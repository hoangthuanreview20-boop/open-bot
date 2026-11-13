/**
 * Tests cho v0.96 — voice live (Đội T5).
 *
 *   1. Transport health (packages/core/src/voice/transportHealth.ts):
 *      LatencyStats (min/max/mean/p50/p95, bounded), Backoff (pure
 *      math + jitter), deriveTransportHealth (5 rules), missing-key
 *      error + message.
 *   2. Adapter protocol với mock WS server: OpenAI handshake
 *      (session.update → session.created → audio delta → transcript
 *      done → function call), Gemini handshake (setup → setupComplete
 *      → inlineData audio → interrupted → toolCall), key gate (không
 *      key → MissingRealtimeKeyError, factory không được gọi), đo
 *      latency connect + first-audio trên cả 2 adapter.
 *   3. STT pipeline: VAD → segment → STT (mock) → text; blip ngắn
 *      bị loại; WER (identical / substitution / deletion /
 *      insertion / empty).
 *   4. TTS queue: splitIntoSentences (viết tắt, câu dài), queue nói
 *      từng câu theo thứ tự, barge-in stop (mock chậm + eSpeak NG
 *      thật khi có engine — đo stopLatencyMs < 200ms).
 *   5. Persistence: save/load round-trip, append, resume (transcript
 *      khôi phục, socket không), file hỏng → null + quarantine,
 *      prune, chống traversal.
 *   6. Session tích hợp: RealtimeSession + mock transport + store +
 *      TTS queue — transcript cuối được persist, barge-in dừng cả
 *      transport lẫn TTS queue, sink bị clear.
 *   7. Live (khi engine có trên máy): whisper-cli thật + model
 *      ggml-tiny transcribe audio eSpeak NG tổng hợp từ câu mẫu,
 *      đo WER; pipeline VAD→STT live end-to-end. Khi engine chưa có,
 *      test assert detectLocalStt() báo unavailable rõ ràng (mock-only).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-live-v096.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  LatencyStats,
  Backoff,
  MissingRealtimeKeyError,
  isMissingRealtimeKeyError,
  realtimeKeyMissingMessage,
  deriveTransportHealth,
  TRANSPORT_SLOW_CONNECT_MS,
} from '../packages/core/dist/voice/transportHealth.js';
import {
  OpenAiRealtimeTransport,
  GeminiLiveTransport,
  resolveRealtimeApiKey,
  hasRealtimeKeyFor,
} from '../packages/core/dist/voice/adapters.js';
import {
  LocalSttPipeline,
  wordErrorRate,
  normalizeTranscriptForWer,
} from '../packages/core/dist/voice/sttPipeline.js';
import {
  MockLocalSttEngine,
  WhisperCliSttEngine,
  detectLocalStt,
} from '../packages/core/dist/voice/localStt.js';
import {
  TtsQueue,
  splitIntoSentences,
  TTS_BARGE_IN_BUDGET_MS,
} from '../packages/core/dist/voice/ttsQueue.js';
import { TtsHarness, MockTtsEngine } from '../packages/core/dist/voice/tts.js';
import {
  VoiceSessionStore,
  createVoiceSessionRecord,
  newVoiceSessionId,
  sanitizeVoiceSessionId,
  isVoiceSessionRecord,
} from '../packages/core/dist/voice/voicePersistence.js';
import { RealtimeSession } from '../packages/core/dist/voice/realtimeSession.js';
import {
  MockAudioSink,
  sinePcm16Frame,
  silencePcm16Frame,
} from '../packages/core/dist/voice/audio.js';

// ---------------------------------------------------------------------------
// Helpers: fake WebSocket + scripted server
// ---------------------------------------------------------------------------

/** Minimal fake WebSocket: the test drives open/message/close by hand. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver one server frame (object → JSON). */
  receive(frame) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  send(data) {
    this.sent.push(String(data));
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  fail(message) {
    this.onerror?.({ message });
  }

  /** Parsed JSON of everything the client sent. */
  sentJson() {
    return this.sent.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return { _raw: s };
      }
    });
  }
}

