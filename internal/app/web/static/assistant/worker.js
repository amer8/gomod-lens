import { generationOptions, AnswerStream, finalAnswer } from './generation.js'
import { models, findModel, catalogInfo, runtimeURL, pinnedModelConfig } from './models.js'
import { chatMessages, planningInstructions, answerInstructions } from './prompts.js'
import { checkCases, checkSuiteVersion } from './model-checks.js'

/** @typedef {{question: string, topics: Record<string, string>, nodes: {id: string}[], selected: string, asked: string[]}} PlanningData */
/** @typedef {{question: string, evidence: {label: string, detail: string}[], previousQuestions: string[], thinking: boolean}} AnswerData */
/** @typedef {{id: number, type: 'cache'}} CacheRequest */
/** @typedef {{id: number, type: 'init', modelID: string}} InitRequest */
/** @typedef {{id: number, type: 'interrupt'}} InterruptRequest */
/** @typedef {{id: number, type: 'query'} & PlanningData} QueryRequest */
/** @typedef {{id: number, type: 'answer'} & AnswerData} AnswerRequest */
/** @typedef {{id: number, type: 'validate'}} ValidationRequest */
/** @typedef {CacheRequest | InitRequest | InterruptRequest | QueryRequest | AnswerRequest | ValidationRequest} WorkerRequest */
/** @typedef {{choices: {message: {content: string}}[]}} Completion */
/** @typedef {{choices: {delta?: {content?: string}}[]}} CompletionChunk */
/** @typedef {(request: {stream: true, messages: ReturnType<typeof chatMessages>}) => Promise<AsyncIterable<CompletionChunk>>} StreamCompletion */
/** @typedef {{response_format: {type: string, schema: string}, messages: ReturnType<typeof chatMessages>}} StructuredRequest */
/** @typedef {(request: StructuredRequest) => Promise<Completion>} StructuredCompletion */
/** @typedef {{interruptGenerate(): void, chat: {completions: {create: StreamCompletion & StructuredCompletion}}}} Engine */
/** @typedef {{text?: string, progress?: number, timeElapsed?: number}} InitProgress */
/** @typedef {import('./models.js').ModelConfig} ModelConfig */
/** @typedef {{prebuiltAppConfig: ModelConfig, hasModelInCache(id: string, appConfig: ModelConfig): Promise<boolean>, CreateMLCEngine(id: string, options: {appConfig: ModelConfig, initProgressCallback: (report: InitProgress) => void}): Promise<Engine>}} Runtime */
/** @typedef {{onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null, postMessage: (message: unknown) => void}} WorkerScope */
const worker = /** @type {WorkerScope} */ (/** @type {unknown} */ (self))
/** @type {Engine | null} */
let engine = null
let modelID = ''
/** @type {Map<number, AbortController>} */
const generations = new Map()
/** @type {number | null} */
let activeID = null
let generationDone = Promise.resolve()

function activeEngine() {
  if (!engine) throw new Error('Local AI is not ready.')
  return engine
}

