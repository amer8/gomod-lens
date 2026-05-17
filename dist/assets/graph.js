import createGraph from 'ngraph.graph'
import {
  CanvasEdgeCollection,
  createScene,
  ForceLayoutAdapter,
  NodeCollection,
} from 'ngraph.svg'

let scene = null
let nodeCol = null
let edgeCol = null
let layout = null
let graph = null
let graphData = null
let selectedNodeId = ''
let activeLensID = 'openssf'
let highlightRequest = null
let onNodeSelected = null
let bfsDistances = new Map()
let maxBfsDistance = 1
let dependencyCountsByNodeID = new Map()
let maxDependencyNodeCount = 1
let hasInitialFit = false
let layoutStopTimer = null

const openSSFNoScorecardColor = '#b985ff'
const openSSFExcellentScoreColor = '#6ed0b3'
const openSSFStrongScoreColor = '#9bd66f'
const openSSFModerateScoreColor = '#f2c14e'
const openSSFWeakScoreColor = '#f08a4b'
const openSSFPoorScoreColor = '#dc5f65'
const openSSFUnavailableColor = '#8b95a7'
const openSSFErrorColor = '#e5a15a'
const releaseFreshnessCurrentColor = '#6ed0b3'
const releaseFreshnessPatchColor = '#f2c14e'
const releaseFreshnessMinorColor = '#f08a4b'
const releaseFreshnessMajorColor = '#dc5f65'
const releaseFreshnessPreviewColor = '#b985ff'
const releaseFreshnessUnknownColor = '#8b95a7'
const releaseFreshnessErrorColor = '#e5a15a'
const baseLayoutEnergyThreshold = 0.003
const maxLayoutRunMs = 12000

