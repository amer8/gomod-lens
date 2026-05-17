package graph

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAnalyzeLocalBuildsWorkspaceGraph(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "go.mod"), "module example.com/demo\n\ngo 1.26\n")

	runner := fakeRunner(func(_ context.Context, workdir string, _ []string, name string, args ...string) ([]byte, error) {
		if workdir != dir {
			t.Fatalf("unexpected workdir: %s", workdir)
		}

		switch commandKey(name, args...) {
		case "go list -m -json all":
			return []byte(strings.Join([]string{
				fmt.Sprintf(`{"Path":"example.com/demo","Main":true,"Dir":%q}`, dir),
				`{"Path":"github.com/example/direct","Version":"v1.0.0","Dir":"/modcache/direct"}`,
				`{"Path":"github.com/example/transitive","Version":"v1.2.0","Dir":"/modcache/transitive"}`,
			}, "\n")), nil
		case "go mod graph":
			return []byte(strings.Join([]string{
				"example.com/demo github.com/example/direct@v1.0.0",
				"github.com/example/direct@v1.0.0 github.com/example/transitive@v1.2.0",
			}, "\n")), nil
		case "go mod edit -json":
			return []byte(`{"Require":[{"Path":"github.com/example/direct","Version":"v1.0.0","Indirect":false},{"Path":"github.com/example/transitive","Version":"v1.2.0","Indirect":true}]}`), nil
		default:
			t.Fatalf("unexpected command: %s", commandKey(name, args...))
			return nil, nil
		}
	})

	analyzer := newTestAnalyzer(runner)
	graph, err := analyzer.Analyze(context.Background(), Request{Target: dir, Mode: ModeLocal})
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}

	if graph.RootID != "example.com/demo" {
		t.Fatalf("RootID = %q", graph.RootID)
	}
	if graph.Meta.NodeCount != 3 || graph.Meta.EdgeCount != 2 {
		t.Fatalf("unexpected counts: %+v", graph.Meta)
	}

	nodeByID := indexNodes(graph.Nodes)
	if !nodeByID["github.com/example/direct@v1.0.0"].Direct {
		t.Fatalf("expected direct dependency flag on first-level dependency")
	}
	if nodeByID["github.com/example/transitive@v1.2.0"].Direct {
		t.Fatalf("did not expect transitive dependency to be marked direct")
	}
	if !nodeByID["example.com/demo"].Main || !nodeByID["example.com/demo"].Root {
		t.Fatalf("expected workspace module to be main root node")
	}
	if graph.Meta.Overlay != OverlayOpenSSF {
		t.Fatalf("overlay = %q", graph.Meta.Overlay)
	}
	if got := nodeByID["github.com/example/direct@v1.0.0"].OpenSSF; got == nil || got.Status != openSSFStatusError {
		t.Fatalf("expected direct dependency to include OpenSSF status, got %+v", got)
	}
}

func TestAnalyzeIncludesOpenSSFDataByDefault(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "go.mod"), "module example.com/demo\n\ngo 1.26\n")

	runner := fakeRunner(func(_ context.Context, workdir string, _ []string, name string, args ...string) ([]byte, error) {
		if workdir != dir {
			t.Fatalf("unexpected workdir: %s", workdir)
		}

		switch commandKey(name, args...) {
		case "go list -m -json all":
			return []byte(strings.Join([]string{
				fmt.Sprintf(`{"Path":"example.com/demo","Main":true,"Dir":%q}`, dir),
				`{"Path":"github.com/example/direct","Version":"v1.0.0","Dir":"/modcache/direct"}`,
				`{"Path":"github.com/example/transitive","Version":"v1.2.0","Dir":"/modcache/transitive"}`,
			}, "\n")), nil
		case "go mod graph":
			return []byte(strings.Join([]string{
				"example.com/demo github.com/example/direct@v1.0.0",
				"github.com/example/direct@v1.0.0 github.com/example/transitive@v1.2.0",
			}, "\n")), nil
		case "go mod edit -json":
			return []byte(`{"Require":[{"Path":"github.com/example/direct","Version":"v1.0.0","Indirect":false},{"Path":"github.com/example/transitive","Version":"v1.2.0","Indirect":true}]}`), nil
		default:
			t.Fatalf("unexpected command: %s", commandKey(name, args...))
			return nil, nil
		}
	})

	analyzer := newTestAnalyzer(runner)
	analyzer.SetOpenSSFScoreProvider(fakeScoreProvider{
		"github.com/example/direct@v1.0.0":     scoreValue(8.4),
		"github.com/example/transitive@v1.2.0": scoreValue(4.2),
	})

	graph, err := analyzer.Analyze(context.Background(), Request{
		Target: dir,
		Mode:   ModeLocal,
	})
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}

	if graph.Meta.Overlay != OverlayOpenSSF {
		t.Fatalf("overlay = %q", graph.Meta.Overlay)
	}
	if len(graph.Meta.Lenses) != 1 || graph.Meta.Lenses[0].ID != LensOpenSSF {
		t.Fatalf("lenses = %+v, want OpenSSF lens", graph.Meta.Lenses)
	}

	nodeByID := indexNodes(graph.Nodes)
	if got := nodeByID["github.com/example/direct@v1.0.0"].OpenSSF; got == nil || got.Score == nil || *got.Score != 8.4 {
		t.Fatalf("direct OpenSSF score = %+v", got)
	}
	if got, ok := nodeByID["github.com/example/direct@v1.0.0"].LensResult(LensOpenSSF); !ok || got.Score == nil || *got.Score != 8.4 {
		t.Fatalf("direct OpenSSF lens result = %+v, ok = %v", got, ok)
	}
	if got := nodeByID["github.com/example/transitive@v1.2.0"].OpenSSF; got == nil || got.Score == nil || *got.Score != 4.2 {
		t.Fatalf("transitive OpenSSF score = %+v", got)
	}
	if got := nodeByID["example.com/demo"].OpenSSF; got == nil || got.Status != openSSFStatusSkipped {
		t.Fatalf("root OpenSSF score = %+v", got)
	}
}

