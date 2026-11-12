/**
 * mcp-git-v07.test.mjs — MCP OAuth + system MCP tool + GitHub host + active branch (v0.7).
 * Mock fetch for the GitHub API and the OAuth token endpoint; the OAuth
 * callback uses a REAL localhost listener on a random port, and the
 * authorization endpoint is a REAL local HTTP server that redirects
 * back to it. Git checkout runs for real on a temporary repo.
 * No live x.ai, no live GitHub, no real tokens.
 * Run: node --test tests/mcp-git-v07.test.mjs (after building core + tools)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  buildAuthorizationUrl,
  createPkcePair,
  createOAuthState,
  exchangeCodeForToken,
  getValidAccessToken,
  loadOAuthToken,
  saveOAuthToken,
  startCallbackListener,
} from '../packages/core/dist/mcp/oauth.js';
import { GitHubClient } from '../packages/core/dist/git/host.js';
import {
  GIT_TOOLS,
  createGitTools,
} from '../packages/tools/dist/gitTools.js';
import {
  MCP_SYSTEM_TOOLS,
  createMcpSystemTools,
} from '../packages/tools/dist/mcpSystemTools.js';

const ctx = (dir) => ({ workspaceDir: dir, botId: 'test-bot' });
const toolByName = (tools, name) => tools.find((t) => t.definition.name === name);

function makeStore() {
  const map = new Map();
  return {
    map,
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => void map.set(k, v),
    delete: (k) => map.delete(k),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// OAuth pure helpers
// ---------------------------------------------------------------------------

test('oauth: PKCE pair — 43-char verifier, S256 challenge matches SHA-256', () => {
  const { verifier, challenge } = createPkcePair();
  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  const expected = crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(challenge, expected);
  assert.notEqual(challenge, verifier);
});

test('oauth: buildAuthorizationUrl carries PKCE + state, refuses plain flow / bad endpoint', () => {
  const url = buildAuthorizationUrl({
    authorizationEndpoint: 'https://auth.example.com/authorize',
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1:51234/',
    codeChallenge: 'challenge-abc',
    scope: 'read',
    state: 'state-xyz',
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-abc');
  assert.equal(parsed.searchParams.get('state'), 'state-xyz');
  assert.equal(parsed.searchParams.get('scope'), 'read');
  assert.throws(
    () =>
      buildAuthorizationUrl({
        authorizationEndpoint: 'https://auth.example.com/authorize',
        clientId: 'c',
        redirectUri: 'http://127.0.0.1:1/',
        codeChallenge: '',
        state: 's',
      }),
    /PKCE/,
  );
  assert.throws(
    () =>
      buildAuthorizationUrl({
        authorizationEndpoint: 'ftp://auth.example.com/authorize',
        clientId: 'c',
        redirectUri: 'http://127.0.0.1:1/',
        codeChallenge: 'x',
        state: 's',
      }),
    /http:\/\/ or https:\/\//,
  );
});

test('oauth: exchangeCodeForToken posts form fields incl. code_verifier; refresh keeps old token when not rotated', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, body: init?.body });
    const params = new URLSearchParams(init?.body);
    if (params.get('grant_type') === 'authorization_code') {
      assert.equal(params.get('code'), 'auth-code-1');
      assert.equal(params.get('code_verifier'), 'verifier-1');
      return jsonResponse({
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: 'read',
      });
    }
    // refresh grant: provider does NOT rotate the refresh token.
    assert.equal(params.get('grant_type'), 'refresh_token');
    assert.equal(params.get('refresh_token'), 'refresh-1');
    return jsonResponse({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600 });
  };
  const token = await exchangeCodeForToken({
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'client-1',
    code: 'auth-code-1',
    redirectUri: 'http://127.0.0.1:51234/',
    codeVerifier: 'verifier-1',
    fetchFn,
  });
  assert.equal(token.accessToken, 'access-1');
  assert.equal(token.refreshToken, 'refresh-1');
  assert.ok(token.expiresAt > Date.now());

  const store = makeStore();
  await saveOAuthToken(store, 'srv', { ...token, expiresAt: Date.now() - 1000 });
  const fresh = await getValidAccessToken(store, 'srv', {
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'client-1',
    fetchFn,
  });
  assert.equal(fresh.accessToken, 'access-2');
  // Refresh token kept because the provider did not rotate it.
  assert.equal(fresh.refreshToken, 'refresh-1');
  const stored = await loadOAuthToken(store, 'srv');
  assert.equal(stored.accessToken, 'access-2');
  assert.equal(seen.length, 2);
});

// ---------------------------------------------------------------------------
// OAuth callback listener + mcp_auth end-to-end against a fake provider
// ---------------------------------------------------------------------------

/** Fake OAuth provider: /authorize redirects to the callback with a code; /token issues tokens. */
function startFakeOAuthProvider() {
  const tokenRequests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const target = `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=fake-code-123&state=${encodeURIComponent(state)}`;
      res.writeHead(302, { Location: target });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        tokenRequests.push(body);
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'authorization_code') {
          assert.equal(params.get('code'), 'fake-code-123');
          assert.ok(params.get('code_verifier'));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'fake-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'fake-refresh-token',
            scope: 'read',
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, tokenRequests });
    });
  });
}

