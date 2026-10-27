package graph

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
	byID := make(map[string]Node, len(g.Nodes))
	for _, node := range g.Nodes {
		byID[node.ID] = node
	}
	outgoing := make(map[string][]string)
	for _, edge := range g.Edges {
		_, sourceOK := byID[edge.Source]
		target, targetOK := byID[edge.Target]
		if sourceOK && targetOK && !target.Root {
			outgoing[edge.Source] = append(outgoing[edge.Source], edge.Target)
		}
	}
	nodes := append([]Node(nil), g.Nodes...)
	for i, node := range nodes {
		if node.DescendantCount != nil {
			continue
		}
		seen := map[string]bool{node.ID: true}
		queue := []string{node.ID}
		for head := 0; head < len(queue); head++ {
			for _, next := range outgoing[queue[head]] {
				if !seen[next] {
					seen[next] = true
					queue = append(queue, next)
				}
			}
		}
		count := len(seen) - 1
		nodes[i].DescendantCount = &count
	}
	g.Nodes = nodes
	return g
}