func TestAnalyzeModuleKeepsTransitiveDependencies(t *testing.T) {
	t.Parallel()

	moduleDir := "/modcache/github.com/example/graph"
	runner := fakeRunner(func(_ context.Context, workdir string, _ []string, name string, args ...string) ([]byte, error) {
		switch commandKey(name, args...) {
		case "go get github.com/example/graph@latest":
			goMod, err := os.ReadFile(filepath.Join(workdir, "go.mod"))
			if err != nil {
				t.Fatalf("read temp go.mod: %v", err)
			}
			if got := string(goMod); got != remoteModuleSeedGoMod {
				t.Fatalf("temp go.mod = %q", got)
			}
			return []byte(""), nil
		case "go list -m -json all":
			if workdir == moduleDir {
				return []byte(strings.Join([]string{
					fmt.Sprintf(`{"Path":"github.com/example/graph","Main":true,"Dir":%q}`, moduleDir),
					`{"Path":"go.yaml.in/yaml/v3","Version":"v3.0.4","Dir":"/modcache/yaml"}`,
					`{"Path":"gopkg.in/check.v1","Version":"v0.0.0-20161208181325-20d25e280405","Dir":"/modcache/check"}`,
				}, "\n")), nil
			}
			return []byte(strings.Join([]string{
				`{"Path":"gomod-lens/tmp","Main":true}`,
				fmt.Sprintf(`{"Path":"github.com/example/graph","Version":"v1.4.0","Dir":%q}`, moduleDir),
				`{"Path":"example.com/temp-only","Version":"v0.1.0","Dir":"/modcache/temp-only"}`,
			}, "\n")), nil
		case "go mod graph":
			if workdir != moduleDir {
				t.Fatalf("unexpected module graph workdir: %s", workdir)
			}
			return []byte(strings.Join([]string{
				"github.com/example/graph go.yaml.in/yaml/v3@v3.0.0",
				"go.yaml.in/yaml/v3@v3.0.4 gopkg.in/check.v1@v0.0.0-20161208181325-20d25e280405",
				"go.yaml.in/yaml/v3@v3.0.0 example.com/non-selected@v1.0.0",
			}, "\n")), nil
		case "go mod edit -json":
			if workdir == moduleDir {
				return []byte(`{"Require":[{"Path":"go.yaml.in/yaml/v3","Version":"v3.0.4","Indirect":false}]}`), nil
			}
			return []byte(`{"Require":[{"Path":"github.com/example/graph","Version":"v1.4.0","Indirect":true},{"Path":"go.yaml.in/yaml/v3","Version":"v3.0.4","Indirect":true},{"Path":"gopkg.in/check.v1","Version":"v0.0.0-20161208181325-20d25e280405","Indirect":true}]}`), nil
		default:
			t.Fatalf("unexpected command: %s", commandKey(name, args...))
			return nil, nil
		}
	})

	analyzer := newTestAnalyzer(runner)
	graph, err := analyzer.Analyze(context.Background(), Request{Target: "github.com/example/graph", Mode: ModeModule})
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}

	if graph.RootID != "github.com/example/graph@v1.4.0" {
		t.Fatalf("RootID = %q", graph.RootID)
	}
	if graph.Meta.NodeCount != 3 {
		t.Fatalf("unexpected node count: %d", graph.Meta.NodeCount)
	}

	nodeByID := indexNodes(graph.Nodes)
	if _, ok := nodeByID["gomod-lens/tmp"]; ok {
		t.Fatalf("synthetic temp module should not be present in filtered graph")
	}
	if _, ok := nodeByID["example.com/temp-only@v0.1.0"]; ok {
		t.Fatalf("temp resolver dependencies should not be present in filtered graph")
	}
	if _, ok := nodeByID["go.yaml.in/yaml/v3@v3.0.0"]; ok {
		t.Fatalf("non-selected module version should not be present in filtered graph")
	}
	if _, ok := nodeByID["example.com/non-selected@v1.0.0"]; ok {
		t.Fatalf("non-selected transitive module should not be present in filtered graph")
	}
	if !nodeByID["go.yaml.in/yaml/v3@v3.0.4"].Direct {
		t.Fatalf("expected direct dependency to be marked direct")
	}
	if nodeByID["gopkg.in/check.v1@v0.0.0-20161208181325-20d25e280405"].Direct {
		t.Fatalf("did not expect transitive dependency to be marked direct")
	}
	if !nodeByID["github.com/example/graph@v1.4.0"].Root {
		t.Fatalf("expected resolved module to be graph root")
	}

	hasMappedEdge := false
	for _, edge := range graph.Edges {
		if edge.Source == "github.com/example/graph@v1.4.0" && edge.Target == "go.yaml.in/yaml/v3@v3.0.4" {
			hasMappedEdge = true
		}
	}
	if !hasMappedEdge {
		t.Fatalf("expected main module edge to be rewritten to selected dependency version")
	}
}

