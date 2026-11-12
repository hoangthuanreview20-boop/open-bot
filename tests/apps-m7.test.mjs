/**
 * Tests for M7 connected apps (v0.49): unified app catalog, OAuth
 * once shared by every bot, auth status, per-app tool cap, and the
 * coordinator RPC (apps.setSharedToken / apps.revokeSharedToken /
 * apps.listStatuses).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/apps-m7.test.mjs
 *
 * No live network, no real accounts or credentials: tokens are fake
 * strings ('xoxb-shared', 'ya29-fake'), the Slack/Gmail APIs and the
 * OAuth token endpoint are mock fetch functions, the Vault used is a
 * temp dir, and workspaces are temp dirs.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AppRegistry,
  BUILTIN_APPS,
  DEFAULT_APP_TOOL_CAP,
  SharedAppAuthStore,
  applyAppToolCaps,
  capAppTools,
  deriveAppAuthStatus,
  getAppToolNames,
  listApps,
} from '../packages/core/dist/apps/index.js';
import { getConnector, vaultTokenStore } from '../packages/core/dist/connectors/framework.js';
import { Vault } from '../packages/core/dist/vault/vault.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import {
  INTEGRATION_TOOLS,
  createAppTools,
  createIntegrationTools,
} from '../packages/tools/dist/integrationTools.js';

const SLACK_API = 'https://slack.com/api';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** In-memory TokenStore (fake Vault) for store-level tests. */
function memoryTokenStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async getToken(id) {
      const v = map.get(id);
      return v ? { ...v } : null;
    },
    async setToken(id, token) {
      map.set(id, { ...token });
    },
    async clearToken(id) {
      map.delete(id);
    },
  };
}

const EXPIRED = new Date(Date.now() - 60_000).toISOString();
const FRESH = new Date(Date.now() + 3600_000).toISOString();

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test('catalog: 6 built-in apps, tool names match the real integration tools', () => {
  const apps = listApps();
  assert.deepEqual(
    apps.map((a) => a.id),
    ['slack', 'gmail', 'teams', 'imessage', 'meeting', 'github'],
  );
  // Every catalog tool name must be a real tool in integrationTools.ts.
  const realNames = new Set(INTEGRATION_TOOLS.map((t) => t.definition.name));
  for (const app of apps) {
    assert.ok(app.tools.length >= 1, `${app.id} must list at least one tool`);
    for (const tool of app.tools) {
      assert.ok(realNames.has(tool.name), `catalog tool ${tool.name} must be a real tool`);
    }
  }
  assert.deepEqual(getAppToolNames('slack'), ['slack_send', 'slack_list_channels', 'slack_read']);
  assert.deepEqual(getAppToolNames('gmail'), ['email_read', 'email_send']);
  assert.deepEqual(getAppToolNames('teams'), ['teams_send', 'teams_list_teams']);
  assert.deepEqual(getAppToolNames('imessage'), ['imessage_draft']);
  assert.deepEqual(getAppToolNames('meeting'), ['meeting_transcript', 'meeting_summarize']);
  // v0.68b: GitHub — the 7 real GitHub API tools from gitTools.ts.
  // set_active_branch is a local git checkout, not a GitHub API tool,
  // so it stays outside the catalog (still a real integration tool).
  assert.deepEqual(getAppToolNames('github'), [
    'git_host_connect',
    'pr_list',
    'pr_create',
    'pr_update',
    'pr_label_set',
    'pr_code_tour_view',
    'pr_code_tour_update',
  ]);
  assert.ok(realNames.has('set_active_branch'), 'set_active_branch stays a real integration tool');
  assert.deepEqual(getAppToolNames('no-such-app'), []);
  // OAuth apps point at a real connector; local apps need no auth;
  // token apps declare their Vault location and no connector.
  for (const app of apps) {
    if (app.authType === 'oauth2') assert.ok(app.connectorId, `${app.id} needs a connectorId`);
    else assert.equal(app.connectorId, undefined);
    if (app.authType === 'token') {
      assert.ok(app.vaultNamespace, `${app.id} needs a vaultNamespace`);
      assert.ok(app.vaultKey, `${app.id} needs a vaultKey`);
    } else {
      assert.equal(app.vaultNamespace, undefined, `${app.id} must not declare a vaultNamespace`);
      assert.equal(app.vaultKey, undefined, `${app.id} must not declare a vaultKey`);
    }
  }
  assert.deepEqual(
    apps.filter((a) => a.authType === 'none').map((a) => a.id),
    ['imessage', 'meeting'],
  );
  assert.deepEqual(
    apps.filter((a) => a.authType === 'token').map((a) => a.id),
    ['github'],
  );
  const github = apps.find((a) => a.id === 'github');
  assert.equal(github.vaultNamespace, 'github');
  assert.equal(github.vaultKey, 'token');
});

