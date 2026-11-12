/**
 * Tests for Trello direct read client (worker F2, v0.89b).
 *
 * Wire shape theo Trello REST API (developer.atlassian.com/cloud/trello):
 * GET /1/members/me/boards, GET /1/boards/{id}/lists,
 * GET /1/lists/{id}/cards, GET /1/boards/{id}/cards. Auth key+token qua query.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-trello.test.mjs
 *
 * No live network, no real key/token: API đều mock fetch, key/token là
 * chuỗi fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  trelloListBoardCards,
  trelloListBoards,
  trelloListCards,
  trelloListLists,
} from '../packages/core/dist/clients/trello.js';

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

const OPTS = { key: 'test-key', token: 'test-token' };

function optsWithFetch(mock) {
  return { key: OPTS.key, token: OPTS.token, fetch: mock.fetch };
}

test('trelloListBoards: trả boards, auth key+token trong query', async () => {
  const mock = makeFetch(() => ({
    body: [{ id: 'b1', name: 'Board 1', url: 'https://trello.com/b/b1', closed: false }],
  }));
  const boards = await trelloListBoards(optsWithFetch(mock));
  assert.equal(boards.length, 1);
  assert.equal(boards[0].name, 'Board 1');
  assert.equal(boards[0].closed, false);
  assert.match(mock.calls[0].url, /\/1\/members\/me\/boards/);
  assert.match(mock.calls[0].url, /key=test-key/);
  assert.match(mock.calls[0].url, /token=test-token/);
});

test('trelloListLists: liệt kê lists của board', async () => {
  const mock = makeFetch(() => ({
    body: [
      { id: 'l1', name: 'Todo', closed: false },
      { id: 'l2', name: 'Done', closed: false },
    ],
  }));
  const lists = await trelloListLists(optsWithFetch(mock), 'b1');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].name, 'Todo');
  assert.match(mock.calls[0].url, /\/1\/boards\/b1\/lists/);
});

test('trelloListCards: liệt kê cards của list', async () => {
  const mock = makeFetch(() => ({
    body: [{ id: 'c1', name: 'Task', shortLink: 'abc', url: 'https://trello.com/c/abc', closed: false }],
  }));
  const cards = await trelloListCards(optsWithFetch(mock), 'l1');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].shortLink, 'abc');
  assert.match(mock.calls[0].url, /\/1\/lists\/l1\/cards/);
});

test('trelloListBoardCards: liệt kê cards của board', async () => {
  const mock = makeFetch(() => ({ body: [{ id: 'c2', name: 'Other', closed: true }] }));
  const cards = await trelloListBoardCards(optsWithFetch(mock), 'b1');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].closed, true);
  assert.match(mock.calls[0].url, /\/1\/boards\/b1\/cards/);
});

test('trelloListBoards: 401 → lỗi rõ, không lộ key/token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: 'invalid key' }));
  await assert.rejects(
    () => trelloListBoards(optsWithFetch(mock)),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /test-token/);
      assert.doesNotMatch(err.message, /test-key/);
      return true;
    },
  );
});

test('trelloListLists: 404 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 404, body: 'not found' }));
  await assert.rejects(() => trelloListLists(optsWithFetch(mock), 'nope'), /404/);
});

test('trelloListLists: boardId rỗng → lỗi input, không gọi fetch', async () => {
  const mock = makeFetch(() => ({ body: [] }));
  await assert.rejects(() => trelloListLists(optsWithFetch(mock), ''), /required/);
  assert.equal(mock.calls.length, 0);
});

test('trelloListBoards: thiếu key → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: [] }));
  await assert.rejects(() => trelloListBoards({ key: '', token: 't', fetch: mock.fetch }), /key/);
  assert.equal(mock.calls.length, 0);
});
