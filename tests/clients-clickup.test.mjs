/**
 * Tests for ClickUp direct read client (worker F2, v0.89b, stretch).
 *
 * Wire shape theo ClickUp API v2 (developer.clickup.com/reference):
 * GET /api/v2/list/{list_id}/task, GET /api/v2/task/{task_id}.
 * Auth: header Authorization = token thô (KHÔNG có 'Bearer ').
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-clickup.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clickupGetTask,
  clickupListTasks,
} from '../packages/core/dist/clients/clickup.js';

/** Mock fetch: handler(url, init) -> { status, body }. Captures calls. */
function makeFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init ?? {});
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.body,
    };
  };
  return { calls, fetch: fetchFn };
}

const TOKEN = 'pk-test-token';

test('clickupListTasks: trả tasks, Authorization là token thô (không Bearer)', async () => {
  const mock = makeFetch(() => ({
    body: {
      tasks: [
        { id: 't1', name: 'Fix bug', status: { status: 'in progress' }, url: 'https://app.clickup.com/t/t1', date_created: '1762900000000' },
      ],
    },
  }));
  const tasks = await clickupListTasks({ token: TOKEN, fetch: mock.fetch }, 'list1');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, 'Fix bug');
  assert.equal(tasks[0].status, 'in progress');
  assert.match(mock.calls[0].url, /api\.clickup\.com\/api\/v2\/list\/list1\/task$/);
  assert.equal(mock.calls[0].init.headers.Authorization, TOKEN);
  assert.doesNotMatch(mock.calls[0].init.headers.Authorization, /Bearer/);
});

test('clickupGetTask: đọc task theo id', async () => {
  const mock = makeFetch(() => ({
    body: { id: 't1', name: 'Fix bug', status: { status: 'done' }, description: 'desc', url: 'https://app.clickup.com/t/t1' },
  }));
  const task = await clickupGetTask({ token: TOKEN, fetch: mock.fetch }, 't1');
  assert.equal(task.id, 't1');
  assert.equal(task.status, 'done');
  assert.equal(task.description, 'desc');
  assert.match(mock.calls[0].url, /\/api\/v2\/task\/t1$/);
});

test('clickupListTasks: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => clickupListTasks({ token: TOKEN, fetch: mock.fetch }, 'list1'),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /pk-test-token/);
      return true;
    },
  );
});

test('clickupGetTask: 404 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 404, body: {} }));
  await assert.rejects(() => clickupGetTask({ token: TOKEN, fetch: mock.fetch }, 'nope'), /404/);
});

test('clickupListTasks: listId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { tasks: [] } }));
  await assert.rejects(() => clickupListTasks({ token: TOKEN, fetch: mock.fetch }, ''), /required/);
  assert.equal(mock.calls.length, 0);
});
