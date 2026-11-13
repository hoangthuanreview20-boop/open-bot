/**
 * Test v0.13 W5d: MCP server + A2A server/client (node:test).
 * Chỉ test local, không mạng live: server chạy trên loopback / stdio
 * trong test, client giả (client MCP tay + A2A client) gọi vào.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/mcp-server-a2a-v013.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMcpServer,
  startMcpHttpServer,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_NOT_INITIALIZED,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_INVALID_REQUEST,
} from '../packages/core/dist/mcp/server.js';
import { StreamableHttpMcpClient, connectMcp } from '../packages/core/dist/mcp/client.js';
import {
  buildMcpClientCapabilities,
  createSamplingHandler,
  parseSamplingRequest,
  SamplingError,
} from '../packages/core/dist/mcp/clientHandlers.js';
import { createApiServer } from '../packages/core/dist/api/server.js';
import { createA2aServer, startA2aHttpServer } from '../packages/core/dist/a2a/server.js';
import { A2aClient, fetchAgentCard } from '../packages/core/dist/a2a/client.js';
import { createMcpTools } from '../packages/tools/dist/mcpTools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_MCP_SERVER = path.join(__dirname, '..', 'packages', 'core', 'dist', 'mcp', 'server.js');

// L2 (audit v0.15): token GIẢ chỉ dùng trong test — createA2aServer bắt
// buộc token, nên mọi server trong file này đều truyền token này và
// client gọi kèm token đó (trừ các test cố tình không auth, xem cuối file).
const TEST_A2A_TOKEN = 'test-a2a-token-v013';
const serversToClose = [];
after(async () => {
  for (const s of serversToClose.splice(0)) {
    await s.close().catch(() => undefined);
  }
});

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mcp-a2a-test-'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'Xin chào workspace', 'utf8');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'inner.txt'), 'nội dung bên trong', 'utf8');
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MCP server — handleJsonRpc trực tiếp
// ---------------------------------------------------------------------------

test('MCP server: tools/list trước initialize -> lỗi -32002', async () => {
  const server = createMcpServer({ workspaceDir: makeWorkspace() });
  const res = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(res.error.code, JSON_RPC_NOT_INITIALIZED);
});

test('MCP server: initialize -> tools/list + tools/call + resources + prompts', async () => {
  const dir = makeWorkspace();
  const server = createMcpServer({ workspaceDir: dir });
  const init = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'open-bot');
  assert.ok(init.result.capabilities.tools);
  assert.ok(init.result.capabilities.resources);
  assert.ok(init.result.capabilities.prompts);
  // Notification initialized: không trả gì.
  assert.equal(await server.handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

  const tools = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = tools.result.tools.map((t) => t.name);
  for (const expected of ['bot_info', 'time_now', 'echo', 'workspace_list_files', 'workspace_read_file']) {
    assert.ok(names.includes(expected), `thiếu tool ${expected}`);
  }
  const echo = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'echo', arguments: { message: 'ping' } },
  });
  assert.equal(echo.result.content[0].text, 'ping');
  assert.equal(echo.result.isError, false);

  // SEP-1303: lỗi validate input là tool error, không phải protocol error.
  const badEcho = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'echo', arguments: {} },
  });
  assert.equal(badEcho.result.isError, true);
  assert.match(badEcho.result.content[0].text, /message/);

  // Tool không có -> lỗi JSON-RPC -32602.
  const unknown = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'khong-co-tool', arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);

  // Method không hỗ trợ -> -32601.
  const noMethod = await server.handleJsonRpc({ jsonrpc: '2.0', id: 6, method: 'sampling/createMessage' });
  assert.equal(noMethod.error.code, JSON_RPC_METHOD_NOT_FOUND);

  // Đọc file trong workspace + chặn thoát workspace.
  const read = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'workspace_read_file', arguments: { path: 'hello.txt' } },
  });
  assert.equal(read.result.content[0].text, 'Xin chào workspace');
  const escape = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'workspace_read_file', arguments: { path: '../secret.txt' } },
  });
  assert.equal(escape.result.isError, true);
  assert.match(escape.result.content[0].text, /ngoài workspace/);

  // Resources: list + read (mặc định + workspace://).
  const resources = await server.handleJsonRpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  const uris = resources.result.resources.map((r) => r.uri);
  assert.ok(uris.includes('open-bot://info'));
  assert.ok(uris.includes('open-bot://workspace'));
  const info = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'open-bot://info' },
  });
  assert.match(info.result.contents[0].text, /open-bot/);
  const wsRes = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'workspace://sub/inner.txt' },
  });
  assert.equal(wsRes.result.contents[0].text, 'nội dung bên trong');
  const templates = await server.handleJsonRpc({ jsonrpc: '2.0', id: 12, method: 'resources/templates/list' });
  assert.equal(templates.result.resourceTemplates[0].uriTemplate, 'workspace://{path}');

  // Prompts: list + get (thiếu argument bắt buộc -> -32602).
  const prompts = await server.handleJsonRpc({ jsonrpc: '2.0', id: 13, method: 'prompts/list' });
  assert.ok(prompts.result.prompts.map((p) => p.name).includes('summarize'));
  const greet = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 14, method: 'prompts/get',
    params: { name: 'greet', arguments: { name: 'Huy' } },
  });
  assert.match(greet.result.messages[0].content.text, /Huy/);
  const missingArg = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 15, method: 'prompts/get',
    params: { name: 'summarize', arguments: {} },
  });
  assert.equal(missingArg.error.code, -32602);
});

test('MCP server: allowlist chỉ expose tool được phép', async () => {
  const server = createMcpServer({ workspaceDir: makeWorkspace(), allowedTools: ['echo'] });
  await server.handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  const tools = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['echo']);
  const blocked = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'workspace_read_file', arguments: { path: 'hello.txt' } },
  });
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /allowlist/);
});

test('MCP server: initialize với version cũ 2024-11-05 vẫn đàm phán được', async () => {
  const server = createMcpServer({});
  const init = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  assert.equal(init.result.protocolVersion, '2024-11-05');
});

// ---------------------------------------------------------------------------
// MCP server — stdio (PassThrough + spawn process thật)
// ---------------------------------------------------------------------------

test('MCP server stdio qua PassThrough: NDJSON request/response', async () => {
  const server = createMcpServer({ workspaceDir: makeWorkspace() });
  const input = new PassThrough();
  const output = new PassThrough();
  let outText = '';
  output.on('data', (chunk) => { outText += chunk.toString('utf8'); });
  const done = server.serveStdio(input, output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { message: 'stdio-ok' } } }) + '\n');
  input.write('không phải json\n');
  input.end();
  await done;
  const lines = outText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3); // init + echo + parse error; notification không trả
  assert.equal(lines[0].result.serverInfo.name, 'open-bot');
  assert.equal(lines[1].result.content[0].text, 'stdio-ok');
  assert.equal(lines[2].error.code, JSON_RPC_PARSE_ERROR);
});

test('MCP server stdio qua spawn process thật', async () => {
  const dir = makeWorkspace();
  const code = [
    `import { createMcpServer } from ${JSON.stringify(pathToFileURL(DIST_MCP_SERVER).href)};`,
    `const s = createMcpServer({ workspaceDir: ${JSON.stringify(dir)} });`,
    'await s.serveStdio();',
  ].join('\n');
  const child = spawn('node', ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  let outText = '';
  let errText = '';
  child.stdout.on('data', (c) => { outText += c.toString('utf8'); });
  child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace_list_files', arguments: {} } }) + '\n');
  await sleep(600);
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  const lines = outText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.match(lines[1].result.content[0].text, /hello\.txt/);
  assert.doesNotMatch(errText, /hello\.txt/); // stdout sạch, log (nếu có) không lẫn vào stream
});

// ---------------------------------------------------------------------------
// MCP server — Streamable HTTP + client MCP tay gọi vào
// ---------------------------------------------------------------------------

test('MCP server HTTP: client MCP tay initialize/list/call/read + lỗi raw', async () => {
  const dir = makeWorkspace();
  const server = createMcpServer({ workspaceDir: dir });
  const httpServer = await startMcpHttpServer(server, { port: 0 });
  serversToClose.push(httpServer);

  // Lỗi raw trước khi client initialize: JSON sai, batch, gọi trước initialize.
  const badJson = await fetch(httpServer.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{sai json' });
  const badJsonBody = await badJson.json();
  assert.equal(badJsonBody.error.code, JSON_RPC_PARSE_ERROR);
  const batch = await fetch(httpServer.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  assert.equal((await batch.json()).error.code, JSON_RPC_INVALID_REQUEST);
  const early = await fetch(httpServer.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) });
  assert.equal((await early.json()).error.code, JSON_RPC_NOT_INITIALIZED);

  // Client MCP tay (Streamable HTTP) nói chuyện được với server tay.
  const client = new StreamableHttpMcpClient({ name: 'open-bot', url: httpServer.url });
  try {
    const info = await client.initialize();
    assert.equal(info.name, 'open-bot');
    assert.equal(info.protocolVersion, '2025-11-25');
    await client.ping();
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'workspace_read_file'));
    assert.equal(await client.callTool('echo', { message: 'http-ok' }), 'http-ok');
    const resources = await client.listResources();
    assert.ok(resources.some((r) => r.uri === 'open-bot://info'));
    assert.match(await client.readResource('workspace://hello.txt'), /Xin chào workspace/);
    // v0.69d (SEP-1303): server trả -32602 "Không có tool" cho tool lạ —
    // client không throw nữa mà trả về dạng tool-error text để model thấy
    // và sửa args gọi lại (trước đây assert.rejects /Không có tool/).
    const noTool = await client.callTool('khong-co-tool', {});
    assert.match(noTool, /^MCP tool error:/);
    assert.match(noTool, /Không có tool/);
    assert.match(noTool, /-32602/);
  } finally {
    await client.close();
  }

  // GET SSE stream mở được và trả comment giữ nhịp.
  const controller = new AbortController();
  const getRes = await fetch(httpServer.url, { method: 'GET', headers: { Accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(getRes.status, 200);
  assert.match(getRes.headers.get('content-type'), /text\/event-stream/);
  const reader = getRes.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /connected/);
  controller.abort();
  await reader.cancel().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// A2A server + client — HTTP
// ---------------------------------------------------------------------------

function echoRunner(delays = {}) {
  return async ({ text, onProgress, signal }) => {
    onProgress(`đang xử lý: ${text}`);
    if (delays.ms) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delays.ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('bị hủy')); }, { once: true });
      });
    }
    return { text: `Đã nhận: ${text}` };
  };
}

test('A2A: Agent Card + sendMessage + getTask + artifact', async () => {
  const httpServer = await startA2aHttpServer({ token: TEST_A2A_TOKEN, runner: echoRunner() }, { port: 0 });
  serversToClose.push(httpServer);
  const card = await fetchAgentCard(httpServer.url, { token: TEST_A2A_TOKEN });
  assert.equal(card.name, 'open-bot');
  assert.equal(card.url, httpServer.url);
  assert.equal(card.protocolVersion, '1.0.1'); // v0.97 (Đội T2): A2A 1.0.1 (trước đây 1.0)
  assert.equal(card.capabilities.streaming, true);
  assert.ok(Array.isArray(card.skills) && card.skills.length > 0);

  const client = new A2aClient({ baseUrl: httpServer.url, token: TEST_A2A_TOKEN });
  const discovered = await client.discover();
  assert.equal(discovered.name, 'open-bot');
  const task = await client.sendMessage('xin chào A2A');
  assert.equal(task.status.state, 'completed');
  assert.ok(task.id.startsWith('task-'));
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0].parts[0].text, 'Đã nhận: xin chào A2A');
  assert.equal(task.history[0].parts[0].text, 'xin chào A2A');

  const again = await client.getTask(task.id);
  assert.equal(again.status.state, 'completed');
  const polled = await client.pollTask(task.id, { intervalMs: 10, timeoutMs: 1000 });
  assert.equal(polled.status.state, 'completed');
  await assert.rejects(() => client.getTask('task-khong-co'), /Không có task/);
});

test('A2A: streamMessage đẩy tiến độ + artifact qua SSE', async () => {
  const httpServer = await startA2aHttpServer({ token: TEST_A2A_TOKEN, runner: echoRunner() }, { port: 0 });
  serversToClose.push(httpServer);
  const client = new A2aClient({ baseUrl: httpServer.url, token: TEST_A2A_TOKEN });
  const progress = [];
  const artifacts = [];
  const states = [];
  const task = await client.streamMessage('làm việc dài', {
    onProgress: (t) => progress.push(t),
    onArtifact: (a) => artifacts.push(a),
    onStatus: (s) => states.push(s),
  });
  assert.equal(task.status.state, 'completed');
  assert.ok(progress.some((p) => p.includes('đang xử lý: làm việc dài')));
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].parts[0].text, 'Đã nhận: làm việc dài');
  assert.ok(states.includes('working'));
  assert.ok(states.includes('completed'));
});

test('A2A: runner cần thêm thông tin -> input-required; runner lỗi -> failed', async () => {
  const needInputServer = await startA2aHttpServer({
    token: TEST_A2A_TOKEN,
    runner: async () => ({ needsInput: 'Cần biết thêm: file nào?' }),
  }, { port: 0 });
  serversToClose.push(needInputServer);
  const needInputTask = await new A2aClient({ baseUrl: needInputServer.url, token: TEST_A2A_TOKEN }).sendMessage('làm gì đó');
  assert.equal(needInputTask.status.state, 'input-required');
  assert.match(needInputTask.status.message.parts[0].text, /Cần biết thêm/);

  const failingServer = await startA2aHttpServer({
    token: TEST_A2A_TOKEN,
    runner: async () => { throw new Error('runner nổ'); },
  }, { port: 0 });
  serversToClose.push(failingServer);
  const failedTask = await new A2aClient({ baseUrl: failingServer.url, token: TEST_A2A_TOKEN }).sendMessage('làm gì đó');
  assert.equal(failedTask.status.state, 'failed');
  assert.match(failedTask.status.message.parts[0].text, /runner nổ/);
});

test('A2A: tasks/cancel hủy task đang chạy (server trực tiếp)', async () => {
  const server = createA2aServer({ token: TEST_A2A_TOKEN, runner: echoRunner({ ms: 5000 }) });
  const sendPromise = server.handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'việc dài' }] } },
  });
  await sleep(150);
  const running = server.listTasks();
  assert.equal(running.length, 1);
  assert.equal(running[0].status.state, 'working');
  const cancelled = server.cancelTask(running[0].id);
  assert.equal(cancelled.status.state, 'cancelled');
  const final = await sendPromise;
  assert.equal(final.result.status.state, 'cancelled');
  // Hủy lần nữa trên task đã xong: no-op, vẫn cancelled.
  assert.equal(server.cancelTask(running[0].id).status.state, 'cancelled');
  // Task không có -> lỗi rõ ràng.
  const unknown = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'task-khong-co' } });
  assert.equal(unknown.error.code, -32602);
  // Method hoàn toàn không có -> -32601 (tasks/list giờ đã hỗ trợ,
  // xem test tasks/list bên dưới — không dùng nó làm method lạ nữa).
  const unknownMethod = await server.handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'unknown/method' });
  assert.equal(unknownMethod.error.code, -32601);
});

test('A2A: tasks/list liệt kê mới nhất trước + phân trang; tasks/cancel lỗi rõ khi task đã xong/không có', async () => {
  const server = createA2aServer({ token: TEST_A2A_TOKEN, runner: echoRunner() });
  const send = (n, text, contextId) => server.handleJsonRpc({
    jsonrpc: '2.0', id: n, method: 'message:send',
    params: {
      message: { role: 'user', parts: [{ kind: 'text', text }] },
      ...(contextId ? { contextId } : {}),
    },
  });
  const t1 = await send(1, 'việc một', 'ctx-list');
  const t2 = await send(2, 'việc hai', 'ctx-list');
  assert.equal(t1.result.status.state, 'completed');
  assert.equal(t2.result.status.state, 'completed');

  const list = await server.handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tasks/list', params: {} });
  assert.equal(list.error, undefined);
  assert.equal(list.result.total, 2);
  assert.equal(list.result.tasks.length, 2);
  assert.equal(list.result.tasks[0].id, t2.result.id); // mới nhất trước
  assert.equal(list.result.tasks[1].id, t1.result.id);
  assert.equal(list.result.nextCursor, null);
  for (const t of list.result.tasks) {
    assert.equal(t.status.state, 'completed');
    assert.match(t.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(t.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  }

  // Phân trang: limit=1 -> trang 1 là task mới nhất + nextCursor '1'.
  const page1 = await server.handleJsonRpc({ jsonrpc: '2.0', id: 4, method: 'tasks/list', params: { limit: 1 } });
  assert.equal(page1.result.tasks.length, 1);
  assert.equal(page1.result.tasks[0].id, t2.result.id);
  assert.equal(page1.result.total, 2);
  assert.equal(page1.result.nextCursor, '1');
  const page2 = await server.handleJsonRpc({ jsonrpc: '2.0', id: 5, method: 'tasks/list', params: { limit: 1, cursor: page1.result.nextCursor } });
  assert.equal(page2.result.tasks.length, 1);
  assert.equal(page2.result.tasks[0].id, t1.result.id);
  assert.equal(page2.result.nextCursor, null);
  // offset tương đương cursor.
  const byOffset = await server.handleJsonRpc({ jsonrpc: '2.0', id: 6, method: 'tasks/list', params: { limit: 1, offset: 1 } });
  assert.equal(byOffset.result.tasks[0].id, t1.result.id);
  // limit vượt trần 100 -> kẹp, không lỗi; limit/cursor sai -> -32602.
  const clamped = await server.handleJsonRpc({ jsonrpc: '2.0', id: 7, method: 'tasks/list', params: { limit: 500 } });
  assert.equal(clamped.result.tasks.length, 2);
  const badLimit = await server.handleJsonRpc({ jsonrpc: '2.0', id: 8, method: 'tasks/list', params: { limit: 0 } });
  assert.equal(badLimit.error.code, -32602);
  const badCursor = await server.handleJsonRpc({ jsonrpc: '2.0', id: 9, method: 'tasks/list', params: { cursor: 'khong-phai-so' } });
  assert.equal(badCursor.error.code, -32602);
  // Lọc theo contextId.
  const filtered = await server.handleJsonRpc({ jsonrpc: '2.0', id: 10, method: 'tasks/list', params: { contextId: 'ctx-list' } });
  assert.equal(filtered.result.total, 2);
  const empty = await server.handleJsonRpc({ jsonrpc: '2.0', id: 11, method: 'tasks/list', params: { contextId: 'ctx-khac' } });
  assert.equal(empty.result.total, 0);
  assert.deepEqual(empty.result.tasks, []);
  // Dạng 'tasks/list' (dấu '/') cũng chạy.
  const slash = await server.handleJsonRpc({ jsonrpc: '2.0', id: 12, method: 'tasks/list' });
  assert.equal(slash.result.total, 2);

  // Cancel task đã xong -> lỗi rõ -32602 (task already completed).
  const cancelDone = await server.handleJsonRpc({ jsonrpc: '2.0', id: 13, method: 'tasks/cancel', params: { id: t2.result.id } });
  assert.equal(cancelDone.error.code, -32602);
  assert.match(cancelDone.error.message, /đã hoàn thành|already completed/);
  // Cancel task không có -> lỗi rõ -32602 (khớp tasks/get).
  const cancelUnknown = await server.handleJsonRpc({ jsonrpc: '2.0', id: 14, method: 'tasks/cancel', params: { id: 'task-khong-co' } });
  assert.equal(cancelUnknown.error.code, -32602);
  assert.match(cancelUnknown.error.message, /Không có task/);
});

test('A2A HTTP: tasks/list qua POST + tasks/cancel task đang chạy -> tasks/get cancelled', async () => {
  const postTo = (baseUrl) => async (body) => (await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_A2A_TOKEN}` },
    body: JSON.stringify(body),
  })).json();

  const httpServer = await startA2aHttpServer({ token: TEST_A2A_TOKEN, runner: echoRunner() }, { port: 0 });
  serversToClose.push(httpServer);
  const postRpc = postTo(httpServer.url);
  const client = new A2aClient({ baseUrl: httpServer.url, token: TEST_A2A_TOKEN });
  const first = await client.sendMessage('việc một');
  const second = await client.streamMessage('việc hai');

  const list = await postRpc({ jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} });
  assert.equal(list.error, undefined);
  assert.equal(list.result.total, 2);
  assert.equal(list.result.tasks.length, 2);
  assert.equal(list.result.tasks[0].id, second.id); // mới nhất trước
  assert.equal(list.result.tasks[1].id, first.id);
  assert.ok(list.result.tasks.every(
    (t) => t.status.state === 'completed' && typeof t.createdAt === 'string' && typeof t.updatedAt === 'string',
  ));
  // Cancel task đã xong -> lỗi rõ.
  const cancelDone = await postRpc({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: second.id } });
  assert.equal(cancelDone.error.code, -32602);
  assert.match(cancelDone.error.message, /đã hoàn thành|already completed/);
  // Cancel task không có -> lỗi rõ, khớp tasks/get.
  const cancelUnknown = await postRpc({ jsonrpc: '2.0', id: 3, method: 'tasks/cancel', params: { id: 'task-khong-co' } });
  assert.equal(cancelUnknown.error.code, -32602);
  assert.match(cancelUnknown.error.message, /Không có task/);

  // Task đang chạy: hủy qua HTTP -> tasks/get trả cancelled.
  const slowServer = await startA2aHttpServer({ token: TEST_A2A_TOKEN, runner: echoRunner({ ms: 5000 }) }, { port: 0 });
  serversToClose.push(slowServer);
  const slowPost = postTo(slowServer.url);
  const slowClient = new A2aClient({ baseUrl: slowServer.url, token: TEST_A2A_TOKEN });
  const sendPromise = slowClient.sendMessage('việc dài');
  await sleep(150);
  const running = await slowPost({ jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} });
  assert.equal(running.result.total, 1);
  assert.equal(running.result.tasks[0].status.state, 'working');
  const cancelled = await slowPost({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: running.result.tasks[0].id } });
  assert.equal(cancelled.result.status.state, 'cancelled');
  assert.equal((await sendPromise).status.state, 'cancelled');
  const got = await slowPost({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: running.result.tasks[0].id } });
  assert.equal(got.result.status.state, 'cancelled');
});

test('A2A: server chưa gắn runner -> task failed với lỗi rõ ràng', async () => {
  const server = createA2aServer({ token: TEST_A2A_TOKEN });
  const res = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'alo' }] } },
  });
  assert.equal(res.result.status.state, 'failed');
  assert.match(res.result.status.message.parts[0].text, /chưa gắn agent runner/);
});

test('A2A client: lỗi mạng/timeout rõ ràng, không throw khó hiểu', async () => {
  await assert.rejects(
    () => fetchAgentCard('http://127.0.0.1:1/'),
    /Không đọc được Agent Card/,
  );
  const dead = new A2aClient({ baseUrl: 'http://127.0.0.1:1/' });
  await assert.rejects(() => dead.sendMessage('alo'), /thất bại/);
  assert.throws(() => new A2aClient({ baseUrl: 'ftp://example.com/' }), /http\(s\)/);

  const slowServer = await startA2aHttpServer({ token: TEST_A2A_TOKEN, runner: echoRunner({ ms: 500 }) }, { port: 0 });
  serversToClose.push(slowServer);
  const impatient = new A2aClient({ baseUrl: slowServer.url, token: TEST_A2A_TOKEN, timeoutMs: 50 });
  await assert.rejects(() => impatient.sendMessage('chậm quá'), /timed out sau 50ms/);
});

// ---------------------------------------------------------------------------
// L2 (audit bảo mật v0.15): A2A server bắt buộc token
// ---------------------------------------------------------------------------

test('A2A L2: tạo server không token -> throw rõ ràng', () => {
  assert.throws(() => createA2aServer({}), /yêu cầu options\.token/);
  assert.throws(() => createA2aServer({ runner: echoRunner() }), /yêu cầu options\.token/);
  assert.throws(() => createA2aServer(), /yêu cầu options\.token/);
});

test('A2A L2: allowUnauthenticated:true -> chạy nhưng cảnh báo stderr rõ ràng', async () => {
  const warnings = [];
  const origError = console.error;
  console.error = (...args) => { warnings.push(args.join(' ')); };
  let server;
  try {
    server = createA2aServer({ allowUnauthenticated: true, runner: echoRunner() });
  } finally {
    console.error = origError;
  }
  assert.ok(server, 'server không auth tường minh vẫn tạo được');
  assert.ok(
    warnings.some((w) => /KHÔNG CÓ token|allowUnauthenticated/.test(w)),
    `phải log cảnh báo stderr, thực tế: ${JSON.stringify(warnings)}`,
  );
  // Server không auth vẫn chạy task bình thường qua handleJsonRpc.
  const res = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'alo' }] } },
  });
  assert.equal(res.result.status.state, 'completed');
});

test('A2A L2: server có token -> HTTP không token bị 401, có token chạy bình thường', async () => {
  const httpServer = await startA2aHttpServer(
    { token: TEST_A2A_TOKEN, runner: echoRunner() },
    { port: 0 },
  );
  serversToClose.push(httpServer);
  // Không token: Agent Card + POST đều 401.
  const noAuthCard = await fetch(`${httpServer.url}.well-known/agent-card.json`);
  assert.equal(noAuthCard.status, 401);
  const noAuthPost = await fetch(httpServer.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } }),
  });
  assert.equal(noAuthPost.status, 401);
  // Sai token cũng 401.
  const wrongCard = await fetch(`${httpServer.url}.well-known/agent-card.json`, {
    headers: { Authorization: 'Bearer sai-token' },
  });
  assert.equal(wrongCard.status, 401);
  // Đúng token: client chạy bình thường.
  const client = new A2aClient({ baseUrl: httpServer.url, token: TEST_A2A_TOKEN });
  const task = await client.sendMessage('có token');
  assert.equal(task.status.state, 'completed');
});

// ---------------------------------------------------------------------------
// MCP sampling — handler thật nối provider của bot (W10c, gap v0.13)
// ---------------------------------------------------------------------------

/** Provider giả cho sampling test: ghi lại mọi lần chat() được gọi. */
function fakeSamplingProvider({ text = 'mock sampling reply', delayMs = 0, failWith = null } = {}) {
  return {
    id: 'mock',
    label: 'Mock',
    calls: [],
    async chat(req) {
      this.calls.push(req);
      if (failWith) throw new Error(failWith);
      if (delayMs > 0) await sleep(delayMs);
      return { text, toolCalls: [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

const SAMPLING_PARAMS = {
  messages: [{ role: 'user', content: { type: 'text', text: 'tóm tắt: hello' } }],
  systemPrompt: 'Bạn là trợ lý ngắn gọn.',
  maxTokens: 100,
};

test('MCP sampling: handler trả text từ provider, đúng shape spec, không gọi tool', async () => {
  const provider = fakeSamplingProvider();
  const handler = createSamplingHandler(provider, { model: 'mock' });
  const result = await handler(SAMPLING_PARAMS);
  assert.equal(result.role, 'assistant');
  assert.equal(result.content.type, 'text');
  assert.equal(result.content.text, 'mock sampling reply');
  assert.equal(result.model, 'mock');
  assert.equal(result.stopReason, 'endTurn');
  assert.equal(provider.calls.length, 1);
  const req = provider.calls[0];
  assert.equal(req.model, 'mock');
  assert.equal(req.maxTokens, 100);
  assert.equal(req.tools, undefined); // sampling chỉ chat text, không tool
  assert.deepEqual(
    req.messages.map((m) => m.role),
    ['system', 'user'],
  );
  assert.equal(req.messages[0].content, 'Bạn là trợ lý ngắn gọn.');
  assert.equal(req.messages[1].content, 'tóm tắt: hello');
});

test('MCP sampling: parse — maxTokens vắng thì mặc định 1024, vượt trần thì kẹp 4096', async () => {
  const provider = fakeSamplingProvider();
  const handler = createSamplingHandler(provider, { model: 'mock' });
  await handler({ messages: [{ role: 'user', content: { type: 'text', text: 'alo' } }] });
  assert.equal(provider.calls[0].maxTokens, 1024);
  await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'alo' } }],
    maxTokens: 999_999,
  });
  assert.equal(provider.calls[1].maxTokens, 4096);
  // Content dạng mảng block + ảnh -> text + placeholder, không crash.
  const parsed = parseSamplingRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'mô tả ảnh này' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ],
    }],
  });
  assert.match(parsed.messages[0].content, /mô tả ảnh này/);
  assert.match(parsed.messages[0].content, /image content/);
});

