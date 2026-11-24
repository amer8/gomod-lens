export class Element extends EventTarget {
  constructor(tagName = '') {
    super()
    this.tagName = tagName
    this.value = ''
    this.children = []
    this.parentElement = null
    this.dataset = {}
    this.attributes = new Map()
    this.className = ''
    this.hidden = false
    this.textContent = ''
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean))
        const added = force ?? !classes.has(name)
        if (added) classes.add(name)
        else classes.delete(name)
        this.className = [...classes].join(' ')
        return added
      },
    }
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this
      this.children.push(node)
    }
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.parentElement = this
      this.children.unshift(node)
    }
  }
  replaceChildren(...nodes) {
    this.children.forEach((node) => {
      node.parentElement = null
    })
    this.children = []
    this.append(...nodes)
  }
  insertBefore(node, before) {
    node.parentElement = this
    this.children.splice(this.children.indexOf(before), 0, node)
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }
  remove() {
    if (!this.parentElement) return
    const siblings = this.parentElement.children
    siblings.splice(siblings.indexOf(this), 1)
    this.parentElement = null
  }
  focus() {}
  matches(selector) {
    if (selector === this.tagName) return true
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1))
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    const attribute = /^\[data-([\w-]+)\]$/.exec(selector)
    return Boolean(
      attribute &&
      attribute[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase()) in this.dataset,
    )
  }
  querySelectorAll(selector) {
    return this.children.flatMap((node) => [
      ...(node.matches(selector) ? [node] : []),
      ...node.querySelectorAll(selector),
    ])
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null
  }
}
