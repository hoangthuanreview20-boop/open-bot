/**
 * Tests for v0.4 usage tracking + spend limits (packages/core/src/usage/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/usage.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  UsageTracker,
  MeteredProvider,
  SpendLimitError,
  estimateCost,
  getModelPrice,
  listPricedModels,
  registerPrice,
  unregisterPrice,
} from '../packages/core/dist/usage/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-usage-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const storeIn = (dir) => path.join(dir, 'usage.json');

/** Mutable clock so tests can move to the next day / month. */
function clock(startIso) {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso);
    },
  };
}

/** Minimal fake Provider implementing the core Provider interface. */
function fakeProvider({ id = 'xai', usage = { inputTokens: 1000, outputTokens: 500 } } = {}) {
  let calls = 0;
  return {
    provider: {
      id,
      label: `Fake ${id}`,
      async chat() {
        calls += 1;
        return { text: 'ok', toolCalls: [], usage: { ...usage } };
      },
      async listModels() {
        return ['grok-4.7'];
      },
    },
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

test('pricing: grok-4.7 costs $2.00/$6.00 per 1M tokens', () => {
  assert.deepEqual(getModelPrice('grok-4.7'), {
    inputPerMillionUsd: 2.0,
    outputPerMillionUsd: 6.0,
  });
  // 1M in + 1M out = $2 + $6 = $8.
  assert.equal(estimateCost('grok-4.7', 1_000_000, 1_000_000), 8);
  // 500k in + 100k out = $1 + $0.60 = $1.60.
  assert.equal(estimateCost('grok-4.7', 500_000, 100_000), 1.6);
});

test('pricing: known models across providers; unknown model returns null', () => {
  assert.deepEqual(getModelPrice('gpt-5'), { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 });
  assert.deepEqual(getModelPrice('claude-sonnet-4.5'), {
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
  });
  assert.deepEqual(getModelPrice('gemini-2.5-flash'), {
    inputPerMillionUsd: 0.3,
    outputPerMillionUsd: 2.5,
  });
  assert.equal(getModelPrice('some-model-that-does-not-exist'), null);
  assert.equal(estimateCost('some-model-that-does-not-exist', 1000, 1000), null);
  assert.ok(listPricedModels().length >= 20, 'price table should cover the popular models');
});

test('pricing: dated model variants inherit the base model price by prefix', () => {
  assert.deepEqual(getModelPrice('grok-4.7-2026-09-21'), {
    inputPerMillionUsd: 2.0,
    outputPerMillionUsd: 6.0,
  });
  // gpt-5-mini must NOT match gpt-5's price.
  assert.deepEqual(getModelPrice('gpt-5-mini'), {
    inputPerMillionUsd: 0.25,
    outputPerMillionUsd: 2.0,
  });
});

test('pricing: registerPrice overrides a model and unregisterPrice restores it', () => {
  registerPrice('grok-4.7', { inputPerMillionUsd: 1.0, outputPerMillionUsd: 1.0 });
  try {
    assert.equal(estimateCost('grok-4.7', 1_000_000, 0), 1.0);
    registerPrice('my-custom-model', { inputPerMillionUsd: 0.5, outputPerMillionUsd: 0.5 });
    assert.equal(estimateCost('my-custom-model', 1_000_000, 1_000_000), 1.0);
  } finally {
    unregisterPrice('grok-4.7');
    unregisterPrice('my-custom-model');
  }
  assert.equal(estimateCost('grok-4.7', 1_000_000, 0), 2.0);
});

// ---------------------------------------------------------------------------
// UsageTracker: recording + summaries
// ---------------------------------------------------------------------------

test('tracker records usage, sums tokens and estimates cost', () => {
  const c = clock('2026-11-08T10:00:00+07:00');
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()), now: c.now });

  const r1 = tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(r1.costUsd, 2.0);
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 0, outputTokens: 1_000_000 });
  tracker.record('bot-b', 'openai', 'gpt-5', { inputTokens: 1_000_000, outputTokens: 0 });

  const all = tracker.getSummary('all');
  assert.equal(all.inputTokens, 2_000_000);
  assert.equal(all.outputTokens, 1_000_000);
  assert.equal(all.calls, 3);
  // $2 + $6 + $1.25 = $9.25
  assert.equal(all.costUsd, 9.25);

  const botA = tracker.getSummary('all', 'bot-a');
  assert.equal(botA.calls, 2);
  assert.equal(botA.costUsd, 8);
});

