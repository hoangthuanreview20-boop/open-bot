/**
 * Tests for P0-1 voice (REA deep-dive §5): redial policy, voice-call
 * toolset, surface register, harness outcomes, STT dictation PCM16.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-p01.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { RealtimeClient } from '../packages/core/dist/voice/realtime.js';
import {
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_MAX_REDIAL_DELAY_MS,
  DEFAULT_MAX_SILENT_PATH_REDIALS,
  DEFAULT_RECONNECT_DELAY_MS,
} from '../packages/core/dist/voice/realtime.js';
import {
  VOICE_CALL_POLICY_CLOSE_CODE,
  VOICE_CALL_REQUEST_CHAR_LIMIT,
  VOICE_CALL_SEARCH_HIT_LIMIT,
  VOICE_CALL_SUPERSEDED_CLOSE_CODE,
  VOICE_REDIAL_DIAL_TIMEOUT_MS,
  VOICE_REDIAL_INITIAL_DELAY_MS,
  VOICE_REDIAL_MAX_ATTEMPTS,
  VOICE_REDIAL_MAX_DELAY_MS,
  VOICE_REDIAL_MAX_SILENT_PATH_REDIALS,
  VOICE_SURFACE_GUIDANCE,
  VOICE_SURFACE_MAX_REPLY_CHARS,
} from '../packages/core/dist/voice/types.js';
import {
  VOICE_CALL_TOOL_NAMES,
  createVoiceCallToolSet,
  isVoiceCallToolName,
  validateVoiceCallArgs,
} from '../packages/core/dist/voice/callTools.js';
import { VoiceCallHarness } from '../packages/core/dist/voice/harness.js';
import {
  DICTATION_MAX_BYTES,
  DICTATION_SAMPLE_RATE_HZ,
  DictationSession,
  pcm16ToWav,
  transcribeDictation,
} from '../packages/core/dist/voice/dictation.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { ALL_TOOLS } from '../packages/tools/dist/index.js';

// ---------------------------------------------------------------------------
// Mock WebSocket (same surface as voice.test.mjs, plus close-code record)
// ---------------------------------------------------------------------------

class MockSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  closeCalled = false;
  closeCode = undefined;
  closeReason = undefined;

  send(data) {
    this.sent.push(typeof data === 'string' ? data : String(data));
  }

  close(code, reason) {
    this.closeCalled = true;
    this.closeCode = code;
    this.closeReason = reason;
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

  failBeforeOpen(code = 1006) {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.({ code, reason: 'connect failed' });
  }
}

async function waitFor(cond, timeoutMs = 5000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect a client with a mock socket factory; returns { client, sockets, errors }. */
async function connectMock({ markActivity = true, ...config } = {}) {
  const sockets = [];
  const errors = [];
  const client = new RealtimeClient({ onError: (e) => errors.push(e) });
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    reconnectDelayMs: 5,
    dialTimeoutMs: 5000,
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
    ...config,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].open();
  // A live call receives session messages: mark the path alive so the
  // silent-path budget (a drop with no message at all) does not apply.
  if (markActivity) sockets[0].receive({ type: 'session.created' });
  await connecting;
  return { client, sockets, errors };
}

// ---------------------------------------------------------------------------
// Redial policy: constants
// ---------------------------------------------------------------------------

test('redial policy constants match the REA deep-dive (§5.2)', () => {
  assert.equal(VOICE_REDIAL_MAX_ATTEMPTS, 20);
  assert.equal(VOICE_REDIAL_DIAL_TIMEOUT_MS, 15_000);
  assert.equal(VOICE_REDIAL_INITIAL_DELAY_MS, 1_000);
  assert.equal(VOICE_REDIAL_MAX_DELAY_MS, 10_000);
  assert.equal(VOICE_REDIAL_MAX_SILENT_PATH_REDIALS, 3);
  assert.equal(VOICE_CALL_POLICY_CLOSE_CODE, 1008);
  assert.equal(VOICE_CALL_SUPERSEDED_CLOSE_CODE, 4001);
  // The client defaults follow the same policy.
  assert.equal(DEFAULT_MAX_RECONNECT_ATTEMPTS, 20);
  assert.equal(DEFAULT_RECONNECT_DELAY_MS, 1_000);
  assert.equal(DEFAULT_DIAL_TIMEOUT_MS, 15_000);
  assert.equal(DEFAULT_MAX_REDIAL_DELAY_MS, 10_000);
  assert.equal(DEFAULT_MAX_SILENT_PATH_REDIALS, 3);
});

