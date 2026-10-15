import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedLens, lensURL } from '../internal/app/web/static/analysis/navigation.js'
import { freshnessRecord, readFreshness } from '../internal/app/web/static/analysis/freshness.js'
import { groupedItems } from '../internal/app/web/static/analysis/ui.js'
import { browserLenses, defaultLensID } from '../internal/app/web/static/analysis/registry.js'

test('registered browser lenses have unique routes and import usable implementations without a browser', async () => {
  assert.equal(new Set(browserLenses.map(lens => lens.id)).size, browserLenses.length)
  assert.equal(new Set(browserLenses.map(lens => lens.key)).size, browserLenses.length)
  assert.ok(browserLenses.some(lens => lens.id === defaultLensID))
  for (const registration of browserLenses) {
    assert.match(registration.id, /^[a-z][a-z0-9-]*$/)
    assert.equal(selectedLens(registration.id), registration.id)
    for (const field of ['key', 'title', 'label', 'icon']) assert.ok(registration[field], `${registration.id}.${field}`)
    const { default: lens } = await registration.importModule()
    assert.equal(typeof lens.load, 'function', registration.id + '.load')
    assert.equal(typeof lens.render, 'function', registration.id + '.render')
    assert.equal(typeof lens.scope, 'string', registration.id + '.scope')
    for (const field of ['selection', 'modulePicker']) {
      if (lens[field] !== undefined) assert.equal(typeof lens[field], 'boolean', registration.id + '.' + field)
    }
    for (const field of ['colors', 'status']) {
      if (lens[field] !== undefined) assert.equal(typeof lens[field], 'function', registration.id + '.' + field)
    }
  }
})

test('old comparison links discard v and removed lenses while retaining module targets and unrelated parameters', () => {
  const original = 'https://example.org/subdir/?lens=impact&debug=true&v=3#target=github.com%2Fgin-gonic%2Fgin%40v1.10.0'
  const result = lensURL(original, 'impact')
  assert.equal(result.searchParams.has('v'), false)
  assert.equal(result.searchParams.has('lens'), false)
  assert.equal(result.searchParams.get('debug'), 'true')
  assert.equal(result.hash, new URL(original).hash)
  assert.equal(result.pathname, '/subdir/')
  for (const id of ['openssf', 'release-freshness', 'vulnerabilities', 'licenses']) {
    assert.equal(selectedLens(id), id)
    assert.equal(lensURL(original, id).searchParams.get('lens'), id === 'openssf' ? null : id)
  }
  for (const id of [null, '', 'impact', 'unexpected']) assert.equal(selectedLens(id), 'openssf')
})

test('release queues preserve resolved replacement identities and source failures without classifying them as current', async () => {
  const node = { id: 'a', name: 'example.org/original', version: 'v1.0.0', replaced: true, lenses: { 'release-freshness': { status: 'patch_behind', details: { module: 'example.org/replacement', version: 'v2.0.0', latestVersion: 'v2.0.1' } } } }
  const record = freshnessRecord(node)
  assert.equal(record.module, 'example.org/replacement')
  assert.equal(record.version, 'v2.0.0')
  assert.equal(record.latest, 'v2.0.1')
  assert.equal(record.status, 'patch_behind')
  for (const status of ['error', 'skipped', 'unavailable', 'future-status']) {
    const result = freshnessRecord({ ...node, lenses: { 'release-freshness': { status, message: 'Source unavailable' } } })
    assert.equal(result.status, 'unknown')
    assert.equal(result.sourceStatus, status)
    assert.equal(result.message, 'Source unavailable')
    assert.equal(result.latest, '')
  }
  for (const status of ['pseudo_version', 'prerelease']) assert.equal(freshnessRecord({ ...node, lenses: { 'release-freshness': { status } } }).status, 'preview')
  const data = await readFreshness({ nodes: [node, { id: 'b', name: 'no-metadata' }] })
  assert.equal(data.records.size, 2)
  assert.equal(data.records.get('b').status, 'unknown')
  assert.equal(data.records.get('b').version, '')
})

test('advisory result groups keep failed observations separate from successful empty results', () => {
  const items = [
    { id: 'matched', status: 'matched', advisories: ['GO-EXAMPLE'] },
    { id: 'clear', status: 'clear', advisories: [] },
    { id: 'failed', status: 'unknown', error: 'Request failed' },
  ]
  const groups = groupedItems(items, [['matched', 'Advisory matches'], ['clear', 'No matches'], ['unknown', 'Unknown']])
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [['matched'], ['clear'], ['failed']])
  assert.equal(groups[2].items[0].error, 'Request failed')
  assert.equal(groupedItems([items[1]], [['matched', 'Advisory matches']])[0].items.length, 0)
})
