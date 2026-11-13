/**
 * Media keys (v0.95, Team D2) — user-supplied API keys for image/video
 * generation models, stored in their own Vault namespace.
 *
 * Huy's direction 2026-11-12: NO Grok Imagine — instead the user
 * pastes their own key for the image/video model of their choice.
 * The product is free and local-first, so there is no built-in
 * image/video model: every key here belongs to the user, lives only
 * in the Vault (namespace 'media'), and is resolved at call time.
 *
 * Providers (at least the 4 the wave asked for; 7 in total):
 *   openai    — image (gpt-image-1) + video (sora-2), built-in HTTP
 *               clients exist in @open-bot/tools (webMedia/videoJobs).
 *   gemini    — image (Nano Banana), built-in client in geminiImage.ts.
 *   stability — image only; key stored + resolved, no built-in HTTP
 *               client yet (its API is multipart, not the OpenAI
 *               shape) — a host can pass its own provider through the
 *               createGeminiImageProvider / createVideoProvider
 *               factories, or an explicit imageModel/videoEndpoint.
 *   replicate — image + video; same key-only status (model ids are
 *               user-supplied, e.g. black-forest-labs/flux-schnell).
 *   runway    — video only (gen-4-turbo); key-only.
 *   luma      — video only (ray-2); key-only.
 *   pika      — video only; key-only.
 *
 * Safety rules (same as the Composio key store):
 *  - Only the key is stored — never logged, never put in an error
 *    message, never returned to the renderer in full. The UI only
 *    ever sees `{configured, suffix}` where suffix is the last 4
 *    characters, so the user can tell keys apart.
 *  - An empty / whitespace-only key counts as "not configured" and
 *    is never written to the Vault.
 *  - This module knows nothing about Electron or the renderer: the
 *    main process owns the Vault and seeds keys to the coordinator
 *    in memory (RPC `media.setKey`, like `composio.setApiKey`).
 */

import type { Vault as VaultType } from '../vault/vault';

/** Vault namespace holding media (image/video) provider keys. */
export const MEDIA_VAULT_NAMESPACE = 'media';

/** What a media provider can generate. */
export type MediaKind = 'image' | 'video';

/**
 * Whether @open-bot/tools has a built-in HTTP client for this
 * provider. 'builtin' = image_generate / video_generate can call it
 * directly once the key is configured. 'key-only' = the key is
 * stored and resolved for the host, but the tool has no built-in
 * client for that provider's API shape yet — calling it without an
 * explicit model/endpoint (or a host-provided provider) fails with
 * a clear error instead of guessing the wire shape.
 */
export type MediaClientStatus = 'builtin' | 'key-only';

/** One image/video provider the user can bring a key for. */
export interface MediaProviderDef {
  /** Provider id — also the Vault key inside namespace 'media'. */
  id: string;
  kinds: readonly MediaKind[];
  /** Default image model, when the provider has a known one. */
  defaultImageModel?: string;
  /** Default video model, when the provider has a known one. */
  defaultVideoModel?: string;
  /** API base URL used when the host builds a provider config. */
  baseUrl: string;
  clientStatus: MediaClientStatus;
  /** i18n key for the short "where to get a key" hint in Settings. */
  hintKey: string;
}

/**
 * The media providers. Order is the order Settings renders them.
 * Models/base URLs are the providers' public defaults (checked
 * 2026-11-12); a host may override the model per call.
 */
