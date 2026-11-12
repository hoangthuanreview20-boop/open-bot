/**
 * Tests for v0.59 (P0-5 follow-ups):
 *  1. Public HTTP route POST /v1/automations/:id/webhook
 *     (packages/core/src/api/server.ts) — Local API auth AND HMAC
 *     signature, raw-body verification, payload into the action.
 *  2. Automation policy by team role (core level — the viewer main
 *     now wires in, see main.ts `localAutomationPolicyChecker`).
 *  3. Webhook key migration: legacy Vault namespace
 *     `automation-webhook-keys/` -> dedicated `WebhookKeyStore`
 *     (packages/core/src/automations/webhookKeys.ts).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/automations-webhook-http-v059.test.mjs
 *
 * No provider, tool or network ever runs (fake handlers); the HTTP
 * server is real (loopback, port 0); keys live in real Vault /
 * WebhookKeyStore files under temp dirs. No fixture secret is logged.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createApiServer } from '../packages/core/dist/api/server.js';
import {
  AUTOMATION_WEBHOOK_KEYS_NAMESPACE,
  AutomationScheduler,
  JsonFileAutomationStore,
  canAutomationAction,
  computeWebhookSignature,
  createAutomationWebhookKey,
  createRolePolicyChecker,
  deleteAutomationWebhookKey,
  getAutomationWebhookKey,
  hasAutomationWebhookKey,
  migrateAutomationWebhookKey,
  rotateAutomationWebhookKey,
  verifyWebhookSignature,
} from '../packages/core/dist/automations/index.js';
import { Vault, WebhookKeyStore } from '../packages/core/dist/vault/index.js';

const TOKEN = 'test-token-webhook-v059';
const TEAM_ID = 'team-1';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-v059-test-'));
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
    id: 'hook-1',
    botId: 'bot-1',
    name: 'Test webhook automation',
    trigger: { kind: 'webhook', keyId: 'hook-1' },
    action: { kind: 'run-tool', tool: 'read_file', args: { path: 'a.md' } },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Fake handlers recording every call (no provider/tool involved). */
function makeHandlers() {
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
      createTask: async (botId, title) => {
        calls.push({ kind: 'create-task', botId, title });
        return 'task-123';
      },
      notify: (message) => {
        calls.push({ kind: 'notify', message });
      },
    },
  };
}

/**
 * One sandbox: legacy Vault + dedicated WebhookKeyStore + scheduler
 * whose webhookKeyProvider reads the PAIR (new store first, legacy
 * fallback with lazy migration) — exactly how main wires it.
 */
function makeSandbox(handlers, opts = {}) {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const keyStore = new WebhookKeyStore({
    dir,
    keyFilePath: path.join(dir, 'webhook-keys.json.key'),
  });
  const pair = { store: keyStore, legacyStore: vault };
  const store = new JsonFileAutomationStore(dir);
  const scheduler = new AutomationScheduler(store, handlers, {
    now: () => new Date('2026-11-09T10:00:00.000Z'),
    webhookKeyProvider: (keyId) => getAutomationWebhookKey(pair, keyId),
    ...opts,
  });
  return { dir, vault, keyStore, pair, store, scheduler };
}

function apiHandlers(scheduler, overrides = {}) {
  return {
    listBots: async () => [{ id: 'bot-1', name: 'Trợ lý', providerId: 'ollama', model: 'qwen2.5:0.5b' }],
    runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
    getHistory: async () => [],
    listTasks: async () => [],
    deliverAutomationWebhook: async (automationId, rawBody, signature) =>
      scheduler.handleWebhook(automationId, rawBody, signature),
    ...overrides,
  };
}

async function startServer(handlers, extraOpts = {}) {
  const server = createApiServer({ port: 0, token: TOKEN, handlers, ...extraOpts });
  await server.start();
  servers.push(server);
  return server;
}

function base(server) {
  return `http://127.0.0.1:${server.port}`;
}