function makeSocketFactory(sockets) {
  return (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
}

/** Base64 PCM16 of one 100 ms sine frame (model audio fixture). */
const AUDIO_B64 = Buffer.from(sinePcm16Frame(2400, 0.2, 440, 24000)).toString('base64');

// ---------------------------------------------------------------------------
// 1. Transport health
// ---------------------------------------------------------------------------

test('v096 health: LatencyStats min/max/mean/p50/p95 + bounded samples', () => {
  const stats = new LatencyStats(3);
  stats.record('connect', 100);
  stats.record('connect', 200);
  stats.record('connect', 300);
  stats.record('connect', 400); // oldest (100) drops out
  const s = stats.summary('connect');
  assert.ok(s);
  assert.equal(s.count, 3);
  assert.equal(s.minMs, 200);
  assert.equal(s.maxMs, 400);
  assert.equal(s.meanMs, 300);
  assert.equal(s.p50Ms, 300);
  assert.equal(s.p95Ms, 400);
  assert.equal(s.lastMs, 400);
  assert.equal(stats.summary('missing'), null);
  assert.equal(stats.totalSamples, 3);
  // Invalid samples are ignored.
  stats.record('connect', -5);
  stats.record('connect', Number.NaN);
  assert.equal(stats.summary('connect').count, 3);
});

test('v096 health: Backoff doubles to the cap; jitter stays in range', () => {
  assert.equal(Backoff.delayFor(1, 1000, 10000), 1000);
  assert.equal(Backoff.delayFor(2, 1000, 10000), 2000);
  assert.equal(Backoff.delayFor(5, 1000, 10000), 10000);
  assert.equal(Backoff.delayFor(9, 1000, 10000), 10000);
  const b = new Backoff({ baseMs: 1000, maxMs: 10000, jitter: 0.2, random: () => 0.5 });
  assert.equal(b.nextDelay(), 1000);
  assert.equal(b.nextDelay(), 2000);
  assert.equal(b.attemptCount, 2);
  b.reset();
  assert.equal(b.attemptCount, 0);
  // Full jitter spread never leaves [0.8x, 1.2x] of the raw delay.
  for (const r of [0, 0.25, 0.75, 1]) {
    const bj = new Backoff({ baseMs: 1000, maxMs: 10000, jitter: 0.2, random: () => r });
    const d = bj.nextDelay();
    assert.ok(d >= 800 && d <= 1200, `jitter delay ${d} out of range for r=${r}`);
  }
});

test('v096 health: deriveTransportHealth rules (key / connected / slow / failed)', () => {
  const base = {
    provider: 'openai',
    keyConfigured: true,
    connected: false,
    connectLatencyMs: null,
    firstAudioLatencyMs: null,
    failedAttempts: 0,
  };
  // No key → down, with the key message.
  const noKey = deriveTransportHealth({ ...base, keyConfigured: false });
  assert.equal(noKey.status, 'down');
  assert.match(noKey.detail, /No API key/);
  // Never tried → unknown.
  assert.equal(deriveTransportHealth(base).status, 'unknown');
  // Failed attempts → down.
  assert.equal(deriveTransportHealth({ ...base, failedAttempts: 2 }).status, 'down');
  // Connected, no audio yet → degraded.
  const waiting = deriveTransportHealth({ ...base, connected: true });
  assert.equal(waiting.status, 'degraded');
  assert.match(waiting.detail, /waiting for the first audio/);
  // Connected + audio, fast → healthy.
  const healthy = deriveTransportHealth({
    ...base,
    connected: true,
    connectLatencyMs: 120,
    firstAudioLatencyMs: 300,
  });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.detail, '');
  // Slow connect downgrades to degraded.
  const slow = deriveTransportHealth({
    ...base,
    connected: true,
    connectLatencyMs: TRANSPORT_SLOW_CONNECT_MS + 1,
    firstAudioLatencyMs: 300,
  });
  assert.equal(slow.status, 'degraded');
  assert.match(slow.detail, /Slow live path/);
});

test('v096 health: MissingRealtimeKeyError carries provider + settings hint, no key', () => {
  const err = new MissingRealtimeKeyError('gemini');
  assert.equal(err.code, 'missing-realtime-key');
  assert.equal(err.provider, 'gemini');
  assert.match(err.message, /Gemini Live/);
  assert.match(err.message, /Settings/);
  assert.ok(!err.message.includes('sk-'), 'message must never contain a key');
  assert.ok(isMissingRealtimeKeyError(err));
  assert.ok(!isMissingRealtimeKeyError(new Error('other')));
  assert.match(realtimeKeyMissingMessage('openai'), /OpenAI Realtime/);
  assert.match(realtimeKeyMissingMessage('openai-compatible'), /endpoint/);
});

test('v096 health: resolveRealtimeApiKey (direct > resolver > null; throwing resolver)', () => {
  assert.equal(
    resolveRealtimeApiKey({ provider: 'openai', apiKey: '  sk-test  ' }),
    'sk-test',
  );
  assert.equal(
    resolveRealtimeApiKey({ provider: 'openai', keyResolver: () => '  gem-key ' }),
    'gem-key',
  );
  assert.equal(resolveRealtimeApiKey({ provider: 'openai' }), null);
  assert.equal(
    resolveRealtimeApiKey({
      provider: 'openai',
      keyResolver: () => {
        throw new Error('vault down');
      },
    }),
    null,
  );
  assert.equal(hasRealtimeKeyFor({ provider: 'openai', apiKey: 'x' }), true);
  assert.equal(hasRealtimeKeyFor({ provider: 'openai' }), false);
  // openai-compatible with a URL alone is key-less by design.
  assert.equal(
    hasRealtimeKeyFor({ provider: 'openai-compatible', url: 'ws://localhost:1234/v1/realtime' }),
    true,
  );
  assert.equal(hasRealtimeKeyFor({ provider: 'openai-compatible' }), false);
});

// ---------------------------------------------------------------------------
// 2. Adapter protocol with a mock WS server
// ---------------------------------------------------------------------------

test('v096 adapter openai: key gate — no key throws, socket factory never called', async () => {
  const sockets = [];
  const transport = new OpenAiRealtimeTransport({});
  await assert.rejects(
    transport.connect({
      provider: 'openai',
      socketFactory: makeSocketFactory(sockets),
      model: 'gpt-4o-realtime-preview',
    }),
    (err) => {
      assert.ok(isMissingRealtimeKeyError(err));
      assert.match(err.message, /OpenAI Realtime/);
      return true;
    },
  );
  assert.equal(sockets.length, 0, 'must not dial without a key');
  assert.equal(transport.getHealth().status, 'down');
  assert.equal(transport.getHealth().keyConfigured, false);
});

