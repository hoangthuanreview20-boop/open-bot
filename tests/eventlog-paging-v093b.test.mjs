/**
 * Tests cho v0.93b — Worker B: EventLogView paging / bot switch / live
 * tail bền vững.
 *
 *   (a) Pure merge helpers (`apps/desktop/src/renderer/components/
 *       eventLogMerge.ts`, import trực tiếp qua Node type stripping
 *       như test mcp-marketplace-view-v067a): dedupe live-vs-paged,
 *       giữ thứ tự thời gian khi "load more" về sau 1 live append,
 *       cap live 500, key giống nhau giữa bản live (có engine) và
 *       bản NDJSON (không engine).
 *   (b) NDJSON paging thật (`ThreadLog` đã build): seed 150 entry,
 *       đọc offset 0/limit 100 → 100 dòng + total 150, offset 100 →
 *       50 dòng còn lại, đúng lát cắt (không mất, không trùng) —
 *       chứng minh đường phân trang dưới EventLogView làm việc với
 *       >100 entries mà không load hết một lần.
 *   (c) Static wiring của `EventLogView.tsx`: generation guard chống
 *       stale load khi đổi bot, clear list đồng bộ khi fresh load,
 *       retry subscribe + resync 30s/focus, status live, không còn
 *       append thô `[...prev, ...page.entries]`.
 *   (d) Static contract của wrapper smoke: chạy thường ghi bằng
 *       chứng vào thư mục scratch gitignored, chỉ refresh snapshot
 *       đã commit khi `SMOKE_EVENTLOG_REFRESH=1`.
 *
 * Không Electron, không mạng, không key. Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eventlog-paging-v093b.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendLiveEventLogEntries,
  eventLogEntryKey,
  mergeEventLogEntries,
} from '../apps/desktop/src/renderer/components/eventLogMerge.ts';
import { ThreadLog } from '../packages/core/dist/harness/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf-8');

function entry(at, kind, text, extra = {}) {
  return {
    at,
    botId: 'bot-a',
    threadId: 'bot-a',
    kind,
    payload: { text },
    ...extra,
  };
}
const iso = (n) => new Date(Date.UTC(2026, 10, 12, 0, 0, n)).toISOString();

test('eventLogEntryKey: live twin (có engine) == NDJSON row (không engine)', () => {
  const live = entry(iso(1), 'text', 'hello', { engine: 'ollama' });
  const disk = entry(iso(1), 'text', 'hello');
  assert.equal(eventLogEntryKey(live), eventLogEntryKey(disk));
  assert.notEqual(
    eventLogEntryKey(entry(iso(1), 'text', 'hello')),
    eventLogEntryKey(entry(iso(1), 'text', 'other')),
  );
  assert.notEqual(
    eventLogEntryKey(entry(iso(1), 'text', 'hello')),
    eventLogEntryKey(entry(iso(2), 'text', 'hello')),
  );
});

test('merge: load-more sau live append vẫn giữ thứ tự thời gian', () => {
  const page1 = [entry(iso(1), 'text', 'e1'), entry(iso(2), 'text', 'e2'), entry(iso(3), 'text', 'e3')];
  const live = [entry(iso(9), 'text', 'live-new')];
  const afterLive = mergeEventLogEntries(page1, live);
  assert.deepEqual(afterLive.map((e) => e.payload.text), ['e1', 'e2', 'e3', 'live-new']);
  // Page 2 (older than the live row) must sort BEFORE it, not after.
  const page2 = [entry(iso(4), 'text', 'e4'), entry(iso(5), 'text', 'e5'), entry(iso(6), 'text', 'e6')];
  const merged = mergeEventLogEntries(afterLive, page2);
  assert.deepEqual(
    merged.map((e) => e.payload.text),
    ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'live-new'],
  );
});

test('merge: page fetch lại event live đã có thì không trùng', () => {
  const shown = [entry(iso(1), 'text', 'e1'), entry(iso(9), 'text', 'live-new', { engine: 'ollama' })];
  // Disk re-read of the same live event (no engine field on disk).
  const refetch = [entry(iso(9), 'text', 'live-new')];
  const merged = mergeEventLogEntries(shown, refetch);
  assert.equal(merged.length, 2);
  assert.equal(merged, shown, 'không có entry mới thì trả về cùng mảng');
});

test('merge: empty incoming trả về prev; thứ tự ổn định khi trùng `at`', () => {
  const prev = [entry(iso(1), 'text', 'a')];
  assert.equal(mergeEventLogEntries(prev, []), prev);
  const sameTime = mergeEventLogEntries(prev, [
    entry(iso(1), 'text', 'b'),
    entry(iso(1), 'text', 'c'),
  ]);
  assert.deepEqual(sameTime.map((e) => e.payload.text), ['a', 'b', 'c']);
});

test('appendLive: cap 500 cắt entry cũ nhất, giữ entry mới nhất', () => {
  const prev = Array.from({ length: 500 }, (_, i) => entry(iso(i), 'text', `e${i}`));
  const out = appendLiveEventLogEntries(prev, [entry(iso(600), 'text', 'newest')], 500);
  assert.equal(out.length, 500);
  assert.equal(out[0].payload.text, 'e1');
  assert.equal(out[out.length - 1].payload.text, 'newest');
  const under = appendLiveEventLogEntries(prev.slice(0, 10), [entry(iso(600), 'text', 'x')], 500);
  assert.equal(under.length, 11);
});

test('ThreadLog paging thật: 150 entries -> page 100 + page 50, đúng lát cắt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eventlog93-'));
  try {
    const log = new ThreadLog(dir);
    for (let i = 0; i < 150; i += 1) {
      log.append({
        at: iso(i),
        botId: 'bot-a',
        threadId: 'bot-a',
        kind: i % 3 === 0 ? 'lifecycle' : 'text',
        payload: { text: `seeded #${i}` },
      });
    }
    const p1 = log.read('bot-a', { limit: 100, offset: 0 });
    assert.equal(p1.total, 150);
    assert.equal(p1.entries.length, 100);
    assert.equal(p1.entries[0].payload.text, 'seeded #0');
    assert.equal(p1.entries[99].payload.text, 'seeded #99');
    const p2 = log.read('bot-a', { limit: 100, offset: 100 });
    assert.equal(p2.total, 150);
    assert.equal(p2.entries.length, 50);
    assert.equal(p2.entries[0].payload.text, 'seeded #100');
    assert.equal(p2.entries[49].payload.text, 'seeded #149');
    // No overlap, no loss across pages.
    const all = [...p1.entries, ...p2.entries].map((e) => e.payload.text);
    assert.equal(new Set(all).size, 150);
    // Kind filter still applies on top of paging.
    const onlyLife = log.read('bot-a', { limit: 100, offset: 0, kinds: ['lifecycle'] });
    assert.equal(onlyLife.total, 50);
    assert.equal(onlyLife.entries.length, 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EventLogView wiring: generation guard + clear + retry/resync + live status', () => {
  const src = read(path.join(repo, 'apps/desktop/src/renderer/components/EventLogView.tsx'));
  // (1) Bot switch: generation guard drops stale loads.
  assert.match(src, /loadGenRef/);
  assert.match(src, /if \(gen !== loadGenRef\.current\) return;/);
  // (2) Fresh load clears the previous bot's rows synchronously.
  assert.match(src, /setEntries\(\[\]\);\s*\n\s*setTotal\(0\);/);
  // (3) Paging + resync go through the dedupe/sort merge, never a raw append.
  assert.match(src, /mergeEventLogEntries\(prev, page\.entries\)/);
  assert.match(src, /appendLiveEventLogEntries\(prev/);
  assert.doesNotMatch(src, /\[\.\.\.prev, \.\.\.page\.entries\]/);
  assert.doesNotMatch(src, /\[\.\.\.prev,\s*\n?\s*\{[^}]*at: event\.at/s);
  // (4) Live tail reconnect: retry when preload is not ready yet.
  assert.match(src, /LIVE_RETRY_MS/);
  assert.match(src, /setTimeout\(trySubscribe, LIVE_RETRY_MS\)/);
  // (5) Resync: 30s tick + focus, baseline-gated, tail pages only.
  assert.match(src, /LIVE_RESYNC_MS = 30_000/);
  assert.match(src, /setInterval\(tick, LIVE_RESYNC_MS\)/);
  assert.match(src, /addEventListener\('focus'/);
  assert.match(src, /resyncFromLog\(/);
  // (6) Live status is visible in the UI; expanded keys are stable per entry.
  assert.match(src, /data-testid="eventlog-live-status"/);
  assert.match(src, /eventlog\.liveConnected/);
  assert.match(src, /eventlog\.liveReconnecting/);
  assert.match(src, /const key = eventLogEntryKey\(entry\);/);
  // (7) Refresh uses the same fresh-load path as a bot switch.
  assert.match(src, /onClick=\{startFreshLoad\}/);
});

test('smoke wrapper contract: scratch mặc định, refresh chỉ khi SMOKE_EVENTLOG_REFRESH=1', () => {
  for (const script of ['scripts/smoke-eventlog-v092b.mjs', 'scripts/smoke-eventlog-v093b.mjs']) {
    const src = read(path.join(repo, script));
    assert.match(src, /SMOKE_EVENTLOG_REFRESH/);
    // Default evidence dir must be the gitignored scratch dir, never docs/.
    assert.match(src, /\.smoke-scratch/);
    assert.doesNotMatch(src, /const SHOTS_DIR = path\.join\(ROOT, 'docs'/);
  }
  const gitignore = read(path.join(repo, '.gitignore'));
  assert.match(gitignore, /^\.smoke-scratch\/$/m);
});
