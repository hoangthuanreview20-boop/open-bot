/**
 * Tests for the hook execution log (v1.01):
 * `packages/core/src/hooks/hookLog.ts` + the runner wiring
 * (`HookRunnerOptions.executionLog`).
 *
 * Under test:
 * - Ring buffer: capacity cap, newest-first listing, filters.
 * - `summary()`: totals by outcome / event.
 * - `toJSONL()` + `readHookLogFile()`: file round-trip, malformed
 *   lines skipped, missing file → [].
 * - Runner wiring: every hook invocation is recorded (decision and
 *   error alike) with duration and reason; a broken log never breaks
 *   a run.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/hooks-log-v101.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  allowDecision,
  blockDecision,
  HookExecutionLog,
  HookRegistry,
  HookRunner,
  readHookLogFile,
  summarizeHookLogRecords,
} from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hook-log-v101-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function record(log, overrides = {}) {
  return log.record({
    hookName: 'h1',
    event: 'PreToolUse',
    action: 'allow',
    durationMs: 5,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// HookExecutionLog (unit)
// ---------------------------------------------------------------------------

test('record/list: newest first, seq increments, filters AND', () => {
  const log = new HookExecutionLog();
  record(log, { hookName: 'a', event: 'PreToolUse', action: 'allow' });
  record(log, { hookName: 'b', event: 'PostToolUse', action: 'block', reason: 'no' });
  record(log, { hookName: 'a', event: 'PreToolUse', action: 'error', error: 'boom', timedOut: true });
  assert.equal(log.size(), 3);

  const all = log.list();
  assert.equal(all[0].hookName, 'a');
  assert.equal(all[0].action, 'error');
  assert.equal(all[0].seq, 3);
  assert.equal(all[2].seq, 1);

  assert.equal(log.list({ hookName: 'a' }).length, 2);
  assert.equal(log.list({ event: 'PostToolUse' }).length, 1);
  assert.equal(log.list({ action: 'block' }).length, 1);
  assert.equal(log.list({ timedOutOnly: true }).length, 1);
  assert.equal(log.list({ hookName: 'a', action: 'allow' }).length, 1);
  assert.equal(log.list({ limit: 2 }).length, 2);
  assert.equal(log.list({ limit: 0 }).length, 0);
});

test('ring buffer: capacity caps memory, oldest drops first', () => {
  const log = new HookExecutionLog({ maxRecords: 3 });
  assert.equal(log.capacity(), 3);
  for (let i = 0; i < 5; i++) record(log, { hookName: `h${i}` });
  assert.equal(log.size(), 3);
  assert.equal(log.oldest().hookName, 'h2');
  assert.equal(log.newest().hookName, 'h4');
  assert.equal(log.oldest().seq, 3);
});

test('capacity is clamped to sane bounds', () => {
  assert.equal(new HookExecutionLog({ maxRecords: 0 }).capacity(), 1);
  assert.equal(new HookExecutionLog({ maxRecords: 999999 }).capacity(), 10000);
});

test('summary: totals by outcome and event', () => {
  const log = new HookExecutionLog();
  record(log, { event: 'PreToolUse', action: 'allow' });
  record(log, { event: 'PreToolUse', action: 'block' });
  record(log, { event: 'SubagentStop', action: 'error', error: 'x', timedOut: true });
  const s = log.summary();
  assert.equal(s.total, 3);
  assert.equal(s.errors, 1);
  assert.equal(s.timeouts, 1);
  assert.equal(s.blocks, 1);
  assert.deepEqual(s.byEvent, { PreToolUse: 2, SubagentStop: 1 });
});

test('clear empties the buffer; record never throws', () => {
  const log = new HookExecutionLog();
  record(log);
  log.clear();
  assert.equal(log.size(), 0);
  assert.equal(log.list().length, 0);
  assert.equal(log.oldest(), undefined);
  assert.equal(log.newest(), undefined);
  assert.doesNotThrow(() => log.record({ hookName: 'x', event: 'Stop', action: 'allow', durationMs: -5 }));
  assert.equal(log.newest().durationMs, 0, 'negative durations clamp to 0');
});

test('toJSONL + readHookLogFile: round-trip, newest first, malformed lines skipped', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'hook-executions.jsonl');
  const log = new HookExecutionLog({ filePath: file });
  record(log, { hookName: 'a', event: 'PreToolUse', action: 'allow' });
  record(log, { hookName: 'b', event: 'SubagentStop', action: 'block', reason: 'gate' });
  const lines = log.toJSONL().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).hookName, 'a');

  // File on disk has both records; append garbage + a valid line by hand.
  fs.appendFileSync(file, 'this is not json\n');
  fs.appendFileSync(file, '{"hookName":"c","event":"Stop","action":"allow","durationMs":1,"seq":99,"at":"2026-01-01T00:00:00.000Z","timedOut":false}\n');
  const back = readHookLogFile(file, 100);
  assert.equal(back.length, 3, 'garbage line skipped, valid lines kept');
  assert.equal(back[0].hookName, 'c');
  assert.equal(back[1].hookName, 'b');
  assert.equal(back[2].hookName, 'a');
  assert.deepEqual(readHookLogFile(file, 1).map((r) => r.hookName), ['c']);
});

test('readHookLogFile: missing file → []', () => {
  assert.deepEqual(readHookLogFile(path.join(makeTempDir(), 'nope.jsonl')), []);
});

test('file append failure never throws (read-only dir)', () => {
  const dir = makeTempDir();
  // Point at a path whose parent is a file, not a directory.
  const notDir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(notDir, 'x');
  const log = new HookExecutionLog({ filePath: path.join(notDir, 'x.jsonl') });
  assert.doesNotThrow(() => record(log));
  assert.equal(log.size(), 1, 'in-memory record survives a failed file write');
});

// ---------------------------------------------------------------------------
// Runner wiring
// ---------------------------------------------------------------------------

test('runner records every invocation: decision, error, duration, reason', async () => {
  const log = new HookExecutionLog();
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.register({
    name: 'allow-er',
    events: ['PreToolUse'],
    handler: () => allowDecision('fine'),
    source: 'builtin',
    enabled: true,
  });
  registry.register({
    name: 'boom',
    events: ['PreToolUse'],
    handler: () => {
      throw new Error('kaboom');
    },
    source: 'builtin',
    enabled: true,
  });
  registry.register({
    name: 'blocker',
    events: ['PostToolUse'],
    handler: () => blockDecision('nope'),
    source: 'builtin',
    enabled: true,
  });
  const runner = new HookRunner(registry, { executionLog: log, onHookError: 'allow' });

  await runner.runPreToolUse({ toolName: 't', toolCallId: '1', args: {} });
  await runner.runPostToolUse({
    toolName: 't',
    toolCallId: '1',
    args: {},
    result: { ok: true, output: 'ok' },
  });

  const records = log.list();
  assert.equal(records.length, 3, 'allow + error + block');
  const byName = Object.fromEntries(records.map((r) => [r.hookName, r]));
  assert.equal(byName['allow-er'].action, 'allow');
  assert.equal(byName['allow-er'].reason, 'fine');
  assert.equal(byName['allow-er'].event, 'PreToolUse');
  assert.equal(byName['boom'].action, 'error');
  assert.match(byName['boom'].error, /kaboom/);
  assert.equal(byName['blocker'].action, 'block');
  assert.equal(byName['blocker'].reason, 'nope');
  for (const r of records) {
    assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
    assert.ok(r.seq >= 1);
    assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);
  }
  const summary = log.summary();
  assert.equal(summary.total, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.blocks, 1);
});

test('runner without executionLog behaves exactly as before (no recording)', async () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.register({
    name: 'h',
    events: ['PreToolUse'],
    handler: () => allowDecision(),
    source: 'builtin',
    enabled: true,
  });
  const runner = new HookRunner(registry);
  const out = await runner.runPreToolUse({ toolName: 't', toolCallId: '1', args: {} });
  assert.equal(out.decision, 'allow');
});

test('summarizeHookLogRecords: per-hook totals, blocks, errors, timeouts, avg, order', () => {
  const rows = summarizeHookLogRecords([
    { seq: 1, at: '2026-11-14T00:00:01.000Z', hookName: 'a', event: 'PreToolUse', action: 'allow', durationMs: 10, timedOut: false },
    { seq: 2, at: '2026-11-14T00:00:02.000Z', hookName: 'a', event: 'PreToolUse', action: 'block', durationMs: 30, timedOut: false, reason: 'no' },
    { seq: 3, at: '2026-11-14T00:00:03.000Z', hookName: 'b', event: 'SubagentStop', action: 'error', durationMs: 50, timedOut: true, error: 'boom' },
    { seq: 4, at: '2026-11-14T00:00:04.000Z', hookName: 'a', event: 'PostToolUse', action: 'allow', durationMs: 20, timedOut: false },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hookName, 'a', 'most-run hook first');
  assert.equal(rows[0].total, 3);
  assert.equal(rows[0].blocks, 1);
  assert.equal(rows[0].errors, 0);
  assert.equal(rows[0].avgDurationMs, 20);
  assert.equal(rows[0].lastAt, '2026-11-14T00:00:04.000Z');
  assert.equal(rows[1].hookName, 'b');
  assert.equal(rows[1].errors, 1);
  assert.equal(rows[1].timeouts, 1);
  assert.deepEqual(summarizeHookLogRecords([]), []);
});

test('HookExecutionLog.perHookSummary matches the pure summariser', () => {
  const log = new HookExecutionLog({ maxRecords: 10 });
  log.record({ hookName: 'x', event: 'Stop', action: 'allow', durationMs: 5 });
  log.record({ hookName: 'x', event: 'Stop', action: 'block', durationMs: 15, reason: 'no' });
  log.record({ hookName: 'y', event: 'Stop', action: 'allow', durationMs: 7 });
  const rows = log.perHookSummary();
  assert.equal(rows[0].hookName, 'x');
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].blocks, 1);
  assert.equal(rows[0].avgDurationMs, 10);
  assert.equal(rows[1].hookName, 'y');
});