test('v096 adapter openai: handshake, audio delta, transcript, tool call, latency', async () => {
  const sockets = [];
  const events = { audio: [], transcripts: [], toolCalls: [], errors: [] };
  const transport = new OpenAiRealtimeTransport({
    onAudio: (e) => events.audio.push(e),
    onTranscript: (e) => events.transcripts.push(e),
    onToolCall: (c) => events.toolCalls.push(c),
    onError: (e) => events.errors.push(e),
  });
  const connected = transport.connect({
    provider: 'openai',
    apiKey: 'test-key-never-sent-anywhere-real',
    socketFactory: makeSocketFactory(sockets),
    model: 'gpt-4o-realtime-preview',
    voice: 'alloy',
  });
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  socket.open();
  await connected;
  assert.equal(transport.isConnected(), true);
  // session.update went out right after open.
  const update = socket.sentJson().find((m) => m.type === 'session.update');
  assert.ok(update, 'session.update must be sent');
  assert.equal(update.session.voice, 'alloy');
  assert.equal(update.session.input_audio_format, 'pcm16');
  // Server acknowledges + streams audio + transcript + a tool call.
  socket.receive({ type: 'session.created' });
  socket.receive({ type: 'response.audio.delta', delta: AUDIO_B64 });
  socket.receive({ type: 'response.audio_transcript.delta', delta: 'xin ' });
  socket.receive({ type: 'response.audio_transcript.delta', delta: 'chào' });
  socket.receive({ type: 'response.audio_transcript.done', transcript: 'xin chào' });
  socket.receive({
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    name: 'read_file',
    arguments: '{"path":"notes/a.md"}',
  });
  assert.equal(events.audio.length, 1);
  assert.equal(events.audio[0].audio.length, 2400 * 2);
  assert.equal(events.transcripts.at(-1).text, 'xin chào');
  assert.equal(events.transcripts.at(-1).isFinal, true);
  assert.equal(events.toolCalls.length, 1);
  assert.equal(events.toolCalls[0].name, 'read_file');
  assert.deepEqual(events.toolCalls[0].args, { path: 'notes/a.md' });
  // Latency recorded: connect + first-audio.
  const latency = transport.getLatencyStats();
  assert.ok(latency.find((s) => s.kind === 'connect'), 'connect latency recorded');
  assert.ok(latency.find((s) => s.kind === 'first-audio'), 'first-audio latency recorded');
  assert.ok(latency.every((s) => s.lastMs >= 0));
  // Health is healthy (connected + audio seen + fast).
  const health = transport.getHealth();
  assert.equal(health.status, 'healthy');
  assert.equal(health.keyConfigured, true);
  assert.equal(health.connected, true);
  // Client → server: audio append, commit, response.create, cancel.
  transport.sendAudio(sinePcm16Frame(1600, 0.2, 440, 24000));
  transport.commitAudio();
  transport.requestResponse();
  transport.cancelResponse();
  const types = socket.sentJson().map((m) => m.type);
  assert.ok(types.includes('input_audio_buffer.append'));
  assert.ok(types.includes('input_audio_buffer.commit'));
  assert.ok(types.includes('response.create'));
  assert.ok(types.includes('response.cancel'));
  // Tool result → conversation.item.create + response.create.
  transport.sendToolResult('call-1', 'file contents here');
  const itemCreate = socket.sentJson().find((m) => m.type === 'conversation.item.create');
  assert.ok(itemCreate);
  assert.equal(itemCreate.item.call_id, 'call-1');
  transport.disconnect();
  assert.equal(transport.isConnected(), false);
});

test('v096 adapter openai-compatible: URL alone connects (key-less local endpoint)', async () => {
  const sockets = [];
  const transport = new OpenAiRealtimeTransport({}, 'openai-compatible');
  const connected = transport.connect({
    provider: 'openai-compatible',
    url: 'ws://localhost:1234/v1/realtime?model=test',
    socketFactory: makeSocketFactory(sockets),
    model: 'test',
  });
  sockets[0].open();
  await connected;
  assert.equal(transport.isConnected(), true);
  assert.equal(transport.getHealth().keyConfigured, true);
  transport.disconnect();
});

test('v096 adapter gemini: key gate + setup handshake + audio + interrupted + toolCall', async () => {
  const sockets = [];
  const events = { audio: [], transcripts: [], toolCalls: [], interrupted: 0, errors: [] };
  const transport = new GeminiLiveTransport({
    onAudio: (e) => events.audio.push(e),
    onTranscript: (e) => events.transcripts.push(e),
    onToolCall: (c) => events.toolCalls.push(c),
    onInterrupted: () => {
      events.interrupted += 1;
    },
    onError: (e) => events.errors.push(e),
  });
  // No key → gate, no dial.
  await assert.rejects(
    transport.connect({
      provider: 'gemini',
      socketFactory: makeSocketFactory(sockets),
      model: 'gemini-live-2.5-flash-native-audio',
    }),
    (err) => isMissingRealtimeKeyError(err),
  );
  assert.equal(sockets.length, 0);
  // With a key (via resolver — the Vault path): dials, sends setup.
  const connected = transport.connect({
    provider: 'gemini',
    keyResolver: () => 'test-gemini-key',
    socketFactory: makeSocketFactory(sockets),
    model: 'gemini-live-2.5-flash-native-audio',
    voice: 'Puck',
  });
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.match(socket.url, /generativelanguage\.googleapis\.com/);
  assert.ok(!socket.url.includes('test-gemini-key') || socket.url.includes('key='), 'key goes in ?key=');
  socket.open();
  // connect() only resolves on setupComplete.
  let resolved = false;
  void connected.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false, 'must not resolve before setupComplete');
  const setup = socket.sentJson().find((m) => m.setup);
  assert.ok(setup, 'setup frame must be sent first');
  assert.equal(setup.setup.model, 'models/gemini-live-2.5-flash-native-audio');
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ['AUDIO']);
  // Audio sent before setupComplete must throw (setup gate).
  assert.throws(
    () => transport.sendAudio(sinePcm16Frame(1600)),
    /setup not complete|not connected/,
  );
  socket.receive({ setupComplete: {} });
  await connected;
  assert.equal(transport.isConnected(), true);
  assert.ok(transport.getLatencyStats().find((s) => s.kind === 'connect'));
  // Model audio + output transcription + turn end.
  socket.receive({
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { mimeType: 'audio/pcm;rate=24000', data: AUDIO_B64 } },
        ],
      },
      outputTranscription: { text: 'xin chào' },
      turnComplete: true,
    },
  });
  assert.equal(events.audio.length, 1);
  assert.equal(events.audio[0].audio.length, 2400 * 2);
  assert.ok(events.transcripts.some((t) => t.text.includes('xin chào') && t.isFinal));
  assert.ok(transport.getLatencyStats().find((s) => s.kind === 'first-audio'));
  assert.equal(transport.getHealth().status, 'healthy');
  // Server-side interruption → onInterrupted.
  socket.receive({ serverContent: { interrupted: true } });
  assert.equal(events.interrupted, 1);
  // Tool call → answered with the original id.
  socket.receive({
    toolCall: {
      functionCalls: [{ id: 'fn-9', name: 'search_web', args: { q: 'open-bot' } }],
    },
  });
  assert.equal(events.toolCalls.length, 1);
  assert.equal(events.toolCalls[0].name, 'search_web');
  transport.sendToolResult('fn-9', 'found it');
  const toolResponse = socket.sentJson().find((m) => m.toolResponse);
  assert.ok(toolResponse);
  assert.equal(toolResponse.toolResponse.functionResponses[0].id, 'fn-9');
  // Unknown tool id → loud error, not a guessed answer.
  assert.throws(() => transport.sendToolResult('nope', 'x'), /unknown tool call id/);
  // Audio out is realtimeInput mediaChunks at 16 kHz.
  transport.sendAudio(sinePcm16Frame(1600));
  const audioMsg = socket.sentJson().find((m) => m.realtimeInput?.mediaChunks);
  assert.ok(audioMsg);
  assert.equal(audioMsg.realtimeInput.mediaChunks[0].mimeType, 'audio/pcm;rate=16000');
  transport.disconnect();
  assert.equal(transport.isConnected(), false);
});

