# Third-Party Notices

This repository does not vendor Go module caches; those paths are ignored by
Git. Pinned browser runtime files are vendored under
`internal/app/web/static/vendor`; the GitHub Pages build copies them into
`dist/assets/vendor`.

The static build publishes this document as `notices.html` and the privacy
document as `privacy.html`. License texts below are included in
`dist/assets/licenses`; the app links these notices from its project information.
The app's own code is [MIT licensed](LICENSE). Third-party code, data and model
weights retain their respective licenses.

## Included license texts

| Material | Full license text |
| --- | --- |
| Go runtime and standard library | [Go BSD license](internal/app/web/static/licenses/Go.txt) |
| Go module parser (`golang.org/x/mod`) | [BSD-3-Clause](internal/app/web/static/licenses/golang-x-mod.txt) |
| WebLLM and the selected catalog configuration | [Apache-2.0](internal/app/web/static/licenses/Apache-2.0.txt) |
| OpenSSF Scorecard report data | [CDLA-Permissive-2.0](internal/app/web/static/licenses/CDLA-Permissive-2.0.txt) |
| deps.dev-generated data, Go and GitHub advisory records | [CC-BY-4.0](internal/app/web/static/licenses/CC-BY-4.0.txt) |
| Llama 3.1 and Hermes 3 Llama 3.1 | [Llama 3.1 Community License](internal/app/web/static/licenses/Llama-3.1.txt), [attribution notice](internal/app/web/static/licenses/Llama-3.1-NOTICE.txt), [acceptable use policy](internal/app/web/static/licenses/Llama-3.1-USE-POLICY.txt) |
| Hermes 3 publisher-declared license | [Meta Llama 3 Community License](internal/app/web/static/licenses/Llama-3.txt), [attribution notice](internal/app/web/static/licenses/Llama-3-NOTICE.txt), [acceptable use policy](internal/app/web/static/licenses/Llama-3-USE-POLICY.txt) |
| Llama 3.2 | [Llama 3.2 Community License](internal/app/web/static/licenses/Llama-3.2.txt), [attribution notice](internal/app/web/static/licenses/Llama-3.2-NOTICE.txt), [acceptable use policy](internal/app/web/static/licenses/Llama-3.2-USE-POLICY.txt) |
| Phi-4-mini | [Microsoft MIT license](internal/app/web/static/licenses/Phi-4-mini-MIT.txt) |
| ngraph browser libraries | [Copyright and license notices](internal/app/web/static/vendor/LICENSES.txt) |

The build copies the Go license from the same toolchain that supplies
`wasm_exec.js` and compiles the WASM binary, replacing the reference text in
the deployment with that toolchain's exact license.

