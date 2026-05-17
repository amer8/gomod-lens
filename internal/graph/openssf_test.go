package graph

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestDepsDevRequestAcceptsLargeScorecardResponse(t *testing.T) {
	t.Parallel()

	client := &http.Client{
		Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			body := fmt.Sprintf(`{
			"projectKey": {"id": "github.com/example/project"},
			"scorecard": {
				"date": "2026-04-27T00:00:00Z",
				"checks": [{"name": "Padding", "details": [%q]}],
				"overallScore": 7.6
			}
		}`, strings.Repeat("x", 8192))
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(body)),
			}, nil
		}),
	}

	response, err := doDepsDevRequest[depsDevProjectResponse](context.Background(), client, "https://example.test/project")
	if err != nil {
		t.Fatalf("doDepsDevRequest() error = %v", err)
	}
	if response.Scorecard == nil {
		t.Fatalf("Scorecard = nil")
	}
	if response.Scorecard.OverallScore != 7.6 {
		t.Fatalf("OverallScore = %v, want 7.6", response.Scorecard.OverallScore)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
