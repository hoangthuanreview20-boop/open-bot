/**
 * Tests for v0.95 Đội D3 — RealtimeSession state machine
 * (packages/core/src/voice/realtimeSession.ts):
 *
 *   1. State machine: idle -> connecting -> listening -> speaking
 *      -> listening -> closed; transcript/audio/tool events reach
 *      the sink.
 *   2. Barge-in: server VAD speech_started while speaking cancels
 *      the response + flushes the playback sink + emits
 *      `interrupted`; local VAD speech while speaking does the
 *      same in local_vad mode.
 *   3. Turn-taking: local_vad ends the turn on silence (commit +
 *      request response); push_to_talk drops mic frames until the
 *      talk button is held and commits on release.
 *   4. Audio path: 16 kHz mic frames are chunked to 100 ms and
 *      resampled to the transport rate (24 kHz for OpenAI).
 *   5. Reconnect (session-owned, Gemini-like transport): drop ->
 *      reconnecting -> listening on the new transport; budget spent
 *      -> closed + error.
 *   6. TTS hook: final transcripts are spoken when the hook is set;
 *      a throwing event sink never breaks the session.
 *
 * No network, no sound card. Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/realtime-session-v095d3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RealtimeSession } from '../packages/core/dist/voice/realtimeSession.js';
import {
  MockAudioSink,
  sinePcm16Frame,
  silencePcm16Frame,
} from '../packages/core/dist/voice/audio.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake transport implementing the RealtimeTransport interface.
 * The test drives it by hand: `open()` connects, `drop()` simulates
 * an unexpected close, `emitAudio()` / `emitTranscript()` /
 * `emitSpeechStarted()` / `emitResponseDone()` deliver server events.
 */
class FakeTransport {
  constructor(callbacks) {
    this.cb = callbacks;
    this.sentAudio = [];
    this.commits = 0;
    this.responses = 0;
    this.cancels = 0;
    this.toolResults = [];
    this.connected = false;
    this.state = 'idle';
    FakeTransport.created.push(this);
  }

  static created = [];

  provider = 'gemini';
  inputSampleRateHz = 16000;
  outputSampleRateHz = 24000;
  handlesReconnect = false;

  async connect() {
    if (this.failConnect) {
      this.state = 'closed';
      this.cb.onError?.(new Error('FakeTransport: connect failed.'));
      throw new Error('FakeTransport: connect failed.');
    }
    this.state = 'connected';
    this.connected = true;
    this.cb.onStateChange?.('connected');
  }

  disconnect() {
    this.connected = false;
    this.state = 'closed';
    this.cb.onStateChange?.('closed');
  }

  sendAudio(chunk) {
    this.sentAudio.push(new Uint8Array(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)));
  }

  commitAudio() {
    this.commits += 1;
  }

  requestResponse() {
    this.responses += 1;
  }

  cancelResponse() {
    this.cancels += 1;
  }

  sendToolResult(callId, output) {
    this.toolResults.push({ callId, output });
  }

  isConnected() {
    return this.connected;
  }

  getState() {
    return this.state;
  }

  open() {
    this.state = 'connected';
    this.connected = true;
    this.cb.onStateChange?.('connected');
  }

  /** Unexpected drop (server closed the socket). */
  drop() {
    this.connected = false;
    this.state = 'closed';
    this.cb.onError?.(new Error('FakeTransport: connection closed (code 1006) — session will retry.'));
    this.cb.onStateChange?.('closed');
  }

  emitAudio(bytes) {
    this.cb.onAudio?.({ audio: new Uint8Array(bytes) });
  }

  emitTranscript(text, isFinal) {
    this.cb.onTranscript?.({ text, isFinal });
  }

  emitSpeechStarted() {
    this.cb.onSpeechStarted?.();
  }

  emitResponseDone() {
    this.cb.onResponseDone?.();
  }

  emitToolCall(call) {
    this.cb.onToolCall?.(call);
  }
}

function collectEvents() {
  const events = [];
  const sink = (e) => events.push(e);
  const byKind = (kind) => events.filter((e) => e.kind === kind);
  return { events, sink, byKind };
}

