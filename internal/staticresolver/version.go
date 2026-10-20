package staticresolver

import (
	"strconv"
	"strings"

	"github.com/amer8/gomod-lens/internal/semver"
)

type goVersion struct {
	Major      int
	Minor      int
	Patch      int
	Prerelease string
}

func parseGoVersion(version string) *goVersion {
	version = strings.TrimSpace(version)
	if !strings.HasPrefix(version, "v") {
		return nil
	}

	body := version[1:]
	if plus := strings.Index(body, "+"); plus >= 0 {
		body = body[:plus]
	}

	prerelease := ""
	if dash := strings.Index(body, "-"); dash >= 0 {
		prerelease = body[dash+1:]
		body = body[:dash]
	}

	parts := strings.Split(body, ".")
	if len(parts) != 3 {
		return nil
	}
	major, ok := parseVersionNumber(parts[0])
	if !ok {
		return nil
	}
	minor, ok := parseVersionNumber(parts[1])
	if !ok {
		return nil
	}
	patch, ok := parseVersionNumber(parts[2])
	if !ok {
		return nil
	}

	return &goVersion{
		Major:      major,
		Minor:      minor,
		Patch:      patch,
		Prerelease: prerelease,
	}
}

func parseVersionNumber(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	parsed, err := strconv.Atoi(value)
	return parsed, err == nil
}

func compareGoVersions(left, right string) int {
	a := parseGoVersion(left)
	b := parseGoVersion(right)
	if a == nil && b == nil {
		return strings.Compare(left, right)
	}
	if a == nil {
		return -1
	}
	if b == nil {
		return 1
	}

	if a.Major != b.Major {
		return a.Major - b.Major
	}
	if a.Minor != b.Minor {
		return a.Minor - b.Minor
	}
	if a.Patch != b.Patch {
		return a.Patch - b.Patch
	}

	if a.Prerelease == "" && b.Prerelease != "" {
		return 1
	}
	if a.Prerelease != "" && b.Prerelease == "" {
		return -1
	}
	if a.Prerelease == "" && b.Prerelease == "" {
		return 0
	}
	return comparePrerelease(a.Prerelease, b.Prerelease)
}

func comparePrerelease(left, right string) int {
	return semver.ComparePrerelease(left, right)
}
