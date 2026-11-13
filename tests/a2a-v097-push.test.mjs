/**
 * Test v0.97 (Đội T2): push notifications A2A —
 * `tasks/pushNotificationConfig` + gửi POST khi task tới trạng thái cuối.
 *
 * Chỉ test local: webhook giả chạy trên loopback (node:http), không
 * mạng ngoài, không dịch vụ thật.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-v097-push.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  A2aPushNotifier,
  A2A_PUSH_MAX_ATTEMPTS,
  buildPushPayload,
  deliverPushNotification,
  validatePushConfig,
} from '../packages/core/dist/a2a/push.js';

const webhookServers = [];
after(async () => {
  for (const s of webhookServers.splice(0)) {
    await new Promise((done) => s.close(() => done()));
  }
});

/** Webhook giả trên loopback: ghi lại mọi request, trả status theo kịch bản. */
function makeWebhook(statuses) {
  const received = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      received.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization ?? null,
        body: body ? JSON.parse(body) : null,
      });
      const status = statuses[Math.min(calls - 1, statuses.length - 1)];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: status < 300 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      webhookServers.push(server);
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/hook`,
        received,
        get calls() {
          return calls;
        },
      });
    });
  });
}

function fakeTask(state) {
  return {
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state, timestamp: new Date().toISOString() },
    artifacts: [],
  };
}

test('validatePushConfig: đủ field, URL http(s); sai → lý do rõ', () => {
  const ok = validatePushConfig({ taskId: 't1', url: 'http://127.0.0.1:9/hook' });
  assert.equal(ok.ok, true);
  assert.equal(validatePushConfig({}).ok, false);
  assert.equal(validatePushConfig({ taskId: '', url: 'http://127.0.0.1/' }).ok, false);
  assert.equal(validatePushConfig({ taskId: 't1', url: 'not a url' }).ok, false);
  assert.equal(validatePushConfig({ taskId: 't1', url: 'ftp://127.0.0.1/' }).ok, false);
  assert.equal(validatePushConfig({ taskId: 't1', url: 'http://127.0.0.1/', token: 5 }).ok, false);
  assert.equal(validatePushConfig(null).ok, false);
});

test('buildPushPayload: { taskId, state, task }', () => {
  const task = fakeTask('completed');
  const payload = buildPushPayload(task);
  assert.equal(payload.taskId, 'task-1');
  assert.equal(payload.state, 'completed');
  assert.equal(payload.task, task);
});

test('deliverPushNotification: POST đúng payload + Bearer <redacted> gửi kèm', async () => {
  const hook = await makeWebhook([200]);
  const result = await deliverPushNotification(
    { taskId: 'task-1', url: hook.url, token: 'secret-1' },
    fakeTask('completed'),
    { sleep: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 200);
  assert.equal(hook.calls, 1);
  assert.equal(hook.received[0].method, 'POST');
  assert.equal(hook.received[0].auth, 'Bearer secret-1');
  assert.equal(hook.received[0].body.taskId, 'task-1');
  assert.equal(hook.received[0].body.state, 'completed');
});

test('deliverPushNotification: webhook 500 rồi 200 → retry 1 lần rồi OK', async () => {
  const hook = await makeWebhook([500, 200]);
  const result = await deliverPushNotification(
    { taskId: 'task-1', url: hook.url },
    fakeTask('failed'),
    { sleep: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(hook.calls, 2);
});

test('deliverPushNotification: hết lượt vẫn lỗi → ok=false, đủ số lần thử', async () => {
  const hook = await makeWebhook([500]);
  const result = await deliverPushNotification(
    { taskId: 'task-1', url: hook.url },
    fakeTask('failed'),
    { sleep: async () => {} },
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts, A2A_PUSH_MAX_ATTEMPTS);
  assert.equal(result.status, 500);
  assert.match(result.error ?? '', /HTTP 500/);
  assert.equal(hook.calls, A2A_PUSH_MAX_ATTEMPTS);
});

test('A2aPushNotifier: chỉ gửi khi task tới trạng thái cuối, config tự xoá sau khi gửi', async () => {
  const hook = await makeWebhook([200]);
  const notifier = new A2aPushNotifier();
  notifier.setConfig({ taskId: 'task-1', url: hook.url });
  // Task chưa xong → no-op, không gửi, config còn.
  const pending = await notifier.notifyIfTerminal(fakeTask('working'));
  assert.equal(pending.notified, false);
  assert.equal(hook.calls, 0);
  assert.ok(notifier.getConfig('task-1'));
  // Task xong → gửi 1 lần, config tự xoá (gọi lại cũng không gửi nữa).
  const done = await notifier.notifyIfTerminal(fakeTask('completed'));
  assert.equal(done.notified, true);
  assert.equal(done.result?.ok, true);
  assert.equal(hook.calls, 1);
  assert.equal(notifier.getConfig('task-1'), undefined);
  const again = await notifier.notifyIfTerminal(fakeTask('completed'));
  assert.equal(again.notified, false);
  assert.equal(hook.calls, 1);
  // Lịch sử gửi gần nhất đọc được.
  assert.equal(notifier.getLastResult('task-1')?.ok, true);
});

test('A2aPushNotifier: task không có config → no-op, không throw', async () => {
  const notifier = new A2aPushNotifier();
  const r = await notifier.notifyIfTerminal(fakeTask('completed'));
  assert.equal(r.notified, false);
});

test('createFilePushConfigStore: lưu/nạp lại, file 0600, entry hỏng bị bỏ', async () => {
  const { createFilePushConfigStore } = await import('../packages/core/dist/a2a/push.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-push-'));
  const file = path.join(dir, 'push.json');
  const store = createFilePushConfigStore(file);
  assert.deepEqual(store.load(), []);
  store.save([{ taskId: 't1', url: 'http://127.0.0.1:9/hook', token: 's3cret' }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const loaded = createFilePushConfigStore(file).load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].taskId, 't1');
  assert.equal(loaded[0].token, 's3cret');
  // Ghi tay file hỏng: JSON sai → [], entry sai → chỉ giữ entry tốt.
  fs.writeFileSync(file, 'not json', 'utf-8');
  assert.deepEqual(createFilePushConfigStore(file).load(), []);
  fs.writeFileSync(
    file,
    JSON.stringify([{ taskId: 'ok', url: 'http://127.0.0.1:9/h' }, { taskId: '', url: 'x' }]),
    'utf-8',
  );
  const kept = createFilePushConfigStore(file).load();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].taskId, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A2aPushNotifier với file store: config sống qua restart notifier', async () => {
  const { createFilePushConfigStore } = await import('../packages/core/dist/a2a/push.js');
  const hook = await makeWebhook([200]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-push-'));
  const file = path.join(dir, 'push.json');
  const first = new A2aPushNotifier({ store: createFilePushConfigStore(file) });
  first.setConfig({ taskId: 'task-9', url: hook.url });
  const second = new A2aPushNotifier({ store: createFilePushConfigStore(file) });
  assert.equal(second.getConfig('task-9')?.url, hook.url);
  const done = await second.notifyIfTerminal(fakeTask('completed'));
  // fakeTask id mặc định là task-1, không phải task-9 → không gửi.
  assert.equal(done.notified, false);
  const done9 = await second.notifyIfTerminal({ ...fakeTask('completed'), id: 'task-9' });
  assert.equal(done9.notified, true);
  assert.equal(hook.calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A2aPushNotifier: URL ngoài loopback bị chặn khi policy mặc định', () => {
  const notifier = new A2aPushNotifier({
    networkPolicy: { allowExternal: false, warningAcknowledged: false },
  });
  assert.throws(
    () => notifier.setConfig({ taskId: 't1', url: 'http://192.168.1.5:9/hook' }),
    /loopback|Settings/,
  );
  // URL ngoài được khi policy đủ hai cờ.
  const open = new A2aPushNotifier({
    networkPolicy: { allowExternal: true, warningAcknowledged: true },
  });
  open.setConfig({ taskId: 't1', url: 'http://192.168.1.5:9/hook' });
  assert.equal(open.getConfig('t1')?.url, 'http://192.168.1.5:9/hook');
  assert.equal(open.listConfigs().length, 1);
  assert.equal(open.removeConfig('t1'), true);
  assert.equal(open.removeConfig('t1'), false);
});
