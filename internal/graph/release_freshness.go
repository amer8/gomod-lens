package graph

import (
	"context"
	"sort"
	"strings"

	"github.com/amer8/gomod-lens/internal/semver"
)

const (
	ReleaseFreshnessStatusCurrent       = "current"
	ReleaseFreshnessStatusPatchBehind   = "patch_behind"
	ReleaseFreshnessStatusMinorBehind   = "minor_behind"
	ReleaseFreshnessStatusMajorBehind   = "major_behind"
	ReleaseFreshnessStatusPrerelease    = "prerelease"
	ReleaseFreshnessStatusPseudoVersion = "pseudo_version"
	ReleaseFreshnessStatusUnknown       = "unknown"
	ReleaseFreshnessStatusSkipped       = "skipped"
	ReleaseFreshnessStatusUnavailable   = "unavailable"
	ReleaseFreshnessStatusError         = "error"
)

// ReleaseFreshnessProvider fetches latest release data for graph nodes.
type ReleaseFreshnessProvider interface {
	FetchReleaseFreshness(ctx context.Context, deps []ReleaseFreshnessRequest) map[string]ReleaseFreshnessInfo
}

// ReleaseFreshnessRequest identifies one module version to classify.
type ReleaseFreshnessRequest struct {
	ID      string
	Module  string
	Version string
}

// ReleaseFreshnessInfo describes how fresh a selected module version is.
type ReleaseFreshnessInfo struct {
	Module        string
	Version       string
	LatestVersion string
	Status        string
	Message       string
}

// ReleaseFreshnessLens applies latest-release freshness data to graph nodes.
type ReleaseFreshnessLens struct {
	provider ReleaseFreshnessProvider
}

// NewReleaseFreshnessLens creates the built-in release freshness lens.
func NewReleaseFreshnessLens(provider ReleaseFreshnessProvider) *ReleaseFreshnessLens {
	return &ReleaseFreshnessLens{provider: provider}
}

// Definition returns metadata for the release freshness lens.
func (l *ReleaseFreshnessLens) Definition() LensDefinition {
	return ReleaseFreshnessLensDefinition()
}

// Analyze enriches graph nodes with release freshness results.
func (l *ReleaseFreshnessLens) Analyze(ctx context.Context, graph *Graph) error {
	applyReleaseFreshnessLens(ctx, graph, l.provider)
	return nil
}

// SetNodeReleaseFreshness records release freshness data on the generic lens map.
func SetNodeReleaseFreshness(node *Node, info *ReleaseFreshnessInfo) {
	if node == nil {
		return
	}
	if info == nil {
		if node.Lenses != nil {
			delete(node.Lenses, LensReleaseFreshness)
		}
		return
	}
	node.SetLensResult(LensReleaseFreshness, info.LensResult())
}

// ReleaseFreshnessForNode returns the release freshness result attached to a node.
func ReleaseFreshnessForNode(node Node) *ReleaseFreshnessInfo {
	result, ok := node.LensResult(LensReleaseFreshness)
	if !ok {
		return nil
	}
	info := ReleaseFreshnessInfo{
		Status:  result.Status,
		Message: result.Message,
	}
	if result.Details != nil {
		info.Module = result.Details["module"]
		info.Version = result.Details["version"]
		info.LatestVersion = result.Details["latestVersion"]
		if info.Message == "" {
			info.Message = result.Details["error"]
		}
	}
	return &info
}

// LensResult converts release freshness data into the generic lens result shape.
func (r ReleaseFreshnessInfo) LensResult() LensResult {
	result := LensResult{
		Status:  r.Status,
		Score:   releaseFreshnessScore(r.Status),
		Message: r.Message,
	}
	details := make(map[string]string)
	if r.Module != "" {
		details["module"] = r.Module
	}
	if r.Version != "" {
		details["version"] = r.Version
	}
	if r.LatestVersion != "" {
		details["latestVersion"] = r.LatestVersion
	}
	if r.Message != "" {
		details["error"] = r.Message
	}
	if len(details) > 0 {
		result.Details = details
	}
	return result
}

