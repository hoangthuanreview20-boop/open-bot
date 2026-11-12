/**
 * Test v0.25 W18c: task A2A bền vững qua restart (file-backed store)
 * + REST `GET /a2a/tasks` (node:test).
 * Chỉ test local, không mạng live: server A2A chạy trên loopback,
 * client thật (`A2aClient`) + mount Local API thật.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-tasks-persist-v025.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createA2aServer,
  createFileTaskStore,
  startA2aHttpServer,
} from '../packages/core/dist/a2a/server.js';
import { A2aClient } from '../packages/core/dist/a2a/client.js';
import { createApiServer } from '../packages/core/dist/api/server.js';

// Token GIẢ chỉ dùng trong test (cùng mẫu file v013/v020).
const TEST_A2A_TOKEN = 'test-a2a-token-v025';
const API_TOKEN = 'test-api-token-v025';

const tempDirs = [];
const httpServersToClose = [];
const apiServersToStop = [];
afterEach(async () => {
  while (httpServersToClose.length > 0) {
    await httpServersToClose.pop().close().catch(() => undefined);
  }
  while (apiServersToStop.length > 0) {
    await apiServersToStop.pop().stop().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-a2a-persist-v025-'));
  tempDirs.push(dir);
  return dir;
}

function echoRunner() {
  return async ({ text }) => ({ text: `Đã nhận: ${text}` });
}

let rpcId = 0;
/** Gửi một task qua JSON-RPC `message:send` (in-process), trả task cuối. */
async function sendTask(server, text, contextId) {
  const res = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'message:send',
    params: {
      message: { role: 'user', parts: [{ kind: 'text', text }] },
      ...(contextId !== undefined ? { contextId } : {}),
    },
  });
  assert.equal(res.error, undefined, `message:send lỗi: ${JSON.stringify(res)}`);
  return res.result;
}

async function listTasksRpc(server, params = {}) {
  const res = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tasks/list',
    params,
  });
  assert.equal(res.error, undefined, `tasks/list lỗi: ${JSON.stringify(res)}`);
  return res.result;
}

function minimalApiHandlers() {
  return {
    listBots: async () => [],
    runBot: async () => ({ text: '' }),
    getHistory: async () => [],
    listTasks: async () => [],
  };
}

test('file store: message:send qua HTTP → restart server cùng file → tasks/get vẫn đủ history/artifacts/status/createdAt/updatedAt', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'a2a-tasks.json');
  const store1 = createFileTaskStore(file);

  const http1 = await startA2aHttpServer(
    { token: TEST_A2A_TOKEN, runner: echoRunner(), taskStore: store1 },
    { port: 0 },
  );
  httpServersToClose.push(http1);
  const client1 = new A2aClient({ baseUrl: http1.url, token: TEST_A2A_TOKEN });
  const created = await client1.sendMessage('việc cần nhớ', { contextId: 'ctx-persist' });
  assert.equal(created.status.state, 'completed');
  assert.equal(created.artifacts[0].parts[0].text, 'Đã nhận: việc cần nhớ');

  // File đã ghi ngay sau khi task xong, mode 0600 (task chứa nội dung nhạy cảm).
  assert.ok(fs.existsSync(file), 'file store phải tồn tại sau khi tạo task');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'file store phải có mode 0600');
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, created.id);

  // Restart: đóng server cũ, tạo server mới cùng file store.
  await http1.close();
  httpServersToClose.splice(httpServersToClose.indexOf(http1), 1);
  const store2 = createFileTaskStore(file);
  const http2 = await startA2aHttpServer(
    { token: TEST_A2A_TOKEN, runner: echoRunner(), taskStore: store2 },
    { port: 0 },
  );
  httpServersToClose.push(http2);
  const client2 = new A2aClient({ baseUrl: http2.url, token: TEST_A2A_TOKEN });
  const restored = await client2.getTask(created.id);
  assert.equal(restored.id, created.id);
  assert.equal(restored.contextId, 'ctx-persist');
  assert.equal(restored.status.state, 'completed');
  assert.deepEqual(restored.history, created.history);
  assert.deepEqual(restored.artifacts, created.artifacts);
  assert.equal(restored.createdAt, created.createdAt);
  assert.equal(restored.updatedAt, created.updatedAt);
  assert.match(restored.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(restored.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const listed = await client2.listTasks();
  assert.equal(listed.total, 1);
  assert.equal(listed.tasks[0].id, created.id);
});

