import test from 'node:test'
import assert from 'node:assert/strict'
import { loadingProgress, modelMarker } from '../internal/app/web/static/assistant/loading.js'
import { inspectModelCache } from '../internal/app/web/static/assistant/local-ai.js'
import { models } from '../internal/app/web/static/assistant/models.js'

test('loading percentages use real finite runtime values, with indeterminate preparation', () => {
  assert.deepEqual(loadingProgress('Importing runtime'), { text: 'Importing runtime', value: null, label: 'Preparing…' })
  for (const value of [undefined, NaN, Infinity, '0.5']) assert.equal(loadingProgress('Loading', { progress: value }).value, null)
  assert.deepEqual(loadingProgress('Loading weights', { progress: 0.425 }), { text: 'Loading weights', value: 0.425, label: '43%' })
  assert.equal(loadingProgress('Loading', { progress: -1 }).value, 0)
  assert.equal(loadingProgress('Loaded', { progress: 1.1 }).value, 1)
})
test('loaded, loading, and cached models remain distinct and unknown states get no marker', () => {
  const cached = new Map([['active', true], ['saved', true], ['missing', false], ['unknown', null]])
  const state = { loaded: 'active', loading: 'pending', cached }
  assert.equal(modelMarker('active', state).label, 'Loaded')
  assert.equal(modelMarker('pending', state).label, 'Loading')
  assert.equal(modelMarker('saved', state).label, 'Cached')
  for (const id of ['missing', 'unknown', 'unchecked']) assert.equal(modelMarker(id, state), null)
  assert.equal(modelMarker('active', { ...state, loaded: null }).label, 'Cached')
})
test('cache inspection returns only confirmed allowlisted hits and releases its worker', async () => {
  let worker
  const records = await inspectModelCache({ workerFactory: () => worker = {
    terminated: false,
    terminate() { this.terminated = true },
    postMessage(data) {
      assert.equal(data.type, 'cache')
      queueMicrotask(() => {
        this.onmessage({ data: { id: 99, value: [] } }) // Ignore unrelated responses.
        this.onmessage({ data: { id: data.id, value: [
          { id: models[0].id, cached: true }, { id: models[1].id, cached: false },
          { id: models[2].id, cached: 'true' }, { id: 'untrusted-model', cached: true },
        ] } })
      })
    },
  } })
  assert.equal(records.size, models.length)
  assert.equal(records.get(models[0].id), true)
  assert.equal(records.get(models[1].id), false)
  assert.equal(records.get(models[2].id), null)
  assert.equal(records.has('untrusted-model'), false)
  assert.equal(worker.terminated, true)
})
test('failed cache checks release their worker and never fabricate cached status', async () => {
  let worker
  await assert.rejects(inspectModelCache({ workerFactory: () => worker = {
    terminated: false,
    terminate() { this.terminated = true },
    postMessage() { queueMicrotask(() => this.onerror()) },
  } }), /unavailable/)
  assert.equal(worker.terminated, true)
})
