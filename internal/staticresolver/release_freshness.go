package staticresolver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/mod/modfile"

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

	release, err := r.latestRelease(ctx, request.Module)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return graph.ReleaseFreshnessInfo{}, err
		}
		if IsNotFound(err) {
			return graph.ReleaseFreshnessUnavailable(request.Module, request.Version), nil
		}
		return graph.ReleaseFreshnessLookupError(request.Module, request.Version, err), nil
	}
	info := graph.ClassifyReleaseFreshness(request.Module, request.Version, release.latest)
	if release.retracted(request.Version) {
		info.Status = graph.ReleaseFreshnessStatusRetracted
		info.Message = "The module author retracted this version."
	}
	return info, nil
}

type releaseVersions struct {
	latest      string
	retractions []modfile.VersionInterval
}

func (v releaseVersions) retracted(version string) bool {
	for _, interval := range v.retractions {
		if compareGoVersions(interval.Low, version) <= 0 && compareGoVersions(version, interval.High) <= 0 {
			return true
		}
	}
	return false
}

// Both the root query and the lens use the highest release's go.mod for
// retractions, including when that release retracts itself.
func (r *Resolver) latestRelease(ctx context.Context, path string) (releaseVersions, error) {
	r.mu.Lock()
	cached, ok := r.releaseVersionCache[path]
	r.mu.Unlock()
	if ok {
		return cached, nil
	}

	base := proxyModuleURL(path)
	list, err := r.fetchText(ctx, base+"/@v/list", "text/plain,*/*")
	if err != nil && !IsNotFound(err) {
		return releaseVersions{}, err
	}
	listed := graph.LatestStableModuleVersion(list)
	highest := listed
	if highest == "" {
		highest, err = r.proxyLatest(ctx, base)
		if err != nil {
			return releaseVersions{}, err
		}
	}
	meta, err := r.loadGoMod(ctx, path, highest)
	if err != nil {
		return releaseVersions{}, err
	}
	release := releaseVersions{latest: highest, retractions: meta.Retractions}
	if release.retracted(highest) {
		var available []string
		for version := range strings.FieldsSeq(list) {
			if !release.retracted(version) {
				available = append(available, version)
			}
		}
		release.latest = graph.LatestStableModuleVersion(strings.Join(available, "\n"))
		if release.latest == "" && listed != "" {
			fallback, err := r.proxyLatest(ctx, base)
			if err != nil && !IsNotFound(err) {
				return releaseVersions{}, err
			}
			if err == nil && !release.retracted(fallback) {
				release.latest = fallback
			}
		}
	}
	r.mu.Lock()
	r.releaseVersionCache[path] = release
	r.mu.Unlock()
	return release, nil
}

func (r *Resolver) proxyLatest(ctx context.Context, base string) (string, error) {
	var info struct{ Version string }
	if err := r.fetchJSON(ctx, base+"/@latest", "application/json", &info); err != nil {
		return "", err
	}
	version := strings.TrimSpace(info.Version)
	if parseGoVersion(version) == nil {
		return "", fmt.Errorf("invalid version from %s/@latest", base)
	}
	return version, nil
}
