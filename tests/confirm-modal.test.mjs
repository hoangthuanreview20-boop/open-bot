/**
 * ConfirmModal + automation run history (v0.64, renderer-only + core).
 *
 * Part 1 — run history:
 * - Core: every run record carries the trigger kind that fired it
 *   (`executeAutomation`, skipped runs, webhook deliveries all go
 *   through `executeAutomation`); the store keeps the newest 100 runs
 *   (MAX_RUN_HISTORY), which is what the history tab shows.
 * - AutomationsView: a "Run history" tab lists the newest 100 runs
 *   (newest first) with automation + status filters, a running row
 *   while a run started from this view is in flight, and a detail
 *   panel (log text) on click.
 *
 * Part 2 — window.confirm cleanup:
 * - NO `window.confirm(` call remains in the renderer: v0.64 replaced
 *   14 sites with the shared in-app ConfirmModal, and v0.71 replaced
 *   the last two (the intentional native L5 vault dialogs in
 *   SettingsView — changeNoStorage: vaultNoStorageFlushConfirm /
 *   vaultNoStorageDiscardConfirm) with the same modal, as a two-step
 *   flow. Every site opens ConfirmModal with the same i18n question
 *   text; Cancel runs nothing (except the L5 second dialog, whose
 *   Cancel saves the temporary secrets — see its `onCancel`), Confirm
 *   runs the action.
 *
 * Run: node --test tests/confirm-modal.test.mjs
 * (also run tests/i18n.test.mjs — the new keys must exist in vi+en.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AutomationScheduler,
  JsonFileAutomationStore,
  MAX_RUN_HISTORY,
  executeAutomation,
} from '../packages/core/dist/automations/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const renderer = path.join(repo, 'apps/desktop/src/renderer');
const components = path.join(renderer, 'components');
const read = (p) => fs.readFileSync(p, 'utf-8');
const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));

const modalSrc = read(path.join(components, 'ConfirmModal.tsx'));
const automationsSrc = read(path.join(components, 'AutomationsView.tsx'));

/** Views that used to call window.confirm (none keeps a native call since v0.71). */
const CONFIRM_VIEWS = [
  'SettingsView.tsx',
  'AgentMarketplaceView.tsx',
  'McpMarketplaceView.tsx',
  'TeamView.tsx',
  'TemplatePluginModal.tsx',
  'A2aClientView.tsx',
  'GroupView.tsx',
  'AutomationsView.tsx',
];

/** The confirm question key each replaced site must still ask. */
const KEPT_QUESTIONS = [
  ['SettingsView.tsx', 'settings.customCliRemoveConfirm'],
  ['SettingsView.tsx', 'settings.apiRegenerateConfirm'],
  ['SettingsView.tsx', 'settings.apiWebhookDeleteConfirm'],
  ['SettingsView.tsx', 'settings.usageResetConfirm'],
  ['SettingsView.tsx', 'settings.vaultDeleteConfirm'],
  ['SettingsView.tsx', 'settings.vaultNoStorageFlushConfirm'],
  ['SettingsView.tsx', 'settings.vaultNoStorageDiscardConfirm'],
  ['AgentMarketplaceView.tsx', 'marketplace.uninstallConfirm'],
  ['McpMarketplaceView.tsx', 'mcp.uninstallConfirm'],
  ['TeamView.tsx', 'team.removeConfirm'],
  ['TeamView.tsx', 'team.serviceAccountDeleteConfirm'],
  ['TemplatePluginModal.tsx', 'pluginTemplate.deleteConfirm'],
  ['A2aClientView.tsx', 'a2a.removeConfirm'],
  ['GroupView.tsx', 'group.deleteConfirm'],
  ['AutomationsView.tsx', 'automations.webhookKeyDeleteConfirm'],
  ['AutomationsView.tsx', 'automations.deleteConfirm'],
];

const HISTORY_KEYS = [
  'automations.historyTab',
  'automations.historyFilterAutomation',
  'automations.historyFilterStatus',
  'automations.historyFilterAll',
  'automations.historyEmpty',
  'automations.historyDetailTitle',
  'automations.historyTrigger',
  'automations.historyStarted',
  'automations.historyFinished',
  'automations.historyDuration',
  'automations.historyOutput',
  'automations.historyError',
  'automations.historyTriggerInput',
  'automations.historyClose',
  'automations.runStatus.running',
];