func TestAnalyzeLocalExcludesPseudoGoModules(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "go.mod"), "module example.com/demo\n\ngo 1.26\n")

	runner := fakeRunner(func(_ context.Context, workdir string, _ []string, name string, args ...string) ([]byte, error) {
		if workdir != dir {
			t.Fatalf("unexpected workdir: %s", workdir)
		}

		switch commandKey(name, args...) {
		case "go list -m -json all":
			return []byte(strings.Join([]string{
				fmt.Sprintf(`{"Path":"example.com/demo","Main":true,"Dir":%q}`, dir),
				`{"Path":"github.com/example/direct","Version":"v1.0.0","Dir":"/modcache/direct"}`,
			}, "\n")), nil
		case "go mod graph":
			return []byte(strings.Join([]string{
				"example.com/demo github.com/example/direct@v1.0.0",
				"example.com/demo go@1.26.0",
				"example.com/demo toolchain@go1.26.1",
			}, "\n")), nil
		case "go mod edit -json":
			return []byte(`{"Require":[{"Path":"github.com/example/direct","Version":"v1.0.0","Indirect":false}]}`), nil
		default:
			t.Fatalf("unexpected command: %s", commandKey(name, args...))
			return nil, nil
		}
	})

	analyzer := newTestAnalyzer(runner)
	graph, err := analyzer.Analyze(context.Background(), Request{Target: dir, Mode: ModeLocal})
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}

	if graph.Meta.NodeCount != 2 || graph.Meta.EdgeCount != 1 {
		t.Fatalf("unexpected counts: %+v", graph.Meta)
	}

	nodeByID := indexNodes(graph.Nodes)
	if _, ok := nodeByID["go@1.26.0"]; ok {
		t.Fatalf("did not expect pseudo go module in graph")
	}
	if _, ok := nodeByID["toolchain@go1.26.1"]; ok {
		t.Fatalf("did not expect pseudo toolchain module in graph")
	}

	for _, entry := range graph.PackageInfo.Names {
		if entry.Name == "go" || entry.Name == "toolchain" {
			t.Fatalf("did not expect pseudo module name in package info: %+v", entry)
		}
	}
}

func TestAnalyzeRejectsEmptyModuleTarget(t *testing.T) {
	t.Parallel()

	analyzer := newTestAnalyzer(fakeRunner(func(context.Context, string, []string, string, ...string) ([]byte, error) {
		t.Fatalf("runner should not be invoked for empty module targets")
		return nil, nil
	}))

	_, err := analyzer.Analyze(context.Background(), Request{Mode: ModeModule})
	if err == nil {
		t.Fatalf("expected error")
	}
	if !IsInvalidRequest(err) {
		t.Fatalf("expected invalid request error, got %v", err)
	}
}