export function renderGraph(container, payload, options = {}) {
  if (!container || !payload) return

  disposeGraph()
  graphData = payload
  selectedNodeId = ''
  activeLensID = 'openssf'
  highlightRequest = null
  onNodeSelected = options.onNodeSelected || null
  hasInitialFit = false
  dependencyCountsByNodeID = dependencyNodeCountForNodes(payload)
  maxDependencyNodeCount = maxRenderableDependencyCount(payload.nodes || [])
  graph = createRenderableGraph(payload)
  computeDistances()

  container.className = 'graphView d2d'

  scene = createScene(container, {
    viewBox: { left: -500, top: -500, right: 500, bottom: 500 },
    panZoom: { minZoom: 0.08, maxZoom: 40 },
  })
  syncGalaxyViewport(container)
  scene.on('transform', (transform) => syncGalaxyViewport(container, transform))
  scene.on('resize', () => syncGalaxyViewport(container))

  nodeCol = new NodeCollection({
    graph,
    maxScale: 2,
    data: (graphNode) => ({
      nodeId: graphNode.id,
      label: graphNode.data.name || graphNode.id,
      fullName: graphNode.data.name || graphNode.id,
      version: graphNode.data.version || '',
      dependencyCount: dependencyCountsByNodeID.get(graphNode.id) || 0,
    }),
    size: 10,
    levels: [
      {
        type: 'circle',
        radius: (d) => nodeRadius(d, 2, 5.5),
        fill: nodeFill,
        opacity: nodeOpacity,
      },
      {
        importance,
        layers: [
          { type: 'circle', radius: (d) => nodeRadius(d, 3, 8), fill: nodeFill, opacity: nodeOpacity },
          {
            type: 'text',
            text: (d) => d.label,
            fontSize: (d) => 9 + importance(d) * importance(d) * 18,
            fill: nodeFill,
            anchor: 'top',
            offset: (d) => [0, -nodeRadius(d, 3, 8) - 9],
          },
        ],
      },
      {
        minZoom: 2.3,
        importance,
        layers: [
          { type: 'circle', radius: (d) => nodeRadius(d, 4, 10), fill: nodeFill, opacity: nodeOpacity },
          {
            type: 'text',
            text: (d) => d.label,
            fontSize: (d) => 10 + importance(d) * importance(d) * 19,
            fill: nodeFill,
            anchor: 'top',
            offset: (d) => [0, -nodeRadius(d, 4, 10) - 9],
          },
          {
            type: 'text',
            text: (d) => d.version,
            fontSize: 12,
            fill: (_d, ctx) => (ctx.dimmed ? 'rgba(255, 255, 255, 0.45)' : '#fff'),
            anchor: 'bottom',
            offset: (d) => [0, nodeRadius(d, 4, 10) + 14],
            visible: (d) => !!d.version,
          },
        ],
      },
      {
        minZoom: 3.8,
        importance,
        layers: [
          { type: 'circle', radius: (d) => nodeRadius(d, 4, 10), fill: nodeFill, opacity: nodeOpacity },
          {
            type: 'text',
            text: (d) => d.label,
            fontSize: (d) => 10 + importance(d) * importance(d) * 19,
            fill: nodeFill,
            anchor: 'top',
            offset: (d) => [0, -nodeRadius(d, 4, 10) - 9],
          },
          {
            type: 'text',
            text: (d) => d.version,
            fontSize: 12,
            fill: (_d, ctx) => (ctx.dimmed ? 'rgba(255, 255, 255, 0.45)' : '#fff'),
            anchor: 'bottom',
            offset: (d) => [0, nodeRadius(d, 4, 10) + 14],
            visible: (d) => !!d.version,
          },
          {
            type: 'text',
            text: (d) => d.fullName,
            fontSize: 11,
            fill: (_d, ctx) => (ctx.dimmed ? 'rgba(255, 255, 255, 0.4)' : '#fff'),
            anchor: 'bottom',
            offset: (d) => [0, nodeRadius(d, 4, 10) + 30],
            visible: (d) => d.fullName !== d.label,
            maxWidth: 240,
          },
        ],
      },
    ],
  })

  edgeCol = new CanvasEdgeCollection({
    graph,
    nodeCollection: nodeCol,
    directed: true,
    container,
    color: edgeColor,
    width: (_d, ctx) => (ctx.highlighted ? 2 : 1),
    opacity: (_d, ctx) => (ctx.dimmed ? 0.12 : 0.5),
  })

  scene.addCollection(edgeCol)
  scene.addCollection(nodeCol)

  layout = new ForceLayoutAdapter(graph, {
    springLength: 80,
    springCoefficient: 0.0002,
    gravity: -1.15,
    dragCoefficient: 0.03,
    layeredLayout: false,
    getNodeSize: layoutNodeSize,
    energyThreshold: layoutEnergyThreshold(),
    onStabilized: async () => {
      await finishLayout()
    },
  })

  layout.onUpdate((positions) => {
    nodeCol.syncPositions(positions)
    edgeCol.syncPositions(positions)
    scene.requestRender()
  })

  void layout.start()
  scheduleLayoutStop()

  const rootNode = graph.getNode(payload.rootId)
  if (rootNode) {
    graph.root = rootNode
    void layout.setNodePosition(rootNode.id, 0, 0)
    void layout.pinNode(rootNode.id)
  }

  bindSelectionEvents()
  applySelectionHighlight()
}

export function clearGraph(container) {
  disposeGraph()
  if (container) {
    container.className = 'graph-empty'
    resetGalaxyViewport(container)
    container.replaceChildren()
  }
}

export function disposeGraph() {
  clearLayoutStopTimer()
  if (layout) {
    layout.dispose()
    layout = null
  }
  if (scene) {
    scene.dispose()
    scene = null
  }
  nodeCol = null
  edgeCol = null
  graph = null
  graphData = null
  selectedNodeId = ''
  highlightRequest = null
  onNodeSelected = null
  dependencyCountsByNodeID = new Map()
  maxDependencyNodeCount = 1
}

export function selectNode(nodeId) {
  selectedNodeId = nodeId || ''
  highlightRequest = null
  if (!graph || !nodeCol || !edgeCol) return
  applySelectionHighlight()
}

