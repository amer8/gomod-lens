package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/amer8/gomod-lens/internal/graph"
)

func TestGraphEndpointReturnsJSON(t *testing.T) {
	t.Parallel()

	analyzer := graph.NewAnalyzer(fakeRunner(func(_ context.Context, workdir string, _ []string, name string, args ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run for cached graph")
		return nil, nil
	}))

	server, err := NewServer(analyzer)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	server.graphCache.set(graphCacheKey("example.com/demo"), &graph.Graph{
		RootID: "example.com/demo",
		Nodes: []graph.Node{{
			ID:      "example.com/demo",
			Name:    "example.com/demo",
			Root:    true,
			OpenSSF: &graph.OpenSSFScore{Status: "skipped"},
			Lenses: graph.LensResults{
				graph.LensOpenSSF: {Status: "skipped"},
			},
		}},
		Meta: graph.GraphMeta{
			Mode:    graph.ModeModule,
			Target:  "example.com/demo",
			Overlay: graph.OverlayOpenSSF,
			Lenses:  []graph.LensDefinition{graph.OpenSSFLensDefinition()},
		},
	})

	request := httptest.NewRequest(http.MethodGet, "/api/graph?target=example.com/demo", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("Content-Type = %q", got)
	}
	if !strings.Contains(response.Body.String(), `"rootId":"example.com/demo"`) {
		t.Fatalf("unexpected body: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"openssf"`) {
		t.Fatalf("expected OpenSSF data in body: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"lenses"`) {
		t.Fatalf("expected lens data in body: %s", response.Body.String())
	}
}

func TestGraphEndpointRejectsLocalTargets(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("runner should not be invoked for local targets")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/graph?target=../private", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"local module targets are not available"`) {
		t.Fatalf("unexpected body: %s", response.Body.String())
	}
}

func TestValidateRequestedModuleTargetAllowsHostRootModules(t *testing.T) {
	t.Parallel()

	if err := validateRequestedModuleTarget("tailscale.com"); err != nil {
		t.Fatalf("validateRequestedModuleTarget() error = %v", err)
	}
	if err := validateResolvedModuleTarget("tailscale.com@v1.98.2"); err != nil {
		t.Fatalf("validateResolvedModuleTarget() error = %v", err)
	}
}

func TestGraphEndpointRateLimitsRequests(t *testing.T) {
	t.Parallel()

	server, err := NewServerWithConfig(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("runner should not run for cached graph")
		return nil, nil
	})), ServerConfig{
		RequestTimeout:      45 * time.Second,
		SearchTimeout:       10 * time.Second,
		AnalysisConcurrency: 1,
		GraphCacheTTL:       time.Hour,
		SearchCacheTTL:      time.Hour,
		UpstreamUserAgent:   defaultUpstreamUserAgent,
		GraphRateLimit:      RateLimitConfig{Requests: 1, Window: time.Minute},
		SearchRateLimit:     RateLimitConfig{Requests: 10, Window: time.Minute},
	})
	if err != nil {
		t.Fatalf("NewServerWithConfig() error = %v", err)
	}
	server.graphCache.set(graphCacheKey("example.com/demo"), &graph.Graph{
		RootID: "example.com/demo",
		Meta: graph.GraphMeta{
			Mode:   graph.ModeModule,
			Target: "example.com/demo",
		},
	})

	first := httptest.NewRecorder()
	server.Routes().ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/graph?target=example.com/demo", nil))
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d, body = %s", first.Code, first.Body.String())
	}

	second := httptest.NewRecorder()
	server.Routes().ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/api/graph?target=example.com/demo", nil))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second status = %d, body = %s", second.Code, second.Body.String())
	}
	if second.Header().Get("Retry-After") == "" {
		t.Fatalf("missing Retry-After header")
	}
}

