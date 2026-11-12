/**
 * Tests for the v0.8 local API additions (packages/core/src/api/):
 *
 * - WebSocket streaming: GET /v1/bots/:id/run/stream (RFC 6455 framing
 *   by hand, no new dependency). Real Node WebSocket client, events
 *   { kind, data } (delta/toolcall/toolresult/summary), socket closes
 *   when the run settles. Bearer + X-Open-Bot-Team auth checked before
 *   the upgrade; unauthorised upgrades never open.
 * - HMAC webhook signing: X-Open-Bot-Signature (sha256=...) +
 *   X-Open-Bot-Timestamp, verifyWebhookSignature with 5-min replay
 *   window; unsigned delivery when no secret.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/api-v08.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { createApiServer } from '../packages/core/dist/api/server.js';
import {
  WebhookDispatcher,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_MAX_AGE_SECONDS,
} from '../packages/core/dist/api/webhooks.js';

assert.equal(WEBHOOK_SIGNATURE_MAX_AGE_SECONDS, 300, 'replay window phải là 5 phút');

const TOKEN = 'test-token-v08';
const TEAM = 'team-1';
const BOTS = [
  { id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Handlers whose runBotStream emits a full event sequence, like a real turn. */
function streamHandlers(overrides = {}) {
  return {
    listBots: async () => BOTS,
    runBot: async (_botId, text) => {
      await sleep(10);
      return { text: `echo: ${text}` };
    },
    runBotStream: async (_botId, text, emit) => {
      emit({ kind: 'delta', data: 'hello ' });
      await sleep(20);
      emit({ kind: 'delta', data: 'world' });
      emit({ kind: 'toolcall', data: { id: 'c1', name: 'read_file', args: { path: 'a.txt' } } });
      emit({ kind: 'toolresult', data: { callId: 'c1', ok: true, output: 'nội dung' } });
      emit({ kind: 'summary', data: 'hello world' });
      return { text: 'hello world' };
    },
    getHistory: async () => [],
    listTasks: async () => [],
    ...overrides,
  };
}

