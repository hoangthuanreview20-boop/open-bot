/**
 * Tests for v0.95 Đội D3 — local STT (packages/core/src/voice/localStt.ts):
 *
 *   1. MockLocalSttEngine returns scripted transcripts in order.
 *   2. WhisperCliSttEngine with no whisper installed (controlled
 *      env: empty PATH/HOME, no WHISPER_* overrides) reports
 *      unavailable with a clear reason, and transcribe() throws
 *      instead of guessing. v0.96 (Đội T5) built whisper.cpp into
 *      ~/tools, so the real machine IS available now — the
 *      "unavailable" case is tested with a scrubbed env, and a
 *      separate test asserts detectLocalStt() is self-consistent
 *      on whatever machine runs it.
 *   3. WhisperCliSttEngine with an injected runner + a fake binary
 *      and model on PATH/HOME transcribes via the temp-WAV path
 *      and reads the .txt back; a non-zero exit is a loud error.
 *   4. detectLocalStt() with no whisper installed reports
 *      unavailable, and on the real machine it is self-consistent
 *      (available iff a binary + model were found).
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

/**
 * Run `fn` with an environment where no whisper binary/model can be
 * found (empty PATH dir + empty HOME + no WHISPER_* overrides), so
 * the "unavailable" path is deterministic on any machine — including
 * this VM since v0.96 (Đội T5) built whisper.cpp into ~/tools.
 */
function withNoWhisperEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-stt-noenv-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  const prevBinary = process.env.WHISPER_BINARY;
  const prevModel = process.env.WHISPER_MODEL;
  process.env.PATH = binDir;
  process.env.HOME = tmp;
  delete process.env.WHISPER_BINARY;
  delete process.env.WHISPER_MODEL;
  try {
    return fn(tmp);
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevBinary === undefined) delete process.env.WHISPER_BINARY;
    else process.env.WHISPER_BINARY = prevBinary;
    if (prevModel === undefined) delete process.env.WHISPER_MODEL;
    else process.env.WHISPER_MODEL = prevModel;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('local-stt: WhisperCliSttEngine with no whisper installed is unavailable with a clear reason', async () => {
  await withNoWhisperEnv(async () => {
    const engine = new WhisperCliSttEngine();
    const status = engine.status();
    assert.equal(status.available, false);
    assert.equal(engine.isAvailable(), false);
    assert.match(status.reason ?? '', /whisper/i);
    await assert.rejects(engine.transcribe(SAMPLE), /local STT unavailable|No whisper/);
  });
});

test('local-stt: detectLocalStt() with no whisper installed reports unavailable', () => {
  withNoWhisperEnv(() => {
    const engine = detectLocalStt();
    assert.equal(engine.isAvailable(), false);
    assert.equal(engine.status().available, false);
  });
});

test('local-stt: detectLocalStt() on the real machine is self-consistent', () => {
  // On this VM (whisper.cpp built in v0.96) the engine is available;
  // on a machine without whisper it is not. Either way the status
  // must agree with isAvailable() and name a binary+model iff
  // available — so the test stays green on CI too.
  const engine = detectLocalStt();
  const status = engine.status();
  assert.equal(status.available, engine.isAvailable());
  if (status.available) {
    assert.equal(status.engineId, 'whisper-cli');
    assert.ok(status.binaryPath);
    assert.ok(status.modelPath);
  } else {
    assert.match(status.reason ?? '', /whisper/i);
  }
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