async function connectedSession(opts = {}) {
  const c = collectEvents();
  const session = new RealtimeSession({
    provider: 'gemini',
    transportFactory: (cb) => new FakeTransport(cb),
    onEvent: c.sink,
    ...opts,
  });
  await session.connect({ url: 'wss://fake', provider: 'gemini' });
  return { session, ...c };
}

// ---------------------------------------------------------------------------
// State machine + events
// ---------------------------------------------------------------------------

test('session: connect moves idle -> listening and forwards transcript/audio/tool events', async () => {
  const { session, events, byKind } = await connectedSession();
  assert.equal(session.getState(), 'listening');
  assert.equal(session.isConnected(), true);
  assert.deepEqual(byKind('state').map((e) => e.state), ['connecting', 'listening']);

  const transport = FakeTransport.created.at(-1);
  transport.emitTranscript('xin ', false);
  transport.emitTranscript('xin chào', true);
  transport.emitAudio([1, 2, 3, 4]);
  transport.emitToolCall({ id: 'c1', name: 'peek_agents', args: {} });
  assert.deepEqual(byKind('transcript'), [
    { kind: 'transcript', text: 'xin ', isFinal: false, at: byKind('transcript')[0].at },
    { kind: 'transcript', text: 'xin chào', isFinal: true, at: byKind('transcript')[1].at },
  ]);
  assert.equal(byKind('audio').length, 1);
  assert.equal(
    byKind('audio')[0].audioBase64,
    Buffer.from([1, 2, 3, 4]).toString('base64'),
  );
  assert.equal(byKind('audio')[0].sampleRateHz, 24000);
  assert.equal(byKind('toolcall')[0].call.name, 'peek_agents');

  // Model audio -> speaking; response done -> listening + model turn.
  assert.equal(session.getState(), 'speaking');
  transport.emitResponseDone();
  assert.equal(session.getState(), 'listening');
  assert.equal(byKind('turn').length, 1);
  assert.equal(byKind('turn')[0].speaker, 'model');
  assert.equal(session.getTurnCount(), 1);

  session.disconnect();
  assert.equal(session.getState(), 'closed');
  assert.equal(session.isConnected(), false);
  // Disconnect is idempotent.
  session.disconnect();
  assert.equal(session.getState(), 'closed');
  void events;
});

test('session: sendAudio throws when not connected or on an invalid frame', async () => {
  const session = new RealtimeSession({
    provider: 'gemini',
    transportFactory: (cb) => new FakeTransport(cb),
  });
  assert.throws(() => session.sendAudio(sinePcm16Frame(1600, 0.2)), /not connected/);
  await session.connect({ url: 'wss://fake', provider: 'gemini' });
  assert.throws(() => session.sendAudio(new Uint8Array([1])), /PCM16/);
  assert.throws(() => session.sendAudio(new Uint8Array(0)), /PCM16/);
  session.disconnect();
});

test('session: a throwing event sink never breaks the call', async () => {
  const session = new RealtimeSession({
    provider: 'gemini',
    transportFactory: (cb) => new FakeTransport(cb),
    onEvent: () => {
      throw new Error('broken sink');
    },
  });
  await session.connect({ url: 'wss://fake', provider: 'gemini' });
  const transport = FakeTransport.created.at(-1);
  transport.emitAudio([1, 2]);
  assert.equal(session.getState(), 'speaking');
  session.disconnect();
  assert.equal(session.getState(), 'closed');
});

// ---------------------------------------------------------------------------
// Barge-in
// ---------------------------------------------------------------------------

test('session: server VAD speech while speaking cancels + flushes + emits interrupted', async () => {
  const sink = new MockAudioSink(24000);
  const { session, byKind } = await connectedSession({ audioSink: sink });
  const transport = FakeTransport.created.at(-1);
  transport.emitAudio([1, 2, 3, 4]);
  assert.equal(session.getState(), 'speaking');
  assert.equal(sink.queuedBytes, 4);

  transport.emitSpeechStarted();
  assert.equal(transport.cancels, 1);
  assert.equal(sink.clears, 1);
  assert.equal(sink.queuedBytes, 0);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.getBargeInCount(), 1);
  assert.equal(byKind('interrupted').length, 1);
  assert.equal(byKind('interrupted')[0].source, 'server_vad');

  // Speech while listening is not a barge-in (nothing to cancel).
  transport.emitSpeechStarted();
  assert.equal(transport.cancels, 1);
  assert.equal(session.getBargeInCount(), 1);
  session.disconnect();
});

