/**
 * Tests cho v0.90a — Đội G: event log harness hoàn chỉnh.
 *
 *   (a) agent loop -> harness: turn-start/end, text, tool_call (chỉ
 *       tên key args — value secret KHÔNG vào log), result, error;
 *       không có harnessSink thì loop chạy như cũ, không event nào.
 *   (b) coordinator nối sink thật: một run qua coordinator.run() ghi
 *       đủ event vào NDJSON ThreadLog của bot.
 *   (f) IPC: parseHarnessThreadLogParams (validate thuần, main dùng
 *       ở đầu handler `harness:thread-log`).
 *   (e) SSE GET /v1/harness/events: Bearer auth, replay từ NDJSON log
 *       + Last-Event-ID resume, live event, heartbeat, unsubscribe
 *       khi client ngắt, 404 khi chưa mount, 400 khi kind lạ.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/harness-eventlog-v090a.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock provider + thư mục tạm + fake Local API handlers.
 * Secret giả chỉ xuất hiện trong args test để chứng minh log redact
 * được nó — không bao giờ là key thật.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { LocalHarness } from '../packages/core/dist/harness/index.js';
import { HARNESS_EVENT_KINDS, parseHarnessThreadLogParams } from '../packages/core/dist/ipc/validate.js';
import { createApiServer } from '../packages/core/dist/api/server.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-eventlog-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function waitUntil(fn, timeoutMs = 5000, stepMs = 25) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Secret GIẢ — chỉ để chứng minh log không ghi value của args. */
const FAKE_SECRET = 'sk-FAKESECRET-abc123-do-not-use';

function makeBot(dir, id = 'bot-loop') {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
  };
}

function makeEvents() {
  return {
    texts: [],
    calls: [],
    results: [],
    onText(text) {
      this.texts.push(text);
    },
    onToolCall(call) {
      this.calls.push(call);
    },
    onToolResult(result) {
      this.results.push(result);
    },
  };
}

function echoTool() {
  return {
    definition: {
      name: 'echo',
      description: 'Echo back the input.',
      parameters: { type: 'object', properties: { msg: { type: 'string' } } },
    },
    needsApproval: false,
    async execute(args) {
      return `echo: ${args.msg}`;
    },
  };
}

/** Mock provider: lượt 1 gọi tool echo (args chứa secret giả), lượt 2 trả text. */
function scriptedProvider() {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat() {
      i += 1;
      if (i === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'call-1', name: 'echo', args: { msg: 'hello', apiKey: FAKE_SECRET } },
          ],
        };
      }
      return { text: 'done', toolCalls: [] };
    },
  };
}

function kindsOf(page) {
  return page.entries.map((e) => e.kind);
}

// ---------------------------------------------------------------------------
// (a) Loop -> harness (trực tiếp qua AgentRunner)
// ---------------------------------------------------------------------------

test('v0.90a loop->harness: turn ghi đủ event vào bus + NDJSON, tool_call chỉ giữ tên key args', async () => {
  const dir = makeTempDir();
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const seenOnBus = [];
  harness.bus.subscribe({}, (event) => seenOnBus.push(event));
  const events = makeEvents();
  const runner = new AgentRunner(scriptedProvider(), [echoTool()], {
    bot: makeBot(dir),
    events,
    harnessSink: (kind, payload) =>
      harness.publishLoopEvent('bot-loop', 'bot-loop', 'mock', kind, payload),
  });
  const text = await runner.run('hi');
  assert.equal(text, 'done');
  assert.deepEqual(events.calls.map((c) => c.name), ['echo']);

  const page = harness.readThreadLog('bot-loop', {});
  assert.deepEqual(kindsOf(page), ['lifecycle', 'tool_call', 'result', 'text', 'lifecycle']);
  assert.equal(page.total, 5);

  const [turnStart, toolCall, result, textEvent, turnEnd] = page.entries;
  assert.equal(turnStart.payload.phase, 'turn-start');
  assert.equal(turnEnd.payload.phase, 'turn-end');
  assert.equal(turnEnd.payload.status, 'ok');
  assert.deepEqual(toolCall.payload, { callId: 'call-1', tool: 'echo', argKeys: ['msg', 'apiKey'] });
  assert.equal(result.payload.tool, 'echo');
  assert.equal(result.payload.ok, true);
  assert.match(result.payload.output, /echo: hello/);
  assert.equal(textEvent.payload.text, 'done');

  // Bus nhận đúng 5 event đã sanitize (cùng envelope với log).
  assert.equal(seenOnBus.length, 5);
  assert.deepEqual(
    seenOnBus.map((e) => e.kind),
    kindsOf(page),
  );

  // File NDJSON thật: có tên tool + tên key, KHÔNG có value secret.
  const raw = fs.readFileSync(path.join(dataDir, 'harness-logs', 'bot-loop.ndjson'), 'utf8');
  assert.ok(raw.includes('"tool":"echo"'), 'log phải ghi tên tool');
  assert.ok(raw.includes('apiKey'), 'log phải ghi tên key args');
  assert.ok(!raw.includes(FAKE_SECRET), 'log KHÔNG được chứa value secret trong args');
});

