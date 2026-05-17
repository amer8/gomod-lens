package staticresolver

import (
	"strconv"
	"strings"
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
	a := splitPrerelease(left)
	b := splitPrerelease(right)
	length := max(len(b), len(a))

	for i := 0; i < length; i++ {
		if i >= len(a) {
			return -1
		}
		if i >= len(b) {
			return 1
		}

		leftNumber, leftOK := parseVersionNumber(a[i])
		rightNumber, rightOK := parseVersionNumber(b[i])
		switch {
		case leftOK && rightOK && leftNumber != rightNumber:
			return leftNumber - rightNumber
		case leftOK && !rightOK:
			return -1
		case !leftOK && rightOK:
			return 1
		case a[i] != b[i]:
			return strings.Compare(a[i], b[i])
		}
	}
	return 0
}

func splitPrerelease(value string) []string {
	return strings.FieldsFunc(value, func(char rune) bool {
		return char == '.' || char == '-'
	})
}
