/**
 * Multimodal media context for voice sessions (v1.02, Team T5 —
 * realtime voice v2).
 *
 * A voice-only agent is blind: the user says "look at this photo"
 * and the model has nothing to look at. This module attaches media
 * to a voice session so the voice agent can see it too:
 *
 *   attach(image/video) ──▶ describe (mock or vision model)
 *                        ──▶ context block ──▶ session instructions
 *   askAboutMedia("what is in this photo?") ──▶ answer from the
 *   description + the describer, recorded against the media item.
 *
 * Hooks, not a vision engine: describing is delegated to a
 * `MediaDescriber`. The built-ins are:
 *
 *   - `MockMediaDescriber` — deterministic, from the item's own
 *     caption/name/metadata. Tests and $0 mode; never pretends to
 *     have seen pixels it did not.
 *   - `VisionApiDescriber` — calls any OpenAI-compatible
 *     `/chat/completions` endpoint with a vision model (local
 *     Ollama llava / qwen2.5-vl, or the user's own key) and sends
 *     the image as `image_url`. Video has no frames sent: the
 *     describer works from the item metadata + an optional poster
 *     frame, and says so in the prompt. No Gemini image call is
 *     made here (free-key image quota is 0 — see the wave brief).
 *
 * Validation reuses the chat vision channel's limits
 * (agent/vision.ts: image MIME allowlist + 10 MB per image, 20 MB
 * total) so media attached to a voice call obeys the same ceilings
 * as media attached to a chat message. Media bytes are never
 * logged. Items are pruned oldest-first when the session holds too
 * many or too many bytes.
 */

/** MIME types accepted for attached video. */
export const VOICE_MEDIA_VIDEO_MIME_TYPES: readonly string[] = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
];
/** Max attached media items per voice session. */
export const VOICE_MEDIA_MAX_ITEMS = 5;
/** Max decoded bytes of ALL attached media in one session (20 MB,
 *  same ceiling as the chat vision channel). */
export const VOICE_MEDIA_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Max decoded bytes of ONE attached video (10 MB — same as images). */
export const VOICE_MEDIA_MAX_VIDEO_BYTES = 10 * 1024 * 1024;
/** Default timeout for a vision-API describe call (ms). */
export const VOICE_MEDIA_DESCRIBE_TIMEOUT_MS = 60_000;

import {
  VISION_ALLOWED_MIME_TYPES,
  VISION_MAX_IMAGE_BYTES,
  visionImageBytes,
} from '../agent/vision';

export type VoiceMediaKind = 'image' | 'video';

/** One media item attached to a voice session. */
export interface VoiceMediaItem {
  /** Stable id (`media-<n>`, assigned on attach). */
  id: string;
  kind: VoiceMediaKind;
  mimeType: string;
  /** File name as the user gave it (never a path). */
  name?: string;
  /** User caption ("screenshot of the error", ...). */
  caption?: string;
  /** Base64 bytes (images; optional for video — metadata-only
   *  video is allowed). Never logged. */
  base64?: string;
  /** Video length in seconds (metadata only). */
  durationSec?: number;
  /** Optional poster frame (base64 JPEG/PNG) for video items. */
  posterBase64?: string;
  /** MIME type of the poster frame. */
  posterMimeType?: string;
  /** Voice turn this media was attached on (if any). */
  turnSeq?: number;
  /** Describer output ('' until described). */
  description: string;
  /** When the description was written (ms since epoch, 0 = never). */
  describedAt: number;
  /** 'pending' | 'described' | 'failed'. */
  status: 'pending' | 'described' | 'failed';
  /** Failure reason when status is 'failed'. */
  error?: string;
  /** When the item was attached (ms since epoch). */
  addedAt: number;
}

/** Input for attaching media (id/description/status are assigned). */
export interface VoiceMediaInput {
  kind: VoiceMediaKind;
  mimeType: string;
  name?: string;
  caption?: string;
  base64?: string;
  durationSec?: number;
  posterBase64?: string;
  posterMimeType?: string;
  turnSeq?: number;
}

/** What a describer returns for one item. */
export interface MediaDescription {
  /** Description text (a few sentences, plain language). */
  text: string;
  /** How much the describer trusts its own output. */
  confidence: 'high' | 'medium' | 'low';
  /** Model/engine that produced the description. */
  model?: string;
}

