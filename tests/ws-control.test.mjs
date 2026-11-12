/**
 * Tests for v0.9a WS control messages (BEYOND-ROADMAP v0.9, items 1–5):
 *
 * - Server -> client events: `run-started` (first, carries runId),
 *   `approval-needed` / `ask-user` (+ `input-required` right after),
 *   `stopped`. A bad control message gets an `error` event back and
 *   the socket stays open; non-JSON text closes it (1007).
 * - Client -> server: `{type:"stop"}` / `{type:"cancel"}`,
 *   `{type:"approval-response", callId, approved}`,
 *   `{type:"ask-user-response", requestId, answer}`, and the unified
 *   `{type:"answer", ...}` (P1-10: routes by the id present —
 *   `callId` / `requestId` / `elicitationId`) — routed through
 *   ApiHandlers.stopRun / respondApproval / respondAskUser.
 * - Closing the socket stops the run (record becomes `stopped`,
 *   visible on GET /v1/runs/:id).
 * - Coordinator: `runId` travels with a run (caller-supplied or
 *   generated, echoed in RunResult) and RPC `stopRun` stops exactly
 *   one run — running or still queued — by id.
 *
 * Mock providers/handlers only: no real API key, no live x.ai.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/ws-control.test.mjs
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createApiServer } from '../packages/core/dist/api/server.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';

const TOKEN = 'test-token-ws-control';
const TEAM = 'team-1';
const BOTS = [
  { id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Local API server: mock handlers + interactive WS client.
// ---------------------------------------------------------------------------

/** Mock ApiHandlers; `calls` records every control handler invocation. */
function controlHandlers(overrides = {}) {
  const calls = { stopRun: [], respondApproval: [], respondAskUser: [] };
  const handlers = {
    listBots: async () => BOTS,
    runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
    runBotStream: async (_botId, text, emit) => {
      emit({ kind: 'delta', data: 'hi' });
      emit({ kind: 'summary', data: 'hi' });
      return { text: 'hi' };
    },
    stopRun: async (runId) => {
      calls.stopRun.push(runId);
      return { runId, stopped: true };
    },
    respondApproval: async (callId, approved) => {
      calls.respondApproval.push([callId, approved]);
      return { found: true };
    },
    respondAskUser: async (requestId, answer) => {
      calls.respondAskUser.push([requestId, answer]);
      return { found: true };
    },
    getHistory: async () => [],
    listTasks: async () => [],
    ...overrides,
  };
  return { handlers, calls };
}

const servers = [];
async function startServer(handlers) {
  const server = createApiServer({ port: 0, token: TOKEN, teamId: TEAM, handlers });
  await server.start();
  servers.push(server);
  return server;
}
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
});

async function getRun(server, runId) {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/runs/${runId}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Open-Bot-Team': TEAM },
  });
  assert.equal(res.status, 200, 'GET /v1/runs/:id phải trả 200');
  return res.json();
}

/**
 * Interactive WebSocket client: collect messages, wait for a matching
 * one, send control messages, wait for the close frame.
 */
