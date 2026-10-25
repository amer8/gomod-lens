# Graph assistant

The Web and WASM apps share a collapsible **Bottom dock** conversation. Load a
public module and choose **Ask AI** at the top right (near the gopher on
small screens). The dock leaves the graph above it and the existing sidebar
beside it on desktop. Hover a lens icon or focus it with Tab to see its full
name beneath the toolbar. Escape dismisses the label without changing the lens. The galaxy backdrop belongs to the full app surface,
independently of the resized graph canvas, so both glass panels retain the same
translucent background in compact and expanded views. The dock starts at 40% of the app height. **Expand**
uses the full height; **Minimise** returns to 40% without clearing the
conversation. Drag the top edge to choose another height. The focusable resize
handle also supports Up/Down (5% steps), Home (40%), and End (full height). **Close** hides the dock; reopening starts at 40%. On small
screens it temporarily covers the sidebar.

The initial three questions use the active lens, selected module, loaded graph,
and already observed evidence. Their counts come from observations, not model
guesses. Direct dependency updates and major-version changes get separate
investigations; license gaps and multiple expressions are offered when present.
You can choose one or type a question. The latest completed answer offers three
follow-ups ranked by the previous answer and the available evidence. Advisory
matches lead to recorded fixed versions, introducing dependencies, and a path
to an actual matched module. All-clear results suppress empty advisory follow-ups.
License inventories can lead to a rare observed identifier, such as ISC, with an
exact inventory filter. Missing or healthy repository reports do not produce
questions asserting failing checks. Root-to-root paths and unavailable operations
are never suggested. Question history tracks the module/filter as well as topic,
so asking a license overview does not suppress a useful named-license query.
Relevant unasked investigations precede repeats; each group has three distinct
topics and normally spans more than one type of evidence.
Starting the next question removes earlier “Continue exploring” sections in
that conversation; only the newest completed answer offers follow-ups.
Answers and follow-ups span the available panel width. Initial and follow-up
question cards share the same filled background as question bubbles.
There is no header or tab strip. **Expand/Minimise** and **Close** float in the
top-right corner, so the model chooser and conversation use the panel's full
height. The resize handle stays on the top edge.

The assistant has one chat history, kept in page memory until reload. Closing
and reopening the dock, switching models, and ejecting a model retain the
messages and draft. One answer runs at a time.
Enter submits; Shift+Enter adds a line; the stop button cancels an answer;
Escape closes the dock.

## Grounded investigations

Chat requires WebLLM and a loaded model. It supports:

- Module graph overview, direct dependencies, and a shortest requirement path.
- Selected module identity, source repository links, public replacements, and observed release gaps.
- Exact-version OSV advisory matches and direct dependencies with paths to them.
- Advisory fixed-version events, scoped to the resolved module identity.
- License expressions, repository check details, and missing observations.
- Explanations of reachability and other analysis limitations.
- Available analysis lenses, using labels and capability descriptions from the browser registry.

Suggested investigations use query functions over the graph and lens observations.
Explicit requirement-path questions use verified graph queries. Named-license
inventory questions such as “Which modules use ISC?” filter the full loaded
license inventory with exact identifier tokens. They do not depend on the first four findings in a model prompt. Common
license identifiers trigger license retrieval even without the word “license”.
Unknown observations remain unknown, and the answer links the evidence and
offers a highlight action for the matches. Expression matches do not infer
license compatibility or the relationship between multiple expressions. Other custom
questions are answered directly by the local model from bounded evidence
and the last two completed exchanges in that conversation. For example,
“Which lenses are available?” lists the registered lenses without module highlights
or external lookups. Other app-guidance questions receive the same registry facts.
“Where’s the repository on GitHub?” supplies the source repository URL rather
than substituting Scorecard checks. Full module paths and unique aliases such
as `x/net` select the relevant module for a typed question. Repository mappings
are preferred; GitHub module-path inferences are explicitly marked. Missing
repository identities are not replaced with invented links.

