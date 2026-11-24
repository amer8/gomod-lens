import { topicIDs, topics, validatePlan } from './queries.js'
import { checkedReport } from './model-checks.js'
import { defaultModelID, findModel, models, runtimeURL } from './models.js'

export const modelID = defaultModelID
export { runtimeURL }

/** @typedef {{resolve: (value: unknown) => void, reject: (reason?: unknown) => void, cleanup: () => void, onText?: (text: string) => void, onStatus?: (status: string) => void}} PendingRequest */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// A blob worker inherits the page's CSP on static hosts without header configuration.
// Share one bootstrap URL for the lifetime of this document, including cache checks.
let workerURL = ''
function createAssistantWorker() {
  if (!workerURL) {
    const entry = new URL('./worker.js', import.meta.url)
    const source = new Blob([`import ${JSON.stringify(entry.href)}`], { type: 'text/javascript' })
    workerURL = URL.createObjectURL(source)
  }
  return new Worker(workerURL, { type: 'module' })
}

// Read the runtime's real cache state in a short-lived worker, without loading
// model weights or allocating a GPU. Unknown results must not become cache hits.
/**
 * @param {{workerFactory?: () => Worker, timeout?: number}} [options]
 * @returns {Promise<Map<string, boolean | null>>}
 */
export async function inspectModelCache({
  workerFactory = createAssistantWorker,
  timeout = 20000,
} = {}) {
  const worker = workerFactory()
  try {
    return await new Promise((resolve, reject) => {
      /** @param {unknown} error @param {Map<string, boolean | null>} [value] */
      const finish = (error, value) => {
        clearTimeout(timer)
        error
          ? reject(error)
          : value
            ? resolve(value)
            : reject(new Error('Model cache is unavailable.'))
      }
      const timer = setTimeout(() => finish(new Error('Model cache check timed out.')), timeout)
      worker.onerror = () => finish(new Error('Model cache is unavailable.'))
      worker.onmessage = ({ data }) => {
        const message = /** @type {unknown} */ (data)
        if (!object(message) || message.id !== 1) return
        if (message.error || !Array.isArray(message.value)) {
          finish(new Error('Model cache is unavailable.'))
          return
        }
        /** @type {Map<string, boolean | null>} */
        const records = new Map(models.map((model) => [model.id, null]))
        for (const record of /** @type {unknown[]} */ (message.value))
          if (
            object(record) &&
            typeof record.id === 'string' &&
            records.has(record.id) &&
            typeof record.cached === 'boolean'
          )
            records.set(record.id, record.cached)
        finish(null, records)
      }
      try {
        worker.postMessage({ type: 'cache', id: 1 })
      } catch (error) {
        finish(error)
      }
    })
  } finally {
    worker.terminate()
  }
}