test('v0.90a loop->harness: không có harnessSink thì loop chạy như cũ, không event nào', async () => {
  const dir = makeTempDir();
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const events = makeEvents();
  const runner = new AgentRunner(scriptedProvider(), [echoTool()], {
    bot: makeBot(dir),
    events,
  });
  const text = await runner.run('hi');
  assert.equal(text, 'done');
  assert.equal(harness.bus.totalPublished, 0);
  assert.equal(harness.readThreadLog('bot-loop', {}).total, 0);
});

test('v0.90a loop->harness: sink throw không làm hỏng run', async () => {
  const dir = makeTempDir();
  const events = makeEvents();
  const runner = new AgentRunner(scriptedProvider(), [echoTool()], {
    bot: makeBot(dir),
    events,
    harnessSink: () => {
      throw new Error('sink hỏng');
    },
  });
  const text = await runner.run('hi');
  assert.equal(text, 'done', 'run vẫn xong dù sink throw');
});

// ---------------------------------------------------------------------------
// (b) Coordinator nối sink thật
// ---------------------------------------------------------------------------

test('v0.90a coordinator: run thật ghi event loop vào NDJSON ThreadLog của bot', async () => {
  const dir = makeTempDir();
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const seenOnBus = [];
  harness.bus.subscribe({}, (event) => seenOnBus.push(event));
  const coordinator = new AgentCoordinator({
    dataDir,
    toolFactory: () => [echoTool()],
    emit: () => undefined,
    harness,
  });
  try {
    await coordinator.createBot({
      bot: makeBot(dir, 'bot-coord'),
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [
          {
            text: '',
            toolCalls: [
              { id: 'call-1', name: 'echo', args: { msg: 'hello', apiKey: FAKE_SECRET } },
            ],
          },
          { text: 'done' },
        ],
      },
    });
    const status = await coordinator.handle('harnessStatus', {});
    assert.equal(status.enabled, true);
    assert.equal(status.instances.length, 1);

    const result = await coordinator.run({ botId: 'bot-coord', text: 'hi' });
    assert.equal(result.text, 'done');

    const page = await coordinator.handle('harnessThreadLog', { threadId: 'bot-coord' });
    assert.deepEqual(kindsOf(page), ['lifecycle', 'tool_call', 'result', 'text', 'lifecycle']);
    const toolCall = page.entries.find((e) => e.kind === 'tool_call');
    assert.deepEqual(toolCall.payload, { callId: 'call-1', tool: 'echo', argKeys: ['msg', 'apiKey'] });
    // Bus của coordinator cũng thấy event loop (đường live stream dùng nó).
    assert.ok(
      seenOnBus.some((e) => e.kind === 'tool_call' && e.botId === 'bot-coord'),
      'bus phải thấy tool_call của run',
    );
    const raw = fs.readFileSync(path.join(dataDir, 'harness-logs', 'bot-coord.ndjson'), 'utf8');
    assert.ok(!raw.includes(FAKE_SECRET), 'log coordinator KHÔNG được chứa value secret');
  } finally {
    coordinator.shutdown();
  }
});

// ---------------------------------------------------------------------------
// (f) IPC validate: parseHarnessThreadLogParams
// ---------------------------------------------------------------------------

