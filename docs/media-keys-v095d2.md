# Media keys — Settings → Media keys (v0.95, Team D2)

User-supplied API keys for image/video generation models. Huy's
direction 2026-11-12: no Grok Imagine — the user pastes their own
key for the image/video model of their choice. The product is free
and local-first, so there is no built-in image/video model.

## Where keys live

- Vault namespace **`media`**, one entry per provider id
  (`packages/core/src/media/mediaKeys.ts`). Only the key is stored —
  never logged, never in an error message, never returned to the
  renderer in full. The UI only ever sees `{configured, suffix}`
  where suffix is the last 4 characters.
- Providers (7): **OpenAI** (image + video), **Gemini** (image),
  **Stability** (image), **Replicate** (image + video), **Runway**
  (video), **Luma** (video), **Pika** (video).

## How a key reaches a tool call

1. Main reads the Vault (safeStorage) and seeds the coordinator in
   memory — RPC `media.setKey` / `media.getKeyStatus` and the
   `mediaApiKeys` param of `createBot` (same pattern as
   `composio.setApiKey`). The child never touches the Vault file.
2. The coordinator's `getProviderConfigFor` falls back to the seeded
   media key when no bot uses that provider (or the bot has no key):
   config is built by `buildMediaProviderConfig` (base URL + default
   image/video model per provider).
3. `image_generate` / `video_generate` resolve through the existing
   `getProviderConfig` host hook. No key → the tool returns a clear
   error pointing at Settings → Media keys; the feature degrades to
   that message instead of crashing, and the app is never blocked.

## Built-in clients vs key-only providers

Only **OpenAI** (image via `/images/generations`, video via the
Sora-shaped async job) and **Gemini** (image via `generateContent`,
see `geminiImage.ts`) have built-in HTTP clients. Stability,
Replicate, Runway, Luma and Pika keys are stored and resolved, but
calling them fails with a clear no-client message instead of
guessing their wire shape — video can be wired through the tool
factory's `createVideoProvider`.

## UI + IPC

- Settings → Bot & Model → **Media keys** section
  (`MediaKeysSection.tsx`, self-contained like
  `CrashReportsSection`): per-provider status, password input +
  save/clear, short "where to get a key" hint (plain text, official
  domain names only, no links).
- IPC `media:get-status` / `media:set-key` / `media:clear-key`
  (main), preload + `global.d.ts` mirrors. `set-key`/`clear-key`
  re-seed the coordinator immediately — no app restart.
- i18n: 23 keys under `settings.mediaKeys.*` in all 6 locales
  (vi/en/zh/ja/es/fr); 1538 → 1561 keys/locale.

## Tests

- `tests/media-keys-v095d2.test.mjs` (14 tests): Vault CRUD +
  validation + suffix-only status, coordinator RPC seed/rotate/
  clear + `getProviderConfigFor` fallback, tool missing-key and
  no-client errors, OpenAI video job through a media-resolved
  config (MOCK provider, no network).
- `tests/media-keys-v095d2-renderer.test.mjs` (4 tests, real
  Electron under xvfb): 7 providers render, save shows the suffix
  and clears the input, clear flips back to missing, load error.
  All keys in tests are FAKE.

## Not verified live

No media key exists in this app's Vault, and keys are never copied
from the connector store — so **no live image/video generation was
attempted**. Live verification needs a user key with quota pasted
in Settings → Media keys (OpenAI image/video and Gemini image are
the callable paths; the free Gemini key's image quota was already
0 in the v0.89b attempt).
