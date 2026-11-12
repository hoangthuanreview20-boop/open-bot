/**
 * Core tests for v0.82 — TTS voice/speed selection (follow-up 3c).
 *
 *   - rateToWpm / rateToSpdSay map a rate multiplier to engine units
 *     (eSpeak 175 wpm default, clamped 80–450; spd-say -100..100).
 *   - parseEspeakVoices parses `espeak-ng --voices` output.
 *   - SystemTtsEngine honours { voice, rate, lang } in argv through a
 *     REAL spawned fake espeak-ng on PATH (voice wins over lang;
 *     an invalid voice id is ignored, never passed through).
 *   - listVoices() returns the fake engine's parsed voices, [] on a
 *     failing engine, and the real machine's voices when eSpeak is
 *     really installed (adaptive — this machine has espeak-ng 1.51
 *     since 2026-11-11, so the live branch runs here).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/tts-voice-v082.test.mjs
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
  parseEspeakVoices,
  rateToSpdSay,
  rateToWpm,
} from '../packages/core/dist/voice/tts.js';

test('rateToWpm: 1 -> 175, scales, clamps 80..450', () => {
  assert.equal(rateToWpm(1), 175);
  assert.equal(rateToWpm(1.25), 219);
  assert.equal(rateToWpm(0.5), 88);
  assert.equal(rateToWpm(2), 350);
  assert.equal(rateToWpm(0), 80);
  assert.equal(rateToWpm(10), 450);
  assert.equal(rateToWpm(undefined), 175);
  assert.equal(rateToWpm(Number.NaN), 175);
});

test('rateToSpdSay: 1 -> 0, scales, clamps -100..100', () => {
  assert.equal(rateToSpdSay(1), 0);
  assert.equal(rateToSpdSay(1.5), 50);
  assert.equal(rateToSpdSay(0.5), -50);
  assert.equal(rateToSpdSay(0), -100);
  assert.equal(rateToSpdSay(3), 100);
  assert.equal(rateToSpdSay(undefined), 0);
});

test('parseEspeakVoices: parses --voices table, dedupes, header ignored', () => {
  const sample = [
    'Pty Language       Age/Gender VoiceName          File                 Other Languages',
    ' 5  vi              --/M      Vietnamese_(Northern) aav/vi               ',
    ' 5  vi-vn-x-south   --/M      Vietnamese_(Southern) aav/vi-VN-x-south    ',
    ' 5  en              --/M      English_(Great_Britain) gmw/en-GB          ',
    ' 5  vi              --/M      Vietnamese_(Northern) aav/vi               ',
    'garbage line without columns',
    '',
  ].join('\n');
  assert.deepEqual(parseEspeakVoices(sample), [
    { id: 'vi', name: 'Vietnamese (Northern)', lang: 'vi' },
    { id: 'vi-vn-x-south', name: 'Vietnamese (Southern)', lang: 'vi' },
    { id: 'en', name: 'English (Great Britain)', lang: 'en' },
  ]);
  assert.deepEqual(parseEspeakVoices(''), []);
  assert.deepEqual(parseEspeakVoices('Pty Language Age/Gender VoiceName File\n'), []);
});

/**
 * Fake espeak-ng: logs speak argv to calls.log; answers --voices with
 * a canned table (exit 1 for --voices=zz to simulate a bad filter).
 */
