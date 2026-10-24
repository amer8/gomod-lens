import test from 'node:test'
import assert from 'node:assert/strict'
import lens from '../internal/app/web/static/analysis/go-requirements.js'
import { classifyRequirement, compareGoVersions, defaultTarget, goModURL, lookupGoRequirements, readGoMinimum, requirementColors, requirementPath, requirementSummary, requirementVersionColors, targetGoVersion } from '../internal/app/web/static/analysis/go-requirements-data.js'
import { clearPublicCache } from '../internal/app/web/static/analysis/public-data.js'

const root = Object.freeze({ id: 'root', name: 'example.org/root', version: 'v1.0.0' })
const dependency = Object.freeze({ id: 'dep', name: 'example.org/dependency', version: 'v2.0.0' })
const unknown = Object.freeze({ id: 'unknown', name: 'example.org/unknown', version: 'v1.0.0' })
const graph = Object.freeze({ rootId: 'root', nodes: Object.freeze([root, dependency, unknown]), edges: Object.freeze([Object.freeze({ source: 'root', target: 'dep' })]) })
const data = { records: new Map([
  ['root', { status: 'observed', minimum: '1.26', implicit: false }],
  ['dep', { status: 'observed', minimum: '1.27.0', implicit: false }],
  ['unknown', { status: 'unknown', error: 'offline' }],
]) }

test('minimum parsing handles comments, quoted versions and implicit legacy minimums', () => {
  assert.deepEqual(readGoMinimum('module example.org/a\ngo 1.26.7 // minimum\ntoolchain go1.27.3'), { minimum: '1.26.7', implicit: false })
  assert.deepEqual(readGoMinimum('/* go 1.99 */\nmodule "example.org/a"\ngo "1.26"\n// go 1.28'), { minimum: '1.26', implicit: false })
  assert.deepEqual(readGoMinimum('module "example.org/go//path"\n// go 1.99\ntoolchain go1.27.3'), { minimum: '1.16', implicit: true })
  for (const body of ['', '<html>error</html>', 'module x\ngo invalid', 'module x\ngo 1.26\ngo 1.27', 'module x\ngo', 'module x\n/* unfinished', 'module x\ngo 1.026', 'module x\ngo go1.26', 'module x\ngo"1.26"']) assert.throws(() => readGoMinimum(body), body)
})

test('Go versions compare numerically with Go language, beta, RC and patch ordering', () => {
  const versions = ['1.20rc2', '1.20', '1.20.1', '1.21', '1.21beta1', '1.21beta2', '1.21rc1', '1.21rc10', '1.21.0', '1.21.1', '1.26.9', '1.26.10', '1.27rc1', '1.27.0']
  for (let i = 1; i < versions.length; i++) assert(compareGoVersions(versions[i - 1], versions[i]) < 0, versions[i])
  assert.equal(compareGoVersions('1.20', '1.20.0'), 0)
  assert(compareGoVersions('1.26.9007199254740993', '1.26.9007199254740992') > 0)
  assert.throws(() => compareGoVersions('invalid', '1.26'))
  assert.equal(targetGoVersion(' go1.26 '), '1.26.0')
  assert.equal(targetGoVersion('1.27rc1'), '1.27rc1')
  assert.equal(targetGoVersion('1.26.10'), '1.26.10')
  assert.equal(targetGoVersion('1.26.01'), '')
})

test('an older minimum is satisfied, while patch and prerelease requirements remain meaningful', () => {
  const record = minimum => ({ status: 'observed', minimum })
  assert.equal(classifyRequirement(record('1.16'), '1.27.3'), 'meets')
  assert.equal(classifyRequirement(record('1.26.10'), '1.26.9'), 'newer')
  assert.equal(classifyRequirement(record('1.27.0'), '1.27rc1'), 'newer')
  assert.equal(classifyRequirement(record('1.27'), '1.27rc1'), 'meets')
  assert.equal(classifyRequirement({ status: 'unknown' }, '1.26.10'), 'unknown')
  assert.equal(classifyRequirement(record('1.26'), ''), 'unknown')
})

