package graphview

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"

	"github.com/amer8/gomod-lens/internal/graph"
)

const (
	openSSFNoScorecardColor      = "#b985ff"
	openSSFExcellentScoreColor   = "#6ed0b3"
	openSSFStrongScoreColor      = "#9bd66f"
	openSSFModerateScoreColor    = "#f2c14e"
	openSSFWeakScoreColor        = "#f08a4b"
	openSSFPoorScoreColor        = "#dc5f65"
	openSSFUnavailableColor      = "#8b95a7"
	openSSFErrorColor            = "#e5a15a"
	releaseFreshnessCurrentColor = "#6ed0b3"
	releaseFreshnessPatchColor   = "#f2c14e"
	releaseFreshnessMinorColor   = "#f08a4b"
	releaseFreshnessMajorColor   = "#dc5f65"
	releaseFreshnessPreviewColor = "#b985ff"
	releaseFreshnessUnknownColor = "#8b95a7"
	releaseFreshnessErrorColor   = "#e5a15a"
)

// Model prepares graph analysis data for templates and client-side controls.
type Model struct {
	Graph                  graph.Graph  `json:"-"`
	RelationGroups         []GroupEntry `json:"relationGroups"`
	LensPanels             []LensPanel  `json:"lensPanels"`
	OpenSSFGroups          []GroupEntry `json:"openSSFGroups"`
	ReleaseFreshnessGroups []GroupEntry `json:"releaseFreshnessGroups"`
	OriginGroups           []GroupEntry `json:"originGroups"`
	NameEntries            []GroupEntry `json:"nameEntries"`
}

// LensPanel describes the sidebar presentation for one analysis lens.
type LensPanel struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description,omitempty"`
	Count       int          `json:"count"`
	Active      bool         `json:"active"`
	Groups      []GroupEntry `json:"groups"`
}

// GroupEntry describes a filterable or navigable group of graph nodes.
type GroupEntry struct {
	Name            string   `json:"name"`
	Count           int      `json:"count"`
	IDs             []string `json:"ids"`
	IDsJSON         string   `json:"idsJSON"`
	Color           string   `json:"color,omitempty"`
	NodesOnly       bool     `json:"nodesOnly"`
	NodesOnlyString string   `json:"nodesOnlyString"`
	DependencyCount int      `json:"dependencyCount"`
	Href            string   `json:"href"`
	Title           string   `json:"title,omitempty"`
	Target          string   `json:"target,omitempty"`
}

// New creates a view model from a dependency graph.
func New(g graph.Graph) Model {
	openSSFGroups := OpenSSFGroups(g)
	releaseFreshnessGroups := ReleaseFreshnessGroups(g)
	return Model{
		Graph:                  g,
		RelationGroups:         RelationGroups(g),
		LensPanels:             LensPanels(g, openSSFGroups, releaseFreshnessGroups),
		OpenSSFGroups:          openSSFGroups,
		ReleaseFreshnessGroups: releaseFreshnessGroups,
		OriginGroups:           OriginGroups(g),
		NameEntries:            NameEntries(g),
	}
}

// RelationGroups groups nodes by root, direct, non-direct, and replacement status.
func RelationGroups(g graph.Graph) []GroupEntry {
	groups := []GroupEntry{
		{
			Name: "root module",
			IDs:  filterNodeIDs(g.Nodes, func(node graph.Node) bool { return node.Root }),
		},
		{
			Name:      "direct dependencies",
			IDs:       filterNodeIDs(g.Nodes, func(node graph.Node) bool { return node.Direct }),
			NodesOnly: true,
		},
		{
			Name: "non-direct modules",
			IDs: filterNodeIDs(g.Nodes, func(node graph.Node) bool {
				return !node.Root && !node.Direct
			}),
			NodesOnly: true,
		},
	}

	replacementIDs := filterNodeIDs(g.Nodes, func(node graph.Node) bool { return node.Replaced })
	if len(replacementIDs) > 0 {
		groups = append(groups, GroupEntry{
			Name: "replacements",
			IDs:  replacementIDs,
		})
	}

	for i := range groups {
		hydrateGroupEntry(&groups[i])
	}
	return groups
}

