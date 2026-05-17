package staticresolver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/amer8/gomod-lens/internal/graph"
)

func (r *Resolver) applyReleaseFreshnessLens(ctx context.Context, result *graph.Graph, progress *progressReporter) error {
	result.Meta.AddLens(graph.ReleaseFreshnessLensDefinition())

	var mu sync.Mutex
	completed := 0

	return mapLimit(ctx, result.Nodes, moduleLoadConcurrency, func(index int, node graph.Node) error {
		info, err := r.releaseFreshnessForNode(ctx, node)
		if err != nil {
			return err
		}

		mu.Lock()
		graph.SetNodeReleaseFreshness(&result.Nodes[index], &info)
		completed++
		offset := 2
		if len(result.Nodes) > 0 {
			offset = (completed * 2) / len(result.Nodes)
		}
		progress.Report(98+offset, "Applying Release Freshness lens")
		mu.Unlock()
		return nil
	})
}

func (r *Resolver) releaseFreshnessForNode(ctx context.Context, node graph.Node) (graph.ReleaseFreshnessInfo, error) {
	request, skipped := graph.ReleaseFreshnessRequestForNode(node)
	if skipped != nil {
		return *skipped, nil
	}

	latest, err := r.fetchLatestReleaseVersion(ctx, request.Module)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return graph.ReleaseFreshnessInfo{}, err
		}
		if IsNotFound(err) {
			return graph.ReleaseFreshnessUnavailable(request.Module, request.Version), nil
		}
		return graph.ReleaseFreshnessLookupError(request.Module, request.Version, err), nil
	}
	return graph.ClassifyReleaseFreshness(request.Module, request.Version, latest), nil
}

func (r *Resolver) fetchLatestReleaseVersion(ctx context.Context, modulePath string) (string, error) {
	modulePath = strings.TrimSpace(modulePath)
	if modulePath == "" {
		return "", fmt.Errorf("module path is empty")
	}

	r.mu.Lock()
	if cached, ok := r.releaseVersionCache[modulePath]; ok {
		r.mu.Unlock()
		return cached, nil
	}
	r.mu.Unlock()

	list, err := r.fetchText(ctx, proxyModuleURL(modulePath)+"/@v/list", "text/plain,*/*")
	if err == nil {
		if latest := graph.LatestStableModuleVersion(list); latest != "" {
			r.mu.Lock()
			r.releaseVersionCache[modulePath] = latest
			r.mu.Unlock()
			return latest, nil
		}
	} else if !IsNotFound(err) {
		return "", err
	}

	var payload struct {
		Version string `json:"Version"`
	}
	if err := r.fetchJSON(ctx, proxyModuleURL(modulePath)+"/@latest", "application/json", &payload); err != nil {
		return "", err
	}
	latest := strings.TrimSpace(payload.Version)
	if latest == "" {
		return "", fmt.Errorf("Go module proxy did not return a latest version for %s", modulePath)
	}

	r.mu.Lock()
	r.releaseVersionCache[modulePath] = latest
	r.mu.Unlock()
	return latest, nil
}
