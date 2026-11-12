/**
 * Tests for v0.9d connector OAuth auto-refresh END-TO-END (local, mock
 * fetch only — no live network, no real tokens):
 *
 *   main (Vault TokenSet + client creds, via createBot params)
 *     -> coordinator child (in-process AgentCoordinator here; the NDJSON
 *        layer is covered by tests/coordinator.test.mjs)
 *     -> ConnectorTokenProvider per connector (in-memory TokenStore)
 *     -> integration tools (Slack / Gmail / Teams) via tokenProvider
 *     -> 'connector.oauth-token' event back out (main persists to Vault)
 *
 * Covered:
 *  - Gmail: expired token + refresh token + client config -> proactive
 *    refresh before the call, retry succeeds, event emitted with the new
 *    TokenSet (refresh token retained when the provider does not rotate),
 *    client secret never appears in the event payload, second call reuses
 *    the fresh token without another refresh.
 *  - Slack xoxb (static, no expiry, no refresh token, no client config)
 *    -> used as-is, no token-endpoint call, no event.
 *  - Gmail expired + refresh token but NO client config -> no refresh
 *    attempted, 401 surfaces as TokenExpiredError ("kết nối lại"), no
 *    crash, no token-endpoint call.
 *  - Seed-only: a stale Vault TokenSet passed on a second createBot does
 *    NOT overwrite the live refreshed TokenSet already in memory.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/connector-token-e2e.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const SLACK_API = 'https://slack.com/api';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-conn-e2e-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

/** Coordinator with an event capture (what main's routeCoordinatorEvent sees). */
function makeCoordinator() {
  const events = [];
  const coordinator = new AgentCoordinator({
    emit: (notification) => {
      if (notification.event === 'agent.event') events.push(notification.data);
    },
  });
  return { coordinator, events };
}

function connectorEvents(events) {
  return events.filter((e) => e.kind === 'connector.oauth-token');
}

/**
 * Mock fetch dispatcher. `handlers` maps a URL prefix to a function
 * (url, init) -> { status, body }. Every call is recorded. Responses
 * expose ok/status/json()/text() like a real fetch Response.
 */
function mockFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });
    for (const [prefix, handler] of handlers) {
      if (urlStr.startsWith(prefix)) {
        const out = await handler(urlStr, init);
        const status = out.status ?? 200;
        const body = out.body ?? {};
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        };
      }
    }
    throw new Error(`mock fetch: unexpected URL ${urlStr}`);
  };
  return { calls, fetchFn };
}

function tokenCalls(calls, tokenUrl) {
  return calls.filter((c) => c.url === tokenUrl);
}

