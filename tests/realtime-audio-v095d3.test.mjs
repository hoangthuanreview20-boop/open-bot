/**
 * Tests for v0.95 Đội D3 — realtime audio plumbing
 * (packages/core/src/voice/audio.ts):
 *
 *   1. PCM16 helpers: RMS, resampling 16 kHz <-> 24 kHz, frame
 *      validation.
 *   2. Pcm16Chunker: small mic frames accumulate into 100 ms
 *      transport frames; leftovers flush at end of turn.
 *   3. LocalVad: energy-based speech start/end with hangover; mic
 *      level reflects RMS.
 *   4. MockAudioSource / MockAudioSink: scripted mic + recording
 *      speaker (barge-in flush accounting).
 *
 * No network, no sound card. Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/realtime-audio-v095d3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalVad,
  MockAudioSink,
  MockAudioSource,
  Pcm16Chunker,
  isValidPcm16Frame,
  pcm16Rms,
  resamplePcm16,
  silencePcm16Frame,
  sinePcm16Frame,
} from '../packages/core/dist/voice/audio.js';

const SAMPLES_100MS_16K = 1600;

// ---------------------------------------------------------------------------
// PCM16 helpers
// ---------------------------------------------------------------------------

test('audio: RMS is 0 for silence and ~0.14 for a 0.2-amplitude sine', () => {
  assert.equal(pcm16Rms(silencePcm16Frame(1600)), 0);
  const sine = sinePcm16Frame(1600, 0.2);
  const rms = pcm16Rms(sine);
  assert.ok(rms > 0.13 && rms < 0.15, `expected RMS ~0.141, got ${rms}`);
});

test('audio: frame validation rejects empty / odd / non-Uint8Array input', () => {
  assert.equal(isValidPcm16Frame(new Uint8Array([1, 2])), true);
  assert.equal(isValidPcm16Frame(new Uint8Array([])), false);
  assert.equal(isValidPcm16Frame(new Uint8Array([1, 2, 3])), false);
  assert.equal(isValidPcm16Frame('x'), false);
  assert.equal(isValidPcm16Frame(null), false);
});

test('audio: resample 16k -> 24k grows by 1.5x and back down restores length', () => {
  const frame = sinePcm16Frame(SAMPLES_100MS_16K, 0.2);
  const up = resamplePcm16(frame, 16000, 24000);
  assert.equal(up.length, 4800);
  const down = resamplePcm16(up, 24000, 16000);
  assert.equal(down.length, 3200);
  // Same-rate resample is a copy, not the same buffer.
  const same = resamplePcm16(frame, 16000, 16000);
  assert.equal(same.length, frame.length);
  assert.notEqual(same, frame);
  assert.deepEqual([...same], [...frame]);
  assert.throws(() => resamplePcm16(new Uint8Array([1]), 16000, 24000), /PCM16/);
  assert.throws(() => resamplePcm16(frame, 0, 24000), /sample rates/);
});

// ---------------------------------------------------------------------------
// Pcm16Chunker
// ---------------------------------------------------------------------------

test('audio: chunker accumulates 20 ms frames into 100 ms frames', () => {
  const chunker = new Pcm16Chunker(3200);
  const frame20ms = sinePcm16Frame(320, 0.2); // 20 ms @ 16 kHz = 640 bytes
  assert.deepEqual(chunker.push(frame20ms), []);
  assert.deepEqual(chunker.push(frame20ms), []);
  assert.deepEqual(chunker.push(frame20ms), []);
  assert.deepEqual(chunker.push(frame20ms), []);
  const out = chunker.push(frame20ms);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 3200);
  assert.equal(chunker.pendingBytes, 0);
});

test('audio: chunker flush returns the leftover partial frame', () => {
  const chunker = new Pcm16Chunker(3200);
  chunker.push(sinePcm16Frame(320, 0.2));
  const left = chunker.flush();
  assert.equal(left.length, 640);
  assert.equal(chunker.pendingBytes, 0);
  assert.equal(chunker.flush().length, 0);
  assert.throws(() => chunker.push(new Uint8Array([1])), /PCM16/);
  assert.throws(() => new Pcm16Chunker(0), /frameBytes/);
});

// ---------------------------------------------------------------------------
// LocalVad
// ---------------------------------------------------------------------------

test('audio: LocalVad fires speech start on speech and end after hangover silence', () => {
  const events = [];
  const vad = new LocalVad({
    threshold: 0.02,
    hangoverMs: 300,
    callbacks: {
      onSpeechStart: () => events.push('start'),
      onSpeechEnd: () => events.push('end'),
    },
  });
  // 500 ms silence: no events, not speaking.
  vad.feed(silencePcm16Frame(8000));
  assert.deepEqual(events, []);
  assert.equal(vad.isSpeaking(), false);
  // 200 ms speech: start fires once.
  vad.feed(sinePcm16Frame(3200, 0.2));
  assert.deepEqual(events, ['start']);
  assert.equal(vad.isSpeaking(), true);
  assert.ok(vad.level > 0.1, `expected mic level > 0.1, got ${vad.level}`);
  // 200 ms silence: still speaking (inside hangover).
  vad.feed(silencePcm16Frame(3200));
  assert.equal(vad.isSpeaking(), true);
  // 200 ms more silence (400 ms total): hangover expires -> end.
  vad.feed(silencePcm16Frame(3200));
  assert.deepEqual(events, ['start', 'end']);
  assert.equal(vad.isSpeaking(), false);
});

test('audio: LocalVad ignores short pauses inside a sentence (hangover)', () => {
  const events = [];
  const vad = new LocalVad({
    threshold: 0.02,
    hangoverMs: 300,
    callbacks: {
      onSpeechStart: () => events.push('start'),
      onSpeechEnd: () => events.push('end'),
    },
  });
  vad.feed(sinePcm16Frame(1600, 0.2));
  vad.feed(silencePcm16Frame(1600)); // 100 ms pause
  vad.feed(sinePcm16Frame(1600, 0.2));
  assert.deepEqual(events, ['start']);
  assert.equal(vad.isSpeaking(), true);
});

test('audio: LocalVad reset clears speech state', () => {
  const vad = new LocalVad({ threshold: 0.02 });
  vad.feed(sinePcm16Frame(1600, 0.2));
  assert.equal(vad.isSpeaking(), true);
  vad.reset();
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.level, 0);
  assert.throws(() => vad.feed(new Uint8Array([1])), /PCM16/);
});

// ---------------------------------------------------------------------------
// Mock source / sink
// ---------------------------------------------------------------------------

test('audio: MockAudioSource pumps the scripted speech/silence pattern', () => {
  const src = new MockAudioSource([
    { speech: true, frames: 2 },
    { speech: false, frames: 1 },
  ]);
  const f1 = src.pump();
  const f2 = src.pump();
  const f3 = src.pump();
  const f4 = src.pump(); // past the script: silence
  assert.ok(pcm16Rms(f1) > 0.1);
  assert.ok(pcm16Rms(f2) > 0.1);
  assert.equal(pcm16Rms(f3), 0);
  assert.equal(pcm16Rms(f4), 0);
  assert.equal(src.emittedFrames, 4);
  src.stop();
});

test('audio: MockAudioSink records frames and accounts barge-in flushes', () => {
  const sink = new MockAudioSink(24000);
  const frame = sinePcm16Frame(1600, 0.2);
  sink.play(frame);
  sink.play(frame);
  assert.equal(sink.queuedBytes, frame.length * 2);
  assert.equal(sink.totalBytes, frame.length * 2);
  assert.equal(sink.clears, 0);
  sink.clear();
  assert.equal(sink.queuedBytes, 0);
  assert.equal(sink.clears, 1);
  assert.equal(sink.flushedBytes, frame.length * 2);
  assert.equal(sink.totalBytes, frame.length * 2); // total is not rewound
  assert.throws(() => sink.play(new Uint8Array([1])), /PCM16/);
});
