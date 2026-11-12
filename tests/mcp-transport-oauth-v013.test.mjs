/**
 * Test v0.13 W5c — MCP OAuth discovery + Streamable HTTP + registry + revocation.
 * (node:test, import từ package core ĐÃ BUILD.)
 *
 * Chạy (sau khi build core):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-transport-oauth-v013.test.mjs
 *
 * Mọi server trong test đều là http server giả chạy trên 127.0.0.1, cổng
 * tạm — KHÔNG gọi mạng live, KHÔNG gọi x.ai hay MCP server thật.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildAuthorizationUrl,
  checkMcpAuthStatus,
  discoverFromWwwAuthenticate,
  discoverOAuthForResource,
  exchangeCodeForToken,
  fetchAuthorizationServerMetadata,
  fetchClientIdMetadataDocument,
  fetchProtectedResourceMetadata,
  findBearerChallenge,
  loadOAuthToken,
  mergeScopes,
  parseResourceMetadataUrl,
  parseStepUpScope,
  parseWwwAuthenticate,
  refreshWithStepUpScope,
  registerDynamicClient,
  resolveOAuthClient,
  revokeOAuthToken,
  revokeStoredOAuthToken,
  saveOAuthToken,
  tokenNeedsStepUp,
} from '../packages/core/dist/mcp/oauth.js';
import {
  McpTransportError,
  StreamableHttpTransport,
  parseSseText,
} from '../packages/core/dist/mcp/transport.js';
import {
  clearRegistryCache,
  fetchRemoteRegistry,
  findRegistryServer,
  loadRegistryFile,
  parseRegistryFile,
  parseServerJson,
  registryEntryToMcpConfig,
  sha256Hex,
  verifyChecksum,
} from '../packages/core/dist/mcp/registry.js';

// ---------------------------------------------------------------------------
// Store trong bộ nhớ (thay cho Vault) + fake server
// ---------------------------------------------------------------------------

function memoryStore() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      return map.delete(key);
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

/** Fake OAuth authorization server + protected resource (PRM/OIDC/DCR/revoke). */
function createFakeOAuthServer() {
  const state = {
    revoked: [], // { token, hint }
    tokenRequests: [], // { grant, scope, resources: [] }
    registerRequests: [],
  };
  let base = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const pathname = url.pathname;
    if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
      // PRM luôn khai resource là `${base}/mcp` — dùng để test mismatch.
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['read', 'write', 'admin'],
        bearer_methods_supported: ['header'],
      });
    }
    if (pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        registration_endpoint: `${base}/register`,
        scopes_supported: ['read', 'write', 'admin'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (pathname.startsWith('/.well-known/openid-configuration')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        registration_endpoint: `${base}/register`,
        scopes_supported: ['read', 'write'],
      });
    }
    if (pathname === '/client.json') {
      return json(res, 200, {
        client_id: `${base}/client.json`,
        client_name: 'open-bot test',
        redirect_uris: ['http://127.0.0.1:1/'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'read',
      });
    }
    if (pathname === '/client-wrong.json') {
      return json(res, 200, {
        client_id: `${base}/someone-else.json`,
        redirect_uris: ['http://127.0.0.1:1/'],
      });
    }
    if (pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.registerRequests.push(body);
      return json(res, 201, {
        client_id: 'dyn-client-1',
        client_secret: 'dyn-secret-1',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
      });
    }
    if (pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const grant = params.get('grant_type');
      const scope = params.get('scope') ?? '';
      const resources = params.getAll('resource');
      state.tokenRequests.push({ grant, scope, resources });
      if (grant === 'authorization_code') {
        return json(res, 200, {
          access_token: 'access-code',
          token_type: 'Bearer',
          refresh_token: 'refresh-1',
          scope: scope || 'read',
          expires_in: 3600,
        });
      }
      if (grant === 'refresh_token') {
        const refreshToken = params.get('refresh_token');
        if (refreshToken === 'bad-refresh') {
          return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        }
        // Token step-up giả: refresh-stepup / refresh-stepup2 chỉ thành
        // công khi scope xin thêm có 'admin'.
        if (
          (refreshToken === 'refresh-stepup' || refreshToken === 'refresh-stepup2') &&
          !scope.split(/\s+/).includes('admin')
        ) {
          return json(res, 400, { error: 'insufficient_scope', error_description: 'need admin scope' });
        }
        return json(res, 200, {
          access_token: `access-fresh-${refreshToken}`,
          token_type: 'Bearer',
          refresh_token: refreshToken,
          scope: scope || 'read',
          expires_in: 3600,
        });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (pathname === '/revoke' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const token = params.get('token') ?? '';
      const hint = params.get('token_type_hint') ?? '';
      if (token === 'bad-token') {
        return json(res, 400, { error: 'invalid_token' });
      }
      state.revoked.push({ token, hint });
      return json(res, 200, {});
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return { server, state, setBase: (b) => { base = b; } };
}

/** Fake MCP server Streamable HTTP: POST JSON/SSE, GET SSE stream, DELETE. */
function createFakeMcpServer() {
  const state = {
    deletes: 0,
    lastEventIdsSeen: [],
    posts: [],
  };
  const sessionId = 'sess-1';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'DELETE') {
      state.deletes++;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const lastEventId = req.headers['last-event-id'];
      if (typeof lastEventId === 'string') state.lastEventIdsSeen.push(lastEventId);
      if (req.headers['mcp-session-id'] !== sessionId) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('unknown session');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'mcp-session-id': sessionId,
      });
      const startFrom = lastEventId === 'evt-10' ? 11 : 10;
      for (let n = startFrom; n <= 11; n++) {
        res.write(
          `id: evt-${n}\nevent: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: { n },
          })}\n\n`,
        );
      }
      res.end();
      return;
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.posts.push({ method: body.method, auth: req.headers['authorization'] ?? null });
      if (req.headers['authorization'] === 'Bearer stale') {
        res.writeHead(401, {
          'WWW-Authenticate':
            'Bearer resource_metadata="http://127.0.0.1/x", scope="admin", error="insufficient_scope"',
        });
        res.end('unauthorized');
        return;
      }
      const headers = { 'mcp-session-id': sessionId };
      if (body.method === 'tools/list') {
        // Response SSE: 1 notification server-initiated + 1 response.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
        res.end(
          'id: evt-1\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
            `id: evt-2\nevent: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: [{ name: 'fake-tool' }] },
            })}\n\n`,
        );
        return;
      }
      if (body.id === undefined) {
        res.writeHead(202, headers);
        res.end();
        return;
      }
      return json(
        res,
        200,
        {
          jsonrpc: '2.0',
          id: body.id,
          result:
            body.method === 'initialize'
              ? { protocolVersion: '2025-11-25', serverInfo: { name: 'fake', version: '1.0.0' } }
              : {},
        },
        headers,
      );
    }
    res.writeHead(405);
    res.end();
  });
  return { server, state, sessionId };
}

