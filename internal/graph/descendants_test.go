package graph

import (
	"math/rand"
	"testing"
)

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

func TestComponentCountsMatchReachability(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for _, n := range []int{1, 9, 65, 130} {
		edges := make([][]int, n)
		for from := range edges {
			for to := range edges {
				if rng.Intn(13) == 0 {
					edges[from] = append(edges[from], to)
				}
			}
		}
		counts := descendantCounts(edges)
		for start := range edges {
			seen := map[int]bool{start: true}
			queue := []int{start}
			for len(queue) > 0 {
				node := queue[0]
				queue = queue[1:]
				for _, next := range edges[node] {
					if !seen[next] {
						seen[next] = true
						queue = append(queue, next)
					}
				}
			}
			if counts[start] != len(seen)-1 {
				t.Fatalf("node %d of %d: got %d, want %d", start, n, counts[start], len(seen)-1)
			}
		}
	}
}
