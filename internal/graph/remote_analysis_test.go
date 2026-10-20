package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/modproxytest"
)

func offlineRunner(t *testing.T, modules map[string]string) Runner {
	t.Helper()
	fixtureEnv := modproxytest.Env(t, modules)
	return fakeRunner(func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
		env = append(append([]string(nil), env...), fixtureEnv...)
		return (CommandRunner{}).Run(ctx, dir, env, name, args...)
	})
}

func TestRemoteAnalysisRejectsLocalReplacementsBeforeLoadingGraph(t *testing.T) {
	for _, target := range []string{t.TempDir(), "../private"} {
		t.Run(target, func(t *testing.T) {
			private := "module private.example/never-disclose\n\ngo 1.26\nrequire private.example/secret v1.0.0\n"
			if filepath.IsAbs(target) {
				mustWriteFile(t, filepath.Join(target, "go.mod"), private)
			}
			modules := map[string]string{
				"example.org/root@v1.0.0": fmt.Sprintf("module example.org/root\n\ngo 1.26\nrequire example.org/dep v1.0.0\nreplace example.org/dep => %s\n", target),
				"example.org/dep@v1.0.0":  "module example.org/dep\n\ngo 1.26\n",
			}
			runner := offlineRunner(t, modules)
			analysisGraphLoads := 0
			guard := fakeRunner(func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
				if filepath.Base(dir) == "analysis" && (commandKey(name, args...) == "go mod download all" || commandKey(name, args...) == "go list -m -json all" || commandKey(name, args...) == "go mod graph") {
					analysisGraphLoads++
				}
				return runner.Run(ctx, dir, env, name, args...)
			})
			analyzer := NewAnalyzer(guard)
			analyzer.SetLenses()
			_, err := analyzer.Analyze(context.Background(), Request{Target: "example.org/root@v1.0.0", Mode: ModeModule})
			if err == nil || !strings.Contains(err.Error(), "filesystem replacements") {
				t.Fatalf("expected safe rejection, got %v", err)
			}
			if strings.Contains(err.Error(), "private.example") || strings.Contains(err.Error(), target) || analysisGraphLoads != 0 {
				t.Fatalf("local replacement reached graph loading or leaked details: loads=%d, error=%v", analysisGraphLoads, err)
			}
		})
	}
}

func TestRemoteAnalysisPopulatesMissingChecksumsWithoutChangingDownload(t *testing.T) {
	modules := map[string]string{
		"example.org/root@v1.0.0":       "module example.org/root\n\ngo 1.16\nrequire example.org/dep v1.0.0\n",
		"example.org/dep@v1.0.0":        "module example.org/dep\n\ngo 1.16\nrequire example.org/transitive v1.0.0\n",
		"example.org/transitive@v1.0.0": "module example.org/transitive\n\ngo 1.16\n",
	}
	base := offlineRunner(t, modules)
	var sourceDir string
	runner := fakeRunner(func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
		out, err := base.Run(ctx, dir, env, name, args...)
		if err == nil && strings.HasPrefix(commandKey(name, args...), "go mod download -json ") {
			var download struct{ Dir string }
			if err := json.Unmarshal(out, &download); err != nil {
				t.Fatal(err)
			}
			sourceDir = download.Dir
		}
		if dir == sourceDir {
			t.Fatal("Go command ran in the immutable downloaded module")
		}
		return out, err
	})
	analyzer := NewAnalyzer(runner)
	analyzer.SetLenses()
	result, err := analyzer.Analyze(context.Background(), Request{Target: "example.org/root@v1.0.0", Mode: ModeModule})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := indexNodes(result.Nodes)["example.org/transitive@v1.0.0"]; !ok || len(result.Nodes) != 3 {
		t.Fatalf("missing dependency graph: %+v", result.Nodes)
	}
	mod, err := os.ReadFile(filepath.Join(sourceDir, "go.mod"))
	if err != nil || string(mod) != modules["example.org/root@v1.0.0"] {
		t.Fatal("downloaded go.mod changed", err)
	}
	if _, err := os.Stat(filepath.Join(sourceDir, "go.sum")); !os.IsNotExist(err) {
		t.Fatalf("downloaded go.sum was modified: %v", err)
	}
}

