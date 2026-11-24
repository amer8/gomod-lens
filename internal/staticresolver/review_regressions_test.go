package staticresolver

import (
	"context"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
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

type fetchFunc func(context.Context, FetchRequest) (string, error)

func (f fetchFunc) FetchText(ctx context.Context, req FetchRequest) (string, error) {
	return f(ctx, req)
}

func TestProxyRetractionsAndIncompatibleVersionsMatchGo(t *testing.T) {
	const rootMod = "module example.org/root\n\ngo 1.16\nrequire (\nexample.org/pinned v1.1.0\nexample.org/legacy v1.0.0\n)\n"
	const pinned = "module example.org/pinned\n\ngo 1.16\nrequire example.org/legacy v2.1.0+incompatible\n"
	env := modproxytest.Env(t, map[string]string{
		"example.org/root@v1.0.0":                rootMod,
		"example.org/pinned@v1.0.0":              pinned,
		"example.org/pinned@v1.1.0":              pinned,
		"example.org/pinned@v1.2.0":              pinned + "retract [v1.1.0, v1.2.0]\n",
		"example.org/legacy@v1.0.0":              "module example.org/legacy\n",
		"example.org/legacy@v2.1.0+incompatible": "module example.org/legacy\n",
	})
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(rootMod), 0o600); err != nil {
		t.Fatal(err)
	}
	goList := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("go", append([]string{"list", "-m"}, args...)...)
		cmd.Dir = dir
		cmd.Env = append(append(os.Environ(), env...), "GOFLAGS=-mod=mod")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("go list: %v: %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	var proxyDir string
	for _, value := range env {
		if raw, ok := strings.CutPrefix(value, "GOPROXY="); ok {
			u, err := url.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			proxyDir = filepath.FromSlash(u.Path)
		}
	}
	r := New(fetchFunc(func(_ context.Context, req FetchRequest) (string, error) {
		if path, ok := strings.CutPrefix(req.URL, proxyBaseURL+"/"); ok {
			raw, err := os.ReadFile(filepath.Join(proxyDir, filepath.FromSlash(path)))
			if !os.IsNotExist(err) {
				return string(raw), err
			}
		}
		return "", &HTTPError{Status: 404, URL: req.URL}
	}))
	result, err := r.ResolveGraph(context.Background(), "example.org/root@v1.0.0", Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range strings.Fields(goList("-f", "{{if .Version}}{{.Path}}@{{.Version}}{{end}}", "all")) {
		if nodeByID(result.Nodes, id) == nil {
			t.Errorf("missing Go build-list entry %s", id)
		}
	}
	selected := nodeByID(result.Nodes, "example.org/pinned@v1.1.0")
	if selected == nil || len(result.Nodes) != 3 || nodeByID(result.Nodes, "example.org/legacy@v2.1.0+incompatible") == nil {
		t.Fatalf("unexpected build list: %+v", result.Nodes)
	}
	want := goList("-f", "{{.Version}}", "example.org/pinned@latest")
	info := graph.ReleaseFreshnessForNode(*selected)
	if want != "v1.0.0" || info == nil || info.Status != graph.ReleaseFreshnessStatusRetracted || info.LatestVersion != want {
		t.Fatalf("Go latest=%s, pinned freshness=%+v", want, info)
	}
	latest, err := r.ResolveGraph(context.Background(), "example.org/pinned@latest", Options{})
	if err != nil || latest.RootID != "example.org/pinned@"+want {
		t.Fatalf("latest graph=%v err=%v", latest, err)
	}
}

func TestExplicitVersionLookupPropagatesTransientFailuresAndRetries(t *testing.T) {
	const path = "example.org/module"
	const version = "v1.2.3"
	for _, failure := range []error{&HTTPError{Status: 429}, &HTTPError{Status: 503}, context.DeadlineExceeded} {
		t.Run(failure.Error(), func(t *testing.T) {
			calls := 0
			r := New(fetchFunc(func(_ context.Context, req FetchRequest) (string, error) {
				if !strings.HasSuffix(req.URL, "/@v/v1.2.3.info") {
					t.Fatalf("unexpected request %s", req.URL)
				}
				calls++
				if calls == 1 {
					return "", failure
				}
				return `{"Version":"v1.2.3"}`, nil
			}))
			if _, err := r.ResolveGraph(context.Background(), path+"@"+version, Options{}); !errors.Is(err, failure) {
				t.Fatalf("resolution returned %v, want %v", err, failure)
			}
			got, err := r.resolveVersionInfo(context.Background(), path, version)
			if err != nil || got != version || calls != 2 {
				t.Fatalf("retry returned %q, %v after %d calls", got, err, calls)
			}
		})
	}
}
