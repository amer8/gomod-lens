import { outgoingIndex, shortestPath, dependencyCounts } from './graph-traversal.js'

/** @typedef {import('./analysis/types.js').GraphNode} GraphNode */
/** @typedef {import('./analysis/types.js').GraphPayload} GraphPayload */
/** @typedef {import('./analysis/types.js').HighlightRequest} HighlightRequest */
/**
 * @typedef {Object} ModelNode
 * @property {string} id
 * @property {GraphNode} data
 * @property {number} index
 * @property {ModelLink[]} links
 * @property {number} dependencyScale
 * @property {number} importance
 * @property {number} radius
 * @property {string} color
 * @property {number} alpha
 */
/**
 * @typedef {Object} ModelLink
 * @property {number} id
 * @property {number} index
 * @property {string} fromId
 * @property {string} toId
 * @property {ModelNode} source
 * @property {ModelNode} target
 * @property {{source: string, target: string}} data
 */

const scoreColors = ['#dc5f65', '#f08a4b', '#f2c14e', '#9bd66f', '#6ed0b3']
/** @type {Record<string, string>} */
const freshnessColors = {
  current: '#6ed0b3',
  patch_behind: '#f2c14e',
  minor_behind: '#f08a4b',
  major_behind: '#dc5f65',
  prerelease: '#b985ff',
  pseudo_version: '#b985ff',
  retracted: '#dc5f65',
  error: '#e5a15a',
}
const unknown = '#8b95a7',
  dimmed = '#50586a'

/**
 * @param {GraphNode} node
 * @param {string} [lens]
 * @param {Record<string, string> | null} [colors]
 */
export function lensColor(node, lens, colors) {
  if (colors) return colors[node.id] || unknown
  if (lens === 'release-freshness')
    return freshnessColors[node.lenses?.[lens]?.status || ''] || unknown
  const score = node.lenses?.openssf
  if (!score) return unknown
  if (score.status === 'error') return '#e5a15a'
  if (score.status === 'no_scorecard') return '#b985ff'
  if (score.status !== 'found' || typeof score.score !== 'number' || !Number.isFinite(score.score))
    return unknown
  return scoreColors[
    score.score >= 9 ? 4 : score.score >= 7 ? 3 : score.score >= 5 ? 2 : score.score >= 3 ? 1 : 0
  ]
}

/** @param {string} hex @param {number} [alpha] */
export function rgba(hex, alpha = 1) {
  // Lens colors are CSS hex strings; invalid observations use the unknown color.
  const value = /^#[\da-f]{6}$/i.test(hex) ? hex : unknown
  return [
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
    alpha,
  ]
}

