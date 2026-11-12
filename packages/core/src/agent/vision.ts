/**
 * Vision channel (v0.63) — image attachments from the chat composer
 * to the model.
 *
 * Where images used to die (found by tracing the v0.60 UI-7 flow):
 * the renderer (`composer.ts` `buildAttachmentBlocks`) turned a
 * pasted/dropped image into a one-line TEXT note ("bot cannot view
 * images yet") because `chat:send` carried text only — the image
 * bytes never left the renderer. This module is the CORE side of the
 * fix: a shared attachment type (`VisionAttachment`, see types.ts),
 * limits + validation, and the per-provider vision capability check.
 * The renderer/main wiring that feeds bytes into `RunParams.
 * attachments` is still open (see the wave report) — until then the
 * loop + providers below are ready and covered by
 * tests/vision-channel.test.mjs.
 *
 * Rules:
 *  - Attachments ride on the FIRST user message of a turn only
 *    (`ChatMessage.attachments`); history / checkpoint / subagent
 *    messages never carry them.
 *  - A provider that cannot do vision NEVER receives the bytes:
 *    the loop refuses the turn with a friendly Vietnamese message
 *    (no provider call, no crash, no silent drop), and
 *    `OllamaProvider.chat` throws a clear error as defence-in-depth
 *    for direct provider callers.
 *  - Limits mirror the composer caps where they exist (max 5 items)
 *    and the providers' own ceilings otherwise (Gemini inlineData
 *    caps at 20 MB per request; OpenAI base64 images are billed per
 *    image — 10 MB each / 20 MB total keeps one turn sane).
 *  - Base64 is validated (charset + padding + decoded size) but
 *    never logged: the bytes could be a photo of anything.
 */

import type { Provider, VisionAttachment } from '../types';

/** Max images on one message — mirrors composer ATTACHMENT_MAX_ITEMS. */
export const VISION_MAX_IMAGES = 5;
/** Max decoded bytes of ONE image (10 MB). */
export const VISION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Max decoded bytes of ALL images on one message (20 MB). */
export const VISION_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * MIME types every vision provider below accepts. SVG is deliberately
 * excluded: neither Gemini inlineData nor OpenAI image_url nor the
 * Anthropic image source accept it as a vision input (an SVG would
 * 400 at the provider). BMP/AVIF are left out for the same reason —
 * a caller that needs them must convert first.
 */
export const VISION_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** Ollama vision models to suggest when the current model cannot see. */
export const OLLAMA_VISION_MODEL_SUGGESTIONS: readonly string[] = [
  'llava',
  'qwen2.5-vl',
  'llama3.2-vision',
  'gemma3',
  'moondream',
];

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte size of a base64 string (no decode — length math). */
export function visionImageBytes(data: string): number {
  const clean = data.replace(/\s/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** Human size: `123 B`, `12 KB`, `1.2 MB` (mirrors composer formatFileSize). */
export function formatVisionBytes(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export type VisionValidationResult =
  | { ok: true; attachments: VisionAttachment[] }
  | { ok: false; error: string };

/**
 * Validate a caller-supplied attachments value (unknown — it arrives
 * over RPC/IPC, so anything can show up). Pure, never throws.
 * On failure the message is a complete Vietnamese sentence the loop
 * can return to the user as-is; it names the offending file, never
 * the bytes.
 */
export function validateVisionAttachments(
  value: unknown,
): VisionValidationResult {
  if (value === undefined || value === null) return { ok: true, attachments: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Ảnh đính kèm phải là một danh sách.' };
  }
  if (value.length === 0) return { ok: true, attachments: [] };
  if (value.length > VISION_MAX_IMAGES) {
    return {
      ok: false,
      error:
        `Chỉ gửi được tối đa ${VISION_MAX_IMAGES} ảnh trong một tin nhắn ` +
        `(bạn gửi ${value.length} ảnh). Hãy gửi bớt ảnh rồi thử lại.`,
    };
  }
  let total = 0;
  const out: VisionAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Ảnh đính kèm không đúng định dạng (cần mimeType + data base64).' };
    }
    const item = raw as Record<string, unknown>;
    const name =
      typeof item.name === 'string' && item.name.trim() !== ''
        ? item.name.trim()
        : 'ảnh đính kèm';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
    if (!VISION_ALLOWED_MIME_TYPES.includes(mimeType)) {
      return {
        ok: false,
        error:
          `Ảnh "${name}" có định dạng không hỗ trợ` +
          (mimeType ? ` (${mimeType})` : '') +
          ` — chỉ hỗ trợ PNG, JPEG, GIF và WebP. Hãy đổi ảnh sang một trong các định dạng này rồi gửi lại.`,
      };
    }
    const data = typeof item.data === 'string' ? item.data.trim() : '';
    if (data.length === 0 || !BASE64_RE.test(data) || data.length % 4 !== 0) {
      return {
        ok: false,
        error: `Ảnh "${name}" bị lỗi dữ liệu (không phải base64 hợp lệ). Hãy đính kèm lại ảnh.`,
      };
    }
    const bytes = visionImageBytes(data);
    if (bytes <= 0) {
      return { ok: false, error: `Ảnh "${name}" rỗng. Hãy đính kèm lại ảnh.` };
    }
    if (bytes > VISION_MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error:
          `Ảnh "${name}" quá lớn (${formatVisionBytes(bytes)} — tối đa ` +
          `${formatVisionBytes(VISION_MAX_IMAGE_BYTES)} mỗi ảnh). Hãy nén nhỏ ảnh rồi gửi lại.`,
      };
    }
    total += bytes;
    if (total > VISION_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error:
          `Tổng dung lượng ảnh quá lớn (tối đa ${formatVisionBytes(VISION_MAX_TOTAL_BYTES)} ` +
          `mỗi tin nhắn). Hãy gửi bớt ảnh hoặc nén nhỏ ảnh rồi thử lại.`,
      };
    }
    out.push({ mimeType, data, ...(typeof item.name === 'string' ? { name: item.name } : {}) });
  }
  return { ok: true, attachments: out };
}