test('redialDelayMs: 1s doubling, capped at 10s', () => {
  const d = RealtimeClient.redialDelayMs;
  assert.equal(d(1, 1000, 10000), 1000);
  assert.equal(d(2, 1000, 10000), 2000);
  assert.equal(d(3, 1000, 10000), 4000);
  assert.equal(d(4, 1000, 10000), 8000);
  assert.equal(d(5, 1000, 10000), 10000);
  assert.equal(d(20, 1000, 10000), 10000);
  assert.equal(d(1, 20, 30), 20);
  assert.equal(d(3, 20, 30), 30);
});

// ---------------------------------------------------------------------------
// Redial policy: default budget is 20, not 3
// ---------------------------------------------------------------------------

test('redial: default budget keeps redialing past 3 drops (was 3, now 20)', async () => {
  const { client, sockets } = await connectMock({ reconnectDelayMs: 5 });
  try {
    for (let i = 0; i < 5; i++) {
      sockets[i].drop();
      await waitFor(() => sockets.length === i + 2);
      sockets[i + 1].open();
      sockets[i + 1].receive({ type: 'session.created' });
      await waitFor(() => client.isConnected());
    }
    // 1 initial + 5 redials, all recovered: the old 3-attempt budget
    // would have given up after the 3rd drop.
    assert.equal(sockets.length, 6);
    assert.equal(client.getReconnectAttempts(), 0);
  } finally {
    client.disconnect();
  }
});

test('redial: backoff is capped — 4 redials land well before the uncapped schedule', async () => {
  const { client, sockets } = await connectMock({
    reconnectDelayMs: 20,
    reconnectMaxDelayMs: 30,
    maxReconnectAttempts: 10,
  });
  try {
    const start = Date.now();
    for (let i = 0; i < 4; i++) {
      sockets[i].drop();
      await waitFor(() => sockets.length === i + 2);
      sockets[i + 1].open();
      sockets[i + 1].receive({ type: 'session.created' });
      await waitFor(() => client.isConnected());
    }
    const elapsed = Date.now() - start;
    // Capped schedule: 20+30+30+30 = 110ms. Uncapped would be
    // 20+40+80+160 = 300ms. The pure-function test above is the
    // authoritative check; this only proves the client uses the cap.
    assert.ok(elapsed < 500, `4 capped redials took ${elapsed}ms, expected < 500ms`);
    assert.equal(sockets.length, 5);
  } finally {
    client.disconnect();
  }
});

test('redial: dial timeout rejects a connect that never opens', async () => {
  const sockets = [];
  const client = new RealtimeClient();
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    dialTimeoutMs: 30,
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
  });
  await assert.rejects(connecting, /dial timed out after 30ms/);
  assert.equal(sockets.length, 1);
  client.disconnect();
});

// ---------------------------------------------------------------------------
// Redial policy: silent path
// ---------------------------------------------------------------------------

test('redial: silent-path drops give up after maxSilentPathRedials', async () => {
  const { client, sockets, errors } = await connectMock({
    markActivity: false,
    maxSilentPathRedials: 1,
    maxReconnectAttempts: 20,
  });
  try {
    sockets[0].drop(); // silent drop #1 -> redial
    await waitFor(() => sockets.length === 2);
    sockets[1].open();
    await waitFor(() => client.isConnected());
    sockets[1].drop(); // silent drop #2 -> over budget, give up
    await waitFor(() => client.getState() === 'closed');
    assert.equal(sockets.length, 2);
    assert.equal(client.getSilentPathRedials(), 2);
    assert.match(errors[errors.length - 1].message, /silent path/);
  } finally {
    client.disconnect();
  }
});

test('redial: a server message proves the path alive and resets the silent budget', async () => {
  const { client, sockets } = await connectMock({
    maxSilentPathRedials: 1,
    maxReconnectAttempts: 20,
  });
  try {
    sockets[0].receive({ type: 'session.created' });
    sockets[0].drop(); // had activity -> not silent, redial
    await waitFor(() => sockets.length === 2);
    sockets[1].open();
    await waitFor(() => client.isConnected());
    assert.equal(client.getSilentPathRedials(), 0);
    sockets[1].receive({ type: 'session.created' });
    sockets[1].drop(); // had activity again -> redial, not give up
    await waitFor(() => sockets.length === 3);
    sockets[2].open();
    await waitFor(() => client.isConnected());
    assert.equal(client.getState(), 'connected');
  } finally {
    client.disconnect();
  }
});