test('catalog: every OAuth2 app points at a registered connector definition', () => {
  // Guard added in v0.67c (catalog expansion review 5 -> 10): an oauth2
  // entry is only honest when its connectorId resolves to a real
  // ConnectorDefinition in connectors/framework.ts (authUrl + tokenUrl
  // for the login flow, token stored under Vault namespace 'connector').
  // A catalog entry naming a connector that does not exist (e.g. a
  // future 'github' or 'notion' entry without its connector) would show
  // a Connect button that can never succeed and a status stuck at
  // 'not_connected'. Nine connectors are registered today (slack/gmail/
  // teams + google/jira/linear/hubspot/asana/discord, v0.72a Team A), so
  // a future catalog OAuth2 app may point at any of them — but only
  // once the app has real local tools (a catalog-only entry without
  // tools is still dishonest, see the tool guard above).
  for (const app of listApps()) {
    if (app.authType !== 'oauth2') continue;
    const def = getConnector(app.connectorId);
    assert.ok(def, `OAuth2 app "${app.id}" needs a registered connector "${app.connectorId}"`);
    assert.equal(def.authType, 'oauth2');
    assert.ok(def.authUrl, `connector "${app.connectorId}" needs an authUrl`);
    assert.ok(def.tokenUrl, `connector "${app.connectorId}" needs a tokenUrl`);
  }
  assert.deepEqual(
    listApps()
      .filter((a) => a.authType === 'oauth2')
      .map((a) => a.connectorId),
    ['slack', 'gmail', 'teams'],
  );
});

test('catalog: token apps declare a Vault namespace/key and no connectorId', () => {
  // Guard added in v0.68b (GitHub, the 6th M7 app): a token app is
  // only honest when it says exactly where its PAT lives in the Vault
  // (vaultNamespace + vaultKey, e.g. 'github'/'token'). A token app
  // without that location would show a PAT form that saves nowhere,
  // and a token app with a connectorId would be read from the wrong
  // Vault namespace ('connector') and stuck at 'not_connected' — the
  // exact failure the v0.67c review found for a hypothetical oauth2
  // 'github' entry. Non-token apps must not declare a Vault location
  // either, so one app never has two token sources.
  const registry = new AppRegistry(BUILTIN_APPS);
  assert.equal(registry.size(), 6);
  assert.throws(
    () =>
      registry.register({
        id: 'bad-token',
        label: 'Bad Token',
        description: '',
        icon: 'B',
        authType: 'token',
        tools: [{ name: 'bad_tool', description: '', needsApproval: false }],
      }),
    /needs a valid vaultNamespace/,
  );
  assert.throws(
    () =>
      registry.register({
        id: 'bad-token',
        label: 'Bad Token',
        description: '',
        icon: 'B',
        authType: 'token',
        vaultNamespace: 'badns',
        tools: [{ name: 'bad_tool', description: '', needsApproval: false }],
      }),
    /needs a valid vaultKey/,
  );
  assert.throws(
    () =>
      registry.register({
        id: 'bad-token',
        label: 'Bad Token',
        description: '',
        icon: 'B',
        authType: 'token',
        connectorId: 'slack',
        vaultNamespace: 'badns',
        vaultKey: 'token',
        tools: [{ name: 'bad_tool', description: '', needsApproval: false }],
      }),
    /must not have a connectorId/,
  );
  assert.throws(
    () =>
      registry.register({
        id: 'bad-oauth',
        label: 'Bad OAuth',
        description: '',
        icon: 'B',
        authType: 'oauth2',
        connectorId: 'slack',
        vaultNamespace: 'badns',
        vaultKey: 'token',
        tools: [{ name: 'bad_tool', description: '', needsApproval: false }],
      }),
    /must not declare a Vault token location/,
  );
  assert.throws(
    () =>
      registry.register({
        id: 'bad-local',
        label: 'Bad Local',
        description: '',
        icon: 'B',
        authType: 'none',
        vaultNamespace: 'badns',
        vaultKey: 'token',
        tools: [{ name: 'bad_tool', description: '', needsApproval: false }],
      }),
    /must not declare a Vault token location/,
  );
  // A well-formed token app registers fine.
  registry.register({
    id: 'good-token',
    label: 'Good Token',
    description: '',
    icon: 'G',
    authType: 'token',
    vaultNamespace: 'goodns',
    vaultKey: 'token',
    tools: [{ name: 'good_tool', description: '', needsApproval: false }],
  });
  assert.equal(registry.size(), 7);
  assert.equal(registry.unregister('good-token'), true);
});

