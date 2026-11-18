import { publicJSON, publicIdentity, mapModules } from './public-data.js'
import {
  element,
  notice,
  badge,
  metrics,
  disclosure,
  link,
  moduleButton,
  searchable,
} from './ui.js'

/** @typedef {import('./types.js').GraphNode} GraphNode */
/** @typedef {import('./types.js').GraphPayload} GraphPayload */
/** @typedef {{name: string, version: string}} ModuleIdentity */
/** @typedef {{events?: {fixed?: string}[]}} AffectedRange */
/** @typedef {{package?: {ecosystem?: string, name?: string}, ranges?: AffectedRange[]}} AffectedModule */
/**
 * @typedef {Object} Advisory
 * @property {string} id
 * @property {string[]} [aliases]
 * @property {string} [summary]
 * @property {string} [details]
 * @property {string} [withdrawn]
 * @property {{name?: string}[]} [credits]
 * @property {AffectedModule[]} [affected]
 */
/** @typedef {Advisory & {aliases: string[], records: Advisory[]}} AdvisoryGroup */
/** @typedef {{status: 'unknown', error?: string} | {status: 'matched' | 'clear', identity: ModuleIdentity, advisories: Advisory[], groups: AdvisoryGroup[], observedAt: string}} VulnerabilityRecord */
/** @typedef {{records: Map<string, VulnerabilityRecord>, capturedAt: string}} VulnerabilityData */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @returns {value is string | undefined} */
const optionalString = (value) => value === undefined || typeof value === 'string'
/** @param {unknown} value */
function validRange(value) {
  return (
    object(value) &&
    (value.events === undefined ||
      (Array.isArray(value.events) &&
        value.events.every((event) => object(event) && optionalString(event.fixed))))
  )
}
/** @param {unknown} value */
function validAffected(value) {
  if (!object(value)) return false
  if (
    value.package !== undefined &&
    (!object(value.package) ||
      !optionalString(value.package.name) ||
      !optionalString(value.package.ecosystem))
  )
    return false
  return (
    value.ranges === undefined || (Array.isArray(value.ranges) && value.ranges.every(validRange))
  )
}
/** @param {unknown} value @returns {value is Advisory} */
function isAdvisory(value) {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    !optionalString(value.summary) ||
    !optionalString(value.details) ||
    !optionalString(value.withdrawn)
  )
    return false
  if (
    value.aliases !== undefined &&
    (!Array.isArray(value.aliases) || !value.aliases.every((id) => typeof id === 'string'))
  )
    return false
  if (
    value.credits !== undefined &&
    (!Array.isArray(value.credits) ||
      !value.credits.every((credit) => object(credit) && optionalString(credit.name)))
  )
    return false
  if (
    value.affected !== undefined &&
    (!Array.isArray(value.affected) || !value.affected.every(validAffected))
  )
    return false
  return true
}

