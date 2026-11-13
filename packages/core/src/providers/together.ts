/**
 * Together AI provider — POST https://api.together.xyz/v1/chat/completions.
 * Together speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * Model notes (checked against Together's docs, 2026-11):
 *  - Together hosts 200+ open-weight models under
 *    `<org>/<model>` ids. `meta-llama/Llama-3.3-70B-Instruct-Turbo`
 *    is the general-purpose default here (same default as the
 *    `together` preset in models/presets.ts, so bots created from the
 *    preset keep working unchanged).
 *  - Other known models: Llama 3.1 8B / 405B Turbo, Qwen3 235B MoE
 *    instruct, DeepSeek-V3, and Llama 4 Maverick (FP8).
 *  - The catalog changes often — when the endpoint answers,
 *    `listModels()` returns the live catalog; otherwise it falls back
 *    to TOGETHER_KNOWN_MODELS.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
/** General-purpose Llama 3.3 70B — default for new Together bots. */
export const TOGETHER_DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
/** Models listed when the API does not return a model list. */
export const TOGETHER_KNOWN_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'meta-llama/Llama-3.1-8B-Instruct-Turbo',
  'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
  'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
  'deepseek-ai/DeepSeek-V3',
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
];

export class TogetherProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'together',
        label: config.label || 'Together AI',
        baseUrl: config.baseUrl ?? TOGETHER_BASE_URL,
        defaultModel: config.defaultModel || TOGETHER_DEFAULT_MODEL,
      },
      TOGETHER_KNOWN_MODELS,
    );
  }
}
