import {
  applyHighlightRequest,
  clearGraph,
  renderGraph,
  selectNode,
  setGraphLens,
} from './graph.js'
import {
  resolveGraph,
  searchModules,
} from './wasm-client.js'

const moduleSuggestionDelay = 220
const maxModuleSuggestions = 6

const elements = {
  form: document.getElementById('search-form'),
  input: document.getElementById('module-target'),
  button: document.getElementById('analyze-button'),
  progress: document.getElementById('graph-progress'),
  progressValue: document.getElementById('loading-progress'),
  errors: document.getElementById('graph-errors'),
  errorMessage: document.getElementById('error-message'),
  graphCanvas: document.getElementById('graph-canvas'),
  graphResult: document.getElementById('graph-result'),
  leftPanel: document.getElementById('left-panel'),
  navbar: document.getElementById('navbar-component'),
  suggestions: null,
}

let graphController = null
let moduleSuggestionTimer = null
let moduleSuggestionController = null
let moduleSuggestions = []
let activeModuleSuggestion = -1

setupModuleSuggestions()

elements.form?.addEventListener('submit', (event) => {
  event.preventDefault()
  submitRequest()
})

elements.input?.addEventListener('input', () => {
  scheduleModuleSuggestions()
})

elements.input?.addEventListener('focus', () => {
  scheduleModuleSuggestions()
})

elements.input?.addEventListener('keydown', (event) => {
  if (!moduleSuggestions.length || elements.suggestions?.hidden) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    setActiveModuleSuggestion((activeModuleSuggestion + 1) % moduleSuggestions.length)
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    setActiveModuleSuggestion((activeModuleSuggestion - 1 + moduleSuggestions.length) % moduleSuggestions.length)
    return
  }

  if (event.key === 'Enter' && activeModuleSuggestion >= 0) {
    event.preventDefault()
    chooseModuleSuggestion(activeModuleSuggestion)
    return
  }

  if (event.key === 'Escape') {
    hideModuleSuggestions()
  }
})

document.addEventListener('click', (event) => {
  const suggestion = event.target.closest('[data-module-suggestion]')
  if (suggestion) {
    event.preventDefault()
    chooseModuleSuggestion(Number(suggestion.dataset.moduleSuggestion))
    return
  }

  if (!event.target.closest('#search-form')) {
    hideModuleSuggestions()
  }

  const highlightLink = event.target.closest('[data-highlight-ids]')
  if (highlightLink) {
    event.preventDefault()
    applyHighlightRequest({
      ids: parseIDs(highlightLink.dataset.highlightIds),
      color: highlightLink.dataset.highlightColor || '',
      nodesOnly: highlightLink.dataset.highlightNodesOnly === 'true',
    })
    return
  }

  const lensButton = event.target.closest('[data-lens-panel-target]')
  if (lensButton) {
    event.preventDefault()
    activateLensPanel(lensButton.dataset.lensPanelTarget || '')
    return
  }

  const moduleLink = event.target.closest('[data-module-target]')
  if (moduleLink) {
    event.preventDefault()
    previewModule(moduleLink.dataset.moduleTarget || '')
    return
  }

})

window.addEventListener('hashchange', syncFromHash)
syncFromHash()

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '')
  const params = new URLSearchParams(raw)
  const target = normalizeModuleTarget(params.get('target')?.trim() || '')
  return { target }
}

function syncFromHash() {
  const route = parseHash()
  elements.input.value = route.target
  if (!route.target) {
    resetGraph()
    return
  }

  void loadGraph(route.target)
}

function resetGraph() {
  graphController?.abort()
  graphController = null
  setLoading(false)
  setError('')
  setGraphResult(emptyGraphResult())
  clearGraph(elements.graphCanvas)
  setGraphLoaded(false)
}

function resolvedModuleTarget() {
  return normalizeModuleTarget(elements.input.value)
}

