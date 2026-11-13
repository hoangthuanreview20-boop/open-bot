/**
 * Test v0.97 T1: MCP Apps — validation, CSP, frame descriptor, bridge (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v097-apps.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppCsp,
  buildAppFrameDescriptor,
  parseAppBridgeMessage,
  parseAppResource,
  validateAppHtml,
  MCP_APP_IFRAME_SANDBOX,
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_MIME_TYPE,
  MCP_APPS_EXTENSION,
  McpAppError,
} from '../packages/core/dist/mcp/apps.js';

const SAFE_HTML = `<!doctype html><html><head><style>body { color: navy; }</style></head>
<body><h1>Hello</h1><button id="ok">OK</button>
<script>document.getElementById('ok').addEventListener('click', () => {
  parent.postMessage({ type: 'mcp-app-request', action: 'notify', payload: { message: 'hi' } }, window.location.origin);
});</script></body></html>`;

test('apps: extension name and mime type constants', () => {
  assert.equal(MCP_APPS_EXTENSION, 'io.modelcontextprotocol/apps');
  assert.equal(MCP_APP_MIME_TYPE, 'text/html');
  assert.equal(MCP_APP_MAX_HTML_BYTES, 256 * 1024);
});

test('apps: safe self-contained HTML validates clean', () => {
  const result = validateAppHtml(SAFE_HTML);
  assert.equal(result.valid, true);
  assert.deepEqual(result.findings, []);
});

test('apps: empty HTML is refused', () => {
  const result = validateAppHtml('');
  assert.equal(result.valid, false);
  assert.equal(result.findings[0].code, 'app-empty');
});

test('apps: oversized HTML is refused', () => {
  const big = `<p>${'x'.repeat(MCP_APP_MAX_HTML_BYTES)}</p>`;
  const result = validateAppHtml(big);
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((f) => f.code === 'app-too-large'));
});

test('apps: remote script / import / resource are blocking', () => {
  for (const [code, html] of [
    ['app-remote-script', '<script src="https://evil.example/x.js"></script>'],
    ['app-remote-import', '<style>@import "https://evil.example/x.css";</style>'],
    ['app-external-resource', '<img src="https://evil.example/pixel.png">'],
    ['app-external-resource', '<link rel="stylesheet" href="https://evil.example/x.css">'],
    ['app-remote-script', '<script src="http://evil.example/x.js"></script>'],
  ]) {
    const result = validateAppHtml(html);
    assert.equal(result.valid, false, html);
    assert.ok(result.findings.some((f) => f.code === code), `${html} should hit ${code}`);
  }
});

test('apps: escape attempts are blocking (navigation, parent access, eval, fetch)', () => {
  const cases = [
    ['app-javascript-url', '<a href="javascript:alert(1)">click</a>'],
    ['app-top-navigation', '<script>window.top.location = "https://evil.example";</script>'],
    ['app-parent-access', '<script>parent.document.title = "x";</script>'],
    ['app-wildcard-postmessage', '<script>parent.postMessage({a:1}, "*");</script>'],
    ['app-form-remote', '<form action="https://evil.example/collect" method="post"></form>'],
    ['app-eval', '<script>eval("alert(1)");</script>'],
    ['app-eval', '<script>new Function("return 1")();</script>'],
    ['app-websocket-remote', '<script>new WebSocket("wss://evil.example/ws");</script>'],
    ['app-fetch-remote', '<script>fetch("https://evil.example/data");</script>'],
    ['app-cookie-access', '<script>document.cookie;</script>'],
    ['app-meta-refresh', '<meta http-equiv="refresh" content="0; url=https://evil.example">'],
    ['app-base-href', '<base href="https://evil.example/">'],
  ];
  for (const [code, html] of cases) {
    const result = validateAppHtml(html);
    assert.equal(result.valid, false, html);
    assert.ok(result.findings.some((f) => f.code === code), `${html} should hit ${code}`);
  }
});

test('apps: warnings do not block (inline event handlers only)', () => {
  const withHandler = validateAppHtml('<button onclick="doThing()">x</button>');
  assert.equal(withHandler.valid, true);
  assert.ok(withHandler.findings.some((f) => f.code === 'app-inline-event-handler'));
});

// v0.98 merge: T6's allowlist policy made storage + external links
// BLOCKING (the CSP already blocks them at runtime — `connect-src
// 'none'`, opaque-origin storage — so warning about them was a lie).
// See packages/core/src/mcp/apps.ts header for the merge policy.
test('apps: storage and external links are blocking since v0.98 (allowlist policy)', () => {
  const withStorage = validateAppHtml('<script>localStorage.setItem("k", "v");</script>');
  assert.equal(withStorage.valid, false);
  assert.ok(withStorage.findings.some((f) => f.code === 'app-localstorage'));
  assert.ok(withStorage.errors.join(' ').includes('localStorage'));
  const withLink = validateAppHtml('<a href="https://example.com/docs">docs</a>');
  assert.equal(withLink.valid, false);
  assert.ok(withLink.findings.some((f) => f.code === 'app-external-host'));
});

test('apps: CSP is strict — no network, no plugins, no top navigation', () => {
  const csp = buildAppCsp();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(csp, /https?:/);
});

test('apps: parseAppResource requires ui:// uri, html and text/html', () => {
  assert.throws(() => parseAppResource(null), McpAppError);
  assert.throws(() => parseAppResource({ uri: 'https://example.com/app', html: '<p>x</p>' }), /ui:\/\//);
  assert.throws(() => parseAppResource({ uri: 'ui://s/app' }), /no HTML/);
  assert.throws(
    () => parseAppResource({ uri: 'ui://s/app', html: '<p>x</p>', mimeType: 'application/json' }),
    /text\/html/,
  );
  assert.throws(
    () => parseAppResource({ uri: 'ui://s/app', html: '<p>x</p>', title: 'x'.repeat(121) }),
    /120/,
  );
  const app = parseAppResource({ uri: 'ui://demo/hello', title: 'Hello', html: '<p>hi</p>' });
  assert.equal(app.uri, 'ui://demo/hello');
  assert.equal(app.title, 'Hello');
  assert.equal(app.mimeType, 'text/html');
  // `text` is accepted as the HTML field (some servers use it).
  assert.equal(parseAppResource({ uri: 'ui://s/app', text: '<p>t</p>' }).html, '<p>t</p>');
});

test('apps: buildAppFrameDescriptor returns sandbox + CSP verbatim, throws on refused apps', () => {
  const descriptor = buildAppFrameDescriptor({
    uri: 'ui://demo/hello',
    title: 'Hello',
    html: SAFE_HTML,
  });
  assert.equal(descriptor.srcdoc, SAFE_HTML);
  assert.equal(descriptor.sandbox, MCP_APP_IFRAME_SANDBOX);
  assert.match(descriptor.sandbox, /allow-scripts/);
  assert.match(descriptor.csp, /default-src 'none'/);
  assert.equal(descriptor.title, 'Hello');
  assert.deepEqual(descriptor.warnings, []);
  assert.throws(
    () =>
      buildAppFrameDescriptor({
        uri: 'ui://evil/x',
        html: '<script src="https://evil.example/x.js"></script>',
      }),
    (err) => err instanceof McpAppError && /remote script/.test(err.message),
  );
});

test('apps: descriptor carries warnings for apps that pass with warnings', () => {
  const descriptor = buildAppFrameDescriptor({
    uri: 'ui://demo/warn',
    html: '<button onclick="go()">x</button>',
  });
  assert.equal(descriptor.warnings.length, 1);
  assert.equal(descriptor.warnings[0].severity, 'warning');
});

test('apps: bridge messages — only mcp-app-request with a known action passes', () => {
  assert.deepEqual(parseAppBridgeMessage({ type: 'mcp-app-request', action: 'notify', payload: { message: 'hi' } }), {
    type: 'mcp-app-request',
    action: 'notify',
    payload: { message: 'hi' },
  });
  assert.deepEqual(parseAppBridgeMessage({ type: 'mcp-app-request', action: 'close' }), {
    type: 'mcp-app-request',
    action: 'close',
  });
  assert.equal(parseAppBridgeMessage({ type: 'mcp-app-response', action: 'notify' }), null);
  assert.equal(parseAppBridgeMessage({ type: 'mcp-app-request', action: 'eval' }), null);
  assert.equal(parseAppBridgeMessage({ type: 'mcp-app-request' }), null);
  assert.equal(parseAppBridgeMessage({ type: 'mcp-app-request', action: 'notify', payload: 'not-an-object' }), null);
  assert.equal(parseAppBridgeMessage('hello'), null);
  assert.equal(parseAppBridgeMessage(null), null);
});
