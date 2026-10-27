package graph

import "testing"

func TestDescendantCountsAreSharedWithoutMutatingInput(t *testing.T) {
	g := Graph{Nodes: []Node{{ID: "root", Root: true}, {ID: "a"}, {ID: "b"}, {ID: "leaf"}, {ID: "isolated"}}, Edges: []Edge{
		{Source: "root", Target: "a"}, {Source: "root", Target: "leaf"}, {Source: "a", Target: "b"}, {Source: "a", Target: "b"},
		{Source: "b", Target: "a"}, {Source: "b", Target: "root"}, {Source: "b", Target: "missing"}, {Source: "missing", Target: "leaf"},
	}}
	result := WithDescendantCounts(g)
	want := []int{3, 1, 1, 0, 0}
	for i, node := range result.Nodes {
		if node.DescendantCount == nil || *node.DescendantCount != want[i] {
			t.Fatalf("%s count = %v, want %d", node.ID, node.DescendantCount, want[i])
		}
		if g.Nodes[i].DescendantCount != nil {
			t.Fatal("input nodes were modified")
		}
	}
	// Consumers can reuse the completed analysis without examining topology.
	result.Edges = nil
	if got := WithDescendantCounts(result); *got.Nodes[0].DescendantCount != 3 {
		t.Fatal("completed counts were recomputed")
	}
}