test('v0.90a IPC validate: parseHarnessThreadLogParams — đúng thì qua, sai thì throw rõ', () => {
  assert.deepEqual(HARNESS_EVENT_KINDS.length, 12); // v0.96 (Đội T3): + 'router.decision'
  assert.deepEqual(parseHarnessThreadLogParams({ threadId: 'bot-1' }), {
    threadId: 'bot-1',
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    parseHarnessThreadLogParams({ threadId: 'bot-1', limit: 10, offset: 20, kinds: ['text', 'error'] }),
    { threadId: 'bot-1', limit: 10, offset: 20, kinds: ['text', 'error'] },
  );
  assert.throws(() => parseHarnessThreadLogParams({}), /threadId/);
  assert.throws(() => parseHarnessThreadLogParams(null), /object/);
  assert.throws(() => parseHarnessThreadLogParams('bot-1'), /object/);
  assert.throws(() => parseHarnessThreadLogParams({ threadId: 'bot-1', limit: 0 }), /limit/);
  assert.throws(() => parseHarnessThreadLogParams({ threadId: 'bot-1', limit: 1001 }), /limit/);
  assert.throws(() => parseHarnessThreadLogParams({ threadId: 'bot-1', limit: 1.5 }), /limit/);
  assert.throws(() => parseHarnessThreadLogParams({ threadId: 'bot-1', offset: -1 }), /offset/);
  assert.throws(
    () => parseHarnessThreadLogParams({ threadId: 'bot-1', kinds: ['nope'] }),
    /kind không hợp lệ: nope/,
  );
  assert.throws(
    () => parseHarnessThreadLogParams({ threadId: 'bot-1', kinds: 'text' }),
    /mảng chuỗi/,
  );
});

// ---------------------------------------------------------------------------
// (e) SSE GET /v1/harness/events
// ---------------------------------------------------------------------------

const API_TOKEN = 'eventlog-test-token-0123456789abcdef';

function sseEntries() {
  return [
    {
      at: '2026-11-11T10:00:00.000Z',
      botId: 'bot-1',
      threadId: 'bot-1',
      kind: 'text',
      payload: { text: 'hello' },
    },
    {
      at: '2026-11-11T10:00:01.000Z',
      botId: 'bot-1',
      threadId: 'bot-1',
      kind: 'tool_call',
      payload: { callId: 'c1', tool: 'echo', argKeys: ['msg'] },
    },
  ];
}

/** Fake mount: replay từ danh sách cố định + 1 live event sau 20ms. */
function sseHandlers(overrides = {}) {
  const entries = sseEntries();
  const seenFilters = [];
  let unsubscribed = false;
  return {
    api: {
      listBots: async () => [{ id: 'bot-1', name: 'Bot 1', providerId: 'mock', model: 'mock' }],
      runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
      getHistory: async () => [],
      listTasks: async () => [],
      harnessThreadLog: async (threadId, opts) => ({
        threadId,
        entries: entries
          .filter((e) => e.threadId === threadId)
          .filter((e) => !opts?.kinds || opts.kinds.includes(e.kind)),
        total: entries.length,
        offset: 0,
        limit: 1000,
      }),
      subscribeHarnessEvents: (filter, emit) => {
        seenFilters.push(filter);
        const timer = setTimeout(() => {
          emit({
            at: '2026-11-11T10:00:02.000Z',
            botId: 'bot-1',
            threadId: 'bot-1',
            engine: 'mock',
            kind: 'result',
            payload: { callId: 'c1', tool: 'echo', ok: true, output: 'echo: hello' },
          });
        }, 20);
        return () => {
          clearTimeout(timer);
          unsubscribed = true;
        };
      },
      ...overrides,
    },
    entries,
    seenFilters,
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

/** Đọc SSE stream tới khi `done()` đúng (hoặc timeout 5s), rồi abort. */
async function collectSse(url, headers, done) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const stopAt = Date.now() + 5000;
  try {
    for (;;) {
      if (done(buf)) break;
      if (Date.now() > stopAt) throw new Error(`SSE timeout, chỉ nhận được: ${buf.slice(0, 500)}`);
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // Đã đóng.
    }
  }
  return { status: res.status, contentType: res.headers.get('content-type'), body: buf };
}

function sseBlocks(body) {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function sseDataEvents(body) {
  return sseBlocks(body)
    .filter((b) => /^id: \S+$/m.test(b) && /^data: /m.test(b))
    .map((b) => {
      const id = (b.match(/^id: (\S+)$/m) ?? [])[1];
      const data = JSON.parse((b.match(/^data: (.*)$/m) ?? [])[1]);
      return { id, data };
    });
}

test('v0.90a SSE: replay + live + heartbeat + unsubscribe khi client ngắt', async () => {
  const mount = sseHandlers();
  const server = createApiServer({
    port: 0,
    token: API_TOKEN,
    handlers: mount.api,
    harnessEventsHeartbeatMs: 50,
  });
  await server.start();
  try {
    const { status, contentType, body } = await collectSse(
      `http://127.0.0.1:${server.port}/v1/harness/events?threadId=bot-1`,
      { Authorization: `Bearer ${API_TOKEN}` },
      (buf) => sseDataEvents(buf).length >= 3 && buf.includes(': heartbeat'),
    );
    assert.equal(status, 200);
    assert.match(contentType, /text\/event-stream/);
    const events = sseDataEvents(body);
    assert.deepEqual(
      events.map((e) => e.data.kind),
      ['text', 'tool_call', 'result'],
      'replay 2 entry rồi mới live event',
    );
    assert.deepEqual(
      events.map((e) => e.id),
      events.map((e) => e.data.at),
      'SSE id phải là `at` của event (chuẩn resume)',
    );
    assert.ok(body.includes(': heartbeat'), 'phải có heartbeat định kỳ');
    // Filter đã tới đúng subscribe handler.
    assert.deepEqual(mount.seenFilters, [{ threadId: 'bot-1' }]);
    // Client ngắt -> server unsubscribe.
    assert.equal(await waitUntil(() => mount.unsubscribed), true, 'ngắt stream phải unsubscribe');
  } finally {
    await server.stop();
  }
});

test('v0.90a SSE: Last-Event-ID resume bỏ qua entry đã nhận, chỉ replay phần mới', async () => {
  const mount = sseHandlers();
  const server = createApiServer({
    port: 0,
    token: API_TOKEN,
    handlers: mount.api,
    harnessEventsHeartbeatMs: 50,
  });
  await server.start();
  try {
    const { body } = await collectSse(
      `http://127.0.0.1:${server.port}/v1/harness/events?threadId=bot-1`,
      {
        Authorization: `Bearer ${API_TOKEN}`,
        'Last-Event-ID': '2026-11-11T10:00:00.000Z',
      },
      (buf) => sseDataEvents(buf).length >= 2,
    );
    const events = sseDataEvents(body);
    assert.deepEqual(
      events.map((e) => e.data.kind),
      ['tool_call', 'result'],
      'entry at 10:00:00 đã nhận rồi thì không replay lại',
    );
  } finally {
    await server.stop();
  }
});

test('v0.90a SSE: lọc kind + 401/404/400', async () => {
  const mount = sseHandlers();
  const server = createApiServer({
    port: 0,
    token: API_TOKEN,
    handlers: mount.api,
    harnessEventsHeartbeatMs: 50,
  });
  await server.start();
  try {
    // Lọc kind=tool_call: replay chỉ còn tool_call, filter tới subscribe.
    const { body } = await collectSse(
      `http://127.0.0.1:${server.port}/v1/harness/events?threadId=bot-1&kind=tool_call`,
      { Authorization: `Bearer ${API_TOKEN}` },
      (buf) => sseDataEvents(buf).length >= 1,
    );
    assert.equal(sseDataEvents(body)[0].data.kind, 'tool_call');
    assert.deepEqual(mount.seenFilters.at(-1), { threadId: 'bot-1', kinds: ['tool_call'] });

    // Không token -> 401, không mở stream.
    const noAuth = await fetch(`http://127.0.0.1:${server.port}/v1/harness/events?threadId=bot-1`);
    assert.equal(noAuth.status, 401);
    await noAuth.text();

    // Kind lạ -> 400.
    const badKind = await fetch(
      `http://127.0.0.1:${server.port}/v1/harness/events?threadId=bot-1&kind=nope`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } },
    );
    assert.equal(badKind.status, 400);
    await badKind.text();
  } finally {
    await server.stop();
  }

  // Chưa mount subscribeHarnessEvents -> 404.
  const bare = createApiServer({
    port: 0,
    token: API_TOKEN,
    handlers: {
      listBots: async () => [],
      runBot: async () => ({ text: '' }),
      getHistory: async () => [],
      listTasks: async () => [],
    },
  });
  await bare.start();
  try {
    const res = await fetch(`http://127.0.0.1:${bare.port}/v1/harness/events`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    assert.equal(res.status, 404);
    await res.text();
  } finally {
    await bare.stop();
  }
});