Custom replies stream into the conversation. **Evidence & scope** shows the
observations supplied to the model, with citation IDs and truncation limits.
Custom replies target one or two short sentences (60 words), naming the actual
module or URL instead of referring to evidence labels. Prompts include only
requested investigations, without unrelated overview, path, or release facts.
Generated prose can be imperfect; the displayed evidence and source links let
you verify it. Model prose is rendered as text, while source links and graph
actions come from the application’s evidence queries.
Module buttons select nodes; separate highlight/lens buttons act on the graph.
Source links, observation timestamps, and scope notes stay in the collapsed
**Evidence & scope** section. License overviews show exact-expression groups
with module counts; overlapping group membership is indicated explicitly.
Selecting a group highlights its modules. All matching modules are displayed by default. A single named-license match is shown inline and becomes the conversational
module context for follow-ups, without changing the graph selection.
All result lists display every finding by default, without a disclosure or display limit.
Links to the corresponding lens remain available.

Questions that need OSV, license, or repository details can fetch the same public
data as those lenses. A failed, skipped, or absent observation stays unknown.
Release information comes from the loaded graph and may be cached. The lens's
Refresh updates its shared observations for subsequent questions; it does not
rewrite earlier answers.

Loading another root or version cancels pending work and starts a new question
context. Earlier answers keep their module/version labels; their graph actions
and follow-ups are disabled. Chat history lives only in page memory and is
lost on reload. Local source analysis, upgrade simulation, code changes, and
reachability analysis are not implemented by this assistant.

## Loading WebLLM

Choose a model in the initial comparison table, then **Load model** to load
WebLLM 0.2.86 in a Web Worker. Opening the chooser imports the runtime in a
short-lived worker to inspect browser cache state; selecting a row does not
download model weights or allocate GPU memory.
Qwen 2.5 1.5B remains the recommended default. The chooser contains a curated
shortlist of ten models, with one `q4f32_1-MLC` variant per model and at least a
4,096-token runtime context. This avoids requiring `shader-f16` for the chosen
variants. The shortlist balances download/GPU budgets, standard chat, optional
thinking and alternative instruction-model families; it is not a measured quality
ranking. Use the developer model verification runner below to check compatibility
on your test device.

| Model | Selection purpose |
| --- | --- |
| Qwen 2.5 1.5B Instruct | Balanced default |
| Qwen 2.5 0.5B Instruct | Smallest download; exercised with the live app checks |
| Qwen 3 0.6B | Compact optional thinking |
| Qwen 3 1.7B | Mid-size optional thinking |
| Qwen 3.5 2B | Newer hybrid option |
| Llama 3.2 3B Instruct | Alternative 3B chat family |
| Phi 4 Mini Instruct | Alternative instruction model |
| Qwen 3 4B | Larger optional-thinking model |
| Hermes 3 Llama 3.1 8B | Desktop instruction model with runtime tool support |
| Qwen 3 8B | Largest optional-thinking option |

Base checkpoints, vision-only differentiators, duplicate precision/context
variants, unknown thinking controls, and reasoning-only models are outside the
shortlist. Removed IDs cannot be selected or initialized through the assistant.

Search matches model names, IDs and short descriptions. The chooser presents only
Model, Download and Memory needed. Click any column header to sort ascending, then
descending. Download bytes and memory estimates sort numerically; unknown values stay last. Sorting and filtering preserve
the chosen model and Loaded/Cached markers. The initial order follows the curated list, with the recommended
model first.

The table compares approximate downloads and graphics memory requirements.
Context limits and capability metadata remain internal implementation details.
Weight sizes sum `.bin` file sizes from public Hugging Face repository listings;
GPU estimates and context overrides come from WebLLM's configuration. Runtime and
tokenizer files add overhead; actual memory needs vary. Unknown sizes are shown
as a dash. Each selection links the actual upstream model repository and license,
without reconstructing URLs from a runtime ID. The options
scroll independently so Load/Cancel stays accessible in the 40% dock.

