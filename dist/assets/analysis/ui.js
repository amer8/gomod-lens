export function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined && text !== null) node.textContent = String(text)
  if (className) node.className = className
  return node
}
export function action(text, run, className = '') {
  const button = element('button', text, 'analysis-button ' + className)
  button.type = 'button'
  button.addEventListener('click', run)
  return button
}
export function link(text, value) {
  const node = element('a', text)
  try { const url = new URL(value); if (url.protocol !== 'https:') throw new Error(); node.href = url.href }
  catch { return element('span', text) }
  node.target = '_blank'; node.rel = 'noreferrer'
  return node
}
export function notice(text, kind = '') { return element('p', text, 'analysis-note ' + kind) }
export function badge(text, kind = '') { return element('span', text, 'analysis-badge ' + kind) }
export function metrics(items) {
  const host = element('div', undefined, 'analysis-metrics')
  for (const [value, label, kind] of items) {
    const item = element('div', undefined, kind || '')
    item.append(element('strong', value), element('span', label)); host.append(item)
  }
  return host
}
export function section(title, body) {
  const host = element('section', undefined, 'analysis-section')
  host.append(element('h5', title), body)
  return host
}
export function disclosure(title, children, open = false) {
  const host = element('details', undefined, 'analysis-disclosure')
  host.open = open
  host.append(element('summary', title), ...children)
  return host
}
export function table(headers, rows, label) {
  const host = element('table', undefined, 'analysis-table'); host.setAttribute('aria-label', label)
  const head = element('thead'), tr = element('tr')
  headers.forEach(text => { const th = element('th', text); th.scope = 'col'; tr.append(th) })
  head.append(tr); const body = element('tbody')
  rows.forEach(cells => { const row = element('tr'); cells.forEach(value => { const cell = element('td'); cell.append(value instanceof Node ? value : element('span', value)); row.append(cell) }); body.append(row) })
  host.append(head, body); return host
}
export function moduleButton(node, select, subtext = node.version || 'Version unknown') {
  const b = action('', () => select(node.id), 'analysis-module')
  b.dataset.nodeId = node.id
  b.append(element('strong', node.name), element('span', subtext))
  return b
}
export function groupedItems(items, groups) {
  return groups.map(([id, label]) => ({ id, label, items: items.filter(item => item.status === id) }))
}
export function searchable(host, { label, placeholder = 'Filter modules…', items, filters = [], row, headers, empty = 'No modules match this filter.', state = {}, groups, highlight }) {
  const controls = element('div', undefined, 'analysis-filters'), search = element('input')
  search.type = 'search'; search.placeholder = placeholder; search.setAttribute('aria-label', label)
  search.value = state.query || ''
  const choices = element('select'); choices.setAttribute('aria-label', label + ' status')
  for (const [value, text] of [['all', 'All modules'], ...filters]) choices.append(new Option(text, value))
  choices.value = ['all', ...filters.map(([value]) => value)].includes(state.status) ? state.status : 'all'
  controls.append(search); if (filters.length) controls.append(choices)
  const result = element('div'), count = element('p', '', 'analysis-note')
  count.setAttribute('role', 'status')
  const render = () => {
    state.query = search.value; state.status = choices.value
    const query = search.value.trim().toLowerCase()
    const match = items.filter(item => (choices.value === 'all' || item.status === choices.value) && (!query || item.search.toLowerCase().includes(query)))
    result.replaceChildren()
    if (groups) {
      const sections = groupedItems(match, groups)
      const first = sections.find(group => group.items.length)?.id
      state.groups ||= {}
      for (const group of sections) {
        const body = []
        if (highlight && group.items.length) body.push(action('Highlight modules', () => highlight({ ids: [...new Set(group.items.map(item => item.node.id))], nodesOnly: true, color: '#a4d6fa' })))
        body.push(group.items.length ? table(headers, group.items.slice(0, 150).map(row), label + ' · ' + group.label) : notice('No modules in this group.'))
        if (group.items.length > 150) body.push(notice('Showing 150 of ' + group.items.length + ' modules. Narrow the filter to find more.'))
        const open = query ? Boolean(group.items.length) : state.groups[group.id] ?? group.id === first
        const section = disclosure(group.label, body, open)
        section.querySelector('summary').append(badge(group.items.length))
        section.addEventListener('toggle', () => { state.groups[group.id] = section.open })
        result.append(section)
      }
    } else result.append(match.length ? table(headers, match.slice(0, 150).map(row), label) : notice(empty))
    count.textContent = !groups && match.length > 150 ? `Showing 150 of ${match.length} matches. Narrow the filter to find more.` : `${match.length} of ${items.length} modules`
  }
  search.addEventListener('input', render); choices.addEventListener('change', render)
  host.append(controls, count, result); render()
}
