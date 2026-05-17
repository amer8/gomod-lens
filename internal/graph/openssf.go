//go:build !js || !wasm

package graph

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	openSSFStatusFound       = "found"
	openSSFStatusNoScorecard = "no_scorecard"
	openSSFStatusNoProject   = "no_project"
	openSSFStatusSkipped     = "skipped"
	openSSFStatusUnavailable = "unavailable"
	openSSFStatusError       = "error"

	depsDevAPIBase          = "https://api.deps.dev/v3"
	defaultDepsDevUserAgent = "gomod-lens (+https://github.com/amer8/gomod-lens)"
	upstreamUserAgentEnvVar = "GOMOD_LENS_USER_AGENT"
	maxDepsDevResponseBytes = 1 << 20
)

var errDepsDevNotFound = errors.New("not found")

// OpenSSFScoreProvider fetches Scorecard data for graph nodes.
type OpenSSFScoreProvider interface {
	FetchOpenSSFScores(ctx context.Context, deps []OpenSSFScoreRequest) map[string]OpenSSFScore
}

// OpenSSFScoreRequest identifies one module version to score.
type OpenSSFScoreRequest struct {
	ID      string
	Module  string
	Version string
}

// OpenSSFScorecardLens applies OpenSSF Scorecard data to graph nodes.
type OpenSSFScorecardLens struct {
	scoreProvider OpenSSFScoreProvider
}

// NewOpenSSFScorecardLens creates the built-in OpenSSF Scorecard lens.
func NewOpenSSFScorecardLens(provider OpenSSFScoreProvider) *OpenSSFScorecardLens {
	return &OpenSSFScorecardLens{scoreProvider: provider}
}

// Definition returns metadata for the OpenSSF Scorecard lens.
func (l *OpenSSFScorecardLens) Definition() LensDefinition {
	return OpenSSFLensDefinition()
}

// Analyze enriches graph nodes with OpenSSF Scorecard results.
func (l *OpenSSFScorecardLens) Analyze(ctx context.Context, graph *Graph) error {
	applyOpenSSFOverlay(ctx, graph, l.scoreProvider)
	return nil
}

// DepsDevOpenSSFScoreProvider loads OpenSSF Scorecard data through the deps.dev API.
type DepsDevOpenSSFScoreProvider struct {
	client      *http.Client
	concurrency int
	cacheMu     sync.RWMutex
	cache       map[string]OpenSSFScore
}

// NewDepsDevOpenSSFScoreProvider creates a deps.dev-backed Scorecard provider.
func NewDepsDevOpenSSFScoreProvider(client *http.Client, concurrency int) *DepsDevOpenSSFScoreProvider {
	if client == nil {
		client = &http.Client{Timeout: 12 * time.Second}
	}
	if concurrency < 1 {
		concurrency = 1
	}
	return &DepsDevOpenSSFScoreProvider{
		client:      client,
		concurrency: concurrency,
		cache:       make(map[string]OpenSSFScore),
	}
}

// FetchOpenSSFScores returns Scorecard results keyed by OpenSSFScoreRequest ID.
func (p *DepsDevOpenSSFScoreProvider) FetchOpenSSFScores(ctx context.Context, deps []OpenSSFScoreRequest) map[string]OpenSSFScore {
	results := make(map[string]OpenSSFScore, len(deps))
	idsByKey := make(map[string][]string)
	requestByKey := make(map[string]OpenSSFScoreRequest)

	for _, dep := range deps {
		key := scoreCacheKey(dep.Module, dep.Version)
		idsByKey[key] = append(idsByKey[key], dep.ID)
		if _, ok := requestByKey[key]; !ok {
			requestByKey[key] = dep
		}
	}

	var wg sync.WaitGroup
	var resultMu sync.Mutex
	sem := make(chan struct{}, p.concurrency)

	for key, dep := range requestByKey {
		if cached, ok := p.cached(key); ok {
			publishScore(results, &resultMu, idsByKey[key], cached)
			continue
		}

		wg.Add(1)
		go func(key string, dep OpenSSFScoreRequest) {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				publishScore(results, &resultMu, idsByKey[key], openSSFErrorScore(dep.Module, dep.Version, ctx.Err()))
				return
			}

			score := p.fetchScore(ctx, dep)
			if score.Status != openSSFStatusError {
				p.setCached(key, score)
			}
			publishScore(results, &resultMu, idsByKey[key], score)
		}(key, dep)
	}

	wg.Wait()
	return results
}

func (p *DepsDevOpenSSFScoreProvider) cached(key string) (OpenSSFScore, bool) {
	p.cacheMu.RLock()
	defer p.cacheMu.RUnlock()
	score, ok := p.cache[key]
	return score, ok
}

func (p *DepsDevOpenSSFScoreProvider) setCached(key string, score OpenSSFScore) {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	p.cache[key] = score
}

