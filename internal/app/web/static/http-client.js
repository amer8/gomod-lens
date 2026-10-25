export async function loadGraph(target, { signal } = {}) {
  const response = await fetch(`/api/graph?${new URLSearchParams({ target })}`, { signal, credentials: 'omit' })
  const payload = await response.json().catch(() => null)
  signal?.throwIfAborted()
  if (!response.ok) {
    throw new Error(payload?.error || `Unable to load graph (HTTP ${response.status})`)
  }
  if (!payload) throw new Error('Graph response did not include data')
  return payload
}

export async function searchModules(query, limit, signal) {
  const response = await fetch(`/api/modules/search?${new URLSearchParams({ q: query, limit: String(limit) })}`, { signal, credentials: 'omit' })
  if (!response.ok) return []
  const payload = await response.json()
  signal?.throwIfAborted()
  return Array.isArray(payload?.results) ? payload.results : []
}
