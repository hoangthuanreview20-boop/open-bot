/**
 * Renderer test for v0.68c — MCP marketplace loading / error states
 * with a mocked `window.openBot`, in a REAL Electron renderer
 * (Chromium) under xvfb.
 *
 * The test bundles tests/fixtures/mcp-marketplace-view-v068c-harness.tsx
 * with esbuild, serves it from a minimal Electron harness app in a
 * temp dir (no main process, no preload — the mock IS `window.openBot`),
 * and mounts the real `McpMarketplaceView` once per scenario:
 *
 *   loading — listMcpMarketplace never settles: the Back button stays
 *             visible next to the loading line (the old early-return
 *             dropped it, leaving the user with no way back).
 *   loaded  — the marketplace answers with two servers.
 *   error   — listMcpMarketplace rejects once, then answers: the error
 *             line shows with a Retry button, and clicking it loads
 *             the server list.
 *
 * Fails on any uncaught renderer exception. The static checks at the
 * bottom run without a display; the renderer tests skip without one —
 * same convention as the other smoke tests.
 *
 * Run: xvfb-run -a node --test tests/mcp-marketplace-view-v068c-renderer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CDP_DEADLINE_MS } from './cdp-deadline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const CDP_PORT = 9770 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-v068c-'));
const bundlePath = path.join(tmpDir, 'bundle.js');

let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const pageExceptions = [];

function evalJs(expression) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP evaluate timed out after ${JS_TIMEOUT_MS}ms: ${expression.slice(0, 120)}`));
    }, JS_TIMEOUT_MS);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) return reject(new Error(`CDP ${m.error.message ?? JSON.stringify(m.error)}`));
      const details = m.result?.exceptionDetails;
      if (details) return reject(new Error(`evaluate threw: ${JSON.stringify(details).slice(0, 500)}`));
      resolve(m.result?.result?.value);
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

function attachWs(pageUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(pageUrl);
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed to open'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        pageExceptions.push(JSON.stringify(m.params?.exceptionDetails ?? m).slice(0, 1000));
        return;
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
  });
}

async function connectCdp() {
  // v0.85: 60s, not 30s — a cold Electron under full-suite load
  // can miss 30s before it serves /json/list (see tests/cdp-deadline.mjs).
  const deadline = Date.now() + CDP_DEADLINE_MS;
  let pageUrl = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const main = list.find((t) => t.type === 'page' && t.url.includes('harness.html'));
      if (main) { pageUrl = main.webSocketDebuggerUrl; break; }
    } catch {
      // DevTools not up yet.
    }
    await sleep(500);
  }
  assert.ok(pageUrl, `CDP page target (harness.html) did not appear in ${CDP_DEADLINE_MS / 1000}s`);
  await attachWs(pageUrl);
  ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.enable', params: {} }));
  const mountDeadline = Date.now() + 30_000;
  while (Date.now() < mountDeadline) {
    const ok = await evalJs(`typeof window.__mountMarketplace === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountMarketplace within 30s');
}

async function launchHarness() {
  // Minimal Electron app: a window that loads the harness page. The
  // bundle (React + the real McpMarketplaceView) runs in the renderer;
  // `window.openBot` is the mock the harness itself installs.
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v068c-harness', private: true, version: '0.0.0', main: 'main.js',
  }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'main.js'), `
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1000, height: 750,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'harness.html'));
});
`, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'harness.html'), `<!doctype html>
<meta charset="utf-8">
<title>MCP marketplace v0.68c harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'mcp-marketplace-view-v068c-harness.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    outfile: bundlePath,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  child = spawn(ELECTRON, [tmpDir, '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: tmpDir,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await connectCdp();
}

async function quitApp() {
  if (ws) { try { ws.close(); } catch { /* already closed */ } ws = null; }
  pending.clear();
  if (!child) return;
  const proc = child;
  child = null;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
}

async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evalJs(expression);
      if (last) return last;
    } catch {
      // Page busy / reloading — keep polling.
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
}

