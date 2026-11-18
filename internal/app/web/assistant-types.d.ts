import type { GraphPayload } from './static/analysis/types.js'
import type { LicenseRecord } from './static/analysis/licenses.js'
import type { VulnerabilityRecord } from './static/analysis/vulnerabilities.js'
import type { ScorecardCheck } from './static/analysis/scorecard.js'

export type LicenseQuery = { ids: string[]; mode: 'all' | 'any' }
export type Context = { graph: GraphPayload; selected: string; lens?: string }
export type Evidence = {
  vulnerabilities?: { records?: Map<string, VulnerabilityRecord>; error?: string; capturedAt?: string }
  licenses?: { records?: Map<string, LicenseRecord>; error?: string; capturedAt?: string }
  openssf?: { error?: string; missing?: boolean; message?: string; checks?: ScorecardCheck[]; source?: string; fetchedAt?: string; date?: string }
}
export type ConversationTurn = { revision: number; question: string; modelID: string | null; selected: string; answer?: string; topic?: string; suggestionKey?: string; article?: HTMLElement }
export type Suggestion = { id: string; label: string; nodeID: string; licenseQuery?: LicenseQuery; key: string }
export type EvidenceFact = {id: string; investigation: string; statements: string; findings: {module: string; detail: string}[]; omittedFindings: number; path?: string[]; omittedPathSteps: number; scope: string; observedAt: string}
export type RepositoryFact = {id: 'R'; module: string; version?: string; repositoryURL: string | null; repositoryMapping: string}
export type Answer = {
  title: string
  paragraphs: string[]
  items: { nodeID?: string; label: string; detail: string }[]
  sources: { label: string; url: string }[]
  actions: { label: string; ids: string[]; lens?: string }[]
  scope: string
  observedAt: string
  topic: string
  generated?: boolean
  evidence?: {label: string; detail: string}[]
  path?: string[]
  licenseQuery?: LicenseQuery
  licenseGroups?: {label: string; ids: string[]}[]
  licenseSummary?: {known: number; multiple: number; total: number; unknown: number; filter: string | null}
}