func TestRemoteAnalysisAppliesRootReplacementsBeforeLoadingDependencies(t *testing.T) {
	for _, goVersion := range []string{"1.16", "1.26"} {
		t.Run(goVersion, func(t *testing.T) {
			modules := map[string]string{
				"example.org/root@v1.0.0": "module example.org/root\n\ngo " + goVersion + "\nrequire example.org/unpublished v1.0.0\nreplace example.org/unpublished => example.org/fork v1.0.0\n",
				"example.org/fork@v1.0.0": "module example.org/fork\n\ngo " + goVersion + "\n",
			}
			base := offlineRunner(t, modules)
			var dependencyDir string
			analyzer := NewAnalyzer(fakeRunner(func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
				output, err := base.Run(ctx, dir, env, name, args...)
				if err == nil && commandKey(name, args...) == "go list -m -json all" {
					list, _, parseErr := parseModuleList(output)
					if parseErr != nil {
						t.Fatal(parseErr)
					}
					dependencyDir = list["example.org/unpublished@v1.0.0"].Dir
				}
				return output, err
			}))
			analyzer.SetLenses()
			result, err := analyzer.Analyze(context.Background(), Request{Target: "example.org/root@v1.0.0", Mode: ModeModule})
			if err != nil {
				t.Fatal(err)
			}
			nodes := indexNodes(result.Nodes)
			dep := nodes["example.org/unpublished@v1.0.0"]
			if len(nodes) != 2 || !dep.Direct || !dep.Replaced || dep.Replacement != "example.org/fork@v1.0.0" {
				t.Fatalf("replacement-backed graph is incorrect: %+v", result.Nodes)
			}
			if dependencyDir == "" {
				t.Fatal("replacement source directory is unavailable for license detection")
			}
			if _, err := os.Stat(filepath.Join(dependencyDir, "fixture.go")); err != nil {
				t.Fatalf("replacement source archive was not downloaded: %v", err)
			}
		})
	}
}

func TestRemoteAnalysisUsesDeclaredPathFromDownloadedMetadata(t *testing.T) {
	analyzer := NewAnalyzer(offlineRunner(t, map[string]string{
		"example.org/alias@v1.0.0": "module example.org/canonical\n\ngo 1.26\n",
	}))
	analyzer.SetLenses()
	result, err := analyzer.Analyze(context.Background(), Request{Target: "example.org/alias@v1.0.0", Mode: ModeModule})
	if err != nil {
		t.Fatal(err)
	}
	if result.RootID != "example.org/canonical@v1.0.0" || result.Meta.Target != result.RootID || len(result.Nodes) != 1 {
		t.Fatalf("declared module identity was not preserved: %+v", result)
	}
}

func TestRemoteAnalysisPreservesDirectRequirementsAfterVersionUpgrades(t *testing.T) {
	for _, goVersion := range []string{"1.16", "1.26"} {
		t.Run(goVersion, func(t *testing.T) {
			modules := map[string]string{
				"example.org/root@v1.0.0": "module example.org/root\n\ngo " + goVersion + "\nrequire (\nexample.org/a v1.0.0\nexample.org/b v1.0.0\nexample.org/c v1.0.0 // indirect\n)\n",
				"example.org/a@v1.0.0":    "module example.org/a\n\ngo " + goVersion + "\nrequire (\nexample.org/b v1.1.0\nexample.org/c v1.1.0\n)\n",
				"example.org/b@v1.0.0":    "module example.org/b\n\ngo " + goVersion + "\n",
				"example.org/b@v1.1.0":    "module example.org/b\n\ngo " + goVersion + "\n",
				"example.org/c@v1.0.0":    "module example.org/c\n\ngo " + goVersion + "\n",
				"example.org/c@v1.1.0":    "module example.org/c\n\ngo " + goVersion + "\n",
			}
			analyzer := NewAnalyzer(offlineRunner(t, modules))
			analyzer.SetLenses()
			result, err := analyzer.Analyze(context.Background(), Request{Target: "example.org/root@v1.0.0", Mode: ModeModule})
			if err != nil {
				t.Fatal(err)
			}
			nodes := indexNodes(result.Nodes)
			for id, wantDirect := range map[string]bool{
				"example.org/root@v1.0.0": false,
				"example.org/a@v1.0.0":    true,
				"example.org/b@v1.1.0":    true,
				"example.org/c@v1.1.0":    false,
			} {
				node, ok := nodes[id]
				if !ok || node.Direct != wantDirect {
					t.Errorf("node %s = %+v (present=%t), want Direct=%t", id, node, ok, wantDirect)
				}
			}
			if len(nodes) != 4 {
				t.Fatalf("expected four selected modules, got %+v", result.Nodes)
			}
		})
	}
}
