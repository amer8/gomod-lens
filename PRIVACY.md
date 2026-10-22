# Privacy and External Services

Last updated: October 21, 2026

go.mod Lens is intended for exploring public Go modules. Do not enter private
module paths, secret repository names, access tokens, or other non-public
identifiers into a public deployment.

This document describes the behavior of this project. A hosted instance may add
its own server logs, analytics, CDN, proxy, or platform-level data collection.

## Data Sent to External Services

### Go Module Mirror and Checksum Database

Remote module analysis shells out to the Go toolchain. For public module
requests, the server pins module resolution to `GOPROXY=https://proxy.golang.org`
and disables direct VCS fallback. The root module is downloaded without resolving
its dependencies first. Remote root modules are analyzed from a
disposable, writable copy of their module metadata. Filesystem replacements
are rejected before their dependency graph is loaded. Selected dependency
archives are then downloaded on a best-effort basis with the root's public
replacements applied for license detection. An unavailable source archive leaves
its license unknown; unavailable graph metadata still fails analysis. Downloaded
module cache files are not modified. The Go module mirror, and the Go checksum
database used by the Go toolchain, may receive requested public module paths and
versions as part of normal module resolution. The Release Freshness lens also
uses Go module mirror version-list and latest-version endpoints for modules in
the displayed graph. After a graph loads, the module version selector in both
the server UI and static UI requests the root module’s version list and latest
version directly from `proxy.golang.org` in the visitor’s browser. Successful
version lookups are kept in page memory for up to five minutes.

See the Go modules services privacy policy:
<https://proxy.golang.org/privacy>

### deps.dev

go.mod Lens fetches OpenSSF Scorecard and related project metadata from the
deps.dev API for modules in the displayed graph. Requests include public module
paths, versions, and project identifiers derived from those modules.

deps.dev generated data is available under CC-BY 4.0, and use of the deps.dev
API is subject to the Google API Terms of Service:
<https://docs.deps.dev/api/v3/>

When enabled in a build, Scorecard details and license evidence retrieve public
repository reports and exact-version license metadata directly from
`api.deps.dev` in the visitor’s browser when their lens is opened. Successful
responses are cached in page memory for five minutes; Refresh clears this cache.

### OSV advisory lookup

When the vulnerability exposure lens is enabled and opened, both the server UI
and static UI send public module names and exact resolved versions directly
from the visitor’s browser to `api.osv.dev`. Public replacement identities are
used when available. No source files are uploaded. Requests use at most four
concurrent lookups, a 20-second timeout, and a five-minute page-memory cache.
Failures remain unknown and Refresh retries the source.

OSV API documentation: <https://google.github.io/osv.dev/api/>

### GitHub Search

The module suggestion box uses the GitHub REST repository search API. Search
queries typed into the module search box may be sent to GitHub when suggestions
are requested.

See GitHub's API terms and search rate-limit documentation:
<https://docs.github.com/en/site-policy/github-terms/github-terms-of-service>
<https://docs.github.com/en/rest/search/search>

## Graph assistant and local AI

The graph assistant keeps its conversation in page memory, with no conversation
upload, account, or persistent chat history. Questions use the loaded graph and
may request the same public OSV/deps.dev evidence as the lenses above. Module
paths and resolved versions are sent to those services; chat text is not.

Chat requires a loaded local model. Opening the model chooser imports the
pinned WebLLM runtime from `cdn.jsdelivr.net` in a temporary worker to check
which models have browser-cached data; it does not load weights or allocate a GPU.
The user-facing chat does not run model tests. A separate developer evaluation
page can explicitly download and test the shortlist using fixed synthetic fixtures;
its reports stay in page memory until the developer downloads them and are not
uploaded to an external service.
Choosing **Load model** or **Switch model** loads model files from
`huggingface.co` and the model's GPU runtime from GitHub-hosted MLC artifacts.
Those hosts receive normal artifact requests, including connection metadata;
questions and graph context are processed locally in a Web Worker. The model
uses module evidence and the last two completed exchanges from the current
conversation to generate custom answers. Optional Qwen3 thinking runs in the same
worker; thinking blocks are discarded before streaming to the page and are not
added to conversation history. Suggested investigations use
allowlisted analysis queries. Source links and graph actions are produced by
the application; generated prose is displayed as text. Unsupported devices and failed model
loads leave chat unavailable; there is no model-free fallback. The initial
comparison table selects a model without downloading its weights. **Change model**
opens that table while retaining the active model. **Eject model** in the chooser
terminates the worker, preserving in-memory chat history
and the draft. Ejection does not delete downloaded files. The browser/runtime may
cache model files; clear browser site data to remove those files. This does not make evidence lookups
offline.

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

The Go server keeps in-memory caches to reduce upstream traffic. Latest-release
and Scorecard provider observations expire after five minutes, including
unavailable Scorecard results. Failed lookups are not cached. These provider
caches are separate from the graph response cache: their expiry does not
invalidate a graph response that is still cached. By default,
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
