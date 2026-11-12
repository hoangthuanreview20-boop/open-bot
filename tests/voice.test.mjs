/**
 * Tests for the v0.4 voice module (packages/core/src/voice/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { RealtimeClient } from '../packages/core/dist/voice/realtime.js';
import { transcribeAudio } from '../packages/core/dist/voice/memo.js';

// ---------------------------------------------------------------------------
// Mock WebSocket (implements the WebSocketLike surface RealtimeClient needs)
// ---------------------------------------------------------------------------

class MockSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0; // CONNECTING
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  closeCalled = false;

  send(data) {
    this.sent.push(typeof data === 'string' ? data : String(data));
  }

  close() {
    this.closeCalled = true;
    this.readyState = MockSocket.CLOSED;
  }

  /** Drive the socket to "open". */
  open() {
    this.readyState = MockSocket.OPEN;
    this.onopen?.({});
  }

  /** Deliver a server message object. */
  receive(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  /** Server drops the connection (after open). */
  drop(code = 1006) {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.({ code, reason: 'dropped' });
  }

  /** Connection fails before opening (for reconnect-attempt failures). */
  failBeforeOpen(code = 1006) {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.({ code, reason: 'connect failed' });
  }
}

/** Poll `cond()` until true or the timeout hits. */
async function waitFor(cond, timeoutMs = 5000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// RealtimeClient: connect + transcript + tool call
// ---------------------------------------------------------------------------

test('realtime connect sends session.update, audio flows, transcript + tool call arrive', async () => {
  const sockets = [];
  const t2 = [];
  const tc2 = [];
  const a2 = [];
  const client2 = new RealtimeClient({
    onTranscript: (e) => t2.push(e),
    onToolCall: (c) => tc2.push(c),
    onAudio: (e) => a2.push(e),
  });

  const connecting = client2.connect({
    url: 'wss://example.invalid/v1/realtime',
    model: 'gpt-4o-realtime-preview',
    voice: 'alloy',
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
  });
  await waitFor(() => sockets.length === 1);
  assert.equal(client2.getState(), 'connecting');
  sockets[0].open();
  await connecting;
  assert.equal(client2.getState(), 'connected');
  assert.equal(client2.isConnected(), true);

  const sessionUpdate = JSON.parse(sockets[0].sent[0]);
  assert.equal(sessionUpdate.type, 'session.update');
  assert.equal(sessionUpdate.session.model, 'gpt-4o-realtime-preview');
  assert.equal(sessionUpdate.session.voice, 'alloy');

  // Audio out: sendAudio base64-encodes PCM16.
  client2.sendAudio(new Uint8Array([1, 2, 3, 4]));
  const append = JSON.parse(sockets[0].sent[1]);
  assert.equal(append.type, 'input_audio_buffer.append');
  assert.equal(append.audio, Buffer.from([1, 2, 3, 4]).toString('base64'));

  // Transcript delta then done.
  sockets[0].receive({ type: 'response.audio_transcript.delta', delta: 'xin ' });
  sockets[0].receive({ type: 'response.audio_transcript.delta', delta: 'chào' });
  sockets[0].receive({ type: 'response.audio_transcript.done', transcript: 'xin chào' });
  assert.deepEqual(t2, [
    { text: 'xin ', isFinal: false },
    { text: 'xin chào', isFinal: false },
    { text: 'xin chào', isFinal: true },
  ]);

  // Audio back from the server.
  sockets[0].receive({ type: 'response.audio.delta', delta: Buffer.from([9, 9]).toString('base64') });
  assert.equal(a2.length, 1);
  assert.deepEqual([...a2[0].audio], [9, 9]);

  // Tool call requested by the model.
  sockets[0].receive({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'read_file',
    arguments: JSON.stringify({ path: 'a.txt' }),
  });
  assert.deepEqual(tc2, [{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }]);

  client2.disconnect();
  assert.equal(client2.getState(), 'closed');
  assert.equal(sockets[0].closeCalled, true);
});

test('realtime sendAudio throws when not connected', () => {
  const client = new RealtimeClient();
  assert.throws(() => client.sendAudio(new Uint8Array([0])), /not connected/);
  assert.throws(() => client.commitAudio(), /not connected/);
});

test('realtime reconnects after a drop (max 3 attempts, backoff) and recovers', async () => {
  const sockets = [];
  const errors = [];
  const client = new RealtimeClient({ onError: (e) => errors.push(e) });
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    maxReconnectAttempts: 3,
    reconnectDelayMs: 10,
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].open();
  await connecting;
  assert.equal(client.isConnected(), true);

  sockets[0].drop();
  // Reconnect attempt #1 after ~10ms.
  await waitFor(() => sockets.length === 2);
  assert.equal(client.getState(), 'reconnecting');
  assert.equal(client.getReconnectAttempts(), 1);
  sockets[1].open();
  await waitFor(() => client.isConnected());
  assert.equal(client.getReconnectAttempts(), 0);
  assert.equal(errors.length, 0);

  client.disconnect();
});

