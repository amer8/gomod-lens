import { renderSidebar } from './sidebar-view.js'
import { createGraphLoadingView } from './graph-loading.js'

export function createApplication({ client, graphView, createAnalysisViews, createModuleVersionPicker }) {
  const { applyHighlightRequest, setAnalysisColors, clearGraph, renderGraph, selectNode, setGraphLens } = graphView
  const moduleSuggestionDelay = 220
  const maxModuleSuggestions = 6

  const elements = {
    form: document.getElementById('search-form'),
    input: document.getElementById('module-target'),
    button: document.getElementById('analyze-button'),
    progress: document.getElementById('graph-progress'),
    cancelLoading: document.getElementById('cancel-graph-loading'),
    errors: document.getElementById('graph-errors'),
    errorMessage: document.getElementById('error-message'),
    graphCanvas: document.getElementById('graph-canvas'),
    graphResult: document.getElementById('graph-result'),
    leftPanel: document.getElementById('left-panel'),
    navbar: document.getElementById('navbar-component'),
    suggestions: null,
  }

  let moduleSuggestionTimer = null
  let moduleSuggestionController = null
  let moduleSuggestions = []
  let activeModuleSuggestion = -1

  const versionPicker = createModuleVersionPicker(elements.form, elements.input)
  const analysisViews = createAnalysisViews({selectNode, setGraphLens, setColors:setAnalysisColors, highlight:applyHighlightRequest})
  const loadingView = createGraphLoadingView(elements.progress)

  let graphController = null
  let routedTarget = null

  elements.cancelLoading.addEventListener('click', () => {
    resetGraph()
    elements.input.focus()
  })

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

    const moduleLink = event.target.closest('[data-module-target]')
    if (moduleLink) {
      event.preventDefault()
      previewModule(moduleLink.dataset.moduleTarget || '')
      return
    }

  })

  window.addEventListener('hashchange', syncFromHash)
  window.addEventListener('popstate', syncFromHash)
  syncFromHash()

  function parseHash() {
    const raw = window.location.hash.replace(/^#/, '')
    const params = new URLSearchParams(raw)
    const target = normalizeModuleTarget(params.get('target')?.trim() || '')
    return { target }
  }

  function syncFromHash() {
    const route = parseHash()
    if (route.target === routedTarget) return
    routedTarget = route.target
    elements.input.value = route.target
    if (!route.target) {
      resetGraph()
      return
    }

    void loadGraph(route.target)
  }

  function resetGraph() {
    versionPicker.clear()
    analysisViews.loading()
    graphController?.abort()
    graphController = null
    setLoading(false)
    setError('')
    setGraphResult(emptyGraphResult())
    clearGraph(elements.graphCanvas)
    setGraphLoaded(false)
  }

  function resolvedModuleTarget() {
    return versionPicker.target(normalizeModuleTarget(elements.input.value))
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
    routedTarget = target
    elements.input.value = target

    const nextParams = new URLSearchParams({ target })
    const next = nextParams.toString()
    if (window.location.hash.replace(/^#/, '') !== next) {
      window.history.replaceState(null, '', `#${next}`)
    }
  }

  async function loadGraph(target) {
    graphController?.abort()
    const own = graphController = new AbortController()
    versionPicker.loading(); analysisViews.loading(); hideModuleSuggestions()
    setGraphResult(emptyGraphResult()); clearGraph(elements.graphCanvas)
    setGraphLoaded(false); setLoading(true, target); setError('')
    try {
      const payload = await client.loadGraph(target, {
        signal: own.signal,
        onProgress(progress) { if (graphController === own && !own.signal.aborted) loadingView.update(progress) },
      })
      if (graphController !== own || own.signal.aborted) return
      if (!hasCompleteBuiltInLensData(payload)) throw new Error('Built-in lens data was not included in the graph response')
      await loadingView.finish()
      if (graphController !== own || own.signal.aborted) return
      syncResolvedTarget(payload?.meta?.target || target)
      setGraphResult(renderSidebar(payload))
      await renderGraph(elements.graphCanvas, payload, { onNodeSelected(node) {
        selectNode(node?.id || ''); analysisViews.select(node)
      } })
      if (graphController !== own || own.signal.aborted) return
      setLoading(false); setError(''); setGraphLoaded(true)
      void versionPicker.capture(payload); void analysisViews.capture(payload)
    } catch (error) {
      if (graphController !== own || own.signal.aborted) return
      versionPicker.clear(); setLoading(false); setError(error?.message || 'Unable to load graph')
      setGraphResult(errorGraphResult(error?.message || 'Unable to load graph'))
      clearGraph(elements.graphCanvas); setGraphLoaded(false)
    }
  }

  function setGraphResult(result) {
    elements.graphResult?.replaceWith(result)
    elements.graphResult = result
  }

  function emptyGraphResult() {
    const result = document.createElement('div')
    result.id = 'graph-result'; result.dataset.state = 'empty'
    return result
  }

  function errorGraphResult(message) {
    const result = emptyGraphResult()
    result.dataset.state = 'error'; result.dataset.error = message
    return result
  }

  function hasCompleteBuiltInLensData(payload) {
    if (!Array.isArray(payload?.nodes)) return false

    const lensIDs = new Set((payload?.meta?.lenses || []).map((lens) => lens?.id).filter(Boolean))
    for (const lensID of ['openssf', 'release-freshness']) {
      if (!lensIDs.has(lensID)) continue
      if (!payload.nodes.every((node) => node?.lenses?.[lensID]?.status)) return false
    }
    return true
  }

  function setGraphLoaded(value) {
    elements.leftPanel?.classList.toggle('left-panel-empty', !value)
    elements.navbar?.classList.toggle('navbar-component-empty', !value)
  }

  function setLoading(value, target) {
    elements.button.disabled = value
    elements.input.disabled = value
    elements.form.hidden = value
    elements.leftPanel?.classList.toggle('is-loading', value)
    elements.graphCanvas?.setAttribute('aria-busy', String(value))
    if (value) loadingView.show(target)
    else loadingView.hide()
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
    hideModuleSuggestions()
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
    const own = moduleSuggestionController = new AbortController()
    client.searchModules(query, maxModuleSuggestions, own.signal).then(results => {
      if (moduleSuggestionController !== own || own.signal.aborted || normalizeModuleSearchQuery(elements.input?.value || '') !== query) return
      renderModuleSuggestions(Array.isArray(results) ? results : [])
    }).catch(error => {
      if (moduleSuggestionController === own && !own.signal.aborted) renderModuleSuggestions([])
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

}