/**
 * Does an Ollama model take images? Matched by NAME ONLY (Ollama has
 * no capability endpoint the provider can ask cheaply per turn):
 * vision families are `llava*` / `bakllava`, `*-vision`, `*-vl`,
 * `moondream`, `gemma3` (multimodal), `minicpm-v`, `cogvlm`,
 * `llama4*`, `granite-*-vision`, `mistral-small3.1`. Everything else
 * — including the text-only `qwen2.5:0.5b` (a plain Qwen2 text model;
 * vision lives in the separate `qwen2.5-vl` family) — is text-only.
 * Fail-closed: an unknown name is treated as NO vision rather than
 * sending bytes blind to a model that will 400 or hallucinate.
 * Verified against Ollama's multimodal docs (blog + library, 2026):
 * LLaVA, Llama 3.2 Vision, Qwen2.5-VL, MiniCPM-V, Moondream,
 * Granite Vision, Gemma 3, Llama 4, Mistral Small 3.1.
 *
 * Known caveat (upstream Ollama, not our bug): most Ollama vision
 * models report capabilities `[completion, vision]` WITHOUT `tools`,
 * so an agent turn that needs tool calls may fail even when vision
 * itself works — plain "describe this image" turns are fine.
 */
export function ollamaModelSupportsVision(model: string): boolean {
  const name = (model ?? '').trim().toLowerCase().split(':')[0] ?? '';
  if (!name) return false;
  if (name.includes('vision')) return true;
  if (name.includes('-vl') || name.endsWith('vl')) return true;
  if (name.startsWith('llava') || name.includes('llava')) return true;
  if (name.startsWith('bakllava')) return true;
  if (name.startsWith('moondream')) return true;
  if (name.startsWith('gemma3')) return true;
  if (name.startsWith('minicpm-v')) return true;
  if (name.startsWith('cogvlm')) return true;
  if (name.startsWith('llama4')) return true;
  if (name.startsWith('granite') && name.includes('vision')) return true;
  if (name.startsWith('mistral-small3.1')) return true;
  return false;
}

/**
 * Can this provider + model take image attachments? The provider's
 * own `supportsVision(model)` wins when it implements the method
 * (Gemini / OpenAI-compatible / Anthropic: true; Ollama: name check
 * above). Providers without the method fall back to the id table:
 * API providers with a documented vision format are true, CLI
 * providers (their transports send text prompts only) and anything
 * unknown are false — fail-closed, never send bytes blind.
 */
export function providerSupportsVision(provider: Provider, model: string): boolean {
  if (typeof provider.supportsVision === 'function') {
    try {
      return provider.supportsVision(model) === true;
    } catch {
      return false;
    }
  }
  switch (provider.id) {
    case 'gemini':
    case 'openai':
    case 'anthropic':
    case 'xai':
    case 'openai-compatible':
      return true;
    case 'ollama':
      return ollamaModelSupportsVision(model);
    default:
      return false;
  }
}

/**
 * Friendly refusal the loop returns as the turn's text when the
 * current provider/model cannot see images — no provider call, no
 * crash. Names the model + a concrete next step (switch model or,
 * for Ollama, pull a vision model).
 */
export function visionUnsupportedMessage(providerLabel: string, model: string): string {
  const label = providerLabel || 'provider này';
  const m = (model ?? '').trim();
  if (m.toLowerCase().startsWith('ollama') || label.toLowerCase().includes('ollama')) {
    return (
      `Model "${m || 'đang dùng'}" (Ollama) không xem được ảnh — đây là model chỉ-xử-lý-text. ` +
      `Hãy pull một model vision rồi đổi model của bot, vd: \`ollama pull ${OLLAMA_VISION_MODEL_SUGGESTIONS[1]}\` ` +
      `(hoặc ${OLLAMA_VISION_MODEL_SUGGESTIONS.join(', ')}), rồi gửi lại ảnh.`
    );
  }
  return (
    `Bot đang dùng model "${m || 'đang dùng'}" (${label}) chưa xem được ảnh, nên mình chưa gửi ảnh của bạn lên. ` +
    `Hãy đổi bot sang model hỗ trợ xem ảnh (vd Gemini, GPT-4.1/GPT-5, Claude, hoặc Ollama với model ` +
    `${OLLAMA_VISION_MODEL_SUGGESTIONS.join(', ')}) rồi gửi lại ảnh nhé.`
  );
}
