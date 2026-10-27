import test from 'node:test'
import assert from 'node:assert/strict'
import { createGraphModel, lensColor } from '../internal/app/web/static/graph-model.js'
import { createGraphLayout } from '../internal/app/web/static/graph-layout.js'
import { fitCamera, shouldUseWebGPU } from '../internal/app/web/static/graph-scene.js'
import { createWebGPURenderer } from '../internal/app/web/static/graph-webgpu.js'

const payload = () => ({
  rootId: 'root', nodes: ['root', 'a', 'b', 'c', 'isolated'].map(id => ({ id, root: id === 'root', lenses: { openssf: { status: 'found', score: 9 } } })),
  edges: [['root','a'], ['root','b'], ['a','c'], ['c','a'], ['b','c']].map(([source, target]) => ({ source, target })),
})
const alpha = (model, id) => model.nodeData[model.byID.get(id).index * 8 + 7]

test('graph snapshots deduplicate edges, reject missing endpoints and safely store arbitrary IDs', () => {
  const data = payload()
  data.nodes.push({ id: '__proto__' })
  data.edges.push(data.edges[0], { source: 'root', target: 'missing' }, { source: '__proto__', target: '__proto__' })
  const model = createGraphModel(data)
  assert.equal(model.graph.getNodesCount(), 6)
  assert.equal(model.links.length, 6)
  assert.equal(model.graph.getLinks('__proto__').size, 1)
  assert.equal(model.graph.getLink('__proto__', '__proto__').id, 5)
  assert.equal(model.graph.getLink('root', 'a').source.id, 'root')
})

test('selection highlights the root path and neighbors; lens group requests preserve nodes-only semantics', () => {
  const model = createGraphModel(payload())
  model.select('a')
  assert.equal(alpha(model, 'root'), 1); assert.equal(alpha(model, 'c'), 1)
  assert(alpha(model, 'b') < 0.3); assert(alpha(model, 'isolated') < 0.3)
  model.highlight({ ids: ['a', 'c'], nodesOnly: true })
  assert.equal(alpha(model, 'a'), 1); assert(alpha(model, 'root') < 0.3)
  assert(model.links.every(link => model.edgeData[link.index * 12 + 11] < 0.13))
  model.highlight({ ids: ['a', 'c'] })
  assert(model.edgeData[model.graph.getLink('a', 'c').index * 12 + 11] > 0.49)
  model.highlight({ ids: ['isolated'] })
  assert.equal(alpha(model, 'isolated'), 1); assert(alpha(model, 'a') < 0.3)
  model.select('')
  assert(model.nodes.every(node => alpha(model, node.id) === 1))
  model.select('stale-node')
  assert(model.nodes.every(node => alpha(model, node.id) === 1))
})

test('colors preserve unknown and error observations and custom lens colors', () => {
  assert.equal(lensColor({ lenses: { openssf: { status: 'found', score: 9 } } }), '#6ed0b3')
  assert.equal(lensColor({ lenses: { openssf: { status: 'found', score: 2 } } }), '#dc5f65')
  assert.equal(lensColor({ lenses: { openssf: { status: 'found', score: 0 } } }), '#dc5f65')
  assert.equal(lensColor({ lenses: { openssf: { status: 'found' } } }), '#8b95a7')
  assert.equal(lensColor({}), '#8b95a7')
  assert.equal(lensColor({ lenses: { openssf: { status: 'error' } } }), '#e5a15a')
  assert.equal(lensColor({ lenses: { 'release-freshness': { status: 'major_behind' } } }, 'release-freshness'), '#dc5f65')
  const model = createGraphModel(payload())
  model.setColors({ a: '#123456' }); assert.equal(model.byID.get('a').color, '#123456')
  model.setColors(null); assert.equal(model.byID.get('a').color, '#6ed0b3')
})

test('pan and zoom within a detail level reuse GPU geometry; level crossings update radii', () => {
  const model = createGraphModel(payload()), revision = model.revision
  model.setZoom(1.5); assert.equal(model.revision, revision)
  const radius = model.byID.get('a').radius
  model.setZoom(3); assert(model.byID.get('a').radius > radius)
  const positions = new Float32Array(model.positions.length).map((_, i) => i * 10)
  model.setPositions(positions)
  assert.equal(model.edgeData[2], positions[model.byID.get('a').index * 2])
})

test('camera fitting handles empty, single-node and narrow viewports without infinities', () => {
  for (const [positions, width, height] of [[[], 320, 100], [[0,0], 1, 1], [[-100,-20,500,80], 1200, 800]]) {
    const camera = fitCamera(positions, width, height)
    assert(Object.values(camera).every(Number.isFinite))
    assert(camera.scale >= 0.08 && camera.scale <= 40)
  }
})

test('automatic rendering avoids GPU startup for small graphs and honors explicit choices', () => {
  assert.equal(shouldUseWebGPU('auto', 100, 369), false)
  assert.equal(shouldUseWebGPU('auto', 500, 1959), true)
  assert.equal(shouldUseWebGPU('auto', 300, 2000), true)
  assert.equal(shouldUseWebGPU('canvas', 1500, 6000), false)
  assert.equal(shouldUseWebGPU('webgpu', 10, 20), true)
})

test('force layout keeps the root pinned and finite positions for cyclic and disconnected nodes', () => {
  const model = createGraphModel(payload()), layout = createGraphLayout(model)
  try {
    for (let i = 0; i < 80; i++) layout.step()
    assert.equal(model.positions[0], 0); assert.equal(model.positions[1], 0)
    assert(model.positions.every(Number.isFinite))
    assert(model.nodes.slice(1).every(node => Math.hypot(model.positions[node.index * 2], model.positions[node.index * 2 + 1]) > 0))
  } finally { layout.dispose() }
})

test('WebGPU rejects unavailable or refused adapters before allocating a device', async () => {
  await assert.rejects(createWebGPURenderer(null, null, null, null), /unavailable/)
  await assert.rejects(createWebGPURenderer(null, null, null, { requestAdapter: async () => null }), /No WebGPU adapter/)
})