async function mountScenario(scenario) {
  assert.equal(await evalJs(`window.__mountMarketplace(${JSON.stringify(scenario)})`), true, `mounting ${scenario}`);
}

const hasTestId = (id) => `!!document.querySelector('[data-testid=${JSON.stringify(id)}]')`;
const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
const clickTestId = (id) => `(() => { const b = document.querySelector('[data-testid=${JSON.stringify(id)}]'); if (!b || b.disabled) return false; b.click(); return true; })()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: loading keeps the Back button + title next to the loading line', { skip: !hasDisplay }, async () => {
  await mountScenario('loading');
  await waitFor(hasTestId('mcp-marketplace-loading'), 10_000, 'marketplace loading line to appear');
  assert.equal(await evalJs(bodyHas('← Quay lại chat')), true, 'Back button stays visible while loading');
  assert.equal(await evalJs(bodyHas('Marketplace MCP')), true, 'title stays visible while loading');
  assert.equal(await evalJs(bodyHas('Fake Tools')), false, 'no server list while still loading');
  assert.equal(await evalJs(hasTestId('mcp-marketplace-retry')), false, 'no retry button while loading');
  // The Back button still works from the loading state.
  assert.equal(
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Quay lại')); if (!b) return false; b.click(); return true; })()`),
    true,
    'clicking Back while loading',
  );
  assert.equal(await evalJs('window.__backClicked'), true, 'onBack fired from the loading state');
});

test('renderer: error shows a Retry button; clicking it loads the list', { skip: !hasDisplay }, async () => {
  await mountScenario('error');
  await waitFor(hasTestId('mcp-marketplace-retry'), 10_000, 'marketplace retry button to appear');
  assert.equal(await evalJs(bodyHas('list failed')), true, 'load error text surfaces');
  assert.equal(await evalJs(bodyHas('← Quay lại chat')), true, 'Back button stays visible on error');
  assert.equal(await evalJs(bodyHas('Fake Tools')), false, 'no server list while in the error state');
  assert.equal(await evalJs(clickTestId('mcp-marketplace-retry')), true, 'clicking the retry button');
  await waitFor(bodyHas('Fake Tools'), 10_000, 'servers to list after retry');
  assert.equal(await evalJs(bodyHas('Memory')), true, 'second server lists after retry too');
  assert.equal(await evalJs(hasTestId('mcp-marketplace-retry')), false, 'retry button gone after a successful retry');
  assert.equal(await evalJs(bodyHas('list failed')), false, 'error text gone after a successful retry');
});

test('renderer: loaded lists the servers', { skip: !hasDisplay }, async () => {
  await mountScenario('loaded');
  await waitFor(bodyHas('Fake Tools'), 10_000, 'first server to list');
  assert.equal(await evalJs(bodyHas('Memory')), true, 'second server lists too');
  assert.equal(await evalJs(hasTestId('mcp-marketplace-loading')), false, 'no loading line once loaded');
  assert.equal(await evalJs(hasTestId('mcp-marketplace-retry')), false, 'no retry button when the load worked');
});

test('renderer: editing args before install sends the edited args (v0.84e)', { skip: !hasDisplay }, async () => {
  await mountScenario('loaded');
  await waitFor(bodyHas('Memory'), 10_000, 'Memory server to list');
  // The args editor is prefilled with the catalogue defaults.
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="mcp-args-memory"]')?.value`),
    '-y\n@modelcontextprotocol/server-memory',
    'args editor prefilled with the catalogue defaults',
  );
  // Edit the args: replace the package with a custom one.
  assert.equal(
    await evalJs(`(() => {
      const el = document.querySelector('[data-testid="mcp-args-memory"]');
      if (!el) return false;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '-y\\n@custom/server-memory');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`),
    true,
    'editing the args textarea',
  );
  // Click Install on the Memory card (not the Fake Tools one).
  assert.equal(
    await evalJs(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Memory'));
      if (!card) return false;
      const b = [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cài đặt');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`),
    true,
    'clicking Install on the Memory card',
  );
  // v0.90 (Marketplace v2): install now asks for approval first — the
  // ConfirmModal must be confirmed before the install IPC runs.
  await waitFor(hasTestId('confirm-modal'), 10_000, 'approval modal to appear');
  assert.equal(
    await evalJs(clickTestId('confirm-modal-confirm')),
    true,
    'confirming the install in the approval modal',
  );
  await waitFor(`window.__installCalls.length === 1`, 10_000, 'install IPC to be called once');
  assert.deepEqual(
    await evalJs(`window.__installCalls[0]`),
    { id: 'memory', botId: 'bot-1', args: ['-y', '@custom/server-memory'] },
    'edited args reach installMcpServer (not the catalogue defaults)',
  );
  assert.deepEqual(
    await evalJs(`window.__approveCalls[0]`),
    { kind: 'mcp-install', id: 'memory', source: 'local' },
    'approval is recorded before the install runs (v0.90)',
  );
  await waitFor(bodyHas('Đã cài server “Memory”.'), 10_000, 'install notice to show');
  assert.equal(await evalJs(bodyHas('Đã cài')), true, 'Memory shows the installed badge');
});

