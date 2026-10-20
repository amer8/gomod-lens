package graph

import (
	"path/filepath"
	"testing"
)

func TestPrereleaseIdentifiersPreserveHyphens(t *testing.T) {
	ordered := []string{"v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta", "v1.0.0-beta.2", "v1.0.0-beta.11", "v1.0.0-beta.9223372036854775808", "v1.0.0-beta.10000000000000000000", "v1.0.0-rc.1", "v1.0.0-rc-1", "v1.0.0"}
	for i, left := range ordered {
		for j, right := range ordered {
			got := compareModuleVersions(left, right)
			if i < j && got >= 0 || i == j && got != 0 || i > j && got <= 0 {
				t.Fatalf("compareModuleVersions(%q, %q) = %d", left, right, got)
			}
		}
	}
}

func TestLargeCoreVersionsRemainComparableForFreshness(t *testing.T) {
	for _, tc := range []struct {
		current string
		latest  string
		status  string
	}{
		{"v1.0.9", "v1.0.9223372036854775808", ReleaseFreshnessStatusPatchBehind},
		{"v1.9.0", "v1.9223372036854775808.0", ReleaseFreshnessStatusMinorBehind},
		{"v9.0.0", "v9223372036854775808.0.0", ReleaseFreshnessStatusMajorBehind},
		{"v1.0.9223372036854775808", "v1.0.10000000000000000000", ReleaseFreshnessStatusPatchBehind},
		{"v1.0.10000000000000000000", "v1.0.9223372036854775808", ReleaseFreshnessStatusCurrent},
		{"v1.0.9223372036854775808-rc-1", "v1.0.9223372036854775808", ReleaseFreshnessStatusPrerelease},
	} {
		t.Run(tc.current+"/"+tc.latest, func(t *testing.T) {
			if got := ClassifyReleaseFreshness("example.org/a", tc.current, tc.latest); got.Status != tc.status {
				t.Fatalf("freshness=%+v, want status %s", got, tc.status)
			}
		})
	}
	if got := LatestStableModuleVersion("v1.0.9\nv1.0.9223372036854775808\n"); got != "v1.0.9223372036854775808" {
		t.Fatalf("large stable release was ignored: %s", got)
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
