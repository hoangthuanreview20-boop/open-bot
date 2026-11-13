/**
 * Mistral AI provider — POST https://api.mistral.ai/v1/chat/completions.
 * Mistral speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * Model notes (checked against Mistral's docs, 2026-11):
 *  - `mistral-small-latest` is the cheap general model and the default
 *    here (same default as the `mistral` preset in models/presets.ts,
 *    so bots created from the preset keep working unchanged).
 *  - `mistral-medium-latest` / `mistral-large-latest` are the larger
 *    general models (Large 3, 256K context, image input);
 *    `mistral-large-2512` pins the Large 3 snapshot; `mistral-small-4`
 *    is the Small 4 generation; `codestral-latest` is code-tuned.
 *  - The `magistral-*` reasoning models are deprecated — use Small 4
 *    for reasoning instead — and are NOT in the known list.
 *  - `listModels()` falls back to MISTRAL_KNOWN_MODELS when the
 *    endpoint has no list API or is unreachable.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
/** Cheap general model — default for new Mistral bots. */
export const MISTRAL_DEFAULT_MODEL = 'mistral-small-latest';
/** Models listed when the API does not return a model list. */
export const MISTRAL_KNOWN_MODELS = [
  'mistral-small-latest',
  'mistral-medium-latest',
  'mistral-large-latest',
  'mistral-large-2512',
  'mistral-medium-3.5',
  'mistral-small-4',
  'codestral-latest',
];

export class MistralProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'mistral',
        label: config.label || 'Mistral',
        baseUrl: config.baseUrl ?? MISTRAL_BASE_URL,
        defaultModel: config.defaultModel || MISTRAL_DEFAULT_MODEL,
      },
      MISTRAL_KNOWN_MODELS,
    );
  }
}