test('oauth: callback listener accepts matching state, rejects mismatch', async () => {
  const state = createOAuthState();
  const listener = startCallbackListener({ state });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const port = listener.port;
  assert.ok(port > 0);
  assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  // Wrong state first: must reject, listener closes afterwards.
  // Start the fetch WITHOUT awaiting it, then observe the wait
  // immediately: awaiting the fetch first would leave the rejecting
  // wait promise unobserved for a tick (Node reports that as an
  // unhandled rejection and fails the test).
  const badWait = listener.waitForCode(5000);
  const badRes = fetch(`http://127.0.0.1:${port}/?code=x&state=wrong-state`);
  await assert.rejects(() => badWait, /state mismatch/);
  assert.equal((await badRes).status, 400);
  listener.close();

  // Matching state resolves with the code.
  const listener2 = startCallbackListener({ state });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const codePromise = listener2.waitForCode(5000);
  const ok = await fetch(
    `http://127.0.0.1:${listener2.port}/?code=code-abc&state=${encodeURIComponent(state)}`,
  );
  assert.equal(ok.status, 200);
  assert.equal(await codePromise, 'code-abc');
});

test('mcp_auth end-to-end: fake provider redirect -> localhost callback -> token stored in Vault namespace', async (t) => {
  const { server, port, tokenRequests } = await startFakeOAuthProvider();
  t.after(() => server.close());
  const store = makeStore();
  const tools = createMcpSystemTools({
    oauthStore: store,
    getOAuthConfig: () => ({
      authorizationEndpoint: `http://127.0.0.1:${port}/authorize`,
      tokenEndpoint: `http://127.0.0.1:${port}/token`,
      clientId: 'test-client',
      scope: 'read',
    }),
    // Simulate the user opening the URL in a browser: fetch follows the
    // provider's 302 redirect to the localhost callback listener.
    openUrl: async (url) => {
      await fetch(url);
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mcp-auth-'));
  const out = await toolByName(tools, 'mcp_auth').execute(
    { server: 'fake-mcp', timeoutSeconds: 60 },
    ctx(dir),
  );
  assert.match(out, /authorized via OAuth/);
  assert.match(out, /refresh token was stored/);
  // The token value must never appear in the tool result.
  assert.doesNotMatch(out, /fake-access-token/);
  assert.equal(tokenRequests.length, 1);
  const stored = await loadOAuthToken(store, 'fake-mcp');
  assert.equal(stored.accessToken, 'fake-access-token');
  assert.equal(stored.refreshToken, 'fake-refresh-token');

  const status = await toolByName(tools, 'mcp_auth_status').execute(
    { server: 'fake-mcp' },
    ctx(dir),
  );
  assert.match(status, /authorized/);
  assert.match(status, /Expired: no/);
  assert.match(status, /Scope: read/);
  assert.doesNotMatch(status, /fake-access-token/);

  const unknown = await toolByName(tools, 'mcp_auth_status').execute(
    { server: 'never-authed' },
    ctx(dir),
  );
  assert.match(unknown, /NOT authorized/);
});

test('mcp_auth without wiring -> clear error, not a throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mcp-auth-'));
  const out = await toolByName(MCP_SYSTEM_TOOLS, 'mcp_auth').execute(
    { server: 'x' },
    ctx(dir),
  );
  assert.match(out, /^Error: MCP OAuth storage is not wired up/);
});

