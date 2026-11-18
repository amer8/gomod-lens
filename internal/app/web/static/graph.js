import { createGraphModel } from './graph-model.js'
import { createGraphLayout } from './graph-layout.js'
import { createGraphScene } from './graph-scene.js'

/**
 * @typedef {Object} GraphState
 * @property {ReturnType<typeof createGraphModel>} model
 * @property {ReturnType<typeof createGraphScene> | null} scene
 * @property {ReturnType<typeof createGraphLayout>} layout
 * @property {number | null} frame
 * @property {number} started
 * @property {() => void} resolveReady
 */
/** @type {GraphState | null} */
let current = null

// Retain the controller/lens contract. The rendering backend is private to the
// graph and can change after asynchronous GPU initialization or device loss.
/**
 * @param {HTMLElement | null} container
 * @param {import('./analysis/types.js').GraphPayload | null} payload
 * @param {NonNullable<Parameters<typeof createGraphScene>[2]>} [options]
 */
export function renderGraph(container, payload, options = {}) {
  if (!container || !payload) return
  const graphContainer = container
  disposeGraph()
  container.className = 'graphView'
  const model = createGraphModel(payload)
  const requested =
    options.renderer || new URLSearchParams(globalThis.location?.search).get('renderer') || 'auto'
  const layout = createGraphLayout(model)
  /** @type {() => void} */
  let resolveReady = () => {}
  /** @type {(reason?: unknown) => void} */
  let rejectReady = () => {}
  /** @type {Promise<void>} */
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  /** @type {GraphState} */
  const state = (current = {
    model,
    scene: null,
    layout,
    frame: null,
    started: performance.now(),
    resolveReady,
  })
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
      do {
        done = layout.step()
        preparedSteps++
      } while (!done && preparedSteps < 120 && performance.now() < deadline)
      if (!done && preparedSteps < 120) {
        state.frame = requestAnimationFrame(tick)
        return
      }
      try {
        state.scene = createGraphScene(graphContainer, model, { ...options, renderer: requested })
      } catch (error) {
        rejectReady(error)
        disposeGraph()
        return
      }
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
  const previous = current
  current = null
  if (previous.frame !== null) cancelAnimationFrame(previous.frame)
  previous.layout.dispose()
  previous.scene?.dispose()
  previous.resolveReady()
}

/** @param {HTMLElement | null} container */
export function clearGraph(container) {
  disposeGraph()
  if (container) {
    container.className = 'graph-empty'
    container.replaceChildren()
  }
}

/** @param {string} id */
export function selectNode(id) {
  current?.model.select(id)
  current?.scene?.requestRender()
}
/** @param {string} id */
export function setGraphLens(id) {
  current?.model.setLens(id)
  current?.scene?.requestRender()
}
/** @param {Record<string, string> | null} colors */
export function setAnalysisColors(colors) {
  current?.model.setColors(colors)
  current?.scene?.requestRender()
}
/** @param {import('./analysis/types.js').HighlightRequest | null} request */
export function applyHighlightRequest(request) {
  current?.model.highlight(request)
  current?.scene?.requestRender()
}
