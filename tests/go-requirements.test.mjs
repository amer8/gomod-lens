import test from 'node:test'
import assert from 'node:assert/strict'
import lens from '../internal/app/web/static/analysis/go-requirements.js'
import { classifyRequirement, compareGoVersions, defaultTarget, goModURL, lookupGoRequirements, requirementColors, requirementPath, requirementSummary, requirementVersionColors, targetGoVersion } from '../internal/app/web/static/analysis/go-requirements-data.js'
import { createGraphModel } from '../internal/app/web/static/graph-model.js'

const root = Object.freeze({ id: 'root', name: 'example.org/root', version: 'v1.0.0' })
const dependency = Object.freeze({ id: 'dep', name: 'example.org/dependency', version: 'v2.0.0' })
const unknown = Object.freeze({ id: 'unknown', name: 'example.org/unknown', version: 'v1.0.0' })
const graph = Object.freeze({ rootId: 'root', nodes: Object.freeze([root, dependency, unknown]), edges: Object.freeze([Object.freeze({ source: 'root', target: 'dep' })]) })
const data = { records: new Map([
  ['root', { status: 'observed', minimum: '1.26', implicit: false }],
  ['dep', { status: 'observed', minimum: '1.27.0', implicit: false }],
  ['unknown', { status: 'unknown', error: 'offline' }],
]) }

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

const observation = (node, minimum = '1.26') => ({ status: 'observed', minimum, implicit: false, identity: { name: node.name, version: node.version }, source: goModURL(node), observedAt: '2026-10-27T10:00:00Z' })

test('graph metadata is reused and only missing exact versions go to WASM', async () => {
  const seededRoot = Object.freeze({ ...root, goRequirement: observation(root) })
  const snapshot = Object.freeze({ ...graph, nodes: Object.freeze([seededRoot, dependency, unknown]) })
  const calls = []
  const lookup = async (nodes, options) => {
    calls.push(nodes.map(node => node.id))
    options.onProgress({ done: nodes.length, total: nodes.length })
    return { records: Object.fromEntries(nodes.map(node => [node.id, observation(node, '1.27.0')])) }
  }
  const progress = []
  const result = await lookupGoRequirements(snapshot, { lookup, progress: (done, total) => progress.push([done, total]) })
  assert.deepEqual(calls, [['dep', 'unknown']])
  assert.equal(result.records.get('root').minimum, '1.26')
  assert.equal(result.records.get('root').observedAt, seededRoot.goRequirement.observedAt)
  assert.equal(result.records.get('dep').minimum, '1.27.0')
  assert.deepEqual(progress.at(-1), [3, 3])
  result.records.get('dep').minimum = '1.99'
  const again = await lookupGoRequirements(snapshot, { lookup })
  assert.equal(calls.length, 1, 'supplemental metadata is reused without mutating the graph')
  assert.equal(again.records.get('dep').minimum, '1.27.0')
  assert.equal(dependency.goRequirement, undefined)
})

test('Refresh replaces seeded and supplemental observations, including failed results', async () => {
  const node = { ...root, goRequirement: observation(root) }, snapshot = { nodes: [node] }
  assert.equal((await lookupGoRequirements(snapshot)).records.get('root').minimum, '1.26')
  let refreshOption
  const refreshed = await lookupGoRequirements(snapshot, { refresh: true, lookup: async (_, options) => {
    refreshOption = options.refresh
    return { records: { root: observation(root, '1.26.7') } }
  } })
  assert.equal(refreshOption, true)
  assert.equal(refreshed.records.get('root').minimum, '1.26.7')
  assert.equal((await lookupGoRequirements(snapshot)).records.get('root').minimum, '1.26.7')
  const failed = await lookupGoRequirements(snapshot, { refresh: true, lookup: async () => { throw new Error('HTTP 503') } })
  assert.equal(failed.records.get('root').status, 'unknown')
  assert.match(failed.records.get('root').error, /503/)
})

