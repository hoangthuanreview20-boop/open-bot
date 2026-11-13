/**
 * Tests for v0.95 Đội D3 — local STT (packages/core/src/voice/localStt.ts):
 *
 *   1. MockLocalSttEngine returns scripted transcripts in order.
 *   2. WhisperCliSttEngine on this machine reports unavailable
 *      (no whisper binary, no model) with a clear reason, and
 *      transcribe() throws instead of guessing.
 *   3. WhisperCliSttEngine with an injected runner + a fake binary
 *      and model on PATH/HOME transcribes via the temp-WAV path
 *      and reads the .txt back; a non-zero exit is a loud error.
 *   4. detectLocalStt() reflects the real machine state.
 *
 * No network, no real whisper binary. Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/local-stt-v095d3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MockLocalSttEngine,
  WhisperCliSttEngine,
  detectLocalStt,
} from '../packages/core/dist/voice/localStt.js';
import { sinePcm16Frame } from '../packages/core/dist/voice/audio.js';

const SAMPLE = sinePcm16Frame(1600, 0.2);

test('local-stt: MockLocalSttEngine returns scripted lines in order', async () => {
  const engine = new MockLocalSttEngine(['xin chào', 'tôi cần giúp']);
  assert.equal(engine.isAvailable(), true);
  assert.equal(engine.status().available, true);
  assert.equal(await engine.transcribe(SAMPLE), 'xin chào');
  assert.equal(await engine.transcribe(SAMPLE), 'tôi cần giúp');
  // Last line repeats.
  assert.equal(await engine.transcribe(SAMPLE), 'tôi cần giúp');
  assert.equal(engine.calls.length, 3);
  await assert.rejects(engine.transcribe(new Uint8Array(0)), /non-empty/);
});

test('local-stt: WhisperCliSttEngine on this VM is unavailable with a clear reason', async () => {
  // This VM has espeak-ng + ffmpeg but no whisper binary/model.
  const engine = new WhisperCliSttEngine();
  const status = engine.status();
  assert.equal(status.available, false);
  assert.equal(engine.isAvailable(), false);
  assert.match(status.reason ?? '', /whisper/i);
  await assert.rejects(engine.transcribe(SAMPLE), /local STT unavailable|No whisper/);
});

test('local-stt: detectLocalStt() reflects the real machine (unavailable here)', () => {
  const engine = detectLocalStt();
  assert.equal(engine.isAvailable(), false);
  assert.equal(engine.status().available, false);
});

/** Fake whisper runner: writes the transcript file the CLI would produce. */
function fakeRunner(text) {
  return async (binaryPath, args) => {
    const ofIndex = args.indexOf('-of');
    assert.notEqual(ofIndex, -1, 'runner expected -of <prefix> in argv');
    const outPrefix = args[ofIndex + 1];
    assert.ok(args.includes('-m'), 'runner expected -m <model> in argv');
    assert.ok(args.includes('-f'), 'runner expected -f <wav> in argv');
    fs.writeFileSync(`${outPrefix}.txt`, `${text}\n`);
    return { stdout: '', stderr: '', code: 0 };
  };
}

test('local-stt: WhisperCliSttEngine transcribes via temp WAV + .txt with an injected runner', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-stt-test-'));
  const binDir = path.join(tmp, 'bin');
  const modelDir = path.join(tmp, '.cache', 'whisper');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'whisper-cpp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(modelDir, 'ggml-base.en.bin'), 'fake-model');
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  try {
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
    process.env.HOME = tmp;
    const engine = new WhisperCliSttEngine({ runner: fakeRunner('xin chào open-bot') });
    assert.equal(engine.isAvailable(), true);
    assert.equal(engine.status().engineId, 'whisper-cli');
    assert.equal(await engine.transcribe(SAMPLE, { language: 'vi' }), 'xin chào open-bot');
    await assert.rejects(engine.transcribe(new Uint8Array([1])), /PCM16/);
    const tooBig = new Uint8Array(26 * 1024 * 1024);
    await assert.rejects(engine.transcribe(tooBig), /too large/);
  } finally {
    process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('local-stt: WhisperCliSttEngine fails loudly on a non-zero whisper exit', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-stt-test-'));
  const binDir = path.join(tmp, 'bin');
  const modelDir = path.join(tmp, '.cache', 'whisper');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'whisper-cpp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(modelDir, 'ggml-base.en.bin'), 'fake-model');
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  try {
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
    process.env.HOME = tmp;
    const failingRunner = async () => ({ stdout: '', stderr: 'model load failed', code: 1 });
    const engine = new WhisperCliSttEngine({ runner: failingRunner });
    await assert.rejects(engine.transcribe(SAMPLE), /exited with code 1/);
  } finally {
    process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
