# Scorecard details

Available in both the Go server Web UI and static WebAssembly build. Select the
existing Scorecard lens, then choose a graph node or use **Module to inspect**.
The sidebar contains the summary followed by **Repository checks**. Search checks,
filter unavailable or low scores, and expand a check for its explanation, evidence
and documentation. All details use the sidebar’s scroll area on desktop and mobile. The footer identifies the assessed
repository commit, capture date and Scorecard engine version.

Try `github.com/google/uuid@v1.6.0`. Changing the version preserves the lens;
repository reports describe their own snapshot, not necessarily that release.
Missing project mappings or unavailable checks stay unknown. Refresh retries
public reports and clears the five-minute page cache.

Validation: `node --test tests/*.test.mjs` and `make check`.