/** POST a webhook delivery; `sig` null omits the signature header. */
async function postWebhook(server, automationId, body, sig, extraHeaders = {}) {
  return fetch(`${base(server)}/v1/automations/${automationId}/webhook`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(sig !== null && sig !== undefined ? { 'x-open-bot-signature': sig } : {}),
      ...extraHeaders,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// 1. HTTP route: valid delivery runs the action with the payload
// ---------------------------------------------------------------------------

test('HTTP webhook: valid signature -> 200, run recorded, run-tool args merged from payload', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));

  // Deliberately non-canonical JSON (spaces) — the server must verify
  // the EXACT bytes sent, not a re-serialised object.
  const body = '{ "path": "b.md", "extra": "from-webhook" }';
  const res = await postWebhook(server, 'hook-1', body, computeWebhookSignature(secret, body));
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.status, 'ok');
  assert.equal(run.automationId, 'hook-1');
  // triggerInput is stored re-serialised from the parsed payload
  // (pre-existing engine behaviour — the 2000-char cap + JSON
  // round-trip in executeAutomation), while the SIGNATURE was
  // verified on the exact spaced bytes sent above (a re-serialised
  // verify would have failed with 401 instead).
  assert.deepEqual(JSON.parse(run.triggerInput), { path: 'b.md', extra: 'from-webhook' });
  assert.equal(calls.length, 1);
  // Action args win over payload keys; payload adds the rest.
  assert.deepEqual(calls[0].args, { path: 'a.md', extra: 'from-webhook' });
  assert.equal(scheduler.listRuns('hook-1').length, 1);
});

test('HTTP webhook: run-agent prompt carries the payload', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(
    baseAutomation({
      action: { kind: 'run-agent', botId: 'bot-1', prompt: 'Summarise the deploy.' },
    }),
  );
  const server = await startServer(apiHandlers(scheduler));
  const body = JSON.stringify({ repo: 'open-bot', pr: 7 });
  const res = await postWebhook(server, 'hook-1', body, computeWebhookSignature(secret, body));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes('Summarise the deploy.'));
  assert.ok(calls[0].prompt.includes('"pr":7'));
});

test('HTTP webhook: wrong / missing / malformed signature -> 401, no run, handler never called', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));
  const body = JSON.stringify({ ping: 1 });
  const goodSig = computeWebhookSignature(secret, body);

  // Flip the last hex digit to a DIFFERENT digit: appending a fixed
  // '0' is not a flip at all when the signature already ends in '0'
  // (~1/16 of random secrets — the secret is fresh every run) — the
  // "malformed" signature would then be identical to the good one
  // and the server would (correctly) answer 200 instead of 401.
  // That was the intermittent 401-vs-200 flake (reproduced 1/30
  // runs before this fix, run 19, case 'malformed: flipped digit').
  const flippedDigit = goodSig.endsWith('0') ? '1' : '0';
  const cases = [
    ['wrong secret', computeWebhookSignature('wrong-secret', body)],
    ['tampered body', computeWebhookSignature(secret, '{"ping":2}')],
    ['missing signature', null],
    ['malformed: no prefix', goodSig.replace('sha256=', '')],
    ['malformed: short hex', 'sha256=deadbeef'],
    ['malformed: flipped digit', goodSig.slice(0, -1) + flippedDigit],
    ['malformed: empty', ''],
  ];
  for (const [label, sig] of cases) {
    const res = await postWebhook(server, 'hook-1', body, sig);
    assert.equal(res.status, 401, label);
    assert.match((await res.json()).error, /Invalid webhook signature/, label);
  }
  assert.equal(calls.length, 0, 'no delivery reached the action handler');
  assert.equal(scheduler.listRuns('hook-1').length, 0, 'no run recorded');
});

test('HTTP webhook: missing/wrong Local API auth -> 401, even with a valid HMAC signature', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));
  const body = JSON.stringify({ ping: 1 });
  const sig = computeWebhookSignature(secret, body);

  const noAuth = await fetch(`${base(server)}/v1/automations/hook-1/webhook`, {
    method: 'POST',
    headers: { 'x-open-bot-signature': sig },
    body,
  });
  assert.equal(noAuth.status, 401);
  const wrongToken = await fetch(`${base(server)}/v1/automations/hook-1/webhook`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token', 'x-open-bot-signature': sig },
    body,
  });
  assert.equal(wrongToken.status, 401);
  assert.equal(calls.length, 0);
  assert.equal(scheduler.listRuns('hook-1').length, 0);
});

test('HTTP webhook: team-bound server requires X-Open-Bot-Team (403) before HMAC is even checked', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler), { teamId: TEAM_ID });
  const body = JSON.stringify({ ping: 1 });
  const sig = computeWebhookSignature(secret, body);

  const noTeam = await postWebhook(server, 'hook-1', body, sig);
  assert.equal(noTeam.status, 403);
  const wrongTeam = await postWebhook(server, 'hook-1', body, sig, { 'X-Open-Bot-Team': 'other-team' });
  assert.equal(wrongTeam.status, 403);
  // Correct team header + valid signature -> through.
  const ok = await postWebhook(server, 'hook-1', body, sig, { 'X-Open-Bot-Team': TEAM_ID });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
});

