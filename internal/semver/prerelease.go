// Package semver provides shared Semantic Version precedence helpers.
package semver

import "strings"

// ComparePrerelease compares non-empty prerelease strings from valid Semantic
// Versions. Numeric identifiers are compared without machine integer limits.
func ComparePrerelease(left, right string) int {
	a, b := strings.Split(left, "."), strings.Split(right, ".")
	for i := 0; i < min(len(a), len(b)); i++ {
		leftNumeric, rightNumeric := numericIdentifier(a[i]), numericIdentifier(b[i])
		switch {
		case leftNumeric && rightNumeric:
			// Valid numeric identifiers have no leading zeros, so length gives
			// their numeric order before comparing equally long digit strings.
			if len(a[i]) < len(b[i]) {
				return -1
			}
			if len(a[i]) > len(b[i]) {
				return 1
			}
		case leftNumeric:
			return -1
		case rightNumeric:
			return 1
		}
		if order := strings.Compare(a[i], b[i]); order != 0 {
			return order
		}
	}
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return 0
}

func numericIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}