export function setGraphLens(lensID) {
  activeLensID = lensID || 'openssf'
  nodeCol?.invalidateContent?.()
  const positions = layout?.getPositions?.()
  if (positions && nodeCol && edgeCol) {
    nodeCol.syncPositions(positions)
    edgeCol.syncPositions(positions)
  }
  if (scene) {
    scene.requestRender()
  }
}

export function applyHighlightRequest(request) {
  const ids = request?.ids || []
  if (ids.length === 1) {
    selectNode(ids[0])
    return
  }

  highlightRequest = ids.length ? request : null
  if (!graph || !nodeCol || !edgeCol) return
  if (highlightRequest) {
    applyRequestHighlight(highlightRequest)
    return
  }
  applySelectionHighlight()
}

function createRenderableGraph(payload) {
  const nextGraph = createGraph()

  ;(payload.nodes || []).forEach((node) => {
    nextGraph.addNode(node.id, {
      ...node,
      name: node.name || node.id,
    })
  })

  ;(payload.edges || []).forEach((edge) => {
    nextGraph.addLink(edge.source, edge.target, edge)
  })

  return nextGraph
}

function computeDistances() {
  bfsDistances = new Map()
  maxBfsDistance = 1
  const adjacency = new Map()

  ;(graphData.nodes || []).forEach((node) => {
    adjacency.set(node.id, [])
  })

  ;(graphData.edges || []).forEach((edge) => {
    adjacency.get(edge.source)?.push(edge.target)
    adjacency.get(edge.target)?.push(edge.source)
  })

  const rootId = graphData.rootId
  bfsDistances.set(rootId, 0)
  const queue = [rootId]

  for (let head = 0; head < queue.length; head += 1) {
    const nodeId = queue[head]
    const distance = bfsDistances.get(nodeId) || 0
    const neighbors = adjacency.get(nodeId) || []
    neighbors.forEach((otherId) => {
      if (bfsDistances.has(otherId)) return
      const nextDistance = distance + 1
      bfsDistances.set(otherId, nextDistance)
      maxBfsDistance = Math.max(maxBfsDistance, nextDistance)
      queue.push(otherId)
    })
  }
}

function layoutEnergyThreshold() {
  return baseLayoutEnergyThreshold * Math.max(graphData.nodes.length, 1)
}

function syncGalaxyViewport(container, transform = scene?.drawContext?.transform) {
  if (!container || !transform) return

  const zoom = clamp(Number(transform.scale) || 1, 0.08, 40)
  const zoomLevel = Math.log2(zoom)
  const starScale = clamp(1 + zoomLevel * 0.12, 0.88, 2.7)
  const bandScale = clamp(1.12 + zoomLevel * 0.08, 1, 2.2)
  const x = Number(transform.x) || 0
  const y = Number(transform.y) || 0

  container.style.setProperty('--galaxy-pan-x', `${clamp(x * 0.045, -280, 280).toFixed(2)}px`)
  container.style.setProperty('--galaxy-pan-y', `${clamp(y * 0.045, -220, 220).toFixed(2)}px`)
  container.style.setProperty('--galaxy-band-pan-x', `${clamp(x * 0.026, -180, 180).toFixed(2)}px`)
  container.style.setProperty('--galaxy-band-pan-y', `${clamp(y * 0.026, -140, 140).toFixed(2)}px`)
  container.style.setProperty('--galaxy-scale', starScale.toFixed(3))
  container.style.setProperty('--galaxy-band-scale', bandScale.toFixed(3))
}