function openControlStream(server, { botId = 'bot-1', text = 'hello bot' } = {}) {
  const url = `ws://127.0.0.1:${server.port}/v1/bots/${botId}/run/stream?text=${encodeURIComponent(text)}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Open-Bot-Team': TEAM },
  });
  const messages = [];
  const waiters = [];
  let closeInfo = null;
  const api = {
    ws,
    messages,
    send(data) {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    },
    close() {
      ws.close();
    },
    waitFor(pred, timeoutMs = 3000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout chờ message sau ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    waitClose(timeoutMs = 3000) {
      if (closeInfo) return Promise.resolve(closeInfo);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout chờ socket đóng sau ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push({ close: true, resolve: (c) => { clearTimeout(timer); resolve(c); } });
      });
    },
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.pred && w.pred(msg)) {
        waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  };
  ws.onclose = (event) => {
    closeInfo = { code: event.code, reason: event.reason };
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.close) {
        waiters.splice(i, 1);
        w.resolve(closeInfo);
      }
    }
  };
  ws.onerror = () => {
    // Handshake/close errors surface through onclose; ignore here.
  };
  return api;
}

const isKind = (kind) => (m) => m.kind === kind;

test('run-started là event đầu tiên, mang runId; approval-response qua WS cho run chạy tiếp', async () => {
  const answered = deferred();
  const { handlers, calls } = controlHandlers({
    respondApproval: async (callId, approved) => {
      calls.respondApproval.push([callId, approved]);
      answered.resolve();
      return { found: true };
    },
    runBotStream: async (_botId, _text, emit) => {
      emit({ kind: 'approval-needed', data: { callId: 'c1', call: { id: 'c1', name: 'write_file', args: {} } } });
      await answered.promise;
      emit({ kind: 'summary', data: 'đã duyệt xong' });
      return { text: 'đã duyệt xong' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  const started = await client.waitFor(isKind('run-started'));
  assert.equal(client.messages[0].kind, 'run-started', 'run-started phải là event đầu tiên');
  assert.equal(typeof started.data.runId, 'string');
  assert.ok(started.data.runId.length > 0);

  const approval = await client.waitFor(isKind('approval-needed'));
  assert.equal(approval.data.callId, 'c1');
  const waiting = await client.waitFor(isKind('input-required'));
  assert.equal(waiting.data.waitingFor, 'approval-needed');
  assert.equal(waiting.data.callId, 'c1');
  assert.equal(waiting.data.runId, started.data.runId);

  client.send({ type: 'approval-response', callId: 'c1', approved: true });
  const summary = await client.waitFor(isKind('summary'));
  assert.equal(summary.data, 'đã duyệt xong');
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.deepEqual(calls.respondApproval, [['c1', true]]);

  const record = await getRun(server, started.data.runId);
  assert.equal(record.status, 'done');
  assert.equal(record.text, 'đã duyệt xong');
});

test('ask-user-response qua WS: run nhận câu trả lời rồi hoàn tất', async () => {
  const answered = deferred();
  const { handlers, calls } = controlHandlers({
    respondAskUser: async (requestId, answer) => {
      calls.respondAskUser.push([requestId, answer]);
      answered.resolve();
      return { found: true };
    },
    runBotStream: async (_botId, _text, emit) => {
      emit({ kind: 'ask-user', data: { requestId: 'q1', question: 'Chọn một?', options: ['a', 'b'] } });
      await answered.promise;
      emit({ kind: 'summary', data: 'đã trả lời' });
      return { text: 'đã trả lời' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  const started = await client.waitFor(isKind('run-started'));
  const asked = await client.waitFor(isKind('ask-user'));
  assert.equal(asked.data.requestId, 'q1');
  const waiting = await client.waitFor(isKind('input-required'));
  assert.equal(waiting.data.waitingFor, 'ask-user');
  assert.equal(waiting.data.requestId, 'q1');

  client.send({ type: 'ask-user-response', requestId: 'q1', answer: 'a' });
  await client.waitFor(isKind('summary'));
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.deepEqual(calls.respondAskUser, [['q1', 'a']]);
  const record = await getRun(server, started.data.runId);
  assert.equal(record.status, 'done');
});

test('answer thống nhất qua WS (approval): run nhận duyệt rồi hoàn tất', async () => {
  const answered = deferred();
  const { handlers, calls } = controlHandlers({
    respondApproval: async (callId, approved) => {
      calls.respondApproval.push([callId, approved]);
      answered.resolve();
      return { found: true };
    },
    runBotStream: async (_botId, _text, emit) => {
      emit({ kind: 'approval-needed', data: { callId: 'c1', call: { id: 'c1', name: 'write_file', args: {} } } });
      await answered.promise;
      emit({ kind: 'summary', data: 'đã duyệt xong' });
      return { text: 'đã duyệt xong' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  const started = await client.waitFor(isKind('run-started'));
  await client.waitFor(isKind('approval-needed'));
  const waiting = await client.waitFor(isKind('input-required'));
  assert.equal(waiting.data.waitingFor, 'approval-needed');

  // Client chỉ gửi answer + callId, không cần biết tên message chuyên biệt.
  client.send({ type: 'answer', callId: 'c1', approved: true });
  const summary = await client.waitFor(isKind('summary'));
  assert.equal(summary.data, 'đã duyệt xong');
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.deepEqual(calls.respondApproval, [['c1', true]]);
  const record = await getRun(server, started.data.runId);
  assert.equal(record.status, 'done');
});

test('answer thống nhất qua WS (ask-user): run nhận câu trả lời rồi hoàn tất', async () => {
  const answered = deferred();
  const { handlers, calls } = controlHandlers({
    respondAskUser: async (requestId, answer) => {
      calls.respondAskUser.push([requestId, answer]);
      answered.resolve();
      return { found: true };
    },
    runBotStream: async (_botId, _text, emit) => {
      emit({ kind: 'ask-user', data: { requestId: 'q1', question: 'Chọn một?', options: ['a', 'b'] } });
      await answered.promise;
      emit({ kind: 'summary', data: 'đã trả lời' });
      return { text: 'đã trả lời' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  const started = await client.waitFor(isKind('run-started'));
  await client.waitFor(isKind('ask-user'));
  const waiting = await client.waitFor(isKind('input-required'));
  assert.equal(waiting.data.waitingFor, 'ask-user');

  client.send({ type: 'answer', requestId: 'q1', answer: 'b' });
  await client.waitFor(isKind('summary'));
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.deepEqual(calls.respondAskUser, [['q1', 'b']]);
  const record = await getRun(server, started.data.runId);
  assert.equal(record.status, 'done');
});

test('answer với callId lạ: error event, socket vẫn mở, run không bị ảnh hưởng', async () => {
  const { handlers, calls } = controlHandlers({
    runBotStream: async (_botId, _text, emit) => {
      await sleep(800);
      emit({ kind: 'summary', data: 'hi' });
      return { text: 'hi' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  await client.waitFor(isKind('run-started'));
  client.send({ type: 'answer', callId: 'c-không-tồn-tại', approved: true });
  const err = await client.waitFor(isKind('error'));
  assert.match(err.data.error, /callId/);
  const summary = await client.waitFor(isKind('summary'));
  assert.equal(summary.data, 'hi');
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.deepEqual(calls.respondApproval, [], 'callId lạ không được trả lời');
  assert.deepEqual(calls.respondAskUser, []);
});

test('answer sai định dạng (thiếu id / id sai kiểu): error event, socket vẫn mở, run xong bình thường', async () => {
  // Thiếu mọi id: chỉ báo lỗi, run vẫn chạy tiếp.
  {
    const { handlers, calls } = controlHandlers({
      runBotStream: async (_botId, _text, emit) => {
        await sleep(800);
        emit({ kind: 'summary', data: 'hi' });
        return { text: 'hi' };
      },
    });
    const server = await startServer(handlers);
    const client = openControlStream(server);
    await client.waitFor(isKind('run-started'));
    client.send({ type: 'answer', approved: true });
    const err = await client.waitFor(isKind('error'));
    assert.match(err.data.error, /answer cần/);
    await client.waitFor(isKind('summary'));
    const closed = await client.waitClose();
    assert.equal(closed.code, 1000);
    assert.deepEqual(calls.respondApproval, []);
  }
  // callId sai kiểu (số, không phải chuỗi): cũng chỉ báo lỗi, không crash, không route nhầm sang ask-user.
  {
    const { handlers, calls } = controlHandlers({
      runBotStream: async (_botId, _text, emit) => {
        await sleep(800);
        emit({ kind: 'summary', data: 'hi' });
        return { text: 'hi' };
      },
    });
    const server = await startServer(handlers);
    const client = openControlStream(server);
    await client.waitFor(isKind('run-started'));
    client.send({ type: 'answer', callId: 123, approved: true });
    const err = await client.waitFor(isKind('error'));
    assert.match(err.data.error, /answer cần/);
    await client.waitFor(isKind('summary'));
    const closed = await client.waitClose();
    assert.equal(closed.code, 1000);
    assert.deepEqual(calls.respondApproval, []);
    assert.deepEqual(calls.respondAskUser, []);
  }
});

test('stop giữa run: nhận stopped, socket đóng 1000, record stopped, signal đã abort', async () => {
  const seen = {};
  const { handlers, calls } = controlHandlers({
    runBotStream: async (_botId, _text, _emit, opts) => {
      seen.runId = opts?.runId;
      seen.signal = opts?.signal;
      await Promise.race([
        new Promise((r) => opts?.signal?.addEventListener('abort', r, { once: true })),
        sleep(5000),
      ]);
      return { text: 'chậm' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  const started = await client.waitFor(isKind('run-started'));
  const runId = started.data.runId;
  assert.equal(seen.runId, runId, 'handler phải nhận đúng runId của stream');
  assert.ok(seen.signal instanceof AbortSignal, 'handler phải nhận AbortSignal');

  client.send({ type: 'stop' });
  const stopped = await client.waitFor(isKind('stopped'));
  assert.equal(stopped.data.runId, runId);
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.equal(seen.signal.aborted, true);
  assert.deepEqual(calls.stopRun, [runId], 'stop phải gọi handlers.stopRun với runId');

  const record = await getRun(server, runId);
  assert.equal(record.status, 'stopped');
  assert.ok(!('text' in record) || record.text === undefined);
});

test('cancel với runId của run khác bị từ chối: error event, socket vẫn mở, run xong bình thường', async () => {
  // Run mock chậm để socket còn mở khi client gửi control message.
  const { handlers, calls } = controlHandlers({
    runBotStream: async (_botId, _text, emit) => {
      await sleep(800);
      emit({ kind: 'summary', data: 'hi' });
      return { text: 'hi' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  const started = await client.waitFor(isKind('run-started'));
  client.send({ type: 'cancel', runId: 'run-không-phải-của-socket-này' });
  const err = await client.waitFor(isKind('error'));
  assert.match(err.data.error, /chỉ điều khiển run/);
  // Socket vẫn mở: run mock xong bình thường rồi mới đóng 1000.
  const summary = await client.waitFor(isKind('summary'));
  assert.equal(summary.data, 'hi');
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.deepEqual(calls.stopRun, [], 'run lạ không được dừng');
  const record = await getRun(server, started.data.runId);
  assert.equal(record.status, 'done');
});

test('approval-response với callId lạ: error event, socket vẫn mở, run không bị ảnh hưởng', async () => {
  const { handlers, calls } = controlHandlers({
    runBotStream: async (_botId, _text, emit) => {
      await sleep(800);
      emit({ kind: 'summary', data: 'hi' });
      return { text: 'hi' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  await client.waitFor(isKind('run-started'));
  client.send({ type: 'approval-response', callId: 'c-không-tồn-tại', approved: true });
  const err = await client.waitFor(isKind('error'));
  assert.match(err.data.error, /callId/);
  const summary = await client.waitFor(isKind('summary'));
  assert.equal(summary.data, 'hi');
  const closed = await client.waitClose();
  assert.equal(closed.code, 1000);
  assert.deepEqual(calls.respondApproval, [], 'callId lạ không được trả lời');
});

test('control message sai định dạng: error event, socket vẫn mở; message không phải JSON: đóng 1007, run stopped', async () => {
  // Sai type: chỉ báo lỗi, run vẫn chạy tiếp.
  {
    const { handlers } = controlHandlers({
      runBotStream: async (_botId, _text, emit) => {
        await sleep(800);
        emit({ kind: 'summary', data: 'hi' });
        return { text: 'hi' };
      },
    });
    const server = await startServer(handlers);
    const client = openControlStream(server);
    await client.waitFor(isKind('run-started'));
    client.send({ type: 'pause' });
    const err = await client.waitFor(isKind('error'));
    assert.match(err.data.error, /pause/);
    await client.waitFor(isKind('summary'));
    const closed = await client.waitClose();
    assert.equal(closed.code, 1000);
  }
  // Không phải JSON: đóng 1007, run bị dừng.
  {
    const seen = {};
    const { handlers } = controlHandlers({
      runBotStream: async (_botId, _text, _emit, opts) => {
        seen.signal = opts?.signal;
        await Promise.race([
          new Promise((r) => opts?.signal?.addEventListener('abort', r, { once: true })),
          sleep(5000),
        ]);
        return { text: 'chậm' };
      },
    });
    const server = await startServer(handlers);
    const client = openControlStream(server);
    const started = await client.waitFor(isKind('run-started'));
    client.send('đây không phải JSON');
    const closed = await client.waitClose();
    assert.equal(closed.code, 1007);
    assert.equal(seen.signal.aborted, true);
    const record = await getRun(server, started.data.runId);
    assert.equal(record.status, 'stopped');
  }
});

test('đóng socket giữa run: run bị dừng (record stopped, signal abort)', async () => {
  const seen = {};
  const { handlers, calls } = controlHandlers({
    runBotStream: async (_botId, _text, _emit, opts) => {
      seen.signal = opts?.signal;
      await Promise.race([
        new Promise((r) => opts?.signal?.addEventListener('abort', r, { once: true })),
        sleep(5000),
      ]);
      return { text: 'chậm' };
    },
  });
  const server = await startServer(handlers);
  const client = openControlStream(server);

  const started = await client.waitFor(isKind('run-started'));
  client.close();
  await client.waitClose();
  // Đợi record chuyển sang stopped (server xử lý close frame bất đồng bộ).
  let record;
  for (let i = 0; i < 20; i++) {
    record = await getRun(server, started.data.runId);
    if (record.status === 'stopped') break;
    await sleep(100);
  }
  assert.equal(record.status, 'stopped');
  assert.equal(seen.signal.aborted, true);
  assert.deepEqual(calls.stopRun, [started.data.runId]);
});

// ---------------------------------------------------------------------------
// Coordinator: runId + stopRun (trực tiếp, không qua child process).
// ---------------------------------------------------------------------------

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-wsctrl-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function botConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function mockProvider(text, extra = {}) {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text, ...extra }] };
}

async function createMockBot(coordinator, id, text = 'xong', extra = {}) {
  await coordinator.createBot({
    bot: botConfig(id, tmpWorkspace()),
    provider: mockProvider(text, extra),
  });
}

test('coordinator stopRun: dừng đúng run theo id, run còn lại chạy tiếp', async () => {
  const coordinator = new AgentCoordinator({ toolFactory: () => [] });
  await createMockBot(coordinator, 'ws-a', 'xong A', { delayMs: 600 });
  await createMockBot(coordinator, 'ws-b', 'xong B', { delayMs: 600 });

  const runA = coordinator.run({ botId: 'ws-a', text: 'chậm A', runId: 'run-a' });
  const runB = coordinator.run({ botId: 'ws-b', text: 'chậm B', runId: 'run-b' });
  await sleep(150);
  const stopped = coordinator.stopRun({ runId: 'run-a' });
  assert.equal(stopped.runId, 'run-a');
  assert.equal(stopped.stopped, true);

  const resultA = await runA;
  assert.equal(resultA.text, 'xong A');
  assert.equal(resultA.stopped, true);
  assert.equal(resultA.runId, 'run-a', 'RunResult phải echo lại runId');
  const resultB = await runB;
  assert.equal(resultB.text, 'xong B');
  assert.equal(resultB.stopped, false, 'run không bị stop phải chạy bình thường');
  assert.equal(resultB.runId, 'run-b');

  const again = coordinator.stopRun({ runId: 'run-a' });
  assert.equal(again.stopped, false, 'run đã xong thì stopRun báo không dừng được');
});

test('coordinator stopRun: run chưa chạy (đang xếp hàng) bị huỷ trước khi bắt đầu', async () => {
  const coordinator = new AgentCoordinator({ toolFactory: () => [], maxConcurrentRuns: 1 });
  await createMockBot(coordinator, 'ws-q1', 'xong 1', { delayMs: 400 });
  await createMockBot(coordinator, 'ws-q2', 'xong 2', { delayMs: 100 });

  const run1 = coordinator.run({ botId: 'ws-q1', text: 'chạy trước', runId: 'run-q1' });
  const run2 = coordinator.run({ botId: 'ws-q2', text: 'xếp hàng', runId: 'run-q2' });
  await sleep(100);
  const stopped = coordinator.stopRun({ runId: 'run-q2' });
  assert.equal(stopped.stopped, true);
  await assert.rejects(run2, /bị huỷ khi đang xếp hàng/);
  const result1 = await run1;
  assert.equal(result1.text, 'xong 1');
  assert.equal(result1.stopped, false);
});

test('coordinator run: không đưa runId thì tự sinh và echo lại; stopRun id lạ báo stopped:false', async () => {
  const coordinator = new AgentCoordinator({ toolFactory: () => [] });
  await createMockBot(coordinator, 'ws-g', 'xong nhanh');
  const result = await coordinator.run({ botId: 'ws-g', text: 'hỏi nhanh' });
  assert.equal(typeof result.runId, 'string');
  assert.ok(result.runId.length > 0, 'runId tự sinh phải có');
  assert.equal(result.stopped, false);

  const unknown = coordinator.stopRun({ runId: 'không-tồn-tại' });
  assert.equal(unknown.stopped, false);
  assert.match(unknown.reason ?? '', /không tìm thấy run/);
  assert.throws(() => coordinator.stopRun({}), /stopRun cần params/);
});
