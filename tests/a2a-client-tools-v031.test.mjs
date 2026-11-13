/**
 * Test P1-2 (v0.31): A2A client tools (`a2aTools.ts`) + đăng ký trong
 * `ToolRegistry.registerA2aTools()` + A2A client stream qua SSE.
 * (node:test, chỉ local, không mạng live, không API key thật.)
 *
 * Fake A2A server: server A2A thật của open-bot (`startA2aHttpServer`,
 * runner echo / chậm / stream) đóng vai agent ngoài, + một server
 * http thô cho trường hợp card sai, + URL chết (127.0.0.1:1).
 *
 * Build trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * rồi: node --test tests/a2a-client-tools-v031.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createA2aServer, startA2aHttpServer } from '../packages/core/dist/a2a/server.js';
import { A2aClient } from '../packages/core/dist/a2a/client.js';
import {
  A2A_TOOLS,
  A2A_TOOL_NAMES,
  createA2aTools,
  createFileTrustedAgentStore,
  createMemoryTrustedAgentStore,
  trustedAgentFromCard,
} from '../packages/tools/dist/a2aTools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

const CTX = { workspaceDir: os.tmpdir(), botId: 'test-bot' };
const serversToClose = [];
const tempDirs = [];

/** Đóng server (cả A2aHttpServer lẫn http.Server thô), không treo suite. */
function closeServer(s) {
  return Promise.race([
    new Promise((resolve) => {
      try {
        s.closeAllConnections?.();
      } catch {}
      try {
        const r = s.close(() => resolve());
        if (r && typeof r.then === 'function') r.then(() => resolve(), () => resolve());
      } catch {
        resolve();
      }
    }),
    sleep(2000).then(() => undefined),
  ]);
}

after(async () => {
  for (const s of serversToClose.splice(0)) {
    await closeServer(s);
  }
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function echoRunner() {
  return async ({ text }) => ({ text: `Đã nhận: ${text}` });
}

function progressRunner() {
  return async ({ text, onProgress }) => {
    onProgress('đang làm phần 1...');
    await sleep(50);
    onProgress('đang làm phần 2...');
    return { text: `Xong: ${text}` };
  };
}

/** Runner chậm: chờ tới khi bị abort (cancel) hoặc tối đa 10s. */
function slowRunner() {
  return async ({ signal }) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      timer.unref?.();
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { text: 'chậm xong' };
  };
}

/** Runner ngủ đúng `ms` rồi mới trả (dùng cho test timeout phía client). */
function sleepRunner(ms) {
  return async () => {
    await sleep(ms);
    return { text: 'ngủ xong' };
  };
}

async function makeFakeAgent(runner = echoRunner()) {
  const httpServer = await startA2aHttpServer(
    { runner, allowUnauthenticated: true },
    { port: 0 },
  );
  serversToClose.push(httpServer);
  return httpServer;
}

function toolNamed(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `thiếu tool ${name}`);
  return t;
}

async function trustedToolsFor(serverUrl, extra = {}) {
  const store = createMemoryTrustedAgentStore([
    { baseUrl: serverUrl, name: 'fake-agent', url: serverUrl, trustedAt: new Date().toISOString() },
  ]);
  const tools = createA2aTools({ store, ...extra });
  return { store, tools };
}

// ---------------------------------------------------------------------------
// Registry: đăng ký tool A2A
// ---------------------------------------------------------------------------

test('registry.registerA2aTools(): đăng ký đủ 8 tool A2A, đúng needsApproval', () => {
  const registry = new ToolRegistry();
  registry.registerA2aTools();
  assert.equal(registry.size(), 8); // v0.97 (Đội T2): + a2a_delegate + a2a_verify_card
  assert.deepEqual(
    registry.list().map((t) => t.definition.name),
    [...A2A_TOOL_NAMES],
  );
  const approval = Object.fromEntries(
    registry.list().map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.deepEqual(approval, {
    a2a_discover: true,
    a2a_list_agents: false,
    a2a_send: true,
    a2a_status: false,
    a2a_cancel: true,
    a2a_list_tasks: false,
    a2a_delegate: true,
    a2a_verify_card: false,
  });
  // Đăng ký lần 2 -> trùng tên, ném lỗi (không âm thầm ghi đè).
  assert.throws(() => registry.registerA2aTools(), /already registered/);
});

test('A2A_TOOLS: placeholder chưa gắn store có đủ 8 tool, validate được qua registry', () => {
  assert.equal(A2A_TOOLS.length, 8); // v0.97 (Đội T2): + a2a_delegate + a2a_verify_card
  const registry = ToolRegistry.fromDefaults(A2A_TOOLS);
  assert.equal(registry.size(), 8);
});

// ---------------------------------------------------------------------------
// Trusted store: memory + file
// ---------------------------------------------------------------------------

test('memory store: add/get/list/remove, chuẩn hoá trailing slash', async () => {
  const store = createMemoryTrustedAgentStore();
  assert.deepEqual(await store.list(), []);
  await store.add({
    baseUrl: 'http://127.0.0.1:9999/',
    name: 'agent-a',
    url: 'http://127.0.0.1:9999/',
    trustedAt: new Date().toISOString(),
  });
  assert.equal((await store.get('http://127.0.0.1:9999')).name, 'agent-a');
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.remove('http://127.0.0.1:9999/'), true);
  assert.equal(await store.remove('http://127.0.0.1:9999'), false);
});

