/**
 * AG-UI SSE transport + renderer feed tests (v0.97, Team T3).
 *
 * - Local API: GET /v1/agui/events streams AG-UI events as SSE
 *   (Bearer auth, type filter, Last-Event-ID replay), and
 *   GET /v1/agui/runs/:runId/state returns the shared run state.
 *   Unmounted handlers answer 404; a bad `type=` answers 400; no
 *   token answers 401 — the same auth contract as the harness SSE.
 * - Renderer feed reducer (aguiFeed.ts, imported as TS via Node's
 *   type stripping): text deltas accumulate, tool calls fold into
 *   one item, generative-UI components open/answer, harness events
 *   bridge only for CLI/mock engines.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/agui-sse-v097.test.mjs
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { createApiServer } from '../packages/core/dist/api/server.js';
import {
  AgUiEventBus,
  AgUiRuntimeEmitter,
  AgUiStateStore,
  makeAgUiEvent,
  parseAgUiSseChunk,
} from '../packages/core/dist/index.js';
import {
  appendAgUiEventToFeed,
  buildAgUiFeed,
  harnessEventToAgUiView,
  shouldBridgeHarnessEvent,
  summarizeAgUiFeed,
} from '../apps/desktop/src/renderer/components/agui/aguiFeed.ts';

const TOKEN = 'test-token-agui-v097';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sseHandlers(bus, store) {
  return {
    listBots: async () => [],
    runBot: async () => ({ text: '' }),
    getHistory: async () => [],
    listTasks: async () => [],
    subscribeAgUiEvents: (filter, emit) => bus.subscribe(filter, emit),
    replayAgUiEvents: (runId, fromSequence) => bus.replay(runId, fromSequence),
    getAgUiRunState: (runId) => store.get(runId) ?? null,
  };
}

function getJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
  });
}

/** Open an SSE stream and collect frames until `stopAfterMs`. `onOpen`
 * fires on the first data chunk (the open frame) — the live
 * subscription is registered by then, so events emitted after it
 * cannot be lost to a subscribe race. */
function collectSse(port, path, { headers = {}, stopAfterMs = 300, onOpen } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } },
      (res) => {
        let raw = '';
        let opened = false;
        const timer = setTimeout(() => {
          res.destroy();
          req.destroy();
          const { frames } = parseAgUiSseChunk(raw);
          resolve({ status: res.statusCode, frames, raw });
        }, stopAfterMs);
        res.on('data', (chunk) => {
          raw += chunk.toString();
          if (!opened) {
            opened = true;
            onOpen?.();
          }
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );
    req.on('error', reject);
  });
}

const servers = [];
async function startServer(handlers) {
  const server = createApiServer({ port: 0, token: TOKEN, handlers });
  await server.start();
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
});

test('agui sse: live stream delivers events, filters by type, rejects bad auth', async () => {
  const bus = new AgUiEventBus();
  const store = new AgUiStateStore();
  const server = await startServer(sseHandlers(bus, store));
  const emitter = new AgUiRuntimeEmitter({ bus, stateStore: store, runId: 'run-1', botId: 'bot-1', providerId: 'openai' });

  const collecting = collectSse(server.port, '/v1/agui/events?runId=run-1', { stopAfterMs: 400 });
  await sleep(50);
  emitter.runStarted({ title: 'sse test' });
  emitter.textContent('hello sse');
  emitter.textEnd();
  emitter.runFinished('completed', 'hello sse');
  const { status, frames } = await collecting;
  assert.equal(status, 200);
  const types = frames.filter((f) => f.data).map((f) => f.data.type);
  assert.ok(types.includes('RUN_STARTED'), `expected RUN_STARTED in ${types.join(',')}`);
  assert.ok(types.includes('TEXT_MESSAGE_CONTENT'));
  assert.ok(types.includes('RUN_FINISHED'));
  assert.ok(
    frames.every((f) => f.heartbeat === true || f.comment === true || typeof f.data?.type === 'string'),
    'every frame is a heartbeat, a comment, or a data event',
  );

  // Type filter: only TOOL_CALL_START arrives.
  // v0.97: stream này không có runId nên không replay được — event phát
  // TRƯỚC khi server đăng ký subscribe sẽ mất. Chờ frame mở (subscribe
  // đã đăng ký xong) rồi mới phát, thay vì sleep mù 50ms sau khi gửi
  // request (request có thể chưa tới server khi máy tải nặng → mất event).
  let openFiltered;
  const openedFiltered = new Promise((resolve) => {
    openFiltered = resolve;
  });
  const filtered = collectSse(server.port, '/v1/agui/events?type=TOOL_CALL_START', {
    stopAfterMs: 250,
    onOpen: openFiltered,
  });
  await openedFiltered;
  await sleep(50);
  emitter.textContent('filtered out');
  emitter.toolCallStart('c9', 'read_file', {});
  const filteredResult = await filtered;
  const filteredTypes = filteredResult.frames.filter((f) => f.data).map((f) => f.data.type);
  assert.deepEqual(filteredTypes, ['TOOL_CALL_START']);

  // No token -> 401 (same auth contract as the other routes).
  const unauth = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.port, path: '/v1/agui/events' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(unauth, 401);
});

