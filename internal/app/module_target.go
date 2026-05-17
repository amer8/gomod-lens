package app

import (
	"fmt"
	"strings"
	"unicode"
)

const (
	maxModuleTargetLength  = 240
	maxModuleSegmentLength = 80
	maxModuleVersionLength = 128
)

func validateRequestedModuleTarget(target string) error {
	target = strings.TrimSpace(target)
	if target == "" {
		return fmt.Errorf("target is required")
	}
	if len(target) > maxModuleTargetLength {
		return fmt.Errorf("target is too long")
	}

	base, version := splitTargetVersion(target)
	if strings.Contains(version, "@") {
		return fmt.Errorf("target version is invalid")
	}
	if err := validateModuleVersion(version); err != nil {
		return err
	}
	if isLikelyLocalTarget(base) {
		return fmt.Errorf("local module targets are not available")
	}
	if strings.Contains(base, "://") || strings.ContainsAny(base, "?#") {
		return fmt.Errorf("target must be a Go module path, not a URL")
	}
	if !hasAllowedModulePathChars(base) {
		return fmt.Errorf("target contains unsupported characters")
	}
	if shouldSearchModuleTarget(target) {
		return nil
	}
	return validateResolvedModuleTarget(target)
}

func validateResolvedModuleTarget(target string) error {
	target = strings.TrimSpace(target)
	base, version := splitTargetVersion(target)
	if err := validateModuleVersion(version); err != nil {
		return err
	}
	if isLikelyLocalTarget(base) {
		return fmt.Errorf("local module targets are not available")
	}
	if !hasAllowedModulePathChars(base) {
		return fmt.Errorf("target contains unsupported characters")
	}

	parts := strings.Split(base, "/")
	if len(parts) < 2 {
		return fmt.Errorf("target must include a public module host")
	}
	if parts[0] == "" || !strings.Contains(parts[0], ".") || strings.EqualFold(parts[0], "localhost") {
		return fmt.Errorf("target must include a public module host")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("target contains an invalid path segment")
		}
		if len(part) > maxModuleSegmentLength {
			return fmt.Errorf("target path segment is too long")
		}
	}
	return nil
}

func validateModuleVersion(version string) error {
	if version == "" {
		return nil
	}
	if len(version) > maxModuleVersionLength {
		return fmt.Errorf("target version is too long")
	}
	for _, r := range version {
		if r > unicode.MaxASCII {
			return fmt.Errorf("target version contains unsupported characters")
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			continue
		}
		switch r {
		case '.', '-', '_', '+':
			continue
		default:
			return fmt.Errorf("target version contains unsupported characters")
		}
	}
	return nil
}

func hasAllowedModulePathChars(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r > unicode.MaxASCII {
			return false
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			continue
		}
		switch r {
		case '/', '.', '-', '_', '~':
			continue
		default:
			return false
		}
	}
	return true
}