func (p *DepsDevOpenSSFScoreProvider) fetchScore(ctx context.Context, dep OpenSSFScoreRequest) OpenSSFScore {
	score := OpenSSFScore{
		Module:  dep.Module,
		Version: dep.Version,
		Status:  openSSFStatusError,
	}

	versionResp, err := p.fetchVersion(ctx, dep.Module, dep.Version)
	if errors.Is(err, errDepsDevNotFound) && needsIncompatible(dep.Module, dep.Version) {
		versionResp, err = p.fetchVersion(ctx, dep.Module, dep.Version+"+incompatible")
	}
	if err != nil {
		if errors.Is(err, errDepsDevNotFound) {
			score.Status = openSSFStatusUnavailable
			return score
		}
		score.Error = err.Error()
		return score
	}

	projectIDs := sourceProjectIDs(dep.Module, versionResp.RelatedProjects)
	if len(projectIDs) == 0 {
		score.Status = openSSFStatusNoProject
		return score
	}

	var projectResp *depsDevProjectResponse
	var projectErr error
	for _, projectID := range projectIDs {
		projectResp, projectErr = p.fetchProject(ctx, projectID)
		if projectErr == nil {
			score.ProjectID = projectID
			break
		}
		if !errors.Is(projectErr, errDepsDevNotFound) {
			break
		}
	}

	if projectErr != nil {
		if errors.Is(projectErr, errDepsDevNotFound) {
			score.Status = openSSFStatusNoScorecard
			return score
		}
		score.Error = projectErr.Error()
		return score
	}

	if projectResp.Scorecard == nil {
		score.Status = openSSFStatusNoScorecard
		return score
	}

	value := projectResp.Scorecard.OverallScore
	score.Score = &value
	score.Date = projectResp.Scorecard.Date
	score.Status = openSSFStatusFound
	return score
}

func (p *DepsDevOpenSSFScoreProvider) fetchVersion(ctx context.Context, module, version string) (*depsDevVersionResponse, error) {
	reqURL := fmt.Sprintf("%s/systems/GO/packages/%s/versions/%s",
		depsDevAPIBase,
		url.PathEscape(module),
		url.PathEscape(version))
	return doDepsDevRequest[depsDevVersionResponse](ctx, p.client, reqURL)
}

func (p *DepsDevOpenSSFScoreProvider) fetchProject(ctx context.Context, projectID string) (*depsDevProjectResponse, error) {
	reqURL := fmt.Sprintf("%s/projects/%s", depsDevAPIBase, url.PathEscape(projectID))
	return doDepsDevRequest[depsDevProjectResponse](ctx, p.client, reqURL)
}

func publishScore(results map[string]OpenSSFScore, mu *sync.Mutex, ids []string, score OpenSSFScore) {
	mu.Lock()
	defer mu.Unlock()
	for _, id := range ids {
		results[id] = score
	}
}

func applyOpenSSFOverlay(ctx context.Context, graph *Graph, provider OpenSSFScoreProvider) {
	if graph == nil {
		return
	}

	requests := make([]OpenSSFScoreRequest, 0, len(graph.Nodes))
	for i := range graph.Nodes {
		request, skipped := openSSFScoreRequestForNode(graph.Nodes[i])
		if skipped != nil {
			SetNodeOpenSSFScore(&graph.Nodes[i], skipped)
			continue
		}
		requests = append(requests, request)
	}

	if provider == nil {
		for i := range graph.Nodes {
			if graph.Nodes[i].OpenSSF != nil {
				continue
			}
			SetNodeOpenSSFScore(&graph.Nodes[i], &OpenSSFScore{
				Module:  graph.Nodes[i].Name,
				Version: graph.Nodes[i].Version,
				Status:  openSSFStatusError,
				Error:   "score provider is unavailable",
			})
		}
		return
	}

	scores := provider.FetchOpenSSFScores(ctx, requests)
	for i := range graph.Nodes {
		if graph.Nodes[i].OpenSSF != nil {
			continue
		}
		if score, ok := scores[graph.Nodes[i].ID]; ok {
			SetNodeOpenSSFScore(&graph.Nodes[i], &score)
			continue
		}
		SetNodeOpenSSFScore(&graph.Nodes[i], &OpenSSFScore{
			Module:  graph.Nodes[i].Name,
			Version: graph.Nodes[i].Version,
			Status:  openSSFStatusError,
			Error:   "score was not returned",
		})
	}
}

func openSSFScoreRequestForNode(node Node) (OpenSSFScoreRequest, *OpenSSFScore) {
	module := node.Name
	version := node.Version

	if node.Replaced && node.Replacement != "" {
		replacementModule, replacementVersion := splitModuleToken(node.Replacement)
		if isLocalReplacementTarget(replacementModule) {
			return OpenSSFScoreRequest{}, &OpenSSFScore{
				Module:  module,
				Version: version,
				Status:  openSSFStatusSkipped,
				Error:   "local replacement",
			}
		}
		module = replacementModule
		if replacementVersion != "" {
			version = replacementVersion
		}
	}

	if strings.TrimSpace(module) == "" || strings.TrimSpace(version) == "" {
		return OpenSSFScoreRequest{}, &OpenSSFScore{
			Module:  module,
			Version: version,
			Status:  openSSFStatusSkipped,
			Error:   "module version is not available",
		}
	}

	return OpenSSFScoreRequest{
		ID:      node.ID,
		Module:  module,
		Version: version,
	}, nil
}

