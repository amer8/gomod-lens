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

func TestSpecificReplacementWinsRegardlessOfDirectiveOrder(t *testing.T) {
	exact := replacement{OldPath: "example.org/a", OldVersion: "v1.0.0", NewPath: "example.org/exact", NewVersion: "v1.0.1"}
	wildcard := replacement{OldPath: "example.org/a", NewPath: "example.org/general", NewVersion: "v1.0.0"}
	for _, rules := range [][]replacement{{wildcard, exact}, {exact, wildcard}} {
		if got := replacementFor("example.org/a", "v1.0.0", rules); got == nil || got.NewPath != exact.NewPath {
			t.Fatalf("specific rule lost precedence: %+v", got)
		}
		if got := replacementFor("example.org/a", "v1.1.0", rules); got == nil || got.NewPath != wildcard.NewPath {
			t.Fatalf("wildcard fallback missing: %+v", got)
		}
		if got := replacementFor("example.org/other", "v1.0.0", rules); got != nil {
			t.Fatalf("replacement matched a different module: %+v", got)
		}
	}
}

func TestPrereleaseHyphensAreNotIdentifierSeparators(t *testing.T) {
	ordered := []string{"v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta", "v1.0.0-beta.2", "v1.0.0-beta.11", "v1.0.0-beta.9223372036854775808", "v1.0.0-beta.10000000000000000000", "v1.0.0-rc.1", "v1.0.0-rc-1", "v1.0.0"}
	for i, left := range ordered {
		for j, right := range ordered {
			got := compareGoVersions(left, right)
			if i < j && got >= 0 || i == j && got != 0 || i > j && got <= 0 {
				t.Fatalf("compareGoVersions(%q, %q) = %d", left, right, got)
			}
		}
	}
}

func TestBuildListMatchesGoWhenRequiredVersionsAreSuperseded(t *testing.T) {
	for _, tc := range []struct {
		name       string
		rootGo     string
		depGo      string
		rootDirect bool
	}{
		{"legacy", "1.16", "1.16", true},
		{"modern root with legacy dependency", "1.26", "1.16", false},
		{"pruned direct upgrade", "1.26", "1.26", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rootMod := "module example.org/root\n\ngo " + tc.rootGo + "\nrequire (\nexample.org/a v1.0.0\nexample.org/b v1.0.0\n)\n"
			if !tc.rootDirect {
				rootMod = "module example.org/root\n\ngo " + tc.rootGo + "\nrequire example.org/a v1.0.0\n"
			}
			modules := map[string]string{
				"example.org/root@v1.0.0": rootMod,
				"example.org/a@v1.0.0":    "module example.org/a\n\ngo " + tc.depGo + "\nrequire (\nexample.org/b v1.1.0\nexample.org/c v1.0.0\n)\n",
				"example.org/b@v1.0.0":    "module example.org/b\n\ngo " + tc.depGo + "\nrequire example.org/d v1.2.0\n",
				"example.org/b@v1.1.0":    "module example.org/b\n\ngo " + tc.depGo + "\nrequire example.org/d v1.0.0\n",
				"example.org/c@v1.0.0":    "module example.org/c\n\ngo " + tc.depGo + "\nrequire example.org/b v1.0.0\n",
				"example.org/d@v1.0.0":    "module example.org/d\n\ngo 1.16\n",
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
			fetcher := fakeFetcher{}
			for id, mod := range modules {
				at := strings.LastIndex(id, "@")
				fetcher[proxyModuleURL(id[:at])+"/@v/"+id[at+1:]+".mod"] = mod
			}
			root := moduleRef{Path: "example.org/root", Version: "v1.0.0", ID: "example.org/root@v1.0.0"}
			resolution, err := New(fetcher).resolveBuildList(context.Background(), root, nil, nil, newProgressReporter(nil))
			if err != nil {
				t.Fatal(err)
			}
			want := make(map[string]string)
			for _, line := range strings.Split(string(output), "\n") {
				fields := strings.Fields(line)
				if len(fields) == 2 {
					want[fields[0]] = fields[1]
				}
			}
			if len(resolution.selected) != len(want)+1 {
				t.Fatalf("build lists differ: WASM=%v, Go=%v", resolution.selected, want)
			}
			for path, version := range want {
				if got := resolution.selected[path]; got != version {
					t.Fatalf("%s selected %s, Go selects %s", path, got, version)
				}
			}
		})
	}
}
