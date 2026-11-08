/**
 * Provider registry: builds a Provider from a ProviderConfig and exposes
 * the metadata the UI needs to render the provider picker.
 */

import type { Provider, ProviderConfig } from '../types';
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import { GeminiProvider, GEMINI_DEFAULT_MODEL } from './gemini';
import { OllamaProvider, OLLAMA_BASE_URL, OLLAMA_DEFAULT_MODEL } from './ollama';
import { OpenAIProvider, OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL } from './openai';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { XAI_BASE_URL, XAI_DEFAULT_MODEL, XAIProvider } from './xai';

export { AnthropicProvider } from './anthropic';
export { GeminiProvider } from './gemini';
export { OllamaProvider } from './ollama';
export { OpenAIProvider } from './openai';
export { OpenAICompatibleProvider } from './openaiCompatible';
export { XAIProvider } from './xai';

export interface ProviderMeta {
  id: string;
  label: string;
  defaultModel: string;
  /** True when the user must supply their own API key for this provider. */
  needsKey: boolean;
  defaultBaseUrl: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: OPENAI_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: OPENAI_BASE_URL,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    defaultModel: GEMINI_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'xai',
    label: 'xAI',
    defaultModel: XAI_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: XAI_BASE_URL,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultModel: OLLAMA_DEFAULT_MODEL,
    needsKey: false,
    defaultBaseUrl: OLLAMA_BASE_URL,
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (tùy chỉnh)',
    defaultModel: '',
    needsKey: false,
    defaultBaseUrl: '',
  },
];

/** Build a Provider from a stored config. Throws on an unknown provider id. */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.id) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    case 'xai':
      return new XAIProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai-compatible':
      return new OpenAICompatibleProvider(config);
    default:
      throw new Error(`Không rõ provider id: ${config.id}`);
  }
}
