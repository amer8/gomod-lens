package staticresolver

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/amer8/gomod-lens/internal/graph"
)

func TestEdgeBudgetCountsDistinctDirectedEndpoints(t *testing.T) {
	entries := []moduleRef{
		{Path: "a", ID: "a@v1"}, {Path: "b", ID: "b@v2"}, {Path: "c", ID: "c@v1"},
	}
	loaded := map[string]moduleMeta{
		"a@v1": {Requires: []requirement{{Path: "b"}, {Path: "b"}, {Path: "a"}}},
		"c@v1": {Requires: []requirement{{Path: "b"}}},
	}
	const endpointBytes = len("a@v1b@v2c@v1b@v2")
	edges, err := graphEdges(context.Background(), entries, loaded, nil, endpointBytes)
	if err != nil || len(edges) != 2 || edges[0].Target != "b@v2" || edges[1].Target != "b@v2" {
		t.Fatalf("exact endpoint budget: edges=%v err=%v", edges, err)
	}
	if _, err := graphEdges(context.Background(), entries, loaded, nil, endpointBytes-1); err == nil {
		t.Fatal("accepted graph exceeding the endpoint budget")
	}
}

func TestFailedAndConcurrentManifestReadsShareBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	readErr := errors.New("interrupted read")
	started := make(chan struct{}, 2)
	resume := make(chan struct{})
	fetch := &graphFetcher{manifestBytesLeft: 5, Fetcher: fetchFunc(func(ctx context.Context, req FetchRequest) (string, error) {
		started <- struct{}{}
		select {
		case <-resume:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		if err := req.ChargeBytes(3); err != nil {
			return "", err
		}
		return "", readErr
	})}
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := fetch.FetchText(ctx, FetchRequest{URL: "a.mod"})
			errs <- err
		}()
	}
	for range 2 {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("concurrent manifest reads did not start")
		}
	}
	close(resume)
	got := make(map[error]int)
	for range 2 {
		got[<-errs]++
	}
	if got[readErr] != 1 || got[errManifestBudget] != 1 {
		t.Fatalf("concurrent charges returned %v", got)
	}
	_, err := fetch.FetchText(context.Background(), FetchRequest{URL: "b.mod"})
	if !errors.Is(err, errManifestBudget) || len(started) != 0 {
		t.Fatalf("issued another manifest read after exhaustion: %v", err)
	}
}

func TestRequirementsBudgetIsSharedAndRenewedPerLookup(t *testing.T) {
	const manifest = "module example.org/component\ngo 1.26\n"
	fetch := fetchFunc(func(_ context.Context, req FetchRequest) (string, error) {
		if req.ChargeBytes == nil {
			return "", errors.New("missing manifest budget")
		}
		// Simulate bytes delivered by a stream without allocating a large fixture.
		if err := req.ChargeBytes(maxGraphGoModBytes); err != nil {
			return "", err
		}
		return manifest, nil
	})
	resolver := New(fetch)
	nodes := []graph.Node{
		{ID: "a", Name: "example.org/a", Version: "v1.0.0"},
		{ID: "b", Name: "example.org/b", Version: "v1.0.0"},
	}
	for range 2 {
		result, err := resolver.LookupGoRequirements(context.Background(), nodes, nil)
		if err != nil {
			t.Fatal(err)
		}
		var observed, exhausted int
		for _, record := range result.Records {
			if record.Status == "observed" && record.Minimum == "1.26" {
				observed++
			}
			if record.Status == "unknown" && record.Error == errManifestBudget.Error() {
				exhausted++
			}
		}
		if observed != 1 || exhausted != 1 || len(resolver.modFileCache) != 0 {
			t.Fatalf("lookup did not isolate its budget and parsed manifests: %+v", result)
		}
	}
}

func TestReplacementIndexPreservesDuplicatePrecedence(t *testing.T) {
	rules := []replacement{
		{OldPath: "a", NewPath: "first-wildcard"},
		{OldPath: "a", OldVersion: "v1.0.0", NewPath: "first-exact"},
		{OldPath: "a", OldVersion: "v1.0.0", NewPath: "last-exact"},
		{OldPath: "a", NewPath: "last-wildcard"},
	}
	index := indexReplacements(rules)
	if len(index) != 2 || index.lookup("a", "v1.0.0") != &rules[1] || index.lookup("a", "v1.1.0") != &rules[3] {
		t.Fatalf("unexpected replacement index: %v", index)
	}
	// The lookup keys were captured when the root was indexed. Looking up
	// a version again must not search the original directives.
	for i := range rules {
		rules[i].OldPath = "changed"
	}
	if index.lookup("changed", "v1.0.0") != nil || index.lookup("a", "v1.0.0") != &rules[1] {
		t.Fatal("lookup consulted the source rule list after indexing")
	}
}

