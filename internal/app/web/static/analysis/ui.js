/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag @param {unknown} [text] @param {string} [className]
 * @returns {HTMLElementTagNameMap[Tag]}
 */
export function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined && text !== null) node.textContent = String(text)
  if (className) node.className = className
  return node
}
/** @param {string} text @param {(event: MouseEvent) => void} run @param {string} [className] */
export function action(text, run, className = '') {
  const button = element('button', text, 'analysis-button ' + className)
  button.type = 'button'
  button.addEventListener('click', run)
  return button
}
/** @param {string} text @param {string} value */
export function link(text, value) {
  const node = element('a', text)
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') throw new Error()
    node.href = url.href
  } catch {
    return element('span', text)
  }
  node.target = '_blank'
  node.rel = 'noreferrer'
  return node
}
/** @param {string} text @param {string} [kind] */
export function notice(text, kind = '') {
  return element('p', text, 'analysis-note ' + kind)
}
/** @param {string | number} text @param {string} [kind] */
export function badge(text, kind = '') {
  return element('span', text, 'analysis-badge ' + kind)
}
/** @param {[string | number, string, string?][]} items */
export function metrics(items) {
  const host = element('div', undefined, 'analysis-metrics')
  for (const [value, label, kind] of items) {
    const item = element('div', undefined, kind || '')
    item.append(element('strong', value), element('span', label))
    host.append(item)
  }
  return host
}
/** @param {string} title @param {Node} body */
export function section(title, body) {
  const host = element('section', undefined, 'analysis-section')
  host.append(element('h5', title), body)
  return host
}
/** @param {string} title @param {Node[]} children @param {boolean} [open] */
export function disclosure(title, children, open = false) {
  const host = element('details', undefined, 'analysis-disclosure')
  host.open = open
  host.append(element('summary', title), ...children)
  return host
}
/** @param {string[]} headers @param {unknown[][]} rows @param {string} label */
export function table(headers, rows, label) {
  const host = element('table', undefined, 'analysis-table')
  host.setAttribute('aria-label', label)
  const head = element('thead'),
    tr = element('tr')
  headers.forEach((text) => {
    const th = element('th', text)
    th.scope = 'col'
    tr.append(th)
  })
  head.append(tr)
  const body = element('tbody')
  rows.forEach((cells) => {
    const row = element('tr')
    cells.forEach((value) => {
      const cell = element('td')
      cell.append(value instanceof Node ? value : element('span', value))
      row.append(cell)
    })
    body.append(row)
  })
  host.append(head, body)
  return host
}
/**
 * @param {import('./types.js').GraphNode} node
 * @param {(id: string) => void} select
 * @param {string} [subtext]
 */
export function moduleButton(node, select, subtext = node.version || 'Version unknown') {
  const b = action('', () => select(node.id), 'analysis-module')
  b.dataset.nodeId = node.id
  b.append(element('strong', node.name), element('span', subtext))
  return b
}
/** @template {{status: string}} Item @param {Item[]} items @param {[string, string][]} groups */
export function groupedItems(items, groups) {
  return groups.map(([id, label]) => ({
    id,
    label,
    items: items.filter((item) => item.status === id),
  }))
}
/**
 * @template Item
 * @typedef {Object} SearchOptions
 * @property {string} label
 * @property {string} [placeholder]
 * @property {Item[]} items
 * @property {[string, string][]} [filters]
 * @property {(item: Item) => unknown[]} row
 * @property {string[]} headers
 * @property {string} [empty]
 * @property {{query?: string, status?: string, groups?: Record<string, boolean>}} [state]
 * @property {[string, string][]} [groups]
 * @property {(request: import('./types.js').HighlightRequest) => void} [highlight]
 */
/**
 * @template {{status: string, search: string, node: {id: string}}} Item
 * @param {HTMLElement} host
 * @param {SearchOptions<Item>} options
 */
export function searchable(
  host,
  {
    label,
    placeholder = 'Filter modules…',
    items,
    filters = [],
    row,
    headers,
    empty = 'No modules match this filter.',
    state = {},
    groups,
    highlight,
  },
) {
  const controls = element('div', undefined, 'analysis-filters'),
    search = element('input')
  search.type = 'search'
  search.placeholder = placeholder
  search.setAttribute('aria-label', label)
  search.value = state.query || ''
  const choices = element('select')
  choices.setAttribute('aria-label', label + ' status')
  for (const [value, text] of [['all', 'All modules'], ...filters])
    choices.append(new Option(text, value))
  const selectedStatus = state.status || ''
  choices.value = ['all', ...filters.map(([value]) => value)].includes(selectedStatus)
    ? selectedStatus
    : 'all'
  controls.append(search)
  if (filters.length) controls.append(choices)
  const result = element('div'),
    count = element('p', '', 'analysis-note')
  count.setAttribute('role', 'status')
  const render = () => {
    state.query = search.value
    state.status = choices.value
    const query = search.value.trim().toLowerCase()
    const match = items.filter(
      (item) =>
        (choices.value === 'all' || item.status === choices.value) &&
        (!query || item.search.toLowerCase().includes(query)),
    )
    result.replaceChildren()
    if (groups) {
      const sections = groupedItems(match, groups)
      const first = sections.find((group) => group.items.length)?.id
      const expandedGroups = (state.groups ||= {})
      for (const group of sections) {
        const body = []
        if (highlight && group.items.length)
          body.push(
            action('Highlight modules', () =>
              highlight({
                ids: [...new Set(group.items.map((item) => item.node.id))],
                nodesOnly: true,
                color: '#a4d6fa',
              }),
            ),
          )
        body.push(
          group.items.length
            ? table(headers, group.items.slice(0, 150).map(row), label + ' · ' + group.label)
            : notice('No modules in this group.'),
        )
        if (group.items.length > 150)
          body.push(
            notice(
              'Showing 150 of ' + group.items.length + ' modules. Narrow the filter to find more.',
            ),
          )
        const open = query
          ? Boolean(group.items.length)
          : (expandedGroups[group.id] ?? group.id === first)
        const section = disclosure(group.label, body, open)
        section.querySelector('summary')?.append(badge(group.items.length))
        section.addEventListener('toggle', () => {
          expandedGroups[group.id] = section.open
        })
        result.append(section)
      }
    } else
      result.append(
        match.length ? table(headers, match.slice(0, 150).map(row), label) : notice(empty),
      )
    count.textContent =
      !groups && match.length > 150
        ? `Showing 150 of ${match.length} matches. Narrow the filter to find more.`
        : `${match.length} of ${items.length} modules`
  }
  search.addEventListener('input', render)
  choices.addEventListener('change', render)
  host.append(controls, count, result)
  render()
}