test('MCP sampling: params sai / provider lỗi / timeout -> SamplingError rõ ràng, không crash', async () => {
  const provider = fakeSamplingProvider();
  const handler = createSamplingHandler(provider, { model: 'mock' });
  await assert.rejects(() => handler({ messages: [] }), /cần "messages"/);
  await assert.rejects(
    () => handler({ messages: [{ role: 'system', content: { type: 'text', text: 'x' } }] }),
    /role phải là "user" hoặc "assistant"/,
  );
  await assert.rejects(() => handler({ messages: [{ role: 'user', content: { type: 'text', text: 'x' } }], maxTokens: 0 }), /maxTokens/);
  await assert.rejects(() => handler('không phải object'), /params phải là một object/);
  assert.throws(() => createSamplingHandler(provider, { model: '  ' }), /options\.model/);

  const failing = fakeSamplingProvider({ failWith: 'provider nổ' });
  await assert.rejects(
    () => createSamplingHandler(failing, { model: 'mock' })(SAMPLING_PARAMS),
    (err) => err instanceof SamplingError && /MCP sampling thất bại: provider nổ/.test(err.message),
  );
  const hanging = {
    id: 'mock',
    label: 'Mock',
    async chat() {
      return new Promise(() => undefined); // không bao giờ resolve
    },
    async listModels() {
      return ['mock'];
    },
  };
  await assert.rejects(
    () => createSamplingHandler(hanging, { model: 'mock', timeoutMs: 50 })(SAMPLING_PARAMS),
    /timed out sau 50ms/,
  );
});

