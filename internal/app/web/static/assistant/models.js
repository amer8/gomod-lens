import { modelProfile, capabilityBadges } from './model-profiles.js'
import { catalog, catalogInfo } from './model-catalog.js'

export { catalogInfo }
export const defaultModelID = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'
export const runtimeURL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${catalogInfo.version}/lib/index.js`
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const weightSize = bytes => bytes == null ? '—' : bytes >= 1e9 ? `~${(bytes / 1e9).toFixed(2)} GB` : `~${Math.round(bytes / 1e6)} MB`
const memorySize = mb => mb == null ? '—' : mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${Math.round(mb)} MB`

// The committed catalog contains only the ten curated runtime IDs. Refreshing
// metadata must preserve tools/webllm-shortlist.json rather than re-expand it.
export const models = Object.freeze(catalog.map(record => {
  const name = record.id.replace(/-q\d[^-]*-MLC.*$/, '').replace(/-instruct$/i, '').replace('-Llama-3.1', '').replace(/-mini$/i, ' Mini').replace(/^Qwen(?=\d)/, 'Qwen ').replace(/^(Llama|Phi|Hermes)-/, '$1 ').replace(/-(\d+(?:\.\d+)?B)$/, ' · $1')
  const precision = /-(q\d[^-]*)-MLC/.exec(record.id)?.[1] || ''
  const profile = modelProfile(record), capabilities = Object.freeze(capabilityBadges(profile))
  const thinking = profile.reasoning === 'optional', alwaysThinking = profile.reasoning === 'required'
  const detail = record.id === defaultModelID ? 'Balanced starting point' : record.id.includes('0.5B') ? 'Smallest download' : /0\.6B/.test(record.id) ? 'Small and lightweight' : /1\.7B|2B/.test(record.id) ? 'A compact alternative' : /8B/.test(record.id) ? 'For more powerful devices' : 'A larger alternative'
  return Object.freeze({ ...record, features: Object.freeze([...record.features]), name, precision, thinking, alwaysThinking, profile, capabilities,
    capabilityText: capabilities.map(value => value.label).join(' · '),
    recommended: record.id === defaultModelID, detail, download: weightSize(record.downloadBytes), gpu: memorySize(record.gpuMB),
    context: record.contextTokens == null ? '—' : record.contextTokens.toLocaleString('en') })
}).sort((a, b) => a.selectionOrder - b.selectionOrder))
const modelByID = new Map(models.map(model => [model.id, model]))
export const findModel = id => modelByID.get(id)

// Missing sizes stay last in either direction; always compare the raw numbers,
// never formatted MB/GB strings. Identity breaks ties between precision variants.
export function sortModels(values, column, direction = 'ascending') {
  const fields = { name: 'name', download: 'downloadBytes', gpu: 'gpuMB', context: 'contextTokens', capabilities: 'capabilityText' }
  const field = fields[column]
  if (!field) throw new Error('Unknown model table column.')
  const sign = direction === 'descending' ? -1 : 1
  return [...values].sort((a, b) => {
    const left = a[field], right = b[field]
    if (left == null && right != null) return 1
    if (right == null && left != null) return -1
    const value = left == null ? 0 : typeof left === 'number' ? left - right : collator.compare(left, right)
    return sign * (value || collator.compare(a.id, b.id))
  })
}
export function filterModels(values, search) {
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return values.filter(model => words.every(word => `${model.name} ${model.id} ${model.detail}`.toLowerCase().includes(word)))
}
