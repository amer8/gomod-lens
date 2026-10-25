<p align="center">
  <img src="docs/assets/gopher-63.svg" width="180" alt="go.mod Lens gopher mascot">
</p>

`gomod-lens` explores public Go module dependency graphs in a browser. It runs as a static WebAssembly application and analyzes modules
through five browser lenses: OpenSSF Scorecard, Release Freshness,
Vulnerability exposure, License evidence and Go requirements.

Deployed to GitHub Pages: https://amer8.github.io/gomod-lens/

After a public module loads, the version selector shows the loaded version,
marks the latest version reported by the Go module proxy, and lets you switch
to older published versions. The search field keeps the module path; Analyze
preserves the selected version for that module. Explicit `module@version`
input and shared URLs still work.

## Lenses

OpenSSF Scorecard highlights repository security practices. Release Freshness
shows whether selected versions are current, patch/minor/major behind,
pre-release, pseudo-version, or unknown. Vulnerability exposure matches exact
module versions against OSV advisories. License evidence displays expressions
observed by deps.dev for exact module versions. Go requirements reads each
exact version's `go.mod`, groups declared minimum Go versions, and compares
them with a chosen target toolchain. Older minimums are compatibility baselines,
not maintenance or security scores. See the
[Go requirements guide](docs/features/go-requirements.md).

Go graph enrichment supplies Scorecard summaries and release freshness in the
graph payload. The browser adds Scorecard check details, vulnerability matches,
license evidence and Go requirements when those views are opened. These browser
observations stay in browser memory rather than the initial graph payload.

The **Graph assistant** adds a collapsible chat dock with three contextual
starter questions and three follow-ups after each answer. It connects answers
to module selections, graph highlights, and source evidence. Chat requires
WebLLM and a loaded model. A searchable, sortable comparison table offers ten curated browser-friendly models with download and memory estimates. Supported models think automatically; switch the
loaded model while retaining chat history. Custom questions receive streamed answers using
module evidence and conversation context, including source repository links. See [the assistant guide](docs/features/graph-assistant.md) for its
scope, model download, privacy, and reproduction steps.

## Scorecard details

The Scorecard lens shows the selected module’s source repository report with
individual check scores, explanations, evidence, assessed commit, date and
Scorecard version. Choose a graph node or the module selector to inspect it.
Filter checks by name or availability and expand a check for remediation links.
Unknown checks remain unknown. Reports describe a repository snapshot and may
postdate the selected module release.

## Development

To change or add a lens, start with the
[lens contributor guide](docs/development/lenses.md) and its
`make new-lens NAME=module-overview` starter. See the
[analysis views](docs/features/analysis-views.md) for UI reproduction steps.

Run `make help` for the full target list.

Development requires Go 1.26+ and Node.js 22+ for tests, without an npm build.
`make check` builds the static deployment and runs Go/WASM and browser tests.

The browser resolves graphs and sidebar summaries with Go/WASM, fetching public
data directly from upstream APIs. There is no application backend or HTTP API.
`dist/` is generated and ignored; edit the page shell in
`internal/app/web/index.html` and browser sources in `internal/app/web/static/`,
then rebuild with `make wasm` or preview with `make serve` (port 4173).
`make run` is an alias for the same static preview. Existing HTTP API consumers
must migrate; `/api/graph`, `/api/modules/search` and `/api/health` are removed.

Graph rendering uses native Canvas for small graphs and WebGPU for graphs with
at least 500 modules or 2,000 edges, with automatic Canvas fallback when a GPU
is unavailable or lost. The CPU force layout still uses `ngraph.forcelayout`;
graph storage and rendering have no ngraph dependency. See the
[renderer verification and benchmark guide](docs/development/graph-rendering.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for development notes.

## Privacy

Treat go.mod Lens as a public-module explorer. Do not submit private module
paths, repository names, tokens, or other secrets to a public deployment.
External service behavior is summarized in [PRIVACY.md](PRIVACY.md).

## Credits

Mascot artwork uses
[63.svg](https://github.com/MariaLetta/free-gophers-pack/blob/master/characters/svg/63.svg)
from [MariaLetta/free-gophers-pack](https://github.com/MariaLetta/free-gophers-pack),
licensed under CC0 1.0 Universal.

## License

go.mod Lens is released under the MIT License. See [LICENSE](LICENSE).

Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