func TestRequirementsBudgetChargesEachReplacementAlias(t *testing.T) {
	result := GoRequirements{Records: make(map[string]graph.GoRequirement)}
	observation := graph.GoRequirement{Status: "unknown", Error: "invalid metadata"}
	budget := 1000
	if err := result.record([]string{"a"}, observation, &budget); err != nil {
		t.Fatal(err)
	}
	oneEntry := 1000 - budget
	budget = oneEntry
	if err := result.record([]string{"b", "c"}, observation, &budget); err == nil {
		t.Fatal("a shared observation was only charged once")
	}
}

func TestReleaseHistorySharedAcrossAliasesAndRetriedOnRefresh(t *testing.T) {
	root := proxyModuleURL("example.org/root") + "/@v/"
	fork := proxyModuleURL("example.org/fork") + "/@v/"
	files := &requirementFetcher{calls: make(map[string]int), files: fakeFetcher{
		root + "list": "v1.0.0\n",
		root + "v1.0.0.mod": `module example.org/root
require example.org/a v1.0.0
require example.org/b v1.0.0
replace example.org/a => example.org/fork v1.0.0
replace example.org/b => example.org/fork v1.1.0
`,
		fork + "list":       "v1.0.0\nv1.1.0\nv1.2.0\n",
		fork + "v1.0.0.mod": "module example.org/fork\n",
		fork + "v1.1.0.mod": "module example.org/fork\n",
		fork + "v1.2.0.mod": "module example.org/fork\ngo invalid\n",
	}}
	resolver := New(files)
	for attempt := 1; attempt <= 2; attempt++ {
		if attempt == 2 {
			files.files[fork+"v1.2.0.mod"] = "module example.org/fork\nretract v1.0.0\n"
		}
		result, err := resolver.ResolveGraph(t.Context(), "example.org/root@latest", Options{})
		if err != nil {
			t.Fatal(err)
		}
		for _, url := range []string{root + "list", fork + "list", fork + "v1.2.0.mod"} {
			if reads := files.calls[url]; reads != attempt {
				t.Errorf("analysis %d: %s read %d times in total, want %d", attempt, url, reads, attempt)
			}
		}
		for name, successStatus := range map[string]string{
			"example.org/a": graph.ReleaseFreshnessStatusRetracted,
			"example.org/b": graph.ReleaseFreshnessStatusMinorBehind,
		} {
			node := nodeByID(result.Nodes, name+"@v1.0.0")
			if node == nil {
				t.Fatalf("missing alias %s", name)
			}
			info := graph.ReleaseFreshnessForNode(*node)
			if attempt == 1 {
				if info == nil || info.Status != graph.ReleaseFreshnessStatusError {
					t.Fatalf("missing lookup error for %s: %+v", name, info)
				}
			} else if info == nil || info.Status != successStatus || info.LatestVersion != "v1.2.0" {
				t.Fatalf("incorrect refreshed observation for %s: %+v", name, info)
			}
		}
	}
}

func TestReleaseListBudgetCountsPartialReadsAcrossModules(t *testing.T) {
	interrupted := errors.New("interrupted version list")
	calls := 0
	fetcher := &graphFetcher{manifestBytesLeft: 1, releaseListBytesLeft: 5, Fetcher: fetchFunc(func(_ context.Context, req FetchRequest) (string, error) {
		calls++
		switch req.URL {
		case "a/@v/list":
			if req.ChargeBytes == nil || req.MaxBytes != 5 {
				t.Fatal("missing initial release-list budget")
			}
			if err := req.ChargeBytes(3); err != nil {
				t.Fatal(err)
			}
			return "", interrupted
		case "b/@v/list":
			if req.MaxBytes != 2 {
				t.Fatalf("second module can read %d bytes, want 2", req.MaxBytes)
			}
			return "b\n", nil
		case "a.mod":
			return "m", nil
		default:
			t.Fatalf("unexpected fetch after exhaustion: %s", req.URL)
			return "", nil
		}
	})}
	for _, tc := range []struct {
		url  string
		body string
		err  error
	}{
		{"a/@v/list", "", interrupted},
		{"b/@v/list", "b\n", nil},
		{"c/@v/list", "", errReleaseListBudget},
		{"a.mod", "m", nil},
	} {
		got, err := fetcher.FetchText(t.Context(), FetchRequest{URL: tc.url})
		if got != tc.body || !errors.Is(err, tc.err) {
			t.Errorf("%s returned %q, %v; want %q, %v", tc.url, got, err, tc.body, tc.err)
		}
	}
	if calls != 3 {
		t.Errorf("issued %d requests, want 3", calls)
	}
}