function submitRequest() {
  const target = resolvedModuleTarget()
  elements.input.value = target
  hideModuleSuggestions()

  const nextParams = new URLSearchParams()
  if (target) {
    nextParams.set('target', target)
  }
  const next = nextParams.toString()
  if (window.location.hash.replace(/^#/, '') === next) {
    if (target) {
      void loadGraph(target)
      return
    }
    resetGraph()
    return
  }

  window.location.hash = next
}

function previewModule(target) {
  elements.input.value = target
  hideModuleSuggestions()
  submitRequest()
}

function syncResolvedTarget(target) {
  target = normalizeModuleTarget(target)
  if (!target) return
  elements.input.value = target

  const nextParams = new URLSearchParams({ target })
  const next = nextParams.toString()
  if (window.location.hash.replace(/^#/, '') !== next) {
    window.history.replaceState(null, '', `#${next}`)
  }
}

async function loadGraph(target) {
  graphController?.abort()
  graphController = new AbortController()

  hideModuleSuggestions()
  setLoading(true)
  setLoadingProgress(0)
  setError('')
  setGraphLoaded(false)

  try {
    const payload = await resolveGraph(target, {
      signal: graphController.signal,
      onProgress: ({ value }) => setLoadingProgress(value),
    })

    if (!hasCompleteBuiltInLensData(payload)) {
      throw new Error('Built-in lens data was not included in the graph response')
    }

    syncResolvedTarget(payload?.meta?.target || target)
    completeLoadingProgress()
    setGraphResult(renderSidebar(payload))
    renderGraph(elements.graphCanvas, payload, {
      onNodeSelected: (node) => {
        selectNode(node?.id || '')
      },
    })
    setGraphLens(activeLensID())
    setLoading(false)
    setError('')
    setGraphLoaded(true)
  } catch (error) {
    if (error?.name === 'AbortError') return
    setLoading(false)
    setError(error?.message || 'Unable to load graph')
    setGraphResult(errorGraphResult(error?.message || 'Unable to load graph'))
    clearGraph(elements.graphCanvas)
    setGraphLoaded(false)
  }
}

function renderSidebar(payload) {
  const viewModel = payload?.viewModel || {}
  const result = el('div', {
    id: 'graph-result',
    dataset: {
      state: 'loaded',
      target: payload?.meta?.target || '',
    },
  })
  const infoBox = el('div', { className: 'infoBox' })
  const packageInfo = el('div', { className: 'packageInfo' })

  if (viewModel.lensPanels?.length) {
    packageInfo.append(lensSection(viewModel.lensPanels))
  }

  packageInfo.append(
    groupSection('Relation groups', viewModel.relationGroups || [], highlightRow),
  )

  packageInfo.append(
    groupSection('Module origins', viewModel.originGroups || [], highlightRow),
    groupSection('Dependency hubs', viewModel.nameEntries || [], nameRow),
  )

  infoBox.append(
    el('a', { className: 'hide-info-box', href: '#' }, 'show graph'),
    packageInfo,
  )
  result.append(infoBox)
  return result
}

function lensSection(panels) {
  const section = el('div', { className: 'all-licenses lens-section' })
  const headingRow = el('div', { className: 'lens-heading-row' })
  const switcher = el('div', { className: 'lens-switcher', 'aria-label': 'Analysis lenses' })
  panels.forEach((panel) => {
    switcher.append(lensCircle(panel))
  })
  switcher.append(el('a', {
    className: 'lens-circle lens-circle-add',
    href: 'https://github.com/amer8/gomod-lens/blob/main/CONTRIBUTING.md#adding-lenses',
    target: '_blank',
    rel: 'noreferrer',
    'aria-label': 'Learn how to add a lens',
    title: 'Add a lens',
  }))
  headingRow.append(el('h4', {}, 'Lenses'), switcher)
  section.append(headingRow)
  panels.forEach((panel) => {
    section.append(lensPanel(panel))
  })
  return section
}

function lensCircle(panel) {
  const attrs = {
    type: 'button',
    className: `lens-circle lens-circle-${panel.id}${panel.active ? ' lens-circle-active' : ''}`,
    dataset: { lensPanelTarget: panel.id },
    title: panel.name,
    'aria-label': panel.name,
  }
  if (panel.active) {
    attrs['aria-current'] = 'true'
  }
  return el('button', attrs)
}

function lensPanel(panel) {
  const section = el('div', {
    className: 'lens-panel',
    dataset: { lensPanel: panel.id },
    hidden: !panel.active,
  })
  section.append(
    el('div', { className: 'lens-panel-heading' },
      el('span', {}, panel.name),
      el('span', { className: 'last' }, String(panel.count))),
  )
  const container = el('div', { className: 'license-container' })
  const groups = panel.groups || []
  groups.forEach((entry) => {
    container.append(scoreRow(entry))
  })
  section.append(container)
  return section
}

function groupSection(title, entries, rowRenderer) {
  const section = el('div', { className: 'all-licenses' })
  section.append(el('h4', {}, title))
  const container = el('div', { className: 'license-container' })
  entries.forEach((entry) => {
    container.append(rowRenderer(entry))
  })
  section.append(container)
  return section
}

function highlightRow(entry) {
  return el('a', {
    className: 'license-row',
    href: entry.href,
    dataset: {
      highlightIds: entry.idsJSON,
      highlightColor: entry.color || '',
      highlightNodesOnly: entry.nodesOnlyString,
    },
  }, el('span', {}, entry.name), el('span', { className: 'last' }, String(entry.count)))
}

function scoreRow(entry) {
  return el('a', {
    className: 'license-row score-row',
    href: entry.href,
    dataset: {
      highlightIds: entry.idsJSON,
      highlightColor: entry.color || '',
      highlightNodesOnly: entry.nodesOnlyString,
    },
  },
  el('span', {}, el('i', { className: 'score-swatch', style: { backgroundColor: entry.color } }), entry.name),
  el('span', { className: 'last' }, String(entry.count)))
}

function nameRow(entry) {
  const attrs = {
    className: 'license-row',
    href: entry.href,
    title: entry.title,
  }

  if (entry.count === 1) {
    attrs.dataset = { moduleTarget: entry.target }
  } else {
    attrs.dataset = {
      highlightIds: entry.idsJSON,
      highlightColor: entry.color || '',
      highlightNodesOnly: entry.nodesOnlyString,
    }
  }

  return el('a', attrs,
    el('span', { className: 'truncate' }, entry.name),
    el('span', { className: 'last module-dependency-count' }, String(entry.dependencyCount)))
}

function setGraphResult(result) {
  elements.graphResult?.replaceWith(result)
  elements.graphResult = result
}

function emptyGraphResult() {
  return el('div', { id: 'graph-result', dataset: { state: 'empty' } })
}

function errorGraphResult(message) {
  return el('div', {
    id: 'graph-result',
    dataset: {
      state: 'error',
      error: message,
    },
  })
}

function hasCompleteBuiltInLensData(payload) {
  if (!Array.isArray(payload?.nodes)) return false

  const lensIDs = new Set((payload?.meta?.lenses || []).map((lens) => lens?.id).filter(Boolean))
  for (const lensID of ['openssf', 'release-freshness']) {
    if (!lensIDs.has(lensID)) continue
    if (!payload.nodes.every((node) => lensResult(node, lensID)?.status)) return false
  }
  return true
}

function lensResult(node, lensID) {
  if (lensID === 'openssf') return node?.lenses?.openssf || node?.openssf
  return node?.lenses?.[lensID]
}

function activateLensPanel(lensID) {
  lensID = lensID.trim()
  if (!lensID) return

  const result = document.getElementById('graph-result')
  if (!result) return

  const buttons = result.querySelectorAll('[data-lens-panel-target]')
  const panels = result.querySelectorAll('[data-lens-panel]')
  buttons.forEach((button) => {
    const active = button.dataset.lensPanelTarget === lensID
    button.classList.toggle('lens-circle-active', active)
    if (active) {
      button.setAttribute('aria-current', 'true')
    } else {
      button.removeAttribute('aria-current')
    }
  })
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.lensPanel !== lensID
  })
  setGraphLens(lensID)
}