let oauthBase;
let oauth;
let mcpBase;
let mcp;
let oidcBase;

before(async () => {
  oauth = createFakeOAuthServer();
  await new Promise((resolve) => oauth.server.listen(0, '127.0.0.1', resolve));
  oauthBase = `http://127.0.0.1:${oauth.server.address().port}`;
  oauth.setBase(oauthBase);

  mcp = createFakeMcpServer();
  await new Promise((resolve) => mcp.server.listen(0, '127.0.0.1', resolve));
  mcpBase = `http://127.0.0.1:${mcp.server.address().port}/mcp`;

  // Server chỉ có OIDC (không có RFC 8414) để test fallback.
  const oidcServer = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/.well-known/openid-configuration')) {
      return json(res, 200, {
        issuer: oidcBase,
        authorization_endpoint: `${oidcBase}/authorize`,
        token_endpoint: `${oidcBase}/token`,
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => oidcServer.listen(0, '127.0.0.1', resolve));
  oidcBase = `http://127.0.0.1:${oidcServer.address().port}`;
  globalThis.__oidcServer = oidcServer;
});

after(async () => {
  oauth.server.close();
  mcp.server.close();
  globalThis.__oidcServer?.close();
});

// ---------------------------------------------------------------------------
// 1. WWW-Authenticate + discovery
// ---------------------------------------------------------------------------

test('parseWwwAuthenticate: parse resource_metadata, scope, error', () => {
  const challenges = parseWwwAuthenticate(
    'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource", scope="read write", error="insufficient_scope"',
  );
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0].scheme, 'Bearer');
  assert.equal(
    challenges[0].params.resource_metadata,
    'https://example.com/.well-known/oauth-protected-resource',
  );
  assert.equal(challenges[0].params.scope, 'read write');
  assert.equal(challenges[0].params.error, 'insufficient_scope');
  assert.deepEqual(parseWwwAuthenticate(''), []);
  assert.deepEqual(parseWwwAuthenticate(null), []);
  assert.equal(findBearerChallenge('Basic realm="x"'), undefined);
});

