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
  let scene
  try { scene = createGraphScene(container, model, { ...options, renderer: requested }) }
  catch (error) { layout.dispose(); throw error }
  const state = current = { model, scene, layout, frame: null, started: performance.now() }
  scene.requestRender()
  function tick() {
    if (current !== state) return
    state.frame = null
    const done = layout.step() || performance.now() - state.started >= 12000
    if (done) { layout.finish(); scene.fit() }
    scene.requestRender()
    if (!done) state.frame = requestAnimationFrame(tick)
  }
  state.frame = requestAnimationFrame(tick)
  return scene.ready
}

export function disposeGraph() {
  if (!current) return
  const previous = current; current = null
  if (previous.frame !== null) cancelAnimationFrame(previous.frame)
  previous.layout.dispose(); previous.scene.dispose()
}

export function clearGraph(container) {
  disposeGraph()
  if (container) { container.className = 'graph-empty'; container.replaceChildren() }
}

export function selectNode(id) { current?.model.select(id); current?.scene.requestRender() }
export function setGraphLens(id) { current?.model.setLens(id); current?.scene.requestRender() }
export function setAnalysisColors(colors) { current?.model.setColors(colors); current?.scene.requestRender() }
export function applyHighlightRequest(request) { current?.model.highlight(request); current?.scene.requestRender() }
