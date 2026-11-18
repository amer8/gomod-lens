/** @type {Promise<void> | null} */
let runtimeReady = null

/** @param {string} target @param {import('../wasm-globals').GraphOptions} [options] */
export async function loadGraph(target, options = {}) {
  await ensureRuntime()
  const payload = await withAbort(
    window.gomodLensResolveGraph(String(target || ''), {
      signal: options.signal,
      onProgress: options.onProgress,
    }),
    options.signal,
  )
  options.signal?.throwIfAborted()
  return payload
}

/** @param {string} query @param {number} [limit] @param {AbortSignal} [signal] */
export async function searchModules(query, limit = 6, signal = undefined) {
  await ensureRuntime()
  return withAbort(
    window.gomodLensSearchModules(String(query || ''), Number(limit) || 6, {
      signal,
    }),
    signal,
  )
}

/**
 * @param {import('../wasm-globals').GraphNode[]} nodes
 * @param {import('../wasm-globals').RequirementOptions} [options]
 */
export async function loadGoRequirements(nodes, { signal, refresh = false, onProgress } = {}) {
  signal?.throwIfAborted()
  await ensureRuntime()
  signal?.throwIfAborted()
  const identities = nodes.map(({ id, name, version, replaced, replacement }) => ({
    id,
    name,
    version,
    replaced,
    replacement,
  }))
  const payload = await withAbort(
    window.gomodLensLoadGoRequirements(JSON.stringify(identities), { signal, refresh, onProgress }),
    signal,
  )
  signal?.throwIfAborted()
  return payload
}

async function ensureRuntime() {
  if (runtimeReady) return runtimeReady

  runtimeReady = (async () => {
    if (typeof window.Go !== 'function') {
      throw new Error('Go WASM runtime did not load')
    }

    const go = new window.Go()
    const result = await instantiateWasm(go)
    const runtimeRun = go.run(result.instance)
    runtimeRun.catch((error) => {
      runtimeReady = null
      console.error('go.mod Lens WASM runtime stopped', error)
    })
    await waitForRuntimeExports()
  })()

  return runtimeReady
}

/** @param {{importObject: WebAssembly.Imports}} go */
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
      typeof window.gomodLensSearchModules === 'function' &&
      typeof window.gomodLensLoadGoRequirements === 'function'
    ) {
      return
    }
    await delay(10)
  }
  throw new Error('go.mod Lens WASM exports did not initialize')
}

/** @template T @param {Promise<T>} promise @param {AbortSignal} [signal] @returns {Promise<T>} */
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

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