// OriginGroups groups nodes by the first segment of their module path.
func OriginGroups(g graph.Graph) []GroupEntry {
	counts := make(map[string][]string)
	for _, node := range g.Nodes {
		key := moduleOrigin(node.Name)
		counts[key] = append(counts[key], node.ID)
	}

	groups := make([]GroupEntry, 0, len(counts))
	for name, ids := range counts {
		entry := GroupEntry{
			Name:      name,
			IDs:       ids,
			NodesOnly: true,
		}
		hydrateGroupEntry(&entry)
		groups = append(groups, entry)
	}

	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Count != groups[j].Count {
			return groups[i].Count > groups[j].Count
		}
		return groups[i].Name < groups[j].Name
	})
	if len(groups) > 20 {
		groups = groups[:20]
	}
	return groups
}

// LensPanels groups lens-specific entries for the sidebar.
func LensPanels(g graph.Graph, openSSFGroups []GroupEntry, releaseFreshnessGroups []GroupEntry) []LensPanel {
	panels := make([]LensPanel, 0, len(g.Meta.Lenses))
	seen := make(map[string]bool, len(g.Meta.Lenses))
	for _, definition := range g.Meta.Lenses {
		id := strings.ToLower(strings.TrimSpace(definition.ID))
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true

		switch id {
		case graph.LensOpenSSF:
			if panel, ok := lensPanelFromGroups(definition, openSSFGroups); ok {
				panels = append(panels, panel)
			}
		case graph.LensReleaseFreshness:
			if panel, ok := lensPanelFromGroups(definition, releaseFreshnessGroups); ok {
				panels = append(panels, panel)
			}
		}
	}

	if !seen[graph.LensOpenSSF] && len(openSSFGroups) > 0 {
		if panel, ok := lensPanelFromGroups(graph.OpenSSFLensDefinition(), openSSFGroups); ok {
			panels = append(panels, panel)
		}
	}
	if !seen[graph.LensReleaseFreshness] && len(releaseFreshnessGroups) > 0 {
		if panel, ok := lensPanelFromGroups(graph.ReleaseFreshnessLensDefinition(), releaseFreshnessGroups); ok {
			panels = append(panels, panel)
		}
	}
	if len(panels) > 0 {
		panels[0].Active = true
	}
	return panels
}

func lensPanelFromGroups(definition graph.LensDefinition, groups []GroupEntry) (LensPanel, bool) {
	if len(groups) == 0 {
		return LensPanel{}, false
	}
	count := 0
	for _, group := range groups {
		count += group.Count
	}
	return LensPanel{
		ID:          definition.ID,
		Name:        definition.Name,
		Description: definition.Description,
		Count:       count,
		Groups:      groups,
	}, true
}

// OpenSSFGroups groups nodes by OpenSSF Scorecard status and score buckets.
func OpenSSFGroups(g graph.Graph) []GroupEntry {
	buckets := []GroupEntry{
		{Name: "9.0 - 10", Color: openSSFExcellentScoreColor, NodesOnly: true},
		{Name: "7.0 - 8.9", Color: openSSFStrongScoreColor, NodesOnly: true},
		{Name: "5.0 - 6.9", Color: openSSFModerateScoreColor, NodesOnly: true},
		{Name: "3.0 - 4.9", Color: openSSFWeakScoreColor, NodesOnly: true},
		{Name: "0 - 2.9", Color: openSSFPoorScoreColor, NodesOnly: true},
		{Name: "no scorecard", Color: openSSFNoScorecardColor, NodesOnly: true},
		{Name: "score unavailable", Color: openSSFUnavailableColor, NodesOnly: true},
		{Name: "lookup error", Color: openSSFErrorColor, NodesOnly: true},
	}

	for _, node := range g.Nodes {
		info := graph.OpenSSFScoreForNode(node)
		switch {
		case info == nil:
			buckets[6].IDs = append(buckets[6].IDs, node.ID)
		case info.Status == "error":
			buckets[7].IDs = append(buckets[7].IDs, node.ID)
		case info.Status == "no_scorecard":
			buckets[5].IDs = append(buckets[5].IDs, node.ID)
		case info.Status != "found" || info.Score == nil:
			buckets[6].IDs = append(buckets[6].IDs, node.ID)
		case *info.Score >= 9:
			buckets[0].IDs = append(buckets[0].IDs, node.ID)
		case *info.Score >= 7:
			buckets[1].IDs = append(buckets[1].IDs, node.ID)
		case *info.Score >= 5:
			buckets[2].IDs = append(buckets[2].IDs, node.ID)
		case *info.Score >= 3:
			buckets[3].IDs = append(buckets[3].IDs, node.ID)
		default:
			buckets[4].IDs = append(buckets[4].IDs, node.ID)
		}
	}

	groups := make([]GroupEntry, 0, len(buckets))
	for i := range buckets {
		if len(buckets[i].IDs) == 0 {
			continue
		}
		hydrateGroupEntry(&buckets[i])
		groups = append(groups, buckets[i])
	}
	return groups
}

