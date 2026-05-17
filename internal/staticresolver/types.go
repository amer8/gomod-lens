package staticresolver

import (
	"context"
	"errors"
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
type ModuleSearchResult struct {
	Path        string `json:"path"`
	Repository  string `json:"repository"`
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
	Stars       int    `json:"stars,omitempty"`
}

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
		status = itoa(e.Status) + " " + status
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

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		digits[index] = '-'
	}
	return string(digits[index:])
}