test('MCP sampling: capability chỉ advertise khi có handler', () => {
  const withHandler = buildMcpClientCapabilities({ samplingHandler: () => ({}) });
  assert.deepEqual(withHandler.sampling, {});
  const withoutHandler = buildMcpClientCapabilities({});
  assert.equal('sampling' in withoutHandler, false);
  assert.deepEqual(withoutHandler, { experimental: {} });
  const noOptions = buildMcpClientCapabilities();
  assert.equal('sampling' in noOptions, false);
});

// Fake MCP server stdio: sau initialize thì gửi sampling/createMessage
// về client, ghi lại capabilities client advertise + response nhận được
// ra file OBS_FILE (dòng `OBS {...}`) rồi thoát 0 — client spawn server
// con nên test không đọc được stderr của nó, file là kênh quan sát.
// Test đọc file để assert.
const FAKE_SAMPLING_SERVER_CODE = [
  `import * as fs from 'node:fs';`,
  `import * as readline from 'node:readline';`,
  `const obsFile = process.env.OBS_FILE;`,
  `const rl = readline.createInterface({ input: process.stdin });`,
  `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
  `const obs = (o) => fs.appendFileSync(obsFile, 'OBS ' + JSON.stringify(o) + '\\n');`,
  `for await (const line of rl) {`,
  `  let msg; try { msg = JSON.parse(line); } catch { continue; }`,
  `  if (msg.method === 'initialize') {`,
  `    obs({ capabilities: msg.params?.capabilities ?? null });`,
  `    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-sampling', version: '0' } } });`,
  `    out({ jsonrpc: '2.0', id: 100, method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'tóm tắt: hello' } }], maxTokens: 100 } });`,
  `  } else if (msg.id === 100) {`,
  `    obs({ samplingResponse: msg });`,
  `    process.exit(0);`,
  `  }`,
  `}`,
].join('\n');

/** Chạy fake server một lần với clientHandlers cho trước; trả observations. */
async function runFakeSamplingServer(clientHandlers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-sampling-test-'));
  const obsFile = path.join(dir, 'obs.jsonl');
  fs.writeFileSync(obsFile, '', 'utf8');
  const readObservations = () =>
    fs
      .readFileSync(obsFile, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('OBS '))
      .map((l) => JSON.parse(l.slice(4)));
  const client = await connectMcp({
    name: 'fake-sampling',
    command: 'node',
    args: ['--input-type=module', '-e', FAKE_SAMPLING_SERVER_CODE],
    env: { OBS_FILE: obsFile },
    ...(clientHandlers ? { clientHandlers } : {}),
  });
  try {
    // Đợi fake server ghi xong samplingResponse (nó tự thoát sau đó).
    const started = Date.now();
    for (;;) {
      const observations = readObservations();
      if (observations.some((o) => o.samplingResponse)) return observations;
      if (Date.now() - started > 5000) {
        throw new Error(`fake sampling server không trả sampling trong 5s: ${JSON.stringify(observations)}`);
      }
      await sleep(25);
    }
  } finally {
    await client.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('MCP sampling qua stdio: server xin sampling -> nhận text từ provider mock; không handler -> -32601', async () => {
  // Có handler: client advertise sampling, server nhận text từ provider.
  const provider = fakeSamplingProvider();
  const observations = await runFakeSamplingServer({
    samplingHandler: createSamplingHandler(provider, { model: 'mock' }),
  });
  const caps = observations.find((o) => o.capabilities)?.capabilities;
  assert.deepEqual(caps?.sampling, {});
  const response = observations.find((o) => o.samplingResponse)?.samplingResponse;
  assert.equal(response.error, undefined);
  assert.equal(response.result.role, 'assistant');
  assert.equal(response.result.content.text, 'mock sampling reply');
  assert.equal(response.result.model, 'mock');
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].messages[0].content, 'tóm tắt: hello');

  // Không handler: client KHÔNG advertise sampling, server nhận -32601.
  const observations2 = await runFakeSamplingServer(undefined);
  const caps2 = observations2.find((o) => o.capabilities)?.capabilities;
  assert.equal('sampling' in (caps2 ?? {}), false);
  const response2 = observations2.find((o) => o.samplingResponse)?.samplingResponse;
  assert.equal(response2.error.code, -32601);
});

// Fake MCP server cho pool test: như FAKE_SAMPLING_SERVER_CODE nhưng
// trả thêm tools/list (rỗng) rồi mới thoát — để mcp_list_tools qua pool
// chạy xong xuôi thay vì gọi vào process đã chết sau sampling.
const FAKE_POOL_SAMPLING_SERVER_CODE = [
  `import * as fs from 'node:fs';`,
  `import * as readline from 'node:readline';`,
  `const obsFile = process.env.OBS_FILE;`,
  `const rl = readline.createInterface({ input: process.stdin });`,
  `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
  `const obs = (o) => fs.appendFileSync(obsFile, 'OBS ' + JSON.stringify(o) + '\\n');`,
  `for await (const line of rl) {`,
  `  let msg; try { msg = JSON.parse(line); } catch { continue; }`,
  `  if (msg.method === 'initialize') {`,
  `    obs({ capabilities: msg.params?.capabilities ?? null });`,
  `    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-pool-sampling', version: '0' } } });`,
  `    out({ jsonrpc: '2.0', id: 100, method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'tóm tắt: hello' } }], maxTokens: 100 } });`,
  `  } else if (msg.id === 100) {`,
  `    obs({ samplingResponse: msg });`,
  `  } else if (msg.method === 'tools/list') {`,
  `    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });`,
  `    setTimeout(() => process.exit(0), 50);`,
  `  }`,
  `}`,
].join('\n');

/** Chạy mcp_list_tools qua pool với getSamplingHandler cho trước; trả observations + kết quả. */
async function runPoolSamplingList(getSamplingHandler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-pool-sampling-'));
  const obsFile = path.join(dir, 'obs.jsonl');
  fs.writeFileSync(obsFile, '', 'utf8');
  fs.mkdirSync(path.join(dir, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.open-bot', 'mcp.json'),
    JSON.stringify({
      servers: {
        fake: {
          command: 'node',
          args: ['--input-type=module', '-e', FAKE_POOL_SAMPLING_SERVER_CODE],
          env: { OBS_FILE: obsFile },
        },
      },
    }),
    'utf8',
  );
  const readObservations = () =>
    fs
      .readFileSync(obsFile, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('OBS '))
      .map((l) => JSON.parse(l.slice(4)));
  const tools = createMcpTools(dir, { getSamplingHandler });
  const listTool = tools.find((t) => t.definition.name === 'mcp_list_tools');
  assert.ok(listTool, 'thiếu tool mcp_list_tools');
  const result = await listTool.execute({ server: 'fake' }, { workspaceDir: dir, botId: 'test-bot' });
  // Đợi server ghi xong samplingResponse (có thể tới sau tools/list).
  const started = Date.now();
  for (;;) {
    if (readObservations().some((o) => o.samplingResponse)) break;
    if (Date.now() - started > 5000) {
      throw new Error(`pool sampling server không trả sampling trong 5s: ${JSON.stringify(readObservations())}`);
    }
    await sleep(25);
  }
  const observations = readObservations();
  fs.rmSync(dir, { recursive: true, force: true });
  return { observations, result };
}

test('MCP sampling qua pool (mcp_list_tools): server xin sampling -> provider mock trả lời', async () => {
  const provider = fakeSamplingProvider();
  const { observations, result } = await runPoolSamplingList(() =>
    createSamplingHandler(provider, { model: 'mock' }),
  );
  assert.match(result, /offers no tools/);
  const caps = observations.find((o) => o.capabilities)?.capabilities;
  assert.deepEqual(caps?.sampling, {}, 'pool client phải advertise sampling');
  const response = observations.find((o) => o.samplingResponse)?.samplingResponse;
  assert.equal(response.error, undefined);
  assert.equal(response.result.content.text, 'mock sampling reply');
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].messages[0].content, 'tóm tắt: hello');

  // Không có getSamplingHandler: client không advertise sampling.
  const { observations: observations2 } = await runPoolSamplingList(undefined);
  const caps2 = observations2.find((o) => o.capabilities)?.capabilities;
  assert.equal('sampling' in (caps2 ?? {}), false);
  const response2 = observations2.find((o) => o.samplingResponse)?.samplingResponse;
  assert.equal(response2.error.code, -32601);
});

// ---------------------------------------------------------------------------
// A2A mount POST /a2a — message:stream qua SSE (W10c, gap v0.13)
// ---------------------------------------------------------------------------

const TEST_API_TOKEN = 'test-api-token-v013-mount';
const apiServersToStop = [];
after(async () => {
  for (const s of apiServersToStop.splice(0)) {
    await s.stop().catch(() => undefined);
  }
});

function minimalApiHandlers() {
  return {
    listBots: async () => [],
    runBot: async () => ({ text: '' }),
    getHistory: async () => [],
    listTasks: async () => [],
  };
}

function slowA2aRunner() {
  return async ({ text, onProgress }) => {
    onProgress('đang xử lý phần 1');
    await sleep(120);
    onProgress('đang xử lý phần 2');
    await sleep(120);
    return { text: `Xong: ${text}` };
  };
}

/** Đọc SSE response thành các frame { at, json } theo thứ tự tới. */
async function readSseFrames(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  const handleChunk = (raw) => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (!data) continue;
      frames.push({ at: Date.now(), json: JSON.parse(data) });
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      handleChunk(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) handleChunk(buffer);
  return frames;
}

function postA2a(apiPort, body, { accept = 'application/json' } = {}) {
  return fetch(`http://127.0.0.1:${apiPort}/a2a`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: accept,
      Authorization: `Bearer ${TEST_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

test('A2A mount: POST /a2a message:stream trả SSE từng chunk, message:send vẫn JSON', async () => {
  const a2aServer = createA2aServer({ token: TEST_A2A_TOKEN, runner: slowA2aRunner() });
  const api = createApiServer({
    port: 0,
    token: TEST_API_TOKEN,
    handlers: minimalApiHandlers(),
    a2aServer,
  });
  await api.start();
  apiServersToStop.push(api);

  // message:stream -> SSE, chunk tới dần (progress trước khi task xong).
  const streamRes = await postA2a(api.port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'message:stream',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'việc chậm' }] } },
  }, { accept: 'text/event-stream' });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type'), /text\/event-stream/);
  const frames = await readSseFrames(streamRes);
  const kinds = frames.map((f) => f.json.result.kind);
  assert.equal(kinds[0], 'task'); // task (submitted) tới ngay đầu
  assert.ok(kinds.includes('status-update'), `thiếu status-update, kinds: ${kinds.join(',')}`);
  assert.ok(kinds.includes('artifact-update'), `thiếu artifact-update, kinds: ${kinds.join(',')}`);
  const taskIds = new Set(frames.map((f) => f.json.result.task?.id ?? f.json.result.taskId));
  assert.equal(taskIds.size, 1); // mọi event cùng một task
  const progressTexts = frames
    .filter((f) => f.json.result.kind === 'status-update')
    .map((f) => f.json.result.status?.message?.parts?.[0]?.text ?? '');
  assert.ok(progressTexts.some((t) => t.includes('đang xử lý phần 1')));
  assert.ok(progressTexts.some((t) => t.includes('đang xử lý phần 2')));
  const artifact = frames.find((f) => f.json.result.kind === 'artifact-update')?.json.result.artifact;
  assert.equal(artifact.parts[0].text, 'Xong: việc chậm');
  const lastTask = [...frames].reverse().find((f) => f.json.result.kind === 'task')?.json.result.task;
  assert.equal(lastTask.status.state, 'completed');
  assert.equal(lastTask.artifacts[0].parts[0].text, 'Xong: việc chậm');
  // Chunk tới dần: frame đầu tới trước frame cuối ít nhất 150ms
  // (runner delay tổng 240ms giữa hai lần progress).
  assert.ok(
    frames[frames.length - 1].at - frames[0].at >= 150,
    `stream phải tới dần, thực tế chỉ ${frames[frames.length - 1].at - frames[0].at}ms`,
  );
  // Task stream xong đọc lại được qua GET /a2a/tasks/:id.
  const got = await fetch(`http://127.0.0.1:${api.port}/a2a/tasks/${lastTask.id}`, {
    headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
  });
  assert.equal(got.status, 200);
  assert.equal((await got.json()).status.state, 'completed');

  // message:send -> JSON như cũ (không SSE).
  const sendRes = await postA2a(api.port, {
    jsonrpc: '2.0',
    id: 2,
    method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'việc nhanh' }] } },
  });
  assert.equal(sendRes.status, 200);
  assert.match(sendRes.headers.get('content-type'), /application\/json/);
  const sendBody = await sendRes.json();
  assert.equal(sendBody.result.status.state, 'completed');
  assert.equal(sendBody.result.artifacts[0].parts[0].text, 'Xong: việc nhanh');

  // message:stream với params sai -> lỗi JSON-RPC -32602, không phải SSE.
  const badRes = await postA2a(api.port, {
    jsonrpc: '2.0',
    id: 3,
    method: 'message:stream',
    params: { message: { role: 'user', parts: [] } },
  }, { accept: 'text/event-stream' });
  assert.equal(badRes.status, 200);
  assert.match(badRes.headers.get('content-type'), /application\/json/);
  assert.equal((await badRes.json()).error.code, -32602);
});