/** Something that can describe one attached media item. */
export interface MediaDescriber {
  /** Human-readable engine name (shown in the panel, never a key). */
  readonly name: string;
  describe(item: VoiceMediaItem, question?: string): Promise<MediaDescription>;
}

/** Result of attaching media: the item, or a refusal reason. */
export type AttachMediaResult =
  | { ok: true; item: VoiceMediaItem }
  | { ok: false; error: string };

/** One answered question about attached media. */
export interface MediaAnswer {
  itemId: string;
  question: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  at: number;
}

export interface VoiceMediaContextOptions {
  /** Describer used for `describe()` / `askAboutMedia()`.
   *  Defaults to `MockMediaDescriber` (no network, no key). */
  describer?: MediaDescriber;
  /** Max items held. Default 5. */
  maxItems?: number;
  /** Max total decoded bytes held. Default 20 MB. */
  maxTotalBytes?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte size of a base64 string (length math, no decode). */
export function mediaBytes(base64: string | undefined): number {
  if (!base64) return 0;
  return visionImageBytes(base64);
}

/**
 * Deterministic describer: describes from the item's own caption,
 * name, kind and metadata only. It never claims to have seen
 * pixels — when there is no caption it says what the item is (kind
 * + name + size) and that no visual description is available. Used
 * for tests, for $0 mode, and as the fallback when the vision API
 * fails. A question is answered from the same metadata (the mock
 * cannot see the image, so it says which facts it used).
 */
export class MockMediaDescriber implements MediaDescriber {
  readonly name = 'mock';

  async describe(item: VoiceMediaItem, question?: string): Promise<MediaDescription> {
    const label = item.caption?.trim() || item.name?.trim() || `an attached ${item.kind}`;
    const size = mediaBytes(item.base64);
    const sizeText = size > 0 ? ` (${Math.round(size / 1024)} KB)` : '';
    const base =
      item.kind === 'video'
        ? `A video${item.durationSec ? `, about ${Math.round(item.durationSec)} seconds long` : ''}: ${label}${sizeText}.`
        : `An image: ${label}${sizeText}.`;
    if (question && question.trim()) {
      return {
        text:
          `${base} Asked: "${question.trim()}" — no vision model is configured, so this ` +
          `answer uses only the file details above, not the pixels. ` +
          `Configure a vision model (Ollama llava / qwen2.5-vl or a provider key) for real visual answers.`,
        confidence: 'low',
        model: 'mock',
      };
    }
    const described =
      item.caption?.trim()
        ? `${base} No vision model is configured, so this description uses only the caption and file details, not the pixels.`
        : `${base} No caption and no vision model is configured — attach a caption or configure a vision model for a real description.`;
    return { text: described, confidence: 'low', model: 'mock' };
  }
}

/**
 * Vision describer over any OpenAI-compatible `/chat/completions`
 * endpoint (local Ollama vision models, or the user's own provider
 * key). Sends the image as `image_url`; for video only the poster
 * frame (when present) is sent, plus the metadata in the prompt —
 * no video frames are uploaded. Throws on HTTP / protocol errors;
 * the caller (`VoiceMediaContext.describe`) records the failure on
 * the item instead of crashing the call.
 */
export class VisionApiDescriber implements MediaDescriber {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? VOICE_MEDIA_DESCRIBE_TIMEOUT_MS;
    this.name = `vision:${options.model}`;
  }

