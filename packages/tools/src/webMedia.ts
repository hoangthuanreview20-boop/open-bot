/**
 * Web & media tools for @open-bot/tools (v0.6).
 *
 *   x_search          — search X via the X API when a bearer token is
 *                       configured; otherwise falls back to web search
 *                       (`site:x.com`) and SAYS SO in the result.
 *   image_generate    — generate an image via a provider's image API
 *                       (OpenAI / xAI via `/images/generations`;
 *                       Gemini Nano Banana via `generateContent`,
 *                       see geminiImage.ts). Saved into the workspace.
 *   video_generate    — v0.86b (P1-5): creates an ASYNC video job
 *                       (VideoJobStore, durable across restarts) and
 *                       starts a background driver that polls the
 *                       provider until done/failed/timeout/cancel;
 *                       returns the job id at once. Live generation
 *                       needs a provider key + video model (OpenAI
 *                       Sora shape, see videoJobs.ts) — NOT
 *                       live-verified on this machine (no key here).
 *   video_status      — v0.86b (P1-5): poll a video job's status
 *                       (queued/running/done/failed/cancelled/
 *                       timed_out); best-effort refreshes from the
 *                       provider when a provider job id is known.
 *   video_cancel      — v0.86b (P1-5): cancel a queued/running job.
 *   video_from_images — assemble workspace images into an mp4 slideshow
 *                       with ffmpeg (no provider call, no API cost).
 *   canvas_read / canvas_write / canvas_list — versioned interactive
 *                       documents backed by CanvasStore (@open-bot/core).
 *
 * How secrets reach these tools (never hard-coded, never read here):
 *  - X bearer token: the host passes `getXBearer`, which reads the Vault
 *    namespace 'x' (e.g. key 'bearer'). The tool never touches the Vault
 *    or settings.json itself, and never logs the token.
 *  - Provider keys: the host passes `getProviderConfig(providerId)`,
 *    which reads the key from the Vault namespace 'provider' (keyed by
 *    provider id) and the base URL / model from the provider presets and
 *    model registry. The tool only receives the resolved config for the
 *    one call it is about to make, and never logs the key.
 *
 * Factory (same pattern as createSubagentTools / createPlanTools):
 *   createWebMediaTools(opts?) -> Tool[]   (bound, usable)
 *   WEB_MEDIA_TOOLS                        (unbound placeholders)
 *   createCanvasTools() -> Tool[]          (no options needed: the store
 *                       is built per call from ctx.workspaceDir/botId)
 *   CANVAS_TOOLS
 *
 * NOTE on x_search: CODE_TOOLS already ships a fallback-only `x_search`
 * (see codeTools.ts). This module's `x_search` is the upgraded version
 * with real X API support. Both tools share the name, so a registry can
 * hold only ONE of them — when wiring WEB_MEDIA_TOOLS, register this
 * one and skip CODE_TOOLS' x_search (or unregister it first).
 *
 * Approval: image_generate / video_generate cost provider API money and
 * video_from_images / canvas_write write files -> needsApproval true.
 * x_search / canvas_read / canvas_list only read -> false.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import { CanvasStore } from '@open-bot/core';
import { formatSearchResults, searchWeb } from './tools';
import { resolveWithin, runShell } from './sandbox';
import { shellQuote } from './shellQuote';
import { fetchPublic } from './ssrf';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';
import {
  VIDEO_JOB_DEFAULT_TIMEOUT_MS,
  VideoJobStore,
  driveVideoJob,
  finishVideoJob,
  formatVideoJob,
  isVideoJobTerminal,
  HttpVideoProvider,
  type VideoProvider,
} from './videoJobs';
import {
  GEMINI_DEFAULT_IMAGE_MODEL,
  HttpGeminiImageProvider,
  extFromGeminiMimeType,
  type GeminiImageProvider,
} from './geminiImage';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };
const FETCH_TIMEOUT_MS = 20_000;
const MEDIA_FETCH_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_CHARS = 500;
const X_API_BASE_URL = 'https://api.x.com/2';

/**
 * Providers whose image API this tool knows how to call. OpenAI and
 * xAI speak the OpenAI shape (`/images/generations`); Gemini speaks
 * its own `generateContent` shape (see geminiImage.ts) and is routed
 * separately below. Any other provider whose config sets an
 * imageModel is also tried against `/images/generations` — that is
 * how an OpenAI-compatible endpoint with an image API plugs in.
 */