export const MEDIA_PROVIDERS: readonly MediaProviderDef[] = [
  {
    id: 'openai',
    kinds: ['image', 'video'],
    defaultImageModel: 'gpt-image-1',
    defaultVideoModel: 'sora-2',
    baseUrl: 'https://api.openai.com/v1',
    clientStatus: 'builtin',
    hintKey: 'settings.mediaKeys.hint.openai',
  },
  {
    id: 'gemini',
    kinds: ['image'],
    defaultImageModel: 'gemini-nano-banana-2.1',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    clientStatus: 'builtin',
    hintKey: 'settings.mediaKeys.hint.gemini',
  },
  {
    id: 'stability',
    kinds: ['image'],
    defaultImageModel: 'sd3.5-large',
    baseUrl: 'https://api.stability.ai/v2beta',
    clientStatus: 'key-only',
    hintKey: 'settings.mediaKeys.hint.stability',
  },
  {
    id: 'replicate',
    kinds: ['image', 'video'],
    baseUrl: 'https://api.replicate.com/v1',
    clientStatus: 'key-only',
    hintKey: 'settings.mediaKeys.hint.replicate',
  },
  {
    id: 'runway',
    kinds: ['video'],
    defaultVideoModel: 'gen-4-turbo',
    baseUrl: 'https://api.dev.runwayml.com/v1',
    clientStatus: 'key-only',
    hintKey: 'settings.mediaKeys.hint.runway',
  },
  {
    id: 'luma',
    kinds: ['video'],
    defaultVideoModel: 'ray-2',
    baseUrl: 'https://api.lumalabs.ai/dream-machine/v1',
    clientStatus: 'key-only',
    hintKey: 'settings.mediaKeys.hint.luma',
  },
  {
    id: 'pika',
    kinds: ['video'],
    defaultVideoModel: 'pika-2.2',
    baseUrl: 'https://api.pika.art/v1',
    clientStatus: 'key-only',
    hintKey: 'settings.mediaKeys.hint.pika',
  },
];

/** Provider ids, in Settings render order. */
export const MEDIA_PROVIDER_IDS: readonly string[] = MEDIA_PROVIDERS.map((p) => p.id);

/** Look a provider definition up by id; undefined when unknown. */
export function getMediaProvider(providerId: string): MediaProviderDef | undefined {
  return MEDIA_PROVIDERS.find((p) => p.id === providerId);
}

/** True when the id is one of the known media providers. */
export function isMediaProviderId(providerId: unknown): providerId is string {
  return typeof providerId === 'string' && getMediaProvider(providerId) !== undefined;
}

/** Longest key accepted (same cap as the Composio set-key channel). */
export const MEDIA_API_KEY_MAX_LENGTH = 500;

/**
 * Validate + normalise a media API key typed by the user. Returns
 * the trimmed key; throws a clear error (no key content in it) for
 * an empty / over-long / control-character value. Callers that want
 * to delete use `clearMediaApiKey`, never an empty save.
 */
export function validateMediaApiKey(apiKey: unknown): string {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Media API key must not be empty.');
  }
  const key = apiKey.trim();
  if (key.length > MEDIA_API_KEY_MAX_LENGTH) {
    throw new Error(
      `Media API key is too long (max ${MEDIA_API_KEY_MAX_LENGTH} characters) — check the pasted key.`,
    );
  }
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new Error('Media API key must not contain control characters.');
  }
  return key;
}

/** Minimal Vault API this key store needs (the real Vault matches). */
export interface MediaKeyVault {
  getSecret(namespace: string, key: string): string | null;
  setSecret(namespace: string, key: string, value: string): void;
  deleteSecret(namespace: string, key: string): boolean;
  listSecrets(namespace: string): string[];
}

/** Cast a real Vault to the minimal interface (keeps tests injectable). */
export function asMediaKeyVault(vault: VaultType): MediaKeyVault {
  return vault;
}

/**
 * Read one provider's media key from the Vault; null when not
 * configured. Never logs the value.
 */
export function getMediaApiKey(vault: MediaKeyVault, providerId: string): string | null {
  if (!isMediaProviderId(providerId)) return null;
  const raw = vault.getSecret(MEDIA_VAULT_NAMESPACE, providerId);
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key ? key : null;
}

/** True when a usable key is stored for this provider (boolean only). */
export function hasMediaApiKey(vault: MediaKeyVault, providerId: string): boolean {
  return getMediaApiKey(vault, providerId) !== null;
}

/**
 * Save a provider's media key to the Vault. Unknown provider ids
 * and empty keys throw a clear error and write nothing. The key is
 * never logged.
 */
export function setMediaApiKey(vault: MediaKeyVault, providerId: string, apiKey: string): void {
  if (!isMediaProviderId(providerId)) {
    throw new Error(`Unknown media provider "${providerId}".`);
  }
  vault.setSecret(MEDIA_VAULT_NAMESPACE, providerId, validateMediaApiKey(apiKey));
}

/** Delete a provider's media key from the Vault. True when one existed. */
export function clearMediaApiKey(vault: MediaKeyVault, providerId: string): boolean {
  if (!isMediaProviderId(providerId)) return false;
  return vault.deleteSecret(MEDIA_VAULT_NAMESPACE, providerId);
}