test('realtime gives up after max reconnect attempts when every retry fails', async () => {
  const sockets = [];
  const errors = [];
  const client = new RealtimeClient({ onError: (e) => errors.push(e) });
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    maxReconnectAttempts: 3,
    reconnectDelayMs: 10,
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      // Every socket after the first fails before opening.
      if (sockets.length > 1) setImmediate(() => s.failBeforeOpen());
      return s;
    },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].open();
  await connecting;

  sockets[0].drop();
  await waitFor(() => client.getState() === 'closed', 5000);
  // 1 initial + 3 failed reconnect attempts.
  assert.equal(sockets.length, 4);
  assert.match(errors[errors.length - 1].message, /gave up after 3 reconnect/);
  assert.equal(client.isConnected(), false);

  client.disconnect();
});

test('realtime disconnect() suppresses reconnect', async () => {
  const sockets = [];
  const client = new RealtimeClient();
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    reconnectDelayMs: 10,
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].open();
  await connecting;
  client.disconnect();
  await sleep(50);
  assert.equal(sockets.length, 1);
  assert.equal(client.getState(), 'closed');
});

// ---------------------------------------------------------------------------
// transcribeAudio against a mock HTTP STT server
// ---------------------------------------------------------------------------

/** Tiny mock of POST /v1/audio/transcriptions. */
function startMockStt({ status = 200, body = { text: 'xin chào, đây là voice memo' } } = {}) {
  let lastRequest = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastRequest = {
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        authorization: req.headers['authorization'],
        body: Buffer.concat(chunks),
      };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        get lastRequest() {
          return lastRequest;
        },
      });
    });
  });
}

test('transcribeAudio posts multipart audio and returns the transcript text', async () => {
  const stt = await startMockStt();
  try {
    const text = await transcribeAudio(new Uint8Array([0, 1, 2, 3]), {
      baseUrl: stt.baseUrl,
      apiKey: 'test-key',
      model: 'whisper-1',
      language: 'vi',
    });
    assert.equal(text, 'xin chào, đây là voice memo');
    assert.equal(stt.lastRequest.method, 'POST');
    assert.equal(stt.lastRequest.url, '/v1/audio/transcriptions');
    assert.match(stt.lastRequest.contentType, /multipart\/form-data/);
    assert.equal(stt.lastRequest.authorization, 'Bearer test-key');
    // Multipart body carries the model + language fields.
    const bodyText = stt.lastRequest.body.toString('latin1');
    assert.match(bodyText, /whisper-1/);
    assert.match(bodyText, /\bvi\b/);
    assert.match(bodyText, /voice-memo\.webm/);
  } finally {
    stt.server.close();
  }
});

test('transcribeAudio works without an API key (local endpoint) and rejects empty audio / HTTP errors', async () => {
  const stt = await startMockStt();
  try {
    const text = await transcribeAudio(new Uint8Array([5, 6]), { baseUrl: stt.baseUrl });
    assert.equal(text, 'xin chào, đây là voice memo');
    assert.equal(stt.lastRequest.authorization, undefined);
  } finally {
    stt.server.close();
  }

  await assert.rejects(
    transcribeAudio(new Uint8Array([]), { baseUrl: stt.baseUrl }),
    /audio rỗng/,
  );

  const failing = await startMockStt({ status: 401, body: { error: 'bad key' } });
  try {
    await assert.rejects(
      transcribeAudio(new Uint8Array([1]), { baseUrl: failing.baseUrl, apiKey: 'bad' }),
      /HTTP 401/,
    );
  } finally {
    failing.server.close();
  }
});
