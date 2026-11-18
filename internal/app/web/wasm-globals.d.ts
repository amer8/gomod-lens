import type { GraphNode, GraphPayload } from './static/analysis/types.js'

type Progress = { value: number; label?: string }
type RequirementProgress = { done: number; total: number }
type GraphOptions = { signal?: AbortSignal; onProgress?: (progress: Progress) => void }
type RequirementOptions = { signal?: AbortSignal; refresh?: boolean; onProgress?: (progress: RequirementProgress) => void }
type SearchResult = { path: string; repository: string; url: string; description?: string; stars?: number }
type GoRequirement = {
  status: string
  minimum?: string
  implicit: boolean
  identity: { name: string; version: string }
  source?: string
  observedAt?: string
  error?: string
}
type Requirements = { records: Record<string, GoRequirement>; capturedAt: string }

declare global {
  interface Window {
    Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
    gomodLensWASMReady: boolean
    gomodLensResolveGraph(target: string, options: GraphOptions): Promise<GraphPayload>
    gomodLensSearchModules(query: string, limit: number, options: { signal?: AbortSignal }): Promise<SearchResult[]>
    gomodLensLoadGoRequirements(nodes: string, options: RequirementOptions): Promise<Requirements>
  }
}

export type { GraphNode, GraphOptions, RequirementOptions, SearchResult }
