/**
 * MCP Apps tests (v0.98, sóng T6 — node:test, không mạng live).
 *
 * Covers packages/core/src/mcp/apps.ts + appsManager.ts:
 *  - validateAppHtml: size, forbidden tags, javascript:/data: URIs,
 *    external hosts (allowlist), form action, network calls, parent
 *    frame access, storage/cookie
 *  - buildAppCsp / buildAppFrameConfig: strict defaults, sandbox is
 *    always exactly 'allow-scripts', CSP meta injected
 *  - parseAppResult: 3 wire shapes (resource text/html, {type:'app'},
 *    structuredContent.app) + blocked app + no app
 *  - AppManager: open/close/dedupe/max-open eviction/list snapshots
 *    (no HTML in list) / onChange
 *  - renderer parity: apps/desktop/src/renderer/components/mcpApps.ts
 *    produces the SAME CSP + srcdoc as core (policy drift fails here)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AppValidationError,
  assertValidAppHtml,
  buildAppCsp,
  buildAppFrameConfig,
  hostOfUrl,
  parseAppResult,
  validateAppHtml,
  MAX_APP_HTML_BYTES,
  MAX_OPEN_APPS,
} from '../packages/core/dist/mcp/apps.js';
// AppManager lives in appsManager.js, not apps.js (v0.98 fix: wrong module import crashed the file).
import { AppManager } from '../packages/core/dist/mcp/appsManager.js';
import { AppManager as AppManagerFromBarrel } from '../packages/core/dist/index.js';
import {
  MCP_APP_SANDBOX,
  SAMPLE_APP_HTML,
  buildRendererAppCsp,
  buildRendererAppSrcdoc,
} from '../apps/desktop/src/renderer/components/mcpApps.ts';

const GOOD_HTML = '<div><h1>Hello</h1><button id="b">Click</button><script>document.getElementById("b").addEventListener("click", function () {});</script></div>';
const FULL_DOC = '<!doctype html><html><head><style>body { color: red; }</style></head><body><p>Hi</p></body></html>';

function contentResult(blocks, structuredContent) {
  const out = { content: blocks, text: '', isError: false, structuredContentValid: false, resourceLinks: [] };
  if (structuredContent !== undefined) out.structuredContent = structuredContent;
  return out;
}

// ---------------------------------------------------------------------------
// hostOfUrl
// ---------------------------------------------------------------------------

test('apps: hostOfUrl parses absolute + protocol-relative, null otherwise', () => {
  assert.equal(hostOfUrl('https://cdn.example.com/a.js'), 'cdn.example.com');
  assert.equal(hostOfUrl('http://EXAMPLE.com/x'), 'example.com');
  assert.equal(hostOfUrl('//cdn.example.com/a.js'), 'cdn.example.com');
  // v0.98 fix: ws/wss cũng là URL tuyệt đối, phải trả host để allowlist kiểm tra.
  assert.equal(hostOfUrl('wss://ws.example.com/socket'), 'ws.example.com');
  assert.equal(hostOfUrl('ws://localhost:8080/x'), 'localhost');
  assert.equal(hostOfUrl('/local/path.js'), null);
  assert.equal(hostOfUrl('./relative.js'), null);
  assert.equal(hostOfUrl('not a url'), null);
});

// ---------------------------------------------------------------------------
// validateAppHtml
// ---------------------------------------------------------------------------

test('apps: validate accepts plain interactive HTML (inline script + style)', () => {
  const result = validateAppHtml(GOOD_HTML);
  // v0.98 merge: the result carries BOTH shapes — `errors` (v0.98,
  // Vietnamese strings) and `findings` (v0.97, coded) — so assert the
  // fields, not the whole object.
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.findings, []);
  assert.doesNotThrow(() => assertValidAppHtml(GOOD_HTML));
});

test('apps: validate rejects empty HTML', () => {
  const result = validateAppHtml('   ');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /rỗng/);
});

test('apps: validate rejects oversize HTML', () => {
  const big = `<p>${'x'.repeat(MAX_APP_HTML_BYTES)}</p>`;
  const result = validateAppHtml(big);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('quá lớn')));
  // A bigger explicit cap allows it back.
  assert.equal(validateAppHtml(big, { maxBytes: MAX_APP_HTML_BYTES * 2 }).valid, true);
});

test('apps: validate rejects base / meta refresh / nested frames', () => {
  for (const html of [
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0; url=https://evil.example/">',
    '<iframe src="https://evil.example/"></iframe>',
    '<object data="https://evil.example/x.swf"></object>',
    '<embed src="https://evil.example/x.swf">',
  ]) {
    const result = validateAppHtml(html);
    assert.equal(result.valid, false, html);
  }
});

test('apps: validate rejects javascript:/data:text/html URIs', () => {
  assert.equal(validateAppHtml('<a href="javascript:alert(1)">x</a>').valid, false);
  assert.equal(validateAppHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>').valid, false);
  assert.equal(validateAppHtml('<a href="https://example.com/">ok</a>').valid, false, 'external https link is also blocked without allowlist');
});

test('apps: validate blocks external resource hosts unless allowlisted', () => {
  const html = '<script src="https://cdn.example.com/lib.js"></script><img src="https://img.example.com/a.png">';
  assert.equal(validateAppHtml(html).valid, false);
  assert.equal(validateAppHtml(html, { allowedHosts: ['cdn.example.com'] }).valid, false, 'one host still missing');
  assert.equal(
    validateAppHtml(html, { allowedHosts: ['cdn.example.com', 'img.example.com'] }).valid,
    true,
  );
  // Subdomains of an allowed host are allowed; lookalike suffixes are not.
  assert.equal(validateAppHtml('<img src="https://a.cdn.example.com/x.png">', { allowedHosts: ['cdn.example.com'] }).valid, true);
  assert.equal(validateAppHtml('<img src="https://notcdn.example.com/x.png">', { allowedHosts: ['cdn.example.com'] }).valid, false);
  // Relative URLs are fine (they resolve inside the sandboxed document).
  assert.equal(validateAppHtml('<img src="/x.png"><script src="./a.js"></script>').valid, true);
});

test('apps: validate rejects form action + network calls to outside hosts', () => {
  assert.equal(validateAppHtml('<form action="/submit"><input></form>').valid, false);
  assert.equal(validateAppHtml('<script>fetch("https://api.example.com/data")</script>').valid, false);
  assert.equal(validateAppHtml('<script>fetch("https://api.example.com/data")</script>', { allowedHosts: ['api.example.com'] }).valid, true);
  assert.equal(validateAppHtml('<script>new WebSocket("wss://ws.example.com")</script>').valid, false);
  assert.equal(validateAppHtml('<script>var x = new XMLHttpRequest();</script>').valid, true, 'bare XHR with no URL is not a leak');
});

test('apps: validate rejects parent-frame access + storage/cookie', () => {
  for (const html of [
    '<script>window.top.location = "https://evil.example/"</script>',
    '<script>window.parent.document.title</script>',
    '<script>document.cookie</script>',
    '<script>localStorage.setItem("k", "v")</script>',
    '<script>sessionStorage.getItem("k")</script>',
  ]) {
    assert.equal(validateAppHtml(html).valid, false, html);
  }
});

test('apps: assertValidAppHtml throws AppValidationError with the reasons', () => {
  assert.throws(
    () => assertValidAppHtml('<iframe src="https://evil.example/"></iframe>'),
    (err) => err instanceof AppValidationError && err.errors.length > 0,
  );
});

// ---------------------------------------------------------------------------
// CSP + frame config
// ---------------------------------------------------------------------------

test('apps: buildAppCsp locks down by default, opens only allowlisted hosts', () => {
  const csp = buildAppCsp();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /img-src data: blob:/);
  const open = buildAppCsp({ allowedHosts: ['cdn.example.com'] });
  assert.match(open, /img-src data: blob: https:\/\/cdn\.example\.com/);
  assert.match(open, /connect-src https:\/\/cdn\.example\.com/);
  assert.doesNotMatch(open, /connect-src 'none'/);
});

test('apps: buildAppFrameConfig sandbox is always exactly allow-scripts', () => {
  const config = buildAppFrameConfig({ title: 'T', html: GOOD_HTML });
  assert.equal(config.sandbox, 'allow-scripts');
  assert.match(config.srcdoc, /Content-Security-Policy/);
  assert.match(config.srcdoc, /<title>T<\/title>/);
  assert.match(config.srcdoc, /Hello/);
  // Full document: CSP meta is injected into <head>, document kept.
  const full = buildAppFrameConfig({ title: 'Full', html: FULL_DOC });
  assert.match(full.srcdoc, /<head><meta http-equiv="Content-Security-Policy"/);
  assert.match(full.srcdoc, /<title>Full<\/title>/);
  assert.match(full.srcdoc, /body { color: red; }/);
  // Title is escaped — a server cannot break out of <title>.
  const evil = buildAppFrameConfig({ title: '</title><script>alert(1)</script>', html: '<p>x</p>' });
  assert.doesNotMatch(evil.srcdoc, /<\/title><script>alert/);
  assert.match(evil.srcdoc, /&lt;\/title&gt;/);
});

// ---------------------------------------------------------------------------
// parseAppResult
// ---------------------------------------------------------------------------

test('apps: parseAppResult shape A — resource text/html (ui://)', () => {
  const parsed = parseAppResult(
    contentResult([
      { type: 'resource', resource: { uri: 'ui://fake/card', mimeType: 'text/html', text: GOOD_HTML } },
      { type: 'text', text: 'Here is your card.' },
    ]),
    { serverName: 'fake', toolName: 'show-app' },
  );
  assert.equal(parsed.blocked, undefined);
  assert.ok(parsed.app);
  assert.equal(parsed.app.serverName, 'fake');
  assert.equal(parsed.app.toolName, 'show-app');
  assert.equal(parsed.app.sourceUri, 'ui://fake/card');
  assert.equal(parsed.app.html, GOOD_HTML);
  assert.equal(parsed.app.origin, 'tool-result');
});

test('apps: parseAppResult shape B — {type: app} block', () => {
  const parsed = parseAppResult(
    contentResult([{ type: 'app', html: GOOD_HTML, title: 'My card' }]),
    { serverName: 'fake', toolName: 'show-app' },
  );
  assert.ok(parsed.app);
  assert.equal(parsed.app.title, 'My card');
});

test('apps: parseAppResult shape C — structuredContent.app / .html', () => {
  const fromApp = parseAppResult(contentResult([], { app: { html: GOOD_HTML, title: 'S' } }), { serverName: 'fake' });
  assert.ok(fromApp.app);
  assert.equal(fromApp.app.title, 'S');
  const fromHtml = parseAppResult(contentResult([], { html: GOOD_HTML }), { serverName: 'fake' });
  assert.ok(fromHtml.app);
  assert.equal(fromHtml.app.title, 'App từ fake');
});

test('apps: parseAppResult returns null when there is no app', () => {
  const parsed = parseAppResult(
    contentResult([{ type: 'text', text: 'just text' }]),
    { serverName: 'fake' },
  );
  assert.deepEqual(parsed, { app: null });
  // A resource with the wrong mime type is not an app.
  const wrong = parseAppResult(
    contentResult([{ type: 'resource', resource: { uri: 'file:///x.txt', mimeType: 'text/plain', text: 'hi' } }]),
    { serverName: 'fake' },
  );
  assert.deepEqual(wrong, { app: null });
});

test('apps: parseAppResult blocks an invalid app instead of returning it', () => {
  const parsed = parseAppResult(
    contentResult([{ type: 'app', html: '<iframe src="https://evil.example/"></iframe>' }]),
    { serverName: 'fake', toolName: 'show-app' },
  );
  assert.equal(parsed.app, null);
  assert.ok(parsed.blocked && parsed.blocked.includes('iframe'));
});

test('apps: parseAppResult takes the first app block only', () => {
  const parsed = parseAppResult(
    contentResult([
      { type: 'app', html: '<p>first</p>', title: 'First' },
      { type: 'app', html: '<p>second</p>', title: 'Second' },
    ]),
    { serverName: 'fake' },
  );
  assert.equal(parsed.app?.title, 'First');
});

// ---------------------------------------------------------------------------
// AppManager
// ---------------------------------------------------------------------------

test('apps: AppManager is exported from the core barrel too', () => {
  assert.equal(AppManagerFromBarrel, AppManager);
});

test('apps: AppManager open/list/get/close + list has no HTML', () => {
  const manager = new AppManager({ newId: (() => { let n = 0; return () => `id-${++n}`; })() });
  const opened = manager.open({ serverName: 'fake', toolName: 'show-app', title: 'Card', html: GOOD_HTML, origin: 'tool-result' });
  assert.equal(opened.id, 'id-1');
  assert.equal(manager.size, 1);
  const list = manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'id-1');
  assert.equal('html' in list[0], false, 'list snapshots must not carry HTML');
  assert.ok(list[0].htmlBytes > 0);
  assert.equal(manager.get('id-1')?.html, GOOD_HTML);
  assert.equal(manager.get('nope'), undefined);
  assert.equal(manager.close('id-1'), true);
  assert.equal(manager.close('id-1'), false);
  assert.equal(manager.size, 0);
});

test('apps: AppManager dedupes reopening the same app', () => {
  const manager = new AppManager();
  const first = manager.open({ serverName: 'fake', title: 'Card', html: GOOD_HTML, origin: 'tool-result' });
  const second = manager.open({ serverName: 'fake', title: 'Card', html: GOOD_HTML, origin: 'tool-result' });
  assert.equal(second.id, first.id);
  assert.equal(manager.size, 1);
});

test('apps: AppManager evicts the oldest app over the cap', () => {
  const manager = new AppManager({ maxOpenApps: 2 });
  const a = manager.open({ serverName: 's', title: 'A', html: '<p>a</p>', origin: 'manual' });
  manager.open({ serverName: 's', title: 'B', html: '<p>b</p>', origin: 'manual' });
  manager.open({ serverName: 's', title: 'C', html: '<p>c</p>', origin: 'manual' });
  assert.equal(manager.size, 2);
  assert.equal(manager.get(a.id), undefined, 'oldest app is evicted');
  assert.equal(manager.list().length, 2);
});

test('apps: AppManager onChange fires on open/close, closeAll clears', () => {
  const manager = new AppManager();
  const seen = [];
  const off = manager.onChange((apps) => seen.push(apps.map((a) => a.id)));
  const app = manager.open({ serverName: 's', title: 'A', html: '<p>a</p>', origin: 'manual' });
  manager.close(app.id);
  const second = manager.open({ serverName: 's', title: 'B', html: '<p>b</p>', origin: 'manual' });
  manager.closeAll();
  off();
  manager.open({ serverName: 's', title: 'C', html: '<p>c</p>', origin: 'manual' });
  assert.equal(seen.length, 4, 'open, close, open, closeAll each emit once; nothing after off()');
  assert.deepEqual(seen[0], [app.id]);
  assert.deepEqual(seen[1], []);
  assert.deepEqual(seen[2], [second.id]);
  assert.deepEqual(seen[3], []);
});

// ---------------------------------------------------------------------------
// Renderer parity (core policy vs renderer mirror)
// ---------------------------------------------------------------------------

test('apps: renderer CSP + srcdoc match core exactly (no policy drift)', () => {
  assert.equal(MCP_APP_SANDBOX, 'allow-scripts');
  assert.equal(buildRendererAppCsp(), buildAppCsp());
  assert.equal(buildRendererAppCsp(['cdn.example.com']), buildAppCsp({ allowedHosts: ['cdn.example.com'] }));
  for (const html of [GOOD_HTML, FULL_DOC, '<p>plain fragment</p>']) {
    assert.equal(
      buildRendererAppSrcdoc('T', html),
      buildAppFrameConfig({ title: 'T', html }).srcdoc,
    );
  }
});

test('apps: sample app passes core validation (sandbox self-test is renderable)', () => {
  assert.equal(validateAppHtml(SAMPLE_APP_HTML).valid, true);
  assert.ok(SAMPLE_APP_HTML.length < MAX_APP_HTML_BYTES);
  assert.ok(MAX_OPEN_APPS >= 1);
});
