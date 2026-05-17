package app

import (
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
)

func TestOpenSSFGroupsUsesFiveScoreBuckets(t *testing.T) {
	t.Parallel()

	groups := openSSFGroups(graph.Graph{
		Nodes: []graph.Node{
			scoreNode("excellent", 9.0),
			scoreNode("strong", 7.0),
			scoreNode("moderate", 5.0),
			scoreNode("weak", 3.0),
			scoreNode("poor", 2.9),
			{ID: "missing", OpenSSF: &graph.OpenSSFScore{Status: "no_scorecard"}},
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

	model := newGraphViewModel(graph.Graph{
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

	model := newGraphViewModel(graph.Graph{
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

	model := newGraphViewModel(graph.Graph{
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

	groups := openSSFGroups(graph.Graph{
		Nodes: []graph.Node{
			{ID: "missing", OpenSSF: &graph.OpenSSFScore{Status: "no_scorecard"}},
			{ID: "unavailable", OpenSSF: &graph.OpenSSFScore{Status: "unavailable"}},
			{ID: "no-project", OpenSSF: &graph.OpenSSFScore{Status: "no_project"}},
			{ID: "skipped", OpenSSF: &graph.OpenSSFScore{Status: "skipped"}},
			{ID: "error", OpenSSF: &graph.OpenSSFScore{Status: "error"}},
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

func TestOpenSSFGroupsShownWithoutOverlayFlag(t *testing.T) {
	t.Parallel()

	groups := openSSFGroups(graph.Graph{
		Nodes: []graph.Node{scoreNode("excellent", 9.0)},
	})

	if len(groups) != 1 || groups[0].Name != "9.0 - 10" || groups[0].Count != 1 {
		t.Fatalf("groups = %+v, want excellent bucket", groups)
	}
}

func TestOpenSSFGroupsReadGenericLensResults(t *testing.T) {
	t.Parallel()

	score := 7.5
	groups := openSSFGroups(graph.Graph{
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

func TestLensPanelsIncludeOpenSSFPanel(t *testing.T) {
	t.Parallel()

	score := 8.2
	model := newGraphViewModel(graph.Graph{
		Meta: graph.GraphMeta{
			Lenses: []graph.LensDefinition{graph.OpenSSFLensDefinition()},
		},
		Nodes: []graph.Node{{
			ID: "scored",
			Lenses: graph.LensResults{
				graph.LensOpenSSF: {
					Status: "found",
					Score:  &score,
				},
			},
		}},
	})

	if len(model.LensPanels) != 1 {
		t.Fatalf("lens panel count = %d, want 1", len(model.LensPanels))
	}
	panel := model.LensPanels[0]
	if panel.ID != graph.LensOpenSSF || panel.Name != "OpenSSF Scorecard" || !panel.Active {
		t.Fatalf("lens panel = %+v, want OpenSSF Scorecard", panel)
	}
	if panel.Count != 1 || len(panel.Groups) != 1 || panel.Groups[0].Name != "7.0 - 8.9" {
		t.Fatalf("lens panel groups = %+v, want strong OpenSSF bucket", panel)
	}
}

func TestLensPanelsIncludeReleaseFreshnessPanel(t *testing.T) {
	t.Parallel()

	score := 8.2
	freshness := graph.ClassifyReleaseFreshness("example.com/mod", "v1.2.0", "v1.3.0").LensResult()
	model := newGraphViewModel(graph.Graph{
		Meta: graph.GraphMeta{
			Lenses: []graph.LensDefinition{
				graph.OpenSSFLensDefinition(),
				graph.ReleaseFreshnessLensDefinition(),
			},
		},
		Nodes: []graph.Node{{
			ID: "stale",
			Lenses: graph.LensResults{
				graph.LensOpenSSF: {
					Status: "found",
					Score:  &score,
				},
				graph.LensReleaseFreshness: freshness,
			},
		}},
	})

	if len(model.LensPanels) != 2 {
		t.Fatalf("lens panel count = %d, want 2", len(model.LensPanels))
	}
	if model.LensPanels[0].ID != graph.LensOpenSSF || !model.LensPanels[0].Active {
		t.Fatalf("first lens panel = %+v, want active OpenSSF panel", model.LensPanels[0])
	}
	releasePanel := model.LensPanels[1]
	if releasePanel.ID != graph.LensReleaseFreshness || releasePanel.Name != "Release Freshness" || releasePanel.Active {
		t.Fatalf("release lens panel = %+v, want inactive Release Freshness panel", releasePanel)
	}
	if releasePanel.Count != 1 || len(releasePanel.Groups) != 1 || releasePanel.Groups[0].Name != "minor behind" {
		t.Fatalf("release lens groups = %+v, want minor behind bucket", releasePanel.Groups)
	}
}

func scoreNode(id string, score float64) graph.Node {
	return graph.Node{
		ID: id,
		OpenSSF: &graph.OpenSSFScore{
			Status: "found",
			Score:  &score,
		},
	}
}
