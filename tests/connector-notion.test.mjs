/**
 * Tests for the Notion direct OAuth connector (v0.89a, worker F3):
 * userinfo + search, theo mẫu connectors-b.test.mjs (mock fetch).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connector-notion.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake ('test-token'). Bao phủ: userinfo parse, search parse, chưa
 * kết nối, refresh khi sắp hết hạn, GET 401 retry 1 lần, POST 401
 * không retry, 401 invalid_grant -> TokenRevokedError.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectorTokenProvider,
  getConnector,
  TokenExpiredError,
  TokenRevokedError,
} from '../packages/core/dist/connectors/framework.js';
import {
  NOTION_CONNECTOR,
  notionGetCurrentUser,
  notionSearch,
} from '../packages/core/dist/connectors/notion.js';
import { buildAuthorizationUrl } from '../packages/core/dist/connectors/framework.js';

/** In-memory TokenStore (same shape as vaultTokenStore). */
function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getToken(id) {
      const t = map.get(id);
      return t ? { ...t } : null;
    },
    async setToken(id, token) {
      map.set(id, { ...token });
    },
    async clearToken(id) {
      map.delete(id);
    },
  };
}

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

const inSecs = (s) => new Date(Date.now() + s * 1000).toISOString();
const TOKEN = 'test-token';
const opts = (fetchFn) => ({ getToken: () => TOKEN, fetchFn });

function bearer(call) {
  return call.init.headers.Authorization;
}

test('notion: connector đã đăng ký, đúng auth/token URL, không có scope', () => {
  assert.equal(NOTION_CONNECTOR.id, 'notion');
  assert.equal(NOTION_CONNECTOR.authUrl, 'https://api.notion.com/v1/oauth/authorize');
  assert.equal(NOTION_CONNECTOR.tokenUrl, 'https://api.notion.com/v1/oauth/token');
  assert.deepEqual(NOTION_CONNECTOR.scopes, []);
  assert.equal(getConnector('notion')?.id, 'notion');
});

test('notion: buildAuthUrl có owner=user và KHÔNG gắn PKCE (Notion từ chối code_challenge)', () => {
  const url = buildAuthorizationUrl(NOTION_CONNECTOR, {
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:9/cb',
    state: 's1',
    codeChallenge: 'abc123',
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get('owner'), 'user');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge'), null);
});

test('notion: users/me parse id/name/email (person)', async () => {
  const mocked = mockFetch(() => ({
    body: {
      object: 'user',
      id: 'u-1',
      name: 'Huy',
      type: 'person',
      person: { email: 'huy@example.com' },
      avatar_url: 'https://example.com/a.png',
    },
  }));
  const user = await notionGetCurrentUser(opts(mocked.fetchFn));
  assert.equal(user.id, 'u-1');
  assert.equal(user.name, 'Huy');
  assert.equal(user.type, 'person');
  assert.equal(user.email, 'huy@example.com');
  assert.equal(mocked.calls.length, 1);
  assert.equal(bearer(mocked.calls[0]), 'Bearer test-token');
  assert.equal(mocked.calls[0].init.headers['Notion-Version'], '2022-06-28');
});

test('notion: search parse page/database + title', async () => {
  const mocked = mockFetch(() => ({
    body: {
      results: [
        {
          object: 'page',
          id: 'p-1',
          url: 'https://notion.so/p1',
          last_edited_time: '2026-11-11T00:00:00.000Z',
          properties: { title: { title: [{ plain_text: 'Ghi chú' }] } },
        },
        {
          object: 'database',
          id: 'd-1',
          properties: { title: { title: [{ plain_text: 'Tasks' }, { plain_text: ' 2026' }] } },
        },
      ],
    },
  }));
  const results = await notionSearch(opts(mocked.fetchFn), 'ghi', 10);
  assert.equal(results.length, 2);
  assert.equal(results[0].object, 'page');
  assert.equal(results[0].title, 'Ghi chú');
  assert.equal(results[1].title, 'Tasks 2026');
  assert.equal(mocked.calls.length, 1);
  assert.equal(mocked.calls[0].init.method, 'POST');
  assert.equal(JSON.parse(mocked.calls[0].init.body).page_size, 10);
});

test('notion: chưa có token -> lỗi rõ ràng hướng dẫn kết nối', async () => {
  const mocked = mockFetch(() => ({ body: {} }));
  await assert.rejects(
    () => notionGetCurrentUser({ getToken: () => null, fetchFn: mocked.fetchFn }),
    /Chưa kết nối Notion/,
  );
  assert.equal(mocked.calls.length, 0);
});

test('notion: token còn < 5 phút -> refresh 1 lần trước khi gọi API', async () => {
  const store = memoryStore({
    notion: { accessToken: 'tok-old', refreshToken: 'r-old', expiresAt: inSecs(4 * 60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth/token')) {
      return { body: { access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' } };
    }
    return { body: { object: 'user', id: 'u-1', name: 'Huy', type: 'person' } };
  });
  const provider = createConnectorTokenProvider(NOTION_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const user = await notionGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn });
  assert.equal(user.id, 'u-1');
  const tokenCalls = mocked.calls.filter((c) => c.url.includes('/oauth/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(new URLSearchParams(tokenCalls[0].init.body).get('grant_type'), 'refresh_token');
  const apiCalls = mocked.calls.filter((c) => c.url.includes('/users/me'));
  assert.equal(apiCalls.length, 1);
  assert.equal(bearer(apiCalls[0]), 'Bearer tok-new');
});

test('notion: GET 401 -> force refresh + retry 1 lần thành công', async () => {
  const store = memoryStore({
    notion: { accessToken: 'tok-old', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const mocked = mockFetch(async (url, init) => {
    if (url.includes('/oauth/token')) {
      return { body: { access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' } };
    }
    const auth = init.headers.Authorization;
    if (auth === 'Bearer tok-old') return { status: 401, body: {} };
    return { body: { object: 'user', id: 'u-1', name: 'Huy', type: 'person' } };
  });
  const provider = createConnectorTokenProvider(NOTION_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const user = await notionGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn });
  assert.equal(user.id, 'u-1');
  const apiCalls = mocked.calls.filter((c) => c.url.includes('/users/me'));
  assert.equal(apiCalls.length, 2);
  assert.equal(bearer(apiCalls[1]), 'Bearer tok-new');
});

test('notion: GET 401 với body invalid_grant -> TokenRevokedError ngay, không retry', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: { error: 'invalid_grant' } }));
  await assert.rejects(
    () => notionGetCurrentUser(opts(mocked.fetchFn)),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(mocked.calls.length, 1);
});

test('notion: search (POST) 401 -> TokenExpiredError, KHÔNG retry', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => notionSearch(opts(mocked.fetchFn), 'x'),
    (err) => err instanceof TokenExpiredError,
  );
  assert.equal(mocked.calls.length, 1);
});

test('notion: refresh token bị invalid_grant -> TokenRevokedError, store bị xóa', async () => {
  const store = memoryStore({
    notion: { accessToken: 'tok-old', refreshToken: 'r-bad', expiresAt: inSecs(60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth/token')) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    return { body: { object: 'user', id: 'u-1' } };
  });
  const provider = createConnectorTokenProvider(NOTION_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  await assert.rejects(
    () => notionGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn }),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(await store.getToken('notion'), null);
});