test('catalog: a new app registers without touching core; duplicates and tool theft throw', () => {
  const registry = new AppRegistry(BUILTIN_APPS);
  assert.equal(registry.size(), 6);
  registry.register({
    id: 'notion',
    label: 'Notion',
    description: 'Fake app for the test.',
    icon: 'N',
    authType: 'oauth2',
    connectorId: 'notion',
    tools: [{ name: 'notion_read', description: 'Read a page.', needsApproval: false }],
  });
  assert.equal(registry.size(), 7);
  assert.deepEqual(registry.toolNamesForApp('notion'), ['notion_read']);
  assert.equal(registry.appIdForTool('notion_read'), 'notion');
  assert.throws(
    () =>
      registry.register({
        id: 'notion',
        label: 'Notion again',
        description: '',
        icon: 'N',
        authType: 'none',
        tools: [],
      }),
    /already registered/,
  );
  assert.throws(
    () =>
      registry.register({
        id: 'thief',
        label: 'Thief',
        description: '',
        icon: 'T',
        authType: 'none',
        tools: [{ name: 'slack_send', description: 'stolen', needsApproval: false }],
      }),
    /already belongs to app "slack"/,
  );
  assert.equal(registry.unregister('notion'), true);
  assert.equal(registry.has('notion'), false);
  assert.equal(registry.appIdForTool('notion_read'), undefined);
});

test('tools: createAppTools groups the existing tools by catalog app, logic unchanged', () => {
  const slack = createAppTools('slack', {});
  assert.deepEqual(
    slack.map((t) => t.definition.name),
    ['slack_send', 'slack_list_channels', 'slack_read'],
  );
  const gmail = createAppTools('gmail', {});
  assert.deepEqual(
    gmail.map((t) => t.definition.name),
    ['email_read', 'email_send'],
  );
  // Unbound placeholders behave as before: no token -> clear "not connected".
  assert.equal(createIntegrationTools().length, INTEGRATION_TOOLS.length);
  assert.throws(() => createAppTools('no-such-app', {}), /Không rõ app/);
});

test('tools: createAppTools github returns the 7 real GitHub API tools, wired to the PAT', async () => {
  // v0.68b: the 6th M7 app. The catalog names must match the real git
  // tools, the approval flags must match gitTools.ts exactly, and the
  // tools must run against a mock GitHub API with the PAT from
  // getGitHubToken (Vault 'github'/'token' in production) — never a
  // real token: the fake here is visibly fake ('ghp_test_...').
  const github = createAppTools('github', {
    getGitHubToken: () => 'ghp_test_fake_token',
    fetchFn: async (url, init = {}) => {
      const urlStr = String(url);
      assert.ok(urlStr.startsWith('https://api.github.com'), `unexpected URL ${urlStr}`);
      assert.equal(
        init.headers?.Authorization,
        'Bearer ghp_test_fake_token',
        'GitHub API must be called with the PAT',
      );
      const body = urlStr.includes('/user/repos')
        ? [{ full_name: 'octocat/hello-world', private: false, default_branch: 'main', description: 'demo' }]
        : { login: 'octocat' };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    },
  });
  assert.deepEqual(
    github.map((t) => t.definition.name),
    [
      'git_host_connect',
      'pr_list',
      'pr_create',
      'pr_update',
      'pr_label_set',
      'pr_code_tour_view',
      'pr_code_tour_update',
    ],
  );
  assert.deepEqual(
    Object.fromEntries(github.map((t) => [t.definition.name, t.needsApproval])),
    {
      git_host_connect: false,
      pr_list: false,
      pr_create: true,
      pr_update: true,
      pr_label_set: true,
      pr_code_tour_view: false,
      pr_code_tour_update: true,
    },
  );
  const byName = new Map(github.map((t) => [t.definition.name, t]));
  const out = await byName
    .get('git_host_connect')
    .execute({}, { workspaceDir: tmpDir('open-bot-apps-m7-github-'), botId: 'bot-github' });
  assert.match(out, /GitHub connected as "octocat"/);
  assert.match(out, /octocat\/hello-world/);
  assert.doesNotMatch(out, /ghp_test_fake_token/, 'tool output must never leak the PAT');
  // set_active_branch is a local git checkout, not a GitHub API tool:
  // it rides along in createIntegrationTools but is NOT a github app tool.
  assert.equal(byName.has('set_active_branch'), false);
  const all = createIntegrationTools({ getGitHubToken: () => 'ghp_test_fake_token' });
  assert.ok(all.some((t) => t.definition.name === 'set_active_branch'));
  // Unbound: no PAT callback -> the API tools report the missing token
  // clearly instead of calling GitHub.
  const unbound = createAppTools('github', {});
  const missing = await unbound[0].execute(
    {},
    { workspaceDir: tmpDir('open-bot-apps-m7-github-'), botId: 'bot-github' },
  );
  assert.match(missing, /Error: /);
  assert.match(missing, /GitHub token/);
});

