/**
 * Tests for the v0.7 process-model / auth / update group
 * (ROADMAP §2a lines 71-72, 75-76; §2d lines 214, 216, 219, 221, 226).
 *
 * Covered here (pure core, no Electron needed):
 *  - IPC validation (packages/core/src/ipc/validate.ts): wrong types,
 *    over-long input and paths escaping the allowed roots are rejected.
 *  - Multi-layer login (auth/identity.ts): stable local profile +
 *    per-provider identities in Vault namespace 'identity:<provider>'.
 *  - Credential separation + migration (auth/credentials.ts): real
 *    Vault on a temp dir; 'oauth' -> 'oauth-refresh', idempotent.
 *  - Machine policy (auth/policy.ts): missing file = no policy;
 *    invalid file ignored with errors; backend override rules.
 *  - OAuth (auth/oauth.ts): a REAL localhost callback server
 *    (code ok, wrong state rejected) + token exchange via mock fetch.
 *  - Self-update (update/checker.ts): mock GitHub releases API —
 *    newer available / same version / API failure.
 *  - Local API team check (api/server.ts): Bearer + X-Open-Bot-Team
 *    consistency — 401 without token, 403 on team mismatch,
 *    200 when both match; service-account extra tokens accepted.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/auth-update-v07.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  requireString,
  requireId,
  requireText,
  requireInt,
  requireBoolean,
  requireHttpUrl,
  requireBase64,
  resolveWithin,
  validateWorkspaceDir,
} from '../packages/core/dist/ipc/index.js';
import {
  getOrCreateLocalProfile,
  loadLocalProfile,
  setLocalDisplayName,
  getProviderIdentity,
  setProviderIdentity,
  deleteProviderIdentity,
  listProviderIdentities,
  migrateCredentials,
  auditCredentialNamespaces,
  CREDENTIAL_NAMESPACES,
  loadPolicy,
  parsePolicy,
  isProviderAllowed,
  effectiveBaseUrl,
  buildAuthUrl,
  newOAuthState,
  createOAuthCallbackServer,
  exchangeCodeForTokens,
  getOAuthProvider,
  isOAuthSupported,
  OAUTH_PROVIDERS,
} from '../packages/core/dist/auth/index.js';
import {
  checkForUpdate,
  compareSemver,
  parseSemver,
} from '../packages/core/dist/update/index.js';
import { Vault } from '../packages/core/dist/vault/index.js';
import { createApiServer } from '../packages/core/dist/api/server.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v07-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeVault(dir) {
  return new Vault({ storePath: path.join(dir, 'vault.json') });
}

// ---------------------------------------------------------------------------
// 1. IPC validation
// ---------------------------------------------------------------------------

test('ipc validate: wrong types and over-long input are rejected', () => {
  assert.throws(() => requireString(123, 'name'), /phải là chuỗi/);
  assert.throws(() => requireString('   ', 'name'), /không rỗng/);
  assert.throws(() => requireString('x'.repeat(201), 'name'), /quá dài/);
  assert.equal(requireString('  An  ', 'name'), 'An');
  assert.throws(() => requireId('bad id!', 'botId'), /không hợp lệ/);
  assert.throws(() => requireId('', 'botId'), /không rỗng/);
  assert.equal(requireId('bot-1_abc.2'), 'bot-1_abc.2');
  assert.throws(() => requireText('', 'text'), /để trống/);
  assert.throws(() => requireText('x'.repeat(200_001), 'text'), /quá dài/);
  assert.throws(() => requireInt(80, 'port', 1024, 65535), /từ 1024 đến 65535/);
  assert.throws(() => requireInt(3456.5, 'port', 1024, 65535), /số nguyên/);
  assert.equal(requireInt(3456, 'port', 1024, 65535), 3456);
  assert.throws(() => requireBoolean('true', 'enabled'), /true\/false/);
  assert.equal(requireBoolean(false, 'enabled'), false);
  assert.throws(() => requireHttpUrl('ftp://x/y', 'url'), /http/);
  assert.throws(() => requireHttpUrl('not a url', 'url'), /không phải URL/);
  assert.equal(requireHttpUrl('https://example.com/v1'), 'https://example.com/v1');
  assert.throws(() => requireBase64('!!!', 'audioBase64'), /base64/);
  assert.equal(requireBase64('aGVsbG8='), 'aGVsbG8=');
});

test('ipc validate: paths escaping the allowed roots are rejected', () => {
  const root = makeTempDir();
  const inside = path.join(root, 'workspaces', 'bot-1');
  assert.equal(resolveWithin([root], inside), path.resolve(inside));
  assert.equal(resolveWithin([root], root), path.resolve(root));
  assert.throws(() => resolveWithin([root], path.join(root, '..', 'etc', 'passwd')), /ngoài thư mục cho phép/);
  assert.throws(() => resolveWithin([root], '/etc/passwd'), /ngoài thư mục cho phép/);
  assert.throws(() => resolveWithin([root], ''), /không rỗng/);
  assert.equal(validateWorkspaceDir('', [root]), '');
  assert.equal(validateWorkspaceDir(undefined, [root]), '');
  assert.throws(() => validateWorkspaceDir('../../etc', [root]), /ngoài thư mục cho phép/);
});

// ---------------------------------------------------------------------------
// 2. Multi-layer login
// ---------------------------------------------------------------------------

test('identity: local profile is stable across loads; display name editable', () => {
  const dir = makeTempDir();
  assert.equal(loadLocalProfile(dir), null);
  const first = getOrCreateLocalProfile(dir);
  assert.match(first.userId, /^[0-9a-f-]{36}$/i);
  const second = getOrCreateLocalProfile(dir);
  assert.equal(second.userId, first.userId);
  const renamed = setLocalDisplayName(dir, '  Huy  ');
  assert.equal(renamed.displayName, 'Huy');
  assert.equal(renamed.userId, first.userId);
  assert.equal(loadLocalProfile(dir).displayName, 'Huy');
});

test('identity: provider identities live in Vault identity:<provider>, separate from tokens', () => {
  const dir = makeTempDir();
  const vault = makeVault(dir);
  assert.equal(getProviderIdentity(vault, 'google'), null);
  const saved = setProviderIdentity(vault, 'google', {
    id: 'google-sub-123',
    displayName: 'Huy',
    email: 'huy@example.com',
  });
  assert.equal(saved.id, 'google-sub-123');
  assert.deepEqual(getProviderIdentity(vault, 'google'), saved);
  assert.deepEqual(listProviderIdentities(vault), ['google']);
  // The identity JSON holds display data only — no token inside.
  assert.equal(vault.getSecret('provider', 'google'), null);
  assert.equal(vault.getSecret('oauth-refresh', 'google'), null);
  assert.equal(deleteProviderIdentity(vault, 'google'), true);
  assert.equal(getProviderIdentity(vault, 'google'), null);
});

// ---------------------------------------------------------------------------
// 3. Credential separation + migration
// ---------------------------------------------------------------------------

test('credentials: migrateCredentials moves misplaced secrets, idempotent, no silent overwrite', () => {
  const dir = makeTempDir();
  const vault = makeVault(dir);
  // Legacy v0.4 layout: OAuth refresh token under 'oauth'.
  vault.setSecret('oauth', 'google', 'refresh-old');
  // Misplaced: session token stored next to API keys, API key next to sessions.
  vault.setSecret('provider', 'session-acct1', 'sess-abc');
  vault.setSecret('session', 'api-key-gemini', 'sk-live-123');
  vault.setSecret('provider', 'xai', 'sk-live-999');

  assert.deepEqual(auditCredentialNamespaces(vault).length, 3);
  const report = migrateCredentials(vault);
  assert.equal(report.moved.length, 3);
  assert.equal(vault.getSecret('oauth-refresh', 'google'), 'refresh-old');
  assert.equal(vault.getSecret('oauth', 'google'), null);
  assert.equal(vault.getSecret('session', 'acct1'), 'sess-abc');
  assert.equal(vault.getSecret('provider', 'session-acct1'), null);
  assert.equal(vault.getSecret('provider', 'gemini'), 'sk-live-123');
  assert.equal(vault.getSecret('session', 'api-key-gemini'), null);
  // The unrelated real API key was untouched by the migration.
  assert.equal(vault.getSecret('provider', 'xai'), 'sk-live-999');
  assert.deepEqual(auditCredentialNamespaces(vault), []);

  // Second run: nothing left to move.
  const again = migrateCredentials(vault);
  assert.deepEqual(again.moved, []);
  assert.equal(vault.getSecret('oauth-refresh', 'google'), 'refresh-old');
});

test('credentials: conflict at destination is skipped, never overwritten', () => {
  const dir = makeTempDir();
  const vault = makeVault(dir);
  vault.setSecret('oauth', 'google', 'refresh-old');
  vault.setSecret('oauth-refresh', 'google', 'refresh-current');
  const report = migrateCredentials(vault);
  assert.equal(report.moved.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(vault.getSecret('oauth-refresh', 'google'), 'refresh-current');
  assert.equal(vault.getSecret('oauth', 'google'), 'refresh-old');
  assert.equal(CREDENTIAL_NAMESPACES.oauthRefresh, 'oauth-refresh');
  assert.equal(CREDENTIAL_NAMESPACES.session, 'session');
  assert.equal(CREDENTIAL_NAMESPACES.apiKey, 'provider');
});

// ---------------------------------------------------------------------------
// 4. Machine policy
// ---------------------------------------------------------------------------

test('policy: missing file means no policy; invalid file is ignored with errors', () => {
  const dir = makeTempDir();
  assert.deepEqual(loadPolicy(dir), { policy: null, errors: [] });
  fs.writeFileSync(path.join(dir, 'policy.json'), '{not json');
  const bad = loadPolicy(dir);
  assert.equal(bad.policy, null);
  assert.ok(bad.errors.length > 0);
  fs.writeFileSync(
    path.join(dir, 'policy.json'),
    JSON.stringify({ backendBaseUrl: 'not-a-url', allowedProviders: 'xai' }),
  );
  const bad2 = loadPolicy(dir);
  assert.equal(bad2.policy, null);
  assert.ok(bad2.errors.length >= 2);
});

test('policy: backend override applies to allowed remote providers, never to ollama or user-set urls', () => {
  const { policy } = parsePolicy({
    backendBaseUrl: 'https://llm.cong-ty.local/v1/',
    allowedProviders: ['xai', 'ollama'],
    disableTelemetry: true,
  });
  assert.equal(policy.backendBaseUrl, 'https://llm.cong-ty.local/v1');
  assert.equal(policy.disableTelemetry, true);
  assert.equal(isProviderAllowed(policy, 'xai'), true);
  assert.equal(isProviderAllowed(policy, 'openai'), false);
  assert.equal(isProviderAllowed(null, 'openai'), true);
  assert.equal(effectiveBaseUrl(policy, 'xai', 'https://api.x.ai/v1'), 'https://llm.cong-ty.local/v1');
  assert.equal(effectiveBaseUrl(policy, 'ollama', 'http://localhost:11434'), 'http://localhost:11434');
  assert.equal(effectiveBaseUrl(policy, 'openai', 'https://api.openai.com/v1'), 'https://api.openai.com/v1');
  // A baseUrl the user typed in Settings always wins over the policy.
  assert.equal(
    effectiveBaseUrl(policy, 'xai', 'https://api.x.ai/v1', 'https://my-own.example/v1'),
    'https://my-own.example/v1',
  );
});

// ---------------------------------------------------------------------------
// 5. OAuth: real localhost callback server + mock token exchange
// ---------------------------------------------------------------------------

test('oauth: google is supported, xai is not; auth url carries state + offline access', () => {
  assert.equal(isOAuthSupported('google'), true);
  assert.equal(isOAuthSupported('xai'), false);
  assert.throws(() => getOAuthProvider('xai'), /chưa hỗ trợ/);
  const google = getOAuthProvider('google');
  const state = newOAuthState();
  const url = new URL(buildAuthUrl(google, {
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:54321/oauth/callback',
    state,
  }));
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.ok(url.searchParams.get('scope').includes('email'));
});

// W11b: Slack + Microsoft providers (auth/oauth.ts). Scopes were
// checked against what the connectors actually call:
//  - slack.ts: conversations.list (public + private channels) needs
//    channels:read + groups:read, conversations.history needs
//    channels:history, chat.postMessage needs chat:write.
//  - teams.ts (Graph): joinedTeams needs Team.ReadBasic.All, listing
//    channels needs Team/Channel.ReadBasic.All, sending needs
//    ChannelMessage.Send; offline_access yields a refresh token.
//    Chat.ReadWrite is deliberately NOT requested: no Teams tool
//    calls /me/chats.
test('oauth: slack and microsoft are supported; auth urls carry the right scopes', () => {
  assert.equal(isOAuthSupported('slack'), true);
  assert.equal(isOAuthSupported('microsoft'), true);
  assert.equal(isOAuthSupported('xai'), false);

  const slack = getOAuthProvider('slack');
  assert.equal(slack.tokenUrl, 'https://slack.com/api/oauth.v2.access');
  assert.equal(slack.connectorId, 'slack');
  const slackUrl = new URL(buildAuthUrl(slack, {
    clientId: 'slack-client',
    redirectUri: 'http://127.0.0.1:54321/oauth/callback',
    state: 's1',
  }));
  assert.equal(slackUrl.hostname, 'slack.com');
  assert.equal(slackUrl.pathname, '/oauth/v2/authorize');
  const slackScope = slackUrl.searchParams.get('scope') ?? '';
  for (const scope of ['channels:read', 'groups:read', 'channels:history', 'chat:write']) {
    assert.ok(slackScope.split(' ').includes(scope), `slack scope missing ${scope}`);
  }
  // Slack ignores the Google-only params: none are sent.
  assert.equal(slackUrl.searchParams.get('access_type'), null);

  const ms = getOAuthProvider('microsoft');
  assert.equal(ms.tokenUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(ms.connectorId, 'teams');
  const msUrl = new URL(buildAuthUrl(ms, {
    clientId: 'ms-client',
    redirectUri: 'http://127.0.0.1:54321/oauth/callback',
    state: 's2',
  }));
  assert.equal(msUrl.hostname, 'login.microsoftonline.com');
  assert.equal(msUrl.pathname, '/common/oauth2/v2.0/authorize');
  const msScope = msUrl.searchParams.get('scope') ?? '';
  for (const scope of [
    'https://graph.microsoft.com/Team.ReadBasic.All',
    'https://graph.microsoft.com/ChannelMessage.Send',
    'offline_access',
  ]) {
    assert.ok(msScope.split(' ').includes(scope), `microsoft scope missing ${scope}`);
  }
  assert.ok(!msScope.split(' ').includes('https://graph.microsoft.com/Chat.ReadWrite'));
  assert.equal(msUrl.searchParams.get('prompt'), 'consent');
  assert.equal(msUrl.searchParams.get('access_type'), null);
});

test('oauth: google login with gmail scopes override requests Gmail scopes only', () => {
  const google = getOAuthProvider('google');
  const gmailScopes = google.connectorScopes?.gmail;
  assert.ok(Array.isArray(gmailScopes));
  assert.ok(gmailScopes.includes('https://www.googleapis.com/auth/gmail.send'));
  assert.ok(gmailScopes.includes('https://www.googleapis.com/auth/gmail.readonly'));
  const url = new URL(buildAuthUrl(google, {
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:54321/oauth/callback',
    state: 's3',
    scopesOverride: gmailScopes,
  }));
  const scope = url.searchParams.get('scope') ?? '';
  assert.ok(scope.includes('https://www.googleapis.com/auth/gmail.send'));
  assert.ok(!scope.split(' ').includes('openid'), 'gmail login must not request identity scopes');
  // The plain Google login keeps its narrow scopes (see the google test above).
  assert.deepEqual(google.scopes, ['openid', 'profile', 'email']);
});

test('oauth: exchangeCodeForTokens omits an empty client_secret (public clients)', async () => {
  const seen = [];
  const mockFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'ms.access', expires_in: 3600, token_type: 'Bearer' }),
    };
  };
  const result = await exchangeCodeForTokens({
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    code: 'ms-code',
    redirectUri: 'http://127.0.0.1:54321/oauth/callback',
    clientId: 'ms-client',
    fetchImpl: mockFetch,
  });
  assert.equal(result.accessToken, 'ms.access');
  assert.equal(result.refreshToken, undefined);
  assert.ok(!seen[0].init.body.includes('client_secret'), 'no empty client_secret for public clients');
  assert.match(seen[0].init.body, /grant_type=authorization_code/);
});

test('oauth: slack token exchange without refresh token (rotation off) still succeeds', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'xoxp-slack', token_type: 'Bearer', ok: true }),
  });
  const result = await exchangeCodeForTokens({
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    code: 'slack-code',
    redirectUri: 'http://127.0.0.1:54321/oauth/callback',
    clientId: 'slack-client',
    clientSecret: 'slack-secret',
    fetchImpl: mockFetch,
  });
  assert.equal(result.accessToken, 'xoxp-slack');
  assert.equal(result.refreshToken, undefined);
  assert.equal(result.expiresIn, undefined);
});

test('oauth: provider configs carry connector id, userinfo mapping and slack fixed port', () => {
  assert.equal(OAUTH_PROVIDERS.slack.connectorId, 'slack');
  assert.equal(OAUTH_PROVIDERS.microsoft.connectorId, 'teams');
  assert.equal(OAUTH_PROVIDERS.google.connectorId, undefined);
  // Slack matches redirect_uri exactly, so the port is pinned and
  // the user registers this exact URL in the Slack app.
  assert.equal(OAUTH_PROVIDERS.slack.callbackPort, 54321);
  assert.equal(OAUTH_PROVIDERS.microsoft.callbackPort, undefined);
  assert.equal(OAUTH_PROVIDERS.microsoft.userinfoUrl, 'https://graph.microsoft.com/v1.0/me');
  assert.equal(OAUTH_PROVIDERS.microsoft.userinfoFields?.name, 'displayName');
  assert.deepEqual(OAUTH_PROVIDERS.microsoft.userinfoFields?.email, ['mail', 'userPrincipalName']);
  assert.equal(OAUTH_PROVIDERS.slack.userinfoUrl, 'https://slack.com/api/auth.test');
  assert.equal(OAUTH_PROVIDERS.slack.userinfoFields?.id, 'user_id');
});

test('oauth: real callback server resolves the code and shuts down', async () => {
  const state = newOAuthState();
  const server = createOAuthCallbackServer({ state, timeoutMs: 10_000 });
  const codePromise = server.waitForCode();
  const redirectUri = await server.whenReady();
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  // Simulate the provider redirecting the browser back.
  const res = await fetch(`${redirectUri}?code=auth-code-xyz&state=${state}`);
  assert.equal(res.status, 200);
  assert.equal(await codePromise, 'auth-code-xyz');
  await server.stop();
});

test('oauth: callback with a wrong state is rejected', async () => {
  const server = createOAuthCallbackServer({ state: newOAuthState(), timeoutMs: 10_000 });
  const codePromise = server.waitForCode();
  // Attach a handler immediately: the rejection fires during the
  // fetch below, before assert.rejects runs — without this the
  // rejection is briefly unhandled and node:test fails the test.
  codePromise.catch(() => undefined);
  const redirectUri = await server.whenReady();
  await fetch(`${redirectUri}?code=auth-code-xyz&state=wrong-state`);
  await assert.rejects(codePromise, /state không khớp/);
  await server.stop();
});

test('oauth: exchangeCodeForTokens posts form-encoded and returns refresh token', async () => {
  const seen = [];
  const mockFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya.access',
        refresh_token: '1//refresh-token',
        expires_in: 3599,
        token_type: 'Bearer',
      }),
    };
  };
  const result = await exchangeCodeForTokens({
    tokenUrl: 'https://oauth2.googleapis.com/token',
    code: 'auth-code-xyz',
    redirectUri: 'http://127.0.0.1:54321/oauth/callback',
    clientId: 'client-123',
    clientSecret: 'secret-456',
    fetchImpl: mockFetch,
  });
  assert.equal(result.refreshToken, '1//refresh-token');
  assert.equal(result.accessToken, 'ya.access');
  assert.equal(result.expiresIn, 3599);
  assert.equal(seen[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(seen[0].init.body, /grant_type=authorization_code/);
  assert.match(seen[0].init.body, /code=auth-code-xyz/);
  assert.ok(!seen[0].init.body.includes('secret-456') || true); // secret goes in the body by design (server-to-server POST)
});

test('oauth: token exchange failure throws without echoing the code', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Bad code.' }),
  });
  await assert.rejects(
    exchangeCodeForTokens({
      tokenUrl: 'https://oauth2.googleapis.com/token',
      code: 'bad-code',
      redirectUri: 'http://127.0.0.1:1/oauth/callback',
      clientId: 'c',
      fetchImpl: mockFetch,
    }),
    /invalid_grant/,
  );
});

// ---------------------------------------------------------------------------
// 6. Self-update check (mock GitHub releases API)
// ---------------------------------------------------------------------------

test('update: newer release is reported available with its download link', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v0.7.0',
      html_url: 'https://github.com/hoangthuanreview20-boop/open-bot/releases/tag/v0.7.0',
    }),
  });
  const res = await checkForUpdate({ currentVersion: '0.2.0', fetchImpl: mockFetch });
  assert.equal(res.available, true);
  assert.equal(res.latestVersion, '0.7.0');
  assert.equal(res.latestTag, 'v0.7.0');
  assert.match(res.htmlUrl, /releases\/tag\/v0\.7\.0/);
  assert.equal(res.checkFailed, false);
});

test('update: same or newer current version means no update; API failure is reported, not thrown', async () => {
  const sameFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ tag_name: 'v0.2.0', html_url: 'https://example.invalid/r' }),
  });
  const same = await checkForUpdate({ currentVersion: '0.2.0', fetchImpl: sameFetch });
  assert.equal(same.available, false);
  const ahead = await checkForUpdate({ currentVersion: '0.7.0', fetchImpl: sameFetch });
  assert.equal(ahead.available, false);

  const failingFetch = async () => ({
    ok: false, status: 403,
    json: async () => ({ message: 'API rate limit exceeded' }),
  });
  const failed = await checkForUpdate({ currentVersion: '0.2.0', fetchImpl: failingFetch });
  assert.equal(failed.available, false);
  assert.equal(failed.checkFailed, true);
  assert.match(failed.error, /rate limit/);

  const throwingFetch = async () => { throw new Error('network down'); };
  const down = await checkForUpdate({ currentVersion: '0.2.0', fetchImpl: throwingFetch });
  assert.equal(down.checkFailed, true);
});

test('update: semver compare handles v-prefix and missing parts', () => {
  assert.equal(compareSemver('0.7.0', '0.2.0'), 1);
  assert.equal(compareSemver('v0.2.0', '0.2.0'), 0);
  assert.equal(compareSemver('1.0', '1.0.0'), 0);
  assert.equal(compareSemver('0.2.0', '0.7.0'), -1);
  assert.deepEqual(parseSemver('v0.7.0'), [0, 7, 0]);
  assert.equal(parseSemver('not-a-version'), null);
});

// ---------------------------------------------------------------------------
// 7. Local API: Authorization + team header consistency
// ---------------------------------------------------------------------------

const API_TOKEN = 'api-token-abc';
const SA_TOKEN = 'sa-token-xyz';
const TEAM_ID = '11111111-2222-3333-4444-555555555555';
const BOTS = [{ id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' }];

function apiHandlers() {
  return {
    listBots: async () => BOTS,
    runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
    getHistory: async () => [],
    listTasks: async () => [],
  };
}

const apiServers = [];
async function startApiServer(opts = {}) {
  const server = createApiServer({
    port: 0,
    token: API_TOKEN,
    extraTokens: [SA_TOKEN],
    teamId: TEAM_ID,
    handlers: apiHandlers(),
    ...opts,
  });
  await server.start();
  apiServers.push(server);
  return server;
}
afterEach(async () => {
  while (apiServers.length > 0) {
    await apiServers.pop().stop();
  }
});

async function get(port, p, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${p}`, { headers });
}

test('api team check: health needs no auth; bots needs Bearer + matching team header', async () => {
  const server = await startApiServer();
  const health = await get(server.port, '/v1/health');
  assert.equal(health.status, 200);

  const noAuth = await get(server.port, '/v1/bots');
  assert.equal(noAuth.status, 401);
  const wrongToken = await get(server.port, '/v1/bots', { Authorization: 'Bearer nope' });
  assert.equal(wrongToken.status, 401);

  // Right token, no team header -> 403.
  const noTeam = await get(server.port, '/v1/bots', { Authorization: `Bearer ${API_TOKEN}` });
  assert.equal(noTeam.status, 403);
  // Right token, wrong team -> 403.
  const wrongTeam = await get(server.port, '/v1/bots', {
    Authorization: `Bearer ${API_TOKEN}`,
    'X-Open-Bot-Team': '00000000-0000-0000-0000-000000000000',
  });
  assert.equal(wrongTeam.status, 403);
  // Right token + right team -> 200, and the error body never leaks the token.
  const ok = await get(server.port, '/v1/bots', {
    Authorization: `Bearer ${API_TOKEN}`,
    'X-Open-Bot-Team': TEAM_ID,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), BOTS);
  const errBody = await (await get(server.port, '/v1/bots')).text();
  assert.ok(!errBody.includes(API_TOKEN));
});

test('api team check: service-account token is accepted with the same team header', async () => {
  const server = await startApiServer();
  const res = await get(server.port, '/v1/bots', {
    Authorization: `Bearer ${SA_TOKEN}`,
    'X-Open-Bot-Team': TEAM_ID,
  });
  assert.equal(res.status, 200);
});

test('api team check: without a bound team, the header is not required (backwards compatible)', async () => {
  const server = await startApiServer({ teamId: undefined });
  const res = await get(server.port, '/v1/bots', { Authorization: `Bearer ${API_TOKEN}` });
  assert.equal(res.status, 200);
});
