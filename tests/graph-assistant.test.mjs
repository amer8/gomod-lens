import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { topicIDs, topics, suggestions, validatePlan, shortestPath, reachableIDs, answerQuestion } from '../internal/app/web/static/assistant/queries.js'
import { LocalAI } from '../internal/app/web/static/assistant/local-ai.js'

const node = (id, direct = false, status = 'current') => ({ id, name: 'example.org/' + id, version: 'v1.0.0', direct, root: id === 'root', lenses: { 'release-freshness': { status, details: { version: 'v1.0.0', latestVersion: 'v1.1.0' } }, openssf: { status: 'found' } } })
const graph = { rootId: 'root', nodes: [node('root'), node('a', true, 'minor_behind'), node('b', true), node('c'), node('unknown', false, 'error')], edges: [{ source: 'root', target: 'a' }, { source: 'root', target: 'b' }, { source: 'a', target: 'c' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }] }
const context = { graph, selected: 'c', lens: 'vulnerabilities' }
const advisory = { id: 'GO-EXAMPLE', affected: [{ package: { name: 'example.org/c', ecosystem: 'Go' }, ranges: [{ events: [{ fixed: 'v1.0.1' }] }] }, { package: { name: 'unrelated.org/lib', ecosystem: 'Go' }, ranges: [{ events: [{ fixed: 'v9.0.0' }] }] }] }
const records = new Map([
  ['root', { status: 'clear' }], ['a', { status: 'clear' }], ['b', { status: 'clear' }],
  ['c', { status: 'matched', identity: { name: 'example.org/c', version: 'v1.0.0' }, groups: [advisory] }],
  ['unknown', { status: 'unknown', error: 'Unavailable' }],
])
const evidence = { vulnerabilities: { records, capturedAt: '2026-10-21T00:00:00Z' } }