test('file store: bền vững qua 2 instance, file hỏng -> lỗi rõ ràng', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-a2a-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'a2a-trusted-agents.json');
  const store1 = createFileTrustedAgentStore(file);
  assert.deepEqual(await store1.list(), []);
  await store1.add({
    baseUrl: 'http://127.0.0.1:9998',
    name: 'agent-file',
    url: 'http://127.0.0.1:9998',
    trustedAt: new Date().toISOString(),
  });
  const store2 = createFileTrustedAgentStore(file);
  assert.equal((await store2.list()).length, 1);
  assert.equal((await store2.get('http://127.0.0.1:9998')).name, 'agent-file');

  fs.writeFileSync(file, '{ json hong', 'utf-8');
  const store3 = createFileTrustedAgentStore(file);
  assert.throws(() => store3.list(), /không phải JSON hợp lệ/);
  fs.writeFileSync(file, JSON.stringify({ agents: 'sai' }), 'utf-8');
  assert.throws(() => store3.list(), /sai định dạng/);
});

test('trustedAgentFromCard(): giữ tên/mô tả/skill/streaming từ card', () => {
  const agent = trustedAgentFromCard(
    {
      name: 'Coder',
      description: 'Viết code',
      url: 'http://127.0.0.1:7777/',
      capabilities: { streaming: true },
      skills: [{ id: 'code', name: 'Code', description: 'Viết code' }],
    },
    'http://127.0.0.1:7777/',
  );
  assert.equal(agent.baseUrl, 'http://127.0.0.1:7777');
  assert.equal(agent.name, 'Coder');
  assert.equal(agent.streaming, true);
  assert.deepEqual(agent.skills, [{ id: 'code', name: 'Code', description: 'Viết code' }]);
  assert.match(agent.trustedAt, /^\d{4}-\d{2}-\d{2}T/);
});

// ---------------------------------------------------------------------------
// a2a_discover: card đúng / card sai
// ---------------------------------------------------------------------------

test('a2a_discover: đọc card fake server ok, trusted=false khi chưa tin tưởng', async () => {
  const server = await makeFakeAgent();
  const tools = createA2aTools();
  const out = await toolNamed(tools, 'a2a_discover').execute({ url: server.url }, CTX);
  assert.doesNotMatch(out, /^Error:/);
  const card = JSON.parse(out);
  assert.equal(typeof card.name, 'string');
  assert.ok(card.name.length > 0);
  assert.equal(typeof card.url, 'string');
  assert.equal(card.trusted, false);
  assert.equal(Array.isArray(card.skills), true);
});

