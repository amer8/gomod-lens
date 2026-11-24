package graph

import (
	"strings"

	"golang.org/x/mod/module"

	"github.com/amer8/gomod-lens/internal/semver"
)

const (
	ReleaseFreshnessStatusRetracted     = "retracted"
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
func ClassifyReleaseFreshness(modulePath, version, latestVersion string) ReleaseFreshnessInfo {
	modulePath = strings.TrimSpace(modulePath)
	version = strings.TrimSpace(version)
	latestVersion = strings.TrimSpace(latestVersion)
	info := ReleaseFreshnessInfo{
		Module:        modulePath,
		Version:       version,
		LatestVersion: latestVersion,
	}
	if modulePath == "" || version == "" {
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
	if module.IsPseudoVersion(version) {
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

// LatestStableModuleVersion prefers a tagged release over a prerelease.
// Pseudo-versions are obtained from the proxy's @latest fallback.
func LatestStableModuleVersion(versionList string) string {
	var stable, preview string
	for version := range strings.FieldsSeq(versionList) {
		parsed := parseModuleVersion(version)
		if parsed == nil || module.IsPseudoVersion(version) {
			continue
		}
		if parsed.Prerelease == "" {
			if stable == "" || compareModuleVersions(version, stable) > 0 {
				stable = version
			}
		} else if preview == "" || compareModuleVersions(version, preview) > 0 {
			preview = version
		}
	}
	if stable != "" {
		return stable
	}
	return preview
}

func releaseFreshnessScore(status string) *float64 {
	scores := map[string]float64{
		ReleaseFreshnessStatusCurrent:       1,
		ReleaseFreshnessStatusRetracted:     0.2,
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