function resetGalaxyViewport(container) {
  if (!container) return

  for (const property of [
    '--galaxy-pan-x',
    '--galaxy-pan-y',
    '--galaxy-band-pan-x',
    '--galaxy-band-pan-y',
    '--galaxy-scale',
    '--galaxy-band-scale',
  ]) {
    container.style.removeProperty(property)
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function scheduleLayoutStop() {
  clearLayoutStopTimer()
  layoutStopTimer = window.setTimeout(() => {
    if (!layout?.isRunning?.()) return
    layout.stop()
    void finishLayout()
  }, maxLayoutRunMs)
}

function clearLayoutStopTimer() {
  if (!layoutStopTimer) return
  window.clearTimeout(layoutStopTimer)
  layoutStopTimer = null
}

async function finishLayout() {
  clearLayoutStopTimer()
  if (!hasInitialFit && layout) {
    hasInitialFit = true
    const bounds = await layout.getBounds()
    scene?.fitToView(bounds, 48)
  }
}

function importance(data) {
  const distance = bfsDistances.get(data.nodeId)
  if (distance === undefined) return 0
  const distanceImportance = 1 - distance / Math.max(maxBfsDistance, 1)
  return Math.max(distanceImportance, dependencyScale(data) * 0.85)
}

function maxRenderableDependencyCount(nodes) {
  return Math.max(
    1,
    ...nodes
      .filter((node) => !node.root)
      .map((node) => dependencyCountsByNodeID.get(node.id) || 0)
  )
}

function dependencyScale(data) {
  const count = data.dependencyCount || 0
  if (count <= 0) return 0
  return Math.min(1, Math.sqrt(count) / Math.sqrt(maxDependencyNodeCount))
}

function nodeRadius(data, minRadius, maxRadius) {
  return minRadius + dependencyScale(data) * (maxRadius - minRadius)
}

function layoutNodeSize(nodeId) {
  const count = dependencyCountsByNodeID.get(nodeId) || 0
  const scale = count <= 0
    ? 0
    : Math.min(1, Math.sqrt(count) / Math.sqrt(maxDependencyNodeCount))
  return 10 + scale * 18
}

function nodeFill(data, ctx) {
  const node = graph?.getNode(data.nodeId)?.data
  return lensNodeFill(node, ctx)
}

function lensNodeFill(node, ctx = null) {
  if (activeLensID === 'release-freshness') {
    return releaseFreshnessNodeFill(node, ctx)
  }
  return openSSFNodeFill(node, ctx)
}

function openSSFNodeFill(node, ctx = null) {
  if (ctx?.dimmed) return '#50586a'

  if (!node) return openSSFNoScorecardColor
  const scoreInfo = openSSFLensResult(node)
  if (!scoreInfo) return openSSFUnavailableColor
  if (scoreInfo.status === 'error') return openSSFErrorColor
  if (scoreInfo.status === 'no_scorecard') return openSSFNoScorecardColor
  if (scoreInfo.status !== 'found' || typeof scoreInfo.score !== 'number') return openSSFUnavailableColor

  if (scoreInfo.score >= 9) return openSSFExcellentScoreColor
  if (scoreInfo.score >= 7) return openSSFStrongScoreColor
  if (scoreInfo.score >= 5) return openSSFModerateScoreColor
  if (scoreInfo.score >= 3) return openSSFWeakScoreColor
  return openSSFPoorScoreColor
}

function openSSFLensResult(node) {
  return node?.lenses?.openssf || node?.openssf
}

function releaseFreshnessNodeFill(node, ctx = null) {
  if (ctx?.dimmed) return '#50586a'

  const info = node?.lenses?.['release-freshness']
  if (!info) return releaseFreshnessUnknownColor

  switch (info.status) {
    case 'current':
      return releaseFreshnessCurrentColor
    case 'patch_behind':
      return releaseFreshnessPatchColor
    case 'minor_behind':
      return releaseFreshnessMinorColor
    case 'major_behind':
      return releaseFreshnessMajorColor
    case 'prerelease':
    case 'pseudo_version':
      return releaseFreshnessPreviewColor
    case 'error':
      return releaseFreshnessErrorColor
    default:
      return releaseFreshnessUnknownColor
  }
}

function edgeColor(data) {
  const targetNode = graph?.getNode(data.toId)?.data
  if (!targetNode) return '#4f5768'
  return lensNodeFill(targetNode)
}

function nodeOpacity(_data, ctx) {
  return ctx.dimmed ? 0.28 : 1
}

function getNodeIdAtClientPoint(clientX, clientY) {
  if (!scene || !nodeCol) return null

  const rect = scene.svg.getBoundingClientRect()
  return nodeCol.getNodeAt(clientX - rect.left, clientY - rect.top, scene.drawContext)
}

function bindSelectionEvents() {
  let mouseDownPos = null
  let touchStartPos = null

  const handleNodeHit = (clientX, clientY) => {
    const nodeId = getNodeIdAtClientPoint(clientX, clientY)
    if (!nodeId) {
      selectedNodeId = ''
      if (onNodeSelected) onNodeSelected(null)
      clearAllStates()
      scene.requestRender()
      return
    }

    const node = graph.getNode(nodeId)
    selectedNodeId = nodeId
    if (onNodeSelected) onNodeSelected(node?.data || null)
    applySelectionHighlight()
  }

  const updateCursor = (clientX, clientY) => {
    scene.svg.style.cursor = getNodeIdAtClientPoint(clientX, clientY) ? 'pointer' : ''
  }

  scene.svg.addEventListener('mousedown', (event) => {
    mouseDownPos = { x: event.clientX, y: event.clientY }
  })

  scene.svg.addEventListener('mousemove', (event) => {
    updateCursor(event.clientX, event.clientY)
  })

  scene.svg.addEventListener('mouseleave', () => {
    scene.svg.style.cursor = ''
  })

  scene.svg.addEventListener('click', (event) => {
    if (mouseDownPos) {
      const dx = event.clientX - mouseDownPos.x
      const dy = event.clientY - mouseDownPos.y
      if (dx * dx + dy * dy > 25) return
    }
    handleNodeHit(event.clientX, event.clientY)
  })

  scene.svg.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length === 1) {
        touchStartPos = {
          x: event.touches[0].clientX,
          y: event.touches[0].clientY,
        }
      } else {
        touchStartPos = null
      }
    },
    { passive: true }
  )

  scene.svg.addEventListener('touchend', (event) => {
    if (touchStartPos && event.changedTouches.length === 1) {
      const touch = event.changedTouches[0]
      const dx = touch.clientX - touchStartPos.x
      const dy = touch.clientY - touchStartPos.y
      if (dx * dx + dy * dy < 25) {
        handleNodeHit(touch.clientX, touch.clientY)
      }
    }
    touchStartPos = null
  })
}

