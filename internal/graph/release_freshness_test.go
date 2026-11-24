package graph

import (
	"testing"
	"unsafe"
)

func TestClassifyReleaseFreshness(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		version       string
		latestVersion string
		want          string
	}{
		{
			name:          "current",
			version:       "v1.2.3",
			latestVersion: "v1.2.3",
			want:          ReleaseFreshnessStatusCurrent,
		},
		{
			name:          "patch behind",
			version:       "v1.2.3",
			latestVersion: "v1.2.4",
			want:          ReleaseFreshnessStatusPatchBehind,
		},
		{
			name:          "minor behind",
			version:       "v1.2.3",
			latestVersion: "v1.3.0",
			want:          ReleaseFreshnessStatusMinorBehind,
		},
		{
			name:          "major behind",
			version:       "v1.2.3",
			latestVersion: "v2.0.0",
			want:          ReleaseFreshnessStatusMajorBehind,
		},
		{
			name:          "prerelease",
			version:       "v1.3.0-rc.1",
			latestVersion: "v1.3.0",
			want:          ReleaseFreshnessStatusPrerelease,
		},
		{
			name:          "timestamp tag",
			version:       "v1.0.0-20210101120000",
			latestVersion: "v1.0.0",
			want:          ReleaseFreshnessStatusPrerelease,
		},
		{
			name:          "pseudo version",
			version:       "v0.0.0-20240501120000-abcdef123456",
			latestVersion: "v0.1.0",
			want:          ReleaseFreshnessStatusPseudoVersion,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := ClassifyReleaseFreshness("example.com/mod", tt.version, tt.latestVersion)
			if got.Status != tt.want {
				t.Fatalf("status = %q, want %q; info = %+v", got.Status, tt.want, got)
			}
		})
	}
}

func TestLatestStableModuleVersionPrefersStableRelease(t *testing.T) {
	t.Parallel()

	got := LatestStableModuleVersion("v1.3.0-rc.1\nv1.2.9\nv1.3.0-beta.1\n")
	if got != "v1.2.9" {
		t.Fatalf("LatestStableModuleVersion() = %q, want stable v1.2.9", got)
	}
}

func TestSelectedReleaseDoesNotRetainVersionList(t *testing.T) {
	for _, want := range []string{"v1.0.0", "v1.0.0-rc.1"} {
		list := want + "\nv0.9.0-beta.1\n"
		got := LatestStableModuleVersion(list)
		if got != want {
			t.Fatalf("selected %q, want %q", got, want)
		}
		if unsafe.StringData(got) == unsafe.StringData(list) {
			t.Error("the cached version still points into the input list")
		}
	}
}

func TestReleaseFreshnessRequestForNodeUsesRemoteReplacement(t *testing.T) {
	t.Parallel()

	request, skipped := ReleaseFreshnessRequestForNode(Node{
		ID:          "example.com/original@v1.0.0",
		Name:        "example.com/original",
		Version:     "v1.0.0",
		Replaced:    true,
		Replacement: "example.com/fork@v1.2.0",
	})

	if skipped != nil {
		t.Fatalf("skipped = %+v, want remote replacement request", skipped)
	}
	if request.Module != "example.com/fork" || request.Version != "v1.2.0" {
		t.Fatalf("request = %+v, want replacement module/version", request)
	}
}
