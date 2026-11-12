/**
 * Composer logic for the chat input (UI-6 + UI-7, v0.60) — pure functions,
 * no React, no DOM, no Electron: node:test can cover this file directly
 * (see tests/ui-composer-autocomplete-attach-v060.test.mjs), like
 * markdown.ts for UI-1.
 *
 * UI-6 — autocomplete `/` (slash) + `@` (mentions):
 * - Slash commands come from the slash registry
 *   (packages/core/src/agent/slash.ts: per-bot `<workspace>/.open-bot/
 *   commands/*.md` + plugin-bundle commands, resolved by the coordinator).
 *   The renderer cannot read that registry itself — it is deliberately
 *   self-contained and never imports @open-bot/core (see types.ts) — so
 *   the list arrives as data: ChatView asks the optional
 *   `window.openBot.listSlashCommands(botId)` (main exposes `slash:list`
 *   in a follow-up; until then the list is empty and the popup shows the
 *   "no commands yet" hint). NOTHING here hardcodes a command list: the
 *   filter below only ranks whatever the registry returned.
 * - Mentions are the closed kind set of packages/core/src/agent/
 *   mentions.ts: exactly `@files` / `@docs` (MentionKind). The two kinds
 *   are mirrored here as data, not invented — core rejects anything else.
 *
 * UI-7 — attachments (file picker / drag-drop / paste image):
 * - Files reach the agent through the @files mechanism that already
 *   exists (mentions.ts `resolveMentions`, run by the coordinator before
 *   slash expansion): a file inside the bot workspace is sent as an
 *   `@files <relative-path>` mention and the coordinator reads it
 *   (100KB/file, 500KB total — the same caps are mirrored below).
 * - A text file outside the workspace cannot be reached by path (the
 *   coordinator only reads inside the workspace), so the renderer reads
 *   its content with the File API and inlines it in the same
 *   `[@files name] + fenced block` shape resolveMentions produces.
 * - Images have no vision channel in `chat:send` (the run text is
 *   text-only), so a pasted/dropped image is shown as a chip + thumbnail
 *   and sent as a short note saying the bot cannot view images yet —
 *   the user describes the image in words. Full image input needs a
 *   `chat:send` image channel in main/coordinator (out of scope here).
 *
 * v0.63 (vision channel, renderer side): the image channel now exists.
 * Images are read as base64 in ChatView (`AttachmentSendItem.dataBase64`)
 * and travel as `VisionAttachment` (mirror of core `VisionAttachment` in
 * packages/core/src/types.ts — same shape, renderer-local so this file
 * stays self-contained) through `chat:send` → coordinator → provider.
 * `buildAttachmentBlocks(..., { imagesAsVision: true })` emits NO text
 * block for images any more (the default `false` keeps the old note for
 * existing callers/tests). Limits mirror core `agent/vision.ts` exactly:
 * max 5 images, 10 MB each, 20 MB total, PNG/JPEG/GIF/WebP only.
 */

/** One slash command, as the registry describes it (name + description). */
export interface SlashCommandItem {
  name: string;
  description: string;
}

/** The two mention kinds core understands (`MentionKind` in mentions.ts). */
export const MENTION_KINDS = [
  { kind: 'files', label: '@files' },
  { kind: 'docs', label: '@docs' },
] as const;

export type MentionKindName = (typeof MENTION_KINDS)[number]['kind'];

/** One autocomplete row: what the popup shows and what it inserts. */
export interface AutocompleteItem {
  /** Stable key for React (`/review-code`, `@files`). */
  key: string;
  /** Label shown in bold (`/review-code`, `@files`). */
  label: string;
  /** One-line description under the label. */
  description: string;
  /** Text inserted into the composer (trailing space included). */
  insertText: string;
}

/** A live trigger: the `/` or `@` the user is typing, up to the cursor. */
export interface ComposerTrigger {
  kind: 'slash' | 'mention';
  /** Partial word after `/` or `@` (may be ''). */
  query: string;
  /** Index of the `/` / `@` in the text. */
  start: number;
  /** == cursor position (end of the trigger word). */
  end: number;
}