test('tracker: unpriced model still counts tokens but cost is null', () => {
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  const r = tracker.record('bot-a', 'openai-compatible', 'mystery-model-9', {
    inputTokens: 1000,
    outputTokens: 500,
  });
  assert.equal(r.costUsd, null);
  const s = tracker.getSummary('all');
  assert.equal(s.inputTokens, 1000);
  assert.equal(s.outputTokens, 500);
  assert.equal(s.calls, 1);
  assert.equal(s.unpricedCalls, 1);
  assert.equal(s.costUsd, null);
});

test('tracker: Ollama (local) calls cost $0', () => {
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  const r = tracker.record('bot-a', 'ollama', 'qwen2.5:0.5b', {
    inputTokens: 100_000,
    outputTokens: 50_000,
  });
  assert.equal(r.costUsd, 0);
  assert.equal(tracker.getSummary('all').costUsd, 0);
});

test('tracker: reload picks up records written by another instance', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const t1 = new UsageTracker({ storePath });
  const t2 = new UsageTracker({ storePath });
  t2.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1000, outputTokens: 0 });
  assert.equal(t1.getSummary('all').calls, 0, 't1 is stale before reload');
  t1.reload();
  assert.equal(t1.getSummary('all').calls, 1);
  t2.setLimits({ dailyUsd: 7 });
  t1.reload();
  assert.equal(t1.getLimits().dailyUsd, 7);
});

test('tracker persists across instances', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const t1 = new UsageTracker({ storePath });
  t1.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1000, outputTokens: 0 });
  t1.setLimits({ dailyUsd: 5 });
  const t2 = new UsageTracker({ storePath });
  assert.equal(t2.getSummary('all').calls, 1);
  assert.equal(t2.getLimits().dailyUsd, 5);
});

// ---------------------------------------------------------------------------
// Day / month windows + reset
// ---------------------------------------------------------------------------

test('tracker: today/month windows split on the local calendar and reset works', () => {
  const c = clock('2026-11-08T10:00:00+07:00');
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()), now: c.now });
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1_000_000, outputTokens: 0 });

  assert.equal(tracker.getSummary('today').calls, 1);
  assert.equal(tracker.getSummary('month').calls, 1);

  // Next day: today is empty, month still has yesterday.
  c.set('2026-11-09T09:00:00+07:00');
  assert.equal(tracker.getSummary('today').calls, 0);
  assert.equal(tracker.getSummary('month').calls, 1);
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(tracker.getSummary('today').calls, 1);
  assert.equal(tracker.getSummary('month').calls, 2);

  // Next month: month is empty, all still has both.
  c.set('2026-12-01T09:00:00+07:00');
  assert.equal(tracker.getSummary('today').calls, 0);
  assert.equal(tracker.getSummary('month').calls, 0);
  assert.equal(tracker.getSummary('all').calls, 2);

  // reset('day') removes only today's records.
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 500_000, outputTokens: 0 });
  assert.equal(tracker.reset('day'), 1);
  assert.equal(tracker.getSummary('all').calls, 2);

  // reset('month') removes only this month's records (none left in Dec).
  assert.equal(tracker.reset('month'), 0);

  // reset('all') clears everything, limits survive.
  tracker.setLimits({ dailyUsd: 10 });
  assert.equal(tracker.reset('all'), 2);
  assert.equal(tracker.getSummary('all').calls, 0);
  assert.equal(tracker.getLimits().dailyUsd, 10);
});

test('tracker: spend status reports limits and percent used for the banner', () => {
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  tracker.setLimits({ dailyUsd: 10, monthlyUsd: 100 });
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1_000_000, outputTokens: 0 }); // $2

  const status = tracker.getSpendStatus();
  assert.equal(status.today.costUsd, 2);
  assert.equal(status.today.limitUsd, 10);
  assert.equal(status.today.percentUsed, 20);
  assert.equal(status.month.limitUsd, 100);
  assert.equal(status.month.percentUsed, 2);
  assert.equal(status.total.limitUsd, undefined);
  assert.equal(status.total.percentUsed, null);
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test('tracker: setLimits rejects non-positive limits', () => {
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  assert.throws(() => tracker.setLimits({ dailyUsd: 0 }), /positive/);
  assert.throws(() => tracker.setLimits({ monthlyUsd: -5 }), /positive/);
  assert.throws(() => tracker.setLimits({ perBot: { 'bot-a': { dailyUsd: 0 } } }), /positive/);
  tracker.setLimits({});
  assert.deepEqual(tracker.getLimits(), {});
});

