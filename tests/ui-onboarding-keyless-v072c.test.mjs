/**
 * Onboarding keyless model paths (v0.72c, Team C).
 *
 * The first-run screen must show the ways to run WITHOUT an API key
 * (an AI agent already logged in on this machine; a local model via
 * Ollama) BEFORE the API-key path. Covered here (no Electron needed):
 *   - the pure rules in onboarding.ts: three paths, keyless first,
 *     requiresKey flags, fresh copies on every call;
 *   - i18n: the path keys exist and are non-empty in both vi and en;
 *   - wiring (static): OnboardingView renders the paths list from the
 *     helper, and styles.css carries the airy list styles.
 *
 * Run: node --test tests/ui-onboarding-keyless-v072c.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ONBOARDING_MODEL_PATHS,
  keylessModelPaths,
  onboardingModelPaths,
} from '../apps/desktop/src/renderer/components/onboarding.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (p) => readFileSync(p, 'utf-8');

const PATH_KEYS = [
  'onboarding.keylessTitle',
  'onboarding.pathCliTitle',
  'onboarding.pathCliText',
  'onboarding.pathOllamaTitle',
  'onboarding.pathOllamaText',
  'onboarding.pathKeyTitle',
  'onboarding.pathKeyText',
];

test('keyless paths: three paths, keyless first, key path last', () => {
  const paths = onboardingModelPaths();
  assert.deepEqual(
    paths.map((p) => p.id),
    ['cli', 'ollama', 'key'],
    'display order must be cli, ollama, then key',
  );
  assert.deepEqual(
    paths.map((p) => p.requiresKey),
    [false, false, true],
    'only the key path requires an API key',
  );
  for (const p of paths) {
    assert.equal(typeof p.titleKey, 'string');
    assert.equal(typeof p.textKey, 'string');
    assert.ok(p.titleKey.startsWith('onboarding.path'));
    assert.ok(p.textKey.startsWith('onboarding.path'));
    assert.ok(PATH_KEYS.includes(p.titleKey), `${p.titleKey} must be a known key`);
    assert.ok(PATH_KEYS.includes(p.textKey), `${p.textKey} must be a known key`);
  }
  assert.equal(ONBOARDING_MODEL_PATHS.length, 3);
});

test('keyless paths: keylessModelPaths returns only the no-key paths', () => {
  const keyless = keylessModelPaths();
  assert.deepEqual(
    keyless.map((p) => p.id),
    ['cli', 'ollama'],
  );
  assert.ok(keyless.every((p) => p.requiresKey === false));
});

test('keyless paths: callers get fresh copies (mutating one call changes nothing)', () => {
  const first = onboardingModelPaths();
  first[0].titleKey = 'mutated';
  first.push({ id: 'key', titleKey: 'x', textKey: 'y', requiresKey: true });
  const second = onboardingModelPaths();
  assert.equal(second.length, 3);
  assert.equal(second[0].titleKey, 'onboarding.pathCliTitle');
  assert.deepEqual(ONBOARDING_MODEL_PATHS.length, 3);
});

test('keyless paths: i18n keys exist and are non-empty in vi and en', () => {
  for (const code of ['vi', 'en']) {
    const dict = JSON.parse(
      read(join(repo, 'apps/desktop/src/renderer/i18n/locales', `${code}.json`)),
    );
    for (const key of PATH_KEYS) {
      assert.equal(typeof dict[key], 'string', `${code} missing ${key}`);
      assert.ok(dict[key].length > 0, `${code} empty ${key}`);
    }
  }
});

test('keyless paths: OnboardingView renders the paths list from the helper', () => {
  const view = read(join(repo, 'apps/desktop/src/renderer/components/OnboardingView.tsx'));
  assert.match(view, /import \{ onboardingModelPaths \} from '\.\/onboarding'/);
  assert.match(view, /onboardingModelPaths\(\)\.map\(\(p\) =>/);
  assert.match(view, /t\('onboarding\.keylessTitle'\)/);
  assert.match(view, /t\(p\.titleKey\)/);
  assert.match(view, /t\(p\.textKey\)/);
  const css = read(join(repo, 'apps/desktop/src/renderer/styles.css'));
  assert.match(css, /\.onboarding-paths \{/);
  assert.match(css, /\.onboarding-keyless \{/);
});
