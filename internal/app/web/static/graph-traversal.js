// Directed traversal over node IDs. Callers filter edges according to their data rules.
/** @param {{source: string, target: string}[]} edges */
export function outgoingIndex(edges) {
  /** @type {Map<string, string[]>} */
  const outgoing = new Map()
  for (const { source, target } of edges) {
    const targets = outgoing.get(source) || []
    if (!outgoing.has(source)) outgoing.set(source, targets)
    targets.push(target)
  }
  return outgoing
}

/** @param {Map<string, string[]>} outgoing @param {string} start @param {string} target */
export function shortestPath(outgoing, start, target) {
  /** @type {Map<string, string | null>} */
  const previous = new Map([[start, null]]),
    queue = [start]
  for (let head = 0; head < queue.length && !previous.has(target); head++) {
    for (const next of outgoing.get(queue[head]) || []) {
      if (previous.has(next)) continue
      previous.set(next, queue[head])
      queue.push(next)
    }
  }
  if (!previous.has(target)) return []
  const path = []
  for (let id = /** @type {string | null} */ (target); id !== null; id = previous.get(id) ?? null)
    path.push(id)
  return path.reverse()
}

// Includes the starting ID, even when it has no outgoing edges.
/** @param {Map<string, string[]>} outgoing @param {string} start */
export function reachableIDs(outgoing, start) {
  const seen = new Set([start]),
    queue = [start]
  for (let head = 0; head < queue.length; head++) {
    for (const next of outgoing.get(queue[head]) || []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/** @param {import('./analysis/types.js').GraphPayload} payload */
export function dependencyCounts(payload) {
  const nodes = payload?.nodes || []
  /**
   * @param {import('./analysis/types.js').GraphNode} node
   * @returns {node is import('./analysis/types.js').GraphNode & {descendantCount: number}}
   */
  const validCount = (node) =>
    typeof node.descendantCount === 'number' &&
    Number.isInteger(node.descendantCount) &&
    node.descendantCount >= 0 &&
    node.descendantCount < nodes.length
  if (nodes.every(validCount)) return new Map(nodes.map((node) => [node.id, node.descendantCount]))
  const nodeByID = new Map(nodes.map((node) => [node.id, node]))
  // Root nodes stop dependency traversal; they are not downstream dependencies.
  const outgoing = outgoingIndex(
    (payload?.edges || []).filter(
      (edge) =>
        nodeByID.has(edge.source) && nodeByID.has(edge.target) && !nodeByID.get(edge.target)?.root,
    ),
  )
  // Legacy and synthetic fixtures can omit the WASM-computed counts.
  return new Map(
    nodes.map((node) => [
      node.id,
      validCount(node) ? node.descendantCount : reachableIDs(outgoing, node.id).size - 1,
    ]),
  )
}
