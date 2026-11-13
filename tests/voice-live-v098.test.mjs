/**
 * Tests cho v0.98 — voice live (Đội T5).
 *
 *   1. Key gate (packages/core/src/voice/keyGate.ts): decide live
 *      vs mock per provider (config > vault > env > keyless-url),
 *      RealtimeKeyGate (register/decideAll/liveProviders), assertLive,
 *      model validation (Gemini Live chỉ chấp nhận *-live-* /
 *      *-native-audio*, OpenAI cảnh báo model lạ).
 *   2. Live probes (liveProbe.ts): endpoint probe không key (fake
 *      fetch: 200/401 = reachable, throw/timeout = unreachable),
 *      parse list-models, connector probe (fake runner), readiness
 *      kết hợp, local proxy probe. + live thật (mạng/helper thật,
 *      chỉ assert shape, log số đo).
 *   3. Turn-taking đo live (turnTaking.ts + RealtimeSession):
 *      meter với clock giả (leg split, budget, stats p50/p95/
 *      breaches), runMockBargeInProbe trên session thật + mock
 *      transport (đo round-trip < 500ms, về listening, event
 *      'barge-in-measured'), VAD paths (local_vad/server_vad).
 *   4. Chunked/streaming STT (whisperStream.ts + localStt.ts):
 *      splitAudioOnSilence, dedupeChunkOverlap, ChunkedWhisperStt
 *      (mock engine: 1 chunk / nhiều chunk + dedupe), segmented,
 *      WER benchmark, StreamingSttSession + scoreReference,
 *      transcribeDetailed (runner giả: JSON segments + fallback
 *      khi thiếu JSON, flag -t). + live whisper thật khi có
 *      engine (WER + thời gian).
 *   5. Fallback factory (realtimeFallback.ts): live vs mock theo
 *      decision, provider mismatch, decide+choose một lần.
 *   6. Diagnostics (voiceDiagnostics.ts): report khi chưa có key
 *      (mock + nextStep), khi có key (ready), STT missing/ready,
 *      verdicts, summary turn-taking.
 *   7. i18n: 2 key mới có đủ 6 locale, placeholder còn nguyên.
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-live-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  RealtimeKeyGate,
  decideRealtimeMode,
  resolveRealtimeKeyWithSource,
  assertLive,
  isGeminiLiveModel,
  isOpenAiRealtimeModel,
  validateRealtimeModel,
} from '../packages/core/dist/voice/keyGate.js';
import {
  probeHttpsEndpoint,
  probeRealtimeEndpoints,
  parseGeminiListModels,
  probeGeminiConnectorModels,
  probeGeminiLiveReadiness,
  probeLocalProxy,
  GEMINI_ENDPOINT_PROBE_URL,
  OPENAI_ENDPOINT_PROBE_URL,
} from '../packages/core/dist/voice/liveProbe.js';
import {
  TurnTakingMeter,
  summarizeBargeInMeasurements,
  emptyTurnTakingStats,
  runMockBargeInProbe,
  BARGE_IN_TOTAL_BUDGET_MS,
} from '../packages/core/dist/voice/turnTaking.js';
import { TTS_BARGE_IN_BUDGET_MS } from '../packages/core/dist/voice/ttsQueue.js';
import {
  ChunkedWhisperStt,
  ChunkedEngineAdapter,
  StreamingSttSession,
  splitAudioOnSilence,
  dedupeChunkOverlap,
  runWerBenchmark,
} from '../packages/core/dist/voice/whisperStream.js';
import {
  WhisperCliSttEngine,
  MockLocalSttEngine,
  detectLocalStt,
  parseWhisperTimestamp,
} from '../packages/core/dist/voice/localStt.js';
import {
  LocalSttPipeline,
  wordErrorRate,
} from '../packages/core/dist/voice/sttPipeline.js';
import {
  OpenAiRealtimeTransport,
  GeminiLiveTransport,
} from '../packages/core/dist/voice/adapters.js';
import {
  chooseRealtimeTransport,
  decideAndChooseRealtimeTransport,
  isMockFallbackChoice,
  isMockRealtimeTransport,
} from '../packages/core/dist/voice/realtimeFallback.js';
import {
  collectVoiceDiagnostics,
  voiceDiagnosticsVerdict,
} from '../packages/core/dist/voice/voiceDiagnostics.js';
import { RealtimeSession } from '../packages/core/dist/voice/realtimeSession.js';
import { MockRealtimeTransport } from '../packages/core/dist/voice/mockTransport.js';
import {
  MockAudioSink,
  MockAudioSource,
  sinePcm16Frame,
  silencePcm16Frame,
} from '../packages/core/dist/voice/audio.js';
import { TtsQueue } from '../packages/core/dist/voice/ttsQueue.js';
import { TtsHarness, MockTtsEngine } from '../packages/core/dist/voice/tts.js';
import {
  runVoiceLiveVerification,
  summarizeVoiceLiveVerification,
} from '../packages/core/dist/voice/liveVerify.js';
import {
  listLocalWhisperModels,
  parseWhisperModelFileName,
  recommendWhisperModel,
  whisperModelDownloadCommand,
  expectedWhisperModelSizeMb,
  isCompleteWhisperModel,
  availableCpuCount,
} from '../packages/core/dist/voice/whisperModels.js';
import { MissingRealtimeKeyError } from '../packages/core/dist/voice/transportHealth.js';

// ---------------------------------------------------------------------------
// Helpers: fake WebSocket + scripted server (same shape as v096)
// ---------------------------------------------------------------------------

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
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

/** Socket factory that opens the socket on the next tick, so a
 *  `connect()` awaiting the open resolves on its own (the probe
 *  cannot open it by hand — it connects before driving audio). */
function makeAutoOpenSocketFactory(sockets) {
  return (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    setTimeout(() => s.open(), 0);
    return s;
  };
}

const AUDIO_B64 = Buffer.from(sinePcm16Frame(2400, 0.2, 440, 24000)).toString('base64');

// ---------------------------------------------------------------------------
// 1. Key gate
// ---------------------------------------------------------------------------

test('v098 keygate: decide live vs mock — config > vault > env > keyless-url > none', () => {
  // No key anywhere → mock, needsKey, settings hint, no key material.
  const none = decideRealtimeMode('openai', { env: {} });
  assert.equal(none.mode, 'mock');
  assert.equal(none.source, 'none');
  assert.equal(none.keyConfigured, false);
  assert.equal(none.needsKey, true);
  assert.match(none.reason, /No API key/);
  assert.match(none.reason, /Settings/);
  assert.ok(!none.reason.includes('sk-'));
  // Direct key wins.
  const direct = decideRealtimeMode('gemini', { apiKey: '  key-1 ', env: {} });
  assert.equal(direct.mode, 'live');
  assert.equal(direct.source, 'config');
  assert.equal(direct.keyConfigured, true);
  assert.equal(direct.needsKey, false);
  // Vault resolver beats env.
  const vault = decideRealtimeMode('openai', {
    keyResolver: () => 'vault-key',
    env: { OPENAI_API_KEY: 'env-key' },
  });
  assert.equal(vault.mode, 'live');
  assert.equal(vault.source, 'vault');
  // Env is the last resort.
  const env = decideRealtimeMode('gemini', { env: { GEMINI_API_KEY: 'env-gem-key' } });
  assert.equal(env.mode, 'live');
  assert.equal(env.source, 'env');
  // A throwing resolver is "no key", not a crash.
  const broken = decideRealtimeMode('openai', {
    keyResolver: () => {
      throw new Error('vault down');
    },
    env: {},
  });
  assert.equal(broken.mode, 'mock');
  // openai-compatible with a URL alone is live (key-less local endpoint).
  const local = decideRealtimeMode('openai-compatible', { url: 'ws://127.0.0.1:8080/v1/realtime', env: {} });
  assert.equal(local.mode, 'live');
  assert.equal(local.source, 'keyless-url');
  // But openai with only a URL is still mock (its adapter needs a key).
  assert.equal(decideRealtimeMode('openai', { url: 'ws://127.0.0.1:8080/v1/realtime', env: {} }).mode, 'mock');
  assert.equal(decideRealtimeMode('gemini', { url: 'ws://127.0.0.1:8080/v1/realtime', env: {} }).mode, 'mock');
});

