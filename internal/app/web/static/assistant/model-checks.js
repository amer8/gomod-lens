import { catalogInfo } from './model-catalog.js'
import { topics } from './topics.js'

/** @typedef {{id: string, passed: boolean}} CheckResult */
/** @typedef {{modelID: string, runtimeVersion: string, suiteVersion: number, results: CheckResult[]}} CheckedReport */
/** @typedef {CheckedReport | {state: 'running'} | {state: 'incomplete', error?: string}} SummaryReport */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Small, fixed fixtures exercise production planning and answering. Passing is
// evidence for these cases on this device, not a benchmark or a quality guarantee.
export const checkSuiteVersion = 2
/** @typedef {{id: string, label: string, accepts: (value: unknown) => boolean}} BaseCheck */
/** @typedef {BaseCheck & {kind: 'plan', data: import('./worker.js').PlanningData}} PlanningCheck */
/** @typedef {BaseCheck & {kind: 'answer', data: import('./worker.js').AnswerData}} AnswerCheck */
/** @type {readonly (PlanningCheck | AnswerCheck)[]} */
export const checkCases = Object.freeze([
  {
    id: 'planning',
    label: 'License investigation planning',
    kind: 'plan',
    data: {
      question: 'What license evidence is available?',
      topics: {
        licenses: 'License evidence',
        paths: 'Dependency paths',
        releases: 'Newer releases',
        unknown: 'Missing observations',
      },
      nodes: [{ id: 'example.org/root' }],
      selected: 'example.org/root',
      asked: [],
    },
    /** @param {unknown} value */
    accepts: (value) =>
      object(value) && value.topic === 'licenses' && value.nodeID === 'example.org/root',
  },
  {
    id: 'dependency-path',
    label: 'Cobra to pflag path planning',
    kind: 'plan',
    data: {
      question: 'How is github.com/spf13/pflag connected to the root?',
      topics,
      nodes: [
        { id: 'github.com/spf13/cobra@v1.8.1' },
        { id: 'github.com/cpuguy83/go-md2man/v2@v2.0.4' },
        { id: 'github.com/spf13/pflag@v1.0.5' },
      ],
      selected: 'github.com/spf13/cobra@v1.8.1',
      asked: [],
    },
    /** @param {unknown} value */
    accepts: (value) =>
      object(value) && value.topic === 'paths' && value.nodeID === 'github.com/spf13/pflag@v1.0.5',
  },
  {
    id: 'repository',
    label: 'Exact repository URL',
    kind: 'answer',
    data: {
      question: "Where's the repository on GitHub?",
      evidence: [
        {
          label: 'Repository',
          detail: 'The source repository URL is https://github.com/gin-gonic/gin.',
        },
      ],
      previousQuestions: [],
      thinking: false,
    },
    /** @param {unknown} value */
    accepts: (value) =>
      typeof value === 'string' && value.includes('https://github.com/gin-gonic/gin'),
  },
  {
    id: 'license',
    label: 'Exact ISC module lookup',
    kind: 'answer',
    data: {
      question: 'Which dependency has an ISC license?',
      evidence: [
        {
          label: 'Licenses',
          detail:
            'example.org/isc-lib: ISC. example.org/mit-lib: MIT. These are the only two modules.',
        },
      ],
      previousQuestions: [],
      thinking: false,
    },
    /** @param {unknown} value */
    accepts: (value) =>
      typeof value === 'string' &&
      value.includes('example.org/isc-lib') &&
      !value.includes('example.org/mit-lib') &&
      !/\b(none|no modules|no dependencies)\b/i.test(value),
  },
])
/** @param {unknown} value @param {string | null} modelID @returns {CheckedReport} */
export function checkedReport(value, modelID) {
  if (
    !object(value) ||
    typeof value.modelID !== 'string' ||
    value.modelID !== modelID ||
    value.runtimeVersion !== catalogInfo.version ||
    value.suiteVersion !== checkSuiteVersion ||
    !Array.isArray(value.results) ||
    value.results.length !== checkCases.length
  ) {
    throw new Error('The model checks did not return a complete report.')
  }
  /** @type {unknown[]} */
  const rawResults = value.results
  /** @param {unknown} result @returns {result is CheckResult} */
  const validResult = (result) =>
    object(result) && typeof result.id === 'string' && typeof result.passed === 'boolean'
  if (
    !rawResults.every(validResult) ||
    !checkCases.every((item) => rawResults.filter((result) => result.id === item.id).length === 1)
  ) {
    throw new Error('The model checks did not return a complete report.')
  }
  return {
    ...value,
    modelID: value.modelID,
    runtimeVersion: catalogInfo.version,
    suiteVersion: checkSuiteVersion,
    results: rawResults.map((result) => ({ id: result.id, passed: result.passed })),
  }
}
/** @param {SummaryReport | null} [report] */
export function checkSummary(report) {
  if (!report)
    return {
      label: 'Not run',
      kind: 'unverified',
      rank: null,
      title: 'No gomod-lens model checks have run for this variant in this page session.',
    }
  if ('state' in report && report.state === 'running')
    return {
      label: 'Checking…',
      kind: 'running',
      rank: null,
      title: `Running local inference on ${checkCases.length} fixed assistant fixtures.`,
    }
  if ('state' in report && report.state === 'incomplete')
    return {
      label: 'Incomplete',
      kind: 'warning',
      rank: null,
      title: report.error || 'Checks did not complete.',
    }
  if (!('results' in report)) throw new Error('Invalid model check report.')
  const count = report.results.filter((value) => value.passed).length
  return {
    label: `${count}/${checkCases.length} passed`,
    kind: count === checkCases.length ? 'passed' : 'warning',
    rank: count,
    title:
      report.results
        .map(
          (result) =>
            `${result.passed ? 'Pass' : 'Fail'}: ${checkCases.find((item) => item.id === result.id)?.label || result.id}`,
        )
        .join('\n') +
      '\nFixed fixture checks in this browser session; not a general quality benchmark.',
  }
}