// ---------------------------------------------------------------------------
// Auth status derivation (pure)
// ---------------------------------------------------------------------------

test('auth status: not_connected / connected / expired / error from the stored TokenSet', () => {
  assert.equal(deriveAppAuthStatus(null), 'not_connected');
  assert.equal(deriveAppAuthStatus({ accessToken: 'x' }), 'connected');
  assert.equal(deriveAppAuthStatus({ accessToken: 'x', expiresAt: FRESH }), 'connected');
  assert.equal(
    deriveAppAuthStatus({ accessToken: 'x', expiresAt: EXPIRED }),
    'expired',
  );
  // Expired but refreshable -> connected (the framework refreshes on use).
  assert.equal(
    deriveAppAuthStatus({ accessToken: 'x', expiresAt: EXPIRED, refreshToken: 'r1' }),
    'connected',
  );
  assert.equal(deriveAppAuthStatus({ accessToken: 'x', expiresAt: 'not-a-date' }), 'error');
});

// ---------------------------------------------------------------------------
// SharedAppAuthStore (fake TokenStore)
// ---------------------------------------------------------------------------

test('shared auth: one connect serves every bot; revoke cuts every bot off at once', async () => {
  const store = new SharedAppAuthStore({ store: memoryTokenStore() });
  assert.equal(await store.getStatus('slack'), 'not_connected');
  assert.equal(await store.getAccessToken('slack'), null);

  await store.connect('slack', { accessToken: 'xoxb-shared' }, 'team@example.com');
  assert.equal(await store.getStatus('slack'), 'connected');
  assert.equal(store.getAccountLabel('slack'), 'team@example.com');
  // Bot A and bot B read the same shared token (no per-bot copy).
  assert.equal(await store.getAccessToken('slack'), 'xoxb-shared');
  assert.equal(await store.getAccessToken('slack'), 'xoxb-shared');

  const statuses = await store.listStatuses();
  assert.equal(statuses.length, 6);
  const slack = statuses.find((s) => s.app.id === 'slack');
  assert.equal(slack.authStatus, 'connected');
  assert.equal(slack.accountLabel, 'team@example.com');
  assert.equal(slack.toolCap, DEFAULT_APP_TOOL_CAP);
  assert.equal(slack.exposedToolCount, 3);
  assert.deepEqual(slack.cappedOutToolNames, []);
  // Local apps never need auth.
  assert.equal(statuses.find((s) => s.app.id === 'imessage').authStatus, 'local');
  assert.equal(statuses.find((s) => s.app.id === 'meeting').authStatus, 'local');
  // No token is ever exposed through the status view.
  assert.ok(!JSON.stringify(statuses).includes('xoxb-shared'), 'status must not leak the token');

  assert.equal(await store.disconnect('slack'), true);
  assert.equal(await store.getStatus('slack'), 'not_connected');
  assert.equal(await store.getAccessToken('slack'), null);
  assert.equal(store.getAccountLabel('slack'), undefined);
  assert.equal(await store.disconnect('slack'), false, 'second revoke reports nothing to revoke');
});

test('shared auth: expired token without refresh token is expired and getAccessToken throws', async () => {
  const store = new SharedAppAuthStore({ store: memoryTokenStore() });
  await store.connect('gmail', { accessToken: 'ya29-old', expiresAt: EXPIRED });
  assert.equal(await store.getStatus('gmail'), 'expired');
  await assert.rejects(store.getAccessToken('gmail'), /hết hạn/);
  assert.equal(await store.getStatus('gmail'), 'error', 'failed fetch marks the error state');
});

test('shared auth: expired token with refresh token refreshes via a fake token endpoint', async () => {
  const backing = memoryTokenStore();
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), GMAIL_TOKEN_URL);
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'refresh-9');
    assert.equal(form.get('client_id'), 'gmail-client-id');
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'ya29-fresh', expires_in: 3600, token_type: 'Bearer' }),
      text: async () => JSON.stringify({ access_token: 'ya29-fresh' }),
    };
  };
  const store = new SharedAppAuthStore({ store: backing, fetchFn });
  store.setClientConfig('gmail', { clientId: 'gmail-client-id' });
  await store.connect('gmail', {
    accessToken: 'ya29-old',
    refreshToken: 'refresh-9',
    expiresAt: EXPIRED,
  });
  assert.equal(await store.getAccessToken('gmail'), 'ya29-fresh');
  assert.equal(calls.length, 1, 'exactly one refresh');
  const stored = await backing.getToken('gmail');
  assert.equal(stored.accessToken, 'ya29-fresh');
  assert.equal(stored.refreshToken, 'refresh-9', 'refresh token retained when not rotated');
  assert.equal(await store.getStatus('gmail'), 'connected');
});

