# Third-Party Notices

This repository does not vendor Go module caches; those paths are ignored by
Git. Pinned browser runtime files are vendored under
`internal/app/web/static/vendor`; the GitHub Pages build copies them into
`dist/assets/vendor`.

## Go Dependencies

This module currently has no third-party Go dependencies.

## Browser Runtime Dependencies

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `ngraph.graph` | `20.1.1` | BSD-3-Clause | Self-hosted for graph data structures |
| `ngraph.forcelayout` | `3.3.1` | BSD-3-Clause | Self-hosted for force-directed graph layout |
| `ngraph.svg` | `0.11.0` | MIT | Self-hosted for graph rendering |
| `ngraph.events` | `1.4.0`, `1.2.2` | BSD-3-Clause | Transitive event helpers for `ngraph.graph` and `ngraph.forcelayout` |
| `ngraph.merge` | `1.0.0` | MIT | Transitive option-merge helper for `ngraph.forcelayout` |
| `ngraph.random` | `1.1.0` | BSD-3-Clause | Transitive random-number helper for `ngraph.forcelayout` |
| `rbush` | `3.0.1` | MIT | Transitive spatial index used by `ngraph.svg` |
| `quickselect` | `2.0.0` | ISC | Transitive selection helper used by `rbush` |
| Go WebAssembly runtime (`wasm_exec.js`) | Go toolchain version from `go.mod`/CI | BSD-style Go license | Copied into the GitHub Pages artifact to bootstrap the static WASM resolver |

Full upstream notices for vendored browser runtime files are copied into
`internal/app/web/static/vendor/LICENSES.txt`. The Pages artifact receives a
generated copy at `dist/assets/vendor/LICENSES.txt`.

## Graph assistant local AI

| Component | Version | License | Use |
| --- | --- | --- | --- |
| [WebLLM](https://github.com/mlc-ai/web-llm) | `0.2.86` | Apache-2.0 | Imported from jsDelivr when opening the model chooser to inspect cache state; interprets suggested investigations and generates custom answers locally in a Web Worker |
| [WebLLM model catalog](https://github.com/mlc-ai/web-llm/blob/v0.2.86/src/config.ts) | `0.2.86` selected language-model variants | Catalog configuration: Apache-2.0; individual weights have their respective upstream licenses | Metadata snapshot in `assistant/model-catalog.js`; weights load only on explicit selection. Each choice links its upstream model card and license |

The recommended default is [Qwen2.5-1.5B-Instruct](https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f32_1-MLC)
(Apache-2.0). Other selected weights include models under Llama community license terms
and Microsoft Phi under MIT. See the selected model card for its applicable notices.
On-demand runtime/model files are not vendored in this repository. Their upstream
distributions retain their respective license notices. Model download-size metadata
comes from public Hugging Face file listings. See the
[model catalog maintenance instructions](docs/features/graph-assistant.md#loading-webllm)
when updating the committed snapshot.

## Artwork

| Asset | License | Use |
| --- | --- | --- |
| [63.svg](https://github.com/MariaLetta/free-gophers-pack/blob/master/characters/svg/63.svg) from [MariaLetta/free-gophers-pack](https://github.com/MariaLetta/free-gophers-pack) | CC0 1.0 Universal | Mascot artwork vendored at `docs/assets/gopher-63.svg`, served in the app from `internal/app/web/static/gopher-63.svg`, and included in `dist/assets/gopher-63.svg` |

## External Data Services

| Service | Use | Terms or License Notes |
| --- | --- | --- |
| [Go module mirror](https://proxy.golang.org/) | Resolves public module versions, `go.mod` files, and release freshness metadata | Subject to the Go module services privacy policy |
| [deps.dev](https://deps.dev/) | Provides OpenSSF Scorecard, project metadata, and exact-version license expressions | deps.dev generated data is available under CC-BY 4.0; API use is subject to the Google API Terms of Service |
| [OSV](https://osv.dev/) | Matches exact public Go module versions to advisory records when the vulnerability lens is enabled | Advisory content comes from the original databases; preserve IDs and source links. [API documentation](https://google.github.io/osv.dev/api/) |
| [GitHub REST Search](https://docs.github.com/en/rest/search/search) | Provides module search suggestions | Subject to GitHub API terms and rate limits |

## Marks

The UI includes a GitHub mark solely as a link to this project's GitHub
repository. GitHub and the GitHub mark are trademarks of GitHub, Inc.; use of
the mark does not imply endorsement.

## Inspiration

go.mod Lens is inspired by the package graph experience of npmgraph. The app
code, CSS, and JavaScript in this repository were generated for this project;
no npmgraph source code is intentionally included.

When updating vendored third-party source files, minified browser assets, or
binaries, preserve the corresponding upstream license notices with those
artifacts.