// ReleaseFreshnessGroups groups nodes by version freshness compared with the
// latest public Go module release.
func ReleaseFreshnessGroups(g graph.Graph) []GroupEntry {
	hasFreshnessResults := false
	for _, node := range g.Nodes {
		if graph.ReleaseFreshnessForNode(node) != nil {
			hasFreshnessResults = true
			break
		}
	}
	if !hasFreshnessResults {
		return nil
	}

	buckets := []GroupEntry{
		{Name: "current release", Color: releaseFreshnessCurrentColor, NodesOnly: true},
		{Name: "patch behind", Color: releaseFreshnessPatchColor, NodesOnly: true},
		{Name: "minor behind", Color: releaseFreshnessMinorColor, NodesOnly: true},
		{Name: "major behind", Color: releaseFreshnessMajorColor, NodesOnly: true},
		{Name: "pre-release / pseudo", Color: releaseFreshnessPreviewColor, NodesOnly: true},
		{Name: "unknown freshness", Color: releaseFreshnessUnknownColor, NodesOnly: true},
		{Name: "lookup error", Color: releaseFreshnessErrorColor, NodesOnly: true},
	}

	for _, node := range g.Nodes {
		info := graph.ReleaseFreshnessForNode(node)
		switch {
		case info == nil:
			buckets[5].IDs = append(buckets[5].IDs, node.ID)
		case info.Status == graph.ReleaseFreshnessStatusError:
			buckets[6].IDs = append(buckets[6].IDs, node.ID)
		case info.Status == graph.ReleaseFreshnessStatusCurrent:
			buckets[0].IDs = append(buckets[0].IDs, node.ID)
		case info.Status == graph.ReleaseFreshnessStatusPatchBehind:
			buckets[1].IDs = append(buckets[1].IDs, node.ID)
		case info.Status == graph.ReleaseFreshnessStatusMinorBehind:
			buckets[2].IDs = append(buckets[2].IDs, node.ID)
		case info.Status == graph.ReleaseFreshnessStatusMajorBehind:
			buckets[3].IDs = append(buckets[3].IDs, node.ID)
		case info.Status == graph.ReleaseFreshnessStatusPrerelease || info.Status == graph.ReleaseFreshnessStatusPseudoVersion:
			buckets[4].IDs = append(buckets[4].IDs, node.ID)
		default:
			buckets[5].IDs = append(buckets[5].IDs, node.ID)
		}
	}

	groups := make([]GroupEntry, 0, len(buckets))
	for i := range buckets {
		if len(buckets[i].IDs) == 0 {
			continue
		}
		hydrateGroupEntry(&buckets[i])
		groups = append(groups, buckets[i])
	}
	return groups
}

// NameEntries lists dependency hubs and a collapsed leaf-module bucket.
func NameEntries(g graph.Graph) []GroupEntry {
	dependencyCounts := dependencyNodeCountForNames(g)
	entries := make([]GroupEntry, 0, len(g.PackageInfo.Names))
	leafModuleIDs := make([]string, 0)

	for _, entry := range g.PackageInfo.Names {
		if entry.Root {
			continue
		}

		ids := nodeIDsByName(g.Nodes, entry.Name)
		dependencyCount := dependencyCounts[entry.Name]
		if dependencyCount == 0 {
			leafModuleIDs = append(leafModuleIDs, ids...)
			continue
		}

		target := nameEntryTarget(g, entry.Name)
		next := GroupEntry{
			Name:            entry.Name,
			Count:           entry.Count,
			IDs:             ids,
			DependencyCount: dependencyCount,
			Target:          target,
			Href:            targetHref(target),
		}
		if entry.Count == 1 {
			next.Title = "open " + entry.Name
		} else if entry.Direct {
			next.Title = "direct dependency"
		} else {
			next.Title = "non-direct module"
		}
		hydrateGroupEntry(&next)
		entries = append(entries, next)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].DependencyCount != entries[j].DependencyCount {
			return entries[i].DependencyCount > entries[j].DependencyCount
		}
		if entries[i].Count != entries[j].Count {
			return entries[i].Count > entries[j].Count
		}
		return entries[i].Name < entries[j].Name
	})
	if len(leafModuleIDs) > 0 {
		entry := GroupEntry{
			Name:            "leaf modules",
			IDs:             leafModuleIDs,
			NodesOnly:       true,
			DependencyCount: len(leafModuleIDs),
			Title:           "modules with no outgoing dependencies",
		}
		hydrateGroupEntry(&entry)
		entries = append(entries, entry)
	}
	return entries
}

