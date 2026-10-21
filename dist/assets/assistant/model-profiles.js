// Profiles describe the pinned MLC conversion, not the original model's full
// capabilities. Unknown templates stay unknown; no compatibility is inferred.
// Sources: WebLLM config.ts and each repository's mlc-chat-config.json, captured
// in model-catalog.js. DeepSeek's model card recommends user-only instructions.
const standardTemplates = new Set(['llama-3_1', 'llama-3', 'llama-2', 'hermes2_pro_llama3', 'hermes3_llama-3_1',
  'open_hermes_mistral', 'neural_hermes_mistral', 'phi-3', 'phi-3-vision', 'phi-4', 'phi-2',
  'mistral_default', 'wizard_coder_or_math', 'chatml', 'gemma_instruction', 'gemma3_instruction',
  'olmo2', 'qwen2', 'stablelm-2', 'redpajama_chat', 'tinyllama_v1_0', 'ministral3'])
const qwen35 = new Set(['Qwen3.5-0.8B', 'Qwen3.5-2B', 'Qwen3.5-4B', 'Qwen3.5-9B'])
export function modelProfile(record) {
  const checkpoint = record.id.replace(/-q\d[^-]*-MLC.*$/, '')
  const deepseek = ['deepseek_r1_qwen', 'deepseek_r1_llama'].includes(record.templateName)
  const ministralReasoning = record.templateName === 'ministral3_reasoning'
  const optional = record.templateName === 'qwen3' || (record.templateName === 'qwen2' && qwen35.has(checkpoint))
  const reasoning = optional ? 'optional' : deepseek || ministralReasoning ? 'required' : standardTemplates.has(record.templateName) && !(record.templateName === 'qwen2' && checkpoint.startsWith('Qwen3')) ? 'standard' : 'unknown'
  return Object.freeze({
    systemPrompt: deepseek || record.acceptsSystemPrompt !== true ? 'user' : 'system',
    reasoning, thinkingControl: optional ? 'enable_thinking' : null,
    output: record.templateName === 'gemma4_instruction' ? 'gemma-channel' : ministralReasoning ? 'square-think' : reasoning === 'required' || optional ? 'angle-think' : 'auto',
    reasoningInstructions: ministralReasoning ? record.reasoningInstructions : '',
    structuredOutput: 'runtime-json', nativeTools: record.nativeTools === true,
    vision: record.vision === true, base: record.templateName === 'LM',
  })
}
export function capabilityBadges(profile) {
  return [
    { label: profile.systemPrompt === 'system' ? 'System prompt' : 'User instructions', title: profile.systemPrompt === 'system' ? 'The MLC chat template accepts system instructions.' : 'Instructions are included in user messages, following the model profile.' },
    { label: ({ optional: 'Thinking optional', required: 'Reasoning', standard: 'Standard chat', unknown: 'Thinking unverified' })[profile.reasoning], title: ({ optional: 'Custom-answer thinking is enabled automatically. Constrained planning keeps it off.', required: 'This reasoning checkpoint has no supported thinking-off switch here.', standard: 'No separate reasoning mode is configured for this chat template.', unknown: 'No verified thinking control is configured for this converted checkpoint.' })[profile.reasoning] },
    { label: 'JSON output', title: 'WebLLM provides grammar-constrained JSON. This does not establish planning accuracy.' },
    ...(profile.nativeTools ? [{ label: 'Tools', title: 'Listed for native function calling by the pinned WebLLM runtime. gomod-lens does not expose tool execution.' }] : []),
    ...(profile.vision ? [{ label: 'Vision', title: 'This MLC variant supports images. gomod-lens currently sends text only.' }] : []),
    ...(profile.base ? [{ label: 'Base model', title: 'A base checkpoint rather than an instruction-tuned chat model; assistant behavior is unverified.' }] : []),
  ].map(value => Object.freeze(value))
}
