/**
 * Tests for v0.9c connector OAuth auto-refresh (local, mock fetch only):
 *  - getValidAccessToken: 5-minute refresh threshold, dedup of in-flight
 *    refreshes, refresh-token rotation / retention, invalid_grant handling.
 *  - Connector calls (Slack / Gmail / Teams): proactive refresh before
 *    each call, one GET retry after 401, no retry for POST sends,
 *    invalid_grant -> TokenRevokedError ("kết nối lại"), Slack xoxb
 *    (no expiry, no refresh token) keeps working untouched.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connector-refresh.test.mjs
 *
 * No live network, no real tokens: every fetch is a mock, tokens are
 * fake strings ('xoxb-...', 'ya29-...', 'graph-...').
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REFRESH_BEFORE_MS,
  TokenExpiredError,
  TokenRevokedError,
  createConnectorTokenProvider,
  getValidAccessToken,
  isTokenRevokedError,
} from '../packages/core/dist/connectors/framework.js';
import { SLACK_CONNECTOR, slackListChannels, slackSendMessage } from '../packages/core/dist/connectors/slack.js';
import { GMAIL_CONNECTOR, gmailListMessages, gmailSendMessage } from '../packages/core/dist/connectors/email.js';
import { TEAMS_CONNECTOR, teamsListTeams } from '../packages/core/dist/connectors/teams.js';

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

/** Parse an application/x-www-form-urlencoded POST body. */
function formBody(init) {
  return new URLSearchParams(typeof init.body === 'string' ? init.body : '');
}

/** Token endpoint mock: returns a fresh access token (optionally rotating the refresh token). */
function tokenEndpoint({ accessToken = 'tok-new', refreshToken, delayMs = 0 } = {}) {
  return mockFetch(async (_url, init) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const body = { access_token: accessToken, expires_in: 3600 };
    if (refreshToken) body.refresh_token = refreshToken;
    return { body };
  });
}

const inSecs = (s) => new Date(Date.now() + s * 1000).toISOString();

// --- Threshold + refresh basics -------------------------------------------

test('REFRESH_BEFORE_MS is 5 minutes', () => {
  assert.equal(REFRESH_BEFORE_MS, 5 * 60_000);
});