test('renderer: probe warning shows next to the empty tool list (v0.73)', { skip: !hasDisplay }, async () => {
  await mountScenario('probe-warning');
  await waitFor(bodyHas('Fake Tools'), 10_000, 'first server to list');
  assert.equal(
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Xem tools'); if (!b || b.disabled) return false; b.click(); return true; })()`),
    true,
    'clicking View tools',
  );
  await waitFor(bodyHas('Server này không công bố tool nào.'), 10_000, 'empty tool list to show');
  assert.equal(await evalJs(hasTestId('marketplace-probe-warning')), true, 'probe warning line renders');
  assert.equal(await evalJs(bodyHas('rejected tools/list (invalid params, code -32602)')), true, 'warning explains why the list is empty');
});

// ---------------------------------------------------------------------------
// Static checks (run without a display)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf-8');
const renderer = path.join(repo, 'apps/desktop/src/renderer');

test('static: loading branch keeps Back + title; error branch has a Retry button calling load()', () => {
  const view = read(path.join(renderer, 'components/McpMarketplaceView.tsx'));
  // Loading branch: Back button + title + loading line with a test id.
  // (v0.90: the branch is `if (loading && botId)` — with no bot picked
  // the view goes straight to the main panel instead of flashing a
  // loading state; the Back + title invariant is unchanged.)
  assert.match(view, /if \(loading(?: && botId)?\) \{[\s\S]*?mcp\.back[\s\S]*?mcp\.title[\s\S]*?data-testid="mcp-marketplace-loading"/);
  // Error branch: error line + retry button that reloads the list.
  assert.match(view, /data-testid="mcp-marketplace-retry"/, 'retry button test id');
  assert.match(view, /onClick=\{\(\) => (?:botId && )?void load\(botId\)\}/, 'retry calls load(botId)');
  assert.match(view, /mcp\.retry/, 'retry label i18n key');
  // The old bare-error line (no way forward) is gone.
  assert.doesNotMatch(view, /\{error && <p className="error">\{error\}<\/p>\}/);
});

test('static: mcp.retry exists in both locales, non-empty, no placeholders', () => {
  const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
  const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));
  for (const [loc, dict] of [['vi', vi], ['en', en]]) {
    assert.ok('mcp.retry' in dict, `mcp.retry missing in ${loc}.json`);
    assert.ok(dict['mcp.retry'].trim().length > 0, `mcp.retry empty in ${loc}.json`);
    assert.doesNotMatch(dict['mcp.retry'], /\{\w+\}/, `mcp.retry takes no vars (${loc})`);
  }
});

test('static: no hard-coded Vietnamese in the changed view file (i18n rule)', () => {
  const vietnamese = /[À-ỹđĐ]/;
  const src = read(path.join(renderer, 'components/McpMarketplaceView.tsx'));
  for (const [i, line] of src.split('\n').entries()) {
    assert.ok(!vietnamese.test(line), `McpMarketplaceView.tsx:${i + 1} still has hard-coded Vietnamese: ${line.trim()}`);
  }
});
