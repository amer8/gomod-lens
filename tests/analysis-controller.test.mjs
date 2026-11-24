import { Element } from './helpers/element.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnalysisViews } from '../internal/app/web/static/analysis/index.js'
import { browserLenses } from '../internal/app/web/static/analysis/registry.js'

const flush = () => new Promise(setImmediate)
const pending = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const graph = (name = 'root') => ({
  rootId: name,
  nodes: [{ id: name, name: 'example.org/' + name, version: 'v1.0.0' }],
  edges: [],
})
const lens = (label, options = {}) => ({
  default: {
    scope: label,
    load: async (graph) => ({ root: graph.rootId }),
    render: ({ host, data }) => {
      host.textContent = label + ':' + data.root
    },
    ...options,
  },
})

function fixture(t, importers = {}, preferred = 'openssf') {
  let views
  t.after(() => views?.loading())
  const app = new Element()
  app.id = 'app'
  const toolbar = new Element()
  toolbar.id = 'lens-toolbar'
  toolbar.hidden = true
  const left = new Element()
  left.className = 'left-panel'
  app.append(toolbar, left)
  const mount = () => {
    const result = new Element()
    result.id = 'graph-result'
    const info = new Element()
    info.className = 'packageInfo'
    result.append(info)
    left.replaceChildren(result)
  }
  mount()
  const document = new EventTarget()
  document.createElement = () => new Element()
  document.getElementById = (id) => (app.id === id ? app : app.querySelector('#' + id))
  const window = new EventTarget()
  window.location = new URL('https://example.org/?lens=' + preferred)
  window.history = {
    replaceState(_, __, value) {
      window.location = new URL(value, window.location)
    },
  }
  class Option extends Element {
    constructor(text, value) {
      super()
      this.textContent = text
      this.value = value
    }
  }
  for (const [name, value] of Object.entries({ document, window, Option })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name],
    )
  }
  const calls = new Map()
  for (const registration of browserLenses)
    t.mock.method(registration, 'importModule', () => {
      calls.set(registration.id, (calls.get(registration.id) || 0) + 1)
      return importers[registration.id]?.() ?? Promise.resolve(lens(registration.label))
    })
  let assistantOptions
  const colors = []
  views = createAnalysisViews({
    selectNode() {},
    setGraphLens() {},
    highlight() {},
    setColors: (value) => colors.push(value),
    createAssistant(options) {
      assistantOptions = options
      return { loading() {}, setContext() {}, observe() {}, invalidate() {} }
    },
  })
  return {
    views,
    calls,
    colors,
    toolbar,
    mount,
    evidence: (...args) => assistantOptions.loadEvidence(...args),
    panels: () => app.querySelectorAll('[data-lens-panel]'),
    panel: (id) =>
      app.querySelectorAll('[data-lens-panel]').find((panel) => panel.dataset.lensPanel === id),
    choose(id) {
      toolbar
        .querySelectorAll('[data-lens-panel-target]')
        .find((button) => button.dataset.lensPanelTarget === id)
        .dispatchEvent(new Event('click'))
    },
  }
}

test('a pending lens import does not block other panels or import inactive lenses', async (t) => {
  const slow = pending()
  const app = fixture(t, { openssf: () => slow.promise })
  await app.views.capture(graph())
  await flush()
  assert.equal(app.panels().length, browserLenses.length)
  assert.equal(app.toolbar.hidden, false)
  assert.deepEqual([...app.calls], [['openssf', 1]])
  app.choose('release-freshness')
  await flush()
  assert.equal(
    app.panel('release-freshness').querySelector('.analysis-body').textContent,
    'Release Freshness:root',
  )
  const lastColors = app.colors.at(-1)
  slow.reject(new Error('Offline'))
  await flush()
  assert.match(app.panel('openssf').querySelector('.analysis-status').textContent, /unavailable/)
  assert.equal(app.panel('release-freshness').hidden, false)
  assert.equal(
    app.colors.at(-1),
    lastColors,
    'a hidden failed lens must not recolor the active graph',
  )
})