function clearAllStates() {
  nodeCol.clearState('highlighted')
  nodeCol.clearState('selected')
  nodeCol.clearState('dimmed')
  edgeCol.clearState('highlighted')
  edgeCol.clearState('dimmed')
}

function applyRequestHighlight(request) {
  clearAllStates()
  const allowed = new Set(request.ids || [])

  graph.forEachNode((node) => {
    if (allowed.has(node.id)) {
      nodeCol.setState(node.id, 'highlighted', true)
      return
    }
    nodeCol.setState(node.id, 'dimmed', true)
  })

  graph.forEachLink((link) => {
    if (request.nodesOnly) {
      edgeCol.setState(link.id, 'dimmed', true)
      return
    }
    if (allowed.has(link.fromId) && allowed.has(link.toId)) {
      edgeCol.setState(link.id, 'highlighted', true)
      return
    }
    edgeCol.setState(link.id, 'dimmed', true)
  })

  scene.requestRender()
}

function applySelectionHighlight() {
  clearAllStates()

  if (!selectedNodeId) {
    scene.requestRender()
    return
  }

  const selectedNode = graph.getNode(selectedNodeId)
  if (!selectedNode) {
    scene.requestRender()
    return
  }

  nodeCol.setState(selectedNode.id, 'selected', true)
  const highlight = selectionHighlight(selectedNode.id)

  graph.forEachNode((node) => {
    if (highlight.nodes.has(node.id)) {
      nodeCol.setState(node.id, 'highlighted', true)
      return
    }
    nodeCol.setState(node.id, 'dimmed', true)
  })

  graph.forEachLink((link) => {
    if (highlight.links.has(link.id)) {
      edgeCol.setState(link.id, 'highlighted', true)
      return
    }
    edgeCol.setState(link.id, 'dimmed', true)
  })

  scene.requestRender()
}

