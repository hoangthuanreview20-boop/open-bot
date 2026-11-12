/**
 * Test v0.20 W16c: A2A client `listTasks()` + `tasks/list` dạng tóm tắt
 * `summary` (node:test).
 * Chỉ test local, không mạng live: server A2A chạy trên loopback,
 * client thật (`A2aClient`) gọi vào.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-tasks-client-v020.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createA2aServer, startA2aHttpServer } from '../packages/core/dist/a2a/server.js';
import { A2aClient } from '../packages/core/dist/a2a/client.js';

// Token GIẢ chỉ dùng trong test (cùng mẫu file v013).
const TEST_A2A_TOKEN = 'test-a2a-token-v020';
const serversToClose = [];
after(async () => {
  for (const s of serversToClose.splice(0)) {
    await s.close().catch(() => undefined);
  }
});

function echoRunner() {
  return async ({ text }) => ({ text: `Đã nhận: ${text}` });
}

/** Tạo server độc lập + client thật; tạo 3 task: 2 ở ctx-a, 1 ở ctx-b. */
async function makeServerWithTasks() {
  const httpServer = await startA2aHttpServer({ token: TEST_A2A_TOKEN, runner: echoRunner() }, { port: 0 });
  serversToClose.push(httpServer);
  const client = new A2aClient({ baseUrl: httpServer.url, token: TEST_A2A_TOKEN });
  const t1 = await client.sendMessage('việc một', { contextId: 'ctx-a' });
  const t2 = await client.sendMessage('việc hai', { contextId: 'ctx-a' });
  const t3 = await client.sendMessage('việc ba', { contextId: 'ctx-b' });
  return { httpServer, client, t1, t2, t3 };
}

