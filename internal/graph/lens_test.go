package graph

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestOpenSSFGraphJSONPreservesEvidenceInOneLensResult(t *testing.T) {
	value, zero := 7.5, 0.0
	for _, tc := range []struct {
		name  string
		score OpenSSFScore
	}{
		{"observed", OpenSSFScore{Status: "found", Score: &value, ProjectID: "github.com/example/fork", Date: "2026-10-01"}},
		{"zero", OpenSSFScore{Status: "found", Score: &zero}},
		{"missing score", OpenSSFScore{Status: "found"}},
		{"no project", OpenSSFScore{Status: "no_project"}},
		{"no scorecard", OpenSSFScore{Status: "no_scorecard"}},
		{"skipped", OpenSSFScore{Status: "skipped", Error: "local replacement"}},
		{"unavailable", OpenSSFScore{Status: "unavailable"}},
		{"error", OpenSSFScore{Status: "error", Error: "upstream unavailable"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Assessed module/version must survive even when they differ from the node.
			tc.score.Module, tc.score.Version = "example.org/fork", "v1.2.3"
			g := Graph{Nodes: []Node{{Name: "example.org/original", Version: "v1.0.0"}}}
			g.Meta.AddLens(OpenSSFLensDefinition())
			SetNodeOpenSSFScore(&g.Nodes[0], &tc.score)
			raw, err := json.Marshal(g)
			if err != nil {
				t.Fatal(err)
			}
			var payload struct {
				Nodes []map[string]json.RawMessage `json:"nodes"`
				Meta  map[string]json.RawMessage   `json:"meta"`
			}
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			if _, exists := payload.Nodes[0]["openssf"]; exists {
				t.Fatal("graph JSON contains a duplicate Scorecard summary")
			}
			if _, exists := payload.Meta["overlay"]; exists {
				t.Fatal("graph JSON contains obsolete overlay metadata")
			}
			var decoded Graph
			if err := json.Unmarshal(raw, &decoded); err != nil {
				t.Fatal(err)
			}
			if got := OpenSSFScoreForNode(decoded.Nodes[0]); !reflect.DeepEqual(got, &tc.score) {
				t.Fatalf("Scorecard evidence changed during serialization: got %+v, want %+v", got, tc.score)
			}
			result := decoded.Nodes[0].Lenses[LensOpenSSF]
			if _, exists := result.Details["error"]; exists {
				t.Fatal("error is duplicated in details instead of using message")
			}
			if len(decoded.Meta.Lenses) != 1 || decoded.Meta.Lenses[0] != OpenSSFLensDefinition() {
				t.Fatalf("Scorecard lens metadata changed: %+v", decoded.Meta.Lenses)
			}
		})
	}
}

func TestOpenSSFScoreOwnershipAndRemoval(t *testing.T) {
	value := 0.0
	node := Node{Lenses: LensResults{LensReleaseFreshness: {Status: "current"}}}
	SetNodeOpenSSFScore(&node, &OpenSSFScore{Status: "found", Score: &value})
	value = 10
	got := OpenSSFScoreForNode(node)
	if got == nil || got.Score == nil || *got.Score != 0 {
		t.Fatalf("changing the lookup result changed the stored observation: %+v", got)
	}
	*got.Score = 5
	if *node.Lenses[LensOpenSSF].Score != 0 {
		t.Fatal("changing a typed view changed the stored observation")
	}
	SetNodeOpenSSFScore(&node, nil)
	if OpenSSFScoreForNode(node) != nil || len(node.Lenses) != 1 || node.Lenses[LensReleaseFreshness].Status != "current" {
		t.Fatalf("removing Scorecard changed another lens: %+v", node.Lenses)
	}
}
