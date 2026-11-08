/**
 * xAI provider — POST https://api.x.ai/v1/chat/completions.
 * xAI dùng API tương thích OpenAI nên transport dùng chung với
 * openaiCompatible.ts. No SDK, plain fetch.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const XAI_BASE_URL = 'https://api.x.ai/v1';
/** Model mới nhất của xAI tính đến 11/2026 — người dùng đổi được. */
export const XAI_DEFAULT_MODEL = 'grok-4.7';
/** Models listed when the API does not return a model list. */
export const XAI_KNOWN_MODELS = ['grok-4.7', 'grok-4', 'grok-3'];

export class XAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'xai',
        label: config.label || 'xAI',
        baseUrl: config.baseUrl ?? XAI_BASE_URL,
        defaultModel: config.defaultModel || XAI_DEFAULT_MODEL,
      },
      XAI_KNOWN_MODELS,
    );
  }
}
