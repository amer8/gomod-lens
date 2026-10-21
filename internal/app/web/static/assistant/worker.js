import { generationOptions, AnswerStream, finalAnswer } from './generation.js'
import { models, findModel, catalogInfo } from './models.js'
import { chatMessages, planningInstructions, answerInstructions } from './prompts.js'
import { checkCases, checkSuiteVersion } from './model-checks.js'

let engine, modelID
async function planInvestigation(data) {
  const ids = Object.keys(data.topics)
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      topic: { type: 'integer', enum: ids.map((_, index) => index) },
      node: { type: 'integer', enum: data.nodes.map((_, index) => index) },
      followUps: { type: 'array', items: { type: 'integer', enum: ids.map((_, index) => index) }, minItems: 3, maxItems: 3 },
    }, required: ['topic', 'node', 'followUps'],
  }
  const user = JSON.stringify({ question: data.question.slice(0, 1200), investigations: ids.map((id, index) => ({ index, topic: id, description: data.topics[id] })), selected: data.nodes.findIndex(node => node.id === data.selected), modules: data.nodes.map((node, index) => ({ index, module: node.id })), alreadyAsked: data.asked.slice(-12) })
  const request = {
    messages: chatMessages(modelID, planningInstructions, user, [], { query: true }),
    ...generationOptions(modelID, { query: true }),
    response_format: { type: 'json_object', schema: JSON.stringify(schema) },
  }
  // Retry malformed constrained responses once, without inventing a plan.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await engine.chat.completions.create(request)
    try {
      const plan = JSON.parse(finalAnswer(response.choices[0].message.content))
      const validTopic = index => Number.isInteger(index) && index >= 0 && index < ids.length
      if (!validTopic(plan.topic) || !Number.isInteger(plan.node) || !data.nodes[plan.node] || !Array.isArray(plan.followUps) || plan.followUps.length !== 3 || !plan.followUps.every(validTopic)) throw new Error('Invalid investigation indices')
      return { topic: ids[plan.topic], nodeID: data.nodes[plan.node].id, followUps: plan.followUps.map(index => ids[index]) }
    } catch { if (attempt) throw new Error('The model could not interpret this question. Try rephrasing it.') }
  }
}
async function answer(data, emit = () => {}) {
  const options = generationOptions(modelID, { thinking: data.thinking !== false })
  const output = new AnswerStream({ expectThinking: findModel(modelID)?.alwaysThinking || options.extra_body?.enable_thinking === true })
  let phase = output.thinking ? 'Thinking…' : 'Writing an answer…', text = ''
  emit('status', phase)
  const stream = await engine.chat.completions.create({
    messages: chatMessages(modelID, answerInstructions, 'Facts for the selected module:\n' + data.evidence + '\n\nQuestion: ' + data.question, data.history),
    stream: true, ...options,
  })
  for await (const chunk of stream) {
    const visible = output.push(chunk.choices[0]?.delta?.content || '')
    const nextPhase = output.thinking ? 'Thinking…' : 'Writing an answer…'
    if (nextPhase !== phase) { phase = nextPhase; emit('status', phase) }
    if (visible !== text) { text = visible; emit('token', text) }
  }
  return output.finish()
}
// Cache inspection imports the runtime only. Weights load on explicit enable.
self.onmessage = async ({ data }) => {
  try {
    let value
    const emit = (type, text) => self.postMessage({ id: data.id, type, text })
    if (data.type === 'cache') {
      const { hasModelInCache } = await import(data.runtimeURL)
      value = []; let next = 0
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < models.length) {
          const model = models[next++]
          try { value.push({ id: model.id, cached: await hasModelInCache(model.id) }) }
          catch { value.push({ id: model.id, cached: null }) }
        }
      }))
    } else if (data.type === 'init') {
      if (!findModel(data.modelID)) throw new Error('Unsupported local model.')
      self.postMessage({ type: 'progress', text: 'Loading the WebLLM runtime…' })
      const { CreateMLCEngine } = await import(data.runtimeURL)
      self.postMessage({ type: 'progress', text: 'Preparing GPU and model files…' })
      engine = await CreateMLCEngine(data.modelID, {
        initProgressCallback: report => self.postMessage({ type: 'progress', text: report.text, progress: report.progress, timeElapsed: report.timeElapsed }),
      })
      modelID = data.modelID; value = true
    } else if (data.type === 'query' && engine) value = await planInvestigation(data)
    else if (data.type === 'answer' && engine) value = { text: await answer(data, emit) }
    else if (data.type === 'validate' && engine) {
      const results = []
      for (const [index, item] of checkCases.entries()) {
        emit('status', `Checking ${index + 1}/${checkCases.length}: ${item.label}…`)
        try {
          const result = item.kind === 'plan' ? await planInvestigation(item.data) : await answer(item.data)
          results.push({ id: item.id, passed: item.accepts(result) })
        } catch { results.push({ id: item.id, passed: false }) }
      }
      value = { modelID, runtimeVersion: catalogInfo.version, suiteVersion: checkSuiteVersion, results, checkedAt: new Date().toISOString() }
    } else throw new Error('Local AI is not ready.')
    self.postMessage({ id: data.id, value })
  } catch (error) { self.postMessage({ id: data.id, error: error.message || 'Local inference failed.' }) }
}
