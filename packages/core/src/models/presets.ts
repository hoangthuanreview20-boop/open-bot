/**
 * Presets for OpenAI-compatible providers (v0.5).
 *
 * A preset is just a well-known base URL + default model for a
 * third-party provider that speaks the OpenAI chat-completions API.
 * No credentials live here — the user still supplies their own API
 * key, stored in the Vault like any other provider key. Adding a new
 * preset is one entry in COMPATIBLE_PRESETS; nothing else changes.
 *
 * This module is intentionally a leaf: it imports nothing from
 * open-bot, so packages/core/src/providers/index.ts can import it
 * without creating a cycle (models/registry.ts imports the provider
 * registry, the provider registry imports only this file).
 */

export interface CompatiblePreset {
  /** Stable id, used in settings (e.g. 'deepseek'). */
  id: string;
  /** Display label, e.g. 'DeepSeek'. */
  label: string;
  /** Base URL of the provider's OpenAI-compatible API. */
  baseUrl: string;
  /** Model used when the user picks this preset and sets no model. */
  defaultModel: string;
}

export const COMPATIBLE_PRESETS: readonly CompatiblePreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    // v0.97: `deepseek-chat` / `deepseek-reasoner` were retired on
    // 2026-07-24 — the current default is the V4 cost-efficient
    // flagship (see providers/deepseek.ts).
    defaultModel: 'deepseek-v4-flash',
  },
  {
    // v0.97 (Team T6): Moonshot AI (Kimi) — international endpoint;
    // mainland-China keys use https://api.moonshot.cn/v1 instead.
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    // v0.97 (Team T6): Cohere Compatibility API — OpenAI-compatible
    // endpoint for the Command models (api.cohere.ai, not .com).
    id: 'cohere',
    label: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-a-03-2025',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
  },
  {
    // B-platform M3. Cerebras: model suy luận siêu nhanh (Wafer-Scale
    // Engine). Mặc định gpt-oss-120b — llama-3.3-70b đã bị gỡ khỏi
    // endpoint công khai của Cerebras trong 2026, không dùng làm mặc định.
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b',
  },
  {
    // B-platform M3. Fireworks AI: serverless, model id đầy đủ dạng
    // accounts/fireworks/models/<model> theo doc của Fireworks.
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    // B-platform M3. SambaNova Cloud: model id Meta-Llama-3.3-70B-Instruct
    // theo doc + danh sách /v1/models trực tiếp. Lưu ý: gói miễn phí
    // của SambaNova hiện yêu cầu phương thức thanh toán trước khi gọi
    // lần đầu (test 2026-08-31 trả 402), người dùng tự thêm key của mình.
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
  },
  {
    // B-platform M3. Google AI Studio qua endpoint tương thích OpenAI:
    // dùng cùng AI Studio key với provider Gemini. Mặc định
    // gemini-2.5-flash (đã kiểm chứng chạy tốt); project mới chưa từng
    // dùng model 2.5 có thể cần chọn model 3.x (vd gemini-3-flash).
    id: 'google-ai-studio',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
];

/** Copies of all presets, in display order. */
export function listCompatiblePresets(): CompatiblePreset[] {
  return COMPATIBLE_PRESETS.map((p) => ({ ...p }));
}

/** One preset by id, or undefined when the id is unknown. Never throws. */
export function resolvePreset(id: string): CompatiblePreset | undefined {
  const found = COMPATIBLE_PRESETS.find((p) => p.id === id);
  return found ? { ...found } : undefined;
}
