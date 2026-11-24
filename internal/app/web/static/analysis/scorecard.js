import { publicIdentity, publicJSON, PublicHTTPError } from './public-data.js'
import { element, notice, badge, metrics, disclosure, link } from './ui.js'

/** @typedef {import('./types.js').GraphNode} GraphNode */
/**
 * @typedef {Object} ScorecardCheck
 * @property {string} name
 * @property {number | null} score
 * @property {string} reason
 * @property {string[]} details
 * @property {{shortDescription?: string, url?: string}} documentation
 * @property {string} group
 */
/**
 * @typedef {Object} MissingReport
 * @property {true} missing
 * @property {string} [source]
 * @property {string} [fetchedAt]
 * @property {ScorecardCheck[]} checks
 * @property {string} [message]
 */
/**
 * @typedef {Object} FoundReport
 * @property {false} [missing]
 * @property {string} source
 * @property {string} fetchedAt
 * @property {number | null} score
 * @property {string} date
 * @property {{name?: string, commit?: string}} repository
 * @property {{version?: string}} engine
 * @property {ScorecardCheck[]} checks
 */
/** @typedef {MissingReport | FoundReport} ScorecardReport */
/** @type {Record<string, string>} */
const groups = {
  'Branch-Protection': 'Change control',
  'Code-Review': 'Change control',
  'Dangerous-Workflow': 'CI/CD protection',
  'Token-Permissions': 'CI/CD protection',
  'Pinned-Dependencies': 'CI/CD protection',
  Webhooks: 'CI/CD protection',
  'CI-Tests': 'Security testing',
  SAST: 'Security testing',
  Fuzzing: 'Security testing',
  Packaging: 'Release integrity',
  'Signed-Releases': 'Release integrity',
  'Binary-Artifacts': 'Release integrity',
  SBOM: 'Release integrity',
  Maintained: 'Project maintenance',
  Contributors: 'Project maintenance',
  'CII-Best-Practices': 'Project maintenance',
  'Dependency-Update-Tool': 'Project hygiene',
  Vulnerabilities: 'Project hygiene',
  License: 'Project hygiene',
  'Security-Policy': 'Project hygiene',
}
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : '')

/**
 * @param {unknown} project
 * @param {string} source
 * @param {string} [fetchedAt]
 * @returns {ScorecardReport}
 */
export function normalizeReport(project, source, fetchedAt = new Date().toISOString()) {
  const report = object(project) ? project.scorecard : null
  if (!report) return { missing: true, source, fetchedAt, checks: [] }
  if (!object(report)) throw new Error('Invalid Scorecard report')
  /** @param {unknown} value */
  const score = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null
  const repository = object(report.repository) ? report.repository : {}
  const engine = object(report.scorecard) ? report.scorecard : {}
  const checks = Array.isArray(report.checks) ? /** @type {unknown[]} */ (report.checks) : []
  return {
    source,
    fetchedAt,
    score: score(report.overallScore),
    date: text(report.date),
    repository: { ...repository, name: text(repository.name), commit: text(repository.commit) },
    engine: { ...engine, version: text(engine.version) },
    checks: checks.map((check) => {
      if (!object(check)) throw new Error('Invalid Scorecard check')
      const documentation = object(check.documentation) ? check.documentation : {}
      const details = Array.isArray(check.details) ? /** @type {unknown[]} */ (check.details) : []
      const name = text(check.name) || 'Unnamed check'
      return {
        name,
        score: score(check.score),
        reason: text(check.reason) || 'No explanation supplied',
        details: details.filter((value) => typeof value === 'string'),
        documentation: {
          ...documentation,
          shortDescription: text(documentation.shortDescription),
          url: text(documentation.url),
        },
        group: groups[name] || 'Other checks',
      }
    }),
  }
}
/**
 * @param {GraphNode} node
 * @param {{signal?: AbortSignal, fetcher?: typeof fetch}} [options]
 * @returns {Promise<ScorecardReport>}
 */
