# Graph rendering and verification

The application uses native Canvas for small graphs, switching to WebGPU at
500 modules or 2,000 edges. This threshold is a heuristic from device
measurements, not an adaptive hardware benchmark. WebGPU initialization failure
or device loss leaves a working Canvas graph. To select a backend explicitly,
append `?renderer=canvas` or `?renderer=webgpu` before the URL hash. WebGPU needs
a secure context such as HTTPS or localhost.

Graph storage uses JavaScript maps and typed arrays. The CPU force layout uses
`ngraph.forcelayout` and its three helpers. Nodes, directed edges, labels,
picking, pan/zoom, pinch gestures, lens colors and assistant highlights use the
app's own code. These four runtime packages are the only graph dependencies;
the development tools use the same modules as the app.

`graph.js` preserves the controller contract. `graph-model.js` owns topology,
selection, colors and packed geometry; `graph-layout.js` adapts the solver;
`graph-scene.js` owns camera, input, resizing and backend lifecycle.
`graph-webgpu.js` draws instanced circles and arrowed edges, while
`graph-canvas.js` supplies the fallback and shared label overlay. Both backends
use the same text collision suppression and zoom-dependent detail.

Positions and styles upload when changed. Panning within a detail level updates
only the GPU camera uniform. Rendering stops when the scene is unchanged.
The production force solver warms up for up to 120 steps before the first
visible graph, using 8 ms batches across animation frames. The loading view
stays active during preparation. The camera fits those initial positions once;
remaining layout steps stop when stable or after 12 seconds, without refitting
the camera or snapping the displayed positions to the solver. Resizing retains
the zoom and the world point at the viewport center. WebGPU accelerates drawing;
layout mathematics, network resolution and evidence fetches still run on the CPU.

## Checks

Run the repository checks with:

```sh
make check
```

The Node tests cover topology, directed path highlighting, lens colors,
geometry invalidation, camera bounds, automatic backend selection, adapter
refusal, root pinning and finite layout positions for cycles and disconnected
nodes. They use the current implementation without a second graph library.

The optional browser runner requires a locally available Playwright module and
an installed Chromium browser with native WebGPU:

```sh
node tools/graph-benchmark/run.mjs --verify
```

This checks actual GPU rendering, node selection, mouse pan/zoom, touch gesture
math, 390-pixel resizing with preserved pan/zoom, camera stability at the layout
timeout, canceled layout preparation, device-loss fallback, refused adapters
and cancellation of pending GPU initialization.

Set `PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright` when Playwright
is supplied by a separate runtime. On macOS the runner defaults to Google
Chrome. `CHROME_PATH` selects another Chromium executable, and `HEADED=1` opens
a visible browser.

## Measure the current renderers

The benchmark compares Canvas and WebGPU using identical graph data, positions,
camera transforms, labels and selections:

```sh
node tools/graph-benchmark/run.mjs --smoke
node tools/graph-benchmark/run.mjs
node tools/graph-benchmark/run.mjs --layout
```

The smoke run uses 35 synthetic nodes. The full run uses seeded synthetic DAGs
with 100/369, 500/1,959 and 1,500/5,946 nodes/edges. These are stress workloads,
not claims about typical Go dependency graphs. Each full workload receives three
paired trials with rotated backend order, 30 warmup frames and 90 measured
frames. Positions come from 300 force steps before the drawing comparison.
The `--layout` run measures the actual public graph entry point while the force
solver runs on 1,500 nodes, over 120 frames per trial.

CPU draw/submission time is separate from GPU execution time. Renderer-main-thread
task time includes deferred DOM/style/layout work, and GPU completion is awaited
at the end of each trial. Review the recorded adapter and environment before
comparing machines. These measurements do not establish battery savings or
performance during concurrent local AI inference.

For an optional run using a newly resolved public module:

```sh
make wasm
node tools/graph-benchmark/run.mjs --live
```

This resolves Cobra through the built WASM app and includes its payload in the
output. A saved run can be replayed with
`--fixture=/absolute/path/to/saved-run.json` without upstream API requests.

The runner serves app/build and benchmark files over ephemeral localhost and
closes the browser/server afterward. Output defaults to
`/private/tmp/gomod-lens-webgpu-benchmark.json`; set `BENCHMARK_OUTPUT` to retain
a run elsewhere. Measurement output is generated on demand rather than checked
into the repository. Earlier renderer implementations and comparison results
remain available through Git history.