  async describe(item: VoiceMediaItem, question?: string): Promise<MediaDescription> {
    const imageBase64 = item.kind === 'image' ? item.base64 : item.posterBase64;
    const imageMime = item.kind === 'image' ? item.mimeType : item.posterMimeType;
    const label = item.caption?.trim() || item.name?.trim() || `an attached ${item.kind}`;
    let prompt = question?.trim()
      ? `Answer this question about the attached ${item.kind} (${label}): ${question.trim()}`
      : `Describe this ${item.kind} in a few sentences: what does it show, what text is visible, what is notable? The user called it: ${label}.`;
    if (item.kind === 'video') {
      prompt +=
        ` This is a video${item.durationSec ? ` about ${Math.round(item.durationSec)} seconds long` : ''}; ` +
        (imageBase64
          ? 'only one still frame is shown — describe that frame and note it is a single frame, not the whole video.'
          : 'no frame is available — answer only from the name, caption and duration given here, and say so.');
    }
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
    if (imageBase64 && imageMime) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${imageMime};base64,${imageBase64}` },
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content }],
          max_tokens: 512,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Vision API returned HTTP ${res.status}.`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      };
      const raw = body?.choices?.[0]?.message?.content;
      const text =
        typeof raw === 'string'
          ? raw.trim()
          : Array.isArray(raw)
            ? raw.map((p) => p?.text ?? '').join(' ').trim()
            : '';
      if (!text) throw new Error('Vision API returned an empty description.');
      return { text, confidence: imageBase64 ? 'high' : 'medium', model: this.model };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class VoiceMediaContext {
  private readonly describer: MediaDescriber;
  private readonly maxItems: number;
  private readonly maxTotalBytes: number;
  private readonly clock: () => number;
  private items: VoiceMediaItem[] = [];
  private seq = 0;
  private answers: MediaAnswer[] = [];

  constructor(options: VoiceMediaContextOptions = {}) {
    this.describer = options.describer ?? new MockMediaDescriber();
    this.maxItems = Math.max(1, options.maxItems ?? VOICE_MEDIA_MAX_ITEMS);
    this.maxTotalBytes = Math.max(1, options.maxTotalBytes ?? VOICE_MEDIA_MAX_TOTAL_BYTES);
    this.clock = options.clock ?? Date.now;
  }

  getDescriberName(): string {
    return this.describer.name;
  }

  list(): VoiceMediaItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  get(id: string): VoiceMediaItem | null {
    const found = this.items.find((i) => i.id === id);
    return found ? { ...found } : null;
  }

  /** Decoded bytes currently held (images + poster frames). */
  getTotalBytes(): number {
    return this.items.reduce(
      (n, i) => n + mediaBytes(i.base64) + mediaBytes(i.posterBase64),
      0,
    );
  }

  getAnswers(): MediaAnswer[] {
    return this.answers.map((a) => ({ ...a }));
  }

  /**
   * Attach media to the session. Validates kind / MIME / base64 /
   * per-item and total size (same ceilings as the chat vision
   * channel); video without bytes is allowed (metadata-only).
   * Prunes the oldest items when the session is over capacity.
   */
  attach(input: VoiceMediaInput): AttachMediaResult {
    if (input.kind !== 'image' && input.kind !== 'video') {
      return { ok: false, error: `Unsupported media kind: ${String(input.kind)}.` };
    }
    const allowed =
      input.kind === 'image' ? VISION_ALLOWED_MIME_TYPES : VOICE_MEDIA_VIDEO_MIME_TYPES;
    if (!allowed.includes(input.mimeType)) {
      return { ok: false, error: `Unsupported ${input.kind} type: ${input.mimeType}.` };
    }
    for (const b64 of [input.base64, input.posterBase64]) {
      if (b64 !== undefined && (typeof b64 !== 'string' || !BASE64_RE.test(b64.replace(/\s/g, '')))) {
        return { ok: false, error: 'Media data is not valid base64.' };
      }
    }
    const bytes = mediaBytes(input.base64) + mediaBytes(input.posterBase64);
    const cap = input.kind === 'image' ? VISION_MAX_IMAGE_BYTES : VOICE_MEDIA_MAX_VIDEO_BYTES;
    if (bytes > cap) {
      return { ok: false, error: `Media is too large (${Math.round(bytes / 1024 / 1024)} MB, max ${Math.round(cap / 1024 / 1024)} MB).` };
    }
    if (this.getTotalBytes() + bytes > this.maxTotalBytes) {
      // Make room first; still refuse when one item alone is over.
      this.prune(bytes);
      if (this.getTotalBytes() + bytes > this.maxTotalBytes) {
        return { ok: false, error: 'Media would exceed the session media budget.' };
      }
    }
    const item: VoiceMediaItem = {
      id: `media-${(this.seq += 1)}`,
      kind: input.kind,
      mimeType: input.mimeType,
      ...(input.name ? { name: input.name } : {}),
      ...(input.caption ? { caption: input.caption } : {}),
      ...(input.base64 ? { base64: input.base64 } : {}),
      ...(typeof input.durationSec === 'number' ? { durationSec: input.durationSec } : {}),
      ...(input.posterBase64 ? { posterBase64: input.posterBase64 } : {}),
      ...(input.posterMimeType ? { posterMimeType: input.posterMimeType } : {}),
      ...(typeof input.turnSeq === 'number' ? { turnSeq: input.turnSeq } : {}),
      description: '',
      describedAt: 0,
      status: 'pending',
      addedAt: this.clock(),
    };
    this.items.push(item);
    // Hard cap on count (oldest described/pending item goes first).
    while (this.items.length > this.maxItems) this.items.shift();
    return { ok: true, item: { ...item } };
  }

  /** Remove one item (false when unknown). */
  remove(id: string): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }

