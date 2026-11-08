/**
 * Ollama provider — local models over the OpenAI-compatible endpoint
 * http://localhost:11434/v1/chat/completions. No API key needed.
 * No SDK, plain fetch.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider, openAIListModels } from './openaiCompatible';

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const OLLAMA_DEFAULT_MODEL = 'llama3.1';
/** Models listed when Ollama has no list API reachable / is not running. */
export const OLLAMA_KNOWN_MODELS = ['llama3.1', 'qwen2.5', 'mistral', 'gemma3'];

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'ollama',
        label: config.label || 'Ollama',
        baseUrl: config.baseUrl ?? OLLAMA_BASE_URL,
        defaultModel: config.defaultModel || OLLAMA_DEFAULT_MODEL,
      },
      OLLAMA_KNOWN_MODELS,
    );
  }

  override async listModels(): Promise<string[]> {
    // Try the OpenAI-compatible /v1/models first, then Ollama's native
    // /api/tags (base without the trailing /v1). Fall back to known models
    // when Ollama is not running.
    const fromCompat = await openAIListModels(this.baseUrl, undefined, [
      ...this.knownModels,
    ]);
    if (fromCompat.join() !== this.knownModels.join()) return fromCompat;
    try {
      const nativeBase = this.baseUrl.replace(/\/v1$/, '');
      const res = await fetch(`${nativeBase}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        const names = (data.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        if (names.length > 0) return names;
      }
    } catch {
      // Ollama is not running — fall through to the known list.
    }
    return [...this.knownModels];
  }
}