/** @param {PlanningData} data @param {AbortSignal} [signal] */
async function planInvestigation(data, signal) {
  const ids = Object.keys(data.topics)
  const question = data.question.slice(0, 1200)
  // A catalog question already identifies its topic. Follow-ups still use the full catalog.
  /** @param {string} text */
  const normalize = (text) => text.trim().toLowerCase().replace(/[?!.]+$/, '')
  const normalized = normalize(question)
  const canonicalTopic = ids.find((id) => normalize(data.topics[id]) === normalized)
  const allowedTopics = canonicalTopic ? [canonicalTopic] : ids
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      topic: { type: 'string', enum: allowedTopics },
      node: { type: 'integer', enum: data.nodes.map((_, index) => index) },
      followUps: {
        type: 'array',
        items: { type: 'string', enum: ids },
        minItems: 3,
        maxItems: 3,
      },
    },
    required: ['topic', 'node', 'followUps'],
  }
  const user = JSON.stringify({
    question,
    investigations: data.topics,
    selected: data.nodes.findIndex((node) => node.id === data.selected),
    modules: data.nodes.map((node, index) => ({ index, module: node.id })),
    alreadyAsked: data.asked.slice(-12),
  })
  const request = {
    messages: chatMessages(modelID, planningInstructions, user, { query: true }),
    ...generationOptions(modelID, { query: true }),
    response_format: { type: 'json_object', schema: JSON.stringify(schema) },
  }
  // Retry malformed constrained responses once, without inventing a plan.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await activeEngine().chat.completions.create(request)
    signal?.throwIfAborted()
    try {
      const plan = /** @type {unknown} */ (
        JSON.parse(finalAnswer(response.choices[0].message.content))
      )
      /** @param {unknown} id @returns {id is string} */
      const validTopic = (id) => typeof id === 'string' && ids.includes(id)
      if (
        !plan ||
        typeof plan !== 'object' ||
        !('topic' in plan) ||
        !('node' in plan) ||
        !('followUps' in plan)
      )
        throw new Error('Invalid investigation plan')
      const followUps = Array.isArray(plan.followUps)
        ? /** @type {unknown[]} */ (plan.followUps)
        : []
      if (
        typeof plan.topic !== 'string' ||
        !allowedTopics.includes(plan.topic) ||
        typeof plan.node !== 'number' ||
        !Number.isInteger(plan.node) ||
        !data.nodes[plan.node] ||
        followUps.length !== 3 ||
        !followUps.every(validTopic)
      )
        throw new Error('Invalid investigation plan')
      return {
        topic: plan.topic,
        nodeID: data.nodes[plan.node].id,
        followUps,
      }
    } catch {
      if (attempt)
        throw new Error('The model could not interpret this question. Try rephrasing it.')
    }
  }
}
/** @param {AnswerData} data @param {(type: 'status' | 'token', text: string) => void} [emit] @param {AbortSignal} [signal] */
async function answer(data, emit = () => {}, signal) {
  const options = generationOptions(modelID, { thinking: data.thinking !== false })
  const output = new AnswerStream({
    expectThinking:
      findModel(modelID)?.alwaysThinking || options.extra_body?.enable_thinking === true,
  })
  let phase = output.thinking ? 'Thinking…' : 'Writing an answer…',
    text = ''
  emit('status', phase)
  const stream = await activeEngine().chat.completions.create({
    messages: chatMessages(
      modelID,
      answerInstructions,
      JSON.stringify({
        question: data.question,
        previousQuestions: data.previousQuestions,
        observations: data.evidence,
      }),
    ),
    stream: true,
    ...options,
  })
  signal?.throwIfAborted()
  for await (const chunk of stream) {
    signal?.throwIfAborted()
    const visible = output.push(chunk.choices[0]?.delta?.content || '')
    const nextPhase = output.thinking ? 'Thinking…' : 'Writing an answer…'
    if (nextPhase !== phase) {
      phase = nextPhase
      emit('status', phase)
    }
    if (visible !== text) {
      text = visible
      emit('token', text)
    }
  }
  return output.finish()
}
/** @param {QueryRequest | AnswerRequest} data @param {(type: 'status' | 'token', text: string) => void} emit */
function generate(data, emit) {
  const controller = new AbortController()
  generations.set(data.id, controller)
  // WebLLM's interrupt flag is engine-wide. Start the next turn only after the
  // interrupted stream (or planner retry) has released the engine.
  const result = generationDone
    .then(async () => {
      controller.signal.throwIfAborted()
      activeID = data.id
      return data.type === 'query'
        ? planInvestigation(data, controller.signal)
        : { text: await answer(data, emit, controller.signal) }
    })
    .finally(() => {
      if (activeID === data.id) activeID = null
      generations.delete(data.id)
    })
  generationDone = result.then(
    () => {},
    () => {},
  )
  return result
}
// Cache inspection imports the runtime only. Weights load on explicit enable.
/** @param {MessageEvent<WorkerRequest>} event @param {() => Promise<Runtime>} [loadRuntime] */
export async function handleRequest({ data }, loadRuntime = () => import(runtimeURL)) {
  try {
    let value
    /** @param {'status' | 'token'} type @param {string} text */
    const emit = (type, text) => worker.postMessage({ id: data.id, type, text })
    if (data.type === 'interrupt') {
      generations.get(data.id)?.abort()
      if (activeID === data.id) engine?.interruptGenerate()
      return
    }
    if (data.type === 'cache') {
      const { hasModelInCache, prebuiltAppConfig } = await loadRuntime()
      const appConfig = pinnedModelConfig(prebuiltAppConfig)
      /** @type {{id: string, cached: boolean | null}[]} */
      const records = []
      let next = 0
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          while (next < models.length) {
            const model = models[next++]
            try {
              records.push({ id: model.id, cached: await hasModelInCache(model.id, appConfig) })
            } catch {
              records.push({ id: model.id, cached: null })
            }
          }
        }),
      )
      value = records
    } else if (data.type === 'init') {
      if (!findModel(data.modelID)) throw new Error('Unsupported local model.')
      worker.postMessage({ type: 'progress', text: 'Loading the WebLLM runtime…' })
      const { CreateMLCEngine, prebuiltAppConfig } = await loadRuntime()
      worker.postMessage({ type: 'progress', text: 'Preparing GPU and model files…' })
      engine = await CreateMLCEngine(data.modelID, {
        appConfig: pinnedModelConfig(prebuiltAppConfig),
        initProgressCallback: (report) =>
          worker.postMessage({
            type: 'progress',
            text: report.text,
            progress: report.progress,
            timeElapsed: report.timeElapsed,
          }),
      })
      modelID = data.modelID
      value = true
    } else if ((data.type === 'query' || data.type === 'answer') && engine)
      value = await generate(data, emit)
    else if (data.type === 'validate' && engine) {
      const results = []
      for (const [index, item] of checkCases.entries()) {
        emit('status', `Checking ${index + 1}/${checkCases.length}: ${item.label}…`)
        try {
          const result =
            item.kind === 'plan' ? await planInvestigation(item.data) : await answer(item.data)
          results.push({ id: item.id, passed: item.accepts(result) })
        } catch {
          results.push({ id: item.id, passed: false })
        }
      }
      value = {
        modelID,
        runtimeVersion: catalogInfo.version,
        suiteVersion: checkSuiteVersion,
        results,
        checkedAt: new Date().toISOString(),
      }
    } else throw new Error('Local AI is not ready.')
    worker.postMessage({ id: data.id, value })
  } catch (error) {
    worker.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : 'Local inference failed.',
    })
  }
}
worker.onmessage = handleRequest
