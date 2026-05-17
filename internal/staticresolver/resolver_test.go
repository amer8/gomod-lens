package staticresolver

import (
	"context"
	"net/url"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
)

type fakeFetcher map[string]string

func (f fakeFetcher) FetchText(_ context.Context, request FetchRequest) (string, error) {
	body, ok := f[request.URL]
	if !ok {
		return "", &HTTPError{Status: 404, StatusText: "Not Found", URL: request.URL}
	}
	return body, nil
}

func TestResolveGraphBuildsBrowserGraph(t *testing.T) {
	fetcher := fakeFetcher{
		proxyModuleURL("example.com/root") + "/@latest":             `{"Version":"v1.2.0"}`,
		proxyModuleURL("example.com/root") + "/@v/list":             "v1.2.0\n",
		proxyModuleURL("example.com/root") + "/@v/v1.2.0.mod":       "module example.com/root\n\nrequire (\n\texample.com/dep v1.0.0\n\texample.com/indirect v1.1.0 // indirect\n)\n",
		proxyModuleURL("example.com/dep") + "/@v/list":              "v1.0.0\nv1.0.1\n",
		proxyModuleURL("example.com/dep") + "/@v/v1.0.0.mod":        "module example.com/dep\n\nrequire example.com/transitive v0.1.0\n",
		proxyModuleURL("example.com/indirect") + "/@v/list":         "v1.1.0\n",
		proxyModuleURL("example.com/indirect") + "/@v/v1.1.0.mod":   "module example.com/indirect\n",
		proxyModuleURL("example.com/transitive") + "/@v/list":       "v0.1.0\nv0.2.0\n",
		proxyModuleURL("example.com/transitive") + "/@v/v0.1.0.mod": "module example.com/transitive\n",
		depsDevVersionURL("example.com/root", "v1.2.0"):             `{}`,
		depsDevVersionURL("example.com/dep", "v1.0.0"):              `{}`,
		depsDevVersionURL("example.com/indirect", "v1.1.0"):         `{}`,
		depsDevVersionURL("example.com/transitive", "v0.1.0"):       `{}`,
	}
	resolver := New(fetcher)

	result, err := resolver.ResolveGraph(context.Background(), "example.com/root@latest", Options{})
	if err != nil {
		t.Fatalf("ResolveGraph returned error: %v", err)
	}
	if result.Meta.Target != "example.com/root@latest" {
		t.Fatalf("target = %q, want latest target", result.Meta.Target)
	}
	if result.Meta.NodeCount != 4 {
		t.Fatalf("node count = %d, want 4", result.Meta.NodeCount)
	}
	if result.Meta.EdgeCount != 3 {
		t.Fatalf("edge count = %d, want 3", result.Meta.EdgeCount)
	}
	if len(result.Meta.Lenses) != 2 || result.Meta.Lenses[0].ID != graph.LensOpenSSF || result.Meta.Lenses[1].ID != graph.LensReleaseFreshness {
		t.Fatalf("lenses = %+v, want OpenSSF and Release Freshness lenses", result.Meta.Lenses)
	}

	dep := nodeByID(result.Nodes, "example.com/dep@v1.0.0")
	if dep == nil {
		t.Fatal("direct dependency node missing")
	}
	if !dep.Direct {
		t.Fatal("direct dependency was not marked direct")
	}

	transitive := nodeByID(result.Nodes, "example.com/transitive@v0.1.0")
	if transitive == nil {
		t.Fatal("transitive dependency node missing")
	}
	if transitive.Direct {
		t.Fatal("transitive dependency was marked direct")
	}
	if transitive.OpenSSF == nil || transitive.OpenSSF.Status != "no_project" {
		t.Fatalf("transitive OpenSSF status = %#v, want no_project", transitive.OpenSSF)
	}
	if got, ok := transitive.LensResult(graph.LensOpenSSF); !ok || got.Status != "no_project" {
		t.Fatalf("transitive OpenSSF lens result = %+v, ok = %v", got, ok)
	}
	if got, ok := transitive.LensResult(graph.LensReleaseFreshness); !ok || got.Status != graph.ReleaseFreshnessStatusMinorBehind {
		t.Fatalf("transitive release freshness lens result = %+v, ok = %v", got, ok)
	}
}

