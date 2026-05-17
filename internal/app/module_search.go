package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultModuleSearchLimit        = 6
	githubModuleSearchCandidateSize = 25
)

// ModuleSearchResult describes a public module search result.
type ModuleSearchResult struct {
	Path        string `json:"path"`
	Repository  string `json:"repository"`
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
	Stars       int    `json:"stars,omitempty"`
}

type moduleSearcher interface {
	Search(ctx context.Context, query string, limit int) ([]ModuleSearchResult, error)
}

// GitHubModuleSearcher searches GitHub repositories for Go module candidates.
type GitHubModuleSearcher struct {
	client    *http.Client
	searchURL string
	userAgent string
}

// NewGitHubModuleSearcher creates a GitHub-backed module searcher.
func NewGitHubModuleSearcher(client *http.Client) *GitHubModuleSearcher {
	return NewGitHubModuleSearcherWithUserAgent(client, defaultUpstreamUserAgent)
}

// NewGitHubModuleSearcherWithUserAgent creates a GitHub-backed module searcher with a custom User-Agent.
func NewGitHubModuleSearcherWithUserAgent(client *http.Client, userAgent string) *GitHubModuleSearcher {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	if strings.TrimSpace(userAgent) == "" {
		userAgent = defaultUpstreamUserAgent
	}
	return &GitHubModuleSearcher{
		client:    client,
		searchURL: "https://api.github.com/search/repositories",
		userAgent: userAgent,
	}
}

// Search returns ranked repository-backed module candidates for query.
func (s *GitHubModuleSearcher) Search(ctx context.Context, query string, limit int) ([]ModuleSearchResult, error) {
	query = normalizeModuleSearchQuery(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 || limit > defaultModuleSearchLimit {
		limit = defaultModuleSearchLimit
	}

	requestURL, err := url.Parse(s.searchURL)
	if err != nil {
		return nil, err
	}
	candidateLimit := max(limit, githubModuleSearchCandidateSize)
	values := requestURL.Query()
	values.Set("q", githubRepositorySearchQuery(query))
	values.Set("sort", "stars")
	values.Set("order", "desc")
	values.Set("per_page", fmt.Sprintf("%d", candidateLimit))
	requestURL.RawQuery = values.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", s.userAgent)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = resp.Status
		}
		if isGitHubRateLimitResponse(resp, detail) {
			return nil, &upstreamHTTPError{
				service:    "GitHub repository search",
				status:     http.StatusTooManyRequests,
				message:    detail,
				retryAfter: retryAfterFromHeaders(resp.Header),
			}
		}
		return nil, fmt.Errorf("github repository search failed: %s", detail)
	}

	var payload githubRepositorySearchResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode github repository search: %w", err)
	}

	results := make([]ModuleSearchResult, 0, len(payload.Items))
	for _, item := range payload.Items {
		fullName := strings.TrimSpace(item.FullName)
		if fullName == "" || item.Archived {
			continue
		}
		results = append(results, ModuleSearchResult{
			Path:        "github.com/" + fullName,
			Repository:  fullName,
			URL:         item.HTMLURL,
			Description: strings.TrimSpace(item.Description),
			Stars:       item.Stars,
		})
	}

	sortModuleSearchResults(results, query)
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

type upstreamHTTPError struct {
	service    string
	status     int
	message    string
	retryAfter string
}

func (e *upstreamHTTPError) Error() string {
	if e == nil {
		return ""
	}
	message := strings.TrimSpace(e.message)
	if message == "" {
		message = http.StatusText(e.status)
	}
	if e.service == "" {
		return message
	}
	return e.service + " returned " + message
}

func upstreamErrorStatus(err error) int {
	var upstreamErr *upstreamHTTPError
	if err != nil && errors.As(err, &upstreamErr) && upstreamErr.status > 0 {
		return upstreamErr.status
	}
	return http.StatusBadGateway
}

func upstreamErrorRetryAfter(err error) string {
	var upstreamErr *upstreamHTTPError
	if err != nil && errors.As(err, &upstreamErr) {
		return upstreamErr.retryAfter
	}
	return ""
}

func isGitHubRateLimitResponse(resp *http.Response, detail string) bool {
	if resp.StatusCode == http.StatusTooManyRequests {
		return true
	}
	if resp.StatusCode != http.StatusForbidden {
		return false
	}
	if resp.Header.Get("X-RateLimit-Remaining") == "0" {
		return true
	}
	lower := strings.ToLower(detail)
	return strings.Contains(lower, "rate limit") || strings.Contains(lower, "secondary rate limit")
}

func retryAfterFromHeaders(header http.Header) string {
	if retryAfter := strings.TrimSpace(header.Get("Retry-After")); retryAfter != "" {
		return retryAfter
	}
	reset := strings.TrimSpace(header.Get("X-RateLimit-Reset"))
	if reset == "" {
		return ""
	}
	epoch, err := strconv.ParseInt(reset, 10, 64)
	if err != nil {
		return ""
	}
	seconds := max(int(time.Until(time.Unix(epoch, 0)).Seconds()), 1)
	return strconv.Itoa(seconds)
}

type githubRepositorySearchResponse struct {
	Items []githubRepositorySearchItem `json:"items"`
}

type githubRepositorySearchItem struct {
	FullName    string `json:"full_name"`
	HTMLURL     string `json:"html_url"`
	Description string `json:"description"`
	Stars       int    `json:"stargazers_count"`
	Archived    bool   `json:"archived"`
}

func githubRepositorySearchQuery(query string) string {
	if strings.Contains(query, "/") {
		return query + " in:name,description language:Go"
	}
	return query + " in:name,description,readme language:Go"
}

func sortModuleSearchResults(results []ModuleSearchResult, query string) {
	query = strings.ToLower(strings.TrimSpace(query))
	sort.SliceStable(results, func(i, j int) bool {
		left := moduleSearchRank(results[i], query)
		right := moduleSearchRank(results[j], query)
		if left != right {
			return left < right
		}
		return results[i].Stars > results[j].Stars
	})
}

func moduleSearchRank(result ModuleSearchResult, query string) int {
	repository := strings.ToLower(result.Repository)
	name := repository
	if slash := strings.LastIndex(repository, "/"); slash >= 0 {
		name = repository[slash+1:]
	}

	switch {
	case name == query:
		return 0
	case repository == query:
		return 1
	case strings.Contains(repository, query):
		return 2
	default:
		return 3
	}
}

func normalizeModuleSearchQuery(query string) string {
	base, _ := splitTargetVersion(strings.TrimSpace(query))
	return strings.TrimSpace(base)
}