test('shared auth: malformed stored token is an error, not a silent not-connected', async () => {
  const backing = memoryTokenStore({ slack: { accessToken: '' } });
  const store = new SharedAppAuthStore({ store: backing });
  assert.equal(await store.getTokenSet('slack'), null);
  assert.equal(await store.getStatus('slack'), 'error');
  assert.match(store.getError('slack'), /hỏng định dạng/);
});

test('shared auth: connect validates the app and the token; caps validate', async () => {
  const store = new SharedAppAuthStore({ store: memoryTokenStore() });
  await assert.rejects(store.connect('no-such-app', { accessToken: 'x' }), /Không rõ app/);
  await assert.rejects(store.connect('slack', { accessToken: '' }), /thiếu accessToken/);
  await assert.rejects(store.connect('imessage', { accessToken: 'x' }), /không dùng OAuth/);
  await assert.rejects(store.disconnect('imessage'), /không dùng OAuth/);
  assert.throws(() => store.setToolCap('slack', 0), /1\.\.100/);
  assert.throws(() => store.setToolCap('slack', 101), /1\.\.100/);
  assert.throws(() => store.setToolCap('no-such-app', 5), /Không rõ app/);
  store.setToolCap('slack', 2);
  assert.equal(store.getToolCap('slack'), 2);
  assert.equal(store.getToolCap('gmail'), DEFAULT_APP_TOOL_CAP);
});

test('shared auth (token app): GitHub PAT status follows the plain-token store, never leaks the token', async () => {
  // v0.68b: the 6th M7 app authenticates with a PAT the user pastes
  // (Vault 'github'/'token' in production). The store reads it through
  // the host-wired getPlainToken callback — no OAuth, no expiry. v0.70:
  // computing the status revalidates the PAT against api.github.com,
  // so this test injects a mock fetch (200 + login) and never touches
  // the real network. The fake PAT below is visibly fake
  // ('ghp_test_...'); no real token is used anywhere.
  let plainToken = null;
  let failReads = false;
  const store = new SharedAppAuthStore({
    store: memoryTokenStore(),
    // v0.70: mock GitHub validation (200 + login) — getStatus must
    // not call the real api.github.com for a fake PAT.
    githubPatFetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ login: 'octocat' }),
      text: async () => '{"login":"octocat"}',
    }),
    getPlainToken: async (namespace, key) => {
      assert.equal(namespace, 'github');
      assert.equal(key, 'token');
      if (failReads) throw new Error('Vault read failed (test)');
      return plainToken;
    },
    setPlainToken: async (namespace, key, value) => {
      assert.equal(namespace, 'github');
      assert.equal(key, 'token');
      plainToken = value;
    },
    clearPlainToken: async (namespace, key) => {
      assert.equal(namespace, 'github');
      assert.equal(key, 'token');
      plainToken = null;
    },
  });

  assert.equal(await store.getStatus('github'), 'not_connected');
  assert.equal(await store.getAccessToken('github'), null);

  await store.connectPlainToken('github', 'ghp_test_fake_token');
  assert.equal(await store.getStatus('github'), 'connected');
  assert.equal(await store.getAccessToken('github'), 'ghp_test_fake_token');

  const statuses = await store.listStatuses();
  assert.equal(statuses.length, 6);
  const github = statuses.find((s) => s.app.id === 'github');
  assert.equal(github.authStatus, 'connected');
  assert.equal(github.exposedToolCount, 7);
  assert.deepEqual(github.cappedOutToolNames, []);
  assert.ok(!JSON.stringify(statuses).includes('ghp_test_fake_token'), 'status must not leak the PAT');

  // A read failure is an error, not a silent not-connected.
  failReads = true;
  assert.equal(await store.getStatus('github'), 'error');
  assert.match(store.getError('github'), /Vault read failed/);
  await assert.rejects(store.getAccessToken('github'), /Vault read failed/);
  // Like the OAuth path, the error sticks until a successful reconnect
  // clears it — a healthy read alone does not clear it.
  failReads = false;
  assert.equal(await store.getStatus('github'), 'error');
  await store.connectPlainToken('github', 'ghp_test_fake_token');
  assert.equal(await store.getStatus('github'), 'connected');

  // Revoke cuts every bot off at once; a second revoke reports nothing.
  assert.equal(await store.disconnect('github'), true);
  assert.equal(await store.getStatus('github'), 'not_connected');
  assert.equal(await store.getAccessToken('github'), null);
  assert.equal(await store.disconnect('github'), false);

  // Validation: empty PAT, wrong app kind, unknown app.
  await assert.rejects(store.connectPlainToken('github', '   '), /token PAT rỗng/);
  await assert.rejects(store.connectPlainToken('slack', 'ghp_test_x'), /không dùng token PAT/);
  await assert.rejects(store.connectPlainToken('no-such-app', 'ghp_test_x'), /Không rõ app/);
  await assert.rejects(store.connect('github', { accessToken: 'x' }), /không dùng OAuth/);
});

