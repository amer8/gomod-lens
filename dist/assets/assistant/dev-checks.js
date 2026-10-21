import { LocalAI } from './local-ai.js'
import { models, catalogInfo } from './models.js'
import { checkCases, checkSuiteVersion } from './model-checks.js'

const byID = id => document.getElementById(id)
const run = byID('run'), stop = byID('stop'), download = byID('download'), status = byID('status'), progress = byID('progress')
const requested = new Set(new URLSearchParams(window.location.search).getAll('model'))
const selected = requested.size ? models.filter(model => requested.has(model.id)) : models
run.textContent = `Run ${selected.length} models`; run.disabled = !selected.length
const rows = new Map(), report = { runtimeVersion: catalogInfo.version, suiteVersion: checkSuiteVersion, userAgent: navigator.userAgent, results: [] }
let canceled = false, active = null, started = null
const ai = new LocalAI({ progress(text, value) {
  status.textContent = active.name + ': ' + text
  if (typeof value?.progress === 'number' && Number.isFinite(value.progress)) progress.value = Math.max(0, Math.min(1, value.progress))
  else progress.removeAttribute('value')
} })
for (const model of models) {
  const row = document.createElement('tr'), cells = [model.id, 'Not run', '—', '—', '—'].map(text => {
    const cell = document.createElement('td'); cell.textContent = text; row.append(cell); return cell
  })
  byID('models').append(row); rows.set(model.id, cells)
}
function showReport() { byID('report').textContent = JSON.stringify(report, null, 2); download.disabled = !report.results.length }
stop.addEventListener('click', () => { canceled = true; ai.stop(); stop.disabled = true; status.textContent = 'Stopping…' })
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'gomod-lens-model-checks.json'; link.click(); URL.revokeObjectURL(url)
})
run.addEventListener('click', async () => {
  run.disabled = true; stop.disabled = false; canceled = false; report.results = []; report.startedAt = new Date().toISOString(); delete report.finishedAt
  for (const model of models) {
    const cells = rows.get(model.id)
    cells[1].textContent = 'Not run'; delete cells[1].dataset.kind
    for (const cell of cells.slice(2)) cell.textContent = '—'
  }
  for (const model of selected) {
    if (canceled) break
    active = model; started = performance.now(); const cells = rows.get(model.id)
    cells[1].textContent = 'Loading'; progress.removeAttribute('value')
    try {
      await ai.enable(model.id, { timeout: 1200000 })
      cells[1].textContent = 'Checking'
      const result = await ai.validate(undefined, text => { status.textContent = model.name + ': ' + text })
      const passed = result.results.filter(item => item.passed).length
      cells[1].textContent = passed + '/' + checkCases.length + ' passed'; cells[1].dataset.kind = passed === checkCases.length ? 'passed' : 'failed'
      checkCases.forEach((item, index) => { cells[index + 2].textContent = result.results.find(value => value.id === item.id).passed ? 'Pass' : 'Fail' })
      report.results.push({ ...result, status: passed === checkCases.length ? 'passed' : 'failed', seconds: Math.round((performance.now() - started) / 1000) })
    } catch (error) {
      cells[1].textContent = canceled ? 'Canceled' : 'Could not run'; cells[1].dataset.kind = 'error'
      report.results.push({ modelID: model.id, status: canceled ? 'canceled' : 'error', error: error.message, checkedAt: new Date().toISOString(), seconds: Math.round((performance.now() - started) / 1000) })
    } finally { ai.stop(); showReport() }
  }
  report.finishedAt = new Date().toISOString(); showReport(); active = null; run.disabled = false; stop.disabled = true; progress.value = 1
  status.textContent = `${canceled ? 'Stopped' : 'Finished'}: ${report.results.length}/${selected.length} models attempted; ${report.results.filter(item => item.status === 'passed').length} passed all three checks.`
})
