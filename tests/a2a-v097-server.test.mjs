/**
 * Test v0.97 (Đội T2): A2A server v1.0 tích hợp — client thật ↔ server
 * thật trên loopback: card ký số, version 1.0.1, transitions,
 * resubscribe, push config + webhook nhận POST khi task xong.
 *
 * Chỉ test local (loopback), không mạng ngoài.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-v097-server.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createA2aServer, startA2aHttpServer } from '../packages/core/dist/a2a/server.js';
import { A2aClient, fetchCheckedAgentCard } from '../packages/core/dist/a2a/client.js';
import { A2aPushNotifier } from '../packages/core/dist/a2a/push.js';
import { generateA2aSigningKey, verifyAgentCardSignature } from '../packages/core/dist/a2a/signing.js';

const TEST_TOKEN = 'test-a2a-token-v097';
const serversToClose = [];
const webhookServers = [];
after(async () => {
  for (const s of serversToClose.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const s of webhookServers.splice(0)) {
    await new Promise((done) => s.close(() => done()));
  }
});

function echoRunner() {
  return async ({ text, onProgress }) => {
    onProgress('đang làm...');
    return { text: `Đã nhận: ${text}` };
  };
}

function makeWebhook() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(body ? JSON.parse(body) : null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      webhookServers.push(server);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/hook`, received });
    });
  });
}

async function makeServer(options = {}) {
  const httpServer = await startA2aHttpServer(
    { token: TEST_TOKEN, runner: echoRunner(), ...options },
    { port: 0 },
  );
  serversToClose.push(httpServer);
  const client = new A2aClient({ baseUrl: httpServer.url, token: TEST_TOKEN });
  return { httpServer, client };
}

test('card ký số: server có signer → signature hợp lệ, protocol 1.0.1', async () => {
  const key = generateA2aSigningKey();
  const { httpServer, client } = await makeServer({ signer: key, name: 'open-bot-test' });
  const card = await client.discover();
  assert.equal(card.protocolVersion, '1.0.1');
  assert.ok(card.signature);
  assert.equal(card.signature.keyId, key.keyId);
  assert.equal(verifyAgentCardSignature(card).ok, true);
  // Capability mới bật.
  assert.equal(card.capabilities?.stateTransitionHistory, true);
  assert.equal(card.capabilities?.streaming, true);
  assert.equal(card.capabilities?.pushNotifications, false);
  void httpServer;
});

test('card không signer → không có chữ ký (agent cũ), verify báo unsigned', async () => {
  const { client } = await makeServer();
  const card = await client.discover();
  assert.equal(card.signature, undefined);
  assert.equal(verifyAgentCardSignature(card).unsigned, true);
});

test('discoverChecked: version đàm phán 1.0.1 + chữ ký hợp lệ', async () => {
  const key = generateA2aSigningKey();
  const { client } = await makeServer({ signer: key });
  const checked = await client.discoverChecked();
  assert.equal(checked.version.ok, true);
  assert.equal(checked.version.negotiated, '1.0.1');
  assert.equal(checked.signature.ok, true);
  assert.equal(checked.signature.keyId, key.keyId);
});

test('fetchCheckedAgentCard: đọc card qua HTTP + kiểm tra luôn', async () => {
  const key = generateA2aSigningKey();
  const { httpServer } = await makeServer({ signer: key });
  const checked = await fetchCheckedAgentCard(httpServer.url, { token: TEST_TOKEN });
  assert.equal(checked.card.name, 'open-bot');
  assert.equal(checked.version.negotiated, '1.0.1');
  assert.equal(checked.signature.ok, true);
});

test('transitions: task chạy xong ghi đủ submitted → working → completed', async () => {
  const { client } = await makeServer();
  const task = await client.sendMessage('việc một');
  assert.equal(task.status.state, 'completed');
  const transitions = task.transitions ?? [];
  assert.ok(transitions.length >= 3);
  assert.equal(transitions[0].from, null);
  assert.equal(transitions[0].to, 'submitted');
  assert.equal(transitions[0].legal, true);
  const states = transitions.map((t) => t.to);
  assert.ok(states.includes('working'));
  assert.equal(states[states.length - 1], 'completed');
  assert.ok(transitions.every((t) => t.legal));
  // tasks/get cũng trả transitions.
  const again = await client.getTask(task.id);
  assert.deepEqual(again.transitions, transitions);
});

test('transitions: runner cần input → input-required ghi vào lịch sử', async () => {
  const httpServer = await startA2aHttpServer(
    {
      token: TEST_TOKEN,
      runner: async () => ({ needsInput: 'Cần thêm thông tin gì?' }),
    },
    { port: 0 },
  );
  serversToClose.push(httpServer);
  const client = new A2aClient({ baseUrl: httpServer.url, token: TEST_TOKEN });
  const task = await client.sendMessage('việc cần hỏi');
  assert.equal(task.status.state, 'input-required');
  const states = (task.transitions ?? []).map((t) => t.to);
  assert.ok(states.includes('input-required'));
});

test('resubscribe: client nối lại lấy task hiện tại kèm transitions', async () => {
  const { client } = await makeServer();
  const sent = await client.sendMessage('việc nối lại');
  const back = await client.resubscribe(sent.id);
  assert.equal(back.id, sent.id);
  assert.equal(back.status.state, 'completed');
  assert.ok((back.transitions ?? []).length >= 3);
  // resubscribe task không có → lỗi rõ.
  await assert.rejects(() => client.resubscribe('task-khong-co'), /Không có task/);
});

test('push: đăng ký config qua client, webhook nhận POST khi task xong', async () => {
  const hook = await makeWebhook();
  const notifier = new A2aPushNotifier();
  const { client } = await makeServer({ pushNotifier: notifier });
  // Task chạy nhanh nên đăng ký phải xong trước khi task settle:
  // dùng runner chậm để có thời gian đăng ký.
  const slow = await startA2aHttpServer(
    {
      token: TEST_TOKEN,
      pushNotifier: notifier,
      runner: async ({ text }) => {
        await new Promise((r) => setTimeout(r, 300));
        return { text: `xong: ${text}` };
      },
    },
    { port: 0 },
  );
  serversToClose.push(slow);
  const slowClient = new A2aClient({ baseUrl: slow.url, token: TEST_TOKEN });
  // Gửi task qua stream để lấy taskId sớm rồi đăng ký push.
  const streamPromise = slowClient.streamMessage('việc push');
  // Đợi task xuất hiện trong list rồi đăng ký (task vẫn working).
  let taskId = null;
  for (let i = 0; i < 20 && !taskId; i++) {
    const list = await slowClient.listTasks({ limit: 5 });
    const t = list.tasks.find((x) => x.status.state === 'working' || x.status.state === 'submitted');
    if (t) taskId = t.id;
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(taskId, 'task phải xuất hiện trước khi chạy xong');
  const saved = await slowClient.setPushNotificationConfig(taskId, hook.url);
  assert.equal(saved.taskId, taskId);
  const got = await slowClient.getPushNotificationConfig(taskId);
  assert.equal(got.url, hook.url);
  const finalTask = await streamPromise;
  assert.equal(finalTask.status.state, 'completed');
  // Webhook nhận đúng 1 POST với task cuối.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hook.received.length, 1);
  assert.equal(hook.received[0].taskId, taskId);
  assert.equal(hook.received[0].state, 'completed');
  assert.equal(hook.received[0].task.status.state, 'completed');
  void client;
});

test('push: server không gắn notifier → set config lỗi rõ, get trả url null', async () => {
  const { client } = await makeServer();
  const task = await client.sendMessage('việc không push');
  await assert.rejects(
    () => client.setPushNotificationConfig(task.id, 'http://127.0.0.1:9/hook'),
    /chưa bật pushNotifications/,
  );
  const got = await client.getPushNotificationConfig(task.id);
  assert.equal(got.url, null);
});

test('push: đăng ký cho task đã xong → lỗi rõ (không có tác dụng)', async () => {
  const notifier = new A2aPushNotifier();
  const { client } = await makeServer({ pushNotifier: notifier });
  const task = await client.sendMessage('việc đã xong');
  assert.equal(task.status.state, 'completed');
  await assert.rejects(
    () => client.setPushNotificationConfig(task.id, 'http://127.0.0.1:9/hook'),
    /đã kết thúc/,
  );
});

test('resubscribeStream: nối lại stream task đang chạy, nhận task cuối', async () => {
  const slow = await startA2aHttpServer(
    {
      token: TEST_TOKEN,
      runner: async ({ text, onProgress }) => {
        onProgress('đang xử lý...');
        await new Promise((r) => setTimeout(r, 400));
        return { text: `xong chậm: ${text}` };
      },
    },
    { port: 0 },
  );
  serversToClose.push(slow);
  const client = new A2aClient({ baseUrl: slow.url, token: TEST_TOKEN });
  const sent = await client.sendMessage('việc resubscribe');
  assert.equal(sent.status.state, 'completed');
  // Task đã xong: resubscribeStream replay task cuối rồi đóng stream.
  const seen = [];
  const back = await client.resubscribeStream(sent.id, {
    onStatus: (s) => seen.push(s),
    timeoutMs: 10000,
  });
  assert.equal(back.id, sent.id);
  assert.equal(back.status.state, 'completed');
  assert.ok(seen.includes('completed'));
  // Task không có → lỗi rõ.
  await assert.rejects(() => client.resubscribeStream('task-khong-co'), /HTTP 404|không còn/);
});

test('resubscribeStream: task đang chạy — stream theo tới khi xong, không hủy task', async () => {
  const slow = await startA2aHttpServer(
    {
      token: TEST_TOKEN,
      runner: async ({ text }) => {
        await new Promise((r) => setTimeout(r, 500));
        return { text: `xong: ${text}` };
      },
    },
    { port: 0 },
  );
  serversToClose.push(slow);
  const client = new A2aClient({ baseUrl: slow.url, token: TEST_TOKEN });
  // Tạo task đang chạy bằng streamMessage nhưng không đợi (chạy nền).
  const running = client.streamMessage('việc nền');
  // Tìm taskId rồi resubscribe stream song song.
  let taskId = null;
  for (let i = 0; i < 20 && !taskId; i++) {
    const list = await client.listTasks({ limit: 5 });
    const t = list.tasks.find((x) => x.status.state === 'working' || x.status.state === 'submitted');
    if (t) taskId = t.id;
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(taskId);
  const back = await client.resubscribeStream(taskId, { timeoutMs: 10000 });
  assert.equal(back.status.state, 'completed');
  assert.match(back.artifacts?.[0]?.parts?.[0]?.text ?? '', /xong: việc nền/);
  // Stream gốc cũng xong bình thường (resubscribe không hủy task).
  const orig = await running;
  assert.equal(orig.status.state, 'completed');
  assert.equal(orig.id, taskId);
});

test('server API trực tiếp: getTaskTransitions + getEventLog + resubscribe', async () => {
  const server = createA2aServer({
    token: TEST_TOKEN,
    runner: echoRunner(),
    allowUnauthenticated: false,
  });
  const record = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'message:send',
    params: { message: 'hello trực tiếp' },
  });
  const task = record.result;
  assert.equal(task.status.state, 'completed');
  const transitions = server.getTaskTransitions(task.id);
  assert.ok(transitions.length >= 3);
  assert.equal(transitions[transitions.length - 1].to, 'completed');
  const events = server.getEventLog();
  assert.ok(events.some((e) => e.kind === 'task-created' && e.taskId === task.id));
  assert.ok(events.some((e) => e.kind === 'state-changed' && e.state === 'completed'));
  const again = server.resubscribe(task.id);
  assert.equal(again?.id, task.id);
  assert.equal(server.resubscribe('nope'), undefined);
  assert.deepEqual(server.getTaskTransitions('nope'), []);
  // setPushNotificationConfig không notifier → throw rõ.
  assert.throws(
    () => server.setPushNotificationConfig({ taskId: task.id, url: 'http://127.0.0.1:9/h' }),
    /chưa bật pushNotifications/,
  );
});
