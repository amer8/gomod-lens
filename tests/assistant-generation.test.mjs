import test from 'node:test'
import assert from 'node:assert/strict'
import { models } from '../internal/app/web/static/assistant/models.js'
import {
  AnswerStream,
  finalAnswer,
  generationOptions,
} from '../internal/app/web/static/assistant/generation.js'

const qwen3 = 'Qwen3-0.6B-q4f32_1-MLC'
const qwen25 = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'

test('thinking is automatic for supported custom answers, with a separate bounded budget', () => {
  assert.equal(generationOptions(qwen3).extra_body.enable_thinking, true)
  const enabled = generationOptions(qwen3, { thinking: true })
  assert.equal(enabled.extra_body.enable_thinking, true)
  assert.equal(generationOptions(qwen3, { thinking: false }).extra_body.enable_thinking, false)
  assert.ok(enabled.max_tokens > generationOptions(qwen3, { thinking: false }).max_tokens)
  assert.ok(enabled.max_tokens < 4096)
  assert.equal(
    generationOptions(qwen3, { query: true, thinking: true }).extra_body.enable_thinking,
    false,
  )
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
  assert.equal(
    finalAnswer('One <think>hidden</think>two <think>other</think>three'),
    'One two three',
  )
  assert.equal(finalAnswer('<think>outer <think>nested</think> outer</think>Answer'), 'Answer')
  assert.equal(finalAnswer('Plain < 4 is fine.'), 'Plain < 4 is fine.')
  const output = new AnswerStream({ expectThinking: true })
  output.push('<thi')
  assert.equal(output.thinking, true)
  output.push('nk>PRIVATE')
  assert.equal(output.text, '')
  output.push('</think>Answer')
  assert.equal(output.thinking, false)
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
  assert.deepEqual(
    JSON.parse(finalAnswer('<think>\n\n</think>\n\n' + JSON.stringify(value))),
    value,
  )
})

test('actual worker emits final-answer tokens and status, but never hidden reasoning', async (t) => {
  const originalSelf = globalThis.self
  const messages = [],
    requests = []
  globalThis.self = { postMessage: (value) => messages.push(value) }
  const engine = {
    chat: {
      completions: {
        async create(request) {
          requests.push(request)
          if (!request.stream)
            return {
              choices: [
                {
                  message: {
                    content: '<think>\n</think>\n{"topic":"licenses","node":0,"followUps":["paths","unknown","selected"]}',
                  },
                },
              ],
            }
          return (async function* () {
            for (const content of ['<thi', 'nk>PRIVATE_REASONING', '</thi', 'nk>Answer [R].'])
              yield { choices: [{ delta: { content } }] }
          })()
        },
      },
    },
  }
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self
    else globalThis.self = originalSelf
  })
  const { handleRequest } = await import(
    '../internal/app/web/static/assistant/worker.js?generation-test'
  )
  const runtime = {
    CreateMLCEngine(id, options) {
      options.initProgressCallback({ text: 'Loading weights', progress: 0.42, timeElapsed: 2 })
      return engine
    },
    hasModelInCache(id) {
      if (id.includes('0.5B')) throw new Error('Storage unavailable')
      return id.includes('1.5B')
    },
  }
  const handler = (event) => handleRequest(event, async () => runtime)
  await handler({ data: { type: 'cache', id: 7 } })
  const cached = messages.find((value) => value.id === 7).value
  assert.equal(cached.length, models.length)
  assert.equal(cached.find((value) => value.id === qwen25).cached, true)
  assert.equal(cached.find((value) => value.id.includes('0.5B')).cached, null)
  assert.equal(requests.length, 0) // Cache inspection never invokes inference.
  await handler({ data: { type: 'init', id: 1, modelID: qwen3 } })
  assert.ok(
    messages.some(
      (value) => value.type === 'progress' && value.progress === 0.42 && value.timeElapsed === 2,
    ),
  )
  await handler({
    data: {
      type: 'query',
      id: 2,
      question: 'Which modules use ISC?',
      topics: {
        licenses: 'License inventory',
        paths: 'Paths',
        unknown: 'Unknown',
        selected: 'Selected',
      },
      nodes: [{ id: 'root' }],
      selected: 'root',
      asked: [],
      thinking: true,
    },
  })
  assert.equal(requests[0].extra_body.enable_thinking, false)
  assert.equal(requests[0].temperature, 0)
  assert.equal(messages.find((value) => value.id === 2).value.topic, 'licenses')
  await handler({
    data: {
      type: 'answer',
      id: 3,
      question: 'Where is the repository?',
      evidence: [{ label: '[R]', detail: 'quoted "module"\nwith two lines' }],
      previousQuestions: [],
    },
  })
  const prompt = JSON.parse(requests[1].messages.at(-1).content)
  assert.deepEqual(prompt, {
    question: 'Where is the repository?',
    previousQuestions: [],
    observations: [{ label: '[R]', detail: 'quoted "module"\nwith two lines' }],
  })
  assert.equal(requests[1].extra_body.enable_thinking, true)
  assert.equal(messages.find((value) => value.id === 3 && value.value).value.text, 'Answer [R].')
  assert.ok(
    messages.some(
      (value) => value.id === 3 && value.type === 'status' && value.text === 'Thinking…',
    ),
  )
  assert.ok(
    messages.some(
      (value) => value.id === 3 && value.type === 'token' && value.text === 'Answer [R].',
    ),
  )
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_REASONING|<think>|<thi/)
  // A malformed constrained response gets one fresh inference, without a fallback plan.
  let attempts = 0
  engine.chat.completions.create = async () => ({
    choices: [
      {
        message: {
          content:
            ++attempts === 1
              ? '{"topic":'
              : '{"topic":"licenses","node":0,"followUps":["paths","unknown","selected"]}',
        },
      },
    ],
  })
  const query = {
    type: 'query',
    question: 'Which dependency has ISC license?',
    topics: { licenses: 'Licenses', paths: 'Paths', unknown: 'Unknown', selected: 'Selected' },
    nodes: [{ id: 'root' }],
    selected: 'root',
    asked: [],
  }
  await handler({ data: { ...query, id: 5 } })
  assert.equal(attempts, 2)
  assert.equal(messages.find((value) => value.id === 5).value.topic, 'licenses')
  attempts = 0
  engine.chat.completions.create = async () => {
    attempts++
    return { choices: [{ message: { content: '{"topic":' } }] }
  }
  await handler({ data: { ...query, id: 6 } })
  assert.equal(attempts, 2)
  assert.match(messages.find((value) => value.id === 6).error, /could not interpret/)
  assert.equal(messages.find((value) => value.id === 6).value, undefined)
  // An exact catalog question pins the main topic while leaving all follow-ups available.
  const catalogRequests = []
  engine.chat.completions.create = async (request) => {
    catalogRequests.push(request)
    const plan = {
      topic: catalogRequests.length === 1 ? 'licenses' : 'paths',
      node: 0,
      followUps: ['licenses', 'selected', 'unknown'],
    }
    return { choices: [{ message: { content: JSON.stringify(plan) } }] }
  }
  await handler({ data: { ...query, id: 8, question: '  PATHS?  ' } })
  assert.equal(catalogRequests.length, 2)
  const fields = JSON.parse(catalogRequests[0].response_format.schema).properties
  assert.deepEqual(fields.topic.enum, ['paths'])
  assert.deepEqual(fields.followUps.items.enum, Object.keys(query.topics))
  assert.equal(messages.find((value) => value.id === 8).value.topic, 'paths')
  // Exhaustion while thinking must become an error rather than an empty success.
  engine.chat.completions.create = async () =>
    (async function* () {
      yield {
        choices: [{ delta: { content: '<think>PRIVATE_REASONING' }, finish_reason: 'length' }],
      }
    })()
  await handler({
    data: {
      type: 'answer',
      id: 4,
      question: '?',
      evidence: [],
      previousQuestions: [],
      thinking: true,
    },
  })
  assert.match(messages.find((value) => value.id === 4 && value.error).error, /final answer/)
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_REASONING/)
})

