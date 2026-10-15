# Contributing

Thanks for taking the time to improve go.mod Lens.

## Development Setup

You need Go 1.26 or newer and Node.js 22 or newer for browser tests. The
server-rendered UI uses Go's standard `html/template` package. No npm install
or JavaScript build step is required.

Run the app locally:

```bash
make run
```

The public web UI and HTTP API accept remote module targets only.

Run tests with repo-local cache directories:

```bash
make test
make test-js
```

## Static Build

```bash
make wasm
make serve
```

Open `http://localhost:4173`.

`make wasm` writes generated artifacts to `dist/assets/`.

## API

```text
GET /api/graph?target=golang.org/x/tools@latest
GET /api/modules/search?q=golang
GET /api/health
```

`/api/graph` is intentionally limited to public remote module targets such as
`golang.org/x/tools@latest`. The underlying graph analyzer still has local-module
support for internal use and tests, but the HTTP API always runs remote module
analysis and rejects local filesystem paths so a hosted deployment cannot be
used to inspect server files or private workspace state.

## Adding Lenses

There are two extension layers:

- **Graph enrichment (Go):** `graph.Lens` implementations attach per-node
  results with `Node.SetLensResult`. `graph.NewAnalyzer` registers the server's
  built-in Scorecard and Freshness implementations. The WASM resolver has
  corresponding enrichment paths under `internal/staticresolver`.
- **Browser views (JavaScript):** the four interactive lenses share the
  interface in `internal/app/web/static/analysis/types.js` and are registered in
  `analysis/registry.js`. Scorecard details, vulnerability matches and license
  evidence fetch additional data in the browser; Freshness reads the graph.
  Browser-only results are not added to `/api/graph` responses.

Follow the [lens architecture and contributor walkthrough](docs/development/lenses.md)
for the contract, a minimal browser lens, registration, Web/WASM asset mirroring,
and testing. Adding a browser-only view does not require a Go lens. A Go lens
that needs an interactive browser view also needs a browser registration.

Keep a new lens narrowly focused, give it a stable lowercase ID, and document
any upstream services it calls in `PRIVACY.md` and `THIRD_PARTY_NOTICES.md`.

## Before Opening a Pull Request

Please run the same checks used by CI:

```bash
make check
```

This includes Go formatting/module checks, WASM compilation, vet, Go tests and
the Node.js browser tests. For a browser-only change, `make test-js` provides a
fast check; still run `make check` before opening a pull request.

## Project Notes

- Keep changes focused and consistent with the existing small-Go-app structure.
- Do not commit generated static assets such as `dist/assets/gomod-lens.wasm`, `dist/assets/wasm_exec.js`, or `dist/assets/vendor/`; CI and the Pages workflow build them.
- The browser UI intentionally avoids an npm build step. Server assets live under `internal/app/web/static`; the GitHub Pages prototype uses `dist/` plus the Go WASM build.
- Remote module analysis shells out to the Go toolchain, so include clear reproduction targets for bugs involving module resolution.