test('A2A mount: mount tối thiểu (không startStream) thì message:stream chạy-tới-hoàn-thành trả JSON', async () => {
  const real = createA2aServer({ token: TEST_A2A_TOKEN, runner: slowA2aRunner() });
  // Mount chỉ có 3 method cũ — không có startStream.
  const minimalMount = {
    getAgentCard: () => real.getAgentCard(),
    handleJsonRpc: (msg) => real.handleJsonRpc(msg),
    getTask: (id) => real.getTask(id),
  };
  const api = createApiServer({
    port: 0,
    token: TEST_API_TOKEN,
    handlers: minimalApiHandlers(),
    a2aServer: minimalMount,
  });
  await api.start();
  apiServersToStop.push(api);
  const res = await postA2a(api.port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'message:stream',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'việc chậm' }] } },
  }, { accept: 'text/event-stream' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.result.status.state, 'completed');
  assert.equal(body.result.artifacts[0].parts[0].text, 'Xong: việc chậm');
});

test('A2A mount: POST /a2a tasks/list + tasks/cancel dùng chung handleJsonRpc với server độc lập', async () => {
  const a2aServer = createA2aServer({ token: TEST_A2A_TOKEN, runner: slowA2aRunner() });
  const api = createApiServer({
    port: 0,
    token: TEST_API_TOKEN,
    handlers: minimalApiHandlers(),
    a2aServer,
  });
  await api.start();
  apiServersToStop.push(api);

  // 2 task qua mount: stream + send.
  const streamRes = await postA2a(api.port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'message:stream',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'việc một' }] } },
  }, { accept: 'text/event-stream' });
  const frames = await readSseFrames(streamRes);
  const streamedTask = [...frames].reverse().find((f) => f.json.result.kind === 'task')?.json.result.task;
  assert.equal(streamedTask.status.state, 'completed');
  const sendRes = await postA2a(api.port, {
    jsonrpc: '2.0',
    id: 2,
    method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'việc hai' }] } },
  });
  const sentTask = (await sendRes.json()).result;
  assert.equal(sentTask.status.state, 'completed');

  // tasks/list qua mount: đủ 2, mới nhất trước.
  const listRes = await postA2a(api.port, { jsonrpc: '2.0', id: 3, method: 'tasks/list', params: { limit: 50 } });
  const list = await listRes.json();
  assert.equal(list.error, undefined);
  assert.equal(list.result.total, 2);
  assert.deepEqual(list.result.tasks.map((t) => t.id), [sentTask.id, streamedTask.id]);
  // tasks/cancel task đã xong qua mount -> lỗi rõ -32602.
  const cancelDoneRes = await postA2a(api.port, { jsonrpc: '2.0', id: 4, method: 'tasks/cancel', params: { id: sentTask.id } });
  const cancelDone = await cancelDoneRes.json();
  assert.equal(cancelDone.error.code, -32602);
  assert.match(cancelDone.error.message, /đã hoàn thành|already completed/);
  // tasks/cancel task không có qua mount -> lỗi rõ.
  const cancelUnknownRes = await postA2a(api.port, { jsonrpc: '2.0', id: 5, method: 'tasks/cancel', params: { id: 'task-khong-co' } });
  assert.equal((await cancelUnknownRes.json()).error.code, -32602);

  // Task đang chạy qua mount: hủy -> tasks/get trả cancelled.
  const longA2a = createA2aServer({ token: TEST_A2A_TOKEN, runner: echoRunner({ ms: 5000 }) });
  const longApi = createApiServer({
    port: 0,
    token: TEST_API_TOKEN,
    handlers: minimalApiHandlers(),
    a2aServer: longA2a,
  });
  await longApi.start();
  apiServersToStop.push(longApi);
  const sendPromise = postA2a(longApi.port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'việc dài' }] } },
  });
  await sleep(150);
  const runningRes = await postA2a(longApi.port, { jsonrpc: '2.0', id: 2, method: 'tasks/list', params: {} });
  const running = await runningRes.json();
  assert.equal(running.result.total, 1);
  assert.equal(running.result.tasks[0].status.state, 'working');
  const cancelRes = await postA2a(longApi.port, { jsonrpc: '2.0', id: 3, method: 'tasks/cancel', params: { id: running.result.tasks[0].id } });
  const cancelled = await cancelRes.json();
  assert.equal(cancelled.result.status.state, 'cancelled');
  const finished = await (await sendPromise).json();
  assert.equal(finished.result.status.state, 'cancelled');
  const getRes = await postA2a(longApi.port, { jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: running.result.tasks[0].id } });
  assert.equal((await getRes.json()).result.status.state, 'cancelled');
});