test('file store: giới hạn 200 vẫn giữ sau restart (tạo 201 task → task cũ nhất mất, còn 200)', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'a2a-tasks.json');
  const server1 = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  const texts = [];
  for (let i = 1; i <= 201; i++) {
    const t = await sendTask(server1, `việc ${i}`);
    texts.push(t);
  }
  assert.equal(server1.listTasks().length, 200);
  const ids1 = new Set(server1.listTasks().map((t) => t.id));
  assert.ok(!ids1.has(texts[0].id), 'task cũ nhất (việc 1) phải bị loại khi vượt 200');
  assert.ok(ids1.has(texts[200].id), 'task mới nhất (việc 201) phải còn');
  // File trên đĩa cũng chỉ còn 200 task.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).length, 200);

  // Restart cùng file: vẫn 200, task cũ nhất vẫn mất.
  const server2 = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  assert.equal(server2.listTasks().length, 200);
  const ids2 = new Set(server2.listTasks().map((t) => t.id));
  assert.ok(!ids2.has(texts[0].id));
  assert.ok(ids2.has(texts[200].id));
  // Mới nhất trước, đúng thứ tự.
  assert.equal(server2.listTasks()[0].id, texts[200].id);
  assert.equal(server2.listTasks()[199].id, texts[1].id);
});

test('file store hỏng: server vẫn khởi động, list trả [] (rác / JSON không phải mảng / file thiếu)', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'a2a-tasks.json');

  // File thiếu hẳn → [] (chạy lần đầu).
  const fresh = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  assert.equal((await listTasksRpc(fresh)).total, 0);

  // Ghi rác vào file → server mới vẫn khởi động, list [].
  fs.writeFileSync(file, 'không phải json {{{', 'utf-8');
  const garbage = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  assert.equal((await listTasksRpc(garbage)).total, 0);

  // JSON hợp lệ nhưng không phải mảng → [].
  fs.writeFileSync(file, '{"khong-phai": "mang"}', 'utf-8');
  const notArray = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  assert.equal((await listTasksRpc(notArray)).total, 0);

  // Entry hỏng lẻ trong mảng → chỉ bỏ entry đó, giữ task hợp lệ.
  const goodTask = {
    id: 'task-tot',
    contextId: 'ctx-x',
    status: { state: 'completed', timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    file,
    JSON.stringify([{ khongCoId: true }, goodTask, 'chuoi-rang', null]),
    'utf-8',
  );
  const partial = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  const listed = await listTasksRpc(partial);
  assert.equal(listed.total, 1);
  assert.equal(listed.tasks[0].id, 'task-tot');
});

test('file store: task đang chạy dở lúc restart được đánh dấu failed rõ ràng khi load lại', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'a2a-tasks.json');
  const now = new Date().toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        id: 'task-dang-chay',
        contextId: 'ctx-y',
        status: { state: 'working', timestamp: now },
        artifacts: [],
        history: [{ kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'việc dở' }] }],
        createdAt: now,
        updatedAt: now,
      },
    ]),
    'utf-8',
  );
  const server = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  const restored = server.getTask('task-dang-chay');
  assert.equal(restored.status.state, 'failed');
  assert.match(restored.status.message.parts[0].text, /khởi động lại/);
  assert.equal(restored.createdAt, now);
  // File được ghi lại với trạng thái failed (không kẹt working sau restart sau nữa).
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(saved[0].status.state, 'failed');
});

test('không có store: hành vi cũ — restart mất task', async () => {
  const server1 = createA2aServer({ token: TEST_A2A_TOKEN, runner: echoRunner() });
  const created = await sendTask(server1, 'việc tạm');
  assert.equal(server1.listTasks().length, 1);
  const server2 = createA2aServer({ token: TEST_A2A_TOKEN, runner: echoRunner() });
  assert.equal(server2.listTasks().length, 0);
  const res = await server2.handleJsonRpc({
    jsonrpc: '2.0',
    id: 999,
    method: 'tasks/get',
    params: { id: created.id },
  });
  assert.equal(res.error.code, -32602);
});

