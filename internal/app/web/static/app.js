import {
  applyHighlightRequest,
  clearGraph,
  renderGraph,
  selectNode,
  setGraphLens,
} from './graph.js'

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
  leftPanel: document.getElementById('left-panel'),
  navbar: document.getElementById('navbar-component'),
  suggestions: null,
}

let loadingProgress = 0
let loadingProgressTimer = null
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
    const ids = parseIDs(highlightLink.dataset.highlightIds)
    applyHighlightRequest({
      ids,
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

document.body.addEventListener('htmx:afterSettle', () => {
  handleGraphResult()
})

document.body.addEventListener('htmx:responseError', (event) => {
  const detail = event.detail || {}
  setLoading(false)
  setError(detail.xhr?.responseText || 'Unable to load graph')
  clearGraph(elements.graphCanvas)
  setGraphLoaded(false)
})

document.body.addEventListener('htmx:sendError', () => {
  setLoading(false)
  setError('Unable to send graph request')
})

window.addEventListener('hashchange', syncFromHash)
syncFromHash()

function readJSONScript(id) {
  const script = document.getElementById(id)
  if (!script?.textContent) return null
  try {
    return JSON.parse(script.textContent)
  } catch {
    return null
  }
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

function normalizeModuleTarget(target) {
  const normalized = target.trim()
  if (!normalized || isLikelyLocalTarget(normalized)) {
    return ''
  }
  return normalized
}

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

  loadGraph(route.target)
}

function resetGraph() {
  setLoading(false)
  setError('')
  const result = document.getElementById('graph-result')
  if (result) {
    result.outerHTML = '<div id="graph-result" data-state="empty"></div>'
  }
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
      loadGraph(target)
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

function loadGraph(target) {
  if (!window.htmx?.ajax) {
    setError('htmx did not load')
    return
  }

  const params = new URLSearchParams({ target })
  hideModuleSuggestions()
  setLoading(true)
  setError('')
  window.htmx.ajax('GET', `/graph?${params.toString()}`, {
    target: '#graph-result',
    swap: 'outerHTML',
  })
}

function handleGraphResult() {
  const result = document.getElementById('graph-result')
  if (!result) return

  const state = result.dataset.state
  if (state === 'loaded') {
    const payload = readJSONScript('graph-payload')
    if (!payload) {
      setLoading(false)
      setError('Graph response did not include data')
      clearGraph(elements.graphCanvas)
      setGraphLoaded(false)
      return
    }
    if (!hasCompleteBuiltInLensData(payload)) {
      setLoading(false)
      setError('Built-in lens data was not included in the graph response')
      clearGraph(elements.graphCanvas)
      setGraphLoaded(false)
      return
    }

    syncResolvedTarget(result.dataset.target || payload?.meta?.target || '')
    completeLoadingProgress()
    window.setTimeout(() => {
      renderGraph(elements.graphCanvas, payload, {
        onNodeSelected: (node) => {
          selectNode(node?.id || '')
        },
      })
      setGraphLens(activeLensID())
      setLoading(false)
      setError('')
      setGraphLoaded(true)
    }, 120)
    return
  }

  if (state === 'error') {
    setLoading(false)
    setError(result.dataset.error || 'Unable to load graph')
    clearGraph(elements.graphCanvas)
    setGraphLoaded(false)
    return
  }

  if (state === 'empty') {
    setLoading(false)
    clearGraph(elements.graphCanvas)
    setGraphLoaded(false)
  }
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
  if (value) {
    startLoadingProgress()
  } else {
    clearLoadingProgressTimer()
  }
}

function startLoadingProgress() {
  loadingProgress = 0
  elements.progressValue.textContent = String(loadingProgress)
  clearLoadingProgressTimer()
  loadingProgressTimer = window.setInterval(() => {
    if (loadingProgress >= 95) return

    if (loadingProgress < 35) {
      loadingProgress = Math.min(loadingProgress + 7, 35)
    } else if (loadingProgress < 70) {
      loadingProgress = Math.min(loadingProgress + 4, 70)
    } else {
      loadingProgress = Math.min(loadingProgress + 1, 95)
    }
    elements.progressValue.textContent = String(loadingProgress)
  }, 350)
}

function completeLoadingProgress() {
  clearLoadingProgressTimer()
  loadingProgress = 100
  elements.progressValue.textContent = String(loadingProgress)
}

function clearLoadingProgressTimer() {
  if (!loadingProgressTimer) return
  window.clearInterval(loadingProgressTimer)
  loadingProgressTimer = null
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

  const params = new URLSearchParams({
    q: query,
    limit: String(maxModuleSuggestions),
  })

  window.fetch(`/api/modules/search?${params.toString()}`, {
    signal: moduleSuggestionController.signal,
    headers: { Accept: 'application/json' },
  }).then((response) => {
    if (!response.ok) return { results: [] }
    return response.json()
  }).then((payload) => {
    if (normalizeModuleSearchQuery(elements.input?.value || '') !== query) return
    renderModuleSuggestions(Array.isArray(payload?.results) ? payload.results : [])
  }).catch((error) => {
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

function normalizeModuleSearchQuery(target) {
  return (target || '').trim().split('@')[0].trim()
}

function shouldSearchModuleQuery(query) {
  if (!query || isLikelyLocalTarget(query)) return false
  const firstSegment = query.split('/')[0] || ''
  return !firstSegment.includes('.')
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
