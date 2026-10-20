package staticresolver

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
	"github.com/amer8/gomod-lens/internal/modproxytest"
)

func TestRootReplacementsOnlyApplyToRequiredDependencyVersions(t *testing.T) {
	for _, goVersion := range []string{"1.16", "1.26"} {
		for _, selector := range []string{"", "v1.0.0"} {
			for _, requiredRootVersion := range []string{"", "v0.9.0", "v1.0.0", "v1.1.0"} {
				t.Run(fmt.Sprintf("go%s/selector=%s/required=%s", goVersion, selector, requiredRootVersion), func(t *testing.T) {
					rootMod := "module example.org/root\n\ngo " + goVersion + "\nrequire (\nexample.org/a v1.0.0\nexample.org/d v1.0.0\n)\nreplace example.org/root " + selector + " => example.org/fork v1.0.0\n"
					aMod := "module example.org/a\n\ngo 1.16\n"
					if requiredRootVersion != "" {
						aMod += "require example.org/root " + requiredRootVersion + "\n"
					}
					modules := map[string]string{
						"example.org/root@v1.0.0": rootMod,
						"example.org/root@v0.9.0": "module example.org/root\n\ngo 1.16\nrequire example.org/d v1.1.0\n",
						"example.org/root@v1.1.0": "module example.org/root\n\ngo 1.16\nrequire example.org/d v1.1.0\n",
						"example.org/a@v1.0.0":    aMod,
						"example.org/fork@v1.0.0": "module example.org/fork\n\ngo 1.16\nrequire example.org/d v1.2.0\n",
						"example.org/d@v1.0.0":    "module example.org/d\n\ngo 1.16\n",
						"example.org/d@v1.1.0":    "module example.org/d\n\ngo 1.16\n",
						"example.org/d@v1.2.0":    "module example.org/d\n\ngo 1.16\n",
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
					result, err := New(fetcher).ResolveGraph(context.Background(), "example.org/root@v1.0.0", Options{})
					if err != nil {
						t.Fatal(err)
					}
					if len(result.Nodes) != len(want) {
						t.Fatalf("build lists differ: browser=%+v, Go=%v", result.Nodes, want)
					}
					for _, node := range result.Nodes {
						if version, ok := want[node.Name]; !ok || node.Version != version {
							t.Errorf("browser selected %s@%s, Go selects %q (present=%t)", node.Name, node.Version, version, ok)
						}
					}
					root := nodeByID(result.Nodes, result.RootID)
					if root == nil || !root.Root || !root.Main || root.Replaced || root.Replacement != "" {
						t.Fatalf("main module was replaced: %+v", root)
					}
					if root.OpenSSF == nil || root.OpenSSF.Module != "example.org/root" || root.OpenSSF.Version != "v1.0.0" {
						t.Fatalf("Scorecard lookup did not use the main module: %+v", root.OpenSSF)
					}
					freshnessRequest, skipped := graph.ReleaseFreshnessRequestForNode(*root)
					if skipped != nil || freshnessRequest.Module != "example.org/root" || freshnessRequest.Version != "v1.0.0" {
						t.Fatalf("freshness lookup did not use the main module: %+v, skipped=%+v", freshnessRequest, skipped)
					}
				})
			}
		}
	}
}
