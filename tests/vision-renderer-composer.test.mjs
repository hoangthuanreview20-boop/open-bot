/**
 * Vision channel — renderer side (v0.63).
 *
 * Pure composer logic (apps/desktop/src/renderer/components/composer.ts,
 * imported via Node's type stripping, like the UI-6/UI-7 tests) plus
 * static contract checks over the wiring files:
 *   - `visionMimeTypeForFile`: png/jpg/jpeg/gif/webp map to their MIME
 *     type; svg/bmp/avif (classified `image` but not vision-supported)
 *     map to null.
 *   - `buildVisionAttachments`: only image items with a supported MIME
 *     type and read bytes become VisionAttachment { mimeType, data
 *     (base64, NO `data:` prefix), name }; text/other items are skipped.
 *   - `validateVisionItems`: mirrors core `validateVisionAttachments`
 *     (max 5 images, 10 MB each, 20 MB total) with reason codes the
 *     composer turns into friendly notices — never a send-then-fail.
 *   - `buildAttachmentBlocks(..., { imagesAsVision: true })` emits NO
 *     text block for images (they ride the vision channel); the default
 *     (no opts) keeps the old image note, so the UI-6/UI-7 tests still
 *     pass unchanged.
 *   - Static checks: `chat:send` carries `attachments` through main
 *     (validated with core `validateVisionAttachments`, image-only
 *     messages allowed), preload, global.d.ts, App (optimistic bubble
 *     + sendChat call), and ChatView renders thumbnails + a preview
 *     modal; the new i18n keys exist in both locales.
 *
 * Run: node --test tests/vision-renderer-composer.test.mjs
 * (no network, no API key, no Electron.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VISION_MAX_IMAGES,
  VISION_MAX_IMAGE_BYTES,
  VISION_MAX_TOTAL_BYTES,
  buildAttachmentBlocks,
  buildSendText,
  buildVisionAttachments,
  validateVisionItems,
  visionImageBytes,
  visionMimeTypeForFile,
} from '../apps/desktop/src/renderer/components/composer.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf-8');

const NOTES = {
  truncatedNote: (taken, total) => `(cut: first ${taken} of ${total})`,
  imageNote: (name, size) => `image ${name} (${size}) — cannot view`,
  unreadableNote: (name) => `cannot read ${name}`,
};

// 1x1 red PNG, base64 without any `data:` prefix.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageItem(over = {}) {
  return {
    name: 'cat.png',
    size: 100,
    kind: 'image',
    relPath: null,
    content: null,
    truncated: false,
    takenBytes: 0,
    totalBytes: 100,
    readError: false,
    dataBase64: PNG_B64,
    ...over,
  };
}

function textItem(over = {}) {
  return {
    name: 'a.ts',
    size: 10,
    kind: 'text',
    relPath: null,
    content: 'hello',
    truncated: false,
    takenBytes: 5,
    totalBytes: 5,
    readError: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// MIME mapping
// ---------------------------------------------------------------------------

test('vision renderer: visionMimeTypeForFile maps png/jpg/jpeg/gif/webp, rejects svg/bmp/avif', () => {
  assert.equal(visionMimeTypeForFile('cat.png'), 'image/png');
  assert.equal(visionMimeTypeForFile('dog.jpg'), 'image/jpeg');
  assert.equal(visionMimeTypeForFile('dog.jpeg'), 'image/jpeg');
  assert.equal(visionMimeTypeForFile('anim.gif'), 'image/gif');
  assert.equal(visionMimeTypeForFile('pic.webp'), 'image/webp');
  assert.equal(visionMimeTypeForFile('PIC.PNG'), 'image/png');
  assert.equal(visionMimeTypeForFile('logo.svg'), null);
  assert.equal(visionMimeTypeForFile('photo.bmp'), null);
  assert.equal(visionMimeTypeForFile('pic.avif'), null);
  assert.equal(visionMimeTypeForFile('notes.txt'), null);
});

test('vision renderer: visionImageBytes decodes the base64 length (no prefix math)', () => {
  assert.equal(visionImageBytes(PNG_B64), 70);
  assert.equal(visionImageBytes(''), 0);
});

// ---------------------------------------------------------------------------
// buildVisionAttachments
// ---------------------------------------------------------------------------

test('vision renderer: buildVisionAttachments keeps images as {mimeType, data, name} without a data: prefix', () => {
  const out = buildVisionAttachments([
    imageItem({ name: 'cat.png' }),
    imageItem({ name: 'dog.jpg', dataBase64: PNG_B64 }),
    textItem(),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { mimeType: 'image/png', data: PNG_B64, name: 'cat.png' });
  assert.deepEqual(out[1], { mimeType: 'image/jpeg', data: PNG_B64, name: 'dog.jpg' });
  assert.ok(!out.some((a) => a.data.startsWith('data:')), 'data must be raw base64');
});

test('vision renderer: buildVisionAttachments drops unsupported / unread images (never sends them half-ready)', () => {
  assert.deepEqual(buildVisionAttachments([imageItem({ name: 'logo.svg' })]), []);
  assert.deepEqual(buildVisionAttachments([imageItem({ dataBase64: null })]), []);
  assert.deepEqual(buildVisionAttachments([imageItem({ dataBase64: '' })]), []);
  assert.deepEqual(buildVisionAttachments([]), []);
});

// ---------------------------------------------------------------------------
// validateVisionItems (early, composer-side mirror of core validation)
// ---------------------------------------------------------------------------

test('vision renderer: validateVisionItems accepts valid images and empty lists', () => {
  assert.deepEqual(validateVisionItems([]), { ok: true });
  assert.deepEqual(validateVisionItems([imageItem()]), { ok: true });
  assert.deepEqual(
    validateVisionItems(Array.from({ length: VISION_MAX_IMAGES }, (_, i) => imageItem({ name: `a${i}.png` }))),
    { ok: true },
  );
});

test('vision renderer: validateVisionItems refuses more than 5 images', () => {
  const r = validateVisionItems(
    Array.from({ length: VISION_MAX_IMAGES + 1 }, (_, i) => imageItem({ name: `a${i}.png` })),
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'too-many-images');
    assert.equal(r.name, `a${VISION_MAX_IMAGES}.png`);
  }
});

test('vision renderer: validateVisionItems refuses an oversized image (per-image 10 MB cap)', () => {
  const r = validateVisionItems([imageItem({ size: VISION_MAX_IMAGE_BYTES + 1 })]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'image-too-large');
    assert.equal(r.name, 'cat.png');
    assert.equal(r.size, VISION_MAX_IMAGE_BYTES + 1);
  }
});

test('vision renderer: validateVisionItems refuses a total over 20 MB', () => {
  // Each ~7 MB decoded (base64 ~9.4M chars); three of them ≈ 21 MB.
  const one = imageItem({ dataBase64: 'A'.repeat(9_400_000), size: 7_000_000 });
  const r = validateVisionItems([one, { ...one }, { ...one }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'images-too-large-total');
});

test('vision renderer: validateVisionItems refuses unsupported formats and unread images', () => {
  const svg = validateVisionItems([imageItem({ name: 'logo.svg' })]);
  assert.equal(svg.ok, false);
  if (!svg.ok) assert.equal(svg.reason, 'image-format-unsupported');
  const unread = validateVisionItems([imageItem({ dataBase64: null })]);
  assert.equal(unread.ok, false);
  if (!unread.ok) assert.equal(unread.reason, 'image-unreadable');
});

// ---------------------------------------------------------------------------
// buildAttachmentBlocks: images leave the text when the vision channel is on
// ---------------------------------------------------------------------------

test('vision renderer: buildAttachmentBlocks with imagesAsVision emits no image block (text files unchanged)', () => {
  const blocks = buildAttachmentBlocks([textItem(), imageItem()], NOTES, { imagesAsVision: true });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /hello/);
});

test('vision renderer: buildAttachmentBlocks without the flag keeps the old image note (backwards compatible)', () => {
  const blocks = buildAttachmentBlocks([imageItem()], NOTES);
  assert.deepEqual(blocks, ['image cat.png (100 B) — cannot view']);
});

test('vision renderer: buildSendText of an image-only message is empty (image-only sends are allowed)', () => {
  assert.equal(buildSendText('', []), '');
  assert.equal(buildSendText('  ', []), '');
  assert.equal(buildSendText('hi', []), 'hi');
});

// ---------------------------------------------------------------------------
// Static contract: the wiring files carry attachments end to end
// ---------------------------------------------------------------------------

test('vision renderer: main chat:send validates attachments and allows empty text with images', () => {
  const main = read(path.join(repo, 'apps/desktop/src/main/main.ts'));
  assert.match(main, /validateVisionAttachments\(payload\?\.attachments\)/);
  assert.match(main, /if \(!text && attachments\.length === 0\) throw new Error\('Tin nhắn trống\.'\)/);
  assert.match(main, /getCoordinator\(\)\.run\(bot\.id, text, undefined, \{\s*threadId,/);
  assert.match(main, /attachments\.length > 0 \? \{ attachments \} : \{\}/);
  // History (v0.65): images are persisted as files + rows via
  // saveMessage — the metadata-line helper is gone, the saved text
  // stays plain, and history reloads re-read the stored images.
  assert.doesNotMatch(main, /function visionHistoryLine/);
  assert.doesNotMatch(main, /Ảnh đính kèm: /);
  assert.match(main, /syncMessageToMemory\(runtime, userMsg, threadId, attachments\)/);
  assert.match(main, /getCoordinator\(\)\.saveMessage\(\s*runtime\.bot\.id,\s*msg\.role,\s*msg\.text,\s*threadId,\s*attachments,/);
  assert.match(main, /getHistory\(\s*runtime\.bot\.id,\s*limit,\s*threadId,\s*true,/);
  assert.doesNotMatch(main, /console\.log\(.*attachment/i);
});

test('vision renderer: preload + global.d.ts expose attachments on sendChat', () => {
  const preload = read(path.join(repo, 'apps/desktop/src/main/preload.ts'));
  assert.match(preload, /sendChat: \(botId: string, text: string, threadId\?: string, attachments\?: Array<\{ mimeType: string; data: string; name\?: string \}>\)/);
  assert.match(preload, /ipcRenderer\.invoke\('chat:send', \{ botId, text, threadId, attachments \}\)/);
  const dts = read(path.join(repo, 'apps/desktop/src/renderer/global.d.ts'));
  assert.match(dts, /sendChat\(botId: string, text: string, threadId\?: string, attachments\?: Array<\{ mimeType: string; data: string; name\?: string \}>\)/);
});

test('vision renderer: App passes attachments to sendChat and the optimistic bubble carries them', () => {
  const app = read(path.join(repo, 'apps/desktop/src/renderer/App.tsx'));
  assert.match(app, /const send = async \(text: string, visionAttachments\?: VisionAttachment\[\]\)/);
  assert.match(app, /sendChat\(\s*botId,\s*text,\s*selectedThreadIdRef\.current \?\? undefined,\s*visionAttachments,\s*\)/);
  assert.match(app, /attachments: visionAttachments/);
  assert.match(app, /onSend=\{\(text, visionAttachments\) => void send\(text, visionAttachments\)\}/);
});

test('vision renderer: ChatView renders thumbnails + preview modal and never logs base64', () => {
  const view = read(path.join(repo, 'apps/desktop/src/renderer/components/ChatView.tsx'));
  assert.match(view, /className="msg-images"/);
  assert.match(view, /className="msg-image-thumb"/);
  assert.match(view, /className="image-preview-overlay"/);
  assert.match(view, /onSend\(text, vision\.length > 0 \? vision : undefined\)/);
  assert.match(view, /data:\$\{att\.mimeType\};base64,\$\{att\.data\}/);
  assert.doesNotMatch(view, /console\.log\(/);
  const css = read(path.join(repo, 'apps/desktop/src/renderer/styles.css'));
  assert.match(css, /\.msg-image-thumb/);
  assert.match(css, /\.image-preview-overlay/);
});

test('vision renderer: new i18n keys exist in both locales', () => {
  for (const loc of ['vi', 'en']) {
    const dict = JSON.parse(read(path.join(repo, `apps/desktop/src/renderer/i18n/locales/${loc}.json`)));
    for (const key of [
      'chat.visionImageTooMany',
      'chat.visionImageTooLarge',
      'chat.visionImagesTooLargeTotal',
      'chat.visionImageUnsupported',
      'chat.visionImageUnreadable',
      'chat.closeImagePreview',
      'chat.attachedImageFallback',
    ]) {
      assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${loc} must define ${key}`);
    }
  }
});
