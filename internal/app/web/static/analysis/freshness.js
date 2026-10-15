import { element, notice, badge, metrics, searchable, moduleButton, action } from './ui.js'

const categories = [
  ['current', 'Current release', 'good'], ['patch_behind', 'Patch behind', 'warning'],
  ['minor_behind', 'Minor behind', 'warning'], ['major_behind', 'Major behind', 'bad'],
  ['preview', 'Pre-release / pseudo', ''], ['unknown', 'Unknown / unavailable', ''],
]

export function freshnessRecord(node) {
  const result = node.lenses?.['release-freshness'] || {}, details = result.details || {}
  const raw = result.status || 'unknown'
  const status = ['prerelease', 'pseudo_version'].includes(raw) ? 'preview' : categories.some(([id]) => id === raw) ? raw : 'unknown'
  return {
    status, sourceStatus: raw, module: details.module || node.name,
    version: details.version || node.version || '', latest: details.latestVersion || '',
    message: result.message || details.error || '',
  }
}

export async function readFreshness(graph) {
  return { records: new Map(graph.nodes.map(node => [node.id, freshnessRecord(node)])) }
}

function selectedVersion(node, record) {
  const body = element('section', undefined, 'analysis-section')
  body.append(element('h5', 'Selected release'), element('div', node.name, 'analysis-selected-name'))
  const versions = element('div', undefined, 'analysis-version-comparison')
  for (const [label, value] of [['Loaded', record.version || 'Unavailable'], ['Latest observed', record.latest || 'Unavailable']]) {
    const item = element('div'); item.append(element('span', label), element('strong', value)); versions.append(item)
  }
  const category = categories.find(([id]) => id === record.status)
  body.append(versions, badge(category[1], category[2]))
  if (record.module !== node.name || record.version !== node.version) body.append(notice('Resolved identity: ' + record.module + '@' + record.version))
  if (record.message) body.append(notice(record.message))
  if (record.latest && record.latest !== record.version) body.append(action('Analyze ' + record.latest, () => {
    window.location.hash = 'target=' + encodeURIComponent(record.module + '@' + record.latest)
  }))
  body.append(notice('A release difference does not establish upgrade compatibility. Analyzing a release loads a new graph.'))
  return body
}

function render({ host, graph, node, data, select, highlight, state }) {
  if (data.error) { host.append(notice(data.error, 'analysis-empty')); return }
  const items = graph.nodes.map(node => {
    const record = data.records.get(node.id)
    return { node, record, status: record.status, search: [node.name, node.version, record.module, record.version, record.latest].join(' ') }
  })
  const current = items.filter(item => item.status === 'current').length
  const behind = items.filter(item => ['patch_behind', 'minor_behind', 'major_behind'].includes(item.status)).length
  const unknown = items.filter(item => item.status === 'unknown').length
  host.append(metrics([[current, 'Current release', 'analysis-good'], [behind, 'Behind release', 'analysis-warning'], [unknown, 'Unknown']]))
  const preview = items.filter(item => item.status === 'preview').length
  if (preview) host.append(notice(preview + ' pre-release / pseudo-version modules are counted separately.'))
  const row = item => {
    const status = categories.find(([id]) => id === item.status), cell = element('div')
    cell.append(badge(status[1], status[2]), notice('Latest: ' + (item.record.latest || 'Unavailable')))
    return [moduleButton(item.node, select), cell]
  }
  const options = { label: 'Release group modules', placeholder: 'Filter module or version…', row, headers: ['Module / loaded version', 'Latest / release state'] }
  const queues = element('div', undefined, 'analysis-release-queues'), results = element('div')
  const buttons = new Map()
  if (!categories.some(([id]) => id === state.queue)) state.queue = null
  const update = () => {
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === state.queue))
    results.replaceChildren()
    const category = categories.find(([id]) => id === state.queue)
    results.append(element('h5', category ? category[1] : 'All modules'))
    searchable(results, { ...options, items: category ? items.filter(item => item.status === state.queue) : items, state: state.queueFilter ||= {} })
  }
  for (const [id, label, kind] of categories) {
    const matching = items.filter(item => item.status === id)
    const button = action('', () => {
      state.queue = state.queue === id ? null : id
      highlight({ ids: state.queue ? matching.map(item => item.node.id) : [], nodesOnly: true, color: '#a4d6fa' }); update()
    }, 'analysis-release-queue')
    button.append(element('span', label), badge(matching.length, kind)); buttons.set(id, button); queues.append(button)
  }
  host.append(queues, action('Clear graph highlight', () => highlight({ ids: [] })), results); update()
  host.append(selectedVersion(node, data.records.get(node.id)))
  host.append(notice('Source: release metadata in the loaded graph. Unknown and failed lookups are kept separate from current releases.', 'analysis-provenance'))
}

/** @type {import('./types.js').BrowserLens} */
const lens = {
  modulePicker: true,
  scope: 'Loaded versions · latest observed releases',
  load: readFreshness,
  render,
  status: data => data.error ? 'Release metadata unavailable' : 'Source: loaded graph · release metadata',
}

export default lens
