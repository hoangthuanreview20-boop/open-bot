/**
 * Core tests for v0.83b — Composio triggers → automations.
 *
 *   - parseComposioTriggerPayload: the real V3 envelope from
 *     Composio's docs (GITHUB_COMMIT_EVENT) parses to triggerSlug +
 *     metadata + data; `payload` alias works; invalid JSON / no
 *     metadata / no slug / bad slug shape / no data all throw.
 *   - verifyComposioWebhookSignature: compute→verify round-trips;
 *     tampered body, wrong secret, stale timestamp (>300 s), missing
 *     headers and a malformed signature all fail; bare base64 is
 *     accepted (forwarders that strip the `v1,` prefix).
 *   - Trigger defs: 50 curated entries from the live catalog;
 *     per-toolkit counts sum to 244; Telegram/Dropbox have 0.
 *   - triggerKeys: signing secret set/get/has/delete + URL token
 *     create/rotate/get/has/delete in a fake Vault; deleting both.
 *   - AutomationScheduler.handleComposioTrigger (real
 *     JsonFileAutomationStore, fake handlers): a signed delivery
 *     runs the action with the event as trigger input (run-agent
 *     prompt carries the event data; run recorded with trigger
 *     'composio'); a wrong signature, no auth, a slug mismatch and
 *     a disabled automation all throw with NO run recorded; the
 *     `?token=` fallback runs when no signature is present, but a
 *     present-but-invalid signature beats a valid token.
 *   - validateAutomation / validateForEnable for the 'composio'
 *     trigger kind (bad slug shape, missing key, missing secret).
 *
 * No Composio key, no network, no real provider ever runs — the
 * "live" side is the catalog snapshot in
 * scripts/composio-triggers-live-v083/ (mock payloads here only).
 *
 * Run: npm run build --workspace=@open-bot/core && node --test tests/composio-triggers-v083.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AutomationScheduler,
  JsonFileAutomationStore,
  validateAutomation,
  validateForEnable,
} from '../packages/core/dist/automations/index.js';
import {
  COMPOSIO_TRIGGER_COUNTS,
  COMPOSIO_TRIGGER_DEFS,
  COMPOSIO_TRIGGER_TOTAL_COUNT,
  computeComposioWebhookSignature,
  composioTriggerTokenKeyId,
  createComposioTriggerToken,
  deleteComposioTriggerSecrets,
  findComposioTriggerDef,
  getComposioTriggerSigningSecret,
  getComposioTriggerToken,
  hasComposioTriggerSigningSecret,
  hasComposioTriggerToken,
  isKnownComposioTriggerSlug,
  isValidComposioTriggerSlug,
  parseComposioTriggerPayload,
  rotateComposioTriggerToken,
  setComposioTriggerSigningSecret,
  verifyComposioTriggerToken,
  verifyComposioWebhookSignature,
} from '../packages/core/dist/composio/index.js';

const SECRET = 'test-composio-webhook-secret-v083';
const TOKEN = 'test-composio-url-token-v083';

/** The V3 envelope from Composio's docs ("Receiving events"). */
function githubCommitEnvelope() {
  return JSON.stringify({
    id: 'msg_abc123',
    type: 'composio.trigger.message',
    metadata: {
      log_id: 'log_abc123',
      trigger_slug: 'GITHUB_COMMIT_EVENT',
      trigger_id: 'ti_xyz789',
      connected_account_id: 'ca_def456',
      auth_config_id: 'ac_xyz789',
      user_id: 'user-id-123435',
    },
    data: { commit_sha: 'a1b2c3d', message: 'fix: resolve null pointer', author: 'jane' },
    timestamp: '2026-01-15T10:30:00Z',
  });
}

function gmailEnvelope() {
  return JSON.stringify({
    id: 'msg_gmail1',
    type: 'composio.trigger.message',
    metadata: {
      trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      trigger_id: 'ti_gmail1',
      connected_account_id: 'ca_gmail1',
      user_id: 'user-1',
    },
    data: { subject: 'Hello from the outside', from: 'boss@example.com', snippet: 'Please review…' },
    timestamp: new Date().toISOString(),
  });
}

function sign(rawBody, webhookId = 'wh_123') {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    webhookId,
    webhookTimestamp: ts,
    webhookSignature: computeComposioWebhookSignature(SECRET, webhookId, ts, rawBody),
  };
}