test('parseStepUpScope / parseResourceMetadataUrl', () => {
  const header = 'Bearer scope="read admin", resource_metadata="https://example.com/prm"';
  assert.deepEqual(parseStepUpScope(header), ['read', 'admin']);
  assert.equal(parseResourceMetadataUrl(header), 'https://example.com/prm');
  assert.deepEqual(parseStepUpScope('Bearer realm="x"'), []);
});

test('fetchProtectedResourceMetadata: trả về PRM, kiểm tra resource khớp', async () => {
  const prm = await fetchProtectedResourceMetadata(`${oauthBase}/mcp`, fetch);
  assert.equal(prm.resource, `${oauthBase}/mcp`);
  assert.deepEqual(prm.authorizationServers, [oauthBase]);
  assert.deepEqual(prm.scopesSupported, ['read', 'write', 'admin']);
});

test('fetchProtectedResourceMetadata: resource không khớp thì từ chối', async () => {
  await assert.rejects(
    fetchProtectedResourceMetadata(`${oauthBase}/other`, fetch),
    /không khớp|khác với server/,
  );
});

test('fetchAuthorizationServerMetadata: RFC 8414 trước, OIDC fallback sau', async () => {
  const rfc = await fetchAuthorizationServerMetadata(oauthBase, fetch);
  assert.equal(rfc.source, 'rfc8414');
  assert.equal(rfc.metadata.tokenEndpoint, `${oauthBase}/token`);
  assert.equal(rfc.metadata.revocationEndpoint, `${oauthBase}/revoke`);
  assert.equal(rfc.metadata.registrationEndpoint, `${oauthBase}/register`);

  const oidc = await fetchAuthorizationServerMetadata(oidcBase, fetch);
  assert.equal(oidc.source, 'oidc');
  assert.equal(oidc.metadata.tokenEndpoint, `${oidcBase}/token`);
});

test('discoverOAuthForResource: PRM -> AS metadata đầy đủ endpoint', async () => {
  const discovery = await discoverOAuthForResource(`${oauthBase}/mcp`, fetch);
  assert.equal(discovery.resource, `${oauthBase}/mcp`);
  assert.equal(discovery.authorizationEndpoint, `${oauthBase}/authorize`);
  assert.equal(discovery.tokenEndpoint, `${oauthBase}/token`);
  assert.equal(discovery.revocationEndpoint, `${oauthBase}/revoke`);
  assert.equal(discovery.registrationEndpoint, `${oauthBase}/register`);
  assert.ok(discovery.resourceMetadata);
  assert.deepEqual(discovery.scopesSupported, ['read', 'write', 'admin']);
});

test('discoverFromWwwAuthenticate: theo resource_metadata trong header 401', async () => {
  const header = `Bearer resource_metadata="${oauthBase}/.well-known/oauth-protected-resource/mcp"`;
  const discovery = await discoverFromWwwAuthenticate(header, `${oauthBase}/mcp`, fetch);
  assert.ok(discovery);
  assert.equal(discovery.tokenEndpoint, `${oauthBase}/token`);
  assert.equal(await discoverFromWwwAuthenticate('Basic realm="x"', `${oauthBase}/mcp`, fetch), null);
  assert.equal(await discoverFromWwwAuthenticate(null, `${oauthBase}/mcp`, fetch), null);
});

// ---------------------------------------------------------------------------
// 2. Resource indicator (RFC 8707) + đăng ký client
// ---------------------------------------------------------------------------

