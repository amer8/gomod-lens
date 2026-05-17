package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGitHubModuleSearcherRanksExactRepoNameBeforeStarrierMatches(t *testing.T) {
	t.Parallel()

	var requestedPerPage string
	var requestedUserAgent string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requestedPerPage = r.URL.Query().Get("per_page")
		requestedUserAgent = r.Header.Get("User-Agent")
		if got := r.URL.Query().Get("q"); !strings.Contains(got, "gin") {
			t.Fatalf("query = %q", got)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(bytes.NewBufferString(`{
			"items": [
				{
					"full_name": "avelino/awesome-go",
					"html_url": "https://github.com/avelino/awesome-go",
					"description": "A curated list of Go frameworks, including Gin.",
					"stargazers_count": 171000
				},
				{
					"full_name": "gin-gonic/gin",
					"html_url": "https://github.com/gin-gonic/gin",
					"description": "Gin is a HTTP web framework written in Go.",
					"stargazers_count": 88000
				}
			]
		}`)),
		}, nil
	})}

	searcher := NewGitHubModuleSearcher(client)
	searcher.searchURL = "https://api.github.test/search/repositories"

	results, err := searcher.Search(context.Background(), "gin", 1)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if requestedPerPage != "25" {
		t.Fatalf("per_page = %q", requestedPerPage)
	}
	if requestedUserAgent != defaultUpstreamUserAgent {
		t.Fatalf("User-Agent = %q", requestedUserAgent)
	}
	if len(results) != 1 {
		t.Fatalf("len(results) = %d", len(results))
	}
	if results[0].Path != "github.com/gin-gonic/gin" {
		t.Fatalf("top result = %q", results[0].Path)
	}
}

func TestGitHubModuleSearcherReturnsRetryAfterForRateLimit(t *testing.T) {
	t.Parallel()

	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusForbidden,
			Header: http.Header{
				"Content-Type":          []string{"application/json"},
				"Retry-After":           []string{"12"},
				"X-RateLimit-Remaining": []string{"0"},
			},
			Body: io.NopCloser(bytes.NewBufferString(`{"message":"API rate limit exceeded"}`)),
		}, nil
	})}

	searcher := NewGitHubModuleSearcher(client)
	searcher.searchURL = "https://api.github.test/search/repositories"

	_, err := searcher.Search(context.Background(), "gin", 1)
	if err == nil {
		t.Fatalf("Search() error = nil")
	}
	var upstreamErr *upstreamHTTPError
	if !errors.As(err, &upstreamErr) {
		t.Fatalf("error type = %T", err)
	}
	if upstreamErr.status != http.StatusTooManyRequests {
		t.Fatalf("status = %d", upstreamErr.status)
	}
	if upstreamErr.retryAfter != "12" {
		t.Fatalf("retryAfter = %q", upstreamErr.retryAfter)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}