test('HTTP webhook: unknown automation -> 404; handler not mounted -> 404', async () => {
  const { handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));
  const body = JSON.stringify({ ping: 1 });
  const sig = computeWebhookSignature(secret, body);

  const unknown = await postWebhook(server, 'no-such-auto', body, sig);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /No automation/);

  const bare = await startServer({
    listBots: async () => [],
    runBot: async () => ({ text: '' }),
    getHistory: async () => [],
    listTasks: async () => [],
  });
  const unmounted = await postWebhook(bare, 'hook-1', body, sig);
  assert.equal(unmounted.status, 404);
  assert.match((await unmounted.json()).error, /not mounted/);
});

test('HTTP webhook: disabled / non-webhook / no-key automations -> 400, nothing runs', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(baseAutomation({ id: 'hook-1' }));
  store.save(baseAutomation({ id: 'plain-1', trigger: { kind: 'manual' } }));
  store.save(baseAutomation({ id: 'no-key', trigger: { kind: 'webhook', keyId: 'no-key' } }));
  const server = await startServer(apiHandlers(scheduler));
  const body = JSON.stringify({ x: 1 });
  const sig = computeWebhookSignature(secret, body);

  const plain = await postWebhook(server, 'plain-1', body, sig);
  assert.equal(plain.status, 400);
  assert.match((await plain.json()).error, /does not have a webhook trigger/);

  const noKey = await postWebhook(server, 'no-key', body, sig);
  assert.equal(noKey.status, 400);
  assert.match((await noKey.json()).error, /no webhook key/);

  scheduler.setEnabled('hook-1', false);
  const disabled = await postWebhook(server, 'hook-1', body, sig);
  assert.equal(disabled.status, 400);
  assert.match((await disabled.json()).error, /disabled/);

  assert.equal(calls.length, 0);
  assert.equal(scheduler.listRuns('hook-1').length, 0);
});

test('HTTP webhook: valid signature over invalid JSON -> 400 (signature passes, payload parse fails)', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, pair } = makeSandbox(handlers);
  const { secret } = createAutomationWebhookKey(pair, 'hook-1');
  store.save(baseAutomation());
  const server = await startServer(apiHandlers(scheduler));
  const body = '{not json';
  const res = await postWebhook(server, 'hook-1', body, computeWebhookSignature(secret, body));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
  assert.equal(calls.length, 0);
  assert.equal(scheduler.listRuns('hook-1').length, 0);
});

// ---------------------------------------------------------------------------
// 2. Policy by role (core level; main wires the same checker for the
//    local viewer — see main.ts `localAutomationPolicyChecker`)
// ---------------------------------------------------------------------------

test('policy: viewer OPEN only, member own-only (+ legacy unowned), admin all', () => {
  // Viewer: may look, never change or run.
  assert.equal(canAutomationAction('viewer', 'OPEN'), true);
  assert.equal(canAutomationAction('viewer', 'CREATE'), false);
  assert.equal(canAutomationAction('viewer', 'TOGGLE'), false);
  assert.equal(canAutomationAction('viewer', 'EDIT'), false);
  assert.equal(canAutomationAction('viewer', 'DELETE'), false);
  assert.equal(canAutomationAction('viewer', 'CHANGE_POLICY'), false);
  // Member: full set except CHANGE_POLICY, and EDIT/TOGGLE/DELETE
  // only for automations they created (legacy `createdBy: ''` is open).
  assert.equal(canAutomationAction('member', 'CREATE'), true);
  assert.equal(canAutomationAction('member', 'CHANGE_POLICY'), false);
  assert.equal(canAutomationAction('member', 'EDIT', { userId: 'u1', createdBy: 'u1' }), true);
  assert.equal(canAutomationAction('member', 'EDIT', { userId: 'u1', createdBy: 'u2' }), false);
  assert.equal(canAutomationAction('member', 'TOGGLE', { userId: 'u1', createdBy: 'u2' }), false);
  assert.equal(canAutomationAction('member', 'DELETE', { userId: 'u1', createdBy: 'u2' }), false);
  assert.equal(canAutomationAction('member', 'EDIT', { userId: 'u1', createdBy: '' }), true, 'legacy unowned');
  assert.equal(canAutomationAction('member', 'TOGGLE', { userId: 'u1', createdBy: '' }), true, 'legacy unowned');
  assert.equal(canAutomationAction('member', 'DELETE', { userId: 'u1', createdBy: '' }), true, 'legacy unowned');
  // Admin: everything, regardless of creator.
  for (const action of ['CREATE', 'CHANGE_POLICY', 'OPEN', 'TOGGLE', 'EDIT', 'DELETE']) {
    assert.equal(canAutomationAction('admin', action, { userId: 'a', createdBy: 'u2' }), true, action);
  }
  // Fail-closed: unknown role / unknown action are denied.
  assert.equal(canAutomationAction('nobody', 'OPEN'), false);
  assert.equal(canAutomationAction('admin', 'BOGUS'), false);
});