test('lookup reads exact resolved replacement versions and retains source evidence on failures', async () => {
  clearPublicCache()
  const replaced = { id: 'fork', name: 'original.org/lib', version: 'v1.0.0', replaced: true, replacement: 'github.com/Acme/Fork@v2.0.0+incompatible' }
  const local = { id: 'local', name: 'original.org/local', version: 'v1.0.0', replaced: true, replacement: '../private' }
  const missing = { id: 'missing', name: 'original.org/missing' }
  const requests = []
  const result = await lookupGoRequirements({ nodes: [root, replaced, local, missing, unknown] }, { fetcher: async (url, options) => {
    requests.push(url)
    assert.equal(options.credentials, 'omit')
    assert(options.signal)
    if (url.includes('/unknown/')) return { ok: false, status: 503 }
    // A fork can retain the original module declaration. Source URL identity matters.
    return { ok: true, text: async () => 'module original.org/lib\ngo 1.20\ntoolchain go1.27.3' }
  } })
  assert.equal(requests.length, 3)
  assert(requests.includes('https://proxy.golang.org/github.com/!acme/!fork/@v/v2.0.0%2Bincompatible.mod'))
  assert.deepEqual(result.records.get('fork').identity, { name: 'github.com/Acme/Fork', version: 'v2.0.0+incompatible' })
  assert.equal(result.records.get('fork').minimum, '1.20')
  assert(result.records.get('fork').observedAt)
  assert.equal(result.records.get('local').status, 'unknown')
  assert.equal(result.records.get('missing').status, 'unknown')
  assert.equal(result.records.get('unknown').status, 'unknown')
  assert.match(result.records.get('unknown').error, /503/)
  assert.match(result.records.get('unknown').source, /v1.0.0.mod$/)
  assert.match(goModURL({ name: 'example.org/A', version: 'v1.0.0-RC1' }), /!a\/@v\/v1.0.0-!r!c1.mod$/)
})

test('malformed metadata remains unknown and cancellation cannot complete a stale lookup', async () => {
  clearPublicCache()
  const invalid = await lookupGoRequirements(graph, { fetcher: async () => ({ ok: true, text: async () => '<html>upstream failed</html>' }) })
  assert([...invalid.records.values()].every(record => record.status === 'unknown' && !record.minimum))
  clearPublicCache()
  const controller = new AbortController()
  await assert.rejects(lookupGoRequirements(graph, { signal: controller.signal, fetcher: async () => {
    controller.abort()
    return { ok: true, text: async () => 'module example.org/a\ngo 1.26' }
  } }), { name: 'AbortError' })
  await assert.rejects(lens.load({ nodes: [] }, { signal: controller.signal }), { name: 'AbortError' })
})

test('summary retains partial observations without mutating the graph', () => {
  const summary = requirementSummary(graph, data, '1.26.10')
  assert.equal(summary.highest, '1.27.0')
  assert.deepEqual(summary.newer.map(item => item.node.id), ['dep'])
  assert.deepEqual(summary.unknown.map(item => item.node.id), ['unknown'])
  assert.deepEqual(summary.minimums, [['1.27.0', 1], ['1.26', 1]])
  assert.equal(defaultTarget(graph, data), '1.26.0')
  assert.equal(defaultTarget(graph, { records: new Map([['dep', data.records.get('dep')]]) }), '1.27.0')
  assert.equal(data.records.get('dep').minimum, '1.27.0')
})

test('release groups share legend colors across exact versions, target, selection and node-order changes', () => {
  const minimums = ['1.25.0', '1.24.0', '1.24', '1.23.0', '1.23', '1.22', '1.21.0', '1.21', '1.20', '1.19', '1.18', '1.17', '1.16', '1.15', '1.13', '1.12', '1.11', '1.9', '1.27rc1', '1.27.0', '1.20.0']
  const nodes = minimums.map((minimum, index) => ({ id: String(index) }))
  nodes.push({ id: 'same-minimum' }, { id: 'failed' }, { id: 'invalid' }, { id: 'missing' })
  const records = new Map(minimums.map((minimum, index) => [String(index), { status: 'observed', minimum }]))
  records.set('same-minimum', { status: 'observed', minimum: minimums[0] })
  records.set('failed', { status: 'unknown', minimum: minimums[0] })
  records.set('invalid', { status: 'observed', minimum: 'invalid' })
  const value = { nodes }, observations = { records }
  const legend = requirementVersionColors(value, observations)
  assert.equal(legend.size, minimums.length)
  assert.equal(new Set(legend.values()).size, 5)
  assert.equal(legend.get('1.24'), legend.get('1.24.0'))
  assert.equal(legend.get('1.27rc1'), legend.get('1.27.0'))
  assert.equal(legend.get('1.12'), legend.get('1.9'))
  assert.notEqual(legend.get('1.27.0'), legend.get('1.25.0'))
  const colors = requirementColors(value, observations, '0', { target: '1.16.0' })
  minimums.forEach((minimum, index) => assert.equal(colors[String(index)], legend.get(minimum)))
  assert.equal(colors['same-minimum'], colors['0'])
  for (const id of ['failed', 'invalid', 'missing']) assert.equal(colors[id], '#8b95a7')
  assert.deepEqual(requirementColors(value, observations, '1', { target: '1.27.3' }), colors)
  assert.deepEqual(requirementColors({ nodes: [...nodes].reverse() }, observations), colors)
  assert.deepEqual(requirementColors(graph, { error: 'offline' }), { root: '#8b95a7', dep: '#8b95a7', unknown: '#8b95a7' })
})

