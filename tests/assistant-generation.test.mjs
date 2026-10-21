import test from 'node:test'
import assert from 'node:assert/strict'
import { models } from '../internal/app/web/static/assistant/models.js'
import { AnswerStream, finalAnswer, generationOptions } from '../internal/app/web/static/assistant/generation.js'

const qwen3 = 'Qwen3-0.6B-q4f32_1-MLC'
const qwen25 = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'

test('thinking is automatic for supported custom answers, with a separate bounded budget', () => {
  assert.equal(generationOptions(qwen3).extra_body.enable_thinking, true)
  const enabled = generationOptions(qwen3, { thinking: true })
  assert.equal(enabled.extra_body.enable_thinking, true)
  assert.equal(generationOptions(qwen3, { thinking: false }).extra_body.enable_thinking, false)
  assert.ok(enabled.max_tokens > generationOptions(qwen3, { thinking: false }).max_tokens)
  assert.ok(enabled.max_tokens < 4096)
  assert.equal(generationOptions(qwen3, { query: true, thinking: true }).extra_body.enable_thinking, false)
  assert.equal(generationOptions(qwen3, { query: true }).max_tokens, 384)
  assert.equal(generationOptions(qwen25, { thinking: true }).extra_body, undefined)
  assert.equal(generationOptions(qwen25).max_tokens, 192)
})
test('reasoning and split tag fragments never appear in streamed visible text', () => {
  const raw = '<think>PRIVATE_REASONING</think>Final answer.'
  // Test every two-chunk boundary and character-by-character delivery.
  for (let split = 0; split <= raw.length; split++) {
    const output = new AnswerStream()
    for (const chunk of [raw.slice(0, split), raw.slice(split)]) {
      const visible = output.push(chunk)
      assert.ok('Final answer.'.startsWith(visible))
      assert.doesNotMatch(visible, /PRIVATE|think|<|>/)
    }
    assert.equal(output.finish(), 'Final answer.')
  }
  const output = new AnswerStream()
  for (const character of raw) assert.ok('Final answer.'.startsWith(output.push(character)))
  assert.equal(output.finish(), 'Final answer.')
})
test('empty template blocks, multiple blocks, nested blocks, and plain answers are handled', () => {
  assert.equal(finalAnswer('<think>\n\n</think>\n\nAnswer'), 'Answer')
  assert.equal(finalAnswer('One <think>hidden</think>two <think>other</think>three'), 'One two three')
  assert.equal(finalAnswer('<think>outer <think>nested</think> outer</think>Answer'), 'Answer')
  assert.equal(finalAnswer('Plain < 4 is fine.'), 'Plain < 4 is fine.')
  const output = new AnswerStream({ expectThinking: true })
  output.push('<thi'); assert.equal(output.thinking, true)
  output.push('nk>PRIVATE'); assert.equal(output.text, '')
  output.push('</think>Answer'); assert.equal(output.thinking, false)
  assert.equal(output.finish(), 'Answer')
})
test('truncated thinking fails closed and keeps discarded content out of memory', () => {
  for (const raw of ['<think>PRIVATE', '<think>', 'PRIVATE without an opening tag']) {
    const output = new AnswerStream({ expectThinking: true })
    assert.equal(output.push(raw), '')
    assert.throws(() => output.finish(), /final answer/)
  }
  const output = new AnswerStream({ expectThinking: true })
  output.push('<think>' + 'private '.repeat(10000))
  assert.equal(output.text, '')
  assert.ok(output.buffer.length < 8)
  output.push('</think>Answer')
  assert.equal(output.finish(), 'Answer')
})
test('JSON planning strips the runtime empty thinking prefix before parsing', () => {
  const value = { topic: 'licenses', nodeID: 'root', followUps: ['paths', 'selected', 'unknown'] }
  assert.deepEqual(JSON.parse(finalAnswer('<think>\n\n</think>\n\n' + JSON.stringify(value))), value)
})