test('exchangeCodeForToken gửi resource (RFC 8707) tới token endpoint', async () => {
  oauth.state.tokenRequests.length = 0;
  const url = buildAuthorizationUrl({
    authorizationEndpoint: `${oauthBase}/authorize`,
    clientId: 'c1',
    redirectUri: 'http://127.0.0.1:1/',
    codeChallenge: 'challenge',
    state: 's1',
    resource: `${oauthBase}/mcp`,
  });
  assert.ok(url.includes(`resource=${encodeURIComponent(`${oauthBase}/mcp`)}`));
  const token = await exchangeCodeForToken({
    tokenEndpoint: `${oauthBase}/token`,
    clientId: 'c1',
    code: 'code-1',
    redirectUri: 'http://127.0.0.1:1/',
    codeVerifier: 'verifier',
    resource: [`${oauthBase}/mcp`, `${oauthBase}/other`],
    fetchFn: fetch,
  });
  assert.equal(token.accessToken, 'access-code');
  const last = oauth.state.tokenRequests.at(-1);
  assert.equal(last.grant, 'authorization_code');
  assert.deepEqual(last.resources, [`${oauthBase}/mcp`, `${oauthBase}/other`]);
});

test('registerDynamicClient (RFC 7591) trả về client_id/secret', async () => {
  const reg = await registerDynamicClient({
    registrationEndpoint: `${oauthBase}/register`,
    clientName: 'open-bot',
    redirectUris: ['http://127.0.0.1:1/'],
    scope: 'read',
    fetchFn: fetch,
  });
  assert.equal(reg.clientId, 'dyn-client-1');
  assert.equal(reg.clientSecret, 'dyn-secret-1');
  assert.equal(oauth.state.registerRequests.at(-1).client_name, 'open-bot');
});

test('fetchClientIdMetadataDocument: khớp client_id thì ok, sai thì từ chối', async () => {
  const doc = await fetchClientIdMetadataDocument(`${oauthBase}/client.json`, fetch);
  assert.equal(doc.clientId, `${oauthBase}/client.json`);
  assert.deepEqual(doc.redirectUris, ['http://127.0.0.1:1/']);
  await assert.rejects(
    fetchClientIdMetadataDocument(`${oauthBase}/client-wrong.json`, fetch),
    /không khớp/,
  );
});

test('resolveOAuthClient: thứ tự pre-registered > metadata > DCR > lỗi', async () => {
  const pre = await resolveOAuthClient({
    preRegisteredClientId: 'pre-1',
    clientIdMetadataUrl: `${oauthBase}/client.json`,
    registrationEndpoint: `${oauthBase}/register`,
    redirectUris: ['http://127.0.0.1:1/'],
    fetchFn: fetch,
  });
  assert.deepEqual([pre.clientId, pre.source], ['pre-1', 'pre-registered']);

  const meta = await resolveOAuthClient({
    clientIdMetadataUrl: `${oauthBase}/client.json`,
    registrationEndpoint: `${oauthBase}/register`,
    redirectUris: ['http://127.0.0.1:1/'],
    fetchFn: fetch,
  });
  assert.deepEqual([meta.clientId, meta.source], [`${oauthBase}/client.json`, 'metadata-document']);

  const dyn = await resolveOAuthClient({
    registrationEndpoint: `${oauthBase}/register`,
    redirectUris: ['http://127.0.0.1:1/'],
    fetchFn: fetch,
  });
  assert.deepEqual([dyn.clientId, dyn.source], ['dyn-client-1', 'dynamic-registration']);

  await assert.rejects(
    resolveOAuthClient({ redirectUris: ['http://127.0.0.1:1/'], fetchFn: fetch }),
    /nhập client_id/,
  );
});

// ---------------------------------------------------------------------------
// 3. Step-up scope
// ---------------------------------------------------------------------------

test('mergeScopes / tokenNeedsStepUp: gộp không trùng, phát hiện thiếu scope', () => {
  assert.equal(mergeScopes('read write', ['write', 'admin']), 'read write admin');
  assert.equal(mergeScopes(undefined, ['read']), 'read');
  const token = { accessToken: 'x', tokenType: 'Bearer', obtainedAt: Date.now(), scope: 'read' };
  assert.equal(tokenNeedsStepUp(token, ['read']), false);
  assert.equal(tokenNeedsStepUp(token, ['admin']), true);
});

