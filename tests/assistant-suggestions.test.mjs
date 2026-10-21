import test from 'node:test'
import assert from 'node:assert/strict'
import { suggestions, suggestionKey, answerQuestion, requiredEvidence, topicIDs } from '../internal/app/web/static/assistant/queries.js'

const node = (id, status = 'current', direct = false) => ({ id, name: 'example.org/' + id, version: 'v1.0.0', direct, root: id === 'root', lenses: { 'release-freshness': { status, details: { version: 'v1.0.0', latestVersion: status === 'major_behind' ? 'v2.0.0' : 'v1.1.0' } }, openssf: { status: 'found' } } })
const graph = { rootId: 'root', nodes: [node('root'), node('direct', 'major_behind', true), node('shared', 'patch_behind'), node('other', 'current', true)], edges: [{ source: 'root', target: 'direct' }, { source: 'root', target: 'other' }, { source: 'direct', target: 'shared' }, { source: 'other', target: 'shared' }, { source: 'shared', target: 'direct' }] }
const context = { graph, selected: 'root', lens: 'vulnerabilities' }
const advisory = { id: 'GO-EXAMPLE', affected: [{ package: { name: 'example.org/shared', ecosystem: 'Go' }, ranges: [{ events: [{ fixed: 'v1.0.2' }] }] }] }
const clear = () => new Map(graph.nodes.map(node => [node.id, { status: 'clear' }]))
function matchedEvidence() {
  const records = clear(); records.set('shared', { status: 'matched', identity: { name: 'example.org/shared', version: 'v1.0.0' }, groups: [advisory] })
  return { vulnerabilities: { records } }
}
function completed(topic, selected = 'root', filter) { return { topic, selected, answer: 'Completed answer', suggestionKey: suggestionKey(topic, selected, filter) } }