/** @param {GraphPayload} payload */
export function createGraphModel(payload) {
  const counts = dependencyCounts(payload)
  const maxCount = Math.max(
    1,
    ...(payload.nodes || []).filter((n) => !n.root).map((n) => counts.get(n.id) || 0),
  )
  /** @type {ModelNode[]} */
  const nodes = (payload.nodes || []).map((data, index) => ({
    id: data.id,
    data,
    index,
    links: [],
    dependencyScale: Math.min(1, Math.sqrt(counts.get(data.id) || 0) / Math.sqrt(maxCount)),
    importance: 0,
    radius: 0,
    color: unknown,
    alpha: 1,
  }))
  const byID = new Map(nodes.map((n) => [n.id, n]))
  /** @type {ModelLink[]} */
  const links = []
  /** @type {Map<string, Map<string, ModelLink>>} */
  const pairs = new Map()
  for (const edge of payload.edges || []) {
    const source = byID.get(edge.source),
      target = byID.get(edge.target)
    if (!source || !target) continue
    let targets = pairs.get(source.id)
    if (!targets) pairs.set(source.id, (targets = new Map()))
    if (targets.has(target.id)) continue
    const link = {
      id: links.length,
      index: links.length,
      fromId: source.id,
      toId: target.id,
      source,
      target,
      data: edge,
    }
    links.push(link)
    targets.set(target.id, link)
    source.links.push(link)
    if (source !== target) target.links.push(link)
  }
  // Immutable snapshots expose the small graph protocol needed by the retained
  // CPU layout. Graph storage itself has no ngraph dependency.
  const graph = {
    /** @param {string} id */
    getNode: (id) => byID.get(id),
    /** @param {string} id */
    getLinks: (id) => byID.get(id)?.links,
    getNodesCount: () => nodes.length,
    /** @param {string} a @param {string} b */
    getLink: (a, b) => pairs.get(a)?.get(b),
    /** @param {string} a @param {string} b */
    hasLink: (a, b) => pairs.get(a)?.get(b),
    /** @param {(node: ModelNode) => unknown} visit */
    forEachNode: (visit) => nodes.some(visit),
    /** @param {(link: ModelLink) => unknown} visit */
    forEachLink: (visit) => links.some(visit),
    on() {},
    off() {},
  }
  /** @type {Map<string, number>} */
  const distances = new Map()
  const root = byID.get(payload.rootId),
    queue = root ? [root] : []
  if (root) distances.set(root.id, 0)
  let maxDistance = 1
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head],
      distance = (distances.get(node.id) ?? 0) + 1
    for (const link of node.links) {
      const next = link.source === node ? link.target : link.source
      if (distances.has(next.id)) continue
      distances.set(next.id, distance)
      maxDistance = Math.max(maxDistance, distance)
      queue.push(next)
    }
  }
  for (const node of nodes)
    node.importance = Math.max(
      distances.has(node.id) ? 1 - (distances.get(node.id) ?? 0) / maxDistance : 0,
      node.dependencyScale * 0.85,
    )
  const outgoing = outgoingIndex(links.map((l) => ({ source: l.fromId, target: l.toId })))
  const positions = new Float32Array(nodes.length * 2)
  const nodeData = new Float32Array(nodes.length * 8),
    edgeData = new Float32Array(links.length * 12)
  let lens = 'openssf',
    selection = '',
    zoom = 1,
    revision = 0
  /** @type {Record<string, string> | null} */
  let colors = null
  /** @type {HighlightRequest | null} */
  let request = null

  function update() {
    /** @type {Set<string>} */
    const selectedNodes = new Set()
    /** @type {Set<number>} */
    const selectedLinks = new Set()
    const singleSelection = request?.ids.length === 1 && !request.nodesOnly
    if (request && !singleSelection) {
      for (const id of request.ids || []) if (byID.has(id)) selectedNodes.add(id)
      if (!request.nodesOnly)
        for (const link of links)
          if (selectedNodes.has(link.fromId) && selectedNodes.has(link.toId))
            selectedLinks.add(link.id)
    } else if (byID.has(selection)) {
      const path = shortestPath(outgoing, payload.rootId, selection)
      for (const id of [selection, ...path]) selectedNodes.add(id)
      for (let i = 1; i < path.length; i++) {
        const link = graph.getLink(path[i - 1], path[i])
        if (link) selectedLinks.add(link.id)
      }
      for (const link of byID.get(selection)?.links || []) {
        selectedNodes.add(link.fromId)
        selectedNodes.add(link.toId)
        selectedLinks.add(link.id)
      }
    }
    const highlightColor =
      selectedNodes.size && request?.color && /^#[\da-f]{6}$/i.test(request.color)
        ? request.color
        : null
    const filtering = (request && !singleSelection) || byID.has(selection)
    for (const node of nodes) {
      const i = node.index * 8,
        faded = filtering && !selectedNodes.has(node.id)
      node.radius =
        (zoom < 0.7 ? 2 : zoom < 2.3 ? 3 : 4) +
        node.dependencyScale * (zoom < 0.7 ? 3.5 : zoom < 2.3 ? 5 : 6)
      node.color = faded ? dimmed : highlightColor || lensColor(node.data, lens, colors)
      node.alpha = faded ? 0.28 : 1
      nodeData.set(
        [
          positions[node.index * 2],
          positions[node.index * 2 + 1],
          node.radius,
          selection === node.id ? 1 : 0,
          ...rgba(node.color, node.alpha),
        ],
        i,
      )
    }
    for (const link of links) {
      const faded = filtering && !selectedLinks.has(link.id),
        highlighted = selectedLinks.has(link.id)
      edgeData.set(
        [
          positions[link.source.index * 2],
          positions[link.source.index * 2 + 1],
          positions[link.target.index * 2],
          positions[link.target.index * 2 + 1],
          link.source.radius,
          link.target.radius,
          highlighted ? 2 : 1,
          0,
          ...rgba(
            (highlighted && highlightColor) || lensColor(link.target.data, lens, colors),
            faded ? 0.12 : 0.5,
          ),
        ],
        link.index * 12,
      )
    }
    revision++
  }
  update()
  return {
    rootId: payload.rootId,
    nodes,
    links,
    graph,
    byID,
    positions,
    nodeData,
    edgeData,
    get revision() {
      return revision
    },
    /** @param {ArrayLike<number>} values */
    setPositions(values) {
      positions.set(values)
      update()
    },
    /** @param {string} value */
    setLens(value) {
      lens = value || 'openssf'
      update()
    },
    /** @param {Record<string, string> | null} value */
    setColors(value) {
      colors = value
      update()
    },
    /** @param {number} value */
    setZoom(value) {
      /** @param {number} v */
      const level = (v) => (v < 0.7 ? 0 : v < 2.3 ? 1 : 2)
      if (level(value) !== level(zoom)) {
        zoom = value
        update()
      } else zoom = value
    },
    /** @param {string} id */
    select(id) {
      selection = id || ''
      request = null
      update()
    },
    /** @param {HighlightRequest | null} value */
    highlight(value) {
      request = value?.ids?.length ? value : null
      if (request?.ids.length === 1 && !request.nodesOnly) selection = request.ids[0]
      update()
    },
  }
}
