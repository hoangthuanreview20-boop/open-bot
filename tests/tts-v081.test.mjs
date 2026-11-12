/**
 * Core tests for v0.81 — TTS harness (local-first).
 *
 *   - MockTtsEngine records utterances (markdown stripped).
 *   - TtsHarness picks the first available engine; with no engine it
 *     returns { spoken: false, reason: 'no-engine-available' } and
 *     never throws.
 *   - SystemTtsEngine speaks through a REAL spawned binary: a fake
 *     `espeak-ng` script on PATH proves the argv-only spawn path.
 *   - stripMarkdownForSpeech removes fences/links/bold/headings.
 *   - Empty text and >5000-char text behave (empty-text / truncate).
 *
 * Machine fact: this dev machine has no real TTS engine, so the
 * "system engine here" test asserts the honest no-engine result —
 * it adapts to the machine instead of hard-coding it, so it stays
 * green on a machine that does have eSpeak installed.
 *
 * Run: npm run build --workspace=@open-bot/core && node --test tests/tts-v081.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MockTtsEngine,
  SystemTtsEngine,
  TtsHarness,
  stripMarkdownForSpeech,
  TTS_MAX_CHARS,
} from '../packages/core/dist/index.js';

test('stripMarkdownForSpeech: fences, links, bold, headings become prose', () => {
  const out = stripMarkdownForSpeech(
    '# Title\n\nHello **world**, see [docs](https://example.com).\n\n```js\nconst x = 1;\n```\n\n- item `code`',
  );
  assert.equal(out.includes('```'), false, 'no fence markers');
  assert.equal(out.includes('**'), false, 'no bold markers');
  assert.equal(out.includes('#'), false, 'no heading markers');
  assert.equal(out.includes('https://example.com'), false, 'no link URL');
  assert.equal(out.includes('const x = 1'), false, 'code block dropped');
  assert.equal(out.includes('Title'), true, 'heading text kept');
  assert.equal(out.includes('Hello world, see docs.'), true, 'prose kept');
  assert.equal(out.includes('item code'), true, 'list item + inline code kept');
});

test('MockTtsEngine records the stripped utterance and reports spoken', async () => {
  const mock = new MockTtsEngine();
  const res = await mock.speak('Hello **there**');
  assert.equal(res.spoken, true);
  assert.equal(res.engineId, 'mock');
  assert.equal(mock.utterances.length, 1);
  assert.equal(mock.utterances[0].text, 'Hello there');
});

test('TtsHarness: mock speaks; empty text is empty-text; long text truncates', async () => {
  const mock = new MockTtsEngine();
  const harness = new TtsHarness([mock]);
  const res = await harness.speak('Hi there');
  assert.equal(res.spoken, true);
  assert.equal(res.engineId, 'mock');

  const empty = await harness.speak('   ');
  assert.deepEqual(empty, { spoken: false, engineId: null, reason: 'empty-text' });

  const long = await harness.speak('x'.repeat(TTS_MAX_CHARS + 1000));
  assert.equal(long.spoken, true);
  assert.equal(mock.utterances[mock.utterances.length - 1].text.length, TTS_MAX_CHARS);
});

test('TtsHarness: no available engine -> no-engine-available, never throws', async () => {
  const dead = {
    id: 'dead',
    name: 'Dead',
    kind: 'system',
    isAvailable: async () => false,
    speak: async () => {
      throw new Error('should never be called');
    },
  };
  const harness = new TtsHarness([dead]);
  const res = await harness.speak('hello');
  assert.deepEqual(res, { spoken: false, engineId: null, reason: 'no-engine-available' });
  const status = await harness.status();
  assert.equal(status.available, false);
  assert.equal(status.engineId, null);
  assert.equal(status.engines[0].available, false);
});

test('TtsHarness: skips an unavailable engine and uses the next one', async () => {
  const dead = {
    id: 'dead',
    name: 'Dead',
    kind: 'system',
    isAvailable: async () => false,
    speak: async () => ({ spoken: false, engineId: 'dead' }),
  };
  const mock = new MockTtsEngine();
  const harness = new TtsHarness([dead, mock]);
  const res = await harness.speak('hello');
  assert.equal(res.spoken, true);
  assert.equal(res.engineId, 'mock');
  const status = await harness.status();
  assert.equal(status.available, true);
  assert.equal(status.engineId, 'mock');
});

test('SystemTtsEngine: speaks through a real spawned fake espeak-ng on PATH', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tts-v081-'));
  try {
    const logFile = path.join(tmpDir, 'calls.log');
    const fakeBin = path.join(tmpDir, 'espeak-ng');
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
      { mode: 0o755 },
    );
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath}`;
    try {
      const engine = new SystemTtsEngine();
      assert.equal(await engine.isAvailable(), true, 'fake espeak-ng detected on PATH');
      assert.equal(engine.id, 'espeak-ng');
      const res = await engine.speak('Hello **world**');
      assert.equal(res.spoken, true);
      assert.equal(res.engineId, 'espeak-ng');
      const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(calls.length, 1, 'fake binary called exactly once');
      assert.deepEqual(calls[0], ['Hello world'], 'argv is the stripped text, no shell');
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SystemTtsEngine on this machine: honest result (no engine installed)', async () => {
  const engine = new SystemTtsEngine();
  const available = await engine.isAvailable();
  const harness = new TtsHarness([engine]);
  const res = await harness.speak('hello');
  if (available) {
    // A machine with eSpeak really speaks; only the engine id is asserted.
    assert.equal(res.engineId, engine.id);
  } else {
    assert.deepEqual(res, { spoken: false, engineId: null, reason: 'no-engine-available' });
    const status = await harness.status();
    assert.equal(status.available, false);
  }
});
