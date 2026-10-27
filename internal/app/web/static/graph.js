import { createGraphModel } from './graph-model.js'
import { createGraphLayout } from './graph-layout.js'
import { createGraphScene } from './graph-scene.js'

let current = null

// Retain the controller/lens contract. The rendering backend is private to the
// graph and can change after asynchronous GPU initialization or device loss.
export function renderGraph(container, payload, options = {}) {
  if (!container || !payload) return
  disposeGraph()
  container.className = 'graphView'
  const model = createGraphModel(payload)
  const requested = options.renderer || new URLSearchParams(globalThis.location?.search).get('renderer') || 'auto'
  const layout = createGraphLayout(model)
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const state = current = { model, scene: null, layout, frame: null, started: performance.now(), resolveReady }
  let preparedSteps = 0
  function tick() {
    if (current !== state) return
    state.frame = null
    let done = false
    if (!state.scene) {
      // Spread the initial expansion across frames before fitting the first
      // visible positions. Fitting the solver's tiny random seed would zoom
      // in too far; fitting again at the end would override the user's view.
      const deadline = performance.now() + 8
      do { done = layout.step(); preparedSteps++ }
      while (!done && preparedSteps < 120 && performance.now() < deadline)
      if (!done && preparedSteps < 120) { state.frame = requestAnimationFrame(tick); return }
      try { state.scene = createGraphScene(container, model, { ...options, renderer: requested }) }
      catch (error) { rejectReady(error); disposeGraph(); return }
      state.scene.ready.then(resolveReady, rejectReady)
    } else done = layout.step()
    done ||= performance.now() - state.started >= 12000
    state.scene.requestRender()
    if (!done) state.frame = requestAnimationFrame(tick)
  }
  state.frame = requestAnimationFrame(tick)
  return ready
}

export function disposeGraph() {
  if (!current) return
  const previous = current; current = null
  if (previous.frame !== null) cancelAnimationFrame(previous.frame)
  previous.layout.dispose(); previous.scene?.dispose(); previous.resolveReady()
}

export function clearGraph(container) {
  disposeGraph()
  if (container) { container.className = 'graph-empty'; container.replaceChildren() }
}

export function selectNode(id) { current?.model.select(id); current?.scene?.requestRender() }
export function setGraphLens(id) { current?.model.setLens(id); current?.scene?.requestRender() }
export function setAnalysisColors(colors) { current?.model.setColors(colors); current?.scene?.requestRender() }
export function applyHighlightRequest(request) { current?.model.highlight(request); current?.scene?.requestRender() }
