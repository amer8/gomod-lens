import test from 'node:test'
import assert from 'node:assert/strict'
import { repositoryFor, questionContext, customTopics, customPacket, recentHistory, customInvestigation } from '../internal/app/web/static/assistant/custom.js'
import { browserLenses } from '../internal/app/web/static/analysis/registry.js'
import { answerQuestion, requiredEvidence } from '../internal/app/web/static/assistant/queries.js'
import { LocalAI } from '../internal/app/web/static/assistant/local-ai.js'

const root = { id: 'github.com/gin-gonic/gin@v1.10.0', name: 'github.com/gin-gonic/gin', version: 'v1.10.0', root: true, lenses: { openssf: { details: { projectId: 'github.com/gin-gonic/gin' } } } }
const net = { id: 'golang.org/x/net@v0.25.0', name: 'golang.org/x/net', version: 'v0.25.0', direct: true, openssf: { projectId: 'github.com/golang/net' } }
const graph = { rootId: root.id, nodes: [root, net], edges: [{ source: root.id, target: net.id }] }
const context = { graph, selected: root.id, lens: 'openssf' }

test('repository questions include the observed source link, not a Scorecard substitution', () => {
  const question = "Where's the repository on github?"
  const packet = customPacket(question, context)
  assert.equal(packet.question, question)
  assert.equal(packet.topic, 'repository')
  assert.equal(packet.facts[0].repositoryURL, 'https://github.com/gin-gonic/gin')
  assert.match(packet.facts[0].repositoryMapping, /Source project mapping/)
  assert.equal(packet.sources[0].url, 'https://github.com/gin-gonic/gin')
  assert.equal(packet.facts.length, 1) // Repository-only questions receive identity, not unrelated release facts.
  assert.ok(!packet.facts.some(fact => fact.investigation === 'scorecard'))
})
test('repository lookup distinguishes mappings, path inferences, missing data, and replacements', () => {
  assert.equal(repositoryFor(net).url, 'https://github.com/golang/net')
  const nested = { name: 'github.com/acme/repo/submodule/v2', version: 'v2.1.0' }
  assert.deepEqual(repositoryFor(nested), { url: 'https://github.com/acme/repo', project: 'github.com/acme/repo', inferred: true })
  assert.equal(repositoryFor({ name: 'example.org/vanity', version: 'v1.0.0' }), null)
  assert.equal(repositoryFor({ name: 'example.org/a', version: 'v1.0.0', openssf: { projectId: 'github.com/../../private' } }), null)
  assert.equal(repositoryFor({ name: 'example.org/a', version: 'v1.0.0', replaced: true, replacement: '../local' }), null)
  const fork = { ...nested, replaced: true, replacement: 'github.com/fork/project@v2.1.0' }
  assert.equal(repositoryFor(fork).url, 'https://github.com/fork/project')
})
test('custom module questions resolve full names and unambiguous aliases, with scoped conversational references', () => {
  assert.equal(questionContext('Why is golang.org/x/net included?', context).selected, net.id)
  assert.equal(questionContext('Why is x/net included?', context).selected, net.id)
  const history = [{ selected: net.id }]
  assert.equal(questionContext('Where is its repository?', context, history).selected, net.id)
  assert.equal(questionContext('Where is the root module repository?', { ...context, selected: net.id }, history).selected, root.id)
  const packet = customPacket('Why is x/net included?', questionContext('Why is x/net included?', context))
  assert.deepEqual(packet.facts.find(fact => fact.investigation === 'paths').path, [root.id, net.id])
  assert.equal(packet.facts[0].repositoryURL, 'https://github.com/golang/net')
  assert.ok(customTopics('Are there vulnerabilities or license issues?').includes('advisories'))
  assert.ok(customTopics('Are there vulnerabilities or license issues?').includes('licenses'))
})
test('custom prompts retain only recent completed history from the current graph revision', () => {
  const turns = [
    { revision: 1, question: 'Old graph', answer: 'Old answer' },
    { revision: 2, question: 'First', answer: 'First answer' },
    { revision: 2, question: 'Second', answer: 'Second answer', selected: net.id },
    { revision: 2, question: 'Third', answer: 'Third answer', selected: root.id },
    { revision: 2, question: 'Canceled' },
  ]
  assert.deepEqual(recentHistory(turns, 2).map(turn => turn.question), ['Second', 'Third'])
  assert.equal(recentHistory(turns, 2)[0].selected, net.id)
  assert.deepEqual(recentHistory([], 2), [])
})
test('custom answers require the model, stream its reply, and propagate failure without a canned fallback', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } })
  const chunks = [], requests = []
  let fail = false
  const worker = {
    terminate() {},
    postMessage(data) {
      requests.push(data)
      queueMicrotask(() => {
        if (data.type === 'init') this.onmessage({ data: { id: data.id, value: true } })
        else if (fail) this.onmessage({ data: { id: data.id, error: 'Inference failed' } })
        else {
          this.onmessage({ data: { id: data.id, type: 'token', text: 'The repository is ' } })
          this.onmessage({ data: { id: data.id, value: { text: 'The repository is https://github.com/gin-gonic/gin. [R]' } } })
        }
      })
    },
  }
  const ai = new LocalAI({ workerFactory: () => worker })
  try {
    const packet = customPacket("Where's the repository on github?", context)
    await assert.rejects(ai.answer(packet.question, packet, []), /Load the local model/)
    await ai.enable()
    assert.match(await ai.answer(packet.question, packet, [], undefined, text => chunks.push(text)), /https:\/\/github.com\/gin-gonic\/gin/)
    assert.deepEqual(chunks, ['The repository is '])
    assert.equal(requests.at(-1).type, 'answer')
    assert.equal(requests.at(-1).question, packet.question)
    assert.match(requests.at(-1).evidence, /Source repository URL: https:\/\/github.com\/gin-gonic\/gin/)
    fail = true
    await assert.rejects(ai.answer('Another question', packet, []), /Inference failed/)
    assert.equal(ai.pending.size, 0)
  } finally {
    ai.stop()
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  }
})