func TestAnalyzeLocalPrunesNonSelectedGraphVersions(t *testing.T) {
	t.Parallel()

	baseDir := t.TempDir()
	rootDir := filepath.Join(baseDir, "root")
	replacementDir := filepath.Join(baseDir, "replacement")
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	if err := os.MkdirAll(replacementDir, 0o755); err != nil {
		t.Fatalf("mkdir replacement: %v", err)
	}

	mustWriteFile(t, filepath.Join(rootDir, "go.mod"), "module example.com/demo\n\ngo 1.26\n")
	mustWriteFile(t, filepath.Join(rootDir, "LICENSE"), "Apache License\nVersion 2.0, January 2004")
	mustWriteFile(t, filepath.Join(replacementDir, "LICENSE"), "Permission is hereby granted, free of charge, to any person obtaining a copy")

	runner := fakeRunner(func(_ context.Context, workdir string, _ []string, name string, args ...string) ([]byte, error) {
		if workdir != rootDir {
			t.Fatalf("unexpected workdir: %s", workdir)
		}

		switch commandKey(name, args...) {
		case "go list -m -json all":
			return []byte(strings.Join([]string{
				fmt.Sprintf(`{"Path":"example.com/demo","Main":true,"Dir":%q}`, rootDir),
				fmt.Sprintf(`{"Path":"example.com/a","Version":"v1.2.0","Dir":%q,"Replace":{"Path":"../replacement","Dir":%q}}`, replacementDir, replacementDir),
				`{"Path":"example.com/dep","Version":"v1.0.0","Dir":"/modcache/dep"}`,
			}, "\n")), nil
		case "go mod graph":
			return []byte(strings.Join([]string{
				"example.com/demo example.com/a@v1.2.0",
				"example.com/demo example.com/dep@v1.0.0",
				"example.com/dep@v1.0.0 example.com/a@v1.0.0",
			}, "\n")), nil
		case "go mod edit -json":
			return []byte(`{"Require":[{"Path":"example.com/a","Version":"v1.2.0","Indirect":false},{"Path":"example.com/dep","Version":"v1.0.0","Indirect":false}],"Replace":[{"Old":{"Path":"example.com/a"},"New":{"Path":"../replacement"}}]}`), nil
		default:
			t.Fatalf("unexpected command: %s", commandKey(name, args...))
			return nil, nil
		}
	})

	analyzer := newTestAnalyzer(runner)
	graph, err := analyzer.Analyze(context.Background(), Request{Target: rootDir, Mode: ModeLocal})
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}

	nodeByID := indexNodes(graph.Nodes)
	if _, ok := nodeByID["example.com/a@v1.0.0"]; ok {
		t.Fatalf("non-selected module version should not be present in filtered graph")
	}

	selectedVersion := nodeByID["example.com/a@v1.2.0"]
	if !selectedVersion.Replaced {
		t.Fatalf("expected selected version to inherit replacement metadata: %+v", selectedVersion)
	}
	if selectedVersion.Replacement != "../replacement" {
		t.Fatalf("replacement = %q", selectedVersion.Replacement)
	}

	hasMappedEdge := false
	for _, edge := range graph.Edges {
		if edge.Source == "example.com/dep@v1.0.0" && edge.Target == "example.com/a@v1.2.0" {
			hasMappedEdge = true
		}
	}
	if !hasMappedEdge {
		t.Fatalf("expected edge to point at selected module version")
	}

	for _, license := range graph.PackageInfo.Licenses {
		if license.Name == "MIT" && license.Count == 1 {
			return
		}
	}
	t.Fatalf("expected replacement-backed versions to use replacement license, got %+v", graph.PackageInfo.Licenses)
}

func TestPickRootModuleIDMatchesResolvedVersion(t *testing.T) {
	t.Parallel()

	id, err := pickRootModuleID("github.com/example/graph", map[string]bool{
		"github.com/example/graph@v1.4.0": true,
	})
	if err != nil {
		t.Fatalf("pickRootModuleID() error = %v", err)
	}
	if id != "github.com/example/graph@v1.4.0" {
		t.Fatalf("pickRootModuleID() = %q", id)
	}
}

type fakeRunner func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error)

func (f fakeRunner) Run(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
	return f(ctx, dir, env, name, args...)
}

func newTestAnalyzer(runner Runner) *Analyzer {
	analyzer := NewAnalyzer(runner)
	analyzer.SetLenses(NewOpenSSFScorecardLens(fakeScoreProvider{}))
	return analyzer
}

type fakeScoreProvider map[string]OpenSSFScore

func (f fakeScoreProvider) FetchOpenSSFScores(_ context.Context, deps []OpenSSFScoreRequest) map[string]OpenSSFScore {
	results := make(map[string]OpenSSFScore, len(deps))
	for _, dep := range deps {
		if score, ok := f[dep.Module+"@"+dep.Version]; ok {
			results[dep.ID] = score
		}
	}
	return results
}

func scoreValue(score float64) OpenSSFScore {
	return OpenSSFScore{
		Status: openSSFStatusFound,
		Score:  &score,
	}
}

func mustWriteFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func indexNodes(nodes []Node) map[string]Node {
	index := make(map[string]Node, len(nodes))
	for _, node := range nodes {
		index[node.ID] = node
	}
	return index
}

func commandKey(name string, args ...string) string {
	return strings.Join(append([]string{name}, args...), " ")
}