const vietnamese = /[À-ỹđĐ]/;

// ---------------------------------------------------------------------------
// ConfirmModal component
// ---------------------------------------------------------------------------

test('ConfirmModal: in-app modal on the delete-bot pattern, no native dialog', () => {
  assert.match(modalSrc, /className="modal-backdrop"/, 'backdrop');
  assert.match(modalSrc, /role="alertdialog"/, 'alertdialog role');
  assert.match(modalSrc, /data-testid="confirm-modal"/, 'modal test id');
  assert.match(modalSrc, /data-testid="confirm-modal-confirm"/, 'confirm button test id');
  assert.match(modalSrc, /data-testid="confirm-modal-cancel"/, 'cancel button test id');
  assert.match(modalSrc, /t\('botForm\.cancel'\)/, 'Cancel label comes from i18n');
  assert.match(modalSrc, /onClick=\{onCancel\}/, 'backdrop click cancels');
  assert.match(modalSrc, /e\.stopPropagation\(\)/, 'click inside the modal does not cancel');
  assert.match(modalSrc, /addEventListener\('keydown', onKey, true\)/, 'Esc listener (capture)');
  assert.match(modalSrc, /if \(e\.key !== 'Escape'\) return;/, 'only Esc cancels');
  assert.ok(!modalSrc.includes('window.confirm('), 'ConfirmModal itself never calls window.confirm');
  assert.ok(!vietnamese.test(modalSrc), 'no hard-coded Vietnamese in ConfirmModal');
  assert.match(modalSrc, /export interface PendingConfirm/, 'shared pending-confirm state type');
  assert.match(modalSrc, /onConfirm: \(\) => void/, 'pending confirm carries the action');
  assert.match(modalSrc, /onCancel\?: \(\) => void/, 'pending confirm may carry a cancel action (L5 dialog 2 = save)');
  assert.match(modalSrc, /danger\?: boolean/, 'pending confirm may override the danger styling');
});

test('ConfirmModal: confirm button is danger-styled by default', () => {
  assert.match(modalSrc, /danger = true/, 'danger defaults on (delete/remove actions)');
  assert.match(modalSrc, /className=\{danger \? 'btn danger' : 'btn'\}/, 'danger class on confirm');
});

// ---------------------------------------------------------------------------
// window.confirm audit
// ---------------------------------------------------------------------------