test('explicit inclusion questions use verified graph paths without turning unrelated custom questions into paths', () => {
  assert.equal(customInvestigation('Why is golang.org/x/net included?'), 'paths')
  assert.equal(customInvestigation('How is x/net connected to the root?'), 'paths')
  assert.equal(customInvestigation("Where's the repository on github?"), null)
  assert.equal(customInvestigation('Why was this version selected?'), null)
  assert.equal(customInvestigation('Why does my program crash?'), null)
  assert.equal(customInvestigation('Does my function import x/net?'), null)
})

test('available-lens questions use the actual registry without module highlights or external lookups', () => {
  for (const question of ['Which lenses are available', 'What analysis lenses are supported?', 'List all lenses', 'Show me the available lenses']) {
    assert.equal(customInvestigation(question), 'lenses', question)
  }
  assert.equal(customInvestigation('Which lens should I use for licenses?'), null)
  assert.equal(customInvestigation('Which lenses can detect vulnerabilities?'), null)
  assert.deepEqual(requiredEvidence('lenses'), [])
  const answer = answerQuestion('lenses', context)
  assert.deepEqual(answer.items.map(item => item.label), browserLenses.map(lens => lens.label))
  assert.ok(answer.items.every(item => item.detail))
  assert.equal(answer.items.length, browserLenses.length)
  assert.deepEqual(answer.actions, [])
  assert.deepEqual(answer.sources, [])
  const packet = customPacket('Which lens should I use for release freshness?', context)
  assert.equal(packet.topic, 'lenses')
  assert.deepEqual(packet.actions, [])
  assert.deepEqual(packet.facts[0].findings.map(item => item.module), browserLenses.map(lens => lens.label))
  assert.ok(!packet.facts.some(fact => fact.investigation === 'overview'))
})
