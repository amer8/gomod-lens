package graph

import (
	"context"
	"strings"
)

// Lens analyzes an existing dependency graph and attaches per-node results.
type Lens interface {
	Definition() LensDefinition
	Analyze(ctx context.Context, graph *Graph) error
}

// OpenSSFLensDefinition returns metadata for the built-in OpenSSF Scorecard lens.
func OpenSSFLensDefinition() LensDefinition {
	return LensDefinition{
		ID:          LensOpenSSF,
		Name:        "OpenSSF Scorecard",
		Description: "Security and supply-chain health signals from OpenSSF Scorecard data.",
	}
}

// ReleaseFreshnessLensDefinition returns metadata for the built-in release
// freshness lens.
func ReleaseFreshnessLensDefinition() LensDefinition {
	return LensDefinition{
		ID:          LensReleaseFreshness,
		Name:        "Release Freshness",
		Description: "Version freshness compared with the latest public Go module release.",
	}
}

// AddLens records a lens definition on graph metadata.
func (m *GraphMeta) AddLens(def LensDefinition) {
	def.ID = normalizeLensID(def.ID)
	if def.ID == "" {
		return
	}
	if def.ID == LensOpenSSF {
		m.Overlay = OverlayOpenSSF
	}
	for i := range m.Lenses {
		if m.Lenses[i].ID == def.ID {
			m.Lenses[i] = def
			return
		}
	}
	m.Lenses = append(m.Lenses, def)
}

// SetLensResult records a generic lens result for a node.
func (n *Node) SetLensResult(lensID string, result LensResult) {
	lensID = normalizeLensID(lensID)
	if lensID == "" {
		return
	}
	if n.Lenses == nil {
		n.Lenses = make(LensResults)
	}
	n.Lenses[lensID] = cloneLensResult(result)
}

// LensResult returns a generic lens result for a node.
func (n Node) LensResult(lensID string) (LensResult, bool) {
	lensID = normalizeLensID(lensID)
	if lensID == "" || n.Lenses == nil {
		return LensResult{}, false
	}
	result, ok := n.Lenses[lensID]
	return result, ok
}

// SetNodeOpenSSFScore records OpenSSF Scorecard data on both the compatibility
// OpenSSF field and the generic lens result map.
func SetNodeOpenSSFScore(node *Node, score *OpenSSFScore) {
	if node == nil {
		return
	}
	node.OpenSSF = score
	if score == nil {
		if node.Lenses != nil {
			delete(node.Lenses, LensOpenSSF)
		}
		return
	}
	node.SetLensResult(LensOpenSSF, score.LensResult())
}

// OpenSSFScoreForNode returns the OpenSSF score attached to a node, including
// results stored only through the generic lens map.
func OpenSSFScoreForNode(node Node) *OpenSSFScore {
	if node.OpenSSF != nil {
		return node.OpenSSF
	}
	result, ok := node.LensResult(LensOpenSSF)
	if !ok {
		return nil
	}
	score := OpenSSFScore{
		Status: result.Status,
		Score:  cloneFloat64(result.Score),
		Error:  result.Message,
	}
	if result.Details != nil {
		score.Module = result.Details["module"]
		score.Version = result.Details["version"]
		score.ProjectID = result.Details["projectId"]
		score.Date = result.Details["date"]
		if score.Error == "" {
			score.Error = result.Details["error"]
		}
	}
	return &score
}

// LensResult converts OpenSSF Scorecard data into the generic lens result shape.
func (s OpenSSFScore) LensResult() LensResult {
	result := LensResult{
		Status:  s.Status,
		Score:   cloneFloat64(s.Score),
		Message: s.Error,
	}
	details := make(map[string]string)
	if s.Module != "" {
		details["module"] = s.Module
	}
	if s.Version != "" {
		details["version"] = s.Version
	}
	if s.ProjectID != "" {
		details["projectId"] = s.ProjectID
	}
	if s.Date != "" {
		details["date"] = s.Date
	}
	if s.Error != "" {
		details["error"] = s.Error
	}
	if len(details) > 0 {
		result.Details = details
	}
	return result
}

// CloneLensDefinitions copies graph lens metadata.
func CloneLensDefinitions(defs []LensDefinition) []LensDefinition {
	return cloneLensDefinitions(defs)
}

// CloneLensResults deep-copies a node lens result map.
func CloneLensResults(results LensResults) LensResults {
	if results == nil {
		return nil
	}
	cloned := make(LensResults, len(results))
	for lensID, result := range results {
		cloned[lensID] = cloneLensResult(result)
	}
	return cloned
}

func cloneLensDefinitions(defs []LensDefinition) []LensDefinition {
	if defs == nil {
		return nil
	}
	cloned := make([]LensDefinition, len(defs))
	copy(cloned, defs)
	return cloned
}

func cloneLensResult(result LensResult) LensResult {
	cloned := result
	cloned.Score = cloneFloat64(result.Score)
	if result.Details != nil {
		cloned.Details = make(map[string]string, len(result.Details))
		for key, value := range result.Details {
			cloned.Details[key] = value
		}
	}
	return cloned
}

func cloneFloat64(value *float64) *float64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func normalizeLensID(id string) string {
	return strings.TrimSpace(strings.ToLower(id))
}
