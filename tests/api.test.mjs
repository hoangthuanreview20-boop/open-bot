/**
 * Tests for the v0.5 local API server + webhooks
 * (packages/core/src/api/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/api.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { createApiServer } from '../packages/core/dist/api/server.js';
import { WebhookDispatcher } from '../packages/core/dist/api/webhooks.js';

const TOKEN = 'test-token-123';
const BOTS = [
  { id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' },
  { id: 'bot-2', name: 'Coder', providerId: 'xai', model: 'grok-4.7' },
];
const HISTORY = [
  { id: 'm1', role: 'user', text: 'chào', createdAt: 1 },
  { id: 'm2', role: 'assistant', text: 'xin chào', createdAt: 2 },
];
const TASKS = [{ id: 't1', botId: 'bot-1', title: 'Việc 1', status: 'pending' }];

/** Mock handlers: runBot resolves after a short delay, like a real agent turn. */
function mockHandlers(overrides = {}) {
  return {
    listBots: async () => BOTS,
    runBot: async (_botId, text) => {
      await new Promise((r) => setTimeout(r, 25));
      return { text: `echo: ${text}` };
    },
    getHistory: async (_botId, limit) => HISTORY.slice(0, limit),
    listTasks: async (_botId) => TASKS,
    ...overrides,
  };
}

const servers = [];
async function startServer(handlers = mockHandlers(), token = TOKEN) {
  const server = createApiServer({ port: 0, token, handlers });
  await server.start();
  servers.push(server);
  return server;
}
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-api-test-'));
  tempDirs.push(dir);
  return dir;
}

function base(server) {
  return `http://127.0.0.1:${server.port}`;
}

async function req(server, p, opts = {}) {
  return fetch(`${base(server)}${p}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), ...(opts.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }) },
  });
}

async function pollRun(server, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await req(server, `/v1/runs/${runId}`);
    assert.equal(res.status, 200);
    const run = await res.json();
    if (run.status !== 'running') return run;
    assert.ok(Date.now() < deadline, 'run did not finish in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Health: no auth needed
// ---------------------------------------------------------------------------

test('health answers { ok: true } without auth', async () => {
  const server = await startServer();
  const res = await req(server, '/v1/health', { auth: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------------------------------------------------------------------------
// Auth: every other route needs a valid Bearer token
// ---------------------------------------------------------------------------

test('bots/history/tasks/run need auth: missing token -> 401, wrong token -> 401', async () => {
  const server = await startServer();
  for (const p of ['/v1/bots', '/v1/bots/bot-1/history', '/v1/bots/bot-1/tasks', '/v1/runs/abc']) {
    const noAuth = await req(server, p, { auth: false });
    assert.equal(noAuth.status, 401, p);
    assert.match((await noAuth.json()).error, /Authorization/);

    const wrong = await fetch(`${base(server)}${p}`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrong.status, 401, p);
  }
  // POST run without auth too.
  const noAuthRun = await fetch(`${base(server)}/v1/bots/bot-1/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(noAuthRun.status, 401);
});

test('bots lists bots with a valid token; unknown bot -> 404 on history/tasks/run', async () => {
  const server = await startServer();
  const res = await req(server, '/v1/bots');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), BOTS);

  for (const p of ['/v1/bots/nope/history', '/v1/bots/nope/tasks']) {
    assert.equal((await req(server, p)).status, 404);
  }
  const runRes = await req(server, '/v1/bots/nope/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(runRes.status, 404);
});

// ---------------------------------------------------------------------------
// Run: async, poll to done with the mock text
// ---------------------------------------------------------------------------

test('run returns { runId, status: running } immediately, polls to done with mock text', async () => {
  // Slow the mock run down (300 ms) so the "still running" check right
  // after the POST is deterministic even when the suite runs under load;
  // the 25 ms default is shorter than a loaded event loop's scheduling gap.
  const server = await startServer(
    mockHandlers({
      runBot: async (_botId, text) => {
        await new Promise((r) => setTimeout(r, 300));
        return { text: `echo: ${text}` };
      },
    }),
  );
  const res = await req(server, '/v1/bots/bot-1/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello bot' }),
  });
  assert.equal(res.status, 202);
  const started = await res.json();
  assert.equal(started.status, 'running');
  assert.equal(typeof started.runId, 'string');

  // Immediately after starting, the run is still running (mock delays 300 ms).
  const early = await req(server, `/v1/runs/${started.runId}`);
  assert.equal((await early.json()).status, 'running');

  const done = await pollRun(server, started.runId);
  assert.equal(done.status, 'done');
  assert.equal(done.text, 'echo: hello bot');
  assert.equal(done.botId, 'bot-1');
  assert.ok(done.finishedAt >= done.startedAt);
});

