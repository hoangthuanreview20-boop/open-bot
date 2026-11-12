/**
 * Gemini image generation for @open-bot/tools (v0.87d).
 *
 * `image_generate` used to know only the OpenAI-shaped image API
 * (POST `/images/generations`, OpenAI + xAI). Gemini image models do
 * NOT speak that shape: they generate images through the same
 * `generateContent` endpoint as text models and return the bytes as an
 * inline part. This module is the Gemini backend for that tool.
 *
 * API shape (checked against official Google docs, 2026-11-11)
 * ------------------------------------------------------------
 * Request: POST `{baseUrl}/models/{model}:generateContent?key=<key>`
 *   { "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
 *     "generationConfig": {
 *       "responseModalities": ["TEXT", "IMAGE"],
 *       "imageConfig": { "aspectRatio": "1:1", "imageSize": "1K" } } }
 * Response: `candidates[0].content.parts[]` — the first part carrying
 * `inlineData` (or `inline_data`) `{ mimeType, data }` holds the
 * base64 image bytes. A text-only reply (e.g. a safety refusal) has no
 * such part and is reported as an error, with the model text included
 * (truncated) so the caller can see why.
 *
 * Sources:
 *  - https://ai.google.dev/gemini-api/docs/image-generation — the
 *    Nano Banana model list (default `gemini-nano-banana-2.1`, plus
 *    `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`,
 *    `gemini-3-pro-image`, legacy `gemini-2.5-flash-image`) and the
 *    fact that generated images carry a SynthID watermark.
 *  - Google's Gemini API reference (generateContent): the standard
 *    endpoint returns a GenerateContentResponse whose candidates carry
 *    `inline_data` Blob parts; `responseModalities` must include
 *    IMAGE for image output, and `imageConfig` carries `aspectRatio`
 *    (1:1, 4:3, 16:9, 9:16, 21:9) and `imageSize` (1K, 2K, 4K tiers).
 *  - Auth uses `?key=` — the same placement the in-repo
 *    GeminiProvider already uses for chat (live-verified 2026-11-09);
 *    Google's docs also accept the `x-goog-api-key` header.
 *
 * Deliberately NOT used: the newer Interactions API
 * (POST `/v1beta/interactions`, SDK property `interaction.output_image`)
 * is now the primary path in Google's image-generation docs, but the
 * docs page shows only SDK usage — its raw REST response envelope is
 * not pinned down there, so wiring it would mean guessing the shape.
 * Follow-up once a live Gemini key test is possible: try Interactions
 * against a real key and switch the default if its envelope checks out.
 *
 * LIVE GENERATION THROUGH THIS PROVIDER — first live attempt
 * 2026-11-11 (v0.89b): called the real API through the local proxy
 * (port 8766, dummy apiKey 'via-proxy') with the default model and
 * two alternates — all three came back HTTP 429 with quota limit 0
 * on the free key (`gemini-nano-banana-2.1`: input-token/min limit 0;
 * `gemini-2.5-flash-image`: requests/day limit 0; `gemini-3.1-flash-image`:
 * input-token/min limit 0). No image was ever produced or saved.
 * The same key still answers text (`gemini-2.5-flash` HTTP 200 the
 * same day), so the block is image-quota-specific, not a dead key —
 * live verification needs a key with image quota/billing. Indirect
 * evidence only: the server accepted the request shape up to quota
 * accounting (a malformed request would be 400, a wrong model 404),
 * and the 429 error path surfaced end-to-end exactly as coded.
 * Default model unchanged (no live evidence favours any alternate).
 * Tests use a mocked global fetch plus a Mock* provider, and assert
 * the exact request URL/body shape. No local free image model exists
 * on this machine either (Ollama here serves text/embedding models
 * only), so a live check cannot be done locally without a key.
 *
 * No secrets live here — the API key arrives per call in the input
 * (resolved by the host from the Vault) and is never written to a
 * file or a log.
 */

const FETCH_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_CHARS = 500;
const MAX_MODEL_TEXT_CHARS = 500;

/** Default Gemini image model: the current primary Nano Banana model. */
export const GEMINI_DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';

