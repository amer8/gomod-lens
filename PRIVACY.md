# Privacy and External Services

Last updated: May 17, 2026

go.mod Lens is intended for exploring public Go modules. Do not enter private
module paths, secret repository names, access tokens, or other non-public
identifiers into a public deployment.

This document describes the behavior of this project. A hosted instance may add
its own server logs, analytics, CDN, proxy, or platform-level data collection.

## Data Sent to External Services

### Go Module Mirror and Checksum Database

Remote module analysis shells out to the Go toolchain. For public module
requests, the server pins module resolution to `GOPROXY=https://proxy.golang.org`
and disables direct VCS fallback. The Go module mirror, and the Go checksum
database used by the Go toolchain, may receive requested public module paths and
versions as part of normal module resolution. The Release Freshness lens also
uses Go module mirror version-list and latest-version endpoints for modules in
the displayed graph.

See the Go modules services privacy policy:
<https://proxy.golang.org/privacy>

### deps.dev

go.mod Lens fetches OpenSSF Scorecard and related project metadata from the
deps.dev API for modules in the displayed graph. Requests include public module
paths, versions, and project identifiers derived from those modules.

deps.dev generated data is available under CC-BY 4.0, and use of the deps.dev
API is subject to the Google API Terms of Service:
<https://docs.deps.dev/api/v3/>

### GitHub Search

The module suggestion box uses the GitHub REST repository search API. Search
queries typed into the module search box may be sent to GitHub when suggestions
are requested.

See GitHub's API terms and search rate-limit documentation:
<https://docs.github.com/en/site-policy/github-terms/github-terms-of-service>
<https://docs.github.com/en/rest/search/search>

## Static Prototype

The experimental static build in `dist/` runs entirely in the browser. When it
is served, the visitor's browser fetches public module data and suggestions
directly from `proxy.golang.org`, `api.deps.dev`, and `api.github.com`. Those
requests are not proxied through a go.mod Lens server.

Pinned browser runtime scripts are served by the same origin as go.mod Lens;
the project code does not make third-party CDN requests for the app shell.

The static build also keeps a browser-local IndexedDB cache of public upstream
responses to speed up repeat graph loads. This cache is stored by the visitor's
browser for the site that serves the static app and can be cleared with normal
browser site-data controls.

## Caching and Rate Limits

The Go server keeps in-memory caches to reduce upstream traffic. By default,
graph responses are cached for 24 hours and module search results for 1 hour.
These defaults can be changed with the environment variables documented in
`README.md`. The static build's IndexedDB cache uses shorter TTLs for mutable
lookups such as `@latest`, module lists, GitHub suggestions, and deps.dev
metadata, and longer TTLs for immutable module artifacts.

The server also applies per-client and global rate limits before calling
upstream services. Defaults are intentionally conservative for public hosting.

## Cookies and Accounts

The project code does not implement user accounts, authentication, advertising
tracking, or application cookies.
