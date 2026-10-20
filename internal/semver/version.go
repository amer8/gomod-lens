package semver

import "strings"

// Version stores version components as decimal strings to avoid integer limits.
type Version struct {
	Major, Minor, Patch string
	Prerelease          string
}

// Parse parses a three-component Go semantic version, including the v prefix.
func Parse(version string) *Version {
	version = strings.TrimSpace(version)
	if !strings.HasPrefix(version, "v") {
		return nil
	}
	body, build, hasBuild := strings.Cut(version[1:], "+")
	if hasBuild && !validIdentifiers(build, false) {
		return nil
	}
	body, prerelease, hasPrerelease := strings.Cut(body, "-")
	if hasPrerelease && !validIdentifiers(prerelease, true) {
		return nil
	}
	parts := strings.Split(body, ".")
	if len(parts) != 3 {
		return nil
	}
	for _, part := range parts {
		if !numericIdentifier(part) || len(part) > 1 && part[0] == '0' {
			return nil
		}
	}
	return &Version{Major: parts[0], Minor: parts[1], Patch: parts[2], Prerelease: prerelease}
}

// Compare orders versions by precedence, ignoring build metadata. Invalid
// versions sort below valid versions, and lexically relative to each other.
func Compare(left, right string) int {
	a, b := Parse(left), Parse(right)
	if a == nil && b == nil {
		return strings.Compare(left, right)
	}
	if a == nil {
		return -1
	}
	if b == nil {
		return 1
	}
	for _, pair := range [][2]string{{a.Major, b.Major}, {a.Minor, b.Minor}, {a.Patch, b.Patch}} {
		if order := CompareNumeric(pair[0], pair[1]); order != 0 {
			return order
		}
	}
	if a.Prerelease == "" && b.Prerelease != "" {
		return 1
	}
	if a.Prerelease != "" && b.Prerelease == "" {
		return -1
	}
	if a.Prerelease == "" {
		return 0
	}
	return ComparePrerelease(a.Prerelease, b.Prerelease)
}

// CompareNumeric compares non-empty decimal strings without leading zeros.
func CompareNumeric(left, right string) int {
	if len(left) < len(right) {
		return -1
	}
	if len(left) > len(right) {
		return 1
	}
	return strings.Compare(left, right)
}

func validIdentifiers(value string, prerelease bool) bool {
	for _, identifier := range strings.Split(value, ".") {
		if identifier == "" {
			return false
		}
		for _, char := range identifier {
			if char != '-' && (char < '0' || char > '9') && (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') {
				return false
			}
		}
		if prerelease && numericIdentifier(identifier) && len(identifier) > 1 && identifier[0] == '0' {
			return false
		}
	}
	return true
}
