# Contributing

Thanks for taking the time to improve go.mod Lens.

## Development Setup

You need Go 1.26 or newer and Node.js 22 or newer for browser tests. The
page shell uses Go's standard `html/template` package; shared JavaScript renders
the graph and sidebar from JSON. No npm install
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

`make wasm` generates the complete, ignored `dist/` deployment from the shared
Go page template and `internal/app/web/static/`. Both deployments use one browser
controller, with small HTTP and WASM clients. Edit canonical sources only;
`make serve` rebuilds the static deployment before serving it.

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

`/api/graph` returns the graph fields (`rootId`, `nodes`, `edges`, `meta`,
`packageInfo`) plus `viewModel`, the sidebar groups shared with the WASM build.
`viewModel.lensGroups` maps lens IDs to distribution groups; the browser registry
owns lens names, descriptions and display order.

## Adding Lenses

The [lens contributor guide](docs/development/lenses.md) maps existing lenses
to their source and tests, explains the browser contract, and covers Go graph
enrichment. To create a working browser lens with registration and tests:

```bash
make new-lens NAME=module-overview
make test-js
make run
```

Edit browser lenses in `internal/app/web/static/analysis/`, then run
`make wasm` to rebuild the static deployment. Use Go graph
enrichment when results also need to appear in `/api/graph`.

Keep a new lens narrowly focused, give it a stable lowercase ID, and document
any new upstream services in `PRIVACY.md` and `THIRD_PARTY_NOTICES.md`.

## Before Opening a Pull Request

Please run the same checks used by CI:

```bash
make check
```

This includes Go formatting/module checks, WASM compilation, vet, Go tests,
the Node.js browser tests and Go WASM lifecycle tests running in Node.js.
`make test-js` and `make test-wasm` provide focused runs; still run `make check`
before opening a pull request. Module-resolution regressions use offline proxy
fixtures to compare the browser resolver's selected versions with the Go toolchain.

## Project Notes

- Keep changes focused and consistent with the existing small-Go-app structure.
- Server and WASM version parsing and precedence share `internal/semver`; keep numeric comparisons independent of machine integer limits.
- Keep `dist/` out of version control; CI and the Pages workflow generate it with `make wasm`.
- The browser UI intentionally avoids an npm build step. All browser sources live under `internal/app/web/static`; both page shells use the Go template.
- Remote module analysis shells out to the Go toolchain, so include clear reproduction targets for bugs involving module resolution.
