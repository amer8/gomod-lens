const stages = [
  {
    value: 0,
    labels: ['Resolving module', 'Loading root module'],
    status: 'Reading module requirements',
    detail: 'Loading the selected module and its go.mod file.',
  },
  {
    value: 18,
    labels: ['Resolving dependencies'],
    status: 'Resolving dependencies',
    detail: 'Following module requirements and selecting dependency versions.',
  },
  {
    value: 78,
    labels: ['Building graph'],
    status: 'Building the dependency graph',
    detail: 'Connecting the resolved modules into a dependency graph.',
  },
  {
    value: 82,
    labels: ['Applying OpenSSF lens'],
    status: 'Checking security practices',
    detail: 'Loading OpenSSF Scorecard evidence for the graph.',
  },
  {
    value: 98,
    labels: ['Applying Release Freshness lens'],
    status: 'Checking release freshness',
    detail: 'Fetching published versions for the dependency graph.',
  },
]
const minimumStageDuration = 500

/** @param {HTMLElement} parent @param {string} selector */
function requiredElement(parent, selector) {
  const element = /** @type {HTMLElement | null} */ (parent.querySelector(selector))
  if (!element) throw new Error(`Graph loading view is missing ${selector}`)
  return element
}

/** @param {HTMLElement} container */
export function createGraphLoadingView(container) {
  const target = requiredElement(container, '#graph-loading-target')
  const status = requiredElement(container, '#graph-loading-status')
  const wait = requiredElement(container, '#graph-loading-wait')
  const stepElements = /** @type {NodeListOf<HTMLElement>} */ (
    container.querySelectorAll('[data-loading-step]')
  )
  const steps = [...stepElements].map((element) => ({
    element,
    marker: requiredElement(element, '.graph-loading-marker'),
    detail: requiredElement(element, '.graph-loading-detail'),
    status: requiredElement(element, '.graph-loading-step-status'),
  }))
  let active = false,
    stage = -1,
    reportedStage = -1,
    stageStartedAt = 0
  /** @type {number | undefined} */
  let waitTimer
  /** @type {number | null} */
  let stageTimer = null
  /** @type {Promise<void> | null} */
  let completion = null
  /** @type {(() => void) | null} */
  let resolveCompletion = null

  function clearTimers() {
    window.clearTimeout(waitTimer)
    window.clearTimeout(stageTimer ?? undefined)
    stageTimer = null
  }

  function complete() {
    resolveCompletion?.()
    resolveCompletion = null
  }

  function restartWaitTimer() {
    window.clearTimeout(waitTimer)
    wait.hidden = true
    waitTimer = window.setTimeout(() => {
      if (active) wait.hidden = false
    }, 15000)
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
    const remaining =
      stage < 0 ? 0 : minimumStageDuration - (window.performance.now() - stageStartedAt)
    if (remaining > 0) {
      stageTimer = window.setTimeout(() => {
        stageTimer = null
        advance()
      }, remaining)
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
    /** @param {string} moduleTarget */
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
    /** @param {{value?: number, label?: string}} [progress] */
    update({ value, label } = {}) {
      if (!active) return
      const done =
        (typeof value === 'number' && Number.isFinite(value) && value >= 100) || label === 'Done'
      let next = done
        ? stages.length
        : stages.findIndex((entry) => entry.labels.includes(label || ''))
      if (next < 0 && typeof value === 'number' && Number.isFinite(value))
        next = stages.findLastIndex((entry) => value >= entry.value)
      if (next < reportedStage) return
      reportedStage = next
      if (next < 0) status.textContent = label || 'Preparing analyzer…'
      advance()
    },
    finish() {
      if (!active || stage === stages.length) return Promise.resolve()
      completion ||= new Promise((resolve) => {
        resolveCompletion = resolve
      })
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
