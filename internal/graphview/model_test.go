package graphview

import (
	"encoding/json"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
)

func TestOpenSSFGroupsUsesFiveScoreBuckets(t *testing.T) {
	t.Parallel()

	groups := OpenSSFGroups(graph.Graph{
		Nodes: []graph.Node{
			scoreNode("excellent", 9.0),
			scoreNode("strong", 7.0),
			scoreNode("moderate", 5.0),
			scoreNode("weak", 3.0),
			scoreNode("poor", 2.9),
			{ID: "missing", Lenses: graph.LensResults{graph.LensOpenSSF: {Status: "no_scorecard"}}},
		},
	})

	got := make(map[string]int, len(groups))
	for _, group := range groups {
		got[group.Name] = group.Count
	}

	for _, want := range []string{
		"9.0 - 10",
		"7.0 - 8.9",
		"5.0 - 6.9",
		"3.0 - 4.9",
		"0 - 2.9",
		"no scorecard",
	} {
		if got[want] != 1 {
			t.Fatalf("group %q count = %d, want 1; groups = %+v", want, got[want], groups)
		}
	}
}

func TestRelationGroupsUseNonDirectModulesLabel(t *testing.T) {
	t.Parallel()

	model := New(graph.Graph{
		Nodes: []graph.Node{
			{ID: "root", Root: true},
			{ID: "direct", Direct: true},
			{ID: "transitive"},
		},
	})

	got := make(map[string]int, len(model.RelationGroups))
	for _, group := range model.RelationGroups {
		got[group.Name] = group.Count
	}
	if got["non-direct modules"] != 1 {
		t.Fatalf("relation groups = %+v, want non-direct modules bucket", model.RelationGroups)
	}
	if _, ok := got["indirect dependencies"]; ok {
		t.Fatalf("relation groups should not use indirect dependencies label: %+v", model.RelationGroups)
	}
	if _, ok := got["replacements"]; ok {
		t.Fatalf("relation groups should hide empty replacements bucket: %+v", model.RelationGroups)
	}
}

func TestRelationGroupsShowReplacementsWhenPresent(t *testing.T) {
	t.Parallel()

	model := New(graph.Graph{
		Nodes: []graph.Node{
			{ID: "root", Root: true},
			{ID: "replacement", Replaced: true},
		},
	})

	got := make(map[string]int, len(model.RelationGroups))
	for _, group := range model.RelationGroups {
		got[group.Name] = group.Count
	}
	if got["replacements"] != 1 {
		t.Fatalf("relation groups = %+v, want replacements bucket", model.RelationGroups)
	}
}

func TestNameEntriesShowDependencyHubsAndLeafBucket(t *testing.T) {
	t.Parallel()

	model := New(graph.Graph{
		Nodes: []graph.Node{
			{ID: "root", Name: "example.com/root", Root: true},
			{ID: "hub", Name: "example.com/hub", Direct: true},
			{ID: "mid", Name: "example.com/mid"},
			{ID: "leaf", Name: "example.com/leaf"},
			{ID: "solo", Name: "example.com/solo", Direct: true},
		},
		Edges: []graph.Edge{
			{Source: "root", Target: "hub"},
			{Source: "root", Target: "solo"},
			{Source: "hub", Target: "mid"},
			{Source: "mid", Target: "leaf"},
		},
		PackageInfo: graph.PackageInfo{
			Names: []graph.PackageName{
				{Name: "example.com/root", Count: 1, Root: true},
				{Name: "example.com/hub", Count: 1, Direct: true},
				{Name: "example.com/mid", Count: 1},
				{Name: "example.com/leaf", Count: 1},
				{Name: "example.com/solo", Count: 1, Direct: true},
			},
		},
	})

	if len(model.NameEntries) != 3 {
		t.Fatalf("name entries = %+v, want two hubs plus leaf bucket", model.NameEntries)
	}

	want := []struct {
		name            string
		dependencyCount int
		count           int
		nodesOnly       bool
	}{
		{name: "example.com/hub", dependencyCount: 2, count: 1},
		{name: "example.com/mid", dependencyCount: 1, count: 1},
		{name: "leaf modules", dependencyCount: 2, count: 2, nodesOnly: true},
	}
	for i, wantEntry := range want {
		got := model.NameEntries[i]
		if got.Name != wantEntry.name ||
			got.DependencyCount != wantEntry.dependencyCount ||
			got.Count != wantEntry.count ||
			got.NodesOnly != wantEntry.nodesOnly {
			t.Fatalf("entry %d = %+v, want %+v", i, got, wantEntry)
		}
	}
}

