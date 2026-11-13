/**
 * Cohere provider — POST https://api.cohere.ai/compatibility/v1/chat/completions.
 * Cohere's Compatibility API speaks the OpenAI chat-completions API, so
 * the transport is shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * Model notes (checked against Cohere's docs, 2026-11):
 *  - `command-a-03-2025` is the stable Command A flagship and the
 *    default here. `command-a-plus-05-2026` is the newer, larger
 *    Command A Plus; `command-a-reasoning-08-2025` is reasoning-tuned;
 *    `command-a-vision-07-2025` takes image input;
 *    `command-r-plus-08-2024` / `command-r-08-2024` are the older
 *    Command R generation (still served).
 *  - Only `none` and `high` are supported for `reasoning_effort` on
 *    this endpoint, and Cohere-native parameters are not supported —
 *    this transport sends neither, so no special-casing is needed.
 *  - Trial keys are limited to 1,000 calls/month for evaluation.
 *  - `listModels()` falls back to COHERE_KNOWN_MODELS when the
 *    endpoint has no list API or is unreachable.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const COHERE_BASE_URL = 'https://api.cohere.ai/compatibility/v1';
/** Stable Command A flagship — default for new Cohere bots. */
export const COHERE_DEFAULT_MODEL = 'command-a-03-2025';
/** Models listed when the API does not return a model list. */
export const COHERE_KNOWN_MODELS = [
  'command-a-03-2025',
  'command-a-plus-05-2026',
  'command-a-reasoning-08-2025',
  'command-a-vision-07-2025',
  'command-r-plus-08-2024',
  'command-r-08-2024',
];

export class CohereProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'cohere',
        label: config.label || 'Cohere',
        baseUrl: config.baseUrl ?? COHERE_BASE_URL,
        defaultModel: config.defaultModel || COHERE_DEFAULT_MODEL,
      },
      COHERE_KNOWN_MODELS,
    );
  }
}