// ---------------------------------------------------------------------------
// Redial policy: terminal close codes + superseded
// ---------------------------------------------------------------------------

test('redial: supersede() closes with code 4001 and never redials', async () => {
  const { client, sockets } = await connectMock();
  try {
    client.supersede();
    assert.equal(client.getState(), 'closed');
    assert.equal(sockets[0].closeCalled, true);
    assert.equal(sockets[0].closeCode, VOICE_CALL_SUPERSEDED_CLOSE_CODE);
    await sleep(50);
    assert.equal(sockets.length, 1);
    // Supersede ends the session, not the client: a fresh connect works.
    const connecting = client.connect({
      url: 'wss://example.invalid/v1/realtime',
      reconnectDelayMs: 5,
      dialTimeoutMs: 5000,
      socketFactory: () => {
        const s = new MockSocket();
        sockets.push(s);
        return s;
      },
    });
    await waitFor(() => sockets.length === 2);
    sockets[1].open();
    await connecting;
    assert.equal(client.getState(), 'connected');
  } finally {
    client.disconnect();
  }
});

test('redial: supersede() while dialing rejects the pending connect, no resurrection', async () => {
  const sockets = [];
  const client = new RealtimeClient();
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    dialTimeoutMs: 5000,
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
  });
  await waitFor(() => sockets.length === 1);
  client.supersede();
  assert.equal(client.getState(), 'closed');
  // The stale socket opens late: it must not resurrect the session.
  sockets[0].open();
  await assert.rejects(connecting, /session ended before opening/);
  await sleep(50);
  assert.equal(sockets.length, 1);
  assert.equal(client.getState(), 'closed');
  assert.equal(client.isConnected(), false);
});

test('redial: disconnect() while dialing also settles the pending connect', async () => {
  const sockets = [];
  const client = new RealtimeClient();
  const connecting = client.connect({
    url: 'wss://example.invalid/v1/realtime',
    dialTimeoutMs: 5000,
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
  });
  await waitFor(() => sockets.length === 1);
  client.disconnect();
  await assert.rejects(connecting, /session ended before opening/);
  assert.equal(client.getState(), 'closed');
});

test('redial: server close 4001 (superseded) and 1008 (policy) never redial', async () => {
  for (const code of [VOICE_CALL_SUPERSEDED_CLOSE_CODE, VOICE_CALL_POLICY_CLOSE_CODE]) {
    const { client, sockets, errors } = await connectMock();
    try {
      sockets[0].drop(code);
      await waitFor(() => client.getState() === 'closed');
      await sleep(30);
      assert.equal(sockets.length, 1, `code ${code} must not redial`);
      assert.match(errors[errors.length - 1].message, new RegExp(`terminal code ${code}`));
    } finally {
      client.disconnect();
    }
  }
});

// ---------------------------------------------------------------------------
// Voice-call toolset
// ---------------------------------------------------------------------------

test('voice toolset: exactly the ten call tools, nothing else', () => {
  assert.deepEqual([...VOICE_CALL_TOOL_NAMES], [
    'nudge',
    'peek_agents',
    'peek_runs',
    'peek_changes',
    'recall_texts',
    'search_conversations',
    'stay_silent',
    'switch_agent',
    'transfer',
    'end_call',
  ]);
  assert.equal(VOICE_CALL_REQUEST_CHAR_LIMIT, 4000);
  assert.equal(VOICE_CALL_SEARCH_HIT_LIMIT, 10);
  for (const name of VOICE_CALL_TOOL_NAMES) {
    assert.equal(isVoiceCallToolName(name), true);
  }
  assert.equal(isVoiceCallToolName('read_file'), false);
  assert.equal(isVoiceCallToolName('shell_exec'), false);
  assert.equal(isVoiceCallToolName(''), false);
});

