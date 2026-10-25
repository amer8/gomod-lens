# Graph rendering and benchmarks

The application uses native Canvas for small graphs, switching to WebGPU at
500 modules or 2,000 edges. This conservative threshold follows the paired
measurements below. It is a heuristic from one machine, not an adaptive hardware
benchmark. WebGPU initialization or device loss leaves a working Canvas graph.
For comparison on another device, append `?renderer=canvas` or
`?renderer=webgpu` before the URL hash. An explicitly requested GPU still falls
back if the browser refuses it. WebGPU needs a secure context, such as HTTPS or
localhost.

Graph storage uses JavaScript maps and typed arrays. The CPU force layout keeps
`ngraph.forcelayout` and its three helpers; nodes, directed edges, labels,
picking, pan/zoom, pinch gestures, lens colors, and assistant highlights use the
app's own code. `ngraph.graph`, `ngraph.svg`, RBush, and quickselect are retained
only in the frozen benchmark, outside the generated deployment.

`graph.js` preserves the controller contract. `graph-model.js` owns topology,
selection, colors, and packed geometry; `graph-layout.js` adapts the retained
solver; `graph-scene.js` owns camera, input, resizing, and backend lifecycle.
`graph-webgpu.js` draws instanced circles and arrowed edges, while
`graph-canvas.js` supplies the fallback and the shared label overlay. Both
backends use the same text collision suppression and zoom-dependent detail.
Positions/styles upload when changed; panning within a detail level updates only
the GPU camera uniform. Rendering stops when the scene is unchanged.

## Measurement method

Measured on 2026-10-25 on an Apple M4 Pro Mac mini, macOS, Chrome 155 headless,
native Metal 3 adapter (not a software fallback), 1,280 × 800 CSS pixels at
2× device pixel ratio. Each renderer receives identical graph data, positions,
and camera transforms. Positions come from 300 steps of the existing solver.

The synthetic DAGs contain 100/369, 500/1,959, and 1,500/5,946 nodes/edges. The
last workload exercises the resolver's 1,500-module cap. They are stress
workloads, not claims about the size of typical Go dependency graphs. A separate
run loads the actual WASM application and resolves Cobra v1.10.2 (7 nodes,
6 edges); its response is saved for offline replay.

Each workload runs three paired trials with rotated renderer order. Each trial
uses 30 warm-up and 90 measured animation frames, deterministic pan/zoom, and
selection changes every 30 frames. Tables summarize the median of the three
trial statistics. Draw time is CPU submission time, not GPU execution time;
WebGPU completion is awaited at the end, without serializing every frame.
Chrome's renderer-main-thread `TaskDuration` includes deferred DOM/style/layout
work and covers all 120 frames. It does not measure GPU utilization or power.

The Canvas/WebGPU comparison isolates the drawing backend because they share
labels and geometry. The original SVG/Canvas renderer has its own label/detail
policy, so comparisons against it measure the whole renderer replacement,
including that policy change. Do not attribute all of that difference to WebGPU.
The original benchmark adapter suppresses duplicate scheduled draws and updates
the same backdrop properties as the new scene.

## Results

Median CPU draw/submission time per measured frame, in milliseconds:

| Workload | Original SVG/Canvas | Native Canvas | WebGPU |
| --- | ---: | ---: | ---: |
| Cobra v1.10.2 / 7 nodes / 6 edges | 0.1 | 0.1 | 0.1 |
| 100 nodes / 369 edges | 0.4 | 0.4 | 0.2 |
| 500 nodes / 1,959 edges | 1.5 | 1.0 | 0.3 |
| 1,500 nodes / 5,946 edges | 4.0 | 2.2 | 0.4 |

At 1,500 nodes, p95 CPU draw time was 5.0 / 2.6 / 0.9 ms respectively. Renderer
main-thread task time over 120 frames was 1,867.6 / 367.5 / 91.1 ms. WebGPU
therefore reduced draw/submission time about 10× against the original renderer,
and about 5.5× against the native Canvas fallback on this workload. These are
CPU-side drawing measurements, not whole-app speedups.

