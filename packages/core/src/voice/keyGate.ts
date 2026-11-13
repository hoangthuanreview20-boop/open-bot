/**
 * Realtime key gate (v0.98, Đội T5 — voice live).
 *
 * v0.96 added a key gate inside each adapter (`connect()` throws
 * `MissingRealtimeKeyError` when no key resolves). That gate is
 * per-connect and per-adapter: the caller only learns "no key" by
 * trying to dial and catching. This module is the gate *before*
 * the dial — one decision point the UI, the session factory and
 * the diagnostics all share:
 *
 *   decideRealtimeMode(provider, { apiKey, keyResolver, url })
 *     → { mode: 'live' | 'mock', source, keyConfigured, … }
 *
 *   - `live` means a usable key (or a key-less local URL for
 *     `openai-compatible`) was found, so the live adapter may dial.
 *   - `mock` means nothing usable was found, so the caller must
 *     use the mock transport — and must say so in the UI ("cần
 *     key"), never present the mock as live.
 *
 * Key sources, in precedence order:
 *   1. `config` — an explicit `apiKey` passed at connect time.
 *   2. `vault` — a `keyResolver` closure over the app Vault
 *      (the normal path: main passes
 *      `() => vault.getSecret('provider', providerId)`).
 *   3. `env` — `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars
 *      (BYOK convention; only read, never written or logged).
 *   4. `keyless-url` — `openai-compatible` only: a custom URL
 *      pointing at a local endpoint that needs no key.
 *
 * The gate never holds a key value: `decideRealtimeMode` returns
 * the *source*, never the key, and `RealtimeKeyGate` keeps only
 * resolver closures. `assertLive()` throws the same
 * `MissingRealtimeKeyError` the adapters throw, so the two gates
 * agree on the error the UI shows.
 *
 * Model validation lives here too: the Gemini Live API only
 * accepts `*-live-*` / `*-native-audio*` models on
 * `bidiGenerateContent` — a plain text model (e.g.
 * `gemini-2.5-flash`) is rejected by the server *after* the dial,
 * so the gate rejects it *before* the dial with a clear message.
 * The OpenAI Realtime API accepts `gpt-realtime*` /
 * `gpt-4o-realtime*` models; anything else is reported as
 * "not a known realtime model" (a warning, not a hard error —
 * providers add models faster than this list can track, and a
 * custom endpoint may accept anything).
 */
import type { RealtimeProvider } from './types';
import { MissingRealtimeKeyError, REALTIME_KEY_SETTINGS_HINT } from './transportHealth';

/** Default Gemini Live model (GA native-audio model). */
export const GEMINI_LIVE_DEFAULT_MODEL = 'gemini-live-2.5-flash-native-audio';
/** Default OpenAI Realtime model. */
export const OPENAI_REALTIME_DEFAULT_MODEL = 'gpt-4o-realtime-preview';

/** Where a realtime key came from (or that none was found). */
export type RealtimeKeySource = 'config' | 'vault' | 'env' | 'keyless-url' | 'none';

/** Live adapter, or the mock fallback. */
export type RealtimeMode = 'live' | 'mock';

/** One key-gate decision (no key material — only the source). */
export interface KeyGateDecision {
  /** Provider this decision is for. */
  provider: RealtimeProvider;
  /** 'live' when the adapter may dial, 'mock' when it must not. */
  mode: RealtimeMode;
  /** Where the key (or key-less URL) came from. */
  source: RealtimeKeySource;
  /** True when a usable key (or key-less URL) is configured. */
  keyConfigured: boolean;
  /** True when the user must add a key to go live. */
  needsKey: boolean;
  /** Where in Settings the key goes (UI location, not a secret). */
  settingsHint: string;
  /** Plain-language reason, for the UI / diagnostics. */
  reason: string;
  /** When the decision was made (wall clock). */
  at: number;
}

