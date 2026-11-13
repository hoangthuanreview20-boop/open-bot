/**
 * i18n tests for open-bot desktop (node:test, no Electron needed).
 *
 * Covers:
 *  - every locale file has exactly the same keys as en.json, with
 *    non-empty values and matching {placeholders}
 *  - the real translator module (imported from the TS source via Node's
 *    type stripping): current-locale lookup, interpolation, and the
 *    fallback chain current -> 'en' -> key itself (never undefined/crash)
 *  - no hard-coded Vietnamese display strings left in App.tsx, main.tsx
 *    or components/*.tsx (Vietnamese lives only in locales/vi.json)
 *  - every key used by the renderer exists in every locale, and every
 *    locale file on disk is registered in LOCALES (adding a language =
 *    one JSON file + one LOCALES entry)
 *  - locale wiring in main process / renderer types (settings:get returns
 *    locale, settings:set accepts it, SettingsView type carries it)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  LOCALES,
  getLocale,
  interpolate,
  lookup,
  normalizeLocale,
  setLocale,
  t,
  tFor,
} from '../apps/desktop/src/renderer/i18n/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const renderer = join(repo, 'apps/desktop/src/renderer');
const localesDir = join(renderer, 'i18n/locales');

// One dict per registered locale (v0.72c: vi, en, zh, ja, es, fr).
const dicts = {};
for (const { code } of LOCALES) {
  dicts[code] = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}
const vi = dicts.vi;
const en = dicts.en;

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function rendererFiles() {
  const components = readdirSync(join(renderer, 'components'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(renderer, 'components', f));
  return [join(renderer, 'App.tsx'), join(renderer, 'main.tsx'), ...components];
}

/** Keys the renderer asks for, including dynamic `t(p.labelKey)` lookups. */
function usedKeys() {
  const used = new Set();
  for (const file of rendererFiles()) {
    const src = readFileSync(file, 'utf-8');
    // v0.95 (merge): negative lookbehind so `document.createElement('a')`
    // is not misread as a `t('a')` call — the tail "Element('a')" matches
    // /t\(\s*'...'/ without it (MemoryView.tsx:135). A real `t(` call is
    // never preceded by an identifier character.
    for (const m of src.matchAll(/(?<![A-Za-z0-9_])t\(\s*'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/(?<![A-Za-z0-9_])t\(\s*"([A-Za-z0-9_.]+)"/g)) used.add(m[1]);
    // Provider labels are looked up via t(meta.labelKey) — collect the
    // labelKey values declared in PROVIDER_META the same way.
    for (const m of src.matchAll(/labelKey:\s*'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  }
  // TaskPanel builds the key dynamically: t(`task.status.${task.status}`).
  for (const status of ['pending', 'running', 'done', 'failed']) {
    used.add(`task.status.${status}`);
  }
  // PlanView builds keys dynamically too (v0.96): t(`planner.status.${step.status}`)
  // and t(`planner.suggestion.${suggestion}`).
  for (const status of ['pending', 'running', 'done', 'failed', 'skipped']) {
    used.add(`planner.status.${status}`);
  }
  for (const suggestion of ['try-different-tool', 'ask-user', 'skip-step', 'replan']) {
    used.add(`planner.suggestion.${suggestion}`);
  }
  return used;
}

test('locale files: every locale has exactly the same keys as en', () => {
  const enKeys = Object.keys(en).sort();
  assert.ok(enKeys.length > 0, 'locales must not be empty');
  for (const { code } of LOCALES) {
    const keys = Object.keys(dicts[code]).sort();
    assert.deepEqual(keys, enKeys, `${code}.json keys must match en.json`);
  }
});

test('locale files: every value is a non-empty string', () => {
  for (const { code } of LOCALES) {
    for (const [key, value] of Object.entries(dicts[code])) {
      assert.equal(typeof value, 'string', `${code}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${code}.${key} must not be empty`);
    }
  }
});

test('locale files: {placeholders} match en for every key in every locale', () => {
  for (const { code } of LOCALES) {
    if (code === 'en') continue;
    for (const key of Object.keys(en)) {
      assert.deepEqual(
        placeholders(dicts[code][key]),
        placeholders(en[key]),
        `placeholders differ for ${key}: ${code}=${JSON.stringify(placeholders(dicts[code][key]))} en=${JSON.stringify(placeholders(en[key]))}`,
      );
    }
  }
});

test('locale files on disk are registered in LOCALES (and vice versa)', () => {
  const files = readdirSync(localesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  const registered = LOCALES.map((l) => l.code).sort();
  assert.deepEqual(registered, files, 'every locales/*.json must have a LOCALES entry');
  assert.ok(LOCALES.every((l) => typeof l.label === 'string' && l.label.length > 0));
  assert.equal(DEFAULT_LOCALE, 'vi');
  assert.equal(FALLBACK_LOCALE, 'en');
});

test('t(): current locale, interpolation, and locale switching', () => {
  setLocale('vi');
  assert.equal(getLocale(), 'vi');
  assert.equal(t('chat.send'), 'Gửi');
  assert.equal(t('chat.emptyGreeting', { name: 'Trợ lý' }), 'Chưa có tin nhắn nào. Hãy chào Trợ lý nhé!');
  assert.equal(t('common.error', { message: 'X' }), '❌ Lỗi: X');
  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(t('chat.send'), 'Send');
  assert.equal(t('chat.emptyGreeting', { name: 'Assistant' }), 'No messages yet. Say hello to Assistant!');
  setLocale('vi');
});

test('tFor(): per-locale lookup without touching global state', () => {
  setLocale('vi');
  assert.equal(tFor('en', 'chat.send'), 'Send');
  assert.equal(tFor('vi', 'chat.send'), 'Gửi');
  assert.equal(getLocale(), 'vi', 'tFor must not change the current locale');
});

test('fallback: missing in current locale -> en -> the key itself, never undefined', () => {
  // Synthetic dictionaries exercise the real lookup() used by t()/tFor().
  const dicts = { vi: { onlyVi: 'chỉ có vi' }, en: { onlyEn: 'only en', onlyVi: 'vi key in en' } };
  assert.equal(lookup(dicts, 'vi', 'onlyEn'), 'only en', 'falls back to en');
  assert.equal(lookup(dicts, 'en', 'onlyVi'), 'vi key in en');
  assert.equal(lookup(dicts, 'vi', 'no.such.key'), 'no.such.key', 'falls back to the key itself');
  assert.equal(lookup(dicts, 'fr', 'onlyEn'), 'only en', 'unknown locale falls back through en');
  assert.equal(lookup(dicts, 'vi', 'no.such.key', { name: 'x' }), 'no.such.key');
  // Against the real dictionaries: an unknown key returns the key, not undefined.
  assert.equal(t('definitely.not.a.key'), 'definitely.not.a.key');
  assert.equal(tFor('en', 'definitely.not.a.key'), 'definitely.not.a.key');
});

test('interpolate(): unknown placeholders are left intact', () => {
  assert.equal(interpolate('Hello {name}, {missing}!', { name: 'An' }), 'Hello An, {missing}!');
  assert.equal(interpolate('No vars here'), 'No vars here');
});

test('normalizeLocale(): unknown/empty codes become the default', () => {
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('vi'), 'vi');
  assert.equal(normalizeLocale('zh'), 'zh');
  assert.equal(normalizeLocale('ja'), 'ja');
  assert.equal(normalizeLocale('es'), 'es');
  assert.equal(normalizeLocale('fr'), 'fr');
  assert.equal(normalizeLocale('de'), 'vi');
  assert.equal(normalizeLocale(''), 'vi');
  assert.equal(normalizeLocale(undefined), 'vi');
  assert.equal(setLocale('de'), 'vi', 'setLocale rejects unknown codes');
  setLocale('vi');
});

test('no hard-coded Vietnamese display strings in renderer components', () => {
  // Vietnamese-specific diacritics. Proper names ("Open Bot") and provider
  // names are ASCII and allowed; every Vietnamese string must live in
  // locales/vi.json instead.
  const vietnamese = /[À-ỹđĐ]/;
  for (const file of rendererFiles()) {
    const src = readFileSync(file, 'utf-8');
    for (const [i, line] of src.split('\n').entries()) {
      assert.ok(!vietnamese.test(line), `${file}:${i + 1} still has hard-coded Vietnamese: ${line.trim()}`);
    }
  }
});

test('every key the renderer uses exists in every locale', () => {
  const used = usedKeys();
  assert.ok(used.size > 50, `expected many used keys, found ${used.size}`);
  for (const key of used) {
    for (const { code } of LOCALES) {
      assert.ok(key in dicts[code], `key ${key} is used but missing in ${code}.json`);
    }
  }
});

test('tFor(): the new locales translate real keys (no silent fallback to en)', () => {
  // chat.send must resolve to a real translated string in every locale,
  // not the key itself (fallback) and not the English text.
  for (const code of ['zh', 'ja', 'es', 'fr']) {
    const value = tFor(code, 'chat.send');
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0, `${code} chat.send must not be empty`);
    assert.notEqual(value, 'chat.send', `${code} chat.send must not fall back to the key`);
    assert.notEqual(value, 'Send', `${code} chat.send must not fall back to English`);
  }
  // And every locale keeps its own onboarding path strings.
  for (const code of ['zh', 'ja', 'es', 'fr']) {
    assert.notEqual(tFor(code, 'onboarding.pathCliTitle'), 'onboarding.pathCliTitle');
    assert.notEqual(tFor(code, 'onboarding.pathOllamaTitle'), 'onboarding.pathOllamaTitle');
  }
});

test('locale is wired through main settings and renderer types', () => {
  const main = readFileSync(join(repo, 'apps/desktop/src/main/main.ts'), 'utf-8');
  assert.match(main, /locale:\s*AppLocale/, 'AppSettings must carry locale');
  assert.match(
    main,
    /locale:\s*isAppLocale\(parsed\.locale\) \? parsed\.locale : 'vi'/,
    'loadSettings must default unknown locale to vi',
  );
  assert.match(main, /if \(isAppLocale\(patch\.locale\)\)/, 'settings:set must accept locale');
  assert.match(main, /locale: settings\.locale/, 'settings:get must return locale');

  const types = readFileSync(join(renderer, 'types.ts'), 'utf-8');
  assert.match(types, /locale: string/, 'SettingsView type must carry locale');

  const globalDts = readFileSync(join(renderer, 'global.d.ts'), 'utf-8');
  assert.match(globalDts, /locale\?: string/, 'setSettings patch type must accept locale');

  const settingsView = readFileSync(join(renderer, 'components/SettingsView.tsx'), 'utf-8');
  // UI-4: the language section lives in the General tab component, while
  // the locale change handler (setSettings) stays in SettingsView.
  const generalTab = readFileSync(join(renderer, 'components/SettingsGeneralTab.tsx'), 'utf-8');
  assert.ok(generalTab.includes('settings.languageTitle'), 'Settings General tab must have a language section');
  assert.ok(generalTab.includes('LOCALES'), 'language picker must come from LOCALES');
  assert.ok(settingsView.includes("setSettings({ locale: code })"), 'changing language must persist via setSettings');

  const app = readFileSync(join(renderer, 'App.tsx'), 'utf-8');
  assert.ok(app.includes('getSettings'), 'App must load saved settings at startup');
  assert.ok(app.includes('setLocale(s.locale)'), 'App must apply the saved locale at startup');
});