test('v098 keygate: resolveRealtimeKeyWithSource precedence + trim', () => {
  assert.deepEqual(resolveRealtimeKeyWithSource('openai', { apiKey: '  a  ' }), { key: 'a', source: 'config' });
  assert.deepEqual(
    resolveRealtimeKeyWithSource('openai', { keyResolver: () => '  v  ', env: { OPENAI_API_KEY: 'e' } }),
    { key: 'v', source: 'vault' },
  );
  assert.deepEqual(resolveRealtimeKeyWithSource('openai', { env: {} }), { key: null, source: 'none' });
  // Blank strings are "no key".
  assert.deepEqual(resolveRealtimeKeyWithSource('gemini', { apiKey: '   ', env: {} }), { key: null, source: 'none' });
});

test('v098 keygate: RealtimeKeyGate — register/decideAll/liveProviders/hasAnyLive', () => {
  const gate = new RealtimeKeyGate({ env: {} });
  assert.deepEqual(gate.liveProviders(), []);
  assert.equal(gate.hasAnyLive(), false);
  const all = gate.decideAll();
  assert.equal(all.openai.mode, 'mock');
  assert.equal(all.gemini.mode, 'mock');
  assert.equal(all['openai-compatible'].mode, 'mock');
  gate.registerResolver('gemini', () => 'gem-key');
  assert.deepEqual(gate.liveProviders(), ['gemini']);
  assert.equal(gate.hasAnyLive(), true);
  assert.equal(gate.decide('gemini').source, 'vault');
  assert.equal(gate.decide('openai').mode, 'mock');
  // Key-less local URL flips openai-compatible to live.
  const all2 = gate.decideAll({ 'openai-compatible': 'ws://127.0.0.1:9/v1/realtime' });
  assert.equal(all2['openai-compatible'].mode, 'live');
  assert.equal(all2['openai-compatible'].source, 'keyless-url');
  gate.unregisterResolver('gemini');
  assert.equal(gate.hasAnyLive(), false);
  // assertLive throws the same error the adapters throw.
  assert.throws(() => assertLive(gate.decide('openai')), (err) => err instanceof MissingRealtimeKeyError);
  assert.equal(assertLive(gate.decide('openai-compatible', { url: 'ws://127.0.0.1:9/v1/realtime' })).mode, 'live');
});

test('v098 keygate: model validation — gemini live-only, openai warning-only', () => {
  assert.equal(isGeminiLiveModel('gemini-live-2.5-flash-native-audio'), true);
  assert.equal(isGeminiLiveModel('models/gemini-live-2.5-flash-preview'), true);
  assert.equal(isGeminiLiveModel('gemini-2.5-flash'), false);
  assert.equal(isGeminiLiveModel('gemini-2.5-pro'), false);
  assert.equal(isGeminiLiveModel(''), false);
  assert.equal(isOpenAiRealtimeModel('gpt-4o-realtime-preview'), true);
  assert.equal(isOpenAiRealtimeModel('gpt-realtime'), true);
  assert.equal(isOpenAiRealtimeModel('gpt-4o'), false);
  // Gemini: non-live is a hard failure with the fix.
  const bad = validateRealtimeModel('gemini', 'gemini-2.5-flash');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not a Gemini Live model/);
  assert.match(bad.reason, /gemini-live-2.5-flash-native-audio/);
  assert.equal(validateRealtimeModel('gemini', 'gemini-live-2.5-flash-native-audio').ok, true);
  assert.equal(validateRealtimeModel('gemini', '').ok, true); // defaults to the live model
  // OpenAI: unknown model is a warning, not a block.
  const warn = validateRealtimeModel('openai', 'gpt-4o');
  assert.equal(warn.ok, true);
  assert.match(warn.reason, /not a known OpenAI Realtime model/);
  assert.equal(validateRealtimeModel('openai', 'gpt-4o-realtime-preview').ok, true);
  assert.equal(validateRealtimeModel('openai-compatible', 'anything-custom').ok, true);
});

// ---------------------------------------------------------------------------
// 2. Live probes (fake fetch / fake runner)
// ---------------------------------------------------------------------------

test('v098 probe: endpoint probe — HTTP 200/401 = reachable, throw/timeout = unreachable', async () => {
  const ok200 = await probeHttpsEndpoint('https://example.test/a', {
    fetchImpl: async () => ({ status: 200 }),
    timeoutMs: 1000,
  });
  assert.equal(ok200.reachable, true);
  assert.equal(ok200.statusCode, 200);
  assert.ok(ok200.latencyMs >= 0);
  assert.equal(ok200.error, '');
  // 401 without a key still proves the endpoint is up.
  const unauth = await probeHttpsEndpoint(GEMINI_ENDPOINT_PROBE_URL, {
    fetchImpl: async () => ({ status: 401 }),
  });
  assert.equal(unauth.reachable, true);
  assert.equal(unauth.statusCode, 401);
  const down = await probeHttpsEndpoint(OPENAI_ENDPOINT_PROBE_URL, {
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(down.reachable, false);
  assert.equal(down.statusCode, null);
  assert.equal(down.latencyMs, -1);
  assert.match(down.error, /Could not reach/);
  // Timeout → unreachable with a timeout reason (probe clamps
  // the timeout to a 100 ms floor).
  const slow = await probeHttpsEndpoint('https://example.test/slow', {
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      }),
    timeoutMs: 100,
  });
  assert.equal(slow.reachable, false);
  assert.match(slow.error, /within 100ms/);
  // Both endpoints in parallel.
  const both = await probeRealtimeEndpoints({
    fetchImpl: async (url) => ({ status: url.includes('googleapis') ? 400 : 405 }),
  });
  assert.equal(both.gemini.reachable, true);
  assert.equal(both.gemini.statusCode, 400);
  assert.equal(both.openai.statusCode, 405);
});