`assistant/model-catalog.js` is a committed metadata snapshot used directly by
the app; no generation step is required. To update it, verify the selected IDs
against the official WebLLM configuration linked in `catalogInfo.source`, then
update the records using their MLC chat templates and weight-file metadata.
Edit the canonical catalog, rebuild with `make wasm`, and update `catalogInfo.version`,
`source` and `checked` together when changing the pinned runtime.
`tools/webllm-shortlist.json` defines the ten exact IDs, selection notes and
model-card sources; keep it aligned with the catalog. The runtime URL uses the
snapshot's version. Run `node --test tests/assistant-models.test.mjs tests/assistant-profiles.test.mjs` after changes.

### Internal model profiles

Profiles distinguish system instructions from user-message instructions, supported
reasoning controls, runtime JSON output, and native tool/vision support. These
details are handled internally rather than exposed as choices in the model table.
Profiles describe the pinned converted model, not every feature of its source
checkpoint. Tools and image uploads are not exposed by the assistant.

Profiles read each captured MLC chat template and the runtime's explicit
`functionCallingModelIds` list. The selected models accept system instructions;
Qwen 3 / 3.5 variants have optional thinking and Hermes 3 8B has native runtime
tool support. Generic output filtering still handles angle/square thinking tags
and Gemma thought-channel markers so unexpected tagged reasoning is not displayed.
No native tool execution or image inputs are enabled by these profiles.

### Developer model verification

Model verification is a developer task. The user-facing chooser has no check
column, test button or session test status, and loading a model does not run test
inferences before the user can chat.

Open `/assets/assistant/dev-checks.html` on a local preview server to run the
shortlist sequentially. The developer runner calls the same `LocalAI` worker,
profile-specific prompts, JSON planner and answer parser used by the app. Only
one test model occupies GPU memory at a time. Uncached weights are downloaded
on explicit **Run 10 models**; **Stop** terminates the current worker. Repeat the
`model` query parameter with exact IDs to run a subset; the developer runner
allows extra startup time for uncached large models.

The three fixed synthetic fixtures cover license-investigation planning, an
exact repository URL, and an ISC dependency lookup. Each model has separate
per-fixture pass/fail results; load errors and canceled runs are recorded as
incomplete rather than passes. The report includes exact IDs, runtime and suite
versions, timestamps and elapsed time. Download JSON to retain a local record
of a run when needed. Generated reports are not part of the repository, and no
report is sent to an external service.
These fixtures measure basic assistant compatibility on the test device, not
general answer quality or a cross-device performance benchmark. The runner is
not linked from the product UI and never runs automatically for end users.

Loading replaces the comparison table with a focused progress card showing
the selected model, weight/GPU estimates, runtime status, and a Cancel button.
Percentages come directly from WebLLM initialization reports; runtime import
and stages without a numeric report show indeterminate progress.
**Loaded** marks the active, ready model in the table. **Cached** marks model
data reported by WebLLM’s `hasModelInCache`; it is not a promise of a complete
offline package. Unknown or failed checks receive no cached marker. Cache
status is checked on first opening, when comparing models, and after a load
settles or is canceled. Ejection does not change cached status.

Progress and cancellation are shown on every load. Once loaded, the
chooser disappears and reopening the panel goes directly to chat. **Change model**
in the chat footer opens the comparison table while keeping the current model
loaded. **Back to chat** returns without reloading; **Use this model** does the
same when the active model is selected. **Switch model** releases the old worker
and loads the selected model. Only one model occupies GPU memory at a time.
**Eject model** in the chooser releases the active worker. Chat history and the
draft remain in page memory throughout switching and ejection. Switching is
disabled while an answer is running. Reloading the page requires loading a model
again, even if its downloaded files are cached.
The footer displays the loaded model name, and each answer retains its
original model label. Closing the dock keeps the model loaded.

Ejecting or canceling releases the worker without deleting downloaded files.
The browser/runtime may reuse its cache when loading again. Browser site-data
controls can clear cached files. Reloading the page releases the worker and
clears the in-memory chat history.

### Optional thinking

