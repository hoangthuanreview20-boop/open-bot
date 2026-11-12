/**
 * Tests cho v0.85 (P2-8) — nối ElicitationUrlTracker.waitForCompletion
 * vào đường xử lý elicitation của dispatcher MCP.
 *
 * Trước v0.85, khi MCP server yêu cầu elicitation qua URL, client mở
 * URL rồi trả `accept` ngay mà không theo dõi user làm gì tiếp ở trình
 * duyệt: `waitForCompletion()` đã viết xong (elicitation.ts) nhưng
 * không có caller nào gọi — chỉ có `complete()` được dispatcher gọi
 * khi notification tới.
 *
 * Nối dây v0.85: `createElicitationHandler` nhận `urlTracker` (do
 * `registerDefaultMcpClientHandlers` tạo + truyền vào) — URL-mode +
 * accept + có elicitationId thì chờ `waitForCompletion` tới khi server
 * gửi `notifications/elicitation/complete` rồi mới trả kết quả; hết
 * timeout (mặc định 10 phút, cùng cửa sổ với timeout hỏi user của
 * coordinator) thì ném `ElicitationError` rõ ràng, dispatcher chuyển
 * thành lỗi MCP `-32603` thay vì treo.
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-elicitation-url-wait-v085.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ELICITATION_URL_COMPLETION_TIMEOUT_MS,
  ElicitationError,
  ElicitationUrlTracker,
  createElicitationHandler,
} from '../packages/core/dist/mcp/elicitation.js';
import { McpDispatcher, JSON_RPC_INTERNAL_ERROR } from '../packages/core/dist/mcp/dispatcher.js';
import { registerDefaultMcpClientHandlers } from '../packages/core/dist/mcp/clientHandlers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const URL_PARAMS = {
  message: 'Mở URL để đăng nhập rồi quay lại.',
  mode: 'url',
  url: 'https://example.com/auth',
  elicitationId: 'e-1',
};

const FORM_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

test('P2-8: handler chờ notification complete rồi mới trả accept (không trả ngay)', async () => {
  const tracker = new ElicitationUrlTracker();
  const handler = createElicitationHandler(async () => ({ action: 'accept' }), {
    urlTracker: tracker,
    urlCompletionTimeoutMs: 5000,
  });
  let settled = false;
  const pending = handler(URL_PARAMS, 'travel-server').then((r) => {
    settled = true;
    return r;
  });
  await sleep(50);
  assert.equal(settled, false, 'chưa có notification thì chưa được trả kết quả');
  assert.equal(tracker.pendingCount, 1);
  assert.equal(tracker.complete('e-khac'), false, 'complete id lạ không giải phóng lượt chờ');
  assert.equal(settled, false);
  assert.equal(tracker.complete('e-1'), true);
  const result = await pending;
  assert.deepEqual(result, { action: 'accept' });
  assert.equal(tracker.pendingCount, 0);
});

test('P2-8: handler timeout khi không có notification — lỗi rõ, không treo', async () => {
  const tracker = new ElicitationUrlTracker();
  const handler = createElicitationHandler(async () => ({ action: 'accept' }), {
    urlTracker: tracker,
    urlCompletionTimeoutMs: 30,
  });
  await assert.rejects(
    handler(URL_PARAMS, 'travel-server'),
    (e) => e instanceof ElicitationError && /hết thời gian chờ hoàn tất/.test(e.message),
  );
  assert.equal(tracker.pendingCount, 0, 'timeout dọn lượt chờ');
});

test('P2-8: form-mode accept + decline/cancel URL-mode trả ngay, không chờ', async () => {
  const tracker = new ElicitationUrlTracker();
  // Form-mode: có tracker cũng không chờ (không có notification complete).
  const formHandler = createElicitationHandler(
    async () => ({ action: 'accept', content: { city: 'Hanoi' } }),
    { urlTracker: tracker, urlCompletionTimeoutMs: 5000 },
  );
  const formResult = await formHandler(
    { message: 'Where?', requestedSchema: FORM_SCHEMA },
    'travel-server',
  );
  assert.equal(formResult.action, 'accept');
  assert.equal(formResult.content.city, 'Hanoi');
  assert.equal(tracker.pendingCount, 0);

  // URL-mode nhưng user decline: không chờ.
  const declineHandler = createElicitationHandler(async () => ({ action: 'decline' }), {
    urlTracker: tracker,
    urlCompletionTimeoutMs: 5000,
  });
  const declined = await declineHandler(URL_PARAMS, 'travel-server');
  assert.deepEqual(declined, { action: 'decline' });
  assert.equal(tracker.pendingCount, 0);
});

test('P2-8: không có tracker / không có elicitationId thì trả ngay như cũ', async () => {
  // Tương thích ngược: caller cũ không truyền tracker.
  const noTracker = createElicitationHandler(async () => ({ action: 'accept' }));
  const res = await noTracker(URL_PARAMS, 'travel-server');
  assert.deepEqual(res, { action: 'accept' });

  // URL-mode nhưng server không gửi elicitationId: không có gì để chờ.
  const tracker = new ElicitationUrlTracker();
  const noId = createElicitationHandler(async () => ({ action: 'accept' }), {
    urlTracker: tracker,
    urlCompletionTimeoutMs: 5000,
  });
  const { elicitationId: _ignored, ...noIdParams } = URL_PARAMS;
  const resNoId = await noId(noIdParams, 'travel-server');
  assert.deepEqual(resNoId, { action: 'accept' });
  assert.equal(tracker.pendingCount, 0);
});

test('P2-8: dispatcher — tool call chờ notification complete rồi mới trả kết quả', async () => {
  const dispatcher = new McpDispatcher();
  const fakeClient = { getDispatcher: () => dispatcher };
  const seen = [];
  registerDefaultMcpClientHandlers(fakeClient, {
    serverName: 'travel-server',
    elicitationPrompt: async (request) => {
      seen.push(request.mode);
      return { action: 'accept' };
    },
    urlCompletionTimeoutMs: 5000,
  });

  let settled = false;
  const pending = dispatcher
    .dispatch({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'elicitation/create',
      params: { ...URL_PARAMS, elicitationId: 'e-9' },
    })
    .then((r) => {
      settled = true;
      return r;
    });
  await sleep(50);
  assert.equal(settled, false, 'tool call chưa được trả khi chưa có notification');
  assert.deepEqual(seen, ['url']);
  // Server báo hoàn tất ngoài băng.
  const notified = await dispatcher.dispatch({
    jsonrpc: '2.0',
    method: 'notifications/elicitation/complete',
    params: { elicitationId: 'e-9' },
  });
  assert.equal(notified, null, 'notification không có response');
  const response = await pending;
  assert.equal(response.id, 'req-1');
  assert.deepEqual(response.result, { action: 'accept' });
  assert.equal(response.error, undefined);
});

test('P2-8: dispatcher — timeout chờ complete trả lỗi -32603 rõ ràng', async () => {
  const dispatcher = new McpDispatcher();
  const fakeClient = { getDispatcher: () => dispatcher };
  registerDefaultMcpClientHandlers(fakeClient, {
    serverName: 'travel-server',
    elicitationPrompt: async () => ({ action: 'accept' }),
    urlCompletionTimeoutMs: 30,
  });
  const response = await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 'req-2',
    method: 'elicitation/create',
    params: URL_PARAMS,
  });
  assert.equal(response.id, 'req-2');
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, JSON_RPC_INTERNAL_ERROR);
  assert.match(response.error.message, /hết thời gian chờ hoàn tất/);
});

test('P2-8: timeout mặc định chờ complete là 10 phút như timeout hỏi user', () => {
  assert.equal(DEFAULT_ELICITATION_URL_COMPLETION_TIMEOUT_MS, 10 * 60 * 1000);
});
