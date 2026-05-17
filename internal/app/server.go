package app

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/amer8/gomod-lens/internal/graph"
)

//go:embed web/static
var embeddedFiles embed.FS

// Server owns HTTP routes, caching, rate limiting, and graph loading.
type Server struct {
	analyzer            *graph.Analyzer
	config              ServerConfig
	moduleSearcher      moduleSearcher
	staticFiles         http.Handler
	analysisSlots       chan struct{}
	graphCache          *ttlCache[*graph.Graph]
	searchCache         *ttlCache[[]ModuleSearchResult]
	graphLimiter        *fixedWindowRateLimiter
	searchLimiter       *fixedWindowRateLimiter
	globalGraphLimiter  *fixedWindowRateLimiter
	globalSearchLimiter *fixedWindowRateLimiter
}

// NewServer creates a Server with default configuration.
func NewServer(analyzer *graph.Analyzer) (*Server, error) {
	return NewServerWithConfig(analyzer, DefaultServerConfig())
}

// NewServerWithConfig creates a Server with explicit configuration.
func NewServerWithConfig(analyzer *graph.Analyzer, config ServerConfig) (*Server, error) {
	staticFS, err := fs.Sub(embeddedFiles, "web/static")
	if err != nil {
		return nil, err
	}
	config = normalizeServerConfig(config)

	return &Server{
		analyzer:            analyzer,
		config:              config,
		moduleSearcher:      NewGitHubModuleSearcherWithUserAgent(nil, config.UpstreamUserAgent),
		staticFiles:         http.FileServer(http.FS(staticFS)),
		analysisSlots:       make(chan struct{}, config.AnalysisConcurrency),
		graphCache:          newTTLCache[*graph.Graph](config.GraphCacheTTL, 128),
		searchCache:         newTTLCache[[]ModuleSearchResult](config.SearchCacheTTL, 256),
		graphLimiter:        newFixedWindowRateLimiter(config.GraphRateLimit),
		searchLimiter:       newFixedWindowRateLimiter(config.SearchRateLimit),
		globalGraphLimiter:  newFixedWindowRateLimiter(config.GlobalGraphRateLimit),
		globalSearchLimiter: newFixedWindowRateLimiter(config.GlobalSearchRateLimit),
	}, nil
}

// Routes returns the HTTP handler for the application.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/assets/", http.StripPrefix("/assets/", s.staticFiles))
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/graph", s.handleGraphFragment)
	mux.HandleFunc("/api/graph", s.handleGraph)
	mux.HandleFunc("/api/modules/search", s.handleModuleSearch)
	mux.HandleFunc("/api/health", s.handleHealth)
	return mux
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = IndexPage().Render(r.Context(), w)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.allowRequest(w, r, s.graphLimiter) {
		return
	}
	if !s.allowGlobalRequest(w, s.globalGraphLimiter) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.RequestTimeout)
	defer cancel()

	target := strings.TrimSpace(r.URL.Query().Get("target"))
	if target == "" {
		writeError(w, http.StatusBadRequest, "target is required")
		return
	}
	result, err := s.loadGraph(ctx, target)
	if err != nil {
		writeStatusError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGraphFragment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	ctx, cancel := context.WithTimeout(r.Context(), s.config.RequestTimeout)
	defer cancel()

	target := strings.TrimSpace(r.URL.Query().Get("target"))
	if target == "" {
		_ = GraphErrorFragment("target is required").Render(r.Context(), w)
		return
	}
	if !s.allowRequest(w, r, s.graphLimiter) {
		return
	}
	if !s.allowGlobalRequest(w, s.globalGraphLimiter) {
		return
	}
	result, err := s.loadGraph(ctx, target)
	if err != nil {
		_ = GraphErrorFragment(err.Error()).Render(r.Context(), w)
		return
	}

	_ = GraphFragment(newGraphViewModel(*result)).Render(r.Context(), w)
}

func (s *Server) handleModuleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.allowRequest(w, r, s.searchLimiter) {
		return
	}
	if !s.allowGlobalRequest(w, s.globalSearchLimiter) {
		return
	}

	query := normalizeModuleSearchQuery(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, http.StatusOK, map[string][]ModuleSearchResult{"results": []ModuleSearchResult{}})
		return
	}
	if s.moduleSearcher == nil {
		writeJSON(w, http.StatusOK, map[string][]ModuleSearchResult{"results": []ModuleSearchResult{}})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.SearchTimeout)
	defer cancel()

	results, err := s.searchModules(ctx, query, parseSearchLimit(r.URL.Query().Get("limit")))
	if err != nil {
		writeStatusError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string][]ModuleSearchResult{"results": results})
}

func (s *Server) loadGraph(ctx context.Context, target string) (*graph.Graph, error) {
	if err := validateRequestedModuleTarget(target); err != nil {
		return nil, invalidRequestStatus(err)
	}

	resolvedTarget, err := s.resolveModuleTarget(ctx, target)
	if err != nil {
		return nil, err
	}
	if err := validateResolvedModuleTarget(resolvedTarget); err != nil {
		return nil, invalidRequestStatus(err)
	}

	key := graphCacheKey(resolvedTarget)
	if cached, ok := s.graphCache.get(key); ok {
		return cloneGraph(cached), nil
	}

	release, ok := s.acquireAnalysisSlot()
	if !ok {
		return nil, &statusError{
			status:     http.StatusTooManyRequests,
			message:    "analysis capacity is full; retry shortly",
			retryAfter: "5",
		}
	}
	defer release()

	result, err := s.analyzer.Analyze(ctx, graph.Request{
		Target: resolvedTarget,
		Mode:   graph.ModeModule,
	})
	if err != nil {
		return nil, err
	}
	s.graphCache.set(key, cloneGraph(result))
	return result, nil
}

