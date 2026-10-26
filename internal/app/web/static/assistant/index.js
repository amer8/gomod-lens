import { element, link } from '../analysis/ui.js'
import { suggestions, suggestionKey, answerQuestion, requiredEvidence } from './queries.js'
import { answerPreview } from './presentation.js'
import { LocalAI, inspectModelCache } from './local-ai.js'
import { loadingProgress, modelMarker } from './loading.js'
import { licenseQuery } from './license-query.js'
import { models, defaultModelID, findModel, filterModels, sortModels } from './models.js'
import { questionContext, customTopics, customPacket, recentHistory, customInvestigation } from './custom.js'

const button = (label, run, className = '') => {
  const value = element('button', label, className); value.type = 'button'; value.addEventListener('click', run); return value
}
const stopError = () => new DOMException('Stopped', 'AbortError')

// Owns conversation state only. Evidence is supplied by the lens controller;
// graph navigation is explicit and old snapshot actions are disabled on reload.
export function createGraphAssistant({ app, loadEvidence, select, highlight, openLens }) {
  let context = null, lastGraph = null, revision = 0, request = 0, controller = null, opened = false, expanded = false, panelHeight = 40
  let enabling = false, aiGeneration = 0, selectedModelID = defaultModelID, choosingModel = false
  let savedModels = new Map(), cacheCheck = 0, cacheChecked = false
  const conversation = { asked: [], turns: [] }
  const cache = new Map(), mobile = window.matchMedia('(max-width: 960px)')
  const launch = button('Ask AI', () => toggle(true), 'assistant-launch')
  launch.hidden = true; launch.id = 'graph-assistant-toggle'
  launch.setAttribute('aria-expanded', 'false'); launch.setAttribute('aria-controls', 'graph-assistant')
  const dock = element('section', undefined, 'assistant-dock'); dock.id = 'graph-assistant'; dock.hidden = true
  dock.setAttribute('aria-label', 'Graph assistant')
  const controls = element('div', undefined, 'assistant-controls')
  const minimise = button('−', () => setHeight(40), 'assistant-window-control')
  minimise.setAttribute('aria-label', 'Minimise chat to 40%'); minimise.title = 'Minimise to 40%'
  const resize = button('', () => setHeight(100), 'assistant-window-control assistant-resize')
  // Two opposing chevrons match the dock controls without opening a new window.
  const expandIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  expandIcon.setAttribute('viewBox', '0 0 24 24'); expandIcon.setAttribute('aria-hidden', 'true')
  const chevrons = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  chevrons.setAttribute('d', 'm8 8 4-4 4 4 M8 16l4 4 4-4'); expandIcon.append(chevrons); resize.append(expandIcon)
  resize.setAttribute('aria-controls', 'graph-assistant'); resize.setAttribute('aria-expanded', 'false')
  resize.setAttribute('aria-label', 'Expand chat'); resize.title = 'Expand chat'
  const close = button('×', () => toggle(false), 'assistant-window-control'); close.setAttribute('aria-label', 'Close graph assistant'); close.title = 'Close chat'
  const windowControls = element('div', undefined, 'assistant-window-controls'); windowControls.append(minimise, resize, close)
  controls.append(windowControls); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Chat panel controls')
  const grip = element('div', undefined, 'assistant-grip'); grip.tabIndex = 0
  grip.setAttribute('aria-controls', 'graph-assistant'); grip.setAttribute('role', 'separator'); grip.setAttribute('aria-label', 'Resize chat panel'); grip.setAttribute('aria-orientation', 'horizontal')
  grip.setAttribute('aria-valuemax', '100'); grip.setAttribute('aria-valuenow', '40')
  const modelGate = element('div', undefined, 'assistant-model-gate')
  const modelHeading = element('strong', 'Choose a local model'), modelIntro = element('p', 'Choose a model, then load it to start chatting.', 'assistant-model-intro')
  modelGate.append(modelHeading, modelIntro)
  const modelTableScroll = element('div', undefined, 'assistant-model-table-scroll')
  modelTableScroll.tabIndex = 0; modelTableScroll.setAttribute('role', 'region'); modelTableScroll.setAttribute('aria-label', 'Local model comparison, scroll for more options')
  const modelTable = element('table', undefined, 'assistant-model-table'); modelTable.setAttribute('aria-label', 'Compare local models')
  const modelTools = element('div', undefined, 'assistant-model-tools')
  const modelSearch = element('input'); modelSearch.type = 'search'; modelSearch.placeholder = 'Search models…'
  modelSearch.setAttribute('aria-label', 'Search supported models')
  const modelCount = element('span', undefined, 'assistant-model-count'); modelCount.setAttribute('role', 'status')
  modelTools.append(modelSearch, modelCount)
  const tableHead = element('thead'), headRow = element('tr'), sortHeaders = []
  let modelSort = null, modelDirection = 'ascending'
  for (const [key, text] of [['name', 'Model'], ['download', 'Download'], ['gpu', 'Memory needed']]) {
    const cell = element('th'); cell.scope = 'col'; cell.setAttribute('aria-sort', 'none')
    const sortButton = button('', () => {
      modelDirection = modelSort === key && modelDirection === 'ascending' ? 'descending' : 'ascending'
      modelSort = key; renderModelRows()
    }, 'assistant-model-sort')
    const arrow = element('span', '↕'); arrow.setAttribute('aria-hidden', 'true')
    sortButton.append(element('span', text), arrow); sortButton.setAttribute('aria-label', 'Sort by ' + text)
    cell.append(sortButton); headRow.append(cell); sortHeaders.push({ cell, key, arrow, sortButton, text })
  }
  tableHead.append(headRow)
  const tableBody = element('tbody'), modelChoices = []
  for (const model of models) {
    const row = element('tr'), identity = element('td'), label = element('label', undefined, 'assistant-model-option')
    const radio = element('input'); radio.type = 'radio'; radio.name = 'assistant-model'; radio.value = model.id; radio.checked = model.id === selectedModelID
    radio.setAttribute('aria-label', model.name); radio.setAttribute('aria-describedby', 'assistant-model-detail-' + modelChoices.length)
    const copy = element('span'), name = element('span', model.name, 'assistant-model-name')
    if (model.recommended) name.append(element('span', 'Recommended', 'assistant-model-badge'))
    const marker = element('span', undefined, 'assistant-model-badge assistant-model-marker'); marker.hidden = true; name.append(marker)
    const detail = element('small', model.detail); detail.id = 'assistant-model-detail-' + modelChoices.length
    copy.append(name, detail); label.append(radio, copy); identity.append(label)
    row.append(identity, element('td', model.download), element('td', model.gpu))
    radio.addEventListener('change', () => { if (radio.checked) { selectedModelID = model.id; updateModelChoice() } })
    modelChoices.push({ model, radio, row, marker })
  }
  const modelEmpty = element('tr'), modelEmptyCell = element('td', 'No models match your search.'); modelEmptyCell.colSpan = 3; modelEmpty.append(modelEmptyCell)
  function renderModelRows() {
    const matching = filterModels(models, modelSearch.value)
    const ordered = modelSort ? sortModels(matching, modelSort, modelDirection) : matching
    const choices = new Map(modelChoices.map(choice => [choice.model.id, choice.row]))
    tableBody.replaceChildren(...ordered.map(model => choices.get(model.id)))
    if (!ordered.length) tableBody.append(modelEmpty)
    for (const { radio, row } of modelChoices) { radio.checked = radio.value === selectedModelID; row.classList.toggle('is-selected', radio.checked) }
    modelCount.textContent = `${ordered.length === models.length ? models.length : ordered.length + ' of ' + models.length} models`
    for (const { cell, key, arrow, sortButton, text } of sortHeaders) {
      cell.setAttribute('aria-sort', modelSort === key ? modelDirection : 'none')
      arrow.textContent = modelSort === key ? modelDirection === 'ascending' ? '↑' : '↓' : '↕'
      sortButton.setAttribute('aria-label', 'Sort by ' + text + (modelSort === key ? modelDirection === 'ascending' ? ', descending' : ', ascending' : ', ascending'))
    }
  }
  modelSearch.addEventListener('input', renderModelRows)
  renderModelRows()
  modelTable.append(tableHead, tableBody); modelTableScroll.append(modelTable)
  const modelStatus = element('p', 'No model loaded.', 'assistant-ai-status'); modelStatus.setAttribute('role', 'status')
  const modelButton = button('Load model', () => void enableAI(), 'assistant-secondary assistant-load-model')
  const modelInfo = element('div', undefined, 'assistant-model-info')
  const modelBar = element('div', undefined, 'assistant-model-bar'), modelFeedback = element('div')
  const modelActions = element('div', undefined, 'assistant-model-actions')
  const backToChat = button('Back to chat', () => showModelPicker(false), 'assistant-secondary')
  const eject = button('⏏ Eject model', ejectModel, 'assistant-eject')
  eject.title = 'Unload the active model; chat history is kept'
  modelActions.append(eject, backToChat, modelButton)
  modelFeedback.append(modelInfo, modelStatus); modelBar.append(modelFeedback, modelActions)
  modelGate.append(modelTools, modelTableScroll, modelBar)
  const loadingView = element('div', undefined, 'assistant-model-loading'); loadingView.hidden = true
  const loadingCard = element('div', undefined, 'assistant-loading-card')
  const loadingHeader = element('div', undefined, 'assistant-loading-header'), loadingCopy = element('div')
  const spinner = element('span', undefined, 'assistant-loading-spinner'); spinner.setAttribute('aria-hidden', 'true')
  const loadingName = element('h3'), loadingMeta = element('p', undefined, 'assistant-loading-meta')
  loadingCopy.append(element('span', 'Loading model', 'assistant-loading-kicker'), loadingName)
  loadingHeader.append(spinner, loadingCopy)
  const loadingBar = element('progress'); loadingBar.max = 1; loadingBar.setAttribute('aria-label', 'Model loading progress')
  const loadingNumbers = element('div', undefined, 'assistant-loading-numbers'), loadingPercent = element('strong', 'Preparing…')
  loadingNumbers.append(element('span', 'Initialization progress'), loadingPercent)
  const loadingDetail = element('p', undefined, 'assistant-loading-detail'); loadingDetail.setAttribute('role', 'status')
  const cancelLoading = button('Cancel loading', () => void enableAI(), 'assistant-secondary assistant-cancel-loading')
  loadingCard.append(loadingHeader, loadingMeta, loadingNumbers, loadingBar, loadingDetail, cancelLoading)
  loadingView.append(loadingCard); modelGate.append(loadingView)
  const transcript = element('div', undefined, 'assistant-transcript')
  transcript.setAttribute('role', 'region'); transcript.setAttribute('aria-label', 'Chat history')
  const starters = element('div', undefined, 'assistant-starters')
  const form = element('form', undefined, 'assistant-composer'), input = element('textarea')
  input.rows = 1; input.maxLength = 1200; input.placeholder = 'Ask about this graph…'; input.setAttribute('aria-label', 'Ask about this graph')
  const send = element('button', '↑', 'assistant-send'); send.type = 'submit'; send.setAttribute('aria-label', 'Send question')
  form.append(input, send)
  const status = element('div', 'Load the model to start chatting', 'assistant-status'); status.setAttribute('role', 'status')
  const changeModel = button('Change model', () => showModelPicker(true), 'assistant-eject')
  changeModel.title = 'Compare models while keeping the current model loaded'
  const footerActions = element('div', undefined, 'assistant-footer-actions'); footerActions.append(changeModel)
  const modelAttribution = element('div', undefined, 'assistant-model-attribution'); modelAttribution.hidden = true
  const footerFeedback = element('div', undefined, 'assistant-footer-feedback'); footerFeedback.append(status, modelAttribution)
  const footer = element('div', undefined, 'assistant-footer'); footer.append(footerFeedback, footerActions)
  dock.append(grip, controls, modelGate, transcript, starters, form, footer); app.append(launch, dock)
  const ai = new LocalAI({ progress: modelMessage })

  function modelMessage(text, report) {
    modelStatus.textContent = text
    if (!enabling) return
    const progress = loadingProgress(text, report)
    loadingDetail.textContent = progress.text; loadingPercent.textContent = progress.label
    if (progress.value === null) loadingBar.removeAttribute('value')
    else loadingBar.value = progress.value
  }

  async function refreshModelCache() {
    const ownCheck = ++cacheCheck; cacheChecked = true
    try {
      const records = await inspectModelCache()
      if (ownCheck === cacheCheck) { savedModels = records; updateModelChoice() }
    } catch { /* Unavailable cache storage is unknown, never a cached badge. */ }
  }

  function updateModelChoice() {
    const model = findModel(selectedModelID)
    modelInfo.replaceChildren(link('About this model ↗', model.url), element('span', ' · Download and memory sizes are approximate.'))
    const terms = element('div', undefined, 'assistant-model-terms')
    if (model.license.attribution) terms.append(element('strong', model.license.attribution + ' · '))
    terms.append(link(model.license.name + ' ↗', model.license.url))
    if (model.license.policyURL) terms.append(element('span', ' · '), link('Acceptable use policy ↗', model.license.policyURL))
    if (model.license.publisherLicense) terms.append(element('span', ' · '), link(model.license.publisherLicense.name + ' ↗', model.license.publisherLicense.url), element('span', ' · '), link('Publisher use policy ↗', model.license.publisherPolicyURL))
    modelInfo.append(terms)
    for (const { radio, row, marker } of modelChoices) {
      radio.checked = radio.value === selectedModelID
      radio.disabled = enabling || !navigator.gpu; row.classList.toggle('is-selected', radio.checked)
      const state = modelMarker(radio.value, { loaded: ai.ready ? ai.loadedModelID : null, loading: enabling ? selectedModelID : null, cached: savedModels })
      marker.hidden = !state
      marker.textContent = state?.label || ''; marker.title = state?.title || ''; marker.dataset.kind = state?.kind || ''
    }
    modelButton.textContent = enabling ? 'Cancel loading' : ai.ready ? selectedModelID === ai.loadedModelID ? 'Use this model' : 'Switch model' : 'Load model'
  }
  function showModelPicker(value) {
    if (controller || enabling) return
    choosingModel = value
    if (value && ai.ready) {
      modelSearch.value = ''; renderModelRows()
      selectedModelID = ai.loadedModelID
      for (const { radio } of modelChoices) radio.checked = radio.value === selectedModelID
      modelMessage(findModel(ai.loadedModelID).name + ' is loaded.')
    }
    updateAI()
    if (value) void refreshModelCache()
    if (value) modelChoices.find(({ radio }) => radio.checked)?.radio.focus({ preventScroll: true })
    else input.focus({ preventScroll: true })
  }
  function ejectModel() {
    choosingModel = false
    ++aiGeneration; enabling = false; cancel(); ai.stop()
    modelMessage('Model ejected. Chat history kept; cached downloads can be reused.')
    updateAI(); modelChoices.find(({ radio }) => radio.checked)?.radio.focus({ preventScroll: true })
  }
  function updateAI() {
    modelButton.disabled = !navigator.gpu
    modelSearch.disabled = enabling
    if (!navigator.gpu) modelMessage('WebGPU is unavailable in this browser. Use a WebGPU-capable browser to chat.')
    modelGate.hidden = ai.ready && !choosingModel
    modelGate.classList.toggle('is-loading', enabling); loadingView.hidden = !enabling
    modelHeading.textContent = ai.ready ? 'Change model' : 'Choose a local model'
    modelIntro.textContent = ai.ready ? 'Your current model stays loaded until you switch. Switching keeps your chat history.' : 'Choose a model, then load it to start chatting.'
    backToChat.hidden = !ai.ready; eject.hidden = !ai.ready; changeModel.hidden = !ai.ready
    updateModelChoice()
    const loaded = ai.ready ? findModel(ai.loadedModelID) : null
    modelAttribution.hidden = !loaded?.license.attribution
    modelAttribution.replaceChildren()
    if (loaded?.license.attribution) modelAttribution.append(element('strong', loaded.license.attribution + ' · '), link(loaded.license.name + ' ↗', loaded.license.url))
    if (loaded?.license.publisherLicense) modelAttribution.append(element('span', ' · '), link(loaded.license.publisherLicense.name + ' ↗', loaded.license.publisherLicense.url))
    setBusy(); renderStarters(); disableOldActions()
    if (!controller) status.textContent = ai.ready ? findModel(ai.loadedModelID).name + ' ready' : enabling ? 'Loading the local model…' : 'Load the model to start chatting'
  }
  async function enableAI() {
    const ownGeneration = ++aiGeneration
    if (enabling) {
      enabling = false; ai.stop(); modelMessage('Model loading canceled. Choose a model to try again.'); updateAI()
      void refreshModelCache(); modelChoices.find(({ radio }) => radio.checked)?.radio.focus({ preventScroll: true }); return
    }
    if (ai.ready && selectedModelID === ai.loadedModelID) { showModelPicker(false); return }
    choosingModel = false
    enabling = true; ai.stop()
    const model = findModel(selectedModelID)
    loadingName.textContent = model.name; loadingMeta.textContent = `${model.download} download · ${model.gpu} memory needed`
    modelMessage('Loading the WebLLM runtime…'); updateAI(); cancelLoading.focus({ preventScroll: true })
    try { await ai.enable(selectedModelID); if (ownGeneration !== aiGeneration) return; modelMessage(findModel(ai.loadedModelID).name + ' ready.') }
    catch (error) { if (ownGeneration !== aiGeneration) return; ai.stop(); modelMessage(error.name === 'AbortError' ? 'Model loading canceled.' : error.message) }
    finally {
      if (ownGeneration === aiGeneration) {
        enabling = false; updateAI(); void refreshModelCache()
        if (opened) (ai.ready ? input : modelButton).focus({ preventScroll: true })
      }
    }
  }
  function setBusy() {
    changeModel.disabled = Boolean(controller)
    const busy = Boolean(controller)
    send.textContent = busy ? '■' : '↑'; send.setAttribute('aria-label', busy ? 'Stop answer' : 'Send question')
    send.disabled = !context || (!ai.ready && !busy); input.disabled = !context || !ai.ready
    dock.setAttribute('aria-busy', String(busy))
  }
  function minimumHeight() { return Math.min(40, Math.max(20, 240 / app.getBoundingClientRect().height * 100)) }
  function setHeight(value) {
    const focusedControl = document.activeElement === resize || document.activeElement === minimise
    panelHeight = Math.min(100, Math.max(minimumHeight(), value)); expanded = panelHeight === 100
    reflectLayout()
    if (focusedControl) (expanded ? minimise : resize).focus({ preventScroll: true })
  }
  function reflectLayout() {
    app.classList.toggle('assistant-open', opened)
    app.classList.toggle('assistant-expanded', opened && expanded)
    app.style.setProperty('--assistant-height', panelHeight + '%')
    resize.hidden = expanded; minimise.hidden = !expanded
    grip.setAttribute('aria-valuemin', String(Math.round(minimumHeight())))
    grip.setAttribute('aria-valuenow', String(Math.round(panelHeight)))
    grip.setAttribute('aria-valuetext', Math.round(panelHeight) + '% height')
    resize.setAttribute('aria-expanded', String(expanded))
    const panel = document.getElementById('left-panel'), toggleButton = document.getElementById('sidebar-toggle')
    if (panel) panel.inert = opened && mobile.matches
    if (toggleButton) toggleButton.inert = opened && mobile.matches
  }
  function toggle(value) {
    opened = value; if (!value) { expanded = false; panelHeight = 40; choosingModel = false; updateAI() } dock.hidden = !value; launch.setAttribute('aria-expanded', String(value)); reflectLayout()
    if (value) {
      if (!cacheChecked) void refreshModelCache()
      ;(enabling ? cancelLoading : modelGate.hidden ? input : modelButton.disabled ? grip : modelButton).focus({ preventScroll: true })
    } else if (!launch.hidden) launch.focus({ preventScroll: true })
  }
  let drag = null
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault(); grip.focus(); grip.setPointerCapture(event.pointerId)
    drag = { id: event.pointerId, y: event.clientY, height: panelHeight }
    app.classList.add('assistant-resizing')
  })
  grip.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return
    const height = app.getBoundingClientRect().height
    setHeight(drag.height + (drag.y - event.clientY) / height * 100)
  })
  const endDrag = () => { drag = null; app.classList.remove('assistant-resizing') }
  grip.addEventListener('pointerup', endDrag); grip.addEventListener('pointercancel', endDrag); grip.addEventListener('lostpointercapture', endDrag)
  grip.addEventListener('keydown', event => {
    const value = { ArrowUp: panelHeight + 5, ArrowDown: panelHeight - 5, Home: 40, End: 100 }[event.key]
    if (value !== undefined) { event.preventDefault(); setHeight(value) }
  })
  window.addEventListener('resize', () => { if (opened) setHeight(panelHeight) })
  mobile.addEventListener('change', reflectLayout)
  dock.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (choosingModel && ai.ready) showModelPicker(false)
    else toggle(false)
  })
  function cancel() {
    const wasRunning = Boolean(controller)
    controller?.abort(stopError()); controller = null; request++
    if (wasRunning && !ai.ready) modelMessage('Model stopped. Load it again to continue chatting.')
    setBusy(); updateAI()
  }
  function questionButtons(host, values, captured, capturedRevision) {
    const group = element('div', undefined, 'assistant-questions')
    for (const value of values) {
      const choice = button('', () => {
        if (!context || !ai.ready || revision !== capturedRevision) return
        void ask(value.label, { topic: value.id, nodeID: value.nodeID || captured.selected, licenseQuery: value.licenseQuery, key: value.key })
      }, 'assistant-question')
      choice.append(element('span', value.label), element('span', '↗', 'assistant-question-arrow'))
      choice.dataset.revision = String(capturedRevision); choice.disabled = !ai.ready || Boolean(controller); group.append(choice)
    }
    host.append(group)
  }
  function suggestionOptions(selected, answer, ranked = []) {
    return { evidence: Object.fromEntries(['vulnerabilities', 'licenses', 'openssf'].map(id => [id, cache.get(id === 'openssf' ? id + ':' + selected : id)])), answer, ranked, history: conversation.turns.filter(turn => turn.revision === revision && turn.answer) }
  }
  function renderStarters() {
    starters.replaceChildren()
    if (!context) { starters.append(element('p', 'Load a public module to ask about its graph.')); return }
    if (!ai.ready || conversation.turns.some(turn => turn.revision === revision)) return
    starters.append(element('h3', 'What would you like to understand?'))
    questionButtons(starters, suggestions(context, conversation.asked, '', suggestionOptions(context.selected)), context, revision)
  }
  function disableOldActions() {
    dock.querySelectorAll('[data-revision]').forEach(value => { value.disabled = !context || Number(value.dataset.revision) !== revision || (value.classList.contains('assistant-question') && (!ai.ready || Boolean(controller))) })
  }
  function renderAnswer(host, answer, captured, capturedRevision, ranked = []) {
    host.replaceChildren()
    const body = element('div', undefined, 'assistant-answer-body'), preview = answerPreview(answer)
    for (const paragraph of preview.paragraphs) body.append(element('p', paragraph, answer.generated ? 'assistant-generated' : ''))
    if (answer.path?.length) {
      const path = element('ol', undefined, 'assistant-path')
      for (const id of answer.path) {
        const row = element('li'), choice = button(id, () => { if (context && revision === capturedRevision) select(id) }, 'assistant-module')
        choice.dataset.revision = String(capturedRevision); row.append(choice); path.append(row)
      }
      body.append(path)
    }
    function findings(items) {
      const list = element('ul', undefined, 'assistant-findings' + (preview.compact ? ' assistant-findings-compact' : ''))
      for (const item of items) {
        const row = element('li')
        if (item.nodeID) {
          const choice = button(item.label, () => { if (context && revision === capturedRevision) select(item.nodeID) }, 'assistant-module')
          choice.dataset.revision = String(capturedRevision); row.append(choice)
        } else row.append(element('strong', item.label))
        row.append(element('span', (preview.compact ? ' — ' : '') + item.detail)); list.append(row)
      }
      return list
    }
    if (preview.groups.length) {
      const groups = element('div', undefined, 'assistant-license-groups')
      for (const group of preview.groups) {
        const choice = button('', () => {
          if (!context || revision !== capturedRevision) return
          openLens('licenses'); highlight({ ids: group.ids, nodesOnly: true, color: '#a4d6fa' })
        }, 'assistant-license-group')
        choice.append(element('span', group.label), element('strong', group.ids.length))
        choice.title = `Highlight ${group.ids.length} module${group.ids.length === 1 ? '' : 's'} with this recorded expression`
        choice.dataset.revision = String(capturedRevision); groups.append(choice)
      }
      body.append(groups)
    }
    if (preview.items.length) body.append(findings(preview.items))
    if (answer.scope || answer.observedAt || answer.evidence?.length || answer.sources.length) {
      const details = element('details', undefined, 'assistant-grounding'); details.append(element('summary', 'Evidence & scope'))
      if (answer.licenseSummary) details.append(element('p', `Checked ${answer.licenseSummary.known} of ${answer.licenseSummary.total} modules; ${answer.licenseSummary.unknown} unknown.`))
      for (const fact of answer.evidence || []) details.append(element('strong', fact.label), element('p', fact.detail))
      if (answer.scope) details.append(element('p', answer.scope, 'assistant-note'))
      if (answer.observedAt) details.append(element('p', 'Observed: ' + answer.observedAt, 'assistant-note'))
      const links = element('div', undefined, 'assistant-sources')
      for (const source of answer.sources.slice(0, 12)) links.append(link(source.label + ' ↗', source.url))
      details.append(links); body.append(details)
    }
    const actions = element('div', undefined, 'assistant-actions')
    for (const action of answer.actions) {
      if (preview.compact && answer.items.length && action.label === 'Open license inventory') continue
      const control = button(action.label, () => {
        if (!context || revision !== capturedRevision) return
        if (action.lens) openLens(action.lens)
        highlight({ ids: action.ids, nodesOnly: true, color: '#a4d6fa' })
      }, 'assistant-secondary')
      control.dataset.revision = String(capturedRevision); actions.append(control)
    }
    body.append(actions); host.append(body)
    const next = element('div', undefined, 'assistant-followups'); next.append(element('div', 'Continue exploring', 'assistant-followups-label'))
    const values = suggestions(captured, conversation.asked, answer.topic, suggestionOptions(captured.selected, answer, ranked))
    questionButtons(next, values, captured, capturedRevision); host.append(next)
    disableOldActions()
  }
  async function evidenceFor(topic, captured, signal) {
    for (const id of new Set((Array.isArray(topic) ? topic : [topic]).flatMap(requiredEvidence))) {
      const key = id === 'openssf' ? id + ':' + captured.selected : id
      if (!cache.has(key)) {
        try {
          const data = await loadEvidence(id, captured.selected, signal)
          signal.throwIfAborted()
          cache.set(key, data)
        }
        catch (error) { if (signal.aborted) throw error; cache.set(key, { error: error.message || 'Source unavailable' }) }
      }
      signal.throwIfAborted()
    }
    return Object.fromEntries(['vulnerabilities', 'licenses', 'openssf'].map(id => [id, cache.get(id === 'openssf' ? id + ':' + captured.selected : id)]))
  }
  async function ask(text, predefined = null) {
    if (!context || !ai.ready || controller || !text.trim()) return
    const history = recentHistory(conversation.turns, revision)
    const captured = predefined ? { ...context, selected: predefined.nodeID || context.selected } : questionContext(text, context, history), capturedRevision = revision
    const ownRequest = ++request; controller = new AbortController(); const signal = controller.signal
    const turn = { revision, question: text, selected: captured.selected, modelID: ai.loadedModelID }; conversation.turns.push(turn)
    if (conversation.turns.length > 30) { conversation.turns.shift().article?.remove() }
    renderStarters(); input.value = ''; setBusy(); disableOldActions()
    const article = turn.article = element('article', undefined, 'assistant-turn')
    article.append(element('p', text, 'assistant-user'), element('div', captured.selected + ' · ' + findModel(turn.modelID).name, 'assistant-turn-context'))
    const response = element('div', undefined, 'assistant-answer'); response.append(element('p', 'Reading the available evidence…', 'assistant-note'))
    // Follow-ups belong to the current end of this conversation, not its history.
    transcript.querySelectorAll('.assistant-followups').forEach(section => section.remove())
    article.append(response); transcript.append(article); transcript.scrollTop = transcript.scrollHeight
    try {
      let answer, ranked = []
      const directTopic = customInvestigation(text), licenseFilter = licenseQuery(text)
      const investigation = predefined || (licenseFilter ? { topic: 'licenses', licenseQuery: licenseFilter } : directTopic ? { topic: directTopic } : null)
      if (investigation) {
        status.textContent = 'Interpreting on this device…'
        const interpreted = await ai.interpret(text, captured, conversation.asked, signal)
        signal.throwIfAborted()
        const evidence = await evidenceFor(investigation.topic, captured, signal)
        if (request !== ownRequest || revision !== capturedRevision || signal.aborted) return
        answer = answerQuestion(investigation.topic, captured, evidence, { licenseQuery: investigation.licenseQuery }); ranked = interpreted.followUps
      } else {
        status.textContent = 'Reading module evidence for your question…'
        const evidence = await evidenceFor(customTopics(text), captured, signal)
        signal.throwIfAborted()
        const packet = customPacket(text, captured, evidence)
        const generated = element('p', 'Writing an answer to your question…', 'assistant-generated')
        response.replaceChildren(generated)
        status.textContent = 'Answering on this device…'
        let receivedText = false
        const output = await ai.answer(text, packet, history, signal, value => {
          receivedText = Boolean(value.trim())
          if (request === ownRequest && revision === capturedRevision && !signal.aborted) {
            generated.textContent = value
            transcript.scrollTop = transcript.scrollHeight
          }
        }, { onStatus: message => {
          if (request !== ownRequest || revision !== capturedRevision || signal.aborted) return
          status.textContent = message
          if (!receivedText) generated.textContent = message
        } })
        if (request !== ownRequest || revision !== capturedRevision || signal.aborted) return
        answer = {
          title: packet.topic === 'repository' ? 'Source repository' : 'Local AI answer', paragraphs: [output], generated: true,
          items: [], sources: packet.sources, actions: packet.actions, topic: packet.topic,
          evidence: packet.facts.map(fact => ({ label: '[' + fact.id + '] ' + (fact.investigation || 'Repository identity'), detail: fact.id === 'R' ? `${fact.module}@${fact.version} · ${fact.repositoryURL || 'Repository unavailable'}. ${fact.repositoryMapping}` : [fact.statements, fact.path?.join(' → '), ...(fact.findings || []).map(item => item.module + ': ' + item.detail), fact.scope, fact.omittedPathSteps ? `${fact.omittedPathSteps} further path steps omitted.` : '', fact.omittedFindings ? `${fact.omittedFindings} other findings omitted from the model context.` : ''].filter(Boolean).join(' ') })),
        }
      }
      turn.selected = answer.licenseSummary?.filter && answer.items.length === 1 ? answer.items[0].nodeID : captured.selected
      turn.answer = [...answer.paragraphs, ...(answer.path || []), ...answer.items.slice(0, 4).map(item => item.label + ': ' + item.detail)].join('\n')
      turn.topic = answer.topic; turn.suggestionKey = predefined?.key || suggestionKey(answer.topic, captured.selected, investigation?.licenseQuery)
      conversation.asked.push(answer.topic)
      renderAnswer(response, answer, { ...captured, selected: turn.selected }, capturedRevision, ranked)
      status.textContent = findModel(ai.loadedModelID).name + ' · answer grounded in graph and source observations'
    } catch (error) {
      if (!signal.aborted) modelMessage(error.message || 'Local inference failed. Try again or reload the model.')
      if (request === ownRequest) status.textContent = 'No answer completed. Try again or reload the model.'
      response.replaceChildren(element('p', signal.aborted ? 'Stopped. No further observations were added to this answer.' : 'The answer could not be completed: ' + error.message, 'assistant-note'))
    } finally {
      if (request === ownRequest) {
        controller = null; updateAI()
        transcript.scrollTop = transcript.scrollHeight
      }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); if (controller) { cancel(); status.textContent = ai.ready ? 'Stopped. You can ask another question.' : 'Stopped. Load the model again to continue.' } else void ask(input.value.trim()) })
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit() } })
  updateAI(); reflectLayout(); setBusy()
  return {
    loading() {
      launch.hidden = true
      if (opened) toggle(false)
      cancel(); context = null; revision++; cache.clear(); setBusy(); renderStarters(); disableOldActions()
      status.textContent = 'Load a module to continue. Earlier answers retain their original module context.'
    },
    setContext(value) {
      if (lastGraph !== value.graph) {
        if (lastGraph && conversation.turns.length) transcript.append(element('div', 'New graph · ' + value.graph.rootId, 'assistant-snapshot-change'))
        conversation.asked = []
        lastGraph = value.graph
      }
      context = value
      launch.hidden = false
      if (!controller) { setBusy(); status.textContent = ai.ready ? findModel(ai.loadedModelID).name + ' ready' : 'Load the model to start chatting' }
      renderStarters(); disableOldActions()
    },
    observe(id, data, nodeID) {
      if (context) { cache.set(id === 'openssf' ? id + ':' + nodeID : id, data); if (!controller) renderStarters() }
    },
    invalidate(id, nodeID) { cache.delete(id === 'openssf' ? id + ':' + nodeID : id); if (!controller) renderStarters() },
  }
}