test('starters use observed release counts without inventing unqueried advisory results', () => {
  const next = suggestions({ ...context, lens: 'release-freshness' })
  assert.equal(next.length, 3)
  assert.ok(next.some(q => q.id === 'direct-updates' && /direct dependency/.test(q.label)))
  assert.ok(next.some(q => q.id === 'major-updates'))
  assert.ok(next.some(q => q.id === 'advisories' && /Do any/.test(q.label)))
  assert.ok(!next.some(q => ['fixes', 'introducers', 'reachability'].includes(q.id)))
})
test('an advisory match leads to fixed-version evidence, introducers and a real dependency path', () => {
  const evidence = matchedEvidence()
  const next = suggestions(context, ['advisories'], 'advisories', { evidence, history: [completed('advisories')] })
  assert.deepEqual(new Set(next.map(q => q.id)), new Set(['fixes', 'introducers', 'paths']))
  const path = next.find(q => q.id === 'paths')
  assert.equal(path.nodeID, 'shared')
  assert.match(path.label, /example.org\/shared/)
  assert.deepEqual(answerQuestion(path.id, { ...context, selected: path.nodeID }, evidence).path, ['root', 'direct', 'shared'])
})
test('all-clear observations suppress empty advisory follow-ups while failures remain unknown', () => {
  const evidence = { vulnerabilities: { records: clear() } }
  const next = suggestions(context, ['advisories'], 'advisories', { evidence })
  assert.ok(!next.some(q => ['advisories', 'fixes', 'introducers', 'reachability'].includes(q.id)))
  assert.ok(next.some(q => ['updates', 'direct-updates', 'major-updates'].includes(q.id)))
  const failed = suggestions(context, [], '', { evidence: { vulnerabilities: { error: 'HTTP 503' } } })
  assert.ok(failed.some(q => q.id === 'unknown' && /4 modules/.test(q.label)))
  assert.ok(!failed.some(q => /no matches|safe|all.clear/i.test(q.label)))
})
test('fixed-version questions require an event for the actual resolved module identity', () => {
  const evidence = matchedEvidence()
  evidence.vulnerabilities.records.get('shared').groups = [{ ...advisory, affected: [{ ...advisory.affected[0], package: { name: 'unrelated.org/lib', ecosystem: 'Go' } }] }]
  assert.ok(!suggestions(context, [], 'advisories', { evidence }).some(q => q.id === 'fixes'))
})
test('license follow-ups discover rare identifiers, preserve filters, and track questions beyond their topic', () => {
  const records = new Map([['root', { status: 'observed', expressions: ['MIT'] }], ['direct', { status: 'observed', expressions: ['MIT', 'Apache-2.0'] }], ['shared', { status: 'observed', expressions: ['ISC'] }]])
  const evidence = { licenses: { records } }, ctx = { ...context, lens: 'licenses' }
  const history = [completed('licenses')]
  const next = suggestions(ctx, ['licenses'], 'licenses', { evidence, history })
  const isc = next.find(q => q.licenseQuery)
  assert.match(isc.label, /ISC/)
  assert.deepEqual(answerQuestion(isc.id, ctx, evidence, { licenseQuery: isc.licenseQuery }).items.map(item => item.nodeID), ['shared'])
  assert.ok(next.some(q => q.id === 'license-gaps'))
  history.push(completed(isc.id, isc.nodeID, isc.licenseQuery))
  const following = suggestions(ctx, ['licenses', 'licenses'], 'licenses', { evidence, history })
  assert.ok(!following.some(q => q.key === isc.key))
  assert.ok(following.some(q => q.id === 'license-review'))
  assert.deepEqual(answerQuestion('license-review', ctx, evidence).items.map(item => item.nodeID), ['direct'])
  assert.deepEqual(answerQuestion('license-gaps', ctx, evidence).items.map(item => item.nodeID), ['other'])
  assert.deepEqual(requiredEvidence('license-review'), ['licenses'])
  assert.deepEqual(requiredEvidence('license-gaps'), ['licenses'])
})
test('release queries honor direct and major filters, including replacement observations', () => {
  const nodes = [node('root', 'major_behind'), node('direct', 'patch_behind', true), node('shared', 'major_behind')]
  nodes[2] = { ...nodes[2], replaced: true, replacement: 'example.org/fork@v1.0.0', lenses: { ...nodes[2].lenses, 'release-freshness': { status: 'major_behind', details: { module: 'example.org/fork', version: 'v1.0.0', latestVersion: 'v2.0.0' } } } }
  const ctx = { ...context, graph: { ...graph, nodes } }
  assert.deepEqual(answerQuestion('direct-updates', ctx).items.map(item => item.nodeID), ['direct'])
  assert.deepEqual(answerQuestion('major-updates', ctx).items.map(item => item.nodeID), ['root', 'shared'])
  assert.match(answerQuestion('major-updates', ctx).items[1].detail, /replacement: example.org\/fork/)
  assert.match(answerQuestion('major-updates', ctx).scope, /do not establish.*compatibility/)
})
test('module context changes allow a fresh path question without repeating an answered one', () => {
  const ctx = { ...context, selected: 'other' }, history = [completed('paths', 'shared'), completed('selected', 'other')]
  const next = suggestions(ctx, ['paths', 'selected'], 'selected', { history })
  const path = next.find(q => q.id === 'paths')
  assert.equal(path.nodeID, 'other')
  assert.notEqual(path.key, history[0].suggestionKey)
  assert.ok(!next.some(q => q.nodeID === 'root' && q.id === 'paths'))
})
test('repository questions distinguish missing, healthy, and actionable check reports', () => {
  const ctx = { ...context, lens: 'openssf' }
  for (const report of [{ missing: true, checks: [] }, { error: '503' }, { checks: [{ name: 'Code-Review', score: 9 }] }]) {
    assert.ok(!suggestions(ctx, [], '', { evidence: { openssf: report } }).some(q => q.id === 'scorecard'))
  }
  const next = suggestions(ctx, [], '', { evidence: { openssf: { checks: [{ name: 'Code-Review', score: 2 }, { name: 'Fuzzing', score: null }] } } })
  assert.match(next.find(q => q.id === 'scorecard').label, /2 repository checks/)
})
test('model preferences cannot promote unsupported investigations or override observed relevance', () => {
  const next = suggestions(context, [], 'advisories', { evidence: matchedEvidence(), ranked: ['lenses', 'run-shell', 'overview'] })
  assert.deepEqual(new Set(next.map(q => q.id)), new Set(['fixes', 'introducers', 'paths']))
  for (const q of next) assert.ok(topicIDs.includes(q.id) && graph.nodes.some(node => node.id === q.nodeID))
})

test('small or disconnected graphs keep useful module questions without inventing a path', () => {
  const one = { ...context, graph: { rootId: 'root', nodes: [node('root')], edges: [] } }
  const evidence = { vulnerabilities: { records: new Map([['root', { status: 'clear' }]]) }, licenses: { records: new Map([['root', { status: 'observed', expressions: ['MIT'] }]]) }, openssf: { checks: [{ name: 'Code-Review', score: 9 }] } }
  assert.equal(suggestions(one, [], 'licenses', { evidence }).length, 3)
  assert.ok(!suggestions(one, [], 'licenses', { evidence }).some(q => q.id === 'paths'))
  const disconnected = { ...context, selected: 'shared', graph: { ...graph, edges: [] } }
  assert.ok(!suggestions(disconnected, [], 'selected').some(q => q.id === 'paths'))
})