/**
 * Last 4 characters of a key, for the UI ("…abcd") — enough to tell
 * keys apart, never enough to reuse one. Empty/short keys yield ''.
 * This is the ONLY part of a key the renderer ever sees.
 */
export function maskMediaKeySuffix(apiKey: string | null | undefined): string | null {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  if (apiKey.length <= 4) return apiKey;
  return apiKey.slice(-4);
}

/** One provider's key status as the renderer sees it — no key value. */
export interface MediaKeyStatusEntry {
  configured: boolean;
  /** Last 4 chars of the key, or null when not configured. */
  suffix: string | null;
}

/** Key status for every media provider (renderer-safe: no values). */
export function getMediaKeyStatus(vault: MediaKeyVault): Record<string, MediaKeyStatusEntry> {
  const out: Record<string, MediaKeyStatusEntry> = {};
  for (const def of MEDIA_PROVIDERS) {
    const key = getMediaApiKey(vault, def.id);
    out[def.id] = { configured: key !== null, suffix: maskMediaKeySuffix(key) };
  }
  return out;
}

/**
 * Read ALL configured media keys (main process only — it owns the
 * Vault and seeds the coordinator in memory). Returns
 * `{providerId: key}` for configured providers only. Never call
 * from the renderer or log the result.
 */
export function getAllMediaApiKeys(vault: MediaKeyVault): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of MEDIA_PROVIDERS) {
    const key = getMediaApiKey(vault, def.id);
    if (key !== null) out[def.id] = key;
  }
  return out;
}

/**
 * Error text for a missing media key, used by the image/video tools
 * and the coordinator. Points at Settings → Media keys and names
 * what the provider can do — the feature degrades to this message
 * instead of crashing, and the app is never blocked by a missing key.
 */
export function mediaKeyMissingMessage(providerId: string): string {
  const def = getMediaProvider(providerId);
  const kinds = def ? def.kinds.join(' + ') : 'image/video';
  return (
    `No ${kinds} API key is configured for provider "${providerId}". ` +
    `Add the provider's own API key in Settings → Media keys first — ` +
    `image/video generation is bring-your-own-key, and the app keeps ` +
    `working without it.`
  );
}

/**
 * Error text for a media provider whose key is configured but which
 * has no built-in HTTP client in this build (key-only provider).
 * Names the real escape hatch instead of guessing the wire shape:
 * image has no generic host-provider factory yet (only OpenAI and
 * Gemini can be called directly); video can be wired through the
 * tool factory's `createVideoProvider`.
 */
export function mediaProviderNoClientMessage(providerId: string, kind: MediaKind): string {
  const def = getMediaProvider(providerId);
  const kinds = def ? def.kinds.join(' + ') : 'image/video';
  if (kind === 'video') {
    return (
      `Provider "${providerId}" (${kinds}) has a key configured, but this build ` +
      `has no built-in video-generation client for its API shape yet — ` +
      `only OpenAI (Sora shape) can be called directly. ` +
      `Wire a host provider through the tool factory's createVideoProvider ` +
      `to call this provider. No video was generated.`
    );
  }
  return (
    `Provider "${providerId}" (${kinds}) has a key configured, but this build ` +
    `has no built-in image-generation client for its API shape yet — ` +
    `only OpenAI and Gemini can be called directly. ` +
    `No image was generated.`
  );
}

/** Strip a key out of a message before logging/throwing it. */
export function redactMediaKey(message: string, apiKey?: string | null): string {
  if (!message || !apiKey) return message;
  return message.split(apiKey).join('[media-key-redacted]');
}

/**
 * Build a ProviderMediaConfig (the shape webMedia's
 * `getProviderConfig` returns) from a registry definition + a
 * resolved key. Pure function — the coordinator's
 * `getProviderConfigFor` media fallback and the tests share it.
 * Returns null when the provider is unknown or the key is empty.
 */
export function buildMediaProviderConfig(
  providerId: string,
  apiKey: string | null | undefined,
): {
  id: string;
  apiKey: string;
  baseUrl: string;
  imageModel?: string;
  videoModel?: string;
} | null {
  const def = getMediaProvider(providerId);
  if (!def) return null;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return null;
  return {
    id: def.id,
    apiKey: key,
    baseUrl: def.baseUrl,
    ...(def.defaultImageModel ? { imageModel: def.defaultImageModel } : {}),
    ...(def.defaultVideoModel ? { videoModel: def.defaultVideoModel } : {}),
  };
}
