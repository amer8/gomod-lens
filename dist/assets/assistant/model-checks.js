import { catalogInfo } from './model-catalog.js'

// Small, fixed fixtures exercise production planning and answering. Passing is
// evidence for these cases on this device, not a benchmark or a quality guarantee.
export const checkSuiteVersion = 1
export const checkCases = Object.freeze([
  { id: 'planning', label: 'License investigation planning', kind: 'plan',
    data: { question: 'What license evidence is available?', topics: { licenses: 'License evidence', paths: 'Dependency paths', releases: 'Newer releases', unknown: 'Missing observations' },
      nodes: [{ id: 'example.org/root' }], selected: 'example.org/root', asked: [] },
    accepts: value => value?.topic === 'licenses' && value.nodeID === 'example.org/root' },
  { id: 'repository', label: 'Exact repository URL', kind: 'answer',
    data: { question: "Where's the repository on GitHub?", evidence: 'The source repository URL is https://github.com/gin-gonic/gin.', history: [], thinking: false },
    accepts: value => typeof value === 'string' && value.includes('https://github.com/gin-gonic/gin') },
  { id: 'license', label: 'Exact ISC module lookup', kind: 'answer',
    data: { question: 'Which dependency has an ISC license?', evidence: 'Recorded license evidence: example.org/isc-lib: ISC. example.org/mit-lib: MIT. These are the only two modules.', history: [], thinking: false },
    accepts: value => typeof value === 'string' && value.includes('example.org/isc-lib') && !value.includes('example.org/mit-lib') && !/\b(none|no modules|no dependencies)\b/i.test(value) },
])
export function checkedReport(value, modelID) {
  if (value?.modelID !== modelID || value.runtimeVersion !== catalogInfo.version || value.suiteVersion !== checkSuiteVersion ||
    !Array.isArray(value.results) || value.results.length !== checkCases.length ||
    !checkCases.every(item => value.results.filter(result => result.id === item.id && typeof result.passed === 'boolean').length === 1)) {
    throw new Error('The model checks did not return a complete report.')
  }
  return { ...value, results: value.results.map(result => ({ id: result.id, passed: result.passed })) }
}
export function checkSummary(report) {
  if (!report) return { label: 'Not run', kind: 'unverified', rank: null, title: 'No gomod-lens model checks have run for this variant in this page session.' }
  if (report.state === 'running') return { label: 'Checking…', kind: 'running', rank: null, title: 'Running local inference on three fixed assistant fixtures.' }
  if (report.state === 'incomplete') return { label: 'Incomplete', kind: 'warning', rank: null, title: report.error || 'Checks did not complete.' }
  const count = report.results.filter(value => value.passed).length
  return { label: `${count}/${checkCases.length} passed`, kind: count === checkCases.length ? 'passed' : 'warning', rank: count,
    title: report.results.map(result => `${result.passed ? 'Pass' : 'Fail'}: ${checkCases.find(item => item.id === result.id).label}`).join('\n') + '\nFixed fixture checks in this browser session; not a general quality benchmark.' }
}