func TestHealthEndpoint(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		return nil, fmt.Errorf("analyzer should not run")
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"status":"ok"`) {
		t.Fatalf("unexpected body: %s", response.Body.String())
	}
}

func TestIndexServesTemplShell(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run for index")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	body := response.Body.String()
	for _, want := range []string{
		`/assets/app.js`,
		`ngraph.forcelayout`,
		`/assets/vendor/htmx.min.js`,
		`/assets/vendor/ngraph.forcelayout.js`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("index body missing %q: %s", want, body)
		}
	}
}

func TestStaticAssetsEndpoint(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run for static assets")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "htmx.ajax") {
		t.Fatalf("unexpected asset body: %s", response.Body.String())
	}
}

func TestStaticVendorAssetsEndpoint(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run for static assets")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	for _, tc := range []struct {
		path string
		want string
	}{
		{path: "/assets/vendor/htmx.min.js", want: `version:"2.0.8"`},
		{path: "/assets/vendor/ngraph.graph.js", want: `./ngraph.events-1.4.0.js`},
		{path: "/assets/vendor/ngraph.svg.js", want: `./ngraph.forcelayout.js`},
	} {
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, tc.path, nil))

		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", tc.path, response.Code)
		}
		if !strings.Contains(response.Body.String(), tc.want) {
			t.Fatalf("%s body missing %q: %s", tc.path, tc.want, response.Body.String())
		}
	}
}

func TestGraphFragmentReturnsErrorForMissingTarget(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("runner should not be invoked for missing targets")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/graph", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	body := response.Body.String()
	if !strings.Contains(body, `data-state="error"`) || !strings.Contains(body, `target is required`) {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestGraphEndpointReturnsBadRequestForMissingTarget(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("runner should not be invoked for missing targets")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/graph", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"target is required"`) {
		t.Fatalf("unexpected body: %s", response.Body.String())
	}
}

func TestGraphEndpointReturnsGatewayTimeoutForDeadlineExceeded(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		return nil, context.DeadlineExceeded
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/graph?target=example.com/demo", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestGraphEndpointReturnsBadGatewayForCommandFailures(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		return nil, &graph.CommandError{
			Command: "go get example.com/demo@latest",
			Output:  "temporary lookup failure",
			Err:     errors.New("exit status 1"),
		}
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/graph?target=example.com/demo", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestResolveModuleTargetSearchesShortQueries(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	searcher := &fakeModuleSearcher{
		results: []ModuleSearchResult{{
			Path:       "github.com/gin-gonic/gin",
			Repository: "gin-gonic/gin",
		}},
	}
	server.moduleSearcher = searcher

	target, err := server.resolveModuleTarget(context.Background(), "gin")
	if err != nil {
		t.Fatalf("resolveModuleTarget() error = %v", err)
	}
	if target != "github.com/gin-gonic/gin" {
		t.Fatalf("target = %q", target)
	}
	if searcher.query != "gin" {
		t.Fatalf("search query = %q", searcher.query)
	}
}

func TestResolveModuleTargetPreservesVersion(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	server.moduleSearcher = &fakeModuleSearcher{
		results: []ModuleSearchResult{{
			Path:       "github.com/gin-gonic/gin",
			Repository: "gin-gonic/gin",
		}},
	}

	target, err := server.resolveModuleTarget(context.Background(), "gin@v1.10.0")
	if err != nil {
		t.Fatalf("resolveModuleTarget() error = %v", err)
	}
	if target != "github.com/gin-gonic/gin@v1.10.0" {
		t.Fatalf("target = %q", target)
	}
}

func TestResolveModuleTargetKeepsFullModulePaths(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	server.moduleSearcher = &fakeModuleSearcher{
		err: errors.New("search should not run"),
	}

	target, err := server.resolveModuleTarget(context.Background(), "github.com/gin-gonic/gin")
	if err != nil {
		t.Fatalf("resolveModuleTarget() error = %v", err)
	}
	if target != "github.com/gin-gonic/gin" {
		t.Fatalf("target = %q", target)
	}
}