const servers = [];
async function startServer(handlers = streamHandlers(), opts = {}) {
  const server = createApiServer({ port: 0, token: TOKEN, teamId: TEAM, handlers, ...opts });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-api-v08-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Open a real WebSocket (Node global client) to the stream endpoint.
 * Resolves when the socket closes with every message received.
 * `auth: false` = no Authorization header; `team: false` = no team header.
 */
function connectStream(server, { botId = 'bot-1', text = 'hello bot', auth = true, team = true, token = TOKEN } = {}) {
  const url = `ws://127.0.0.1:${server.port}/v1/bots/${botId}/run/stream?text=${encodeURIComponent(text)}`;
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${token}`;
    if (team) headers['X-Open-Bot-Team'] = TEAM;
    const ws = new WebSocket(url, { headers });
    const messages = [];
    let opened = false;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
      reject(new Error('WebSocket did not close within 5s'));
    }, 5000);
    ws.onopen = () => { opened = true; };
    ws.onmessage = (event) => {
      messages.push(JSON.parse(event.data));
    };
    ws.onerror = () => {
      // Handshake rejection (401/403/404) surfaces as error + close;
      // the close handler below resolves with opened === false.
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      resolve({ opened, messages, code: event.code, reason: event.reason });
    };
  });
}

// ---------------------------------------------------------------------------
// WebSocket streaming: happy path
// ---------------------------------------------------------------------------

test('WS stream: nhận đủ delta/toolcall/toolresult/summary rồi đóng 1000', async () => {
  const server = await startServer();
  const { opened, messages, code } = await connectStream(server);
  assert.equal(opened, true, 'socket phải mở được với token + team hợp lệ');
  assert.equal(code, 1000, 'run xong phải đóng 1000');

  const kinds = messages.map((m) => m.kind);
  // v0.9a: run-started (mang runId) là event đầu tiên của mọi stream.
  assert.deepEqual(kinds, ['run-started', 'delta', 'delta', 'toolcall', 'toolresult', 'summary']);
  assert.equal(typeof messages[0].data.runId, 'string');
  assert.equal(messages[1].data, 'hello ');
  assert.equal(messages[2].data, 'world');
  assert.equal(messages[3].data.name, 'read_file');
  assert.equal(messages[4].data.callId, 'c1');
  assert.equal(messages[4].data.ok, true);
  assert.equal(messages[5].data, 'hello world');

  // Run record như run HTTP: done + text, webhook hook vẫn chạy.
  const runs = server.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].text, 'hello world');
  assert.equal(runs[0].botId, 'bot-1');
  assert.equal(messages[0].data.runId, runs[0].runId);
});

test('WS stream fallback: không có runBotStream vẫn stream delta + summary', async () => {
  const server = await startServer(streamHandlers({ runBotStream: undefined }));
  const { opened, messages, code } = await connectStream(server);
  assert.equal(opened, true);
  assert.equal(code, 1000);
  assert.deepEqual(
    messages.map((m) => m.kind),
    ['run-started', 'delta', 'summary'],
  );
  assert.equal(typeof messages[0].data.runId, 'string');
  assert.equal(messages[1].data, 'echo: hello bot');
  assert.equal(messages[2].data, 'echo: hello bot');
  assert.equal(server.listRuns()[0].status, 'done');
});

test('WS stream lỗi: nhận event error rồi đóng 1011, run ghi error', async () => {
  const server = await startServer(
    streamHandlers({
      runBotStream: async () => {
        throw new Error('provider exploded');
      },
    }),
  );
  const { opened, messages, code } = await connectStream(server);
  assert.equal(opened, true);
  // v0.9a: run-started đi trước, rồi mới tới event error của run lỗi.
  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, 'run-started');
  assert.equal(typeof messages[0].data.runId, 'string');
  assert.equal(messages[1].kind, 'error');
  assert.equal(messages[1].data.error, 'provider exploded');
  assert.equal(code, 1011);
  assert.equal(server.listRuns()[0].status, 'error');
  assert.equal(server.listRuns()[0].error, 'provider exploded');
});

// ---------------------------------------------------------------------------
// WebSocket streaming: auth checked before the upgrade
// ---------------------------------------------------------------------------

test('WS stream không token / sai token / sai team / bot lạ: không mở được', async () => {
  const server = await startServer();

  const noToken = await connectStream(server, { auth: false });
  assert.equal(noToken.opened, false, 'thiếu Bearer phải bị từ chối trước upgrade');
  assert.equal(noToken.messages.length, 0);

  const wrongToken = await connectStream(server, { token: 'sai' });
  assert.equal(wrongToken.opened, false, 'sai token phải bị từ chối');

  const wrongTeam = await connectStream(server, { team: false });
  assert.equal(wrongTeam.opened, false, 'thiếu X-Open-Bot-Team phải bị từ chối (403)');

  const unknownBot = await connectStream(server, { botId: 'nope' });
  assert.equal(unknownBot.opened, false, 'bot không tồn tại phải bị từ chối (404)');

  assert.equal(server.listRuns().length, 0, 'run bị từ chối không được tạo record');
});

test('WS stream thiếu ?text=: không mở được', async () => {
  const server = await startServer();
  const res = await connectStream(server, { text: '   ' });
  assert.equal(res.opened, false);
});

// ---------------------------------------------------------------------------
// HMAC webhook signing
// ---------------------------------------------------------------------------

function startListener() {
  const received = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({
        signature: req.headers['x-open-bot-signature'],
        timestamp: req.headers['x-open-bot-timestamp'],
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    mock.listen(0, '127.0.0.1', () => resolve({ mock, port: mock.address().port, received }));
  });
}

async function stopListener(mock) {
  await new Promise((r) => mock.close(r));
}

test('webhook có secret: header ký + timestamp, verify pass; sửa body thì fail', async () => {
  const { mock, port, received } = await startListener();
  try {
    const dir = makeTempDir();
    const secret = 'hmac-secret-xyz';
    const d = new WebhookDispatcher({
      storePath: path.join(dir, 'webhooks.json'),
      hmacSecret: secret,
      // Mock server chạy trên loopback — test cơ chế ký, không phải SSRF.
      allowInternalUrls: true,
    });
    assert.equal(d.isSigning, true);
    d.add(`http://127.0.0.1:${port}/hook`, ['run.done']);

    const results = await d.dispatch({
      kind: 'run.done',
      at: '2026-11-09T00:00:00.000Z',
      data: { botId: 'bot-1', runId: 'r1', text: 'xong' },
    });
    assert.equal(results[0].ok, true);
    assert.equal(received.length, 1);

    const { signature, timestamp, body } = received[0];
    assert.match(signature, /^sha256=[0-9a-f]{64}$/);
    assert.match(timestamp, /^\d+$/);
    const ts = Number(timestamp);
    assert.ok(Math.abs(Math.floor(Date.now() / 1000) - ts) <= 5, 'timestamp phải là epoch giây hiện tại');

    assert.equal(verifyWebhookSignature(secret, ts, body, signature), true);
    // Sửa body sau khi ký -> fail.
    assert.equal(
      verifyWebhookSignature(secret, ts, body.replace('xong', 'x0ng'), signature),
      false,
    );
    // Sai secret -> fail.
    assert.equal(verifyWebhookSignature('secret-khac', ts, body, signature), false);
    // Chữ ký rác -> fail, không throw.
    assert.equal(verifyWebhookSignature(secret, ts, body, 'sha256=00'), false);
    assert.equal(verifyWebhookSignature(secret, ts, body, ''), false);
    // Secret rỗng -> fail.
    assert.equal(verifyWebhookSignature('', ts, body, signature), false);
  } finally {
    await stopListener(mock);
  }
});