function activeLensID() {
  const result = document.getElementById('graph-result')
  const activeButton = result?.querySelector('[data-lens-panel-target].lens-circle-active')
  return activeButton?.dataset.lensPanelTarget || 'openssf'
}

function setGraphLoaded(value) {
  elements.leftPanel?.classList.toggle('left-panel-empty', !value)
  elements.navbar?.classList.toggle('navbar-component-empty', !value)
}

function setLoading(value) {
  elements.button.disabled = value
  elements.progress.hidden = !value
}

function setLoadingProgress(value) {
  const progress = Math.max(0, Math.min(100, Math.round(value)))
  elements.progressValue.textContent = String(progress)
}

function completeLoadingProgress() {
  setLoadingProgress(100)
}

function setError(message) {
  elements.errors.hidden = !message
  elements.errorMessage.textContent = message
}

function setupModuleSuggestions() {
  if (!elements.form || !elements.input) return

  const suggestions = document.createElement('div')
  suggestions.id = 'module-suggestions'
  suggestions.className = 'module-suggestions'
  suggestions.hidden = true
  suggestions.setAttribute('role', 'listbox')
  suggestions.setAttribute('aria-label', 'Module suggestions')
  elements.input.setAttribute('aria-controls', suggestions.id)
  elements.input.setAttribute('aria-autocomplete', 'list')

  const controlStack = elements.form.querySelector('.control-stack')
  if (controlStack) {
    controlStack.append(suggestions)
  }
  elements.suggestions = suggestions
}

