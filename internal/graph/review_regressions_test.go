package graph

import (
	"path/filepath"
	"testing"
)

func TestPrereleaseIdentifiersPreserveHyphens(t *testing.T) {
	ordered := []string{"v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta", "v1.0.0-beta.2", "v1.0.0-beta.11", "v1.0.0-rc.1", "v1.0.0-rc-1", "v1.0.0"}
	for i, left := range ordered {
		for j, right := range ordered {
			got := compareModuleVersions(left, right)
			if i < j && got >= 0 || i == j && got != 0 || i > j && got <= 0 {
				t.Fatalf("compareModuleVersions(%q, %q) = %d", left, right, got)
			}
		}
	}
}

func TestUnknownLicenseCandidateDoesNotMaskRecognizedLicense(t *testing.T) {
	for _, candidate := range []string{"COPYING", "LICENSE.custom"} {
		t.Run(candidate, func(t *testing.T) {
			dir := t.TempDir()
			mustWriteFile(t, filepath.Join(dir, candidate), "See the project documentation for notices.")
			mustWriteFile(t, filepath.Join(dir, "LICENSE.txt"), "SPDX-License-Identifier: MIT")
			cache := make(map[string]string)
			if got := detectModuleLicense(dir, cache); got != "MIT" {
				t.Fatalf("unrecognized candidate masked MIT: %q", got)
			}
			if cache[dir] != "MIT" {
				t.Fatal("recognized license was not cached")
			}
		})
	}
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "NOTICE"), "Unrecognized project notice.")
	if got := detectModuleLicense(dir, make(map[string]string)); got != "unknown" {
		t.Fatalf("unrecognized files produced %q", got)
	}
}
