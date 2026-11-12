/**
 * Tests for the Zoom direct OAuth connector (v0.89a, worker F3):
 * userinfo + list meetings, theo mẫu connectors-b.test.mjs (mock fetch).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connector-zoom.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake ('test-token'). Bao phủ: userinfo parse, list meetings parse,
 * chưa kết nối, refresh khi sắp hết hạn, GET 401 retry 1 lần,
 * 401 invalid_grant -> TokenRevokedError.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectorTokenProvider,
  getConnector,
  TokenRevokedError,
} from '../packages/core/dist/connectors/framework.js';
import {
  ZOOM_CONNECTOR,
  zoomGetCurrentUser,
  zoomListMeetings,
} from '../packages/core/dist/connectors/zoom.js';

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

test('zoom: connector đã đăng ký, đúng auth/token URL, scope chỉ đọc', () => {
  assert.equal(ZOOM_CONNECTOR.id, 'zoom');
  assert.equal(ZOOM_CONNECTOR.authUrl, 'https://zoom.us/oauth/authorize');
  assert.equal(ZOOM_CONNECTOR.tokenUrl, 'https://zoom.us/oauth/token');
  assert.deepEqual(ZOOM_CONNECTOR.scopes, ['user:read', 'meeting:read']);
  assert.equal(getConnector('zoom')?.id, 'zoom');
});

test('zoom: users/me parse id/name/email/type', async () => {
  const mocked = mockFetch(() => ({
    body: { id: 'z-1', first_name: 'Huy', last_name: 'Nguyen', email: 'huy@example.com', type: 2 },
  }));
  const user = await zoomGetCurrentUser(opts(mocked.fetchFn));
  assert.equal(user.id, 'z-1');
  assert.equal(user.firstName, 'Huy');
  assert.equal(user.lastName, 'Nguyen');
  assert.equal(user.email, 'huy@example.com');
  assert.equal(user.type, 2);
  assert.equal(mocked.calls.length, 1);
  assert.equal(bearer(mocked.calls[0]), 'Bearer test-token');
  assert.ok(mocked.calls[0].url.includes('api.zoom.us/v2/users/me'));
});

test('zoom: list meetings parse topic/start_time/duration/join_url', async () => {
  const mocked = mockFetch(() => ({
    body: {
      meetings: [
        {
          id: 123456789,
          uuid: 'uuid-1',
          topic: 'Họp tuần',
          start_time: '2026-11-12T09:00:00Z',
          duration: 60,
          join_url: 'https://zoom.us/j/123456789',
          status: 'waiting',
        },
        { id: 987654321, topic: '1:1', start_time: '2026-11-13T10:00:00Z', duration: 30 },
      ],
    },
  }));
  const meetings = await zoomListMeetings(opts(mocked.fetchFn), 10);
  assert.equal(meetings.length, 2);
  assert.equal(meetings[0].topic, 'Họp tuần');
  assert.equal(meetings[0].startTime, '2026-11-12T09:00:00Z');
  assert.equal(meetings[0].duration, 60);
  assert.equal(meetings[0].joinUrl, 'https://zoom.us/j/123456789');
  assert.equal(meetings[1].id, 987654321);
  assert.ok(mocked.calls[0].url.includes('/users/me/meetings'));
  assert.ok(mocked.calls[0].url.includes('type=scheduled'));
  assert.ok(mocked.calls[0].url.includes('page_size=10'));
});

test('zoom: chưa có token -> lỗi rõ ràng hướng dẫn kết nối', async () => {
  const mocked = mockFetch(() => ({ body: {} }));
  await assert.rejects(
    () => zoomGetCurrentUser({ getToken: () => null, fetchFn: mocked.fetchFn }),
    /Chưa kết nối Zoom/,
  );
  assert.equal(mocked.calls.length, 0);
});

test('zoom: token còn < 5 phút -> refresh 1 lần trước khi gọi API', async () => {
  const store = memoryStore({
    zoom: { accessToken: 'tok-old', refreshToken: 'r-old', expiresAt: inSecs(4 * 60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth/token')) {
      return { body: { access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' } };
    }
    return { body: { id: 'z-1', first_name: 'Huy' } };
  });
  const provider = createConnectorTokenProvider(ZOOM_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const user = await zoomGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn });
  assert.equal(user.id, 'z-1');
  const tokenCalls = mocked.calls.filter((c) => c.url.includes('/oauth/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(new URLSearchParams(tokenCalls[0].init.body).get('grant_type'), 'refresh_token');
  const apiCalls = mocked.calls.filter((c) => c.url.includes('/users/me'));
  assert.equal(apiCalls.length, 1);
  assert.equal(bearer(apiCalls[0]), 'Bearer tok-new');
});

test('zoom: GET 401 -> force refresh + retry 1 lần thành công', async () => {
  const store = memoryStore({
    zoom: { accessToken: 'tok-old', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const mocked = mockFetch(async (url, init) => {
    if (url.includes('/oauth/token')) {
      return { body: { access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' } };
    }
    const auth = init.headers.Authorization;
    if (auth === 'Bearer tok-old') return { status: 401, body: {} };
    return { body: { id: 'z-1', first_name: 'Huy' } };
  });
  const provider = createConnectorTokenProvider(ZOOM_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const user = await zoomGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn });
  assert.equal(user.id, 'z-1');
  const apiCalls = mocked.calls.filter((c) => c.url.includes('/users/me'));
  assert.equal(apiCalls.length, 2);
  assert.equal(bearer(apiCalls[1]), 'Bearer tok-new');
});

test('zoom: GET 401 với body invalid_grant -> TokenRevokedError ngay, không retry', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: { error: 'invalid_grant' } }));
  await assert.rejects(
    () => zoomGetCurrentUser(opts(mocked.fetchFn)),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(mocked.calls.length, 1);
});

test('zoom: refresh token bị invalid_grant -> TokenRevokedError, store bị xóa', async () => {
  const store = memoryStore({
    zoom: { accessToken: 'tok-old', refreshToken: 'r-bad', expiresAt: inSecs(60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth/token')) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    return { body: { id: 'z-1' } };
  });
  const provider = createConnectorTokenProvider(ZOOM_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  await assert.rejects(
    () => zoomGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn }),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(await store.getToken('zoom'), null);
});
