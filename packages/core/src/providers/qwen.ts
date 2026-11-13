/**
 * Qwen (Alibaba Cloud Model Studio / DashScope) provider —
 * POST https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions.
 * DashScope speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * Model notes (checked against Alibaba Cloud docs, 2026-11):
 *  - `qwen-plus` is the balanced general model and the default here
 *    (same default as the `qwen` preset in models/presets.ts, so bots
 *    created from the preset keep working unchanged).
 *  - Qwen3.7 / Qwen3.8 are the current flagship lines:
 *    `qwen3.7-plus` (balanced, thinking + vision + tool calling),
 *    `qwen3.7-max` (previous flagship), `qwen3.8-flash` / `qwen3.8-max`
 *    (current flagship, 1M context, multimodal input).
 *    `qwen3-coder-plus` is the coding-tuned model.
 *  - This is the INTERNATIONAL endpoint. Beijing-region accounts use
 *    https://dashscope.aliyuncs.com/compatible-mode/v1 instead
 *    (keys are region-specific) — the user can override baseUrl.
 *  - `listModels()` falls back to QWEN_KNOWN_MODELS when the endpoint
 *    has no list API or is unreachable.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
/** Balanced general model — default for new Qwen bots. */
export const QWEN_DEFAULT_MODEL = 'qwen-plus';
/** Models listed when the API does not return a model list. */
export const QWEN_KNOWN_MODELS = [
  'qwen-plus',
  'qwen3.7-plus',
  'qwen3.7-max',
  'qwen3.8-flash',
  'qwen3.8-max',
  'qwen3-coder-plus',
  'qwen-max',
];

export class QwenProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'qwen',
        label: config.label || 'Qwen (Alibaba)',
        baseUrl: config.baseUrl ?? QWEN_BASE_URL,
        defaultModel: config.defaultModel || QWEN_DEFAULT_MODEL,
      },
      QWEN_KNOWN_MODELS,
    );
  }
}