test('session: manual interrupt() cancels the model response', async () => {
  const { session, byKind } = await connectedSession();
  const transport = FakeTransport.created.at(-1);
  assert.equal(session.interrupt(), false);
  transport.emitAudio([1, 2]);
  assert.equal(session.interrupt(), true);
  assert.equal(transport.cancels, 1);
  assert.equal(byKind('interrupted')[0].source, 'manual');
  assert.equal(session.getState(), 'listening');
  session.disconnect();
});

test('session: local VAD speech while speaking barges in (local_vad mode)', async () => {
  const sink = new MockAudioSink(24000);
  const session = new RealtimeSession({
    provider: 'gemini',
    turnMode: 'local_vad',
    audioSink: sink,
    transportFactory: (cb) => new FakeTransport(cb),
    onEvent: () => {},
  });
  await session.connect({ url: 'wss://fake', provider: 'gemini' });
  const transport = FakeTransport.created.at(-1);
  transport.emitAudio([1, 2, 3, 4]);
  assert.equal(session.getState(), 'speaking');
  // 200 ms of loud mic audio -> local VAD speech start -> barge-in.
  session.pushAudioFrame(sinePcm16Frame(3200, 0.2));
  assert.equal(transport.cancels, 1);
  assert.equal(sink.clears, 1);
  assert.equal(session.getBargeInCount(), 1);
  assert.equal(session.getState(), 'listening');
  session.disconnect();
});

// ---------------------------------------------------------------------------
// Turn-taking
// ---------------------------------------------------------------------------

test('session: local_vad ends the turn on silence (commit + request response)', async () => {
  const events = [];
  const session = new RealtimeSession({
    provider: 'gemini',
    turnMode: 'local_vad',
    transportFactory: (cb) => new FakeTransport(cb),
    onEvent: (e) => events.push(e),
  });
  await session.connect({ url: 'wss://fake', provider: 'gemini' });
  const transport = FakeTransport.created.at(-1);
  // Speak 200 ms, then 400 ms silence (hangover 300 ms) -> turn ends.
  session.pushAudioFrame(sinePcm16Frame(3200, 0.2));
  assert.equal(transport.commits, 0);
  session.pushAudioFrame(silencePcm16Frame(6400));
  assert.equal(transport.commits, 1);
  assert.equal(transport.responses, 0); // Gemini ignores requestResponse
  const turns = events.filter((e) => e.kind === 'turn' && e.speaker === 'user');
  assert.equal(turns.length, 1);
  session.disconnect();
});

test('session: push_to_talk drops mic frames until held, commits on release', async () => {
  const session = new RealtimeSession({
    provider: 'gemini',
    turnMode: 'push_to_talk',
    transportFactory: (cb) => new FakeTransport(cb),
    onEvent: () => {},
  });
  await session.connect({ url: 'wss://fake', provider: 'gemini' });
  const transport = FakeTransport.created.at(-1);
  // Not held yet: mic frames are dropped.
  session.pushAudioFrame(sinePcm16Frame(1600, 0.2));
  assert.equal(transport.sentAudio.length, 0);
  assert.equal(session.startTalk(), true);
  session.pushAudioFrame(sinePcm16Frame(1600, 0.2));
  assert.equal(transport.sentAudio.length, 1);
  assert.equal(session.endTalk(), true);
  assert.equal(transport.commits, 1);
  // After release, frames are dropped again.
  session.pushAudioFrame(sinePcm16Frame(1600, 0.2));
  assert.equal(transport.sentAudio.length, 1);
  session.disconnect();
});

test('session: startTalk/endTalk are no-ops outside push_to_talk mode', async () => {
  const { session } = await connectedSession({ turnMode: 'server_vad' });
  assert.equal(session.startTalk(), false);
  assert.equal(session.endTalk(), false);
  session.disconnect();
});

