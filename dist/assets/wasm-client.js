let runtimeReady = null
let runtimeRun = null

export async function resolveGraph(target, options = {}) {
  await ensureRuntime()
  return withAbort(window.gomodLensResolveGraph(String(target || ''), {
    signal: options.signal,
    onProgress: options.onProgress,
  }), options.signal)
}

export async function searchModules(query, limit = 6, signal = undefined) {
  await ensureRuntime()
  return withAbort(window.gomodLensSearchModules(String(query || ''), Number(limit) || 6, {
    signal,
  }), signal)
}

async function ensureRuntime() {
  if (runtimeReady) return runtimeReady

  runtimeReady = (async () => {
    if (typeof window.Go !== 'function') {
      throw new Error('Go WASM runtime did not load')
    }

    const go = new window.Go()
    const result = await instantiateWasm(go)
    runtimeRun = go.run(result.instance)
    runtimeRun.catch((error) => {
      runtimeReady = null
      console.error('go.mod Lens WASM runtime stopped', error)
    })
    await waitForRuntimeExports()
  })()

  return runtimeReady
}

async function instantiateWasm(go) {
  const wasmURL = './assets/gomod-lens.wasm'
  if (WebAssembly.instantiateStreaming) {
    try {
      return await WebAssembly.instantiateStreaming(fetch(wasmURL), go.importObject)
    } catch {
      // Local static servers often do not serve application/wasm; retry from bytes.
    }
  }

  const response = await fetch(wasmURL)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${wasmURL}`)
  }
  const bytes = await response.arrayBuffer()
  return WebAssembly.instantiate(bytes, go.importObject)
}

async function waitForRuntimeExports() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      window.gomodLensWASMReady &&
      typeof window.gomodLensResolveGraph === 'function' &&
      typeof window.gomodLensSearchModules === 'function'
    ) {
      return
    }
    await delay(10)
  }
  throw new Error('go.mod Lens WASM exports did not initialize')
}

function withAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(abortError())
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