// ---------------------------------------------------------------------------
// mcp_system_exec
// ---------------------------------------------------------------------------

test('mcp_system_exec: allowlist enforced, output truncated, approval required', async () => {
  const calls = [];
  const tools = createMcpSystemTools({
    allowedSystemTools: ['read_note'],
    callSystemTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'read_note') return 'x'.repeat(25_000);
      return 'ok';
    },
  });
  assert.equal(toolByName(tools, 'mcp_system_exec').needsApproval, true);
  const denied = await toolByName(tools, 'mcp_system_exec').execute(
    { tool: 'delete_everything', arguments: {} },
    ctx(os.tmpdir()),
  );
  assert.match(denied, /not on the allowlist/);
  assert.equal(calls.length, 0);

  const out = await toolByName(tools, 'mcp_system_exec').execute(
    { tool: 'read_note', arguments: { id: '1' } },
    ctx(os.tmpdir()),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { id: '1' });
  assert.ok(out.length <= 20_000 + 100);
  assert.match(out, /truncated to 20000 chars/);

  const unwired = await toolByName(MCP_SYSTEM_TOOLS, 'mcp_system_exec').execute(
    { tool: 'read_note' },
    ctx(os.tmpdir()),
  );
  assert.match(unwired, /No system MCP tool executor is wired up/);
});

// ---------------------------------------------------------------------------
// GitHub host (mock fetch)
// ---------------------------------------------------------------------------