test('overview keeps four release families, combines earlier minimums and preserves exact comparisons', () => {
  const minimums = ['1.27.0', '1.26', '1.26.10', '1.25rc1', '1.25.0', '1.24.3', '1.23', '1.22', '1.16', 'invalid', undefined]
  const nodes = minimums.map((minimum, index) => ({ id: String(index), name: 'example.org/module-' + index }))
  const records = new Map(minimums.map((minimum, index) => [String(index), { status: 'observed', minimum }]))
  const summary = requirementSummary({ nodes }, { records }, '1.26.9')
  assert.deepEqual(summary.groups.map(group => [group.id, group.label, group.items.length]), [
    ['1.27', 'Go 1.27', 1], ['1.26', 'Go 1.26', 2], ['1.25', 'Go 1.25', 2], ['1.24', 'Go 1.24', 1],
    ['earlier', 'Go 1.23 and earlier', 3], ['unknown', 'Unknown', 2],
  ])
  assert.equal(new Set(summary.groups.flatMap(group => group.items.map(item => item.node.id))).size, nodes.length)
  assert.equal(summary.groups.reduce((total, group) => total + group.items.length, 0), nodes.length)
  assert.deepEqual(summary.groups[1].items.map(item => [item.record.minimum, item.status]), [['1.26', 'meets'], ['1.26.10', 'newer']])
  assert.equal(summary.highest, '1.27.0')
  assert.deepEqual(summary.newer.map(item => item.record.minimum), ['1.27.0', '1.26.10'])
  assert.match(summary.items[2].search, /Go 1\.26\.10/)
  assert.deepEqual(summary.groups[4].items.map(item => item.record.minimum), ['1.23', '1.22', '1.16'])
})

test('small graphs omit empty earlier and unknown groups, and failed metadata is never grouped as observed', () => {
  const small = requirementSummary(graph, data, '1.27.3')
  assert.deepEqual(small.groups.map(group => group.id), ['1.27', '1.26', 'unknown'])
  const observed = { records: new Map([['root', { status: 'observed', minimum: '1.24' }], ['dep', { status: 'observed', minimum: '1.24.0' }]]) }
  assert.deepEqual(requirementSummary({ nodes: [root, dependency] }, observed, '').groups.map(group => group.id), ['1.24'])
  const failed = { records: new Map([['root', { status: 'unknown', minimum: '1.27.0' }]]) }
  const unavailable = requirementSummary(graph, failed, '1.26.0')
  assert.deepEqual(unavailable.groups.map(group => [group.id, group.items.length]), [['unknown', 3]])
  assert.equal(unavailable.highest, '')
  assert.deepEqual(requirementSummary({ nodes: [] }, {}, '').groups, [])
})

test('requirement paths handle cycles, shared modules, roots and disconnected nodes', () => {
  const value = { rootId: 'a', nodes: ['a', 'b', 'c', 'd', 'isolated'].map(id => ({ id })), edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'b', target: 'd' }, { source: 'd', target: 'a' }, { source: 'c', target: 'd' }] }
  assert.deepEqual(requirementPath(value, 'd'), ['a', 'b', 'd'])
  assert.deepEqual(requirementPath(value, 'a'), ['a'])
  assert.deepEqual(requirementPath(value, 'isolated'), [])
  assert.deepEqual(requirementPath(value, 'missing'), [])
})

test('all modules tying for the highest requirement are included, including equivalent pre-1.21 spellings', () => {
  const records = new Map([
    ['root', { status: 'observed', minimum: '1.20' }],
    ['dep', { status: 'observed', minimum: '1.20.0' }],
  ])
  assert.deepEqual(requirementSummary(graph, { records }, '1.27.3').highestItems.map(item => item.node.id), ['root', 'dep'])
})
