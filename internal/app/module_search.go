package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/amer8/gomod-lens/internal/modulesearch"
)

const defaultModuleSearchLimit = modulesearch.DefaultLimit

// ModuleSearchResult describes a public module search result.
type ModuleSearchResult = modulesearch.Result

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
	requestURL, err := url.Parse(s.searchURL)
	if err != nil {
		return nil, err
	}
	values := requestURL.Query()
	for key, value := range modulesearch.GitHubQuery(query) {
		values[key] = value
	}
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

	var payload modulesearch.GitHubResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode github repository search: %w", err)
	}

	return payload.Results(query, limit), nil
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

func normalizeModuleSearchQuery(query string) string {
	base, _ := splitTargetVersion(strings.TrimSpace(query))
	return strings.TrimSpace(base)
}