test('A2aClient.listTasks(): qua client thật tới server độc lập, đủ tasks + total + nextCursor, mới nhất trước', async () => {
  const { client, t1, t2, t3 } = await makeServerWithTasks();
  const res = await client.listTasks();
  assert.equal(res.total, 3);
  assert.equal(res.tasks.length, 3);
  assert.equal(res.nextCursor, null);
  // Mới nhất trước: task tạo sau cùng (t3) đứng đầu.
  assert.deepEqual(res.tasks.map((t) => t.id), [t3.id, t2.id, t1.id]);
  for (const t of res.tasks) {
    assert.equal(t.status.state, 'completed');
    assert.match(t.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(t.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('A2aClient.listTasks(): phân trang limit/offset/cursor, cursor thắng offset', async () => {
  const { client, t1, t2, t3 } = await makeServerWithTasks();

  const page1 = await client.listTasks({ limit: 1 });
  assert.equal(page1.tasks.length, 1);
  assert.equal(page1.tasks[0].id, t3.id);
  assert.equal(page1.total, 3);
  assert.equal(page1.nextCursor, '1');

  const page2 = await client.listTasks({ limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.tasks.length, 1);
  assert.equal(page2.tasks[0].id, t2.id);
  assert.equal(page2.nextCursor, '2');

  const page3 = await client.listTasks({ limit: 1, cursor: page2.nextCursor });
  assert.equal(page3.tasks.length, 1);
  assert.equal(page3.tasks[0].id, t1.id);
  assert.equal(page3.nextCursor, null);

  // offset tương đương cursor.
  const byOffset = await client.listTasks({ limit: 1, offset: 1 });
  assert.equal(byOffset.tasks[0].id, t2.id);
  // cursor thắng offset khi cả hai có mặt.
  const cursorWins = await client.listTasks({ limit: 1, offset: 0, cursor: '2' });
  assert.equal(cursorWins.tasks[0].id, t1.id);
  // limit vượt trần 100 -> server kẹp, không lỗi, trả đủ.
  const clamped = await client.listTasks({ limit: 500 });
  assert.equal(clamped.tasks.length, 3);
  assert.equal(clamped.total, 3);
});

test('A2aClient.listTasks(): lọc contextId', async () => {
  const { client, t1, t2 } = await makeServerWithTasks();
  const filtered = await client.listTasks({ contextId: 'ctx-a' });
  assert.equal(filtered.total, 2);
  assert.deepEqual(filtered.tasks.map((t) => t.id), [t2.id, t1.id]);
  assert.equal(filtered.nextCursor, null);
  const other = await client.listTasks({ contextId: 'ctx-b' });
  assert.equal(other.total, 1);
  assert.equal(other.tasks[0].contextId, 'ctx-b');
  const empty = await client.listTasks({ contextId: 'ctx-khac' });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.tasks, []);
  assert.equal(empty.nextCursor, null);
});

test('tasks/list summary:true: task gọn — đủ id/status/createdAt/updatedAt, KHÔNG history/artifacts', async () => {
  const { client, t3 } = await makeServerWithTasks();
  const res = await client.listTasks({ summary: true });
  assert.equal(res.total, 3);
  assert.equal(res.tasks.length, 3);
  assert.equal(res.nextCursor, null);
  assert.equal(res.tasks[0].id, t3.id);
  for (const t of res.tasks) {
    assert.equal(typeof t.id, 'string');
    assert.equal(t.status.state, 'completed');
    assert.equal(typeof t.status.timestamp, 'string');
    assert.equal(typeof t.contextId, 'string');
    assert.match(t.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(t.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal('history' in t, false, 'summary không được kèm history');
    assert.equal('artifacts' in t, false, 'summary không được kèm artifacts');
    // Chỉ đúng 5 key cho phép.
    assert.deepEqual(Object.keys(t).sort(), ['contextId', 'createdAt', 'id', 'status', 'updatedAt']);
  }
  // summary:true vẫn phân trang + lọc contextId bình thường.
  const page = await client.listTasks({ summary: true, limit: 1, contextId: 'ctx-a' });
  assert.equal(page.total, 2);
  assert.equal(page.tasks.length, 1);
  assert.equal(page.nextCursor, '1');
  assert.equal('history' in page.tasks[0], false);
});

test('tasks/list mặc định (không summary) và summary:false vẫn trả full task', async () => {
  const { client, t1 } = await makeServerWithTasks();
  const def = await client.listTasks();
  const byId = def.tasks.find((t) => t.id === t1.id);
  assert.ok(Array.isArray(byId.history) && byId.history.length > 0);
  assert.equal(byId.history[0].parts[0].text, 'việc một');
  assert.ok(Array.isArray(byId.artifacts) && byId.artifacts.length === 1);
  assert.equal(byId.artifacts[0].parts[0].text, 'Đã nhận: việc một');

  const explicitFalse = await client.listTasks({ summary: false });
  const byId2 = explicitFalse.tasks.find((t) => t.id === t1.id);
  assert.ok(Array.isArray(byId2.history) && byId2.history.length > 0);
  assert.ok(Array.isArray(byId2.artifacts) && byId2.artifacts.length === 1);
});

test('tasks/list summary sai kiểu -> lỗi -32602 (qua client và qua handleJsonRpc trực tiếp)', async () => {
  const { client } = await makeServerWithTasks();
  // Qua client thật: postRpc đổi lỗi JSON-RPC thành A2aError có code.
  await assert.rejects(
    () => client.listTasks({ summary: 'yes' }),
    (err) => err.code === -32602 && /tasks\/list/.test(err.message),
  );
  await assert.rejects(
    () => client.listTasks({ summary: 1 }),
    (err) => err.code === -32602,
  );

  // Qua handleJsonRpc trực tiếp (server độc lập, cùng logic mount Local API dùng).
  const server = createA2aServer({ token: TEST_A2A_TOKEN, runner: echoRunner() });
  const bad = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 1, method: 'tasks/list', params: { summary: 'yes' },
  });
  assert.equal(bad.error.code, -32602);
  const badNull = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 2, method: 'tasks/list', params: { summary: null },
  });
  assert.equal(badNull.error.code, -32602);
  // summary:true qua handleJsonRpc trực tiếp cũng gọn.
  await server.handleJsonRpc({
    jsonrpc: '2.0', id: 3, method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'alo' }] } },
  });
  const summary = await server.handleJsonRpc({
    jsonrpc: '2.0', id: 4, method: 'tasks/list', params: { summary: true },
  });
  assert.equal(summary.error, undefined);
  assert.equal(summary.result.total, 1);
  assert.equal('history' in summary.result.tasks[0], false);
  assert.equal('artifacts' in summary.result.tasks[0], false);
  assert.equal(typeof summary.result.tasks[0].id, 'string');
});
