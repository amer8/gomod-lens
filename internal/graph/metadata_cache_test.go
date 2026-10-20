package graph

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestReleaseMetadataExpiresAndFailedRefreshDoesNotServeOldVersion(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	version, calls, status := "v1.0.0", 0, http.StatusOK
	provider := NewGoProxyReleaseFreshnessProvider(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(version))}, nil
	})}, 1)
	provider.now = func() time.Time { return now }
	requests := []ReleaseFreshnessRequest{{ID: "root", Module: "example.org/root", Version: "v1.0.0"}}
	read := func() ReleaseFreshnessInfo {
		return provider.FetchReleaseFreshness(context.Background(), requests)["root"]
	}
	if info := read(); info.Status != ReleaseFreshnessStatusCurrent {
		t.Fatal(info)
	}
	version = "v1.0.1"
	now = now.Add(mutableLensCacheTTL - time.Nanosecond)
	if info := read(); info.Status != ReleaseFreshnessStatusCurrent || calls != 1 {
		t.Fatalf("cache miss before expiry: %+v, calls=%d", info, calls)
	}
	now = now.Add(time.Nanosecond)
	if info := read(); info.Status != ReleaseFreshnessStatusPatchBehind || calls != 2 {
		t.Fatalf("latest version did not refresh at expiry: %+v, calls=%d", info, calls)
	}
	now = now.Add(mutableLensCacheTTL)
	status = http.StatusServiceUnavailable
	if info := read(); info.Status != ReleaseFreshnessStatusError {
		t.Fatalf("expired success masked a refresh failure: %+v", info)
	}
	status, version = http.StatusOK, "v1.1.0"
	if info := read(); info.Status != ReleaseFreshnessStatusMinorBehind || calls != 4 {
		t.Fatalf("failed lookup was cached: %+v, calls=%d", info, calls)
	}
}

func TestScorecardMetadataExpiresIncludingUnavailableResults(t *testing.T) {
	for _, initialScorecard := range []bool{true, false} {
		t.Run(fmt.Sprint(initialScorecard), func(t *testing.T) {
			now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
			calls, score := 0, 5
			hasScorecard := initialScorecard
			provider := NewDepsDevOpenSSFScoreProvider(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				calls++
				body := `{"relatedProjects":[{"projectKey":{"id":"github.com/example/root"},"relationType":"SOURCE_REPO"}]}`
				if strings.Contains(request.URL.Path, "/projects/") {
					body = `{}`
					if hasScorecard {
						body = fmt.Sprintf(`{"scorecard":{"overallScore":%d}}`, score)
					}
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}, 1)
			provider.now = func() time.Time { return now }
			requests := []OpenSSFScoreRequest{{ID: "root", Module: "example.org/root", Version: "v1.0.0"}}
			read := func() OpenSSFScore { return provider.FetchOpenSSFScores(context.Background(), requests)["root"] }
			first := read()
			score, hasScorecard = 9, true
			now = now.Add(mutableLensCacheTTL - time.Nanosecond)
			if cached := read(); cached.Status != first.Status || calls != 2 {
				t.Fatalf("cache miss before expiry: %+v, calls=%d", cached, calls)
			}
			now = now.Add(time.Nanosecond)
			if refreshed := read(); refreshed.Status != openSSFStatusFound || refreshed.Score == nil || *refreshed.Score != 9 || calls != 4 {
				t.Fatalf("Scorecard did not refresh at expiry: %+v, calls=%d", refreshed, calls)
			}
		})
	}
}