function scheduleModuleSuggestions() {
  clearModuleSuggestionTimer()
  const query = normalizeModuleSearchQuery(elements.input?.value || '')
  if (!shouldSearchModuleQuery(query)) {
    hideModuleSuggestions()
    return
  }

  moduleSuggestionTimer = window.setTimeout(() => {
    fetchModuleSuggestions(query)
  }, moduleSuggestionDelay)
}

function fetchModuleSuggestions(query) {
  moduleSuggestionController?.abort()
  moduleSuggestionController = new AbortController()

  searchModules(query, maxModuleSuggestions, moduleSuggestionController.signal)
    .then((results) => {
      if (normalizeModuleSearchQuery(elements.input?.value || '') !== query) return
      renderModuleSuggestions(results)
    })
    .catch((error) => {
      if (error?.name !== 'AbortError') {
        renderModuleSuggestions([])
      }
    })
}

function renderModuleSuggestions(results) {
  moduleSuggestions = results.filter((result) => result?.path)
  activeModuleSuggestion = -1
  if (!elements.suggestions || !moduleSuggestions.length) {
    hideModuleSuggestions()
    return
  }

  elements.suggestions.replaceChildren(...moduleSuggestions.map((result, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'module-suggestion'
    button.dataset.moduleSuggestion = String(index)
    button.setAttribute('role', 'option')

    const main = document.createElement('span')
    main.className = 'module-suggestion-main'
    main.textContent = result.path
    button.append(main)

    const meta = document.createElement('span')
    meta.className = 'module-suggestion-meta'
    meta.textContent = moduleSuggestionMeta(result)
    button.append(meta)

    return button
  }))
  elements.suggestions.hidden = false
}

function moduleSuggestionMeta(result) {
  const bits = []
  if (result.description) {
    bits.push(result.description)
  }
  if (result.stars) {
    bits.push(`${formatCount(result.stars)} stars`)
  }
  return bits.join('  ')
}

function setActiveModuleSuggestion(index) {
  activeModuleSuggestion = index
  elements.suggestions?.querySelectorAll('[data-module-suggestion]').forEach((item, itemIndex) => {
    item.classList.toggle('module-suggestion-active', itemIndex === index)
    item.setAttribute('aria-selected', itemIndex === index ? 'true' : 'false')
  })
}

function chooseModuleSuggestion(index) {
  const suggestion = moduleSuggestions[index]
  if (!suggestion?.path) return
  elements.input.value = suggestion.path
  hideModuleSuggestions()
  submitRequest()
}

function hideModuleSuggestions() {
  clearModuleSuggestionTimer()
  moduleSuggestionController?.abort()
  moduleSuggestionController = null
  moduleSuggestions = []
  activeModuleSuggestion = -1
  if (elements.suggestions) {
    elements.suggestions.hidden = true
    elements.suggestions.replaceChildren()
  }
}

function clearModuleSuggestionTimer() {
  if (!moduleSuggestionTimer) return
  window.clearTimeout(moduleSuggestionTimer)
  moduleSuggestionTimer = null
}

function normalizeModuleTarget(target) {
  const normalized = target.trim()
  if (!normalized || isLikelyLocalTarget(normalized)) {
    return ''
  }
  return normalized
}

function normalizeModuleSearchQuery(target) {
  return (target || '').trim().split('@')[0].trim()
}

function shouldSearchModuleQuery(query) {
  if (!query || isLikelyLocalTarget(query)) return false
  const firstSegment = query.split('/')[0] || ''
  return !firstSegment.includes('.')
}

function isLikelyLocalTarget(target) {
  if (!target) return false
  return (
    target === '.' ||
    target === '..' ||
    target.startsWith('./') ||
    target.startsWith('../') ||
    target.startsWith('/') ||
    target.endsWith('.mod')
  )
}

function formatCount(value) {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`
  }
  return String(value)
}

function parseIDs(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function el(tagName, attrs = {}, ...children) {
  const node = document.createElement(tagName)
  const { dataset, style, ...rest } = attrs || {}

  Object.entries(rest).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    if (key === 'className') {
      node.className = value
    } else if (key in node) {
      node[key] = value
    } else {
      node.setAttribute(key, value)
    }
  })

  if (dataset) {
    Object.entries(dataset).forEach(([key, value]) => {
      node.dataset[key] = value
    })
  }

  if (style) {
    Object.entries(style).forEach(([key, value]) => {
      node.style[key] = value
    })
  }

  for (const child of children.flat()) {
    if (child === undefined || child === null) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }

  return node
}
