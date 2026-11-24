import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  models,
  defaultModelID,
  findModel,
  sortModels,
  filterModels,
  catalogInfo,
  runtimeURL,
  pinnedModelConfig,
} from '../internal/app/web/static/assistant/models.js'
import { prebuiltAppConfig, verifyIntegrity } from '../internal/app/web/static/vendor/web-llm-0.2.89.js'
import { LocalAI } from '../internal/app/web/static/assistant/local-ai.js'

function browserGPU(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  })
}
function harness() {
  const workers = []
  const ai = new LocalAI({
    workerFactory: () => {
      const worker = {
        terminated: false,
        messages: [],
        terminate() {
          this.terminated = true
        },
        postMessage(value) {
          this.messages.push(value)
        },
        settle(value = true) {
          this.onmessage({ data: { id: this.messages[0].id, value } })
        },
      }
      workers.push(worker)
      return worker
    },
  })
  return { ai, workers }
}

test('every curated model keeps its upstream configuration and requires matching library bytes', async () => {
  assert.throws(() => pinnedModelConfig({ model_list: [] }), /Missing pinned library/)
  for (const record of pinnedModelConfig(prebuiltAppConfig).model_list) {
    const original = prebuiltAppConfig.model_list.find((item) => item.model_id === record.model_id)
    assert.equal(record.model_lib.split('/').at(-1), original.model_lib.split('/').at(-1))
    assert.equal(record.model, original.model)
    assert.deepEqual(record.overrides, original.overrides)
    await assert.rejects(
      verifyIntegrity(new Uint8Array([0]), record.integrity.model_lib, record.model_lib, record.integrity.onFailure),
      { name: 'IntegrityError' },
    )
  }
})

