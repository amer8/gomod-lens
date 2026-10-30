# Privacy and External Services

Last updated: October 26, 2026

go.mod Lens is intended for exploring public Go modules. Do not enter private
module paths, secret repository names, access tokens, or other non-public
identifiers into a public deployment.

This document describes the behavior of this project. Static hosting may add
its own access logs, CDN, or platform-level data collection.
The app links this document as `privacy.html`; it is available before a module
is submitted or a model is loaded.

Each upstream service receives the requested public identifiers and normal
connection information, including the visitor's IP address and browser-supplied
request headers. Connections go directly from the visitor's browser to those
services. Their privacy policies govern their handling of those requests.

## Data Sent to External Services

### Go Module Mirror

The browser resolves public module graphs by fetching module versions and
`go.mod` files directly from `proxy.golang.org` through Go/WASM. It does not
run Go commands, download source archives for license detection, or contact
the Go checksum database. The module mirror receives requested public module
paths and versions. Filesystem replacements are not followed.

The Release Freshness lens uses module version-list and latest-version
endpoints for modules in the graph. The version selector also requests the
root module's version list and latest version directly from the browser.
Successful version-selector lookups are kept in page memory for five minutes.

Opening the Go requirements lens reuses exact-version metadata already parsed
during graph resolution. Missing observations send public resolved module paths
and exact versions to `proxy.golang.org` through Go/WASM to read `.mod` files.
Public replacements use their resolved identities; local replacements and
missing versions are not sent. Requests omit credentials. Supplemental metadata
is kept in page memory for the current graph and can reuse the IndexedDB cache.
Refresh requests every public version again, bypassing those cached observations
and IndexedDB responses. The chosen target toolchain is compared locally and is
not sent to that service.

See the Go modules services privacy policy:
<https://proxy.golang.org/privacy>

### deps.dev

go.mod Lens fetches OpenSSF Scorecard and related project metadata from the
deps.dev API for modules in the displayed graph. Requests include public module
paths, versions, and project identifiers derived from those modules.

deps.dev-generated data is available under CC-BY 4.0. Aggregated Scorecard data
retains its CDLA-Permissive-2.0 license. Use of the deps.dev API is subject to
the [Google API Terms of Service](https://developers.google.com/terms).
See the [API and data documentation](https://docs.deps.dev/api/v3/).

Scorecard details and license evidence retrieve public
repository reports and exact-version license metadata directly from
`api.deps.dev` in the visitor’s browser when their lens is opened. Successful
responses are cached in page memory for five minutes; Refresh clears this cache.

### OSV advisory lookup

When the vulnerability exposure lens is enabled and opened, the browser sends
public module names and exact resolved versions directly to `api.osv.dev`.
Public replacement identities are
used when available. No source files are uploaded. Requests use at most four
concurrent lookups, a 20-second timeout, and a five-minute page-memory cache.
Failures remain unknown and Refresh retries the source.

OSV API documentation: <https://google.github.io/osv.dev/api/>
Advisories retain their original database licenses:
[OSV data sources](https://google.github.io/osv.dev/data/).

### GitHub Search

The module suggestion box uses the GitHub REST repository search API. Search
queries typed into the module search box may be sent to GitHub when suggestions
are requested.

See GitHub's API terms and search rate-limit documentation:
<https://docs.github.com/en/site-policy/github-terms/github-terms-of-service>
<https://docs.github.com/en/rest/search/search>

Use the public lookup services in accordance with the terms linked above,
including their applicable usage limits. The app's own MIT license does not
replace the services' terms or the licenses on their data.

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
The model chooser provides each model's license and any acceptable use policy
before loading it. Llama-based choices and active chat display their required
attribution. Full license texts are in [Licenses and notices](THIRD_PARTY_NOTICES.md).

## Static Deployment

The static build in `dist/` runs entirely in the browser. When it
is served, the visitor's browser fetches public module data and suggestions
directly from `proxy.golang.org`, `api.deps.dev`, and `api.github.com`. Those
requests go directly to upstream services; the app has no HTTP API or backend.

Pinned browser runtime scripts are served by the same origin as go.mod Lens;
the project code does not make third-party CDN requests for the app shell.

The static build also keeps a browser-local IndexedDB cache of public upstream
responses to speed up repeat graph loads. This cache is stored by the visitor's
browser for the site that serves the static app and can be cleared with normal
browser site-data controls.

## Caching and Rate Limits

The browser keeps an IndexedDB cache of public upstream responses, with
shorter TTLs for mutable lookups such as `@latest`, module lists, GitHub
suggestions and deps.dev metadata, and longer TTLs for immutable module
artifacts. Lens evidence uses a separate five-minute page-memory cache;
Refresh clears that evidence cache. Go requirements keeps parsed observations
per graph; its Refresh bypasses both those observations and IndexedDB responses.
The app removes expired IndexedDB entries on cache opening and periodically
after writes. It also aims to retain at most 2,000 responses, evicting those
with the earliest expiration first; the count can temporarily exceed that limit
between cleanup runs. If storage is full, it evicts a batch and retries a cache
write once. Browser site-data controls clear persisted responses.

Request concurrency is bounded by the browser resolver and evidence loaders.
There are no application-server caches or per-client/global server rate limits.
Upstream services apply their own limits to browser requests.

## Cookies and Accounts

The project code does not implement user accounts, authentication, advertising
tracking, or application cookies.