test('shared auth (token app): disconnect without a wired plain-token store is a clear error', async () => {
  // No getPlainToken/setPlainToken/clearPlainToken wired: status
  // fail-closes to not_connected, connect/disconnect refuse loudly
  // instead of pretending to save a token nowhere.
  const store = new SharedAppAuthStore({ store: memoryTokenStore() });
  assert.equal(await store.getStatus('github'), 'not_connected');
  await assert.rejects(
    store.connectPlainToken('github', 'ghp_test_fake_token'),
    /host chưa nối kho token PAT/,
  );
  await assert.rejects(store.disconnect('github'), /host chưa nối kho token PAT/);
});

test('shared auth: Vault-backed store persists the shared token once, revoke removes it', async () => {
  const dir = tmpDir('open-bot-apps-m7-vault-');
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.key'),
  });
  const store = new SharedAppAuthStore({ store: vaultTokenStore(vault) });
  await store.connect('teams', { accessToken: 'graph-shared' }, 'user@example.com');
  const raw = vault.getSecret('connector', 'teams');
  assert.ok(raw, 'token must be in the Vault under namespace connector');
  assert.equal(JSON.parse(raw).accessToken, 'graph-shared');
  // A second store over the same Vault sees the same token (shared, not per-bot).
  const second = new SharedAppAuthStore({ store: vaultTokenStore(vault) });
  assert.equal(await second.getAccessToken('teams'), 'graph-shared');
  await store.disconnect('teams');
  assert.equal(vault.getSecret('connector', 'teams'), null);
  assert.equal(await store.getAccessToken('teams'), null);
  // One TokenStore has one SharedAppAuthStore instance per process (the
  // coordinator owns its single instance); a fresh instance over the
  // same Vault after revoke sees nothing — no stale token survives.
  const third = new SharedAppAuthStore({ store: vaultTokenStore(vault) });
  assert.equal(await third.getAccessToken('teams'), null);
});

// ---------------------------------------------------------------------------
// Per-app tool cap
// ---------------------------------------------------------------------------

function fakeTool(name) {
  return { definition: { name, description: '', parameters: { type: 'object', properties: {} } } };
}

test('tool cap: default 10 per app, catalog order kept, non-app tools untouched', () => {
  assert.equal(DEFAULT_APP_TOOL_CAP, 10);
  const registry = new AppRegistry();
  registry.register({
    id: 'big',
    label: 'Big',
    description: '',
    icon: 'B',
    authType: 'none',
    tools: Array.from({ length: 12 }, (_, i) => ({
      name: `big_tool_${i + 1}`,
      description: '',
      needsApproval: false,
    })),
  });
  const tools = [
    ...Array.from({ length: 12 }, (_, i) => fakeTool(`big_tool_${i + 1}`)),
    fakeTool('read_file'),
    fakeTool('slack_send'),
  ];
  const { tools: kept, capped } = applyAppToolCaps(tools, {}, registry);
  assert.deepEqual(
    kept.map((t) => t.definition.name),
    [
      ...Array.from({ length: 10 }, (_, i) => `big_tool_${i + 1}`),
      'read_file',
      'slack_send',
    ],
  );
  assert.equal(capped.length, 1);
  assert.equal(capped[0].appId, 'big');
  assert.equal(capped[0].cap, 10);
  assert.equal(capped[0].exposedCount, 10);
  assert.deepEqual(capped[0].droppedToolNames, ['big_tool_11', 'big_tool_12']);
  // Per-app override.
  const capped2 = applyAppToolCaps(tools, { big: 2 }, registry);
  assert.equal(capped2.tools.filter((t) => t.definition.name.startsWith('big_tool_')).length, 2);
  assert.deepEqual(capped2.capped[0].droppedToolNames.slice(0, 2), ['big_tool_3', 'big_tool_4']);
  // The default registry caps slack at 10: its 3 tools all survive.
  const slackOnly = applyAppToolCaps(
    ['slack_send', 'slack_list_channels', 'slack_read'].map(fakeTool),
  );
  assert.equal(slackOnly.tools.length, 3);
  assert.deepEqual(slackOnly.capped, []);
});

