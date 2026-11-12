/**
 * OS notifications tests for v0.87c (node:test, no Electron needed).
 *
 * Covers the pure core service (packages/core/src/notifications/):
 *   - defaults: all four kinds ON (v0.94c adds project-update); resolveNotificationSettings fills
 *     partial input and ignores non-booleans
 *   - per-kind toggle: a disabled kind never shows
 *   - dedupe: same kind + bot + title inside 10s is dropped; a
 *     different title, a different bot, or a later time shows again;
 *     an explicit dedupeKey groups even with different titles
 *   - rate limit: at most 5 shown per kind per rolling 60s; the 6th
 *     is dropped as rate-limited and counted; other kinds unaffected
 *   - click: the shown notification carries the internal deep-link
 *     route (bot id -> open-bot://bot/<id>, no bot -> chat screen)
 *     and onClick calls onActivate with that route — never a URL
 *   - validation: bad kind / empty title / empty body / bad botId
 *     are rejected as { shown: false, reason: 'invalid' }, never throw
 *   - unsupported platform: isSupported() false -> 'unsupported'
 *   - a throwing show adapter never throws out of notify()
 *   - localised text: formatNotificationText in all 6 locales for
 *     all 3 kinds, unknown locale falls back to English
 *
 * What this does NOT cover (honest limit, see docs/notifications.md):
 * a real popup on screen. This VM is headless — no notification
 * daemon — so the Electron Notification constructor is never run
 * here; only the logic around it is tested, with a fake `show`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  NOTIFICATION_RATE_LIMIT_MAX,
  NOTIFICATION_RATE_LIMIT_WINDOW_MS,
  NotificationService,
  formatNotificationText,
  resolveNotificationSettings,
  validateNotificationRequest,
} from '../packages/core/dist/notifications/index.js';

function makeService(overrides = {}) {
  let now = 1_000_000;
  const shown = [];
  const activated = [];
  const enabled = { runComplete: true, approval: true, runError: true, ...(overrides.enabled ?? {}) };
  const service = new NotificationService({
    show: (n) => {
      shown.push({ title: n.title, body: n.body, route: n.route, onClick: n.onClick });
      if (overrides.throwOnShow) throw new Error('adapter boom');
    },
    isSupported: overrides.isSupported ?? (() => true),
    isEnabled: (kind) =>
      kind === 'run-complete' ? enabled.runComplete : kind === 'approval' ? enabled.approval : enabled.runError,
    onActivate: (route) => activated.push(route),
    now: () => now,
  });
  return {
    service,
    shown,
    activated,
    advance: (ms) => {
      now += ms;
    },
    setEnabled: (kind, value) => {
      if (kind === 'run-complete') enabled.runComplete = value;
      else if (kind === 'approval') enabled.approval = value;
      else enabled.runError = value;
    },
  };
}

const runComplete = (overrides = {}) => ({
  kind: 'run-complete',
  title: 'Bot A finished',
  body: 'The bot finished its reply.',
  botId: 'bot-a',
  ...overrides,
});

test('defaults: all four kinds ON; resolve fills partial input, ignores non-booleans', () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_SETTINGS, {
    runComplete: true,
    approval: true,
    runError: true,
    projectUpdate: true,
  });
  assert.deepEqual(resolveNotificationSettings(undefined), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(resolveNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(resolveNotificationSettings({ approval: false }), {
    runComplete: true,
    approval: false,
    runError: true,
    projectUpdate: true,
  });
  // A non-boolean never silently flips a kind: it falls back to ON.
  assert.deepEqual(resolveNotificationSettings({ runComplete: 'yes', runError: 0 }), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(resolveNotificationSettings({ unknownField: true }), DEFAULT_NOTIFICATION_SETTINGS);
  assert.equal(NOTIFICATION_DEDUPE_WINDOW_MS, 10_000);
  assert.equal(NOTIFICATION_RATE_LIMIT_MAX, 5);
  assert.equal(NOTIFICATION_RATE_LIMIT_WINDOW_MS, 60_000);
});

test('disabled kind never shows', () => {
  const { service, shown, setEnabled } = makeService();
  setEnabled('approval', false);
  const out = service.notify({ kind: 'approval', title: 'Needs approval', body: 'Tool x waits.' });
  assert.deepEqual(out, { shown: false, reason: 'disabled' });
  assert.equal(shown.length, 0);
  // Other kinds are unaffected.
  assert.equal(service.notify(runComplete()).shown, true);
  assert.equal(shown.length, 1);
});

test('dedupe: same kind + bot + title inside 10s is dropped', () => {
  const { service, shown, advance } = makeService();
  assert.equal(service.notify(runComplete()).shown, true);
  assert.deepEqual(service.notify(runComplete()), { shown: false, reason: 'duplicate' });
  assert.equal(shown.length, 1);
  // Different title -> shows; different bot -> shows.
  assert.equal(service.notify(runComplete({ title: 'Bot A finished again' })).shown, true);
  assert.equal(service.notify(runComplete({ botId: 'bot-b' })).shown, true);
  // After the window passes, the same notification shows again.
  advance(NOTIFICATION_DEDUPE_WINDOW_MS + 1);
  assert.equal(service.notify(runComplete()).shown, true);
  assert.equal(shown.length, 4);
});

test('dedupe: explicit dedupeKey groups requests with different titles', () => {
  const { service, shown } = makeService();
  const first = service.notify({
    kind: 'approval',
    title: 'Bot A needs approval',
    body: 'Tool shell_exec waits.',
    botId: 'bot-a',
    dedupeKey: 'call-123',
  });
  assert.equal(first.shown, true);
  const second = service.notify({
    kind: 'approval',
    title: 'Bot A needs approval (edited args)',
    body: 'Tool shell_exec waits.',
    botId: 'bot-a',
    dedupeKey: 'call-123',
  });
  assert.deepEqual(second, { shown: false, reason: 'duplicate' });
  assert.equal(shown.length, 1);
});

test('rate limit: at most 5 shown per kind per rolling 60s; others unaffected', () => {
  const { service, shown, advance } = makeService();
  for (let i = 0; i < 5; i++) {
    assert.equal(service.notify(runComplete({ title: `run ${i}` })).shown, true, `run ${i} must show`);
  }
  const sixth = service.notify(runComplete({ title: 'run 5' }));
  assert.equal(sixth.shown, false);
  assert.equal(sixth.reason, 'rate-limited');
  assert.equal(sixth.suppressed, 1);
  const seventh = service.notify(runComplete({ title: 'run 6' }));
  assert.equal(seventh.suppressed, 2);
  assert.equal(service.suppressedCount('run-complete'), 2);
  assert.equal(shown.length, 5);
  // Another kind still shows (limit is per kind).
  assert.equal(
    service.notify({ kind: 'approval', title: 'needs approval', body: 'x' }).shown,
    true,
  );
  // After the window rolls past, the kind shows again.
  advance(NOTIFICATION_RATE_LIMIT_WINDOW_MS + 1);
  assert.equal(service.notify(runComplete({ title: 'run 7' })).shown, true);
  assert.equal(shown.length, 7);
});

test('click: shown notification carries the internal deep-link route, never a URL', () => {
  const { service, shown, activated } = makeService();
  assert.equal(service.notify(runComplete()).shown, true);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].route, { kind: 'bot', botId: 'bot-a' });
  assert.equal(typeof shown[0].onClick, 'function');
  shown[0].onClick();
  assert.deepEqual(activated, [{ kind: 'bot', botId: 'bot-a' }]);
  // No bot -> the chat screen.
  assert.equal(
    service.notify({ kind: 'run-error', title: 'oops', body: 'boom' }).shown,
    true,
  );
  assert.deepEqual(shown[1].route, { kind: 'chat' });
  shown[1].onClick();
  assert.deepEqual(activated[1], { kind: 'chat' });
});

test('validation: bad requests are rejected, never thrown', () => {
  const { service, shown } = makeService();
  for (const bad of [
    null,
    'hello',
    [],
    { kind: 'nope', title: 't', body: 'b' },
    { kind: 'approval', title: '   ', body: 'b' },
    { kind: 'approval', title: 't', body: '' },
    { kind: 'approval', title: 't', body: 'b', botId: '../evil' },
    { kind: 'approval', title: 't', body: 'b', botId: 'bot id!' },
    { kind: 'approval', title: 't', body: 'b', dedupeKey: '' },
  ]) {
    const out = service.notify(bad);
    assert.equal(out.shown, false, JSON.stringify(bad));
    assert.equal(out.reason, 'invalid', JSON.stringify(bad));
    assert.equal(typeof out.detail, 'string');
  }
  assert.equal(shown.length, 0);
  // Titles/bodies are trimmed and capped, not rejected.
  const capped = validateNotificationRequest({
    kind: 'approval',
    title: `  ${'t'.repeat(200)}  `,
    body: `  ${'b'.repeat(600)}  `,
  });
  assert.equal(capped.ok, true);
  assert.equal(capped.request.title.length, 128);
  assert.equal(capped.request.body.length, 512);
});

test('unsupported platform: isSupported() false -> unsupported, nothing shown', () => {
  const { service, shown } = makeService({ isSupported: () => false });
  assert.deepEqual(service.notify(runComplete()), { shown: false, reason: 'unsupported' });
  assert.equal(shown.length, 0);
});

test('a throwing show adapter never throws out of notify()', () => {
  const { service, shown } = makeService({ throwOnShow: true });
  const out = service.notify(runComplete());
  assert.equal(out.shown, false);
  assert.equal(out.reason, 'unsupported');
  assert.match(out.detail ?? '', /adapter boom/);
  assert.equal(shown.length, 1, 'the adapter was attempted once');
});

test('formatNotificationText: all 6 locales, all 3 kinds, unknown locale falls back to en', () => {
  const cases = [
    ['vi', 'run-complete', '{bot} đã xong việc'],
    ['vi', 'approval', '{bot} cần bạn duyệt'],
    ['vi', 'run-error', '{bot} gặp lỗi khi chạy'],
    ['en', 'run-complete', '{bot} finished'],
    ['en', 'approval', '{bot} needs approval'],
    ['en', 'run-error', '{bot} ran into an error'],
  ];
  for (const [locale, kind, title] of cases) {
    const text = formatNotificationText(locale, kind, { botName: 'Trợ lý', tool: 'shell_exec', error: 'boom' });
    assert.equal(text.title, title.replace('{bot}', 'Trợ lý'), `${locale}/${kind} title`);
    assert.ok(text.body.length > 0, `${locale}/${kind} body must not be empty`);
  }
  // zh/ja/es/fr must differ from the English text (real translation, not fallback).
  for (const locale of ['zh', 'ja', 'es', 'fr']) {
    const text = formatNotificationText(locale, 'run-complete', { botName: 'Bot' });
    assert.notEqual(text.title, 'Bot finished', `${locale} must not fall back to en`);
    assert.notEqual(text.title, 'run-complete', `${locale} must not fall back to the key`);
  }
  // Approval body carries the tool name; error body carries the excerpt.
  const approval = formatNotificationText('en', 'approval', { botName: 'Bot', tool: 'shell_exec' });
  assert.ok(approval.body.includes('shell_exec'));
  const err = formatNotificationText('en', 'run-error', { botName: 'Bot', error: 'x'.repeat(500) });
  assert.ok(err.body.includes('x'.repeat(200)));
  assert.ok(!err.body.includes('x'.repeat(201)), 'error excerpt is capped at 200 chars');
  // Unknown locale -> English; empty bot name -> 'open-bot'.
  assert.equal(formatNotificationText('de', 'run-complete', { botName: 'Bot' }).title, 'Bot finished');
  assert.equal(formatNotificationText(undefined, 'run-complete', { botName: '  ' }).title, 'open-bot finished');
});
