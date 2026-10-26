import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../internal/app/web/static/app-controller.js'
import { renderSidebar, renderDistribution } from '../internal/app/web/static/sidebar-view.js'

const flush = () => new Promise(setImmediate)
const event = (type, properties = {}) => Object.assign(new Event(type, { cancelable: true }), properties)
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture(t) {
  const ids = new Map(), timers = new Map()
  class Element extends EventTarget {
    constructor(id = '') { super(); this.id = id; this.dataset = {}; this.style = {}; this.children = []; this.hidden = false; this.value = ''; this.textContent = ''; this.attributes = new Map(); this.classes = new Set(); this.classList = { toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name) } }
    append(...nodes) { this.children.push(...nodes) }
    replaceChildren(...nodes) { this.children = nodes }
    replaceWith(node) { ids.set(this.id, node) }
    setAttribute(name, value) { this.attributes.set(name, value) }
    removeAttribute(name) { this.attributes.delete(name) }
    focus() { this.focused = true }
    querySelector(selector) { return selector === '.control-stack' ? this.stack : this.parts?.[selector] || null }
    querySelectorAll(selector) { return this.children.filter(node => selector === '[data-loading-step]' ? node.dataset.loadingStep !== undefined : node.dataset?.moduleSuggestion !== undefined) }
  }
  const document = new EventTarget()
  document.getElementById = id => ids.get(id)
  document.createElement = tagName => Object.assign(new Element(), { tagName })
  document.createTextNode = textContent => Object.assign(new Element(), { textContent })
  document.querySelector = () => null
  document.querySelectorAll = () => []
  for (const id of ['search-form', 'module-target', 'analyze-button', 'graph-progress', 'graph-loading-target', 'graph-loading-status', 'graph-loading-wait', 'cancel-graph-loading', 'graph-errors', 'error-message', 'graph-canvas', 'graph-result', 'left-panel', 'navbar-component']) ids.set(id, new Element(id))
  ids.get('graph-progress').parts = Object.fromEntries(['graph-loading-target', 'graph-loading-status', 'graph-loading-wait'].map(id => ['#' + id, ids.get(id)]))
  for (let index = 0; index < 5; index++) {
    const step = new Element()
    step.dataset.loadingStep = ''
    step.parts = Object.fromEntries(['graph-loading-marker', 'graph-loading-detail', 'graph-loading-step-status'].map(name => ['.' + name, new Element()]))
    ids.get('graph-progress').append(step)
  }
  ids.get('search-form').stack = new Element()
  const window = new EventTarget()
  let hash = '', timer = 0, now = 0
  window.location = { get hash() { return hash }, set hash(value) { hash = value ? '#' + value.replace(/^#/, '') : ''; queueMicrotask(() => window.dispatchEvent(event('hashchange'))) } }
  window.history = { replaceState(_, __, value) { hash = value } }
  window.performance = { now: () => now }
  window.setTimeout = (callback, delay = 0) => { timers.set(++timer, { callback, at: now + delay }); return timer }
  window.clearTimeout = id => timers.delete(id)
  function tick(milliseconds = 220) {
    const until = now + milliseconds
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      const [id, { callback, at }] = next
      now = at
      timers.delete(id)
      callback()
    }
    now = until
  }
  for (const [name, value] of Object.entries({ document, window, Node: Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name])
  }
  const graphRequests = [], searchRequests = [], rendered = [], captured = [], targetInputs = []
  let selectedTarget
  const client = {
    loadGraph(target, options) { const request = { target, options, ...pending() }; graphRequests.push(request); return request.promise },
    searchModules(query, limit, signal) { const request = { query, limit, signal, ...pending() }; searchRequests.push(request); return request.promise },
  }
  createApplication({ client,
    graphView: { applyHighlightRequest() {}, setAnalysisColors() {}, clearGraph() {}, renderGraph: (_, payload) => rendered.push(payload), selectNode() {}, setGraphLens() {} },
    createAnalysisViews: () => ({ loading() {}, select() {}, capture: payload => captured.push(payload) }),
    createModuleVersionPicker: () => ({ loading() {}, clear() {}, target(value) { targetInputs.push(value); return selectedTarget || value }, capture() {} }),
  })
  return { ids, window, graphRequests, searchRequests, rendered, captured, targetInputs,
    selectTarget(value) { selectedTarget = value },
    input(value) { const input = ids.get('module-target'); input.value = value; input.dispatchEvent(event('input')) },
    submit() { ids.get('search-form').dispatchEvent(event('submit')) },
    tick,
    async finish() { await flush(); tick(2500); await flush() },
    resolve(request, target = request.target, extra = {}) { request.resolve({ nodes: [{ id: 'root' }], edges: [], meta: { target }, ...extra }) },
  }
}

test('routing honors the version picker, canonical targets, repeated submissions and clearing', async t => {
  const app = fixture(t)
  app.selectTarget('example.org/mod@selected'); app.input('example.org/mod'); app.submit(); await flush()
  assert.deepEqual(app.targetInputs, ['example.org/mod'])
  assert.equal(app.graphRequests[0].target, 'example.org/mod@selected')
  assert.equal(app.ids.get('analyze-button').disabled, true)
  app.resolve(app.graphRequests[0], 'example.org/mod@v1.2.3'); await app.finish()
  assert.equal(new URLSearchParams(app.window.location.hash.slice(1)).get('target'), 'example.org/mod@v1.2.3')
  assert.equal(app.graphRequests.length, 1, 'canonical URL replacement must not reload the graph')
  assert.equal(app.rendered.length, 1); assert.equal(app.captured.length, 1)
  assert.equal(app.ids.get('analyze-button').disabled, false)
  app.window.dispatchEvent(event('popstate')); await flush()
  assert.equal(app.graphRequests.length, 1, 'lens-only history changes must not reload the canonical target')
  app.selectTarget('example.org/mod@v1.2.3'); app.submit(); await flush()
  assert.equal(app.graphRequests.length, 2, 'same-target Analyze should reload')
  app.window.location.hash = ''; await flush()
  assert.equal(app.graphRequests[1].options.signal.aborted, true)
  app.resolve(app.graphRequests[1]); await flush()
  assert.equal(app.rendered.length, 1)
  assert.equal(app.ids.get('graph-result').dataset.state, 'empty')
  assert(app.ids.get('left-panel').classes.has('left-panel-empty'))
})

test('Back restores module targets on popstate and a following hashchange does not load twice', async t => {
  const app = fixture(t)
  app.input('example.org/current'); app.submit(); await flush()
  app.window.history.replaceState(null, '', '#target=example.org%2Fprevious')
  app.window.dispatchEvent(event('popstate')); await flush()
  assert.equal(app.graphRequests[0].options.signal.aborted, true)
  assert.equal(app.graphRequests[1].target, 'example.org/previous')
  app.window.dispatchEvent(event('hashchange')); await flush()
  assert.equal(app.graphRequests.length, 2)
})

test('invalid graph data uses the graph error UI', async t => {
  const app = fixture(t)
  app.window.location.hash = 'target=example.org%2Fmod'; await flush()
  app.resolve(app.graphRequests[0], undefined, { meta: { lenses: [{ id: 'openssf' }] } }); await flush()
  assert.equal(app.rendered.length, 0)
  assert.equal(app.ids.get('graph-result').dataset.state, 'error')
  assert.match(app.ids.get('error-message').textContent, /Built-in lens data/)
  assert.equal(app.ids.get('analyze-button').disabled, false)
  app.window.location.hash = 'target=..%2Fprivate'; await flush()
  assert.equal(app.graphRequests.length, 1)
  assert.equal(app.ids.get('graph-errors').hidden, true)
})

test('built-in lens validation accepts canonical results including a zero Scorecard score', async t => {
  const app = fixture(t)
  app.input('example.org/mod'); app.submit(); await flush()
  const lenses = { openssf: { status: 'found', score: 0 }, 'release-freshness': { status: 'current' } }
  app.resolve(app.graphRequests[0], undefined, {
    nodes: [{ id: 'root', lenses }], meta: { lenses: Object.keys(lenses).map(id => ({ id })) },
  }); await app.finish()
  assert.equal(app.rendered.length, 1)
  assert.deepEqual(app.rendered[0].nodes[0].lenses, lenses)
  assert.equal(app.ids.get('graph-errors').hidden, true)
})

test('suggestions reject late results even when the text repeats and keyboard selection loads the module', async t => {
  const app = fixture(t)
  for (const query of ['first', 'second', 'first']) { app.input(query); app.tick() }
  assert.equal(app.searchRequests.length, 3)
  assert.equal(app.searchRequests[0].signal.aborted, true)
  assert.equal(app.searchRequests[1].signal.aborted, true)
  app.searchRequests[2].resolve([{ path: 'github.com/new/project' }]); await flush()
  app.searchRequests[0].resolve([{ path: 'github.com/old/project' }]); app.searchRequests[1].reject(new Error('late failure')); await flush()
  const suggestions = app.ids.get('search-form').stack.children[0]
  assert.equal(suggestions.children[0].children[0].textContent, 'github.com/new/project')
  const input = app.ids.get('module-target')
  input.dispatchEvent(event('keydown', { key: 'ArrowDown' }))
  assert.equal(suggestions.children[0].attributes.get('aria-selected'), 'true')
  input.dispatchEvent(event('keydown', { key: 'Enter' })); await flush()
  assert.equal(app.graphRequests[0].target, 'github.com/new/project')
  assert.equal(suggestions.hidden, true)
})

test('superseded graph requests cannot overwrite current progress, results or errors', async t => {
  const app = fixture(t)
  app.input('example.org/old'); app.submit(); await flush()
  app.input('example.org/new'); app.submit(); await flush()
  const [old, current] = app.graphRequests
  assert.equal(old.options.signal.aborted, true)
  current.options.onProgress({ value: 25, label: 'Resolving dependencies' }); old.options.onProgress({ value: 90, label: 'Applying OpenSSF lens' })
  app.tick(500)
  assert.equal(app.ids.get('graph-loading-status').textContent, 'Resolving dependencies')
  assert.equal(app.ids.get('graph-progress').children[1].attributes.get('aria-current'), 'step')
  app.resolve(current); await app.finish()
  old.reject(new Error('late failure')); await flush()
  assert.equal(app.rendered.length, 1)
  assert.equal(app.ids.get('graph-errors').hidden, true)
})

test('guided loading follows resolver stages and stays active during final release checks', async t => {
  const app = fixture(t)
  app.input('example.org/mod@v1.2.3'); app.submit(); await flush()
  const progress = app.ids.get('graph-progress'), steps = progress.children
  const request = app.graphRequests[0]
  assert.equal(app.ids.get('graph-loading-target').textContent, 'example.org/mod@v1.2.3')
  assert.equal(app.ids.get('graph-loading-status').textContent, 'Preparing analyzer…')
  assert.equal(app.ids.get('search-form').hidden, true)
  assert.equal(app.ids.get('module-target').disabled, true)
  assert(app.ids.get('left-panel').classes.has('is-loading'))
  assert(steps.every(step => step.dataset.state === 'pending'))

  for (const [index, report] of [
    [0, { value: 4, label: 'Resolving module' }],
    [1, { value: 18, label: 'Resolving dependencies' }],
    [2, { value: 78, label: 'Building graph' }],
    [3, { label: 'Applying OpenSSF lens' }],
    [4, { value: 99, label: 'Applying Release Freshness lens' }],
  ]) {
    request.options.onProgress(report)
    assert(steps.slice(0, index).every(step => step.dataset.state === 'complete'))
    assert.equal(steps[index].dataset.state, 'active')
    assert.equal(steps[index].attributes.get('aria-current'), 'step')
    assert(steps.slice(index + 1).every(step => step.dataset.state === 'pending'))
    assert.equal(progress.hidden, false)
    app.tick(500)
  }
  assert.equal(app.ids.get('graph-loading-status').textContent, 'Checking release freshness')
  assert.equal(app.rendered.length, 0, '99% must not imply that a graph is ready')
  request.options.onProgress({ value: 100, label: 'Done' })
  assert(steps.every(step => step.dataset.state === 'complete'))
  assert.equal(app.ids.get('graph-loading-status').textContent, 'Preparing visualization…')
  assert.equal(progress.hidden, false, 'wait for the graph payload before leaving the loading view')
  app.resolve(request); await flush()
  assert.equal(progress.hidden, true)
  assert.equal(app.ids.get('search-form').hidden, false)
  assert.equal(app.ids.get('module-target').disabled, false)
  assert(!app.ids.get('left-panel').classes.has('is-loading'))
})

test('a longer stage shows a wait message and changing stages or canceling clears it', async t => {
  const app = fixture(t)
  app.input('example.org/mod'); app.submit(); await flush()
  const request = app.graphRequests[0], wait = app.ids.get('graph-loading-wait')
  request.options.onProgress({ value: 90, label: 'Applying OpenSSF lens' })
  app.tick(1500)
  assert.equal(wait.hidden, true)
  app.tick(15000)
  assert.equal(wait.hidden, false)
  request.options.onProgress({ value: 95, label: 'Applying OpenSSF lens' })
  assert.equal(wait.hidden, false, 'incremental progress within one stage should not hide the message')
  request.options.onProgress({ value: 98, label: 'Applying Release Freshness lens' })
  assert.equal(wait.hidden, true)
  app.ids.get('cancel-graph-loading').dispatchEvent(event('click'))
  assert.equal(request.options.signal.aborted, true)
  assert.equal(app.ids.get('graph-progress').hidden, true)
  assert.equal(app.ids.get('graph-result').dataset.state, 'empty')
  assert.equal(app.ids.get('module-target').value, 'example.org/mod')
  assert.equal(app.ids.get('module-target').focused, true)
  assert.equal(app.ids.get('analyze-button').disabled, false)
  app.tick(15000)
  request.options.onProgress({ value: 100, label: 'Done' })
  app.resolve(request); await flush()
  assert.equal(wait.hidden, true)
  assert.equal(app.rendered.length, 0, 'a canceled result must not replace the welcome screen')
  assert.equal(app.ids.get('graph-errors').hidden, true)

  app.submit(); await flush()
  assert.equal(app.graphRequests.length, 2, 'the canceled target can be submitted again')
  assert.equal(app.ids.get('graph-loading-status').textContent, 'Preparing analyzer…')
  app.resolve(app.graphRequests[1]); await app.finish()
  assert.equal(app.rendered.length, 1)
})

test('fast resolution still displays every stage for at least half a second', async t => {
  const app = fixture(t)
  app.input('example.org/fast'); app.submit(); await flush()
  const request = app.graphRequests[0], steps = app.ids.get('graph-progress').children
  request.options.onProgress({ value: 99, label: 'Applying Release Freshness lens' })
  request.options.onProgress({ value: 100, label: 'Done' })
  app.resolve(request); await flush()

  for (let stage = 0; stage < steps.length; stage++) {
    assert.equal(steps[stage].dataset.state, 'active')
    assert.equal(app.ids.get('graph-progress').hidden, false)
    app.tick(499); await flush()
    assert.equal(steps[stage].dataset.state, 'active', 'each stage must remain visible for the entire 500 ms')
    assert.equal(app.rendered.length, 0, 'a ready payload must wait for the displayed stages')
    app.tick(1); await flush()
  }
  assert.equal(app.rendered.length, 1)
  assert.equal(app.ids.get('graph-progress').hidden, true)
})

test('a stage already visible for half a second advances immediately when real progress arrives', async t => {
  const app = fixture(t)
  app.input('example.org/slow'); app.submit(); await flush()
  const request = app.graphRequests[0], steps = app.ids.get('graph-progress').children
  request.options.onProgress({ value: 4, label: 'Resolving module' })
  app.tick(2000)
  assert.equal(steps[0].dataset.state, 'active', 'presentation must not run ahead of real progress')
  request.options.onProgress({ value: 18, label: 'Resolving dependencies' })
  assert.equal(steps[1].dataset.state, 'active', 'slow stages do not need an additional artificial wait')
  app.tick(500)
  request.options.onProgress({ value: 78, label: 'Building graph' })
  assert.equal(steps[2].dataset.state, 'active')
  app.resolve(request); await app.finish()
  assert.equal(app.rendered.length, 1)
})

test('replacing or canceling a ready graph during the display delay cannot reveal stale results', async t => {
  const app = fixture(t)
  app.input('example.org/first'); app.submit(); await flush()
  app.resolve(app.graphRequests[0]); await flush()
  app.tick(750)
  assert.equal(app.rendered.length, 0)

  app.input('example.org/second'); app.submit(); await flush()
  assert.equal(app.graphRequests[0].options.signal.aborted, true)
  assert.equal(app.ids.get('graph-loading-target').textContent, 'example.org/second')
  assert.equal(app.ids.get('graph-loading-status').textContent, 'Preparing analyzer…')
  app.resolve(app.graphRequests[1]); await flush()
  app.tick(200)
  app.ids.get('cancel-graph-loading').dispatchEvent(event('click'))
  app.tick(5000); await flush()
  assert.equal(app.graphRequests[1].options.signal.aborted, true)
  assert.equal(app.rendered.length, 0)
  assert.equal(app.ids.get('graph-progress').hidden, true)
  assert.equal(app.ids.get('graph-errors').hidden, true)

  app.submit(); await flush()
  app.resolve(app.graphRequests[2]); await app.finish()
  assert.equal(app.rendered.length, 1)
  assert.equal(app.rendered[0].meta.target, 'example.org/second')
})

test('sidebar summaries preserve navigation, distributions and untrusted text', t => {
  fixture(t)
  const hostile = '</script><img src=x onerror=alert(1)>', ids = ['root', 'node"<&']
  const group = { name: hostile, count: 2, ids, color: '#8b95a7', nodesOnly: true, href: '#' }
  const result = renderSidebar({ meta: { target: 'example.org/root?x="bad"' }, viewModel: {
    relationGroups: [group], originGroups: [],
    nameEntries: [{ name: 'example.org/hub', count: 1, dependencyCount: 3, target: 'example.org/hub@v1.0.0', href: '#target=example.org%2Fhub%40v1.0.0' }, { ...group, name: 'leaf modules', dependencyCount: 2 }],
  } })
  const distribution = renderDistribution('openssf', [group])
  const walk = node => [node, ...node.children.flatMap(walk)], nodes = [...walk(result), ...walk(distribution)]
  assert.deepEqual(result.dataset, { state: 'loaded', target: 'example.org/root?x="bad"' })
  assert.deepEqual(nodes.filter(node => node.tagName === 'h4').map(node => node.children[0].textContent), ['Relation groups', 'Module origins', 'Dependency hubs'])
  assert.equal(distribution.children[0].children[0].textContent, 'Graph score distribution')
  assert.equal(renderDistribution('release-freshness', []).children[0].children[0].textContent, 'Graph release distribution')
  assert.equal(nodes.find(node => node.className === 'score-swatch').style.backgroundColor, '#8b95a7')
  assert.equal(nodes.find(node => node.dataset.moduleTarget)?.dataset.moduleTarget, 'example.org/hub@v1.0.0')
  for (const node of nodes.filter(node => node.dataset.highlightIds)) {
    assert.deepEqual(JSON.parse(node.dataset.highlightIds), ids)
    assert.equal(node.dataset.highlightNodesOnly, 'true')
  }
  assert(nodes.some(node => node.textContent === hostile))
  assert(!nodes.some(node => ['img', 'script'].includes(node.tagName)))
  assert(!nodes.some(node => node.dataset.lensPanelTarget || node.dataset.lensPanel))
})