func dependencyNodeCountForNames(g graph.Graph) map[string]int {
	nodeByID, nodeIDsByName, dependencyIDsByID := buildDependencyIndex(g)
	counts := make(map[string]int, len(nodeIDsByName))
	for name, ids := range nodeIDsByName {
		counts[name] = reachableDependencyNodeCount(ids, dependencyIDsByID, nodeByID)
	}
	return counts
}

func buildDependencyIndex(g graph.Graph) (map[string]graph.Node, map[string][]string, map[string][]string) {
	nodeByID := make(map[string]graph.Node, len(g.Nodes))
	nodeIDsByName := make(map[string][]string)
	dependencyIDsByID := make(map[string][]string)

	for _, node := range g.Nodes {
		nodeByID[node.ID] = node
		if node.Root {
			continue
		}
		nodeIDsByName[node.Name] = append(nodeIDsByName[node.Name], node.ID)
	}

	for _, edge := range g.Edges {
		if _, ok := nodeByID[edge.Source]; !ok {
			continue
		}
		if _, ok := nodeByID[edge.Target]; !ok {
			continue
		}
		dependencyIDsByID[edge.Source] = append(dependencyIDsByID[edge.Source], edge.Target)
	}

	return nodeByID, nodeIDsByName, dependencyIDsByID
}

func reachableDependencyNodeCount(startIDs []string, dependencyIDsByID map[string][]string, nodeByID map[string]graph.Node) int {
	startIDSet := make(map[string]bool, len(startIDs))
	seenDependencyIDs := make(map[string]bool)
	stack := make([]string, 0)

	for _, id := range startIDs {
		startIDSet[id] = true
		stack = append(stack, dependencyIDsByID[id]...)
	}

	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if startIDSet[id] || seenDependencyIDs[id] {
			continue
		}

		node, ok := nodeByID[id]
		if !ok || node.Root {
			continue
		}

		seenDependencyIDs[id] = true
		stack = append(stack, dependencyIDsByID[id]...)
	}

	return len(seenDependencyIDs)
}

func filterNodeIDs(nodes []graph.Node, keep func(graph.Node) bool) []string {
	ids := make([]string, 0)
	for _, node := range nodes {
		if keep(node) {
			ids = append(ids, node.ID)
		}
	}
	return ids
}

func nodeIDsByName(nodes []graph.Node, name string) []string {
	ids := make([]string, 0)
	for _, node := range nodes {
		if node.Name == name {
			ids = append(ids, node.ID)
		}
	}
	return ids
}

func hydrateGroupEntry(entry *GroupEntry) {
	entry.Count = len(entry.IDs)
	entry.IDsJSON = jsonAttribute(entry.IDs)
	if entry.Href == "" {
		entry.Href = "#"
	}
	if entry.NodesOnly {
		entry.NodesOnlyString = "true"
	} else {
		entry.NodesOnlyString = "false"
	}
}

func jsonAttribute(values []string) string {
	raw, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

func moduleOrigin(modulePath string) string {
	if modulePath == "" {
		return "unknown"
	}
	parts := strings.Split(modulePath, "/")
	if parts[0] == "" {
		return modulePath
	}
	return parts[0]
}

func nameEntryTarget(g graph.Graph, name string) string {
	for _, node := range g.Nodes {
		if node.Name == name {
			return node.ID
		}
	}
	return name
}

func targetHref(target string) string {
	params := url.Values{"target": []string{target}}
	return "#" + params.Encode()
}
