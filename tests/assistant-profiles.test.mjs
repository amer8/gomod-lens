import { prebuiltAppConfig } from '../internal/app/web/static/vendor/web-llm-0.2.89.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { models, findModel, catalogInfo } from '../internal/app/web/static/assistant/models.js'
import {
  modelProfile,
  capabilityBadges,
} from '../internal/app/web/static/assistant/model-profiles.js'
import {
  chatMessages,
  answerInstructions,
  planningInstructions,
} from '../internal/app/web/static/assistant/prompts.js'
import { generationOptions, AnswerStream } from '../internal/app/web/static/assistant/generation.js'
import {
  checkCases,
  checkSummary,
  checkedReport,
  checkSuiteVersion,
} from '../internal/app/web/static/assistant/model-checks.js'
import { LocalAI } from '../internal/app/web/static/assistant/local-ai.js'

const deepseek = 'DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC'
const ministral = 'Ministral-3-3B-Reasoning-2512-q4f32_1-MLC'
const qwen = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'

test('curated capabilities retain supported thinking and the selected native tool model', () => {
  assert.ok(
    models.every((model) => model.profile && model.templateName && model.capabilities.length >= 3),
  )
  assert.ok(models.every((model) => model.profile.systemPrompt === 'system'))
  assert.equal(findModel('Qwen3.5-2B-q4f32_1-MLC').profile.reasoning, 'optional')
  assert.equal(findModel('Phi-4-mini-instruct-q4f32_1-MLC').profile.reasoning, 'standard')
  assert.equal(models.filter((model) => model.profile.nativeTools).length, 1)
  assert.equal(findModel('Hermes-3-Llama-3.1-8B-q4f32_1-MLC').profile.nativeTools, true)
  assert.ok(
    models.every(
      (model) =>
        !model.profile.base && !model.profile.vision && model.profile.reasoning !== 'required',
    ),
  )
  const unknown = modelProfile({
    id: 'future-model',
    templateName: 'future',
    acceptsSystemPrompt: null,
  })
  assert.equal(unknown.reasoning, 'unknown')
  assert.equal(unknown.systemPrompt, 'user')
  assert.equal(unknown.nativeTools, false)
  assert.ok(capabilityBadges(unknown).some((value) => value.label === 'Thinking unverified'))
})
test('curated system templates preserve instruction and request roles and reject removed IDs', () => {
  for (const model of models) {
    const standard = chatMessages(model.id, answerInstructions, 'Current question')
    assert.deepEqual(
      standard.map((message) => message.role),
      ['system', 'user'],
    )
    assert.equal(standard[0].content, answerInstructions)
    assert.equal(standard.at(-1).content, 'Current question')
  }
  assert.throws(() => chatMessages(deepseek, answerInstructions, 'Question'), /Unsupported/)
})
test('selected thinking models use explicit controls while standard alternatives receive no thinking flags', () => {
  for (const model of models) {
    const planning = chatMessages(model.id, planningInstructions, 'Question', { query: true })
    assert.equal(planning[0].content, planningInstructions)
    if (model.thinking) {
      assert.equal(generationOptions(model.id).extra_body.enable_thinking, true)
      assert.equal(
        generationOptions(model.id, { thinking: false }).extra_body.enable_thinking,
        false,
      )
      assert.equal(generationOptions(model.id, { query: true }).extra_body.enable_thinking, false)
    } else assert.equal(generationOptions(model.id).extra_body, undefined)
  }
  assert.throws(() => generationOptions(ministral), /Unsupported/)
})
test('Gemma channel markers and reasoning stay hidden across every stream split', () => {
  const raw = '<|channel>thought\nPRIVATE_REASONING<channel|>Final answer.'
  for (let split = 0; split <= raw.length; split++) {
    const stream = new AnswerStream()
    for (const chunk of [raw.slice(0, split), raw.slice(split)])
      assert.ok('Final answer.'.startsWith(stream.push(chunk)))
    assert.equal(stream.finish(), 'Final answer.')
  }
  const unfinished = new AnswerStream()
  assert.equal(unfinished.push('<|channel>thought\nPRIVATE'), '')
  assert.throws(() => unfinished.finish(), /final answer/)
})
test('app-check badges cannot be inferred from a loaded model, partial results or another runtime', () => {
  assert.equal(checkSummary().label, 'Not run')
  const value = {
    modelID: qwen,
    runtimeVersion: catalogInfo.version,
    suiteVersion: checkSuiteVersion,
    results: checkCases.map((item) => ({ id: item.id, passed: true })),
  }
  assert.equal(checkSummary(checkedReport(value, qwen)).label, '4/4 passed')
  for (const invalid of [
    { ...value, modelID: deepseek },
    { ...value, runtimeVersion: 'future' },
    { ...value, suiteVersion: 1 },
    { ...value, results: value.results.slice(1) },
    { ...value, results: [value.results[1], ...value.results.slice(1)] },
    { ...value, results: [null, ...value.results.slice(1)] },
  ]) {
    assert.throws(() => checkedReport(invalid, qwen), /complete report/)
  }
  assert.equal(checkSummary({ state: 'incomplete' }).kind, 'warning')
  const failed = {
    ...value,
    results: value.results.map((item, index) => ({ ...item, passed: index !== 1 })),
  }
  assert.equal(checkSummary(checkedReport(failed, qwen)).label, '3/4 passed')
})
test('worker app checks run production inference and retain failed cases without streaming fixture answers', async (t) => {
  const previousSelf = globalThis.self
  const messages = [],
    requests = []
  globalThis.self = {
    postMessage(value) {
      messages.push(value)
    },
  }
  let correct = true
  const engine = {
    chat: {
      completions: {
        async create(request) {
          requests.push(request)
          const user = JSON.parse(request.messages.at(-1).content)
          if (!request.stream) {
            const plan = user.question.includes('pflag')
              ? {
                  topic: 'paths',
                  node: correct ? user.modules.find((m) => m.module.includes('/pflag@')).index : 0,
                  followUps: ['licenses', 'selected', 'overview'],
                }
              : { topic: 'licenses', node: 0, followUps: ['paths', 'releases', 'unknown'] }
            return { choices: [{ message: { content: JSON.stringify(plan) } }] }
          }
          const text = correct
            ? user.question.startsWith('Which dependency')
              ? 'example.org/isc-lib uses ISC.'
              : 'https://github.com/gin-gonic/gin'
            : 'I do not know.'
          return (async function* () {
            yield { choices: [{ delta: { content: '<think>PRIVATE_REASONING</think>' + text } }] }
          })()
        },
      },
    },
  }
  t.after(() => {
    globalThis.self = previousSelf
  })
  const { handleRequest } = await import(
    '../internal/app/web/static/assistant/worker.js?profiles-test'
  )
  const handler = (event) => handleRequest(event, async () => ({ prebuiltAppConfig, CreateMLCEngine: () => engine }))
  await handler({ data: { id: 1, type: 'init', modelID: qwen } })
  await handler({ data: { id: 2, type: 'validate' } })
  const result = checkedReport(
    messages.find((message) => message.id === 2 && message.value).value,
    qwen,
  )
  assert.equal(checkSummary(result).label, '4/4 passed')
  assert.equal(requests.length, 4)
  assert.ok(requests.every((request) => request.messages[0].role === 'system'))
  assert.ok(!messages.some((message) => message.type === 'token'))
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_REASONING|example.org\/isc-lib/)
  correct = false
  await handler({ data: { id: 3, type: 'validate' } })
  const failed = checkedReport(
    messages.find((message) => message.id === 3 && message.value).value,
    qwen,
  )
  assert.equal(checkSummary(failed).label, '1/4 passed')
  assert.equal(failed.results.find((item) => item.id === 'dependency-path').passed, false)
})
test('canceling app checks terminates inference without producing a passing report', async (t) => {
  let worker
  const ai = new LocalAI({
    workerFactory: () =>
      (worker = {
        terminate() {
          this.terminated = true
        },
        postMessage(data) {
          if (data.type === 'init')
            queueMicrotask(() => this.onmessage({ data: { id: data.id, value: true } }))
        },
      }),
  })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } })
  t.after(() => {
    ai.stop()
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  })
  await ai.enable(qwen)
  const controller = new AbortController()
  const pending = ai.validate(controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(worker.terminated, true)
  assert.equal(ai.ready, false)
})
