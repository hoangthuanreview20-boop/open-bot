/**
 * Tests for monday.com direct read client (worker F2, v0.89b, stretch).
 *
 * Wire shape theo monday GraphQL API
 * (developer.monday.com/api-reference/reference/boards, items-page;
 * API-Version 2024-01): POST /v2 { query } → { data: { boards } }.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-monday.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mondayListBoardItems,
  mondayListBoards,
} from '../packages/core/dist/clients/monday.js';

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

const TOKEN = 'monday-test-token';

test('mondayListBoards: trả boards, header API-Version 2024-01', async () => {
  const mock = makeFetch(() => ({
    body: { data: { boards: [{ id: '111', name: 'Roadmap', state: 'active' }] } },
  }));
  const boards = await mondayListBoards({ token: TOKEN, fetch: mock.fetch }, 10);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].id, '111');
  assert.equal(boards[0].name, 'Roadmap');
  assert.match(mock.calls[0].url, /api\.monday\.com\/v2$/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(mock.calls[0].init.headers['API-Version'], '2024-01');
  assert.match(JSON.parse(mock.calls[0].init.body).query, /boards/);
});

test('mondayListBoardItems: trả items qua items_page', async () => {
  const mock = makeFetch(() => ({
    body: {
      data: { boards: [{ items_page: { items: [{ id: '222', name: 'Task A' }, { id: '223', name: 'Task B' }] } }] },
    },
  }));
  const items = await mondayListBoardItems({ token: TOKEN, fetch: mock.fetch }, '111');
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Task A');
  assert.match(JSON.parse(mock.calls[0].init.body).query, /boards \(ids: \[111\]\)/);
});

test('mondayListBoards: errors GraphQL → lỗi mang message', async () => {
  const mock = makeFetch(() => ({
    body: { errors: [{ message: 'Invalid token' }] },
  }));
  await assert.rejects(
    () => mondayListBoards({ token: TOKEN, fetch: mock.fetch }),
    (err) => {
      assert.match(err.message, /Invalid token/);
      assert.doesNotMatch(err.message, /monday-test-token/);
      return true;
    },
  );
});

test('mondayListBoards: 401 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(() => mondayListBoards({ token: TOKEN, fetch: mock.fetch }), /401/);
});

test('mondayListBoardItems: boardId không phải số → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { data: { boards: [] } } }));
  await assert.rejects(
    () => mondayListBoardItems({ token: TOKEN, fetch: mock.fetch }, 'abc'),
    /boardId is invalid/,
  );
  assert.equal(mock.calls.length, 0);
});

test('mondayListBoardItems: boardId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { data: { boards: [] } } }));
  await assert.rejects(
    () => mondayListBoardItems({ token: TOKEN, fetch: mock.fetch }, ''),
    /required/,
  );
  assert.equal(mock.calls.length, 0);
});