func isLocalReplacementTarget(target string) bool {
	if target == "" {
		return false
	}
	switch {
	case strings.HasPrefix(target, "."):
		return true
	case strings.HasPrefix(target, "/"), strings.HasPrefix(target, `\`):
		return true
	case len(target) >= 2 &&
		((target[0] >= 'a' && target[0] <= 'z') || (target[0] >= 'A' && target[0] <= 'Z')) &&
		target[1] == ':':
		return true
	default:
		return false
	}
}

func openSSFErrorScore(module, version string, err error) OpenSSFScore {
	message := ""
	if err != nil {
		message = err.Error()
	}
	return OpenSSFScore{
		Module:  module,
		Version: version,
		Status:  openSSFStatusError,
		Error:   message,
	}
}

func scoreCacheKey(module, version string) string {
	return module + "@" + version
}

func sourceProjectIDs(module string, relatedProjects []depsDevRelatedProject) []string {
	for _, project := range relatedProjects {
		if project.RelationType == "SOURCE_REPO" {
			return []string{project.ProjectKey.ID}
		}
	}
	return InferOpenSSFProjectIDs(module)
}

func doDepsDevRequest[T any](ctx context.Context, client *http.Client, reqURL string) (*T, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", depsDevUserAgent())

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDepsDevResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxDepsDevResponseBytes {
		return nil, fmt.Errorf("deps.dev response exceeded %d bytes", maxDepsDevResponseBytes)
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, errDepsDevNotFound
	}
	if resp.StatusCode != http.StatusOK {
		if isDepsDevRateLimitResponse(resp, string(body)) {
			return nil, &depsDevHTTPError{
				status:     http.StatusTooManyRequests,
				message:    strings.TrimSpace(string(body)),
				retryAfter: depsDevRetryAfter(resp.Header),
			}
		}
		return nil, fmt.Errorf("deps.dev returned status %d: %s", resp.StatusCode, string(body))
	}

	var result T
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

type depsDevHTTPError struct {
	status     int
	message    string
	retryAfter string
}

func (e *depsDevHTTPError) Error() string {
	if e == nil {
		return ""
	}
	message := strings.TrimSpace(e.message)
	if message == "" {
		message = http.StatusText(e.status)
	}
	if e.retryAfter != "" {
		return fmt.Sprintf("deps.dev returned %s; retry after %ss", message, e.retryAfter)
	}
	return "deps.dev returned " + message
}

func isDepsDevRateLimitResponse(resp *http.Response, detail string) bool {
	if resp.StatusCode == http.StatusTooManyRequests {
		return true
	}
	return resp.StatusCode == http.StatusForbidden && strings.Contains(strings.ToLower(detail), "rate limit")
}

func depsDevRetryAfter(header http.Header) string {
	if retryAfter := strings.TrimSpace(header.Get("Retry-After")); retryAfter != "" {
		return retryAfter
	}
	reset := strings.TrimSpace(header.Get("X-RateLimit-Reset"))
	if reset == "" {
		return ""
	}
	epoch, err := strconv.ParseInt(reset, 10, 64)
	if err != nil {
		return ""
	}
	seconds := max(int(time.Until(time.Unix(epoch, 0)).Seconds()), 1)
	return strconv.Itoa(seconds)
}

func depsDevUserAgent() string {
	if value := strings.TrimSpace(os.Getenv(upstreamUserAgentEnvVar)); value != "" {
		return value
	}
	return defaultDepsDevUserAgent
}

func needsIncompatible(module, version string) bool {
	if strings.HasSuffix(version, "+incompatible") {
		return false
	}

	v := strings.TrimPrefix(version, "v")
	parts := strings.Split(v, ".")
	if len(parts) == 0 {
		return false
	}

	major, err := strconv.Atoi(parts[0])
	if err != nil || major < 2 {
		return false
	}

	moduleParts := strings.Split(module, "/")
	if len(moduleParts) == 0 {
		return true
	}

	last := moduleParts[len(moduleParts)-1]
	if strings.HasPrefix(last, "v") && len(last) >= 2 {
		if _, err := strconv.Atoi(last[1:]); err == nil {
			return false
		}
	}

	return true
}

type depsDevVersionResponse struct {
	RelatedProjects []depsDevRelatedProject `json:"relatedProjects"`
}

type depsDevRelatedProject struct {
	ProjectKey   depsDevProjectKey `json:"projectKey"`
	RelationType string            `json:"relationType"`
}

type depsDevProjectKey struct {
	ID string `json:"id"`
}

type depsDevProjectResponse struct {
	ProjectKey depsDevProjectKey `json:"projectKey"`
	Scorecard  *depsDevScorecard `json:"scorecard"`
}

type depsDevScorecard struct {
	Date         string  `json:"date"`
	OverallScore float64 `json:"overallScore"`
}
