import { element } from './ui.js'

// One tooltip for the compact lens toolbar. Delegation survives graph reloads.
export function createLensTooltip(toolbar, host) {
  const tooltip = element('div', '', 'lens-name-tooltip')
  tooltip.id = 'lens-name-tooltip'; tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip')
  host.append(tooltip)
  let hovered = null, focused = null, active = null, dismissed = false
  const control = target => target?.closest?.('.lens-circle') || null
  function hide() {
    active?.removeAttribute('aria-describedby'); active = null; tooltip.hidden = true
  }
  function render() {
    const next = hovered || focused
    if (dismissed || !next?.isConnected || toolbar.hidden) { hide(); return }
    if (active !== next) { hide(); active = next; active.setAttribute('aria-describedby', tooltip.id) }
    tooltip.textContent = next.getAttribute('aria-label')
    tooltip.hidden = false
    const rect = next.getBoundingClientRect(), box = tooltip.getBoundingClientRect()
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 12))
    tooltip.style.left = left + 'px'; tooltip.style.top = rect.bottom + 12 + 'px'
    tooltip.style.setProperty('--tooltip-arrow-x', Math.max(12, Math.min(box.width - 12, rect.left + rect.width / 2 - left)) + 'px')
  }
  toolbar.addEventListener('pointerover', event => {
    const next = control(event.target)
    if (next && next !== hovered) { hovered = next; dismissed = false; render() }
  })
  toolbar.addEventListener('pointerout', event => {
    if (hovered?.contains(event.relatedTarget) || tooltip.contains(event.relatedTarget)) return
    hovered = null; render()
  })
  tooltip.addEventListener('pointerleave', event => { hovered = control(event.relatedTarget); render() })
  toolbar.addEventListener('focusin', event => { focused = control(event.target); dismissed = false; render() })
  toolbar.addEventListener('focusout', event => { focused = control(event.relatedTarget); render() })
  toolbar.addEventListener('click', () => { dismissed = true; hide() })
  // Escape must also work when the pointer opened a tooltip outside keyboard focus.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || tooltip.hidden) return
    event.preventDefault(); event.stopPropagation(); dismissed = true; hide()
  }, true)
  window.addEventListener('resize', () => { if (!tooltip.hidden) render() })
  return () => { hovered = null; focused = null; dismissed = false; hide() }
}