test('catalog contains exactly the curated ten and excludes removed runtime variants', () => {
  const selection = JSON.parse(
    readFileSync(new URL('../tools/webllm-shortlist.json', import.meta.url), 'utf8'),
  )
  assert.deepEqual(
    models.map((model) => model.id),
    selection.map((model) => model.id),
  )
  assert.equal(models.length, 10)
  assert.equal(new Set(models.map((model) => model.id)).size, 10)
  assert.equal(models.filter((model) => model.recommended).length, 1)
  assert.equal(findModel(defaultModelID).recommended, true)
  assert.equal(catalogInfo.version, '0.2.89')
  assert.equal(
    runtimeURL,
    new URL(`../internal/app/web/static/vendor/web-llm-${catalogInfo.version}.js`, import.meta.url)
      .href,
  )
  assert.ok(
    models.every(
      (model) =>
        model.url.startsWith('https://huggingface.co/mlc-ai/') &&
        model.downloadBytes > 0 &&
        model.gpuMB > 0 &&
        model.contextTokens > 0,
    ),
  )
  assert.ok(
    models.every(
      (model) =>
        model.precision === 'q4f32_1' && model.contextTokens >= 4096 && model.selectionReason,
    ),
  )
  assert.equal(new Set(models.map((model) => model.name)).size, 10)
  assert.equal(findModel('Qwen2.5-1.5B-Instruct-q4f16_1-MLC'), undefined)
  assert.equal(findModel('DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC'), undefined)
  assert.equal(findModel('gemma-4-E2B-it-q4f32_1-MLC'), undefined)
  assert.equal(findModel('untrusted-model'), undefined)
})
test('shortlisted metadata matches the catalog shipped in the pinned WebLLM bundle', async () => {
  const { prebuiltAppConfig, functionCallingModelIds, ModelType } = await import(runtimeURL)
  for (const model of models) {
    const matches = prebuiltAppConfig.model_list.filter((record) => record.model_id === model.id)
    assert.equal(matches.length, 1, model.id)
    const [record] = matches
    assert.equal(model.url, record.model, model.id)
    assert.equal(model.gpuMB, record.vram_required_MB, model.id)
    assert.equal(model.contextTokens, record.overrides?.context_window_size, model.id)
    assert.deepEqual(model.features, record.required_features ?? [], model.id)
    assert.equal(model.vision, record.model_type === ModelType.VLM, model.id)
    assert.equal(model.nativeTools, functionCallingModelIds.includes(model.id), model.id)
    assert.equal(model.manifest, record.model_manifest ?? null, model.id)
  }
})
test('every offered checkpoint has license information and Llama derivatives keep their base terms', () => {
  assert.ok(
    models.every((model) => model.license?.name && model.license.url.startsWith('https://')),
  )
  assert.equal(findModel(defaultModelID).license.name, 'Apache-2.0')
  assert.equal(findModel('Phi-4-mini-instruct-q4f32_1-MLC').license.name, 'MIT')
  for (const [id, version] of [
    ['Llama-3.2-3B-Instruct-q4f32_1-MLC', '3.2'],
    ['Hermes-3-Llama-3.1-8B-q4f32_1-MLC', '3.1'],
  ]) {
    const { license } = findModel(id)
    assert.ok(license.attribution.includes('Built with Llama'))
    assert.ok(license.name.includes(version))
    assert.ok(license.policyURL.includes('llama' + version.replace('.', '_')))
  }
  const hermes = findModel('Hermes-3-Llama-3.1-8B-q4f32_1-MLC').license
  assert.ok(hermes.attribution.includes('Built with Meta Llama 3'))
  assert.ok(hermes.publisherLicense.url.endsWith('/llama3/LICENSE'))
  assert.ok(
    models
      .filter((model) => !model.id.includes('Llama'))
      .every((model) => !model.license.attribution),
  )
})
test('eject releases the worker and identity; another model loads with its own ID', async (t) => {
  browserGPU(t)
  const { ai, workers } = harness()
  t.after(() => ai.stop())
  const first = ai.enable()
  workers[0].settle()
  await first
  assert.equal(ai.loadedModelID, defaultModelID)
  ai.stop()
  assert.equal(workers[0].terminated, true)
  assert.equal(ai.loadedModelID, null)
  assert.equal(ai.ready, false)
  const second = ai.enable(models[1].id)
  assert.equal(workers[1].messages[0].modelID, models[1].id)
  assert.equal(ai.ready, false)
  workers[1].settle()
  await second
  assert.equal(ai.loadedModelID, models[1].id)
  await assert.rejects(ai.enable('untrusted-model'), /supported model/)
  assert.equal(workers.length, 2)
  assert.equal(ai.loadedModelID, models[1].id)
})
test('switching directly releases the active model before loading its replacement', async (t) => {
  browserGPU(t)
  const { ai, workers } = harness()
  t.after(() => ai.stop())
  const first = ai.enable(models[3].id)
  workers[0].settle()
  await first
  const switched = ai.enable(models[4].id)
  assert.equal(workers[0].terminated, true)
  assert.equal(ai.ready, false)
  assert.equal(ai.loadedModelID, null)
  assert.equal(workers[1].messages[0].modelID, models[4].id)
  workers[1].settle()
  await switched
  assert.equal(ai.ready, true)
  assert.equal(ai.loadedModelID, models[4].id)
  assert.equal(workers.filter((worker) => !worker.terminated).length, 1)
})
test('late canceled initialization cannot revive the old model or stop its replacement', async (t) => {
  browserGPU(t)
  const { ai, workers } = harness()
  t.after(() => ai.stop())
  const old = ai.enable()
  const rejected = assert.rejects(old, { name: 'AbortError' })
  ai.stop()
  const replacement = ai.enable(models[2].id)
  workers[0].settle()
  await rejected
  assert.equal(workers[1].terminated, false)
  assert.equal(ai.ready, false)
  workers[1].settle()
  await replacement
  assert.equal(ai.loadedModelID, models[2].id)
  assert.equal(ai.pending.size, 0)
})
test('failed loading leaves no worker or ready identity', async (t) => {
  browserGPU(t)
  const { ai, workers } = harness()
  t.after(() => ai.stop())
  const load = ai.enable(models[3].id)
  workers[0].onmessage({ data: { id: workers[0].messages[0].id, error: 'Not enough GPU memory' } })
  await assert.rejects(load, /GPU memory/)
  assert.equal(workers[0].terminated, true)
  assert.equal(ai.loadedModelID, null)
  assert.equal(ai.worker, null)
  assert.equal(ai.ready, false)
  assert.equal(ai.pending.size, 0)
})

test('inference timeout interrupts one request and tears down only if the worker stays hung', async (t) => {
  browserGPU(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ai, workers } = harness()
  t.after(() => ai.stop())
  const load = ai.enable()
  const worker = workers[0]
  worker.settle()
  await load
  for (const responsive of [true, false]) {
    const answer = ai.request('answer', {}, { timeout: 50 })
    const { id } = worker.messages.at(-1)
    t.mock.timers.tick(50)
    await assert.rejects(answer, /timed out/)
    assert.deepEqual(worker.messages.at(-1), { type: 'interrupt', id })
    assert.equal(ai.ready, true)
    if (responsive) worker.onmessage({ data: { id, error: 'Interrupted' } })
    t.mock.timers.tick(10000)
    assert.equal(worker.terminated, !responsive)
    assert.equal(ai.ready, responsive)
    assert.equal(ai.pending.size, 0)
  }
})

