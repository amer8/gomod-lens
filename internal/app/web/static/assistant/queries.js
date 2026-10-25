import { suggestedQuestions, evidenceGaps } from './suggestions.js'
export { suggestionKey } from './suggestions.js'
import { browserLenses } from '../analysis/registry.js'
import { freshnessRecord } from '../analysis/freshness.js'
import { publicIdentity } from '../analysis/public-data.js'
import { hasLicenseEvidence, matchesLicense } from './license-query.js'
import { fixedVersions } from '../analysis/vulnerabilities.js'
import { outgoingIndex, shortestPath as findPath, reachableIDs as reachable } from '../graph-traversal.js'

// Queries and follow-ups are an allowlist. Neither natural language nor model
// output can execute code, invent graph actions, or change a module version.
export const topics = {
  attention: 'Which dependencies deserve attention first?',
  advisories: 'Which modules have known advisory matches?',
  introducers: 'Which direct dependencies introduce advisory matches?',
  updates: 'Which modules are behind an observed release?',
  'direct-updates': 'Which direct dependencies have newer observed releases?',
  'major-updates': 'Which updates cross a major version?',
  unknown: 'Where are we missing evidence?',
  paths: 'How is the selected module connected to the root?',
  selected: 'What do we know about the selected module?',
  licenses: 'What license evidence is available?',
  'license-review': 'Which modules have multiple license expressions?',
  'license-gaps': 'Which modules lack usable license evidence?',
  scorecard: 'Which repository checks need investigation?',
  fixes: 'Which advisories mention fixed versions?',
  reachability: 'Can this graph establish vulnerability reachability?',
  overview: 'How is this dependency graph structured?',
  lenses: 'Which analysis lenses are available?',
}
export const topicIDs = Object.keys(topics)
export function questionLabel(topic, context) {
  const node = context.graph?.nodes.find(n => n.id === context.selected)
  if (node && node.id !== context.graph.rootId) {
    if (topic === 'paths') return `Why is ${node.name} included?`
    if (topic === 'selected') return `What do we know about ${node.name}?`
  }
  return topics[topic]
}
export function suggestions(context, asked = [], after = '', options = {}) {
  return suggestedQuestions(context, { ...options, topics, asked, after })
}
export function validatePlan(value, graph) {
  if (!value || !topicIDs.includes(value.topic)) throw new Error('Local AI could not map this question to a supported investigation.')
  if (value.nodeID && !graph.nodes.some(node => node.id === value.nodeID)) throw new Error('Local AI referenced a module outside this graph.')
  return { topic: value.topic, nodeID: value.nodeID || graph.rootId }
}
export function shortestPath(graph, target) {
  const nodes = new Set(graph.nodes.map(node => node.id))
  if (!nodes.has(target) || !nodes.has(graph.rootId)) return []
  const outgoing = outgoingIndex(graph.edges.filter(edge => nodes.has(edge.source) && nodes.has(edge.target)))
  return findPath(outgoing, graph.rootId, target)
}
export function reachableIDs(graph, start) {
  return reachable(outgoingIndex(graph.edges), start)
}
export function requiredEvidence(topic) {
  if (['attention', 'advisories', 'introducers', 'fixes'].includes(topic)) return ['vulnerabilities']
  if (['licenses', 'license-review', 'license-gaps'].includes(topic)) return ['licenses']
  if (topic === 'scorecard') return ['openssf']
  return []
}
const isBehind = node => ['patch_behind', 'minor_behind', 'major_behind'].includes(freshnessRecord(node).status)
const sourceLink = (label, url) => ({ label, url })

/** Produce factual answer blocks and explicit graph actions from observations.
 * Missing and failed observations never count as successful empty lookups. */