export const IMAGE_CAPABLE_PROVIDERS: readonly string[] = ['openai', 'xai', 'gemini'];
const DEFAULT_IMAGE_MODEL: Record<string, string> = {
  openai: 'gpt-image-1',
  xai: 'grok-2-image',
  gemini: GEMINI_DEFAULT_IMAGE_MODEL,
};
/**
 * Default video model per provider, used when the host config sets no
 * videoModel. Only OpenAI has one: 'sora-2', the public OpenAI video
 * model — the built-in HttpVideoProvider speaks the Sora async shape
 * (POST /videos, GET /videos/{id}, GET /videos/{id}/content).
 * LIVE GENERATION WITH THIS DEFAULT HAS NOT BEEN VERIFIED on this
 * machine (no OpenAI key here, no live call was made). xAI has no
 * default: Grok Imagine is app-only and xAI publishes no public
 * video endpoint, so xai without an explicit videoModel/videoEndpoint
 * still reports "does not support video generation".
 */
export const DEFAULT_VIDEO_MODEL: Record<string, string> = {
  openai: 'sora-2',
};

export interface ProviderMediaConfig {
  /** Provider id, e.g. 'openai' or 'xai'. */
  id: string;
  /** API key, resolved by the host from the Vault. Never logged. */
  apiKey: string;
  /** API base URL, e.g. 'https://api.openai.com/v1'. No trailing slash needed. */
  baseUrl: string;
  /** Image model for this provider (defaults per provider when omitted). */
  imageModel?: string;
  /**
   * Video model for this provider. When set, video_generate attempts the
   * provider's video API; when absent the provider is reported as not
   * supporting video generation. (No provider in the built-in set
   * advertises a video API yet — this field exists so a host can wire
   * one in without changing this tool.)
   */
  videoModel?: string;
  /** Full video-generation endpoint URL. Defaults to `<baseUrl>/videos`. */
  videoEndpoint?: string;
}

export interface WebMediaToolOptions {
  /**
   * X bearer token for the X API, or null when not configured. The host
   * reads it from the Vault namespace 'x' (e.g. `vault.getSecret('x',
   * 'bearer')`). When absent, x_search falls back to web search and
   * says so in its result.
   */
  getXBearer?: () => string | null | Promise<string | null>;
  /**
   * Provider config for image/video generation, or null when the
   * provider is unknown / has no key. The host resolves the API key
   * from the Vault namespace 'provider' and the base URL / models from
   * the provider presets and model registry.
   */
  getProviderConfig?: (
    providerId: string,
  ) => ProviderMediaConfig | null | Promise<ProviderMediaConfig | null>;
  /** Provider used when the agent does not name one. Default: 'openai'. */
  defaultProviderId?: string;
  /**
   * v0.87d: build the Gemini image provider for a resolved media
   * config. The default builds HttpGeminiImageProvider (Gemini
   * `generateContent` shape, see geminiImage.ts). A host whose Gemini
   * setup differs passes its own implementation here; tests pass a
   * mock (clearly named Mock*). The factory receives the resolved
   * config (key from the Vault) and must never log or persist it.
   * Only used when the provider id is 'gemini'; OpenAI-shaped
   * providers go through `/images/generations` directly.
   */
  createGeminiImageProvider?: (
    config: ProviderMediaConfig,
  ) => GeminiImageProvider | Promise<GeminiImageProvider>;
  /**
   * v0.86b (P1-5): build the VideoProvider for a resolved media
   * config. The default builds HttpVideoProvider (Sora-shaped HTTP).
   * A host whose provider has a different video API passes its own
   * implementation here; tests pass a mock (clearly named Mock*).
   * The factory receives the resolved config (key from the Vault) and
   * must never log or persist it.
   */
  createVideoProvider?: (
    config: ProviderMediaConfig,
  ) => VideoProvider | Promise<VideoProvider>;
  /**
   * v0.86b (P1-5): poll interval of the background video-job driver,
   * in ms. Default 5000. Tests pass a small value (e.g. 10) so a mock
   * job finishes fast.
   */
  videoJobPollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------


function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  if (value < min || value > max) {
    throw new Error(`Argument "${name}" must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

/** fetch() with a hard timeout. Throws on timeout / network error. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
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

function truncateErrorBody(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS
    ? text.slice(0, MAX_ERROR_BODY_CHARS) + '…'
    : text;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

async function resolveProviderConfig(
  opts: WebMediaToolOptions,
  providerId: string,
): Promise<ProviderMediaConfig> {
  if (!opts.getProviderConfig) {
    throw new Error(
      `No provider config is wired up (createWebMediaTools needs getProviderConfig). ` +
        `The host must supply it — it reads the API key from the Vault namespace ` +
        `'provider' and the base URL / model from the provider presets.`,
    );
  }
  const config = await opts.getProviderConfig(providerId);
  if (!config) {
    throw new Error(
      `No provider config for "${providerId}": unknown provider or no API key stored ` +
        `in the Vault (namespace 'provider', key '${providerId}'). ` +
        `Add the key in Settings → Vault first.`,
    );
  }
  if (!config.apiKey) {
    throw new Error(
      `Provider "${providerId}" has no API key configured (Vault namespace 'provider').`,
    );
  }
  if (!config.baseUrl) {
    throw new Error(`Provider "${providerId}" has no baseUrl configured.`);
  }
  return config;
}

function imageModelFor(config: ProviderMediaConfig, override?: string): string {
  return override ?? config.imageModel ?? DEFAULT_IMAGE_MODEL[config.id] ?? '';
}

// ---------------------------------------------------------------------------
// x_search — X API when a bearer token exists, labelled web fallback otherwise
// ---------------------------------------------------------------------------

export interface XPost {
  id: string;
  text: string;
  authorUsername: string;
  authorName: string;
  createdAt: string;
  url: string;
}

/** Parse an X API `tweets/search/recent` response into posts. Pure function (unit-tested). */
export function parseXSearchResponse(body: unknown): XPost[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('X API returned an unexpected response shape (not an object).');
  }
  const data = (body as Record<string, unknown>)['data'];
  if (data === undefined) return [];
  if (!Array.isArray(data)) {
    throw new Error('X API returned an unexpected response shape ("data" is not an array).');
  }
  const users = new Map<string, { username: string; name: string }>();
  const includes = (body as Record<string, unknown>)['includes'];
  if (typeof includes === 'object' && includes !== null && !Array.isArray(includes)) {
    const rawUsers = (includes as Record<string, unknown>)['users'];
    if (Array.isArray(rawUsers)) {
      for (const user of rawUsers) {
        if (typeof user !== 'object' || user === null) continue;
        const u = user as Record<string, unknown>;
        if (typeof u['id'] === 'string' && typeof u['username'] === 'string') {
          users.set(u['id'] as string, {
            username: u['username'] as string,
            name: typeof u['name'] === 'string' ? (u['name'] as string) : (u['username'] as string),
          });
        }
      }
    }
  }
  const posts: XPost[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const tweet = item as Record<string, unknown>;
    if (typeof tweet['id'] !== 'string' || typeof tweet['text'] !== 'string') continue;
    const authorId = typeof tweet['author_id'] === 'string' ? (tweet['author_id'] as string) : '';
    const author = users.get(authorId);
    const username = author?.username ?? 'unknown';
    posts.push({
      id: tweet['id'] as string,
      text: tweet['text'] as string,
      authorUsername: username,
      authorName: author?.name ?? username,
      createdAt: typeof tweet['created_at'] === 'string' ? (tweet['created_at'] as string) : '',
      url: `https://x.com/${username}/status/${tweet['id'] as string}`,
    });
  }
  return posts;
}