/** Install the mock as global fetch for the duration of one test. */
async function withMockFetch(fetchFn, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const EXPIRED = new Date(Date.now() - 60_000).toISOString();
const FRESH = new Date(Date.now() + 3600_000).toISOString();

test('gmail e2e: expired token refreshes proactively, event back, second call reuses fresh token', async () => {
  const { coordinator, events } = makeCoordinator();
  const ws = tmpWorkspace();
  const { calls, fetchFn } = mockFetch([
    [
      GMAIL_TOKEN_URL,
      async (_url, init) => {
        const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'refresh-1');
        assert.equal(form.get('client_id'), 'gmail-client-id');
        assert.equal(form.get('client_secret'), 'gmail-secret-xyz');
        return {
          body: {
            access_token: 'ya29-new',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        };
      },
    ],
    [
      GMAIL_API,
      async (_url, init) => {
        const auth = init.headers?.Authorization ?? '';
        assert.equal(auth, 'Bearer ya29-new', 'API must be called with the refreshed token');
        return { body: { messages: [{ id: 'm1', threadId: 't1' }] } };
      },
    ],
  ]);

  await withMockFetch(fetchFn, async () => {
    const created = await coordinator.createBot({
      bot: botConfig('bot-gmail', ws),
      provider: mockProvider(),
      connectorTokenSets: {
        gmail: { accessToken: 'ya29-old', refreshToken: 'refresh-1', expiresAt: EXPIRED },
      },
      connectorClientConfigs: {
        gmail: { clientId: 'gmail-client-id', clientSecret: 'gmail-secret-xyz' },
      },
    });
    assert.ok(created.toolNames.includes('email_read'));

    // First call: token expired -> proactive refresh, then API with new token.
    const first = await coordinator.runTool({ botId: 'bot-gmail', tool: 'email_read', args: {} });
    assert.match(first.output, /m1/, 'list must return the mocked message');
    assert.equal(tokenCalls(calls, GMAIL_TOKEN_URL).length, 1, 'exactly one refresh');

    // Event-back: main would persist this TokenSet to Vault.
    const emitted = connectorEvents(events);
    assert.equal(emitted.length, 1, 'exactly one connector.oauth-token event');
    assert.equal(emitted[0].botId, 'bot-gmail');
    assert.equal(emitted[0].payload.connectorId, 'gmail');
    const persisted = JSON.parse(emitted[0].payload.value);
    assert.equal(persisted.accessToken, 'ya29-new');
    assert.equal(persisted.refreshToken, 'refresh-1', 'refresh token retained (no rotation)');
    assert.ok(persisted.expiresAt, 'new expiry recorded');
    assert.ok(
      !JSON.stringify(emitted).includes('gmail-secret-xyz'),
      'client secret must never appear in the event payload',
    );
    assert.ok(
      JSON.stringify(emitted).includes('refresh-1'),
      'refresh token IS part of the persisted TokenSet (needed for the next refresh)',
    );

    // Second call: fresh token reused, no second refresh, no new event.
    const second = await coordinator.runTool({ botId: 'bot-gmail', tool: 'email_read', args: {} });
    assert.match(second.output, /m1/);
    assert.equal(tokenCalls(calls, GMAIL_TOKEN_URL).length, 1, 'no refresh on the second call');
    assert.equal(connectorEvents(events).length, 1, 'no second event');
  });
});

test('gmail e2e: 401 triggers force refresh + one GET retry', async () => {
  const { coordinator, events } = makeCoordinator();
  const ws = tmpWorkspace();
  const { calls, fetchFn } = mockFetch([
    [
      GMAIL_TOKEN_URL,
      async () => ({
        body: { access_token: 'ya29-retry', expires_in: 3600, token_type: 'Bearer' },
      }),
    ],
    [
      GMAIL_API,
      async (_url, init) => {
        const auth = init.headers?.Authorization ?? '';
        if (auth === 'Bearer ya29-stale') {
          return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } };
        }
        assert.equal(auth, 'Bearer ya29-retry');
        return { body: { messages: [{ id: 'm2', threadId: 't2' }] } };
      },
    ],
  ]);

  await withMockFetch(fetchFn, async () => {
    await coordinator.createBot({
      bot: botConfig('bot-gmail-401', ws),
      provider: mockProvider(),
      // Token looks fresh (expires in 1h) so no proactive refresh: the
      // 401 path is what triggers the force refresh.
      connectorTokenSets: {
        gmail: { accessToken: 'ya29-stale', refreshToken: 'refresh-2', expiresAt: FRESH },
      },
      connectorClientConfigs: { gmail: { clientId: 'gmail-client-id' } },
    });
    const out = await coordinator.runTool({ botId: 'bot-gmail-401', tool: 'email_read', args: {} });
    assert.match(out.output, /m2/, 'retry with the refreshed token must succeed');
    assert.equal(tokenCalls(calls, GMAIL_TOKEN_URL).length, 1, 'exactly one force refresh');
    assert.equal(connectorEvents(events).length, 1, 'refreshed TokenSet emitted back');
    const persisted = JSON.parse(connectorEvents(events)[0].payload.value);
    assert.equal(persisted.accessToken, 'ya29-retry');
    assert.equal(persisted.refreshToken, 'refresh-2', 'refresh token retained');
  });
});

