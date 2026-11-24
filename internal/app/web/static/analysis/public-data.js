/** @typedef {{signal?: AbortSignal, body?: unknown, fetcher?: typeof fetch}} PublicOptions */
/** @typedef {{name: string, version: string}} ModuleIdentity */
/** @type {Map<string, {at: number, value: unknown}>} */
const memory = new Map()
export function clearPublicCache() {
  memory.clear()
}
export class PublicHTTPError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`Public source returned HTTP ${status}`)
    this.status = status
  }
}
/** @param {string} url @param {PublicOptions} [options] @returns {Promise<unknown>} */
export function publicJSON(url, options) {
  return publicData(url, options, 'json')
}
/** @param {string} url @param {PublicOptions} [options] @returns {Promise<string>} */
export function publicText(url, options) {
  return publicData(url, options, 'text')
}
/**
 * @overload
 * @param {string} url
 * @param {PublicOptions | undefined} options
 * @param {'json'} format
 * @returns {Promise<unknown>}
 */
/**
 * @overload
 * @param {string} url
 * @param {PublicOptions | undefined} options
 * @param {'text'} format
 * @returns {Promise<string>}
 */
/**
 * @param {string} url
 * @param {PublicOptions | undefined} options
 * @param {'json' | 'text'} format
 * @returns {Promise<unknown>}
 */
async function publicData(url, { signal, body, fetcher = fetch } = {}, format) {
  signal?.throwIfAborted()
  const key = format + ':' + url + (body ? JSON.stringify(body) : '')
  const cached = memory.get(key)
  if (cached && Date.now() - cached.at < 300000) return structuredClone(cached.value)
  const timeout = AbortSignal.timeout(20000)
  const response = await fetcher(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'omit',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
  if (!response.ok) throw new PublicHTTPError(response.status)
  const value = await response[format]()
  signal?.throwIfAborted()
  if (memory.size >= 1000) {
    const oldest = memory.keys().next()
    if (!oldest.done) memory.delete(oldest.value)
  }
  memory.set(key, { at: Date.now(), value })
  return structuredClone(value)
}
/**
 * @param {Pick<import('./types.js').GraphNode, 'name' | 'version' | 'replaced' | 'replacement' | 'localReplacement'> | null | undefined} node
 * @returns {ModuleIdentity | null}
 */
export function publicIdentity(node) {
  if (!node?.name || !node.version) return null
  if (node.replaced) {
    const replacement = node.replacement || ''
    // Older graph payloads only carry the display string.
    if (node.localReplacement || /^[./\\]|^[a-z]:/i.test(replacement)) return null
    const at = replacement.lastIndexOf('@')
    if (at < 1) return null
    const name = replacement.slice(0, at),
      version = replacement.slice(at + 1)
    if (!name.includes('.') || name.startsWith('.') || name.startsWith('/') || !version) return null
    return { name, version }
  }
  return { name: node.name, version: node.version }
}
/**
 * @template {{id: string}} Node
 * @template Result
 * @param {Node[]} nodes
 * @param {(node: Node) => Promise<Result>} work
 * @param {{signal?: AbortSignal, progress?: (done: number, total: number) => void}} [options]
 * @returns {Promise<Map<string, Result | {status: 'unknown', error: string}>>}
 */
export async function mapModules(nodes, work, { signal, progress = () => {} } = {}) {
  /** @type {Map<string, Result | {status: 'unknown', error: string}>} */
  const records = new Map()
  let next = 0,
    done = 0
  await Promise.all(
    Array.from({ length: Math.min(4, nodes.length) }, async () => {
      while (next < nodes.length) {
        if (signal?.aborted) throw signal.reason
        const node = nodes[next++]
        try {
          records.set(node.id, await work(node))
        } catch (error) {
          if (signal?.aborted) throw error
          const message =
            error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
              ? error.message
              : String(error)
          records.set(node.id, { status: 'unknown', error: message })
        }
        progress(++done, nodes.length)
      }
    }),
  )
  return records
}
/** @param {ModuleIdentity} identity */
export const versionURL = (identity) =>
  'https://api.deps.dev/v3/systems/GO/packages/' +
  encodeURIComponent(identity.name) +
  '/versions/' +
  encodeURIComponent(identity.version)