/** Render X posts as readable text. Pure function (unit-tested). */
export function formatXPosts(query: string, source: string, posts: XPost[]): string {
  if (posts.length === 0) {
    return `X search for "${query}" via ${source} — 0 result(s).`;
  }
  const lines = posts.map((post, i) => {
    const when = post.createdAt ? ` — ${post.createdAt}` : '';
    return `${i + 1}. @${post.authorUsername} (${post.authorName})${when}\n   ${post.text}\n   ${post.url}`;
  });
  return truncate(
    `X search for "${query}" via ${source} — ${posts.length} result(s):\n${lines.join('\n')}`,
  );
}

async function searchXViaApi(
  query: string,
  maxResults: number,
  bearer: string,
): Promise<XPost[]> {
  const url =
    `${X_API_BASE_URL}/tweets/search/recent?` +
    `query=${encodeURIComponent(query)}&max_results=${maxResults}` +
    `&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,name`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(
      `X API search failed (network error: ${(err as Error).message}). ` +
        `The bearer token was NOT retried via web search — fix the network/token and retry.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `X API search failed with HTTP ${res.status}: ${truncateErrorBody(body) || res.statusText}. ` +
        `Check the X bearer token in the Vault (namespace 'x') — a 401 means it is ` +
        `missing, expired or lacks search permission; a 429 means the X rate limit was hit.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('X API returned a response that is not valid JSON.');
  }
  return parseXSearchResponse(parsed);
}

