# License evidence

Available in both the Go server Web UI and static WebAssembly build.

Select the **§** lens after loading a public module. Choose a graph node or module, search names or license expressions, and filter identifiers, non-standard results or unknowns. Each selected version shows its observed expressions, source link and timestamp. Highlight unknowns focuses gaps in the graph.

Try `github.com/gin-gonic/gin@v1.10.0`, then inspect different dependencies and filter `MIT`. Green means identifiers observed, amber means non-standard, gray means unknown. Multiple expressions retain their source wording and unspecified relationship. This is module metadata evidence, not file-level license coverage or a compatibility decision.

No uploads are required. Module/version changes reset the analysis, preserve the selected lens and cancel superseded lookups. Refresh retries public sources where applicable.

Validation: `node --test tests/*.test.mjs` and `make check`.