/**
 * Gemini image models known to this module, from the official model
 * list on https://ai.google.dev/gemini-api/docs/image-generation
 * (2026-11-11). `gemini-2.5-flash-image` is the legacy first
 * Nano Banana model; the docs recommend migrating off it.
 */
export const GEMINI_IMAGE_MODELS: readonly string[] = [
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image',
];

/** Aspect ratios the docs list for `imageConfig.aspectRatio`. */
const KNOWN_ASPECT_RATIOS: readonly { ratio: number; value: string }[] = [
  { ratio: 1, value: '1:1' },
  { ratio: 4 / 3, value: '4:3' },
  { ratio: 16 / 9, value: '16:9' },
  { ratio: 9 / 16, value: '9:16' },
  { ratio: 21 / 9, value: '21:9' },
];

/** A ratio within this distance of a listed value maps to it. */
const ASPECT_RATIO_TOLERANCE = 0.08;

export interface GeminiImageConfig {
  aspectRatio?: string;
  imageSize: string;
}

/**
 * Map a `"<width>x<height>"` size to Gemini `imageConfig`.
 * aspectRatio is only sent when the ratio is close to a value the
 * docs list — anything else (e.g. 3:4 portrait) is left out rather
 * than guessed, and the model picks its default. imageSize is the
 * nearest resolution tier from the longest side (1K ≈ 1024,
 * 2K ≈ 2048, 4K ≈ 4096; boundaries at the midpoints 1536 and 3072).
 * Pure function (unit-tested).
 */