test('tool cap: capAppTools cuts one app list to the cap, cap 0 cuts everything', () => {
  const tools = [fakeTool('a'), fakeTool('b'), fakeTool('c')];
  assert.deepEqual(capAppTools(tools, 2).tools.map((t) => t.definition.name), ['a', 'b']);
  assert.deepEqual(capAppTools(tools, 2).droppedToolNames, ['c']);
  assert.deepEqual(capAppTools(tools, 10).tools, tools);
  assert.deepEqual(capAppTools(tools, 10).droppedToolNames, []);
  assert.deepEqual(capAppTools(tools, 0).tools, []);
  assert.deepEqual(capAppTools(tools, 0).droppedToolNames, ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// Coordinator RPC + end-to-end sharing across two bots (mock fetch)
// ---------------------------------------------------------------------------

function botConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function mockProvider() {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] };
}

/** Mock fetch: Slack API only; asserts the Authorization header each call. */
function slackMockFetch(expectedToken) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });
    assert.ok(urlStr.startsWith(SLACK_API), `unexpected URL ${urlStr}`);
    assert.equal(
      init.headers?.Authorization,
      `Bearer ${expectedToken}`,
      'Slack API must be called with the shared token',
    );
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }] }),
      text: async () => JSON.stringify({ ok: true }),
    };
  };
  return { calls, fetchFn };
}

async function withMockFetch(fetchFn, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('coordinator RPC: one shared token serves bot A + bot B; revoke cuts both off at once', async () => {
  const coordinator = new AgentCoordinator({});
  const wsA = tmpDir('open-bot-apps-m7-bot-a-');
  const wsB = tmpDir('open-bot-apps-m7-bot-b-');
  await coordinator.createBot({ bot: botConfig('bot-a', wsA), provider: mockProvider() });
  await coordinator.createBot({ bot: botConfig('bot-b', wsB), provider: mockProvider() });

  // Before connect: both bots report "not connected".
  const before = await coordinator.runTool({ botId: 'bot-a', tool: 'slack_list_channels', args: {} });
  assert.match(before.output, /Chưa kết nối/);

  // Connect ONCE via RPC, after both bots already exist (v0.19 gap).
  const connected = await coordinator.handle('apps.setSharedToken', {
    appId: 'slack',
    token: { accessToken: 'xoxb-shared' },
    accountLabel: 'team@example.com',
  });
  assert.equal(connected.authStatus, 'connected');
  assert.equal(connected.accountLabel, 'team@example.com');
  assert.ok(!JSON.stringify(connected).includes('xoxb-shared'), 'RPC status must not leak the token');

  // Both bots now call Slack with the SAME shared token.
  const { calls, fetchFn } = slackMockFetch('xoxb-shared');
  await withMockFetch(fetchFn, async () => {
    const outA = await coordinator.runTool({ botId: 'bot-a', tool: 'slack_list_channels', args: {} });
    assert.match(outA.output, /general/);
    const outB = await coordinator.runTool({ botId: 'bot-b', tool: 'slack_list_channels', args: {} });
    assert.match(outB.output, /general/);
  });
  assert.equal(calls.length, 2, 'one Slack call per bot, same token');

  // listStatuses via RPC: slack connected, local apps local.
  const statuses = await coordinator.handle('apps.listStatuses', {});
  assert.equal(statuses.length, 6);
  assert.equal(statuses.find((s) => s.app.id === 'slack').authStatus, 'connected');
  assert.equal(statuses.find((s) => s.app.id === 'imessage').authStatus, 'local');

  // Revoke ONCE via RPC: both bots lose access immediately.
  const revoked = await coordinator.handle('apps.revokeSharedToken', { appId: 'slack' });
  assert.equal(revoked.authStatus, 'not_connected');
  const afterA = await coordinator.runTool({ botId: 'bot-a', tool: 'slack_list_channels', args: {} });
  assert.match(afterA.output, /Chưa kết nối/);
  const afterB = await coordinator.runTool({ botId: 'bot-b', tool: 'slack_list_channels', args: {} });
  assert.match(afterB.output, /Chưa kết nối/);
  assert.equal(calls.length, 2, 'no Slack call after revoke');
});

/** Mock fetch: GitHub API only; asserts the Authorization header each call. */
function githubMockFetch(expectedToken) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });
    assert.ok(urlStr.startsWith('https://api.github.com'), `unexpected URL ${urlStr}`);
    assert.equal(
      init.headers?.Authorization,
      `Bearer ${expectedToken}`,
      'GitHub API must be called with the PAT',
    );
    const body = urlStr.includes('/user/repos')
      ? [{ full_name: 'octocat/hello-world', private: false, default_branch: 'main', description: 'demo' }]
      : { login: 'octocat' };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, fetchFn };
}

