/**
 * Tests for v0.83b — HTTP route POST /v1/automations/:id/composio-trigger
 * (packages/core/src/api/server.ts).
 *
 *   1. Signed delivery WITHOUT any Local API Bearer token -> 200, run
 *      recorded with trigger 'composio' (the route is checked BEFORE
 *      the Bearer gate on purpose — Composio cannot send the local
 *      token). A wrong Bearer token is likewise ignored on this route.
 *   2. Bad signature / no auth at all -> 401, no run recorded.
 *   3. `?token=` fallback (no signature headers) -> 200; wrong token
 *      -> 401.
 *   4. Slug mismatch -> 400, no run; unknown automation -> 404;
 *      handler not mounted -> 404.
 *   5. Non-canonical JSON (spaces) signed over the EXACT bytes sent
 *      -> 200 (the signature is verified on the raw body, never on a
 *      re-serialised object).
 *
 * The server is real (loopback, port 0); the signing secret lives in
 * a real Vault under a temp dir; the scheduler is real. No provider,
 * tool or network ever runs (fake handlers). No fixture secret is
 * logged.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-trigger-http-v083.test.mjs
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
  ComposioTriggerQueue,
  computeComposioWebhookSignature,
  getComposioTriggerSigningSecret,
  getComposioTriggerToken,
  setComposioTriggerSigningSecret,
  createComposioTriggerToken,
} from '../packages/core/dist/composio/index.js';
import { Vault } from '../packages/core/dist/vault/index.js';

const TOKEN = 'test-token-composio-v083';
const SECRET = 'test-composio-webhook-secret-http-v083';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-composio-http-v083-'));
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
    name: 'Mail mới thì báo',
    trigger: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', keyId: 'auto-1', tokenKeyId: 'auto-1-url-token' },
    action: { kind: 'run-agent', botId: 'bot-1', prompt: 'Tóm tắt mail mới.' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function gmailBody() {
  return JSON.stringify({
    id: 'msg_gmail1',
    type: 'composio.trigger.message',
    metadata: {
      trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      trigger_id: 'ti_gmail1',
      connected_account_id: 'ca_gmail1',
      user_id: 'user-1',
    },
    data: { subject: 'Hello from the outside', from: 'boss@example.com' },
    timestamp: new Date().toISOString(),
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
    composioWebhookSecretProvider: (keyId) => getComposioTriggerSigningSecret(vault, keyId),
    composioTriggerTokenProvider: (keyId) =>
      keyId === 'auto-1-url-token' ? getComposioTriggerToken(vault, 'auto-1') : null,
  });
  return { dir, vault, store, scheduler };
}

function apiHandlers(scheduler, overrides = {}) {
  return {
    listBots: async () => [{ id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' }],
    runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
    getHistory: async () => [],
    listTasks: async () => [],
    deliverComposioTrigger: async (automationId, rawBody, auth) =>
      scheduler.handleComposioTrigger(automationId, rawBody, auth),
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

function signHeaders(body, secret = SECRET, webhookId = 'wh_123') {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': ts,
    'webhook-signature': computeComposioWebhookSignature(secret, webhookId, ts, body),
  };
}

async function postTrigger(server, automationId, body, headers = {}, query = '') {
  return fetch(`${base(server)}/v1/automations/${automationId}/composio-trigger${query}`, {
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

test('HTTP composio trigger: signed delivery WITHOUT a Bearer token -> 200 + run', async () => {
  const { calls, handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setComposioTriggerSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const body = gmailBody();
  // No Authorization header at all — the route must not demand it.
  const res = await postTrigger(server, 'auto-1', body, signHeaders(body));
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.status, 'ok');
  assert.equal(run.trigger, 'composio');
  assert.equal(run.automationId, 'auto-1');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes('Hello from the outside'));

  // A WRONG Bearer token is ignored on this route too (it is neither
  // required nor accepted as a substitute for the Composio signature).
  const res2 = await postTrigger(server, 'auto-1', body, {
    ...signHeaders(body),
    Authorization: 'Bearer wrong-token',
  });
  assert.equal(res2.status, 200);
  assert.equal(scheduler.listRuns('auto-1').length, 2);
});

test('HTTP composio trigger: bad signature / no auth -> 401, no run', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setComposioTriggerSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const body = gmailBody();
  const bad = await postTrigger(server, 'auto-1', body, signHeaders(body, 'wrong-secret'));
  assert.equal(bad.status, 401);
  const none = await postTrigger(server, 'auto-1', body, {});
  assert.equal(none.status, 401);
  assert.equal(scheduler.listRuns('auto-1').length, 0);
});

test('HTTP composio trigger: ?token= fallback -> 200, wrong token -> 401', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setComposioTriggerSigningSecret(vault, 'auto-1', SECRET);
  const { secret: token } = createComposioTriggerToken(vault, 'auto-1');
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const body = gmailBody();
  const ok = await postTrigger(server, 'auto-1', body, {}, `?token=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 200);
  const run = await ok.json();
  assert.equal(run.status, 'ok');
  const bad = await postTrigger(server, 'auto-1', body, {}, '?token=nope');
  assert.equal(bad.status, 401);
  assert.equal(scheduler.listRuns('auto-1').length, 1);
});

test('HTTP composio trigger: slug mismatch -> 400, unknown automation -> 404, unmounted -> 404', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setComposioTriggerSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const ghBody = JSON.stringify({
    id: 'msg_gh',
    type: 'composio.trigger.message',
    metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT', trigger_id: 'ti_gh' },
    data: { commit_sha: 'abc' },
    timestamp: new Date().toISOString(),
  });
  const mismatch = await postTrigger(server, 'auto-1', ghBody, signHeaders(ghBody));
  assert.equal(mismatch.status, 400);
  assert.equal(scheduler.listRuns('auto-1').length, 0);

  const body = gmailBody();
  const unknown = await postTrigger(server, 'no-such-auto', body, signHeaders(body));
  assert.equal(unknown.status, 404);

  const bare = await startServer({
    listBots: async () => [],
    runBot: async () => ({}),
    getHistory: async () => [],
    listTasks: async () => [],
  });
  const unmounted = await postTrigger(bare, 'auto-1', body, signHeaders(body));
  assert.equal(unmounted.status, 404);
});

test('HTTP composio trigger: non-canonical JSON signed over exact bytes -> 200', async () => {
  const { handlers } = fakeHandlers();
  const { vault, store, scheduler } = makeSandbox(handlers);
  setComposioTriggerSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  const body =
    '{ "id": "msg_spaced", "type": "composio.trigger.message", "metadata": { "trigger_slug": "GMAIL_NEW_GMAIL_MESSAGE" }, "data": { "subject": "spaced" } }';
  const res = await postTrigger(server, 'auto-1', body, signHeaders(body));
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.status, 'ok');
  assert.ok(run.triggerInput.includes('GMAIL_NEW_GMAIL_MESSAGE'));
});

test('HTTP composio trigger v096: verified delivery ALSO enqueues into the queue; bad signature does not', async () => {
  const { handlers } = fakeHandlers();
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const store = new JsonFileAutomationStore(dir);
  const queue = new ComposioTriggerQueue({ maxSize: 100, ttlMs: 60_000, now: () => Date.now() });
  const scheduler = new AutomationScheduler(store, handlers, {
    composioWebhookSecretProvider: (keyId) => getComposioTriggerSigningSecret(vault, keyId),
    composioTriggerTokenProvider: (keyId) =>
      keyId === 'auto-1-url-token' ? getComposioTriggerToken(vault, 'auto-1') : null,
    composioTriggerQueue: queue,
  });
  setComposioTriggerSigningSecret(vault, 'auto-1', SECRET);
  store.save(baseAutomation());
  const body = gmailBody();
  const h = signHeaders(body);
  const run = await scheduler.handleComposioTrigger('auto-1', body, {
    webhookId: h['webhook-id'],
    webhookTimestamp: h['webhook-timestamp'],
    webhookSignature: h['webhook-signature'],
  });
  assert.equal(run.status, 'ok');
  assert.equal(queue.stats().pending, 1);
  const [ev] = queue.peek();
  assert.equal(ev.event.triggerSlug, 'GMAIL_NEW_GMAIL_MESSAGE');
  assert.equal(ev.event.eventId, 'msg_gmail1');
  assert.equal(ev.event.data.subject, 'Hello from the outside');
  // Bad signature -> 401-style throw, no run AND no enqueue.
  await assert.rejects(
    scheduler.handleComposioTrigger('auto-1', body, {
      webhookId: h['webhook-id'],
      webhookTimestamp: h['webhook-timestamp'],
      webhookSignature: signHeaders(body, 'wrong-secret')['webhook-signature'],
    }),
    /Invalid Composio webhook signature/,
  );
  assert.equal(queue.stats().pending, 1);
  assert.equal(scheduler.listRuns('auto-1').length, 1);
});
