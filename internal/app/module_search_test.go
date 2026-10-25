package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/staticresolver"
)

func TestModuleSearchProviders(t *testing.T) {
	t.Parallel()
	const candidates = `{"items":[
		{"full_name":"avelino/awesome-go","stargazers_count":171000},
		{"full_name":"star/gin-helper","stargazers_count":300},
		{"full_name":" Org/Gin ","description":" framework ","html_url":"https://github.com/Org/Gin","stargazers_count":10},
		{"full_name":"other/gin","stargazers_count":20},
		{"full_name":"tied/one","stargazers_count":7},
		{"full_name":"tied/two","stargazers_count":7},
		{"full_name":"star/archived","archived":true,"stargazers_count":999999},
		{"full_name":" ","stargazers_count":999999},
		{"full_name":"other/extra","stargazers_count":1}
	]}`
	const shortQuery = "gin in:name,description,readme language:Go"
	all := []string{"other/gin", "Org/Gin", "star/gin-helper", "avelino/awesome-go", "tied/one", "tied/two"}
	for _, tc := range []struct {
		name, query, githubQuery, body string
		limit                          int
		want                           []string
	}{
		{name: "short query", query: " gin@v1.2.3 ", githubQuery: shortQuery, limit: 6, want: all},
		{name: "repository query", query: " Org/Gin@latest ", githubQuery: "Org/Gin in:name,description language:Go", limit: 3, want: []string{"Org/Gin", "avelino/awesome-go", "star/gin-helper"}},
		{name: "limit after ranking", query: "gin", githubQuery: shortQuery, limit: 1, want: all[:1]},
		{name: "default limit", query: "gin", githubQuery: shortQuery, want: all},
		{name: "negative limit", query: "gin", githubQuery: shortQuery, limit: -1, want: all},
		{name: "excessive limit", query: "gin", githubQuery: shortQuery, limit: 99, want: all},
		{name: "empty query", query: " \t "},
		{name: "no candidates", query: "gin", githubQuery: shortQuery, body: `{}`, want: []string{}},
		{name: "all filtered", query: "gin", githubQuery: shortQuery, body: `{"items":[{"full_name":"old/gin","archived":true},{"full_name":" "}]}`, want: []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := 0
			fetch := func(_ context.Context, request staticresolver.FetchRequest) (string, error) {
				requests++
				u, err := url.Parse(request.URL)
				if err != nil {
					t.Fatal(err)
				}
				want := url.Values{"q": {tc.githubQuery}, "per_page": {"25"}, "sort": {"stars"}, "order": {"desc"}}
				if !reflect.DeepEqual(u.Query(), want) || request.Accept != "application/vnd.github+json" {
					t.Fatalf("request = %+v, want query %v and GitHub JSON", request, want)
				}
				if tc.body != "" {
					return tc.body, nil
				}
				return candidates, nil
			}
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("User-Agent") != defaultUpstreamUserAgent || r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
					t.Fatalf("server request headers = %v", r.Header)
				}
				body, err := fetch(r.Context(), staticresolver.FetchRequest{URL: r.URL.String(), Accept: r.Header.Get("Accept")})
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, err
			})}
			server := NewGitHubModuleSearcher(client)
			wasm := staticresolver.New(searchFetcher(fetch))
			for name, search := range map[string]func(context.Context, string, int) ([]ModuleSearchResult, error){"server": server.Search, "wasm": wasm.SearchModules} {
				t.Run(name, func(t *testing.T) {
					before := requests
					results, err := search(context.Background(), tc.query, tc.limit)
					if err != nil {
						t.Fatal(err)
					}
					var got []string
					if results != nil {
						got = make([]string, 0, len(results))
					}
					for _, result := range results {
						got = append(got, result.Repository)
						if result.Path != "github.com/"+result.Repository {
							t.Fatalf("module path = %q", result.Path)
						}
						if result.Repository == "Org/Gin" && (result.Description != "framework" || result.URL != "https://github.com/Org/Gin" || result.Stars != 10) {
							t.Fatalf("converted result = %+v", result)
						}
					}
					if !reflect.DeepEqual(got, tc.want) {
						t.Fatalf("repositories = %v, want %v", got, tc.want)
					}
					if (requests > before) != (tc.githubQuery != "") {
						t.Fatalf("unexpected request count: %d", requests-before)
					}
				})
			}
		})
	}
}

type searchFetcher func(context.Context, staticresolver.FetchRequest) (string, error)

func (f searchFetcher) FetchText(ctx context.Context, request staticresolver.FetchRequest) (string, error) {
	return f(ctx, request)
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