test('suggestions stay contextual, distinct, and avoid already answered topics until exhausted', () => {
  for (const lens of ['openssf', 'release-freshness', 'vulnerabilities', 'licenses']) {
    let asked = [], previous = ''
    for (let i = 0; i < 20; i++) {
      const next = suggestions({ ...context, lens }, asked, previous)
      assert.equal(next.length, 3)
      assert.equal(new Set(next.map(q => q.id)).size, 3)
      assert.ok(next.every(q => topicIDs.includes(q.id) && q.id !== previous))
      assert.ok(next.every(q => q.key && graph.nodes.some(node => node.id === q.nodeID)))
      assert.ok(!next.some(q => ['fixes', 'introducers', 'reachability', 'license-review', 'license-gaps'].includes(q.id))) // These need observations we have not loaded.
      previous = next[0].id; asked.push(previous)
    }
  }
  assert.ok(!suggestions({ ...context, selected: graph.rootId }).some(q => q.id === 'paths' && q.nodeID === graph.rootId))
})
test('model plans reject unsupported operations and modules outside the graph', () => {
  assert.throws(() => validatePlan({ topic: 'run-command', command: 'rm -rf /' }, graph))
  assert.throws(() => validatePlan({ topic: 'paths', nodeID: 'outside' }, graph))
  assert.deepEqual(validatePlan({ topic: 'paths', nodeID: 'c' }, graph), { topic: 'paths', nodeID: 'c' })
})
test('path and introducer analysis handle cycles and shared transitive modules', () => {
  assert.deepEqual(shortestPath(graph, 'c'), ['root', 'a', 'c'])
  assert.deepEqual(shortestPath(graph, 'unknown'), [])
  assert.deepEqual(shortestPath(graph, 'root'), ['root'])
  assert.deepEqual([...reachableIDs(graph, 'a')], ['a', 'c'])
  const result = answerQuestion('introducers', context, evidence)
  assert.deepEqual(result.items.map(item => item.nodeID), ['a', 'b'])
  assert.match(result.paragraphs.join(' '), /1 unknown/)
  assert.deepEqual(result.actions[0].ids, ['c'])
})
test('unknown and absent observations never become successful empty results', () => {
  const answer = answerQuestion('advisories', context, evidence)
  assert.match(answer.paragraphs[0], /1 module has.*1 remain unknown.*3 returned no matches/)
  assert.match(answer.scope, /do not establish/)
  const failed = answerQuestion('advisories', context, { vulnerabilities: { error: 'HTTP 503' } })
  assert.match(failed.paragraphs.join(' '), /5 remain unknown/)
  assert.match(failed.paragraphs.join(' '), /503/)
  const missing = answerQuestion('unknown', context)
  assert.equal(missing.paragraphs.filter(text => /not loaded/.test(text)).length, 2)
})
test('fixed-version evidence stays scoped to resolved identity and does not promise compatibility', () => {
  const answer = answerQuestion('fixes', context, evidence)
  assert.match(answer.items[0].detail, /v1.0.1/)
  assert.doesNotMatch(answer.items[0].detail, /v9.0.0/)
  assert.match(answer.paragraphs[0], /not automatically a suitable upgrade/)
  assert.equal(answer.sources.find(source => source.label === 'GO-EXAMPLE').url, 'https://osv.dev/vulnerability/GO-EXAMPLE')
})
test('license, release, and repository answers preserve observation scope and missing data', () => {
  const licenses = answerQuestion('licenses', context, { licenses: { records: new Map([['c', { status: 'observed', expressions: ['MIT', 'Apache-2.0'] }]]) } })
  assert.match(licenses.paragraphs[0], /1 module has.*4 remain unknown/)
  assert.match(licenses.scope, /unspecified relationship/)
  const releases = answerQuestion('updates', context)
  assert.match(releases.paragraphs[0], /1 of 5.*1 have unknown/)
  assert.match(releases.scope, /do not establish.*compatibility/)
  const report = answerQuestion('scorecard', context, { openssf: { missing: true, checks: [] } })
  assert.match(report.paragraphs[0], /No individual/)
  for (const topic of Object.keys(topics)) assert.ok(answerQuestion(topic, context, evidence).paragraphs.length)
})
test('replacement observations retain their real lookup identity in answers', () => {
  const replaced = { ...node('c'), replaced: true, replacement: 'github.com/acme/fork@v2.0.0', lenses: { 'release-freshness': { status: 'patch_behind', details: { module: 'github.com/acme/fork', version: 'v2.0.0', latestVersion: 'v2.0.1' } } } }
  const ctx = { ...context, graph: { ...graph, nodes: [graph.nodes[0], replaced] } }
  const answer = answerQuestion('selected', ctx)
  assert.match(answer.paragraphs.join(' '), /github.com\/acme\/fork@v2.0.0/)
  assert.match(answer.sources[0].url, /github.com%2Facme%2Ffork\/versions\/v2.0.0/)
})
test('chat requires a loaded model and never dispatches model-free requests', async () => {
  const ai = new LocalAI()
  let posted = false
  ai.worker = { postMessage() { posted = true }, terminate() {} }
  await assert.rejects(ai.interpret('Show dependencies', context, []), /Load the local model/)
  assert.equal(posted, false)
})
test('stopping a local-AI request terminates its worker and rejects pending work', async () => {
  let terminated = false
  const ai = new LocalAI()
  ai.worker = { postMessage() {}, terminate() { terminated = true } }; ai.ready = true
  const controller = new AbortController()
  const promise = ai.interpret('Show dependencies', context, [], controller.signal)
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
  assert.equal(terminated, true); assert.equal(ai.pending.size, 0); assert.equal(ai.ready, false)
})
test('server and static builds ship the same assistant code and stylesheet', async () => {
  const server = new URL('../internal/app/web/static/assistant/', import.meta.url), staticDir = new URL('../dist/assets/assistant/', import.meta.url)
  const names = await readdir(server); assert.deepEqual(names, await readdir(staticDir))
  for (const name of names) assert.equal(await readFile(new URL(name, server), 'utf8'), await readFile(new URL(name, staticDir), 'utf8'), name)
  for (const file of ['../internal/app/web/templates/view.html', '../dist/index.html']) assert.match(await readFile(new URL(file, import.meta.url), 'utf8'), /assistant\/assistant.css/)
})