// ---------------------------------------------------------------------------
// MCP sampling — tool calling (SEP-1577) + modelPreferences.hints (W15b, v0.20)
// ---------------------------------------------------------------------------

/**
 * Provider giả theo kịch bản: mỗi lần chat() trả response tiếp theo trong
 * `script` (hết script thì lặp lại response cuối — để test giới hạn vòng
 * tool: provider lúc nào cũng đòi gọi tool). Ghi lại mọi lần chat().
 */
function scriptedSamplingProvider(script, { listModelsResult = ['mock'] } = {}) {
  return {
    id: 'mock',
    label: 'Mock',
    calls: [],
    async chat(req) {
      this.calls.push(req);
      const next = script[Math.min(this.calls.length - 1, script.length - 1)];
      return { text: next.text ?? '', toolCalls: next.toolCalls ?? [] };
    },
    async listModels() {
      return [...listModelsResult];
    },
  };
}

const SAMPLING_TOOL_PARAMS = {
  messages: [{ role: 'user', content: { type: 'text', text: 'mấy giờ rồi?' } }],
  maxTokens: 100,
  tools: [
    {
      name: 'get_time',
      description: 'Lấy giờ hiện tại.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
};

test('MCP sampling tools: provider gọi tool -> handler gọi tool trên server -> trả text cuối', async () => {
  const toolCalls = [];
  const callServerTool = async (name, args) => {
    toolCalls.push({ name, args });
    assert.equal(name, 'get_time');
    return '12:00';
  };
  const provider = scriptedSamplingProvider([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_time', args: {} }] },
    { text: 'Bây giờ là 12:00', toolCalls: [] },
  ]);
  const handler = createSamplingHandler(provider, { model: 'mock', callServerTool });
  const result = await handler(SAMPLING_TOOL_PARAMS);
  assert.equal(result.content.text, 'Bây giờ là 12:00');
  assert.equal(result.stopReason, 'endTurn');
  assert.equal(result.model, 'mock');
  assert.equal(toolCalls.length, 1, 'tool trên server chỉ chạy đúng 1 lần');
  assert.deepEqual(toolCalls[0].args, {});
  assert.equal(provider.calls.length, 2);
  // Lần 1 provider nhận tools; lần 2 nhận kết quả tool để trả text cuối.
  assert.equal(provider.calls[0].tools[0].name, 'get_time');
  assert.equal(provider.calls[0].tools[0].parameters.type, 'object');
  const secondMessages = provider.calls[1].messages;
  assert.ok(secondMessages.some((m) => m.role === 'assistant' && m.toolCalls?.[0]?.name === 'get_time'));
  const toolMsg = secondMessages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.content, '12:00');
  assert.equal(toolMsg.toolCallId, 'call_1');
});

test('MCP sampling tools: toolChoice none -> provider không nhận tools; tool ép -> chỉ nhận đúng tool đó', async () => {
  const neverCalled = async () => { throw new Error('không được gọi tool'); };
  const provider = scriptedSamplingProvider([{ text: 'trả lời thẳng, không tool', toolCalls: [] }]);
  const handler = createSamplingHandler(provider, { model: 'mock', callServerTool: neverCalled });
  const result = await handler({
    ...SAMPLING_TOOL_PARAMS,
    tools: [
      ...SAMPLING_TOOL_PARAMS.tools,
      { name: 'get_date', description: 'Lấy ngày.', inputSchema: { type: 'object', properties: {} } },
    ],
    toolChoice: { type: 'none' },
  });
  assert.equal(result.content.text, 'trả lời thẳng, không tool');
  assert.equal(provider.calls[0].tools, undefined);

  // toolChoice ép tool: provider chỉ nhận đúng 1 tool đó.
  const forced = scriptedSamplingProvider([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_date', args: {} }] },
    { text: 'Hôm nay là thứ Hai', toolCalls: [] },
  ]);
  const forcedCalls = [];
  const handler2 = createSamplingHandler(forced, {
    model: 'mock',
    callServerTool: async (name, args) => { forcedCalls.push({ name, args }); return 'thứ Hai'; },
  });
  const result2 = await handler2({
    ...SAMPLING_TOOL_PARAMS,
    tools: [
      ...SAMPLING_TOOL_PARAMS.tools,
      { name: 'get_date', description: 'Lấy ngày.', inputSchema: { type: 'object', properties: {} } },
    ],
    toolChoice: { type: 'tool', name: 'get_date' },
  });
  assert.equal(result2.content.text, 'Hôm nay là thứ Hai');
  assert.deepEqual(forced.calls[0].tools.map((t) => t.name), ['get_date']);
  assert.equal(forcedCalls.length, 1);

  // toolChoice ép tool không có trong request -> lỗi rõ, không gọi provider.
  const handler3 = createSamplingHandler(scriptedSamplingProvider([{ text: 'x' }]), { model: 'mock' });
  await assert.rejects(
    () => handler3({ ...SAMPLING_TOOL_PARAMS, toolChoice: { type: 'tool', name: 'khong-co-tool' } }),
    (err) => err instanceof SamplingError && /toolChoice ép dùng tool "khong-co-tool"/.test(err.message),
  );
});

test('MCP sampling hints: hint khớp model provider có -> dùng model đó; không khớp -> giữ model bot', async () => {
  const provider = scriptedSamplingProvider(
    [{ text: 'reply gpt-4o', toolCalls: [] }],
    { listModelsResult: ['gpt-4o', 'mock'] },
  );
  const handler = createSamplingHandler(provider, { model: 'mock' });
  const result = await handler({
    ...SAMPLING_PARAMS,
    modelPreferences: { hints: [{ name: 'gpt-4o' }] },
  });
  assert.equal(provider.calls[0].model, 'gpt-4o');
  assert.equal(result.model, 'gpt-4o');
  assert.equal(result.content.text, 'reply gpt-4o');

  // Hint không khớp model nào provider có -> giữ model bot, không fail.
  const provider2 = scriptedSamplingProvider(
    [{ text: 'reply mock', toolCalls: [] }],
    { listModelsResult: ['gpt-4o', 'mock'] },
  );
  const result2 = await createSamplingHandler(provider2, { model: 'mock' })({
    ...SAMPLING_PARAMS,
    modelPreferences: { hints: [{ name: 'model-khong-ton-tai' }] },
  });
  assert.equal(provider2.calls[0].model, 'mock');
  assert.equal(result2.model, 'mock');
  assert.equal(result2.content.text, 'reply mock');
});

test('MCP sampling tools: provider không hỗ trợ tool calling / không có executor / tool lạ -> lỗi rõ, không crash', async () => {
  // Provider gắn cờ không hỗ trợ tool calling + request có tools -> lỗi ngay.
  const unsupported = scriptedSamplingProvider([{ text: 'không tới đây được', toolCalls: [] }]);
  unsupported.supportsToolCalling = false;
  await assert.rejects(
    () => createSamplingHandler(unsupported, { model: 'mock' })(SAMPLING_TOOL_PARAMS),
    (err) => err instanceof SamplingError && /không hỗ trợ tool calling/.test(err.message),
  );
  assert.equal(unsupported.calls.length, 0, 'provider không hỗ trợ thì không gọi chat');

  // Provider gọi tool nhưng handler không có callServerTool/executeTool -> lỗi rõ.
  const noExecutor = scriptedSamplingProvider([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_time', args: {} }] },
  ]);
  await assert.rejects(
    () => createSamplingHandler(noExecutor, { model: 'mock' })(SAMPLING_TOOL_PARAMS),
    (err) => err instanceof SamplingError && /không có đường gọi tool/.test(err.message),
  );

  // Provider gọi tool không có trong request -> lỗi rõ, executor không chạy.
  const liarCalls = [];
  const liar = scriptedSamplingProvider([
    { text: '', toolCalls: [{ id: 'call_9', name: 'tool-la', args: {} }] },
  ]);
  await assert.rejects(
    () => createSamplingHandler(liar, {
      model: 'mock',
      callServerTool: async (name) => { liarCalls.push(name); return 'x'; },
    })(SAMPLING_TOOL_PARAMS),
    (err) => err instanceof SamplingError && /tool "tool-la" mà server không cung cấp/.test(err.message),
  );
  assert.equal(liarCalls.length, 0);

  // Executor ném lỗi -> SamplingError bọc rõ, run không crash.
  const failingExecutor = scriptedSamplingProvider([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_time', args: {} }] },
  ]);
  await assert.rejects(
    () => createSamplingHandler(failingExecutor, {
      model: 'mock',
      callServerTool: async () => { throw new Error('server tool nổ'); },
    })(SAMPLING_TOOL_PARAMS),
    (err) => err instanceof SamplingError && /gọi tool "get_time" thất bại: server tool nổ/.test(err.message),
  );
});

test('MCP sampling tools: provider lúc nào cũng đòi tool -> dừng sau đúng 3 vòng tool', async () => {
  const toolCalls = [];
  const provider = scriptedSamplingProvider([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_time', args: {} }] },
  ]);
  const handler = createSamplingHandler(provider, {
    model: 'mock',
    callServerTool: async (name, args) => { toolCalls.push({ name, args }); return '12:00'; },
  });
  const result = await handler(SAMPLING_TOOL_PARAMS);
  assert.equal(toolCalls.length, 3, 'tối đa 3 vòng tool');
  assert.equal(provider.calls.length, 4, '3 vòng tool + 1 lần chat cuối lấy text');
  assert.equal(result.stopReason, 'endTurn');
  assert.equal(result.content.text, '');
});

// ---------------------------------------------------------------------------
// MCP sampling — includeContext + stopSequences (W16b, v0.23)
// ---------------------------------------------------------------------------

test('MCP sampling includeContext thisServer: lần 2 provider nhận lịch sử lần 1 prepend trước messages mới', async () => {
  const provider = scriptedSamplingProvider([
    { text: 'Câu trả lời đầu: Paris.', toolCalls: [] },
    { text: 'Câu trả lời sau: vẫn là Paris.', toolCalls: [] },
  ]);
  const handler = createSamplingHandler(provider, { model: 'mock' });
  const first = await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'Thủ đô của Pháp là gì?' } }],
    maxTokens: 100,
    includeContext: 'thisServer',
  });
  assert.equal(first.content.text, 'Câu trả lời đầu: Paris.');
  // Lần 1 chưa có lịch sử nên provider chỉ nhận đúng messages mới.
  assert.deepEqual(
    provider.calls[0].messages.map((m) => m.content),
    ['Thủ đô của Pháp là gì?'],
  );

  const second = await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'Còn thủ đô của Đức?' } }],
    maxTokens: 100,
    includeContext: 'thisServer',
  });
  assert.equal(second.content.text, 'Câu trả lời sau: vẫn là Paris.');
  // Lịch sử lần 1 (user + assistant) prepend TRƯỚC messages mới, đúng thứ tự.
  assert.deepEqual(
    provider.calls[1].messages.map((m) => [m.role, m.content]),
    [
      ['user', 'Thủ đô của Pháp là gì?'],
      ['assistant', 'Câu trả lời đầu: Paris.'],
      ['user', 'Còn thủ đô của Đức?'],
    ],
  );
});

