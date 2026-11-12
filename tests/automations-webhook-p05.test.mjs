/**
 * Tests for P0-5 (v0.52): automation webhook trigger + cron window +
 * trigger description/presentation + validate-on-enable + retry-run +
 * policy CREATE/CHANGE_POLICY (packages/core/src/automations/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/automations-webhook-p05.test.mjs
 *
 * HMAC is tested against real `node:crypto` vectors (no fixture
 * secret is ever logged). Webhook keys are tested against a real
 * Vault in a temp dir. The scheduler is tested with an injected
 * clock and fake handlers — no provider, tool or network ever runs.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AUTOMATION_WEBHOOK_KEYS_NAMESPACE,
  AutomationScheduler,
  JsonFileAutomationStore,
  applyTriggerInputToAction,
  automationAccessAllows,
  buildTriggerPresentation,
  canAutomationAction,
  computeWebhookSignature,
  createAutomationWebhookKey,
  createRolePolicyChecker,
  deleteAutomationWebhookKey,
  describeTrigger,
  getAutomationWebhookKey,
  getTriggerDescription,
  handleWebhookDelivery,
  hasAutomationWebhookKey,
  missedGraceMs,
  parseWebhookPayload,
  rotateAutomationWebhookKey,
  validateAutomation,
  validateForEnable,
  verifyWebhookSignature,
  viewerAutomationCapabilities,
} from '../packages/core/dist/automations/index.js';
import { Vault } from '../packages/core/dist/vault/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-p05-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function baseAutomation(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'auto-1',
    botId: 'bot-1',
    name: 'Test automation',
    trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'notify', message: 'ping' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Fake handlers recording every call (no provider/tool involved). */
