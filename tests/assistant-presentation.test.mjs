import test from 'node:test'
import assert from 'node:assert/strict'
import { answerPreview } from '../internal/app/web/static/assistant/presentation.js'
import { answerQuestion } from '../internal/app/web/static/assistant/queries.js'
import { customPacket } from '../internal/app/web/static/assistant/custom.js'
import { licenseQuery } from '../internal/app/web/static/assistant/license-query.js'

const nodes = Array.from({ length: 57 }, (_, index) => ({ id: 'module-' + index, name: index === 6 ? 'github.com/davecgh/go-spew' : 'example.org/module-' + index, version: 'v1.0.0', root: index === 0 }))
const context = { selected: nodes[0].id, graph: { nodes, edges: [], rootId: nodes[0].id } }
const records = new Map(nodes.map((node, index) => [node.id, { status: 'observed', expressions: index === 6 ? ['ISC'] : index % 2 ? ['Apache-2.0'] : ['MIT'] }]))
const evidence = { licenses: { records } }

test('license overview retains grouped counts and displays all module details by default', () => {
  const answer = answerQuestion('licenses', context, evidence), preview = answerPreview(answer)
  assert.deepEqual(preview.paragraphs, ['57/57 modules have license metadata.'])
  assert.deepEqual(preview.items, answer.items)
  assert.equal(preview.items.length, 57)
  assert.equal(answer.items.length, 57)
  assert.deepEqual(preview.groups.map(group => [group.label, group.ids.length]), [['Apache-2.0', 28], ['MIT', 28], ['ISC', 1]])
  assert.deepEqual(preview.groups.find(group => group.label === 'ISC').ids, ['module-6'])
})
test('the exact reported ISC wording produces one concrete compact result without a count or scope dump', () => {
  const query = licenseQuery('Which dependency has ISC license?')
  assert.notEqual(query, null)
  const answer = answerQuestion('licenses', context, evidence, { licenseQuery: query }), preview = answerPreview(answer)
  assert.equal(preview.compact, true)
  assert.deepEqual(preview.paragraphs, [])
  assert.deepEqual(preview.items.map(item => [item.label, item.detail]), [['github.com/davecgh/go-spew', 'ISC']])
  assert.equal(answer.licenseSummary.total, 57) // Full audit scope remains available.
})
test('license groups count modules once per exact expression without inventing AND/OR relationships', () => {
  const data = { licenses: { records: new Map([[nodes[0].id, { status: 'observed', expressions: ['MIT', 'MIT', 'Apache-2.0', '(MIT OR ISC)'] }]]) } }
  const answer = answerQuestion('licenses', context, data), preview = answerPreview(answer)
  assert.equal(answer.licenseSummary.multiple, 1)
  assert.match(preview.paragraphs[0], /1 appears in multiple groups/)
  assert.equal(preview.groups.find(group => group.label === 'MIT').ids.length, 1)
  assert.equal(preview.groups.find(group => group.label === '(MIT OR ISC)').ids.length, 1)
  assert.equal(preview.groups.some(group => group.label === 'ISC'), false)
  assert.match(preview.paragraphs.join(' '), /56 modules have unknown/)
})
test('other result lists display every entry without a preview limit', () => {
  const items = Array.from({ length: 14 }, (_, index) => ({ label: 'module-' + index, detail: 'Observed advisory' }))
  const answer = { paragraphs: ['14 modules matched.'], items }
  const preview = answerPreview(answer)
  assert.deepEqual(preview.items, items)
  assert.equal(preview.items.length, 14)
  assert.equal(answer.items.length, 14)
})
test('explanatory custom license questions receive focused evidence and actual module names', () => {
  const packet = customPacket('Explain which dependency has ISC license', context, evidence)
  assert.equal(licenseQuery(packet.question), null) // Genuine custom generation path.
  assert.deepEqual(packet.facts.map(fact => fact.investigation), ['licenses'])
  assert.equal(packet.facts[0].findings[0].module, 'github.com/davecgh/go-spew')
  assert.ok(!packet.sources.some(source => /source repository/.test(source.label)))
})
