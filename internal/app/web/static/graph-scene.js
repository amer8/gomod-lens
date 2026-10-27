import { createCanvasRenderer, createGraphLabels } from './graph-canvas.js'

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// The paired renderer benchmark found small absolute savings at 100 modules
// and larger savings at 500. Explicit WebGPU remains available for
// measuring smaller graphs on other devices.
export function shouldUseWebGPU(mode, nodes, edges) {
  return mode === 'webgpu' || (mode !== 'canvas' && (nodes >= 500 || edges >= 2000))
}

export function fitCamera(positions, width, height, padding = 48) {
  if (!positions.length) return { scale: 1, x: width / 2, y: height / 2 }
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (let i = 0; i < positions.length; i += 2) {
    left = Math.min(left, positions[i]); right = Math.max(right, positions[i])
    top = Math.min(top, positions[i + 1]); bottom = Math.max(bottom, positions[i + 1])
  }
  const scale = clamp(Math.min(Math.max(1, width - padding * 2) / Math.max(100, right - left), Math.max(1, height - padding * 2) / Math.max(100, bottom - top)), 0.08, 40)
  return { scale, x: width / 2 - (left + right) / 2 * scale, y: height / 2 - (top + bottom) / 2 * scale }
}

export function createGraphScene(container, model, options = {}) {
  let disposed = false, frame = null, width = 0, height = 0, pixelRatio = 0
  const abort = new AbortController(), pointers = new Map()
  const createCanvas = () => {
    const canvas = document.createElement('canvas')
    canvas.className = 'graph-layer'
    return canvas
  }
  let canvas = createCanvas(), renderer = createCanvasRenderer(canvas, model)
  const labelsCanvas = createCanvas(), labels = createGraphLabels(labelsCanvas, model)
  labelsCanvas.classList.add('graph-labels'); labelsCanvas.setAttribute('aria-hidden', 'true')
  // The container stays the interaction surface while a GPU canvas initializes
  // or is replaced after device loss, so gestures never retain a dead canvas.
  container.replaceChildren(canvas, labelsCanvas)
  container.setAttribute('role', 'img')
  container.setAttribute('aria-label', `Dependency graph with ${model.nodes.length} modules and ${model.links.length} connections`)
  const camera = { scale: 1, x: 0, y: 0 }
  let fallbackReason = '', down = null, gesture = false

  function size(target) { target.width = Math.max(1, Math.round(width * pixelRatio)); target.height = Math.max(1, Math.round(height * pixelRatio)) }
  function backdrop() {
    const element = container.closest('#app') || container, level = Math.log2(camera.scale)
    element.style.setProperty('--galaxy-pan-x', `${clamp(camera.x * 0.045, -280, 280).toFixed(2)}px`)
    element.style.setProperty('--galaxy-pan-y', `${clamp(camera.y * 0.045, -220, 220).toFixed(2)}px`)
    element.style.setProperty('--galaxy-band-pan-x', `${clamp(camera.x * 0.026, -180, 180).toFixed(2)}px`)
    element.style.setProperty('--galaxy-band-pan-y', `${clamp(camera.y * 0.026, -140, 140).toFixed(2)}px`)
    element.style.setProperty('--galaxy-scale', clamp(1 + level * 0.12, 0.88, 2.7).toFixed(3))
    element.style.setProperty('--galaxy-band-scale', clamp(1.12 + level * 0.08, 1, 2.2).toFixed(3))
  }
  function setCamera(value) {
    Object.assign(camera, value); camera.scale = clamp(camera.scale, 0.08, 40)
    model.setZoom(camera.scale); backdrop(); requestRender()
  }
  function fit() { setCamera(fitCamera(model.positions, width, height)) }
  function resize() {
    if (disposed) return
    const box = container.getBoundingClientRect()
    const previousWidth = width, previousHeight = height, initial = pixelRatio === 0
    width = Math.max(1, box.width); height = Math.max(1, box.height); pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2)
    size(canvas); size(labelsCanvas)
    if (initial) fit()
    // Keep the same world point at the center and retain the user's zoom.
    else setCamera({ x: camera.x + (width - previousWidth) / 2, y: camera.y + (height - previousHeight) / 2 })
  }
  function draw() {
    if (disposed) return
    if (frame !== null) { cancelAnimationFrame(frame); frame = null }
    if (pixelRatio !== Math.min(globalThis.devicePixelRatio || 1, 2)) resize()
    try { renderer.draw(camera, width, height) } catch (error) { fallback(error); renderer.draw(camera, width, height) }
    labels.draw(camera, width, height)
  }
  function requestRender() { if (!disposed && frame === null) frame = requestAnimationFrame(draw) }
  function fallback(error) {
    if (disposed) return
    fallbackReason = error?.message || 'WebGPU initialization failed'
    if (renderer.type === 'canvas') return
    const previous = canvas, next = createCanvas()
    renderer.dispose(); canvas = next; size(canvas)
    renderer = createCanvasRenderer(canvas, model); previous.replaceWith(canvas)
    container.dataset.graphRenderer = renderer.type; requestRender()
  }
  async function initialize() {
    if (!shouldUseWebGPU(options.renderer, model.nodes.length, model.links.length)) return
    let candidate = null, failed = null
    try {
      const { createWebGPURenderer } = await import('./graph-webgpu.js')
      if (disposed) return
      const next = createCanvas()
      candidate = await createWebGPURenderer(next, model, error => {
        failed = error
        if (renderer === candidate) fallback(error)
      })
      if (disposed) { candidate.dispose(); return }
      size(next)
      // Render once before adopting the candidate; validation/device errors
      // cannot leave the visible graph empty during initialization.
      candidate.draw(camera, width, height); await candidate.flush()
      if (failed) throw failed
      if (disposed) { candidate.dispose(); return }
      renderer.dispose(); canvas.replaceWith(next); canvas = next; renderer = candidate
      container.dataset.graphRenderer = renderer.type; requestRender()
    } catch (error) { candidate?.dispose(); fallback(error) }
  }
  function point(event) { const box = container.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top } }
  function zoom(factor, x, y) {
    const scale = clamp(camera.scale * factor, 0.08, 40), ratio = scale / camera.scale
    setCamera({ scale, x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio })
  }
  function hit(x, y) {
    for (let i = model.nodes.length - 1; i >= 0; i--) {
      const node = model.nodes[i], px = model.positions[i * 2] * camera.scale + camera.x, py = model.positions[i * 2 + 1] * camera.scale + camera.y
      if ((x - px) ** 2 + (y - py) ** 2 <= Math.max(7, node.radius * Math.min(camera.scale, 2)) ** 2) return node
    }
    const label = labels.hits.find(box => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
    return label ? model.byID.get(label.id) : null
  }
  const listen = (type, fn, extra = {}) => container.addEventListener(type, fn, { ...extra, signal: abort.signal })
  listen('wheel', event => {
    event.preventDefault(); const p = point(event), unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? height : 1
    zoom(Math.exp(-event.deltaY * unit * 0.002), p.x, p.y)
  }, { passive: false })
  listen('dblclick', event => { event.preventDefault(); const p = point(event); zoom(2, p.x, p.y) })
  listen('pointerdown', event => {
    if (event.button !== 0) return
    const p = point(event); pointers.set(event.pointerId, p); container.setPointerCapture(event.pointerId)
    if (pointers.size === 1) { down = { ...p }; gesture = false } else gesture = true
  })
  listen('pointermove', event => {
    const p = point(event), previous = pointers.get(event.pointerId)
    if (!previous) { container.style.cursor = hit(p.x, p.y) ? 'pointer' : ''; return }
    if (down && Math.hypot(p.x - down.x, p.y - down.y) > 5) gesture = true
    if (pointers.size === 1) setCamera({ x: camera.x + p.x - previous.x, y: camera.y + p.y - previous.y })
    else {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1]
      const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y), distance = Math.hypot(p.x - other.x, p.y - other.y)
      const oldX = (previous.x + other.x) / 2, oldY = (previous.y + other.y) / 2
      if (oldDistance > 0) zoom(distance / oldDistance, oldX, oldY)
      setCamera({ x: camera.x + (p.x - previous.x) / 2, y: camera.y + (p.y - previous.y) / 2 })
    }
    pointers.set(event.pointerId, p)
  })
  listen('pointerup', event => {
    if (!pointers.has(event.pointerId)) return
    const p = point(event)
    if (!gesture && pointers.size === 1 && down && Math.hypot(p.x - down.x, p.y - down.y) <= 5) options.onNodeSelected?.(hit(p.x, p.y)?.data || null)
    pointers.delete(event.pointerId)
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId)
    if (!pointers.size) down = null
  })
  listen('pointercancel', event => { pointers.delete(event.pointerId); gesture = true; down = null })
  listen('pointerleave', () => { container.style.cursor = '' })
  const observer = new ResizeObserver(resize); observer.observe(container)
  container.dataset.graphRenderer = 'canvas'; resize()
  const ready = initialize()
  return {
    camera, model, ready, requestRender, draw, setCamera, fit, hit,
    get renderer() { return renderer.type }, get fallbackReason() { return fallbackReason },
    get adapterInfo() { return renderer.adapterInfo },
    get dimensions() { return { width, height, pixelRatio } },
    flush: () => renderer.flush(),
    dispose() {
      if (disposed) return
      disposed = true; abort.abort(); observer.disconnect(); renderer.dispose(); pointers.clear()
      if (frame !== null) cancelAnimationFrame(frame)
      container.style.cursor = ''; delete container.dataset.graphRenderer
      container.removeAttribute('role'); container.removeAttribute('aria-label')
      for (const name of ['pan-x', 'pan-y', 'band-pan-x', 'band-pan-y', 'scale', 'band-scale']) (container.closest('#app') || container).style.removeProperty(`--galaxy-${name}`)
      container.replaceChildren()
    },
  }
}