func TestOpenSSFGroupsSeparatesUnavailableAndErrors(t *testing.T) {
	t.Parallel()

	groups := OpenSSFGroups(graph.Graph{
		Nodes: []graph.Node{
			{ID: "missing", Lenses: graph.LensResults{graph.LensOpenSSF: {Status: "no_scorecard"}}},
			{ID: "unavailable", Lenses: graph.LensResults{graph.LensOpenSSF: {Status: "unavailable"}}},
			{ID: "no-project", Lenses: graph.LensResults{graph.LensOpenSSF: {Status: "no_project"}}},
			{ID: "skipped", Lenses: graph.LensResults{graph.LensOpenSSF: {Status: "skipped"}}},
			{ID: "error", Lenses: graph.LensResults{graph.LensOpenSSF: {Status: "error"}}},
		},
	})

	got := make(map[string]int, len(groups))
	for _, group := range groups {
		got[group.Name] = group.Count
	}

	if got["no scorecard"] != 1 {
		t.Fatalf("no scorecard count = %d, want 1; groups = %+v", got["no scorecard"], groups)
	}
	if got["score unavailable"] != 3 {
		t.Fatalf("score unavailable count = %d, want 3; groups = %+v", got["score unavailable"], groups)
	}
	if got["lookup error"] != 1 {
		t.Fatalf("lookup error count = %d, want 1; groups = %+v", got["lookup error"], groups)
	}
}

func TestOpenSSFGroupsShownWithoutLensDefinitions(t *testing.T) {
	t.Parallel()

	groups := OpenSSFGroups(graph.Graph{
		Nodes: []graph.Node{scoreNode("excellent", 9.0)},
	})

	if len(groups) != 1 || groups[0].Name != "9.0 - 10" || groups[0].Count != 1 {
		t.Fatalf("groups = %+v, want excellent bucket", groups)
	}
}

func TestOpenSSFGroupsReadGenericLensResults(t *testing.T) {
	t.Parallel()

	score := 7.5
	groups := OpenSSFGroups(graph.Graph{
		Nodes: []graph.Node{{
			ID: "generic",
			Lenses: graph.LensResults{
				graph.LensOpenSSF: {
					Status: "found",
					Score:  &score,
				},
			},
		}},
	})

	if len(groups) != 1 || groups[0].Name != "7.0 - 8.9" || groups[0].Count != 1 {
		t.Fatalf("groups = %+v, want strong bucket", groups)
	}
}

func TestLensGroupsJSONDoesNotDependOnPresentationDefinitions(t *testing.T) {
	t.Parallel()

	score := 8.2
	g := graph.Graph{Nodes: []graph.Node{{
		ID: "module",
		Lenses: graph.LensResults{
			graph.LensOpenSSF:          {Status: "found", Score: &score},
			graph.LensReleaseFreshness: graph.ClassifyReleaseFreshness("example.com/mod", "v1.2.0", "v1.3.0").LensResult(),
		},
	}}}
	for _, definitions := range [][]graph.LensDefinition{
		nil,
		{graph.ReleaseFreshnessLensDefinition(), graph.OpenSSFLensDefinition()},
		{graph.OpenSSFLensDefinition(), graph.OpenSSFLensDefinition(), {ID: "custom"}},
	} {
		g.Meta.Lenses = definitions
		raw, err := json.Marshal(NewResponse(g))
		if err != nil {
			t.Fatal(err)
		}
		var payload struct {
			ViewModel struct {
				LensGroups map[string][]GroupEntry `json:"lensGroups"`
			} `json:"viewModel"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		for id, want := range map[string]string{graph.LensOpenSSF: "7.0 - 8.9", graph.LensReleaseFreshness: "minor behind"} {
			groups := payload.ViewModel.LensGroups[id]
			if len(groups) != 1 || groups[0].Name != want || groups[0].Count != 1 || len(groups[0].IDs) != 1 || groups[0].IDs[0] != "module" {
				t.Fatalf("%s groups = %+v, want one module in %s; definitions = %+v", id, groups, want, definitions)
			}
		}
	}
}

func TestLensGroupsEmptyGraph(t *testing.T) {
	t.Parallel()

	groups := New(graph.Graph{}).LensGroups
	for _, id := range []string{graph.LensOpenSSF, graph.LensReleaseFreshness} {
		if len(groups[id]) != 0 {
			t.Fatalf("empty graph has %s distribution: %+v", id, groups[id])
		}
	}
}

func scoreNode(id string, score float64) graph.Node {
	return graph.Node{
		ID:     id,
		Lenses: graph.LensResults{graph.LensOpenSSF: {Status: "found", Score: &score}},
	}
}