// ReleaseFreshnessRequestForNode returns the module/version lookup target for a
// node, accounting for remote replacements and local replacement skips.
func ReleaseFreshnessRequestForNode(node Node) (ReleaseFreshnessRequest, *ReleaseFreshnessInfo) {
	module := strings.TrimSpace(node.Name)
	version := strings.TrimSpace(node.Version)

	if node.Replaced && strings.TrimSpace(node.Replacement) != "" {
		replacementModule, replacementVersion := splitReleaseModuleToken(node.Replacement)
		if isLocalReleaseReplacementTarget(replacementModule) {
			return ReleaseFreshnessRequest{}, &ReleaseFreshnessInfo{
				Module:  module,
				Version: version,
				Status:  ReleaseFreshnessStatusSkipped,
				Message: "local replacement",
			}
		}
		module = replacementModule
		if replacementVersion != "" {
			version = replacementVersion
		}
	}

	if module == "" || version == "" {
		return ReleaseFreshnessRequest{}, &ReleaseFreshnessInfo{
			Module:  module,
			Version: version,
			Status:  ReleaseFreshnessStatusSkipped,
			Message: "module version is not available",
		}
	}

	return ReleaseFreshnessRequest{
		ID:      node.ID,
		Module:  module,
		Version: version,
	}, nil
}

// ClassifyReleaseFreshness compares version to latestVersion and returns a lens
// result with a stable status taxonomy.
func ClassifyReleaseFreshness(module, version, latestVersion string) ReleaseFreshnessInfo {
	module = strings.TrimSpace(module)
	version = strings.TrimSpace(version)
	latestVersion = strings.TrimSpace(latestVersion)
	info := ReleaseFreshnessInfo{
		Module:        module,
		Version:       version,
		LatestVersion: latestVersion,
	}
	if module == "" || version == "" {
		info.Status = ReleaseFreshnessStatusSkipped
		info.Message = "module version is not available"
		return info
	}
	if latestVersion == "" {
		info.Status = ReleaseFreshnessStatusUnavailable
		info.Message = "latest version is not available"
		return info
	}
	if version == latestVersion {
		info.Status = ReleaseFreshnessStatusCurrent
		return info
	}

	current := parseModuleVersion(version)
	latest := parseModuleVersion(latestVersion)
	if current == nil || latest == nil {
		info.Status = ReleaseFreshnessStatusUnknown
		info.Message = "module version could not be compared"
		return info
	}
	if isPseudoModuleVersion(version) {
		info.Status = ReleaseFreshnessStatusPseudoVersion
		return info
	}
	if current.Prerelease != "" {
		info.Status = ReleaseFreshnessStatusPrerelease
		return info
	}
	if compareModuleVersions(version, latestVersion) >= 0 {
		info.Status = ReleaseFreshnessStatusCurrent
		return info
	}
	switch {
	case semver.CompareNumeric(current.Major, latest.Major) < 0:
		info.Status = ReleaseFreshnessStatusMajorBehind
	case semver.CompareNumeric(current.Minor, latest.Minor) < 0:
		info.Status = ReleaseFreshnessStatusMinorBehind
	default:
		info.Status = ReleaseFreshnessStatusPatchBehind
	}
	return info
}

// ReleaseFreshnessLookupError returns a non-fatal per-node error result.
func ReleaseFreshnessLookupError(module, version string, err error) ReleaseFreshnessInfo {
	message := ""
	if err != nil {
		message = err.Error()
	}
	return ReleaseFreshnessInfo{
		Module:  strings.TrimSpace(module),
		Version: strings.TrimSpace(version),
		Status:  ReleaseFreshnessStatusError,
		Message: message,
	}
}

// ReleaseFreshnessUnavailable returns a non-fatal per-node unavailable result.
func ReleaseFreshnessUnavailable(module, version string) ReleaseFreshnessInfo {
	return ReleaseFreshnessInfo{
		Module:  strings.TrimSpace(module),
		Version: strings.TrimSpace(version),
		Status:  ReleaseFreshnessStatusUnavailable,
	}
}

// LatestStableModuleVersion returns the highest stable semver in a Go proxy
// version list. If no stable version exists, it returns the highest comparable
// version so callers can still classify pre-release-only modules.
func LatestStableModuleVersion(versionList string) string {
	versions := make([]string, 0)
	for _, version := range strings.Fields(versionList) {
		version = strings.TrimSpace(version)
		if version != "" && parseModuleVersion(version) != nil {
			versions = append(versions, version)
		}
	}
	sort.Slice(versions, func(i, j int) bool {
		return compareModuleVersions(versions[i], versions[j]) > 0
	})
	for _, version := range versions {
		parsed := parseModuleVersion(version)
		if parsed != nil && parsed.Prerelease == "" && !isPseudoModuleVersion(version) {
			return version
		}
	}
	if len(versions) > 0 {
		return versions[0]
	}
	return ""
}