test('slack e2e: static xoxb token used as-is, no refresh, no event', async () => {
  const { coordinator, events } = makeCoordinator();
  const ws = tmpWorkspace();
  const { calls, fetchFn } = mockFetch([
    [
      SLACK_API,
      async (_url, init) => {
        assert.equal(init.headers?.Authorization, 'Bearer xoxb-static');
        return { body: { ok: true, channels: [{ id: 'C1', name: 'general' }] } };
      },
    ],
  ]);

  await withMockFetch(fetchFn, async () => {
    await coordinator.createBot({
      bot: botConfig('bot-slack', ws),
      provider: mockProvider(),
      connectorTokenSets: { slack: { accessToken: 'xoxb-static' } },
      // No client config on purpose: a non-expiring token needs none.
    });
    const out = await coordinator.runTool({
      botId: 'bot-slack',
      tool: 'slack_list_channels',
      args: {},
    });
    assert.match(out.output, /general/);
    assert.equal(calls.filter((c) => c.url.includes('oauth')).length, 0, 'no token endpoint hit');
    assert.equal(connectorEvents(events).length, 0, 'no refresh event');
  });
});

test('gmail e2e: expired token + refresh token but NO client config -> no refresh, TokenExpiredError, no crash', async () => {
  const { coordinator, events } = makeCoordinator();
  const ws = tmpWorkspace();
  const { calls, fetchFn } = mockFetch([
    [
      GMAIL_API,
      async () => ({
        status: 401,
        body: { error: { code: 401, message: 'Invalid Credentials' } },
      }),
    ],
  ]);

  await withMockFetch(fetchFn, async () => {
    await coordinator.createBot({
      bot: botConfig('bot-gmail-noclient', ws),
      provider: mockProvider(),
      connectorTokenSets: {
        gmail: { accessToken: 'ya29-old', refreshToken: 'refresh-9', expiresAt: EXPIRED },
      },
      // No connectorClientConfigs: refresh is impossible without a client id.
    });
    const out = await coordinator.runTool({ botId: 'bot-gmail-noclient', tool: 'email_read', args: {} });
    assert.match(out.output, /TOKEN_EXPIRED|đã hết hạn/, 'tool reports an expired token, not a crash');
    assert.equal(tokenCalls(calls, GMAIL_TOKEN_URL).length, 0, 'no refresh attempted without client id');
    assert.equal(connectorEvents(events).length, 0, 'nothing refreshed, nothing emitted');
  });
});

test('seed-only: stale Vault TokenSet on a second createBot does not overwrite the refreshed token', async () => {
  const { coordinator, events } = makeCoordinator();
  const wsA = tmpWorkspace();
  const wsB = tmpWorkspace();
  const { calls, fetchFn } = mockFetch([
    [
      GMAIL_TOKEN_URL,
      async () => ({
        body: { access_token: 'ya29-new', expires_in: 3600, token_type: 'Bearer' },
      }),
    ],
    [
      GMAIL_API,
      async (_url, init) => {
        assert.equal(init.headers?.Authorization, 'Bearer ya29-new');
        return { body: { messages: [{ id: 'm9', threadId: 't9' }] } };
      },
    ],
  ]);

  await withMockFetch(fetchFn, async () => {
    await coordinator.createBot({
      bot: botConfig('bot-a', wsA),
      provider: mockProvider(),
      connectorTokenSets: {
        gmail: { accessToken: 'ya29-old', refreshToken: 'refresh-1', expiresAt: EXPIRED },
      },
      connectorClientConfigs: { gmail: { clientId: 'gmail-client-id' } },
    });
    const first = await coordinator.runTool({ botId: 'bot-a', tool: 'email_read', args: {} });
    assert.match(first.output, /m9/);
    assert.equal(tokenCalls(calls, GMAIL_TOKEN_URL).length, 1);

    // A second bot is created with the STALE Vault copy (as main would
    // pass before it persisted the refreshed set). The live refreshed
    // TokenSet must win.
    await coordinator.createBot({
      bot: botConfig('bot-b', wsB),
      provider: mockProvider(),
      connectorTokenSets: {
        gmail: { accessToken: 'ya29-old', refreshToken: 'refresh-1', expiresAt: EXPIRED },
      },
      connectorClientConfigs: { gmail: { clientId: 'gmail-client-id' } },
    });
    const second = await coordinator.runTool({ botId: 'bot-b', tool: 'email_read', args: {} });
    assert.match(second.output, /m9/, 'second bot uses the refreshed token, not the stale seed');
    assert.equal(tokenCalls(calls, GMAIL_TOKEN_URL).length, 1, 'no re-refresh from the stale seed');
    assert.equal(connectorEvents(events).length, 1, 'only the original refresh was emitted');
  });
});