test('actual worker emits final-answer tokens and status, but never hidden reasoning', async t => {
  const originalSelf = globalThis.self, originalEngine = globalThis.assistantTestEngine
  const messages = [], requests = []
  globalThis.self = { postMessage(value) { messages.push(value) } }
  const engine = globalThis.assistantTestEngine = { chat: { completions: { async create(request) {
    requests.push(request)
    if (!request.stream) return { choices: [{ message: { content: '<think>\n</think>\n{"topic":0,"node":0,"followUps":[1,2,3]}' } }] }
    return (async function* () { for (const content of ['<thi', 'nk>PRIVATE_REASONING', '</thi', 'nk>Answer [R].']) yield { choices: [{ delta: { content } }] } })()
  } } } }
  t.after(() => { if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf; if (originalEngine === undefined) delete globalThis.assistantTestEngine; else globalThis.assistantTestEngine = originalEngine })
  await import('../internal/app/web/static/assistant/worker.js?generation-test')
  const handler = globalThis.self.onmessage
  const runtimeURL = 'data:text/javascript,' + encodeURIComponent('export async function CreateMLCEngine(id, options){options.initProgressCallback({text:"Loading weights",progress:0.42,timeElapsed:2});return globalThis.assistantTestEngine} export async function hasModelInCache(id){if(id.includes("0.5B"))throw new Error("Storage unavailable");return id.includes("1.5B")}')
  await handler({ data: { type: 'cache', id: 7, runtimeURL } })
  const cached = messages.find(value => value.id === 7).value
  assert.equal(cached.length, models.length)
  assert.equal(cached.find(value => value.id === qwen25).cached, true)
  assert.equal(cached.find(value => value.id.includes('0.5B')).cached, null)
  assert.equal(requests.length, 0) // Cache inspection never invokes inference.
  await handler({ data: { type: 'init', id: 1, modelID: qwen3, runtimeURL } })
  assert.ok(messages.some(value => value.type === 'progress' && value.progress === 0.42 && value.timeElapsed === 2))
  await handler({ data: { type: 'query', id: 2, question: 'Which modules use ISC?', topics: { licenses: 'License inventory', paths: 'Paths', unknown: 'Unknown', selected: 'Selected' }, nodes: [{ id: 'root' }], selected: 'root', asked: [], thinking: true } })
  assert.equal(requests[0].extra_body.enable_thinking, false)
  assert.equal(requests[0].temperature, 0)
  assert.equal(messages.find(value => value.id === 2).value.topic, 'licenses')
  await handler({ data: { type: 'answer', id: 3, question: 'Where is the repository?', evidence: '[R] repository URL', history: [] } })
  assert.equal(requests[1].extra_body.enable_thinking, true)
  assert.equal(messages.find(value => value.id === 3 && value.value).value.text, 'Answer [R].')
  assert.ok(messages.some(value => value.id === 3 && value.type === 'status' && value.text === 'Thinking…'))
  assert.ok(messages.some(value => value.id === 3 && value.type === 'token' && value.text === 'Answer [R].'))
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_REASONING|<think>|<thi/)
  // A malformed constrained response gets one fresh inference, without a fallback plan.
  let attempts = 0
  engine.chat.completions.create = async () => ({ choices: [{ message: { content: ++attempts === 1 ? '{"topic":' : '{"topic":0,"node":0,"followUps":[1,2,3]}' } }] })
  const query = { type: 'query', question: 'Which dependency has ISC license?', topics: { licenses: 'Licenses', paths: 'Paths', unknown: 'Unknown', selected: 'Selected' }, nodes: [{ id: 'root' }], selected: 'root', asked: [] }
  await handler({ data: { ...query, id: 5 } })
  assert.equal(attempts, 2)
  assert.equal(messages.find(value => value.id === 5).value.topic, 'licenses')
  attempts = 0
  engine.chat.completions.create = async () => { attempts++; return { choices: [{ message: { content: '{"topic":' } }] } }
  await handler({ data: { ...query, id: 6 } })
  assert.equal(attempts, 2)
  assert.match(messages.find(value => value.id === 6).error, /could not interpret/)
  assert.equal(messages.find(value => value.id === 6).value, undefined)
  // Exhaustion while thinking must become an error rather than an empty success.
  engine.chat.completions.create = async () => (async function* () { yield { choices: [{ delta: { content: '<think>PRIVATE_REASONING' }, finish_reason: 'length' }] } })()
  await handler({ data: { type: 'answer', id: 4, question: '?', evidence: '', history: [], thinking: true } })
  assert.match(messages.find(value => value.id === 4 && value.error).error, /final answer/)
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_REASONING/)
})


test('removed reasoning models cannot be selected, while their output markers remain safely filtered', () => {
  for (const id of ['DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC', 'Ministral-3-3B-Reasoning-2512-q4f32_1-MLC']) {
    assert.throws(() => generationOptions(id), /Unsupported/)
  }
  const raw = '[THINK]private[/THINK]Answer'
  for (let split = 0; split <= raw.length; split++) {
    const stream = new AnswerStream({ expectThinking: true })
    for (const chunk of [raw.slice(0, split), raw.slice(split)]) assert.ok('Answer'.startsWith(stream.push(chunk)))
    assert.equal(stream.finish(), 'Answer')
  }
  assert.equal(finalAnswer(raw), 'Answer')
})