test('agui sse: Last-Event-ID replays buffered events, then live continues', async () => {
  const bus = new AgUiEventBus();
  const store = new AgUiStateStore();
  const server = await startServer(sseHandlers(bus, store));
  const emitter = new AgUiRuntimeEmitter({ bus, stateStore: store, runId: 'run-1', botId: 'bot-1', providerId: 'openai' });
  emitter.runStarted({ title: 'replay test' });
  const last = bus.lastEvent('run-1');
  assert.ok(last?.sequence !== undefined);
  emitter.textContent('first');
  // Reconnect with Last-Event-ID = the snapshot event: the client
  // must get everything after it (the text content), not before.
  const replayed = collectSse(server.port, '/v1/agui/events?runId=run-1', {
    headers: { 'Last-Event-ID': `run-1:${last.sequence}` },
    stopAfterMs: 300,
  });
  await sleep(50);
  emitter.textContent('second');
  const { frames } = await replayed;
  const deltas = frames
    .filter((f) => f.data?.type === 'TEXT_MESSAGE_CONTENT')
    .map((f) => f.data.data.delta);
  assert.ok(deltas.includes('first'), 'replay must include events after Last-Event-ID');
  assert.ok(deltas.includes('second'), 'live events must follow the replay');
});

test('agui sse: bad type is 400, unmounted handlers are 404, state endpoint works', async () => {
  const bus = new AgUiEventBus();
  const store = new AgUiStateStore();
  const server = await startServer(sseHandlers(bus, store));
  const bad = await getJson(server.port, '/v1/agui/events?type=NOPE');
  assert.equal(bad.status, 400);

  const emitter = new AgUiRuntimeEmitter({ bus, stateStore: store, runId: 'run-1', botId: 'bot-1', providerId: 'openai' });
  emitter.runStarted({ title: 'state test' });
  const state = await getJson(server.port, '/v1/agui/runs/run-1/state');
  assert.equal(state.status, 200);
  const parsed = JSON.parse(state.body);
  assert.equal(parsed.runId, 'run-1');
  assert.equal(parsed.state.status, 'running');
  const missing = await getJson(server.port, '/v1/agui/runs/run-nope/state');
  assert.equal(missing.status, 404);

  const bare = await startServer({
    listBots: async () => [],
    runBot: async () => ({ text: '' }),
    getHistory: async () => [],
    listTasks: async () => [],
  });
  const unmounted = await getJson(bare.port, '/v1/agui/events');
  assert.equal(unmounted.status, 404);
  const unmountedState = await getJson(bare.port, '/v1/agui/runs/run-1/state');
  assert.equal(unmountedState.status, 404);
});

// ---------------------------------------------------------------------------
// Renderer feed reducer
// ---------------------------------------------------------------------------