test('voice toolset: char limits are enforced, never silently truncated', () => {
  assert.deepEqual(validateVoiceCallArgs('search_conversations', { query: 'hello' }), {
    ok: true,
    args: { query: 'hello' },
  });
  // Query over its 500-char limit.
  const long = 'x'.repeat(501);
  const over = validateVoiceCallArgs('search_conversations', { query: long });
  assert.equal(over.ok, false);
  assert.match(over.error, /500-char limit/);
  // Missing required field.
  const missing = validateVoiceCallArgs('nudge', { to: 'agent-b' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing required argument "task"/);
  // Unknown field.
  const unknownField = validateVoiceCallArgs('nudge', { task: 'do it', bogus: 'x' });
  assert.equal(unknownField.ok, false);
  assert.match(unknownField.error, /unknown argument "bogus"/);
  // Non-string value.
  const nonString = validateVoiceCallArgs('nudge', { task: 42 });
  assert.equal(nonString.ok, false);
  assert.match(nonString.error, /must be a string/);
  // Unknown tool.
  const unknownTool = validateVoiceCallArgs('read_file', { path: 'a.txt' });
  assert.equal(unknownTool.ok, false);
  assert.match(unknownTool.error, /unknown voice-call tool/);
  // Non-object args.
  assert.equal(validateVoiceCallArgs('nudge', 'do it').ok, false);
  assert.equal(validateVoiceCallArgs('nudge', null).ok, false);
});

test('voice toolset: execute serves, and classifies unknown/invalid without throwing', async () => {
  const calls = [];
  const toolset = createVoiceCallToolSet({
    nudge: async (args) => {
      calls.push(args);
      return `nudged: ${args.task}`;
    },
    stay_silent: () => 'silent',
    end_call: () => {
      throw new Error('hangup failed');
    },
  });
  assert.equal(toolset.has('nudge'), true);
  assert.equal(toolset.has('read_file'), false);
  assert.equal(toolset.definitions.length, 10);

  const served = await toolset.execute('nudge', { task: 'check the build' });
  assert.deepEqual(served, { kind: 'served', tool: 'nudge', output: 'nudged: check the build' });
  assert.deepEqual(calls, [{ task: 'check the build' }]);

  const unknown = await toolset.execute('read_file', { path: 'a.txt' });
  assert.equal(unknown.kind, 'unknown_tool');
  assert.equal(unknown.tool, 'read_file');

  const noHandler = await toolset.execute('peek_agents', {});
  assert.equal(noHandler.kind, 'unknown_tool');
  assert.match(noHandler.error, /no handler bound/);

  const invalid = await toolset.execute('nudge', { to: 'agent-b' });
  assert.equal(invalid.kind, 'invalid_input');
  assert.match(invalid.error, /missing required argument/);

  const failed = await toolset.execute('end_call', {});
  assert.equal(failed.kind, 'invalid_input');
  assert.match(failed.error, /hangup failed/);
});

test('voice toolset: no voice-call tool leaks into the general agent registry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-voice-p01-'));
  const mem = new BotMemory(dir);
  try {
    const general = defaultToolFactory(mem, dir, 'bot-1');
    const generalNames = general.map((t) => t.definition.name);
    assert.ok(generalNames.length > 100, `expected a full registry, got ${generalNames.length}`);
    // The voice definitions are never registered generally. One name
    // overlaps by design: the general registry already had its own
    // `search_conversations` (a full-text tool with JSON-schema params)
    // long before the voice toolset existed — the voice tool of the same
    // name is a different, voice-scoped tool (char limits, no `limit`
    // param, different description). Everything else must be absent.
    for (const name of VOICE_CALL_TOOL_NAMES) {
      if (name === 'search_conversations') continue;
      assert.ok(!generalNames.includes(name), `voice tool ${name} leaked into the general registry`);
    }
    const generalSearch = general.find((t) => t.definition.name === 'search_conversations');
    assert.ok(generalSearch, 'general search_conversations exists');
    assert.notEqual(
      generalSearch.definition.description,
      'Search past conversations for something said before.',
    );
    // The general tool takes a numeric `limit` and has no voice char-limit
    // params; the voice tool takes `quote`/`scope`/`context` with char limits.
    assert.ok(generalSearch.definition.parameters.properties.limit, 'general tool has a limit param');
    assert.ok(!generalSearch.definition.parameters.properties.quote, 'general tool has no voice quote param');
    const defaultNames = ALL_TOOLS.map((t) => t.definition.name);
    for (const name of VOICE_CALL_TOOL_NAMES) {
      assert.ok(!defaultNames.includes(name), `voice tool ${name} in ALL_TOOLS`);
    }
    // Behavioural isolation: the voice toolset cannot reach the general
    // tool of the same name — with no handler bound it reports
    // unknown_tool instead of running the general search.
    const { getVoiceCallToolDefinition } = await import('../packages/core/dist/voice/callTools.js');
    assert.equal(getVoiceCallToolDefinition('search_conversations').parameters.query.charLimit, 500);
    const bare = createVoiceCallToolSet();
    const outcome = await bare.execute('search_conversations', { query: 'hello' });
    assert.equal(outcome.kind, 'unknown_tool');
  } finally {
    try {
      mem.close?.();
    } catch {
      // Best effort; a temp dir is harmless.
    }
  }
});