test('MCP sampling includeContext none / vắng / allServers + lịch sử riêng theo handler instance', async () => {
  const provider = scriptedSamplingProvider([
    { text: 'đáp 1', toolCalls: [] },
    { text: 'đáp 2', toolCalls: [] },
    { text: 'đáp 3', toolCalls: [] },
  ]);
  const handler = createSamplingHandler(provider, { model: 'mock' });
  await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu 1' } }],
    maxTokens: 100,
    includeContext: 'none',
  });
  await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu 2' } }],
    maxTokens: 100,
    includeContext: 'none',
  });
  assert.equal(provider.calls[1].messages.length, 1, 'includeContext none: lần 2 không prepend lịch sử lần 1');
  assert.equal(provider.calls[1].messages[0].content, 'câu 2');

  // Vắng includeContext cũng là none (mặc định spec).
  await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu 3' } }],
    maxTokens: 100,
  });
  assert.equal(provider.calls[2].messages.length, 1);
  assert.equal(provider.calls[2].messages[0].content, 'câu 3');

  // allServers: không có store liên-server nên fallback về lịch sử thisServer.
  const provider2 = scriptedSamplingProvider([
    { text: 'đáp A', toolCalls: [] },
    { text: 'đáp B', toolCalls: [] },
  ]);
  const handler2 = createSamplingHandler(provider2, { model: 'mock' });
  await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu A' } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });
  await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu B' } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });
  assert.deepEqual(
    provider2.calls[1].messages.map((m) => m.content),
    ['câu A', 'đáp A', 'câu B'],
  );

  // Lịch sử nằm trong handler instance: handler mới không thấy lịch sử handler cũ.
  const provider3 = scriptedSamplingProvider([{ text: 'đáp mới', toolCalls: [] }]);
  const fresh = createSamplingHandler(provider3, { model: 'mock' });
  await fresh({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu mới' } }],
    maxTokens: 100,
    includeContext: 'thisServer',
  });
  assert.equal(provider3.calls[0].messages.length, 1, 'handler mới bắt đầu với lịch sử rỗng');
});

test('MCP sampling includeContext: lịch sử kẹp tối đa 20 message gần nhất', async () => {
  const script = Array.from({ length: 13 }, (_, i) => ({ text: `đáp ${i}`, toolCalls: [] }));
  const provider = scriptedSamplingProvider(script);
  const handler = createSamplingHandler(provider, { model: 'mock' });
  for (let i = 0; i < 12; i++) {
    await handler({
      messages: [{ role: 'user', content: { type: 'text', text: `câu ${i}` } }],
      maxTokens: 100,
      includeContext: 'thisServer',
    });
  }
  // 12 lượt × (1 user + 1 assistant) = 24 message lịch sử → kẹp còn 20.
  await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu 12' } }],
    maxTokens: 100,
    includeContext: 'thisServer',
  });
  const last = provider.calls[12].messages;
  assert.equal(last.length, 21, '20 message lịch sử + 1 message mới');
  assert.equal(last[0].content, 'câu 2', 'message cũ nhất còn lại là của lượt 2 (lượt 0-1 đã bị cắt)');
  assert.equal(last[last.length - 1].content, 'câu 12');
});