export function answerQuestion(topic, context, evidence = {}, { licenseQuery = null } = {}) {
  const { graph } = context, selected = graph.nodes.find(node => node.id === context.selected) || graph.nodes[0]
  const records = evidence.vulnerabilities?.records
  const matches = graph.nodes.filter(node => records?.get(node.id)?.status === 'matched')
  const unknowns = graph.nodes.filter(node => !['matched', 'clear'].includes(records?.get(node.id)?.status))
  const result = { title: topics[topic] || 'Ask about this graph', paragraphs: [], items: [], sources: [], actions: [], scope: '', observedAt: '', topic }
  const item = (node, detail) => ({ nodeID: node.id, label: node.name, detail })
  const show = (label, ids, lens) => { if (ids.length) result.actions.push({ label, ids, lens }) }
  const useAdvisories = () => {
    result.sources.push(sourceLink('OSV · exact-version observations', 'https://osv.dev/'))
    result.observedAt = evidence.vulnerabilities?.capturedAt || ''
    result.scope = 'Module advisory matches do not establish function reachability or exploitability.'
    if (evidence.vulnerabilities?.error) result.paragraphs.push('The advisory lookup failed: ' + evidence.vulnerabilities.error)
  }
  if (topic === 'lenses') {
    result.title = 'Available analysis lenses'
    result.paragraphs.push(`${browserLenses.length} analysis lenses are available:`)
    result.items = browserLenses.map(lens => ({ label: lens.label, detail: lens.description || lens.title }))
  } else if (topic === 'paths') {
    const path = shortestPath(graph, selected.id)
    result.title = 'Connection to ' + selected.name
    result.paragraphs.push(selected.id === graph.rootId ? 'This is the root module of the loaded graph. Select a dependency to investigate its requirement path.' : path.length ? 'One shortest requirement path in the loaded module graph:' : 'No requirement path from the root is recorded for this selected module.')
    result.path = path
    result.scope = 'Requirement edges are not package imports or function calls. The graph does not retain every go.mod constraint needed to explain version selection.'
    show('Highlight this path', path)
  } else if (topic === 'selected') {
    const identity = publicIdentity(selected), freshness = freshnessRecord(selected)
    result.title = selected.name
    result.paragraphs.push(`Loaded version: ${selected.version || 'unavailable'}. ${selected.root ? 'Root module.' : selected.direct ? 'Marked as a direct dependency.' : 'Not marked as a direct dependency.'}`)
    if (selected.replaced) result.paragraphs.push('Replacement: ' + (selected.replacement || 'identity unavailable') + '. External observations use the resolved identity when available.')
    result.paragraphs.push(freshness.latest ? `Latest observed for ${freshness.module}: ${freshness.latest}. Release state: ${freshness.status.replaceAll('_', ' ')}.` : 'No comparable latest-release observation is available.')
    if (identity) result.sources.push(sourceLink('Exact-version module metadata', 'https://api.deps.dev/v3/systems/GO/packages/' + encodeURIComponent(identity.name) + '/versions/' + encodeURIComponent(identity.version)))
    show('Show selected module', [selected.id])
  } else if (['updates', 'direct-updates', 'major-updates'].includes(topic)) {
    const candidates = topic === 'direct-updates' ? graph.nodes.filter(node => node.direct && !node.root) : graph.nodes
    const behind = candidates.filter(node => isBehind(node) && (topic !== 'major-updates' || freshnessRecord(node).status === 'major_behind'))
    const unknown = candidates.filter(node => freshnessRecord(node).status === 'unknown')
    result.paragraphs.push(topic === 'major-updates' ? `${behind.length} modules have an observed major-version release gap. ${unknown.length} modules have unknown release status.` : `${behind.length} of ${candidates.length} ${topic === 'direct-updates' ? 'direct dependencies' : 'modules'} are behind an observed release. ${unknown.length} have unknown release status.`)
    result.items = behind.map(node => { const record = freshnessRecord(node); return item(node, `${record.version} → ${record.latest} · ${record.status.replaceAll('_', ' ')}${record.module !== node.name ? ' · replacement: ' + record.module : ''}`) })
    result.scope = 'Release differences do not establish security risk or upgrade compatibility. These observations come from the loaded graph and may be cached.'
    result.sources.push(sourceLink('Go module mirror', 'https://proxy.golang.org/'))
    show('Show release queue', behind.map(node => node.id), 'release-freshness')
  } else if (['advisories', 'attention'].includes(topic)) {
    useAdvisories()
    result.paragraphs.push(`${matches.length} module${matches.length === 1 ? ' has' : 's have'} observed advisory matches; ${unknowns.length} remain unknown. ${graph.nodes.length - matches.length - unknowns.length} returned no matches for their resolved versions.`)
    result.items = matches.map(node => item(node, `${records.get(node.id).groups?.length || records.get(node.id).advisories?.length || 0} advisory groups · resolved ${records.get(node.id).identity?.name || node.name}@${records.get(node.id).identity?.version || node.version}`))
    if (topic === 'attention') {
      result.paragraphs.push('Investigate advisory matches first, then missing evidence. Release gaps are a separate maintenance signal, not a numerical risk score.')
      const behind = graph.nodes.filter(isBehind); result.paragraphs.push(`${behind.length} modules also have an observed release gap.`)
    }
    show('Highlight advisory matches', matches.map(node => node.id), 'vulnerabilities')
    show('Inspect unknown results', unknowns.map(node => node.id), 'vulnerabilities')
  } else if (topic === 'introducers') {
    useAdvisories()
    for (const direct of graph.nodes.filter(node => node.direct && !node.root)) {
      const reachable = reachableIDs(graph, direct.id), introduced = matches.filter(node => reachable.has(node.id))
      if (introduced.length) result.items.push(item(direct, `${introduced.length} matched module${introduced.length === 1 ? '' : 's'} downstream: ${introduced.map(node => node.name).join(', ')}`))
    }
    result.paragraphs.push(`${result.items.length} direct dependencies have a recorded path to advisory-matched modules. Shared modules may appear under more than one dependency.`)
    if (unknowns.length) result.paragraphs.push(`${unknowns.length} unknown module observations are not included as matches.`)
    if (matches.length && !result.items.length) result.paragraphs.push('Matches exist, but no path from a module marked direct is recorded. Inspect the matches themselves; this is not proof of absence.')
    show('Inspect advisory matches', matches.map(node => node.id), 'vulnerabilities')
  } else if (topic === 'fixes') {
    useAdvisories()
    const seen = new Set()
    for (const node of matches) {
      const record = records.get(node.id)
      for (const advisory of record.groups || record.advisories || []) {
        const identity = record.identity || publicIdentity(node)
        const fixed = identity ? fixedVersions(advisory, identity) : []
        result.items.push(item(node, `${advisory.id}: ${fixed.length ? 'fixed-version events ' + fixed.join(', ') : 'no fixed-version event supplied'}`))
        if (!seen.has(advisory.id)) { seen.add(advisory.id); result.sources.push(sourceLink(advisory.id, 'https://osv.dev/vulnerability/' + encodeURIComponent(advisory.id))) }
      }
    }
    result.paragraphs.push('These are advisory range events for the resolved module identity. A listed event is not automatically a suitable upgrade target; review the affected ranges and compatibility.')
    if (!matches.length) result.paragraphs.push('No successfully observed matches are available to inspect.' )
    show('Inspect affected versions', matches.map(node => node.id), 'vulnerabilities')
  } else if (['license-review', 'license-gaps'].includes(topic)) {
    const records = evidence.licenses?.records
    const unknown = graph.nodes.filter(node => !hasLicenseEvidence(records?.get(node.id)))
    const matching = topic === 'license-gaps' ? unknown : graph.nodes.filter(node => hasLicenseEvidence(records?.get(node.id)) && new Set(records.get(node.id).expressions).size > 1)
    result.paragraphs.push(topic === 'license-gaps' ? `${matching.length} modules lack usable license evidence.` : `${matching.length} modules have multiple recorded license expressions; ${unknown.length} modules have unknown license evidence.`)
    if (evidence.licenses?.error) result.paragraphs.push('The license lookup failed: ' + evidence.licenses.error)
    result.items = matching.map(node => item(node, topic === 'license-gaps' ? 'No usable license expression was returned.' : records.get(node.id).expressions.join(' · ')))
    result.scope = 'Multiple expressions have an unspecified relationship. Missing license evidence is not proof that a module has no license.'
    result.sources.push(sourceLink('deps.dev · license metadata', 'https://deps.dev/'))
    result.observedAt = evidence.licenses?.capturedAt || ''
    show(topic === 'license-gaps' ? 'Highlight license gaps' : 'Highlight multiple expressions', matching.map(node => node.id), 'licenses')
  } else if (topic === 'licenses') {
    const licenses = evidence.licenses?.records
    const unknown = graph.nodes.filter(node => !hasLicenseEvidence(licenses?.get(node.id)))
    result.paragraphs.push(`${graph.nodes.length - unknown.length} module${graph.nodes.length - unknown.length === 1 ? ' has' : 's have'} recorded license expressions; ${unknown.length} remain unknown.`)
    if (evidence.licenses?.error) result.paragraphs.push('The license lookup failed: ' + evidence.licenses.error)
    const observed = graph.nodes.filter(node => hasLicenseEvidence(licenses?.get(node.id)))
    const filtered = licenseQuery ? observed.filter(node => matchesLicense(licenses.get(node.id), licenseQuery)) : observed
    result.items = filtered.map(node => {
      const record = licenses.get(node.id), identity = record.identity
      const replacement = identity && (identity.name !== node.name || identity.version !== node.version) ? ` · resolved ${identity.name}@${identity.version}` : ''
      return item(node, record.expressions.join(' · ') + replacement)
    })
    if (licenseQuery) {
      result.licenseQuery = licenseQuery
      const label = licenseQuery.ids.join(licenseQuery.mode === 'all' ? ' and ' : ' or ')
      result.paragraphs = [`${filtered.length} module${filtered.length === 1 ? ' has' : 's have'} recorded license expressions containing ${label}. Checked ${observed.length} of ${graph.nodes.length} modules; ${unknown.length} remain unknown.`]
      if (evidence.licenses?.error) result.paragraphs.push('The license lookup failed: ' + evidence.licenses.error)
      if (!filtered.length) result.paragraphs.push(unknown.length ? 'No matches in the available observations. Unknown results cannot establish absence.' : 'No matching identifier was found in the recorded expressions.')
      if (licenseQuery.mode === 'all' && licenseQuery.ids.length > 1) result.paragraphs.push('Each matching module records all requested identifiers; this does not establish that their license terms apply together.')
      show('Highlight license matches', filtered.map(node => node.id), 'licenses')
    }
    result.licenseSummary = { known: observed.length, multiple: observed.filter(node => new Set(licenses.get(node.id).expressions).size > 1).length, total: graph.nodes.length, unknown: unknown.length, filter: licenseQuery ? licenseQuery.ids.join(licenseQuery.mode === 'all' ? ' and ' : ' or ') : null }
    if (!licenseQuery) {
      const groups = new Map()
      for (const node of observed) for (const expression of new Set(licenses.get(node.id).expressions)) {
        if (!groups.has(expression)) groups.set(expression, { label: expression, ids: [] })
        groups.get(expression).ids.push(node.id)
      }
      result.licenseGroups = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || a.label.localeCompare(b.label))
    }
    result.scope = 'Multiple expressions have an unspecified relationship. Metadata does not establish license compatibility, approval, or file-level completeness.'
    result.observedAt = evidence.licenses?.capturedAt || ''
    result.sources.push(sourceLink('deps.dev · license metadata', 'https://deps.dev/'))
    if (licenseQuery) for (const node of filtered) {
      const record = licenses.get(node.id)
      if (record.source) result.sources.push(sourceLink(node.name + ' · license evidence', record.source))
    }
    show('Open license inventory', graph.nodes.map(node => node.id), 'licenses')
  } else if (topic === 'scorecard') {
    const report = evidence.openssf
    result.title = 'Repository practices · ' + selected.name
    result.paragraphs.push(report?.error || report?.message || (report?.missing || !report ? 'No individual repository report is available for the selected module.' : `${report.checks.length} reported checks. The report assesses a repository snapshot, not this module version.`))
    if (report?.checks) result.items = report.checks.filter(check => check.score === null || check.score < 7).map(check => ({ label: check.name, detail: `${check.score === null ? 'Unknown' : check.score + '/10'} · ${check.reason}` }))
    if (report && !report.error && !report.missing && report.checks?.length && !result.items.length) result.paragraphs.push('No reported check is below 7/10 or unknown.')
    if (report?.source) result.sources.push(sourceLink('Repository report · deps.dev', report.source))
    result.observedAt = report?.fetchedAt || ''
    result.scope = report?.date ? 'Assessed snapshot: ' + report.date + '. Missing check results remain unknown.' : 'A repository score is not a security verdict for a released module.'
    show('Open repository checks', [selected.id], 'openssf')
  } else if (topic === 'unknown') {
    const releaseUnknown = graph.nodes.filter(node => freshnessRecord(node).status === 'unknown')
    const scoreUnknown = graph.nodes.filter(node => (node.lenses?.openssf?.status || node.openssf?.status) !== 'found')
    result.paragraphs.push(`Loaded graph: ${releaseUnknown.length} modules have unknown release status; ${scoreUnknown.length} lack a found repository Scorecard observation.`)
    for (const [key, label, known] of [['vulnerabilities', 'Advisories', ['matched', 'clear']], ['licenses', 'Licenses', ['observed', 'nonstandard']]]) {
      const observed = evidence[key]?.records
      const missing = graph.nodes.filter(node => key === 'licenses' ? !hasLicenseEvidence(observed?.get(node.id)) : !known.includes(observed?.get(node.id)?.status))
      result.paragraphs.push(evidence[key] ? `${label}: ${missing.length} module observations remain unknown.${evidence[key].error ? ' Lookup failed: ' + evidence[key].error : ''}` : `${label}: not loaded for this conversation yet. No conclusion can be drawn from missing observations.`)
    }
    result.items = evidenceGaps(graph, evidence).map(node => item(node, 'One or more loaded observations are unavailable.'))
    result.scope = 'Unknown, failed, skipped, and not-yet-loaded observations do not mean a successful check.'
    show('Highlight evidence gaps', result.items.map(value => value.nodeID))
  } else if (topic === 'reachability') {
    result.paragraphs.push('This graph records module requirements and exact-version advisory matches, not package imports or function calls. It cannot establish whether vulnerable code is reachable or exploitable in your application.')
    result.paragraphs.push('A source-based govulncheck run in your project can investigate calls to affected functions. Local source analysis is not currently exposed by this web app.')
    result.sources.push(sourceLink('Go vulnerability analysis', 'https://go.dev/doc/security/vuln/'))
  } else if (topic === 'overview') {
    const direct = graph.nodes.filter(node => node.direct && !node.root)
    result.paragraphs.push(`${graph.nodes.length} modules and ${graph.edges.length} requirement edges are recorded. ${direct.length} modules are marked direct dependencies.`)
    result.items = [...direct].sort((a, b) => (b.outDegree || 0) - (a.outDegree || 0)).map(node => item(node, `${node.outDegree || 0} outgoing requirement edges`))
    result.scope = 'Module count is not binary size, runtime cost, or the number of packages used by your program.'
    show('Highlight direct dependencies', direct.map(node => node.id))
  } else {
    result.paragraphs.push('I can investigate the loaded dependency graph, advisory observations, release gaps, repository checks, and license evidence. Choose a suggested question, name a module, or rephrase your question.')
    result.scope = 'Upgrade simulation, local source analysis, and automatic code changes are not available in this chat.'
  }
  return result
}