test('parseComposioTriggerPayload: V3 envelope, payload alias, and rejections', () => {
  const ev = parseComposioTriggerPayload(githubCommitEnvelope());
  assert.equal(ev.triggerSlug, 'GITHUB_COMMIT_EVENT');
  assert.equal(ev.triggerId, 'ti_xyz789');
  assert.equal(ev.connectedAccountId, 'ca_def456');
  assert.equal(ev.userId, 'user-id-123435');
  assert.deepEqual(ev.data, { commit_sha: 'a1b2c3d', message: 'fix: resolve null pointer', author: 'jane' });

  const aliased = parseComposioTriggerPayload(
    JSON.stringify({ metadata: { trigger_slug: 'SLACK_CHANNEL_MESSAGE_RECEIVED' }, payload: { text: 'hi' } }),
  );
  assert.equal(aliased.triggerSlug, 'SLACK_CHANNEL_MESSAGE_RECEIVED');
  assert.deepEqual(aliased.data, { text: 'hi' });

  assert.throws(() => parseComposioTriggerPayload('not json'), /not valid JSON/);
  assert.throws(() => parseComposioTriggerPayload('[]'), /JSON object/);
  assert.throws(() => parseComposioTriggerPayload('{"data":{}}'), /no metadata/);
  assert.throws(() => parseComposioTriggerPayload('{"metadata":{},"data":{}}'), /no metadata\.trigger_slug/);
  assert.throws(
    () => parseComposioTriggerPayload('{"metadata":{"trigger_slug":"lower_case"},"data":{}}'),
    /unexpected shape/,
  );
  assert.throws(
    () => parseComposioTriggerPayload('{"metadata":{"trigger_slug":"GMAIL_NEW_GMAIL_MESSAGE"}}'),
    /neither data nor payload/,
  );
});

test('verifyComposioWebhookSignature: round-trip, tamper, replay, malformed', () => {
  const body = githubCommitEnvelope();
  const { webhookId, webhookTimestamp, webhookSignature } = sign(body);
  assert.equal(verifyComposioWebhookSignature(SECRET, webhookId, webhookTimestamp, body, webhookSignature), true);
  // Tampered body fails.
  assert.equal(
    verifyComposioWebhookSignature(SECRET, webhookId, webhookTimestamp, body + ' ', webhookSignature),
    false,
  );
  // Wrong secret fails.
  assert.equal(
    verifyComposioWebhookSignature('wrong-secret', webhookId, webhookTimestamp, body, webhookSignature),
    false,
  );
  // Stale timestamp (>300 s) fails — replay protection.
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  const oldSig = computeComposioWebhookSignature(SECRET, webhookId, oldTs, body);
  assert.equal(verifyComposioWebhookSignature(SECRET, webhookId, oldTs, body, oldSig), false);
  // Missing pieces fail.
  assert.equal(verifyComposioWebhookSignature(SECRET, null, webhookTimestamp, body, webhookSignature), false);
  assert.equal(verifyComposioWebhookSignature(SECRET, webhookId, webhookTimestamp, body, null), false);
  assert.equal(verifyComposioWebhookSignature('', webhookId, webhookTimestamp, body, webhookSignature), false);
  // Malformed signature fails.
  assert.equal(verifyComposioWebhookSignature(SECRET, webhookId, webhookTimestamp, body, 'v1,!!!'), false);
  // Bare base64 (prefix stripped by a forwarder) is accepted.
  const bare = webhookSignature.slice('v1,'.length);
  assert.equal(verifyComposioWebhookSignature(SECRET, webhookId, webhookTimestamp, body, bare), true);
});

test('trigger defs: 50 curated entries, counts sum to 244, telegram/dropbox have none', () => {
  assert.equal(COMPOSIO_TRIGGER_DEFS.length, 50);
  assert.equal(COMPOSIO_TRIGGER_TOTAL_COUNT, 244);
  const sum = Object.values(COMPOSIO_TRIGGER_COUNTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 244, 'per-toolkit counts must sum to the live total');
  assert.equal(COMPOSIO_TRIGGER_COUNTS.telegram, 0);
  assert.equal(COMPOSIO_TRIGGER_COUNTS.dropbox, 0);
  for (const def of COMPOSIO_TRIGGER_DEFS) {
    assert.ok(isValidComposioTriggerSlug(def.slug), def.slug);
    assert.ok(def.toolkit && def.name, def.slug);
    assert.ok(def.delivery === 'webhook' || def.delivery === 'poll', def.slug);
  }
  assert.equal(findComposioTriggerDef('GITHUB_COMMIT_EVENT')?.toolkit, 'github');
  assert.equal(findComposioTriggerDef('SLACK_CHANNEL_MESSAGE_RECEIVED')?.delivery, 'webhook');
  assert.equal(isKnownComposioTriggerSlug('GMAIL_NEW_GMAIL_MESSAGE'), true);
  assert.equal(isKnownComposioTriggerSlug('SOME_UNLISTED_TRIGGER'), false);
  assert.equal(isValidComposioTriggerSlug('lower_case'), false);
  assert.equal(isValidComposioTriggerSlug(''), false);
  assert.equal(isValidComposioTriggerSlug('AB'), false);
});