function makeHandlers(failTool = false) {
  const calls = [];
  const state = { failTool };
  return {
    calls,
    state,
    handlers: {
      runAgent: async (botId, prompt) => {
        calls.push({ kind: 'run-agent', botId, prompt });
        return `agent answered: ${prompt.slice(0, 40)}`;
      },
      runTool: async (name, args) => {
        calls.push({ kind: 'run-tool', name, args });
        if (state.failTool) throw new Error('tool boom');
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

function makeScheduler(dir, handlers, opts = {}) {
  const clock = { now: new Date('2026-11-09T10:00:00.000Z') };
  const store = new JsonFileAutomationStore(dir);
  const scheduler = new AutomationScheduler(store, handlers, {
    now: () => new Date(clock.now.getTime()),
    ...opts,
  });
  return { scheduler, store, clock };
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature
// ---------------------------------------------------------------------------

test('webhook HMAC: sign + verify roundtrip; wrong secret/body/signature rejected', () => {
  const secret = 's3cr3t-key';
  const body = '{"event":"deploy","ok":true}';
  const sig = computeWebhookSignature(secret, body);
  assert.ok(sig.startsWith('sha256='));
  assert.equal(sig.length, 'sha256='.length + 64, 'hex SHA-256 is 64 chars');
  assert.equal(verifyWebhookSignature(secret, body, sig), true);
  assert.equal(verifyWebhookSignature(secret, body, computeWebhookSignature(secret, body)), true);
  assert.equal(verifyWebhookSignature('other-secret', body, sig), false);
  assert.equal(verifyWebhookSignature(secret, '{"event":"deploy","ok":false}', sig), false, 'tampered body');
  assert.equal(verifyWebhookSignature(secret, body, null), false, 'missing signature');
  assert.equal(verifyWebhookSignature(secret, body, undefined), false);
  assert.equal(verifyWebhookSignature(secret, body, ''), false);
  assert.equal(verifyWebhookSignature(secret, body, 'sha256=deadbeef'), false, 'short hex');
  assert.equal(verifyWebhookSignature(secret, body, sig.replace('sha256=', '')), false, 'missing prefix');
  // Flip the last hex digit to a digit GUARANTEED different from the
  // original: a fixed '0' is a no-op when the signature already ends
  // in '0' (same latent 1/16 flake as the v059 HTTP test — there the
  // secret is random per run, so the collision actually fired).
  const flippedLastDigit = sig.endsWith('0') ? '1' : '0';
  assert.equal(verifyWebhookSignature(secret, body, sig.slice(0, -1) + flippedLastDigit), false, 'last hex digit flipped');
  assert.equal(verifyWebhookSignature('', body, sig), false, 'empty secret never verifies');
});

test('parseWebhookPayload: valid JSON parses, invalid JSON throws a clear error', () => {
  assert.deepEqual(parseWebhookPayload('{"a":1}'), { a: 1 });
  assert.equal(parseWebhookPayload('"just a string"'), 'just a string');
  assert.throws(() => parseWebhookPayload('{not json'), /not valid JSON/);
  assert.throws(() => parseWebhookPayload(''), /not valid JSON/);
});

test('applyTriggerInputToAction: run-agent appends payload, run-tool merges (action args win)', () => {
  const agent = applyTriggerInputToAction(
    { kind: 'run-agent', botId: 'b', prompt: 'Summarise.' },
    { repo: 'open-bot', pr: 42 },
  );
  assert.equal(agent.kind, 'run-agent');
  assert.ok(agent.prompt.startsWith('Summarise.'));
  assert.ok(agent.prompt.includes('"repo":"open-bot"') || agent.prompt.includes('open-bot'));

  const tool = applyTriggerInputToAction(
    { kind: 'run-tool', tool: 'read_file', args: { path: 'a.md' } },
    { path: 'b.md', extra: 'from-webhook' },
  );
  assert.deepEqual(tool.args, { path: 'a.md', extra: 'from-webhook' });

  const notify = applyTriggerInputToAction({ kind: 'notify', message: 'hi' }, { x: 1 });
  assert.deepEqual(notify, { kind: 'notify', message: 'hi' });
});

// ---------------------------------------------------------------------------
// Webhook keys in the Vault (namespace `automation-webhook-keys/`)
// ---------------------------------------------------------------------------

test('webhook keys: create/get/rotate/delete via a real Vault; secret never listed', () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const created = createAutomationWebhookKey(vault, 'auto-1');
  assert.equal(created.keyId, 'auto-1');
  assert.equal(typeof created.secret, 'string');
  assert.equal(created.secret.length, 64, '32 random bytes, hex-encoded');
  assert.equal(getAutomationWebhookKey(vault, 'auto-1'), created.secret);
  assert.equal(hasAutomationWebhookKey(vault, 'auto-1'), true);
  assert.equal(hasAutomationWebhookKey(vault, 'auto-2'), false);
  assert.equal(getAutomationWebhookKey(vault, 'auto-2'), null);

  // Listing exposes key names only — the secret value is nowhere in it.
  const listed = vault.listSecrets(AUTOMATION_WEBHOOK_KEYS_NAMESPACE);
  assert.deepEqual(listed, ['auto-1']);
  assert.ok(!JSON.stringify(listed).includes(created.secret));

  const rotated = rotateAutomationWebhookKey(vault, 'auto-1');
  assert.equal(rotated.keyId, 'auto-1');
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(getAutomationWebhookKey(vault, 'auto-1'), rotated.secret);
  // The old secret no longer verifies.
  const body = '{"ping":1}';
  assert.equal(verifyWebhookSignature(rotated.secret, body, computeWebhookSignature(rotated.secret, body)), true);
  assert.equal(verifyWebhookSignature(created.secret, body, computeWebhookSignature(rotated.secret, body)), false);

  assert.equal(deleteAutomationWebhookKey(vault, 'auto-1'), true);
  assert.equal(deleteAutomationWebhookKey(vault, 'auto-1'), false, 'second delete finds nothing');
  assert.equal(getAutomationWebhookKey(vault, 'auto-1'), null);
});

// ---------------------------------------------------------------------------
// Validation: webhook trigger, cron window, description, access policy
// ---------------------------------------------------------------------------

test('validateAutomation: webhook needs keyId; cron window must be 1..1440 whole minutes', () => {
  assert.deepEqual(validateAutomation(baseAutomation()), []);
  assert.ok(
    validateAutomation(baseAutomation({ trigger: { kind: 'webhook', keyId: '' } })).some((e) =>
      e.includes('keyId'),
    ),
  );
  assert.ok(
    validateAutomation(baseAutomation({ trigger: { kind: 'webhook' } })).length > 0,
    'missing keyId',
  );
  assert.deepEqual(
    validateAutomation(baseAutomation({ trigger: { kind: 'webhook', keyId: 'auto-1' } })),
    [],
  );
  for (const bad of [0, -5, 1441, 1.5, Number.NaN]) {
    assert.ok(
      validateAutomation(
        baseAutomation({ trigger: { kind: 'cron', expression: '0 9 * * *', window: { minutes: bad } } }),
      ).length > 0,
      `window ${bad} must be rejected`,
    );
  }
  assert.deepEqual(
    validateAutomation(
      baseAutomation({ trigger: { kind: 'cron', expression: '0 9 * * *', window: { minutes: 60 } } }),
    ),
    [],
  );
  assert.ok(
    validateAutomation(baseAutomation({ triggerDescription: 'x'.repeat(501) })).length > 0,
  );
  assert.ok(
    validateAutomation(baseAutomation({ triggerPresentation: { label: '  ' } })).length > 0,
  );
  assert.ok(
    validateAutomation(baseAutomation({ validateOnEnable: 'yes' })).length > 0,
  );
  assert.ok(
    validateAutomation(baseAutomation({ access: { roles: ['superuser'] } })).length > 0,
  );
  assert.deepEqual(validateAutomation(baseAutomation({ access: { roles: ['member'] } })), []);
});

test('describeTrigger / buildTriggerPresentation cover every trigger kind', () => {
  assert.equal(describeTrigger(baseAutomation({ trigger: { kind: 'interval', minutes: 30 } })), 'Every 30 minutes');
  assert.equal(
    describeTrigger(baseAutomation({ trigger: { kind: 'cron', expression: '0 9 * * *', window: { minutes: 15 } } })),
    'Cron 0 9 * * * (allows runs up to 15 min late)',
  );
  assert.equal(
    describeTrigger(baseAutomation({ trigger: { kind: 'webhook', keyId: 'auto-1' } })),
    'Webhook (key auto-1)',
  );
  assert.equal(describeTrigger(baseAutomation({ trigger: { kind: 'manual' } })), 'Manual only');
  assert.equal(
    describeTrigger(baseAutomation({ trigger: { kind: 'event', event: 'file-changed', pathPattern: 'notes/*.md' } })),
    'When a file changes (notes/*.md)',
  );
  const pres = buildTriggerPresentation(
    baseAutomation({ trigger: { kind: 'webhook', keyId: 'auto-1' } }),
  );
  assert.equal(pres.label, 'Webhook');
  assert.equal(pres.detail, 'key auto-1');
  assert.equal(pres.icon, 'webhook');
  // Stored description wins over the computed one; absent falls back.
  assert.equal(
    getTriggerDescription(baseAutomation({ triggerDescription: 'My custom text' })),
    'My custom text',
  );
  assert.equal(
    getTriggerDescription(baseAutomation({ trigger: { kind: 'manual' } })),
    'Manual only',
  );
});

// ---------------------------------------------------------------------------
// Validate-on-enable (fail-closed)
// ---------------------------------------------------------------------------

test('setEnabled(true) on an invalid automation throws and leaves it disabled', () => {
  const dir = makeTempDir();
  const { scheduler, store } = makeScheduler(dir, makeHandlers().handlers);
  // Plant an invalid automation straight into the store (update() would
  // refuse it — this simulates an automation that became invalid after
  // creation, e.g. its cron was edited by hand in the JSON file).
  const planted = baseAutomation({
    enabled: false,
    trigger: { kind: 'cron', expression: 'not a cron' },
  });
  store.save(planted);
  assert.throws(() => scheduler.setEnabled('auto-1', true), /Cannot enable automation/);
  assert.equal(scheduler.get('auto-1').enabled, false, 'stays disabled (fail-closed)');
  // Disabling never validates.
  assert.equal(scheduler.setEnabled('auto-1', false).enabled, false);
});

test('validate-on-enable opt-outs: per-automation flag and global switch', async () => {
  const dir = makeTempDir();
  const bad = () =>
    baseAutomation({ enabled: false, trigger: { kind: 'cron', expression: 'nope' } });

  // Per-automation opt-out.
  const { scheduler: s1, store: store1 } = makeScheduler(dir, makeHandlers().handlers);
  store1.save({ ...bad(), validateOnEnable: false });
  assert.equal(s1.setEnabled('auto-1', true).enabled, true);
  // A tick fires it once (never run = due immediately), then never
  // again: with no computable next run it is skipped, not crashed.
  const firstTick = await s1.tick();
  assert.equal(firstTick.length, 1);
  assert.equal(firstTick[0].status, 'ok');
  assert.deepEqual(await s1.tick(), []);

  // Global switch off.
  const dir2 = makeTempDir();
  const { scheduler: s2, store: store2 } = makeScheduler(dir2, makeHandlers().handlers, {
    validateOnEnable: false,
  });
  store2.save(bad());
  assert.equal(s2.setEnabled('auto-1', true).enabled, true);
});

test('validateForEnable: webhook automation without a Vault key cannot be enabled', () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const { scheduler, store } = makeScheduler(dir, makeHandlers().handlers, {
    webhookKeyProvider: (keyId) => getAutomationWebhookKey(vault, keyId),
  });
  const hook = baseAutomation({
    id: 'hook-1',
    enabled: false,
    trigger: { kind: 'webhook', keyId: 'hook-1' },
  });
  store.save(hook);
  assert.throws(() => scheduler.setEnabled('hook-1', true), /Webhook key/);
  assert.equal(scheduler.get('hook-1').enabled, false);
  // After the key exists, enabling works.
  createAutomationWebhookKey(vault, 'hook-1');
  assert.equal(scheduler.setEnabled('hook-1', true).enabled, true);
  // Direct validateForEnable without a provider skips the key check.
  assert.deepEqual(validateForEnable(baseAutomation({ trigger: { kind: 'webhook', keyId: 'x' } })), []);
});

// ---------------------------------------------------------------------------
// Cron window in the scheduler
// ---------------------------------------------------------------------------

test('missedGraceMs: cron window wins over the 60-minute default', () => {
  const cron = (window) =>
    baseAutomation({ trigger: { kind: 'cron', expression: '0 9 * * *', ...(window ? { window } : {}) } });
  assert.equal(missedGraceMs(cron(undefined)), 60 * 60_000);
  assert.equal(missedGraceMs(cron({ minutes: 10 })), 10 * 60_000);
  assert.equal(missedGraceMs(cron({ minutes: 120 })), 120 * 60_000);
  assert.equal(missedGraceMs(baseAutomation({ trigger: { kind: 'interval', minutes: 30 } })), 60 * 60_000);
});

test('tick: cron run inside its window fires; outside its window it is skipped, never caught up', async () => {
  const dir = makeTempDir();
  const { scheduler, store, clock } = makeScheduler(dir, makeHandlers().handlers);
  const now = clock.now.getTime();
  // Due 90 minutes ago, window 120 -> fires.
  store.save(
    baseAutomation({
      id: 'in-window',
      trigger: { kind: 'cron', expression: '0 9 * * *', window: { minutes: 120 } },
      nextRunAt: new Date(now - 90 * 60_000).toISOString(),
    }),
  );
  // Due 90 minutes ago, window 30 -> skipped.
  store.save(
    baseAutomation({
      id: 'too-late',
      trigger: { kind: 'cron', expression: '0 9 * * *', window: { minutes: 30 } },
      nextRunAt: new Date(now - 90 * 60_000).toISOString(),
    }),
  );
  const runs = await scheduler.tick();
  assert.equal(runs.length, 2);
  const fired = runs.find((r) => r.automationId === 'in-window');
  const skipped = runs.find((r) => r.automationId === 'too-late');
  assert.equal(fired.status, 'ok');
  assert.equal(skipped.status, 'skipped');
  assert.ok(skipped.output.includes('90') || skipped.output.includes('grace'), 'skip reason is recorded');
  // The skipped automation was rescheduled from now, not left in the past.
  assert.ok(new Date(scheduler.get('too-late').nextRunAt).getTime() >= now);
});

// ---------------------------------------------------------------------------
// Webhook delivery through the scheduler
// ---------------------------------------------------------------------------

test('handleWebhook: valid signature runs the action with the payload; bad signature runs nothing', async () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const { calls, handlers } = makeHandlers();
  const { scheduler, store } = makeScheduler(dir, handlers, {
    webhookKeyProvider: (keyId) => getAutomationWebhookKey(vault, keyId),
  });
  const { secret } = createAutomationWebhookKey(vault, 'hook-1');
  store.save(
    baseAutomation({
      id: 'hook-1',
      trigger: { kind: 'webhook', keyId: 'hook-1' },
      action: { kind: 'run-tool', tool: 'read_file', args: { path: 'a.md' } },
    }),
  );
  const body = JSON.stringify({ path: 'b.md', extra: 'from-webhook' });
  const run = await scheduler.handleWebhook('hook-1', body, computeWebhookSignature(secret, body));
  assert.equal(run.status, 'ok');
  assert.equal(run.triggerInput, body);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: 'a.md', extra: 'from-webhook' });

  // Bad signature: throws, no run recorded, handler not called again.
  const runsBefore = scheduler.listRuns('hook-1').length;
  await assert.rejects(
    () => scheduler.handleWebhook('hook-1', body, computeWebhookSignature('wrong-secret', body)),
    /Invalid webhook signature/,
  );
  assert.equal(scheduler.listRuns('hook-1').length, runsBefore);
  assert.equal(calls.length, 1);
});

