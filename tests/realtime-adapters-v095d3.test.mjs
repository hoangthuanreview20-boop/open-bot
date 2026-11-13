/**
 * Tests for v0.95 Đội D3 — realtime provider adapters
 * (packages/core/src/voice/adapters.ts):
 *
 *   1. OpenAI transport (wraps RealtimeClient): session.update
 *      shape + turn_detection flag, audio append, response.cancel
 *      for barge-in, speech_started callback.
 *   2. Gemini Live transport: setup gating on setupComplete, the
 *      realtimeInput mediaChunks shape (16 kHz), serverContent
 *      audio (24 kHz) + outputTranscription + turnComplete +
 *      interrupted, toolCall -> toolResponse with the original id,
 *      goAway error, drop -> closed.
 *   3. Factory + URL builders (no live calls — the "key" below is a
 *      fake test value, never a real credential).
 *
 * No network. Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/realtime-adapters-v095d3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GeminiLiveTransport,
  OpenAiRealtimeTransport,
  buildGeminiLiveUrl,
  buildOpenAiRealtimeUrl,
  createRealtimeTransport,
} from '../packages/core/dist/voice/adapters.js';

/** Mock WebSocket (same surface as tests/voice.test.mjs). */
class MockSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  closeArgs = null;

  constructor(url) {
    this.url = url;
  }

  send(data) {
    this.sent.push(typeof data === 'string' ? data : String(data));
  }

  close(code, reason) {
    this.closeArgs = { code, reason };
    this.readyState = MockSocket.CLOSED;
  }

  open() {
    this.readyState = MockSocket.OPEN;
    this.onopen?.({});
  }

  receive(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  drop(code = 1006) {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.({ code, reason: 'dropped' });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sentJson(socket, index = 0) {
  return JSON.parse(socket.sent[index]);
}

// ---------------------------------------------------------------------------
// URL builders + factory
// ---------------------------------------------------------------------------

test('adapters: URL builders carry the model / key in the right place', () => {
  assert.equal(
    buildOpenAiRealtimeUrl('gpt-4o-realtime-preview'),
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
  );
  const url = buildGeminiLiveUrl('fake-test-key');
  assert.ok(url.startsWith('wss://generativelanguage.googleapis.com/ws/'));
  assert.ok(url.includes('?key=fake-test-key'));
  // The key must be URL-encoded, never raw in a log line — the
  // builder encodes it, so a key with special chars stays one param.
  assert.ok(buildGeminiLiveUrl('a&b=c').includes('?key=a%26b%3Dc'));
});

test('adapters: factory picks the transport per provider and rejects unknown ones', () => {
  assert.equal(createRealtimeTransport('openai').provider, 'openai');
  assert.equal(createRealtimeTransport('openai-compatible').provider, 'openai');
  assert.equal(createRealtimeTransport('gemini').provider, 'gemini');
  assert.throws(() => createRealtimeTransport('xai'), /unknown provider/);
});

// ---------------------------------------------------------------------------
// OpenAI transport
// ---------------------------------------------------------------------------

test('adapters: OpenAI transport sends session.update with server_vad and streams audio', async () => {
  const sockets = [];
  const events = [];
  const t = new OpenAiRealtimeTransport({
    onTranscript: (e) => events.push(['transcript', e]),
    onSpeechStarted: () => events.push(['speech_started']),
  });
  assert.equal(t.handlesReconnect, true);
  assert.equal(t.inputSampleRateHz, 24000);
  assert.equal(t.outputSampleRateHz, 24000);
  const connected = t.connect({
    provider: 'openai',
    model: 'gpt-4o-realtime-preview',
    voice: 'alloy',
    socketFactory: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
  });
  const socket = sockets[0];
  assert.ok(socket.url.includes('model=gpt-4o-realtime-preview'));
  socket.open();
  await connected;
  assert.equal(t.isConnected(), true);
  const update = sentJson(socket, 0);
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.model, 'gpt-4o-realtime-preview');
  assert.equal(update.session.voice, 'alloy');
  assert.deepEqual(update.session.turn_detection, { type: 'server_vad' });

  // Audio out: one append per chunk, base64 PCM16.
  t.sendAudio(new Uint8Array([1, 2, 3, 4]));
  const append = sentJson(socket, 1);
  assert.equal(append.type, 'input_audio_buffer.append');
  assert.equal(append.audio, Buffer.from([1, 2, 3, 4]).toString('base64'));

  // Server VAD speech_started -> callback (session uses it for barge-in).
  socket.receive({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual(events, [['speech_started']]);

  // Barge-in cancel.
  t.cancelResponse();
  assert.equal(sentJson(socket, 2).type, 'response.cancel');

  // Transcript + audio + response.done flow through.
  socket.receive({ type: 'response.audio_transcript.delta', delta: 'xin ' });
  socket.receive({ type: 'response.audio_transcript.done', transcript: 'xin chào' });
  assert.deepEqual(events[1], ['transcript', { text: 'xin ', isFinal: false }]);
  assert.deepEqual(events[2], ['transcript', { text: 'xin chào', isFinal: true }]);
  t.disconnect();
  assert.equal(t.isConnected(), false);
});

test('adapters: OpenAI transport with turnDetection none sends turn_detection null (manual turns)', async () => {
  const sockets = [];
  const t = new OpenAiRealtimeTransport({});
  const connected = t.connect({
    provider: 'openai',
    turnDetection: 'none',
    socketFactory: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
  });
  sockets[0].open();
  await connected;
  assert.equal(sentJson(sockets[0], 0).session.turn_detection, null);
  t.disconnect();
});

// ---------------------------------------------------------------------------
// Gemini Live transport
// ---------------------------------------------------------------------------

test('adapters: Gemini transport gates on setupComplete and sends setup first', async () => {
  const sockets = [];
  const t = new GeminiLiveTransport({});
  assert.equal(t.handlesReconnect, false);
  assert.equal(t.inputSampleRateHz, 16000);
  assert.equal(t.outputSampleRateHz, 24000);
  let resolved = false;
  const connected = t
    .connect({
      provider: 'gemini',
      apiKey: 'fake-test-key',
      model: 'gemini-live-2.5-flash-native-audio',
      voice: 'Puck',
      instructions: 'Be brief.',
      socketFactory: (url) => {
        const s = new MockSocket(url);
        sockets.push(s);
        return s;
      },
    })
    .then(() => {
      resolved = true;
    });
  const socket = sockets[0];
  assert.ok(socket.url.includes('BidiGenerateContent?key=fake-test-key'));
  socket.open();
  await sleep(10);
  // Open alone is not enough: connect() waits for setupComplete.
  assert.equal(resolved, false);
  assert.equal(t.isConnected(), false);
  // Audio before setupComplete is refused (not connected yet — the
  // session is still in its setup handshake).
  assert.throws(() => t.sendAudio(new Uint8Array([1, 2])), /not connected/);
  const setup = sentJson(socket, 0);
  assert.ok(setup.setup, 'first frame must be setup');
  assert.equal(setup.setup.model, 'models/gemini-live-2.5-flash-native-audio');
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(
    setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    'Puck',
  );
  assert.equal(setup.setup.systemInstruction.parts[0].text, 'Be brief.');
  socket.receive({ setupComplete: {} });
  await connected;
  assert.equal(resolved, true);
  assert.equal(t.isConnected(), true);
  t.disconnect();
});

test('adapters: Gemini transport requires a key (or an explicit URL) to connect', async () => {
  const t = new GeminiLiveTransport({});
  await assert.rejects(
    t.connect({ provider: 'gemini', socketFactory: (url) => new MockSocket(url) }),
    /API key is required/,
  );
});

test('adapters: Gemini transport streams audio in and out, transcripts, turns, interruption', async () => {
  const sockets = [];
  const transcripts = [];
  const audios = [];
  const interrupted = [];
  const t = new GeminiLiveTransport({
    onTranscript: (e) => transcripts.push(e),
    onAudio: (e) => audios.push(e.audio),
    onInterrupted: () => interrupted.push(true),
  });
  const connected = t.connect({
    provider: 'gemini',
    apiKey: 'fake-test-key',
    socketFactory: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
  });
  const socket = sockets[0];
  socket.open();
  socket.receive({ setupComplete: {} });
  await connected;

  // Mic audio -> realtimeInput mediaChunks, 16 kHz PCM.
  t.sendAudio(new Uint8Array([10, 20, 30, 40]));
  const input = sentJson(socket, 1);
  assert.ok(input.realtimeInput, 'expected realtimeInput frame');
  assert.equal(input.realtimeInput.mediaChunks[0].mimeType, 'audio/pcm;rate=16000');
  assert.equal(
    input.realtimeInput.mediaChunks[0].data,
    Buffer.from([10, 20, 30, 40]).toString('base64'),
  );

  // Model audio (24 kHz) + output transcription + turn end.
  const pcm24 = Buffer.from([1, 2, 3, 4, 5, 6]).toString('base64');
  socket.receive({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm24 } }],
      },
      outputTranscription: { text: 'xin ' },
    },
  });
  assert.equal(audios.length, 1);
  assert.deepEqual([...audios[0]], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(transcripts[0], { text: 'xin ', isFinal: false });
  socket.receive({
    serverContent: { outputTranscription: { text: 'chào' }, turnComplete: true },
  });
  // Like the OpenAI client, the turn end re-emits the accumulated
  // text as final (the delta just before it was interim).
  assert.deepEqual(transcripts[1], { text: 'xin chào', isFinal: false });
  assert.deepEqual(transcripts[2], { text: 'xin chào', isFinal: true });

  // User's own words arrive as inputTranscription (own final line).
  socket.receive({ serverContent: { inputTranscription: { text: 'tôi cần giúp' } } });
  assert.deepEqual(transcripts[3], { text: 'tôi cần giúp', isFinal: true });

  // Server-driven barge-in.
  socket.receive({ serverContent: { interrupted: true } });
  assert.deepEqual(interrupted, [true]);

  // Cancel (client barge-in) signals activity start.
  t.cancelResponse();
  const cancel = sentJson(socket, socket.sent.length - 1);
  assert.deepEqual(cancel, { realtimeInput: { activityStart: {} } });
  t.disconnect();
});