function mockGitHubFetch() {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', auth: init.headers?.Authorization });
    const u = new URL(url);
    const p = u.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (p === '/user') return jsonResponse({ login: 'octocat' });
    if (p === '/user/repos') {
      return jsonResponse([
        { full_name: 'octocat/hello-world', name: 'hello-world', owner: { login: 'octocat' }, private: false, description: 'demo', html_url: 'https://github.com/octocat/hello-world', default_branch: 'main' },
        { full_name: 'octocat/secret', name: 'secret', owner: { login: 'octocat' }, private: true, description: null, html_url: 'https://github.com/octocat/secret', default_branch: 'main' },
      ]);
    }
    if (p === '/repos/octocat/hello-world/pulls' && (init.method ?? 'GET') === 'GET') {
      return jsonResponse([
        { number: 7, title: 'Fix bug', state: 'open', html_url: 'https://github.com/octocat/hello-world/pull/7', user: { login: 'octocat' }, head: { ref: 'fix' }, base: { ref: 'main' }, body: 'fixes it', labels: [{ name: 'bug' }], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
      ]);
    }
    if (p === '/repos/octocat/hello-world/pulls' && init.method === 'POST') {
      assert.equal(body.title, 'New feature');
      return jsonResponse({ number: 8, title: body.title, state: 'open', html_url: 'https://github.com/octocat/hello-world/pull/8', user: { login: 'octocat' }, head: { ref: body.head }, base: { ref: body.base }, body: body.body ?? '', labels: [], created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' }, 201);
    }
    if (p === '/repos/octocat/hello-world/pulls/7' && init.method === 'PATCH') {
      return jsonResponse({ number: 7, title: body.title ?? 'Fix bug', state: body.state ?? 'open', html_url: 'https://github.com/octocat/hello-world/pull/7', user: { login: 'octocat' }, head: { ref: 'fix' }, base: { ref: 'main' }, body: body.body ?? '', labels: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-04T00:00:00Z' });
    }
    if (p === '/repos/octocat/hello-world/pulls/7' && (init.method ?? 'GET') === 'GET') {
      return jsonResponse({ number: 7, title: 'Fix bug', state: 'open', html_url: 'https://github.com/octocat/hello-world/pull/7', user: { login: 'octocat' }, head: { ref: 'fix' }, base: { ref: 'main' }, body: 'fixes it', labels: [{ name: 'bug' }], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' });
    }
    if (p === '/repos/octocat/hello-world/pulls/7/files') {
      return jsonResponse([
        { filename: 'src/a.ts', status: 'modified', additions: 10, deletions: 2, patch: '@@ -1,2 +1,3 @@\n+new line' },
        { filename: 'README.md', status: 'added', additions: 5, deletions: 0, patch: '' },
      ]);
    }
    if (p === '/repos/octocat/hello-world/pulls/7/comments' && (init.method ?? 'GET') === 'GET') {
      return jsonResponse([
        { id: 11, user: { login: 'reviewer' }, body: 'Looks good', path: 'src/a.ts', line: 3, created_at: '2026-01-02T00:00:00Z', html_url: 'https://github.com/x#11' },
      ]);
    }
    if (p === '/repos/octocat/hello-world/issues/7/labels' && init.method === 'PUT') {
      return jsonResponse(body.labels.map((name) => ({ name })));
    }
    if (p === '/repos/octocat/hello-world/issues/7/comments' && init.method === 'POST') {
      return jsonResponse({ id: 21, user: { login: 'octocat' }, body: body.body, path: null, line: null, created_at: '2026-01-03T00:00:00Z', html_url: 'https://github.com/x#21' }, 201);
    }
    if (p === '/repos/octocat/hello-world/pulls/7/comments' && init.method === 'POST') {
      return jsonResponse({ id: 22, user: { login: 'octocat' }, body: body.body, path: body.path, line: body.line, created_at: '2026-01-03T00:00:00Z', html_url: 'https://github.com/x#22' }, 201);
    }
    if (p === '/repos/octocat/hello-world/pulls/7/reviews' && init.method === 'POST') {
      return jsonResponse({ id: 31, state: 'APPROVED' }, 201);
    }
    if (p === '/repos/octocat/missing/pulls') return jsonResponse({ message: 'Not Found' }, 404);
    return jsonResponse({ message: 'Not Found' }, 404);
  };
  return { fetchFn, calls };
}

test('git tools: exports 8 tools with correct approval flags', () => {
  const names = GIT_TOOLS.map((t) => t.definition.name).sort();
  assert.deepEqual(names, [
    'git_host_connect',
    'pr_code_tour_update',
    'pr_code_tour_view',
    'pr_create',
    'pr_label_set',
    'pr_list',
    'pr_update',
    'set_active_branch',
  ]);
  const needsApproval = Object.fromEntries(
    GIT_TOOLS.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(needsApproval.git_host_connect, false);
  assert.equal(needsApproval.pr_list, false);
  assert.equal(needsApproval.pr_code_tour_view, false);
  assert.equal(needsApproval.pr_create, true);
  assert.equal(needsApproval.pr_update, true);
  assert.equal(needsApproval.pr_label_set, true);
  assert.equal(needsApproval.pr_code_tour_update, true);
  assert.equal(needsApproval.set_active_branch, true);
});

test('git tools via mock GitHub API: connect, list, create, update, labels, code tour, comment, review', async () => {
  const { fetchFn, calls } = mockGitHubFetch();
  const tools = createGitTools({ getGitHubToken: () => 'test-token-123', fetchFn });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-git-'));

  const connected = await toolByName(tools, 'git_host_connect').execute({}, ctx(dir));
  assert.match(connected, /GitHub connected as "octocat"/);
  assert.match(connected, /octocat\/hello-world/);
  assert.match(connected, /\(private\)/);
  assert.doesNotMatch(connected, /test-token-123/);

  const listed = await toolByName(tools, 'pr_list').execute(
    { owner: 'octocat', repo: 'hello-world' },
    ctx(dir),
  );
  assert.match(listed, /#7 Fix bug/);
  assert.match(listed, /\[bug\]/);

  const created = await toolByName(tools, 'pr_create').execute(
    { owner: 'octocat', repo: 'hello-world', title: 'New feature', head: 'feat', base: 'main', body: 'adds it' },
    ctx(dir),
  );
  assert.match(created, /#8 New feature/);

  const updated = await toolByName(tools, 'pr_update').execute(
    { owner: 'octocat', repo: 'hello-world', number: 7, title: 'Fix bug v2', state: 'open' },
    ctx(dir),
  );
  assert.match(updated, /Fix bug v2/);

  const labels = await toolByName(tools, 'pr_label_set').execute(
    { owner: 'octocat', repo: 'hello-world', number: 7, labels: ['bug', 'v0.7'] },
    ctx(dir),
  );
  assert.match(labels, /bug, v0\.7/);

  const tour = await toolByName(tools, 'pr_code_tour_view').execute(
    { owner: 'octocat', repo: 'hello-world', number: 7 },
    ctx(dir),
  );
  assert.match(tour, /Code tour for octocat\/hello-world#7/);
  assert.match(tour, /src\/a\.ts \(modified, \+10\/-2\)/);
  assert.match(tour, /Looks good/);

  const comment = await toolByName(tools, 'pr_code_tour_update').execute(
    { owner: 'octocat', repo: 'hello-world', number: 7, body: 'Nice work' },
    ctx(dir),
  );
  assert.match(comment, /Comment added.*comment id 21/);

  const inline = await toolByName(tools, 'pr_code_tour_update').execute(
    { owner: 'octocat', repo: 'hello-world', number: 7, body: 'nit here', path: 'src/a.ts', line: 3, commitId: 'abc123' },
    ctx(dir),
  );
  assert.match(inline, /inline at src\/a\.ts:3/);

  const review = await toolByName(tools, 'pr_code_tour_update').execute(
    { owner: 'octocat', repo: 'hello-world', number: 7, body: 'Approved', reviewEvent: 'APPROVE' },
    ctx(dir),
  );
  assert.match(review, /APPROVE \(review id 31/);

  // Every call carried the Bearer token; no result leaks it.
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.auth === 'Bearer test-token-123'));

  // 404 surfaces as a clear error string.
  const missing = await toolByName(tools, 'pr_list').execute(
    { owner: 'octocat', repo: 'missing' },
    ctx(dir),
  );
  assert.match(missing, /^Error: GitHub API error 404/);
});

test('git tools: no token wired -> clear error, not a throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-git-'));
  const out = await toolByName(GIT_TOOLS, 'git_host_connect').execute({}, ctx(dir));
  assert.match(out, /^Error: No GitHub token is wired up/);
});

test('GitHubClient: invalid owner/repo rejected before any request', async () => {
  let fetched = 0;
  const client = new GitHubClient({
    getToken: () => 't',
    fetchFn: async () => {
      fetched += 1;
      return jsonResponse([]);
    },
  });
  await assert.rejects(() => client.listPullRequests('bad owner!', 'r'), /Invalid GitHub owner/);
  assert.equal(fetched, 0);
});

// ---------------------------------------------------------------------------
// set_active_branch — real git on a temp repo
// ---------------------------------------------------------------------------

function initTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-branch-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com" && git config user.name "Test"', {
    cwd: dir,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n', 'utf8');
  execSync('git add . && git commit -m init', { cwd: dir, stdio: 'pipe' });
  execSync('git checkout -b feature/x', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n', 'utf8');
  execSync('git add . && git commit -m feature', { cwd: dir, stdio: 'pipe' });
  execSync('git checkout main', { cwd: dir, stdio: 'pipe' });
  return dir;
}

test('set_active_branch: real git checkout on a temp repo; rejects unknown branch / bad name / non-repo', async () => {
  const dir = initTempRepo();
  const tools = createGitTools({ getGitHubToken: () => 'unused' });
  const current = () =>
    execSync('git branch --show-current', { cwd: dir, encoding: 'utf8' }).trim();

  assert.equal(current(), 'main');
  const out = await toolByName(tools, 'set_active_branch').execute(
    { branch: 'feature/x' },
    ctx(dir),
  );
  assert.match(out, /Active branch is now "feature\/x"/);
  assert.equal(current(), 'feature/x');

  const missing = await toolByName(tools, 'set_active_branch').execute(
    { branch: 'no-such-branch' },
    ctx(dir),
  );
  assert.match(missing, /does not exist/);
  assert.equal(current(), 'feature/x');

  const bad = await toolByName(tools, 'set_active_branch').execute(
    { branch: '../evil' },
    ctx(dir),
  );
  assert.match(bad, /Invalid branch name/);

  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-norepo-'));
  const notRepo = await toolByName(tools, 'set_active_branch').execute(
    { branch: 'main' },
    ctx(plainDir),
  );
  assert.match(notRepo, /not a git repository/);
});
