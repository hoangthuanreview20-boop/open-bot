/**
 * Tests for v0.87a (P2-2) — HTTP route POST /v1/automations/:id/slack-inbound
 * (packages/core/src/api/server.ts).
 *
 *   1. Signed message delivery WITHOUT any Local API Bearer token -> 200,
 *      run recorded with trigger 'composio' (the route is checked BEFORE
 *      the Bearer gate on purpose — Slack cannot send the local token).
 *      A wrong Bearer token is likewise ignored on this route.
 *   2. Bad signature / no auth at all -> 401, no run recorded.
 *   3. `url_verification` -> 200 with the challenge, no run; a bot
 *      message -> 200 with the ignored ack, no run.
 *   4. Slug mismatch (DM to a channel automation) -> 400, no run;
 *      unknown automation -> 404; handler not mounted -> 404.
 *   5. Non-canonical JSON (spaces) signed over the EXACT bytes sent
 *      -> 200 (the signature is verified on the raw body, never on a
 *      re-serialised object).
 *   6. Form-encoded `block_actions` -> 200, run recorded with the
 *      interaction as input.
 *
 * The server is real (loopback, port 0); the signing secret lives in
 * a real Vault under a temp dir; the scheduler is real. No provider,
 * tool or network ever runs (fake handlers). No fixture secret is
 * logged.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/slack-inbound-http-v087a.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createApiServer } from '../packages/core/dist/api/server.js';
import {
  AutomationScheduler,
  JsonFileAutomationStore,
} from '../packages/core/dist/automations/index.js';
import {
  computeSlackSignature,
  getSlackSigningSecret,
  setSlackSigningSecret,
} from '../packages/core/dist/slack/index.js';
import { Vault } from '../packages/core/dist/vault/index.js';

const TOKEN = 'test-token-slack-v087a';
const SECRET = 'test-slack-signing-secret-http-v087a';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-slack-http-v087a-'));
  tempDirs.push(dir);
  return dir;
}

const servers = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function baseAutomation(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'auto-1',
    botId: 'bot-1',
    name: 'Slack thì trả lời',
    trigger: { kind: 'composio', triggerSlug: 'SLACK_CHANNEL_MESSAGE_RECEIVED', keyId: 'auto-1' },
    action: { kind: 'run-agent', botId: 'bot-1', prompt: 'Trả lời tin Slack.' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function messageBody(overrides = {}) {
  return JSON.stringify({
    token: 'test-verification-token',
    team_id: 'T123',
    api_app_id: 'A123',
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'C123',
      user: 'U456',
      text: 'hello bot, deploy please',
      ts: '1762850000.000001',
      team: 'T123',
      channel_type: 'channel',
      event_ts: '1762850000.000001',
      ...overrides,
    },
  });
}

function makeSandbox(handlers) {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const store = new JsonFileAutomationStore(dir);
  const scheduler = new AutomationScheduler(store, handlers, {
    slackSigningSecretProvider: (keyId) => {
      try {
        return getSlackSigningSecret(vault, keyId);
      } catch {
        return null;
      }
    },
  });
  return { dir, vault, store, scheduler };
}

function apiHandlers(scheduler, overrides = {}) {
  return {
    listBots: async () => [{ id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' }],
    runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
    getHistory: async () => [],
    listTasks: async () => [],
    deliverSlackInbound: async (automationId, rawBody, auth, contentType) =>
      scheduler.handleSlackInbound(automationId, rawBody, auth, contentType),
    ...overrides,
  };
}

async function startServer(handlers) {
  const server = createApiServer({ port: 0, token: TOKEN, handlers });
  await server.start();
  servers.push(server);
  return server;
}

function base(server) {
  return `http://127.0.0.1:${server.port}`;
}

function signHeaders(body, secret = SECRET) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'x-slack-request-timestamp': ts,
    'x-slack-signature': computeSlackSignature(secret, ts, body),
  };
}

async function postSlack(server, automationId, body, headers = {}) {
  return fetch(`${base(server)}/v1/automations/${automationId}/slack-inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

function fakeHandlers() {
  const calls = [];
  return {
    calls,
    handlers: {
      runAgent: async (botId, prompt) => {
        calls.push({ kind: 'run-agent', botId, prompt });
        return `agent answered: ${prompt.slice(0, 40)}`;
      },
      runTool: async (name, args) => {
        calls.push({ kind: 'run-tool', name, args });
        return `tool ${name} ok`;
      },
      createTask: async () => 'task-123',
      notify: () => undefined,
    },
  };
}

test('HTTP slack inbound: signed delivery WITHOUT a Bearer token -> 200 + run', async () => {
  const { calls, handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setSlackSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const body = messageBody();
  // No Authorization header at all — the route must not demand it.
  const res = await postSlack(server, 'auto-1', body, signHeaders(body));
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.status, 'ok');
  assert.equal(run.trigger, 'composio');
  assert.equal(run.automationId, 'auto-1');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes('hello bot, deploy please'));

  // A WRONG Bearer token is ignored on this route too (it is neither
  // required nor accepted as a substitute for the Slack signature).
  const res2 = await postSlack(server, 'auto-1', body, {
    ...signHeaders(body),
    Authorization: 'Bearer wrong-token',
  });
  assert.equal(res2.status, 200);
  assert.equal(scheduler.listRuns('auto-1').length, 2);
});

test('HTTP slack inbound: bad signature / no auth -> 401, no run', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setSlackSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const body = messageBody();
  const bad = await postSlack(server, 'auto-1', body, signHeaders(body, 'wrong-secret'));
  assert.equal(bad.status, 401);
  const noAuth = await postSlack(server, 'auto-1', body, {});
  assert.equal(noAuth.status, 401);
  // Signature present but timestamp missing.
  const noTs = await postSlack(server, 'auto-1', body, {
    'x-slack-signature': signHeaders(body)['x-slack-signature'],
  });
  assert.equal(noTs.status, 401);
  assert.equal(scheduler.listRuns('auto-1').length, 0, 'rejected deliveries record no run');
});

test('HTTP slack inbound: url_verification -> challenge, bot message -> ignored, no run', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setSlackSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const challengeBody = JSON.stringify({ token: 't', challenge: 'abc123', type: 'url_verification' });
  const res = await postSlack(server, 'auto-1', challengeBody, signHeaders(challengeBody));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { kind: 'url_verification', challenge: 'abc123' });
  assert.equal(scheduler.listRuns('auto-1').length, 0);

  const botBody = messageBody({ subtype: 'bot_message', bot_id: 'B1' });
  const res2 = await postSlack(server, 'auto-1', botBody, signHeaders(botBody));
  assert.equal(res2.status, 200);
  const ignored = await res2.json();
  assert.equal(ignored.kind, 'ignored');
  assert.equal(ignored.ok, true);
  assert.equal(scheduler.listRuns('auto-1').length, 0);
});

test('HTTP slack inbound: slug mismatch -> 400, unknown automation -> 404, unmounted -> 404', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setSlackSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  // A DM delivered to a channel-message automation.
  const dmBody = messageBody({ channel: 'D999', channel_type: 'im' });
  const mismatch = await postSlack(server, 'auto-1', dmBody, signHeaders(dmBody));
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /slug mismatch/);

  // Unknown automation.
  const unknown = await postSlack(server, 'nope', messageBody(), signHeaders(messageBody()));
  assert.equal(unknown.status, 404);

  // Handler not mounted: the route reports 404, not 500.
  const bare = await startServer({ listBots: async () => [], runBot: async () => ({}), getHistory: async () => [], listTasks: async () => [] });
  const unmounted = await postSlack(bare, 'auto-1', messageBody(), signHeaders(messageBody()));
  assert.equal(unmounted.status, 404);
  assert.equal(scheduler.listRuns('auto-1').length, 0);
});

test('HTTP slack inbound: non-canonical JSON signed over the exact bytes -> 200', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setSlackSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  // Extra spaces: the signature covers the exact bytes, not a re-serialised object.
  const body = messageBody().replace('"type":"event_callback"', '"type":  "event_callback"');
  assert.notEqual(body, messageBody());
  const res = await postSlack(server, 'auto-1', body, signHeaders(body));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
  assert.equal(scheduler.listRuns('auto-1').length, 1);
});

test('HTTP slack inbound: form-encoded block_actions -> 200 + run', async () => {
  const { calls, handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setSlackSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const payload = {
    type: 'block_actions',
    user: { id: 'U456' },
    team: { id: 'T123' },
    channel: { id: 'C123', name: 'general' },
    message: { ts: '1762850000.000001' },
    actions: [{ action_id: 'approve_prod', block_id: 'b1', type: 'button', value: 'approve_prod' }],
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const res = await fetch(`${base(server)}/v1/automations/auto-1/slack-inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...signHeaders(body),
    },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes('approve_prod'));
  assert.equal(scheduler.listRuns('auto-1').length, 1);
});
