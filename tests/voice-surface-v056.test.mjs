/**
 * Tests for v0.56: voice harness wired into the main process via
 * VoiceCallSession (packages/core/src/voice/session.ts) + IPC
 * voice:surface (register/unregister/list) + RealtimeClient
 * sendToolResult / session.update tools.
 *
 * Everything runs against a mock realtime client — no live
 * connection to x.ai or any realtime endpoint is ever made.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-surface-v056.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RealtimeClient } from '../packages/core/dist/voice/realtime.js';
import { VoiceCallSession, truncateToolOutput } from '../packages/core/dist/voice/session.js';
import {
  VOICE_CALL_REQUEST_CHAR_LIMIT,
  VOICE_SURFACE_MAX_REPLY_CHARS,
} from '../packages/core/dist/voice/types.js';

// ---------------------------------------------------------------------------
// Mock realtime client (same method surface VoiceCallSession needs)
// ---------------------------------------------------------------------------

class MockVoiceClient {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.connected = false;
    this.config = null;
    this.audioFrames = [];
    this.toolResults = [];
    this.commits = 0;
    this.responses = 0;
    this.disconnects = 0;
  }

  async connect(config) {
    this.config = config;
    this.connected = true;
    this.callbacks.onStateChange?.('connected');
  }

  disconnect() {
    this.connected = false;
    this.disconnects += 1;
    this.callbacks.onStateChange?.('closed');
  }

  sendAudio(chunk) {
    this.audioFrames.push(chunk);
  }

  commitAudio() {
    this.commits += 1;
  }

  requestResponse() {
    this.responses += 1;
  }

  sendToolResult(callId, output) {
    this.toolResults.push({ callId, output });
  }

  isConnected() {
    return this.connected;
  }

  getState() {
    return this.connected ? 'connected' : 'closed';
  }

  // -- server-side simulation helpers --
  serverTranscript(text, isFinal) {
    this.callbacks.onTranscript?.({ text, isFinal });
  }

  serverAudio(bytes) {
    this.callbacks.onAudio?.({ audio: bytes });
  }

  serverToolCall(call) {
    this.callbacks.onToolCall?.(call);
  }

  serverError(message) {
    this.callbacks.onError?.(new Error(message));
  }
}

/** Build a session wired to a mock client; returns { session, events, clients }. */
function makeSession({ botId = 'bot-1', handlers = {}, surface } = {}) {
  const events = [];
  const clients = [];
  const session = new VoiceCallSession({
    botId,
    handlers,
    ...(surface !== undefined ? { surface } : {}),
    clientFactory: (callbacks) => {
      const client = new MockVoiceClient(callbacks);
      clients.push(client);
      return client;
    },
    onEvent: (event) => events.push(event),
  });
  return { session, events, clients };
}