test('v096 adapter gemini: dial timeout rejects + counts a failed attempt', async () => {
  const sockets = [];
  const errors = [];
  const transport = new GeminiLiveTransport({ onError: (e) => errors.push(e) });
  await assert.rejects(
    transport.connect({
      provider: 'gemini',
      apiKey: 'test-key',
      socketFactory: makeSocketFactory(sockets),
      dialTimeoutMs: 20,
    }),
    /dial timed out after 20ms/,
  );
  assert.equal(transport.getHealth().failedAttempts, 1);
  assert.equal(transport.getHealth().status, 'down');
});

// ---------------------------------------------------------------------------
// 3. STT pipeline + WER
// ---------------------------------------------------------------------------

/** Feed `frames` of speech then `silenceFrames` of silence into a pipeline. */
function feedSpeechThenSilence(pipeline, speechFrames, silenceFrames = 20) {
  for (let i = 0; i < speechFrames; i++) {
    pipeline.feed(sinePcm16Frame(320, 0.2, 440, 16000)); // 20 ms
  }
  for (let i = 0; i < silenceFrames; i++) {
    pipeline.feed(silencePcm16Frame(320));
  }
}

test('v096 stt pipeline: VAD → segment → STT → text (mock engine)', async () => {
  const engine = new MockLocalSttEngine(['xin chào open-bot']);
  const results = [];
  const pipeline = new LocalSttPipeline({
    engine,
    callbacks: { onResult: (r) => results.push(r) },
  });
  assert.equal(pipeline.isEngineAvailable(), true);
  feedSpeechThenSilence(pipeline, 25); // 500 ms speech
  await pipeline.drain();
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'xin chào open-bot');
  assert.ok(results[0].segmentMs >= 400 && results[0].segmentMs <= 900, `segmentMs=${results[0].segmentMs}`);
  assert.equal(pipeline.transcribedCount, 1);
  assert.equal(engine.calls.length, 1);
  // The engine got real audio bytes (not silence).
  const pcm = engine.calls[0];
  assert.ok(pcm.length > 0 && pcm.length % 2 === 0);
});

test('v096 stt pipeline: blip ngắn bị loại, không gọi engine', async () => {
  const engine = new MockLocalSttEngine(['should not be called']);
  const results = [];
  const pipeline = new LocalSttPipeline({
    engine,
    minSegmentMs: 300,
    callbacks: { onResult: (r) => results.push(r) },
  });
  feedSpeechThenSilence(pipeline, 5); // 100 ms — below the 300 ms floor
  await pipeline.drain();
  assert.equal(results.length, 0);
  assert.equal(engine.calls.length, 0);
  assert.equal(pipeline.discardedCount, 1);
});

test('v096 stt pipeline: segment dài bị cắt giữa chừng, flush kết thúc đoạn', async () => {
  const engine = new MockLocalSttEngine(['part one', 'part two']);
  const results = [];
  const pipeline = new LocalSttPipeline({
    engine,
    maxSegmentMs: 400,
    callbacks: { onResult: (r) => results.push(r) },
  });
  // 40 × 20 ms = 800 ms speech → cut at ~400 ms, rest (400 ms) flushed.
  for (let i = 0; i < 40; i++) pipeline.feed(sinePcm16Frame(320, 0.2, 440, 16000));
  pipeline.flush();
  await pipeline.drain();
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.text), ['part one', 'part two']);
  // A failing engine is reported, not fatal.
  const failing = {
    id: 'failing',
    isAvailable: () => true,
    status: () => ({ available: true, engineId: 'failing', binaryPath: null, modelPath: null }),
    transcribe: async () => {
      throw new Error('engine boom');
    },
  };
  const errors = [];
  const p2 = new LocalSttPipeline({ engine: failing, callbacks: { onError: (e) => errors.push(e) } });
  feedSpeechThenSilence(p2, 25);
  await p2.drain();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /engine boom/);
  assert.equal(p2.failureCount, 1);
});

test('v096 stt WER: identical / substitution / deletion / insertion / empty', () => {
  assert.deepEqual(wordErrorRate('hello world', 'hello world'), {
    wer: 0, substitutions: 0, deletions: 0, insertions: 0, refWords: 2, hypWords: 2,
  });
  assert.equal(wordErrorRate('hello world', 'hello there').wer, 0.5);
  assert.equal(wordErrorRate('hello world', 'hello world').substitutions, 0);
  assert.equal(wordErrorRate('hello brave new world', 'hello world').deletions, 2);
  assert.equal(wordErrorRate('hello world', 'hello brave new world').insertions, 2);
  assert.equal(wordErrorRate('', '').wer, 0);
  assert.equal(wordErrorRate('', 'hello').wer, 1);
  // Case + punctuation insensitive.
  assert.equal(wordErrorRate('Hello, World!', 'hello world').wer, 0);
  assert.equal(normalizeTranscriptForWer('  Xin   Chào! '), 'xin chào');
});

