import { publicIdentity } from './public-data.js'
import { loadGoRequirements } from '../wasm-client.js'
import { outgoingIndex, shortestPath } from '../graph-traversal.js'

/** @typedef {import('./types.js').GraphNode} GraphNode */
/** @typedef {import('./types.js').GraphPayload} GraphPayload */
/** @typedef {import('./types.js').GoRequirement} GoRequirement */
/** @typedef {import('./types.js').ModuleIdentity} ModuleIdentity */
/** @typedef {{records: Map<string, GoRequirement>, capturedAt?: string}} RequirementData */
/** @typedef {{node: GraphNode, record: GoRequirement, parts: string[] | null, family: string, status: string, search: string}} RequirementItem */
/** @typedef {{id: string, label: string, items: RequirementItem[], color?: string}} RequirementGroup */
/**
 * @typedef {Object} RequirementLookupOptions
 * @property {AbortSignal} [signal]
 * @property {(done: number, total: number) => void} [progress]
 * @property {boolean} [refresh]
 * @property {(nodes: GraphNode[], options: import('../../wasm-globals').RequirementOptions) => Promise<{records?: Record<string, GoRequirement>} | null>} [lookup]
 */

// Supplemental metadata belongs to its graph snapshot, without mutating nodes.
/** @type {WeakMap<GraphPayload, {records: Map<string, GoRequirement>, generation: number}>} */
const snapshots = new WeakMap()

// Shared by legend swatches, labels and the Canvas/WebGPU rendering buffers.
const releaseGroupColors = ['#74b7e7', '#ea8aa6', '#a0eea0', '#9674e7', '#eac28a']

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*)|(beta|rc)(0|[1-9]\d*))?$/
const maxComponentDigits = 32
export const maxGoVersionLength = 3 * maxComponentDigits + '.beta'.length

// Components are canonical ASCII decimals without leading zeroes.
/** @param {string} left @param {string} right */
function compareDigits(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** @param {unknown} value */
function versionParts(value) {
  if (typeof value !== 'string' || value.length > maxGoVersionLength) return null
  const match = versionPattern.exec(value)
  if (!match || match[1] === '0') return null
  const [, major, minor, patch, kind, serial] = match
  const revision = patch || serial || '0'
  if (Math.max(major.length, minor.length, revision.length) > maxComponentDigits) return null
  // Since 1.21, language versions precede betas, RCs and the .0 release.
  let phase = '3'
  if (kind === 'beta') phase = '1'
  else if (kind === 'rc') phase = '2'
  else if (!patch && (major !== '1' || compareDigits(minor, '21') >= 0)) phase = '0'
  return [major, minor, phase, revision]
}

/** @param {string[]} left @param {string[]} right */
export function compareVersionParts(left, right) {
  for (let i = 0; i < left.length; i++) {
    const order = compareDigits(left[i], right[i])
    if (order) return order
  }
  return 0
}

/** @param {string} left @param {string} right */
export function compareGoVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right)
  if (!a || !b) throw new Error('Invalid Go version')
  return compareVersionParts(a, b)
}

/** @param {string} input */
export function targetGoVersion(input) {
  const value = (input || '').trim().replace(/^go/, '')
  if (!versionParts(value)) return ''
  // A user-entered release family such as 1.26 means its .0 toolchain.
  return /^\d+\.\d+$/.test(value) ? value + '.0' : value
}

/** @param {ModuleIdentity} identity */
export function goModURL(identity) {
  /** @param {string} value */
  const escape = (value) =>
    value
      .replace(/[A-Z]/g, (char) => '!' + char.toLowerCase())
      .split('/')
      .map(encodeURIComponent)
      .join('/')
  return `https://proxy.golang.org/${escape(identity.name)}/@v/${escape(identity.version)}.mod`
}

/**
 * @param {GraphPayload} graph
 * @param {RequirementLookupOptions} [options]
 * @returns {Promise<RequirementData>}
 */
