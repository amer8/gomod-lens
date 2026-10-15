import { publicJSON } from './public-data.js'
import { element, notice, badge, metrics, disclosure, link } from './ui.js'

const groups = {
  'Branch-Protection': 'Change control', 'Code-Review': 'Change control',
  'Dangerous-Workflow': 'CI/CD protection', 'Token-Permissions': 'CI/CD protection', 'Pinned-Dependencies': 'CI/CD protection', 'Webhooks': 'CI/CD protection',
  'CI-Tests': 'Security testing', SAST: 'Security testing', Fuzzing: 'Security testing',
  Packaging: 'Release integrity', 'Signed-Releases': 'Release integrity', 'Binary-Artifacts': 'Release integrity', SBOM: 'Release integrity',
  Maintained: 'Project maintenance', Contributors: 'Project maintenance', 'CII-Best-Practices': 'Project maintenance',
  'Dependency-Update-Tool': 'Project hygiene', Vulnerabilities: 'Project hygiene', License: 'Project hygiene', 'Security-Policy': 'Project hygiene',
}
export function normalizeReport(project, source, fetchedAt = new Date().toISOString()) {
  const report = project?.scorecard
  if (!report) return { missing: true, source, fetchedAt, checks: [] }
  const score = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null
  return {
    source, fetchedAt, score: score(report.overallScore), date: report.date || '', repository: report.repository || {}, engine: report.scorecard || {},
    checks: (Array.isArray(report.checks) ? report.checks : []).map(check => ({ name: String(check.name || 'Unnamed check'), score: score(check.score), reason: String(check.reason || 'No explanation supplied'), details: Array.isArray(check.details) ? check.details.filter(v => typeof v === 'string') : [], documentation: check.documentation || {}, group: groups[check.name] || 'Other checks' })),
  }
}
export async function loadReport(node, { signal, fetcher } = {}) {
  const project = node?.openssf?.projectId || node?.lenses?.openssf?.details?.projectId
  if (!project) return { missing: true, checks: [], message: 'No source repository mapping is available for this module.' }
  const source = 'https://api.deps.dev/v3/projects/' + encodeURIComponent(project)
  return normalizeReport(await publicJSON(source, { signal, fetcher }), source)
}
function render({ host, data, node, state = {}, inspect }) {
  if (data.error || data.missing) { host.append(notice(data.error || data.message || 'This repository has no published Scorecard report.', 'analysis-empty')); return }
  const unknown = data.checks.filter(check => check.score === null).length
  host.append(metrics([[data.score === null ? '—' : data.score.toFixed(1), 'Repository score'], [data.checks.length, 'Reported checks'], [unknown, 'Unavailable']]))
  host.append(notice('Captured ' + (data.date ? data.date.slice(0, 10) : 'at an unknown date') + '. This repository snapshot may differ from the selected ' + (node.version || 'module version') + '.'))
  const evidenceHost = element('div')
  if (!data.checks.length) evidenceHost.append(notice('The source supplied an aggregate score without individual checks.', 'analysis-empty'))
  else {
    const filters = element('div', undefined, 'analysis-filters'), search = element('input'), mode = element('select'), list = element('div'), count = notice('')
    search.type = 'search'; search.placeholder = 'Find a check…'; search.setAttribute('aria-label', 'Filter Scorecard checks')
    search.value = state.query || ''
    for (const [value, title] of [['all', 'All checks'], ['attention', 'Below 7/10'], ['unknown', 'Unavailable']]) mode.append(new Option(title, value))
    mode.setAttribute('aria-label', 'Scorecard check status'); filters.append(search, mode)
    mode.value = ['all', 'attention', 'unknown'].includes(state.status) ? state.status : 'all'
    count.setAttribute('role', 'status')
    state.checks ||= Object.create(null)
    const update = () => {
      state.query = search.value; state.status = mode.value
      const query = search.value.trim().toLowerCase()
      const checks = data.checks.filter(check => (!query || [check.name, check.reason, check.group].join(' ').toLowerCase().includes(query)) && (mode.value === 'all' || mode.value === 'unknown' && check.score === null || mode.value === 'attention' && check.score !== null && check.score < 7)).sort((a, b) => (a.score ?? 99) - (b.score ?? 99) || a.name.localeCompare(b.name))
      list.replaceChildren(); count.textContent = checks.length + ' of ' + data.checks.length + ' checks · lowest scores first'
      const checkItem = check => {
        const evidence = [notice(check.group + ' · ' + check.reason)]
        if (check.details.length) { const ul = element('ul'); check.details.forEach(value => ul.append(element('li', value))); evidence.push(ul) }
        if (check.documentation.shortDescription) evidence.push(notice(check.documentation.shortDescription))
        if (check.documentation.url) evidence.push(link('Check definition and remediation ↗', check.documentation.url))
        const item = disclosure(check.name, evidence, Boolean(state.checks[check.name]))
        item.addEventListener('toggle', () => { state.checks[check.name] = item.open })
        item.querySelector('summary').append(badge(check.score === null ? 'Unknown' : check.score + '/10', check.score === null ? '' : check.score < 5 ? 'bad' : check.score < 7 ? 'warning' : 'good'))
        return item
      }
      checks.forEach(check => list.append(checkItem(check)))
      if (!checks.length) list.append(notice('No checks match this filter.', 'analysis-empty'))
    }
    search.addEventListener('input', update); mode.addEventListener('change', update)
    evidenceHost.append(filters, count, list); update()
  }
  const provenance = element('div', undefined, 'analysis-provenance')
  provenance.append(element('div', 'Scorecard ' + (data.engine.version || 'version unavailable')))
  if (data.repository.name) provenance.append(element('div', 'Repository: ' + data.repository.name))
  if (data.repository.commit) provenance.append(element('div', 'Assessed commit: ' + data.repository.commit))
  provenance.append(element('div', 'Retrieved: ' + data.fetchedAt), link('View source report ↗', data.source))
  evidenceHost.append(provenance)
  host.append(notice('Select a module to inspect its repository report alongside the graph.'))
  inspect(evidenceHost)
}
/** @type {import('./types.js').BrowserLens} */
const lens = {
  selection: true,
  scope: 'Repository security practices',
  load: (_, options) => loadReport(options.node, options),
  render,
  status: data => data.error ? 'Lookup failed · refresh to retry' : data.missing ? 'Report unavailable' : 'Source: deps.dev · OpenSSF Scorecard',
}

export default lens
