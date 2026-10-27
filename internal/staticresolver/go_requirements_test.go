package staticresolver

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
)

func TestSharedModuleParser(t *testing.T) {
	for _, tc := range []struct{ body, minimum string }{
		{"module example.org/a\ngo 1.26.7 // minimum\ntoolchain go1.27.3\n", "1.26.7"},
		{"module\texample.org/a\ngo\t1.26\nrequire\texample.org/b v1.0.0\n", "1.26"},
		{"module \"example.org/a\"\n// go 1.99\ntoolchain go1.27.3\n", ""},
	} {
		meta, err := parseGoMod(tc.body)
		if err != nil || meta.GoVersion != tc.minimum {
			t.Fatalf("parseGoMod(%q) = %+v, %v", tc.body, meta, err)
		}
	}
	meta, err := parseGoMod("module example.org/a\nrequire\texample.org/b v1.0.0\n")
	if err != nil || len(meta.Requires) != 1 {
		t.Fatalf("tabbed requirement lost: %+v, %v", meta, err)
	}
	for _, body := range []string{"", "<html>error</html>", "module x\ngo invalid", "module x\ngo 1.26\ngo 1.27", "module x\ngo", "module x\n/* unfinished", "module x\ngo 1.026", "module x\ngo go1.26", "module x\ngo 1.17.0junk", "module x\ngo 1.17.0-custom1", "module x\ngo 2"} {
		if _, err := parseGoMod(body); err == nil {
			t.Fatalf("malformed metadata accepted: %q", body)
		}
	}
}

type requirementFetcher struct {
	mu    sync.Mutex
	files fakeFetcher
	calls map[string]int
}

func (f *requirementFetcher) FetchText(ctx context.Context, request FetchRequest) (string, error) {
	f.mu.Lock()
	f.calls[request.URL]++
	f.mu.Unlock()
	return f.files.FetchText(ctx, request)
}

func TestGraphReusesExactVersionModuleMetadata(t *testing.T) {
	fetcher := &requirementFetcher{calls: make(map[string]int), files: fakeFetcher{
		proxyModuleURL("example.org/root") + "/@v/v1.0.0.info": `{"Version":"v1.0.0"}`,
		proxyModuleURL("example.org/root") + "/@v/v1.0.0.mod":  "module example.org/root\ngo 1.26\nrequire (\nexample.org/a v1.0.0\nexample.org/local v1.0.0\n)\nreplace example.org/a => example.org/fork v1.2.0\nreplace example.org/local => ../local\n",
		proxyModuleURL("example.org/fork") + "/@v/v1.2.0.mod":  "module example.org/a\ngo 1.25.7\nrequire example.org/pruned v1.0.0\n",
	}}
	result, err := New(fetcher).ResolveGraph(context.Background(), "example.org/root@v1.0.0", Options{})
	if err != nil {
		t.Fatal(err)
	}
	root := nodeByID(result.Nodes, result.RootID)
	if root.GoRequirement == nil || root.GoRequirement.Minimum != "1.26" {
		t.Fatalf("root metadata missing: %+v", root)
	}
	dep := nodeByID(result.Nodes, "example.org/a@v1.0.0")
	if dep.GoRequirement == nil || dep.GoRequirement.Minimum != "1.25.7" || dep.GoRequirement.Identity.Name != "example.org/fork" || dep.GoRequirement.Identity.Version != "v1.2.0" {
		t.Fatalf("replacement metadata incorrect: %+v", dep)
	}
	if dep.GoRequirement.Source != proxyModuleURL("example.org/fork")+"/@v/v1.2.0.mod" || dep.GoRequirement.ObservedAt == "" {
		t.Fatalf("metadata provenance missing: %+v", dep.GoRequirement)
	}
	for _, id := range []string{"example.org/local@v1.0.0", "example.org/pruned@v1.0.0"} {
		if node := nodeByID(result.Nodes, id); node == nil || node.GoRequirement != nil {
			t.Fatalf("unread metadata invented: %+v", node)
		}
	}
	if got := fetcher.calls[proxyModuleURL("example.org/fork")+"/@v/v1.2.0.mod"]; got != 1 {
		t.Fatalf("replacement fetched %d times", got)
	}
}

func TestRequirementsLookupDeduplicatesResolvedIdentitiesAndPreservesUnknowns(t *testing.T) {
	fetcher := &requirementFetcher{calls: make(map[string]int), files: fakeFetcher{
		proxyModuleURL("example.org/fork") + "/@v/v1.2.0.mod": "module example.org/original\n",
		proxyModuleURL("example.org/bad") + "/@v/v1.0.0.mod":  "<html>failed</html>",
	}}
	nodes := []graph.Node{
		{ID: "a", Name: "example.org/a", Version: "v1.0.0", Replaced: true, Replacement: "example.org/fork@v1.2.0"},
		{ID: "b", Name: "example.org/b", Version: "v1.0.0", Replaced: true, Replacement: "example.org/fork@v1.2.0"},
		{ID: "local", Name: "example.org/local", Version: "v1.0.0", Replaced: true, Replacement: "../local"},
		{ID: "bad", Name: "example.org/bad", Version: "v1.0.0"},
		{ID: "failed", Name: "example.org/failed", Version: "v1.0.0"},
	}
	var completed int
	result, err := New(fetcher).LookupGoRequirements(context.Background(), nodes, func(done, total int) {
		completed = done
		if total != len(nodes) {
			t.Errorf("total = %d", total)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		record := result.Records[id]
		if record.Status != "observed" || record.Minimum != "1.16" || !record.Implicit || record.Identity.Name != "example.org/fork" {
			t.Fatalf("%s: %+v", id, record)
		}
	}
	for _, id := range []string{"local", "bad", "failed"} {
		if record := result.Records[id]; record.Status != "unknown" || record.Minimum != "" {
			t.Fatalf("%s: %+v", id, record)
		}
	}
	if fetcher.calls[proxyModuleURL("example.org/fork")+"/@v/v1.2.0.mod"] != 1 || completed != len(nodes) || result.CapturedAt == "" {
		t.Fatalf("calls=%v completed=%d", fetcher.calls, completed)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New(fetcher).LookupGoRequirements(ctx, nodes, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled lookup returned %v", err)
	}
}
