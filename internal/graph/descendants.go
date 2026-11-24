package graph

import (
	"math/big"
	"math/bits"
)

// WithDescendantCounts supplies counts shared by the sidebar and renderers.
// Roots stop traversal, missing endpoints are ignored, and cycles count once.
// The input's nodes are not modified.
func WithDescendantCounts(g Graph) Graph {
	complete := true
	for _, node := range g.Nodes {
		if node.DescendantCount == nil {
			complete = false
			break
		}
	}
	if complete {
		return g
	}
	index := make(map[string]int, len(g.Nodes))
	for i, node := range g.Nodes {
		index[node.ID] = i
	}
	outgoing := make([][]int, len(g.Nodes))
	for _, edge := range g.Edges {
		from, sourceOK := index[edge.Source]
		to, targetOK := index[edge.Target]
		if sourceOK && targetOK && !g.Nodes[to].Root {
			outgoing[from] = append(outgoing[from], to)
		}
	}
	counts := descendantCounts(outgoing)
	g.Nodes = append([]Node(nil), g.Nodes...)
	for i := range g.Nodes {
		if g.Nodes[i].DescendantCount == nil {
			g.Nodes[i].DescendantCount = &counts[i]
		}
	}
	return g
}

// Tarjan's traversal completes each strongly connected component after all its
// successors. Members of a cycle share a reachable set, and a bitset union
// counts shared downstream dependencies only once.
func descendantCounts(edges [][]int) []int {
	n := len(edges)
	order := make([]int, n)
	low := make([]int, n)
	reachable := make([]*big.Int, n)
	counts := make([]int, n)
	var stack []int
	sequence := 0
	var visit func(int)
	visit = func(v int) {
		sequence++
		order[v], low[v] = sequence, sequence
		stack = append(stack, v)
		for _, w := range edges[v] {
			if order[w] == 0 {
				visit(w)
				low[v] = min(low[v], low[w])
			} else if reachable[w] == nil {
				low[v] = min(low[v], order[w])
			}
		}
		if low[v] != order[v] {
			return
		}
		first := len(stack) - 1
		for stack[first] != v {
			first--
		}
		members := stack[first:]
		set := new(big.Int)
		for _, member := range members {
			set.SetBit(set, member, 1)
			for _, w := range edges[member] {
				if child := reachable[w]; child != nil {
					set.Or(set, child)
				}
			}
		}
		count := -1 // exclude the starting node itself
		for _, word := range set.Bits() {
			count += bits.OnesCount(uint(word))
		}
		for _, member := range members {
			reachable[member], counts[member] = set, count
		}
		stack = stack[:first]
	}
	for v := range edges {
		if order[v] == 0 {
			visit(v)
		}
	}
	return counts
}