func TestModuleSearchEndpointReturnsResults(t *testing.T) {
	t.Parallel()

	server, err := NewServer(graph.NewAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("analyzer should not run")
		return nil, nil
	})))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	server.moduleSearcher = &fakeModuleSearcher{
		results: []ModuleSearchResult{{
			Path:        "github.com/gin-gonic/gin",
			Repository:  "gin-gonic/gin",
			URL:         "https://github.com/gin-gonic/gin",
			Description: "Gin is a HTTP web framework written in Go.",
			Stars:       80000,
		}},
	}

	request := httptest.NewRequest(http.MethodGet, "/api/modules/search?q=gin&limit=3", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"path":"github.com/gin-gonic/gin"`) {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestGraphEndpointResolvesShortModuleTarget(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	analyzer := graph.NewAnalyzer(fakeRunner(func(_ context.Context, workdir string, _ []string, name string, args ...string) ([]byte, error) {
		command := strings.Join(append([]string{name}, args...), " ")
		switch command {
		case "go get github.com/gin-gonic/gin@latest":
			return nil, nil
		case "go list -m -json all":
			if workdir == rootDir {
				return fmt.Appendf(nil, `{"Path":"github.com/gin-gonic/gin","Main":true,"Dir":%q}`, rootDir), nil
			}
			return []byte(strings.Join([]string{
				fmt.Sprintf(`{"Path":"gomod-lens/tmp","Main":true,"Dir":%q}`, workdir),
				fmt.Sprintf(`{"Path":"github.com/gin-gonic/gin","Version":"v1.10.0","Dir":%q}`, rootDir),
			}, "\n")), nil
		case "go mod edit -json":
			if workdir == rootDir {
				return []byte(`{}`), nil
			}
			return []byte(`{"Require":[{"Path":"github.com/gin-gonic/gin","Version":"v1.10.0","Indirect":true}]}`), nil
		case "go mod graph":
			if workdir != rootDir {
				t.Fatalf("unexpected graph workdir: %s", workdir)
			}
			return nil, nil
		default:
			t.Fatalf("unexpected command: %s", command)
			return nil, nil
		}
	}))
	analyzer.SetLenses(graph.NewOpenSSFScorecardLens(fakeScoreProvider{
		"github.com/gin-gonic/gin@v1.10.0": graph.OpenSSFScore{
			Module:  "github.com/gin-gonic/gin",
			Version: "v1.10.0",
			Status:  "found",
		},
	}))

	server, err := NewServer(analyzer)
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	server.moduleSearcher = &fakeModuleSearcher{
		results: []ModuleSearchResult{{
			Path:       "github.com/gin-gonic/gin",
			Repository: "gin-gonic/gin",
		}},
	}

	request := httptest.NewRequest(http.MethodGet, "/api/graph?target=gin", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, want := range []string{
		`"target":"github.com/gin-gonic/gin"`,
		`"rootId":"github.com/gin-gonic/gin@v1.10.0"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q: %s", want, body)
		}
	}
}

type fakeRunner func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error)

func (f fakeRunner) Run(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
	return f(ctx, dir, env, name, args...)
}

type fakeScoreProvider map[string]graph.OpenSSFScore

func (f fakeScoreProvider) FetchOpenSSFScores(_ context.Context, deps []graph.OpenSSFScoreRequest) map[string]graph.OpenSSFScore {
	results := make(map[string]graph.OpenSSFScore, len(deps))
	for _, dep := range deps {
		if score, ok := f[dep.Module+"@"+dep.Version]; ok {
			results[dep.ID] = score
		}
	}
	return results
}

type fakeModuleSearcher struct {
	results []ModuleSearchResult
	err     error
	query   string
	limit   int
}

func (f *fakeModuleSearcher) Search(_ context.Context, query string, limit int) ([]ModuleSearchResult, error) {
	f.query = query
	f.limit = limit
	return f.results, f.err
}