/** Minimal in-memory Vault for the key tests. */
function fakeVault() {
  const map = new Map();
  return {
    getSecret: (ns, key) => map.get(`${ns}/${key}`) ?? null,
    setSecret: (ns, key, value) => {
      map.set(`${ns}/${key}`, value);
    },
    deleteSecret: (ns, key) => map.delete(`${ns}/${key}`),
    hasSecret: (ns, key) => map.has(`${ns}/${key}`),
  };
}

test('triggerKeys: signing secret + URL token lifecycle in a fake Vault', () => {
  const vault = fakeVault();
  assert.equal(hasComposioTriggerSigningSecret(vault, 'auto-1'), false);
  setComposioTriggerSigningSecret(vault, 'auto-1', SECRET);
  assert.equal(getComposioTriggerSigningSecret(vault, 'auto-1'), SECRET);
  assert.equal(hasComposioTriggerSigningSecret(vault, 'auto-1'), true);
  assert.throws(() => setComposioTriggerSigningSecret(vault, 'auto-2', '   '), /must not be empty/);

  assert.equal(composioTriggerTokenKeyId('auto-1'), 'auto-1-url-token');
  assert.equal(hasComposioTriggerToken(vault, 'auto-1'), false);
  const created = createComposioTriggerToken(vault, 'auto-1');
  assert.equal(created.keyId, 'auto-1-url-token');
  assert.equal(created.secret.length, 64, '32 random bytes, hex');
  assert.equal(getComposioTriggerToken(vault, 'auto-1'), created.secret);
  assert.equal(verifyComposioTriggerToken(created.secret, created.secret), true);
  assert.equal(verifyComposioTriggerToken(created.secret, 'wrong'), false);
  assert.equal(verifyComposioTriggerToken(created.secret, null), false);
  const rotated = rotateComposioTriggerToken(vault, 'auto-1');
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(getComposioTriggerToken(vault, 'auto-1'), rotated.secret);

  deleteComposioTriggerSecrets(vault, 'auto-1');
  assert.equal(hasComposioTriggerSigningSecret(vault, 'auto-1'), false);
  assert.equal(hasComposioTriggerToken(vault, 'auto-1'), false);
});

// --- Scheduler -----------------------------------------------------------

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-composio-v083-'));
  tempDirs.push(dir);
  return dir;
}

function makeScheduler({ secret = SECRET, token = TOKEN, withToken = true } = {}) {
  const dir = makeTempDir();
  const store = new JsonFileAutomationStore(dir);
  const agentPrompts = [];
  const toolCalls = [];
  const handlers = {
    runAgent: async (botId, prompt) => {
      agentPrompts.push({ botId, prompt });
      return `agent saw: ${prompt.slice(0, 200)}`;
    },
    runTool: async (name, args) => {
      toolCalls.push({ name, args });
      return `tool ${name} ok`;
    },
    createTask: async () => 'task-1',
    notify: () => undefined,
  };
  const scheduler = new AutomationScheduler(store, handlers, {
    composioWebhookSecretProvider: (keyId) => (keyId === 'auto-1' ? secret : null),
    composioTriggerTokenProvider: (keyId) => (keyId === 'auto-1-url-token' ? token : null),
  });
  return { scheduler, store, agentPrompts, toolCalls, dir };
}