async function waitFor(cond, timeoutMs = 5000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------------------
// Surface register: register / unregister / list / fallback
// ---------------------------------------------------------------------------

test('surface: register/unregister/list, latest surface wins, fallback on close', () => {
  const { session } = makeSession();
  assert.equal(session.getSurface(), 'desk');
  assert.equal(session.hasSurfaces(), false);
  assert.deepEqual(session.listSurfaces(), []);

  const chat = session.registerSurface('desk', 'chat');
  assert.equal(chat.botId, 'bot-1');
  assert.equal(chat.surface, 'desk');
  assert.equal(chat.view, 'chat');
  assert.ok(chat.surfaceId.startsWith('vs-'));
  assert.equal(session.getSurface(), 'desk');
  assert.equal(session.hasSurfaces(), true);

  const call = session.registerSurface('carplay', 'call');
  assert.equal(session.getSurface(), 'carplay');
  assert.equal(session.getMaxReplyChars(), VOICE_SURFACE_MAX_REPLY_CHARS.carplay);
  assert.equal(session.listSurfaces().length, 2);

  // Closing the newest surface falls back to the previous one.
  assert.equal(session.unregisterSurface(call.surfaceId), true);
  assert.equal(session.getSurface(), 'desk');
  assert.equal(session.getMaxReplyChars(), VOICE_SURFACE_MAX_REPLY_CHARS.desk);
  assert.equal(session.listSurfaces().length, 1);

  // Unknown id: nothing happens, returns false.
  assert.equal(session.unregisterSurface('vs-no-such'), false);
  assert.equal(session.listSurfaces().length, 1);

  // Closing the last surface falls back to desk.
  assert.equal(session.unregisterSurface(chat.surfaceId), true);
  assert.equal(session.getSurface(), 'desk');
  assert.equal(session.hasSurfaces(), false);
});

test('surface: unknown surface / view is rejected, never recorded', () => {
  const { session } = makeSession();
  assert.throws(() => session.registerSurface('tv'), /unknown surface/);
  assert.throws(() => session.registerSurface('desk', 'popup'), /unknown surface view/);
  assert.equal(session.listSurfaces().length, 0);
  assert.equal(session.getSurface(), 'desk');
});

test('surface: shortenForSurface follows the surface on record', () => {
  const { session } = makeSession();
  const longText = 'chi tiết. '.repeat(200); // > 600 chars
  assert.ok(session.shortenForSurface(longText).length <= 600);
  session.registerSurface('carplay');
  assert.ok(session.shortenForSurface(longText).length <= 160);
  assert.equal(session.shortenForSurface('Xong rồi.'), 'Xong rồi.');
});

test('surface: register/unregister emit a surface event with the list', () => {
  const { session, events } = makeSession();
  const reg = session.registerSurface('phone', 'chat');
  const emitted = events.filter((e) => e.kind === 'surface');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].botId, 'bot-1');
  assert.equal(emitted[0].surface, 'phone');
  assert.deepEqual(emitted[0].surfaceIds, [reg.surfaceId]);
  assert.equal(emitted[0].surfaces.length, 1);
  session.unregisterSurface(reg.surfaceId);
  assert.equal(events.filter((e) => e.kind === 'surface').length, 2);
  assert.deepEqual(events[events.length - 1].surfaces, []);
});

// ---------------------------------------------------------------------------
// Connect: instructions carry surface guidance, tools are the ten
// voice-call tools only
// ---------------------------------------------------------------------------

test('connect: session instructions carry surface guidance + 10 voice tools', async () => {
  const { session, clients } = makeSession();
  session.registerSurface('carplay');
  await session.connect({ url: 'wss://example.invalid/v1/realtime', instructions: 'You are helpful.' });
  assert.equal(clients.length, 1);
  const config = clients[0].config;
  assert.match(config.instructions, /You are helpful\./);
  assert.match(config.instructions, /CarPlay/);
  assert.match(config.instructions, /driving/);
  assert.equal(config.tools.length, 10);
  assert.deepEqual(
    config.tools.map((t) => t.name),
    ['nudge', 'peek_agents', 'peek_runs', 'peek_changes', 'recall_texts', 'search_conversations', 'stay_silent', 'switch_agent', 'transfer', 'end_call'],
  );
  for (const tool of config.tools) assert.equal(tool.type, 'function');
  assert.equal(session.isConnected(), true);
  session.disconnect();
});

test('connect: default surface is desk when nothing registered', async () => {
  const { session, clients } = makeSession();
  await session.connect({ url: 'wss://example.invalid/v1/realtime', instructions: '' });
  assert.match(clients[0].config.instructions, /transcript/);
  assert.equal(clients[0].config.tools.length, 10);
  session.disconnect();
});

test('connect: second connect while connected is a no-op', async () => {
  const { session, clients } = makeSession();
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  assert.equal(clients.length, 1);
  session.disconnect();
});

// ---------------------------------------------------------------------------
// Events: transcript/audio/error carry botId + surface + surfaceIds
// ---------------------------------------------------------------------------

test('events: transcript/audio/error carry botId, surface and surfaceIds', async () => {
  const { session, events, clients } = makeSession();
  const reg = session.registerSurface('phone', 'chat');
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  const client = clients[0];
  client.serverTranscript('xin chào', false);
  client.serverTranscript('xin chào bot', true);
  client.serverAudio(new Uint8Array([0, 1, 2, 3]));
  client.serverError('boom');
  const transcripts = events.filter((e) => e.kind === 'transcript');
  assert.equal(transcripts.length, 2);
  assert.deepEqual(
    transcripts.map((e) => [e.botId, e.text, e.isFinal, e.surface, e.surfaceIds]),
    [
      ['bot-1', 'xin chào', false, 'phone', [reg.surfaceId]],
      ['bot-1', 'xin chào bot', true, 'phone', [reg.surfaceId]],
    ],
  );
  const audio = events.filter((e) => e.kind === 'audio');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].botId, 'bot-1');
  assert.equal(audio[0].surface, 'phone');
  assert.deepEqual([...Buffer.from(audio[0].audioBase64, 'base64')], [0, 1, 2, 3]);
  const errors = events.filter((e) => e.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'boom');
  session.disconnect();
});