test('interrupting a planner skips its retry and keeps the next generation on the same engine', async (t) => {
  const messages = [],
    requests = []
  const previous = globalThis.self
  globalThis.self = { postMessage: (message) => messages.push(message) }
  t.after(() => {
    if (previous === undefined) delete globalThis.self
    else globalThis.self = previous
  })
  const planning = Promise.withResolvers(),
    finishing = Promise.withResolvers()
  let interrupts = 0
  const engine = {
    interruptGenerate() {
      interrupts++
    },
    chat: {
      completions: {
        async create(request) {
          requests.push(request)
          if (request.stream)
            return (async function* () {
              yield { choices: [{ delta: { content: 'Next answer' } }] }
            })()
          planning.resolve()
          await finishing.promise
          return { choices: [{ message: { content: '{' } }] }
        },
      },
    },
  }
  const { handleRequest } = await import(
    '../internal/app/web/static/assistant/worker.js?interrupt-test'
  )
  await handleRequest({ data: { id: 1, type: 'init', modelID: qwen25 } }, async () => ({
    CreateMLCEngine: () => engine,
  }))
  const dispatch = (data) => handleRequest({ data })
  const first = dispatch({
    id: 2,
    type: 'query',
    question: '?',
    topics: { paths: 'Paths' },
    nodes: [{ id: 'root' }],
    selected: 'root',
    asked: [],
  })
  await planning.promise
  await dispatch({ id: 2, type: 'interrupt' })
  const answer = {
    type: 'answer',
    question: '?',
    evidence: [],
    previousQuestions: [],
    thinking: false,
  }
  const skipped = dispatch({ ...answer, id: 3 })
  await dispatch({ id: 3, type: 'interrupt' })
  const next = dispatch({ ...answer, id: 4 })
  assert.equal(requests.length, 1)
  assert.equal(interrupts, 1)
  finishing.resolve()
  await Promise.all([first, skipped, next])
  assert.equal(requests.length, 2)
  assert.ok(messages.find((m) => m.id === 2).error)
  assert.ok(messages.find((m) => m.id === 3).error)
  assert.equal(messages.find((m) => m.id === 4 && m.value).value.text, 'Next answer')
})

test('removed reasoning models cannot be selected, while their output markers remain safely filtered', () => {
  for (const id of [
    'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC',
    'Ministral-3-3B-Reasoning-2512-q4f32_1-MLC',
  ]) {
    assert.throws(() => generationOptions(id), /Unsupported/)
  }
  const raw = '[THINK]private[/THINK]Answer'
  for (let split = 0; split <= raw.length; split++) {
    const stream = new AnswerStream({ expectThinking: true })
    for (const chunk of [raw.slice(0, split), raw.slice(split)])
      assert.ok('Answer'.startsWith(stream.push(chunk)))
    assert.equal(stream.finish(), 'Answer')
  }
  assert.equal(finalAnswer(raw), 'Answer')
})