test('refreshWithStepUpScope: xin thêm scope admin rồi lưu token mới', async () => {
  const store = memoryStore();
  await saveOAuthToken(store, 'srv-stepup', {
    accessToken: 'old',
    tokenType: 'Bearer',
    refreshToken: 'refresh-stepup',
    scope: 'read',
    expiresAt: Date.now() + 3600_000,
    obtainedAt: Date.now(),
  });
  const fresh = await refreshWithStepUpScope(store, 'srv-stepup', {
    tokenEndpoint: `${oauthBase}/token`,
    clientId: 'c1',
    requiredScopes: ['admin'],
    fetchFn: fetch,
  });
  assert.equal(fresh.scope, 'read admin');
  const saved = await loadOAuthToken(store, 'srv-stepup');
  assert.equal(saved.scope, 'read admin');
});

test('refreshWithStepUpScope: thử lại có giới hạn khi thiếu scope (callback bổ sung)', async () => {
  const store = memoryStore();
  await saveOAuthToken(store, 'srv-stepup2', {
    accessToken: 'old',
    tokenType: 'Bearer',
    refreshToken: 'refresh-stepup2',
    scope: 'read',
    expiresAt: Date.now() + 3600_000,
    obtainedAt: Date.now(),
  });
  let calls = 0;
  const fresh = await refreshWithStepUpScope(store, 'srv-stepup2', {
    tokenEndpoint: `${oauthBase}/token`,
    clientId: 'c1',
    requiredScopes: ['write'],
    maxAttempts: 3,
    extraScopesForAttempt: (attempt) => {
      calls++;
      assert.ok(attempt >= 1);
      return ['admin'];
    },
    fetchFn: fetch,
  });
  assert.equal(calls, 1);
  assert.equal(fresh.scope, 'read write admin');
});

test('refreshWithStepUpScope: không có refresh token thì báo authorize lại', async () => {
  const store = memoryStore();
  await saveOAuthToken(store, 'srv-norefresh', {
    accessToken: 'old',
    tokenType: 'Bearer',
    obtainedAt: Date.now(),
  });
  await assert.rejects(
    refreshWithStepUpScope(store, 'srv-norefresh', {
      tokenEndpoint: `${oauthBase}/token`,
      clientId: 'c1',
      requiredScopes: ['admin'],
      fetchFn: fetch,
    }),
    /không có refresh token/,
  );
});

// ---------------------------------------------------------------------------
// 4. Revocation + auth status thật
// ---------------------------------------------------------------------------

test('revokeOAuthToken: 200 thì ok, token xấu thì lỗi', async () => {
  await revokeOAuthToken({
    revocationEndpoint: `${oauthBase}/revoke`,
    token: 'access-1',
    tokenTypeHint: 'access_token',
    clientId: 'c1',
    fetchFn: fetch,
  });
  await assert.rejects(
    revokeOAuthToken({
      revocationEndpoint: `${oauthBase}/revoke`,
      token: 'bad-token',
      clientId: 'c1',
      fetchFn: fetch,
    }),
    /HTTP 400/,
  );
});

test('revokeStoredOAuthToken: thu hồi refresh + access rồi xóa khỏi store', async () => {
  const store = memoryStore();
  await saveOAuthToken(store, 'srv-revoke', {
    accessToken: 'access-9',
    tokenType: 'Bearer',
    refreshToken: 'refresh-9',
    obtainedAt: Date.now(),
  });
  const before = oauth.state.revoked.length;
  const result = await revokeStoredOAuthToken(store, 'srv-revoke', {
    tokenEndpoint: `${oauthBase}/token`,
    clientId: 'c1',
    revocationEndpoint: `${oauthBase}/revoke`,
    fetchFn: fetch,
  });
  assert.equal(result.revokedCount, 2);
  assert.deepEqual(result.errors, []);
  const revoked = oauth.state.revoked.slice(before);
  assert.deepEqual(
    revoked.map((r) => r.hint),
    ['refresh_token', 'access_token'],
  );
  assert.equal(await loadOAuthToken(store, 'srv-revoke'), null);
});