test('session: commitAudio flushes the partial frame then commits', async () => {
  const { session } = await connectedSession();
  const transport = FakeTransport.created.at(-1);
  session.pushAudioFrame(sinePcm16Frame(320, 0.2)); // 20 ms only
  assert.equal(transport.sentAudio.length, 0);
  session.commitAudio();
  assert.equal(transport.sentAudio.length, 1); // flushed partial frame
  assert.equal(transport.commits, 1);
  session.disconnect();
});

// ---------------------------------------------------------------------------
// Audio path: chunking + resampling
// ---------------------------------------------------------------------------

test('session: 16 kHz mic frames reach a 24 kHz transport as 100 ms 24 kHz frames', async () => {
  const session = new RealtimeSession({
    provider: 'openai',
    transportFactory: (cb) => {
      const t = new FakeTransport(cb);
      t.provider = 'openai';
      t.inputSampleRateHz = 24000;
      t.handlesReconnect = true;
      return t;
    },
    onEvent: () => {},
  });
  await session.connect({ url: 'wss://fake', provider: 'openai' });
  const transport = FakeTransport.created.at(-1);
  // Five 20 ms frames = one 100 ms frame; resampled 16k -> 24k.
  for (let i = 0; i < 5; i++) {
    session.pushAudioFrame(sinePcm16Frame(320, 0.2));
  }
  assert.equal(transport.sentAudio.length, 1);
  assert.equal(transport.sentAudio[0].length, 4800);
  assert.equal(session.getMicFrames(), 5);
  assert.ok(session.getMicLevel() > 0.1);
  session.disconnect();
});

// ---------------------------------------------------------------------------
// Reconnect (session-owned)
// ---------------------------------------------------------------------------

test('session: Gemini-like drop reconnects on a new transport and resumes listening', async () => {
  const { session, byKind } = await connectedSession({
    reconnectDelayMs: 5,
    reconnectMaxDelayMs: 10,
  });
  const first = FakeTransport.created.at(-1);
  first.drop();
  assert.equal(session.getState(), 'reconnecting');
  await sleep(50);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.isConnected(), true);
  assert.notEqual(FakeTransport.created.at(-1), first);
  assert.ok(byKind('state').some((e) => e.state === 'reconnecting'));
  session.disconnect();
});

test('session: reconnect budget spent -> closed + error event', async () => {
  const events = [];
  let created = 0;
  const session = new RealtimeSession({
    provider: 'gemini',
    maxReconnectAttempts: 2,
    reconnectDelayMs: 5,
    reconnectMaxDelayMs: 10,
    transportFactory: (cb) => {
      const t = new FakeTransport(cb);
      created += 1;
      // The first transport connects fine; every redial fails, so
      // the session spends its budget on consecutive failures.
      if (created > 1) t.failConnect = true;
      return t;
    },
    onEvent: (e) => events.push(e),
  });
  await session.connect({ url: 'wss://fake', provider: 'gemini' });
  FakeTransport.created.at(-1).drop();
  const deadline = Date.now() + 5000;
  while (session.getState() !== 'closed' && Date.now() < deadline) {
    await sleep(10);
  }
  assert.equal(session.getState(), 'closed');
  assert.ok(
    events.some((e) => e.kind === 'error' && e.message.includes('gave up after 2 reconnect')),
    JSON.stringify(events.filter((e) => e.kind === 'error')),
  );
  session.disconnect();
});

// ---------------------------------------------------------------------------
// TTS hook
// ---------------------------------------------------------------------------

test('session: final transcripts are spoken when the TTS hook is set', async () => {
  const spoken = [];
  const { session } = await connectedSession({
    speakFinalTranscript: (text) => {
      spoken.push(text);
    },
  });
  const transport = FakeTransport.created.at(-1);
  transport.emitTranscript('xin ', false);
  assert.deepEqual(spoken, []);
  transport.emitTranscript('xin chào', true);
  assert.deepEqual(spoken, ['xin chào']);
  session.disconnect();
});
