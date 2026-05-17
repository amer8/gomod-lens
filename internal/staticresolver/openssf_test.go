package staticresolver

import (
	"context"
	"net/url"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
)

func TestOpenSSFScoreForNodeUsesSharedVanityProjectFallback(t *testing.T) {
	fetcher := fakeFetcher{
		depsDevVersionURL("golang.org/x/net", "v0.51.0"): `{}`,
		depsDevProjectURL("github.com/golang/net"):       `{"scorecard":{"overallScore":8.6,"date":"2026-05-04T00:00:00Z"}}`,
	}
	resolver := New(fetcher)

	score, err := resolver.openSSFScoreForNode(context.Background(), graph.Node{
		Name:    "golang.org/x/net",
		Version: "v0.51.0",
	})
	if err != nil {
		t.Fatalf("openSSFScoreForNode() error = %v", err)
	}
	if score.Status != "found" {
		t.Fatalf("status = %q, want found; score = %+v", score.Status, score)
	}
	if score.ProjectID != "github.com/golang/net" {
		t.Fatalf("project id = %q, want github.com/golang/net", score.ProjectID)
	}
	if score.Score == nil || *score.Score != 8.6 {
		t.Fatalf("score = %v, want 8.6", score.Score)
	}
}

func TestOpenSSFScoreForNodeUsesModuleReplacementTarget(t *testing.T) {
	fetcher := fakeFetcher{
		depsDevVersionURL("example.com/fork", "v1.2.3"): `{"relatedProjects":[{"projectKey":{"id":"github.com/example/fork"},"relationType":"SOURCE_REPO"}]}`,
		depsDevProjectURL("github.com/example/fork"):    `{"scorecard":{"overallScore":7.4,"date":"2026-05-04T00:00:00Z"}}`,
	}
	resolver := New(fetcher)

	score, err := resolver.openSSFScoreForNode(context.Background(), graph.Node{
		Name:        "example.com/original",
		Version:     "v1.0.0",
		Replaced:    true,
		Replacement: "example.com/fork@v1.2.3",
	})
	if err != nil {
		t.Fatalf("openSSFScoreForNode() error = %v", err)
	}
	if score.Status != "found" {
		t.Fatalf("status = %q, want found; score = %+v", score.Status, score)
	}
	if score.Module != "example.com/fork" || score.Version != "v1.2.3" {
		t.Fatalf("looked up %s@%s, want replacement example.com/fork@v1.2.3", score.Module, score.Version)
	}
	if score.ProjectID != "github.com/example/fork" {
		t.Fatalf("project id = %q, want github.com/example/fork", score.ProjectID)
	}
}

func depsDevProjectURL(projectID string) string {
	return depsDevBaseURL + "/projects/" + url.PathEscape(projectID)
}
