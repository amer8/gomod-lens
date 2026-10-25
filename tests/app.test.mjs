import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../internal/app/web/static/app-controller.js'
import * as http from '../internal/app/web/static/http-client.js'
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
    querySelector(selector) { return selector === '.control-stack' ? this.stack : null }
    querySelectorAll() { return this.children.filter(node => node.dataset?.moduleSuggestion !== undefined) }
  }
  const document = new EventTarget()
  document.getElementById = id => ids.get(id)
  document.createElement = tagName => Object.assign(new Element(), { tagName })
  document.createTextNode = textContent => Object.assign(new Element(), { textContent })
  document.querySelector = () => null
  document.querySelectorAll = () => []
  for (const id of ['search-form', 'module-target', 'analyze-button', 'graph-progress', 'loading-progress', 'graph-errors', 'error-message', 'graph-canvas', 'graph-result', 'left-panel', 'navbar-component']) ids.set(id, new Element(id))
  ids.get('search-form').stack = new Element()
  const window = new EventTarget()
  let hash = '', timer = 0
  window.location = { get hash() { return hash }, set hash(value) { hash = value ? '#' + value.replace(/^#/, '') : ''; queueMicrotask(() => window.dispatchEvent(event('hashchange'))) } }
  window.history = { replaceState(_, __, value) { hash = value } }
  window.setTimeout = callback => { timers.set(++timer, callback); return timer }
  window.clearTimeout = id => timers.delete(id)
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
    tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()) },
    resolve(request, target = request.target, extra = {}) { request.resolve({ nodes: [{ id: 'root' }], edges: [], meta: { target }, ...extra }) },
  }
}

test('routing honors the version picker, canonical targets, repeated submissions and clearing', async t => {
  const app = fixture(t)
  app.selectTarget('example.org/mod@selected'); app.input('example.org/mod'); app.submit(); await flush()
  assert.deepEqual(app.targetInputs, ['example.org/mod'])
  assert.equal(app.graphRequests[0].target, 'example.org/mod@selected')
  assert.equal(app.ids.get('analyze-button').disabled, true)
  app.resolve(app.graphRequests[0], 'example.org/mod@v1.2.3'); await flush()
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

test('invalid graph data uses the same error UI for either transport', async t => {
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
  current.options.onProgress({ value: 25 }); old.options.onProgress({ value: 90 })
  assert.equal(app.ids.get('loading-progress').textContent, ' 25%')
  app.resolve(current); await flush()
  old.reject(new Error('late failure')); await flush()
  assert.equal(app.rendered.length, 1)
  assert.equal(app.ids.get('graph-errors').hidden, true)
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

test('HTTP client decodes graph JSON, errors and search results with cancellation', async t => {
  const payload = { nodes: [{ id: 'root' }] }, signal = new AbortController().signal
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.signal, signal); assert.equal(options.credentials, 'omit')
    if (url.startsWith('/api/graph?')) {
      assert.equal(new URL(url, 'https://app.test').searchParams.get('target'), 'example.org/mod@v1.0.0+incompatible')
      return Response.json(payload)
    }
    assert.equal(new URL(url, 'https://app.test').searchParams.get('q'), 'a/b')
    return { ok: true, json: async () => ({ results: [{ path: 'example.org/module' }] }) }
  })
  assert.deepEqual(await http.loadGraph('example.org/mod@v1.0.0+incompatible', { signal }), payload)
  assert.deepEqual(await http.searchModules('a/b', 6, signal), [{ path: 'example.org/module' }])
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'retry shortly' }, { status: 429 }))
  await assert.rejects(http.loadGraph('module'), /retry shortly/)
  t.mock.method(globalThis, 'fetch', async () => new Response('upstream failed', { status: 502 }))
  await assert.rejects(http.loadGraph('module'), /HTTP 502/)
  t.mock.method(globalThis, 'fetch', async () => new Response('invalid JSON'))
  await assert.rejects(http.loadGraph('module'), /did not include data/)
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { controller.abort(); return payload } }))
  await assert.rejects(http.loadGraph('module', { signal: controller.signal }), { name: 'AbortError' })
})
