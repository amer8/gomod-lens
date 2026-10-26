import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { models, defaultModelID, findModel, sortModels, filterModels, catalogInfo, runtimeURL } from '../internal/app/web/static/assistant/models.js'
import { LocalAI } from '../internal/app/web/static/assistant/local-ai.js'

function browserGPU(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator })
}
function harness() {
  const workers = []
  const ai = new LocalAI({ workerFactory: () => {
    const worker = { terminated: false, messages: [], terminate() { this.terminated = true }, postMessage(value) { this.messages.push(value) }, settle(value = true) { this.onmessage({ data: { id: this.messages[0].id, value } }) } }
    workers.push(worker); return worker
  } })
  return { ai, workers }
}

test('catalog contains exactly the curated ten and excludes removed runtime variants', () => {
  const selection = JSON.parse(readFileSync(new URL('../tools/webllm-shortlist.json', import.meta.url), 'utf8'))
  assert.deepEqual(models.map(model => model.id), selection.map(model => model.id))
  assert.equal(models.length, 10)
  assert.equal(new Set(models.map(model => model.id)).size, 10)
  assert.equal(models.filter(model => model.recommended).length, 1)
  assert.equal(findModel(defaultModelID).recommended, true)
  assert.equal(catalogInfo.version, '0.2.86')
  assert.ok(runtimeURL.includes('@' + catalogInfo.version + '/'))
  assert.ok(models.every(model => model.url.startsWith('https://huggingface.co/mlc-ai/') && model.downloadBytes > 0 && model.gpuMB > 0 && model.contextTokens > 0))
  assert.ok(models.every(model => model.precision === 'q4f32_1' && model.contextTokens >= 4096 && model.selectionReason))
  assert.equal(new Set(models.map(model => model.name)).size, 10)
  assert.equal(findModel('Qwen2.5-1.5B-Instruct-q4f16_1-MLC'), undefined)
  assert.equal(findModel('DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC'), undefined)
  assert.equal(findModel('gemma-4-E2B-it-q4f32_1-MLC'), undefined)
  assert.equal(findModel('untrusted-model'), undefined)
})
test('every offered checkpoint has license information and Llama derivatives keep their base terms', () => {
  assert.ok(models.every(model => model.license?.name && model.license.url.startsWith('https://')))
  assert.equal(findModel(defaultModelID).license.name, 'Apache-2.0')
  assert.equal(findModel('Phi-4-mini-instruct-q4f32_1-MLC').license.name, 'MIT')
  for (const [id, version] of [['Llama-3.2-3B-Instruct-q4f32_1-MLC', '3.2'], ['Hermes-3-Llama-3.1-8B-q4f32_1-MLC', '3.1']]) {
    const { license } = findModel(id)
    assert.ok(license.attribution.includes('Built with Llama'))
    assert.ok(license.name.includes(version))
    assert.ok(license.policyURL.includes('llama' + version.replace('.', '_')))
  }
  const hermes = findModel('Hermes-3-Llama-3.1-8B-q4f32_1-MLC').license
  assert.ok(hermes.attribution.includes('Built with Meta Llama 3'))
  assert.ok(hermes.publisherLicense.url.endsWith('/llama3/LICENSE'))
  assert.ok(models.filter(model => !model.id.includes('Llama')).every(model => !model.license.attribution))
})
test('eject releases the worker and identity; another model loads with its own ID', async t => {
  browserGPU(t)
  const { ai, workers } = harness(); t.after(() => ai.stop())
  const first = ai.enable(); workers[0].settle(); await first
  assert.equal(ai.loadedModelID, defaultModelID)
  ai.stop()
  assert.equal(workers[0].terminated, true)
  assert.equal(ai.loadedModelID, null)
  assert.equal(ai.ready, false)
  const second = ai.enable(models[1].id)
  assert.equal(workers[1].messages[0].modelID, models[1].id)
  assert.equal(ai.ready, false)
  workers[1].settle(); await second
  assert.equal(ai.loadedModelID, models[1].id)
  await assert.rejects(ai.enable('untrusted-model'), /supported model/)
  assert.equal(workers.length, 2)
  assert.equal(ai.loadedModelID, models[1].id)
})
test('switching directly releases the active model before loading its replacement', async t => {
  browserGPU(t)
  const { ai, workers } = harness(); t.after(() => ai.stop())
  const first = ai.enable(models[3].id); workers[0].settle(); await first
  const switched = ai.enable(models[4].id)
  assert.equal(workers[0].terminated, true)
  assert.equal(ai.ready, false)
  assert.equal(ai.loadedModelID, null)
  assert.equal(workers[1].messages[0].modelID, models[4].id)
  workers[1].settle(); await switched
  assert.equal(ai.ready, true)
  assert.equal(ai.loadedModelID, models[4].id)
  assert.equal(workers.filter(worker => !worker.terminated).length, 1)
})
test('late canceled initialization cannot revive the old model or stop its replacement', async t => {
  browserGPU(t)
  const { ai, workers } = harness(); t.after(() => ai.stop())
  const old = ai.enable(); const rejected = assert.rejects(old, { name: 'AbortError' })
  ai.stop()
  const replacement = ai.enable(models[2].id)
  workers[0].settle(); await rejected
  assert.equal(workers[1].terminated, false)
  assert.equal(ai.ready, false)
  workers[1].settle(); await replacement
  assert.equal(ai.loadedModelID, models[2].id)
  assert.equal(ai.pending.size, 0)
})
test('failed loading leaves no worker or ready identity', async t => {
  browserGPU(t)
  const { ai, workers } = harness(); t.after(() => ai.stop())
  const load = ai.enable(models[3].id)
  workers[0].onmessage({ data: { id: workers[0].messages[0].id, error: 'Not enough GPU memory' } })
  await assert.rejects(load, /GPU memory/)
  assert.equal(workers[0].terminated, true)
  assert.equal(ai.loadedModelID, null)
  assert.equal(ai.worker, null)
  assert.equal(ai.ready, false)
  assert.equal(ai.pending.size, 0)
})

