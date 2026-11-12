/**
 * Tests for the Dropbox direct OAuth connector (v0.89a, worker F3):
 * userinfo + list_folder, theo mẫu connectors-b.test.mjs (mock fetch).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connector-dropbox.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake ('test-token'). Bao phủ: userinfo parse, list_folder parse +
 * has_more/cursor/continue, chưa kết nối, refresh khi sắp hết hạn,
 * POST 401 -> TokenExpiredError (không retry — Dropbox chỉ có POST),
 * 401 invalid_grant -> TokenRevokedError.
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
  DROPBOX_CONNECTOR,
  dropboxGetCurrentAccount,
  dropboxListFolder,
  dropboxListFolderContinue,
} from '../packages/core/dist/connectors/dropbox.js';

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

test('dropbox: connector đã đăng ký, đúng auth/token URL, scope chỉ đọc', () => {
  assert.equal(DROPBOX_CONNECTOR.id, 'dropbox');
  assert.equal(DROPBOX_CONNECTOR.authUrl, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(DROPBOX_CONNECTOR.tokenUrl, 'https://api.dropboxapi.com/oauth2/token');
  assert.deepEqual(DROPBOX_CONNECTOR.scopes, [
    'account_info.read',
    'files.metadata.read',
    'files.content.read',
  ]);
  assert.equal(getConnector('dropbox')?.id, 'dropbox');
});

test('dropbox: get_current_account parse account_id/name/email', async () => {
  const mocked = mockFetch(() => ({
    body: {
      account_id: 'dbid:123',
      name: { display_name: 'Huy Nguyen' },
      email: 'huy@example.com',
    },
  }));
  const acc = await dropboxGetCurrentAccount(opts(mocked.fetchFn));
  assert.equal(acc.accountId, 'dbid:123');
  assert.equal(acc.displayName, 'Huy Nguyen');
  assert.equal(acc.email, 'huy@example.com');
  assert.equal(mocked.calls.length, 1);
  assert.equal(mocked.calls[0].init.method, 'POST');
  assert.equal(bearer(mocked.calls[0]), 'Bearer test-token');
});

test('dropbox: list_folder parse entries + has_more/cursor, continue lấy trang sau', async () => {
  const mocked = mockFetch(async (url) => {
    if (url.includes('/files/list_folder/continue')) {
      return {
        body: {
          entries: [{ '.tag': 'file', id: 'id:2', name: 'b.txt', path_lower: '/b.txt', size: 10 }],
          has_more: false,
        },
      };
    }
    return {
      body: {
        entries: [
          { '.tag': 'folder', id: 'id:1', name: 'Photos', path_lower: '/photos' },
          { '.tag': 'file', id: 'id:3', name: 'a.jpg', path_lower: '/a.jpg', size: 2048 },
        ],
        has_more: true,
        cursor: 'cursor-1',
      },
    };
  });
  const page1 = await dropboxListFolder(opts(mocked.fetchFn), '', 100);
  assert.equal(page1.entries.length, 2);
  assert.equal(page1.entries[0].tag, 'folder');
  assert.equal(page1.entries[0].name, 'Photos');
  assert.equal(page1.entries[1].size, 2048);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.cursor, 'cursor-1');
  assert.deepEqual(JSON.parse(mocked.calls[0].init.body), { path: '', recursive: false, limit: 100 });
  const page2 = await dropboxListFolderContinue(opts(mocked.fetchFn), 'cursor-1');
  assert.equal(page2.entries.length, 1);
  assert.equal(page2.entries[0].name, 'b.txt');
  assert.equal(page2.hasMore, false);
  assert.deepEqual(JSON.parse(mocked.calls[1].init.body), { cursor: 'cursor-1' });
});

test('dropbox: chưa có token -> lỗi rõ ràng hướng dẫn kết nối', async () => {
  const mocked = mockFetch(() => ({ body: {} }));
  await assert.rejects(
    () => dropboxGetCurrentAccount({ getToken: () => null, fetchFn: mocked.fetchFn }),
    /Chưa kết nối Dropbox/,
  );
  assert.equal(mocked.calls.length, 0);
});

test('dropbox: token còn < 5 phút -> refresh 1 lần trước khi gọi API', async () => {
  const store = memoryStore({
    dropbox: { accessToken: 'tok-old', refreshToken: 'r-old', expiresAt: inSecs(4 * 60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth2/token')) {
      return { body: { access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' } };
    }
    return { body: { account_id: 'dbid:123', name: { display_name: 'Huy' } } };
  });
  const provider = createConnectorTokenProvider(DROPBOX_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const acc = await dropboxGetCurrentAccount({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn });
  assert.equal(acc.accountId, 'dbid:123');
  const tokenCalls = mocked.calls.filter((c) => c.url.includes('/oauth2/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(new URLSearchParams(tokenCalls[0].init.body).get('grant_type'), 'refresh_token');
  const apiCalls = mocked.calls.filter((c) => c.url.includes('/get_current_account'));
  assert.equal(apiCalls.length, 1);
  assert.equal(bearer(apiCalls[0]), 'Bearer tok-new');
});

test('dropbox: POST 401 -> TokenExpiredError, KHÔNG retry (Dropbox chỉ có POST)', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => dropboxGetCurrentAccount(opts(mocked.fetchFn)),
    (err) => err instanceof TokenExpiredError,
  );
  assert.equal(mocked.calls.length, 1);
});

test('dropbox: POST 401 với body invalid_grant -> TokenRevokedError ngay', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: { error: 'invalid_grant' } }));
  await assert.rejects(
    () => dropboxGetCurrentAccount(opts(mocked.fetchFn)),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(mocked.calls.length, 1);
});

test('dropbox: refresh token bị invalid_grant -> TokenRevokedError, store bị xóa', async () => {
  const store = memoryStore({
    dropbox: { accessToken: 'tok-old', refreshToken: 'r-bad', expiresAt: inSecs(60) },
  });
  const mocked = mockFetch(async (url) => {
    if (url.includes('/oauth2/token')) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    return { body: { account_id: 'dbid:123' } };
  });
  const provider = createConnectorTokenProvider(DROPBOX_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  await assert.rejects(
    () => dropboxGetCurrentAccount({ getToken: () => 'tok-old', tokenProvider: provider, fetchFn: mocked.fetchFn }),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(await store.getToken('dropbox'), null);
});
