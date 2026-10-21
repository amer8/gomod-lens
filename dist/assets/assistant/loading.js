// Never invent a percentage for runtime import or reports without a number.
export function loadingProgress(text, report = {}) {
  const value = typeof report.progress === 'number' && Number.isFinite(report.progress) ? Math.max(0, Math.min(1, report.progress)) : null
  return { text, value, label: value === null ? 'Preparing…' : Math.round(value * 100) + '%' }
}

export function modelMarker(id, { loaded, loading, cached }) {
  if (id === loaded) return { label: 'Loaded', kind: 'loaded', title: 'Active model, ready to chat.' }
  if (id === loading) return { label: 'Loading', kind: 'loading', title: 'This model is being prepared.' }
  if (cached.get(id) === true) return { label: 'Cached', kind: 'cached', title: 'WebLLM found saved model data in this browser. Loading may still fetch missing files.' }
  return null
}
