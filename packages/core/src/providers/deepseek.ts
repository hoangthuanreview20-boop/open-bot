/**
 * DeepSeek provider — POST https://api.deepseek.com/v1/chat/completions.
 * DeepSeek speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * Model notes (checked against DeepSeek's docs, 2026-11):
 *  - Current generation is V4 (April 2026): `deepseek-v4-flash` is the
 *    cost-efficient flagship (1M context) and the default here;
 *    `deepseek-v4-pro` is the frontier tier.
 *  - The legacy aliases `deepseek-chat` / `deepseek-reasoner` were
 *    retired on 2026-07-24 and are intentionally NOT in the known
 *    list; users still holding them can type the name by hand.
 *  - `listModels()` falls back to DEEPSEEK_KNOWN_MODELS when the
 *    endpoint has no list API or is unreachable.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
/** Cost-efficient V4 flagship — default for new DeepSeek bots. */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
/** Models listed when the API does not return a model list. */
export const DEEPSEEK_KNOWN_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'deepseek',
        label: config.label || 'DeepSeek',
        baseUrl: config.baseUrl ?? DEEPSEEK_BASE_URL,
        defaultModel: config.defaultModel || DEEPSEEK_DEFAULT_MODEL,
      },
      DEEPSEEK_KNOWN_MODELS,
    );
  }
}
