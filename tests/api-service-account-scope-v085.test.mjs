/**
 * Tests for v0.85a (P0-1): service-account scope enforcement on the
 * Local API (packages/core/src/api/server.ts).
 *
 * The bug: a `run`-scoped service-account token could approve its
 * own dangerous tool call through POST /v1/harness/permissions/:id,
 * because the scope was dropped when the desktop main process built
 * `extraTokens` (string[]) and the server never carried a scope in
 * its auth context. The fix threads `{ token, scope }` from
 * team.json through main.ts into createApiServer, attaches the scope
 * to every request's auth context, and refuses `run` tokens with a
 * clear 403 on admin-only routes.
 *
 * Scope decisions locked in by these tests:
 * - `run`  -> may run bots (POST /v1/bots/:id/run, WS run stream,
 *   read-only GETs) but NOT POST /v1/harness/permissions/:id,
 *   POST /mcp, POST /a2a, nor the WS `approval-response` control
 *   message (including the unified `{type:"answer", callId}` form).
 * - `admin` / main token -> full access, unchanged.
 * - Bare string token, or `{ token }` without scope -> NO scope,
 *   keeps the pre-v0.85a behaviour (full access). Deliberate
 *   backwards compatibility: only tokens that explicitly declare
 *   `scope: 'run'` are restricted.
 * - An `extraTokens` entry whose scope is present but not 'run' /
 *   'admin' fails server creation (fail-closed).
 * - Read-only routes (GET /v1/bots, /v1/harness/status, ...) stay
 *   open to `run` tokens; the automation webhook routes are NOT
 *   gated here because they need a second secret (HMAC /
 *   Composio signature) besides the Bearer token.
 *
 * Mock handlers/mounts only: no real API key, no live x.ai.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/api-service-account-scope-v085.test.mjs
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApiServer } from '../packages/core/dist/api/server.js';

const MAIN_TOKEN = 'test-token-scope-v085-main';
const RUN_TOKEN = 'test-token-scope-v085-run';
const ADMIN_TOKEN = 'test-token-scope-v085-admin';
const LEGACY_TOKEN = 'test-token-scope-v085-legacy';
const OBJECT_UNSCOPED_TOKEN = 'test-token-scope-v085-object-unscoped';
const BOTS = [{ id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mock ApiHandlers; `calls` records every permission/approval invocation. */
function scopeHandlers() {
  const calls = { respondHarnessPermission: [], respondApproval: [], respondAskUser: [] };
  const handlers = {
    listBots: async () => BOTS,
    runBot: async (_botId, text) => {
      await sleep(25);
      return { text: `echo: ${text}` };
    },
    // WS stream: waits on an approval, never settles on its own —
    // the test closes the socket (which stops the run).
    runBotStream: async (_botId, _text, emit) => {
      emit({ kind: 'approval-needed', data: { callId: 'call-1', call: { method: 'shell_exec' } } });
      await new Promise(() => undefined);
    },
    getHistory: async () => [],
    listTasks: async () => [],
    harnessStatus: async () => ({ enabled: true, instances: [], pendingPermissions: [] }),
    harnessThreadLog: async () => ({ total: 0, entries: [] }),
    respondHarnessPermission: async (requestId, allowed) => {
      calls.respondHarnessPermission.push([requestId, allowed]);
      return { requestId, found: true, allowed };
    },
    respondApproval: async (callId, approved) => {
      calls.respondApproval.push([callId, approved]);
      return { found: true };
    },
    respondAskUser: async (requestId, answer) => {
      calls.respondAskUser.push([requestId, answer]);
      return { found: true };
    },
  };
  return { handlers, calls };
}

/** Minimal MCP mount: answers `ping` straight through handleJsonRpc. */
function mockMcpServer(calls) {
  return {
    listToolNames: () => [],
    listToolDefinitions: () => [],
    handleJsonRpc: async (body) => {
      calls.mcp.push(body);
      return { jsonrpc: '2.0', id: body?.id ?? null, result: { ok: true } };
    },
  };
}