test('adapters: Gemini transport answers tool calls with the original id', async () => {
  const sockets = [];
  const calls = [];
  const t = new GeminiLiveTransport({ onToolCall: (c) => calls.push(c) });
  const connected = t.connect({
    provider: 'gemini',
    apiKey: 'fake-test-key',
    socketFactory: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
  });
  const socket = sockets[0];
  socket.open();
  socket.receive({ setupComplete: {} });
  await connected;

  socket.receive({
    toolCall: { functionCalls: [{ id: 'call-1', name: 'peek_agents', args: { filter: 'x' } }] },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call-1');
  assert.equal(calls[0].name, 'peek_agents');
  assert.deepEqual(calls[0].args, { filter: 'x' });

  t.sendToolResult('call-1', '{"agents":[]}');
  const resp = sentJson(socket, socket.sent.length - 1);
  assert.equal(resp.toolResponse.functionResponses[0].id, 'call-1');
  assert.equal(resp.toolResponse.functionResponses[0].name, 'peek_agents');
  assert.equal(resp.toolResponse.functionResponses[0].response.result, '{"agents":[]}');

  // Unknown call id is an error, not a silent wrong answer.
  assert.throws(() => t.sendToolResult('nope', '{}'), /unknown tool call id/);
  t.disconnect();
});

test('adapters: Gemini transport reports goAway and drops as errors + closed state', async () => {
  const sockets = [];
  const errors = [];
  const states = [];
  const t = new GeminiLiveTransport({
    onError: (e) => errors.push(e.message),
    onStateChange: (s) => states.push(s),
  });
  const connected = t.connect({
    provider: 'gemini',
    apiKey: 'fake-test-key',
    socketFactory: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
  });
  const socket = sockets[0];
  socket.open();
  socket.receive({ setupComplete: {} });
  await connected;
  socket.receive({ goAway: { timeLeft: '60s' } });
  assert.ok(errors[0].includes('go away'), errors[0]);
  assert.ok(errors[0].includes('60s'), errors[0]);
  socket.drop(1006);
  assert.equal(t.getState(), 'closed');
  assert.ok(states.includes('closed'));
  assert.ok(errors.some((m) => m.includes('connection closed')), errors.join(' | '));
});

test('adapters: Gemini transport in local_vad mode commits with activityEnd', async () => {
  const sockets = [];
  const t = new GeminiLiveTransport({});
  const connected = t.connect({
    provider: 'gemini',
    apiKey: 'fake-test-key',
    turnMode: 'local_vad',
    socketFactory: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
  });
  const socket = sockets[0];
  socket.open();
  socket.receive({ setupComplete: {} });
  await connected;
  // No activity started yet: commit is a no-op (no frame sent).
  const before = socket.sent.length;
  t.commitAudio();
  assert.equal(socket.sent.length, before);
  // After a cancel (activityStart), commit sends activityEnd.
  t.cancelResponse();
  t.commitAudio();
  const last = sentJson(socket, socket.sent.length - 1);
  assert.deepEqual(last, { realtimeInput: { activityEnd: {} } });
  t.disconnect();
});
