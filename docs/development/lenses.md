# Implementing lenses

go.mod Lens has two extension layers. Choose the layer according to where the
result needs to be available, rather than implementing every analysis twice.

| Layer | Responsibility | Current implementations |
| --- | --- | --- |
| Go graph enrichment | Attach serializable results to the graph, including `/api/graph` | Scorecard summary and Release Freshness |
| Browser view | Present interactive analysis in both Web and WASM; optionally load additional public evidence | Scorecard details, Freshness queues, vulnerability groups, license inventory |

The graph model is defined in `internal/graph/model.go`. A browser view reads
this payload but keeps its own observations separately. Adding a view does not
automatically add that analysis to the HTTP API or Go model.

## Code map

Paths below are relative to the repository root.

| File/directory | Responsibility |
| --- | --- |
| `internal/graph/lens.go` | Go `Lens` interface and per-node result helpers |
| `internal/graph/analyzer.go` | Server graph enrichment registration |
| `internal/staticresolver/` | Equivalent graph enrichment for the WASM resolver |
| `internal/graphview/` | Go graph summary groups used by both deployments |
| `internal/app/web/static/analysis/registry.js` | Browser IDs, module keys, headings, toolbar labels, glyphs and imports |
| `internal/app/web/static/analysis/types.js` | JSDoc browser lens contract for editors |
| `internal/app/web/static/analysis/index.js` | Browser selection, loading, caching, cancellation and sidebar rendering |
| `internal/app/web/static/analysis/navigation.js` | URL handling using the registry |
| `internal/app/web/static/analysis/public-data.js` | Public JSON fetching, resolved identities and bounded module lookups |
| `internal/app/web/static/analysis/ui.js` | Shared DOM, tables, search, badges and disclosures |
| `internal/app/web/static/graph.js` | Graph rendering, built-in colors and browser color overrides |
| `dist/assets/analysis/` | Identical copies shipped by the static deployment |

## Browser contract

Each implementation exports a default object described by `BrowserLens` in
`types.js`. Registration metadata belongs only in `registry.js`.

| Property | Required | Meaning |
| --- | --- | --- |
| `scope` | Yes | Short description beneath the panel heading |
| `load(graph, context)` | Yes | Async data loading; return lens-specific data |
| `render(context)` | Yes | Synchronous DOM rendering into the supplied empty `host` |
| `selection` | No | Load/cache per selected node; also show the module picker |
| `modulePicker` | No | Show the picker while retaining one result for the whole graph |
| `colors(graph, data, selectedID)` | No | Return node-ID to CSS-color mappings |
| `status(data)` | No | Return a short source/status caption |

The load context supplies `node`, `signal` and `progress(done, total)`. Propagate
the signal into upstream requests. The render context supplies `host`, `graph`,
the currently selected `node`, `data`, `state`, and these callbacks:

- `select(nodeID)` selects a module and rerenders the active lens.
- `highlight({ids, nodesOnly, color})` highlights graph nodes. An empty `ids`
  array clears the explicit highlight. The graph renderer treats a single ID
  as a node selection.

The controller converts a thrown load error into `{error: message}`. Both
`render` and optional `status`/`colors` callbacks must handle that shape. A
module-level lookup failure should remain unknown, without discarding other
successful module results. An empty successful lookup is a separate outcome.

### Lifecycle and ownership

Modules are imported when the browser controller starts, so avoid DOM work or
network requests at import time. `load` runs only when its view opens. Results
are reused per graph, or per node with `selection: true`; selecting a module in
an inventory rerenders without fetching the whole inventory again.

`render` receives a cleared host and must recreate its DOM. Keep filters and
expanded sections in the supplied `state`, rather than retaining detached DOM.
State survives node and lens selection within a graph. New root modules or
versions clear state/results and abort previous requests; generation checks
prevent superseded completions from updating the new graph. Avoid global event
listeners inside `render`, since it runs repeatedly.

Refresh clears the shared public fetch cache and reloads the active result
(the current node for a selection-scoped view). Freshness has no browser fetch:
its Refresh rereads metadata already present in the graph. It does not trigger
a fresh Go module mirror lookup or bypass the graph response cache.

`publicJSON` provides a five-minute memory cache, 20-second request timeout and
credential-free requests. `mapModules` limits module lookups to four concurrent
tasks and records individual failures as unknown. `publicIdentity` resolves
public replacements and rejects missing/local replacement versions. Use these
helpers when applicable and preserve source URLs and observation times.

