import { clearPublicCache } from './public-data.js'
import { browserLenses, defaultLensID } from './registry.js'
import { element, action, notice } from './ui.js'
import { selectedLens, lensURL } from './navigation.js'
import { createGraphAssistant } from '../assistant/index.js'
import { createLensTooltip } from './lens-tooltip.js'
export function createAnalysisViews({ selectNode, setColors, highlight }) {
  const ready = Promise.all(browserLenses.map(async registration => ({
    ...(await registration.importModule()).default,
    ...registration,
  })))
  let graph = null, selected = '', generation = 0, controller = null
  let modules = [], active = null
  let preferred = selectedLens(new URLSearchParams(window.location.search).get('lens'))
  const panels = new Map(), results = new Map(), requests = new Map(), states = new Map()
  window.history.replaceState(window.history.state, '', lensURL(window.location.href, preferred))
  const app = document.getElementById('app')
  const resetLensTooltip = createLensTooltip(document.getElementById('lens-toolbar'), app)
  const assistant = createGraphAssistant({ app, select, highlight,
    openLens(id) { document.querySelector(`#lens-toolbar [data-lens-panel-target="${id}"]`)?.click() },
    async loadEvidence(id, nodeID, signal) {
      const module = modules.find(value => value.id === id)
      if (!module || !graph || !controller) throw new Error('Load a module graph first.')
      const capturedGraph = graph, node = graph.nodes.find(value => value.id === nodeID)
      if (!node) throw new Error('The selected module is no longer in this graph.')
      const key = module.selection ? module.key + ':' + nodeID : module.key
      if (requests.has(key)) await requests.get(key)
      signal.throwIfAborted()
      if (results.has(key)) return results.get(key)
      return module.load(capturedGraph, { node, signal: AbortSignal.any([signal, controller.signal]), progress() {} })
    },
  })
  function syncAssistant() { if (graph && controller) assistant.setContext({ graph, selected, lens: preferred }) }
  function layout() { app.dataset.analysisLens = active?.id || preferred }
  layout()
  // Abort upstream work and invalidate completions from the previous graph.
  const stop = () => {
    resetLensTooltip()
    assistant.loading()
    generation++
    controller?.abort()
    controller = null
    const toolbar = document.getElementById('lens-toolbar'); if (toolbar) toolbar.hidden = true
    for (const panel of panels.values()) {
      panel.querySelector('.analysis-body')?.replaceChildren(notice('Loading the new module graph…'))
      const status = panel.querySelector('.analysis-status'); if (status) status.textContent = 'Waiting for graph…'
      const refresh = panel.querySelector('.analysis-refresh'); if (refresh) refresh.disabled = true
      const picker = panel.querySelector('.analysis-module-select'); if (picker) picker.disabled = true
      panel.setAttribute('aria-busy', 'true')
    }
    panels.clear()
    results.clear()
    requests.clear()
    states.clear()
    active = null
    setColors(null)
  }
  function choose(id) {
    id = selectedLens(id); preferred = id
    window.history.replaceState(window.history.state, '', lensURL(window.location.href, id))
    const module = modules.find(module => module.id === id)
    if (active?.id !== id) {
      highlight({ ids: [] })
      const scroll = panels.get(module?.key)?.closest('.infoBox')
      if (scroll) scroll.scrollTop = 0
    }
    if (!module || !graph) { active = null; setColors(null); return }
    active = module
    syncAssistant()
    layout()
    paint(); void render(module)
  }
  function paint() {
    const data = results.get(active?.key)
    setColors(active?.colors && data ? active.colors(graph, data, selected) : null)
  }
  function select(id) {
    if (!graph?.nodes.some(node => node.id === id)) return
    selected = id; selectNode(id)
    syncAssistant()
    paint()
    if (active) {
      const fromTable = document.activeElement?.closest('.analysis-module')
      void render(active)
      const panel = panels.get(active.key)
      const scroll = panel?.closest('.infoBox')
      if (scroll) scroll.scrollTop = 0
      if (fromTable) panel?.querySelector('.analysis-module-select')?.focus({ preventScroll: true })
    }
  }
  async function render(module, refresh = false) {
    const panel = panels.get(module.key); if (!panel || !graph) return
    // Repository reports load per selection; inventories load once per graph.
    const requestKey = module.selection ? module.key + ':' + selected : module.key
    if (refresh) { clearPublicCache(); assistant.invalidate(module.id, selected); results.delete(requestKey); results.delete(module.key); paint() }
    if (module.selection && results.has(requestKey)) results.set(module.key, results.get(requestKey))
    const data = module.selection ? results.get(requestKey) : results.get(module.key)
    const host = panel.querySelector('.analysis-body'), status = panel.querySelector('.analysis-status'), retry = panel.querySelector('.analysis-refresh')
    const selectedControl = panel.querySelector('.analysis-module-select')
    if (selectedControl) selectedControl.value = selected
    panel.querySelector('.analysis-selected-name').textContent = graph.nodes.find(n => n.id === selected)?.name || ''
    if (data !== undefined) {
      assistant.observe(module.id, data, selected)
      panel.removeAttribute('aria-busy')
      status.textContent = module.status?.(data) || 'Analysis ready'; retry.disabled = false
      if (!states.has(module.key)) states.set(module.key, {})
      const node = graph.nodes.find(n => n.id === selected)
      host.replaceChildren(); module.render({ host, graph, node, data, select, highlight, state: states.get(module.key) })
      for (const button of host.querySelectorAll('[data-node-id]')) {
        if (button.dataset.nodeId === selected) button.setAttribute('aria-current', 'true')
      }
      if (active === module) paint()
      return
    }
    host.replaceChildren(notice(module.selection ? 'Loading the selected repository’s public report…' : 'Reading exact public module versions…'))
    status.textContent = 'Loading…'; retry.disabled = true; panel.setAttribute('aria-busy', 'true')
    if (requests.has(requestKey)) return
    const current = generation, capturedGraph = graph, capturedNode = graph.nodes.find(n => n.id === selected)
    const request = (async () => {
      try {
        const result = await module.load(capturedGraph, { node: capturedNode, signal: controller.signal, progress(done, total) { if (current === generation) status.textContent = `Loading ${done} of ${total} modules…` } })
        if (current !== generation) return
        results.set(requestKey, result)
        if (!module.selection || selected === capturedNode.id) results.set(module.key, result)
      } catch (error) {
        if (current !== generation) return
        results.set(requestKey, { error: error.message || 'Public data unavailable' })
        if (!module.selection || selected === capturedNode.id) results.set(module.key, results.get(requestKey))
      } finally {
        if (current === generation) { requests.delete(requestKey); panel.removeAttribute('aria-busy'); if (active === module) void render(module) }
      }
    })()
    requests.set(requestKey, request)
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-lens-panel-target]')
    if (button) choose(button.dataset.lensPanelTarget)
  })
  window.addEventListener('popstate', () => {
    const id = selectedLens(new URLSearchParams(window.location.search).get('lens'))
    const button = [...document.querySelectorAll('#lens-toolbar [data-lens-panel-target]')].find(button => button.dataset.lensPanelTarget === id)
    if (button && !document.getElementById('lens-toolbar').hidden) button.click(); else preferred = id
  })
  return {
    loading: stop,
    select(node) { if (node?.id) select(node.id) },
    async capture(payload) {
      stop(); graph = payload; selected = payload.rootId; controller = new AbortController()
      const current = generation
      modules = await ready
      if (current !== generation) return
      const root = document.querySelector('.lens-section'), toolbar = document.getElementById('lens-toolbar')
      const heading = root?.querySelector('.lens-heading-row')
      if (heading && toolbar) toolbar.replaceChildren(heading)
      const switcher = toolbar?.querySelector('.lens-switcher')
      if (!root || !switcher) return
      switcher.querySelector('.lens-circle-add')?.removeAttribute('title')
      toolbar.hidden = false
      for (const module of modules) {
        let panel = root.querySelector(`[data-lens-panel="${module.id}"]`)
        let distribution
        if (panel) {
          distribution = element('details', undefined, 'analysis-distribution')
          distribution.append(element('summary', module.id === 'release-freshness' ? 'Graph release distribution' : 'Graph score distribution'))
          const groups = panel.querySelector('.license-container'); if (groups) distribution.append(groups)
          panel.replaceChildren()
        } else {
          panel = element('section', undefined, 'lens-panel'); panel.dataset.lensPanel = module.id; panel.hidden = true; root.append(panel)
        }
        let button = switcher.querySelector(`[data-lens-panel-target="${module.id}"]`)
        if (!button) {
          button = action('', () => {})
          button.dataset.lensPanelTarget = module.id
          switcher.insertBefore(button, switcher.querySelector('.lens-circle-add'))
        }
        button.className = `lens-circle lens-circle-${module.id}`
        button.textContent = module.icon
        button.removeAttribute('title')
        button.setAttribute('aria-label', module.label)
        panel.classList.add('analysis-view')
        const head = element('div', undefined, 'analysis-heading'), title = element('div')
        title.append(element('h4', module.title), element('span', module.scope, 'analysis-eyebrow'))
        const retry = action('Refresh', () => void render(module, true), 'analysis-refresh')
        const controls = element('div', undefined, 'analysis-heading-controls')
        const expand = action('Expand panel', () => {
          const expanded = root.closest('.left-panel').classList.toggle('analysis-expanded')
          expand.textContent = expanded ? 'Compact panel' : 'Expand panel'; expand.setAttribute('aria-expanded', String(expanded))
        }, 'analysis-expand')
        const expanded = root.closest('.left-panel').classList.contains('analysis-expanded')
        expand.textContent = expanded ? 'Compact panel' : 'Expand panel'; expand.setAttribute('aria-expanded', String(expanded))
        controls.append(expand, retry); head.append(title, controls)
        const selectedName = element('div', undefined, 'analysis-selected-name')
        panel.append(head, selectedName)
        if (module.selection || module.modulePicker) {
          const selectInput = element('select', undefined, 'analysis-module-select'); selectInput.setAttribute('aria-label', 'Module to inspect')
          payload.nodes.forEach(node => selectInput.append(new Option(node.name + (node.version ? '@' + node.version : ''), node.id)))
          selectInput.addEventListener('change', () => select(selectInput.value)); panel.append(selectInput)
        }
        const status = notice('', 'analysis-status'); status.setAttribute('role', 'status')
        panel.append(status, element('div', undefined, 'analysis-body')); if (distribution) panel.append(distribution)
        panels.set(module.key, panel)
      }
      const button = [...toolbar.querySelectorAll('[data-lens-panel-target]')].find(button => button.dataset.lensPanelTarget === preferred)
      if (button) button.click()
      else choose(defaultLensID)
    },
  }
}