test('token còn hạn > 5 phút → dùng tiếp, không gọi token endpoint', async () => {
  const store = memoryStore({
    slack: { accessToken: 'xoxb-fresh', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const mocked = tokenEndpoint();
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  assert.equal(await provider.getAccessToken(), 'xoxb-fresh');
  assert.equal(mocked.calls.length, 0);
  assert.equal((await store.getToken('slack')).accessToken, 'xoxb-fresh');
});

test('token còn < 5 phút → refresh 1 lần; refresh token cũ được giữ khi provider không rotate', async () => {
  const store = memoryStore({
    gmail: { accessToken: 'ya29-old', refreshToken: 'r-old', expiresAt: inSecs(4 * 60) },
  });
  const mocked = tokenEndpoint({ accessToken: 'ya29-new' });
  const provider = createConnectorTokenProvider(GMAIL_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  assert.equal(await provider.getAccessToken(), 'ya29-new');
  assert.equal(mocked.calls.length, 1);
  assert.equal(formBody(mocked.calls[0].init).get('grant_type'), 'refresh_token');
  assert.equal(formBody(mocked.calls[0].init).get('refresh_token'), 'r-old');
  const saved = await store.getToken('gmail');
  assert.equal(saved.accessToken, 'ya29-new');
  assert.equal(saved.refreshToken, 'r-old'); // không rotate -> giữ cũ
  assert.ok(Date.parse(saved.expiresAt) > Date.now() + 3500 * 1000);
});

test('provider rotate refresh token → refresh token mới được lưu', async () => {
  const store = memoryStore({
    teams: { accessToken: 'graph-old', refreshToken: 'r-old', expiresAt: inSecs(-10) },
  });
  const mocked = tokenEndpoint({ accessToken: 'graph-new', refreshToken: 'r-new' });
  const provider = createConnectorTokenProvider(TEAMS_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  assert.equal(await provider.getAccessToken(), 'graph-new');
  const saved = await store.getToken('teams');
  assert.equal(saved.refreshToken, 'r-new');
});

test('token hết hạn nhưng không có refreshToken → trả token cũ, không gọi token endpoint', async () => {
  const store = memoryStore({
    gmail: { accessToken: 'ya29-stale', expiresAt: inSecs(-60) },
  });
  const mocked = tokenEndpoint();
  assert.equal(
    await getValidAccessToken(GMAIL_CONNECTOR, store, { clientId: 'cid', fetchFn: mocked.fetchFn }),
    'ya29-stale',
  );
  assert.equal(mocked.calls.length, 0);
});

test('5 lần gọi đồng thời khi hết hạn → chỉ 1 request refresh (dedup)', async () => {
  const store = memoryStore({
    slack: { accessToken: 'xoxb-old', refreshToken: 'r1', expiresAt: inSecs(-5) },
  });
  const mocked = tokenEndpoint({ accessToken: 'xoxb-new', delayMs: 25 });
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  const results = await Promise.all([
    provider.getAccessToken(),
    provider.getAccessToken(),
    provider.getAccessToken(),
    provider.getAccessToken(),
    provider.getAccessToken(),
  ]);
  assert.deepEqual(results, ['xoxb-new', 'xoxb-new', 'xoxb-new', 'xoxb-new', 'xoxb-new']);
  assert.equal(mocked.calls.length, 1);
});

test('refresh lỗi (500) → lỗi lan ra, store giữ nguyên, lần sau thử refresh lại được', async () => {
  const store = memoryStore({
    slack: { accessToken: 'xoxb-old', refreshToken: 'r1', expiresAt: inSecs(-5) },
  });
  let fail = true;
  const mocked = mockFetch(async () => {
    if (fail) return { status: 500, body: { error: 'temporarily_unavailable' } };
    return { body: { access_token: 'xoxb-new', expires_in: 3600 } };
  });
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  await assert.rejects(provider.getAccessToken(), /temporarily_unavailable/);
  assert.equal(mocked.calls.length, 1);
  assert.equal((await store.getToken('slack')).accessToken, 'xoxb-old'); // chưa ghi đè
  fail = false;
  assert.equal(await provider.getAccessToken(), 'xoxb-new'); // map lỗi đã xóa -> thử lại được
  assert.equal(mocked.calls.length, 2);
});

test('invalid_grant ở token endpoint → store bị xóa, lỗi TokenRevokedError báo kết nối lại', async () => {
  const store = memoryStore({
    gmail: { accessToken: 'ya29-old', refreshToken: 'r-revoked', expiresAt: inSecs(-5) },
  });
  const mocked = mockFetch(async () => ({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
  }));
  const provider = createConnectorTokenProvider(GMAIL_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: mocked.fetchFn,
  });
  await assert.rejects(
    provider.getAccessToken(),
    (err) => {
      assert.ok(err instanceof TokenRevokedError, `expected TokenRevokedError, got ${err}`);
      assert.ok(isTokenRevokedError(err));
      assert.match(err.message, /kết nối lại/);
      assert.doesNotMatch(err.message, /ya29-old|r-revoked/);
      return true;
    },
  );
  assert.equal(mocked.calls.length, 1);
  assert.equal(await store.getToken('gmail'), null); // đã xóa, không retry vô hạn
});

// --- Connector calls: GET 401 retry ---------------------------------------

test('Slack GET 401 → force refresh + retry 1 lần thành công, token mới được lưu', async () => {
  // Token trông còn hạn (không refresh chủ động) nhưng API từ chối.
  const store = memoryStore({
    slack: { accessToken: 'xoxb-stale', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const tokenMock = tokenEndpoint({ accessToken: 'xoxb-new' });
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: tokenMock.fetchFn,
  });
  const api = mockFetch((url, init) => {
    if (init.headers.Authorization === 'Bearer xoxb-stale') {
      return { status: 401, body: { ok: false, error: 'invalid_auth' } };
    }
    if (url.includes('/conversations.list')) {
      return { body: { ok: true, channels: [{ id: 'C1', name: 'general' }] } };
    }
    return { status: 404, body: { ok: false, error: 'not_found' } };
  });
  const channels = await slackListChannels({
    getToken: () => 'xoxb-stale',
    tokenProvider: provider,
    fetchFn: api.fetchFn,
  });
  assert.deepEqual(channels.map((c) => c.id), ['C1']);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].init.headers.Authorization, 'Bearer xoxb-new');
  assert.equal(tokenMock.calls.length, 1); // đúng 1 lần force refresh
  assert.equal((await store.getToken('slack')).accessToken, 'xoxb-new');
});

test('Slack GET 401 lần 2 → TokenRevokedError, không retry lần 3', async () => {
  const store = memoryStore({
    slack: { accessToken: 'xoxb-stale', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const tokenMock = tokenEndpoint({ accessToken: 'xoxb-new' });
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: tokenMock.fetchFn,
  });
  const api = mockFetch(() => ({ status: 401, body: { ok: false, error: 'invalid_auth' } }));
  await assert.rejects(
    slackListChannels({ getToken: () => 'xoxb-stale', tokenProvider: provider, fetchFn: api.fetchFn }),
    (err) => {
      assert.ok(err instanceof TokenRevokedError, `expected TokenRevokedError, got ${err}`);
      assert.match(err.message, /kết nối lại/);
      assert.doesNotMatch(err.message, /xoxb-new|xoxb-stale/);
      return true;
    },
  );
  assert.equal(api.calls.length, 2); // gọi đầu + đúng 1 retry
  assert.equal(tokenMock.calls.length, 1);
});

test('Gmail GET 401 với body invalid_grant → TokenRevokedError ngay, không refresh, không retry', async () => {
  const store = memoryStore({
    gmail: { accessToken: 'ya29-stale', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const tokenMock = tokenEndpoint({ accessToken: 'ya29-new' });
  const provider = createConnectorTokenProvider(GMAIL_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: tokenMock.fetchFn,
  });
  const api = mockFetch(() => ({ status: 401, body: { error: 'invalid_grant' } }));
  await assert.rejects(
    gmailListMessages({ getToken: () => 'ya29-stale', tokenProvider: provider, fetchFn: api.fetchFn }),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(api.calls.length, 1);
  assert.equal(tokenMock.calls.length, 0);
  assert.equal((await store.getToken('gmail')).accessToken, 'ya29-stale'); // store không bị đụng
});

test('Teams GET 401 → force refresh + retry 1 lần thành công', async () => {
  const store = memoryStore({
    teams: { accessToken: 'graph-stale', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const tokenMock = tokenEndpoint({ accessToken: 'graph-new' });
  const provider = createConnectorTokenProvider(TEAMS_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: tokenMock.fetchFn,
  });
  const api = mockFetch((url, init) => {
    if (init.headers.Authorization === 'Bearer graph-stale') {
      return { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } } };
    }
    if (url.includes('/me/joinedTeams')) {
      return { body: { value: [{ id: 'team1', displayName: 'Eng' }] } };
    }
    return { status: 404, body: {} };
  });
  const teams = await teamsListTeams({
    getToken: () => 'graph-stale',
    tokenProvider: provider,
    fetchFn: api.fetchFn,
  });
  assert.deepEqual(teams.map((t) => t.id), ['team1']);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].init.headers.Authorization, 'Bearer graph-new');
  assert.equal(tokenMock.calls.length, 1);
});

// --- POST: không retry ------------------------------------------------------

test('Slack POST gửi tin 401 → không retry, TokenExpiredError (tránh gửi trùng)', async () => {
  const store = memoryStore({
    slack: { accessToken: 'xoxb-stale', refreshToken: 'r1', expiresAt: inSecs(3600) },
  });
  const tokenMock = tokenEndpoint({ accessToken: 'xoxb-new' });
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: tokenMock.fetchFn,
  });
  const api = mockFetch(() => ({ status: 401, body: { ok: false, error: 'invalid_auth' } }));
  await assert.rejects(
    slackSendMessage(
      { getToken: () => 'xoxb-stale', tokenProvider: provider, fetchFn: api.fetchFn },
      'C1',
      'hello',
    ),
    (err) => err instanceof TokenExpiredError && /kết nối lại/.test(err.message),
  );
  assert.equal(api.calls.length, 1); // không retry POST
  assert.equal(tokenMock.calls.length, 0); // không force refresh vô ích
});

test('Gmail POST gửi mail 401 với invalid_grant → TokenRevokedError, không retry', async () => {
  const api = mockFetch(() => ({ status: 401, body: { error: 'invalid_grant' } }));
  await assert.rejects(
    gmailSendMessage(
      { getToken: () => 'ya29-stale', fetchFn: api.fetchFn },
      { to: 'a@example.com', subject: 'Hi', body: 'Body' },
    ),
    (err) => err instanceof TokenRevokedError && /kết nối lại/.test(err.message),
  );
  assert.equal(api.calls.length, 1);
});

// --- Không có provider / token trần kiểu cũ --------------------------------

test('không có provider: GET 401 → đọc lại getToken; token giống cũ thì không retry vô ích', async () => {
  const api = mockFetch(() => ({ status: 401, body: { ok: false, error: 'invalid_auth' } }));
  await assert.rejects(
    slackListChannels({ getToken: () => 'xoxb-old', fetchFn: api.fetchFn }),
    (err) => err instanceof TokenExpiredError,
  );
  assert.equal(api.calls.length, 1);
});

test('không có provider: GET 401 → getToken trả token mới thì retry 1 lần thành công', async () => {
  let calls = 0;
  const getToken = () => {
    calls += 1;
    return calls === 1 ? 'xoxb-old' : 'xoxb-new';
  };
  const api = mockFetch((url, init) => {
    if (init.headers.Authorization === 'Bearer xoxb-old') {
      return { status: 401, body: { ok: false, error: 'invalid_auth' } };
    }
    return { body: { ok: true, channels: [{ id: 'C1', name: 'general' }] } };
  });
  const channels = await slackListChannels({ getToken, fetchFn: api.fetchFn });
  assert.deepEqual(channels.map((c) => c.id), ['C1']);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].init.headers.Authorization, 'Bearer xoxb-new');
});

test('Slack xoxb không expiresAt, không refreshToken → dùng tiếp, không refresh, không lỗi', async () => {
  const store = memoryStore({ slack: { accessToken: 'xoxb-plain' } });
  const tokenMock = tokenEndpoint({ accessToken: 'xoxb-should-not-be-used' });
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: tokenMock.fetchFn,
  });
  assert.equal(await provider.getAccessToken(), 'xoxb-plain');
  assert.equal(tokenMock.calls.length, 0);
  const api = mockFetch(() => ({
    body: { ok: true, channels: [{ id: 'C1', name: 'general' }] },
  }));
  const channels = await slackListChannels({
    getToken: () => 'xoxb-plain',
    tokenProvider: provider,
    fetchFn: api.fetchFn,
  });
  assert.deepEqual(channels.map((c) => c.id), ['C1']);
  assert.equal(api.calls[0].init.headers.Authorization, 'Bearer xoxb-plain');
  assert.equal(tokenMock.calls.length, 0);
});

test('dedup qua connector: 3 GET song song khi hết hạn → chỉ 1 refresh', async () => {
  const store = memoryStore({
    slack: { accessToken: 'xoxb-old', refreshToken: 'r1', expiresAt: inSecs(-5) },
  });
  const tokenMock = tokenEndpoint({ accessToken: 'xoxb-new', delayMs: 25 });
  const provider = createConnectorTokenProvider(SLACK_CONNECTOR, store, {
    clientId: 'cid',
    fetchFn: tokenMock.fetchFn,
  });
  const api = mockFetch((url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer xoxb-new');
    return { body: { ok: true, channels: [{ id: 'C1', name: 'general' }] } };
  });
  const opts = { getToken: () => 'xoxb-old', tokenProvider: provider, fetchFn: api.fetchFn };
  const results = await Promise.all([
    slackListChannels(opts),
    slackListChannels(opts),
    slackListChannels(opts),
  ]);
  for (const channels of results) assert.deepEqual(channels.map((c) => c.id), ['C1']);
  assert.equal(tokenMock.calls.length, 1);
  assert.equal(api.calls.length, 3);
});
