package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

type statusError struct {
	status     int
	message    string
	err        error
	retryAfter string
}

func (e *statusError) Error() string {
	return e.message
}

func (e *statusError) Unwrap() error {
	return e.err
}

func (s *Server) resolveModuleTarget(ctx context.Context, target string) (string, error) {
	target = strings.TrimSpace(target)
	if !shouldSearchModuleTarget(target) {
		return target, nil
	}
	if s.moduleSearcher == nil {
		return target, nil
	}

	base, version := splitTargetVersion(target)
	results, err := s.searchModules(ctx, base, 1)
	if err != nil {
		return "", &statusError{
			status:     upstreamErrorStatus(err),
			message:    fmt.Sprintf("module search for %q failed: %v", base, err),
			err:        err,
			retryAfter: upstreamErrorRetryAfter(err),
		}
	}
	if len(results) == 0 {
		return "", &statusError{
			status:  http.StatusBadRequest,
			message: fmt.Sprintf("no Go module found for %q", base),
		}
	}

	resolved := results[0].Path
	if version != "" {
		resolved += "@" + version
	}
	return resolved, nil
}

func shouldSearchModuleTarget(target string) bool {
	target = strings.TrimSpace(target)
	if target == "" {
		return false
	}

	base, _ := splitTargetVersion(target)
	if isLikelyLocalTarget(base) {
		return false
	}

	firstSegment := base
	if slash := strings.Index(firstSegment, "/"); slash >= 0 {
		firstSegment = firstSegment[:slash]
	}
	return !strings.Contains(firstSegment, ".")
}

func splitTargetVersion(target string) (string, string) {
	target = strings.TrimSpace(target)
	base, version, found := strings.Cut(target, "@")
	if !found {
		return target, ""
	}
	return strings.TrimSpace(base), strings.TrimSpace(version)
}

func isLikelyLocalTarget(target string) bool {
	return target == "." ||
		target == ".." ||
		strings.HasPrefix(target, "./") ||
		strings.HasPrefix(target, "../") ||
		filepath.IsAbs(target) ||
		strings.HasSuffix(target, ".mod")
}

func errorStatus(err error) int {
	var statusErr *statusError
	if errors.As(err, &statusErr) {
		return statusErr.status
	}
	var upstreamErr *upstreamHTTPError
	if errors.As(err, &upstreamErr) && upstreamErr.status > 0 {
		return upstreamErr.status
	}
	return graphErrorStatus(err)
}

func errorRetryAfter(err error) string {
	var statusErr *statusError
	if errors.As(err, &statusErr) {
		return statusErr.retryAfter
	}
	return upstreamErrorRetryAfter(err)
}

func parseSearchLimit(raw string) int {
	if raw == "" {
		return defaultModuleSearchLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return defaultModuleSearchLimit
	}
	if limit > defaultModuleSearchLimit {
		return defaultModuleSearchLimit
	}
	return limit
}