// ---------------------------------------------------------------------------
// Surface register + harness
// ---------------------------------------------------------------------------

test('surface register: every surface has guidance and a reply cap, carplay tightest', () => {
  for (const surface of ['desk', 'web', 'phone', 'carplay', 'headphones']) {
    assert.ok(VOICE_SURFACE_GUIDANCE[surface].length > 0, `${surface} guidance`);
    assert.ok(VOICE_SURFACE_MAX_REPLY_CHARS[surface] > 0, `${surface} cap`);
  }
  assert.ok(VOICE_SURFACE_MAX_REPLY_CHARS.carplay < VOICE_SURFACE_MAX_REPLY_CHARS.phone);
  assert.ok(VOICE_SURFACE_MAX_REPLY_CHARS.phone <= VOICE_SURFACE_MAX_REPLY_CHARS.desk);
  assert.ok(VOICE_SURFACE_MAX_REPLY_CHARS.desk <= 600);
});

test('harness: surface register drives short replies per surface', () => {
  const harness = new VoiceCallHarness();
  assert.equal(harness.getSurface(), 'desk');
  assert.equal(harness.getMaxReplyChars(), 600);

  const longText = `File src/app.ts đã sửa xong, 3 test mới pass, ` + 'chi tiết. '.repeat(200);
  assert.ok(longText.length > 600);
  const deskShort = harness.shortenForSurface(longText);
  assert.ok(deskShort.length <= 600, `desk reply ${deskShort.length} chars`);
  assert.ok(deskShort.endsWith('…'));

  harness.setSurface('carplay');
  assert.equal(harness.getSurface(), 'carplay');
  assert.equal(harness.getMaxReplyChars(), 160);
  const carShort = harness.shortenForSurface(longText);
  assert.ok(carShort.length <= 160, `carplay reply ${carShort.length} chars`);
  assert.ok(carShort.length < deskShort.length);

  // Short text passes through untouched.
  assert.equal(harness.shortenForSurface('Xong rồi.'), 'Xong rồi.');

  // Unknown surface is rejected, never recorded.
  assert.throws(() => harness.setSurface('tv'), /unknown surface/);
  assert.equal(harness.getSurface(), 'carplay');

  // Surface guidance goes into the session instructions.
  const instructions = harness.buildSessionInstructions('You are helpful.');
  assert.match(instructions, /You are helpful\./);
  assert.match(instructions, /CarPlay/);
  assert.match(instructions, /driving/);
  const bare = new VoiceCallHarness({}, { surface: 'desk' }).buildSessionInstructions('');
  assert.match(bare, /transcript/);
});

test('harness: executeTool outcomes served / unknown_tool / invalid_input', async () => {
  const harness = new VoiceCallHarness({
    peek_runs: () => [{ id: 'run-1', status: 'running' }],
    stay_silent: () => 'ok',
  });
  const served = await harness.executeTool('peek_runs', {});
  assert.equal(served.kind, 'served');
  assert.deepEqual(served.output, [{ id: 'run-1', status: 'running' }]);

  const unknown = await harness.executeTool('read_file', { path: 'a.txt' });
  assert.deepEqual({ kind: unknown.kind, tool: unknown.tool }, { kind: 'unknown_tool', tool: 'read_file' });

  const invalid = await harness.executeTool('search_conversations', { query: 'x'.repeat(501) });
  assert.equal(invalid.kind, 'invalid_input');
  assert.match(invalid.error, /500-char limit/);

  // Realtime function definitions expose only the ten voice tools.
  const defs = harness.toRealtimeFunctionDefinitions();
  assert.equal(defs.length, 10);
  assert.deepEqual(
    defs.map((d) => d.name),
    [...VOICE_CALL_TOOL_NAMES],
  );
  for (const d of defs) {
    assert.equal(d.type, 'function');
    assert.equal(d.parameters.type, 'object');
  }
  const nudge = defs.find((d) => d.name === 'nudge');
  assert.deepEqual(nudge.parameters.required, ['task']);
});

