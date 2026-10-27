// Directed traversal over node IDs. Callers filter edges according to their data rules.
export function outgoingIndex(edges) {
  const outgoing = new Map()
  for (const { source, target } of edges) {
    if (!outgoing.has(source)) outgoing.set(source, [])
    outgoing.get(source).push(target)
  }
  return outgoing
}

export function shortestPath(outgoing, start, target) {
  const previous = new Map([[start, null]]), queue = [start]
  for (let head = 0; head < queue.length && !previous.has(target); head++) {
    for (const next of outgoing.get(queue[head]) || []) {
      if (previous.has(next)) continue
      previous.set(next, queue[head])
      queue.push(next)
    }
  }
  if (!previous.has(target)) return []
  const path = []
  for (let id = target; id !== null; id = previous.get(id)) path.push(id)
  return path.reverse()
}

// Includes the starting ID, even when it has no outgoing edges.
export function reachableIDs(outgoing, start) {
  const seen = new Set([start]), queue = [start]
  for (let head = 0; head < queue.length; head++) {
    for (const next of outgoing.get(queue[head]) || []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

export function dependencyCounts(payload) {
  const nodes = payload?.nodes || []
  const validCount = node => Number.isInteger(node.descendantCount) && node.descendantCount >= 0 && node.descendantCount < nodes.length
  if (nodes.every(validCount)) return new Map(nodes.map(node => [node.id, node.descendantCount]))
  const nodeByID = new Map(nodes.map(node => [node.id, node]))
  // Root nodes stop dependency traversal; they are not downstream dependencies.
  const outgoing = outgoingIndex((payload?.edges || []).filter(edge =>
    nodeByID.has(edge.source) && nodeByID.has(edge.target) && !nodeByID.get(edge.target).root))
  // Legacy and synthetic fixtures can omit the WASM-computed counts.
  return new Map(nodes.map(node => [node.id, validCount(node) ? node.descendantCount : reachableIDs(outgoing, node.id).size - 1]))
}