export function geminiImageConfigForSize(size: string): GeminiImageConfig {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    throw new Error(`Invalid "size" "${size}": expected e.g. "1024x1024".`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid "size" "${size}": dimensions must be positive.`);
  }
  const ratio = width / height;
  const nearest = KNOWN_ASPECT_RATIOS.reduce<{ ratio: number; value: string } | null>(
    (best, entry) =>
      best === null || Math.abs(entry.ratio - ratio) < Math.abs(best.ratio - ratio)
        ? entry
        : best,
    null,
  );
  const longest = Math.max(width, height);
  const config: GeminiImageConfig = {
    imageSize: longest <= 1536 ? '1K' : longest <= 3072 ? '2K' : '4K',
  };
  if (nearest && Math.abs(nearest.ratio - ratio) <= ASPECT_RATIO_TOLERANCE) {
    config.aspectRatio = nearest.value;
  }
  return config;
}

export interface GeminiImageResult {
  /** Raw image bytes (decoded from the base64 inline part). */
  bytes: Buffer;
  /** MIME type from the inline part, e.g. 'image/png'. */
  mimeType: string;
}

/** One part of a Gemini `candidates[].content.parts[]` array. */
function inlineDataOf(part: unknown): { mimeType: string; data: string } | null {
  if (typeof part !== 'object' || part === null) return null;
  const record = part as Record<string, unknown>;
  // The REST API returns camelCase `inlineData`; some clients and
  // proxies surface snake_case `inline_data` — accept both.
  const raw = record['inlineData'] ?? record['inline_data'];
  if (typeof raw !== 'object' || raw === null) return null;
  const blob = raw as Record<string, unknown>;
  const data = blob['data'];
  if (typeof data !== 'string' || data.length === 0) return null;
  const mimeType = blob['mimeType'] ?? blob['mime_type'];
  return {
    mimeType: typeof mimeType === 'string' && mimeType.length > 0 ? mimeType : 'image/png',
    data,
  };
}

/**
 * Extract the generated image from a `generateContent` response body.
 * Returns the first inline-data part's bytes + MIME type. Throws a
 * clear error when there is no image part (a text-only reply, e.g. a
 * safety refusal, surfaces its text truncated). Pure function
 * (unit-tested).
 */
export function parseGeminiImageResponse(body: unknown): GeminiImageResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Gemini image API returned an unexpected response shape (not an object).');
  }
  const candidates = (body as Record<string, unknown>)['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Gemini image API returned no candidates (empty "candidates" array).');
  }
  const first = candidates[0];
  if (typeof first !== 'object' || first === null) {
    throw new Error('Gemini image API returned an unexpected candidate shape.');
  }
  const content = (first as Record<string, unknown>)['content'];
  const parts =
    typeof content === 'object' && content !== null
      ? (content as Record<string, unknown>)['parts']
      : undefined;
  if (!Array.isArray(parts)) {
    throw new Error('Gemini image API returned no content parts (no "content.parts" array).');
  }
  for (const part of parts) {
    const inline = inlineDataOf(part);
    if (inline) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(inline.data, 'base64');
      } catch {
        throw new Error('Gemini image API returned inline image data that is not valid base64.');
      }
      if (bytes.length === 0) {
        throw new Error('Gemini image API returned empty inline image data.');
      }
      return { bytes, mimeType: inline.mimeType };
    }
  }
  // No image part: surface the model's text (if any) so the caller
  // can see whether it was a refusal or an unexpected reply.
  const text = parts
    .filter(
      (p): p is { text: string } =>
        typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>)['text'] === 'string',
    )
    .map((p) => p.text)
    .join(' ')
    .trim();
  throw new Error(
    text.length > 0
      ? `Gemini image API returned no image (model text: "${text.slice(0, MAX_MODEL_TEXT_CHARS)}${text.length > MAX_MODEL_TEXT_CHARS ? '…' : ''}").`
      : 'Gemini image API returned no image (no inlineData part in the response).',
  );
}

/** File extension for a Gemini image MIME type (defaults to .png). */
export function extFromGeminiMimeType(mimeType: string): string {
  const clean = mimeType.split(';')[0].trim().toLowerCase();
  if (clean === 'image/jpeg' || clean === 'image/jpg') return '.jpg';
  if (clean === 'image/webp') return '.webp';
  return '.png';
}

export interface GeminiImageGenerateInput {
  /** API key, resolved by the host from the Vault. Never logged. */
  apiKey: string;
  /** API base URL, e.g. 'https://generativelanguage.googleapis.com/v1beta'. */
  baseUrl: string;
  /** Gemini image model, e.g. 'gemini-nano-banana-2.1'. */
  model: string;
  /** Text description of the image to generate. */
  prompt: string;
  /** Size as "WxH", e.g. "1024x1024" (mapped to aspectRatio/imageSize). */
  size: string;
}

/** Backend that generates one image with Gemini. A host can substitute its own. */
export interface GeminiImageProvider {
  generateImage(input: GeminiImageGenerateInput): Promise<GeminiImageResult>;
}

/** fetch() with a hard timeout. Throws on timeout / network error. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Built-in HTTP Gemini image provider: plain fetch, no SDK.
 * Auth is `?key=` (same placement as the in-repo GeminiProvider for
 * chat); the key is only ever sent to Google's API host, never logged.
 */
export class HttpGeminiImageProvider implements GeminiImageProvider {
  async generateImage(input: GeminiImageGenerateInput): Promise<GeminiImageResult> {
    if (!input.apiKey) {
      throw new Error('Gemini image generation needs an API key (Vault namespace \'provider\').');
    }
    if (!input.baseUrl) {
      throw new Error('Gemini image generation needs a baseUrl configured.');
    }
    if (!input.model) {
      throw new Error('Gemini image generation needs an image model (e.g. "gemini-nano-banana-2.1").');
    }
    const imageConfig = geminiImageConfigForSize(input.size);
    const url =
      `${input.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(input.model)}:generateContent` +
      `?key=${encodeURIComponent(input.apiKey)}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig,
          },
        }),
      });
    } catch (err) {
      throw new Error(
        `Gemini image generation request failed (network error: ${(err as Error).message}). No image was saved.`,
      );
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const detail = bodyText.length > MAX_ERROR_BODY_CHARS
        ? bodyText.slice(0, MAX_ERROR_BODY_CHARS) + '…'
        : bodyText;
      throw new Error(
        `Gemini image generation failed with HTTP ${res.status}: ${detail || res.statusText}. No image was saved.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error('Gemini image API returned a response that is not valid JSON.');
    }
    return parseGeminiImageResponse(parsed);
  }
}