func TestParseGoModHandlesReplacementAndIndirectComment(t *testing.T) {
	meta := parseGoMod(`module example.com/root

require (
	example.com/direct v1.0.0
	example.com/indirect v1.0.1 //indirect
)

replace example.com/direct => example.com/fork v1.2.3
replace example.com/local => ../local
exclude example.com/direct v1.0.0
exclude (
	example.com/other v0.9.0
)
`)

	if meta.ModulePath != "example.com/root" {
		t.Fatalf("module path = %q", meta.ModulePath)
	}
	if len(meta.Requires) != 2 {
		t.Fatalf("requires length = %d, want 2", len(meta.Requires))
	}
	if meta.Requires[0].Indirect {
		t.Fatal("direct require was marked indirect")
	}
	if !meta.Requires[1].Indirect {
		t.Fatal("indirect require was not marked indirect")
	}
	if len(meta.Replacements) != 2 {
		t.Fatalf("replacements length = %d, want 2", len(meta.Replacements))
	}
	if meta.Replacements[0].NewPath != "example.com/fork" || meta.Replacements[0].NewVersion != "v1.2.3" {
		t.Fatalf("module replacement = %#v", meta.Replacements[0])
	}
	if meta.Replacements[1].LocalPath != "../local" {
		t.Fatalf("local replacement = %#v", meta.Replacements[1])
	}
	if len(meta.Excludes) != 2 {
		t.Fatalf("excludes length = %d, want 2", len(meta.Excludes))
	}
	if meta.Excludes[0].Path != "example.com/direct" || meta.Excludes[0].Version != "v1.0.0" {
		t.Fatalf("single exclude = %#v", meta.Excludes[0])
	}
	if meta.Excludes[1].Path != "example.com/other" || meta.Excludes[1].Version != "v0.9.0" {
		t.Fatalf("block exclude = %#v", meta.Excludes[1])
	}
}

func TestResolveGraphDropsRootExcludedRequirements(t *testing.T) {
	fetcher := fakeFetcher{
		proxyModuleURL("example.com/root") + "/@latest":          `{"Version":"v1.0.0"}`,
		proxyModuleURL("example.com/root") + "/@v/v1.0.0.mod":    "module example.com/root\n\nrequire (\n\texample.com/a v1.0.0\n\texample.com/blocked v1.0.0\n)\n\nexclude example.com/blocked v1.0.0\n",
		proxyModuleURL("example.com/a") + "/@v/v1.0.0.mod":       "module example.com/a\n\nrequire (\n\texample.com/blocked v1.0.0\n\texample.com/allowed v1.0.0\n)\n",
		proxyModuleURL("example.com/allowed") + "/@v/v1.0.0.mod": "module example.com/allowed\n",
		depsDevVersionURL("example.com/root", "v1.0.0"):          `{}`,
		depsDevVersionURL("example.com/a", "v1.0.0"):             `{}`,
		depsDevVersionURL("example.com/allowed", "v1.0.0"):       `{}`,
	}
	resolver := New(fetcher)

	result, err := resolver.ResolveGraph(context.Background(), "example.com/root@latest", Options{})
	if err != nil {
		t.Fatalf("ResolveGraph returned error: %v", err)
	}
	if result.Meta.NodeCount != 3 {
		t.Fatalf("node count = %d, want 3", result.Meta.NodeCount)
	}
	if result.Meta.EdgeCount != 2 {
		t.Fatalf("edge count = %d, want 2", result.Meta.EdgeCount)
	}

	if blocked := nodeByID(result.Nodes, "example.com/blocked@v1.0.0"); blocked != nil {
		t.Fatalf("excluded module should not be selected: %#v", blocked)
	}

	direct := nodeByID(result.Nodes, "example.com/a@v1.0.0")
	if direct == nil || !direct.Direct {
		t.Fatalf("direct allowed dependency = %#v, want direct node", direct)
	}
	allowed := nodeByID(result.Nodes, "example.com/allowed@v1.0.0")
	if allowed == nil || allowed.Direct {
		t.Fatalf("transitive allowed dependency = %#v, want indirect node", allowed)
	}

	for _, edge := range result.Edges {
		if edge.Target == "example.com/blocked@v1.0.0" {
			t.Fatalf("excluded requirement should not produce edge: %+v", edge)
		}
	}
}