// ---------------------------------------------------------------------------
// Tool calls: harness executes, outcome goes back to the server
// ---------------------------------------------------------------------------

test('toolcall: served outcome runs the bound handler and is sent back', async () => {
  const { session, events, clients } = makeSession({
    handlers: {
      peek_runs: () => [{ id: 'run-1', status: 'running' }],
    },
  });
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  const client = clients[0];
  client.serverToolCall({ id: 'call-1', name: 'peek_runs', args: {} });
  await waitFor(() => events.some((e) => e.kind === 'toolcall'));
  const toolEvent = events.find((e) => e.kind === 'toolcall');
  assert.equal(toolEvent.botId, 'bot-1');
  assert.deepEqual(toolEvent.call, { id: 'call-1', name: 'peek_runs', args: {} });
  assert.equal(toolEvent.outcome.kind, 'served');
  assert.deepEqual(toolEvent.outcome.output, [{ id: 'run-1', status: 'running' }]);
  // The outcome is answered back to the realtime server so the model
  // can speak the result.
  assert.equal(client.toolResults.length, 1);
  assert.equal(client.toolResults[0].callId, 'call-1');
  assert.match(client.toolResults[0].output, /run-1/);
  assert.equal(session.isConnected(), true);
  session.disconnect();
});

test('toolcall: unknown tool and invalid input are classified, still answered', async () => {
  const { session, events, clients } = makeSession({
    handlers: { nudge: () => 'nudged' },
  });
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  const client = clients[0];
  client.serverToolCall({ id: 'call-u', name: 'read_file', args: { path: 'a.txt' } });
  client.serverToolCall({ id: 'call-i', name: 'nudge', args: { to: 'agent-b' } });
  await waitFor(() => events.filter((e) => e.kind === 'toolcall').length === 2);
  const [unknown, invalid] = events.filter((e) => e.kind === 'toolcall');
  assert.equal(unknown.outcome.kind, 'unknown_tool');
  assert.equal(invalid.outcome.kind, 'invalid_input');
  assert.match(invalid.outcome.error, /missing required argument/);
  // Both still get a function output back — the conversation must not stall.
  assert.equal(client.toolResults.length, 2);
  assert.match(client.toolResults[0].output, /error: unknown voice-call tool/);
  assert.match(client.toolResults[1].output, /error: .*missing required argument/);
  session.disconnect();
});

test('toolcall: served end_call hangs up after answering', async () => {
  const { session, events, clients } = makeSession({
    handlers: { end_call: () => 'bye' },
  });
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  const client = clients[0];
  client.serverToolCall({ id: 'call-end', name: 'end_call', args: {} });
  await waitFor(() => events.some((e) => e.kind === 'toolcall'));
  await waitFor(() => session.isConnected() === false);
  assert.equal(client.toolResults.length, 1);
  assert.equal(client.toolResults[0].callId, 'call-end');
  assert.equal(client.disconnects, 1);
  session.disconnect();
});

test('toolcall: no handler bound means unknown_tool, never the general registry', async () => {
  const { session, events, clients } = makeSession();
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  clients[0].serverToolCall({ id: 'call-n', name: 'peek_agents', args: {} });
  await waitFor(() => events.some((e) => e.kind === 'toolcall'));
  const toolEvent = events.find((e) => e.kind === 'toolcall');
  assert.equal(toolEvent.outcome.kind, 'unknown_tool');
  assert.match(toolEvent.outcome.error, /no handler bound/);
  session.disconnect();
});

// ---------------------------------------------------------------------------
// STT PCM16 path: sendAudio validates frames, commit asks for a reply
// ---------------------------------------------------------------------------