test('MCP sampling stopSequences: handler truyền stop xuống provider và cắt text client-side ở lần xuất hiện đầu tiên', async () => {
  const provider = scriptedSamplingProvider([
    { text: 'Hello STOP world STOP again', toolCalls: [] },
  ]);
  const handler = createSamplingHandler(provider, { model: 'mock' });
  const result = await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'nói hello' } }],
    maxTokens: 100,
    stopSequences: ['STOP'],
  });
  // Provider giả bỏ qua stop nên text gốc vẫn chứa STOP — backstop client-side phải cắt.
  assert.equal(result.content.text, 'Hello ');
  assert.deepEqual(
    provider.calls[0].stop,
    ['STOP'],
    'handler truyền stopSequences xuống provider.chat dưới tên stop',
  );

  // Stop sequence không xuất hiện thì text giữ nguyên; stop ở đầu thì thành rỗng.
  const provider2 = scriptedSamplingProvider([
    { text: 'không có gì để cắt', toolCalls: [] },
    { text: 'END bỏ phần này', toolCalls: [] },
  ]);
  const handler2 = createSamplingHandler(provider2, { model: 'mock' });
  const r1 = await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'a' } }],
    maxTokens: 100,
    stopSequences: ['END'],
  });
  assert.equal(r1.content.text, 'không có gì để cắt');
  const r2 = await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'b' } }],
    maxTokens: 100,
    stopSequences: ['END'],
  });
  assert.equal(r2.content.text, '');

  // Nhiều stop sequence: cắt ở lần xuất hiện sớm nhất của bất kỳ chuỗi nào.
  const provider3 = scriptedSamplingProvider([
    { text: 'alpha BETA gamma ALPHA delta', toolCalls: [] },
  ]);
  const r3 = await createSamplingHandler(provider3, { model: 'mock' })({
    messages: [{ role: 'user', content: { type: 'text', text: 'c' } }],
    maxTokens: 100,
    stopSequences: ['ALPHA', 'BETA'],
  });
  assert.equal(r3.content.text, 'alpha ');
});

test('MCP sampling: includeContext / stopSequences sai kiểu -> SamplingError, không gọi provider', async () => {
  const provider = scriptedSamplingProvider([{ text: 'x', toolCalls: [] }]);
  const handler = createSamplingHandler(provider, { model: 'mock' });
  await assert.rejects(
    () => handler({ ...SAMPLING_PARAMS, includeContext: 'everything' }),
    /includeContext/,
  );
  await assert.rejects(
    () => handler({ ...SAMPLING_PARAMS, stopSequences: 'STOP' }),
    /stopSequences/,
  );
  await assert.rejects(
    () => handler({ ...SAMPLING_PARAMS, stopSequences: ['ok', ''] }),
    /stopSequences/,
  );
  assert.equal(provider.calls.length, 0, 'params sai thì fail trước khi gọi provider');
});

test('MCP sampling stopSequences (cách a): 3 provider nối stop native — OpenAI stop, Anthropic stop_sequences, Gemini stopSequences', async () => {
  // Import động trong test để không sửa khối import đầu file (chỉ thêm test mới).
  const { OpenAICompatibleProvider } = await import('../packages/core/dist/providers/openaiCompatible.js');
  const { AnthropicProvider } = await import('../packages/core/dist/providers/anthropic.js');
  const { GeminiProvider } = await import('../packages/core/dist/providers/gemini.js');
  const originalFetch = globalThis.fetch;
  try {
    // Một canned response chứa đủ field cho cả 3 parser (mỗi parser chỉ
    // đọc field của mình, bỏ qua field thừa); fetch giả không mạng live.
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        content: [{ type: 'text', text: 'ok' }],
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const openai = new OpenAICompatibleProvider({ id: 'test-openai', label: 'Test', baseUrl: 'https://example.invalid', defaultModel: 'm' });
    await openai.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stop: ['END'] });
    assert.deepEqual(seen[0].body.stop, ['END']);

    const anthropic = new AnthropicProvider({ id: 'anthropic', label: 'Anthropic', apiKey: 'test-key', defaultModel: 'claude-sonnet-4-5' });
    await anthropic.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], stop: ['END'] });
    assert.deepEqual(seen[1].body.stop_sequences, ['END']);
    assert.equal(seen[1].body.stop, undefined);

    const gemini = new GeminiProvider({ id: 'gemini', label: 'Gemini', apiKey: 'test-key', defaultModel: 'gemini-2.5-flash' });
    await gemini.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], stop: ['END'] });
    assert.deepEqual(seen[2].body.generationConfig.stopSequences, ['END']);

    // Không truyền stop thì không gửi trường stop nào (không đổi hành vi cũ).
    await openai.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal('stop' in seen[3].body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// MCP sampling — includeContext 'allServers' thật qua store dùng chung +
// stopReason 'stopSequence' (W17d, v0.24)
// ---------------------------------------------------------------------------

test('MCP sampling allServers với contextStore dùng chung: handler thứ 2 thấy lịch sử handler thứ 1', async () => {
  // Import động trong test để không sửa khối import đầu file (chỉ thêm test mới).
  const { createSamplingContextStore } = await import('../packages/core/dist/mcp/samplingContext.js');
  const store = createSamplingContextStore();
  const provider1 = scriptedSamplingProvider([
    { text: 'Paris là thủ đô của Pháp.', toolCalls: [] },
  ]);
  const handler1 = createSamplingHandler(provider1, {
    model: 'mock',
    contextStore: store,
    serverName: 'server-a',
  });
  await handler1({
    messages: [{ role: 'user', content: { type: 'text', text: 'Thủ đô của Pháp là gì?' } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });
  assert.equal(provider1.calls[0].messages.length, 1, 'lần đầu chưa có lịch sử chung');

  // Handler thứ 2 (server khác) dùng chung 1 store với handler thứ 1.
  const provider2 = scriptedSamplingProvider([
    { text: 'Berlin là thủ đô của Đức.', toolCalls: [] },
  ]);
  const handler2 = createSamplingHandler(provider2, {
    model: 'mock',
    contextStore: store,
    serverName: 'server-b',
  });
  await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'Còn thủ đô của Đức?' } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });
  assert.deepEqual(
    provider2.calls[0].messages.map((m) => [m.role, m.content]),
    [
      ['user', 'Thủ đô của Pháp là gì?'],
      ['assistant', 'Paris là thủ đô của Pháp.'],
      ['user', 'Còn thủ đô của Đức?'],
    ],
    'handler server-b đọc được lịch sử server-a qua store dùng chung',
  );
});

test('MCP sampling allServers không có store: fallback thisServer, không thấy lịch sử server khác', async () => {
  const provider1 = scriptedSamplingProvider([{ text: 'đáp A', toolCalls: [] }]);
  const handler1 = createSamplingHandler(provider1, { model: 'mock' });
  await handler1({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu A' } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });

  // Handler thứ 2 không có store: lần đầu không thấy gì của server A.
  const provider2 = scriptedSamplingProvider([
    { text: 'đáp B', toolCalls: [] },
    { text: 'đáp B2', toolCalls: [] },
  ]);
  const handler2 = createSamplingHandler(provider2, { model: 'mock' });
  await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu B' } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });
  assert.deepEqual(
    provider2.calls[0].messages.map((m) => m.content),
    ['câu B'],
    'không có store: allServers không thấy lịch sử server khác',
  );

  // Fallback thisServer vẫn hoạt động: lần 2 của cùng handler thấy lịch sử lần 1 của chính nó.
  await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'câu B2' } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });
  assert.deepEqual(
    provider2.calls[1].messages.map((m) => m.content),
    ['câu B', 'đáp B', 'câu B2'],
  );
});

test('MCP sampling allServers qua store: đọc rồi ghi không trùng lặp lịch sử', async () => {
  const { createSamplingContextStore } = await import('../packages/core/dist/mcp/samplingContext.js');
  const store = createSamplingContextStore();
  const provider = scriptedSamplingProvider([
    { text: 'đáp 1', toolCalls: [] },
    { text: 'đáp 2', toolCalls: [] },
    { text: 'đáp 3', toolCalls: [] },
  ]);
  const handler = createSamplingHandler(provider, {
    model: 'mock',
    contextStore: store,
    serverName: 'server-a',
  });
  const params = (text) => ({
    messages: [{ role: 'user', content: { type: 'text', text } }],
    maxTokens: 100,
    includeContext: 'allServers',
  });
  await handler(params('câu 1'));
  await handler(params('câu 2'));
  // Lượt 2 chỉ prepend đúng 1 lần lịch sử lượt 1 (không nhân đôi do vừa đọc vừa ghi).
  assert.deepEqual(
    provider.calls[1].messages.map((m) => m.content),
    ['câu 1', 'đáp 1', 'câu 2'],
  );
  await handler(params('câu 3'));
  assert.deepEqual(
    provider.calls[2].messages.map((m) => m.content),
    ['câu 1', 'đáp 1', 'câu 2', 'đáp 2', 'câu 3'],
  );
  // Store cũng chỉ giữ mỗi lượt đúng một lần.
  assert.deepEqual(
    store.getAllHistory().map((m) => m.content),
    ['câu 1', 'đáp 1', 'câu 2', 'đáp 2', 'câu 3', 'đáp 3'],
  );
});

