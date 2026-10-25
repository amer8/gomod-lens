// Package modulesearch defines the search rules shared by the server and WASM resolver.
package modulesearch

import (
	"net/url"
	"sort"
	"strings"
)

const DefaultLimit = 6

// Result describes a repository-backed public module search hit.
type Result struct {
	Path        string `json:"path"`
	Repository  string `json:"repository"`
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
	Stars       int    `json:"stars,omitempty"`
}

// GitHubQuery requests enough candidates to rank exact matches ahead of stars.
func GitHubQuery(query string) url.Values {
	scope := "in:name,description,readme language:Go"
	if strings.Contains(query, "/") {
		scope = "in:name,description language:Go"
	}
	return url.Values{"q": {query + " " + scope}, "sort": {"stars"}, "order": {"desc"}, "per_page": {"25"}}
}

// GitHubResponse is the repository search payload used by both transports.
type GitHubResponse struct {
	Items []struct {
		FullName    string `json:"full_name"`
		HTMLURL     string `json:"html_url"`
		Description string `json:"description"`
		Stars       int    `json:"stargazers_count"`
		Archived    bool   `json:"archived"`
	} `json:"items"`
}

// Results filters unusable repositories and ranks matches before applying the limit.
func (response GitHubResponse) Results(query string, limit int) []Result {
	if limit <= 0 || limit > DefaultLimit {
		limit = DefaultLimit
	}
	results := make([]Result, 0, len(response.Items))
	for _, item := range response.Items {
		fullName := strings.TrimSpace(item.FullName)
		if fullName == "" || item.Archived {
			continue
		}
		results = append(results, Result{
			Path:        "github.com/" + fullName,
			Repository:  fullName,
			URL:         item.HTMLURL,
			Description: strings.TrimSpace(item.Description),
			Stars:       item.Stars,
		})
	}
	query = strings.ToLower(strings.TrimSpace(query))
	sort.SliceStable(results, func(i, j int) bool {
		left, right := rank(results[i], query), rank(results[j], query)
		if left != right {
			return left < right
		}
		return results[i].Stars > results[j].Stars
	})
	return results[:min(limit, len(results))]
}

func rank(result Result, query string) int {
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