func TestResolveGraphPrunesTransitiveRequirementsForModernModules(t *testing.T) {
	fetcher := fakeFetcher{
		proxyModuleURL("example.com/root") + "/@latest":       `{"Version":"v1.0.0"}`,
		proxyModuleURL("example.com/root") + "/@v/v1.0.0.mod": "module example.com/root\n\ngo 1.25.0\n\nrequire example.com/text v1.0.0\n",
		proxyModuleURL("example.com/text") + "/@v/v1.0.0.mod": "module example.com/text\n\ngo 1.24.0\n\nrequire example.com/tools v1.0.0\n",
	}
	resolver := New(fetcher)

	result, err := resolver.ResolveGraph(context.Background(), "example.com/root@latest", Options{})
	if err != nil {
		t.Fatalf("ResolveGraph returned error: %v", err)
	}
	if result.Meta.NodeCount != 3 {
		t.Fatalf("node count = %d, want 3", result.Meta.NodeCount)
	}
	if tools := nodeByID(result.Nodes, "example.com/tools@v1.0.0"); tools == nil {
		t.Fatal("pruned dependency requirement should remain selected")
	}
	if telemetry := nodeByID(result.Nodes, "example.com/telemetry@v1.0.0"); telemetry != nil {
		t.Fatalf("transitive dependency past pruning horizon should not be selected: %#v", telemetry)
	}
	if hasEdge(result.Edges, "example.com/tools@v1.0.0", "example.com/telemetry@v1.0.0") {
		t.Fatal("pruned dependency should not have outgoing telemetry edge")
	}
	if !hasEdge(result.Edges, "example.com/text@v1.0.0", "example.com/tools@v1.0.0") {
		t.Fatalf("expected edge from loaded root dependency to pruned selected dependency: %+v", result.Edges)
	}
}

func TestResolveGraphKeepsTransitiveRequirementsForLegacyModules(t *testing.T) {
	fetcher := fakeFetcher{
		proxyModuleURL("example.com/root") + "/@latest":            `{"Version":"v1.0.0"}`,
		proxyModuleURL("example.com/root") + "/@v/v1.0.0.mod":      "module example.com/root\n\ngo 1.25.0\n\nrequire example.com/legacy v1.0.0\n",
		proxyModuleURL("example.com/legacy") + "/@v/v1.0.0.mod":    "module example.com/legacy\n\ngo 1.16\n\nrequire example.com/telemetry v1.0.0\n",
		proxyModuleURL("example.com/telemetry") + "/@v/v1.0.0.mod": "module example.com/telemetry\n\ngo 1.24.0\n",
	}
	resolver := New(fetcher)

	result, err := resolver.ResolveGraph(context.Background(), "example.com/root@latest", Options{})
	if err != nil {
		t.Fatalf("ResolveGraph returned error: %v", err)
	}
	if telemetry := nodeByID(result.Nodes, "example.com/telemetry@v1.0.0"); telemetry == nil {
		t.Fatal("legacy dependency's transitive requirement should stay selected")
	}
	if !hasEdge(result.Edges, "example.com/legacy@v1.0.0", "example.com/telemetry@v1.0.0") {
		t.Fatalf("expected legacy transitive edge: %+v", result.Edges)
	}
}

func TestCompareGoVersions(t *testing.T) {
	cases := []struct {
		left  string
		right string
		want  int
	}{
		{left: "v1.2.3", right: "v1.2.2", want: 1},
		{left: "v1.2.3-rc.1", right: "v1.2.3", want: -1},
		{left: "v1.2.3-rc.2", right: "v1.2.3-rc.10", want: -1},
	}

	for _, tc := range cases {
		got := compareGoVersions(tc.left, tc.right)
		switch {
		case tc.want < 0 && got >= 0:
			t.Fatalf("compareGoVersions(%q, %q) = %d, want negative", tc.left, tc.right, got)
		case tc.want > 0 && got <= 0:
			t.Fatalf("compareGoVersions(%q, %q) = %d, want positive", tc.left, tc.right, got)
		case tc.want == 0 && got != 0:
			t.Fatalf("compareGoVersions(%q, %q) = %d, want zero", tc.left, tc.right, got)
		}
	}
}

func TestParseGoModCapturesGoDirective(t *testing.T) {
	meta := parseGoMod("module example.com/root\n\ngo 1.25.0\n")
	if meta.GoVersion != "1.25.0" {
		t.Fatalf("go version = %q, want 1.25.0", meta.GoVersion)
	}
}

func TestPruningForGoDirective(t *testing.T) {
	cases := []struct {
		version string
		want    modulePruning
	}{
		{version: "", want: pruningUnpruned},
		{version: "1.16", want: pruningUnpruned},
		{version: "1.17", want: pruningPruned},
		{version: "1.25.0", want: pruningPruned},
	}

	for _, tc := range cases {
		if got := pruningForGoDirective(tc.version); got != tc.want {
			t.Fatalf("pruningForGoDirective(%q) = %v, want %v", tc.version, got, tc.want)
		}
	}
}

func nodeByID(nodes []graph.Node, id string) *graph.Node {
	for i := range nodes {
		if nodes[i].ID == id {
			return &nodes[i]
		}
	}
	return nil
}

func hasEdge(edges []graph.Edge, source, target string) bool {
	for _, edge := range edges {
		if edge.Source == source && edge.Target == target {
			return true
		}
	}
	return false
}

func depsDevVersionURL(modulePath, version string) string {
	return depsDevBaseURL + "/systems/GO/packages/" + url.PathEscape(modulePath) + "/versions/" + url.PathEscape(version)
}
