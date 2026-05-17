package app

import (
	"github.com/amer8/gomod-lens/internal/graph"
	"github.com/amer8/gomod-lens/internal/graphview"
)

// GraphViewModel aliases the graph view model used by app templates.
type GraphViewModel = graphview.Model

// GroupEntry aliases a graph view grouping used by app templates.
type GroupEntry = graphview.GroupEntry

// LensPanel aliases a graph view lens panel used by app templates.
type LensPanel = graphview.LensPanel

func newGraphViewModel(g graph.Graph) GraphViewModel {
	return graphview.New(g)
}

func openSSFGroups(g graph.Graph) []GroupEntry {
	return graphview.OpenSSFGroups(g)
}

func releaseFreshnessGroups(g graph.Graph) []GroupEntry {
	return graphview.ReleaseFreshnessGroups(g)
}

func importMap() map[string]map[string]string {
	return map[string]map[string]string{
		"imports": {
			"ngraph.forcelayout": "/assets/vendor/ngraph.forcelayout.js",
			"ngraph.graph":       "/assets/vendor/ngraph.graph.js",
			"ngraph.svg":         "/assets/vendor/ngraph.svg.js",
		},
	}
}

func htmxURL() string {
	return "/assets/vendor/htmx.min.js"
}
