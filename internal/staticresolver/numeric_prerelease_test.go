package staticresolver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/modproxytest"
)

func TestLargeNumericVersionSelectionMatchesGo(t *testing.T) {
	for _, tc := range []struct{ name, lower, higher string }{
		{"prerelease", "v1.0.0-9223372036854775808", "v1.0.0-10000000000000000000"},
		{"patch", "v1.0.9", "v1.0.9223372036854775808"},
		{"minor", "v1.9.0", "v1.9223372036854775808.0"},
		{"large patches", "v1.0.9223372036854775808", "v1.0.10000000000000000000"},
		{"large minors", "v1.9223372036854775808.0", "v1.10000000000000000000.0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lower, higher := tc.lower, tc.higher
			rootMod := "module example.org/root\n\ngo 1.16\nrequire (\nexample.org/a " + lower + "\nexample.org/b v1.0.0\n)\n"
			modules := map[string]string{
				"example.org/root@v1.0.0": rootMod,
				"example.org/a@" + lower:  "module example.org/a\n\ngo 1.16\n",
				"example.org/a@" + higher: "module example.org/a\n\ngo 1.16\n",
				"example.org/b@v1.0.0":    "module example.org/b\n\ngo 1.16\nrequire example.org/a " + higher + "\n",
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
			if !strings.Contains(string(output), "example.org/a "+higher+"\n") {
				t.Fatalf("Go did not select the higher numeric version: %s", output)
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
			if nodeByID(result.Nodes, "example.org/a@"+higher) == nil || nodeByID(result.Nodes, "example.org/a@"+lower) != nil {
				t.Fatalf("browser disagrees with Go's selected version: %+v", result.Nodes)
			}
		})
	}
}