test('v098 probe: parseGeminiListModels — JSON lines + array, live detection, dedupe', () => {
  const stdout = [
    '{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}',
    '{"name": "models/gemini-live-2.5-flash-native-audio", "supportedGenerationMethods": ["bidiGenerateContent", "generateContent"]}',
    '{"name": "models/gemini-live-2.5-flash-native-audio", "supportedGenerationMethods": ["bidiGenerateContent"]}',
    'some progress text, not JSON',
    '{"name": "models/gemini-2.5-flash-preview-native-audio", "supportedGenerationMethods": ["generateContent"]}',
  ].join('\n');
  const models = parseGeminiListModels(stdout);
  assert.equal(models.length, 3, 'dedupe keeps 3 unique models');
  const live = models.filter((m) => m.liveCapable);
  assert.equal(live.length, 2, 'live model by id + live model by method');
  assert.ok(live.some((m) => m.id === 'gemini-live-2.5-flash-native-audio'));
  assert.ok(live.some((m) => m.id === 'gemini-2.5-flash-preview-native-audio'));
  assert.equal(models.find((m) => m.id === 'gemini-2.5-flash').liveCapable, false);
  // A JSON array parses too; garbage parses to nothing.
  assert.equal(parseGeminiListModels('[{"name":"models/a-live-x","supportedGenerationMethods":[]}]').length, 1);
  assert.deepEqual(parseGeminiListModels('no json here\nat all'), []);
  assert.deepEqual(parseGeminiListModels(''), []);
  // The real helper's plain-text shape: `models/<id> | m, m` + footer.
  const plain = parseGeminiListModels(
    'models/gemini-2.5-flash | generateContent, countTokens\n' +
      'models/gemini-live-2.5-flash-native-audio | bidiGenerateContent, generateContent\n' +
      '(2 models, HTTP 200)\n',
  );
  assert.equal(plain.length, 2);
  assert.equal(plain.find((m) => m.id === 'gemini-2.5-flash').liveCapable, false);
  assert.equal(plain.find((m) => m.id === 'gemini-live-2.5-flash-native-audio').liveCapable, true);
  assert.deepEqual(plain.find((m) => m.id === 'gemini-2.5-flash').supportedGenerationMethods, [
    'generateContent',
    'countTokens',
  ]);
});

test('v098 probe: connector probe — fake runner (success / exit code / empty / throw)', async () => {
  const good = await probeGeminiConnectorModels({
    runner: async () => ({
      stdout: '{"name": "models/gemini-live-2.5-flash-native-audio", "supportedGenerationMethods": ["bidiGenerateContent"]}\n{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}\n',
      stderr: '',
      code: 0,
    }),
  });
  assert.equal(good.available, true);
  assert.equal(good.liveModels.length, 1);
  assert.equal(good.liveModels[0].id, 'gemini-live-2.5-flash-native-audio');
  assert.deepEqual(good.modelIds, ['gemini-live-2.5-flash-native-audio', 'gemini-2.5-flash']);
  assert.ok(good.latencyMs >= 0);
  assert.equal(good.error, '');
  const failed = await probeGeminiConnectorModels({
    runner: async () => ({ stdout: '', stderr: '401 Unauthorized', code: 1 }),
  });
  assert.equal(failed.available, false);
  assert.match(failed.error, /exited with code 1/);
  assert.match(failed.error, /401/);
  const empty = await probeGeminiConnectorModels({
    runner: async () => ({ stdout: 'nothing usable\n', stderr: '', code: 0 }),
  });
  assert.equal(empty.available, false);
  assert.match(empty.error, /no models/);
  const threw = await probeGeminiConnectorModels({
    runner: async () => {
      throw new Error('spawn ENOENT');
    },
  });
  assert.equal(threw.available, false);
  assert.match(threw.error, /could not run/);
});

