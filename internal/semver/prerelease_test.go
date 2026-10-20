package semver

import (
	"strings"
	"testing"
)

func TestComparePrerelease(t *testing.T) {
	ordered := []string{
		"0", "1", "9", "10", "9223372036854775807", "9223372036854775808",
		"10000000000000000000", strings.Repeat("9", 100), "0x",
		"alpha", "alpha.1", "alpha.9223372036854775808",
		"alpha.10000000000000000000", "alpha.10000000000000000000.1",
		"beta", "beta.2", "beta.11", "rc.1", "rc-1",
	}
	for i, left := range ordered {
		for j, right := range ordered {
			got := ComparePrerelease(left, right)
			if i < j && got >= 0 || i == j && got != 0 || i > j && got <= 0 {
				t.Fatalf("ComparePrerelease(%q, %q) = %d", left, right, got)
			}
		}
	}
}
