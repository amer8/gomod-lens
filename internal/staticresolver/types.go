package staticresolver

import (
	"context"
	"errors"
	"strconv"

	"github.com/amer8/gomod-lens/internal/modulesearch"
)

// FetchRequest describes one upstream text request made by the static resolver.
type FetchRequest struct {
	URL    string
	Accept string
}

// Fetcher retrieves text resources for static module resolution.
type Fetcher interface {
	FetchText(ctx context.Context, request FetchRequest) (string, error)
}

// Options configures optional callbacks for graph resolution.
type Options struct {
	Progress func(Progress)
}

// Progress reports a user-visible resolver milestone.
type Progress struct {
	Value int    `json:"value"`
	Label string `json:"label,omitempty"`
}

// ModuleSearchResult describes a repository-backed module search hit.
type ModuleSearchResult = modulesearch.Result

// HTTPError captures an upstream HTTP failure from a browser fetch.
type HTTPError struct {
	Status     int
	StatusText string
	URL        string
	Message    string
}

// Error returns the best available upstream error message.
func (e *HTTPError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	status := e.StatusText
	if status == "" {
		status = "HTTP error"
	}
	if e.Status > 0 {
		status = strconv.Itoa(e.Status) + " " + status
	}
	if e.URL == "" {
		return status
	}
	return status + " from " + e.URL
}

// IsNotFound reports whether err represents a 404 or 410 upstream response.
func IsNotFound(err error) bool {
	var httpErr *HTTPError
	return errors.As(err, &httpErr) && (httpErr.Status == 404 || httpErr.Status == 410)
}