/** Max items the popup ever shows. */
export const AUTOCOMPLETE_LIMIT = 8;

/** Slash only triggers at the start of a line (`/` must be the first char). */
function detectSlash(text: string, cursor: number): ComposerTrigger | null {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  if (text[lineStart] !== '/') return null;
  const query = text.slice(lineStart + 1, cursor);
  if (!/^[a-z0-9-]*$/.test(query)) return null;
  return { kind: 'slash', query, start: lineStart, end: cursor };
}

/**
 * Mention trigger: `@` + word chars, where the char before `@` is the
 * start of the text, whitespace, or an opening/punctuation char — so
 * `mail@files` (email) never triggers, but `(@files` and `"@docs` do.
 */
function detectMention(text: string, cursor: number): ComposerTrigger | null {
  let i = cursor;
  while (i > 0 && /[A-Za-z0-9_-]/.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== '@') {
    // `@` alone (empty query): the word scan found nothing, but the char
    // right before the cursor may itself be the `@`.
    if (cursor === 0 || text[cursor - 1] !== '@') return null;
    i = cursor;
  }
  const at = i - 1;
  if (at > 0 && !/[\s\(\[\{,;:'"]/.test(text[at - 1]!)) return null;
  const query = text.slice(at + 1, cursor);
  if (!/^[A-Za-z0-9_-]*$/.test(query)) return null;
  return { kind: 'mention', query, start: at, end: cursor };
}

/**
 * Find the trigger active at `cursor`, or null. The trigger word must
 * end at the cursor (the next char, if any, is whitespace or a newline)
 * — typing in the middle of a word does not open the popup. When both
 * a slash and a mention could match, the one closer to the cursor wins
 * (e.g. `/cmd @fi` is a mention trigger).
 */
export function detectTrigger(text: string, cursor: number): ComposerTrigger | null {
  if (typeof text !== 'string') return null;
  const pos = Math.max(0, Math.min(cursor, text.length));
  const next = text[pos];
  if (next !== undefined && next !== ' ' && next !== '\t' && next !== '\n') return null;
  const slash = detectSlash(text, pos);
  const mention = detectMention(text, pos);
  if (slash && mention) return mention.start > slash.start ? mention : slash;
  return mention ?? slash;
}

/** Ranked filter: prefix matches first, then substring matches. */
function rankFilter<T>(items: T[], query: string, haystack: (item: T) => string[]): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items.slice(0, AUTOCOMPLETE_LIMIT);
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const hay = haystack(item).map((s) => s.toLowerCase());
    let score = -1;
    if (hay[0]?.startsWith(q)) score = 0;
    else if (hay.some((s) => s.includes(q))) score = 1;
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, AUTOCOMPLETE_LIMIT).map((s) => s.item);
}

/** Filter registry slash commands by the typed query (no hardcoding). */
export function filterSlashCommands(
  commands: SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  return rankFilter(commands ?? [], query, (c) => [c.name, c.description]);
}

/** Filter the two mention kinds by the typed query. */
export function filterMentionKinds(query: string): Array<{ kind: MentionKindName; label: string }> {
  return rankFilter([...MENTION_KINDS], query, (m) => [m.kind, m.label]);
}

/** Build popup rows for slash commands (insert keeps a trailing space for args). */
export function slashItems(commands: SlashCommandItem[], query: string): AutocompleteItem[] {
  return filterSlashCommands(commands, query).map((c) => ({
    key: `/${c.name}`,
    label: `/${c.name}`,
    description: c.description,
    insertText: `/${c.name} `,
  }));
}

/** Build popup rows for mentions. `describe` supplies the i18n description. */
export function mentionItems(
  query: string,
  describe: (kind: MentionKindName) => string,
): AutocompleteItem[] {
  return filterMentionKinds(query).map((m) => ({
    key: m.label,
    label: m.label,
    description: describe(m.kind),
    insertText: `${m.label} `,
  }));
}

/** Replace the trigger span with the chosen completion; returns new text + cursor. */
export function applyCompletion(
  text: string,
  trigger: ComposerTrigger,
  insertText: string,
): { text: string; cursor: number } {
  const next = text.slice(0, trigger.start) + insertText + text.slice(trigger.end);
  return { text: next, cursor: trigger.start + insertText.length };
}

// ---------------------------------------------------------------------------
// Attachments (UI-7)
// ---------------------------------------------------------------------------

/** Max bytes inlined from one attached text file — mirrors MENTION_MAX_FILE_BYTES. */
export const ATTACHMENT_MAX_FILE_BYTES = 100 * 1024;

/** Max total inlined bytes per message — mirrors MENTION_MAX_TOTAL_BYTES. */
export const ATTACHMENT_MAX_TOTAL_BYTES = 500 * 1024;

/** Max attachments on one message (keeps the composer readable). */
export const ATTACHMENT_MAX_ITEMS = 5;

export type AttachmentKind = 'text' | 'image' | 'other';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c',
  'cpp', 'h', 'hpp', 'cs', 'css', 'scss', 'html', 'htm', 'sh', 'bash', 'zsh',
  'sql', 'log', 'ini', 'cfg', 'conf', 'env', 'diff', 'patch', 'tex', 'vue', 'svelte',
]);

/** Fence language by extension — same mapping as mentions.ts LANG_BY_EXT. */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'mjs', '.cjs': 'cjs',
  '.json': 'json', '.md': 'md', '.markdown': 'md', '.py': 'python', '.rb': 'ruby',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.css': 'css', '.html': 'html', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml', '.sh': 'bash', '.sql': 'sql', '.txt': 'text',
};

