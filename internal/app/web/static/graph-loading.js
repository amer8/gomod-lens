const stages = [
  { value: 0, labels: ['Resolving module', 'Loading root module'], status: 'Reading module requirements', detail: 'Loading the selected module and its go.mod file.' },
  { value: 18, labels: ['Resolving dependencies'], status: 'Resolving dependencies', detail: 'Following module requirements and selecting dependency versions.' },
  { value: 78, labels: ['Building graph'], status: 'Building the dependency graph', detail: 'Connecting the resolved modules into a dependency graph.' },
  { value: 82, labels: ['Applying OpenSSF lens'], status: 'Checking security practices', detail: 'Loading OpenSSF Scorecard evidence for the graph.' },
  { value: 98, labels: ['Applying Release Freshness lens'], status: 'Checking release freshness', detail: 'Fetching published versions for the dependency graph.' },
]

export function createGraphLoadingView(container) {
  const target = container.querySelector('#graph-loading-target')
  const status = container.querySelector('#graph-loading-status')
  const wait = container.querySelector('#graph-loading-wait')
  const steps = [...container.querySelectorAll('[data-loading-step]')].map(element => ({
    element,
    marker: element.querySelector('.graph-loading-marker'),
    detail: element.querySelector('.graph-loading-detail'),
    status: element.querySelector('.graph-loading-step-status'),
  }))
  let active = false, stage = -1, timer = null

  function restartWaitTimer() {
    window.clearTimeout(timer)
    wait.hidden = true
    timer = window.setTimeout(() => { if (active) wait.hidden = false }, 15000)
  }

  function render() {
    steps.forEach((step, index) => {
      const complete = index < stage
      const current = index === stage
      step.element.dataset.state = complete ? 'complete' : current ? 'active' : 'pending'
      if (current) step.element.setAttribute('aria-current', 'step')
      else step.element.removeAttribute('aria-current')
      step.marker.textContent = complete ? '✓' : current ? '' : String(index + 1)
      step.detail.textContent = current ? stages[index].detail : ''
      step.status.textContent = complete ? 'Done' : current ? 'In progress' : ''
    })
  }

  return {
    show(moduleTarget) {
      active = true
      stage = -1
      target.textContent = moduleTarget
      container.dataset.state = 'preparing'
      status.textContent = 'Preparing analyzer…'
      render()
      restartWaitTimer()
      container.hidden = false
    },
    update({ value, label } = {}) {
      if (!active) return
      if ((Number.isFinite(value) && value >= 100) || label === 'Done') {
        stage = stages.length
        container.dataset.state = 'complete'
        status.textContent = 'Preparing visualization…'
        window.clearTimeout(timer)
        wait.hidden = true
        render()
        return
      }
      let next = stages.findIndex(entry => entry.labels.includes(label))
      if (next < 0 && Number.isFinite(value)) next = stages.findLastIndex(entry => value >= entry.value)
      if (next < stage) return
      if (next !== stage) {
        stage = next
        container.dataset.state = 'loading'
        restartWaitTimer()
        render()
      }
      status.textContent = stages[stage]?.status || label || 'Preparing analyzer…'
    },
    hide() {
      active = false
      window.clearTimeout(timer)
      wait.hidden = true
      container.hidden = true
    },
  }
}
