import { findModel } from './models.js'

// Budget and sampling are selected per checkpoint, not by a family-name guess.
// Planning uses constrained JSON. Only profiles with a verified thinking-off
// mechanism receive that flag; reasoning-only checkpoints keep their native mode.
export function generationOptions(modelID, { query = false, thinking = true } = {}) {
  const model = findModel(modelID)
  if (!model) throw new Error('Unsupported local model.')
  const enabled = !query && (model.alwaysThinking || (model.thinking && thinking))
  return {
    temperature: query ? 0 : model.profile.output === 'square-think' ? 0.7 : model.templateName === 'qwen2' && model.thinking ? 1 : model.thinking || model.alwaysThinking ? 0.6 : 0,
    max_tokens: query ? 384 : enabled ? 1536 : 192,
    ...(model.thinking ? { top_p: 0.95, extra_body: { enable_thinking: Boolean(enabled) } } : {}),
  }
}

// Discard reasoning inside the worker before any token reaches the UI/history.
// Preserve partial tag prefixes across chunks, including an unfinished block.
// In thinking mode, fail closed until the first reasoning block has ended.
export class AnswerStream {
  constructor({ expectThinking = false } = {}) {
    this.buffer = ''; this.text = ''; this.depth = expectThinking ? 1 : 0; this.opening = expectThinking
  }
  push(chunk) {
    this.buffer += chunk
    if (this.opening) {
      const start = this.buffer.trimStart().toLowerCase()
      if (!start || ['<think>', '[think]'].some(tag => tag.startsWith(start) && start !== tag)) return this.text
      if (start.startsWith('<think>') || start.startsWith('[think]')) this.buffer = this.buffer.trimStart().slice(7)
      this.opening = false
    }
    while (this.buffer) {
      const match = /(?:<\/?think>|\[\/?think\]|<\|channel>thought|<channel\|>)/i.exec(this.buffer)
      if (match) {
        if (!this.depth) this.text += this.buffer.slice(0, match.index)
        this.depth = (match[0][1] === '/' || match[0].toLowerCase() === '<channel|>') ? Math.max(0, this.depth - 1) : this.depth + 1
        this.buffer = this.buffer.slice(match.index + match[0].length)
      } else {
        const lower = this.buffer.toLowerCase()
        let held = 0
        for (const tag of ['<think>', '</think>', '[think]', '[/think]', '<|channel>thought', '<channel|>']) for (let n = 1; n < tag.length; n++) if (lower.endsWith(tag.slice(0, n))) held = Math.max(held, n)
        if (!this.depth) this.text += this.buffer.slice(0, this.buffer.length - held)
        this.buffer = held ? this.buffer.slice(-held) : ''
        break
      }
      this.text = this.text.slice(0, 8000)
    }
    this.text = this.text.slice(0, 8000)
    return this.text
  }
  get thinking() { return this.depth > 0 }
  finish() {
    if (this.depth || this.opening) throw new Error('The model stopped thinking before producing a final answer. Try a shorter question or another model.')
    if (!this.text.trim()) throw new Error('The model did not produce a final answer. Try rephrasing your question or choosing another model.')
    return this.text.trim()
  }
}
export function finalAnswer(text) { const output = new AnswerStream(); output.push(text); return output.finish() }