test('MCP sampling stopSequences: backstop cắt text -> stopReason stopSequence, không gặp stop -> endTurn', async () => {
  // Provider giả bỏ qua stop nên text gốc vẫn chứa STOP — backstop cắt, báo stopSequence.
  const provider = scriptedSamplingProvider([
    { text: 'Hello STOP world', toolCalls: [] },
  ]);
  const handler = createSamplingHandler(provider, { model: 'mock' });
  const result = await handler({
    messages: [{ role: 'user', content: { type: 'text', text: 'nói hello' } }],
    maxTokens: 100,
    stopSequences: ['STOP'],
  });
  assert.equal(result.content.text, 'Hello ');
  assert.equal(result.stopReason, 'stopSequence');

  // Không gặp stop sequence thì text giữ nguyên, vẫn 'endTurn' như cũ.
  const provider2 = scriptedSamplingProvider([
    { text: 'không có gì để cắt', toolCalls: [] },
  ]);
  const r2 = await createSamplingHandler(provider2, { model: 'mock' })({
    messages: [{ role: 'user', content: { type: 'text', text: 'a' } }],
    maxTokens: 100,
    stopSequences: ['END'],
  });
  assert.equal(r2.content.text, 'không có gì để cắt');
  assert.equal(r2.stopReason, 'endTurn');

  // Không có stopSequences thì cũng 'endTurn' (hành vi cũ, không đổi).
  const provider3 = scriptedSamplingProvider([{ text: 'trả lời thường', toolCalls: [] }]);
  const r3 = await createSamplingHandler(provider3, { model: 'mock' })({
    messages: [{ role: 'user', content: { type: 'text', text: 'b' } }],
    maxTokens: 100,
  });
  assert.equal(r3.stopReason, 'endTurn');

  // 'maxTokens' (heuristic cũ) vẫn hoạt động: usage.outputTokens >= maxTokens.
  const maxed = {
    id: 'mock',
    label: 'Mock',
    async chat() {
      return { text: 'dài', toolCalls: [], usage: { inputTokens: 1, outputTokens: 100 } };
    },
    async listModels() {
      return ['mock'];
    },
  };
  const r4 = await createSamplingHandler(maxed, { model: 'mock' })({
    messages: [{ role: 'user', content: { type: 'text', text: 'c' } }],
    maxTokens: 100,
  });
  assert.equal(r4.stopReason, 'maxTokens');
});

test('MCP sampling contextStore: lịch sử trong store chịu cùng giới hạn 20 message', async () => {
  const { createSamplingContextStore } = await import('../packages/core/dist/mcp/samplingContext.js');
  const store = createSamplingContextStore();
  for (let i = 0; i < 25; i++) {
    store.append('server-a', [{ role: 'user', content: `câu ${i}` }]);
  }
  const history = store.getAllHistory();
  assert.equal(history.length, 20, 'store cắt về tối đa 20 message như lịch sử thisServer');
  assert.equal(history[0].content, 'câu 5', 'message cũ nhất còn lại là câu 5 (câu 0-4 đã bị cắt)');
  assert.equal(history[history.length - 1].content, 'câu 24');

  // getHistory chỉ trả lịch sử của đúng server đó; clear xoá hết.
  store.append('server-b', [{ role: 'user', content: 'câu của B' }]);
  assert.deepEqual(
    store.getHistory('server-b').map((m) => m.content),
    ['câu của B'],
  );
  assert.ok(!store.getHistory('server-a').some((m) => m.content === 'câu của B'));
  store.clear();
  assert.deepEqual(store.getAllHistory(), []);
});

// ---------------------------------------------------------------------------
// MCP sampling — kẹp số lượng stopSequences (W19b, v0.26, cách (b))
// ---------------------------------------------------------------------------

test('MCP sampling stopSequences: server gửi 8 chuỗi -> provider chỉ nhận 5 đầu, backstop vẫn cắt đúng ở chuỗi 6-8', async () => {
  const { SAMPLING_PROVIDER_STOP_SEQUENCES_MAX } = await import('../packages/core/dist/mcp/clientHandlers.js');
  assert.equal(SAMPLING_PROVIDER_STOP_SEQUENCES_MAX, 5, 'trần chung của handler là 5 (max của Gemini)');
  const stops8 = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
  // Provider giả bỏ qua stop nên text gốc vẫn chứa chuỗi dừng — backstop
  // client-side phải cắt, kể cả chuỗi provider không nhận được.
  const provider = scriptedSamplingProvider([
    { text: 'Hello S6 world', toolCalls: [] },
    { text: 'Hello S7 world', toolCalls: [] },
    { text: 'Hello S8 world', toolCalls: [] },
  ]);
  const handler = createSamplingHandler(provider, { model: 'mock' });
  const params = {
    messages: [{ role: 'user', content: { type: 'text', text: 'nói hello' } }],
    maxTokens: 100,
    stopSequences: stops8,
  };
  // Chuỗi thứ 6 (bị kẹp khỏi provider) vẫn dừng text đúng chỗ.
  const r1 = await handler(params);
  assert.equal(r1.content.text, 'Hello ');
  assert.equal(r1.stopReason, 'stopSequence');
  assert.deepEqual(provider.calls[0].stop, ['S1', 'S2', 'S3', 'S4', 'S5']);
  // Chuỗi thứ 7 và thứ 8 cũng vậy.
  const r2 = await handler(params);
  assert.equal(r2.content.text, 'Hello ');
  assert.equal(r2.stopReason, 'stopSequence');
  assert.deepEqual(provider.calls[1].stop, ['S1', 'S2', 'S3', 'S4', 'S5']);
  const r3 = await handler(params);
  assert.equal(r3.content.text, 'Hello ');
  assert.equal(r3.stopReason, 'stopSequence');
  assert.deepEqual(provider.calls[2].stop, ['S1', 'S2', 'S3', 'S4', 'S5']);

  // List <= trần thì không bị cắt: 5 chuỗi gửi đủ 5, 4 chuỗi gửi đủ 4.
  const provider2 = scriptedSamplingProvider([
    { text: 'đủ 5', toolCalls: [] },
    { text: 'đủ 4', toolCalls: [] },
  ]);
  const handler2 = createSamplingHandler(provider2, { model: 'mock' });
  await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'a' } }],
    maxTokens: 100,
    stopSequences: ['S1', 'S2', 'S3', 'S4', 'S5'],
  });
  assert.deepEqual(provider2.calls[0].stop, ['S1', 'S2', 'S3', 'S4', 'S5']);
  await handler2({
    messages: [{ role: 'user', content: { type: 'text', text: 'b' } }],
    maxTokens: 100,
    stopSequences: ['S1', 'S2', 'S3', 'S4'],
  });
  assert.deepEqual(provider2.calls[1].stop, ['S1', 'S2', 'S3', 'S4']);
});

test('MCP sampling stopSequences (cách b): provider kẹp theo giới hạn của nó — OpenAI 4, Gemini 5, Anthropic không kẹp (không có giới hạn trong doc chính thức)', async () => {
  // Import động trong test để không sửa khối import đầu file (chỉ thêm test mới).
  const { OpenAICompatibleProvider } = await import('../packages/core/dist/providers/openaiCompatible.js');
  const { AnthropicProvider } = await import('../packages/core/dist/providers/anthropic.js');
  const { GeminiProvider } = await import('../packages/core/dist/providers/gemini.js');
  const originalFetch = globalThis.fetch;
  try {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        content: [{ type: 'text', text: 'ok' }],
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const stops8 = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

    // Gọi thẳng provider với 8 chuỗi: OpenAI kẹp 4, Gemini kẹp 5.
    const openai = new OpenAICompatibleProvider({ id: 'test-openai', label: 'Test', baseUrl: 'https://example.invalid', defaultModel: 'm' });
    await openai.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stop: stops8 });
    assert.deepEqual(seen[0].body.stop, ['S1', 'S2', 'S3', 'S4'], 'OpenAI tối đa 4');

    const gemini = new GeminiProvider({ id: 'gemini', label: 'Gemini', apiKey: 'test-key', defaultModel: 'gemini-2.5-flash' });
    await gemini.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], stop: stops8 });
    assert.deepEqual(seen[1].body.generationConfig.stopSequences, ['S1', 'S2', 'S3', 'S4', 'S5'], 'Gemini tối đa 5');

    // Anthropic: doc chính thức không nêu giới hạn số lượng nên provider
    // không kẹp thêm — gửi đủ 8 (trong đường sampling, handler đã kẹp
    // trần chung 5 trước khi tới đây — xem test handler + provider thật).
    const anthropic = new AnthropicProvider({ id: 'anthropic', label: 'Anthropic', apiKey: 'test-key', defaultModel: 'claude-sonnet-4-5' });
    await anthropic.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], stop: stops8 });
    assert.deepEqual(seen[2].body.stop_sequences, stops8, 'Anthropic không có giới hạn kiểm chứng được nên không kẹp');

    // List <= giới hạn thì không bị cắt ở tầng provider.
    await openai.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stop: ['A', 'B', 'C'] });
    assert.deepEqual(seen[3].body.stop, ['A', 'B', 'C']);
    await gemini.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], stop: ['A', 'B', 'C', 'D', 'E'] });
    assert.deepEqual(seen[4].body.generationConfig.stopSequences, ['A', 'B', 'C', 'D', 'E']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MCP sampling stopSequences (cách b): handler + provider thật qua fetch stub — server gửi 8 chuỗi, OpenAI nhận 4, Gemini nhận 5, Anthropic nhận 5 (trần chung handler)', async () => {
  const { OpenAICompatibleProvider } = await import('../packages/core/dist/providers/openaiCompatible.js');
  const { AnthropicProvider } = await import('../packages/core/dist/providers/anthropic.js');
  const { GeminiProvider } = await import('../packages/core/dist/providers/gemini.js');
  const originalFetch = globalThis.fetch;
  try {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        content: [{ type: 'text', text: 'ok' }],
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const stops8 = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
    const params = {
      messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      maxTokens: 100,
      stopSequences: stops8,
    };

    const openai = new OpenAICompatibleProvider({ id: 'test-openai', label: 'Test', baseUrl: 'https://example.invalid', defaultModel: 'm' });
    const r1 = await createSamplingHandler(openai, { model: 'm' })(params);
    assert.equal(r1.content.text, 'ok');
    assert.deepEqual(seen[0].body.stop, ['S1', 'S2', 'S3', 'S4'], 'handler 5 -> OpenAI kẹp tiếp xuống 4');

    const gemini = new GeminiProvider({ id: 'gemini', label: 'Gemini', apiKey: 'test-key', defaultModel: 'gemini-2.5-flash' });
    const r2 = await createSamplingHandler(gemini, { model: 'gemini-2.5-flash' })(params);
    assert.equal(r2.content.text, 'ok');
    assert.deepEqual(seen[1].body.generationConfig.stopSequences, ['S1', 'S2', 'S3', 'S4', 'S5'], 'handler 5 = đúng trần Gemini');

    const anthropic = new AnthropicProvider({ id: 'anthropic', label: 'Anthropic', apiKey: 'test-key', defaultModel: 'claude-sonnet-4-5' });
    const r3 = await createSamplingHandler(anthropic, { model: 'claude-sonnet-4-5' })(params);
    assert.equal(r3.content.text, 'ok');
    assert.deepEqual(seen[2].body.stop_sequences, ['S1', 'S2', 'S3', 'S4', 'S5'], 'Anthropic qua sampling chỉ nhận 5 nhờ trần chung handler (provider không kẹp thêm)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
