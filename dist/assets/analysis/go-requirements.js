import { action, badge, disclosure, element, link, moduleButton, notice, searchable } from './ui.js'
import { compareGoVersions, defaultTarget, lookupGoRequirements, requirementColors, requirementPath, requirementSummary, requirementVersionColors, targetGoVersion } from './go-requirements-data.js'

function versionLabel(text, color, className = '') {
  const label = element('span', text, 'go-requirement-version ' + className)
  const swatch = element('span', undefined, 'go-requirement-swatch')
  swatch.style.backgroundColor = color
  swatch.setAttribute('aria-hidden', 'true'); label.prepend(swatch)
  return label
}

function selectedRequirement({ graph, node, data, versionColors, select, highlight, state }) {
  const record = data.records.get(node.id), content = []
  content.push(element('strong', node.name + (node.version ? '@' + node.version : '')))
  const source = element('div', undefined, 'go-requirement-source')
  if (record?.status === 'observed') {
    source.append(versionLabel('Go ' + record.minimum, versionColors.get(record.minimum), 'analysis-badge'))
    if (record.implicit) content.push(notice('No go directive; Go assumes 1.16.'))
    if (record.identity.name !== node.name || record.identity.version !== node.version) content.push(notice('Replacement: ' + record.identity.name + '@' + record.identity.version))
  } else content.push(notice(record?.error || 'Module metadata unavailable.'))
  if (record?.source) source.append(link('go.mod ↗', record.source))
  content.splice(1, 0, source)
  if (record?.observedAt) content.push(notice('Observed: ' + record.observedAt))
  if (node.id !== graph.rootId) {
    const path = requirementPath(graph, node.id)
    if (path.length) {
      const list = element('ol', undefined, 'go-requirement-path'), nodes = new Map(graph.nodes.map(value => [value.id, value]))
      for (const id of path) {
        const item = element('li'); item.append(moduleButton(nodes.get(id), select)); list.append(item)
      }
      const controls = element('div', undefined, 'analysis-actions')
      controls.append(action('Highlight path', () => highlight({ ids: path, nodesOnly: false, color: '#a4d6fa' })), action('Clear highlight', () => highlight({ ids: [] })))
      content.push(disclosure('Dependency path', [list, controls]))
    } else content.push(notice('No path from the root in this graph.'))
  }
  const changedNode = state.detailsNode !== node.id
  const details = disclosure('Module details', content, changedNode ? node.id !== graph.rootId : Boolean(state.detailsOpen))
  state.detailsNode = node.id
  details.addEventListener('toggle', () => { state.detailsOpen = details.open })
  return details
}