/** Inputs a key-gate decision reads. */
export interface KeyGateInput {
  /** Explicit key passed at connect time (wins over everything). */
  apiKey?: string;
  /** Vault resolver (main's closure over the keyStore). */
  keyResolver?: () => string | null;
  /** Custom endpoint URL (openai-compatible key-less local URL). */
  url?: string;
  /** Env reader (injectable in tests; defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/** Env var names the gate reads as a last-resort key source. */
export const REALTIME_KEY_ENV_VARS: Record<RealtimeProvider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

/**
 * Resolve the key for a provider from the inputs, in precedence
 * order (config > vault > env). Returns the key and its source,
 * or `{ key: null, source: 'none' }`. Never logs the key.
 */
export function resolveRealtimeKeyWithSource(
  provider: RealtimeProvider,
  input: KeyGateInput = {},
): { key: string | null; source: RealtimeKeySource } {
  const direct = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (direct) return { key: direct, source: 'config' };
  try {
    const resolved = input.keyResolver?.();
    const key = typeof resolved === 'string' ? resolved.trim() : '';
    if (key) return { key, source: 'vault' };
  } catch {
    // A throwing Vault resolver is "no key", not a crash.
  }
  const env = input.env ?? process.env;
  const envName = REALTIME_KEY_ENV_VARS[provider];
  const envKey = typeof env[envName] === 'string' ? (env[envName] as string).trim() : '';
  if (envKey) return { key: envKey, source: 'env' };
  return { key: null, source: 'none' };
}

/** Settings hint for a provider (UI location, not a secret). */
export function realtimeSettingsHint(provider: RealtimeProvider): string {
  return REALTIME_KEY_SETTINGS_HINT[provider] ?? 'Settings → API keys';
}

/**
 * Decide live vs mock for one provider. Pure except for the
 * resolver/env reads in `input`. The decision never contains a
 * key value — only where it came from.
 */
export function decideRealtimeMode(
  provider: RealtimeProvider,
  input: KeyGateInput = {},
): KeyGateDecision {
  const at = Date.now();
  const settingsHint = realtimeSettingsHint(provider);
  const { key, source } = resolveRealtimeKeyWithSource(provider, input);
  if (key) {
    const sourceLabel =
      source === 'config'
        ? 'an API key passed at connect time'
        : source === 'vault'
          ? 'the app Vault (Settings → API keys)'
          : `the ${REALTIME_KEY_ENV_VARS[provider]} environment variable`;
    return {
      provider,
      mode: 'live',
      source,
      keyConfigured: true,
      needsKey: false,
      settingsHint,
      reason: `Live ${providerName(provider)} is ready — key found via ${sourceLabel}.`,
      at,
    };
  }
  // openai-compatible may point at a local endpoint that needs no key.
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (provider === 'openai-compatible' && url) {
    return {
      provider,
      mode: 'live',
      source: 'keyless-url',
      keyConfigured: true,
      needsKey: false,
      settingsHint,
      reason: `Live openai-compatible endpoint is configured (${url} — key-less local endpoint).`,
      at,
    };
  }
  return {
    provider,
    mode: 'mock',
    source: 'none',
    keyConfigured: false,
    needsKey: true,
    settingsHint,
    reason:
      `No API key is configured for ${providerName(provider)} — ` +
      `add the provider's own API key in ${settingsHint} for live voice. ` +
      'Mock mode is running instead: the app works, but the voice is scripted, not live.',
    at,
  };
}

/** Display name for a realtime provider. */
export function providerName(provider: RealtimeProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI Realtime';
    case 'gemini':
      return 'Gemini Live';
    case 'openai-compatible':
      return 'OpenAI-compatible realtime';
    default:
      return String(provider);
  }
}

/**
 * Throw `MissingRealtimeKeyError` when the decision is mock, so
 * the pre-dial gate and the adapters' in-connect gate agree on
 * the error. Returns the decision unchanged when live.
 */
