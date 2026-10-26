import { outgoingIndex, shortestPath, dependencyCounts } from './graph-traversal.js'

const scoreColors = ['#dc5f65', '#f08a4b', '#f2c14e', '#9bd66f', '#6ed0b3']
const freshnessColors = { current: '#6ed0b3', patch_behind: '#f2c14e', minor_behind: '#f08a4b', major_behind: '#dc5f65', prerelease: '#b985ff', pseudo_version: '#b985ff', error: '#e5a15a' }
const unknown = '#8b95a7', dimmed = '#50586a'

export function lensColor(node, lens, colors) {
  if (colors) return colors[node.id] || unknown
  if (lens === 'release-freshness') return freshnessColors[node.lenses?.[lens]?.status] || unknown
  const score = node.lenses?.openssf
  if (!score) return unknown
  if (score.status === 'error') return '#e5a15a'
  if (score.status === 'no_scorecard') return '#b985ff'
  if (score.status !== 'found' || !Number.isFinite(score.score)) return unknown
  return scoreColors[score.score >= 9 ? 4 : score.score >= 7 ? 3 : score.score >= 5 ? 2 : score.score >= 3 ? 1 : 0]
}

export function rgba(hex, alpha = 1) {
  // Lens colors are CSS hex strings; invalid observations use the unknown color.
  const value = /^#[\da-f]{6}$/i.test(hex) ? hex : unknown
  return [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255, alpha]
}

export function createGraphModel(payload) {
  const counts = dependencyCounts(payload)
  const maxCount = Math.max(1, ...(payload.nodes || []).filter(n => !n.root).map(n => counts.get(n.id) || 0))
  const nodes = (payload.nodes || []).map((data, index) => ({
    id: data.id, data, index, links: new Set(),
    dependencyScale: Math.min(1, Math.sqrt(counts.get(data.id) || 0) / Math.sqrt(maxCount)),
  }))
  const byID = new Map(nodes.map(n => [n.id, n])), links = [], pairs = new Map()
  for (const edge of payload.edges || []) {
    const source = byID.get(edge.source), target = byID.get(edge.target)
    if (!source || !target) continue
    let targets = pairs.get(source.id)
    if (!targets) pairs.set(source.id, targets = new Map())
    if (targets.has(target.id)) continue
    const link = { id: links.length, index: links.length, fromId: source.id, toId: target.id, source, target, data: edge }
    links.push(link); targets.set(target.id, link); source.links.add(link); target.links.add(link)
  }
  // Immutable snapshots expose the small graph protocol needed by the retained
  // CPU layout. Graph storage itself has no ngraph dependency.
  const graph = {
    getNode: id => byID.get(id), getLinks: id => byID.get(id)?.links,
    getNodesCount: () => nodes.length,
    getLink: (a, b) => pairs.get(a)?.get(b), hasLink: (a, b) => pairs.get(a)?.get(b),
    forEachNode: visit => nodes.some(visit), forEachLink: visit => links.some(visit),
    on() {}, off() {},
  }
  const distances = new Map(), root = byID.get(payload.rootId), queue = root ? [root] : []
  if (root) distances.set(root.id, 0)
  let maxDistance = 1
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head], distance = distances.get(node.id) + 1
    for (const link of node.links) {
      const next = link.source === node ? link.target : link.source
      if (distances.has(next.id)) continue
      distances.set(next.id, distance); maxDistance = Math.max(maxDistance, distance); queue.push(next)
    }
  }
  for (const node of nodes) node.importance = Math.max(distances.has(node.id) ? 1 - distances.get(node.id) / maxDistance : 0, node.dependencyScale * 0.85)
  const outgoing = outgoingIndex(links.map(l => ({ source: l.fromId, target: l.toId })))
  const positions = new Float32Array(nodes.length * 2)
  const nodeData = new Float32Array(nodes.length * 8), edgeData = new Float32Array(links.length * 12)
  let lens = 'openssf', colors = null, selection = '', request = null, zoom = 1, revision = 0

  function update() {
    const selectedNodes = new Set(), selectedLinks = new Set()
    if (request) {
      for (const id of request.ids || []) if (byID.has(id)) selectedNodes.add(id)
      if (!request.nodesOnly) for (const link of links) if (selectedNodes.has(link.fromId) && selectedNodes.has(link.toId)) selectedLinks.add(link.id)
    } else if (byID.has(selection)) {
      const path = shortestPath(outgoing, payload.rootId, selection)
      for (const id of [selection, ...path]) selectedNodes.add(id)
      for (let i = 1; i < path.length; i++) selectedLinks.add(graph.getLink(path[i - 1], path[i]).id)
      for (const link of byID.get(selection).links) {
        selectedNodes.add(link.fromId); selectedNodes.add(link.toId); selectedLinks.add(link.id)
      }
    }
    const filtering = !!request || byID.has(selection)
    for (const node of nodes) {
      const i = node.index * 8, faded = filtering && !selectedNodes.has(node.id)
      node.radius = (zoom < 0.7 ? 2 : zoom < 2.3 ? 3 : 4) + node.dependencyScale * (zoom < 0.7 ? 3.5 : zoom < 2.3 ? 5 : 6)
      node.color = faded ? dimmed : lensColor(node.data, lens, colors)
      node.alpha = faded ? 0.28 : 1
      nodeData.set([positions[node.index * 2], positions[node.index * 2 + 1], node.radius, selection === node.id ? 1 : 0, ...rgba(node.color, node.alpha)], i)
    }
    for (const link of links) {
      const faded = filtering && !selectedLinks.has(link.id), highlighted = selectedLinks.has(link.id)
      edgeData.set([
        positions[link.source.index * 2], positions[link.source.index * 2 + 1], positions[link.target.index * 2], positions[link.target.index * 2 + 1],
        link.source.radius, link.target.radius, highlighted ? 2 : 1, 0,
        ...rgba(lensColor(link.target.data, lens, colors), faded ? 0.12 : 0.5),
      ], link.index * 12)
    }
    revision++
  }
  update()
  return {
    rootId: payload.rootId, nodes, links, graph, byID, positions, nodeData, edgeData,
    get revision() { return revision },
    setPositions(values) { positions.set(values); update() },
    setLens(value) { lens = value || 'openssf'; update() },
    setColors(value) { colors = value; update() },
    setZoom(value) {
      const level = v => v < 0.7 ? 0 : v < 2.3 ? 1 : 2
      if (level(value) !== level(zoom)) { zoom = value; update() } else zoom = value
    },
    select(id) { selection = id || ''; request = null; update() },
    highlight(value) {
      if (value?.ids?.length === 1 && !value.nodesOnly) { selection = value.ids[0]; request = null }
      else request = value?.ids?.length ? value : null
      update()
    },
  }
}
