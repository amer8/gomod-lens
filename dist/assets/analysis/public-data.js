const memory = new Map()
export function clearPublicCache() { memory.clear() }
export function publicJSON(url, options) { return publicData(url, options, 'json') }
export function publicText(url, options) { return publicData(url, options, 'text') }
async function publicData(url, { signal, body, fetcher = fetch } = {}, format) {
  signal?.throwIfAborted()
  const key = format + ':' + url + (body ? JSON.stringify(body) : '')
  const cached = memory.get(key)
  if (cached && Date.now() - cached.at < 300000) return structuredClone(cached.value)
  const timeout = AbortSignal.timeout(20000)
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'omit', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error(`Public source returned HTTP ${response.status}`)
  const value = await response[format]()
  signal?.throwIfAborted()
  if (memory.size >= 1000) memory.delete(memory.keys().next().value)
  memory.set(key, { at: Date.now(), value }); return structuredClone(value)
}
export function publicIdentity(node) {
  if (!node?.name || !node.version) return null
  if (node.replaced) {
    const replacement = node.replacement || '', at = replacement.lastIndexOf('@')
    if (at < 1) return null
    const name = replacement.slice(0, at), version = replacement.slice(at + 1)
    if (!name.includes('.') || name.startsWith('.') || name.startsWith('/') || !version) return null
    return { name, version }
  }
  return { name: node.name, version: node.version }
}
export async function mapModules(nodes, work, { signal, progress = () => {} } = {}) {
  const records = new Map(); let next = 0, done = 0
  await Promise.all(Array.from({ length: Math.min(4, nodes.length) }, async () => {
    while (next < nodes.length) {
      if (signal?.aborted) throw signal.reason
      const node = nodes[next++]
      try { records.set(node.id, await work(node)) }
      catch (error) { if (signal?.aborted) throw error; records.set(node.id, { status: 'unknown', error: error.message }) }
      progress(++done, nodes.length)
    }
  }))
  return records
}
export const versionURL = identity => 'https://api.deps.dev/v3/systems/GO/packages/' + encodeURIComponent(identity.name) + '/versions/' + encodeURIComponent(identity.version)