Thinking is enabled automatically for custom answers when the selected model
supports it, including the shortlisted Qwen 3 / 3.5 variants. There is no user-facing
Thinking switch. These answers can take longer. Inventory and path investigations
use thinking-off JSON planning. Plans use bounded integer indices rather than copying long module IDs,
zero-temperature sampling, and one retry for malformed output. Invalid plans never become inferred facts. Standard checkpoints do not receive the thinking flag. The internal API retains
an explicit `thinking: false` override for developer evaluation; normal chat does
not supply it.

The worker passes `extra_body.enable_thinking` explicitly to WebLLM 0.2.86.
Fast custom answers use up to 192 generated tokens; thinking answers use up to 1,536 tokens total, including
reasoning, with a 180-second timeout. These are limits, not guaranteed final-answer
space: the model's 4,096-token context window also includes the prompt/history.
If thinking ends without a final answer, the UI shows an actionable error;
there is no model-free fallback or reasoning text presented as an answer.

Thinking blocks are discarded inside the worker before streaming to the page.
A chunk-aware parser handles split `<think>` and `[THINK]` tags, empty template blocks,
nesting, and unfinished blocks. The page receives only a **Thinking…** status
and visible answer tokens. Only visible answers enter conversation history.
Closing or canceling still follows the normal worker lifecycle.

For suggested questions, deterministic evidence-based ranking selects the next
investigations. Model preferences break ties without overriding observed relevance;
the chosen investigation, target module, and any license filter remain explicit. Custom questions use text generation with the
user's original wording, recent conversation context, and module evidence.
They are not forced into an investigation enum. The model cannot execute
commands, create graph actions, or generate clickable links. All answers require
a loaded model and successful inference.
If loading or inference fails, an error is shown without a model-free answer.
Unsupported WebGPU browsers cannot chat; graph and lens features remain available.
Stopping inference terminates the worker; reload the model before continuing.

Inference stays on the device. Loading AI makes requests to jsDelivr, Hugging
Face, and GitHub for runtime/model artifacts. Evidence lookups still use the
external services documented in `PRIVACY.md`; this is not an offline mode.

## Code map and validation

- `internal/app/web/static/assistant/queries.js`: pure query planning,
  answer construction, contextual suggestions, and graph-data validation.
- `internal/app/web/static/graph-traversal.js`: directed traversal shared with
  the graph renderer; rendering-specific edge IDs stay in `graph.js`.
- `assistant/index.js`: dock, single chat history, cancellation and actions.
- `assistant/suggestions.js`: evidence-based question ranking, module/filter
  identity, source coverage, and suppression of empty or irrelevant follow-ups.
- `assistant/custom.js`: repository identities, question-specific module context,
  bounded evidence packets, and conversation-history selection.
- `assistant/license-query.js`: named-license intent recognition and exact-token inventory filters.
- `assistant/presentation.js`: concise answer text, license group summaries, and complete result inventories.
- `assistant/loading.js`: numeric loading progress and distinct loaded/cache markers.
- `assistant/generation.js`: per-checkpoint generation settings and streaming thinking-block removal.
- `assistant/models.js`, `assistant/model-catalog.js`, and `assistant/model-profiles.js`: pinned WebLLM catalog, template-backed capability profiles, search and sorting.
- `assistant/prompts.js`: profile-specific instruction and history placement.
- `assistant/model-checks.js`: fixed inference fixtures and report validation.
- `assistant/dev-checks.html` and `assistant/dev-checks.js`: developer-only batch evaluation UI, outside the user-facing chooser.
- `assistant/local-ai.js` and `assistant/worker.js`: opt-in local model lifecycle
  validated question interpretation, and streamed custom replies. No model loads at import time.
- `analysis/index.js`: supplies lens observations and graph/selection context.
- `dist/assets/assistant/`: generated output for GitHub Pages; edit canonical sources.

Run `make check`. `tests/graph-assistant.test.mjs` covers graph cycles/shared
dependencies, unknown evidence, replacement identities, fixed-version scope,
suggestions, plan validation, worker cancellation, and model-required gating.