test('handleWebhook: disabled, non-webhook, missing key and missing provider all refuse', async () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const { secret } = createAutomationWebhookKey(vault, 'hook-1');
  const body = '{"x":1}';
  const sig = computeWebhookSignature(secret, body);

  const { scheduler, store } = makeScheduler(dir, makeHandlers().handlers, {
    webhookKeyProvider: (keyId) => getAutomationWebhookKey(vault, keyId),
  });
  store.save(baseAutomation({ id: 'hook-1', trigger: { kind: 'webhook', keyId: 'hook-1' } }));
  store.save(baseAutomation({ id: 'plain-1', trigger: { kind: 'manual' } }));
  store.save(
    baseAutomation({ id: 'no-key', trigger: { kind: 'webhook', keyId: 'no-key' } }),
  );
  await assert.rejects(() => scheduler.handleWebhook('plain-1', body, sig), /does not have a webhook trigger/);
  await assert.rejects(() => scheduler.handleWebhook('no-key', body, sig), /no webhook key/);
  await assert.rejects(() => scheduler.handleWebhook('missing-id', body, sig), /No automation/);

  const dir2 = makeTempDir();
  const { scheduler: s2, store: s2store } = makeScheduler(dir2, makeHandlers().handlers);
  s2store.save(baseAutomation({ id: 'hook-1', trigger: { kind: 'webhook', keyId: 'hook-1' } }));
  await assert.rejects(() => s2.handleWebhook('hook-1', body, sig), /not configured/);

  // Disabled automation refuses even with a valid signature.
  scheduler.setEnabled('hook-1', false);
  await assert.rejects(() => scheduler.handleWebhook('hook-1', body, sig), /disabled/);
});

