import test from 'node:test'
import assert from 'node:assert/strict'
import { createLensTooltip } from '../internal/app/web/static/analysis/lens-tooltip.js'

test('lens tooltip responds to pointer, focus, dismissal and non-node related targets', (t) => {
  class Element extends EventTarget {
    constructor() {
      super()
      this.hidden = false
      this.isConnected = true
      this.attributes = new Map()
      this.style = { setProperty() {} }
      this.children = []
    }
    append(child) {
      this.children.push(child)
    }
    setAttribute(name, value) {
      this.attributes.set(name, value)
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null
    }
    removeAttribute(name) {
      this.attributes.delete(name)
    }
    closest(selector) {
      return selector === '.lens-circle' && this.circle ? this : null
    }
    contains(node) {
      return node === this || this.children.includes(node)
    }
    getBoundingClientRect() {
      return { left: 40, width: 20, bottom: 30 }
    }
  }
  const document = new EventTarget(),
    window = new EventTarget()
  document.createElement = () => new Element()
  window.innerWidth = 500
  for (const [name, value] of Object.entries({ document, window, Node: Element, Element })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name],
    )
  }
  const toolbar = new Element(),
    host = new Element(),
    button = new Element()
  button.circle = true
  button.setAttribute('aria-label', 'Release Freshness')
  const reset = createLensTooltip(toolbar, host),
    tooltip = host.children[0]
  const send = (target, type, properties = {}) => {
    const event = new Event(type, { cancelable: true })
    for (const [key, value] of Object.entries(properties))
      Object.defineProperty(event, key, { value })
    target.dispatchEvent(event)
    return event
  }

  send(toolbar, 'pointerover', { target: button })
  assert.equal(tooltip.hidden, false)
  assert.equal(tooltip.textContent, 'Release Freshness')
  assert.equal(button.getAttribute('aria-describedby'), 'lens-name-tooltip')
  send(toolbar, 'pointerout', { relatedTarget: window })
  assert.equal(tooltip.hidden, true)
  send(toolbar, 'focusin', { target: button })
  assert.equal(tooltip.hidden, false)
  const escape = send(document, 'keydown', { key: 'Escape' })
  assert.equal(escape.defaultPrevented, true)
  assert.equal(tooltip.hidden, true)
  assert.equal(button.getAttribute('aria-describedby'), null)
  reset()
})
