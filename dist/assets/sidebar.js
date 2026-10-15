const panel = document.getElementById('left-panel')
const toggle = document.getElementById('sidebar-toggle')
if (panel && toggle) {
  function positionToggle() {
    const mobile = window.matchMedia('(max-width: 960px)').matches
    if (panel.hidden) {
      toggle.style.left = '0px'
      toggle.style.top = '50%'
      toggle.style.transform = 'translateY(-50%)'
    } else {
      const rect = panel.getBoundingClientRect()
      toggle.style.left = mobile ? '0px' : rect.right + 'px'
      toggle.style.top = mobile ? Math.max(0, rect.top - 32) + 'px' : rect.top + rect.height / 2 + 'px'
      toggle.style.transform = mobile ? 'none' : 'translateY(-50%)'
    }
  }
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    document.getElementById('app').classList.toggle('sidebar-collapsed', panel.hidden)
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
    const label = panel.hidden ? 'Show sidebar' : 'Hide sidebar'
    toggle.setAttribute('aria-label', label)
    toggle.title = label
    positionToggle()
  })
  new ResizeObserver(positionToggle).observe(panel)
  window.addEventListener('resize', positionToggle)
  positionToggle()
  toggle.disabled = false
}