test('webhook verify: timestamp lệch > 5 phút bị từ chối (chống replay)', async () => {
  const secret = 's';
  const body = '{"kind":"run.done"}';
  const now = Math.floor(Date.now() / 1000);
  // Trong cửa sổ 5 phút thì pass.
  const fresh = signWebhookPayload(secret, now - 299, body);
  assert.equal(verifyWebhookSignature(secret, now - 299, body, fresh), true);
  // Quá 5 phút (cũ) và tương lai xa đều fail.
  const stale = signWebhookPayload(secret, now - 301, body);
  assert.equal(verifyWebhookSignature(secret, now - 301, body, stale), false);
  const future = signWebhookPayload(secret, now + 301, body);
  assert.equal(verifyWebhookSignature(secret, now + 301, body, future), false);
  // Timestamp không phải số nguyên giây -> fail.
  assert.equal(verifyWebhookSignature(secret, now + 0.5, body, fresh), false);
  // Chữ ký không có prefix sha256= vẫn verify được (bare hex).
  assert.equal(verifyWebhookSignature(secret, now, body, signWebhookPayload(secret, now, body).slice(7)), true);
});

test('webhook thiếu secret: gửi không ký, không crash; setHmacSecret bật/tắt ký', async () => {
  const { mock, port, received } = await startListener();
  try {
    const dir = makeTempDir();
    const d = new WebhookDispatcher({ storePath: path.join(dir, 'webhooks.json'), allowInternalUrls: true });
    assert.equal(d.isSigning, false);
    d.add(`http://127.0.0.1:${port}/hook`, ['run.done']);

    const event = { kind: 'run.done', at: new Date().toISOString(), data: { botId: 'bot-1' } };
    const results = await d.dispatch(event);
    assert.equal(results[0].ok, true, 'thiếu secret vẫn gửi được (không crash)');
    assert.equal(received.length, 1);
    assert.equal(received[0].signature, undefined);
    assert.equal(received[0].timestamp, undefined);

    // Bật secret lúc chạy -> các lần gửi sau được ký.
    d.setHmacSecret('sau-nay-moi-co-secret');
    assert.equal(d.isSigning, true);
    await d.dispatch(event);
    assert.equal(received.length, 2);
    assert.match(received[1].signature, /^sha256=[0-9a-f]{64}$/);
    assert.match(received[1].timestamp, /^\d+$/);

    // Tắt secret -> lại không ký.
    d.setHmacSecret('');
    assert.equal(d.isSigning, false);
    await d.dispatch(event);
    assert.equal(received[2].signature, undefined);
  } finally {
    await stopListener(mock);
  }
});
