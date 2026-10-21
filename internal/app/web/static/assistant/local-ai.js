import { topicIDs, topics, validatePlan } from './queries.js'
import { checkedReport } from './model-checks.js'
import { evidenceText } from './custom.js'
import { defaultModelID, findModel, models, runtimeURL } from './models.js'

export const modelID = defaultModelID
export { runtimeURL }

// Read the runtime's real cache state in a short-lived worker, without loading
// model weights or allocating a GPU. Unknown results must not become cache hits.
export async function inspectModelCache({ workerFactory = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), timeout = 20000 } = {}) {
  const worker = workerFactory()
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value) }
      const timer = setTimeout(() => finish(new Error('Model cache check timed out.')), timeout)
      worker.onerror = () => finish(new Error('Model cache is unavailable.'))
      worker.onmessage = ({ data }) => {
        if (data.id !== 1) return
        if (data.error || !Array.isArray(data.value)) { finish(new Error('Model cache is unavailable.')); return }
        const records = new Map(models.map(model => [model.id, null]))
        for (const record of data.value) if (records.has(record.id) && typeof record.cached === 'boolean') records.set(record.id, record.cached)
        finish(null, records)
      }
      try { worker.postMessage({ type: 'cache', id: 1, runtimeURL }) }
      catch (error) { finish(error) }
    })
  } finally { worker.terminate() }
}

export class LocalAI {
  constructor({ workerFactory = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), progress = () => {} } = {}) {
    this.workerFactory = workerFactory; this.progress = progress; this.pending = new Map(); this.next = 0; this.ready = false; this.loadedModelID = null; this.worker = null
  }
  async enable(selectedID = defaultModelID, { timeout = 300000 } = {}) {
    if (!findModel(selectedID)) throw new Error('Choose a supported model from the comparison table.')
    if (!globalThis.navigator?.gpu) throw new Error('WebGPU is unavailable in this browser. Chat requires a WebGPU-capable browser.')
    this.stop()
    const worker = this.worker = this.workerFactory()
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return
      if (data.type === 'progress') { this.progress(data.text || 'Loading local AI…', { progress: data.progress, timeElapsed: data.timeElapsed }); return }
      if (data.type === 'status') { this.pending.get(data.id)?.onStatus?.(data.text); return }
      if (data.type === 'token') { this.pending.get(data.id)?.onText?.(data.text); return }
      const pending = this.pending.get(data.id)
      if (pending) { data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.value); pending.cleanup() }
    }
    worker.onerror = () => { if (this.worker === worker) this.stop(new Error('Local AI could not start. Reload the model to chat.')) }
    try {
      await this.request('init', { runtimeURL, modelID: selectedID }, { timeout })
      if (this.worker !== worker) throw new DOMException('Stopped', 'AbortError')
      this.loadedModelID = selectedID; this.ready = true
    } catch (error) {
      // A canceled load may settle after another model has started loading.
      if (this.worker === worker) this.stop(error)
      throw error
    }
  }
  async interpret(question, context, asked, signal) {
    if (!this.ready) throw new Error('Load the local model before asking a question.')
    const value = await this.request('query', {
      question, topics, asked,
      selected: context.selected,
      nodes: [...new Map([
        ...context.graph.nodes.filter(node => node.id === context.selected || question.toLowerCase().includes(node.name.toLowerCase())),
        ...context.graph.nodes.slice(0, 40),
      ].map(node => [node.id, { id: node.id }])).values()],
    }, { signal, timeout: 45000 })
    const plan = validatePlan(value, context.graph)
    plan.followUps = [...new Set(Array.isArray(value.followUps) ? value.followUps : [])].filter(id => topicIDs.includes(id) && id !== plan.topic)
    return plan
  }
  async answer(question, packet, history, signal, onText, { thinking = true, onStatus } = {}) {
    if (!this.ready) throw new Error('Load the local model before asking a question.')
    const enabled = Boolean(findModel(this.loadedModelID)?.alwaysThinking || (thinking && findModel(this.loadedModelID)?.thinking))
    const value = await this.request('answer', { question: question.slice(0, 1200), evidence: evidenceText(packet.facts), rootModule: packet.rootModule, selectedModule: packet.selectedModule, history, thinking: enabled }, { signal, timeout: enabled ? 180000 : 90000, onText, onStatus })
    if (typeof value?.text !== 'string' || !value.text.trim()) throw new Error('The local model returned an empty answer. Try rephrasing your question.')
    return value.text.trim().slice(0, 8000)
  }
  async validate(signal, onStatus) {
    if (!this.ready) throw new Error('Load the model before running checks.')
    const selected = this.loadedModelID
    const report = await this.request('validate', {}, { signal, timeout: 240000, onStatus })
    return checkedReport(report, selected)
  }
  request(type, payload, { signal, timeout, onText, onStatus } = {}) {
    signal?.throwIfAborted()
    if (!this.worker) return Promise.reject(new Error('Local AI is not enabled.'))
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const abort = () => this.stop(signal.reason || new DOMException('Stopped', 'AbortError'))
      const timer = setTimeout(() => this.stop(new Error('Local AI timed out. Reload the model and try again.')), timeout)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id) }
      this.pending.set(id, { resolve, reject, cleanup, onText, onStatus })
      signal?.addEventListener('abort', abort, { once: true })
      this.worker.postMessage({ id, type, ...payload })
    })
  }
  stop(reason = new DOMException('Stopped', 'AbortError')) {
    this.ready = false; this.loadedModelID = null; this.worker?.terminate(); this.worker = null
    for (const pending of [...this.pending.values()]) { pending.reject(reason); pending.cleanup() }
  }
}