test('an older supplemental lookup cannot overwrite observations from Refresh', async () => {
  const snapshot = { nodes: [root] }
  let completeOld
  const old = lookupGoRequirements(snapshot, { lookup: () => new Promise(resolve => { completeOld = resolve }) })
  await lookupGoRequirements(snapshot, { refresh: true, lookup: async () => ({ records: { root: observation(root, '1.26.7') } }) })
  completeOld({ records: { root: observation(root, '1.26') } }); await old
  assert.equal((await lookupGoRequirements(snapshot)).records.get('root').minimum, '1.26.7')
})

test('lookup preserves resolved replacements, skips local identities and rejects mismatched observations', async () => {
  const replaced = { id: 'fork', name: 'original.org/lib', version: 'v1.0.0', replaced: true, replacement: 'github.com/Acme/Fork@v2.0.0+incompatible', goRequirement: observation(root) }
  const local = { id: 'local', name: 'original.org/local', version: 'v1.0.0', replaced: true, replacement: '../private' }
  const missing = { id: 'missing', name: 'original.org/missing' }
  const result = await lookupGoRequirements({ nodes: [replaced, local, missing, unknown] }, { lookup: async nodes => {
    assert.deepEqual(nodes.map(node => node.id), ['fork', 'unknown'])
    const identity = { name: 'github.com/Acme/Fork', version: 'v2.0.0+incompatible' }
    return { records: { fork: { ...observation(identity, '1.20'), identity }, unknown: observation(root) } }
  } })
  assert.deepEqual(result.records.get('fork').identity, { name: 'github.com/Acme/Fork', version: 'v2.0.0+incompatible' })
  assert.equal(result.records.get('fork').minimum, '1.20')
  for (const id of ['local', 'missing', 'unknown']) assert.equal(result.records.get(id).status, 'unknown')
  assert.match(result.records.get('fork').source, /!acme\/!fork\/@v\/v2.0.0%2Bincompatible.mod$/)
})

test('cancellation and incomplete WASM results cannot publish successful observations', async () => {
  for (const response of [null, { records: {} }]) {
    const invalid = await lookupGoRequirements(graph, { lookup: async () => response })
    assert([...invalid.records.values()].every(record => record.status === 'unknown' && !record.minimum))
  }
  const controller = new AbortController(), snapshot = { nodes: [root] }
  await assert.rejects(lookupGoRequirements(snapshot, { signal: controller.signal, lookup: async () => {
    controller.abort()
    return { records: { root: observation(root) } }
  } }), { name: 'AbortError' })
  let requests = 0
  await lookupGoRequirements(snapshot, { lookup: async () => { requests++; return { records: { root: observation(root) } } } })
  assert.equal(requests, 1, 'a canceled lookup must not enter the snapshot cache')
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

test('Go requirement legend colors reach node and edge rendering buffers', () => {
  const minimums = ['1.27.0', '1.26', '1.26.3', '1.25.0', '1.24', '1.23', '1.22', undefined]
  const nodes = minimums.map((_, index) => ({ id: String(index), root: index === 0 }))
  const snapshot = { rootId: '0', nodes, edges: nodes.slice(1).map(node => ({ source: '0', target: node.id })) }
  const observations = { records: new Map(minimums.map((minimum, index) => [String(index), minimum ? { status: 'observed', minimum } : { status: 'unknown' }])) }
  const summary = requirementSummary(snapshot, observations, '')
  const model = createGraphModel(snapshot)
  model.setColors(requirementColors(snapshot, observations))

  for (const group of summary.groups) {
    assert.match(group.color, /^#[\da-f]{6}$/i, 'legend colors must use the renderer color format')
    const expected = [1, 3, 5].map(offset => parseInt(group.color.slice(offset, offset + 2), 16) / 255)
    for (const { node } of group.items) {
      const rendered = model.byID.get(node.id)
      assert.equal(rendered.color, group.color)
      expected.forEach((channel, index) => assert(Math.abs(model.nodeData[rendered.index * 8 + 4 + index] - channel) < 1e-6))
      assert.equal(model.nodeData[rendered.index * 8 + 7], 1)
      for (const edge of model.links.filter(edge => edge.toId === node.id)) {
        expected.forEach((channel, index) => assert(Math.abs(model.edgeData[edge.index * 12 + 8 + index] - channel) < 1e-6))
        assert.equal(model.edgeData[edge.index * 12 + 11], 0.5)
      }
    }
  }
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
