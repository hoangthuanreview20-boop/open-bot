/**
 * Moonshot AI (Kimi) provider — POST https://api.moonshot.ai/v1/chat/completions.
 * Moonshot speaks the OpenAI chat-completions API, so the transport is
 * shared with openaiCompatible.ts. No SDK, plain fetch.
 *
 * Model notes (checked against Moonshot's docs, 2026-11):
 *  - Current flagship is `kimi-k3` (July 2026, 1M context, native
 *    vision, always-on thinking) and the default here. `kimi-k2.6`
 *    (256K context) is the cheaper general model; `kimi-k2.7-code`
 *    and `kimi-k2.7-code-highspeed` are coding-tuned.
 *  - The `moonshot-v1-*` family and `kimi-k2.5` were retired on
 *    2026-08-31 and are intentionally NOT in the known list.
 *  - This is the INTERNATIONAL endpoint (platform.moonshot.ai).
 *    Mainland-China accounts use https://api.moonshot.cn/v1 instead
 *    (region-locked keys) — the user can override baseUrl in Settings.
 *  - `listModels()` falls back to MOONSHOT_KNOWN_MODELS when the
 *    endpoint has no list API or is unreachable.
 */

import type { ProviderConfig } from '../types';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
/** Kimi K3 flagship — default for new Moonshot bots. */
export const MOONSHOT_DEFAULT_MODEL = 'kimi-k3';
/** Models listed when the API does not return a model list. */
export const MOONSHOT_KNOWN_MODELS = [
  'kimi-k3',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
];

export class MoonshotProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        id: 'moonshot',
        label: config.label || 'Moonshot (Kimi)',
        baseUrl: config.baseUrl ?? MOONSHOT_BASE_URL,
        defaultModel: config.defaultModel || MOONSHOT_DEFAULT_MODEL,
      },
      MOONSHOT_KNOWN_MODELS,
    );
  }
}
