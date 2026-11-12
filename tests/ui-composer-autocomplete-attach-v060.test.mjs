/**
 * UI-6 + UI-7 tests (v0.60) — composer autocomplete + attachments.
 *
 * Pure logic lives in apps/desktop/src/renderer/components/composer.ts
 * (no DOM / Electron needed, imported via Node's type stripping, like
 * the markdown tests):
 *   - detectTrigger: slash only at line start, mention `@` anywhere
 *     (but never inside an email address); the trigger word must end
 *     at the cursor; closest trigger wins.
 *   - filterSlashCommands / filterMentionKinds: prefix-first ranking,
 *     case-insensitive, capped at 8; the slash filter only ranks the
 *     registry list it is given (no hardcoded commands).
 *   - applyCompletion: replaces the trigger span, returns new cursor.
 *   - attachments: classify by extension, workspace-relative path,
 *     100KB/file + 500KB total caps (mirroring mentions.ts), truncation,
 *     and buildAttachmentBlocks — in-workspace files become
 *     `@files <rel-path>` (coordinator resolves them), outside text
 *     files are inlined as `[@files name]` + fenced content, images
 *     become a note (no vision channel in chat:send).
 * Static contract checks: ChatView wires the popup + attach/drop/paste,
 * global.d.ts declares the (now required) listSlashCommands, and every new
 * i18n key exists in both locales.
 *
 * Run: node --test tests/ui-composer-autocomplete-attach-v060.test.mjs
 * (no network, no API key, no Electron.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  AUTOCOMPLETE_LIMIT,
  MENTION_KINDS,
  applyCompletion,
  buildAttachmentBlocks,
  buildSendText,
  classifyAttachment,
  detectTrigger,
  filterMentionKinds,
  filterSlashCommands,
  formatFileSize,
  inlineBytesUsed,
  mentionItems,
  relativeWorkspacePath,
  slashItems,
  truncateTextContent,
  wouldExceedTotal,
} from '../apps/desktop/src/renderer/components/composer.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const renderer = path.join(repo, 'apps/desktop/src/renderer');
const read = (p) => fs.readFileSync(p, 'utf-8');

const COMMANDS = [
  { name: 'review-code', description: 'Review code for bugs' },
  { name: 'refactor', description: 'Refactor the selected code' },
  { name: 'commit', description: 'Write a commit message' },
  { name: 'test', description: 'Generate tests' },
];

const NOTES = {
  truncatedNote: (taken, total) => `(cut: first ${taken} of ${total})`,
  imageNote: (name, size) => `image ${name} (${size}) — cannot view`,
  unreadableNote: (name) => `cannot read ${name}`,
};

function item(over = {}) {
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

// --- UI-6: trigger detection -------------------------------------------

test('detectTrigger: slash only at the start of a line', () => {
  assert.deepEqual(detectTrigger('/rev', 4), {
    kind: 'slash', query: 'rev', start: 0, end: 4,
  });
  assert.deepEqual(detectTrigger('hello\n/rev', 10), {
    kind: 'slash', query: 'rev', start: 6, end: 10,
  });
  assert.equal(detectTrigger('hello /rev', 10), null, 'slash mid-line does not trigger');
  assert.equal(detectTrigger('  /rev', 6), null, 'indented slash does not trigger');
  assert.deepEqual(detectTrigger('/', 1), { kind: 'slash', query: '', start: 0, end: 1 });
  assert.equal(detectTrigger('/rev args', 9), null, 'space ends the trigger word');
  assert.equal(detectTrigger('/Rev', 4), null, 'uppercase slash names are not commands');
});

test('detectTrigger: mention @ anywhere, never inside an email', () => {
  assert.deepEqual(detectTrigger('@fi', 3), {
    kind: 'mention', query: 'fi', start: 0, end: 3,
  });
  assert.deepEqual(detectTrigger('xem @files README.md', 10), {
    kind: 'mention', query: 'files', start: 4, end: 10,
  });
  assert.deepEqual(detectTrigger('@', 1), { kind: 'mention', query: '', start: 0, end: 1 });
  assert.deepEqual(detectTrigger('(@docs', 6), {
    kind: 'mention', query: 'docs', start: 1, end: 6,
  });
  assert.equal(detectTrigger('mail@files x', 10), null, 'email address is not a mention');
  assert.equal(detectTrigger('@files ', 7), null, 'space after the kind closes the popup');
  assert.equal(detectTrigger('@files README', 13), null, 'cursor after a path is not a trigger');
});

test('detectTrigger: cursor must be at the end of the trigger word', () => {
  assert.equal(detectTrigger('/review-code', 4), null, 'cursor mid-word, next char is a word char');
  assert.equal(detectTrigger('@files x', 3), null);
  assert.deepEqual(detectTrigger('/rev ', 4), {
    kind: 'slash', query: 'rev', start: 0, end: 4,
  });
});

test('detectTrigger: closest trigger wins', () => {
  assert.deepEqual(detectTrigger('/cmd @fi', 8), {
    kind: 'mention', query: 'fi', start: 5, end: 8,
  });
});

// --- UI-6: filtering + completion --------------------------------------

test('filterSlashCommands: prefix first, case-insensitive, capped', () => {
  assert.deepEqual(
    filterSlashCommands(COMMANDS, 're').map((c) => c.name),
    ['review-code', 'refactor'],
    'prefix matches come first, in registry order',
  );
  assert.deepEqual(
    filterSlashCommands(COMMANDS, 'TEST').map((c) => c.name),
    ['test'],
  );
  assert.deepEqual(
    filterSlashCommands(COMMANDS, 'code').map((c) => c.name),
    ['review-code', 'refactor'],
    'substring also matches name or description',
  );
  assert.deepEqual(filterSlashCommands(COMMANDS, 'zzz'), []);
  assert.equal(filterSlashCommands(COMMANDS, '').length, 4, 'empty query lists all');
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `cmd-${i}`, description: '' }));
  assert.equal(filterSlashCommands(many, '').length, AUTOCOMPLETE_LIMIT);
  assert.deepEqual(filterSlashCommands([], 're'), [], 'empty registry, empty list — never hardcoded');
});

test('filterMentionKinds: exactly the two core kinds', () => {
  assert.deepEqual(
    MENTION_KINDS.map((m) => m.kind),
    ['files', 'docs'],
  );
  assert.deepEqual(
    filterMentionKinds('fi').map((m) => m.kind),
    ['files'],
  );
  assert.deepEqual(
    filterMentionKinds('').map((m) => m.kind),
    ['files', 'docs'],
  );
  assert.deepEqual(filterMentionKinds('zzz'), []);
});

test('slashItems / mentionItems: labels and inserted text', () => {
  const [first] = slashItems(COMMANDS, 'rev');
  assert.equal(first.label, '/review-code');
  assert.equal(first.insertText, '/review-code ', 'trailing space so args can follow');
  const [m] = mentionItems('fi', (kind) => (kind === 'files' ? 'files in workspace' : 'docs'));
  assert.equal(m.label, '@files');
  assert.equal(m.insertText, '@files ');
  assert.equal(m.description, 'files in workspace');
});

test('applyCompletion: replaces only the trigger span', () => {
  const trigger = detectTrigger('please /rev', 11);
  assert.equal(trigger, null, 'mid-line slash is not a trigger — use a line-start case');
  const t2 = detectTrigger('/rev', 4);
  assert.ok(t2);
  assert.deepEqual(applyCompletion('/rev', t2, '/review-code '), {
    text: '/review-code ',
    cursor: 13,
  });
  const t3 = detectTrigger('xem @fi', 7);
  assert.ok(t3);
  assert.deepEqual(applyCompletion('xem @fi', t3, '@files '), {
    text: 'xem @files ',
    cursor: 11,
  });
  const t4 = detectTrigger('/rev\nsecond line', 4);
  assert.ok(t4);
  assert.equal(applyCompletion('/rev\nsecond line', t4, '/review-code ').text, '/review-code \nsecond line');
});

// --- UI-7: attachment classification + limits --------------------------

test('classifyAttachment: image / text / other by extension', () => {
  assert.equal(classifyAttachment('photo.png'), 'image');
  assert.equal(classifyAttachment('shot.JPG'), 'image');
  assert.equal(classifyAttachment('a.ts'), 'text');
  assert.equal(classifyAttachment('README.md'), 'text');
  assert.equal(classifyAttachment('data.json'), 'text');
  assert.equal(classifyAttachment('LICENSE'), 'text', 'extensionless files are read as text');
  assert.equal(classifyAttachment('app.exe'), 'other');
  assert.equal(classifyAttachment('archive.zip'), 'other');
});

test('formatFileSize', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(123), '123 B');
  assert.equal(formatFileSize(2048), '2 KB');
  assert.equal(formatFileSize(1536 * 1024), '1.5 MB');
});

test('relativeWorkspacePath: inside -> rel, outside -> null', () => {
  assert.equal(relativeWorkspacePath('/ws', '/ws/src/a.ts'), 'src/a.ts');
  assert.equal(relativeWorkspacePath('/ws/', '/ws/a.ts'), 'a.ts');
  assert.equal(relativeWorkspacePath('C:\\ws', 'C:/ws/src/a.ts'), 'src/a.ts');
  assert.equal(relativeWorkspacePath('/ws', '/other/a.ts'), null);
  assert.equal(relativeWorkspacePath('/ws', '/ws'), null, 'the workspace dir itself is not a file');
  assert.equal(relativeWorkspacePath('/ws', '/ws2/a.ts'), null, 'prefix sibling must not match');
  assert.equal(relativeWorkspacePath('/ws', ''), null);
});

test('truncateTextContent: 100KB cap, byte counts', () => {
  assert.equal(ATTACHMENT_MAX_FILE_BYTES, 100 * 1024);
  assert.equal(ATTACHMENT_MAX_TOTAL_BYTES, 500 * 1024);
  const small = truncateTextContent('hello', 100);
  assert.equal(small.truncated, false);
  assert.equal(small.takenBytes, 5);
  const big = truncateTextContent('x'.repeat(300), 100);
  assert.equal(big.truncated, true);
  assert.equal(big.takenBytes, 100);
  assert.equal(big.totalBytes, 300);
  assert.equal(big.content.length, 100);
});

test('wouldExceedTotal / inlineBytesUsed: 500KB total over inlined text only', () => {
  const inWorkspace = item({ relPath: 'src/a.ts', content: null, takenBytes: 0 });
  assert.equal(inlineBytesUsed([inWorkspace]), 0, 'in-workspace files cost nothing here');
  const image = item({ kind: 'image', content: null, takenBytes: 0, size: 900000 });
  assert.equal(inlineBytesUsed([image]), 0, 'images are never inlined');
  const used = [item({ takenBytes: 450 * 1024 })];
  assert.equal(wouldExceedTotal(used, 40 * 1024), false);
  assert.equal(wouldExceedTotal(used, 100 * 1024), true, '450KB + min(100KB, 100KB) > 500KB');
  assert.equal(wouldExceedTotal(used, 200 * 1024), true, 'a 200KB file still costs its truncated 100KB');
});

// --- UI-7: blocks that reach the agent ---------------------------------

test('buildAttachmentBlocks: in-workspace file becomes @files mention', () => {
  const blocks = buildAttachmentBlocks(
    [item({ relPath: 'src/a.ts', content: null, takenBytes: 0 })],
    NOTES,
  );
  assert.deepEqual(blocks, ['@files src/a.ts']);
});

test('buildAttachmentBlocks: outside text file is inlined as a fenced block', () => {
  const blocks = buildAttachmentBlocks([item({ name: 'a.ts', content: 'const x = 1;' })], NOTES);
  assert.equal(blocks[0], '[@files a.ts]\n```ts\nconst x = 1;\n```');
  const cut = buildAttachmentBlocks(
    [item({ name: 'big.txt', content: 'x'.repeat(10), truncated: true, takenBytes: 100 * 1024, totalBytes: 200 * 1024 })],
    NOTES,
  );
  assert.match(cut[0], /\(cut: first 100 KB of 200 KB\)/);
});

test('buildAttachmentBlocks: image and unreadable files become notes', () => {
  const blocks = buildAttachmentBlocks(
    [
      item({ kind: 'image', name: 'shot.png', size: 2048, content: null, takenBytes: 0 }),
      item({ kind: 'other', name: 'app.exe', content: null, takenBytes: 0 }),
      item({ kind: 'text', name: 'broken.txt', content: null, readError: true, takenBytes: 0 }),
    ],
    NOTES,
  );
  assert.deepEqual(blocks, [
    'image shot.png (2 KB) — cannot view',
    'cannot read app.exe',
    'cannot read broken.txt',
  ]);
});

test('buildSendText: typed text plus one paragraph per attachment', () => {
  assert.equal(buildSendText('hi', ['@files src/a.ts']), 'hi\n\n@files src/a.ts');
  assert.equal(buildSendText('  ', ['@files src/a.ts']), '@files src/a.ts');
  assert.equal(buildSendText('hi', []), 'hi');
  assert.equal(buildSendText('', []), '');
});

// --- Static contract: wiring -------------------------------------------

test('ChatView wires autocomplete + attach/drop/paste (static contract)', () => {
  const chat = read(path.join(renderer, 'components/ChatView.tsx'));
  assert.match(chat, /import ComposerAutocomplete from '\.\/ComposerAutocomplete'/);
  assert.match(chat, /detectTrigger\(/, 'trigger detection is wired to the composer');
  assert.match(chat, /listSlashCommands/, 'slash list is fetched from the (optional) registry API');
  assert.match(chat, /<ComposerAutocomplete/, 'the popup component is rendered by ChatView');
  assert.match(chat, /data-testid="attach-button"/);
  assert.match(chat, /onDrop/, 'drag-drop is handled on the composer');
  assert.match(chat, /onPaste/, 'paste is handled on the textarea');
  assert.match(chat, /buildAttachmentBlocks\(/, 'attachments are folded into the sent text');
  assert.match(chat, /handleAutocompleteKey/, 'ArrowUp/Down/Enter/Tab/Escape navigate the popup');
  assert.match(chat, /chat\.attachHint/, 'attach button uses the i18n key');
});

test('ComposerAutocomplete renders rows + empty state (static contract)', () => {
  const cmp = read(path.join(renderer, 'components/ComposerAutocomplete.tsx'));
  assert.match(cmp, /role="listbox"/);
  assert.match(cmp, /role="option"/);
  assert.match(cmp, /data-testid="composer-autocomplete"/);
  assert.match(cmp, /onMouseDown/, 'select on mousedown so the textarea keeps focus');
  assert.match(cmp, /composer-autocomplete-empty/);
});

test('global.d.ts declares the required listSlashCommands API (v0.60 follow-up: main exposes slash:list)', () => {
  const dts = read(path.join(renderer, 'global.d.ts'));
  assert.match(dts, /listSlashCommands\(botId: string\)/);
  assert.doesNotMatch(dts, /listSlashCommands\?\(botId: string\)/);
});

test('i18n: every new chat.* key exists in both locales', () => {
  const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
  const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));
  const keys = [
    'chat.attachHint',
    'chat.attachmentMaxItems',
    'chat.attachmentTotalLimit',
    'chat.attachmentTruncated',
    'chat.dropFilesHere',
    'chat.fileNotReadable',
    'chat.imageAttachedNote',
    'chat.mentionDocsDesc',
    'chat.mentionFilesDesc',
    'chat.noSlashCommands',
    'chat.removeAttachment',
  ];
  for (const key of keys) {
    assert.ok(key in vi, `${key} missing in vi.json`);
    assert.ok(key in en, `${key} missing in en.json`);
    assert.ok(vi[key].trim().length > 0 && en[key].trim().length > 0);
  }
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keys) {
    assert.deepEqual(placeholders(vi[key]), placeholders(en[key]), `placeholders differ for ${key}`);
  }
});
