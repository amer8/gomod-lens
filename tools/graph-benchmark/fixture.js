// Seeded public-shaped DAGs. Synthetic workloads are explicitly identified in
// reports; they exercise the resolver's 1,500-module limit without network I/O.
export function makeFixture(count, seed = 42) {
  let state = seed
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `example.org/module-${i}@v1.2.3`, name: `example.org/module-${i}`, version: 'v1.2.3', root: i === 0,
    lenses: { openssf: { status: 'found', score: 2 + random() * 8 }, 'release-freshness': { status: i % 4 ? 'current' : 'minor_behind' } },
  }))
  const edges = [], seen = new Set()
  const add = (a, b) => {
    if (a === b || seen.has(`${a}:${b}`)) return
    seen.add(`${a}:${b}`); edges.push({ source: nodes[a].id, target: nodes[b].id })
  }
  for (let i = 1; i < count; i++) {
    add(Math.floor((i - 1) / 4), i)
    for (let j = 0; j < 3; j++) add(Math.floor(random() * i), i)
  }
  return { rootId: nodes[0]?.id, nodes, edges, meta: { target: nodes[0]?.id, synthetic: true } }
}