function writeFakeEspeakNg(tmpDir) {
  const logFile = path.join(tmpDir, 'calls.log');
  const fakeBin = path.join(tmpDir, 'espeak-ng');
  fs.writeFileSync(
    fakeBin,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const logFile = ${JSON.stringify(logFile)};`,
      'const args = process.argv.slice(2);',
      "if (args[0] && args[0].startsWith('--voices')) {",
      "  if (args[0] === '--voices=zz') process.exit(1);",
      '  process.stdout.write(',
      "    'Pty Language Age/Gender VoiceName File\\n' +",
      "    ' 5  vi --/M Vietnamese_(Northern) aav/vi\\n' +",
      "    ' 5  vi-vn-x-south --/M Vietnamese_(Southern) aav/vi-VN-x-south\\n' +",
      "    ' 5  en --/M English_(Great_Britain) gmw/en-GB\\n');",
      '  process.exit(0);',
      '}',
      "fs.appendFileSync(logFile, JSON.stringify(args) + '\\n');",
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { fakeBin, logFile };
}

function readCalls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('SystemTtsEngine: voice wins over lang, rate -> -s wpm (fake binary)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tts-v082-'));
  try {
    const { logFile } = writeFakeEspeakNg(tmpDir);
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath}`;
    try {
      const engine = new SystemTtsEngine();
      assert.equal(engine.id, 'espeak-ng');
      assert.equal((await engine.speak('Hello', { voice: 'vi-vn-x-south', rate: 1.25 })).spoken, true);
      assert.equal((await engine.speak('Hello', { lang: 'vi' })).spoken, true);
      assert.equal((await engine.speak('Hello', { voice: 'vi', lang: 'en' })).spoken, true);
      assert.equal((await engine.speak('Hello', { rate: 0 })).spoken, true);
      // Invalid voice id is ignored (never passed to the binary) and
      // lang still applies — argv must contain no ';' or shell bits.
      assert.equal((await engine.speak('Hello', { voice: 'vi; rm -rf /', lang: 'en' })).spoken, true);
      const calls = readCalls(logFile);
      assert.equal(calls.length, 5);
      assert.deepEqual(calls[0], ['-v', 'vi-vn-x-south', '-s', '219', 'Hello']);
      assert.deepEqual(calls[1], ['-v', 'vi', 'Hello']);
      assert.deepEqual(calls[2], ['-v', 'vi', 'Hello']);
      assert.deepEqual(calls[3], ['-s', '80', 'Hello']);
      assert.deepEqual(calls[4], ['-v', 'en', 'Hello']);
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SystemTtsEngine.listVoices: parses fake --voices, [] on failure', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tts-v082-'));
  try {
    writeFakeEspeakNg(tmpDir);
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath}`;
    try {
      const engine = new SystemTtsEngine();
      assert.deepEqual(await engine.listVoices(), [
        { id: 'vi', name: 'Vietnamese (Northern)', lang: 'vi' },
        { id: 'vi-vn-x-south', name: 'Vietnamese (Southern)', lang: 'vi' },
        { id: 'en', name: 'English (Great Britain)', lang: 'en' },
      ]);
      // A failing filter yields [] instead of throwing.
      assert.deepEqual(await engine.listVoices('zz'), []);
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TtsHarness.listVoices: delegates to the engine; mock-only -> []', async () => {
  const mock = new MockTtsEngine();
  assert.deepEqual(await new TtsHarness([mock]).listVoices(), []);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tts-v082-'));
  try {
    writeFakeEspeakNg(tmpDir);
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath}`;
    try {
      const voices = await new TtsHarness().listVoices();
      assert.equal(voices.length, 3);
      assert.equal(voices[0].id, 'vi');
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SystemTtsEngine on this machine: real espeak-ng voices + voice speak (adaptive)', async () => {
  const engine = new SystemTtsEngine();
  if (!(await engine.isAvailable()) || engine.id !== 'espeak-ng') {
    // Machine without eSpeak: the harness must stay honest.
    assert.deepEqual(await engine.listVoices(), []);
    return;
  }
  const voices = await engine.listVoices();
  assert.ok(voices.length > 0, 'real espeak-ng must list at least one voice');
  assert.ok(
    voices.some((v) => v.id === 'vi'),
    `real voice list must include vi, got ${voices.map((v) => v.id).slice(0, 5).join(',')}`,
  );
  const res = await engine.speak('Xin chào', { voice: 'vi-vn-x-south', rate: 1.25 });
  assert.equal(res.spoken, true, 'real speak with voice+rate must report spoken:true');
  assert.equal(res.engineId, 'espeak-ng');
});
