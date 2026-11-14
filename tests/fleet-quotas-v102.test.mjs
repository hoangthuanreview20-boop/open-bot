/**
 * Tests for per-bot resource quotas (packages/core/src/fleet/quotas.ts).
 *
 * Covers quota validation + CRUD, evaluation against measured usage
 * (ok / warning / breach / unknown, disabled quotas never enforced),
 * the CPU rate derived from cumulative CPU-second samples, usage
 * statistics, and the fleet-wide alert check.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-quotas-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkBotQuotas,
  cpuRateFromSamples,
  evaluateBotQuota,
  getBotQuota,
  loadBotQuotas,
  removeBotQuota,
  setBotQuota,
  summarizeBotUsage,
  validateBotQuota,
} from '../packages/core/dist/fleet/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-quotas-'));
}

const GB = 1024 ** 3;

function makeQuota(overrides = {}) {
  return {
    botId: 'bot-1',
    cpuCoresMax: 1,
    ramBytesMax: 1 * GB,
    diskBytesMax: 10 * GB,
    warnPercent: 0.8,
    enabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin',
    ...overrides,
  };
}

function sample(botId, at, cpuSeconds, rssBytes, diskBytes) {
  return { workspaceId: botId, at, cpuSeconds, rssBytes, diskBytes, servicePid: 100 };
}

// --- validation + CRUD -----------------------------------------------------

test('quotas: validation rejects bad limits and thresholds', () => {
  assert.throws(() => validateBotQuota(makeQuota({ cpuCoresMax: 0 })), /cpuCoresMax/);
  assert.throws(() => validateBotQuota(makeQuota({ ramBytesMax: -1 })), /ramBytesMax/);
  assert.throws(() => validateBotQuota(makeQuota({ warnPercent: 1 })), /warnPercent/);
  assert.throws(() => validateBotQuota(makeQuota({ warnPercent: 0 })), /warnPercent/);
  assert.throws(() => validateBotQuota(makeQuota({ enabled: 'yes' })), /enabled/);
  assert.throws(() => validateBotQuota(makeQuota({ botId: '  ' })), /botId/);
  assert.doesNotThrow(() => validateBotQuota(makeQuota()));
});

test('quotas: set/get/remove/list, replace keeps one row per bot', () => {
  const dir = tmpDir();
  assert.deepEqual(loadBotQuotas(dir), []);
  const first = setBotQuota(
    dir,
    { botId: 'bot-1', cpuCoresMax: 1, ramBytesMax: GB, diskBytesMax: 10 * GB },
    'admin',
  );
  assert.equal(first.warnPercent, 0.8);
  assert.equal(first.enabled, true);
  assert.equal(getBotQuota(dir, 'bot-1')?.cpuCoresMax, 1);
  setBotQuota(
    dir,
    { botId: 'bot-1', cpuCoresMax: 2, ramBytesMax: 2 * GB, diskBytesMax: 20 * GB, warnPercent: 0.5 },
    'admin',
  );
  assert.equal(loadBotQuotas(dir).length, 1);
  assert.equal(getBotQuota(dir, 'bot-1')?.cpuCoresMax, 2);
  assert.equal(getBotQuota(dir, 'bot-1')?.warnPercent, 0.5);
  assert.equal(removeBotQuota(dir, 'bot-1'), true);
  assert.equal(removeBotQuota(dir, 'bot-1'), false);
  assert.equal(getBotQuota(dir, 'bot-1'), undefined);
  assert.throws(
    () => setBotQuota(dir, { botId: 'bot-2', cpuCoresMax: 1, ramBytesMax: GB, diskBytesMax: 10 * GB }, '  '),
    /updatedBy/,
  );
});

// --- evaluation ------------------------------------------------------------

test('quotas: evaluation reports ok / warning / breach per resource', () => {
  const quota = makeQuota();
  const ok = evaluateBotQuota(quota, { cpuCoresUsed: 0.5, ramBytesUsed: 0.5 * GB, diskBytesUsed: 5 * GB });
  assert.equal(ok.overall, 'ok');
  assert.deepEqual(
    ok.resources.map((r) => r.level),
    ['ok', 'ok', 'ok'],
  );
  const warning = evaluateBotQuota(quota, { cpuCoresUsed: 0.5, ramBytesUsed: 0.85 * GB, diskBytesUsed: 5 * GB });
  assert.equal(warning.overall, 'warning');
  assert.equal(warning.resources.find((r) => r.resource === 'ram')?.level, 'warning');
  assert.equal(warning.resources.find((r) => r.resource === 'ram')?.percent, 0.85);
  const breach = evaluateBotQuota(quota, { cpuCoresUsed: 1.5, ramBytesUsed: 0.5 * GB, diskBytesUsed: 10 * GB });
  assert.equal(breach.overall, 'breach');
  assert.equal(breach.resources.find((r) => r.resource === 'cpu')?.level, 'breach');
  assert.equal(breach.resources.find((r) => r.resource === 'disk')?.level, 'breach');
  // Exactly at the limit is a breach; exactly at warnPercent is a warning.
  assert.equal(
    evaluateBotQuota(quota, { cpuCoresUsed: 1, ramBytesUsed: null, diskBytesUsed: null }).overall,
    'breach',
  );
  assert.equal(
    evaluateBotQuota(quota, { cpuCoresUsed: 0.8, ramBytesUsed: null, diskBytesUsed: null }).overall,
    'warning',
  );
});

test('quotas: unmeasured usage is unknown, disabled quotas never enforce', () => {
  const quota = makeQuota();
  const unmeasured = evaluateBotQuota(quota, { cpuCoresUsed: null, ramBytesUsed: null, diskBytesUsed: null });
  assert.equal(unmeasured.overall, 'unknown');
  assert.ok(unmeasured.resources.every((r) => r.level === 'unknown' && r.percent === null));
  const disabled = evaluateBotQuota(makeQuota({ enabled: false }), {
    cpuCoresUsed: 99,
    ramBytesUsed: 99 * GB,
    diskBytesUsed: 99 * GB,
  });
  assert.equal(disabled.overall, 'unknown');
  assert.ok(disabled.resources.every((r) => r.level === 'unknown'));
});

// --- CPU rate from samples -------------------------------------------------

test('quotas: cpu rate is the delta of cumulative seconds over wall time', () => {
  assert.equal(cpuRateFromSamples([sample('b', 1000, 10, 100, 100)]), null);
  assert.equal(cpuRateFromSamples([sample('b', 1000, 10, 100, 100), sample('b', 11000, 15, 100, 100)]), 0.5);
  // Out-of-order samples are sorted first.
  assert.equal(cpuRateFromSamples([sample('b', 11000, 15, 100, 100), sample('b', 1000, 10, 100, 100)]), 0.5);
  // Zero / negative wall delta and backwards CPU counters give null, never a guess.
  assert.equal(cpuRateFromSamples([sample('b', 1000, 10, 100, 100), sample('b', 1000, 12, 100, 100)]), null);
  assert.equal(cpuRateFromSamples([sample('b', 1000, 15, 100, 100), sample('b', 11000, 10, 100, 100)]), null);
  // Null cpuSeconds samples are skipped.
  assert.equal(
    cpuRateFromSamples([
      sample('b', 1000, 10, 100, 100),
      sample('b', 6000, null, 100, 100),
      sample('b', 11000, 20, 100, 100),
    ]),
    1,
  );
});

// --- usage stats -----------------------------------------------------------

test('quotas: usage stats aggregate peaks, averages and totals', () => {
  const samples = [
    sample('bot-1', 1000, 10, 100, 1000),
    sample('bot-1', 2000, 20, 300, 2000),
    sample('bot-1', 3000, 30, 200, 1500),
    sample('bot-2', 2000, 5, 999, 999),
  ];
  const stats = summarizeBotUsage('bot-1', samples);
  assert.equal(stats.samples, 3);
  assert.equal(stats.peakRssBytes, 300);
  assert.equal(stats.avgRssBytes, 200);
  assert.equal(stats.peakDiskBytes, 2000);
  assert.equal(stats.cpuSecondsTotal, 20);
  assert.equal(stats.latestRssBytes, 200);
  assert.equal(stats.latestDiskBytes, 1500);
  assert.equal(summarizeBotUsage('bot-3', samples), null);
  const unmeasured = summarizeBotUsage('bot-1', [
    sample('bot-1', 1000, null, null, null),
    sample('bot-1', 2000, null, null, null),
  ]);
  assert.equal(unmeasured.peakRssBytes, null);
  assert.equal(unmeasured.cpuSecondsTotal, null);
});

// --- fleet-wide alert check -------------------------------------------------

test('quotas: checkBotQuotas returns warnings and breaches, newest first', () => {
  const quotas = [
    makeQuota({ botId: 'bot-1' }),
    makeQuota({ botId: 'bot-2' }),
    makeQuota({ botId: 'bot-3', enabled: false }),
  ];
  const samplesByBot = {
    'bot-1': [
      sample('bot-1', 1000, 10, 0.5 * GB, 5 * GB),
      sample('bot-1', 11000, 11, 0.9 * GB, 5 * GB),
    ],
    // bot-2 breaches disk; CPU rate is 0.1 cores (1s over 10s) — fine.
    'bot-2': [
      sample('bot-2', 1000, 10, 0.1 * GB, 9 * GB),
      sample('bot-2', 11000, 11, 0.1 * GB, 11 * GB),
    ],
    // Disabled quota: over every limit, still no alert.
    'bot-3': [sample('bot-3', 1000, 10, 99 * GB, 99 * GB)],
  };
  const alerts = checkBotQuotas(quotas, samplesByBot, 12000);
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((a) => `${a.botId}:${a.resource}:${a.level}`),
    ['bot-1:ram:warning', 'bot-2:disk:breach'],
  );
  assert.equal(alerts[0].percent, 0.9);
  assert.equal(alerts[0].used, 0.9 * GB);
  assert.equal(alerts[0].limit, GB);
  // No quota / no samples / unmeasured => no alerts.
  assert.deepEqual(checkBotQuotas(quotas, {}, 12000), []);
  assert.deepEqual(checkBotQuotas([makeQuota()], { 'bot-1': [sample('bot-1', 1000, null, null, null)] }, 12000), []);
});
