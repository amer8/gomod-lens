# Contributing

Thanks for taking the time to improve go.mod Lens.

## Development Setup

Development requires Go 1.26 or newer. Use Node.js 24 LTS for the test suite.
The application runs in the browser: Go/WASM resolves public module graphs,
and JavaScript renders the graph, sidebar and lenses. No npm install or
JavaScript build step is required.

Run the static application locally:

```bash
make serve
```

Open `http://localhost:4173`. `make run` is an alias for the same preview;
set `PORT` to use a different port. The preview server only serves files.
There is no application backend or HTTP API.

Run focused tests with repo-local Go cache directories:

```bash
make test
make test-js
make test-wasm
```

## Static Build

`make wasm` generates the complete, ignored `dist/` deployment from
`internal/app/web/index.html` and `internal/app/web/static/`, and compiles
`cmd/wasm`. The build replaces the asset tree so deleted assets disappear.
Edit canonical sources only; `make serve` rebuilds before serving them.

The WASM client returns graph fields (`rootId`, `nodes`, `edges`, `meta`,
`packageInfo`) plus `viewModel`, the sidebar summary groups.
`viewModel.lensGroups` maps lens IDs to distribution groups; the browser registry
owns lens names, descriptions and display order. Public data is fetched directly
from upstream APIs, which must support browser CORS access. License evidence
comes from deps.dev; the app does not inspect local source files.

## Adding Lenses

The [lens contributor guide](docs/development/lenses.md) maps existing lenses
to their source and tests, explains the browser contract, and covers Go graph
enrichment. To create a working browser lens with registration and tests:

```bash
make new-lens NAME=module-overview
make test-js
make serve
```

Edit browser lenses in `internal/app/web/static/analysis/`. Use Go graph
enrichment in `internal/staticresolver` when results belong in the initial
graph payload. Keep a new lens narrowly focused, give it a stable lowercase ID,
and document new upstream services in `PRIVACY.md` and `THIRD_PARTY_NOTICES.md`.

## Before Opening a Pull Request

Run the same checks used by CI:

```bash
make check
```

This includes Go formatting/module checks, WASM compilation, vet, Go tests,
the Node.js browser tests and Go WASM lifecycle tests running in Node.js.
`make test-js` and `make test-wasm` provide focused runs; still run `make check`
before opening a pull request. Module-resolution regressions use offline proxy
fixtures to compare the browser resolver's selected versions with `go list`.
Keep these Go reference tests even though the production app is static-only.

## Project Notes

- Keep changes focused and consistent with the existing small-Go-app structure.
- Version parsing and precedence use `internal/semver`; keep numeric comparisons independent of machine integer limits.
- Keep `dist/` out of version control; CI and the Pages workflow generate it with `make wasm`.
- The HTML shell is plain static HTML. Browser sources live under `internal/app/web/static/`.
- Include exact public module targets for bugs involving module resolution.