The license texts are reproduced from the [WebLLM v0.2.86 license](https://github.com/mlc-ai/web-llm/blob/v0.2.86/LICENSE),
[CDLA release](https://github.com/Community-Data-License-Agreements/Releases/blob/main/CDLA-Permissive-2.0.txt),
[Go vulnerability database license](https://github.com/golang/vulndb/blob/master/LICENSE),
[Meta's Llama 3.1 materials](https://github.com/meta-llama/llama-models/tree/main/models/llama3_1),
[Meta's Llama 3 materials](https://github.com/meta-llama/llama-models/tree/main/models/llama3),
[Meta's Llama 3.2 materials](https://github.com/meta-llama/llama-models/tree/main/models/llama3_2),
and [Phi-4-mini license](https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/main/LICENSE).

## Go Dependencies

| Module | Version | License | Use |
| --- | --- | --- | --- |
| [golang.org/x/mod](https://pkg.go.dev/golang.org/x/mod) | `v0.37.0` | BSD-3-Clause | Shared `go.mod` parsing for dependency resolution and Go requirements in WASM |

## Browser Runtime Dependencies

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `ngraph.forcelayout` | `3.3.1` | BSD-3-Clause | Self-hosted for force-directed graph layout |
| `ngraph.events` | `1.2.2` | BSD-3-Clause | Transitive event helper for `ngraph.forcelayout` |
| `ngraph.merge` | `1.0.0` | MIT | Transitive option-merge helper for `ngraph.forcelayout` |
| `ngraph.random` | `1.1.0` | BSD-3-Clause | Transitive random-number helper for `ngraph.forcelayout` |
| Go WebAssembly runtime (`wasm_exec.js`) | Go toolchain version from `go.mod`/CI | BSD-style Go license | Copied into the GitHub Pages artifact to bootstrap the static WASM resolver |

Full upstream notices for vendored browser runtime files are copied into
`internal/app/web/static/vendor/LICENSES.txt`. The Pages artifact receives a
generated copy at `dist/assets/vendor/LICENSES.txt`.
Go's copyright notice, conditions and disclaimer are included separately in
`dist/assets/licenses/Go.txt`.

The app's graph storage, WebGPU renderer, Canvas fallback, labels, and
interaction code use native browser APIs. The development renderer benchmark
uses these same runtime files and adds no graph dependencies.

## Graph assistant local AI

| Component | Version | License | Use |
| --- | --- | --- | --- |
| [WebLLM](https://github.com/mlc-ai/web-llm) | `0.2.86` | Apache-2.0 | Imported from jsDelivr when opening the model chooser to inspect cache state; interprets suggested investigations and generates custom answers locally in a Web Worker |
| [WebLLM model catalog](https://github.com/mlc-ai/web-llm/blob/v0.2.86/src/config.ts) | `0.2.86` selected language-model variants | Catalog configuration: Apache-2.0; individual weights have their respective upstream licenses | Metadata snapshot in `assistant/model-catalog.js`; weights load only on explicit selection. Each choice links its upstream model card and license |

The recommended default is [Qwen2.5-1.5B-Instruct](https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f32_1-MLC)
(Apache-2.0). Other selected weights include models under Llama community license terms
and Microsoft Phi under MIT. See the selected model card for its applicable notices.
On-demand runtime/model files are not vendored in this repository. Their upstream
distributions retain their respective license notices. The WebLLM catalog
configuration is a modified selection: ten models are retained, and download
sizes, display metadata and capability annotations are added.
Model download-size metadata
comes from public Hugging Face file listings. See the
[model catalog maintenance instructions](docs/features/graph-assistant.md#loading-webllm)
when updating the committed snapshot.

## Llama models

**Built with Llama** when a Llama-based model is selected or running in the
optional graph assistant. The model chooser and active chat identify this use
and link the applicable license and acceptable use policy before a download.

Llama 3.1 is licensed under the Llama 3.1 Community License,
Copyright © Meta Platforms, Inc. All Rights Reserved.

Llama 3.2 is licensed under the Llama 3.2 Community License,
Copyright © Meta Platforms, Inc. All Rights Reserved.

Hermes 3 is a Llama 3.1 derivative published by
[Nous Research](https://huggingface.co/NousResearch/Hermes-3-Llama-3.1-8B).
Its publisher's model card declares `llama3` while identifying a Llama 3.1
base. Both the publisher-declared Meta Llama 3 terms and the Llama 3.1 base
terms are provided here. The Hermes option additionally displays
**Built with Meta Llama 3** and links both sets of terms and use policies.

Meta Llama 3 is licensed under the Meta Llama 3 Community License,
Copyright © Meta Platforms, Inc. All Rights Reserved.

Converted and quantized model artifacts are supplied by
[MLC AI](https://huggingface.co/mlc-ai); upstream model cards identify their
original creators. Other Qwen choices use Apache-2.0; Phi-4-mini uses MIT.

## Artwork

| Asset | License | Use |
| --- | --- | --- |
| [63.svg](https://github.com/MariaLetta/free-gophers-pack/blob/master/characters/svg/63.svg) from [MariaLetta/free-gophers-pack](https://github.com/MariaLetta/free-gophers-pack) | CC0 1.0 Universal | Mascot artwork vendored at `docs/assets/gopher-63.svg`, served in the app from `internal/app/web/static/gopher-63.svg`, and included in `dist/assets/gopher-63.svg` |

## External Data Services

| Service | Use | Terms or License Notes |
| --- | --- | --- |
| [Go module mirror](https://proxy.golang.org/) | Resolves public module versions, `go.mod` files, and release freshness metadata | Subject to the Go module services privacy policy |
| [deps.dev (Google Open Source Insights)](https://deps.dev/) | Provides project associations and exact-version license expressions | Generated data: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Aggregated records retain upstream licenses. [Data documentation](https://docs.deps.dev/api/v3/#data); [Google API Terms of Service](https://developers.google.com/terms) |
| [OpenSSF Scorecard](https://github.com/ossf/scorecard#scorecard-rest-api) | Repository reports retrieved through deps.dev | Report data: [CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/) |
| [OSV](https://osv.dev/) | Matches exact public Go module versions to advisory records | Data retains each original database's license. Go Vulnerability Database (The Go Authors) and GitHub Advisory Database records: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). [Source licenses](https://google.github.io/osv.dev/data/); [API documentation](https://google.github.io/osv.dev/api/) |
| [GitHub REST Search](https://docs.github.com/en/rest/search/search) | Provides module search suggestions | Subject to GitHub API terms and rate limits |

Data presentation changes: module records are selected and grouped; scores and
dates may be formatted; advisory aliases are grouped and long descriptions may
be shortened. Source IDs, reported credits and evidence links are retained.
These presentation changes do not establish endorsement by any data provider.

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
