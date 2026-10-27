import test from 'node:test'
import assert from 'node:assert/strict'

test('WASM client shares initialization and forwards graph, search, progress and cancellation', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const graph = { nodes: [{ id: 'root' }] }, results = [{ path: 'example.org/module' }]
  const controller = new AbortController(), progress = () => {}, requests = []
  let runs = 0, fetches = 0, finishPending
  const window = {
    Go: class {
      importObject = {}
      run() {
        runs++
        window.gomodLensWASMReady = true
        window.gomodLensResolveGraph = (target, options) => {
          requests.push({ target, options })
          return target === 'pending' ? new Promise(resolve => { finishPending = resolve }) : Promise.resolve(graph)
        }
        window.gomodLensSearchModules = async (query, limit, options) => {
          assert.equal(query, 'a/b'); assert.equal(limit, 6); assert.equal(options.signal, controller.signal)
          return results
        }
        window.gomodLensLoadGoRequirements = async (nodes, options) => {
          assert.deepEqual(JSON.parse(nodes), [{ id: 'root', name: 'example.org/root', version: 'v1.0.0' }])
          assert.equal(options.signal, controller.signal)
          assert.equal(options.refresh, true)
          options.onProgress({ done: 1, total: 1 })
          return { records: { root: { status: 'observed', minimum: '1.26' } } }
        }
        return new Promise(() => {})
      }
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window)
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, './assets/gomod-lens.wasm'); fetches++
    return new Response('wasm bytes')
  })
  t.mock.method(WebAssembly, 'instantiateStreaming', async response => {
    await response
    return { instance: {} }
  })
  const client = await import('../internal/app/web/static/wasm-client.js?static-client-test')
  assert.deepEqual(await Promise.all([
    client.loadGraph('example.org/mod@v1.0.0', { signal: controller.signal, onProgress: progress }),
    client.searchModules('a/b', 6, controller.signal),
  ]), [graph, results])
  assert.equal(runs, 1); assert.equal(fetches, 1)
  assert.equal(requests[0].target, 'example.org/mod@v1.0.0')
  assert.equal(requests[0].options.signal, controller.signal)
  assert.equal(requests[0].options.onProgress, progress)
  let metadataProgress
  assert.equal((await client.loadGoRequirements([{ id: 'root', name: 'example.org/root', version: 'v1.0.0', lenses: { unrelated: true } }], {
    signal: controller.signal, refresh: true, onProgress: value => { metadataProgress = value },
  })).records.root.minimum, '1.26')
  assert.deepEqual(metadataProgress, { done: 1, total: 1 })
  const loading = client.loadGraph('pending', { signal: controller.signal })
  await new Promise(setImmediate)
  controller.abort()
  await assert.rejects(loading, { name: 'AbortError' })
  finishPending(graph)
})