test('tracker: checkLimits finds global + per-bot violations', () => {
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  tracker.setLimits({
    dailyUsd: 1,
    perBot: { 'bot-a': { dailyUsd: 0.5 } },
  });
  // $2 today for bot-a: over both the per-bot ($0.50) and global ($1) caps.
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1_000_000, outputTokens: 0 });

  const violations = tracker.checkLimits('bot-a');
  assert.equal(violations.length, 2);
  assert.equal(violations[0].scope, 'daily');
  assert.equal(violations[0].spentUsd, 2);
  assert.equal(violations[0].limitUsd, 1);
  assert.equal(violations[1].scope, 'bot-daily');
  assert.equal(violations[1].botId, 'bot-a');

  // Another bot with no spend is fine on its own per-bot check...
  assert.deepEqual(tracker.checkLimits('bot-b'), [
    { scope: 'daily', spentUsd: 2, limitUsd: 1, botId: undefined },
  ]);
  assert.throws(() => tracker.assertWithinLimits('bot-a'), SpendLimitError);
});

// ---------------------------------------------------------------------------
// MeteredProvider
// ---------------------------------------------------------------------------

test('MeteredProvider passes through under the limit and records usage', async () => {
  const { provider, calls } = fakeProvider({ id: 'xai' });
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  tracker.setLimits({ dailyUsd: 10 });
  const metered = new MeteredProvider(provider, tracker, { botId: 'bot-a' });

  assert.equal(metered.id, 'xai');
  const res = await metered.chat({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.text, 'ok');
  assert.equal(calls(), 1);
  assert.deepEqual(await metered.listModels(), ['grok-4.7']);

  const s = tracker.getSummary('all', 'bot-a');
  assert.equal(s.calls, 1);
  assert.equal(s.inputTokens, 1000);
  assert.equal(s.outputTokens, 500);
  // 1000 in * $2/1M + 500 out * $6/1M = $0.002 + $0.003 = $0.005
  assert.equal(s.costUsd, 0.005);
});

test('MeteredProvider blocks the call when the limit is already exceeded', async () => {
  const { provider, calls } = fakeProvider({ id: 'xai' });
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  tracker.setLimits({ dailyUsd: 0.01 });
  // Pre-spend $2 today (over the $0.01 cap) without going through the provider.
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1_000_000, outputTokens: 0 });
  const metered = new MeteredProvider(provider, tracker, { botId: 'bot-a' });

  await assert.rejects(
    metered.chat({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof SpendLimitError);
      assert.equal(err.scope, 'daily');
      assert.equal(err.spentUsd, 2);
      assert.equal(err.limitUsd, 0.01);
      // English message carries spent + limit amounts.
      assert.match(err.message, /Spend limit exceeded \(daily\)/);
      assert.match(err.message, /\$2\.00/);
      assert.match(err.message, /\$0\.01/);
      return true;
    },
  );
  // The inner provider was never called.
  assert.equal(calls(), 0);
  assert.equal(tracker.getSummary('all').calls, 1, 'blocked call records nothing');
});

test('MeteredProvider enforces a per-bot limit for that bot only', async () => {
  const { provider, calls } = fakeProvider({ id: 'xai' });
  const tracker = new UsageTracker({ storePath: storeIn(makeTempDir()) });
  tracker.setLimits({ perBot: { 'bot-a': { dailyUsd: 0.01 } } });
  tracker.record('bot-a', 'xai', 'grok-4.7', { inputTokens: 1_000_000, outputTokens: 0 });

  const blocked = new MeteredProvider(provider, tracker, { botId: 'bot-a' });
  await assert.rejects(
    blocked.chat({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof SpendLimitError && err.scope === 'bot-daily',
  );

  const allowed = new MeteredProvider(provider, tracker, { botId: 'bot-b' });
  const res = await allowed.chat({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.text, 'ok');
  assert.equal(calls(), 1);
});
