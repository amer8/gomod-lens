import { freshnessRecord } from '../analysis/freshness.js'
import { fixedVersions } from '../analysis/vulnerabilities.js'
import { publicIdentity } from '../analysis/public-data.js'
import { hasLicenseEvidence, licenseIDsIn, matchesLicense } from './license-query.js'

export function suggestionKey(topic, nodeID, filter) {
  return JSON.stringify([topic, ['paths', 'selected', 'scorecard'].includes(topic) ? nodeID : '', filter ? [filter.mode, ...filter.ids.map(id => id.toLowerCase()).sort()] : null])
}

export function evidenceGaps(graph, evidence = {}) {
  return graph.nodes.filter(node => freshnessRecord(node).status === 'unknown' ||
    node.lenses?.openssf?.status !== 'found' ||
    (evidence.vulnerabilities && !['matched', 'clear'].includes(evidence.vulnerabilities.records?.get(node.id)?.status)) ||
    (evidence.licenses && !hasLicenseEvidence(evidence.licenses.records?.get(node.id))))
}

// Rank answerable investigations, not dependency risk. Every candidate carries
// an explicit query, real graph node and optional exact license filter. Text
// never implies a successful lookup when observations are absent or failed.
export function suggestedQuestions(context, { topics, asked = [], after = '', evidence = {}, answer, history = [], ranked = [] }) {
  const { graph } = context, nodes = graph.nodes
  const selected = nodes.find(node => node.id === context.selected) || nodes[0]
  if (!selected) return []
  const candidates = [], records = evidence.vulnerabilities?.records, licenses = evidence.licenses?.records
  const matched = nodes.filter(node => records?.get(node.id)?.status === 'matched')
  const vulnerabilityUnknown = evidence.vulnerabilities ? nodes.filter(node => !['matched', 'clear'].includes(records?.get(node.id)?.status)) : []
  const behind = nodes.filter(node => ['patch_behind', 'minor_behind', 'major_behind'].includes(freshnessRecord(node).status))
  const directBehind = behind.filter(node => node.direct && !node.root)
  const majorBehind = behind.filter(node => freshnessRecord(node).status === 'major_behind')
  const observed = nodes.filter(node => hasLicenseEvidence(licenses?.get(node.id)))
  const multiple = observed.filter(node => new Set(licenses.get(node.id).expressions).size > 1)
  const licenseUnknown = evidence.licenses ? nodes.filter(node => !hasLicenseEvidence(licenses?.get(node.id))) : []
  const gaps = evidenceGaps(graph, evidence), report = evidence.openssf
  const checks = report && !report.error && !report.missing && Array.isArray(report.checks) ? report.checks : null
  const lowChecks = checks?.filter(check => check.score === null || (Number.isFinite(check.score) && check.score < 7)) || []
  const lensTopics = {
    vulnerabilities: ['advisories', 'introducers', 'fixes', 'reachability'],
    'release-freshness': ['updates', 'direct-updates', 'major-updates'],
    licenses: ['licenses', 'license-review', 'license-gaps'], openssf: ['scorecard', 'advisories'],
  }[context.lens] || []
  const nextTopics = {
    advisories: matched.length ? ['introducers', 'fixes', 'paths', 'reachability'] : ['unknown', 'updates', 'licenses', 'scorecard'],
    attention: matched.length ? ['introducers', 'fixes', 'paths'] : ['unknown', 'updates', 'licenses'],
    introducers: ['fixes', 'paths', 'reachability'], fixes: ['introducers', 'paths', 'reachability'],
    updates: ['direct-updates', 'major-updates', 'advisories'], 'direct-updates': ['major-updates', 'advisories', 'paths'],
    'major-updates': ['direct-updates', 'advisories', 'paths'],
    licenses: ['license-review', 'license-gaps', 'licenses'], 'license-review': ['license-gaps', 'licenses', 'paths'],
    'license-gaps': ['license-review', 'licenses', 'scorecard'],
    scorecard: ['advisories', 'direct-updates', 'unknown'], unknown: ['advisories', 'licenses', 'scorecard'],
    paths: ['selected', 'advisories', 'updates'], selected: ['paths', 'advisories', 'updates'],
    repository: ['scorecard', 'advisories', 'paths'], overview: ['direct-updates', 'advisories', 'licenses'],
    reachability: ['fixes', 'introducers', 'paths'], lenses: ['scorecard', 'advisories', 'licenses'],
  }[after] || []
  const add = (id, label, category, score, extra = {}) => {
    candidates.push({ id, label, category, score: score + (lensTopics.includes(id) ? 30 : 0) + (nextTopics.includes(id) ? 45 : 0), nodeID: selected.id, ...extra })
  }

  if (!records && !evidence.vulnerabilities?.error) add('advisories', 'Do any dependencies have known advisory matches?', 'security', 55)
  else if (matched.length) add('advisories', matched.length === 1 ? 'Which dependency has advisory matches?' : `Which ${matched.length} modules have advisory matches?`, 'security', 75)
  // Do not suggest another empty inventory after a successful all-clear lookup.
  if (matched.length) {
    const incoming = new Map()
    for (const edge of graph.edges) {
      if (!incoming.has(edge.target)) incoming.set(edge.target, [])
      incoming.get(edge.target).push(edge.source)
    }
    const ancestors = new Set(matched.map(node => node.id)), pending = [...ancestors]
    for (let index = 0; index < pending.length; index++) for (const source of incoming.get(pending[index]) || []) if (!ancestors.has(source)) { ancestors.add(source); pending.push(source) }
    if (nodes.some(node => node.direct && !node.root && ancestors.has(node.id))) add('introducers', 'Which direct dependencies bring in these advisory matches?', 'security', 78)
    const hasFix = matched.some(node => {
      const record = records.get(node.id), identity = record.identity || publicIdentity(node)
      return identity && (record.groups || record.advisories || []).some(advisory => fixedVersions(advisory, identity).length)
    })
    if (hasFix) add('fixes', 'Which advisory matches report fixed versions?', 'security', 82)
    add('reachability', 'How can I check whether affected code is reachable?', 'security', 40)
  }
  if (behind.length) add('updates', behind.length === 1 ? 'Which module has a newer observed release?' : `Which ${behind.length} modules have newer observed releases?`, 'releases', 60)
  if (directBehind.length) add('direct-updates', directBehind.length === 1 ? 'Which direct dependency has a newer release?' : `Which ${directBehind.length} direct dependencies have newer releases?`, 'releases', 76)
  if (majorBehind.length) add('major-updates', 'Which updates cross a major version?', 'releases', 72)
  if (!evidence.licenses?.error) add('licenses', licenses ? 'Which licenses appear across these dependencies?' : 'What license evidence is available for these dependencies?', 'licenses', 48)
  if (multiple.length) add('license-review', 'Which modules have multiple license expressions?', 'licenses', 77)
  if (licenseUnknown.length) add('license-gaps', `Which ${licenseUnknown.length === 1 ? 'module lacks' : licenseUnknown.length + ' modules lack'} license evidence?`, 'licenses', 80)
  const identifiers = new Map()
  for (const node of observed) {
    const record = licenses.get(node.id)
    for (const id of licenseIDsIn(record.expressions.join(' '))) if (matchesLicense(record, { ids: [id], mode: 'any' })) identifiers.set(id, (identifiers.get(id) || 0) + 1)
  }
  const rare = [...identifiers].filter(([id]) => !['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause'].includes(id.toLowerCase())).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]
  if (rare) add('licenses', `Which ${rare[1] === 1 ? 'dependency uses' : 'modules use'} ${rare[0]}?`, 'licenses', after === 'licenses' ? 95 : 44, { licenseQuery: { ids: [rare[0]], mode: 'any' } })
  if (checks && lowChecks.length) add('scorecard', `Which ${lowChecks.length === 1 ? 'repository check needs' : lowChecks.length + ' repository checks need'} a closer look?`, 'repository', 80)
  else if (!report) add('scorecard', `Does ${selected.name} have repository checks to review?`, 'repository', 50)
  if (gaps.length && (vulnerabilityUnknown.length || nodes.some(node => freshnessRecord(node).status === 'unknown' || node.lenses?.openssf?.status !== 'found'))) add('unknown', `Which ${gaps.length === 1 ? 'module has' : gaps.length + ' modules have'} incomplete observations?`, 'evidence', 58)

  // Trace a relevant dependency instead of asking for the root's path to itself.
  const reachable = new Set([graph.rootId]), queue = [graph.rootId], outgoing = new Map()
  for (const edge of graph.edges) { if (!outgoing.has(edge.source)) outgoing.set(edge.source, []); outgoing.get(edge.source).push(edge.target) }
  for (let index = 0; index < queue.length; index++) for (const target of outgoing.get(queue[index]) || []) if (!reachable.has(target)) { reachable.add(target); queue.push(target) }
  const related = ['advisories', 'attention', 'introducers', 'fixes'].includes(after) ? matched : ['updates', 'direct-updates', 'major-updates'].includes(after) ? [...directBehind, ...behind] : []
  const focus = [...related, selected.id !== graph.rootId ? selected : null, ...matched, ...directBehind, ...behind, ...nodes.filter(node => node.direct)].find(node => node && node.id !== graph.rootId && reachable.has(node.id))
  if (focus) add('paths', `How does ${focus.name} enter this dependency graph?`, 'structure', matched.some(node => node.id === focus.id) ? 73 : 42, { nodeID: focus.id })
  const inspect = selected.id !== graph.rootId ? selected : focus || selected
  add('selected', inspect.id === graph.rootId ? `What version of ${inspect.name} is loaded?` : `What do we know about ${inspect.name}?`, 'structure', inspect.id === graph.rootId ? 20 : 32, { nodeID: inspect.id })
  add('overview', 'Which direct dependencies anchor this graph?', 'structure', 30)
  add('lenses', 'Which analysis lenses are available?', 'help', 5)

  const completed = history.filter(turn => turn.answer && turn.topic)
  const seen = new Set(completed.map(turn => turn.suggestionKey || suggestionKey(turn.topic, turn.selected)))
  const currentKey = completed.at(-1)?.suggestionKey || suggestionKey(after, selected.id, answer?.licenseQuery)
  for (const candidate of candidates) {
    candidate.key = suggestionKey(candidate.id, candidate.nodeID, candidate.licenseQuery)
    candidate.seen = seen.has(candidate.key) || (!completed.length && asked.includes(candidate.id))
    const rank = ranked.indexOf(candidate.id)
    if (rank >= 0) candidate.score += (ranked.length - rank) / 100 // Tie-break only.
  }
  const sorted = candidates.filter(candidate => candidate.key !== currentKey).sort((a, b) => Number(a.seen) - Number(b.seen) || b.score - a.score || a.key.localeCompare(b.key))
  const result = [], ids = new Set(), categories = new Map()
  for (const candidate of sorted) {
    if (ids.has(candidate.id) || (categories.get(candidate.category) || 0) >= 2) continue
    // Prefer an unseen third investigation over repeating an old topic for diversity.
    if (candidate.seen && sorted.some(value => !value.seen && !ids.has(value.id))) continue
    result.push(candidate); ids.add(candidate.id); categories.set(candidate.category, (categories.get(candidate.category) || 0) + 1)
    if (result.length === 3) break
  }
  for (const candidate of sorted) {
    if (result.length === 3) break
    if (!ids.has(candidate.id)) { result.push(candidate); ids.add(candidate.id) }
  }
  return result.map(({ id, label, nodeID, licenseQuery, key }) => ({ id, label: label || topics[id], nodeID, ...(licenseQuery ? { licenseQuery } : {}), key }))
}