test('run with a failing handler polls to error with the handler message', async () => {
  const server = await startServer(
    mockHandlers({ runBot: async () => { throw new Error('provider exploded'); } }),
  );
  const res = await req(server, '/v1/bots/bot-1/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  const { runId } = await res.json();
  const done = await pollRun(server, runId);
  assert.equal(done.status, 'error');
  assert.equal(done.error, 'provider exploded');
});

test('run with missing/empty text -> 400; unknown run id -> 404', async () => {
  const server = await startServer();
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
    const res = await req(server, '/v1/bots/bot-1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const res = await req(server, '/v1/runs/does-not-exist');
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Body parsing: invalid JSON -> 400; history limit respected
// ---------------------------------------------------------------------------

test('invalid JSON body -> 400', async () => {
  const server = await startServer();
  const res = await req(server, '/v1/bots/bot-1/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
});

test('history honours ?limit= and rejects a bad limit', async () => {
  const server = await startServer();
  const one = await req(server, '/v1/bots/bot-1/history?limit=1');
  assert.equal(one.status, 200);
  assert.equal((await one.json()).length, 1);

  const bad = await req(server, '/v1/bots/bot-1/history?limit=abc');
  assert.equal(bad.status, 400);

  const tasks = await req(server, '/v1/bots/bot-1/tasks');
  assert.equal(tasks.status, 200);
  assert.deepEqual(await tasks.json(), TASKS);
});

// ---------------------------------------------------------------------------
// Server lifecycle: busy port throws a clear error; stop() really closes
// ---------------------------------------------------------------------------

test('starting on a busy port throws a clear error', async () => {
  const first = await startServer();
  const second = createApiServer({ port: first.port, token: TOKEN, handlers: mockHandlers() });
  await assert.rejects(second.start(), /already in use/);
});

test('stop() closes the server: further requests fail', async () => {
  const server = await startServer();
  const ok = await req(server, '/v1/health', { auth: false });
  assert.equal(ok.status, 200);
  await server.stop();
  assert.equal(server.isRunning, false);
  await assert.rejects(fetch(`${base(server)}/v1/health`));
});

// ---------------------------------------------------------------------------
// WebhookDispatcher: persistence, dispatch, dead endpoint
// Các test này POST tới mock server trên loopback (127.0.0.1) nên phải
// bật allowInternalUrls — v0.15 (M5) chặn SSRF mặc định ở cả add/load/dispatch.
test('webhook add/list/remove persist to webhooks.json and reload', () => {
  const dir = makeTempDir();
  const storePath = path.join(dir, 'webhooks.json');
  const d = new WebhookDispatcher({ storePath, allowInternalUrls: true });
  assert.deepEqual(d.list(), []);

  const reg = d.add('http://127.0.0.1:9/hook', ['run.done', 'run.error']);
  assert.equal(typeof reg.id, 'string');
  assert.equal(d.list().length, 1);
  assert.ok(fs.existsSync(storePath));

  // A fresh dispatcher reading the same file sees the same webhook.
  const d2 = new WebhookDispatcher({ storePath, allowInternalUrls: true });
  assert.deepEqual(d2.list(), d.list());

  assert.equal(d2.remove(reg.id), true);
  assert.equal(d2.remove(reg.id), false);
  assert.deepEqual(d2.list(), []);

  assert.throws(() => d.add('ftp://example.com/x', ['run.done']), /http/);
  assert.throws(() => d.add('http://example.com/x', []), /at least one/);
  assert.throws(() => d.add('http://example.com/x', ['nope']), /Unknown webhook event/);
});

test('webhook store corrupt or wrong shape loads empty instead of throwing', () => {
  const dir = makeTempDir();
  const storePath = path.join(dir, 'webhooks.json');
  // Invalid JSON.
  fs.writeFileSync(storePath, '{not json', 'utf-8');
  assert.deepEqual(new WebhookDispatcher({ storePath, allowInternalUrls: true }).list(), []);
  // Valid JSON but wrong shape (e.g. a bare array, not {version, webhooks}).
  fs.writeFileSync(storePath, '[{"id":"x","url":"http://127.0.0.1:9/h","events":["run.done"]}]', 'utf-8');
  assert.deepEqual(new WebhookDispatcher({ storePath, allowInternalUrls: true }).list(), []);
  // A good entry still loads after the bad file is replaced by a good one.
  const d = new WebhookDispatcher({ storePath, allowInternalUrls: true });
  const reg = d.add('http://127.0.0.1:9/hook', ['run.done']);
  assert.equal(new WebhookDispatcher({ storePath, allowInternalUrls: true }).list().length, 1);
  assert.equal(new WebhookDispatcher({ storePath, allowInternalUrls: true }).list()[0].id, reg.id);
});

test('webhook dispatch POSTs the exact event JSON to a mock local server', async () => {
  const received = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, contentType: req.headers['content-type'], body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  try {
    const dir = makeTempDir();
    const d = new WebhookDispatcher({ storePath: path.join(dir, 'webhooks.json'), allowInternalUrls: true });
    d.add(`http://127.0.0.1:${port}/hook`, ['run.done']);
    d.add(`http://127.0.0.1:${port}/other`, ['automation.notify']); // must NOT receive run.done

    const results = await d.dispatch({
      kind: 'run.done',
      at: '2026-11-08T00:00:00.000Z',
      data: { botId: 'bot-1', runId: 'r1', text: 'xong' },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/hook');
    assert.match(received[0].contentType, /application\/json/);
    assert.deepEqual(received[0].body, {
      kind: 'run.done',
      at: '2026-11-08T00:00:00.000Z',
      data: { botId: 'bot-1', runId: 'r1', text: 'xong' },
    });
  } finally {
    await new Promise((r) => mock.close(r));
  }
});

test('webhook dispatch to a dead URL does not throw and reports the error', async () => {
  const dir = makeTempDir();
  const d = new WebhookDispatcher({ storePath: path.join(dir, 'webhooks.json'), allowInternalUrls: true });
  // Port 9 (discard) on loopback: nothing listens there.
  d.add('http://127.0.0.1:9/dead', ['run.error']);
  const results = await d.dispatch({
    kind: 'run.error',
    at: new Date().toISOString(),
    data: { botId: 'bot-1', error: 'boom' },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(typeof results[0].error, 'string');
  assert.ok(results[0].error.length > 0);
});