func applyReleaseFreshnessLens(ctx context.Context, graph *Graph, provider ReleaseFreshnessProvider) {
	if graph == nil {
		return
	}

	requests := make([]ReleaseFreshnessRequest, 0, len(graph.Nodes))
	for i := range graph.Nodes {
		request, skipped := ReleaseFreshnessRequestForNode(graph.Nodes[i])
		if skipped != nil {
			SetNodeReleaseFreshness(&graph.Nodes[i], skipped)
			continue
		}
		requests = append(requests, request)
	}

	if provider == nil {
		for i := range graph.Nodes {
			if ReleaseFreshnessForNode(graph.Nodes[i]) != nil {
				continue
			}
			SetNodeReleaseFreshness(&graph.Nodes[i], &ReleaseFreshnessInfo{
				Module:  graph.Nodes[i].Name,
				Version: graph.Nodes[i].Version,
				Status:  ReleaseFreshnessStatusError,
				Message: "release freshness provider is unavailable",
			})
		}
		return
	}

	results := provider.FetchReleaseFreshness(ctx, requests)
	for i := range graph.Nodes {
		if ReleaseFreshnessForNode(graph.Nodes[i]) != nil {
			continue
		}
		if info, ok := results[graph.Nodes[i].ID]; ok {
			SetNodeReleaseFreshness(&graph.Nodes[i], &info)
			continue
		}
		SetNodeReleaseFreshness(&graph.Nodes[i], &ReleaseFreshnessInfo{
			Module:  graph.Nodes[i].Name,
			Version: graph.Nodes[i].Version,
			Status:  ReleaseFreshnessStatusError,
			Message: "release freshness was not returned",
		})
	}
}

func releaseFreshnessScore(status string) *float64 {
	scores := map[string]float64{
		ReleaseFreshnessStatusCurrent:       1,
		ReleaseFreshnessStatusPatchBehind:   0.78,
		ReleaseFreshnessStatusMinorBehind:   0.54,
		ReleaseFreshnessStatusMajorBehind:   0.28,
		ReleaseFreshnessStatusPrerelease:    0.48,
		ReleaseFreshnessStatusPseudoVersion: 0.42,
		ReleaseFreshnessStatusUnknown:       0.34,
		ReleaseFreshnessStatusUnavailable:   0.22,
		ReleaseFreshnessStatusSkipped:       0.22,
		ReleaseFreshnessStatusError:         0.16,
	}
	value, ok := scores[status]
	if !ok {
		return nil
	}
	return &value
}

func parseModuleVersion(version string) *semver.Version {
	return semver.Parse(version)
}

func compareModuleVersions(left, right string) int {
	return semver.Compare(left, right)
}

func isPseudoModuleVersion(version string) bool {
	parsed := parseModuleVersion(version)
	if parsed == nil || parsed.Prerelease == "" {
		return false
	}
	// Pseudo-version timestamps use a hyphen before the revision, unlike the
	// dot-delimited identifiers used for SemVer precedence.
	for _, part := range strings.FieldsFunc(parsed.Prerelease, func(r rune) bool { return r == '.' || r == '-' }) {
		if len(part) != 14 {
			continue
		}
		if strings.Trim(part, "0123456789") == "" {
			return true
		}
	}
	return false
}

func splitReleaseModuleToken(token string) (string, string) {
	index := strings.LastIndex(token, "@")
	if index <= 0 {
		return strings.TrimSpace(token), ""
	}
	return strings.TrimSpace(token[:index]), strings.TrimSpace(token[index+1:])
}

func isLocalReleaseReplacementTarget(target string) bool {
	if target == "" {
		return false
	}
	switch {
	case strings.HasPrefix(target, "."):
		return true
	case strings.HasPrefix(target, "/"), strings.HasPrefix(target, `\`):
		return true
	case len(target) >= 2 && target[1] == ':':
		return true
	default:
		return false
	}
}
