/**
 * Tests for v0.86 (P2-7): opt-in crash reporting — redaction, report
 * shape, local store (caps + rotation + delete), collector gate.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/crash-reporting-v086.test.mjs
 *
 * No network, no live services, no real user data: every test passes
 * a FAKE home dir / user name, and the store lives in a temp dir.
 * Nothing here touches the real `~/.config` or the real home.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildCrashReport,
  CrashCollector,
  CrashReportStore,
  createRendererErrorHandler,
  isValidCrashReportId,
  redactCrashText,
  MAX_CRASH_REPORTS,
  MAX_CRASH_REPORTS_BYTES,
} from '../packages/core/dist/crash/index.js';

const FAKE_HOME = '/home/fakeuser';
const FAKE_USER = 'fakeuser';
const REDACT = { homeDir: FAKE_HOME, username: FAKE_USER };

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- redaction ---------------------------------------------------------------

test('redact: home dir + user name are hidden (posix + windows spellings)', () => {
  const text = `Error at ${FAKE_HOME}/project/app/main.ts:12 and C:\\Users\\fakeuser\\app\\x.js, user "fakeuser" failed`;
  const out = redactCrashText(text, REDACT);
  assert.ok(!out.includes(FAKE_HOME), 'posix home must be gone');
  assert.ok(!out.includes('fakeuser'), 'user name must be gone');
  assert.ok(out.includes('<home>/project/app/main.ts'), 'tail of the path stays (useful, no PII)');
  assert.ok(out.includes('<home>\\app\\x.js') || out.includes('<home>/app/x.js'), 'windows home hidden');
});

test('redact: secrets are hidden (bearer, sk-/xai- keys, api_key=, password=)', () => {
  const text = [
    'Authorization: Bearer abc.def.ghi',
    'key sk-1234567890abcdefghij',
    'xai-abcdefghijklmnopqrstuvwxyz1234',
    'api_key=supersecretvalue123',
    '"password": "hunter2hunter2"',
  ].join('\n');
  const out = redactCrashText(text, REDACT);
  assert.ok(!out.includes('abc.def.ghi'), 'bearer token gone');
  assert.ok(!out.includes('sk-1234567890abcdefghij'), 'sk- key gone');
  assert.ok(!out.includes('xai-abcdefghijklmnopqrstuvwxyz1234'), 'xai- key gone');
  assert.ok(!out.includes('supersecretvalue123'), 'api_key value gone');
  assert.ok(!out.includes('hunter2hunter2'), 'password value gone');
  assert.ok(out.includes('<redacted>'), 'redaction marker present');
  assert.ok(out.includes('api_key='), 'the key NAME stays (only the value is hidden)');
});

test('redact: known extra secrets are blanked; ordinary text survives', () => {
  const out = redactCrashText('hello world, token MYSECRETTOKEN99 here', {
    ...REDACT,
    extraSecrets: ['MYSECRETTOKEN99'],
  });
  assert.ok(!out.includes('MYSECRETTOKEN99'));
  assert.ok(out.includes('hello world'));
  assert.equal(redactCrashText('plain message, no secrets', REDACT), 'plain message, no secrets');
});

test('redact: chat content is NOT specially preserved — it is just text (no chat is ever passed in)', () => {
  // The collector only ever receives error message/stack; this test
  // pins that a chat-like string passed by mistake is still redacted
  // for paths/secrets the same way (defence in depth, not a feature).
  const out = redactCrashText(`chat: meet me at ${FAKE_HOME}/secret.txt`, REDACT);
  assert.ok(!out.includes(FAKE_HOME));
});

// --- report shape ------------------------------------------------------------

test('buildCrashReport: shape + caps + sent=false + no PII', () => {
  const report = buildCrashReport(
    {
      source: 'main',
      kind: 'uncaughtException',
      message: `boom at ${FAKE_HOME}/app/index.js with key sk-1234567890abcdefghij`,
      stack: `Error: boom\n    at foo (${FAKE_HOME}/app/index.js:10:5)`,
      appVersion: '0.86.0',
      nodeVersion: 'v22.0.0',
    },
    REDACT,
  );
  assert.equal(report.version, 1);
  assert.equal(report.source, 'main');
  assert.equal(report.kind, 'uncaughtException');
  assert.equal(report.sent, false, 'v0.86 never sends: sent must be false');
  assert.equal(report.appVersion, '0.86.0');
  assert.equal(report.nodeVersion, 'v22.0.0');
  assert.ok(!JSON.stringify(report).includes(FAKE_HOME), 'no home dir anywhere in the report');
  assert.ok(!JSON.stringify(report).includes('sk-1234567890abcdefghij'), 'no key in the report');
  assert.ok(isValidCrashReportId(report.id));
  assert.ok(report.createdAt.endsWith('Z'));
});

test('buildCrashReport: long message/stack are capped, not stored whole', () => {
  // Varied words (no 40+ char token runs — those are redacted as
  // token-shaped by design, see the redact test above).
  const report = buildCrashReport(
    { source: 'renderer', kind: 'renderer-error', message: 'word '.repeat(1500), stack: 'frame '.repeat(2000) },
    REDACT,
  );
  assert.ok(report.message.length <= 2100, `message capped, got ${report.message.length}`);
  assert.ok(report.stack.length <= 8100, `stack capped, got ${report.stack.length}`);
  assert.ok(report.message.includes('[truncated'), 'cap is visible to the reader');
});

test('buildCrashReport: empty message becomes "Unknown error", never crashes', () => {
  const report = buildCrashReport({ source: 'main', kind: 'unhandledRejection', message: '   ' }, REDACT);
  assert.equal(report.message, 'Unknown error');
});

test('isValidCrashReportId: rejects path traversal', () => {
  assert.equal(isValidCrashReportId('../evil'), false);
  assert.equal(isValidCrashReportId('../../etc/passwd'), false);
  assert.equal(isValidCrashReportId('crash-123-abcdef'), true);
  assert.equal(isValidCrashReportId(''), false);
});

// --- store -------------------------------------------------------------------

test('store: save/list/get/delete/deleteAll round-trip (atomic, mode 0600)', () => {
  const dir = makeTempDir('open-bot-crash-store-');
  const store = new CrashReportStore(dir);
  assert.deepEqual(store.list(), []);
  const r1 = buildCrashReport({ source: 'main', kind: 'uncaughtException', message: 'first' }, REDACT);
  const r2 = buildCrashReport({ source: 'renderer', kind: 'renderer-error', message: 'second' }, REDACT);
  assert.equal(store.save(r1), true);
  assert.equal(store.save(r2), true);
  assert.equal(fs.statSync(path.join(dir, `${r2.id}.json`)).mode & 0o777, 0o600, 'report files are 0600');
  const listed = store.list();
  assert.equal(listed.length, 2);
  assert.equal(store.get(r1.id).message, 'first');
  assert.deepEqual(store.listSummaries().map((s) => s.id).sort(), [r1.id, r2.id].sort());
  assert.equal(store.get('no-such-id'), undefined);
  assert.equal(store.delete('no-such-id'), false);
  assert.equal(store.delete(r1.id), true);
  assert.equal(store.list().length, 1);
  assert.equal(store.deleteAll(), 1);
  assert.deepEqual(store.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: file mode is 0600 on save', () => {
  const dir = makeTempDir('open-bot-crash-mode-');
  const store = new CrashReportStore(dir);
  const r = buildCrashReport({ source: 'main', kind: 'uncaughtException', message: 'm' }, REDACT);
  store.save(r);
  const mode = fs.statSync(path.join(dir, `${r.id}.json`)).mode & 0o777;
  assert.equal(mode, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: corrupt file is skipped, never breaks list', () => {
  const dir = makeTempDir('open-bot-crash-corrupt-');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crash-bad.json'), '{not json', 'utf8');
  fs.writeFileSync(path.join(dir, 'crash-wrong.json'), JSON.stringify({ id: 'x' }), 'utf8');
  const store = new CrashReportStore(dir);
  const good = buildCrashReport({ source: 'main', kind: 'uncaughtException', message: 'ok' }, REDACT);
  store.save(good);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, good.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: count cap rotates oldest first', () => {
  const dir = makeTempDir('open-bot-crash-cap-');
  const store = new CrashReportStore(dir, { maxReports: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = buildCrashReport(
      {
        source: 'main',
        kind: 'uncaughtException',
        message: `crash ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        id: `crash-20260101-00000${i}`,
      },
      REDACT,
    );
    store.save(r);
    ids.push(r.id);
  }
  const kept = store.list().map((r) => r.id).sort();
  assert.deepEqual(kept, ids.slice(2).sort(), 'only the 3 newest survive');
  assert.equal(store.list().length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: byte cap rotates oldest first', () => {
  const dir = makeTempDir('open-bot-crash-bytes-');
  // Each report carries ~600 chars of stack (spaced words, so the
  // token-shaped redaction does not shrink it); cap 1000 bytes keeps
  // at most 1.
  const store = new CrashReportStore(dir, { maxReports: 50, maxTotalBytes: 1000 });
  for (let i = 0; i < 3; i++) {
    const r = buildCrashReport(
      {
        source: 'main',
        kind: 'uncaughtException',
        message: `crash ${i}`,
        stack: 'frame '.repeat(100),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        id: `crash-20260101-00000${i}`,
      },
      REDACT,
    );
    store.save(r);
  }
  const stats = store.stats();
  assert.ok(stats.totalBytes <= 1000, `total ${stats.totalBytes} must fit the 1000-byte cap`);
  assert.equal(stats.count, 1, 'only the newest fits');
  assert.equal(store.list()[0].message, 'crash 2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: default caps are 50 reports / 5 MB', () => {
  assert.equal(MAX_CRASH_REPORTS, 50);
  assert.equal(MAX_CRASH_REPORTS_BYTES, 5 * 1024 * 1024);
});

// --- collector ---------------------------------------------------------------

test('collector: disabled by default — capture returns null and stores nothing', () => {
  const dir = makeTempDir('open-bot-crash-off-');
  const store = new CrashReportStore(dir);
  const collector = new CrashCollector({ store, isEnabled: () => false, redactOpts: REDACT });
  const report = collector.capture('uncaughtException', new Error('boom'));
  assert.equal(report, null);
  assert.deepEqual(store.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collector: enabled — capture stores a redacted report (fake crash)', () => {
  const dir = makeTempDir('open-bot-crash-on-');
  const store = new CrashReportStore(dir);
  let seen = null;
  const collector = new CrashCollector({
    store,
    isEnabled: () => true,
    appVersion: '0.86.0-test',
    redactOpts: REDACT,
    onReport: (r) => {
      seen = r;
    },
  });
  const err = new Error(`fake crash at ${FAKE_HOME}/app.js with sk-1234567890abcdefghij`);
  err.stack = `Error: fake crash\n    at test (${FAKE_HOME}/app.js:1:1)`;
  const report = collector.capture('uncaughtException', err);
  assert.ok(report, 'report must be created');
  assert.equal(report.appVersion, '0.86.0-test');
  assert.ok(!JSON.stringify(report).includes(FAKE_HOME), 'no PII in the stored report');
  assert.ok(!JSON.stringify(report).includes('sk-1234567890abcdefghij'));
  assert.equal(store.list().length, 1);
  assert.equal(seen?.id, report.id, 'onReport fires');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collector: toggle off mid-run stops recording immediately', () => {
  const dir = makeTempDir('open-bot-crash-toggle-');
  const store = new CrashReportStore(dir);
  let enabled = true;
  const collector = new CrashCollector({ store, isEnabled: () => enabled, redactOpts: REDACT });
  assert.ok(collector.capture('uncaughtException', new Error('one')));
  enabled = false;
  assert.equal(collector.capture('uncaughtException', new Error('two')), null);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].message, 'one');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collector: install/uninstall wires process handlers; unhandledRejection is recorded', async () => {
  const dir = makeTempDir('open-bot-crash-hooks-');
  const store = new CrashReportStore(dir);
  const collector = new CrashCollector({ store, isEnabled: () => true, redactOpts: REDACT });
  assert.equal(collector.isInstalled, false);
  const beforeUncaught = process.listeners('uncaughtException');
  const beforeRejection = process.listeners('unhandledRejection');
  collector.install();
  assert.equal(collector.isInstalled, true);
  collector.install(); // idempotent — no second listener
  const addedUncaught = process.listeners('uncaughtException').filter((l) => !beforeUncaught.includes(l));
  const addedRejection = process.listeners('unhandledRejection').filter((l) => !beforeRejection.includes(l));
  assert.equal(addedUncaught.length, 1, 'install adds exactly one uncaughtException listener');
  assert.equal(addedRejection.length, 1, 'install adds exactly one unhandledRejection listener');
  // A genuinely unhandled promise inside node:test fails the test in
  // the runner itself, so the handler is invoked directly with a fake
  // rejection — this still proves the installed listener records it.
  addedRejection[0](new Error('rejected promise fake crash'), Promise.resolve());
  addedUncaught[0](new Error('uncaught fake crash'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const found = store.list();
  assert.equal(found.filter((r) => r.kind === 'unhandledRejection').length, 1, 'the rejection must be recorded once');
  assert.equal(found.filter((r) => r.kind === 'uncaughtException').length, 1, 'the exception must be recorded once');
  assert.ok(found.some((r) => r.message.includes('rejected promise fake crash')));
  collector.uninstall();
  assert.equal(collector.isInstalled, false);
  collector.uninstall(); // idempotent
  assert.deepEqual(
    process.listeners('unhandledRejection').filter((l) => !beforeRejection.includes(l)),
    [],
    'uninstall removes the listener',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collector: capture never throws (broken store, weird input)', () => {
  const badStore = {
    saveSync() {
      throw new Error('disk is on fire');
    },
  };
  const collector = new CrashCollector({
    store: badStore,
    isEnabled: () => true,
    redactOpts: REDACT,
  });
  assert.equal(collector.capture('uncaughtException', new Error('x')), null);
  assert.equal(collector.capture('uncaughtException', undefined), null);
  assert.equal(collector.capture('uncaughtException', null), null);
  assert.equal(collector.captureRendererError(null), null);
  assert.equal(collector.captureRendererError({ message: '' }), null);
});

test('collector: renderer error input is recorded as renderer-error', () => {
  const dir = makeTempDir('open-bot-crash-renderer-');
  const store = new CrashReportStore(dir);
  const collector = new CrashCollector({ store, isEnabled: () => true, source: 'main', redactOpts: REDACT });
  const report = collector.captureRendererError({
    message: `Uncaught TypeError at ${FAKE_HOME}/bundle.js`,
    stack: `TypeError\n    at foo (${FAKE_HOME}/bundle.js:3:1)`,
  });
  assert.ok(report);
  assert.equal(report.kind, 'renderer-error');
  assert.ok(!JSON.stringify(report).includes(FAKE_HOME));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createRendererErrorHandler: forwards message+stack, never throws, returns false', () => {
  const seen = [];
  const h = createRendererErrorHandler((input) => seen.push(input));
  assert.equal(h.onError('boom', 'http://x/app.js', 1, 2, new Error('boom')), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'boom');
  h.onUnhandledRejection({ reason: new Error('async boom') });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].message.includes('async boom'));
  // A throwing reporter must not propagate out of the error handler.
  const bad = createRendererErrorHandler(() => {
    throw new Error('reporter broke');
  });
  assert.equal(bad.onError('x'), false);
  bad.onUnhandledRejection({ reason: 'y' });
});