export function fileExtension(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Classify an attachment by extension: image / readable text / other (binary). */
export function classifyAttachment(fileName: string): AttachmentKind {
  const ext = fileExtension(fileName);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext) || ext === '') return 'text';
  return 'other';
}

/** Human size: `123 B`, `12 KB`, `1.2 MB`. */
export function formatFileSize(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Relative path of `filePath` inside `workspaceDir`, or null when the
 * file is outside the workspace. Both are host paths; separators are
 * normalised so a Windows-style `C:\ws\a.ts` still matches.
 */
export function relativeWorkspacePath(workspaceDir: string, filePath: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const ws = norm(String(workspaceDir ?? ''));
  const file = norm(String(filePath ?? ''));
  if (!ws || !file) return null;
  if (file === ws) return null;
  if (!file.startsWith(`${ws}/`)) return null;
  return file.slice(ws.length + 1);
}

/**
 * Truncate text content to `maxBytes` (UTF-8). Returns the kept content,
 * whether it was cut, and the byte counts (for the "(truncated…)" note).
 */
export function truncateTextContent(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean; takenBytes: number; totalBytes: number } {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(content).length;
  if (totalBytes <= maxBytes) {
    return { content, truncated: false, takenBytes: totalBytes, totalBytes };
  }
  const bytes = encoder.encode(content).subarray(0, maxBytes);
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { content: kept, truncated: true, takenBytes: maxBytes, totalBytes };
}

/** One attachment as prepared by the composer (content already read / truncated). */
export interface AttachmentSendItem {
  name: string;
  size: number;
  kind: AttachmentKind;
  /** Relative path when the file lives in the bot workspace (else null). */
  relPath: string | null;
  /** Inlined text content for outside-workspace text files (else null). */
  content: string | null;
  truncated: boolean;
  takenBytes: number;
  totalBytes: number;
  /** True when reading the file failed (renders the unreadable note). */
  readError: boolean;
  /**
   * v0.63 (vision channel): base64 image bytes (WITHOUT the `data:`
   * prefix) for kind === 'image', read by ChatView with the File API.
   * Null / missing = not read yet (or the read failed — see
   * `validateVisionItems`, which refuses to send such an image).
   */
  dataBase64?: string | null;
}

// ---------------------------------------------------------------------------
// Vision attachments (v0.63) — mirrors packages/core/src/agent/vision.ts
// ---------------------------------------------------------------------------

/**
 * One image attached to a user message — renderer mirror of core
 * `VisionAttachment` (packages/core/src/types.ts). Same field names so
 * the object passes straight through IPC into `RunParams.attachments`.
 * `data` is raw base64 WITHOUT the `data:` prefix (providers add their
 * own envelope); never logged (see ChatView — thumbnails use data URLs
 * for display only, never `console.log`).
 */
export interface VisionAttachment {
  /** Image MIME type, e.g. `image/png` (see VISION_ALLOWED_MIME_TYPES). */
  mimeType: string;
  /** Raw image bytes, base64-encoded, no `data:` prefix. */
  data: string;
  /** Original file name (for error messages / display); optional. */
  name?: string;
  /**
   * v0.65 (vision persistence): true when the stored image is gone or
   * unreadable — `data` is '' and the renderer shows the name + an
   * "unavailable" note instead of a thumbnail. Only produced by a
   * history reload; never set on a live-turn attachment.
   */
  unavailable?: boolean;
}

/** Max images on one message — mirrors core VISION_MAX_IMAGES (and ATTACHMENT_MAX_ITEMS). */
export const VISION_MAX_IMAGES = 5;
/** Max decoded bytes of ONE image (10 MB) — mirrors core VISION_MAX_IMAGE_BYTES. */
export const VISION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Max decoded bytes of ALL images on one message (20 MB) — mirrors core VISION_MAX_TOTAL_BYTES. */
export const VISION_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * MIME types the vision channel accepts — mirrors core
 * VISION_ALLOWED_MIME_TYPES. SVG/BMP/AVIF are classified as `image`
 * by `classifyAttachment` but are NOT accepted here (no vision provider
 * takes them as image input); they are refused with a friendly error.
 */
export const VISION_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

const VISION_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Vision MIME type for a file name, or null when the format is not vision-supported. */
export function visionMimeTypeForFile(fileName: string): string | null {
  return VISION_MIME_BY_EXT[fileExtension(fileName)] ?? null;
}

/** Decoded byte size of a base64 string (length math, no decode — mirrors core visionImageBytes). */
export function visionImageBytes(data: string): number {
  const clean = data.replace(/\s/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * Vision-eligible images among the prepared items: kind === 'image'
 * with a supported MIME type and bytes already read. Anything else
 * (unsupported format, unreadable) is dropped here and reported by
 * `validateVisionItems` instead of being sent silently incomplete.
 */
export function buildVisionAttachments(items: AttachmentSendItem[]): VisionAttachment[] {
  const out: VisionAttachment[] = [];
  for (const item of items) {
    if (item.kind !== 'image') continue;
    const mimeType = visionMimeTypeForFile(item.name);
    if (!mimeType || !item.dataBase64) continue;
    out.push({ mimeType, data: item.dataBase64, name: item.name });
  }
  return out;
}

export type VisionValidationResult =
  | { ok: true }
  | { ok: false; reason: 'too-many-images'; name: string }
  | { ok: false; reason: 'image-too-large'; name: string; size: number }
  | { ok: false; reason: 'images-too-large-total'; name: string }
  | { ok: false; reason: 'image-format-unsupported'; name: string }
  | { ok: false; reason: 'image-unreadable'; name: string };

/**
 * Check the image attachments against the vision limits BEFORE sending,
 * so the composer can refuse with a friendly notice instead of sending
 * and failing in main/core. Mirrors core `validateVisionAttachments`
 * (which re-validates fail-closed on the way in — this is only the
 * early, user-facing check). The first violation wins, in the order
 * the user would fix it: count, then per-image format / size / read,
 * then the total.
 */
export function validateVisionItems(items: AttachmentSendItem[]): VisionValidationResult {
  const images = items.filter((item) => item.kind === 'image');
  if (images.length > VISION_MAX_IMAGES) {
    return { ok: false, reason: 'too-many-images', name: images[VISION_MAX_IMAGES]!.name };
  }
  let total = 0;
  for (const item of images) {
    if (!visionMimeTypeForFile(item.name)) {
      return { ok: false, reason: 'image-format-unsupported', name: item.name };
    }
    if (item.size > VISION_MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'image-too-large', name: item.name, size: item.size };
    }
    if (!item.dataBase64) {
      return { ok: false, reason: 'image-unreadable', name: item.name };
    }
    total += visionImageBytes(item.dataBase64);
    if (total > VISION_MAX_TOTAL_BYTES) {
      return { ok: false, reason: 'images-too-large-total', name: item.name };
    }
  }
  return { ok: true };
}

/** i18n note builders, supplied by the caller (this module stays string-free). */
export interface AttachmentNoteFns {
  truncatedNote: (taken: string, total: string) => string;
  imageNote: (name: string, size: string) => string;
  unreadableNote: (name: string) => string;
}

/**
 * Bytes of inlined text one attachment contributes to the 500KB total
 * budget (0 for in-workspace files — the coordinator counts those
 * itself — and for images/other, which are never inlined).
 */
export function attachmentInlineBytes(item: Pick<AttachmentSendItem, 'kind' | 'relPath' | 'takenBytes'>): number {
  if (item.kind !== 'text' || item.relPath !== null) return 0;
  return item.takenBytes;
}

/** Total inlined bytes of the attachments already on the composer. */
export function inlineBytesUsed(items: AttachmentSendItem[]): number {
  return items.reduce((sum, item) => sum + attachmentInlineBytes(item), 0);
}

/**
 * Would adding an outside-workspace text file of `nextSize` bytes bust
 * the 500KB total? (The file is truncated to 100KB first, so it costs
 * at most that much.)
 */
export function wouldExceedTotal(items: AttachmentSendItem[], nextSize: number): boolean {
  return inlineBytesUsed(items) + Math.min(nextSize, ATTACHMENT_MAX_FILE_BYTES) > ATTACHMENT_MAX_TOTAL_BYTES;
}

/**
 * Turn prepared attachments into the text blocks appended to the message.
 * - In-workspace file → `@files <rel-path>` (coordinator resolves it).
 * - Outside text file → `[@files name]` + fenced content (same shape
 *   resolveMentions produces), plus the truncated note when cut.
 * - Image / unreadable / other → a one-line note (i18n, via `notes`).
 * - v0.63: with `opts.imagesAsVision`, image items emit NO block — they
 *   travel as `VisionAttachment` (see `buildVisionAttachments`) instead
 *   of a text note. Default (no opts) keeps the old note behaviour.
 */
export function buildAttachmentBlocks(
  items: AttachmentSendItem[],
  notes: AttachmentNoteFns,
  opts?: { imagesAsVision?: boolean },
): string[] {
  const blocks: string[] = [];
  for (const item of items) {
    if (item.kind === 'text' && item.relPath !== null) {
      blocks.push(`@files ${item.relPath}`);
      continue;
    }
    if (item.kind === 'text' && item.content !== null) {
      const lang = LANG_BY_EXT[`.${fileExtension(item.name)}`] ?? '';
      let block = `[@files ${item.name}]\n\`\`\`${lang}\n${item.content}\n\`\`\``;
      if (item.truncated) {
        block += `\n${notes.truncatedNote(formatFileSize(item.takenBytes), formatFileSize(item.totalBytes))}`;
      }
      blocks.push(block);
      continue;
    }
    if (item.kind === 'image') {
      // v0.63: images ride the vision channel, not the text — no block.
      if (opts?.imagesAsVision) continue;
      blocks.push(notes.imageNote(item.name, formatFileSize(item.size)));
      continue;
    }
    blocks.push(notes.unreadableNote(item.name));
  }
  return blocks;
}

/** Final message text: typed text plus one paragraph per attachment block. */
export function buildSendText(input: string, attachmentBlocks: string[]): string {
  const parts = [input.trim(), ...attachmentBlocks.map((b) => b.trim())].filter((p) => p !== '');
  return parts.join('\n\n');
}