test('checkMcpAuthStatus: valid / refreshed / expired-no-refresh / not-authorized / needs-reauth', async () => {
  const store = memoryStore();
  const baseOpts = {
    tokenEndpoint: `${oauthBase}/token`,
    clientId: 'c1',
    fetchFn: fetch,
  };

  assert.equal((await checkMcpAuthStatus(store, 'srv-none', baseOpts)).status, 'not-authorized');

  await saveOAuthToken(store, 'srv-valid', {
    accessToken: 'a',
    tokenType: 'Bearer',
    scope: 'read',
    expiresAt: Date.now() + 3600_000,
    obtainedAt: Date.now(),
  });
  const valid = await checkMcpAuthStatus(store, 'srv-valid', baseOpts);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.refreshed, false);

  await saveOAuthToken(store, 'srv-expired', {
    accessToken: 'old',
    tokenType: 'Bearer',
    refreshToken: 'refresh-1',
    scope: 'read',
    expiresAt: Date.now() - 1000,
    obtainedAt: Date.now() - 7200_000,
  });
  const refreshed = await checkMcpAuthStatus(store, 'srv-expired', baseOpts);
  assert.equal(refreshed.status, 'refreshed');
  assert.equal(refreshed.refreshed, true);
  assert.equal((await loadOAuthToken(store, 'srv-expired')).accessToken, 'access-fresh-refresh-1');

  await saveOAuthToken(store, 'srv-norefresh', {
    accessToken: 'old',
    tokenType: 'Bearer',
    expiresAt: Date.now() - 1000,
    obtainedAt: Date.now() - 7200_000,
  });
  assert.equal((await checkMcpAuthStatus(store, 'srv-norefresh', baseOpts)).status, 'expired-no-refresh');

  await saveOAuthToken(store, 'srv-badrefresh', {
    accessToken: 'old',
    tokenType: 'Bearer',
    refreshToken: 'bad-refresh',
    expiresAt: Date.now() - 1000,
    obtainedAt: Date.now() - 7200_000,
  });
  assert.equal((await checkMcpAuthStatus(store, 'srv-badrefresh', baseOpts)).status, 'needs-reauth');
});

// ---------------------------------------------------------------------------
// 5. Streamable HTTP transport
// ---------------------------------------------------------------------------

test('parseSseText: id/event/data nhiều dòng + remainder', () => {
  const { events, remainder } = parseSseText(
    'id: e1\nevent: message\ndata: {"a":1}\ndata: line2\n\n: comment\nid: e2\ndata: hi\n\nid: e3\ndata: dang-',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'e1');
  assert.equal(events[0].event, 'message');
  assert.equal(events[0].data, '{"a":1}\nline2');
  assert.equal(events[1].id, 'e2');
  assert.equal(remainder, 'id: e3\ndata: dang-');
});

test('transport send: POST JSON trả result + nhớ Mcp-Session-Id', async () => {
  const t = new StreamableHttpTransport({ url: mcpBase, timeoutMs: 5000 });
  const res = await t.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.result.protocolVersion, '2025-11-25');
  assert.equal(t.getSessionId(), 'sess-1');
  await t.close();
  assert.equal(t.isClosed(), true);
  await assert.rejects(t.send({ jsonrpc: '2.0', id: 2, method: 'ping' }), /đã đóng/);
});