test('coordinator RPC: one shared PAT serves the GitHub tools; revoke cuts them off at once', async () => {
  // v0.68b: the 6th M7 app. Main saves the PAT to the Vault, then seeds
  // the coordinator through apps.setPlainToken (RPC); bots created
  // before the connect use the new token immediately, because the git
  // tools read host.getGitHubToken at call time. The fake PAT is
  // visibly fake ('ghp_test_...'); no real token is used anywhere.
  const coordinator = new AgentCoordinator({});
  const wsA = tmpDir('open-bot-apps-m7-github-bot-a-');
  await coordinator.createBot({ bot: botConfig('bot-a', wsA), provider: mockProvider() });

  // Before connect: the tool reports the missing token clearly.
  const before = await coordinator.runTool({ botId: 'bot-a', tool: 'git_host_connect', args: {} });
  assert.match(before.output, /GitHub token/);

  // Connect ONCE via RPC, after the bot already exists.
  // Connect ONCE via RPC, after the bot already exists.
  // v0.70: setPlainToken returns the revalidated status, so the RPC
  // runs under the GitHub mock fetch (200 + login) — never the real
  // api.github.com for a fake PAT.
  const { calls: validateCalls, fetchFn: validateFetch } = githubMockFetch('ghp_test_fake_token');
  const connected = await withMockFetch(validateFetch, () =>
    coordinator.handle('apps.setPlainToken', {
      appId: 'github',
      token: 'ghp_test_fake_token',
    }),
  );
  assert.equal(validateCalls.length, 1, 'one /user validation call on connect');
  assert.equal(connected.authStatus, 'connected');
  assert.ok(!JSON.stringify(connected).includes('ghp_test_fake_token'), 'RPC status must not leak the PAT');

  // The bot now calls the GitHub API with the shared PAT.
  const { calls, fetchFn } = githubMockFetch('ghp_test_fake_token');
  await withMockFetch(fetchFn, async () => {
    const out = await coordinator.runTool({ botId: 'bot-a', tool: 'git_host_connect', args: {} });
    assert.match(out.output, /GitHub connected as "octocat"/);
    assert.match(out.output, /octocat\/hello-world/);
  });
  assert.equal(calls.length, 2, 'one /user + one /user/repos call');

  // listStatuses via RPC: github connected, local apps local.
  const statuses = await coordinator.handle('apps.listStatuses', {});
  assert.equal(statuses.length, 6);
  assert.equal(statuses.find((s) => s.app.id === 'github').authStatus, 'connected');
  assert.equal(statuses.find((s) => s.app.id === 'imessage').authStatus, 'local');

  // Revoke ONCE via RPC: the bot loses access immediately.
  const revoked = await coordinator.handle('apps.revokeSharedToken', { appId: 'github' });
  assert.equal(revoked.authStatus, 'not_connected');
  const after = await coordinator.runTool({ botId: 'bot-a', tool: 'git_host_connect', args: {} });
  assert.match(after.output, /GitHub token/);
  assert.equal(calls.length, 2, 'no GitHub call after revoke');

  // RPC validation: empty token, unknown app, OAuth-shaped connect.
  await assert.rejects(
    coordinator.handle('apps.setPlainToken', { appId: 'github', token: '   ' }),
    /không rỗng/,
  );
  await assert.rejects(
    coordinator.handle('apps.setPlainToken', { appId: 'nope', token: 'ghp_test_x' }),
    /Không rõ app/,
  );
  await assert.rejects(
    coordinator.handle('apps.setPlainToken', { appId: 'slack', token: 'ghp_test_x' }),
    /không dùng token PAT/,
  );
});

test('coordinator RPC: unknown app and local-app token ops are clear errors', async () => {
  const coordinator = new AgentCoordinator({});
  await assert.rejects(
    coordinator.handle('apps.setSharedToken', { appId: 'nope', token: { accessToken: 'x' } }),
    /Không rõ app/,
  );
  await assert.rejects(
    coordinator.handle('apps.revokeSharedToken', { appId: 'imessage' }),
    /không dùng OAuth/,
  );
  await assert.rejects(coordinator.handle('apps.revokeSharedToken', {}), /appId/);
});
