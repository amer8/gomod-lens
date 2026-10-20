package staticresolver

import "github.com/amer8/gomod-lens/internal/semver"

func parseGoVersion(version string) *semver.Version {
	return semver.Parse(version)
}

func compareGoVersions(left, right string) int {
	return semver.Compare(left, right)
}