test('Qwen3 custom answers default to thinking and forward only active request status', async t => {
  browserGPU(t)
  const requests = [], statuses = []
  const worker = {
    terminate() {},
    postMessage(data) {
      requests.push(data)
      queueMicrotask(() => {
        if (data.type === 'init') this.onmessage({ data: { id: data.id, value: true } })
        else {
          this.onmessage({ data: { id: data.id, type: 'status', text: data.thinking ? 'Thinking…' : 'Writing an answer…' } })
          this.onmessage({ data: { id: data.id, value: { text: 'Visible final answer.' } } })
          this.onmessage({ data: { id: data.id, type: 'status', text: 'Late status must be ignored' } })
        }
      })
    },
  }
  const ai = new LocalAI({ workerFactory: () => worker }); t.after(() => ai.stop())
  await ai.enable('Qwen3-0.6B-q4f32_1-MLC')
  const packet = { facts: [], rootModule: 'root', selectedModule: 'root' }
  await ai.answer('Question', packet, [], undefined, undefined, { onStatus: text => statuses.push(text) })
  assert.equal(requests.at(-1).thinking, true)
  await ai.answer('Question', packet, [], undefined, undefined, { thinking: false, onStatus: text => statuses.push(text) })
  assert.equal(requests.at(-1).thinking, false)
  assert.deepEqual(statuses, ['Thinking…', 'Writing an answer…'])
  assert.equal(ai.pending.size, 0)
})

test('initialization progress keeps numeric values and ignores messages from an ejected worker', async t => {
  browserGPU(t)
  const reports = [], workers = []
  const ai = new LocalAI({ progress: (text, report) => reports.push({ text, ...report }), workerFactory: () => {
    const worker = { terminate() {}, postMessage(data) { this.id = data.id } }; workers.push(worker); return worker
  } }); t.after(() => ai.stop())
  const first = ai.enable(); const stopped = assert.rejects(first, { name: 'AbortError' })
  workers[0].onmessage({ data: { type: 'progress', text: 'Fetching weights', progress: 0.25, timeElapsed: 3 } })
  assert.deepEqual(reports, [{ text: 'Fetching weights', progress: 0.25, timeElapsed: 3 }])
  ai.stop(); await stopped
  const second = ai.enable(models[1].id)
  workers[0].onmessage({ data: { type: 'progress', text: 'Stale progress', progress: 1 } })
  assert.equal(reports.length, 1)
  workers[1].onmessage({ data: { id: workers[1].id, value: true } }); await second
})


test('numeric sorting compares bytes, GPU MB and context tokens with unknowns last in either direction', () => {
  const values = [
    { id: 'large', name: 'Model 10', downloadBytes: 2e9, gpuMB: 3000, contextTokens: 4096 },
    { id: 'small', name: 'Model 2', downloadBytes: 800e6, gpuMB: 900, contextTokens: 1024 },
    { id: 'unknown', name: 'Model 3', downloadBytes: null, gpuMB: null, contextTokens: null },
  ]
  for (const column of ['download', 'gpu', 'context']) {
    assert.deepEqual(sortModels(values, column).map(model => model.id), ['small', 'large', 'unknown'])
    assert.deepEqual(sortModels(values, column, 'descending').map(model => model.id), ['large', 'small', 'unknown'])
  }
  assert.deepEqual(sortModels(values, 'name').map(model => model.id), ['small', 'unknown', 'large'])
  assert.equal(values[0].id, 'large') // Sorting does not mutate catalog order.
  assert.throws(() => sortModels(values, 'untrusted-column'), /Unknown/)
})
test('search finds model families, precision and context variants without hiding supported models by default', () => {
  assert.equal(filterModels(models, '').length, 10)
  const variants = filterModels(models, 'Qwen3-0.6B q4f32')
  assert.equal(variants.length, 1)
  assert.equal(variants[0].id, 'Qwen3-0.6B-q4f32_1-MLC')
  assert.equal(filterModels(models, 'DEEPSEEK').length, 0)
  assert.equal(filterModels(models, 'Hermes').length, 1)
  assert.ok(filterModels(models, 'shader-f16').every(model => model.features.includes('shader-f16')))
  assert.deepEqual(filterModels(models, 'nonexistent-family'), [])
})