test('transport send: POST SSE dispatch notification + trả response + nhớ Last-Event-ID', async () => {
  const seen = [];
  const t = new StreamableHttpTransport({ url: mcpBase, onServerMessage: (m) => seen.push(m) });
  const res = await t.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.deepEqual(res.result.tools, [{ name: 'fake-tool' }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'notifications/progress');
  assert.equal(t.getLastEventId(), 'evt-2');
  await t.close();
});

test('transport send: 401 thì refresh 1 lần rồi retry; không có refresh thì lỗi kèm WWW-Authenticate', async () => {
  const t = new StreamableHttpTransport({
    url: mcpBase,
    getAuthorization: () => 'Bearer stale',
    refreshAuthorization: () => 'Bearer fresh',
  });
  const res = await t.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(res.result, {});
  await t.close();

  const t2 = new StreamableHttpTransport({
    url: mcpBase,
    getAuthorization: () => 'Bearer stale',
  });
  let caught;
  try {
    await t2.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof McpTransportError);
  assert.equal(caught.status, 401);
  assert.deepEqual(parseStepUpScope(caught.wwwAuthenticate), ['admin']);
  await t2.close();
});

test('transport sendNotification: 202 rỗng trả về null', async () => {
  const t = new StreamableHttpTransport({ url: mcpBase });
  assert.equal(await t.send({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  await t.close();
});

test('transport openStream + resume: GET SSE nhận notification, nối lại bằng Last-Event-ID', async () => {
  const seen = [];
  const deletesBefore = mcp.state.deletes;
  const t = new StreamableHttpTransport({
    url: mcpBase,
    maxReconnectAttempts: 0,
    reconnectDelayMs: 10,
    onServerMessage: (m) => seen.push(m),
  });
  await t.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await t.openStream();
  // Chờ stream đọc xong (server đóng sau khi gửi 2 event).
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.getLastEventId(), 'evt-11');
  assert.deepEqual(seen.map((m) => m.params.n), [10, 11]);
  await t.close();
  assert.equal(mcp.state.deletes, deletesBefore + 1);
});

test('transport resume: gửi Last-Event-ID của event cuối và nhận event mới', async () => {
  const seen = [];
  const t = new StreamableHttpTransport({
    url: mcpBase,
    maxReconnectAttempts: 0,
    reconnectDelayMs: 10,
    onServerMessage: (m) => seen.push(m),
  });
  await t.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await t.openStream();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.getLastEventId(), 'evt-11');
  const before = mcp.state.lastEventIdsSeen.length;
  // Resume thủ công: transport gửi lại GET kèm Last-Event-ID evt-11;
  // fake server khi thấy evt-10 mới lọc, nên ta kiểm tra header đã gửi.
  await t.resume();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(mcp.state.lastEventIdsSeen.length > before);
  assert.equal(mcp.state.lastEventIdsSeen.at(-1), 'evt-11');
  await t.close();
});

test('transport: URL không http(s) thì lỗi ngay', () => {
  assert.throws(
    () => new StreamableHttpTransport({ url: 'ftp://example.com/mcp' }),
    /http/,
  );
});

// ---------------------------------------------------------------------------
// 6. Registry server.json
// ---------------------------------------------------------------------------

const REGISTRY_JSON = JSON.stringify({
  $schema: 'https://example.com/schema.json',
  version: '0.1.0',
  servers: [
    {
      name: 'io.github.example/filesystem',
      description: 'Filesystem server',
      version: '1.2.3',
      repository: { url: 'https://github.com/example/filesystem', id: '1' },
      packages: [
        {
          registryType: 'npm',
          identifier: '@example/mcp-filesystem',
          version: '1.2.3',
          transport: { type: 'stdio' },
        },
      ],
    },
    {
      name: 'io.github.example/remote-notes',
      description: 'Remote notes server',
      version: '0.9.0',
      remotes: [{ transportType: 'streamable-http', url: 'https://notes.example.com/mcp' }],
    },
  ],
});

test('parseRegistryFile: registry nhiều server + tìm theo tên', () => {
  const registry = parseRegistryFile(REGISTRY_JSON);
  assert.equal(registry.servers.length, 2);
  assert.equal(registry.version, '0.1.0');
  assert.equal(findRegistryServer(registry, 'io.github.example/filesystem').version, '1.2.3');
  assert.equal(findRegistryServer(registry, 'khong-co'), undefined);
});

test('parseRegistryFile: từ chối version sai, thiếu transport, trùng tên, checksum sai', () => {
  const badVersion = JSON.stringify({
    servers: [{ name: 'a/b', description: 'd', version: 'x', packages: [{ registryType: 'npm', identifier: 'p', version: '1.0.0', transport: { type: 'stdio' } }] }],
  });
  assert.throws(() => parseRegistryFile(badVersion), /semver/);
  const noTransport = JSON.stringify({
    servers: [{ name: 'a/b', description: 'd', version: '1.0.0' }],
  });
  assert.throws(() => parseRegistryFile(noTransport), /packages.*remotes/);
  const duplicate = JSON.stringify({
    servers: [
      { name: 'a/b', description: 'd', version: '1.0.0', remotes: [{ transportType: 'streamable-http', url: 'https://x.example.com/mcp' }] },
      { name: 'a/b', description: 'd', version: '1.0.0', remotes: [{ transportType: 'streamable-http', url: 'https://x.example.com/mcp' }] },
    ],
  });
  assert.throws(() => parseRegistryFile(duplicate), /trùng tên/);
  assert.throws(
    () => parseRegistryFile('{"servers": []}'),
    /rỗng/,
  );
  assert.throws(() => parseRegistryFile('{khong phai json'), /không phải JSON/);
});

test('parseServerJson: 1 server thì ok, nhiều server thì lỗi', () => {
  const single = JSON.stringify({
    name: 'io.github.example/only',
    description: 'Only one',
    version: '2.0.0',
    remotes: [{ transportType: 'streamable-http', url: 'https://only.example.com/mcp' }],
  });
  assert.equal(parseServerJson(single).name, 'io.github.example/only');
  assert.throws(() => parseServerJson(REGISTRY_JSON), /2 server/);
});

test('sha256Hex / verifyChecksum', () => {
  const hash = sha256Hex('hello');
  assert.equal(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(verifyChecksum('hello', hash), true);
  assert.equal(verifyChecksum('hello!', hash), false);
  assert.equal(verifyChecksum('hello', 'not-a-hash'), false);
});

test('registryEntryToMcpConfig: remote -> url, npm stdio -> npx -y', () => {
  const registry = parseRegistryFile(REGISTRY_JSON);
  const remote = registryEntryToMcpConfig(findRegistryServer(registry, 'io.github.example/remote-notes'));
  assert.deepEqual(remote, { name: 'remote-notes', url: 'https://notes.example.com/mcp' });
  const stdio = registryEntryToMcpConfig(findRegistryServer(registry, 'io.github.example/filesystem'));
  assert.deepEqual(stdio, {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@example/mcp-filesystem'],
  });
});

test('loadRegistryFile: đọc từ đĩa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-registry-'));
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, REGISTRY_JSON, 'utf8');
  assert.equal(loadRegistryFile(file).servers.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fetchRemoteRegistry: tải + cache có TTL + checksum', async () => {
  const body = REGISTRY_JSON;
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/registry.json`;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-regcache-'));
  try {
    const expected = sha256Hex(body);
    const first = await fetchRemoteRegistry({ url, cacheDir, ttlMs: 5000, expectedSha256: expected });
    assert.equal(first.fromCache, false);
    assert.equal(first.registry.servers.length, 2);
    assert.equal(first.sha256, expected);
    assert.equal(hits, 1);

    const second = await fetchRemoteRegistry({ url, cacheDir, ttlMs: 5000, expectedSha256: expected });
    assert.equal(second.fromCache, true);
    assert.equal(hits, 1);

    // Sai checksum kỳ vọng: từ chối, không dùng, không ghi đè cache tốt.
    await assert.rejects(
      fetchRemoteRegistry({ url, cacheDir, ttlMs: 0, expectedSha256: '0'.repeat(64) }),
      /checksum/,
    );

    // Hết TTL thì tải lại. TTL 500ms + ngủ 600ms (không phải 50ms/80ms):
    // fetchedAt được ghi ở lần tải ĐẦU, và trước lần gọi thứ ba đã có
    // thêm 2 round-trip (lần 2 từ cache + lần checksum sai tải lại từ
    // mạng) nên tuổi cache lúc gọi thứ ba thường đã > 50ms — TTL 50ms
    // là race: test đỏ/đen tùy tốc độ máy. 500ms vẫn giữ đúng ý test
    // (lần 3 còn hạn, ngủ quá TTL thì lần 4 tải lại) với biên an toàn.
    const third = await fetchRemoteRegistry({ url, cacheDir, ttlMs: 500, expectedSha256: expected });
    assert.equal(third.fromCache, true);
    await new Promise((r) => setTimeout(r, 600));
    const fourth = await fetchRemoteRegistry({ url, cacheDir, ttlMs: 500, expectedSha256: expected });
    assert.equal(fourth.fromCache, false);
    assert.equal(hits, 3);

    // Cache hỏng thì tải lại thay vì crash.
    const cacheFiles = fs.readdirSync(cacheDir);
    assert.equal(cacheFiles.length, 1);
    fs.writeFileSync(path.join(cacheDir, cacheFiles[0]), 'khong phai json {', 'utf8');
    const fifth = await fetchRemoteRegistry({ url, cacheDir, ttlMs: 5000, expectedSha256: expected });
    assert.equal(fifth.fromCache, false);

    assert.equal(clearRegistryCache(cacheDir, url), true);
    assert.equal(clearRegistryCache(cacheDir, url), false);
  } finally {
    server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('fetchRemoteRegistry: nội dung hỏng thì lỗi và không cache', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"servers": "khong phai mang"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/registry.json`;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-regcache-bad-'));
  try {
    await assert.rejects(fetchRemoteRegistry({ url, cacheDir }), /servers/);
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  } finally {
    server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