test('REST GET /a2a/tasks qua mount thật: phân trang + summary gọn + lọc contextId + query sai → 400', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'a2a-tasks.json');
  const a2aServer = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: createFileTaskStore(file),
  });
  const t1 = await sendTask(a2aServer, 'việc một', 'ctx-a');
  const t2 = await sendTask(a2aServer, 'việc hai', 'ctx-a');
  const t3 = await sendTask(a2aServer, 'việc ba', 'ctx-b');

  const api = createApiServer({
    port: 0,
    token: API_TOKEN,
    handlers: minimalApiHandlers(),
    a2aServer,
  });
  await api.start();
  apiServersToStop.push(api);
  const base = `http://127.0.0.1:${api.port}`;
  const get = (p, auth = true) =>
    fetch(`${base}${p}`, {
      headers: auth ? { Authorization: `Bearer ${API_TOKEN}` } : {},
    });

  // Không token → 401.
  assert.equal((await get('/a2a/tasks', false)).status, 401);

  // List mặc định: đủ 3, mới nhất trước, full task (có history/artifacts).
  let res = await get('/a2a/tasks');
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.total, 3);
  assert.equal(body.nextCursor, null);
  assert.deepEqual(body.tasks.map((t) => t.id), [t3.id, t2.id, t1.id]);
  assert.ok(Array.isArray(body.tasks[0].history) && body.tasks[0].history.length === 1);
  assert.equal(body.tasks[0].artifacts[0].parts[0].text, 'Đã nhận: việc ba');

  // Phân trang limit=2 → nextCursor '2'; cursor=2 → trang còn lại.
  res = await get('/a2a/tasks?limit=2');
  body = await res.json();
  assert.equal(body.tasks.length, 2);
  assert.equal(body.total, 3);
  assert.equal(body.nextCursor, '2');
  res = await get('/a2a/tasks?limit=2&cursor=2');
  body = await res.json();
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].id, t1.id);
  assert.equal(body.nextCursor, null);

  // limit > 100 được kẹp về 100 (không lỗi, vẫn trả đủ 3).
  res = await get('/a2a/tasks?limit=500');
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.total, 3);

  // summary=true → dạng gọn: chỉ id/status/contextId/createdAt/updatedAt.
  res = await get('/a2a/tasks?summary=true');
  body = await res.json();
  assert.equal(body.tasks.length, 3);
  for (const t of body.tasks) {
    assert.deepEqual(Object.keys(t).sort(), ['contextId', 'createdAt', 'id', 'status', 'updatedAt']);
    assert.ok(!('history' in t) && !('artifacts' in t));
  }
  // summary=false → full task như mặc định.
  res = await get('/a2a/tasks?summary=false');
  body = await res.json();
  assert.ok('history' in body.tasks[0]);

  // Lọc contextId.
  res = await get('/a2a/tasks?contextId=ctx-a');
  body = await res.json();
  assert.equal(body.total, 2);
  assert.deepEqual(body.tasks.map((t) => t.id), [t2.id, t1.id]);

  // Query sai → 400 rõ ràng.
  for (const bad of [
    '/a2a/tasks?limit=abc',
    '/a2a/tasks?limit=0',
    '/a2a/tasks?limit=-5',
    '/a2a/tasks?limit=1.5',
    '/a2a/tasks?offset=-1',
    '/a2a/tasks?offset=xyz',
    '/a2a/tasks?cursor=xx',
    '/a2a/tasks?summary=maybe',
    '/a2a/tasks?summary=1',
  ]) {
    res = await get(bad);
    assert.equal(res.status, 400, `${bad} phải 400`);
    const errBody = await res.json();
    assert.equal(typeof errBody.error, 'string');
    assert.ok(errBody.error.length > 0, `${bad} phải có message lỗi rõ ràng`);
  }

  // GET /a2a/tasks/:id cũ vẫn chạy qua mount.
  res = await get(`/a2a/tasks/${t2.id}`);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.id, t2.id);
  assert.equal(body.status.state, 'completed');
});

test('REST GET /a2a/tasks: chưa mount A2A → 404', async () => {
  const api = createApiServer({
    port: 0,
    token: API_TOKEN,
    handlers: minimalApiHandlers(),
  });
  await api.start();
  apiServersToStop.push(api);
  const res = await fetch(`http://127.0.0.1:${api.port}/a2a/tasks`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  assert.equal(res.status, 404);
});