test('scheduler policy: viewer cannot create/run; member manages only their own; admin can do everything', async () => {
  const dir = makeTempDir();
  const viewerBox = makeSandbox(makeHandlers().handlers, {
    policyChecker: createRolePolicyChecker('viewer', 'v1'),
  });
  assert.throws(() => viewerBox.scheduler.create(baseAutomation()), /not allowed/);
  viewerBox.store.save(baseAutomation({ id: 'hook-1' }));
  await assert.rejects(() => viewerBox.scheduler.runNow('hook-1'), /not allowed/);

  const memberBox = makeSandbox(makeHandlers().handlers, {
    policyChecker: createRolePolicyChecker('member', 'u1'),
    currentUserId: 'u1',
  });
  const own = memberBox.scheduler.create(baseAutomation({ id: 'own-1' }));
  assert.equal(own.createdBy, 'u1', 'currentUserId is stamped as createdBy');
  memberBox.store.save(baseAutomation({ id: 'other-1', createdBy: 'u2' }));
  assert.throws(
    () => memberBox.scheduler.update({ ...memberBox.scheduler.get('other-1'), name: 'x' }),
    /not allowed/,
  );
  assert.throws(() => memberBox.scheduler.setEnabled('other-1', false), /not allowed/);
  assert.throws(() => memberBox.scheduler.remove('other-1'), /not allowed/);
  await assert.rejects(() => memberBox.scheduler.runNow('other-1'), /not allowed/);
  // Own automation works; legacy unowned automation is manageable.
  assert.equal(memberBox.scheduler.setEnabled('own-1', false).enabled, false);
  memberBox.store.save(baseAutomation({ id: 'legacy-1', createdBy: '' }));
  assert.equal(memberBox.scheduler.setEnabled('legacy-1', false).enabled, false);

  // Changing `access` needs CHANGE_POLICY: member denied, admin allowed.
  assert.throws(
    () => memberBox.scheduler.update({ ...memberBox.scheduler.get('own-1'), access: { roles: ['admin'] } }),
    /not allowed/,
  );
  // An admin scheduler over the SAME store (same automations) may change it.
  const adminScheduler = new AutomationScheduler(memberBox.store, makeHandlers().handlers, {
    policyChecker: createRolePolicyChecker('admin', 'a1'),
  });
  assert.deepEqual(
    adminScheduler.update({ ...adminScheduler.get('own-1'), access: { roles: ['admin'] } }).access,
    { roles: ['admin'] },
  );
});

// ---------------------------------------------------------------------------
// 3. Migration: legacy Vault namespace -> dedicated WebhookKeyStore
// ---------------------------------------------------------------------------

test('migration: key created in the legacy Vault is moved to the new store on first read', () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const keyStore = new WebhookKeyStore({
    dir,
    keyFilePath: path.join(dir, 'webhook-keys.json.key'),
  });
  const pair = { store: keyStore, legacyStore: vault };

  // Old-world: key created straight in the legacy Vault (pre-v0.59).
  const { secret } = createAutomationWebhookKey(vault, 'hook-1');
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), true);
  assert.equal(keyStore.hasKey('hook-1'), false);

  // `has` sees it through the legacy fallback (no migration yet).
  assert.equal(hasAutomationWebhookKey(pair, 'hook-1'), true);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), true, 'has() does not migrate');

  // First real read migrates: same secret, now in the new store only.
  assert.equal(getAutomationWebhookKey(pair, 'hook-1'), secret);
  assert.equal(keyStore.hasKey('hook-1'), true);
  assert.equal(keyStore.getKey('hook-1'), secret);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), false, 'legacy copy deleted');
  assert.equal(vault.getSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), null);

  // Second read comes from the new store; the secret still verifies.
  assert.equal(getAutomationWebhookKey(pair, 'hook-1'), secret);
  const body = '{"ping":1}';
  assert.equal(
    verifyWebhookSignature(secret, body, computeWebhookSignature(secret, body)),
    true,
  );
});