test('v098 probe: readiness combos — ready / no connector / no live models / endpoint down', async () => {
  const liveRunner = async () => ({
    stdout: '{"name": "models/gemini-live-2.5-flash-native-audio", "supportedGenerationMethods": ["bidiGenerateContent"]}\n',
    stderr: '',
    code: 0,
  });
  const okFetch = async () => ({ status: 400 });
  const ready = await probeGeminiLiveReadiness({ runner: liveRunner, fetchImpl: okFetch });
  assert.equal(ready.liveReady, true);
  assert.equal(ready.liveModels.length, 1);
  assert.match(ready.detail, /Gemini Live is ready/);
  assert.match(ready.detail, /gemini-live-2.5-flash-native-audio/);
  const noConnector = await probeGeminiLiveReadiness({
    runner: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
    fetchImpl: okFetch,
  });
  assert.equal(noConnector.liveReady, false);
  assert.match(noConnector.detail, /connector check failed/);
  const noLive = await probeGeminiLiveReadiness({
    runner: async () => ({
      stdout: '{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}\n',
      stderr: '',
      code: 0,
    }),
    fetchImpl: okFetch,
  });
  assert.equal(noLive.liveReady, false);
  assert.match(noLive.detail, /none is Live-capable/);
  const down = await probeGeminiLiveReadiness({
    runner: liveRunner,
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(down.liveReady, false);
  assert.match(down.detail, /endpoint unreachable/);
});

test('v098 probe: local proxy probe — 200 up, 500 down, unreachable down', async () => {
  const up = await probeLocalProxy({ port: 8765, fetchImpl: async () => ({ status: 200 }) });
  assert.equal(up.up, true);
  assert.equal(up.port, 8765);
  assert.ok(up.latencyMs >= 0);
  const bad = await probeLocalProxy({ port: 8765, fetchImpl: async () => ({ status: 500 }) });
  assert.equal(bad.up, false);
  assert.match(bad.error, /HTTP 500/);
  const down = await probeLocalProxy({
    port: 8765,
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(down.up, false);
  assert.match(down.error, /not running on 127.0.0.1:8765/);
});

// ---------------------------------------------------------------------------
// 3. Turn-taking measurement
// ---------------------------------------------------------------------------

test('v098 turn-taking: meter legs + budget + stats (fake clock)', () => {
  let now = 1000;
  const meter = new TurnTakingMeter({ clock: () => now, budgetMs: 500 });
  assert.equal(meter.measuring, false);
  assert.equal(meter.finish(), null, 'finish with nothing in flight is null');
  meter.begin('local_vad');
  assert.equal(meter.measuring, true);
  now += 12; // VAD → cancel
  meter.markCancelSent();
  now += 30; // cancel → flush
  meter.markFlushed();
  now += 8; // flush → listening
  const m = meter.finish();
  assert.ok(m);
  assert.equal(m.source, 'local_vad');
  assert.equal(m.totalMs, 50);
  assert.equal(m.vadToCancelMs, 12);
  assert.equal(m.cancelToFlushMs, 30);
  assert.equal(m.flushToListeningMs, 8);
  assert.equal(m.withinBudget, true);
  assert.equal(m.ttsStopLatencyMs, null);
  assert.equal(meter.measuring, false);
  // A slow one breaches the budget; stats aggregate.
  meter.begin('manual');
  now += 700;
  meter.markCancelSent();
  meter.markFlushed();
  const slow = meter.finish(150);
  assert.equal(slow.withinBudget, false);
  assert.equal(slow.ttsStopLatencyMs, 150);
  const stats = meter.stats();
  assert.equal(stats.count, 2);
  assert.equal(stats.minMs, 50);
  assert.equal(stats.maxMs, 700);
  assert.equal(stats.meanMs, 375);
  assert.equal(stats.p50Ms, 50);
  assert.equal(stats.p95Ms, 700);
  assert.equal(stats.lastMs, 700);
  assert.equal(stats.breaches, 1);
  assert.equal(stats.budgetMs, 500);
  assert.deepEqual(meter.all().map((x) => x.totalMs), [50, 700]);
  assert.equal(meter.last().totalMs, 700);
  // cancel() drops an in-flight measurement without recording.
  meter.begin('server_vad');
  meter.cancel();
  assert.equal(meter.finish(), null);
  assert.equal(meter.stats().count, 2);
  meter.reset();
  assert.deepEqual(meter.stats(), emptyTurnTakingStats());
});

test('v098 turn-taking: summarizeBargeInMeasurements pure (empty + breach count)', () => {
  assert.deepEqual(summarizeBargeInMeasurements([]), emptyTurnTakingStats());
  const made = (totalMs) => ({
    source: 'manual',
    detectedAt: 0,
    cancelSentAt: 0,
    flushedAt: 0,
    listeningAt: totalMs,
    totalMs,
    vadToCancelMs: 0,
    cancelToFlushMs: 0,
    flushToListeningMs: totalMs,
    withinBudget: totalMs <= BARGE_IN_TOTAL_BUDGET_MS,
    ttsStopLatencyMs: null,
  });
  const s = summarizeBargeInMeasurements([made(10), made(20), made(600)]);
  assert.equal(s.count, 3);
  assert.equal(s.meanMs, 210);
  assert.equal(s.breaches, 1);
});

test('v098 turn-taking: runMockBargeInProbe — session thật + mock transport, đo < 500ms', async () => {
  const sockets = [];
  const sink = new MockAudioSink(24000);
  const queue = new TtsQueue({ harness: new TtsHarness([new MockTtsEngine()]) });
  const events = [];
  const result = await runMockBargeInProbe({
    ttsQueue: queue,
    // Fake socket factory (auto-open): the probe never dials a
    // real endpoint, and connect() resolves on its own.
    connectConfig: { apiKey: 'probe-key', model: 'mock', socketFactory: makeAutoOpenSocketFactory(sockets) },
    createSession: () =>
      new RealtimeSession({
        provider: 'openai',
        transportFactory: (cb) => new OpenAiRealtimeTransport(cb),
        audioSink: sink,
        ttsQueue: queue,
        onEvent: (e) => events.push(e),
      }),
    makeModelSpeak: async (session) => {
      // The probe connected already; drive the model-audio event
      // through the captured fake socket so the session is speaking.
      const socket = sockets[0];
      assert.ok(socket, 'socket must be captured');
      socket.receive({ type: 'response.audio.delta', delta: AUDIO_B64 });
      assert.equal(session.getState(), 'speaking');
    },
  });
  assert.ok(result.measurement.totalMs < BARGE_IN_TOTAL_BUDGET_MS, `barge-in took ${result.measurement.totalMs}ms`);
  assert.equal(result.measurement.withinBudget, true);
  assert.equal(result.backToListening, true);
  assert.equal(result.bargeInCount, 1);
  assert.equal(result.stats.count, 1);
  console.log(
    `v098 turn-taking probe: barge-in ${result.measurement.totalMs}ms ` +
      `(vad→cancel ${result.measurement.vadToCancelMs}ms, cancel→flush ${result.measurement.cancelToFlushMs}ms, ` +
      `flush→listening ${result.measurement.flushToListeningMs}ms), budget ${BARGE_IN_TOTAL_BUDGET_MS}ms`,
  );
});

test('v098 turn-taking: session barge-in — event + getters + local_vad/server_vad paths', async () => {
  const sockets = [];
  const sink = new MockAudioSink(24000);
  const events = [];
  const session = new RealtimeSession({
    provider: 'openai',
    turnMode: 'local_vad',
    transportFactory: (cb) => new OpenAiRealtimeTransport(cb),
    audioSink: sink,
    onEvent: (e) => events.push(e),
  });
  const connecting = session.connect({
    apiKey: 'test-key',
    socketFactory: makeSocketFactory(sockets),
    model: 'gpt-4o-realtime-preview',
  });
  sockets[0].open();
  await connecting;
  // Model speaks.
  sockets[0].receive({ type: 'response.audio.delta', delta: AUDIO_B64 });
  assert.equal(session.getState(), 'speaking');
  // Local VAD hears the user → barge-in via local_vad.
  session.pushAudioFrame(sinePcm16Frame(1600, 0.2, 440, 16000));
  assert.equal(session.getState(), 'listening');
  assert.equal(session.getBargeInCount(), 1);
  const m = session.getLastBargeIn();
  assert.ok(m, 'last barge-in measured');
  assert.equal(m.source, 'local_vad');
  assert.ok(m.totalMs < BARGE_IN_TOTAL_BUDGET_MS);
  assert.equal(m.withinBudget, true);
  assert.equal(session.getBargeInStats().count, 1);
  assert.ok(events.some((e) => e.kind === 'barge-in-measured' && e.measurement.source === 'local_vad'));
  assert.ok(events.some((e) => e.kind === 'interrupted' && e.source === 'local_vad'));
  // Server VAD path: model speaks again, server speech_started barges in.
  sockets[0].receive({ type: 'response.audio.delta', delta: AUDIO_B64 });
  assert.equal(session.getState(), 'speaking');
  sockets[0].receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(session.getState(), 'listening');
  assert.equal(session.getBargeInCount(), 2);
  assert.equal(session.getLastBargeIn().source, 'server_vad');
  assert.equal(session.getBargeInStats().count, 2);
  // interrupt() when not speaking: false, no new measurement.
  assert.equal(session.interrupt(), false);
  assert.equal(session.getBargeInStats().count, 2);
  session.disconnect();
  assert.equal(session.getState(), 'closed');
});

// ---------------------------------------------------------------------------
// 4. Chunked / streaming STT
// ---------------------------------------------------------------------------

test('v098 whisper: splitAudioOnSilence — spans at quiet gaps, blips dropped', () => {
  // 1 s speech, 0.6 s silence, 1 s speech, 0.6 s silence,
  // 0.1 s blip, 0.6 s silence. (The blip needs its own silence
  // gap — a blip glued to the speech would extend that span.)
  const speech = sinePcm16Frame(16000, 0.2, 440, 16000);
  const silence = silencePcm16Frame(9600);
  const blip = sinePcm16Frame(1600, 0.2, 440, 16000);
  const pcm = new Uint8Array(speech.length * 2 + silence.length * 3 + blip.length);
  let off = 0;
  for (const part of [speech, silence, speech, silence, blip, silence]) {
    pcm.set(part, off);
    off += part.length;
  }
  const spans = splitAudioOnSilence(pcm, { minSilenceMs: 400, minSegmentMs: 200 });
  assert.equal(spans.length, 2, 'two speech spans; the 100 ms blip is dropped');
  assert.ok(Math.abs(spans[0].startMs - 0) <= 25, `span0 start ${spans[0].startMs}`);
  assert.ok(Math.abs(spans[0].endMs - 1000) <= 25, `span0 end ${spans[0].endMs}`);
  assert.ok(Math.abs(spans[1].startMs - 1600) <= 25, `span1 start ${spans[1].startMs}`);
  assert.ok(Math.abs(spans[1].endMs - 2600) <= 25, `span1 end ${spans[1].endMs}`);
  assert.equal(spans[0].pcm16.length, spans[0].endSample * 2 - spans[0].startSample * 2);
  // All silence → no spans.
  assert.deepEqual(splitAudioOnSilence(silencePcm16Frame(16000)), []);
  // Invalid input throws.
  assert.throws(() => splitAudioOnSilence(new Uint8Array([1])), /non-empty even-length/);
});

test('v098 whisper: dedupeChunkOverlap — longest suffix/prefix match, case-insensitive', () => {
  assert.equal(dedupeChunkOverlap('hello world this is', 'this is a test'), 'a test');
  assert.equal(dedupeChunkOverlap('Hello World.', 'world this is'), 'this is');
  assert.equal(dedupeChunkOverlap('one two three', 'four five six'), 'four five six');
  assert.equal(dedupeChunkOverlap('', 'hello world'), 'hello world');
  assert.equal(dedupeChunkOverlap('hello world', ''), '');
  // Only the longest match is dropped (not a partial word).
  assert.equal(dedupeChunkOverlap('the quick brown fox', 'brown fox jumps'), 'jumps');
});

test('v098 whisper: ChunkedWhisperStt — 1 chunk short, N chunks long + dedupe join', async () => {
  // Mock engine: returns one line per call, scripted.
  const engine = new MockLocalSttEngine(['hello world']);
  const chunked = new ChunkedWhisperStt(engine);
  assert.equal(chunked.isAvailable(), true);
  // Short audio (1 s) → exactly one engine call.
  const short = sinePcm16Frame(16000, 0.2, 440, 16000);
  const r1 = await chunked.transcribeChunked(short, { chunkMs: 30000 });
  assert.equal(r1.chunkCount, 1);
  assert.equal(r1.text, 'hello world');
  assert.equal(engine.calls.length, 1);
  // Long audio (5 s) with 2 s chunks + 0.5 s overlap → 3 chunks;
  // the engine repeats "hello world" per chunk, dedupe drops the
  // repeated prefix words on join.
  const repeating = new MockLocalSttEngine(['alpha beta gamma', 'beta gamma delta', 'gamma delta epsilon']);
  const chunked2 = new ChunkedWhisperStt(repeating);
  const long = sinePcm16Frame(16000 * 5, 0.2, 440, 16000);
  const r2 = await chunked2.transcribeChunked(long, { chunkMs: 2000, overlapMs: 500 });
  assert.equal(r2.chunkCount, 3);
  assert.equal(r2.text, 'alpha beta gamma delta epsilon');
  assert.ok(r2.totalMs >= 0);
  assert.equal(r2.chunks[0].startMs, 0);
  assert.ok(r2.chunks[2].endMs >= 4500);
  // Unavailable engine throws loudly.
  const failing = {
    id: 'down',
    isAvailable: () => false,
    status: () => ({ available: false, engineId: null, binaryPath: null, modelPath: null, reason: 'no engine here' }),
    transcribe: async () => {
      throw new Error('never called');
    },
  };
  const chunked3 = new ChunkedWhisperStt(failing);
  await assert.rejects(chunked3.transcribeChunked(short), /no engine here/);
  await assert.rejects(chunked3.transcribeChunked(new Uint8Array([1])), /no engine here|non-empty/);
});

test('v098 whisper: transcribeSegmented — silence split first, then chunk', async () => {
  const engine = new MockLocalSttEngine(['first part', 'second part']);
  const chunked = new ChunkedWhisperStt(engine);
  const speech = sinePcm16Frame(16000, 0.2, 440, 16000);
  const silence = silencePcm16Frame(16000);
  const pcm = new Uint8Array(speech.length * 2 + silence.length);
  pcm.set(speech, 0);
  pcm.set(silence, speech.length);
  pcm.set(speech, speech.length + silence.length);
  const res = await chunked.transcribeSegmented(pcm, { minSilenceMs: 400 });
  assert.equal(res.segmentCount, 2);
  assert.equal(res.text, 'first part second part');
  // All silence → empty, no engine call.
  const empty = await chunked.transcribeSegmented(silencePcm16Frame(32000));
  assert.equal(empty.text, '');
  assert.equal(empty.segmentCount, 0);
});

test('v098 whisper: runWerBenchmark — mock engine scores 0; failing case recorded, not fatal', async () => {
  const engine = new MockLocalSttEngine(['hello world', 'the quick brown fox']);
  const pcm = sinePcm16Frame(16000, 0.2, 440, 16000);
  const result = await runWerBenchmark(engine, [
    { name: 'a', reference: 'hello world', pcm16: pcm },
    { name: 'b', reference: 'the quick brown fox', pcm16: pcm },
  ]);
  assert.equal(result.caseCount, 2);
  assert.equal(result.meanWer, 0);
  assert.equal(result.maxWer, 0);
  assert.equal(result.cases[0].wer, 0);
  assert.equal(result.cases[1].hypWords, 4);
  // A failing engine is recorded (wer 1), not fatal.
  const failing = {
    id: 'failing',
    isAvailable: () => true,
    status: () => ({ available: true, engineId: 'failing', binaryPath: null, modelPath: null }),
    transcribe: async () => {
      throw new Error('engine boom');
    },
  };
  const bad = await runWerBenchmark(failing, [{ name: 'x', reference: 'hello', pcm16: pcm }]);
  // WER can exceed 1: hypothesis 'ERROR: engine boom' is 3 words
  // against a 1-word reference (1 substitution + 2 insertions).
  assert.equal(bad.cases[0].wer, 3);
  assert.equal(bad.cases[0].substitutions, 1);
  assert.equal(bad.cases[0].insertions, 2);
  assert.match(bad.cases[0].hypothesis, /ERROR: engine boom/);
  // Chunked engine path works through the same harness.
  const chunked = new ChunkedWhisperStt(new MockLocalSttEngine(['hello world']));
  const chunkedResult = await runWerBenchmark(chunked, [{ name: 'c', reference: 'hello world', pcm16: pcm }]);
  assert.equal(chunkedResult.meanWer, 0);
});

test('v098 whisper: StreamingSttSession — VAD segment → result + scoreReference + report', async () => {
  const results = [];
  const session = new StreamingSttSession({
    engine: new MockLocalSttEngine(['xin chào open-bot']),
    callbacks: { onResult: (r) => results.push(r) },
  });
  assert.equal(session.isSpeaking(), false);
  for (let i = 0; i < 25; i++) session.feed(sinePcm16Frame(320, 0.2, 440, 16000)); // 500 ms
  for (let i = 0; i < 20; i++) session.feed(silencePcm16Frame(320));
  await session.drain();
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'xin chào open-bot');
  assert.equal(results[0].index, 0);
  assert.ok(results[0].segmentMs >= 400);
  const wer = session.scoreReference('xin chào open-bot');
  assert.equal(wer.wer, 0);
  const report = session.getEvalReport();
  assert.equal(report.segments, 1);
  assert.equal(report.failures, 0);
  assert.equal(report.meanWer, 0);
  assert.equal(report.lastText, 'xin chào open-bot');
  assert.ok(report.meanTranscribeMs >= 0);
  session.dispose();
  assert.throws(() => session.feed(sinePcm16Frame(320)), /disposed/);
  // Chunked engine behind the session works too.
  const s2 = new StreamingSttSession({
    engine: new ChunkedWhisperStt(new MockLocalSttEngine(['chunked hello'])),
    callbacks: {},
  });
  for (let i = 0; i < 25; i++) s2.feed(sinePcm16Frame(320, 0.2, 440, 16000));
  for (let i = 0; i < 20; i++) s2.feed(silencePcm16Frame(320));
  await s2.drain();
  assert.equal(s2.transcribedCount, 1);
  assert.equal(s2.getEvalReport().lastText, 'chunked hello');
  s2.dispose();
});

test('v098 whisper: ChunkedEngineAdapter — chunked engine as a plain engine', async () => {
  const adapter = new ChunkedEngineAdapter(new ChunkedWhisperStt(new MockLocalSttEngine(['adapted']))); 
  assert.equal(adapter.id, 'chunked-whisper');
  assert.equal(adapter.isAvailable(), true);
  assert.equal(await adapter.transcribe(sinePcm16Frame(16000, 0.2, 440, 16000)), 'adapted');
});

// ---------------------------------------------------------------------------
// 5. localStt detailed transcription (fake runner)
// ---------------------------------------------------------------------------

test('v098 localStt: defaultWhisperThreads — cgroup quota, not host CPUs', async () => {
  const { defaultWhisperThreads } = await import('../packages/core/dist/voice/localStt.js');
  const threads = defaultWhisperThreads();
  assert.ok(Number.isInteger(threads) && threads >= 1 && threads <= 4, `threads=${threads}`);
  // On this VM the cgroup allows 1.5 CPUs while the host reports 4 —
  // the default must follow the quota (2), not the host (4).
  assert.equal(threads, 2);
});

test('v098 localStt: parseWhisperTimestamp — HH:MM:SS,mmm + MM:SS.mmm', () => {
  assert.equal(parseWhisperTimestamp('00:00:03,620'), 3620);
  assert.equal(parseWhisperTimestamp('01:02:03,004'), 3723004);
  assert.equal(parseWhisperTimestamp('00:03.620'), 3620);
  assert.equal(parseWhisperTimestamp('garbage'), null);
  assert.equal(parseWhisperTimestamp(undefined), null);
  assert.equal(parseWhisperTimestamp(123), null);
});

test('v098 localStt: transcribeDetailed — fake runner writes .txt + .json, segments parsed', async () => {
  // Fake binary + model on disk (empty files — the runner never execs them).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v098-fake-whisper-'));
  const fakeBin = path.join(dir, 'whisper-cli');
  const fakeModel = path.join(dir, 'ggml-tiny.bin');
  fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeBin, 0o755);
  fs.writeFileSync(fakeModel, 'fake-model');
  const seenArgs = [];
  const runner = async (_bin, args, _timeoutMs) => {
    seenArgs.push([...args]);
    const ofIndex = args.indexOf('-of');
    assert.notEqual(ofIndex, -1, 'runner expected -of <prefix> in argv');
    const prefix = args[ofIndex + 1];
    fs.writeFileSync(`${prefix}.txt`, 'Hello world, this is a test.\n');
    fs.writeFileSync(
      `${prefix}.json`,
      JSON.stringify({
        transcription: [
          { timestamps: { from: '00:00:00,000', to: '00:00:01,500' }, text: ' Hello world,' },
          { timestamps: { from: '00:00:01,500', to: '00:00:03,620' }, text: ' this is a test.' },
        ],
      }),
    );
    return { stdout: '', stderr: '', code: 0 };
  };
  // Temporarily put the fake dir first on PATH so the engine
  // finds the fake binary; the model still comes from the
  // machine's real locations (~/.cache/whisper) — skip when
  // unavailable (fresh machine without a model).
  const oldPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const engine2 = new WhisperCliSttEngine({ runner });
    if (!engine2.isAvailable()) {
      console.log('v098 localStt detailed: SKIP — no real whisper model on PATH-visible locations');
      return;
    }
    const pcm = sinePcm16Frame(16000 * 3, 0.2, 440, 16000);
    const detailed = await engine2.transcribeDetailed(pcm, { language: 'en', threads: 2 });
    assert.equal(detailed.text, 'Hello world, this is a test.');
    assert.equal(detailed.segments.length, 2);
    assert.equal(detailed.segments[0].startMs, 0);
    assert.equal(detailed.segments[0].endMs, 1500);
    assert.equal(detailed.segments[1].endMs, 3620);
    assert.ok(detailed.durationMs >= 0);
    // Threads flag reached the CLI.
    assert.ok(seenArgs.flat().includes('-t'), 'expected -t <threads> in argv');
    assert.ok(seenArgs.flat().includes('2'), 'expected threads=2 in argv');
    assert.ok(seenArgs.flat().includes('-ojf'), 'expected -ojf in argv');
    // transcribe() is the detailed text.
    assert.equal(await engine2.transcribe(pcm, { language: 'en' }), 'Hello world, this is a test.');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v098 localStt: transcribeDetailed falls back to .txt when JSON is missing', async () => {
  const oldPath = process.env.PATH ?? '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v098-fake-whisper2-'));
  const fakeBin = path.join(dir, 'whisper-cli');
  fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeBin, 0o755);
  const runner = async (_bin, args, _timeoutMs) => {
    const ofIndex = args.indexOf('-of');
    const prefix = args[ofIndex + 1];
    fs.writeFileSync(`${prefix}.txt`, 'Only text, no JSON.\n');
    // No .json written — the engine must still return the text.
    return { stdout: '', stderr: '', code: 0 };
  };
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const engine = new WhisperCliSttEngine({ runner });
    if (!engine.isAvailable()) {
      console.log('v098 localStt fallback: SKIP — no real whisper model available');
      return;
    }
    const detailed = await engine.transcribeDetailed(sinePcm16Frame(16000, 0.2, 440, 16000));
    assert.equal(detailed.text, 'Only text, no JSON.');
    assert.deepEqual(detailed.segments, []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Adapter model gate + fallback factory
// ---------------------------------------------------------------------------

test('v098 adapter: gemini connect with a plain text model fails fast, never dials', async () => {
  const sockets = [];
  const transport = new GeminiLiveTransport({});
  await assert.rejects(
    transport.connect({
      provider: 'gemini',
      apiKey: 'test-key',
      socketFactory: makeSocketFactory(sockets),
      model: 'gemini-2.5-flash',
    }),
    (err) => {
      assert.match(err.message, /not a Gemini Live model/);
      return true;
    },
  );
  assert.equal(sockets.length, 0, 'must not dial with a non-live model');
  // The live model dials (mock WS server answers setupComplete).
  const connected = transport.connect({
    provider: 'gemini',
    apiKey: 'test-key',
    socketFactory: makeSocketFactory(sockets),
    model: 'gemini-live-2.5-flash-native-audio',
  });
  sockets[0].open();
  sockets[0].receive({ setupComplete: {} });
  await connected;
  assert.equal(transport.isConnected(), true);
  transport.disconnect();
});

test('v098 fallback: choose live vs mock from the gate decision', () => {
  const liveDecision = decideRealtimeMode('openai', { apiKey: 'k', env: {} });
  const { transport: live, choice: liveChoice } = chooseRealtimeTransport('openai', liveDecision, {});
  assert.equal(liveChoice.mode, 'live');
  assert.equal(liveChoice.mock, false);
  assert.equal(isMockFallbackChoice(liveChoice), false);
  assert.equal(isMockRealtimeTransport(live), false);
  const mockDecision = decideRealtimeMode('gemini', { env: {} });
  const { transport: mock, choice: mockChoice } = chooseRealtimeTransport('gemini', mockDecision, {});
  assert.equal(mockChoice.mode, 'mock');
  assert.equal(mockChoice.mock, true);
  assert.equal(isMockFallbackChoice(mockChoice), true);
  assert.equal(isMockRealtimeTransport(mock), true);
  assert.equal(mock.getHealth().mock, true);
  // Provider mismatch is a loud error, not a wrong transport.
  assert.throws(
    () => chooseRealtimeTransport('openai', mockDecision, {}),
    /decision is for gemini, not openai/,
  );
  // decide+choose in one call (the main path).
  const { choice: c2 } = decideAndChooseRealtimeTransport(
    'openai-compatible',
    { url: 'ws://127.0.0.1:9/v1/realtime', env: {} },
    {},
  );
  assert.equal(c2.mode, 'live');
  const { choice: c3, transport: t3 } = decideAndChooseRealtimeTransport('gemini', { env: {} }, {});
  assert.equal(c3.mode, 'mock');
  assert.equal(isMockRealtimeTransport(t3), true);
});

// ---------------------------------------------------------------------------
// 7. Diagnostics
// ---------------------------------------------------------------------------

test('v098 diagnostics: no key → mock realtime, nextStep names the key; key → ready', () => {
  const gate = new RealtimeKeyGate({ env: {} });
  const report = collectVoiceDiagnostics({ keyGate: gate });
  assert.equal(report.realtime.readiness, 'mock');
  assert.deepEqual(report.realtime.liveProviders, []);
  assert.equal(report.realtime.providers.openai.needsKey, true);
  assert.match(report.summary.realtime, /mock mode/);
  assert.match(report.nextStep, /API key in Settings/);
  assert.equal(voiceDiagnosticsVerdict(report), report.localStt.readiness === 'ready' ? 'mock' : 'missing');
  // With a vault key, realtime is ready.
  gate.registerResolver('gemini', () => 'gem-key');
  const report2 = collectVoiceDiagnostics({
    keyGate: gate,
    sttEngine: new MockLocalSttEngine(['x']),
    turnTakingStats: summarizeBargeInMeasurements([]),
  });
  assert.equal(report2.realtime.readiness, 'ready');
  assert.deepEqual(report2.realtime.liveProviders, ['gemini']);
  assert.equal(report2.localStt.readiness, 'ready');
  assert.equal(report2.localStt.available, true);
  assert.match(report2.summary.turnTaking, /No barge-in measured yet/);
  assert.equal(voiceDiagnosticsVerdict(report2), 'ready');
  assert.match(report2.nextStep, /interrupt the bot once/);
  // A broken gate reports missing, never throws.
  const brokenGate = { decideAll: () => { throw new Error('gate boom'); } };
  const report3 = collectVoiceDiagnostics({ keyGate: brokenGate });
  assert.equal(report3.realtime.readiness, 'mock');
  assert.match(report3.realtime.providers.openai.reason, /gate boom/);
});

// ---------------------------------------------------------------------------
// 8. i18n — new keys in all 6 locales
// ---------------------------------------------------------------------------

test('v098 i18n: barge-in stats keys exist in all 6 locales with placeholders intact', () => {
  const localesDir = path.join(process.cwd(), 'apps/desktop/src/renderer/i18n/locales');
  for (const locale of ['en', 'vi', 'zh', 'ja', 'es', 'fr']) {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'));
    const stats = data['voice.realtime.live.bargeInStats'];
    const breaches = data['voice.realtime.live.bargeInBreaches'];
    assert.ok(typeof stats === 'string' && stats.length > 0, `${locale}: bargeInStats missing`);
    assert.ok(typeof breaches === 'string' && breaches.length > 0, `${locale}: bargeInBreaches missing`);
    for (const ph of ['{count}', '{mean}', '{p95}', '{last}', '{budget}']) {
      assert.ok(stats.includes(ph), `${locale}: bargeInStats missing placeholder ${ph}`);
    }
    assert.ok(breaches.includes('{breaches}'), `${locale}: bargeInBreaches missing placeholder`);
  }
});

// ---------------------------------------------------------------------------
// 9. Live verification runner + whisper model inventory
// ---------------------------------------------------------------------------

test('v098 liveVerify: sections skip/pass/fail independently (fakes)', async () => {
  const allSkipped = await runVoiceLiveVerification({
    probeEndpoints: false,
    probeGemini: false,
    probeProxy: false,
    sttEngine: new MockLocalSttEngine(['x']),
  });
  assert.equal(allSkipped.ranSections, 1, 'only whisper runs (engine status, no cases)');
  assert.equal(allSkipped.endpoints.status, 'skipped');
  assert.equal(allSkipped.gemini.status, 'skipped');
  assert.equal(allSkipped.localProxy.status, 'skipped');
  assert.equal(allSkipped.bargeIn.status, 'skipped');
  assert.equal(allSkipped.whisper.status, 'pass');
  assert.match(allSkipped.whisper.detail, /no benchmark cases/);
  const summary = summarizeVoiceLiveVerification(allSkipped);
  assert.match(summary, /1\/1 sections passed/);
  // Endpoints up + proxy up + whisper benchmark WER 0 → all pass.
  const allPass = await runVoiceLiveVerification({
    probeEndpoints: true,
    probeGemini: false,
    probeProxy: true,
    fetchImpl: async () => ({ status: 200 }),
    sttEngine: new MockLocalSttEngine(['hello world']),
    whisperCases: [{ name: 'a', reference: 'hello world', pcm16: sinePcm16Frame(16000, 0.2, 440, 16000) }],
  });
  assert.equal(allPass.endpoints.status, 'pass');
  assert.equal(allPass.localProxy.status, 'pass');
  assert.equal(allPass.whisper.status, 'pass');
  assert.equal(allPass.whisper.benchmark.meanWer, 0);
  assert.equal(allPass.passedSections, allPass.ranSections);
  // Endpoints down → fail, but the run still reports the rest.
  const down = await runVoiceLiveVerification({
    probeEndpoints: true,
    probeGemini: false,
    probeProxy: false,
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
    sttEngine: new MockLocalSttEngine(['x']),
  });
  assert.equal(down.endpoints.status, 'fail');
  assert.equal(down.whisper.status, 'pass');
  assert.match(down.endpoints.detail, /reachable=false/);
  // Gemini readiness via fakes.
  const geminiOk = await runVoiceLiveVerification({
    probeEndpoints: false,
    probeGemini: true,
    probeProxy: false,
    fetchImpl: async () => ({ status: 400 }),
    connectorRunner: async () => ({
      stdout: '{"name": "models/gemini-live-2.5-flash-native-audio", "supportedGenerationMethods": ["bidiGenerateContent"]}\n',
      stderr: '',
      code: 0,
    }),
    sttEngine: new MockLocalSttEngine(['x']),
  });
  assert.equal(geminiOk.gemini.status, 'pass');
  assert.equal(geminiOk.gemini.readiness.liveReady, true);
});

test('v098 whisperModels: parse/list/recommend on a fake model dir', () => {
  assert.equal(parseWhisperModelFileName('ggml-tiny.bin'), 'tiny');
  assert.equal(parseWhisperModelFileName('ggml-small.en.bin'), 'small.en');
  assert.equal(parseWhisperModelFileName('not-a-model.bin'), null);
  assert.equal(parseWhisperModelFileName('ggml-tiny.gguf'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v098-models-'));
  try {
    fs.writeFileSync(path.join(dir, 'ggml-tiny.bin'), Buffer.alloc(1024 * 1024 * 75));
    fs.writeFileSync(path.join(dir, 'ggml-base.bin'), Buffer.alloc(1024 * 1024 * 10)); // truncated base
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a model');
    const models = listLocalWhisperModels([dir]);
    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'base', 'sorted by size (base 10MB < tiny 75MB here)');
    assert.equal(models[1].id, 'tiny');
    assert.equal(models[1].isDefaultPick, true, 'tiny is the earliest candidate present');
    assert.equal(models[0].isDefaultPick, false);
    assert.equal(isCompleteWhisperModel(path.join(dir, 'ggml-tiny.bin')), true);
    assert.equal(isCompleteWhisperModel(path.join(dir, 'ggml-base.bin')), false, 'truncated base is incomplete');
    assert.equal(isCompleteWhisperModel(path.join(dir, 'notes.txt')), false);
    assert.equal(isCompleteWhisperModel(path.join(dir, 'missing.bin')), false);
    // Default recommendation: smallest (tiny here is bigger than the
    // truncated base — smallest wins regardless of completeness).
    assert.equal(recommendWhisperModel(models).id, 'base');
    // preferAccuracy on this few-CPU VM still picks the smallest.
    assert.equal(recommendWhisperModel(models, { preferAccuracy: true }).id, 'base');
    // Non-English want prefers multilingual models.
    assert.equal(recommendWhisperModel(models, { wantLanguages: ['vi'] }).id, 'base');
    assert.equal(recommendWhisperModel([]), null);
    assert.equal(expectedWhisperModelSizeMb('tiny'), 75);
    assert.equal(expectedWhisperModelSizeMb('unknown-model'), null);
    assert.match(whisperModelDownloadCommand('tiny'), /ggml-tiny\.bin/);
    assert.ok(availableCpuCount() >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Real machine inventory: tiny must be present (v0.96 installed it).
  const real = listLocalWhisperModels();
  const tiny = real.find((m) => m.id === 'tiny');
  if (tiny) {
    console.log(`v098 whisperModels live: found ${real.map((m) => `${m.id} (${m.sizeMb}MB)`).join(', ')}`);
    assert.ok(tiny.sizeMb >= 70 && tiny.sizeMb <= 80, `tiny size ${tiny.sizeMb}MB`);
    assert.equal(tiny.isDefaultPick, true);
  } else {
    console.log('v098 whisperModels live: no models found (fresh machine?)');
  }
});

// ---------------------------------------------------------------------------
// 10. Live: real network + real connector helper + real whisper
// ---------------------------------------------------------------------------

/** Run a command, return stdout Buffer (or null when the binary is missing). */
function tryRun(argv, options = {}) {
  try {
    return execFileSync(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024, ...options });
  } catch {
    return null;
  }
}

test('v098 live: unauthenticated endpoint probes (real network, shape only)', async () => {
  const { gemini, openai } = await probeRealtimeEndpoints({ timeoutMs: 8000 });
  for (const [name, r] of [['gemini', gemini], ['openai', openai]]) {
    assert.equal(typeof r.reachable, 'boolean');
    assert.ok(r.latencyMs === -1 || r.latencyMs >= 0);
    console.log(`v098 live endpoint ${name}: reachable=${r.reachable} status=${r.statusCode} latency=${r.latencyMs}ms${r.error ? ` error=${r.error}` : ''}`);
  }
  // Local proxy is expected to be down unless the user started it.
  const proxy = await probeLocalProxy({ timeoutMs: 2000 });
  console.log(`v098 live local proxy: up=${proxy.up}${proxy.error ? ` (${proxy.error})` : ` latency=${proxy.latencyMs}ms`}`);
  assert.equal(typeof proxy.up, 'boolean');
});

test('v098 live: gemini connector probe (real helper, real key via connector)', async () => {
  const result = await probeGeminiConnectorModels({ timeoutMs: 30000 });
  if (!result.available) {
    console.log(`v098 live gemini connector: UNAVAILABLE — ${result.error}`);
    assert.ok(result.error.length > 0, 'probe must explain why');
    return;
  }
  console.log(
    `v098 live gemini connector: ${result.modelIds.length} model(s) in ${result.latencyMs}ms, ` +
      `live-capable: ${result.liveModels.map((m) => m.id).join(', ') || '(none)'}`,
  );
  assert.ok(result.modelIds.length > 0);
  const readiness = await probeGeminiLiveReadiness({ timeoutMs: 30000 });
  console.log(`v098 live gemini readiness: liveReady=${readiness.liveReady} — ${readiness.detail}`);
  assert.equal(typeof readiness.liveReady, 'boolean');
});

test('v098 live: whisper thật — transcribeDetailed + chunked + WER benchmark', async () => {
  const stt = detectLocalStt();
  if (!stt.isAvailable()) {
    console.log(`v098 live whisper: MOCK-ONLY — ${stt.status().reason}`);
    assert.equal(stt.status().available, false);
    return;
  }
  console.log(`v098 live whisper: engine ${stt.status().binaryPath}, model ${stt.status().modelPath}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-voice-live-v098-'));
  try {
    const makePcm = (text) => {
      const wav = tryRun(['espeak-ng', '--stdout', '-v', 'en', '-s', '150', text]);
      assert.ok(wav && wav.length > 1000, 'espeak-ng must synthesise audio');
      const wavPath = path.join(dir, `ref-${Date.now()}-${Math.random()}.wav`);
      const pcmPath = `${wavPath}.pcm`;
      fs.writeFileSync(wavPath, wav);
      const converted = tryRun(['ffmpeg', '-y', '-v', 'error', '-i', wavPath, '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath]);
      assert.ok(converted !== null || fs.existsSync(pcmPath), 'ffmpeg must convert to 16k mono PCM');
      return new Uint8Array(fs.readFileSync(pcmPath));
    };
    const ref1 = 'hello world, this is a test of local speech recognition';
    const pcm1 = makePcm(ref1);
    // Detailed (timed segments) with 2 threads — the measured path.
    const detailed = await stt.transcribeDetailed(pcm1, { language: 'en', threads: 2, timeoutMs: 180000 });
    const wer1 = wordErrorRate(ref1, detailed.text);
    console.log(
      `v098 live whisper detailed: "${detailed.text}" (WER ${wer1.wer}, ${detailed.durationMs}ms, ` +
        `${detailed.segments.length} segment(s))`,
    );
    assert.ok(detailed.text.length > 0);
    assert.ok(wer1.wer <= 0.6, `WER ${wer1.wer} too high for a clear synthetic voice`);
    for (let i = 1; i < detailed.segments.length; i++) {
      assert.ok(detailed.segments[i].startMs >= detailed.segments[i - 1].startMs, 'segments must be time-ordered');
    }
    // Chunked path on the same audio (single chunk) + WER benchmark.
    const chunked = new ChunkedWhisperStt(stt);
    const ref2 = 'the quick brown fox jumps over the lazy dog';
    const pcm2 = makePcm(ref2);
    const bench = await runWerBenchmark(
      chunked,
      [
        { name: 'hello-world', reference: ref1, pcm16: pcm1 },
        { name: 'quick-fox', reference: ref2, pcm16: pcm2 },
      ],
      { language: 'en', threads: 2, timeoutMs: 180000 },
    );
    for (const c of bench.cases) {
      console.log(`v098 live whisper bench ${c.name}: "${c.hypothesis}" (WER ${c.wer}, ${c.transcribeMs}ms)`);
    }
    console.log(`v098 live whisper bench: mean WER ${bench.meanWer}, max WER ${bench.maxWer}, total ${bench.totalMs}ms`);
    assert.ok(bench.meanWer <= 0.6, `mean WER ${bench.meanWer} too high`);
    // Streaming session end-to-end on the same audio (VAD → segment → STT).
    const results = [];
    const stream = new StreamingSttSession({
      engine: chunked,
      language: 'en',
      callbacks: { onResult: (r) => results.push(r) },
    });
    const frameBytes = 640; // 20 ms @ 16 kHz
    for (let off = 0; off + frameBytes <= pcm1.length; off += frameBytes) {
      stream.feed(pcm1.slice(off, off + frameBytes));
    }
    for (let i = 0; i < 30; i++) stream.feed(silencePcm16Frame(320));
    await stream.drain();
    assert.equal(results.length, 1, 'one speech segment → one transcription');
    const pipeWer = wordErrorRate(ref1, results[0].text);
    console.log(`v098 live whisper streaming: "${results[0].text}" (WER ${pipeWer.wer}, ${results[0].transcribeMs}ms)`);
    assert.ok(pipeWer.wer <= 0.6);
    stream.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