test('handleWebhookDelivery: run-agent prompt carries the payload; auth failure records no run', async () => {
  const { calls, handlers } = makeHandlers();
  const auto = baseAutomation({
    id: 'hook-1',
    trigger: { kind: 'webhook', keyId: 'hook-1' },
    action: { kind: 'run-agent', botId: 'bot-1', prompt: 'Summarise the deploy.' },
  });
  const body = JSON.stringify({ repo: 'open-bot', pr: 7 });
  const run = await handleWebhookDelivery(auto, {
    rawBody: body,
    signature: computeWebhookSignature('k', body),
    secret: 'k',
    handlers,
  });
  assert.equal(run.status, 'ok');
  assert.ok(calls[0].prompt.includes('Summarise the deploy.'));
  assert.ok(calls[0].prompt.includes('"pr":7'));
  await assert.rejects(
    () =>
      handleWebhookDelivery(auto, {
        rawBody: body,
        signature: 'sha256=nope',
        secret: 'k',
        handlers,
      }),
    /Invalid webhook signature/,
  );
  assert.equal(calls.length, 1, 'rejected delivery never reached the handler');
});

// ---------------------------------------------------------------------------
// Retry-run
// ---------------------------------------------------------------------------

test('retryRun: re-runs the last failed run with the same input and links it', async () => {
  const dir = makeTempDir();
  const vault = new Vault({
    storePath: path.join(dir, 'vault.json'),
    keyFilePath: path.join(dir, 'vault.json.key'),
  });
  const made = makeHandlers(true); // tool fails at first
  const { scheduler, store } = makeScheduler(dir, made.handlers, {
    webhookKeyProvider: (keyId) => getAutomationWebhookKey(vault, keyId),
  });
  const { secret } = createAutomationWebhookKey(vault, 'hook-1');
  store.save(
    baseAutomation({
      id: 'hook-1',
      trigger: { kind: 'webhook', keyId: 'hook-1' },
      action: { kind: 'run-tool', tool: 'read_file', args: { path: 'a.md' } },
    }),
  );
  const body = JSON.stringify({ extra: 'same-input' });
  const failed = await scheduler.handleWebhook('hook-1', body, computeWebhookSignature(secret, body));
  assert.equal(failed.status, 'error');
  assert.ok(failed.error.includes('tool boom'));
  assert.equal(made.calls.length, 1);

  // Fix the tool, then retry: same input must reach the handler again.
  made.state.failTool = false;
  const retried = await scheduler.retryLastFailedRun('hook-1');
  assert.equal(retried.status, 'ok');
  assert.equal(retried.retriedFromRunId, failed.id);
  assert.equal(retried.triggerInput, body);
  assert.equal(made.calls.length, 2);
  assert.deepEqual(made.calls[1].args, { path: 'a.md', extra: 'same-input' });

  // No failed run left to retry; retrying an ok run throws.
  await assert.rejects(() => scheduler.retryLastFailedRun('hook-1'), /no failed run/);
  await assert.rejects(() => scheduler.retryRun(retried.id), /did not fail/);
  await assert.rejects(() => scheduler.retryRun('no-such-run'), /No automation run/);
});

