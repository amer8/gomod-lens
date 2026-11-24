import { modelProfile, capabilityBadges } from './model-profiles.js'
import { catalog, catalogInfo } from './model-catalog.js'

export { catalogInfo }
export const defaultModelID = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'
export const runtimeURL = new URL(`../vendor/web-llm-${catalogInfo.version}.js`, import.meta.url)
  .href
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
/** @param {number | null | undefined} bytes */
const weightSize = (bytes) =>
  bytes == null
    ? '—'
    : bytes >= 1e9
      ? `~${(bytes / 1e9).toFixed(2)} GB`
      : `~${Math.round(bytes / 1e6)} MB`
/** @param {number | null | undefined} mb */
const memorySize = (mb) =>
  mb == null ? '—' : mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${Math.round(mb)} MB`

/** @typedef {{name: string, url: string, attribution?: string, policyURL?: string, publisherLicense?: {name: string, url: string}, publisherPolicyURL?: string}} ModelLicense */
const apache = Object.freeze({
  name: 'Apache-2.0',
  url: 'https://www.apache.org/licenses/LICENSE-2.0',
})
/** @param {string} version */
const llama = (version) =>
  Object.freeze({
    name: `Llama ${version} Community License`,
    attribution: 'Built with Llama',
    url: `https://github.com/meta-llama/llama-models/blob/main/models/llama${version.replace('.', '_')}/LICENSE`,
    policyURL: `https://github.com/meta-llama/llama-models/blob/main/models/llama${version.replace('.', '_')}/USE_POLICY.md`,
  })
// Licenses belong to these specific checkpoints, not to model-family names.
/** @type {Map<string, ModelLicense>} */
const licenseByID = new Map([
  ...[
    'Qwen2.5-1.5B-Instruct',
    'Qwen2.5-0.5B-Instruct',
    'Qwen3-0.6B',
    'Qwen3-1.7B',
    'Qwen3.5-2B',
    'Qwen3-4B',
    'Qwen3-8B',
  ].map((id) => /** @type {[string, ModelLicense]} */ ([id + '-q4f32_1-MLC', apache])),
  ['Llama-3.2-3B-Instruct-q4f32_1-MLC', llama('3.2')],
  [
    'Hermes-3-Llama-3.1-8B-q4f32_1-MLC',
    Object.freeze({
      ...llama('3.1'),
      name: 'Llama 3.1 base license',
      attribution: 'Built with Llama · Built with Meta Llama 3',
      publisherLicense: Object.freeze({
        name: 'Publisher: Meta Llama 3 license',
        url: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3/LICENSE',
      }),
      publisherPolicyURL:
        'https://github.com/meta-llama/llama-models/blob/main/models/llama3/USE_POLICY.md',
    }),
  ],
  [
    'Phi-4-mini-instruct-q4f32_1-MLC',
    Object.freeze({
      name: 'MIT',
      url: 'https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/main/LICENSE',
    }),
  ],
])

// The committed catalog contains only the ten curated runtime IDs. Refreshing
// metadata must preserve tools/webllm-shortlist.json rather than re-expand it.
export const models = Object.freeze(
  catalog
    .map((record) => {
      const license = licenseByID.get(record.id)
      if (!license) throw new Error('Missing model license: ' + record.id)
      const name = record.id
        .replace(/-q\d[^-]*-MLC.*$/, '')
        .replace(/-instruct$/i, '')
        .replace('-Llama-3.1', '')
        .replace(/-mini$/i, ' Mini')
        .replace(/^Qwen(?=\d)/, 'Qwen ')
        .replace(/^(Llama|Phi|Hermes)-/, '$1 ')
        .replace(/-(\d+(?:\.\d+)?B)$/, ' · $1')
      const precision = /-(q\d[^-]*)-MLC/.exec(record.id)?.[1] || ''
      const profile = modelProfile(record),
        capabilities = Object.freeze(capabilityBadges(profile))
      const thinking = profile.reasoning === 'optional',
        alwaysThinking = profile.reasoning === 'required'
      const detail =
        record.id === defaultModelID
          ? 'Balanced starting point'
          : record.id.includes('0.5B')
            ? 'Smallest download'
            : /0\.6B/.test(record.id)
              ? 'Small and lightweight'
              : /1\.7B|2B/.test(record.id)
                ? 'A compact alternative'
                : /8B/.test(record.id)
                  ? 'For more powerful devices'
                  : 'A larger alternative'
      return Object.freeze({
        ...record,
        features: Object.freeze([...record.features]),
        name,
        precision,
        thinking,
        alwaysThinking,
        profile,
        capabilities,
        license,
        capabilityText: capabilities.map((value) => value.label).join(' · '),
        recommended: record.id === defaultModelID,
        detail,
        download: weightSize(record.downloadBytes),
        gpu: memorySize(record.gpuMB),
        context: record.contextTokens == null ? '—' : record.contextTokens.toLocaleString('en'),
      })
    })
    .sort((a, b) => a.selectionOrder - b.selectionOrder),
)
const modelByID = new Map(models.map((model) => [model.id, model]))
/** @param {string | null} id */
export const findModel = (id) => (id === null ? undefined : modelByID.get(id))

// Missing sizes stay last in either direction; always compare the raw numbers,
// never formatted MB/GB strings. Identity breaks ties between precision variants.
/**
 * @template {{id: string, name: string, downloadBytes: number | null, gpuMB: number | null, contextTokens: number | null, capabilityText?: string}} Model
 * @param {readonly Model[]} values @param {string} column @param {string} [direction] @returns {Model[]}
 */
export function sortModels(values, column, direction = 'ascending') {
  /** @type {Record<string, 'name' | 'downloadBytes' | 'gpuMB' | 'contextTokens' | 'capabilityText'>} */
  const fields = {
    name: 'name',
    download: 'downloadBytes',
    gpu: 'gpuMB',
    context: 'contextTokens',
    capabilities: 'capabilityText',
  }
  const field = fields[column]
  if (!field) throw new Error('Unknown model table column.')
  const sign = direction === 'descending' ? -1 : 1
  return [...values].sort((a, b) => {
    const left = a[field],
      right = b[field]
    if (left == null && right != null) return 1
    if (right == null && left != null) return -1
    const value =
      left == null || right == null
        ? 0
        : typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left), String(right))
    return sign * (value || collator.compare(a.id, b.id))
  })
}
/**
 * @template {{name: string, id: string, detail: string}} Model
 * @param {readonly Model[]} values
 * @param {string} search
 * @returns {Model[]}
 */
export function filterModels(values, search) {
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return values.filter((model) =>
    words.every((word) => `${model.name} ${model.id} ${model.detail}`.toLowerCase().includes(word)),
  )
}