function render({ host, graph, node, data, state, select, highlight }) {
  if (data.error) { host.append(notice(data.error, 'analysis-empty')); return }
  state.target ||= defaultTarget(graph, data)
  const versionColors = requirementVersionColors(graph, data)
  const overview = element('div'), inventory = element('div'), details = element('div')
  const form = element('form', undefined, 'go-requirement-target'), label = element('label', 'Go toolchain')
  const input = element('input'); input.type = 'text'; input.value = state.target; input.placeholder = 'e.g. 1.26.10'; input.spellcheck = false; input.maxLength = 64
  input.setAttribute('aria-label', 'Target Go toolchain')
  const compare = element('button', 'Compare', 'analysis-button'); compare.type = 'submit'
  const fields = element('div'); fields.append(input, compare); label.append(fields); form.append(label)
  const comparisonResult = element('div')
  const comparison = disclosure('Compare toolchain', [form, comparisonResult], Boolean(state.compareOpen))
  comparison.addEventListener('toggle', () => { state.compareOpen = comparison.open })
  const about = disclosure('About this data', [
    notice('Go versions are declared minimums, not a maintenance score or the compiler used to build a module. Meeting them does not guarantee a successful build.'),
    notice('Colors group release families; earlier families are combined. Gray means unknown. Comparisons use exact patch and prerelease requirements; dependency toolchain directives are ignored.'),
    notice('Source: Go module mirror · Observed ' + data.capturedAt),
    link('Go requirements reference ↗', 'https://go.dev/doc/toolchain#module-and-workspace-configuration'),
  ], Boolean(state.aboutOpen))
  about.addEventListener('toggle', () => { state.aboutOpen = about.open })
  host.append(overview, comparison, details, inventory, about)
  const chooseGroup = (id, items = []) => {
    state.group = state.group === id ? '' : id
    state.inventory = {}
    highlight({ ids: state.group ? items.map(item => item.node.id) : [], nodesOnly: true })
    update()
  }
  const update = () => {
    overview.replaceChildren(); inventory.replaceChildren(); details.replaceChildren(); comparisonResult.replaceChildren()
    const summary = requirementSummary(graph, data, state.target)
    if (state.group && state.group !== 'highest' && !summary.groups.some(group => group.id === state.group)) state.group = ''
    const selectedGroup = summary.groups.find(group => group.id === state.group)
    const heading = element('div', undefined, 'go-requirement-summary')
    const highest = action(summary.highest ? 'Highest observed: Go ' + summary.highest : 'No known minimums', () => chooseGroup('highest', summary.highestItems))
    highest.disabled = !summary.highest
    highest.title = 'Show modules with the highest observed minimum'
    heading.append(highest, element('span', graph.nodes.length + ' modules'))
    const versionChoices = element('div', undefined, 'go-requirement-groups')
    versionChoices.setAttribute('role', 'group'); versionChoices.setAttribute('aria-label', 'Minimum Go versions')
    for (const group of [{ id: '', label: 'All', items: summary.items }, ...summary.groups]) {
      const choose = action('', () => chooseGroup(group.id, group.items), 'go-requirement-group')
      choose.setAttribute('aria-pressed', String((state.group || '') === group.id))
      choose.append(group.color ? versionLabel(group.label, group.color) : element('span', group.label), badge(group.items.length)); versionChoices.append(choose)
    }
    overview.append(heading, versionChoices)
    if (state.comparing) {
      comparisonResult.append(notice(summary.newer.length ? summary.newer.length + ' modules require newer Go.' : 'All observed minimums met.', summary.newer.length ? 'analysis-warning' : ''))
      if (summary.unknown.length) comparisonResult.append(notice(summary.unknown.length + ' unknown requirements.'))
      const controls = element('div', undefined, 'analysis-actions')
      if (summary.newer.length) controls.append(action('Highlight newer requirements', () => highlight({ ids: summary.newer.map(item => item.node.id), nodesOnly: true, color: '#f2c976' })))
      controls.append(action('Clear highlight', () => highlight({ ids: [] }))); comparisonResult.append(controls)
    }
    details.append(selectedRequirement({ graph, node, data, versionColors, select, highlight, state }))
    if (state.group) {
      const filter = element('div', undefined, 'go-requirement-summary')
      filter.append(element('span', state.group === 'highest' ? 'Highest minimums' : selectedGroup.label), action('Show all', () => chooseGroup('')))
      inventory.append(filter)
    }
    const ordered = [...(state.group === 'highest' ? summary.highestItems : selectedGroup?.items || summary.items)]
      .sort((a, b) => {
        if (!a.family || !b.family) return Number(Boolean(b.family)) - Number(Boolean(a.family))
        return compareGoVersions(b.record.minimum, a.record.minimum) || a.node.name.localeCompare(b.node.name)
      })
    searchable(inventory, {
      label: 'Go module requirements', placeholder: 'Find module or Go version…', items: ordered, state: state.inventory ||= {},
      filters: state.comparing ? [['newer', 'Requires newer'], ['meets', 'Meets minimum'], ['unknown', 'Unknown']] : [], headers: ['Module', 'Minimum Go'],
      row: item => {
        const detail = element('div'); detail.append(item.family ? versionLabel('Go ' + item.record.minimum, versionColors.get(item.record.minimum), 'analysis-badge') : badge('Unknown'))
        if (state.comparing && item.status === 'newer') detail.append(notice('Requires newer', 'analysis-warning'))
        return [moduleButton(item.node, select), detail]
      },
    })
  }
  input.addEventListener('input', () => input.setCustomValidity(''))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const target = targetGoVersion(input.value)
    input.setCustomValidity(target ? '' : 'Enter a Go version such as 1.26.10 or 1.27rc1.')
    if (!target) { input.reportValidity(); return }
    state.target = target; state.comparing = true; input.value = target
    highlight({ ids: [] }); update()
  })
  update()
}

/** @type {import('./types.js').BrowserLens} */
const lens = {
  scope: 'Minimum Go versions',
  load: lookupGoRequirements,
  render,
  colors: requirementColors,
  status: data => data.error ? 'Requirements unavailable · refresh to retry' : 'Source: Go module mirror · exact-version go.mod',
}

export default lens