// ---------------------------------------------------------------------------
// Policy CREATE / CHANGE_POLICY / viewer capabilities
// ---------------------------------------------------------------------------

test('policy: role matrix — admin all, member own-only, viewer OPEN only', () => {
  assert.deepEqual(viewerAutomationCapabilities('admin'), [
    'CREATE',
    'CHANGE_POLICY',
    'OPEN',
    'TOGGLE',
    'EDIT',
    'DELETE',
  ]);
  assert.deepEqual(viewerAutomationCapabilities('member'), ['CREATE', 'OPEN', 'TOGGLE', 'EDIT', 'DELETE']);
  assert.deepEqual(viewerAutomationCapabilities('viewer'), ['OPEN']);
  assert.equal(canAutomationAction('admin', 'CHANGE_POLICY'), true);
  assert.equal(canAutomationAction('member', 'CHANGE_POLICY'), false);
  assert.equal(canAutomationAction('viewer', 'CREATE'), false);
  assert.equal(canAutomationAction('viewer', 'OPEN'), true);
  assert.equal(canAutomationAction('viewer', 'TOGGLE'), false);
  assert.equal(canAutomationAction('member', 'EDIT', { userId: 'u1', createdBy: 'u1' }), true);
  assert.equal(canAutomationAction('member', 'EDIT', { userId: 'u1', createdBy: 'u2' }), false);
  assert.equal(canAutomationAction('member', 'EDIT', { userId: 'u1', createdBy: '' }), true, 'legacy unowned');
  assert.equal(canAutomationAction('member', 'DELETE', { userId: 'u1', createdBy: 'u2' }), false);
  assert.equal(canAutomationAction('admin', 'DELETE', { userId: 'a', createdBy: 'u2' }), true);
  assert.equal(canAutomationAction('nobody', 'OPEN'), false, 'unknown role denied (fail-closed)');
  assert.equal(canAutomationAction('admin', 'BOGUS'), false, 'unknown action denied');
  assert.equal(
    automationAccessAllows(baseAutomation({ access: { roles: ['member'] } }), 'admin'),
    true,
    'admin bypasses access.roles',
  );
  assert.equal(
    automationAccessAllows(baseAutomation({ access: { roles: ['member'] } }), 'viewer'),
    false,
  );
  assert.equal(automationAccessAllows(baseAutomation(), 'viewer'), true, 'no access field = no restriction');
});

