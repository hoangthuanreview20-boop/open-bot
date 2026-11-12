/**
 * Tests for the Outlook (Microsoft Graph) direct OAuth connector
 * (v0.89a, worker F3): userinfo + list messages, theo mẫu
 * connectors-b.test.mjs (mock fetch).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connector-outlook.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake ('test-token'). Bao phủ: userinfo parse, list messages parse,
 * chưa kết nối, refresh khi sắp hết hạn, GET 401 retry 1 lần,
 * 401 invalid_grant -> TokenRevokedError, login Microsoft cấp scope
 * cho connector outlook qua OAUTH_PROVIDERS.connectorScopes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectorTokenProvider,
  getConnector,
  TokenRevokedError,
} from '../packages/core/dist/connectors/framework.js';
import {
  OUTLOOK_CONNECTOR,
  outlookGetCurrentUser,
  outlookListMessages,
} from '../packages/core/dist/connectors/outlook.js';
import { OAUTH_PROVIDERS } from '../packages/core/dist/auth/oauth.js';

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

test('outlook: connector đã đăng ký, đúng auth/token URL (chung Microsoft), scope chỉ đọc', () => {
  assert.equal(OUTLOOK_CONNECTOR.id, 'outlook');
  assert.equal(OUTLOOK_CONNECTOR.authUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(OUTLOOK_CONNECTOR.tokenUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.deepEqual(OUTLOOK_CONNECTOR.scopes, [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Files.Read',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ]);
  assert.equal(getConnector('outlook')?.id, 'outlook');
});

test('outlook: login Microsoft cấp scope cho connector outlook (OAUTH_PROVIDERS.connectorScopes)', () => {
  assert.deepEqual(OAUTH_PROVIDERS.microsoft.connectorScopes?.outlook, [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Files.Read',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ]);
});

test('outlook: /me parse id/displayName/mail (fallback userPrincipalName)', async () => {
  const mocked = mockFetch(() => ({
    body: { id: 'u-1', displayName: 'Huy Nguyen', userPrincipalName: 'huy@contoso.onmicrosoft.com' },
  }));
  const user = await outlookGetCurrentUser(opts(mocked.fetchFn));
  assert.equal(user.id, 'u-1');
  assert.equal(user.displayName, 'Huy Nguyen');
  assert.equal(user.email, 'huy@contoso.onmicrosoft.com');
  assert.equal(mocked.calls.length, 1);
  assert.equal(bearer(mocked.calls[0]), 'Bearer test-token');
  assert.ok(mocked.calls[0].url.includes('graph.microsoft.com/v1.0/me'));
});

test('outlook: list messages parse subject/from/ngày/isRead', async () => {
  const mocked = mockFetch(() => ({
    body: {
      value: [
        {
          id: 'm-1',
          subject: 'Báo cáo tuần',
          from: { emailAddress: { name: 'Lan', address: 'lan@example.com' } },
          receivedDateTime: '2026-11-11T08:00:00Z',
          isRead: false,
          bodyPreview: 'Chào Huy, ...',
        },
        { id: 'm-2', subject: '(không tiêu đề)', from: { emailAddress: {} } },
      ],
    },
  }));
  const msgs = await outlookListMessages(opts(mocked.fetchFn), 10);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].subject, 'Báo cáo tuần');
  assert.equal(msgs[0].from, 'Lan');
  assert.equal(msgs[0].fromEmail, 'lan@example.com');
  assert.equal(msgs[0].isRead, false);
  assert.equal(msgs[1].subject, '(không tiêu đề)');
  assert.equal(msgs.length, 2);
  assert.ok(mocked.calls[0].url.includes('/me/mailFolders/inbox/messages'));
  assert.ok(mocked.calls[0].url.includes('%24top=10'));
});

test('outlook: chưa có token -> lỗi rõ ràng hướng dẫn kết nối', async () => {
  const mocked = mockFetch(() => ({ body: {} }));
  await assert.rejects(
    () => outlookGetCurrentUser({ getToken: () => null, fetchFn: mocked.fetchFn }),
    /Chưa kết nối Outlook/,
  );
  assert.equal(mocked.calls.length, 0);
});

test('outlook: token còn < 5 phút -> refresh 1 lần trước khi gọi API', async () => {
  const store = memoryStore({
    outlook: { accessToken: 'tok-old', refreshToken: 'r-old', expiresAt: inSecs(4 * 60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return { body: { access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' } };
    }
    return { body: { id: 'u-1', displayName: 'Huy' } };
  });
  const provider = createConnectorTokenProvider(OUTLOOK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const user = await outlookGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn });
  assert.equal(user.id, 'u-1');
  const tokenCalls = mocked.calls.filter((c) => c.url.includes('/oauth2/v2.0/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(new URLSearchParams(tokenCalls[0].init.body).get('grant_type'), 'refresh_token');
  const apiCalls = mocked.calls.filter((c) => c.url.includes('/v1.0/me'));
  assert.equal(apiCalls.length, 1);
  assert.equal(bearer(apiCalls[0]), 'Bearer tok-new');
});

test('outlook: GET 401 -> force refresh + retry 1 lần thành công', async () => {
  const store = memoryStore({
    outlook: { accessToken: 'tok-old', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const mocked = mockFetch(async (url, init) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return { body: { access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' } };
    }
    const auth = init.headers.Authorization;
    if (auth === 'Bearer tok-old') return { status: 401, body: {} };
    return { body: { id: 'u-1', displayName: 'Huy' } };
  });
  const provider = createConnectorTokenProvider(OUTLOOK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const user = await outlookGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn });
  assert.equal(user.id, 'u-1');
  const apiCalls = mocked.calls.filter((c) => c.url.includes('/v1.0/me'));
  assert.equal(apiCalls.length, 2);
  assert.equal(bearer(apiCalls[1]), 'Bearer tok-new');
});

test('outlook: GET 401 với body invalid_grant -> TokenRevokedError ngay, không retry', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: { error: 'invalid_grant' } }));
  await assert.rejects(
    () => outlookGetCurrentUser(opts(mocked.fetchFn)),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(mocked.calls.length, 1);
});

test('outlook: refresh token bị invalid_grant -> TokenRevokedError, store bị xóa', async () => {
  const store = memoryStore({
    outlook: { accessToken: 'tok-old', refreshToken: 'r-bad', expiresAt: inSecs(60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    return { body: { id: 'u-1' } };
  });
  const provider = createConnectorTokenProvider(OUTLOOK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  await assert.rejects(
    () => outlookGetCurrentUser({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn }),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(await store.getToken('outlook'), null);
});
