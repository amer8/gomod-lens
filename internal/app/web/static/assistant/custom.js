import { answerQuestion } from './queries.js'
import { licenseIDsIn, licenseQuery, matchesLicense } from './license-query.js'
import { publicIdentity, versionURL } from '../analysis/public-data.js'

// Repository links come from observed project mappings. A GitHub module-path
// fallback is explicitly marked as an inference, never a verified mapping.
export function repositoryFor(node) {
  const project = node?.lenses?.openssf?.details?.projectId
  const valid = value => typeof value === 'string' && /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[\w.-]+(?:\/[\w.-]+)+$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..')
  if (valid(project)) return { url: 'https://' + project, project, inferred: false }
  const name = publicIdentity(node)?.name
  const match = name?.match(/^(github\.com\/[\w.-]+\/[\w.-]+)(?:\/|$)/)
  if (match && valid(match[1])) return { url: 'https://' + match[1], project: match[1], inferred: true }
  return null
}
export function questionContext(question, context, history = []) {
  const text = question.toLowerCase()
  const full = context.graph.nodes.filter(node => text.includes(node.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)
  if (full.length) return { ...context, selected: full[0].id }
  const aliases = context.graph.nodes.filter(node => {
    const parts = node.name.replace(/\/v\d+$/, '').toLowerCase().split('/')
    const alias = parts.slice(-2).join('/')
    return alias.includes('/') && text.includes(alias)
  })
  if (aliases.length === 1) return { ...context, selected: aliases[0].id }
  if (/\broot (module|project)|\bmain module/.test(text)) return { ...context, selected: context.graph.rootId }
  const previous = history.at(-1)?.selected
  if (previous && /\b(it|its|that module|that dependency|same module)\b/.test(text) && context.graph.nodes.some(node => node.id === previous)) return { ...context, selected: previous }
  return { ...context }
}
// This selects observations to retrieve, not a canned answer. Custom wording is
// passed intact to the model, together with conversation history and facts.
export function customTopics(question) {
  const text = question.toLowerCase(), topics = []
  if (/\blens(?:es)?\b/.test(text)) topics.push('lenses')
  if (/repo|github|gitlab|source code|hosted|codeberg|bitbucket/.test(text)) topics.push('repository')
  if (/why|path|includ|connect/.test(text)) topics.push('paths')
  if (/vuln|advis|cve|osv|secur|risk|fix|attention|priorit/.test(text)) topics.push('advisories')
  if (/licen[cs]|copyright/.test(text) || licenseIDsIn(question).length) topics.push('licenses')
  if (/scorecard|repository checks|security practice|maintain/.test(text)) topics.push('scorecard')
  if (/update|upgrad|latest|older|outdat|behind|fresh|release/.test(text)) topics.push('updates')
  return topics.length ? topics : ['overview']
}
export function customPacket(question, context, evidence = {}) {
  const selected = context.graph.nodes.find(node => node.id === context.selected)
  const repository = repositoryFor(selected), topics = customTopics(question)
  // Supply only requested investigations: unrelated overview/path/version facts
  // distract small models. Repository identity is supplied separately below.
  const ids = licenseIDsIn(question), filter = licenseQuery(question)
  const reports = [...new Set(topics.filter(topic => topic !== 'repository'))].map(topic => {
    const report = answerQuestion(topic, context, evidence, { licenseQuery: filter })
    // A named license may occur well beyond the four-item prompt budget.
    if (topic === 'licenses' && ids.length && !filter) report.items.sort((a, b) => Number(matchesLicense(evidence.licenses?.records?.get(b.nodeID), { ids, mode: 'any' })) - Number(matchesLicense(evidence.licenses?.records?.get(a.nodeID), { ids, mode: 'any' })))
    return report
  })
  const facts = reports.map((report, index) => ({
    id: 'E' + (index + 1), investigation: report.topic,
    statements: report.paragraphs.join(' ').slice(0, 700),
    findings: report.items.slice(0, report.topic === 'lenses' ? report.items.length : 4).map(item => ({ module: item.label, detail: item.detail.slice(0, 180) })),
    omittedFindings: report.topic === 'lenses' ? 0 : Math.max(0, report.items.length - 4),
    path: report.path?.slice(0, 8), omittedPathSteps: Math.max(0, (report.path?.length || 0) - 8),
    scope: report.scope.slice(0, 300), observedAt: report.observedAt,
  }))
  if (topics.includes('repository') || topics.includes('selected') || topics.includes('paths')) facts.unshift({ id: 'R', module: selected.name, version: selected.version, repositoryURL: repository?.url || null, repositoryMapping: repository ? repository.inferred ? 'Inferred from the resolved GitHub module path; not independently verified.' : 'Source project mapping from the loaded module metadata.' : 'No repository mapping available. Do not invent a repository URL.' })
  const sources = repository && topics.includes('repository') ? [{ label: repository.project + (repository.inferred ? ' · inferred from module path' : ' · source repository'), url: repository.url }] : []
  const identity = publicIdentity(selected)
  if (topics.includes('repository') && identity) sources.push({ label: 'Exact-version module metadata', url: versionURL(identity) })
  for (const report of reports) for (const source of report.sources) if (!sources.some(value => value.url === source.url)) sources.push(source)
  const focused = reports.find(report => report.topic === topics[0]) || reports.find(report => report.topic === 'selected')
  return { question, rootModule: context.graph.rootId, selectedModule: context.selected, facts, sources, actions: focused?.actions || [{ label: 'Show selected module', ids: [selected.id] }], topic: topics[0] }
}
export function recentHistory(turns, revision) {
  return turns.filter(turn => turn.revision === revision && turn.answer).slice(-2).map(turn => ({ question: turn.question.slice(0, 400), answer: turn.answer.slice(0, 600), selected: turn.selected }))
}

export function evidenceText(facts) {
  return facts.map(fact => {
    if (fact.id === 'R') return `[R] Module: ${fact.module}@${fact.version}. Source repository URL: ${fact.repositoryURL || 'unavailable'}. ${fact.repositoryMapping}`
    return [`[${fact.id}] ${fact.investigation}: ${fact.statements}`, fact.path?.length ? 'Requirement path: ' + fact.path.join(' → ') : '', ...(fact.findings || []).map(item => item.module + ': ' + item.detail), fact.omittedFindings ? `${fact.omittedFindings} further findings omitted; use the stated totals.` : '', fact.omittedPathSteps ? `${fact.omittedPathSteps} further path steps omitted.` : '', fact.scope].filter(Boolean).join('\n')
  }).join('\n\n').slice(0, 7000)
}

// An explicit graph-path request has a verifiable answer. Keep its requirement
// edges rather than replacing them with a model's guess at package behavior.
export function customInvestigation(question) {
  const text = question.toLowerCase()
  if (/^\s*(?:(?:which|what)\s+(?:(?:analysis|available|supported)\s+)*lenses(?: (?:are )?(?:available|supported))?|(?:list|show)(?: me)?(?: all)?(?: the)?(?: available| supported| analysis)? lenses)\s*[?!.]*\s*$/.test(text)) return 'lenses'
  if (/version|import|function|unused|source code/.test(text)) return null
  return /\bwhy\b.*\b(included|required|dependency)\b|\bhow\b.*\bconnected\b|\brequirement path\b/.test(text) ? 'paths' : null
}