// ---------------------------------------------------------------------------
// 4. TTS queue
// ---------------------------------------------------------------------------

test('v096 tts queue: splitIntoSentences (viết tắt, câu dài, rỗng)', () => {
  assert.deepEqual(splitIntoSentences(''), []);
  assert.deepEqual(splitIntoSentences('Hello world.'), ['Hello world.']);
  assert.deepEqual(splitIntoSentences('Hello world. How are you? Fine!'), [
    'Hello world.',
    'How are you?',
    'Fine!',
  ]);
  // Abbreviations do not split.
  const abbr = splitIntoSentences('Dr. Smith said hello. Then he left.');
  assert.equal(abbr.length, 2);
  assert.match(abbr[0], /Dr\. Smith said hello/);
  // A very long sentence splits at commas so pauses land regularly.
  const long = `First part is here, second part follows along, third part keeps going, fourth part wraps it up, and the final part ends the sentence.`;
  const parts = splitIntoSentences(long);
  assert.ok(parts.length >= 2, `long sentence split into ${parts.length}`);
  assert.ok(parts.every((p) => p.length <= 130), 'no part wildly over the split length');
  // Markdown is stripped before splitting.
  assert.deepEqual(splitIntoSentences('**Hello** [world](https://x.test).'), ['Hello world.']);
});

test('v096 tts queue: enqueue nói từng câu theo thứ tự, drain về idle', async () => {
  const engine = new MockTtsEngine();
  const harness = new TtsHarness([engine]);
  const started = [];
  const done = [];
  const queue = new TtsQueue({
    harness,
    callbacks: {
      onSentenceStart: (s) => started.push(s.text),
      onSentenceDone: (s) => done.push(s.text),
    },
  });
  const n = queue.enqueue('First sentence. Second sentence. Third sentence.');
  assert.equal(n, 3);
  await queue.drain();
  assert.deepEqual(started, ['First sentence.', 'Second sentence.', 'Third sentence.']);
  assert.deepEqual(done, started);
  assert.equal(queue.spokenSentences, 3);
  assert.equal(queue.queuedCount, 0);
  assert.equal(queue.isSpeaking(), false);
  assert.equal(engine.utterances.length, 3);
});

/** Mock engine whose speak() only finishes when stopped (barge-in fixture). */
class SlowMockTtsEngine {
  constructor() {
    this.id = 'slow-mock';
    this.name = 'Slow mock';
    this.kind = 'mock';
    this.spoken = [];
    this._resolve = null;
    this._timer = null;
  }

  async isAvailable() {
    return true;
  }

  speak(text) {
    this.spoken.push(text);
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._timer = setTimeout(() => resolve({ spoken: true, engineId: this.id }), 5000);
    });
  }

  async stop() {
    if (!this._resolve) return false;
    clearTimeout(this._timer);
    const resolve = this._resolve;
    this._resolve = null;
    resolve({ spoken: false, engineId: this.id, reason: 'stopped' });
    return true;
  }

  async listVoices() {
    return [];
  }
}