export function createXSearchTool(opts: WebMediaToolOptions): Tool {
  return {
    definition: toolDef(
      'x_search',
      'Search posts on X (Twitter). With an X bearer token configured (Vault namespace \'x\') ' +
        'it uses the X API (live results); without one it falls back to web search ' +
        '(`site:x.com`) and says so clearly in the result — fallback results may be ' +
        'incomplete or stale. Returns up to 25 posts with text, author, URL and time.',
      {
        query: { type: 'string', description: 'What to search for on X.' },
        max_results: {
          type: 'number',
          description: 'Maximum posts to return (1–25). Default: 10.',
        },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        const maxResults = getNumberArg(args, 'max_results', 10, 1, 25);
        const bearer = (await opts.getXBearer?.()) ?? null;
        if (bearer) {
          const posts = await searchXViaApi(query, maxResults, bearer);
          return formatXPosts(query, 'X API', posts);
        }
        const found = await searchWeb(`site:x.com ${query}`);
        if (!found) {
          return errorResult(
            'X search failed: no X bearer token is configured (so the X API was not used) ' +
              'and the web-search fallback (DuckDuckGo, then Bing) returned no usable results. ' +
              'Configure an X bearer token in the Vault (namespace \'x\') for live X search, or try again later.',
          );
        }
        const header =
          '[FALLBACK] No X bearer token is configured, so this is NOT the X API — ' +
            `results come from web search (site:x.com via ${found.source}) and may be ` +
            'incomplete or stale. Configure an X bearer token in the Vault (namespace \'x\') for live X search.\n';
        return header + formatSearchResults(query, found.source, found.results, 'X search (site:x.com)');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// image_generate — provider image API, saved into the workspace
// ---------------------------------------------------------------------------

function extFromImageUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return '.jpg';
  if (clean.endsWith('.webp')) return '.webp';
  return '.png';
}

export function createImageGenerateTool(opts: WebMediaToolOptions): Tool {
  return {
    definition: toolDef(
      'image_generate',
      'Generate an image from a text prompt via a provider image API. ' +
        'OpenAI / xAI (and any OpenAI-compatible provider with an ' +
        'imageModel) use POST /images/generations; Gemini uses its ' +
        'Nano Banana models via generateContent (default ' +
        'gemini-nano-banana-2.1; live generation NOT verified on this ' +
        'machine — it needs a Gemini key in the Vault). For Gemini, ' +
        '"size" maps to the nearest supported aspect ratio / resolution ' +
        'tier. Costs provider API money. Saves the image into the ' +
        'workspace and returns its path + metadata.',
      {
        prompt: { type: 'string', description: 'Text description of the image to generate.' },
        providerId: {
          type: 'string',
          description:
            'Provider id (e.g. "openai", "xai", "gemini"). Default: the host default provider.',
        },
        model: {
          type: 'string',
          description:
            'Image model override (e.g. "gpt-image-1", "grok-2-image", "gemini-nano-banana-2.1").',
        },
        size: {
          type: 'string',
          description: 'Image size, e.g. "1024x1024". Default: "1024x1024".',
        },
        outputPath: {
          type: 'string',
          description: 'Workspace-relative path to save the image to. Default: generated-media/image-<timestamp>.png.',
        },
      },
      ['prompt'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const prompt = getStringArg(args, 'prompt');
        const providerId =
          getOptionalStringArg(args, 'providerId') ?? opts.defaultProviderId ?? 'openai';
        const modelOverride = getOptionalStringArg(args, 'model');
        const size = getOptionalStringArg(args, 'size') ?? '1024x1024';
        if (!/^\d+x\d+$/.test(size)) {
          return errorResult(`Invalid "size" "${size}": expected e.g. "1024x1024".`);
        }
        const config = await resolveProviderConfig(opts, providerId);
        const model = imageModelFor(config, modelOverride);
        if (!IMAGE_CAPABLE_PROVIDERS.includes(config.id) && !config.imageModel && !modelOverride) {
          return errorResult(
            `Provider "${config.id}" does not support image generation through this tool. ` +
              `Supported providers: ${IMAGE_CAPABLE_PROVIDERS.join(', ')} ` +
              `(or any provider whose config sets an imageModel). ` +
              `Anthropic and Ollama have no compatible image-generation endpoint here.`,
          );
        }
        if (!model) {
          return errorResult(
            `No image model known for provider "${config.id}": pass "model" explicitly ` +
              `or set imageModel in the provider config.`,
          );
        }
        let bytes: Buffer;
        let ext = '.png';
        if (config.id === 'gemini') {
          // v0.87d: Gemini image models do NOT speak
          // /images/generations — they generate through generateContent
          // and return the bytes as an inlineData part (see
          // geminiImage.ts). The provider only ever receives the
          // resolved config (key from the Vault) and never logs it.
          try {
            const provider = opts.createGeminiImageProvider
              ? await opts.createGeminiImageProvider(config)
              : new HttpGeminiImageProvider();
            const result = await provider.generateImage({
              apiKey: config.apiKey,
              baseUrl: config.baseUrl,
              model,
              prompt,
              size,
            });
            bytes = result.bytes;
            ext = extFromGeminiMimeType(result.mimeType);
          } catch (err) {
            return errorResult((err as Error).message);
          }
        } else {
          const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/images/generations`;
          let res: Response;
          try {
            res = await fetchWithTimeout(
              endpoint,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${config.apiKey}`,
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                },
                body: JSON.stringify({ model, prompt, size, n: 1 }),
              },
              MEDIA_FETCH_TIMEOUT_MS,
            );
          } catch (err) {
            return errorResult(
              `Image generation request failed (network error: ${(err as Error).message}). No image was saved.`,
            );
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            return errorResult(
              `Image generation failed with HTTP ${res.status} from provider "${config.id}": ` +
                `${truncateErrorBody(body) || res.statusText}. No image was saved.`,
            );
          }
          let parsed: unknown;
          try {
            parsed = await res.json();
          } catch {
            return errorResult('Image API returned a response that is not valid JSON.');
          }
          const data = (parsed as Record<string, unknown>)['data'];
          if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== 'object' || data[0] === null) {
            return errorResult('Image API returned no image data (empty "data" array).');
          }
          const first = data[0] as Record<string, unknown>;
          if (typeof first['b64_json'] === 'string') {
            bytes = Buffer.from(first['b64_json'] as string, 'base64');
          } else if (typeof first['url'] === 'string') {
            ext = extFromImageUrl(first['url'] as string);
            // v0.15 (H3 audit): URL ảnh do provider trả về cũng phải qua
            // chặn SSRF — không tải từ service nội bộ.
            const imgRes = await fetchPublic(
              first['url'] as string,
              {},
              MEDIA_FETCH_TIMEOUT_MS,
            );
            if (!imgRes.ok) {
              return errorResult(
                `Image was generated but downloading it failed with HTTP ${imgRes.status}.`,
              );
            }
            bytes = Buffer.from(await imgRes.arrayBuffer());
          } else {
            return errorResult(
              'Image API returned an image without "b64_json" or "url" — cannot save it.',
            );
          }
        }
        const relPath =
          getOptionalStringArg(args, 'outputPath') ??
          `generated-media/image-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
        const fullPath = resolveWithin(ctx.workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, bytes);
        return truncate(
          `Image generated via provider "${config.id}" (model "${model}", size ${size}).\n` +
            `Saved to: ${relPath} (${bytes.length} bytes)\n` +
            `Prompt: ${prompt}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// video_generate / video_status / video_cancel — async video jobs (v0.86b)
// ---------------------------------------------------------------------------

function videoModelFor(config: ProviderMediaConfig, override?: string): string {
  return override ?? config.videoModel ?? DEFAULT_VIDEO_MODEL[config.id] ?? '';
}

async function buildVideoProvider(
  opts: WebMediaToolOptions,
  config: ProviderMediaConfig,
): Promise<VideoProvider> {
  if (opts.createVideoProvider) return opts.createVideoProvider(config);
  return new HttpVideoProvider(config);
}

function videoJobStore(ctx: ToolContext): VideoJobStore {
  return new VideoJobStore(ctx.workspaceDir, ctx.botId);
}

export function createVideoGenerateTool(opts: WebMediaToolOptions): Tool {
  return {
    definition: toolDef(
      'video_generate',
      'Generate a video from a text prompt via a provider video API. ' +
        'ASYNC: creates a durable job and returns its job id at once — ' +
        'the video takes minutes, so poll it with video_status (or stop ' +
        'it with video_cancel). Needs a provider video model: OpenAI ' +
        'defaults to sora-2 (live generation NOT verified on this ' +
        'machine — it needs an OpenAI key in the Vault); other providers ' +
        'need an explicit videoModel/videoEndpoint in their config, ' +
        'otherwise this tool errors and suggests video_from_images. ' +
        'Costs provider API money when it runs.',
      {
        prompt: { type: 'string', description: 'Text description of the video to generate.' },
        providerId: {
          type: 'string',
          description: 'Provider id. Default: the host default provider.',
        },
        model: { type: 'string', description: 'Video model override (e.g. "sora-2").' },
        durationSeconds: {
          type: 'number',
          description: 'Desired video length in seconds. Default: 5.',
        },
        timeoutSeconds: {
          type: 'number',
          description:
            'Give up (job becomes timed_out) this many seconds after creation. Default: 600 (10 min).',
        },
      },
      ['prompt'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const prompt = getStringArg(args, 'prompt');
        const providerId =
          getOptionalStringArg(args, 'providerId') ?? opts.defaultProviderId ?? 'openai';
        const durationSeconds = getNumberArg(args, 'durationSeconds', 5, 1, 60);
        const timeoutSeconds = getNumberArg(
          args,
          'timeoutSeconds',
          VIDEO_JOB_DEFAULT_TIMEOUT_MS / 1000,
          1,
          3600,
        );
        const config = await resolveProviderConfig(opts, providerId);
        const model = videoModelFor(config, getOptionalStringArg(args, 'model'));
        if (!model) {
          return errorResult(
            `Provider "${config.id}" does not support video generation: no video model ` +
              `or endpoint is configured for it. None of the built-in providers ` +
              `except OpenAI (default model "sora-2", needs an OpenAI key in the Vault) ` +
              `advertises a video-generation API that this tool can call yet — ` +
              `xAI's Grok Imagine is app-only and has no public video endpoint. ` +
              `Use video_from_images instead: it assembles images already in the workspace ` +
              `into an mp4 slideshow with ffmpeg (no API cost).`,
          );
        }
        const store = videoJobStore(ctx);
        const job = await store.create({
          prompt,
          providerId: config.id,
          model,
          durationSeconds,
          timeoutMs: timeoutSeconds * 1000,
        });
        const provider = await buildVideoProvider(opts, config);
        // Fire-and-forget: the driver persists every transition, so the
        // job survives even if this process restarts mid-generation.
        // driveVideoJob records provider failures on the job instead of
        // throwing; the catch here only guards store errors.
        void driveVideoJob(store, provider, job.id, {
          workspaceDir: ctx.workspaceDir,
          pollIntervalMs: opts.videoJobPollIntervalMs,
        }).catch(() => {});
        return truncate(
          `Video job created via provider "${config.id}" (model "${model}", ${durationSeconds}s).\n` +
            `Job ID: ${job.id}\nStatus: queued\n` +
            `Prompt: ${prompt}\n` +
            `Video generation is asynchronous — poll the job with video_status ` +
            `(jobId: ${job.id}) or stop it with video_cancel. ` +
            `The finished video is saved to generated-media/video-${job.id}.mp4 ` +
            `when done (timeout: ${timeoutSeconds}s).`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

export function createVideoStatusTool(opts: WebMediaToolOptions): Tool {
  return {
    definition: toolDef(
      'video_status',
      'Poll a video job created by video_generate. Returns its status ' +
        '(queued/running/done/failed/cancelled/timed_out), provider, ' +
        'prompt and — when done — the saved workspace path of the mp4. ' +
        'Jobs are durable: a job still exists after a restart. When the ' +
        'job is still running and a provider job id is known, this tool ' +
        'best-effort refreshes the status from the provider once; a job ' +
        'past its timeout is marked timed_out. Read-only (no approval).',
      {
        jobId: { type: 'string', description: 'Video job id returned by video_generate.' },
      },
      ['jobId'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const jobId = getStringArg(args, 'jobId');
        const store = videoJobStore(ctx);
        let job = await store.read(jobId);
        if (!job) {
          return errorResult(
            `No video job with id "${jobId}". The id comes from video_generate; ` +
              `jobs are stored per bot under .open-bot/video-jobs/.`,
          );
        }
        if (!isVideoJobTerminal(job.status)) {
          // Lazy timeout: a job left running by a crashed/restarted
          // process must not stay 'running' forever.
          if (Date.now() > Date.parse(job.createdAt) + job.timeoutMs) {
            job =
              (await store.finish(jobId, 'timed_out', {
                error:
                  `Video job timed out after ${Math.round(job.timeoutMs / 1000)}s ` +
                  `(last known status: ${job.status}). Increase "timeoutSeconds" and retry.`,
              })) ?? job;
          } else if (job.providerJobId) {
            // Best-effort live refresh from the provider. Any failure
            // (no config/key, network error) keeps the stored state.
            try {
              const config = await opts.getProviderConfig?.(job.providerId);
              if (config?.apiKey) {
                const provider = await buildVideoProvider(opts, config);
                const polled = await provider.pollJob(job.providerJobId);
                if (polled.status === 'done') {
                  const done =
                    (await finishVideoJob(store, provider, job, polled, ctx.workspaceDir)) ?? job;
                  job = done;
                } else if (polled.status === 'failed') {
                  job =
                    (await store.finish(jobId, 'failed', {
                      providerJobId: job.providerJobId,
                      resultUrl: polled.videoUrl,
                      error:
                        polled.error ??
                        `Provider "${job.providerId}" reported the video job as failed.`,
                    })) ?? job;
                } else {
                  job =
                    (await store.update(jobId, (current) => {
                      if (isVideoJobTerminal(current.status) || current.cancelRequested) return null;
                      return {
                        ...current,
                        status: polled.status === 'queued' ? 'queued' : 'running',
                        resultUrl: polled.videoUrl ?? current.resultUrl,
                        lastError: undefined,
                      };
                    })) ?? job;
                }
              }
            } catch {
              // Keep the stored state; the background driver keeps polling.
            }
          }
        }
        return truncate(formatVideoJob(job));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

export function createVideoCancelTool(opts: WebMediaToolOptions): Tool {
  return {
    definition: toolDef(
      'video_cancel',
      'Cancel a queued/running video job created by video_generate. ' +
        'The background driver stops at its next poll; when the provider ' +
        'supports it, the provider-side job is cancelled too. A job that ' +
        'already reached a terminal state (done/failed/cancelled/' +
        'timed_out) cannot be cancelled.',
      {
        jobId: { type: 'string', description: 'Video job id returned by video_generate.' },
      },
      ['jobId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const jobId = getStringArg(args, 'jobId');
        const store = videoJobStore(ctx);
        const job = await store.read(jobId);
        if (!job) {
          return errorResult(`No video job with id "${jobId}". The id comes from video_generate.`);
        }
        if (isVideoJobTerminal(job.status)) {
          return errorResult(
            `Video job "${jobId}" is already ${job.status} and cannot be cancelled.`,
          );
        }
        const cancelled =
          (await store.finish(jobId, 'cancelled', {
            cancelRequested: true,
            error: 'Cancelled by the user.',
          })) ?? job;
        // Best-effort provider-side cancel; a failure here does not
        // un-cancel the local job (the driver also tries on its way out).
        if (job.providerJobId) {
          try {
            const config = await opts.getProviderConfig?.(job.providerId);
            if (config?.apiKey) {
              const provider = await buildVideoProvider(opts, config);
              await provider.cancelJob?.(job.providerJobId);
            }
          } catch {
            // Local cancellation stands regardless.
          }
        }
        return truncate(
          `Video job "${jobId}" cancelled (was ${job.status}).\n` +
            formatVideoJob(cancelled),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// video_from_images — ffmpeg slideshow, no provider call
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export function createVideoFromImagesTool(): Tool {
  return {
    definition: toolDef(
      'video_from_images',
      'Assemble images in the workspace into an mp4 slideshow video with ffmpeg ' +
        '(already installed on the machine). No provider API call, no API cost. ' +
        'Each image is shown for secondsPerImage seconds.',
      {
        images: {
          type: 'array',
          description: 'Workspace-relative paths of the images, in display order (at least 1).',
          items: { type: 'string' },
        },
        secondsPerImage: {
          type: 'number',
          description: 'Seconds each image is shown (0.5–30). Default: 2.',
        },
        outputPath: {
          type: 'string',
          description: 'Workspace-relative path for the mp4. Default: generated-media/slideshow-<timestamp>.mp4.',
        },
        width: { type: 'number', description: 'Video width in pixels. Default: 1280.' },
        height: { type: 'number', description: 'Video height in pixels. Default: 720.' },
      },
      ['images'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      const concatRel = `.open-bot/ffmpeg-concat-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
      try {
        const images = getStringArrayArg(args, 'images');
        if (images.length === 0) {
          return errorResult('Argument "images" must contain at least one image path.');
        }
        const secondsPerImage = getNumberArg(args, 'secondsPerImage', 2, 0.5, 30);
        const width = Math.floor(getNumberArg(args, 'width', 1280, 16, 3840));
        const height = Math.floor(getNumberArg(args, 'height', 720, 16, 2160));
        const resolved: string[] = [];
        for (const rel of images) {
          const full = resolveWithin(ctx.workspaceDir, rel);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            return errorResult(`Image not found in the workspace: "${rel}"`);
          }
          if (!stat.isFile()) return errorResult(`Not a file: "${rel}"`);
          if (!IMAGE_EXTENSIONS.has(path.extname(full).toLowerCase())) {
            return errorResult(
              `Unsupported image type for "${rel}" (expected one of ${[...IMAGE_EXTENSIONS].join(', ')}).`,
            );
          }
          resolved.push(full);
        }
        const outputRel =
          getOptionalStringArg(args, 'outputPath') ??
          `generated-media/slideshow-${Date.now()}.mp4`;
        const outputFull = resolveWithin(ctx.workspaceDir, outputRel);
        fs.mkdirSync(path.dirname(outputFull), { recursive: true });
        // ffmpeg concat demuxer file: each image + duration, then the
        // last image repeated once without a duration (the demuxer
        // needs a final entry to flush the last frame's duration).
        const concatFull = resolveWithin(ctx.workspaceDir, concatRel);
        fs.mkdirSync(path.dirname(concatFull), { recursive: true });
        const lines: string[] = [];
        for (const full of resolved) {
          lines.push(`file ${shellQuote(full)}`);
          lines.push(`duration ${secondsPerImage}`);
        }
        lines.push(`file ${shellQuote(resolved[resolved.length - 1])}`);
        fs.writeFileSync(concatFull, lines.join('\n') + '\n', 'utf8');
        const filter =
          `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
        const command =
          `ffmpeg -y -f concat -safe 0 -i ${shellQuote(concatFull)} ` +
          `-vf ${shellQuote(filter)} -c:v libx264 -r 30 -movflags +faststart ` +
          shellQuote(outputFull);
        const result = await runShell(command, ctx.workspaceDir, {
          workspaceDir: ctx.workspaceDir,
          signal: ctx.signal,
        });
        if (result.code !== 0) {
          const detail = truncateErrorBody(
            (result.stderr || result.stdout || `ffmpeg exited with code ${result.code}`).trim(),
          );
          return errorResult(`ffmpeg failed (exit ${result.code}): ${detail}`);
        }
        const bytes = fs.statSync(outputFull).size;
        return truncate(
          `Slideshow video created: ${outputRel} (${bytes} bytes, ` +
            `${images.length} image(s) x ${secondsPerImage}s = ~${images.length * secondsPerImage}s, ${width}x${height}).`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      } finally {
        try {
          fs.unlinkSync(resolveWithin(ctx.workspaceDir, concatRel));
        } catch {
          // Concat file was never created or already removed.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Canvas tools (CanvasStore, one store per call from the ToolContext)
// ---------------------------------------------------------------------------

function canvasStore(ctx: ToolContext): CanvasStore {
  return new CanvasStore(ctx.workspaceDir, ctx.botId);
}

function parseBlocksArg(args: Record<string, unknown>): unknown {
  const value = args['blocks'];
  if (value === undefined || value === null) {
    throw new Error('Missing required argument: "blocks"');
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('Argument "blocks" is a string but not valid JSON.');
    }
  }
  return value;
}

export function createCanvasTools(): Tool[] {
  const canvasRead: Tool = {
    definition: toolDef(
      'canvas_read',
      'Read a canvas (interactive versioned document) by id. Returns its title, blocks, version and last update time.',
      {
        id: { type: 'string', description: 'Canvas id (from canvas_list or a previous canvas_write).' },
      },
      ['id'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const id = getStringArg(args, 'id');
        const doc = await canvasStore(ctx).read(id);
        if (!doc) return errorResult(`No canvas with id "${id}". Use canvas_list to see existing canvases.`);
        return truncate(JSON.stringify(doc, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const canvasWrite: Tool = {
    definition: toolDef(
      'canvas_write',
      'Create a canvas (omit "id") or overwrite an existing one (pass "id"). ' +
        'Each write bumps the version. Pass "expectedVersion" to fail instead of ' +
        'overwriting a newer edit made in the meantime.',
      {
        id: { type: 'string', description: 'Canvas id to overwrite. Omit to create a new canvas.' },
        title: { type: 'string', description: 'Canvas title (required when creating, optional when overwriting).' },
        blocks: {
          description: 'Array of block objects, each with a string "type" — or a JSON string of such an array.',
        },
        expectedVersion: {
          type: 'number',
          description: 'Optimistic concurrency: fail when the stored version differs.',
        },
      },
      ['blocks'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const blocks = parseBlocksArg(args);
        const title = getOptionalStringArg(args, 'title');
        const expectedVersion =
          args['expectedVersion'] === undefined
            ? undefined
            : getNumberArg(args, 'expectedVersion', 0, 1, Number.MAX_SAFE_INTEGER);
        const store = canvasStore(ctx);
        const id = getOptionalStringArg(args, 'id');
        const doc = id
          ? await store.write(id, blocks, { title, expectedVersion })
          : await store.create(title ?? 'Untitled canvas', blocks);
        return truncate(
          `Canvas "${doc.title}" saved (id: ${doc.id}, version: ${doc.version}, ` +
            `${doc.blocks.length} block(s), updated: ${doc.updatedAt}).`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const canvasList: Tool = {
    definition: toolDef(
      'canvas_list',
      'List this bot\'s canvases (id, title, version, block count, last update). Newest first.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const summaries = await canvasStore(ctx).list();
        if (summaries.length === 0) return '(no canvases yet for this bot)';
        const lines = summaries.map(
          (s) => `- ${s.id} — "${s.title}" (v${s.version}, ${s.blockCount} block(s), ${s.updatedAt})`,
        );
        return truncate(`Canvases (${summaries.length}):\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [canvasRead, canvasWrite, canvasList];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function createWebMediaTools(opts: WebMediaToolOptions = {}): Tool[] {
  return [
    createXSearchTool(opts),
    createImageGenerateTool(opts),
    createVideoGenerateTool(opts),
    createVideoStatusTool(opts),
    createVideoCancelTool(opts),
    createVideoFromImagesTool(),
  ];
}

/** Unbound placeholders (same pattern as PLAN_TOOLS / SUBAGENT_TOOLS). */
export const WEB_MEDIA_TOOLS: Tool[] = createWebMediaTools();

export const CANVAS_TOOLS: Tool[] = createCanvasTools();