/** Minimal A2A mount: answers `message:send` straight through handleJsonRpc. */
function mockA2aServer(calls) {
  return {
    getAgentCard: () => ({}),
    handleJsonRpc: async (body) => {
      calls.a2a.push(body);
      return { jsonrpc: '2.0', id: body?.id ?? null, result: { status: { state: 'completed' } } };
    },
    getTask: () => null,
  };
}

const servers = [];
async function startServer() {
  const calls = { mcp: [], a2a: [] };
  const { handlers, calls: handlerCalls } = scopeHandlers();
  const server = createApiServer({
    port: 0,
    token: MAIN_TOKEN,
    extraTokens: [
      { token: RUN_TOKEN, scope: 'run' },
      { token: ADMIN_TOKEN, scope: 'admin' },
      LEGACY_TOKEN,
      { token: OBJECT_UNSCOPED_TOKEN },
    ],
    handlers,
    mcpServer: mockMcpServer(calls),
    a2aServer: mockA2aServer(calls),
  });
  await server.start();
  servers.push(server);
  return { server, calls, handlerCalls };
}
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
});

function base(server) {
  return `http://127.0.0.1:${server.port}`;
}

async function req(server, p, token, opts = {}) {
  return fetch(`${base(server)}${p}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function pollRun(server, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await req(server, `/v1/runs/${runId}`, MAIN_TOKEN);
    assert.equal(res.status, 200);
    const run = await res.json();
    if (run.status !== 'running') return run;
    assert.ok(Date.now() < deadline, 'run did not finish in time');
    await sleep(10);
  }
}

/** Interactive WebSocket client (same shape as tests/ws-control.test.mjs). */
function openControlStream(server, token, { botId = 'bot-1', text = 'hello bot' } = {}) {
  const url = `ws://127.0.0.1:${server.port}/v1/bots/${botId}/run/stream?text=${encodeURIComponent(text)}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const messages = [];
  const waiters = [];
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
  };
  ws.addEventListener('message', (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(parsed)) {
        waiters.splice(i, 1)[0].resolve(parsed);
      }
    }
  });
  return api;
}

// ---------------------------------------------------------------------------
// `run` token: admin-only HTTP routes -> 403, handler never runs
// ---------------------------------------------------------------------------

test('v0.85a: token run gọi POST /v1/harness/permissions/:id -> 403, handler không chạy', async () => {
  const { server, handlerCalls } = await startServer();
  const res = await req(server, '/v1/harness/permissions/req-1', RUN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed: true }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /scope "run"/);
  assert.deepEqual(handlerCalls.respondHarnessPermission, []);
});

test('v0.85a: token run gọi POST /mcp -> 403, MCP server không nhận request', async () => {
  const { server, calls } = await startServer();
  const res = await req(server, '/mcp', RUN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /scope "run"/);
  assert.deepEqual(calls.mcp, []);
});

test('v0.85a: token run gọi POST /a2a -> 403, A2A server không nhận request', async () => {
  const { server, calls } = await startServer();
  const res = await req(server, '/a2a', RUN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message:send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'chào' }] } },
    }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /scope "run"/);
  assert.deepEqual(calls.a2a, []);
});

// ---------------------------------------------------------------------------
// `run` token: chạy bot + đọc vẫn OK
// ---------------------------------------------------------------------------

test('v0.85a: token run vẫn chạy bot (POST run -> 202, run done) và đọc GET', async () => {
  const { server } = await startServer();
  const runRes = await req(server, '/v1/bots/bot-1/run', RUN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'chào bot' }),
  });
  assert.equal(runRes.status, 202);
  const { runId } = await runRes.json();
  const run = await pollRun(server, runId);
  assert.equal(run.status, 'done');
  assert.equal(run.text, 'echo: chào bot');

  const botsRes = await req(server, '/v1/bots', RUN_TOKEN);
  assert.equal(botsRes.status, 200);
  assert.deepEqual(await botsRes.json(), BOTS);

  // Read-only harness routes stay open to `run` tokens.
  const statusRes = await req(server, '/v1/harness/status', RUN_TOKEN);
  assert.equal(statusRes.status, 200);
});

// ---------------------------------------------------------------------------
// `admin` / main / legacy-unscoped tokens: full access, unchanged
// ---------------------------------------------------------------------------