export function assertLive(decision: KeyGateDecision): KeyGateDecision {
  if (decision.mode === 'mock') {
    throw new MissingRealtimeKeyError(decision.provider);
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Model validation (before the dial, not after a server rejection)
// ---------------------------------------------------------------------------

/** Pattern a Gemini model id must match to work on the Live API. */
export const GEMINI_LIVE_MODEL_PATTERN = /live|native-audio/i;
/** Pattern an OpenAI model id should match for Realtime. */
export const OPENAI_REALTIME_MODEL_PATTERN = /^(gpt-realtime|gpt-4o-realtime)/i;

/** Result of validating a realtime model id. */
export interface RealtimeModelValidation {
  ok: boolean;
  /** Provider + model that were checked. */
  provider: RealtimeProvider;
  model: string;
  /** Plain-language reason when not ok ('' when ok). */
  reason: string;
}

/** True when the model id can be used on the Gemini Live API. */
export function isGeminiLiveModel(model: string): boolean {
  const id = String(model ?? '').trim();
  if (!id) return false;
  const bare = id.replace(/^models\//, '');
  return GEMINI_LIVE_MODEL_PATTERN.test(bare);
}

/** True when the model id looks like an OpenAI Realtime model. */
export function isOpenAiRealtimeModel(model: string): boolean {
  const id = String(model ?? '').trim();
  if (!id) return false;
  return OPENAI_REALTIME_MODEL_PATTERN.test(id);
}

/**
 * Validate a realtime model id before dialling.
 *   - gemini: a non-live model is a hard `ok: false` — the server
 *     rejects it on `bidiGenerateContent`, so fail fast with the
 *     fix (pick a `*-live-*` / `*-native-audio*` model).
 *   - openai / openai-compatible: an unknown model id is a
 *     warning-shaped `ok: true` with a reason — providers add
 *     models faster than this list tracks, and a custom endpoint
 *     may accept anything, so the dial still goes ahead.
 */
export function validateRealtimeModel(
  provider: RealtimeProvider,
  model: string,
): RealtimeModelValidation {
  const id = String(model ?? '').trim();
  if (provider === 'gemini') {
    if (!id) {
      return {
        ok: true,
        provider,
        model: GEMINI_LIVE_DEFAULT_MODEL,
        reason: `No model given — defaulting to ${GEMINI_LIVE_DEFAULT_MODEL}.`,
      };
    }
    if (isGeminiLiveModel(id)) {
      return { ok: true, provider, model: id, reason: '' };
    }
    return {
      ok: false,
      provider,
      model: id,
      reason:
        `Model "${id}" is not a Gemini Live model — the Live API (bidiGenerateContent) ` +
        `only accepts *-live-* / *-native-audio* models such as ${GEMINI_LIVE_DEFAULT_MODEL}. ` +
        'A plain text model (e.g. gemini-2.5-flash) is rejected by the server; pick a live model in Settings.',
    };
  }
  if (!id) {
    return {
      ok: true,
      provider,
      model: OPENAI_REALTIME_DEFAULT_MODEL,
      reason: `No model given — defaulting to ${OPENAI_REALTIME_DEFAULT_MODEL}.`,
    };
  }
  if (isOpenAiRealtimeModel(id)) {
    return { ok: true, provider, model: id, reason: '' };
  }
  return {
    ok: true,
    provider,
    model: id,
    reason:
      `Model "${id}" is not a known OpenAI Realtime model ` +
      `(expected gpt-realtime* / gpt-4o-realtime*) — dialling anyway; ` +
      'a custom endpoint may accept it, but the server may reject it.',
  };
}

// ---------------------------------------------------------------------------
// Gate object (one per app — holds the Vault resolvers)
// ---------------------------------------------------------------------------

/** Per-provider Vault resolvers, registered once by main. */
export type RealtimeKeyResolverMap = Partial<
  Record<RealtimeProvider, () => string | null>
>;

/**
 * The app-wide key gate. Main registers one resolver per provider
 * (a closure over the Vault — the gate never sees a key value,
 * only the resolver's boolean answer via `decideRealtimeMode`).
 * `decide()` / `decideAll()` are what the UI and the session
 * factory call; `liveProviders()` lists what can go live now.
 */
export class RealtimeKeyGate {
  private readonly resolvers = new Map<RealtimeProvider, () => string | null>();
  private readonly env: Record<string, string | undefined>;

  constructor(options: { resolvers?: RealtimeKeyResolverMap; env?: Record<string, string | undefined> } = {}) {
    for (const [provider, resolver] of Object.entries(options.resolvers ?? {})) {
      if (typeof resolver === 'function') {
        this.resolvers.set(provider as RealtimeProvider, resolver);
      }
    }
    this.env = options.env ?? process.env;
  }

  /** Register (or replace) the Vault resolver for a provider. */
  registerResolver(provider: RealtimeProvider, resolver: () => string | null): void {
    this.resolvers.set(provider, resolver);
  }

  /** Drop the resolver for a provider (key removed / provider disabled). */
  unregisterResolver(provider: RealtimeProvider): void {
    this.resolvers.delete(provider);
  }

  /** Decide live vs mock for one provider (Vault resolver + env + URL). */
  decide(
    provider: RealtimeProvider,
    input: Omit<KeyGateInput, 'keyResolver' | 'env'> & { apiKey?: string } = {},
  ): KeyGateDecision {
    return decideRealtimeMode(provider, {
      apiKey: input.apiKey,
      keyResolver: this.resolvers.get(provider),
      url: input.url,
      env: this.env,
    });
  }

  /** Decide for every provider (the Settings / diagnostics view). */
  decideAll(
    urls: Partial<Record<RealtimeProvider, string>> = {},
  ): Record<RealtimeProvider, KeyGateDecision> {
    return {
      openai: this.decide('openai', { url: urls.openai }),
      gemini: this.decide('gemini', { url: urls.gemini }),
      'openai-compatible': this.decide('openai-compatible', { url: urls['openai-compatible'] }),
    };
  }

  /** Providers that can go live right now (mode === 'live'). */
  liveProviders(urls: Partial<Record<RealtimeProvider, string>> = {}): RealtimeProvider[] {
    const all = this.decideAll(urls);
    return (Object.keys(all) as RealtimeProvider[]).filter((p) => all[p]?.mode === 'live');
  }

  /** True when at least one provider can go live right now. */
  hasAnyLive(urls: Partial<Record<RealtimeProvider, string>> = {}): boolean {
    return this.liveProviders(urls).length > 0;
  }
}
