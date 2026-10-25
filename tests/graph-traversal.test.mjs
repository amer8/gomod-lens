import test from 'node:test'
import assert from 'node:assert/strict'
import { outgoingIndex, shortestPath, reachableIDs, dependencyCounts } from '../internal/app/web/static/graph-traversal.js'

const edges = pairs => pairs.map(([source, target]) => ({ source, target }))

test('directed walks preserve edge order, shortest paths and cycles', () => {
  const outgoing = outgoingIndex(edges([
    ['root', 'a'], ['root', 'b'], ['root', 'a'], ['a', 'c'],
    ['b', 'c'], ['c', 'a'], ['c', 'target'], ['b', 'target'],
  ]))
  assert.deepEqual(outgoing.get('root'), ['a', 'b', 'a'])
  assert.deepEqual(shortestPath(outgoing, 'root', 'c'), ['root', 'a', 'c'])
  assert.deepEqual(shortestPath(outgoing, 'root', 'target'), ['root', 'b', 'target'])
  assert.deepEqual(shortestPath(outgoing, 'root', 'root'), ['root'])
  assert.deepEqual(shortestPath(outgoing, 'a', 'root'), [])
  assert.deepEqual(shortestPath(outgoing, 'root', 'isolated'), [])
  assert.deepEqual([...reachableIDs(outgoing, 'a')], ['a', 'c', 'target'])
  assert.deepEqual([...reachableIDs(outgoing, 'isolated')], ['isolated'])
})

test('dependency counts deduplicate cycles and stop at roots and missing nodes', () => {
  const graph = {
    nodes: ['root', 'a', 'b', 'leaf', 'isolated'].map(id => ({ id, root: id === 'root' })),
    edges: edges([
      ['root', 'a'], ['root', 'leaf'], ['a', 'b'], ['a', 'b'], ['a', 'a'],
      ['b', 'a'], ['b', 'root'], ['b', 'missing'], ['missing', 'leaf'],
    ]),
  }
  assert.deepEqual([...dependencyCounts(graph)], [['root', 3], ['a', 1], ['b', 1], ['leaf', 0], ['isolated', 0]])
  assert.deepEqual([...dependencyCounts({})], [])
})
