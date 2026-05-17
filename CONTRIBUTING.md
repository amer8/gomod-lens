# Contributing

Thanks for taking the time to improve go.mod Lens.

## Development Setup

You need Go 1.26 or newer. The server-rendered UI uses Go's standard
`html/template` package.

Run the app locally:

```bash
make run
```

The public web UI and HTTP API accept remote module targets only.

Run tests with repo-local cache directories:

```bash
make test
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

Lenses are Go implementations of the `graph.Lens` interface. A lens receives an
already-built module graph and attaches results to nodes with
`Node.SetLensResult`. Built-in lenses are registered by `graph.NewAnalyzer`; the
OpenSSF Scorecard and Release Freshness lenses are the first examples.

Keep a new lens narrowly focused, give it a stable lowercase ID, and document
any upstream services it calls in `PRIVACY.md` and `THIRD_PARTY_NOTICES.md`.
If a lens is useful in the static WebAssembly build, add the corresponding
browser resolver path under `internal/staticresolver` too.

## Before Opening a Pull Request

Please run the same checks used by CI:

```bash
make check
```

## Project Notes

- Keep changes focused and consistent with the existing small-Go-app structure.
- Do not commit generated static assets such as `dist/assets/gomod-lens.wasm`, `dist/assets/wasm_exec.js`, or `dist/assets/vendor/`; CI and the Pages workflow build them.
- The browser UI intentionally avoids an npm build step. Server assets live under `internal/app/web/static`; the GitHub Pages prototype uses `dist/` plus the Go WASM build.
- Remote module analysis shells out to the Go toolchain, so include clear reproduction targets for bugs involving module resolution.
