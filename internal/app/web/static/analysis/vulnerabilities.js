import { publicJSON, publicIdentity, mapModules } from './public-data.js'
import { element, notice, badge, metrics, disclosure, link, moduleButton, searchable } from './ui.js'

// OSV may return the same issue from several databases. Connect aliases before
// presenting the count; retain the original records as source evidence.
export function groupAdvisories(advisories) {
  const groups = []
  for (const advisory of advisories) {
    const ids = new Set([advisory.id, ...(advisory.aliases || [])]), matching = groups.filter(group => [...ids].some(id => group.ids.has(id)))
    const group = { ids, records: [advisory] }
    for (const previous of matching) { previous.ids.forEach(id => ids.add(id)); group.records.push(...previous.records); groups.splice(groups.indexOf(previous), 1) }
    groups.push(group)
  }
  return groups.map(group => {
    const primary = group.records.find(record => record.id.startsWith('GO-')) || group.records[0]
    return { ...primary, aliases: [...group.ids].filter(id => id !== primary.id), records: group.records }
  }).sort((a, b) => a.id.localeCompare(b.id))
}
export async function lookupVulnerabilities(graph, { signal, progress, fetcher } = {}) {
  const records = await mapModules(graph.nodes, async node => {
    const identity = publicIdentity(node)
    if (!identity) return { status: 'unknown', error: 'The resolved public module version is unavailable.' }
    const advisories = [], tokens = new Set(); let page = ''
    do {
      const body = { package: { name: identity.name, ecosystem: 'Go' }, version: identity.version }
      if (page) body.page_token = page
      const result = await publicJSON('https://api.osv.dev/v1/query', { body, signal, fetcher })
      if (result.vulns !== undefined && !Array.isArray(result.vulns)) throw new Error('Invalid advisory response')
      advisories.push(...(result.vulns || []).filter(item => !item.withdrawn))
      page = result.next_page_token || ''
      if (page && (tokens.has(page) || tokens.size >= 30)) throw new Error('Advisory pagination incomplete; this module remains unknown.')
      tokens.add(page)
    } while (page)
    const unique = [...new Map(advisories.map(item => [item.id, item])).values()]
    return { status: unique.length ? 'matched' : 'clear', identity, advisories: unique, groups: groupAdvisories(unique), observedAt: new Date().toISOString() }
  }, { signal, progress })
  return { records, capturedAt: new Date().toISOString() }
}
export function fixedVersions(advisory, identity) {
  return [...new Set((advisory.affected || []).filter(entry => entry.package?.ecosystem === 'Go' && entry.package?.name === identity.name).flatMap(entry => (entry.ranges || []).flatMap(range => (range.events || []).map(event => event.fixed).filter(Boolean))))]
}
export function vulnerabilityColors(graph, data) {
  return Object.fromEntries(graph.nodes.map(node => [node.id, { matched: '#df777e', clear: '#78ceb3', unknown: '#8b95a7' }[data.records?.get(node.id)?.status] || '#8b95a7']))
}
function render({ host, graph, node, data, select, highlight, state = {} }) {
  if (data.error) { host.append(notice(data.error, 'analysis-empty')); return }
  const values = [...data.records.values()], matched = values.filter(record => record.status === 'matched').length, unknown = values.filter(record => record.status === 'unknown').length
  host.append(metrics([[matched, 'Modules matched', 'analysis-bad'], [values.length - matched - unknown, 'No matches', 'analysis-good'], [unknown, 'Unknown']]))
  host.append(notice('Module advisory matches · function reachability and product exploitability are unassessed.'))
  host.append(notice('Graph: red = advisory match · green = lookup without matches · gray = unknown.'))
  const selected = data.records.get(node.id) || { status: 'unknown', error: 'No observation is available.' }
  const detail = element('section', undefined, 'analysis-section'); detail.append(element('h5', 'Selected module · ' + node.version))
  if (selected?.status === 'unknown') detail.append(notice(selected.error || 'Lookup unavailable', 'analysis-empty'))
  else if (!selected?.groups.length) detail.append(notice('OSV returned no known advisory matches for this exact module version.', 'analysis-empty'))
  else for (const advisory of selected.groups) {
    const fixed = fixedVersions(advisory, selected.identity)
    const body = [notice(advisory.summary || 'No summary supplied'), notice('Fixed-version events: ' + (fixed.join(', ') || 'None supplied; review the advisory.'))]
    const description = advisory.details || ''
    if (description) body.push(notice(description.slice(0, 3500)))
    if (description.length > 3500) body.push(notice('Description shortened for display; the source contains the full text.'))
    if (advisory.records.length > 1) body.push(notice(advisory.records.length + ' source records grouped by shared advisory identifiers.'))
    body.push(link('Read advisory and affected ranges ↗', 'https://osv.dev/vulnerability/' + encodeURIComponent(advisory.id)))
    for (const record of advisory.records) {
      const source = record.id.startsWith('GO-') ? 'Go Vulnerability Database (The Go Authors)' : record.id.startsWith('GHSA-') ? 'GitHub Advisory Database' : ''
      if (source) body.push(notice('Source record: ' + record.id + ' · ' + source), link('Record license: CC-BY-4.0 ↗', 'https://creativecommons.org/licenses/by/4.0/'))
      const credits = (Array.isArray(record.credits) ? record.credits : []).filter(credit => typeof credit.name === 'string' && credit.name.trim())
      if (credits.length) body.push(notice('Credits (' + record.id + '): ' + credits.map(credit => credit.name).join('; ')))
    }
    detail.append(disclosure(advisory.id + (advisory.aliases?.length ? ' · ' + advisory.aliases.slice(0, 2).join(', ') : ''), body))
  }
  if (selected.identity && (selected.identity.name !== node.name || selected.identity.version !== node.version)) detail.append(notice('Resolved replacement: ' + selected.identity.name + '@' + selected.identity.version))
  if (selected.observedAt) detail.append(notice('Observed: ' + selected.observedAt, 'analysis-provenance'))
  const priority = { matched: 0, unknown: 1, clear: 2 }
  const items = graph.nodes.map(n => { const record = data.records.get(n.id); return { node: n, record, status: record.status, search: [n.name, n.version, record.identity?.name || '', record.identity?.version || '', ...(record.advisories || []).flatMap(a => [a.id, ...(a.aliases || []), a.summary || ''])].join(' ') } }).sort((a, b) => priority[a.status] - priority[b.status] || (b.record.groups?.length || 0) - (a.record.groups?.length || 0) || a.node.name.localeCompare(b.node.name))
  const filters = [['matched', 'Advisory matches'], ['clear', 'No matches'], ['unknown', 'Unknown']]
  searchable(host, { label: 'Module advisory results', items, filters, state, groups: filters, highlight, headers: ['Module / version', 'OSV result'], row: item => [moduleButton(item.node, select), badge(item.status === 'matched' ? item.record.groups.length + (item.record.groups.length === 1 ? ' issue' : ' issues') : item.status === 'clear' ? 'No matches' : 'Unknown', item.status === 'matched' ? 'bad' : item.status === 'clear' ? 'good' : '')] })
  host.append(disclosure('Selected module · ' + node.name, [detail], true))
  host.append(notice('Source: OSV · Observed ' + data.capturedAt, 'analysis-provenance'))
  host.append(link('Original advisory databases and data licenses ↗', 'https://google.github.io/osv.dev/data/'))
}
/** @type {import('./types.js').BrowserLens} */
const lens = {
  modulePicker: true,
  scope: 'Known advisories · exact module versions',
  load: lookupVulnerabilities,
  render,
  colors: vulnerabilityColors,
  status: data => data.error ? 'Lookup failed · refresh to retry' : 'Source: OSV · exact resolved identities',
}

export default lens
