package graph

import (
	"context"
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
				if filepath.Base(dir) == "analysis" && (commandKey(name, args...) == "go list -m -json all" || commandKey(name, args...) == "go mod graph") {
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
		if err == nil && commandKey(name, args...) == "go list -m -json all" && filepath.Base(dir) != "analysis" {
			list, _, parseErr := parseModuleList(out)
			if parseErr != nil {
				t.Fatal(parseErr)
			}
			sourceDir = list["example.org/root@v1.0.0"].Dir
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