test('scheduler policy: viewer cannot create; member manages only their own; CHANGE_POLICY is admin-only', async () => {
  const dir = makeTempDir();
  const viewer = makeScheduler(dir, makeHandlers().handlers, {
    policyChecker: createRolePolicyChecker('viewer', 'v1'),
  });
  assert.throws(() => viewer.scheduler.create(baseAutomation()), /not allowed/);

  const member = makeScheduler(dir, makeHandlers().handlers, {
    policyChecker: createRolePolicyChecker('member', 'u1'),
    currentUserId: 'u1',
  });
  const own = member.scheduler.create(baseAutomation({ id: 'own-1' }));
  assert.equal(own.createdBy, 'u1');
  // Another member's automation, planted directly.
  member.store.save(baseAutomation({ id: 'other-1', createdBy: 'u2' }));
  assert.throws(() => member.scheduler.update({ ...member.scheduler.get('other-1'), name: 'x' }), /not allowed/);
  assert.throws(() => member.scheduler.setEnabled('other-1', false), /not allowed/);
  assert.throws(() => member.scheduler.remove('other-1'), /not allowed/);
  await assert.rejects(() => member.scheduler.runNow('other-1'), /not allowed/);
  // Own automation: edit + toggle work.
  assert.equal(member.scheduler.setEnabled('own-1', false).enabled, false);
  assert.equal(member.scheduler.setEnabled('own-1', true).enabled, true);

  // Changing `access` is a policy change: member denied, admin allowed.
  assert.throws(
    () =>
      member.scheduler.update({
        ...member.scheduler.get('own-1'),
        access: { roles: ['admin'] },
      }),
    /not allowed/,
  );
  const admin = makeScheduler(dir, makeHandlers().handlers, {
    policyChecker: createRolePolicyChecker('admin', 'a1'),
  });
  const updated = admin.scheduler.update({
    ...admin.scheduler.get('own-1'),
    access: { roles: ['admin'] },
  });
  assert.deepEqual(updated.access, { roles: ['admin'] });
  // access.roles now blocks the member even for their own automation.
  assert.throws(() => member.scheduler.setEnabled('own-1', false), /not allowed/);
});