test('v0.85a: token admin gọi permissions + /mcp + /a2a -> 200', async () => {
  const { server, calls, handlerCalls } = await startServer();
  const decide = await req(server, '/v1/harness/permissions/req-1', ADMIN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed: true }),
  });
  assert.equal(decide.status, 200);
  assert.deepEqual(await decide.json(), { requestId: 'req-1', found: true, allowed: true });
  assert.deepEqual(handlerCalls.respondHarnessPermission, [['req-1', true]]);

  const mcp = await req(server, '/mcp', ADMIN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(mcp.status, 200);
  assert.equal(calls.mcp.length, 1);

  const a2a = await req(server, '/a2a', ADMIN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message:send', params: {} }),
  });
  assert.equal(a2a.status, 200);
  assert.equal(calls.a2a.length, 1);
});

test('v0.85a: token chính gọi permissions -> 200 (quyền không đổi)', async () => {
  const { server, handlerCalls } = await startServer();
  const res = await req(server, '/v1/harness/permissions/req-9', MAIN_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed: false }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(handlerCalls.respondHarnessPermission, [['req-9', false]]);
});

test('v0.85a: token không scope (string trần + object không scope) giữ hành vi cũ: permissions + /mcp -> 200', async () => {
  const { server, handlerCalls } = await startServer();
  for (const token of [LEGACY_TOKEN, OBJECT_UNSCOPED_TOKEN]) {
    const decide = await req(server, '/v1/harness/permissions/req-legacy', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed: true }),
    });
    assert.equal(decide.status, 200, `legacy token ${token} phải giữ quyền cũ`);
    const mcp = await req(server, '/mcp', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(mcp.status, 200, `legacy token ${token} phải vào được /mcp`);
  }
  assert.equal(handlerCalls.respondHarnessPermission.length, 2);
});

test('v0.85a: extraTokens có scope lạ -> createApiServer throw (fail-closed)', () => {
  const { handlers } = scopeHandlers();
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: MAIN_TOKEN,
        extraTokens: [{ token: 'x', scope: 'superuser' }],
        handlers,
      }),
    /invalid scope/,
  );
});

// ---------------------------------------------------------------------------
// WS: `run` token không được trả lời approval của chính nó
// ---------------------------------------------------------------------------

test('v0.85a: WS token run gửi approval-response / answer -> error event, respondApproval không chạy', async () => {
  const { server, handlerCalls } = await startServer();
  const stream = openControlStream(server, RUN_TOKEN);
  try {
    const started = await stream.waitFor((m) => m.kind === 'run-started');
    assert.ok(started.data.runId);
    await stream.waitFor((m) => m.kind === 'approval-needed');

    stream.send({ type: 'approval-response', callId: 'call-1', approved: true });
    const err = await stream.waitFor(
      (m) => m.kind === 'error' && /scope "run"/.test(m.data?.error ?? ''),
    );
    assert.match(err.data.error, /không được trả lời approval/);
    assert.deepEqual(handlerCalls.respondApproval, []);
    // Socket stays open after a refused control message.
    assert.equal(stream.ws.readyState, WebSocket.OPEN);

    // Unified `{type:"answer", callId}` routes to the same gate.
    stream.send({ type: 'answer', callId: 'call-1', approved: true });
    const err2 = await stream.waitFor(
      (m) => m.kind === 'error' && /scope "run"/.test(m.data?.error ?? '') && m !== err,
    );
    assert.match(err2.data.error, /không được trả lời approval/);
    assert.deepEqual(handlerCalls.respondApproval, []);
  } finally {
    stream.close();
  }
});

test('v0.85a: WS token chính gửi approval-response -> respondApproval chạy', async () => {
  const { server, handlerCalls } = await startServer();
  const stream = openControlStream(server, MAIN_TOKEN);
  try {
    await stream.waitFor((m) => m.kind === 'run-started');
    await stream.waitFor((m) => m.kind === 'approval-needed');
    stream.send({ type: 'approval-response', callId: 'call-1', approved: true });
    await sleep(100);
    assert.deepEqual(handlerCalls.respondApproval, [['call-1', true]]);
    assert.equal(stream.messages.some((m) => m.kind === 'error'), false);
  } finally {
    stream.close();
  }
});