export class LocalAI {
  /** @param {{workerFactory?: () => Worker, progress?: (text: string, report: {progress?: unknown, timeElapsed?: unknown}) => void, onFailure?: (message: string) => void}} [options] */
  constructor({
    workerFactory = createAssistantWorker,
    progress = () => {},
    onFailure = () => {},
  } = {}) {
    this.workerFactory = workerFactory
    this.progress = progress
    this.onFailure = onFailure
    /** @type {Map<number, PendingRequest>} */
    this.pending = new Map()
    this.next = 0
    this.ready = false
    /** @type {string | null} */
    this.loadedModelID = null
    /** @type {Worker | null} */
    this.worker = null
  }
  /** @param {string} [selectedID] @param {{timeout?: number}} [options] */
  async enable(selectedID = defaultModelID, { timeout = 300000 } = {}) {
    if (!findModel(selectedID))
      throw new Error('Choose a supported model from the comparison table.')
    if (!globalThis.navigator || !('gpu' in globalThis.navigator) || !globalThis.navigator.gpu)
      throw new Error(
        'WebGPU is unavailable in this browser. Chat requires a WebGPU-capable browser.',
      )
    this.stop()
    const worker = (this.worker = this.workerFactory())
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return
      const message = /** @type {unknown} */ (data)
      if (!object(message)) return
      if (message.type === 'progress') {
        this.progress((typeof message.text === 'string' && message.text) || 'Loading local AI…', {
          progress: message.progress,
          timeElapsed: message.timeElapsed,
        })
        return
      }
      if (typeof message.id !== 'number') return
      if (message.type === 'status') {
        if (typeof message.text === 'string') this.pending.get(message.id)?.onStatus?.(message.text)
        return
      }
      if (message.type === 'token') {
        if (typeof message.text === 'string') this.pending.get(message.id)?.onText?.(message.text)
        return
      }
      const pending = this.pending.get(message.id)
      if (pending) {
        message.error
          ? pending.reject(new Error(String(message.error)))
          : pending.resolve(message.value)
        pending.cleanup()
      }
    }
    worker.onerror = () => {
      if (this.worker === worker) this.fail('Local AI worker failed. Reload the model to chat.')
    }
    try {
      await this.request('init', { modelID: selectedID }, { timeout })
      if (this.worker !== worker) throw new DOMException('Stopped', 'AbortError')
      this.loadedModelID = selectedID
      this.ready = true
    } catch (error) {
      // A canceled load may settle after another model has started loading.
      if (this.worker === worker) this.stop(error)
      throw error
    }
  }
  /**
   * @param {string} question
   * @param {import('../../assistant-types').Context} context
   * @param {string[]} asked
   * @param {AbortSignal} [signal]
   */
  async interpret(question, context, asked, signal) {
    if (!this.ready) throw new Error('Load the local model before asking a question.')
    const value = await this.request(
      'query',
      {
        question,
        topics,
        asked,
        selected: context.selected,
        nodes: [
          ...new Map(
            [
              ...context.graph.nodes.filter(
                (node) =>
                  node.id === context.selected ||
                  question.toLowerCase().includes(node.name.toLowerCase()),
              ),
              ...context.graph.nodes.slice(0, 40),
            ].map((node) => [node.id, { id: node.id }]),
          ).values(),
        ],
      },
      { signal, timeout: 45000 },
    )
    const plan = validatePlan(value, context.graph)
    const followUps =
      value && typeof value === 'object' && 'followUps' in value && Array.isArray(value.followUps)
        ? /** @type {unknown[]} */ (value.followUps)
        : []
    return {
      ...plan,
      followUps: [...new Set(followUps.filter((id) => typeof id === 'string'))].filter(
        (id) => topicIDs.includes(id) && id !== plan.topic,
      ),
    }
  }
  /**
   * @param {string} question
   * @param {ReturnType<typeof import('./custom.js').customPacket>} packet
   * @param {{question: string}[]} history
   * @param {AbortSignal} [signal]
   * @param {(text: string) => void} [onText]
   * @param {{thinking?: boolean, onStatus?: (status: string) => void}} [options]
   */
  async answer(question, packet, history, signal, onText, { thinking = true, onStatus } = {}) {
    if (!this.ready) throw new Error('Load the local model before asking a question.')
    const enabled = Boolean(
      findModel(this.loadedModelID)?.alwaysThinking ||
        (thinking && findModel(this.loadedModelID)?.thinking),
    )
    const value = await this.request(
      'answer',
      {
        question: question.slice(0, 1200),
        evidence: packet.evidence,
        rootModule: packet.rootModule,
        selectedModule: packet.selectedModule,
        previousQuestions: history.map((turn) => turn.question),
        thinking: enabled,
      },
      { signal, timeout: enabled ? 180000 : 90000, onText, onStatus },
    )
    if (
      !value ||
      typeof value !== 'object' ||
      !('text' in value) ||
      typeof value.text !== 'string' ||
      !value.text.trim()
    )
      throw new Error('The local model returned an empty answer. Try rephrasing your question.')
    return value.text.trim().slice(0, 8000)
  }
  /** @param {AbortSignal} [signal] @param {(status: string) => void} [onStatus] */
  async validate(signal, onStatus) {
    if (!this.ready) throw new Error('Load the model before running checks.')
    const selected = this.loadedModelID
    const report = await this.request('validate', {}, { signal, timeout: 240000, onStatus })
    return checkedReport(report, selected)
  }
  /**
   * @param {string} type
   * @param {Record<string, unknown>} payload
   * @param {{signal?: AbortSignal, timeout?: number, onText?: (text: string) => void, onStatus?: (status: string) => void}} [options]
   * @returns {Promise<unknown>}
   */
  request(type, payload, { signal, timeout, onText, onStatus } = {}) {
    signal?.throwIfAborted()
    if (!this.worker) return Promise.reject(new Error('Local AI is not enabled.'))
    const id = ++this.next,
      worker = this.worker
    return new Promise((resolve, reject) => {
      const abort = () => cancel(signal?.reason || new DOMException('Stopped', 'AbortError'))
      let timer = setTimeout(() => cancel(new Error('Local AI timed out. Try again.')), timeout)
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
      }
      const pending = { resolve, reject, cleanup, onText, onStatus }
      /** @param {unknown} reason */
      const cancel = (reason) => {
        if (type !== 'answer' && type !== 'query') {
          this.stop(reason)
          return
        }
        // Reject immediately. Keep the entry until the worker finishes unwinding.
        reject(reason)
        pending.onText = pending.onStatus = undefined
        signal?.removeEventListener('abort', abort)
        clearTimeout(timer)
        timer = setTimeout(
          () => this.fail('Local AI stopped responding. Reload the model to chat.'),
          10000,
        )
        try {
          worker.postMessage({ type: 'interrupt', id })
        } catch {
          this.fail('Local AI worker failed. Reload the model to chat.')
        }
      }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        worker.postMessage({ id, type, ...payload })
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }
  /** @param {string} message */
  fail(message) {
    this.stop(new Error(message))
    this.onFailure(message)
  }
  /** @param {unknown} [reason] */
  stop(reason = new DOMException('Stopped', 'AbortError')) {
    this.ready = false
    this.loadedModelID = null
    this.worker?.terminate()
    this.worker = null
    for (const pending of [...this.pending.values()]) {
      pending.reject(reason)
      pending.cleanup()
    }
  }
}