test('a failed lens has a working Refresh retry and configures its controls after recovery', async (t) => {
  let attempts = 0
  const app = fixture(
    t,
    {
      licenses: () =>
        ++attempts === 1
          ? Promise.reject(new Error('Offline'))
          : Promise.resolve(lens('Recovered licenses', { modulePicker: true })),
    },
    'licenses',
  )
  await app.views.capture(graph())
  await flush()
  const panel = app.panel('licenses'),
    refresh = panel.querySelector('.analysis-refresh')
  assert.match(panel.querySelector('.analysis-body').children[0].textContent, /could not be loaded/)
  assert.equal(refresh.disabled, false)
  assert.equal(panel.getAttribute('aria-busy'), null)
  assert.deepEqual(app.colors.at(-1), {}, 'unavailable evidence must use unknown graph colors')
  refresh.dispatchEvent(new Event('click'))
  await flush()
  assert.equal(app.calls.get('licenses'), 2)
  assert.equal(panel.querySelector('.analysis-body').textContent, 'Recovered licenses:root')
  assert.equal(panel.querySelector('.analysis-eyebrow').textContent, 'Recovered licenses')
  assert.equal(panel.querySelector('.analysis-module-select').children.length, 1)
  app.choose('release-freshness')
  await flush()
  assert.equal(
    app.panel('release-freshness').querySelector('.analysis-body').textContent,
    'Release Freshness:root',
  )
})

test('late imports cannot load or update a superseded graph', async (t) => {
  const slow = pending(),
    loaded = []
  const app = fixture(t, { openssf: () => slow.promise })
  await app.views.capture(graph('old'))
  await flush()
  const oldPanel = app.panel('openssf')
  app.views.loading()
  app.mount()
  await app.views.capture(graph('new'))
  await flush()
  slow.resolve(
    lens('Scorecard', {
      selection: true,
      load: async (graph) => {
        loaded.push(graph.rootId)
        return { root: graph.rootId }
      },
    }),
  )
  await flush()
  assert.deepEqual(loaded, ['new'])
  assert.equal(app.calls.get('openssf'), 1, 'overlapping graphs share the same module import')
  assert.equal(
    oldPanel.querySelector('.analysis-body').children[0].textContent,
    'Loading the new module graph…',
  )
  const panel = app.panel('openssf')
  assert.equal(panel.querySelector('.analysis-body').textContent, 'Scorecard:new')
  assert.equal(panel.querySelector('.analysis-module-select').children[0].value, 'new')
})

test('assistant evidence shares a lens import and an import failure does not disable other lenses', async (t) => {
  const slow = pending()
  const app = fixture(t, { licenses: () => slow.promise })
  await app.views.capture(graph())
  await flush()
  const first = app.evidence('licenses', 'root', new AbortController().signal)
  const second = app.evidence('licenses', 'root', new AbortController().signal)
  const rejected = Promise.all([
    assert.rejects(first, /Offline/),
    assert.rejects(second, /Offline/),
  ])
  slow.reject(new Error('Offline'))
  await rejected
  assert.equal(app.calls.get('licenses'), 1)
  app.choose('release-freshness')
  await flush()
  assert.equal(
    app.panel('release-freshness').querySelector('.analysis-body').textContent,
    'Release Freshness:root',
  )
})

test('explicit Refresh is passed to the active lens while the initial load reuses metadata', async (t) => {
  const refreshes = []
  const app = fixture(
    t,
    {
      'go-requirements': () =>
        Promise.resolve(
          lens('Go requirements', {
            load: async (graph, options) => {
              refreshes.push(options.refresh)
              return { root: graph.rootId }
            },
          }),
        ),
    },
    'go-requirements',
  )
  await app.views.capture(graph())
  await flush()
  app.panel('go-requirements').querySelector('.analysis-refresh').dispatchEvent(new Event('click'))
  await flush()
  assert.deepEqual(refreshes, [false, true])
})