function selectionHighlight(targetNodeId) {
  const links = directedLinkIndex()
  const path = findRootPath(targetNodeId, links.outgoing)
  const highlightedNodes = new Set(path.nodes)
  const highlightedLinks = new Set(path.links)

  ;(links.incoming.get(targetNodeId) || []).forEach((link) => {
    highlightedNodes.add(link.fromId)
    highlightedNodes.add(link.toId)
    highlightedLinks.add(link.id)
  })

  ;(links.outgoing.get(targetNodeId) || []).forEach((link) => {
    highlightedNodes.add(link.fromId)
    highlightedNodes.add(link.toId)
    highlightedLinks.add(link.id)
  })

  return {
    nodes: highlightedNodes,
    links: highlightedLinks,
  }
}

function directedLinkIndex() {
  const outgoing = new Map()
  const incoming = new Map()

  graph.forEachLink((link) => {
    appendLink(outgoing, link.fromId, link)
    appendLink(incoming, link.toId, link)
  })

  return { outgoing, incoming }
}

function appendLink(index, nodeId, link) {
  if (!index.has(nodeId)) {
    index.set(nodeId, [])
  }
  index.get(nodeId).push(link)
}

function findRootPath(targetNodeId, outgoing) {
  const rootId = graphData.rootId
  if (!rootId || rootId === targetNodeId) {
    return { nodes: [targetNodeId], links: [] }
  }

  const visited = new Set([rootId])
  const previous = new Map()
  const queue = [rootId]

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]
    const links = outgoing.get(current) || []
    for (const link of links) {
      if (visited.has(link.toId)) continue
      visited.add(link.toId)
      previous.set(link.toId, { nodeId: current, linkId: link.id })
      if (link.toId === targetNodeId) {
        return buildPath(rootId, targetNodeId, previous)
      }
      queue.push(link.toId)
    }
  }

  return { nodes: [targetNodeId], links: [] }
}

function buildPath(rootId, targetNodeId, previous) {
  const nodes = [targetNodeId]
  const links = []
  let current = targetNodeId

  while (current !== rootId) {
    const step = previous.get(current)
    if (!step) return { nodes: [targetNodeId], links: [] }
    nodes.unshift(step.nodeId)
    links.unshift(step.linkId)
    current = step.nodeId
  }

  return { nodes, links }
}

function dependencyNodeCountForNodes(payload) {
  const { nodeByID, dependencyIDsByID } = buildDependencyIndex(payload)
  const counts = new Map()

  ;(payload?.nodes || []).forEach((node) => {
    counts.set(node.id, reachableDependencyNodeCount([node.id], dependencyIDsByID, nodeByID))
  })

  return counts
}

function buildDependencyIndex(payload) {
  const nodes = payload?.nodes || []
  const edges = payload?.edges || []
  const nodeByID = new Map(nodes.map((node) => [node.id, node]))
  const dependencyIDsByID = new Map()

  edges.forEach((edge) => {
    if (!nodeByID.has(edge.source) || !nodeByID.has(edge.target)) return
    if (!dependencyIDsByID.has(edge.source)) {
      dependencyIDsByID.set(edge.source, [])
    }
    dependencyIDsByID.get(edge.source).push(edge.target)
  })

  return { nodeByID, dependencyIDsByID }
}

function reachableDependencyNodeCount(startIDs, dependencyIDsByID, nodeByID) {
  const startIDSet = new Set(startIDs)
  const seenDependencyIDs = new Set()
  const stack = startIDs.flatMap((id) => dependencyIDsByID.get(id) || [])

  while (stack.length) {
    const id = stack.pop()
    if (startIDSet.has(id) || seenDependencyIDs.has(id)) continue

    const node = nodeByID.get(id)
    if (!node || node.root) continue

    seenDependencyIDs.add(id)
    stack.push(...(dependencyIDsByID.get(id) || []))
  }

  return seenDependencyIDs.size
}
