# Go requirements

Select **Go requirements** (`Go`) after loading a public module, or open:

```text
http://localhost:8080/?lens=go-requirements#target=github.com%2Fspf13%2Fcobra%40v1.10.2
http://localhost:4173/?lens=go-requirements#target=github.com%2Fspf13%2Fcobra%40v1.10.2
```

The lens reads each resolved version's `go.mod` from the Go module mirror.
Public replacements use their resolved identities; local replacements and
unavailable metadata remain unknown. Results stay in the browser.

## Interpretation

A `go` directive is a declared minimum Go version and language baseline. A
module declaring `go 1.20` can use a current toolchain; an old minimum alone
does not indicate poor maintenance or security. The lens does not report the
compiler used to build an application or upstream Go support status.

Open **Compare toolchain** to check a target. It starts at the root's declared
minimum, or the highest observed minimum if unavailable. Enter your toolchain
and choose **Compare**. A release family such as `1.26` is interpreted as the
`.0` toolchain; full patch versions and beta/RC versions are supported.

The overview shows the four highest observed release families, combines earlier
minimums into one group, and lists unknowns separately. For example, `1.24`,
`1.24.0` and `1.24.3` share the Go 1.24 group and color. Graph colors match the
group and module-table swatches. Gray means unknown metadata. After comparing,
modules exceeding the target show **Requires newer** in amber. Changing the
target preserves the version colors.

Comparisons follow Go version ordering. A valid module file without a `go`
directive has an implicit minimum of 1.16. Dependency `toolchain` directives
are not consumer requirements and are ignored.

The highest observed minimum includes the root and is a lower bound while any
module metadata is unknown. Meeting every observed minimum does not guarantee
a successful build; source compatibility and other build constraints also apply.

See the official [Go toolchain rules](https://go.dev/doc/toolchain) and
[Go directive reference](https://go.dev/ref/mod#go-mod-file-go).

## Explore the graph

Choose a version group to filter the table and highlight its nodes. Click
**Highest observed** to focus the highest minimum. **All**, **Show all**, or
clicking the active group again clears the filter and group highlight. Exact minimums
remain searchable, and comparisons retain patch and prerelease precision.
Comparison status filters appear after using **Compare**.

Select a module in the table or graph to open **Module details**, including its
source and expandable **Dependency path**. Path highlighting lives there;
**Highlight newer requirements** lives in the toolchain comparison. Explanations
and provenance are under **About this data**.

Changing the target recomputes the comparison locally without
new requests. The target and filters survive module/lens selection; a new root
or version resets them. Refresh retries metadata requests. See
[PRIVACY.md](../../PRIVACY.md) for external request details.

## Reproduction and checks

1. Load either example URL above. The default view shows version groups and
   the module table. Open **Module details** to inspect the exact-version source.
2. Open **Compare toolchain** and compare `1.16.0` with `1.27.3`. Results should change
   without refetching metadata or changing version colors. Try a malformed
   input; it must not apply.
3. Click **Highest observed**, choose a dependency, and expand its dependency
   path. Switch to another lens and back; the chosen target remains.
4. Select another root version; the target resets and the inventory reloads.
   Check the target form and table on a narrow screen in both deployments.

```sh
node --test tests/go-requirements.test.mjs tests/analysis-public-data.test.mjs
make check
```
