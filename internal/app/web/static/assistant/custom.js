import { answerQuestion } from './queries.js'
import { licenseIDsIn, licenseQuery, matchesLicense } from './license-query.js'
import { publicIdentity, versionURL } from '../analysis/public-data.js'

// Repository links come from observed project mappings. A GitHub module-path
// fallback is explicitly marked as an inference, never a verified mapping.
/** @param {import('../analysis/types.js').GraphNode | null | undefined} node */
export function repositoryFor(node) {
  const project = node?.lenses?.openssf?.details?.projectId
  /** @param {unknown} value @returns {value is string} */
  const valid = (value) =>
    typeof value === 'string' &&
    /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[\w.-]+(?:\/[\w.-]+)+$/.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  if (valid(project)) return { url: 'https://' + project, project, inferred: false }
  const name = publicIdentity(node)?.name
  const match = name?.match(/^(github\.com\/[\w.-]+\/[\w.-]+)(?:\/|$)/)
  if (match && valid(match[1]))
    return { url: 'https://' + match[1], project: match[1], inferred: true }
  return null
}
// Match the named endpoint, including a bare module name in a path question.
const rootConnection =
  /\bhow\s+(?:(?:does|is)\s+)?(?:the\s+)?(?:module\s+)?[`'"]?([\w.@/+\-]+)[`'"]?\s+connect(?:s|ed)?\s+to\s+(?:the\s+)?root\b/i

/**
 * @param {string} question
 * @param {import('../../assistant-types').Context} context
 * @param {{selected: string}[]} [history]
 */
export function questionContext(question, context, history = []) {
  const text = question.toLowerCase()
  const full = context.graph.nodes
    .filter((node) => text.includes(node.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)
  if (full.length) return { ...context, selected: full[0].id }
  const pathTarget = text.match(rootConnection)?.[1]
  const aliases = context.graph.nodes.filter((node) => {
    const parts = node.name
      .replace(/\/v\d+$/, '')
      .toLowerCase()
      .split('/')
    const alias = parts.slice(-2).join('/')
    return (alias.includes('/') && text.includes(alias)) || parts.at(-1) === pathTarget
  })
  if (aliases.length === 1) return { ...context, selected: aliases[0].id }
  if (/\broot (module|project)|\bmain module/.test(text))
    return { ...context, selected: context.graph.rootId }
  const previous = history.at(-1)?.selected
  if (
    previous &&
    /\b(it|its|that module|that dependency|same module)\b/.test(text) &&
    context.graph.nodes.some((node) => node.id === previous)
  )
    return { ...context, selected: previous }
  return { ...context }
}
// This selects observations to retrieve, not a canned answer. Custom wording is
// passed intact to the model, together with recent questions and observations.
/** @param {string} question */
export function customTopics(question) {
  const text = question.toLowerCase(),
    topics = []
  if (/\blens(?:es)?\b/.test(text)) topics.push('lenses')
  if (/repo|github|gitlab|source code|hosted|codeberg|bitbucket/.test(text))
    topics.push('repository')
  if (/why|path|includ|connect/.test(text)) topics.push('paths')
  if (/vuln|advis|cve|osv|secur|risk|fix|attention|priorit/.test(text)) topics.push('advisories')
  if (/licen[cs]|copyright/.test(text) || licenseIDsIn(question).length) topics.push('licenses')
  if (/scorecard|repository checks|security practice|maintain/.test(text)) topics.push('scorecard')
  if (/update|upgrad|latest|older|outdat|behind|fresh|release/.test(text)) topics.push('updates')
  return topics.length ? topics : ['overview']
}
const truncationMarker = '… [truncated]'

/** @param {string} text @param {number} limit */
function excerpt(text, limit) {
  return text.length <= limit
    ? text
    : text.slice(0, limit - truncationMarker.length) + truncationMarker
}
/**
 * @param {string} question
 * @param {import('../../assistant-types').Context} context
 * @param {import('../../assistant-types').Evidence} [evidence]
 */
export function customPacket(question, context, evidence = {}) {
  const selected = context.graph.nodes.find((node) => node.id === context.selected)
  if (!selected) throw new Error('The selected module is not in the dependency graph.')
  const repository = repositoryFor(selected),
    topics = customTopics(question)
  // Supply only requested investigations: unrelated overview/path/version facts
  // distract small models. Repository identity is supplied separately below.
  const ids = licenseIDsIn(question),
    filter = licenseQuery(question)
  const reports = [...new Set(topics.filter((topic) => topic !== 'repository'))].map((topic) => {
    const report = answerQuestion(topic, context, evidence, { licenseQuery: filter })
    // A named license may occur well beyond the four-item prompt budget.
    if (topic === 'licenses' && ids.length && !filter)
      report.items.sort(
        (a, b) =>
          Number(
            matchesLicense(b.nodeID ? evidence.licenses?.records?.get(b.nodeID) : undefined, {
              ids,
              mode: 'any',
            }),
          ) -
          Number(
            matchesLicense(a.nodeID ? evidence.licenses?.records?.get(a.nodeID) : undefined, {
              ids,
              mode: 'any',
            }),
          ),
      )
    return report
  })
  /** @type {(import('../../assistant-types').EvidenceFact | import('../../assistant-types').RepositoryFact)[]} */
  const facts = reports.map((report, index) => ({
    id: 'E' + (index + 1),
    investigation: report.topic,
    statements: excerpt(report.paragraphs.join(' '), 700),
    findings: report.items
      .slice(0, report.topic === 'lenses' ? report.items.length : 4)
      .map((item) => ({ module: item.label, detail: excerpt(item.detail, 180) })),
    omittedFindings: report.topic === 'lenses' ? 0 : Math.max(0, report.items.length - 4),
    path: report.path?.slice(0, 8),
    omittedPathSteps: Math.max(0, (report.path?.length || 0) - 8),
    scope: excerpt(report.scope, 300),
    observedAt: report.observedAt,
  }))
  if (topics.includes('repository') || topics.includes('selected') || topics.includes('paths'))
    facts.unshift({
      id: 'R',
      module: selected.name,
      version: selected.version,
      repositoryURL: repository?.url || null,
      repositoryMapping: repository
        ? repository.inferred
          ? 'Inferred from the resolved GitHub module path; not independently verified.'
          : 'Source project mapping from the loaded module metadata.'
        : 'No repository mapping available. Do not invent a repository URL.',
    })
  const sources =
    repository && topics.includes('repository')
      ? [
          {
            label:
              repository.project +
              (repository.inferred ? ' · inferred from module path' : ' · source repository'),
            url: repository.url,
          },
        ]
      : []
  const identity = publicIdentity(selected)
  if (topics.includes('repository') && identity)
    sources.push({ label: 'Exact-version module metadata', url: versionURL(identity) })
  for (const report of reports)
    for (const source of report.sources)
      if (!sources.some((value) => value.url === source.url)) sources.push(source)
  const focused =
    reports.find((report) => report.topic === topics[0]) ||
    reports.find((report) => report.topic === 'selected')
  return {
    question,
    rootModule: context.graph.rootId,
    selectedModule: context.selected,
    facts,
    evidence: evidenceBlocks(facts),
    sources,
    actions: focused?.actions || [{ label: 'Show selected module', ids: [selected.id] }],
    topic: topics[0],
  }
}
/**
 * @param {{revision: number, question: string, answer?: string, selected: string}[]} turns
 * @param {number} revision
 */
export function recentHistory(turns, revision) {
  return turns
    .filter((turn) => turn.revision === revision && turn.answer)
    .slice(-2)
    .map((turn) => ({
      question: turn.question.slice(0, 400),
      selected: turn.selected,
    }))
}

/** @param {(import('../../assistant-types').EvidenceFact | import('../../assistant-types').RepositoryFact)[]} facts */
function evidenceBlocks(facts) {
  const blocks = []
  let remaining = 7000 - 2 // JSON array brackets
  for (const fact of facts) {
    const label =
      '[' + fact.id + '] ' + ('module' in fact ? 'Repository identity' : fact.investigation)
    const detail =
      'module' in fact
        ? `${fact.module}@${fact.version}. Source repository URL: ${fact.repositoryURL || 'unavailable'}. ${fact.repositoryMapping}`
        : [
            fact.statements,
            fact.path?.length ? 'Requirement path: ' + fact.path.join(' → ') : '',
            ...fact.findings.map((item) => item.module + ': ' + item.detail),
            fact.omittedFindings ? `${fact.omittedFindings} further findings omitted.` : '',
            fact.omittedPathSteps ? `${fact.omittedPathSteps} further path steps omitted.` : '',
            fact.scope,
          ]
            .filter(Boolean)
            .join('\n')
    // Include JSON quoting and reserve room for the final omission notice.
    const block = { label, detail }
    const overhead = JSON.stringify({ label, detail: '' }).length + 1
    const available = remaining - overhead - 80
    if (available < truncationMarker.length) break
    if (JSON.stringify(detail).length - 2 > available) {
      let budget = available - truncationMarker.length
      block.detail = ''
      for (const char of detail) {
        budget -= JSON.stringify(char).length - 2
        if (budget < 0) break
        block.detail += char
      }
      block.detail += truncationMarker
    }
    blocks.push(block)
    remaining -= JSON.stringify(block).length + 1
  }
  if (blocks.length < facts.length)
    blocks.push({
      label: 'Evidence limit',
      detail: `${facts.length - blocks.length} further observations omitted.`,
    })
  return blocks
}

// An explicit graph-path request has a verifiable answer. Keep its requirement
// edges rather than replacing them with a model's guess at package behavior.
/** @param {string} question */
export function customInvestigation(question) {
  const text = question.toLowerCase()
  if (
    /^\s*(?:(?:which|what)\s+(?:(?:analysis|available|supported)\s+)*lenses(?: (?:are )?(?:available|supported))?|(?:list|show)(?: me)?(?: all)?(?: the)?(?: available| supported| analysis)? lenses)\s*[?!.]*\s*$/.test(
      text,
    )
  )
    return 'lenses'
  if (/version|import|function|unused|source code/.test(text)) return null
  if (rootConnection.test(text)) return 'paths'
  return /\bwhy\b.*\b(included|required|dependency)\b|\bhow\b.*\bconnected\b|\brequirement path\b/.test(
    text,
  )
    ? 'paths'
    : null
}