func (s *Server) acquireAnalysisSlot() (func(), bool) {
	select {
	case s.analysisSlots <- struct{}{}:
		return func() { <-s.analysisSlots }, true
	default:
		return nil, false
	}
}

func graphCacheKey(target string) string {
	return strings.TrimSpace(target)
}

func (s *Server) searchModules(ctx context.Context, query string, limit int) ([]ModuleSearchResult, error) {
	query = normalizeModuleSearchQuery(query)
	if query == "" || s.moduleSearcher == nil {
		return nil, nil
	}
	if err := validateModuleSearchQuery(query); err != nil {
		return nil, invalidRequestStatus(err)
	}
	key := moduleSearchCacheKey(query, limit)
	if cached, ok := s.searchCache.get(key); ok {
		return cloneModuleSearchResults(cached), nil
	}

	results, err := s.moduleSearcher.Search(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	results = cloneModuleSearchResults(results)
	s.searchCache.set(key, results)
	return cloneModuleSearchResults(results), nil
}

func moduleSearchCacheKey(query string, limit int) string {
	return strings.TrimSpace(query) + "\x00" + strconv.Itoa(limit)
}

func validateModuleSearchQuery(query string) error {
	query = normalizeModuleSearchQuery(query)
	if query == "" {
		return nil
	}
	if len(query) > maxModuleTargetLength {
		return invalidRequestStatusString("query is too long")
	}
	if isLikelyLocalTarget(query) || strings.Contains(query, "://") || strings.ContainsAny(query, "?#") {
		return invalidRequestStatusString("query must be a Go module path or repository name")
	}
	if !hasAllowedModulePathChars(query) {
		return invalidRequestStatusString("query contains unsupported characters")
	}
	return nil
}

func cloneModuleSearchResults(results []ModuleSearchResult) []ModuleSearchResult {
	if results == nil {
		return nil
	}
	cloned := make([]ModuleSearchResult, len(results))
	copy(cloned, results)
	return cloned
}

func cloneGraph(g *graph.Graph) *graph.Graph {
	if g == nil {
		return nil
	}
	cloned := *g
	cloned.Meta.Lenses = graph.CloneLensDefinitions(g.Meta.Lenses)
	cloned.Nodes = append([]graph.Node(nil), g.Nodes...)
	for i := range cloned.Nodes {
		cloned.Nodes[i].Lenses = graph.CloneLensResults(g.Nodes[i].Lenses)
		cloned.Nodes[i].OpenSSF = cloneOpenSSFScore(g.Nodes[i].OpenSSF)
	}
	cloned.Edges = append([]graph.Edge(nil), g.Edges...)
	cloned.PackageInfo.Licenses = append([]graph.LicenseInfo(nil), g.PackageInfo.Licenses...)
	cloned.PackageInfo.Names = append([]graph.PackageName(nil), g.PackageInfo.Names...)
	return &cloned
}

func cloneOpenSSFScore(score *graph.OpenSSFScore) *graph.OpenSSFScore {
	if score == nil {
		return nil
	}
	cloned := *score
	if score.Score != nil {
		value := *score.Score
		cloned.Score = &value
	}
	return &cloned
}

func (s *Server) allowRequest(w http.ResponseWriter, r *http.Request, limiter *fixedWindowRateLimiter) bool {
	if limiter == nil {
		return true
	}
	retryAfter, ok := limiter.allow(clientKey(r, s.config.TrustProxyHeaders))
	if ok {
		return true
	}
	if retryAfter < time.Second {
		retryAfter = time.Second
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
	writeError(w, http.StatusTooManyRequests, "rate limit exceeded; retry shortly")
	return false
}

func (s *Server) allowGlobalRequest(w http.ResponseWriter, limiter *fixedWindowRateLimiter) bool {
	if limiter == nil {
		return true
	}
	retryAfter, ok := limiter.allow("global")
	if ok {
		return true
	}
	if retryAfter < time.Second {
		retryAfter = time.Second
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
	writeError(w, http.StatusTooManyRequests, "server rate limit exceeded; retry shortly")
	return false
}

func graphErrorStatus(err error) int {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	case graph.IsInvalidRequest(err):
		return http.StatusBadRequest
	default:
		var commandErr *graph.CommandError
		if errors.As(err, &commandErr) {
			return http.StatusBadGateway
		}
		return http.StatusInternalServerError
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeStatusError(w http.ResponseWriter, err error) {
	if retryAfter := errorRetryAfter(err); retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	writeError(w, errorStatus(err), err.Error())
}

func invalidRequestStatus(err error) error {
	if err == nil {
		return nil
	}
	return &statusError{
		status:  http.StatusBadRequest,
		message: err.Error(),
		err:     err,
	}
}

func invalidRequestStatusString(message string) error {
	return &statusError{
		status:  http.StatusBadRequest,
		message: message,
	}
}