test('audio: sendAudio accepts even PCM16 frames, rejects odd/empty/not-connected', async () => {
  const { session, clients } = makeSession();
  assert.throws(() => session.sendAudio(new Uint8Array([1, 2])), /not connected/);
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  session.sendAudio(new Uint8Array([0, 0, 255, 127]));
  assert.equal(clients[0].audioFrames.length, 1);
  assert.throws(() => session.sendAudio(new Uint8Array([1, 2, 3])), /even byte length/);
  assert.throws(() => session.sendAudio(new Uint8Array([])), /empty/);
  assert.equal(clients[0].audioFrames.length, 1); // rejected frames never sent
  session.disconnect();
});

test('audio: commitAudio commits + requests a response; throws when not connected', async () => {
  const { session, clients } = makeSession();
  assert.throws(() => session.commitAudio(), /not connected/);
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  session.commitAudio();
  assert.equal(clients[0].commits, 1);
  assert.equal(clients[0].responses, 1);
  session.disconnect();
  assert.throws(() => session.commitAudio(), /not connected/);
});

// ---------------------------------------------------------------------------
// Lifecycle: disconnect keeps surfaces, dispose clears everything
// ---------------------------------------------------------------------------

test('lifecycle: disconnect keeps surfaces for a redial, dispose clears all', async () => {
  const { session } = makeSession();
  const reg = session.registerSurface('headphones', 'chat');
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  session.disconnect();
  assert.equal(session.isConnected(), false);
  assert.equal(session.listSurfaces().length, 1);
  assert.equal(session.getSurface(), 'headphones');
  // A redial reuses the same session + surface.
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  assert.equal(session.isConnected(), true);
  assert.equal(session.listSurfaces().length, 1);
  session.dispose();
  assert.equal(session.isConnected(), false);
  assert.deepEqual(session.listSurfaces(), []);
  assert.equal(session.getSurface(), 'desk');
  await assert.rejects(session.connect({ url: 'wss://example.invalid/v1/realtime' }), /disposed/);
  void reg;
});

test('lifecycle: a throwing event sink never breaks the call', async () => {
  const events = [];
  const session = new VoiceCallSession({
    botId: 'bot-9',
    clientFactory: (callbacks) => new MockVoiceClient(callbacks),
    onEvent: () => {
      throw new Error('renderer sink broke');
    },
  });
  session.registerSurface('desk');
  await session.connect({ url: 'wss://example.invalid/v1/realtime' });
  assert.equal(session.isConnected(), true);
  session.disconnect();
  assert.equal(session.isConnected(), false);
  void events;
});

// ---------------------------------------------------------------------------
// truncateToolOutput + RealtimeClient.sendToolResult (real client, mock socket)
// ---------------------------------------------------------------------------

test('truncateToolOutput: short output passes, long output is capped', () => {
  assert.equal(truncateToolOutput('ok'), 'ok');
  assert.equal(truncateToolOutput({ a: 1 }), '{"a":1}');
  const big = 'x'.repeat(VOICE_CALL_REQUEST_CHAR_LIMIT + 100);
  const capped = truncateToolOutput(big);
  assert.equal(capped.length, VOICE_CALL_REQUEST_CHAR_LIMIT + 1);
  assert.ok(capped.endsWith('…'));
});

test('RealtimeClient.sendToolResult: answers with function_call_output + response.create', async () => {
  const sockets = [];
  class MockSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = MockSocket.OPEN;
      this.onopen?.({});
    }
  }
  const client = new RealtimeClient();
  assert.throws(() => client.sendToolResult('c1', 'out'), /not connected/);
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    dialTimeoutMs: 5000,
    tools: [{ type: 'function', name: 'nudge', description: 'd', parameters: { type: 'object', properties: {} } }],
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].open();
  await connecting;
  // session.update carried the tools list.
  const update = JSON.parse(sockets[0].sent[0]);
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.tools.length, 1);
  assert.equal(update.session.tools[0].name, 'nudge');
  // Answering a tool call sends exactly the two follow-up messages.
  const before = sockets[0].sent.length;
  client.sendToolResult('call-9', '{"runs":[]}');
  assert.equal(sockets[0].sent.length, before + 2);
  const item = JSON.parse(sockets[0].sent[before]);
  assert.equal(item.type, 'conversation.item.create');
  assert.equal(item.item.type, 'function_call_output');
  assert.equal(item.item.call_id, 'call-9');
  assert.equal(item.item.output, '{"runs":[]}');
  assert.equal(JSON.parse(sockets[0].sent[before + 1]).type, 'response.create');
  client.disconnect();
});
