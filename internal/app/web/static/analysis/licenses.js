import { publicJSON, publicIdentity, mapModules, versionURL } from './public-data.js'
import { element, notice, badge, metrics, link, moduleButton, searchable, action } from './ui.js'

export function licenseObservation(body, identity, source, observedAt = new Date().toISOString()) {
  if (body.versionKey && (body.versionKey.name !== identity.name || body.versionKey.version !== identity.version)) throw new Error('Source returned a different module identity')
  const expressions = Array.isArray(body.licenses) ? [...new Set(body.licenses.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))] : []
  const nonstandard = expressions.some(value => value.toLowerCase() === 'non-standard')
  return { status: !expressions.length ? 'unknown' : nonstandard ? 'nonstandard' : 'observed', identity, expressions, source, observedAt }
}
export async function lookupLicenses(graph, { signal, progress, fetcher } = {}) {
  const records = await mapModules(graph.nodes, async node => {
    const identity = publicIdentity(node)
    if (!identity) return { status: 'unknown', error: 'No resolved public module version is available.', expressions: [] }
    const source = versionURL(identity)
    return licenseObservation(await publicJSON(source, { signal, fetcher }), identity, source)
  }, { signal, progress })
  return { records, capturedAt: new Date().toISOString() }
}
export function licenseColors(graph, data) {
  return Object.fromEntries(graph.nodes.map(node => [node.id, { observed: '#78ceb3', nonstandard: '#f2c976', unknown: '#8b95a7' }[data.records?.get(node.id)?.status] || '#8b95a7']))
}
function render({ host, graph, node, data, select, highlight, state = {} }) {
  if (data.error) { host.append(notice(data.error, 'analysis-empty')); return }
  const records = [...data.records.values()], observed = records.filter(r => r.status === 'observed').length, unusual = records.filter(r => r.status === 'nonstandard').length
  host.append(metrics([[observed, 'With identifiers', 'analysis-good'], [unusual, 'Non-standard', 'analysis-warning'], [records.length - observed - unusual, 'Unknown']]))
  host.append(notice('Observed license expressions for exact module versions. Multiple entries have an unspecified relationship.'))
  const selected = data.records.get(node.id) || { status: 'unknown', expressions: [] }, detail = element('section', undefined, 'analysis-section')
  detail.append(element('h5', 'Selected version · ' + node.version))
  if (selected.expressions?.length) {
    const list = element('div', undefined, 'analysis-actions'); selected.expressions.forEach(expression => list.append(badge(expression, selected.status === 'nonstandard' ? 'warning' : 'good'))); detail.append(list)
  } else detail.append(notice(selected.error || 'No license evidence is available for this exact version.', 'analysis-empty'))
  if (selected.expressions?.length > 1) detail.append(notice('The source records multiple expressions with an unspecified relationship. They are not combined into an AND / OR expression.'))
  if (selected.identity && (selected.identity.name !== node.name || selected.identity.version !== node.version)) detail.append(notice('Resolved replacement: ' + selected.identity.name + '@' + selected.identity.version))
  if (selected.source) detail.append(link('View exact-version source ↗', selected.source), notice('Observed: ' + selected.observedAt))
  host.append(detail)
  const items = graph.nodes.map(n => { const record = data.records.get(n.id); return { node: n, record, status: record.status, search: [n.name, n.version, ...(record.expressions || [])].join(' ') } })
  searchable(host, { label: 'Module license evidence', placeholder: 'Filter module or license…', items, state, filters: [['observed', 'Identifiers'], ['nonstandard', 'Non-standard'], ['unknown', 'Unknown']], headers: ['Module / version', 'Evidence'], row: item => {
    const state = element('div'); if (item.record.expressions?.length) item.record.expressions.forEach(value => state.append(badge(value, item.status === 'observed' ? 'good' : 'warning'))); else state.append(badge('Unknown'))
    return [moduleButton(item.node, select), state]
  } })
  const actions = element('div', undefined, 'analysis-actions')
  const unknowns = items.filter(item => item.status === 'unknown').map(item => item.node.id)
  const showUnknowns = action('Highlight unknowns', () => highlight({ ids: unknowns, color: '#aab8cf', nodesOnly: true }))
  showUnknowns.disabled = !unknowns.length
  actions.append(showUnknowns)
  host.append(actions, notice('Graph: green = identifiers observed · amber = non-standard · gray = unknown. These colors show evidence availability; they are not license approval decisions.'))
  host.append(notice('Source: deps.dev · Module metadata does not establish file-level completeness or license compatibility.', 'analysis-provenance'))
  host.append(link('deps.dev-generated metadata: CC-BY-4.0 ↗', 'https://creativecommons.org/licenses/by/4.0/'))
}
/** @type {import('./types.js').BrowserLens} */
const lens = {
  modulePicker: true,
  scope: 'Exact-version metadata · source evidence',
  load: lookupLicenses,
  render,
  colors: licenseColors,
  status: data => data.error ? 'Lookup failed · refresh to retry' : 'Source: deps.dev · recorded license expressions',
}

export default lens