// ---------------------------------------------------------------------------
// STT dictation PCM16
// ---------------------------------------------------------------------------

/** Tiny mock of POST /v1/audio/transcriptions (same shape as voice.test.mjs). */
function startMockStt({ status = 200, body = { text: 'xin chào, đây là dictation' } } = {}) {
  let lastRequest = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastRequest = {
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
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

test('dictation: pcm16ToWav builds a valid RIFF/WAVE header', () => {
  assert.equal(DICTATION_SAMPLE_RATE_HZ, 16000);
  assert.equal(DICTATION_MAX_BYTES, 25 * 1024 * 1024);
  const pcm = new Uint8Array([0, 0, 255, 127, 0, 128]);
  const wav = pcm16ToWav(pcm, 16000);
  assert.equal(wav.length, 44 + pcm.length);
  const text = Buffer.from(wav.subarray(0, 44)).toString('latin1');
  assert.equal(text.slice(0, 4), 'RIFF');
  assert.equal(text.slice(8, 12), 'WAVE');
  assert.equal(text.slice(12, 16), 'fmt ');
  assert.equal(text.slice(36, 40), 'data');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(24, true), 16000); // sample rate
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), pcm.length); // data size
  assert.deepEqual([...wav.subarray(44)], [...pcm]); // samples round-trip
  assert.throws(() => pcm16ToWav(new Uint8Array([1, 2, 3])), /even byte length/);
  assert.throws(() => pcm16ToWav(pcm, 0), /positive integer/);
});

test('dictation: transcribeDictation sends WAV PCM16 and returns text', async () => {
  const stt = await startMockStt();
  try {
    const pcm = new Uint8Array(3200); // 100ms at 16 kHz mono
    const text = await transcribeDictation(pcm, { baseUrl: stt.baseUrl, model: 'whisper-1' });
    assert.equal(text, 'xin chào, đây là dictation');
    assert.equal(stt.lastRequest.method, 'POST');
    assert.equal(stt.lastRequest.url, '/v1/audio/transcriptions');
    assert.match(stt.lastRequest.contentType, /multipart\/form-data/);
    const bodyText = stt.lastRequest.body.toString('latin1');
    assert.match(bodyText, /dictation\.wav/);
    assert.match(bodyText, /audio\/wav/);
    assert.match(bodyText, /whisper-1/);
  } finally {
    stt.server.close();
  }
  await assert.rejects(
    transcribeDictation(new Uint8Array([]), { baseUrl: stt.baseUrl }),
    /audio rỗng/,
  );
  await assert.rejects(
    transcribeDictation(new Uint8Array([1, 2, 3]), { baseUrl: stt.baseUrl }),
    /even byte length/,
  );
});

test('dictation: DictationSession buffers pushAudio frames and transcribes on stop()', async () => {
  const stt = await startMockStt();
  try {
    const session = new DictationSession({ baseUrl: stt.baseUrl });
    assert.equal(session.getBufferedBytes(), 0);
    session.pushAudio(new Uint8Array(1600)); // 50ms
    session.pushAudio(new Uint8Array(1600));
    assert.equal(session.getBufferedBytes(), 3200);
    assert.equal(session.getBufferedDurationMs(), 100);
    const text = await session.stop();
    assert.equal(text, 'xin chào, đây là dictation');
    assert.equal(session.getBufferedBytes(), 0); // buffer cleared after stop
    await assert.rejects(session.stop(), /chưa có audio/);
  } finally {
    stt.server.close();
  }

  // cancel() drops the buffer without transcribing.
  const session2 = new DictationSession({ baseUrl: stt.baseUrl });
  session2.pushAudio(new Uint8Array([1, 2, 3, 4]));
  session2.cancel();
  assert.equal(session2.getBufferedBytes(), 0);
  await assert.rejects(session2.stop(), /chưa có audio/);

  // Odd-length frames and over-cap buffers are rejected.
  const session3 = new DictationSession({ baseUrl: stt.baseUrl, maxBytes: 4 });
  assert.throws(() => session3.pushAudio(new Uint8Array([1, 2, 3])), /even byte length/);
  session3.pushAudio(new Uint8Array([1, 2, 3, 4]));
  assert.throws(() => session3.pushAudio(new Uint8Array([5, 6])), /quá dài/);
});
