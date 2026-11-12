/**
 * Tests cho v0.86 (P2-6) — deep-link `open-bot://`.
 *
 * Phần A: parser thuần `parseDeepLink` / `extractDeepLinkFromArgv` /
 * `deepLinkToString` trong packages/core/src/deeplink.ts (không Electron).
 * Phần B: wiring main process `setupDeepLink` / `handleDeepLinkUrl`
 * trong apps/desktop/src/main/deeplink.ts, với mock `app` (không chạy
 * Electron thật): đăng ký scheme, single-instance lock, event
 * `open-url` (macOS) và `second-instance` (Windows/Linux).
 *
 * Phân biệt: URI resource MCP `open-bot://info` / `open-bot://workspace`
 * (packages/core/src/mcp/server.ts) KHÔNG phải deep-link OS — parser
 * phải từ chối chúng (xem test "MCP resource URIs are not deep-links").
 *
 * Chạy sau khi build core + main desktop:
 *   npm run build --workspace=@open-bot/core
 *   npx tsc -p apps/desktop/tsconfig.main.json
 *   node --test tests/deep-link-v086.test.mjs
 *
 * Không network, không live service, không Electron thật.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEP_LINK_SCHEME,
  parseDeepLink,
  extractDeepLinkFromArgv,
  deepLinkToString,
} from '../packages/core/dist/deeplink.js';
import {
  setupDeepLink,
  handleDeepLinkUrl,
} from '../apps/desktop/dist/main/deeplink.js';

// ---------------------------------------------------------------------------
// Phần A: parser
// ---------------------------------------------------------------------------

test('v0.86 P2-6 parser: scheme + route rỗng về màn hình chat', () => {
  assert.equal(DEEP_LINK_SCHEME, 'open-bot');
  assert.deepEqual(parseDeepLink('open-bot://'), { ok: true, route: { kind: 'chat' } });
  assert.deepEqual(parseDeepLink('open-bot:///'), { ok: true, route: { kind: 'chat' } });
  assert.deepEqual(parseDeepLink('open-bot://chat'), { ok: true, route: { kind: 'chat' } });
  // Khoảng trắng đầu/cuối (do shell/launcher thêm) được trim, không lỗi.
  assert.deepEqual(parseDeepLink('  open-bot://settings  '), { ok: true, route: { kind: 'settings' } });
});

test('v0.86 P2-6 parser: settings + canvas', () => {
  assert.deepEqual(parseDeepLink('open-bot://settings'), { ok: true, route: { kind: 'settings' } });
  assert.deepEqual(parseDeepLink('open-bot://canvas'), { ok: true, route: { kind: 'canvas' } });
  // Scheme/host không phân biệt hoa-thường (URL parser tự lowercase host).
  assert.deepEqual(parseDeepLink('OPEN-BOT://SETTINGS'), { ok: true, route: { kind: 'settings' } });
  assert.deepEqual(parseDeepLink('open-bot:///canvas'), { ok: true, route: { kind: 'canvas' } });
});

test('v0.86 P2-6 parser: bot — path, query, và dạng không host', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(parseDeepLink(`open-bot://bot/${uuid}`), { ok: true, route: { kind: 'bot', botId: uuid } });
  assert.deepEqual(parseDeepLink('open-bot://bot/abc123'), { ok: true, route: { kind: 'bot', botId: 'abc123' } });
  assert.deepEqual(parseDeepLink('open-bot://bot?id=abc123'), { ok: true, route: { kind: 'bot', botId: 'abc123' } });
  assert.deepEqual(parseDeepLink('open-bot:///bot/abc123'), { ok: true, route: { kind: 'bot', botId: 'abc123' } });
  assert.deepEqual(parseDeepLink('open-bot:/bot/abc123'), { ok: true, route: { kind: 'bot', botId: 'abc123' } });
  // Query thừa không liên quan bị bỏ qua, không làm hỏng route.
  assert.deepEqual(parseDeepLink('open-bot://bot/abc123?foo=bar'), { ok: true, route: { kind: 'bot', botId: 'abc123' } });
});

test('v0.86 P2-6 parser: percent-encode trong botId', () => {
  // %2D decode thành '-' -> botId hợp lệ.
  assert.deepEqual(parseDeepLink('open-bot://bot/bot%2D1'), { ok: true, route: { kind: 'bot', botId: 'bot-1' } });
  // %2F decode thành '/' -> botId chứa '/' -> từ chối.
  assert.equal(parseDeepLink('open-bot://bot/abc%2Fdef').ok, false);
  // % encode hỏng -> từ chối, không throw.
  assert.equal(parseDeepLink('open-bot://bot/%ZZ').ok, false);
  assert.equal(parseDeepLink('open-bot://bot/%').ok, false);
});

test('v0.86 P2-6 parser: MCP resource URIs are not deep-links', () => {
  // `open-bot://info` và `open-bot://workspace` là URI resource của MCP
  // server, không phải route deep-link OS — mở chúng từ ngoài phải bị
  // bỏ qua, không được điều hướng app đi đâu cả.
  assert.equal(parseDeepLink('open-bot://info').ok, false);
  assert.equal(parseDeepLink('open-bot://workspace').ok, false);
});

test('v0.86 P2-6 parser: URL sai/không rõ -> { ok: false }, không throw', () => {
  const invalid = [
    '', '   ', null, undefined, 123, {}, [],
    'https://example.com',
    'open-bot://foobar',
    'open-bot://bot',
    'open-bot://bot/',
    'open-bot://bot?id=',
    'open-bot://bot/abc/def',
    'open-bot://bot/abc%2Fdef',
    'open-bot://bot/a b',
    'open-bot://bot/../etc',
    'open-bot://bot/..',
    'open-bot://bot/.hidden',
    'open-bot://settings/extra',
    'open-bot://canvas/1',
    'open-bot://chat/extra',
    'open-bot://bot:123/abc',
    'open-bot://user@bot/abc',
    'open-bot://bot\\abc',
    'not a url at all',
    'open-bot://bot/' + 'a'.repeat(200),
    'open-bot://' + 'x'.repeat(3000),
  ];
  for (const raw of invalid) {
    const result = parseDeepLink(raw);
    assert.equal(result.ok, false, `expected invalid: ${String(raw).slice(0, 60)}`);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, 'reason phải có nội dung để log');
  }
});

test('v0.86 P2-6 parser: deepLinkToString round-trip qua parse', () => {
  const routes = [
    { kind: 'chat' },
    { kind: 'settings' },
    { kind: 'canvas' },
    { kind: 'bot', botId: '550e8400-e29b-41d4-a716-446655440000' },
  ];
  for (const route of routes) {
    const url = deepLinkToString(route);
    assert.ok(url.startsWith('open-bot://'), url);
    assert.deepEqual(parseDeepLink(url), { ok: true, route });
  }
});

test('v0.86 P2-6 parser: extractDeepLinkFromArgv', () => {
  assert.equal(
    extractDeepLinkFromArgv(['/usr/bin/electron', '/app/main.js', 'open-bot://settings']),
    'open-bot://settings',
  );
  assert.equal(extractDeepLinkFromArgv(['/usr/bin/electron', '/app/main.js']), null);
  assert.equal(extractDeepLinkFromArgv([]), null);
  // Lấy URL đầu tiên; các arg khác (flag, file) bị bỏ qua.
  assert.equal(
    extractDeepLinkFromArgv(['electron', '--no-sandbox', 'open-bot://bot/abc', 'open-bot://canvas']),
    'open-bot://bot/abc',
  );
});

// ---------------------------------------------------------------------------
// Phần B: wiring main process với mock `app`
// ---------------------------------------------------------------------------

function makeMockApp({ packaged = true, lock = true, alreadyDefault = false, registerThrows = false } = {}) {
  const listeners = new Map();
  const calls = { setDefault: [], quit: 0 };
  const app = {
    isPackaged: packaged,
    setAsDefaultProtocolClient(scheme) {
      calls.setDefault.push(scheme);
      if (registerThrows) throw new Error('đăng ký thất bại (giả lập)');
      return true;
    },
    isDefaultProtocolClient() {
      return alreadyDefault;
    },
    requestSingleInstanceLock() {
      return lock;
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    quit() {
      calls.quit += 1;
    },
    emit(event, ...args) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length;
    },
  };
  return { app, calls };
}

test('v0.86 P2-6 main: packaged app đăng ký scheme + lấy initialUrl từ argv', () => {
  const { app, calls } = makeMockApp({ packaged: true });
  const seen = [];
  const result = setupDeepLink({
    app,
    argv: ['electron', 'main.js', 'open-bot://bot/abc123'],
    onUrl: (u) => seen.push(u),
  });
  assert.deepEqual(result, { lockAcquired: true, registered: true, initialUrl: 'open-bot://bot/abc123' });
  assert.deepEqual(calls.setDefault, ['open-bot']);
  assert.equal(app.listenerCount('open-url'), 1);
  assert.equal(app.listenerCount('second-instance'), 1);
  assert.deepEqual(seen, [], 'initialUrl trả về cho caller, không tự gọi onUrl');
});

test('v0.86 P2-6 main: dev mode KHÔNG chiếm scheme của OS', () => {
  const { app, calls } = makeMockApp({ packaged: false });
  const result = setupDeepLink({ app, argv: ['electron', 'main.js'], onUrl: () => {} });
  assert.equal(result.lockAcquired, true);
  assert.equal(result.registered, false);
  assert.deepEqual(calls.setDefault, []);
  assert.equal(result.initialUrl, null);
});

test('v0.86 P2-6 main: đã là default thì không gọi set lại', () => {
  const { app, calls } = makeMockApp({ packaged: true, alreadyDefault: true });
  const result = setupDeepLink({ app, argv: [], onUrl: () => {} });
  assert.equal(result.registered, true);
  assert.deepEqual(calls.setDefault, []);
});

test('v0.86 P2-6 main: đăng ký lỗi -> registered=false, app vẫn chạy', () => {
  const { app } = makeMockApp({ packaged: true, registerThrows: true });
  const result = setupDeepLink({ app, argv: [], onUrl: () => {} });
  assert.equal(result.lockAcquired, true);
  assert.equal(result.registered, false);
});

test('v0.86 P2-6 main: lock không lấy được -> quit, không bootstrap', () => {
  const { app, calls } = makeMockApp({ lock: false });
  const result = setupDeepLink({
    app,
    argv: ['electron', 'main.js', 'open-bot://settings'],
    onUrl: () => {
      throw new Error('không được gọi onUrl khi lock thất bại');
    },
  });
  assert.deepEqual(result, { lockAcquired: false, registered: false, initialUrl: null });
  assert.equal(calls.quit, 1);
  assert.equal(app.listenerCount('open-url'), 0);
});

test('v0.86 P2-6 main: open-url (macOS) gọi onUrl + preventDefault', () => {
  const { app } = makeMockApp();
  const seen = [];
  let prevented = false;
  setupDeepLink({ app, argv: [], onUrl: (u) => seen.push(u) });
  app.emit('open-url', { preventDefault: () => { prevented = true; } }, 'open-bot://canvas');
  assert.equal(prevented, true);
  assert.deepEqual(seen, ['open-bot://canvas']);
});

test('v0.86 P2-6 main: second-instance (Win/Linux) lấy URL từ argv', () => {
  const { app } = makeMockApp();
  const seen = [];
  setupDeepLink({ app, argv: [], onUrl: (u) => seen.push(u) });
  app.emit('second-instance', {}, ['electron', 'main.js', 'open-bot://settings'], '/tmp');
  assert.deepEqual(seen, ['open-bot://settings']);
  // Instance thứ hai không mang deep-link: không gọi onUrl, không crash.
  app.emit('second-instance', {}, ['electron', 'main.js'], '/tmp');
  assert.deepEqual(seen, ['open-bot://settings']);
});

test('v0.86 P2-6 main: handleDeepLinkUrl deliver route hợp lệ, bỏ qua URL sai', () => {
  const delivered = [];
  assert.deepEqual(
    handleDeepLinkUrl('open-bot://bot/abc123', (r) => delivered.push(r)),
    { kind: 'bot', botId: 'abc123' },
  );
  assert.deepEqual(delivered, [{ kind: 'bot', botId: 'abc123' }]);
  assert.equal(handleDeepLinkUrl('open-bot://info', (r) => delivered.push(r)), null);
  assert.equal(handleDeepLinkUrl('https://example.com', (r) => delivered.push(r)), null);
  assert.equal(handleDeepLinkUrl(null, (r) => delivered.push(r)), null);
  assert.deepEqual(delivered, [{ kind: 'bot', botId: 'abc123' }]);
});

test('v0.86 P2-6 main: handleDeepLinkUrl không throw khi deliver lỗi', () => {
  assert.equal(
    handleDeepLinkUrl('open-bot://settings', () => {
      throw new Error('deliver lỗi (giả lập)');
    }),
    null,
  );
});
