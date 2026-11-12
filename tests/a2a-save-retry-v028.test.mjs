/**
 * Test v0.28: retry + cảnh báo khi lưu task A2A lỗi (node:test).
 *
 * Trước v0.28, `persistTasks()` chỉ thử `store.save()` đúng 1 lần: lỗi
 * đĩa thoáng qua là mất lần lưu đó ngay, chỉ còn log stderr mà người
 * dùng không bao giờ thấy. Từ v0.28, mỗi lần lưu được thử lại tối đa
 * 3 lần với backoff 50ms → 100ms; hết retry vẫn lỗi thì server cập
 * nhật `getPersistStatus()` + gọi `onPersistStatusChange` để UI hiện
 * banner cảnh báo (task vẫn giữ trong bộ nhớ, không crash server).
 *
 * Chỉ test local, không mạng live, không API key thật.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-save-retry-v028.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createA2aServer,
  saveTaskStoreWithRetry,
  A2A_PERSIST_MAX_ATTEMPTS,
  A2A_PERSIST_RETRY_DELAY_MS,
} from '../packages/core/dist/a2a/server.js';

const TEST_A2A_TOKEN = 'test-a2a-token-v028';

let rpcId = 0;
/** Gửi một task qua JSON-RPC `message:send` (in-process), trả task cuối. */
async function sendTask(server, text) {
  const res = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'message:send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text }] } },
  });
  assert.equal(res.error, undefined, `message:send lỗi: ${JSON.stringify(res)}`);
  return res.result;
}

function echoRunner() {
  return async ({ text }) => ({ text: `Đã nhận: ${text}` });
}

/**
 * Store A2A trong bộ nhớ, cho test điều khiển lỗi: `failNext(n)` làm
 * `n` lần `save` tiếp theo throw lỗi đĩa giả, rồi lại ghi bình thường.
 */
function makeFlakyStore() {
  let saved = [];
  let calls = 0;
  let failuresLeft = 0;
  return {
    get saved() {
      return saved;
    },
    get calls() {
      return calls;
    },
    failNext(n) {
      failuresLeft = n;
    },
    store: {
      load() {
        return [...saved];
      },
      save(tasks) {
        calls += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('đĩa tạm lỗi (EIO giả lập)');
        }
        saved = [...tasks];
      },
    },
  };
}

test('saveTaskStoreWithRetry: lỗi tạm thời 2 lần rồi thành công — ok, 3 lần thử, backoff 50ms → 100ms', () => {
  assert.equal(A2A_PERSIST_MAX_ATTEMPTS, 3);
  assert.equal(A2A_PERSIST_RETRY_DELAY_MS, 50);
  const flaky = makeFlakyStore();
  flaky.failNext(2);
  const delays = [];
  const result = saveTaskStoreWithRetry(flaky.store, [{ id: 't1' }], {
    sleep: (ms) => delays.push(ms),
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.error, undefined);
  assert.deepEqual(delays, [50, 100], 'backoff phải là 50ms rồi 100ms (×2)');
  assert.equal(flaky.calls, 3);
  assert.equal(flaky.saved.length, 1);
});

test('saveTaskStoreWithRetry: lỗi hẳn — ok=false sau 3 lần thử, không throw, trả error lần cuối', () => {
  const flaky = makeFlakyStore();
  flaky.failNext(99);
  const delays = [];
  const result = saveTaskStoreWithRetry(flaky.store, [{ id: 't1' }], {
    sleep: (ms) => delays.push(ms),
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.match(result.error.message, /đĩa tạm lỗi/);
  assert.deepEqual(delays, [50, 100]);
  assert.equal(flaky.calls, 3);
  assert.equal(flaky.saved.length, 0);
});

test('saveTaskStoreWithRetry: thành công ngay lần đầu — 1 lần thử, không chờ', () => {
  const flaky = makeFlakyStore();
  const delays = [];
  const result = saveTaskStoreWithRetry(flaky.store, [{ id: 't1' }], {
    sleep: (ms) => delays.push(ms),
  });
  assert.deepEqual({ ok: result.ok, attempts: result.attempts }, { ok: true, attempts: 1 });
  assert.deepEqual(delays, []);
});

test('server: lỗi tạm thời 2 lần ở lần lưu đầu — retry cứu được, task lưu đủ, status ok, không báo lỗi UI', async () => {
  const flaky = makeFlakyStore();
  flaky.failNext(2);
  const statusChanges = [];
  const server = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: flaky.store,
    persistRetryDelayMs: 1,
    onPersistStatusChange: (status) => statusChanges.push(status),
  });
  const created = await sendTask(server, 'việc cần nhớ');
  assert.equal(created.status.state, 'completed');
  // Lần lưu đầu (tạo task) thử 3 lần: lỗi, lỗi, ok; 2 lần lưu sau
  // (working → completed) thành công ngay: tổng 5 lần gọi save.
  assert.equal(flaky.calls, 5);
  assert.equal(flaky.saved.length, 1);
  assert.equal(flaky.saved[0].id, created.id);
  assert.equal(flaky.saved[0].status.state, 'completed');
  // Không lần lưu nào thất bại hẳn nên không báo UI.
  assert.deepEqual(statusChanges, []);
  const status = server.getPersistStatus();
  assert.equal(status.ok, true);
  assert.equal(status.lastError, null);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.totalFailures, 0);
  assert.equal(status.lastAttempts, 1, 'lần lưu cuối thành công ngay');
});

