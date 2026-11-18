/** @typedef {{name: string, count: number, href: string, ids?: string[], color?: string, nodesOnly?: boolean, dependencyCount?: number, title?: string, target?: string}} GroupEntry */
/** @typedef {{meta?: {target?: string}, viewModel?: {relationGroups?: GroupEntry[], originGroups?: GroupEntry[], nameEntries?: GroupEntry[]}}} SidebarPayload */
/** @typedef {{id?: string, className?: string, href?: string, title?: string, dataset?: Record<string, string | undefined>, style?: {backgroundColor?: string}}} Attributes */
/** @typedef {Node | string | number | null | undefined | (Node | string | number | null | undefined)[]} Child */

/** @param {SidebarPayload | null | undefined} payload */
export function renderSidebar(payload) {
  const viewModel = payload?.viewModel || {}
  const result = el('div', {
    id: 'graph-result',
    dataset: {
      state: 'loaded',
      target: payload?.meta?.target || '',
    },
  })
  const infoBox = el('div', { className: 'infoBox' })
  const packageInfo = el('div', { className: 'packageInfo' })

  packageInfo.append(groupSection('Relation groups', viewModel.relationGroups || [], highlightRow))

  packageInfo.append(
    groupSection('Module origins', viewModel.originGroups || [], highlightRow),
    groupSection('Dependency hubs', viewModel.nameEntries || [], nameRow),
  )

  infoBox.append(el('a', { className: 'hide-info-box', href: '#' }, 'show graph'), packageInfo)
  result.append(infoBox)
  return result
}

/** @param {string} lensID @param {GroupEntry[]} groups */
export function renderDistribution(lensID, groups) {
  return el(
    'details',
    { className: 'analysis-distribution' },
    el(
      'summary',
      {},
      lensID === 'release-freshness' ? 'Graph release distribution' : 'Graph score distribution',
    ),
    el('div', { className: 'license-container' }, groups.map(scoreRow)),
  )
}

/**
 * @param {string} title
 * @param {GroupEntry[]} entries
 * @param {(entry: GroupEntry) => HTMLElement} rowRenderer
 */
function groupSection(title, entries, rowRenderer) {
  const section = el('div', { className: 'all-licenses' })
  section.append(el('h4', {}, title))
  const container = el('div', { className: 'license-container' })
  entries.forEach((entry) => {
    container.append(rowRenderer(entry))
  })
  section.append(container)
  return section
}

/** @param {GroupEntry} entry */
function highlightRow(entry) {
  return el(
    'a',
    {
      className: 'license-row',
      href: entry.href,
      dataset: {
        highlightIds: JSON.stringify(entry.ids || []),
        highlightColor: entry.color || '',
        highlightNodesOnly: String(!!entry.nodesOnly),
      },
    },
    el('span', {}, entry.name),
    el('span', { className: 'last' }, String(entry.count)),
  )
}

/** @param {GroupEntry} entry */
function scoreRow(entry) {
  return el(
    'a',
    {
      className: 'license-row score-row',
      href: entry.href,
      dataset: {
        highlightIds: JSON.stringify(entry.ids || []),
        highlightColor: entry.color || '',
        highlightNodesOnly: String(!!entry.nodesOnly),
      },
    },
    el(
      'span',
      {},
      el('i', { className: 'score-swatch', style: { backgroundColor: entry.color } }),
      entry.name,
    ),
    el('span', { className: 'last' }, String(entry.count)),
  )
}

/** @param {GroupEntry} entry */
function nameRow(entry) {
  /** @type {Attributes} */
  const attrs = {
    className: 'license-row',
    href: entry.href,
    title: entry.title,
  }

  if (entry.count === 1) {
    attrs.dataset = { moduleTarget: entry.target }
  } else {
    attrs.dataset = {
      highlightIds: JSON.stringify(entry.ids || []),
      highlightColor: entry.color || '',
      highlightNodesOnly: String(!!entry.nodesOnly),
    }
  }

  return el(
    'a',
    attrs,
    el('span', { className: 'truncate' }, entry.name),
    el('span', { className: 'last module-dependency-count' }, String(entry.dependencyCount)),
  )
}

/** @param {string} tagName @param {Attributes} [attrs] @param {...Child} children */
function el(tagName, attrs = {}, ...children) {
  const node = document.createElement(tagName)
  const { dataset, style, ...rest } = attrs || {}

  Object.entries(rest).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    if (key === 'className') node.className = value
    else if (key === 'id') node.id = value
    else node.setAttribute(key, value)
  })

  if (dataset) {
    Object.entries(dataset).forEach(([key, value]) => {
      if (value !== undefined) node.dataset[key] = value
    })
  }

  if (style) {
    if (style.backgroundColor !== undefined) node.style.backgroundColor = style.backgroundColor
  }

  for (const child of children.flat()) {
    if (child === undefined || child === null) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }

  return node
}
