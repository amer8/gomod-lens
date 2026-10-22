import test from 'node:test'
import assert from 'node:assert/strict'
import { licenseIDsIn, licenseQuery, matchesLicense } from '../internal/app/web/static/assistant/license-query.js'
import { customTopics, customPacket, evidenceText } from '../internal/app/web/static/assistant/custom.js'
import { answerQuestion } from '../internal/app/web/static/assistant/queries.js'

const nodes = Array.from({ length: 18 }, (_, index) => ({ id: 'module-' + index, name: index === 17 ? 'github.com/davecgh/go-spew' : 'example.org/module-' + index, version: 'v1.0.0', root: index === 0 }))
const graph = { rootId: nodes[0].id, nodes, edges: [] }
const context = { graph, selected: nodes[0].id, lens: 'licenses' }
const observed = expressions => ({ status: 'observed', expressions })
const records = new Map(nodes.map(node => [node.id, observed(node.id === 'module-17' ? ['ISC'] : ['MIT'])]))
const evidence = { licenses: { records, capturedAt: '2026-10-21T20:35:55Z' } }

test('license identifiers route to license evidence without requiring the word license', () => {
  for (const id of ['ISC', 'MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0-only', 'LGPL-2.1-or-later', '0BSD', 'Zlib']) {
    const question = 'Which modules use ' + id
    assert.ok(customTopics(question).includes('licenses'), question)
    assert.deepEqual(licenseQuery(question), { ids: [id], mode: 'any' })
  }
  for (const question of ['Which dependency has ISC license?', 'Which dependency has an ISC license?', 'Which dependencies have ISC?', 'Which package carries an ISC license?', 'Which module is licensed under ISC?']) assert.deepEqual(licenseQuery(question), { ids: ['ISC'], mode: 'any' }, question)
  assert.deepEqual(licenseIDsIn('Which modules use isc?'), ['isc'])
  assert.deepEqual(licenseQuery('Which modules are ISC-licensed?'), { ids: ['ISC'], mode: 'any' })
  for (const question of ['DISCARD HTTP packages', 'Which modules use LicenseRef-MIT?', 'Why is github.com/isc/package included?']) assert.deepEqual(licenseIDsIn(question), [])
  for (const question of ['Which modules do not use ISC?', 'Which modules use only MIT?', 'Why do modules use ISC?', 'Which modules use ISC and where are their repositories?', 'Which modules use MIT and ISC or Apache-2.0?', 'Which direct dependencies use ISC?', 'Which modules use ISC and have vulnerabilities?', 'Which modules use ISC and are behind a release?']) assert.equal(licenseQuery(question), null)
})
test('ISC inventory filtering scans all modules, beyond both prompt and display limits', () => {
  const question = 'Which modules use ISC'
  const answer = answerQuestion('licenses', context, evidence, { licenseQuery: licenseQuery(question) })
  assert.deepEqual(answer.items.map(item => item.label), ['github.com/davecgh/go-spew'])
  assert.equal(answer.items[0].detail, 'ISC')
  assert.match(answer.paragraphs[0], /1 module has.*ISC.*18 of 18.*0 remain unknown/)
  assert.deepEqual(answer.actions.find(action => action.label === 'Highlight license matches').ids, ['module-17'])
  assert.equal(answer.observedAt, evidence.licenses.capturedAt)
  const packet = customPacket(question, context, evidence)
  const fact = packet.facts.find(fact => fact.investigation === 'licenses')
  assert.equal(packet.topic, 'licenses')
  assert.equal(fact.findings.length, 1)
  assert.equal(fact.findings[0].module, 'github.com/davecgh/go-spew')
  assert.match(evidenceText(packet.facts), /github.com\/davecgh\/go-spew: ISC/)
})
test('other custom questions prioritize named license matches before bounding model evidence', () => {
  const packet = customPacket('Explain ISC evidence for these modules', context, evidence)
  const licenses = packet.facts.find(fact => fact.investigation === 'licenses')
  assert.equal(licenses.findings[0].module, 'github.com/davecgh/go-spew')
  assert.equal(licenses.omittedFindings, 14)
})
test('license filtering preserves expressions and compares complete identifiers, not substrings or exceptions', () => {
  assert.equal(matchesLicense(observed(['(MIT OR ISC)']), { ids: ['isc'], mode: 'any' }), true)
  assert.equal(matchesLicense(observed(['LicenseRef-ISC']), { ids: ['ISC'], mode: 'any' }), false)
  assert.equal(matchesLicense(observed(['ISC-exception']), { ids: ['ISC'], mode: 'any' }), false)
  assert.equal(matchesLicense(observed(['MIT WITH ISC']), { ids: ['ISC'], mode: 'any' }), false)
  assert.equal(matchesLicense(observed(['MIT', 'ISC']), { ids: ['MIT', 'ISC'], mode: 'all' }), true)
  assert.equal(matchesLicense(observed(['MIT']), { ids: ['MIT', 'ISC'], mode: 'all' }), false)
  assert.equal(matchesLicense(observed(['MIT']), { ids: ['MIT', 'ISC'], mode: 'any' }), true)
  const data = { licenses: { records: new Map([[nodes[0].id, observed(['MIT OR ISC'])]]) } }
  const answer = answerQuestion('licenses', context, data, { licenseQuery: licenseQuery('Which modules use MIT and ISC?') })
  assert.equal(answer.items[0].detail, 'MIT OR ISC')
  assert.match(answer.paragraphs.join(' '), /does not establish.*apply together/)
})
test('missing or failed observations cannot prove that no modules use a license', () => {
  for (const data of [{}, { licenses: { error: 'HTTP 503' } }, { licenses: { records: new Map([[nodes[0].id, { status: 'error', expressions: ['ISC'] }]]) } }]) {
    const answer = answerQuestion('licenses', context, data, { licenseQuery: licenseQuery('Which modules use ISC?') })
    assert.equal(answer.items.length, 0)
    assert.match(answer.paragraphs.join(' '), /18 remain unknown/)
    assert.match(answer.paragraphs.join(' '), /cannot establish absence/)
    assert.ok(!answer.actions.some(action => action.label === 'Highlight license matches'))
  }
  const failed = answerQuestion('licenses', context, { licenses: { error: 'HTTP 503' } }, { licenseQuery: licenseQuery('Which modules use ISC?') })
  assert.match(failed.paragraphs.join(' '), /503/)
})
test('filtered license answers keep resolved replacement identities and exact-version sources', () => {
  const identity = { name: 'github.com/fork/project', version: 'v2.0.0' }
  const source = 'https://api.deps.dev/v3/systems/GO/packages/github.com%2Ffork%2Fproject/versions/v2.0.0'
  const data = { licenses: { records: new Map([[nodes[0].id, { ...observed(['ISC']), identity, source }]]) } }
  const answer = answerQuestion('licenses', context, data, { licenseQuery: licenseQuery('Which modules use ISC?') })
  assert.match(answer.items[0].detail, /resolved github.com\/fork\/project@v2.0.0/)
  assert.equal(answer.sources.at(-1).url, source)
  assert.match(answer.scope, /does not establish license compatibility/)
})
