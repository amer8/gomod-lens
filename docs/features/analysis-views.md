# Browser analysis views

The Go web UI and static WebAssembly UI share four analysis lenses:

| Lens query | Design | Interaction |
| --- | --- | --- |
| `openssf` (default) | Repository on graph | Select a module and inspect its repository checks beside the graph. |
| `release-freshness` | Update queues | Start with all modules. Select a release gap to filter and highlight matching graph nodes; click it again to show all modules. |
| `vulnerabilities` | Result groups | Expand matched, no-match and unknown groups; select a module to inspect advisories. |
| `licenses` | Evidence inventory | Filter the module table and inspect exact-version source expressions. |

Select a lens with the centered toolbar, or link to it directly:

```text
http://localhost:8080/?lens=vulnerabilities#target=github.com%2Fgin-gonic%2Fgin%40v1.10.0
http://localhost:4173/?lens=licenses#target=github.com%2Fgin-gonic%2Fgin%40v1.10.0
```

There is no layout selector. Legacy comparison URLs discard `v`; unsupported
or removed lens IDs fall back to Scorecard while preserving the module target.

Run `make run` for the Go web UI, or `make wasm` followed by `make serve` for the
static version. Both deployments ship identical analysis modules and styling.
The Scorecard inspector collapses with its summary. On smaller screens it moves
into the sidebar drawer, before the overview. The existing Expand panel button
provides more room. The sidebar remains collapsible, with the default-collapsed
gopher at the bottom right.

## Reproduction

Load `github.com/gin-gonic/gin@v1.10.0`. Verify repository check search, release
queue counts/highlights, grouped advisory results and the license table. Select
`gopkg.in/yaml.v3@v3.0.1` in the license view to inspect multiple source
expressions with an unspecified relationship. Change the root module version
and confirm the selected lens remains active while old evidence is cleared.

Load `github.com/google/uuid@v1.5.0` to exercise a small graph and empty advisory
groups. Upstream data changes over time; counts are observations rather than
fixed assertions.

Scope remains explicit: Scorecard assesses repository snapshots; OSV matches
module versions without assessing function reachability or exploitability;
license metadata does not establish compatibility or file-level completeness.

Validate with `make check`, which includes the browser tests. Use `make test-js`
for a focused run. For implementation and extension instructions, see the
[lens developer guide](../development/lenses.md).
