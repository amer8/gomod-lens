package staticresolver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
	"github.com/amer8/gomod-lens/internal/modproxytest"
)

func TestRootVersionRemainsPinnedWhenDependenciesRequireAnotherVersion(t *testing.T) {
	for _, tc := range []struct {
		name   string
		rootGo string
		depGo  string
	}{
		{"legacy", "1.16", "1.16"},
		{"modern with legacy dependency", "1.26", "1.16"},
		{"pruned", "1.26", "1.26"},
	} {
		for _, requiredRootVersion := range []string{"v0.9.0", "v1.1.0"} {
			t.Run(tc.name+"/"+requiredRootVersion, func(t *testing.T) {
				rootMod := "module example.org/root\n\ngo " + tc.rootGo + "\nrequire (\nexample.org/a v1.0.0\nexample.org/d v1.0.0\n)\n"
				modules := map[string]string{
					"example.org/root@v1.0.0":                 rootMod,
					"example.org/root@" + requiredRootVersion: "module example.org/root\n\ngo 1.16\nrequire example.org/d v1.2.0\n",
					"example.org/a@v1.0.0":                    "module example.org/a\n\ngo " + tc.depGo + "\nrequire example.org/root " + requiredRootVersion + "\n",
					"example.org/d@v1.0.0":                    "module example.org/d\n\ngo 1.16\n",
					"example.org/d@v1.2.0":                    "module example.org/d\n\ngo 1.16\n",
				}
				fixtureEnv := modproxytest.Env(t, modules)
				dir := t.TempDir()
				if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(rootMod), 0o600); err != nil {
					t.Fatal(err)
				}
				command := exec.Command("go", "list", "-m", "all")
				command.Dir = dir
				command.Env = append(append(os.Environ(), fixtureEnv...), "GOFLAGS=-mod=mod")
				output, err := command.CombinedOutput()
				if err != nil {
					t.Fatalf("Go reference build list: %v: %s", err, output)
				}
				// Go reports the main module without a version. The explorer
				// identifies it by the version the user explicitly requested.
				want := map[string]string{"example.org/root": "v1.0.0"}
				for _, line := range strings.Split(string(output), "\n") {
					fields := strings.Fields(line)
					if len(fields) == 2 {
						want[fields[0]] = fields[1]
					}
				}
				fetcher := fakeFetcher{}
				for id, mod := range modules {
					at := strings.LastIndex(id, "@")
					fetcher[proxyModuleURL(id[:at])+"/@v/"+id[at+1:]+".mod"] = mod
				}
				resolver := New(fetcher)
				result, err := resolver.ResolveGraph(context.Background(), "example.org/root@v1.0.0", Options{})
				if err != nil {
					t.Fatal(err)
				}
				if result.RootID != "example.org/root@v1.0.0" || result.Meta.Target != result.RootID {
					t.Fatalf("graph no longer identifies the requested root: %+v", result)
				}
				root := nodeByID(result.Nodes, result.RootID)
				if root == nil || !root.Root || !root.Main || root.Version != "v1.0.0" {
					t.Fatalf("requested root node is missing or changed: %+v", root)
				}
				if score := graph.OpenSSFScoreForNode(*root); score == nil || score.Version != "v1.0.0" {
					t.Fatalf("Scorecard lookup used a different root version: %+v", score)
				}
				if len(result.Nodes) != len(want) {
					t.Fatalf("build lists differ: browser=%+v, Go=%v", result.Nodes, want)
				}
				for _, node := range result.Nodes {
					if version, ok := want[node.Name]; !ok || node.Version != version {
						t.Errorf("browser selected %s@%s, Go selects %q (present=%t)", node.Name, node.Version, version, ok)
					}
				}
			})
		}
	}
}
