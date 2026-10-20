package semver

import (
	"strings"
	"testing"
)

func TestCompareVersionCoreWithoutIntegerLimits(t *testing.T) {
	huge := strings.Repeat("9", 100)
	ordered := []string{
		"v0.0.0", "v1.0.9", "v1.0.9223372036854775808", "v1.0.10000000000000000000",
		"v1.0." + huge, "v1.9.0", "v1.9223372036854775808.0", "v1.10000000000000000000.0",
		"v1." + huge + ".0", "v9.0.0", "v9223372036854775808.0.0", "v10000000000000000000.0.0",
		"v" + huge + ".0.0-rc.1", "v" + huge + ".0.0-rc-1", "v" + huge + ".0.0",
	}
	for i, left := range ordered {
		if Parse(left) == nil {
			t.Fatalf("valid version was rejected: %s", left)
		}
		for j, right := range ordered {
			got := Compare(left, right)
			if i < j && got >= 0 || i == j && got != 0 || i > j && got <= 0 {
				t.Fatalf("Compare(%q, %q) = %d", left, right, got)
			}
		}
	}
	if Compare("v1.0.0+incompatible", "v1.0.0+build.001") != 0 {
		t.Fatal("build metadata changed version precedence")
	}
}

func TestParseRejectsInvalidNumericAndIdentifierSyntax(t *testing.T) {
	for _, version := range []string{"", "1.0.0", "v1", "v1.2", "v01.0.0", "v1.01.0", "v1.0.01", "v1.0.0-", "v1.0.0-01", "v1.0.0-rc..1", "v1.0.0+", "v1.0.0+build+1", "v1.0.0-rc_1"} {
		if Parse(version) != nil {
			t.Errorf("accepted invalid version %q", version)
		}
	}
}
