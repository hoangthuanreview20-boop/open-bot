/**
 * AG-UI renderer tests (v0.97, Team T3).
 *
 * - Every `agui.*` / `sidebar.activityFeed` key used by the new
 *   renderer files exists in all 6 locales with matching
 *   {placeholders} (mirrors the i18n test's contract, scoped to the
 *   AG-UI keys so a missing translation fails here first).
 * - No hard-coded Vietnamese in the new renderer files (comments
 *   included — the i18n test scans comments too) and no unsafe
 *   rendering primitive (`dangerouslySetInnerHTML`, `eval(`, innerHTML
 *   assignment) anywhere in them: generative-UI content is data only.
 * - The feed reducer never mutates its input and caps the feed.
 *
 * Run: node --test tests/agui-renderer-v097.test.mjs (no build needed
 * for the locale checks; the feed import needs no build either —
 * Node type-strips the .ts source).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendAgUiEventToFeed, AG_UI_FEED_CAP } from '../apps/desktop/src/renderer/components/agui/aguiFeed.ts';
import { makeAgUiEvent } from '../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const renderer = join(repo, 'apps/desktop/src/renderer');
const localesDir = join(renderer, 'i18n/locales');
const aguiDir = join(renderer, 'components/agui');

const LOCALES = ['en', 'vi', 'zh', 'ja', 'fr', 'es'];
const dicts = {};
for (const code of LOCALES) {
  dicts[code] = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}
const en = dicts.en;

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function aguiFiles() {
  return readdirSync(aguiDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => join(aguiDir, f));
}

test('agui renderer: every agui.* key used exists in all 6 locales', () => {
  const used = new Set();
  for (const file of aguiFiles()) {
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/(?<![A-Za-z0-9_])t\(\s*'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  }
  // Plus the sidebar key used from Sidebar.tsx.
  used.add('sidebar.activityFeed');
  assert.ok(used.size >= 30, `expected at least 30 AG-UI keys, found ${used.size}: ${[...used].join(', ')}`);
  for (const key of used) {
    assert.ok(key in en, `key ${key} is used by the renderer but missing from en.json`);
    for (const code of LOCALES) {
      assert.ok(key in dicts[code], `key ${key} missing from ${code}.json`);
      assert.deepEqual(
        placeholders(dicts[code][key]),
        placeholders(en[key]),
        `placeholders differ for ${key} in ${code}.json`,
      );
      assert.ok(dicts[code][key].trim().length > 0, `${code}.${key} must not be empty`);
    }
  }
});

test('agui renderer: no hard-coded Vietnamese in the new renderer files', () => {
  // Vietnamese diacritics range (à-ỹ, À-Ỹ + đ/Đ) — the same rule the
  // i18n test applies to App.tsx / components/*.tsx.
  const vietnamese = /[àáâãèéêìíòóôõùúýỳỹạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđĐ]/;
  const files = [...aguiFiles(), join(renderer, 'components/Sidebar.tsx'), join(renderer, 'App.tsx')];
  for (const file of files) {
    const src = readFileSync(file, 'utf-8');
    // Sidebar.tsx / App.tsx are pre-existing files: only the AG-UI
    // lines added in v0.97 must be clean (the rest is covered by the
    // i18n test already).
    const lines = src.split('\n');
    lines.forEach((line, index) => {
      if (/agui|AgUi|activityFeed/i.test(line)) {
        assert.ok(!vietnamese.test(line), `${file}:${index + 1} has Vietnamese in an AG-UI line: ${line.trim()}`);
      }
    });
    if (file.startsWith(aguiDir)) {
      assert.ok(!vietnamese.test(src), `${file} must not contain Vietnamese anywhere`);
    }
  }
});

test('agui renderer: generative UI never renders event content as HTML or code', () => {
  for (const file of aguiFiles()) {
    const src = readFileSync(file, 'utf-8');
    // Match real usage, not a mention inside a comment explaining
    // the sandbox (GenerativeUi.tsx names the forbidden primitive
    // in its header comment on purpose).
    assert.ok(!/dangerouslySetInnerHTML\s*[:=]/.test(src), `${file} must not use dangerouslySetInnerHTML`);
    assert.ok(!/\.innerHTML\s*=/.test(src), `${file} must not assign innerHTML`);
    assert.ok(!/\beval\s*\(/.test(src), `${file} must not use eval`);
    assert.ok(!/new Function\s*\(/.test(src), `${file} must not use new Function`);
  }
});

test('agui renderer: feed reducer never mutates input and caps the feed', () => {
  let items = [];
  const event = makeAgUiEvent('ACTIVITY', 'run-1', { kind: 'note', label: 'step' }, { botId: 'bot-1' });
  for (let i = 0; i < AG_UI_FEED_CAP + 50; i++) {
    const next = appendAgUiEventToFeed(items, { ...event, timestamp: new Date(Date.now() + i).toISOString(), sequence: i });
    assert.ok(items.length <= AG_UI_FEED_CAP, 'input list must not grow past the cap');
    assert.notEqual(next, items, 'reducer returns a new list');
    items = next;
  }
  assert.equal(items.length, AG_UI_FEED_CAP);
  // Run items are kept preferentially when the feed overflows.
  let withRun = appendAgUiEventToFeed([], makeAgUiEvent('RUN_STARTED', 'run-keep', { title: 'keep me' }, { botId: 'bot-1' }));
  for (let i = 0; i < AG_UI_FEED_CAP + 10; i++) {
    withRun = appendAgUiEventToFeed(withRun, { ...event, runId: `run-${i}`, timestamp: new Date(Date.now() + i).toISOString(), sequence: i });
  }
  assert.ok(withRun.some((item) => item.id === 'run:run-keep'), 'run items survive feed capping');
});
