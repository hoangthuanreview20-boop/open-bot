/**
 * Groq provider — POST https://api.groq.com/openai/v1/chat/completions.
 * Groq speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * Model notes (checked against Groq's docs, 2026-11):
 *  - `llama-3.3-70b-versatile` is the general-purpose workhorse and
 *    the default here (same default as the `groq` preset in
 *    models/presets.ts, so bots created from the preset keep working
 *    unchanged). `llama-3.1-8b-instant` is the fastest/cheapest;
 *    `meta-llama/llama-4-scout-17b-16e-instruct` is multimodal;
 *    `openai/gpt-oss-120b` / `openai/gpt-oss-20b` are reasoning models;
 *    `qwen/qwen3-32b` is the Qwen option on Groq.
 *  - Groq's free tier is rate-limited per model (RPM / RPD / TPM /
 *    TPD) and the catalog rotates without much notice — when the
 *    endpoint answers, `listModels()` returns the live catalog;
 *    otherwise it falls back to GROQ_KNOWN_MODELS.
 *  - Groq rejects a few OpenAI parameters (`logprobs`, `logit_bias`,
 *    `messages[].name`, `n` other than 1) — this transport never sends
 *    them, so no special-casing is needed here.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** General-purpose workhorse — default for new Groq bots. */
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';
/** Models listed when the API does not return a model list. */
export const GROQ_KNOWN_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3-32b',
];

export class GroqProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'groq',
        label: config.label || 'Groq',
        baseUrl: config.baseUrl ?? GROQ_BASE_URL,
        defaultModel: config.defaultModel || GROQ_DEFAULT_MODEL,
      },
      GROQ_KNOWN_MODELS,
    );
  }
}
