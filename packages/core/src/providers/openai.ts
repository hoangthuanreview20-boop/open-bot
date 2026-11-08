/**
 * OpenAI provider — POST https://api.openai.com/v1/chat/completions.
 * OpenAI-compatible tool calling; transport shared with
 * openaiCompatible.ts. No SDK, plain fetch.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';
/** Models listed when the API does not return a model list. */
export const OPENAI_KNOWN_MODELS = ['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini'];

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'openai',
        label: config.label || 'OpenAI',
        baseUrl: config.baseUrl ?? OPENAI_BASE_URL,
        // NOTE: defaultModel "gpt-5-mini" — người dùng đổi được trong cài đặt bot.
        defaultModel: config.defaultModel || OPENAI_DEFAULT_MODEL,
      },
      OPENAI_KNOWN_MODELS,
    );
  }
}