export async function lookupGoRequirements(
  graph,
  { signal, progress = () => {}, refresh = false, lookup = loadGoRequirements } = {},
) {
  signal?.throwIfAborted()
  let snapshot = snapshots.get(graph)
  if (!snapshot) {
    snapshot = { records: new Map(), generation: 0 }
    snapshots.set(graph, snapshot)
  }
  const generation = refresh ? ++snapshot.generation : snapshot.generation
  /** @type {Map<string, GoRequirement>} */
  const records = new Map()
  /** @type {GraphNode[]} */
  const missing = []
  const previous = snapshot.records
  for (const node of graph.nodes) {
    const identity = publicIdentity(node)
    if (!identity) {
      records.set(node.id, {
        status: 'unknown',
        error: 'No resolved public module version is available.',
      })
      continue
    }
    const candidate = refresh ? null : previous?.get(node.id) || node.goRequirement
    if (
      candidate?.status === 'observed' &&
      versionParts(candidate.minimum) &&
      candidate.identity?.name === identity.name &&
      candidate.identity?.version === identity.version &&
      candidate.source &&
      candidate.observedAt
    ) {
      records.set(node.id, structuredClone(candidate))
    } else missing.push(node)
  }
  const reused = records.size
  progress(reused, graph.nodes.length)
  if (missing.length) {
    /** @type {{records?: Record<string, GoRequirement>} | null} */
    let response
    try {
      response = await lookup(missing, {
        signal,
        refresh,
        onProgress: ({ done }) => progress(reused + done, graph.nodes.length),
      })
      signal?.throwIfAborted()
    } catch (error) {
      signal?.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      response = {
        records: Object.fromEntries(
          missing.map((node) => [
            node.id,
            { status: 'unknown', error: message || 'Module metadata unavailable' },
          ]),
        ),
      }
    }
    for (const node of missing) {
      const identity = publicIdentity(node),
        record = response?.records?.[node.id]
      if (!identity) {
        records.set(node.id, {
          status: 'unknown',
          error: 'No resolved public module version is available.',
        })
        continue
      }
      const matches =
        record?.identity?.name === identity.name && record.identity?.version === identity.version
      if (
        matches &&
        record.status === 'observed' &&
        versionParts(record.minimum) &&
        record.source &&
        record.observedAt
      )
        records.set(node.id, record)
      else
        records.set(node.id, {
          status: 'unknown',
          identity,
          source: goModURL(identity),
          observedAt: record?.observedAt || new Date().toISOString(),
          error: record?.error || 'No valid exact-version metadata was returned.',
        })
    }
  }
  signal?.throwIfAborted()
  if (generation === snapshot.generation)
    snapshot.records = new Map([...records].map(([id, record]) => [id, structuredClone(record)]))
  progress(graph.nodes.length, graph.nodes.length)
  return { records, capturedAt: new Date().toISOString() }
}

/** @param {GoRequirement | null | undefined} record @param {string} target */
export function classifyRequirement(record, target) {
  const minimum = record?.status === 'observed' ? versionParts(record.minimum) : null
  return comparisonStatus(minimum, versionParts(target))
}

/** @param {string[] | null} minimum @param {string[] | null} target */
function comparisonStatus(minimum, target) {
  if (!minimum || !target) return 'unknown'
  return compareVersionParts(minimum, target) > 0 ? 'newer' : 'meets'
}