test('server: lỗi hẳn — task vẫn chạy xong và giữ trong bộ nhớ, status báo lỗi rõ, callback UI được gọi, mỗi lần lưu thử đủ 3 lần', async () => {
  const flaky = makeFlakyStore();
  flaky.failNext(99);
  const statusChanges = [];
  const server = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: flaky.store,
    persistRetryDelayMs: 1,
    onPersistStatusChange: (status) => statusChanges.push(status),
  });
  const created = await sendTask(server, 'việc vẫn chạy dù đĩa lỗi');
  // Task vẫn chạy xong bình thường — lỗi lưu không được làm hỏng run.
  assert.equal(created.status.state, 'completed');
  assert.equal(server.listTasks().length, 1);
  assert.equal(server.getTask(created.id).status.state, 'completed');
  // 1 lần gửi = 3 lần lưu (tạo task, working, completed), mỗi lần
  // thử đủ 3 lần rồi mới bỏ: 9 lần gọi save, không lần nào ghi được.
  assert.equal(flaky.calls, 9);
  assert.equal(flaky.saved.length, 0);
  const status = server.getPersistStatus();
  assert.equal(status.ok, false);
  assert.match(status.lastError, /đĩa tạm lỗi/);
  assert.equal(status.lastAttempts, 3);
  assert.equal(status.consecutiveFailures, 3, '3 lần lưu liên tiếp đều thất bại');
  assert.equal(status.totalFailures, 3);
  assert.match(status.lastAttemptAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.lastSuccessAt, null, 'chưa lưu thành công lần nào');
  // Callback UI được gọi cho mỗi lần lưu thất bại (3 lần), đều ok:false.
  assert.equal(statusChanges.length, 3);
  for (const change of statusChanges) assert.equal(change.ok, false);
});

test('server: lỗi hẳn rồi hồi phục — status chuyển ok, consecutiveFailures reset, callback báo hồi phục cho UI gỡ banner', async () => {
  const flaky = makeFlakyStore();
  flaky.failNext(99);
  const statusChanges = [];
  const server = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: flaky.store,
    persistRetryDelayMs: 1,
    onPersistStatusChange: (status) => statusChanges.push(status),
  });
  await sendTask(server, 'việc lúc đĩa lỗi');
  assert.equal(server.getPersistStatus().ok, false);
  assert.equal(server.getPersistStatus().consecutiveFailures, 3);

  // Đĩa "khỏi": lần lưu tiếp theo phải thành công và báo hồi phục.
  flaky.failNext(0);
  const changesBefore = statusChanges.length;
  const created = await sendTask(server, 'việc lúc đĩa khỏi');
  assert.equal(created.status.state, 'completed');
  assert.equal(flaky.saved.length, 2, 'cả 2 task đều được lưu sau khi hồi phục');
  const status = server.getPersistStatus();
  assert.equal(status.ok, true);
  assert.equal(status.lastError, null);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.totalFailures, 3, 'tổng lỗi cũ vẫn giữ để UI/debug thấy');
  assert.match(status.lastSuccessAt, /^\d{4}-\d{2}-\d{2}T/);
  // Chỉ báo callback 1 lần cho lần lưu thành công đầu tiên sau chuỗi
  // lỗi (các lần lưu thành công sau đó không spam callback).
  assert.equal(statusChanges.length, changesBefore + 1);
  assert.equal(statusChanges[statusChanges.length - 1].ok, true);
});

test('server: backoff mặc định — một lần lưu lỗi hẳn chờ ít nhất 100ms (50ms + 100ms) trước khi bỏ', async () => {
  const flaky = makeFlakyStore();
  flaky.failNext(3); // chỉ làm lỗi đúng 1 lần lưu (3 lần thử), rồi khỏi
  const server = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    taskStore: flaky.store,
    // Không truyền persistRetryDelayMs: dùng mặc định 50ms.
  });
  const started = Date.now();
  const created = await sendTask(server, 'việc đo backoff');
  const elapsedMs = Date.now() - started;
  assert.equal(created.status.state, 'completed');
  // Lần lưu đầu thất bại 2 lần rồi thành công lần 3: chờ 50 + 100 =
  // 150ms. Ngưỡng 100ms để không flaky trên máy chậm.
  assert.ok(elapsedMs >= 100, `phải chờ backoff, chỉ mất ${elapsedMs}ms`);
  assert.equal(flaky.saved.length, 1);
  assert.equal(server.getPersistStatus().ok, true);
});

test('server: không có store — getPersistStatus() mặc định ok, không callback, không crash', async () => {
  const statusChanges = [];
  const server = createA2aServer({
    token: TEST_A2A_TOKEN,
    runner: echoRunner(),
    onPersistStatusChange: (status) => statusChanges.push(status),
  });
  await sendTask(server, 'việc không store');
  assert.equal(server.listTasks().length, 1);
  assert.deepEqual(server.getPersistStatus(), {
    ok: true,
    lastError: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastAttempts: 0,
    consecutiveFailures: 0,
    totalFailures: 0,
  });
  assert.deepEqual(statusChanges, []);
});