export async function loadReport(node, { signal, fetcher } = {}) {
  const observation = node?.lenses?.openssf
  const project = observation?.details?.projectId
  if (!project) {
    if (observation?.status === 'error')
      throw new Error(observation.message || 'Scorecard lookup failed.')
    let message = 'No source repository mapping is available for this module.'
    switch (observation?.status) {
      case 'skipped':
        message = 'Scorecard lookup skipped. ' + (observation.message || '')
        break
      case 'no_scorecard':
        message = 'No published Scorecard report was found for this module.'
        break
      case 'unavailable':
        message = 'deps.dev has no metadata for this module version.'
        break
    }
    return { missing: true, checks: [], message }
  }
  const source = 'https://api.deps.dev/v3/projects/' + encodeURIComponent(project)
  try {
    return normalizeReport(await publicJSON(source, { signal, fetcher }), source)
  } catch (error) {
    if (error instanceof PublicHTTPError && error.status === 404)
      return { missing: true, source, checks: [] }
    throw error
  }
}
/** @param {import('./types.js').RenderContext<ScorecardReport>} context */
function render({ host, data, node, state = {} }) {
  if (node.replaced && node.replacement)
    host.append(notice('Resolved replacement: ' + node.replacement))
  if ('error' in data) {
    host.append(notice(data.error, 'analysis-empty'))
    return
  }
  if (data.missing) {
    host.append(
      notice(
        data.message || 'This repository has no published Scorecard report.',
        'analysis-empty',
      ),
    )
    return
  }
  const unknown = data.checks.filter((check) => check.score === null).length
  host.append(
    metrics([
      [data.score === null ? '—' : data.score.toFixed(1), 'Repository score'],
      [data.checks.length, 'Reported checks'],
      [unknown, 'Unavailable'],
    ]),
  )
  host.append(
    notice(
      'Captured ' +
        (data.date ? data.date.slice(0, 10) : 'at an unknown date') +
        '. This repository snapshot may differ from the selected ' +
        (node.lenses?.openssf?.details?.version ||
          publicIdentity(node)?.version ||
          'module version') +
        '.',
    ),
  )
  const evidenceHost = element('section', undefined, 'analysis-section')
  evidenceHost.setAttribute('aria-label', 'Repository checks')
  evidenceHost.append(element('h5', 'Repository checks'))
  if (!data.checks.length)
    evidenceHost.append(
      notice('The source supplied an aggregate score without individual checks.', 'analysis-empty'),
    )
  else {
    const filters = element('div', undefined, 'analysis-filters'),
      search = element('input'),
      mode = element('select'),
      list = element('div'),
      count = notice('')
    search.type = 'search'
    search.placeholder = 'Find a check…'
    search.setAttribute('aria-label', 'Filter Scorecard checks')
    search.value = state.query || ''
    for (const [value, title] of [
      ['all', 'All checks'],
      ['attention', 'Below 7/10'],
      ['unknown', 'Unavailable'],
    ])
      mode.append(new Option(title, value))
    mode.setAttribute('aria-label', 'Scorecard check status')
    filters.append(search, mode)
    mode.value = ['all', 'attention', 'unknown'].includes(state.status) ? state.status : 'all'
    count.setAttribute('role', 'status')
    state.checks ||= Object.create(null)
    const update = () => {
      state.query = search.value
      state.status = mode.value
      const query = search.value.trim().toLowerCase()
      const checks = data.checks
        .filter(
          (check) =>
            (!query ||
              [check.name, check.reason, check.group].join(' ').toLowerCase().includes(query)) &&
            (mode.value === 'all' ||
              (mode.value === 'unknown' && check.score === null) ||
              (mode.value === 'attention' && check.score !== null && check.score < 7)),
        )
        .sort((a, b) => (a.score ?? 99) - (b.score ?? 99) || a.name.localeCompare(b.name))
      list.replaceChildren()
      count.textContent =
        checks.length + ' of ' + data.checks.length + ' checks · lowest scores first'
      /** @param {ScorecardCheck} check */
      const checkItem = (check) => {
        /** @type {HTMLElement[]} */
        const evidence = [notice(check.group + ' · ' + check.reason)]
        if (check.details.length) {
          const ul = element('ul')
          check.details.forEach((value) => ul.append(element('li', value)))
          evidence.push(ul)
        }
        if (check.documentation.shortDescription)
          evidence.push(notice(check.documentation.shortDescription))
        if (check.documentation.url)
          evidence.push(link('Check definition and remediation ↗', check.documentation.url))
        const item = disclosure(check.name, evidence, Boolean(state.checks[check.name]))
        item.addEventListener('toggle', () => {
          state.checks[check.name] = item.open
        })
        item
          .querySelector('summary')
          ?.append(
            badge(
              check.score === null ? 'Unknown' : check.score + '/10',
              check.score === null
                ? ''
                : check.score < 5
                  ? 'bad'
                  : check.score < 7
                    ? 'warning'
                    : 'good',
            ),
          )
        return item
      }
      checks.forEach((check) => list.append(checkItem(check)))
      if (!checks.length) list.append(notice('No checks match this filter.', 'analysis-empty'))
    }
    search.addEventListener('input', update)
    mode.addEventListener('change', update)
    evidenceHost.append(filters, count, list)
    update()
  }
  const provenance = element('div', undefined, 'analysis-provenance')
  provenance.append(element('div', 'Scorecard ' + (data.engine.version || 'version unavailable')))
  if (data.repository.name) provenance.append(element('div', 'Repository: ' + data.repository.name))
  if (data.repository.commit)
    provenance.append(element('div', 'Assessed commit: ' + data.repository.commit))
  provenance.append(
    element('div', 'Retrieved: ' + data.fetchedAt),
    link('View source report ↗', data.source),
  )
  provenance.append(
    link('Scorecard data: CDLA-Permissive-2.0 ↗', 'https://cdla.dev/permissive-2-0/'),
  )
  evidenceHost.append(provenance)
  host.append(evidenceHost)
}
/** @type {import('./types.js').BrowserLens<ScorecardReport>} */
const lens = {
  selection: true,
  scope: 'Repository security practices',
  load: (_, options) => loadReport(options.node, options),
  render,
  status: (data) =>
    'error' in data
      ? 'Lookup failed · refresh to retry'
      : data.missing
        ? 'Report unavailable'
        : 'Source: deps.dev · OpenSSF Scorecard',
}

export default lens