Views must not mutate the shared graph. Without a `colors` callback, the
renderer retains its built-in Scorecard/Freshness coloring. A new analysis
whose colors convey its own results should implement `colors`, including an
unknown color for unavailable data. Use `textContent`/the shared `element`
helper for upstream text and the shared HTTPS `link` helper for source links.

## Add a browser view

1. Create a module under `internal/app/web/static/analysis/`. Keep loading and
   normalization separate from DOM rendering so data behavior can be tested
   with Node.js and an injected fetcher.
2. Add one entry to `registry.js`. Its `id` is the stable lowercase URL/panel
   ID; `key` is the unique state key. Supply `title`, accessible toolbar `label`,
   `icon`, and an explicit `importModule` function. The controller and URL
   allowlist derive from this registry; no edits to `index.js` or
   `navigation.js` are needed for registration.
3. Style new view-specific content in `analysis.css`; reuse shared controls and
   respect the shared 400px sidebar, collapse control and mobile drawer. Toolbar
   color styling uses `.lens-circle-<id>`; the glyph comes from the registry.
4. Mirror every added/changed analysis file into `dist/assets/analysis/`.
   Mirror any changes to other shared assets too, for example `main.css` into
   `dist/assets/main.css`. These are maintained source assets; the WASM build
   does not synchronize them. Parity tests detect drift in the analysis files.
5. Document upstream requests in `PRIVACY.md` and `THIRD_PARTY_NOTICES.md`, add
   a feature description/reproduction target, and add relevant data tests.
6. Run `make check`, then exercise the view in both deployments with a real
   public module, including an unavailable result and a module/version change.

A minimal view with no upstream requests:

```js
// internal/app/web/static/analysis/example.js
import { notice } from './ui.js'

/** @type {import('./types.js').BrowserLens<{moduleCount: number}>} */
const lens = {
  scope: 'Modules in the loaded graph',
  async load(graph, { signal }) {
    signal.throwIfAborted()
    return { moduleCount: graph.nodes.length }
  },
  render({ host, data }) {
    if ('error' in data) {
      host.append(notice(data.error, 'analysis-empty'))
      return
    }
    host.append(notice(data.moduleCount + ' modules in this graph.'))
  },
}

export default lens
```

Register it by appending to `browserLenses`:

```js
{
  id: 'example', key: 'example', title: 'Module overview',
  label: 'Module overview', icon: '≡',
  importModule: () => import('./example.js'),
},
```

Then open `?lens=example#target=github.com%2Fgoogle%2Fuuid%40v1.6.0` in either
deployment. The example deliberately adds only a browser view; graph colors
retain their existing fallback behavior.

## Add Go graph enrichment

Implement `graph.Lens` (`Definition()` and `Analyze(ctx, graph)`) and attach
per-node `graph.LensResult` values through `Node.SetLensResult`. Register the
server implementation in `graph.NewAnalyzer`; `SetLenses` also supports custom
analyzer configurations and tests. Return stable statuses and retain lookup
failures as unknown/error outcomes rather than inventing successful results.

For equivalent WASM graph data, add an enrichment path to
`internal/staticresolver` and invoke it from `Resolver.ResolveGraph`. It uses
browser-provided fetching instead of server HTTP clients or the Go toolchain.
Check both deployment payloads for equivalent definitions and statuses.

A Go lens can exist without a dedicated browser view. To expose interactive
controls, register a browser view that reads its `node.lenses[id]` results.
For new summary groups, extend `internal/graphview` as needed. Reuse the same
stable ID when the view represents the same analysis. Scorecard illustrates a
Go summary plus extra browser evidence; Freshness illustrates a browser view
that only reads graph results.

## Validation

Go 1.26+ and Node.js 22+ are required. No npm install is needed.

```sh
make test-js   # Registry contract, data logic, URL behavior and asset parity
make check     # Also Go formatting/modules, WASM build, vet and Go tests
make run       # Web UI: http://localhost:8080
make serve     # WASM UI: http://localhost:4173 (after make wasm/check)
```

CI runs both Go and browser tests. The registry test imports every registered
implementation without a browser and checks its required hooks and metadata.
These tests do not type-check JSDoc or replace visual/manual browser checks.
Use the [feature reproduction steps](../features/analysis-views.md) to check
selection, filters, unknown data, graph colors and responsive layout.