  /** Drop all items and answers (new call). */
  clear(): void {
    this.items = [];
    this.answers = [];
  }

  /**
   * Describe one item (or all pending ones when no id is given).
   * Failures are recorded on the item (`status: 'failed'`) and
   * returned, never thrown — a failed description must not break
   * the voice call.
   */
  async describe(id?: string): Promise<MediaDescription | null> {
    const targets = id
      ? this.items.filter((i) => i.id === id)
      : this.items.filter((i) => i.status === 'pending');
    if (targets.length === 0) return null;
    let last: MediaDescription | null = null;
    for (const item of targets) {
      try {
        const desc = await this.describer.describe({ ...item });
        item.description = desc.text;
        item.describedAt = this.clock();
        item.status = 'described';
        item.error = undefined;
        last = desc;
      } catch (err) {
        item.status = 'failed';
        item.error = err instanceof Error ? err.message : 'Description failed.';
        last = null;
      }
    }
    return last;
  }

  /**
   * Answer a question about attached media. With no `itemId` the
   * most recently attached item is used. The answer is recorded
   * (question + answer + item) so the voice transcript can cite it.
   * Returns null when there is no media to ask about.
   */
  async askAboutMedia(question: string, itemId?: string): Promise<MediaAnswer | null> {
    const clean = String(question ?? '').trim();
    if (!clean) return null;
    const item = itemId
      ? this.items.find((i) => i.id === itemId)
      : this.items[this.items.length - 1];
    if (!item) return null;
    try {
      const desc = await this.describer.describe({ ...item }, clean);
      const answer: MediaAnswer = {
        itemId: item.id,
        question: clean,
        answer: desc.text,
        confidence: desc.confidence,
        at: this.clock(),
      };
      this.answers.push(answer);
      // Keep the description fresh when the item was undescribed.
      if (!item.description) {
        item.description = desc.text;
        item.describedAt = this.clock();
        item.status = 'described';
      }
      return { ...answer };
    } catch (err) {
      const answer: MediaAnswer = {
        itemId: item.id,
        question: clean,
        answer: `Could not describe that media: ${err instanceof Error ? err.message : 'unknown error'}`,
        confidence: 'low',
        at: this.clock(),
      };
      this.answers.push(answer);
      return { ...answer };
    }
  }

  /**
   * The context block for the model: one line per attached item
   * (kind + name/caption + description or "not described yet") plus
   * recent Q&A. Paste into session instructions or a turn prefix;
   * '' when nothing is attached. Never contains raw bytes.
   */
  buildMediaContextBlock(): string {
    if (this.items.length === 0) return '';
    const lines = this.items.map((item, idx) => {
      const label = item.caption?.trim() || item.name?.trim() || `${item.kind} ${idx + 1}`;
      const desc = item.description
        ? item.description
        : item.status === 'failed'
          ? `description failed${item.error ? `: ${item.error}` : ''}`
          : 'not described yet';
      const extra =
        item.kind === 'video' && item.durationSec
          ? `, ${Math.round(item.durationSec)}s`
          : '';
      return `[${idx + 1}] ${item.kind} "${label}"${extra}: ${desc}`;
    });
    const qa = this.answers.slice(-3).map((a) => `Q about media ${a.itemId}: ${a.question}\nA: ${a.answer}`);
    return (
      'Attached media the user can see and talk about:\n' +
      lines.join('\n') +
      (qa.length > 0 ? '\n\nRecent media questions:\n' + qa.join('\n') : '')
    );
  }

  /** Drop oldest items until `bytesNeeded` fits the total budget. */
  private prune(bytesNeeded: number): void {
    while (
      this.items.length > 0 &&
      this.getTotalBytes() + bytesNeeded > this.maxTotalBytes
    ) {
      this.items.shift();
    }
  }
}
