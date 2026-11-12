/**
 * Tests for the Trello direct connector (v0.89a, worker F3): API key +
 * user token nhập tay (KHÔNG phải OAuth 1.0a), theo mẫu
 * connectors-b.test.mjs (mock fetch).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connector-trello.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, key/token là
 * chuỗi fake ('key-test' / 'token-test'). Bao phủ: authorize URL
 * (scope read, hạn 30 ngày), userinfo parse, boards/lists parse,
 * chưa có key/token, 401 -> báo tạo token mới (chỉ 1 call, không
 * retry vô ích).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getConnector } from '../packages/core/dist/connectors/framework.js';
import {
  TRELLO_CONNECTOR,
  buildTrelloAuthorizeUrl,
  trelloGetCurrentUser,
  trelloListBoards,
  trelloListLists,
} from '../packages/core/dist/connectors/trello.js';

/** Mock fetch: handler(url, init) -> { status, body }. Captures calls. */
function mockFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init ?? {});
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.body,
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
      headers: { get: () => null },
    };
  };
  return { calls, fetchFn };
}

const opts = (fetchFn) => ({
  getApiKey: () => 'key-test',
  getToken: () => 'token-test',
  fetchFn,
});

test('trello: connector đã đăng ký, authType apiKey (KHÔNG phải oauth2)', () => {
  assert.equal(TRELLO_CONNECTOR.id, 'trello');
  assert.equal(TRELLO_CONNECTOR.authType, 'apiKey');
  assert.equal(TRELLO_CONNECTOR.authUrl, undefined);
  assert.equal(TRELLO_CONNECTOR.tokenUrl, undefined);
  assert.deepEqual(TRELLO_CONNECTOR.scopes, []);
  assert.equal(getConnector('trello')?.id, 'trello');
});

test('trello: authorize URL đúng tham số (scope read, hạn 30 ngày, response_type token)', () => {
  const url = buildTrelloAuthorizeUrl('key-test');
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://trello.com/1/authorize');
  assert.equal(u.searchParams.get('key'), 'key-test');
  assert.equal(u.searchParams.get('scope'), 'read');
  assert.equal(u.searchParams.get('expiration'), '30days');
  assert.equal(u.searchParams.get('response_type'), 'token');
  assert.equal(u.searchParams.get('name'), 'open-bot');
  assert.throws(() => buildTrelloAuthorizeUrl(''), /API key is required/);
});

test('trello: members/me parse id/username/fullName', async () => {
  const mocked = mockFetch(() => ({
    body: { id: 'm-1', username: 'huy', fullName: 'Huy Nguyen' },
  }));
  const member = await trelloGetCurrentUser(opts(mocked.fetchFn));
  assert.equal(member.id, 'm-1');
  assert.equal(member.username, 'huy');
  assert.equal(member.fullName, 'Huy Nguyen');
  assert.equal(mocked.calls.length, 1);
  const u = new URL(mocked.calls[0].url);
  assert.equal(u.searchParams.get('key'), 'key-test');
  assert.equal(u.searchParams.get('token'), 'token-test');
});

test('trello: list boards parse id/name/url', async () => {
  const mocked = mockFetch(() => ({
    body: [
      { id: 'b-1', name: 'Roadmap', url: 'https://trello.com/b/b1/roadmap', shortUrl: 'https://trello.com/b/b1', closed: false },
      { id: 'b-2', name: 'Cá nhân', closed: false },
    ],
  }));
  const boards = await trelloListBoards(opts(mocked.fetchFn));
  assert.equal(boards.length, 2);
  assert.equal(boards[0].name, 'Roadmap');
  assert.equal(boards[0].shortUrl, 'https://trello.com/b/b1');
  assert.equal(boards[1].name, 'Cá nhân');
  assert.ok(mocked.calls[0].url.includes('/members/me/boards'));
  assert.ok(mocked.calls[0].url.includes('filter=open'));
});

test('trello: list lists parse id/name/closed', async () => {
  const mocked = mockFetch(() => ({
    body: [
      { id: 'l-1', name: 'Todo', closed: false },
      { id: 'l-2', name: 'Doing', closed: false },
      { id: 'l-3', name: 'Done', closed: true },
    ],
  }));
  const lists = await trelloListLists(opts(mocked.fetchFn), 'b-1');
  assert.equal(lists.length, 3);
  assert.equal(lists[0].name, 'Todo');
  assert.equal(lists[2].closed, true);
  assert.ok(mocked.calls[0].url.includes('/boards/b-1/lists'));
  await assert.rejects(() => trelloListLists(opts(mocked.fetchFn), ''), /boardId is required/);
});

test('trello: chưa có API key/token -> lỗi rõ ràng hướng dẫn kết nối', async () => {
  const mocked = mockFetch(() => ({ body: {} }));
  await assert.rejects(
    () => trelloGetCurrentUser({ getApiKey: () => null, getToken: () => 'token-test', fetchFn: mocked.fetchFn }),
    /Chưa kết nối Trello/,
  );
  await assert.rejects(
    () => trelloGetCurrentUser({ getApiKey: () => 'key-test', getToken: () => null, fetchFn: mocked.fetchFn }),
    /Chưa kết nối Trello/,
  );
  assert.equal(mocked.calls.length, 0);
});

test('trello: 401 -> báo token hết hạn/tạo token mới, chỉ 1 call (không retry vô ích)', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: 'invalid token' }));
  await assert.rejects(
    () => trelloGetCurrentUser(opts(mocked.fetchFn)),
    /không còn hợp lệ.*tạo token mới/s,
  );
  assert.equal(mocked.calls.length, 1);
});

test('trello: 403/404/429 có thông báo riêng', async () => {
  const mocked403 = mockFetch(() => ({ status: 403, body: {} }));
  await assert.rejects(() => trelloGetCurrentUser(opts(mocked403.fetchFn)), /không đủ quyền/);
  const mocked404 = mockFetch(() => ({ status: 404, body: {} }));
  await assert.rejects(() => trelloListLists(opts(mocked404.fetchFn), 'b-x'), /không tìm thấy/);
  const mocked429 = mockFetch(() => ({ status: 429, body: {} }));
  await assert.rejects(() => trelloGetCurrentUser(opts(mocked429.fetchFn)), /rate limit/);
});