test('migration: migrateAutomationWebhookKey moves once, then reports nothing to do', () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const keyStore = new WebhookKeyStore({
    dir,
    keyFilePath: path.join(dir, 'webhook-keys.json.key'),
  });
  const pair = { store: keyStore, legacyStore: vault };

  assert.equal(migrateAutomationWebhookKey(pair, 'hook-1'), false, 'no key at all');
  const { secret } = createAutomationWebhookKey(vault, 'hook-1');
  assert.equal(migrateAutomationWebhookKey(pair, 'hook-1'), true, 'legacy key moved');
  assert.equal(keyStore.getKey('hook-1'), secret);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), false);
  assert.equal(migrateAutomationWebhookKey(pair, 'hook-1'), false, 'already migrated');
  // No legacy store attached: nothing to migrate, never throws.
  assert.equal(migrateAutomationWebhookKey(keyStore, 'hook-1'), false);
});

test('migration: new writes go ONLY to the dedicated store; the legacy Vault stays empty', () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const keyStore = new WebhookKeyStore({
    dir,
    keyFilePath: path.join(dir, 'webhook-keys.json.key'),
  });
  const pair = { store: keyStore, legacyStore: vault };

  const created = createAutomationWebhookKey(pair, 'hook-1');
  assert.equal(created.secret.length, 64);
  assert.equal(keyStore.getKey('hook-1'), created.secret);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), false);
  assert.deepEqual(vault.listSecrets(AUTOMATION_WEBHOOK_KEYS_NAMESPACE), []);

  const rotated = rotateAutomationWebhookKey(pair, 'hook-1');
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(keyStore.getKey('hook-1'), rotated.secret);
  assert.equal(getAutomationWebhookKey(pair, 'hook-1'), rotated.secret);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), false);
  // The old secret stops verifying immediately.
  const body = '{"ping":1}';
  assert.equal(
    verifyWebhookSignature(created.secret, body, computeWebhookSignature(rotated.secret, body)),
    false,
  );
  assert.equal(
    verifyWebhookSignature(rotated.secret, body, computeWebhookSignature(rotated.secret, body)),
    true,
  );
  assert.equal(hasAutomationWebhookKey(pair, 'hook-1'), true);
  assert.equal(hasAutomationWebhookKey(pair, 'hook-2'), false);
});

test('migration: delete via the pair removes the key from BOTH stores', () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const keyStore = new WebhookKeyStore({
    dir,
    keyFilePath: path.join(dir, 'webhook-keys.json.key'),
  });
  const pair = { store: keyStore, legacyStore: vault };

  // Legacy-only key (never migrated): delete must still remove it.
  createAutomationWebhookKey(vault, 'legacy-1');
  assert.equal(deleteAutomationWebhookKey(pair, 'legacy-1'), true);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'legacy-1'), false);
  assert.equal(keyStore.hasKey('legacy-1'), false);
  assert.equal(deleteAutomationWebhookKey(pair, 'legacy-1'), false, 'second delete finds nothing');

  // Key in both stores at once (e.g. created in the new store while a
  // stale legacy copy lingers): one delete clears both.
  createAutomationWebhookKey(pair, 'both-1');
  vault.setSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'both-1', 'stale-legacy-secret');
  assert.equal(deleteAutomationWebhookKey(pair, 'both-1'), true);
  assert.equal(keyStore.hasKey('both-1'), false);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'both-1'), false);
  assert.equal(getAutomationWebhookKey(pair, 'both-1'), null);
});

test('migration: a scheduler wired to the pair delivers a webhook whose key still lives in the legacy Vault', async () => {
  const { calls, handlers } = makeHandlers();
  const { scheduler, store, vault, keyStore, pair } = makeSandbox(handlers);
  // Key created the old way, straight into the legacy Vault.
  const { secret } = createAutomationWebhookKey(vault, 'hook-1');
  store.save(baseAutomation());
  const body = JSON.stringify({ extra: 'from-webhook' });
  const run = await scheduler.handleWebhook('hook-1', body, computeWebhookSignature(secret, body));
  assert.equal(run.status, 'ok');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: 'a.md', extra: 'from-webhook' });
  // The delivery migrated the key: it now lives in the new store only.
  assert.equal(keyStore.getKey('hook-1'), secret);
  assert.equal(vault.hasSecret(AUTOMATION_WEBHOOK_KEYS_NAMESPACE, 'hook-1'), false);
  assert.equal(getAutomationWebhookKey(pair, 'hook-1'), secret);
});