test('malformed worker messages do not settle or stream an active request', async (t) => {
  browserGPU(t)
  const { ai, workers } = harness()
  t.after(() => ai.stop())
  const loading = ai.enable(),
    worker = workers[0]
  worker.onmessage({ data: null })
  worker.onmessage({ data: { id: '1', value: true } })
  assert.equal(ai.pending.size, 1)
  worker.settle()
  await loading
  const received = []
  const pending = ai.request('answer', {}, { onText: (text) => received.push(text) })
  const id = worker.messages.at(-1).id
  worker.onmessage({ data: { id, type: 'token', text: { invalid: true } } })
  assert.deepEqual(received, [])
  worker.onmessage({ data: { id, value: 'done' } })
  assert.equal(await pending, 'done')
})

test('Qwen3 custom answers default to thinking and forward only active request status', async (t) => {
  browserGPU(t)
  const requests = [],
    statuses = []
  const worker = {
    terminate() {},
    postMessage(data) {
      requests.push(data)
      queueMicrotask(() => {
        if (data.type === 'init') this.onmessage({ data: { id: data.id, value: true } })
        else {
          this.onmessage({
            data: {
              id: data.id,
              type: 'status',
              text: data.thinking ? 'Thinking…' : 'Writing an answer…',
            },
          })
          this.onmessage({ data: { id: data.id, value: { text: 'Visible final answer.' } } })
          this.onmessage({
            data: { id: data.id, type: 'status', text: 'Late status must be ignored' },
          })
        }
      })
    },
  }
  const ai = new LocalAI({ workerFactory: () => worker })
  t.after(() => ai.stop())
  await ai.enable('Qwen3-0.6B-q4f32_1-MLC')
  const packet = { evidence: [], rootModule: 'root', selectedModule: 'root' }
  await ai.answer('Question', packet, [], undefined, undefined, {
    onStatus: (text) => statuses.push(text),
  })
  assert.equal(requests.at(-1).thinking, true)
  await ai.answer('Question', packet, [], undefined, undefined, {
    thinking: false,
    onStatus: (text) => statuses.push(text),
  })
  assert.equal(requests.at(-1).thinking, false)
  assert.deepEqual(statuses, ['Thinking…', 'Writing an answer…'])
  assert.equal(ai.pending.size, 0)
})

test('initialization progress keeps numeric values and ignores messages from an ejected worker', async (t) => {
  browserGPU(t)
  const reports = [],
    workers = []
  const ai = new LocalAI({
    progress: (text, report) => reports.push({ text, ...report }),
    workerFactory: () => {
      const worker = {
        terminate() {},
        postMessage(data) {
          this.id = data.id
        },
      }
      workers.push(worker)
      return worker
    },
  })
  t.after(() => ai.stop())
  const first = ai.enable()
  const stopped = assert.rejects(first, { name: 'AbortError' })
  workers[0].onmessage({
    data: { type: 'progress', text: 'Fetching weights', progress: 0.25, timeElapsed: 3 },
  })
  assert.deepEqual(reports, [{ text: 'Fetching weights', progress: 0.25, timeElapsed: 3 }])
  ai.stop()
  await stopped
  const second = ai.enable(models[1].id)
  workers[0].onmessage({ data: { type: 'progress', text: 'Stale progress', progress: 1 } })
  assert.equal(reports.length, 1)
  workers[1].onmessage({ data: { id: workers[1].id, value: true } })
  await second
})

test('numeric sorting compares bytes, GPU MB and context tokens with unknowns last in either direction', () => {
  const values = [
    { id: 'large', name: 'Model 10', downloadBytes: 2e9, gpuMB: 3000, contextTokens: 4096 },
    { id: 'small', name: 'Model 2', downloadBytes: 800e6, gpuMB: 900, contextTokens: 1024 },
    { id: 'unknown', name: 'Model 3', downloadBytes: null, gpuMB: null, contextTokens: null },
  ]
  for (const column of ['download', 'gpu', 'context']) {
    assert.deepEqual(
      sortModels(values, column).map((model) => model.id),
      ['small', 'large', 'unknown'],
    )
    assert.deepEqual(
      sortModels(values, column, 'descending').map((model) => model.id),
      ['large', 'small', 'unknown'],
    )
  }
  assert.deepEqual(
    sortModels(values, 'name').map((model) => model.id),
    ['small', 'unknown', 'large'],
  )
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
  assert.ok(
    filterModels(models, 'shader-f16').every((model) => model.features.includes('shader-f16')),
  )
  assert.deepEqual(filterModels(models, 'nonexistent-family'), [])
})