test('agui feed: text deltas accumulate into one item, tool call folds into one item', () => {
  const events = [
    makeAgUiEvent('RUN_STARTED', 'run-1', { title: 'feed test' }, { botId: 'bot-1' }),
    makeAgUiEvent('TEXT_MESSAGE_START', 'run-1', { messageId: 'm1' }, { botId: 'bot-1', messageId: 'm1' }),
    makeAgUiEvent('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'hel' }, { botId: 'bot-1', messageId: 'm1' }),
    makeAgUiEvent('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm1', delta: 'lo' }, { botId: 'bot-1', messageId: 'm1' }),
    makeAgUiEvent('TOOL_CALL_START', 'run-1', { toolCallId: 'c1', toolName: 'read_file' }, { botId: 'bot-1', toolCallId: 'c1' }),
    makeAgUiEvent('TOOL_CALL_ARGS', 'run-1', { toolCallId: 'c1', toolName: 'read_file', argKeys: ['path'] }, { botId: 'bot-1', toolCallId: 'c1' }),
    makeAgUiEvent('TOOL_CALL_END', 'run-1', { toolCallId: 'c1', toolName: 'read_file', status: 'ok' }, { botId: 'bot-1', toolCallId: 'c1' }),
    makeAgUiEvent('TOOL_CALL_RESULT', 'run-1', { toolCallId: 'c1', toolName: 'read_file', ok: true, outputPreview: 'contents' }, { botId: 'bot-1', toolCallId: 'c1' }),
    makeAgUiEvent('RUN_FINISHED', 'run-1', { status: 'completed', finalText: 'hello' }, { botId: 'bot-1' }),
  ];
  const items = buildAgUiFeed(events);
  assert.equal(items.length, 3, 'run + text + tool items (no per-delta rows)');
  const text = items.find((i) => i.kind === 'text');
  assert.equal(text?.text, 'hello');
  const tool = items.find((i) => i.kind === 'tool');
  assert.equal(tool?.toolName, 'read_file');
  assert.equal(tool?.toolStatus, 'ok');
  assert.deepEqual(tool?.argKeys, ['path']);
  assert.equal(tool?.outputPreview, 'contents');
  const run = items.find((i) => i.kind === 'run');
  assert.equal(run?.runStatus, 'completed');
  const summary = summarizeAgUiFeed(items);
  assert.deepEqual(summary, { runs: 1, runningRuns: 0, toolCalls: 1, failedTools: 0, components: 0, pendingComponents: 0 });
});

test('agui feed: generative UI opens and answers, state snapshot/delta apply', () => {
  let items = [];
  items = appendAgUiEventToFeed(
    items,
    makeAgUiEvent('GENERATIVE_UI', 'run-1', {
      componentId: 'c1',
      kind: 'confirm',
      title: 'Delete?',
      props: { summary: 'Deletes one file.' },
    }, { botId: 'bot-1' }),
  );
  assert.equal(summarizeAgUiFeed(items).pendingComponents, 1);
  items = appendAgUiEventToFeed(
    items,
    makeAgUiEvent('GENERATIVE_UI_RESPONSE', 'run-1', { componentId: 'c1', response: { confirmed: true } }, { botId: 'bot-1' }),
  );
  assert.equal(summarizeAgUiFeed(items).pendingComponents, 0);
  assert.equal(items.find((i) => i.kind === 'genui')?.component?.answered, true);

  items = appendAgUiEventToFeed(
    items,
    makeAgUiEvent('STATE_SNAPSHOT', 'run-1', { state: { status: 'running', count: 1 } }, { botId: 'bot-1' }),
  );
  items = appendAgUiEventToFeed(
    items,
    makeAgUiEvent('STATE_DELTA', 'run-1', { operations: [{ op: 'set', path: 'count', value: 2 }] }, { botId: 'bot-1' }),
  );
  const state = items.find((i) => i.kind === 'state');
  assert.equal(state?.state.count, 2);
  assert.equal(state?.state.status, 'running');
});

test('agui feed: harness bridge only for CLI/mock engines', () => {
  const at = new Date().toISOString();
  const cliEvent = {
    botId: 'bot-1',
    threadId: 'bot-1',
    engine: 'claude-code',
    kind: 'text',
    payload: { delta: 'hi' },
    at,
  };
  const apiEvent = { ...cliEvent, engine: 'openai' };
  assert.equal(shouldBridgeHarnessEvent(cliEvent), true);
  assert.equal(shouldBridgeHarnessEvent(apiEvent), false);
  assert.equal(shouldBridgeHarnessEvent({ ...cliEvent, engine: 'mock' }), true);
  assert.equal(shouldBridgeHarnessEvent({ ...cliEvent, engine: 'custom-acp:my-cli' }), true);
  const bridged = harnessEventToAgUiView(cliEvent, 'bot-1');
  assert.equal(bridged?.type, 'TEXT_MESSAGE_CONTENT');
  assert.equal(bridged?.data.delta, 'hi');
  const items = buildAgUiFeed(bridged ? [bridged] : []);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'text');
  assert.equal(items[0].text, 'hi');
});