For manual checks, load `github.com/gin-gonic/gin@v1.10.0` in the static application.
Open the assistant, load the model, ask about advisory matches, highlight the matches, select a
module, and follow a path question. Change to v1.9.1 during a pending answer:
the old request must stop and its graph actions must become unavailable. Try
`github.com/google/uuid@v1.6.0` for a small graph. Check narrow-screen layout,
keyboard controls, and unsupported-WebGPU fallback. On a WebGPU device, enable
the model, ask a differently worded question, and stop inference.
Verify the chat is locked before loading and after stopping inference, and that failed
inference never produces a fallback answer. Drag-resize, expand, minimise, and
close/reopen the dock on desktop and mobile; conversation content must survive
resizing.

Ask two questions and keep a draft. Close/reopen the dock and switch models;
verify the messages and draft remain. Confirm there is no conversation menu or
new-conversation control. Verify the floating controls remain reachable at 40%,
full height, and on narrow screens.

Custom-answer regression checks: ask “Where's the repository on github?” and
verify the exact source link. Ask “Why is golang.org/x/net included?” and verify
that module's requirement path, then “Where is its repository?” to check context.
Load another module to ensure older answers do not enter its context. Test a module
without a repository mapping and confirm the answer states the missing data.
`tests/assistant-custom.test.mjs` covers evidence preparation, repository safety,
replacement identity, history scope, streaming, and failure propagation.

Model switching checks: load the recommended model, ask a question, keep a draft,
and eject. Confirm the chooser returns and chat is locked. Choose a different
model, load it, and check the footer ID, retained messages/draft, and original
answer labels. Eject during generation to verify cancellation; cancel a load and
immediately load another model to check stale callbacks cannot revive it.
`tests/assistant-models.test.mjs` covers the allowlist, model identity, ejection,
failed initialization, and canceled-load races.

License-filter regression: load `github.com/gin-gonic/gin@v1.12.0`, ask the license
inventory question, then “Which modules use ISC”. The result must include
`github.com/davecgh/go-spew` when its resolved-version observation contains ISC,
with a matching highlight and source link. Repeat with MIT and an identifier
without matches. `tests/assistant-licenses.test.mjs` checks routing, matches
beyond prompt/display limits, expression boundaries, multiple identifiers,
replacement identities, and incomplete or failed observations.

Qwen3 checks: load a Qwen3 variant and ask a custom question. Confirm the
Thinking status appears automatically and only the final answer is shown. No
checkbox or capability/context columns should be visible. Keep inventory queries
fast through constrained planning. Cancel while thinking,
eject/reload, close and reopen the dock during generation, and verify no reasoning
appears in either transcript/history. `tests/assistant-generation.test.mjs`
exercises every split-tag boundary, unfinished blocks, per-mode token budgets,
JSON prefix handling, and the actual worker message boundary with a fake engine.

Answer-quality checks: ask “What license evidence is available?” followed by
“Which dependency has ISC license?” on Gin v1.12.0. The overview must show
expression counts; the follow-up must name go-spew directly. Ask “Explain which
dependency has ISC license” to exercise custom generation with focused license
facts. `tests/assistant-presentation.test.mjs` covers complete grouped counts,
compact single matches, unknown evidence, and complete result lists.

Model-loading checks: verify indeterminate startup, numeric initialization progress,
cancel/close/reopen during loading, and both 40%/full-height layouts. After loading,
open **Change model** and check the **Loaded** badge; after ejection/reload, cached
models must be marked **Cached**, never **Loaded**. Cache failures must leave the
chooser usable without a false cache hit. `tests/assistant-loading.test.mjs` covers
progress values, marker precedence, cache-result validation, and probe cleanup.

Suggestion checks: change lenses and select a dependency; verify questions reflect
the observed data. After advisory matches, inspect a fixed-version event and trace
a suggested module back to the root. After an all-clear lookup, no introducer or
fix question should appear. In the license inventory, follow an observed identifier
and verify the resulting list is filtered. `tests/assistant-suggestions.test.mjs`
covers these flows, query scopes, replacements, missing data, and history.