function composioAutomation(overrides = {}) {
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

test('scheduler.handleComposioTrigger: signed delivery runs with the event as input', async () => {
  const { scheduler, store, agentPrompts } = makeScheduler();
  scheduler.create(composioAutomation());
  const body = gmailEnvelope();
  const run = await scheduler.handleComposioTrigger('auto-1', body, sign(body));
  assert.equal(run.status, 'ok');
  assert.equal(run.trigger, 'composio');
  assert.equal(agentPrompts.length, 1);
  assert.ok(agentPrompts[0].prompt.includes('Tóm tắt mail mới.'), 'original prompt kept');
  assert.ok(agentPrompts[0].prompt.includes('Hello from the outside'), 'event data appended to the prompt');
  assert.ok(agentPrompts[0].prompt.includes('GMAIL_NEW_GMAIL_MESSAGE'), 'slug in the prompt context');
  const stored = store.listRuns('auto-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'ok');
  assert.ok(stored[0].triggerInput?.includes('GMAIL_NEW_GMAIL_MESSAGE'), 'run history keeps the trigger input');
});

test('scheduler.handleComposioTrigger: bad signature / no auth / slug mismatch record no run', async () => {
  const { scheduler, store } = makeScheduler();
  scheduler.create(composioAutomation());
  const body = gmailEnvelope();
  const good = sign(body);
  // Wrong signature.
  await assert.rejects(
    scheduler.handleComposioTrigger('auto-1', body, { ...good, webhookSignature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    /Invalid Composio webhook signature/,
  );
  // No auth at all.
  await assert.rejects(scheduler.handleComposioTrigger('auto-1', body, {}), /needs a signature/);
  // Slug mismatch: a GitHub event delivered to a Gmail automation.
  const ghBody = githubCommitEnvelope();
  await assert.rejects(scheduler.handleComposioTrigger('auto-1', ghBody, sign(ghBody)), /slug mismatch/);
  // Invalid JSON with a valid signature for that body.
  const badJson = '{oops';
  await assert.rejects(scheduler.handleComposioTrigger('auto-1', badJson, sign(badJson)), /not valid JSON/);
  assert.equal(store.listRuns('auto-1').length, 0, 'rejected deliveries record no run');
});

test('scheduler.handleComposioTrigger: token fallback, and a bad signature beats a good token', async () => {
  const { scheduler, store } = makeScheduler();
  scheduler.create(composioAutomation());
  const body = gmailEnvelope();
  // Token only (no signature headers) runs.
  const run = await scheduler.handleComposioTrigger('auto-1', body, { token: TOKEN });
  assert.equal(run.status, 'ok');
  // Wrong token fails.
  await assert.rejects(scheduler.handleComposioTrigger('auto-1', body, { token: 'nope' }), /Invalid Composio trigger token/);
  // Bad signature + good token: the signature is evidence of tampering.
  const good = sign(body);
  await assert.rejects(
    scheduler.handleComposioTrigger('auto-1', body, { ...good, webhookSignature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', token: TOKEN }),
    /Invalid Composio webhook signature/,
  );
  assert.equal(store.listRuns('auto-1').length, 1, 'only the token-only delivery ran');
});

test('scheduler.handleComposioTrigger: disabled automation and run-tool input mapping', async () => {
  const { scheduler, store, toolCalls } = makeScheduler();
  scheduler.create(
    composioAutomation({
      action: { kind: 'run-tool', tool: 'notify_tool', args: { fixed: true } },
    }),
  );
  scheduler.setEnabled('auto-1', false);
  const body = gmailEnvelope();
  await assert.rejects(scheduler.handleComposioTrigger('auto-1', body, sign(body)), /disabled/);
  scheduler.setEnabled('auto-1', true);
  const run = await scheduler.handleComposioTrigger('auto-1', body, sign(body));
  assert.equal(run.status, 'ok');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].args.fixed, true, 'explicit action args win over payload keys');
  assert.equal(store.listRuns('auto-1').length, 1);
});

test('validateAutomation / validateForEnable for the composio trigger kind', async () => {
  const bad = composioAutomation({ trigger: { kind: 'composio', triggerSlug: 'lower_case', keyId: 'auto-1' } });
  assert.ok(validateAutomation(bad).some((e) => e.includes('triggerSlug')));
  const noKey = composioAutomation({ trigger: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', keyId: '' } });
  assert.ok(validateAutomation(noKey).some((e) => e.includes('keyId')));
  const ok = composioAutomation();
  assert.deepEqual(validateAutomation(ok), []);

  // validate-on-enable fails without the signing secret, passes with it.
  const { scheduler } = makeScheduler({ secret: null });
  scheduler.create(composioAutomation());
  assert.throws(() => scheduler.setEnabled('auto-1', true), /COMPOSIO_WEBHOOK_SECRET/);
  const { scheduler: withSecret } = makeScheduler({ secret: SECRET });
  withSecret.create(composioAutomation());
  assert.equal(withSecret.setEnabled('auto-1', true).enabled, true);
});