test('window.confirm: none remain in the renderer (v0.71 removed the last two L5 vault dialogs)', () => {
  const calls = [];
  for (const file of fs.readdirSync(components).filter((f) => f.endsWith('.tsx'))) {
    const src = read(path.join(components, file));
    for (const m of src.matchAll(/window\.confirm\(/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      calls.push(`${file}:${line}`);
    }
  }
  for (const file of ['App.tsx', 'main.tsx']) {
    const src = read(path.join(renderer, file));
    assert.ok(!src.includes('window.confirm('), `${file} must not call window.confirm`);
  }
  assert.deepEqual(
    calls,
    [],
    `expected zero window.confirm calls in the renderer, got: ${calls.join(', ')}`,
  );
  const settingsSrc = read(path.join(components, 'SettingsView.tsx'));
  assert.ok(
    settingsSrc.includes("t('settings.vaultNoStorageFlushConfirm'"),
    'L5 dialog 1 (flush) is still asked, now through ConfirmModal',
  );
  assert.ok(
    settingsSrc.includes("t('settings.vaultNoStorageDiscardConfirm'"),
    'L5 dialog 2 (discard) is still asked, now through ConfirmModal',
  );
  assert.ok(
    settingsSrc.includes('onCancel: () => void applyNoStorageChange(false, false)'),
    'L5 dialog 2 Cancel still saves (flushes) the temporary secrets',
  );
  assert.ok(
    settingsSrc.includes('onConfirm: () => void applyNoStorageChange(false, true)'),
    'L5 dialog 2 Confirm still deletes the temporary secrets',
  );
});

test('every replaced view opens ConfirmModal with the same question text', () => {
  for (const file of CONFIRM_VIEWS) {
    const src = read(path.join(components, file));
    assert.ok(src.includes("from './ConfirmModal'"), `${file} must import ConfirmModal`);
    assert.ok(src.includes('PendingConfirm'), `${file} must use the PendingConfirm state`);
    assert.ok(src.includes('<ConfirmModal'), `${file} must render ConfirmModal`);
    if (file === 'SettingsView.tsx') {
      // SettingsView's Cancel also runs the pending onCancel (L5 dialog
      // 2 = save the temporary secrets) — asserted below, not here.
      assert.ok(
        src.includes('onCancel={() => {'),
        `${file}: modal Cancel must clear the pending confirm`,
      );
    } else {
      assert.ok(
        src.includes('onCancel={() => setPendingConfirm(null)}'),
        `${file}: Cancel must only close the modal`,
      );
    }
    assert.ok(
      src.includes('c.onConfirm();'),
      `${file}: Confirm must run the pending action`,
    );
  }
  for (const [file, key] of KEPT_QUESTIONS) {
    const src = read(path.join(components, file));
    assert.ok(src.includes(`t('${key}'`), `${file} must still ask ${key}`);
  }
  // SettingsView is the one view whose Cancel runs something: the L5
  // second dialog's Cancel saves the temporary secrets (its onCancel),
  // so its modal onCancel clears the pending confirm AND runs
  // c.onCancel?.() instead of only clearing it.
  const settingsSrc = read(path.join(components, 'SettingsView.tsx'));
  assert.ok(
    settingsSrc.includes('c.onCancel?.();'),
    'SettingsView: modal Cancel must run the pending onCancel (L5 dialog 2 = save)',
  );
  assert.ok(
    settingsSrc.includes('danger={pendingConfirm.danger ?? true}'),
    'SettingsView: the modal must honour the pending danger flag (L5 dialog 1 is not danger)',
  );
});

test('SettingsView: the replaced sites each have a do* action behind the modal (plus the L5 apply)', () => {
  const src = read(path.join(components, 'SettingsView.tsx'));
  for (const name of [
    'doRemoveCustomCli',
    'doRegenerateToken',
    'doRemoveWebhook',
    'doResetUsage',
    'doDeleteVaultKey',
    'applyNoStorageChange',
  ]) {
    assert.ok(src.includes(`const ${name} = async`), `SettingsView must keep ${name} as the confirmed action`);
  }
});

// ---------------------------------------------------------------------------
// Run history: i18n + AutomationsView
// ---------------------------------------------------------------------------

test('i18n: all run-history keys exist, non-empty, in vi + en', () => {
  assert.equal(HISTORY_KEYS.length, 15, 'the key list must stay complete');
  for (const key of HISTORY_KEYS) {
    assert.ok(key in vi, `key ${key} missing in vi.json`);
    assert.ok(key in en, `key ${key} missing in en.json`);
    assert.ok(vi[key].trim().length > 0 && en[key].trim().length > 0, `key ${key} must be non-empty`);
  }
});

test('AutomationsView: history tab with filters, rows and detail', () => {
  assert.match(automationsSrc, /data-testid="automations-tab-history"/, 'history tab button');
  assert.match(automationsSrc, /data-testid="automations-tab-list"/, 'list tab button');
  assert.match(automationsSrc, /data-testid="history-filter-automation"/, 'automation filter');
  assert.match(automationsSrc, /data-testid="history-filter-status"/, 'status filter');
  assert.match(automationsSrc, /data-testid="run-history-row"/, 'history rows');
  assert.match(automationsSrc, /data-testid="run-history-detail"/, 'detail panel');
  assert.match(automationsSrc, /t\('automations\.historyTab'\)/, 'history tab label from i18n');
  assert.match(automationsSrc, /t\('automations\.runStatus\.running'\)/, 'running status from i18n');
  assert.match(automationsSrc, /t\('automations\.historyTriggerInput'\)/, 'trigger input shown in detail');
  assert.match(automationsSrc, /t\('automations\.historyDuration'\)/, 'duration shown in detail');
  assert.match(automationsSrc, /setAllRuns\(all\.slice\(0, 100\)\)/, 'history shows the newest 100 runs');
  assert.match(automationsSrc, /status: 'running'/, 'in-flight runs get a synthetic running row');
  assert.match(automationsSrc, /onClick=\{\(\) => setSelectedRunId\(row\.id\)\}/, 'clicking a row opens its detail');
  assert.ok(!vietnamese.test(automationsSrc), 'no hard-coded Vietnamese in AutomationsView');
});

// ---------------------------------------------------------------------------
// Core: run records carry the trigger; store keeps the newest 100
// ---------------------------------------------------------------------------

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-confirm-test-'));
  tempDirs.push(dir);
  return dir;
}

test('core: MAX_RUN_HISTORY is 100 and the store keeps the newest 100 runs', () => {
  assert.equal(MAX_RUN_HISTORY, 100, 'history tab shows up to 100 runs');
  const store = new JsonFileAutomationStore(makeTempDir());
  for (let i = 0; i < 105; i++) {
    store.appendRun({
      id: `run-${i}`,
      automationId: 'auto-1',
      startedAt: new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString(),
      status: 'ok',
      trigger: 'interval',
    });
  }
  const runs = store.listRuns();
  assert.equal(runs.length, 100, 'oldest runs are dropped past the cap');
  assert.equal(runs[0].id, 'run-5', 'the 5 oldest runs are gone');
  assert.equal(runs[99].id, 'run-104', 'the newest run is kept');
  fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('core: executeAutomation records trigger, finishedAt and the error', async () => {
  const now = new Date('2026-11-10T10:00:00.000Z');
  const okRun = await executeAutomation(
    {
      id: 'auto-1',
      botId: 'bot-1',
      name: 'Ping',
      trigger: { kind: 'cron', expression: '0 9 * * *' },
      action: { kind: 'notify', message: 'ping' },
      enabled: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      runAgent: async () => 'agent',
      runTool: async () => 'tool',
      createTask: async () => 'task-1',
      notify: () => undefined,
    },
    now,
  );
  assert.equal(okRun.status, 'ok');
  assert.equal(okRun.trigger, 'cron', 'run records the trigger kind that fired it');
  assert.equal(okRun.startedAt, now.toISOString());
  assert.ok(okRun.finishedAt, 'finishedAt is recorded');

  const errRun = await executeAutomation(
    {
      id: 'auto-1',
      botId: 'bot-1',
      name: 'Boom',
      trigger: { kind: 'webhook', keyId: 'auto-1' },
      action: { kind: 'run-tool', tool: 'nope', args: {} },
      enabled: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      runAgent: async () => 'agent',
      runTool: async () => {
        throw new Error('tool exploded');
      },
      createTask: async () => 'task-1',
      notify: () => undefined,
    },
    now,
  );
  assert.equal(errRun.status, 'error');
  assert.equal(errRun.trigger, 'webhook');
  assert.equal(errRun.error, 'tool exploded');
});

test('core: a skipped run records its trigger too', async () => {
  const clock = { now: new Date('2026-11-08T10:00:00') };
  const store = new JsonFileAutomationStore(makeTempDir());
  const scheduler = new AutomationScheduler(
    store,
    {
      runAgent: async () => 'agent',
      runTool: async () => 'tool',
      createTask: async () => 'task-1',
      notify: () => undefined,
    },
    { now: () => new Date(clock.now.getTime()) },
  );
  scheduler.create({
    botId: 'bot-1',
    name: 'Every 30 min',
    trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'notify', message: 'ping' },
    enabled: true,
  });
  await scheduler.tick(); // first run at 10:00
  clock.now = new Date('2026-11-08T12:00:00'); // 2h later: past the grace window
  const runs = await scheduler.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'skipped');
  assert.equal(runs[0].trigger, 'interval', 'skipped run records its trigger');
  const stored = store.listRuns();
  assert.equal(stored.length, 2, 'both runs are persisted');
  assert.ok(stored.every((r) => r.trigger === 'interval'), 'every stored run has a trigger');
  fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});