// OSV may return the same issue from several databases. Connect aliases before
// presenting the count; retain the original records as source evidence.
/** @param {Advisory[]} advisories @returns {AdvisoryGroup[]} */
export function groupAdvisories(advisories) {
  const groups = []
  for (const advisory of advisories) {
    const ids = new Set([advisory.id, ...(advisory.aliases || [])]),
      matching = groups.filter((group) => [...ids].some((id) => group.ids.has(id)))
    const group = { ids, records: [advisory] }
    for (const previous of matching) {
      previous.ids.forEach((id) => ids.add(id))
      group.records.push(...previous.records)
      groups.splice(groups.indexOf(previous), 1)
    }
    groups.push(group)
  }
  return groups
    .map((group) => {
      const primary =
        group.records.find((record) => record.id.startsWith('GO-')) || group.records[0]
      return {
        ...primary,
        aliases: [...group.ids].filter((id) => id !== primary.id),
        records: group.records,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}
/**
 * @param {GraphPayload} graph
 * @param {{signal?: AbortSignal, progress?: (done: number, total: number) => void, fetcher?: typeof fetch}} [options]
 * @returns {Promise<VulnerabilityData>}
 */
export async function lookupVulnerabilities(graph, { signal, progress, fetcher } = {}) {
  /** @param {GraphNode} node @returns {Promise<VulnerabilityRecord>} */
  const lookup = async (node) => {
    const identity = publicIdentity(node)
    if (!identity)
      return { status: 'unknown', error: 'The resolved public module version is unavailable.' }
    /** @type {Advisory[]} */
    const advisories = []
    const tokens = new Set()
    let page = ''
    do {
      /** @type {{package: {name: string, ecosystem: string}, version: string, page_token?: string}} */
      const body = { package: { name: identity.name, ecosystem: 'Go' }, version: identity.version }
      if (page) body.page_token = page
      const result = await publicJSON('https://api.osv.dev/v1/query', { body, signal, fetcher })
      if (
        !object(result) ||
        (result.vulns !== undefined &&
          (!Array.isArray(result.vulns) || !result.vulns.every(isAdvisory))) ||
        !optionalString(result.next_page_token)
      )
        throw new Error('Invalid advisory response')
      const entries = result.vulns === undefined ? [] : /** @type {Advisory[]} */ (result.vulns)
      advisories.push(...entries.filter((item) => !item.withdrawn))
      page = result.next_page_token || ''
      if (page && (tokens.has(page) || tokens.size >= 30))
        throw new Error('Advisory pagination incomplete; this module remains unknown.')
      tokens.add(page)
    } while (page)
    const unique = [...new Map(advisories.map((item) => [item.id, item])).values()]
    return {
      status: unique.length ? 'matched' : 'clear',
      identity,
      advisories: unique,
      groups: groupAdvisories(unique),
      observedAt: new Date().toISOString(),
    }
  }
  const records = await mapModules(graph.nodes, lookup, { signal, progress })
  return { records, capturedAt: new Date().toISOString() }
}
/** @param {Pick<Advisory, 'affected'>} advisory @param {Pick<ModuleIdentity, 'name'>} identity */
export function fixedVersions(advisory, identity) {
  return [
    ...new Set(
      (advisory.affected || [])
        .filter(
          (entry) => entry.package?.ecosystem === 'Go' && entry.package?.name === identity.name,
        )
        .flatMap((entry) =>
          (entry.ranges || []).flatMap((range) =>
            (range.events || [])
              .map((event) => event.fixed)
              .filter((value) => typeof value === 'string' && Boolean(value)),
          ),
        ),
    ),
  ]
}
/** @param {GraphPayload} graph @param {VulnerabilityData | {error: string}} data */
export function vulnerabilityColors(graph, data) {
  const colors = { matched: '#df777e', clear: '#78ceb3', unknown: '#8b95a7' }
  return Object.fromEntries(
    graph.nodes.map((node) => [
      node.id,
      colors[('records' in data && data.records.get(node.id)?.status) || 'unknown'],
    ]),
  )
}
/** @param {import('./types.js').RenderContext<VulnerabilityData>} context */
function render({ host, graph, node, data, select, highlight, state = {} }) {
  if ('error' in data) {
    host.append(notice(data.error, 'analysis-empty'))
    return
  }
  const values = [...data.records.values()],
    matched = values.filter((record) => record.status === 'matched').length,
    unknown = values.filter((record) => record.status === 'unknown').length
  host.append(
    metrics([
      [matched, 'Modules matched', 'analysis-bad'],
      [values.length - matched - unknown, 'No matches', 'analysis-good'],
      [unknown, 'Unknown'],
    ]),
  )
  host.append(
    notice(
      'Module advisory matches · function reachability and product exploitability are unassessed.',
    ),
  )
  host.append(
    notice('Graph: red = advisory match · green = lookup without matches · gray = unknown.'),
  )
  /** @type {VulnerabilityRecord} */
  const selected = data.records.get(node.id) || {
    status: 'unknown',
    error: 'No observation is available.',
  }
  const detail = element('section', undefined, 'analysis-section')
  detail.append(element('h5', 'Selected module · ' + node.version))
  if (selected?.status === 'unknown')
    detail.append(notice(selected.error || 'Lookup unavailable', 'analysis-empty'))
  else if (!selected?.groups.length)
    detail.append(
      notice(
        'OSV returned no known advisory matches for this exact module version.',
        'analysis-empty',
      ),
    )
  else
    for (const advisory of selected.groups) {
      const fixed = fixedVersions(advisory, selected.identity)
      /** @type {HTMLElement[]} */
      const body = [
        notice(advisory.summary || 'No summary supplied'),
        notice(
          'Fixed-version events: ' + (fixed.join(', ') || 'None supplied; review the advisory.'),
        ),
      ]
      const description = advisory.details || ''
      if (description) body.push(notice(description.slice(0, 3500)))
      if (description.length > 3500)
        body.push(notice('Description shortened for display; the source contains the full text.'))
      if (advisory.records.length > 1)
        body.push(
          notice(
            advisory.records.length + ' source records grouped by shared advisory identifiers.',
          ),
        )
      body.push(
        link(
          'Read advisory and affected ranges ↗',
          'https://osv.dev/vulnerability/' + encodeURIComponent(advisory.id),
        ),
      )
      for (const record of advisory.records) {
        const source = record.id.startsWith('GO-')
          ? 'Go Vulnerability Database (The Go Authors)'
          : record.id.startsWith('GHSA-')
            ? 'GitHub Advisory Database'
            : ''
        if (source)
          body.push(
            notice('Source record: ' + record.id + ' · ' + source),
            link('Record license: CC-BY-4.0 ↗', 'https://creativecommons.org/licenses/by/4.0/'),
          )
        const credits = (record.credits || []).filter(
          (credit) => typeof credit.name === 'string' && credit.name.trim(),
        )
        if (credits.length)
          body.push(
            notice(
              'Credits (' + record.id + '): ' + credits.map((credit) => credit.name).join('; '),
            ),
          )
      }
      detail.append(
        disclosure(
          advisory.id +
            (advisory.aliases?.length ? ' · ' + advisory.aliases.slice(0, 2).join(', ') : ''),
          body,
        ),
      )
    }
  if (
    selected.status !== 'unknown' &&
    (selected.identity.name !== node.name || selected.identity.version !== node.version)
  )
    detail.append(
      notice('Resolved replacement: ' + selected.identity.name + '@' + selected.identity.version),
    )
  if (selected.status !== 'unknown' && selected.observedAt)
    detail.append(notice('Observed: ' + selected.observedAt, 'analysis-provenance'))
  const priority = { matched: 0, unknown: 1, clear: 2 }
  const items = graph.nodes
    .map((n) => {
      const record =
        data.records.get(n.id) || /** @type {VulnerabilityRecord} */ ({ status: 'unknown' })
      return {
        node: n,
        record,
        status: record.status,
        search: [
          n.name,
          n.version,
          ...(record.status === 'unknown'
            ? []
            : [
                record.identity.name,
                record.identity.version,
                ...record.advisories.flatMap((a) => [a.id, ...(a.aliases || []), a.summary || '']),
              ]),
        ].join(' '),
      }
    })
    .sort(
      (a, b) =>
        priority[a.status] - priority[b.status] ||
        (b.record.status === 'unknown' ? 0 : b.record.groups.length) -
          (a.record.status === 'unknown' ? 0 : a.record.groups.length) ||
        a.node.name.localeCompare(b.node.name),
    )
  /** @type {[string, string][]} */
  const filters = [
    ['matched', 'Advisory matches'],
    ['clear', 'No matches'],
    ['unknown', 'Unknown'],
  ]
  searchable(host, {
    label: 'Module advisory results',
    items,
    filters,
    state,
    groups: filters,
    highlight,
    headers: ['Module / version', 'OSV result'],
    row: (item) => [
      moduleButton(item.node, select),
      badge(
        item.record.status === 'matched'
          ? item.record.groups.length + (item.record.groups.length === 1 ? ' issue' : ' issues')
          : item.status === 'clear'
            ? 'No matches'
            : 'Unknown',
        item.status === 'matched' ? 'bad' : item.status === 'clear' ? 'good' : '',
      ),
    ],
  })
  host.append(disclosure('Selected module · ' + node.name, [detail], true))
  host.append(notice('Source: OSV · Observed ' + data.capturedAt, 'analysis-provenance'))
  host.append(
    link(
      'Original advisory databases and data licenses ↗',
      'https://google.github.io/osv.dev/data/',
    ),
  )
}
/** @type {import('./types.js').BrowserLens<VulnerabilityData>} */
const lens = {
  modulePicker: true,
  scope: 'Known advisories · exact module versions',
  load: lookupVulnerabilities,
  render,
  colors: vulnerabilityColors,
  status: (data) =>
    'error' in data
      ? 'Lookup failed · refresh to retry'
      : 'Source: OSV · exact resolved identities',
}

export default lens