All implementations maintained approximately 16.7 ms frame intervals in these
headless runs, with p95 at 16.7–16.8 ms and no measured interval above 25 ms.
There was no observed frame-rate improvement on this machine's 60 Hz benchmark
pacing. The measured benefit is CPU headroom during interaction. At 100 nodes,
the small absolute draw-time saving is less compelling than avoiding GPU startup;
the real seven-node Cobra graph had effectively equal median draw time, with
37.7 ms renderer task time for Canvas versus 48.5 ms for WebGPU over 120 frames,
plus GPU initialization overhead. This is why small graphs default to Canvas.

The median 1,500-node scene initialization cost was 35.6 ms for the original,
20.0 ms for Canvas, and 32.8 ms for WebGPU. These runs include model construction
and use warmed browser/driver caches; they are not a cold-start compilation
benchmark. Smaller GPU scenes took about 7.5–8.9 ms to initialize. Adapter
creation and shader compilation remain costs that Canvas avoids.

An additional test used the actual public `renderGraph` entry points while the
force solver was running on a 1,500-node graph. Median renderer main-thread task
time over 120 frames was 1,204.4 ms for the original, 742.3 ms for Canvas, and
470.9 ms for WebGPU. WebGPU reduced that CPU time about 61% against the original
and 37% against Canvas; all three still paced at approximately 60 fps.

The new layout adapter's 300 synchronous steps took about 705.5 ms at 1,500
nodes. The solver remains on the CPU, with numerical agreement checked against
the original adapter. Network resolution, upstream evidence fetches, and layout
mathematics receive no WebGPU acceleration. The production renderer normally
spreads steps across animation frames and caps the layout run at 12 seconds.

The runtime graph modules and their vendor dependencies occupy approximately
115 kB before and 59 kB after this change, or 32.8 kB and 20.1 kB when each
module is gzipped separately. These figures exclude unchanged traversal code,
notices, and the rest of the application; the frozen development benchmark is
not part of the deployment.

WebGPU is worthwhile here for larger graphs, and the Canvas replacement also
reduces work relative to the original renderer. Measurements on one Apple GPU
do not establish a universal threshold, battery savings, behavior during local
AI inference, or performance on mobile, integrated, or discrete PC GPUs. Those
remain reasons to keep the backend override and fallback. Concurrent WebLLM
inference was not benchmarked.

Raw observations are in
[`apple-m4-pro.json`](../../tools/graph-benchmark/results/apple-m4-pro.json),
[`cobra.json`](../../tools/graph-benchmark/results/cobra.json), and
[`live-layout.json`](../../tools/graph-benchmark/results/live-layout.json).

## Reproduce

The app still needs no npm build or install. The optional benchmark runner needs
Playwright and an installed browser; it is a development tool, not a runtime
dependency. From the repository root, with Playwright resolvable by Node:

```sh
make check
node tools/graph-benchmark/run.mjs
node tools/graph-benchmark/run.mjs --verify
node tools/graph-benchmark/run.mjs --layout
node tools/graph-benchmark/run.mjs --fixture=tools/graph-benchmark/results/cobra.json
```

Use `PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright` when it is
provided by a separate tool runtime. On macOS the runner defaults to installed
Google Chrome; set `CHROME_PATH` for another Chromium binary. `HEADED=1` runs a
visible browser. `BENCHMARK_OUTPUT=/path/to/results.json` controls the JSON output
(default: `/private/tmp/gomod-lens-webgpu-benchmark.json`). The runner serves
only the app/build and benchmark directories over ephemeral localhost, closes
the browser/server afterward, and rejects missing WebGPU adapters. Check the
reported adapter before interpreting another machine's results.

`--verify` exercises native GPU selection, mouse pan/zoom, touch gesture math,
390-pixel resizing, actual GPU device loss, refused adapters, and canceled
initialization. `--layout` measures the real public renderer entry points while
the force solver is running. `make wasm` followed by `--live` additionally
loads the built app with the public Cobra module and records its resolved graph.
The default synthetic benchmarks and saved Cobra replay need no upstream APIs.

The Node tests check topology, directed path highlighting, lens colors,
geometry invalidation, camera bounds, the automatic threshold, and numerical
agreement with the original force solver. The old renderer and pinned vendor
snapshot in `tools/graph-benchmark/legacy*` remain solely for reproducibility and
this differential test; do not import them into the application.
