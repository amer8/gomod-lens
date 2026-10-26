const stages = [
  { value: 0, labels: ['Resolving module', 'Loading root module'], status: 'Reading module requirements', detail: 'Loading the selected module and its go.mod file.' },
  { value: 18, labels: ['Resolving dependencies'], status: 'Resolving dependencies', detail: 'Following module requirements and selecting dependency versions.' },
  { value: 78, labels: ['Building graph'], status: 'Building the dependency graph', detail: 'Connecting the resolved modules into a dependency graph.' },
  { value: 82, labels: ['Applying OpenSSF lens'], status: 'Checking security practices', detail: 'Loading OpenSSF Scorecard evidence for the graph.' },
  { value: 98, labels: ['Applying Release Freshness lens'], status: 'Checking release freshness', detail: 'Fetching published versions for the dependency graph.' },
]
const minimumStageDuration = 500

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
  let active = false, stage = -1, reportedStage = -1, stageStartedAt = 0
  let waitTimer = null, stageTimer = null, completion = null, resolveCompletion = null

  function clearTimers() {
    window.clearTimeout(waitTimer)
    window.clearTimeout(stageTimer)
    stageTimer = null
  }

  function complete() {
    resolveCompletion?.()
    resolveCompletion = null
  }

  function restartWaitTimer() {
    window.clearTimeout(waitTimer)
    wait.hidden = true
    waitTimer = window.setTimeout(() => { if (active) wait.hidden = false }, 15000)
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

  function advance() {
    if (!active || stage >= reportedStage || stageTimer !== null) return
    const remaining = stage < 0 ? 0 : minimumStageDuration - (window.performance.now() - stageStartedAt)
    if (remaining > 0) {
      stageTimer = window.setTimeout(() => { stageTimer = null; advance() }, remaining)
      return
    }
    stage++
    stageStartedAt = window.performance.now()
    container.dataset.state = stage === stages.length ? 'complete' : 'loading'
    status.textContent = stages[stage]?.status || 'Preparing visualization…'
    render()
    if (stage === stages.length) {
      window.clearTimeout(waitTimer)
      wait.hidden = true
      complete()
    } else {
      restartWaitTimer()
      advance()
    }
  }

  return {
    show(moduleTarget) {
      clearTimers()
      complete()
      completion = null
      active = true
      stage = reportedStage = -1
      target.textContent = moduleTarget
      container.dataset.state = 'preparing'
      status.textContent = 'Preparing analyzer…'
      render()
      restartWaitTimer()
      container.hidden = false
    },
    update({ value, label } = {}) {
      if (!active) return
      const done = (Number.isFinite(value) && value >= 100) || label === 'Done'
      let next = done ? stages.length : stages.findIndex(entry => entry.labels.includes(label))
      if (next < 0 && Number.isFinite(value)) next = stages.findLastIndex(entry => value >= entry.value)
      if (next < reportedStage) return
      reportedStage = next
      if (next < 0) status.textContent = label || 'Preparing analyzer…'
      advance()
    },
    finish() {
      if (!active || stage === stages.length) return Promise.resolve()
      completion ||= new Promise(resolve => { resolveCompletion = resolve })
      reportedStage = stages.length
      advance()
      return completion
    },
    hide() {
      active = false
      clearTimers()
      complete()
      wait.hidden = true
      container.hidden = true
    },
  }
}
