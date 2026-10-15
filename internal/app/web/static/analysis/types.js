// Editor documentation for the browser extension interface; no build step.
// The serialized graph is defined in internal/graph/model.go.

/**
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} name
 * @property {string} [version]
 * @property {boolean} [replaced]
 * @property {string} [replacement] Resolved name@version, or a local path.
 * @property {Object<string, {status: string, score?: number, message?: string, details?: Object<string, string>}>} [lenses]
 * @property {{projectId?: string}} [openssf] Legacy Scorecard compatibility data.
 */

/**
 * @typedef {Object} GraphPayload
 * @property {string} rootId
 * @property {GraphNode[]} nodes
 * @property {{source: string, target: string}[]} edges
 */

/**
 * @typedef {Object} LoadContext
 * @property {GraphNode} node Selected node captured when this request starts.
 * @property {AbortSignal} signal Aborted when the module graph changes.
 * @property {(done: number, total: number) => void} progress
 */

/**
 * @typedef {Object} HighlightRequest
 * @property {string[]} ids An empty array clears the explicit highlight.
 * @property {boolean} [nodesOnly]
 * @property {string} [color]
 */

/**
 * @template T
 * @typedef {Object} RenderContext
 * @property {HTMLElement} host Empty content container owned by this lens.
 * @property {GraphPayload} graph
 * @property {GraphNode} node Currently selected node.
 * @property {T | {error: string}} data Load result, or a controller-wrapped failure.
 * @property {Object<string, any>} state Lens-owned UI state, reset on graph changes.
 * @property {(id: string) => void} select Select a module and rerender the lens.
 * @property {(request: HighlightRequest) => void} highlight
 * @property {(content: HTMLElement) => void} inspect Place content in the shared
 * collapsible inspector (beside the graph on desktop, inside the mobile drawer).
 */

/**
 * @template [T=any]
 * @typedef {Object} BrowserLens
 * @property {string} scope Short description of what this view assesses.
 * @property {(graph: GraphPayload, context: LoadContext) => Promise<T>} load
 * Load lazily when opened. Use the supplied signal for every upstream request.
 * @property {(context: RenderContext<T>) => void} render Synchronous DOM rendering.
 * Must handle data.error; preserve controls through state rather than host DOM.
 * @property {boolean} [selection] Cache results per selected node instead of per
 * graph. Also enables the module picker. Use for repository report lookups.
 * @property {boolean} [modulePicker] Show a picker without loading per selection.
 * @property {(graph: GraphPayload, data: T | {error: string}, selected: string) => Object<string, string>} [colors]
 * Node-ID to CSS-color map. Handle missing records/errors with an unknown color.
 * If omitted, graph.js uses its existing Scorecard/Freshness color scheme.
 * @property {(data: T | {error: string}) => string} [status] Source/status caption.
 */

/**
 * @typedef {Object} BrowserLensRegistration
 * @property {string} id Stable lowercase URL and panel identifier.
 * @property {string} key Unique module/state key; keep stable across releases.
 * @property {string} title Sidebar/inspector heading.
 * @property {string} label Accessible toolbar label and tooltip.
 * @property {string} icon Toolbar glyph; colors/styles live in CSS.
 * @property {() => Promise<{default: BrowserLens}>} importModule
 */

export {}
