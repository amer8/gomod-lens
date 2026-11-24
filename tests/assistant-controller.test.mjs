import test from 'node:test'
import assert from 'node:assert/strict'
import { Element } from './helpers/element.mjs'
import { createGraphAssistant } from '../internal/app/web/static/assistant/index.js'
import { LocalAI } from '../internal/app/web/static/assistant/local-ai.js'

const flush = () => new Promise(setImmediate)
test('chat shows the supplied evidence and keeps stopped and superseded turns out of later replies', async (t) => {
  const app = new Element()
  app.style = { setProperty() {} }
  app.getBoundingClientRect = () => ({ height: 800 })
  const window = new EventTarget()
  window.matchMedia = () => new EventTarget()
  const document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    getElementById: () => null,
  }
  for (const [name, value] of Object.entries({ window, document, navigator: { gpu: {} } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name],
    )
  }
  t.mock.method(LocalAI.prototype, 'enable', async function (id) {
    this.ready = true
    this.loadedModelID = id
  })
  const pending = []
  t.mock.method(LocalAI.prototype, 'answer', (question, packet, history, signal, onText) => {
    const deferred = Promise.withResolvers()
    pending.push({ packet, history, signal, onText, ...deferred })
    return deferred.promise
  })
  const assistant = createGraphAssistant({
    app,
    select() {},
    highlight() {},
    openLens() {},
    async loadEvidence() {},
  })
  const load = (id) =>
    assistant.setContext({
      graph: { rootId: id, nodes: [{ id, name: id, version: 'v1.0.0' }], edges: [] },
      selected: id,
    })
  load('github.com/acme/first')
  app.querySelector('.assistant-load-model').dispatchEvent(new Event('click'))
  await flush()
  const form = app.querySelector('.assistant-composer')
  const submit = async (question) => {
    form.querySelector('textarea').value = question
    form.dispatchEvent(new Event('submit'))
    await flush()
  }
  await submit('Where is the repository?')
  const first = pending[0]
  first.resolve('First answer.')
  await flush()
  const grounding = app.querySelector('.assistant-grounding')
  for (const fact of first.packet.evidence)
    assert.ok(grounding.querySelectorAll('p').some((p) => p.textContent === fact.detail))
  assert.match(
    app.querySelector('.assistant-status').textContent,
    /generated from the supplied observations/,
  )

  await submit('Where is its repository?')
  assert.deepEqual(pending[1].history, [
    { question: 'Where is the repository?', selected: 'github.com/acme/first' },
  ])
  await submit('') // The submit button stops the active turn.
  assert.equal(pending[1].signal.aborted, true)
  await submit('Where is the source code?')
  pending[2].resolve('New answer.')
  await flush()
  pending[1].onText('Late token')
  pending[1].resolve('Late answer')
  await flush()
  assert.ok(!app.querySelectorAll('p').some((p) => /Late token|Late answer/.test(p.textContent)))
  assert.match(
    app.querySelector('.assistant-status').textContent,
    /generated from the supplied observations/,
  )

  t.mock.method(LocalAI.prototype, 'interpret', async () => ({ followUps: [] }))
  await submit('Which lenses are available?')
  assert.match(app.querySelector('.assistant-status').textContent, /graph investigation complete/)
  const oldAction = app.querySelector('[data-revision]')
  assistant.loading()
  load('github.com/acme/second')
  await submit('Where is the repository?')
  assert.equal(oldAction.disabled, true)
  assert.deepEqual(pending[3].history, [])
  pending[3].resolve('Second repository.')
  await flush()
})