test('v096 tts queue: barge-in dừng câu đang nói + drop hàng chờ, đo <200ms', async () => {
  const engine = new SlowMockTtsEngine();
  const harness = new TtsHarness([engine]);
  const queue = new TtsQueue({ harness });
  queue.enqueue('Sentence one is long. Sentence two is long. Sentence three is long.');
  // Wait until the first sentence is actually speaking.
  for (let i = 0; i < 50 && !queue.isSpeaking(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(queue.isSpeaking(), true);
  const result = await queue.bargeIn();
  assert.equal(result.stopped, true);
  assert.equal(result.droppedSentences, 2);
  assert.ok(
    result.stopLatencyMs < TTS_BARGE_IN_BUDGET_MS,
    `stop took ${result.stopLatencyMs}ms, budget ${TTS_BARGE_IN_BUDGET_MS}ms`,
  );
  assert.equal(queue.isSpeaking(), false);
  assert.equal(queue.queuedCount, 0);
  assert.equal(queue.lastStopLatency, result.stopLatencyMs);
  assert.equal(queue.droppedSentences, 3); // 2 queued + 1 mid-sentence
  await queue.drain();
  // Stop on an idle queue: nothing to stop.
  const idle = await queue.stop();
  assert.equal(idle.stopped, false);
  assert.equal(idle.stopLatencyMs, 0);
});

// ---------------------------------------------------------------------------
// 5. Persistence
// ---------------------------------------------------------------------------

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-voice-v096-'));
  return { dir, store: new VoiceSessionStore({ dir }) };
}

test('v096 persistence: save/load round-trip + append + resume (không khôi phục socket)', () => {
  const { dir, store } = tmpStore();
  const id = newVoiceSessionId();
  const record = createVoiceSessionRecord({ sessionId: id, provider: 'openai', turnMode: 'server_vad', botId: 'bot-1' });
  assert.equal(store.save(record), true);
  assert.deepEqual(store.list(), [id]);
  const loaded = store.load(id);
  assert.ok(loaded);
  assert.equal(loaded.sessionId, id);
  assert.equal(loaded.botId, 'bot-1');
  assert.equal(loaded.state, 'connecting');
  assert.equal(store.appendTranscript(id, { id: `${id}-1`, at: Date.now(), speaker: 'user', text: 'xin chào', isFinal: true }), true);
  assert.equal(store.appendTranscript(id, { id: `${id}-2`, at: Date.now(), speaker: 'model', text: 'chào bạn', isFinal: true }), true);
  // Interim lines are never persisted.
  assert.equal(store.appendTranscript(id, { id: `${id}-3`, at: Date.now(), speaker: 'model', text: 'đang…', isFinal: false }), false);
  const after = store.load(id);
  assert.equal(after.transcript.length, 2);
  assert.equal(after.transcript[1].speaker, 'model');
  // Resume: transcript + state reset, socket NOT restored.
  const resumed = store.resume(id);
  assert.ok(resumed);
  assert.equal(resumed.state, 'idle');
  assert.equal(resumed.endedAt, undefined);
  assert.equal(resumed.transcript.length, 2);
  assert.equal(store.delete(id), true);
  assert.equal(store.load(id), null);
  assert.deepEqual(store.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v096 persistence: file hỏng → null + quarantine; traversal bị chặn; prune', () => {
  const { dir, store } = tmpStore();
  const id = newVoiceSessionId();
  store.save(createVoiceSessionRecord({ sessionId: id, provider: 'gemini', turnMode: 'local_vad' }));
  // Corrupt the file on disk.
  fs.writeFileSync(path.join(dir, `${id}.json`), '{not json', 'utf8');
  assert.equal(store.load(id), null);
  const leftovers = fs.readdirSync(dir);
  assert.ok(leftovers.some((f) => f.startsWith(`${id}.json.corrupt-`)), 'corrupt file quarantined');
  assert.ok(!leftovers.includes(`${id}.json`), 'bad file moved aside');
  // Traversal: a crafted id can never escape the directory.
  assert.ok(!sanitizeVoiceSessionId('../../etc/passwd').includes('/'));
  assert.ok(store.filePath('../../etc/passwd').startsWith(dir));
  assert.equal(store.save({ version: 1, sessionId: '', provider: 'openai', startedAt: 1, transcript: [] }), false);
  assert.ok(!isVoiceSessionRecord({ version: 2, sessionId: 'x' }));
  // Prune: an old session goes, a fresh one stays; over the cap the oldest goes.
  const oldId = newVoiceSessionId();
  store.save(createVoiceSessionRecord({ sessionId: oldId, provider: 'openai', turnMode: 'server_vad' }));
  const oldFile = path.join(dir, `${oldId}.json`);
  const ancient = Date.now() - 40 * 24 * 60 * 60 * 1000;
  // Age the record in place (save() would refresh updatedAt).
  const raw = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
  raw.updatedAt = ancient;
  fs.writeFileSync(oldFile, JSON.stringify(raw), 'utf8');
  const freshId = newVoiceSessionId();
  store.save(createVoiceSessionRecord({ sessionId: freshId, provider: 'openai', turnMode: 'server_vad' }));
  const removed = store.prune(30 * 24 * 60 * 60 * 1000, 50);
  assert.ok(removed.includes(oldId), 'old session pruned');
  assert.ok(!removed.includes(freshId), 'fresh session kept');
  assert.equal(store.load(freshId)?.sessionId, freshId);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. Session integration: transport + store + TTS queue + barge-in
// ---------------------------------------------------------------------------

test('v096 session: transcript cuối được persist, barge-in dừng cả transport lẫn TTS', async () => {
  const { dir, store } = tmpStore();
  const sockets = [];
  const sink = new MockAudioSink(24000);
  const slowEngine = new SlowMockTtsEngine();
  const queue = new TtsQueue({ harness: new TtsHarness([slowEngine]) });
  const events = [];
  const sessionId = newVoiceSessionId();
  const session = new RealtimeSession({
    provider: 'openai',
    transportFactory: (cb) => new OpenAiRealtimeTransport(cb),
    audioSink: sink,
    ttsQueue: queue,
    sessionStore: store,
    persistSessionId: sessionId,
    botId: 'bot-1',
    onEvent: (e) => events.push(e),
  });
  const connecting = session.connect({
    apiKey: 'test-key',
    socketFactory: makeSocketFactory(sockets),
    model: 'gpt-4o-realtime-preview',
  });
  sockets[0].open();
  await connecting;
  assert.equal(session.getState(), 'listening');
  assert.equal(session.getSessionId(), sessionId);
  // Model speaks (audio delta) → session 'speaking', sink gets audio.
  sockets[0].receive({ type: 'response.audio.delta', delta: AUDIO_B64 });
  assert.equal(session.getState(), 'speaking');
  assert.ok(sink.totalBytes > 0);
  // Final transcript → TTS queue starts speaking it (slow engine) + persisted.
  sockets[0].receive({ type: 'response.audio_transcript.done', transcript: 'Hello there, this is a long reply.' });
  for (let i = 0; i < 50 && !queue.isSpeaking(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(queue.isSpeaking(), true);
  const stored = store.load(sessionId);
  assert.ok(stored);
  assert.equal(stored.transcript.length, 1);
  assert.equal(stored.transcript[0].speaker, 'model');
  assert.match(stored.transcript[0].text, /Hello there/);
  assert.equal(session.getTranscriptLines().length, 1);
  // User line recorded from the local STT path.
  session.recordUserTranscript('xin chào');
  assert.equal(session.getTranscriptLines().length, 2);
  assert.equal(store.load(sessionId).transcript.length, 2);
  // Barge-in: transport cancelled + sink cleared + TTS queue stopped.
  const clearedBefore = sink.clears;
  const interrupted = session.interrupt();
  assert.equal(interrupted, true);
  assert.equal(sink.clears, clearedBefore + 1);
  assert.equal(sink.queuedBytes, 0);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.getBargeInCount(), 1);
  assert.ok(events.some((e) => e.kind === 'interrupted'));
  // The queue dies fast (mock engine stops instantly).
  await queue.drain();
  assert.equal(queue.isSpeaking(), false);
  assert.ok(queue.lastStopLatency !== null && queue.lastStopLatency < TTS_BARGE_IN_BUDGET_MS);
  // Disconnect saves the final record (endedAt + counters).
  session.disconnect();
  const final = store.load(sessionId);
  assert.equal(final.state, 'closed');
  assert.ok(typeof final.endedAt === 'number');
  assert.equal(final.bargeInCount, 1);
  assert.equal(final.transcript.length, 2);
  // Resume: a new session with the same id sees the old transcript.
  const session2 = new RealtimeSession({
    provider: 'openai',
    transportFactory: (cb) => new OpenAiRealtimeTransport(cb),
    sessionStore: store,
    persistSessionId: sessionId,
  });
  const connecting2 = session2.connect({
    apiKey: 'test-key',
    socketFactory: makeSocketFactory(sockets),
    model: 'gpt-4o-realtime-preview',
  });
  sockets[1].open();
  await connecting2;
  assert.equal(session2.getTranscriptLines().length, 2);
  assert.equal(session2.getBargeInCount(), 1);
  session2.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v096 session: không key → MissingRealtimeKeyError, không dial', async () => {
  const sockets = [];
  const session = new RealtimeSession({
    provider: 'openai',
    transportFactory: (cb) => new OpenAiRealtimeTransport(cb),
  });
  await assert.rejects(
    session.connect({
      socketFactory: makeSocketFactory(sockets),
      model: 'gpt-4o-realtime-preview',
    }),
    (err) => isMissingRealtimeKeyError(err),
  );
  assert.equal(sockets.length, 0);
  assert.equal(session.getState(), 'idle');
  // keyResolver (Vault path) supplies the key at connect time.
  const session2 = new RealtimeSession({
    provider: 'openai',
    transportFactory: (cb) => new OpenAiRealtimeTransport(cb),
    keyResolver: () => 'vault-key',
  });
  const connecting = session2.connect({
    socketFactory: makeSocketFactory(sockets),
    model: 'gpt-4o-realtime-preview',
  });
  sockets[0].open();
  await connecting;
  assert.equal(session2.isConnected(), true);
  assert.equal(session2.getHealth()?.keyConfigured, true);
  session2.disconnect();
});

// ---------------------------------------------------------------------------
// 7. Live engine tests (chỉ chạy thật khi engine có trên máy)
// ---------------------------------------------------------------------------

/** Run a command, return stdout Buffer (or null when the binary is missing). */
function tryRun(argv, options = {}) {
  try {
    return execFileSync(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024, ...options });
  } catch {
    return null;
  }
}

test('v096 live stt: whisper-cli thật transcribe audio eSpeak NG, đo WER', async () => {
  const stt = detectLocalStt();
  const status = stt.status();
  if (!stt.isAvailable()) {
    // Engine chưa có: assert probe báo rõ ràng để caller fallback.
    assert.equal(status.available, false);
    assert.ok(status.reason && status.reason.length > 0, 'probe must explain why');
    console.log(`v096 live stt: MOCK-ONLY — ${status.reason}`);
    return;
  }
  assert.equal(status.engineId, 'whisper-cli');
  assert.ok(status.binaryPath, 'binary path found');
  assert.ok(status.modelPath, 'model path found');
  console.log(`v096 live stt: engine ${status.binaryPath}, model ${status.modelPath}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-voice-live-'));
  try {
    // Synthesise known speech: eSpeak NG reads the reference text.
    const reference = 'hello world';
    const wav = tryRun(['espeak-ng', '--stdout', '-v', 'en', reference]);
    assert.ok(wav && wav.length > 1000, 'espeak-ng must synthesise audio');
    const wavPath = path.join(dir, 'ref.wav');
    const pcmPath = path.join(dir, 'ref.pcm');
    fs.writeFileSync(wavPath, wav);
    const converted = tryRun(['ffmpeg', '-y', '-v', 'error', '-i', wavPath, '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath]);
    assert.ok(converted !== null || fs.existsSync(pcmPath), 'ffmpeg must convert to 16k mono PCM');
    const pcm16 = new Uint8Array(fs.readFileSync(pcmPath));
    assert.ok(pcm16.length > 0 && pcm16.length % 2 === 0);
    // Direct engine call.
    // v0.97 fix (merge verify): timeout 180s cho test live này — test
    // đo WER (độ chính xác), không đo tốc độ; timeout mặc định của
    // product là 120s, test trước đây ép 60s (chặt hơn cả product) nên
    // flake khi whisper-cli chỉ riêng khởi động model đã quá 60s dưới
    // tải suite (load avg ~9, máy 1,5 CPU).
    const started = Date.now();
    const text = await stt.transcribe(pcm16, { language: 'en', timeoutMs: 180000 });
    const tookMs = Date.now() - started;
    const result = wordErrorRate(reference, text);
    console.log(`v096 live stt: whisper heard "${text}" (WER ${result.wer}, ${tookMs}ms)`);
    assert.ok(text.length > 0, 'whisper must return non-empty text');
    assert.ok(result.wer <= 0.6, `WER ${result.wer} too high for a clear synthetic voice`);
    // Full pipeline (VAD → segment → STT) on the same audio, live.
    const pipelineResults = [];
    const pipeline = new LocalSttPipeline({
      engine: stt,
      language: 'en',
      callbacks: { onResult: (r) => pipelineResults.push(r) },
    });
    const frameBytes = 640; // 20 ms @ 16 kHz
    for (let off = 0; off + frameBytes <= pcm16.length; off += frameBytes) {
      pipeline.feed(pcm16.slice(off, off + frameBytes));
    }
    for (let i = 0; i < 30; i++) pipeline.feed(silencePcm16Frame(320));
    await pipeline.drain();
    assert.equal(pipelineResults.length, 1, 'one speech segment → one transcription');
    const pipeWer = wordErrorRate(reference, pipelineResults[0].text);
    console.log(`v096 live stt pipeline: "${pipelineResults[0].text}" (WER ${pipeWer.wer})`);
    assert.ok(pipeWer.wer <= 0.6, `pipeline WER ${pipeWer.wer} too high`);
    assert.ok(pipelineResults[0].transcribeMs > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v096 live tts: eSpeak NG thật — stop giữa câu dài < 200ms', async () => {
  const harness = new TtsHarness();
  const status = await harness.status();
  if (!status.available) {
    console.log('v096 live tts: MOCK-ONLY — no system TTS engine on this machine');
    return;
  }
  // Probe: the engine must actually speak (not just exist).
  const probe = await harness.speak('test');
  if (!probe.spoken) {
    console.log(`v096 live tts: MOCK-ONLY — probe did not speak (${probe.reason})`);
    return;
  }
  const queue = new TtsQueue({ harness });
  const longText = [
    'This is the first sentence of a long reply.',
    'Here comes the second sentence, still going strong.',
    'The third sentence keeps talking without pause.',
    'A fourth sentence follows right behind it.',
    'And a fifth sentence finishes the reply.',
  ].join(' ');
  queue.enqueue(longText);
  for (let i = 0; i < 100 && !queue.isSpeaking(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(queue.isSpeaking(), true, 'queue must be mid-sentence for a real stop test');
  const result = await queue.stop();
  assert.equal(result.stopped, true);
  console.log(`v096 live tts: espeak stop latency ${result.stopLatencyMs}ms (budget ${TTS_BARGE_IN_BUDGET_MS}ms)`);
  assert.ok(
    result.stopLatencyMs < TTS_BARGE_IN_BUDGET_MS,
    `live stop took ${result.stopLatencyMs}ms, budget ${TTS_BARGE_IN_BUDGET_MS}ms`,
  );
  assert.equal(queue.isSpeaking(), false);
  await queue.drain();
});

test('v096 live: detectLocalStt + WhisperCliSttEngine agree on availability', () => {
  const detected = detectLocalStt();
  const direct = new WhisperCliSttEngine();
  assert.equal(detected.isAvailable(), direct.isAvailable());
  assert.equal(detected.status().available, direct.status().available);
  // Either both found the same binary/model or both found nothing.
  assert.equal(detected.status().binaryPath, direct.status().binaryPath);
  assert.equal(detected.status().modelPath, direct.status().modelPath);
});

// ---------------------------------------------------------------------------
// 8. Mock transport fallback (không key → vẫn chạy, nói rõ là mock)
// ---------------------------------------------------------------------------

import { MockRealtimeTransport, isMockRealtimeTransport } from '../packages/core/dist/voice/mockTransport.js';

test('v096 mock: connect ngay, commit → transcript + audio + responseDone', async () => {
  const events = { audio: [], transcripts: [], done: 0, states: [] };
  const transport = new MockRealtimeTransport(
    {
      onAudio: (e) => events.audio.push(e),
      onTranscript: (e) => events.transcripts.push(e),
      onResponseDone: () => {
        events.done += 1;
      },
      onStateChange: (s) => events.states.push(s),
    },
    { script: [{ text: 'mock reply one', audioMs: 100 }, { text: 'mock reply two', audioMs: 100 }] },
    'openai',
  );
  // No key needed — the mock never dials.
  await transport.connect({ provider: 'openai' });
  assert.equal(transport.isConnected(), true);
  assert.equal(events.states[0], 'connected');
  assert.equal(transport.getHealth().mock, true);
  assert.equal(transport.getHealth().keyConfigured, false);
  assert.equal(transport.getHealth().status, 'healthy');
  assert.ok(transport.getLatencyStats().find((s) => s.kind === 'connect'));
  // Mic audio is accepted; the reply comes on commit.
  transport.sendAudio(sinePcm16Frame(1600));
  transport.commitAudio();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.transcripts.length, 1);
  assert.equal(events.transcripts[0].text, 'mock reply one');
  assert.equal(events.transcripts[0].isFinal, true);
  assert.equal(events.audio.length, 1);
  assert.ok(events.audio[0].audio.length > 0);
  assert.equal(events.done, 1);
  assert.equal(transport.repliesServed, 1);
  // Second commit → second reply; then the last reply repeats.
  transport.requestResponse();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.transcripts[1].text, 'mock reply two');
  transport.requestResponse();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.transcripts[2].text, 'mock reply two');
  // Tool result → next scripted reply (the model "answers" it).
  transport.sendToolResult('call-1', 'ok');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.transcripts.length, 4);
  transport.disconnect();
  assert.equal(transport.isConnected(), false);
  assert.ok(isMockRealtimeTransport(transport));
  assert.equal(isMockRealtimeTransport(new OpenAiRealtimeTransport({})), false);
});

test('v096 mock: cancelResponse drop reply đang chờ; sendAudio khi chưa nối thì lỗi', async () => {
  const events = { transcripts: [] };
  const transport = new MockRealtimeTransport(
    { onTranscript: (e) => events.transcripts.push(e) },
    { script: [{ text: 'never arrives', audioMs: 100 }], replyDelayMs: 300 },
    'gemini',
  );
  assert.throws(() => transport.sendAudio(sinePcm16Frame(1600)), /not connected/);
  await transport.connect({ provider: 'gemini' });
  transport.commitAudio();
  transport.cancelResponse();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(events.transcripts.length, 0, 'cancelled reply must never arrive');
  assert.equal(transport.getHealth().provider, 'gemini');
  transport.disconnect();
});

test('v096 mock: RealtimeSession chạy mock không cần key, transcript tới UI', async () => {
  const events = [];
  const session = new RealtimeSession({
    provider: 'openai',
    transportFactory: (cb) => new MockRealtimeTransport(cb, { script: [{ text: 'mock hello', audioMs: 50 }] }, 'openai'),
    turnMode: 'local_vad',
    onEvent: (e) => events.push(e),
  });
  // No apiKey, no keyResolver — the mock path never asks for one.
  await session.connect({ model: 'mock' });
  assert.equal(session.getState(), 'listening');
  assert.equal(session.getHealth()?.mock, true);
  session.pushAudioFrame(sinePcm16Frame(1600, 0.2, 440, 16000));
  session.commitAudio();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(events.some((e) => e.kind === 'transcript' && e.text === 'mock hello' && e.isFinal));
  assert.ok(events.some((e) => e.kind === 'turn' && e.speaker === 'model'));
  session.disconnect();
  assert.equal(session.getState(), 'closed');
});
