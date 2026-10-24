import { mapModules, publicIdentity, publicText } from './public-data.js'

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*)|(beta|rc)(0|[1-9]\d*))?$/

function versionParts(value) {
  if (typeof value !== 'string') return null
  const match = versionPattern.exec(value)
  if (!match || match[1] === '0') return null
  const major = BigInt(match[1]), minor = BigInt(match[2])
  const languageOnly = match[3] === undefined && !match[4]
  // Since 1.21, language versions precede betas, RCs and the .0 release.
  const phase = match[4] === 'beta' ? 1 : match[4] === 'rc' ? 2 : languageOnly && (major > 1n || minor >= 21n) ? 0 : 3
  return [major, minor, BigInt(phase), BigInt(match[3] || match[5] || '0')]
}

export function compareGoVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) throw new Error('Invalid Go version')
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

export function targetGoVersion(input) {
  const value = (input || '').trim().replace(/^go/, '')
  if (!versionParts(value)) return ''
  // A user-entered release family such as 1.26 means its .0 toolchain.
  return /^\d+\.\d+$/.test(value) ? value + '.0' : value
}

function withoutComments(text) {
  let result = '', quote = '', block = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1]
    if (block) {
      if (char === '*' && next === '/') { block = false; i++; result += ' ' }
      else if (char === '\n') result += '\n'
    } else if (quote) {
      result += char
      if (char === '\\' && quote === '"') { result += text[++i] || '' }
      else if (char === quote) quote = ''
      else if (char === '\n') throw new Error('Invalid quoted go.mod field')
    } else if (char === '"' || char === '`') { quote = char; result += char }
    else if (char === '/' && next === '*') { block = true; i++; result += ' ' }
    else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      result += '\n'
    } else result += char
  }
  if (block || quote) throw new Error('Unterminated go.mod comment or string')
  return result
}

export function readGoMinimum(text) {
  const lines = withoutComments(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const modules = lines.filter(line => /^module(?:\s|$)/.test(line))
  if (modules.length !== 1 || !/^module\s+(?:"(?:[^"\\]|\\.)+"|[^\s"`]+)$/.test(modules[0])) throw new Error('Source did not contain a module declaration')
  const directives = lines.filter(line => /^go(?:\s|[(["`]|$)/.test(line))
  if (!directives.length) return { minimum: '1.16', implicit: true }
  if (directives.length !== 1) throw new Error('Source contains multiple go directives')
  const match = /^go\s+(.+)$/.exec(directives[0])
  let version = match?.[1] || ''
  if (version.startsWith('"')) {
    try { version = JSON.parse(version) } catch { throw new Error('Invalid quoted Go version') }
  }
  if (!versionParts(version)) throw new Error('Source contains an invalid Go minimum')
  return { minimum: version, implicit: false }
}

export function goModURL(identity) {
  const escape = value => value.replace(/[A-Z]/g, char => '!' + char.toLowerCase()).split('/').map(encodeURIComponent).join('/')
  return `https://proxy.golang.org/${escape(identity.name)}/@v/${escape(identity.version)}.mod`
}

export async function lookupGoRequirements(graph, { signal, progress, fetcher } = {}) {
  signal?.throwIfAborted()
  const records = await mapModules(graph.nodes, async node => {
    const identity = publicIdentity(node)
    if (!identity) return { status: 'unknown', error: 'No resolved public module version is available.' }
    const source = goModURL(identity)
    try {
      const body = await publicText(source, { signal, fetcher })
      return { status: 'observed', ...readGoMinimum(body), identity, source, observedAt: new Date().toISOString() }
    } catch (error) {
      signal?.throwIfAborted()
      return { status: 'unknown', error: error.message || 'Module metadata unavailable', identity, source, observedAt: new Date().toISOString() }
    }
  }, { signal, progress })
  return { records, capturedAt: new Date().toISOString() }
}

export function classifyRequirement(record, target) {
  if (record?.status !== 'observed' || !versionParts(record.minimum) || !versionParts(target)) return 'unknown'
  return compareGoVersions(record.minimum, target) > 0 ? 'newer' : 'meets'
}

export function requirementSummary(graph, data, target) {
  const items = graph.nodes.map(node => {
    const record = data.records?.get(node.id) || { status: 'unknown', error: 'Module metadata unavailable' }
    const parts = record.status === 'observed' && versionParts(record.minimum)
    const family = parts ? parts.slice(0, 2).join('.') : ''
    return { node, record, family, status: classifyRequirement(record, target), search: [node.name, node.version, record.identity?.name, record.minimum && 'Go ' + record.minimum].filter(Boolean).join(' ') }
  })
  const versions = new Map()
  for (const { record } of items) if (record.status === 'observed' && versionParts(record.minimum)) versions.set(record.minimum, (versions.get(record.minimum) || 0) + 1)
  const minimums = [...versions].sort(([a], [b]) => compareGoVersions(b, a))
  const highest = minimums[0]?.[0] || ''
  const families = [...new Set(items.map(item => item.family).filter(Boolean))].sort((a, b) => compareGoVersions(b, a))
  const groups = families.slice(0, 4).map(family => ({ id: family, label: 'Go ' + family, items: items.filter(item => item.family === family) }))
  if (families.length > 4) {
    const earlier = new Set(families.slice(4))
    groups.push({ id: 'earlier', label: 'Go ' + families[4] + ' and earlier', items: items.filter(item => earlier.has(item.family)) })
  }
  // Keep the overview and graph to a handful of matching categorical colors.
  groups.forEach((group, index) => { group.color = `hsl(${((205 + index * 137.508) % 360).toFixed(1)}, 70%, ${68 + index % 3 * 5}%)` })
  const unknown = items.filter(item => !item.family)
  if (unknown.length) groups.push({ id: 'unknown', label: 'Unknown', items: unknown, color: '#8b95a7' })
  return {
    items, minimums, highest, groups,
    highestItems: items.filter(item => item.record.status === 'observed' && versionParts(item.record.minimum) && highest && compareGoVersions(item.record.minimum, highest) === 0),
    newer: items.filter(item => item.status === 'newer'),
    unknown,
  }
}

export function defaultTarget(graph, data) {
  return targetGoVersion(data.records?.get(graph.rootId)?.minimum || requirementSummary(graph, data, '').highest)
}

export function requirementVersionColors(graph, data) {
  return new Map(requirementSummary(graph, data, '').groups
    .filter(group => group.id !== 'unknown')
    .flatMap(group => group.items.map(item => [item.record.minimum, group.color])))
}

export function requirementColors(graph, data) {
  const colors = requirementVersionColors(graph, data)
  return Object.fromEntries(graph.nodes.map(node => {
    const record = data.records?.get(node.id)
    return [node.id, record?.status === 'observed' && colors.get(record.minimum) || '#8b95a7']
  }))
}

export function requirementPath(graph, target) {
  const nodes = new Set(graph.nodes.map(node => node.id)), outgoing = new Map()
  if (!nodes.has(graph.rootId) || !nodes.has(target)) return []
  for (const edge of graph.edges) if (nodes.has(edge.source) && nodes.has(edge.target)) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    outgoing.get(edge.source).push(edge.target)
  }
  const previous = new Map([[graph.rootId, null]]), queue = [graph.rootId]
  for (let i = 0; i < queue.length && !previous.has(target); i++) for (const id of outgoing.get(queue[i]) || []) {
    if (!previous.has(id)) { previous.set(id, queue[i]); queue.push(id) }
  }
  if (!previous.has(target)) return []
  const path = []
  for (let id = target; id !== null; id = previous.get(id)) path.push(id)
  return path.reverse()
}