test('a2a_discover: card sai -> lỗi rõ ràng (404 / JSON hỏng / thiếu url)', async () => {
  const bad = http.createServer((req, res) => {
    if (req.url === '/404/.well-known/agent-card.json') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } else if (req.url === '/badjson/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('<html>không phải json</html>');
    } else if (req.url === '/nouser/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'Thiếu url' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve));
  serversToClose.push(bad);
  const port = bad.address().port;
  const tools = createA2aTools();
  const discover = toolNamed(tools, 'a2a_discover');

  const notFound = await discover.execute({ url: `http://127.0.0.1:${port}/404/` }, CTX);
  assert.match(notFound, /^Error:.*HTTP 404/);
  const badJson = await discover.execute({ url: `http://127.0.0.1:${port}/badjson/` }, CTX);
  assert.match(badJson, /^Error:.*không phải JSON hợp lệ/);
  const noUrl = await discover.execute({ url: `http://127.0.0.1:${port}/nouser/` }, CTX);
  assert.match(noUrl, /^Error:.*thiếu field bắt buộc/);
});

test('a2a_discover: server chết (connection refused) -> lỗi rõ ràng, không crash', async () => {
  const tools = createA2aTools();
  const out = await toolNamed(tools, 'a2a_discover').execute({ url: 'http://127.0.0.1:1/' }, CTX);
  assert.match(out, /^Error:/);
  assert.match(out, /Không đọc được Agent Card/);
});

// ---------------------------------------------------------------------------
// a2a_send / a2a_status / a2a_list_tasks qua fake server
// ---------------------------------------------------------------------------

test('a2a_send: gửi task tới agent đã tin tưởng, nhận artifact text về', async () => {
  const server = await makeFakeAgent();
  const { tools } = await trustedToolsFor(server.url);
  const out = await toolNamed(tools, 'a2a_send').execute(
    { agent: 'fake-agent', message: 'viết giúp tôi một hàm' },
    CTX,
  );
  assert.doesNotMatch(out, /^Error:/);
  const res = JSON.parse(out);
  assert.equal(res.agent, 'fake-agent');
  assert.equal(res.state, 'completed');
  assert.match(res.text, /Đã nhận: viết giúp tôi một hàm/);
  assert.equal(res.artifacts.length, 1);
  assert.match(res.artifacts[0].text, /Đã nhận/);
  assert.equal(typeof res.taskId, 'string');
});

test('a2a_send: agent chưa tin tưởng -> từ chối (fail-closed), kể cả gọi bằng URL', async () => {
  const server = await makeFakeAgent();
  const tools = createA2aTools(); // store trống
  const byName = await toolNamed(tools, 'a2a_send').execute(
    { agent: 'fake-agent', message: 'alo' },
    CTX,
  );
  assert.match(byName, /^Error:.*Chưa có agent A2A nào được tin tưởng/);
  const byUrl = await toolNamed(tools, 'a2a_send').execute(
    { agent: server.url, message: 'alo' },
    CTX,
  );
  assert.match(byUrl, /^Error:.*Chưa có agent A2A nào được tin tưởng/);
});

test('a2a_send: message rỗng / quá dài -> lỗi rõ ràng, không gọi mạng', async () => {
  const server = await makeFakeAgent();
  const { tools } = await trustedToolsFor(server.url);
  const empty = await toolNamed(tools, 'a2a_send').execute({ agent: 'fake-agent', message: '   ' }, CTX);
  assert.match(empty, /^Error:/);
  const tooLong = await toolNamed(tools, 'a2a_send').execute(
    { agent: 'fake-agent', message: 'x'.repeat(20_001) },
    CTX,
  );
  assert.match(tooLong, /vượt giới hạn 20000/);
});

test('a2a_send: server chết -> lỗi rõ ràng', async () => {
  const { tools } = await trustedToolsFor('http://127.0.0.1:1/');
  const out = await toolNamed(tools, 'a2a_send').execute(
    { agent: 'http://127.0.0.1:1/', message: 'alo' },
    CTX,
  );
  assert.match(out, /^Error:/);
});

test('a2a_send: timeout (runner ngủ 3s, timeoutMs 1000) -> lỗi timeout rõ ràng', async () => {
  const server = await makeFakeAgent(sleepRunner(3000));
  const { tools } = await trustedToolsFor(server.url);
  const out = await toolNamed(tools, 'a2a_send').execute(
    { agent: 'fake-agent', message: 'việc chậm', timeoutMs: 1000 },
    CTX,
  );
  assert.match(out, /^Error:.*timed out sau 1000ms/);
  // Đợi runner phía server chạy xong rồi mới đóng server (tránh close treo).
  await sleep(3200);
});

test('a2a_status + a2a_list_tasks: xem lại task đã gửi, liệt kê đủ task', async () => {
  const server = await makeFakeAgent();
  const { tools } = await trustedToolsFor(server.url);
  const sent1 = JSON.parse(
    await toolNamed(tools, 'a2a_send').execute({ agent: server.url, message: 'việc một' }, CTX),
  );
  const sent2 = JSON.parse(
    await toolNamed(tools, 'a2a_send').execute({ agent: server.url, message: 'việc hai' }, CTX),
  );
  const status = JSON.parse(
    await toolNamed(tools, 'a2a_status').execute({ agent: server.url, taskId: sent1.taskId }, CTX),
  );
  assert.equal(status.state, 'completed');
  assert.match(status.text, /việc một/);
  const listed = JSON.parse(
    await toolNamed(tools, 'a2a_list_tasks').execute({ agent: server.url, limit: 10 }, CTX),
  );
  assert.equal(listed.total, 2);
  assert.deepEqual(
    listed.tasks.map((t) => t.taskId),
    [sent2.taskId, sent1.taskId],
  );
  // Task không tồn tại -> lỗi JSON-RPC từ server, tool trả Error rõ ràng.
  const missing = await toolNamed(tools, 'a2a_status').execute(
    { agent: server.url, taskId: 'task-khong-co' },
    CTX,
  );
  assert.match(missing, /^Error:/);
});

test('a2a_list_agents: trống -> hướng dẫn; đã tin tưởng -> liệt kê đủ', async () => {
  const tools = createA2aTools();
  const empty = await toolNamed(tools, 'a2a_list_agents').execute({}, CTX);
  assert.match(empty, /Chưa có agent A2A nào được tin tưởng/);
  const server = await makeFakeAgent();
  const { tools: tools2 } = await trustedToolsFor(server.url);
  const listed = JSON.parse(await toolNamed(tools2, 'a2a_list_agents').execute({}, CTX));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'fake-agent');
  assert.equal(listed[0].baseUrl, server.url.replace(/\/+$/, ''));
});

// ---------------------------------------------------------------------------
// a2a_cancel: huỷ task đang chạy
// ---------------------------------------------------------------------------

test('a2a_cancel: huỷ task đang working, task chuyển sang cancelled', async () => {
  const server = await makeFakeAgent(slowRunner());
  const { tools } = await trustedToolsFor(server.url);
  const client = new A2aClient({ baseUrl: server.url });
  // Gửi task ở nền (runner chậm nên sendMessage chưa trả ngay).
  const pending = client.sendMessage('việc dài');
  let workingId = null;
  for (let i = 0; i < 20 && !workingId; i++) {
    await sleep(100);
    const listed = JSON.parse(
      await toolNamed(tools, 'a2a_list_tasks').execute({ agent: server.url, limit: 5 }, CTX),
    );
    const working = listed.tasks.find((t) => t.state === 'working' || t.state === 'submitted');
    if (working) workingId = working.taskId;
  }
  assert.ok(workingId, 'phải thấy task đang chạy trước khi huỷ');
  const cancelled = JSON.parse(
    await toolNamed(tools, 'a2a_cancel').execute({ agent: server.url, taskId: workingId }, CTX),
  );
  assert.equal(cancelled.state, 'cancelled');
  const settled = await pending;
  assert.equal(settled.status.state, 'cancelled');
});

// ---------------------------------------------------------------------------
// A2aClient.streamMessage: SSE — progress + artifact
// ---------------------------------------------------------------------------

test('A2aClient.streamMessage: stream status + artifact qua SSE từ fake server', async () => {
  const server = await makeFakeAgent(progressRunner());
  const client = new A2aClient({ baseUrl: server.url });
  const progress = [];
  const statuses = [];
  const artifacts = [];
  const task = await client.streamMessage('làm việc stream', {
    onProgress: (t) => progress.push(t),
    onStatus: (s) => statuses.push(s),
    onArtifact: (a) => artifacts.push(a),
  });
  assert.equal(task.status.state, 'completed');
  assert.ok(progress.length >= 1, `phải có progress, thực tế ${progress.length}`);
  assert.ok(progress.some((p) => p.includes('phần 1')));
  assert.ok(statuses.includes('completed') || statuses.includes('working'));
  assert.match(task.artifacts[0].parts[0].text, /Xong: làm việc stream/);
});

test('A2aClient.streamMessage: server trả JSON-RPC error -> A2aError có code', async () => {
  // Fake server thô: card đúng nhưng RPC trả lỗi -32601.
  const raw = http.createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'raw', url: `http://127.0.0.1:${raw.address().port}/` }));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32601, message: 'Method not found' },
        }),
      );
    });
  });
  await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
  serversToClose.push(raw);
  const baseUrl = `http://127.0.0.1:${raw.address().port}/`;
  const client = new A2aClient({ baseUrl });
  await assert.rejects(() => client.sendMessage('alo'), (err) => err.code === -32601);
  await assert.rejects(
    () => client.streamMessage('alo'),
    (err) => err.code === -32601 && /message:stream/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// createA2aServer trực tiếp (không HTTP): client-side không dùng, chỉ kiểm
// tra server độc lập vẫn tạo task được — giữ làm đối chứng cho fake server.
// ---------------------------------------------------------------------------

test('sanity: createA2aServer (in-process) vẫn chạy — đối chứng fake server HTTP', async () => {
  const server = createA2aServer({ runner: echoRunner(), allowUnauthenticated: true });
  const res = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'ping' }] } },
  });
  assert.equal(res.error, undefined);
  assert.equal(res.result.status.state, 'completed');
});