/** @param {GraphPayload} graph @param {RequirementData} data @param {string} target */
export function requirementSummary(graph, data, target) {
  const targetParts = versionParts(target)
  /** @type {Map<string, {parts: string[], family: string, count: number}>} */
  const versions = new Map()
  /** @param {string | undefined} minimum */
  function countVersion(minimum) {
    if (!minimum || minimum.length > maxGoVersionLength) return null
    let version = versions.get(minimum)
    if (!version) {
      const parts = versionParts(minimum)
      if (!parts) return null
      version = { parts, family: parts[0] + '.' + parts[1], count: 0 }
      versions.set(minimum, version)
    }
    version.count++
    return version
  }
  const items = graph.nodes.map((node) => {
    const record =
      data.records?.get(node.id) ||
      /** @type {GoRequirement} */ ({ status: 'unknown', error: 'Module metadata unavailable' })
    const version = record.status === 'observed' ? countVersion(record.minimum) : null
    const parts = version?.parts ?? null
    return {
      node,
      record,
      parts,
      family: version?.family || '',
      status: comparisonStatus(parts, targetParts),
      search: [
        node.name,
        node.version,
        record.identity?.name,
        version && 'Go ' + record.minimum,
      ]
        .filter(Boolean)
        .join(' '),
    }
  })
  const ranked = [...versions].sort(([, a], [, b]) => compareVersionParts(b.parts, a.parts))
  const highestParts = ranked[0]?.[1].parts
  const families = [...new Set(ranked.map(([, version]) => version.family))]
  const visibleFamilies = families.slice(0, 4)
  /** @type {RequirementGroup[]} */
  const groups = visibleFamilies.map((family) => ({
    id: family,
    label: 'Go ' + family,
    items: items.filter((item) => item.family === family),
  }))
  if (families.length > 4) {
    const earlier = new Set(families.slice(4))
    groups.push({
      id: 'earlier',
      label: 'Go ' + families[4] + ' and earlier',
      items: items.filter((item) => earlier.has(item.family)),
    })
  }
  // Keep the overview and graph to a handful of matching categorical colors.
  groups.forEach((group, index) => {
    group.color = releaseGroupColors[index]
  })
  const unknown = items.filter((item) => !item.family)
  if (unknown.length)
    groups.push({ id: 'unknown', label: 'Unknown', items: unknown, color: '#8b95a7' })
  return {
    items,
    minimums: ranked.map(([minimum, version]) => [minimum, version.count]),
    highest: ranked[0]?.[0] || '',
    groups,
    highestItems: items.filter(
      (item) => item.parts && highestParts && compareVersionParts(item.parts, highestParts) === 0,
    ),
    newer: items.filter((item) => item.status === 'newer'),
    unknown,
  }
}

/** @param {GraphPayload} graph @param {RequirementData} data */
export function defaultTarget(graph, data) {
  const root = data.records?.get(graph.rootId)
  if (root?.status === 'observed' && root.minimum && versionParts(root.minimum))
    return targetGoVersion(root.minimum)
  return targetGoVersion(requirementSummary(graph, data, '').highest)
}

/** @param {GraphPayload} graph @param {RequirementData} data */
export function requirementVersionColors(graph, data) {
  /** @type {Map<string, string>} */
  const colors = new Map()
  for (const group of requirementSummary(graph, data, '').groups) {
    if (group.id === 'unknown' || !group.color) continue
    for (const item of group.items)
      if (item.record.minimum) colors.set(item.record.minimum, group.color)
  }
  return colors
}

/** @param {GraphPayload} graph @param {RequirementData} data */
export function requirementColors(graph, data) {
  const colors = requirementVersionColors(graph, data)
  return Object.fromEntries(
    graph.nodes.map((node) => {
      const record = data.records?.get(node.id)
      return [
        node.id,
        (record?.status === 'observed' && record.minimum && colors.get(record.minimum)) ||
          '#8b95a7',
      ]
    }),
  )
}

/** @param {GraphPayload} graph @param {string} target */
export function requirementPath(graph, target) {
  const nodes = new Set(graph.nodes.map((node) => node.id))
  if (!nodes.has(graph.rootId) || !nodes.has(target)) return []
  return shortestPath(
    outgoingIndex(graph.edges.filter((edge) => nodes.has(edge.source) && nodes.has(edge.target))),
    graph.rootId,
    target,
  )
}
