/**
 * Renderer test for v0.67b — Connected apps loading / empty / error
 * states with a mocked `window.openBot`, in a REAL Electron renderer
 * (Chromium) under xvfb.
 *
 * The test bundles tests/fixtures/connected-apps-v067b-harness.tsx
 * with esbuild, serves it from a minimal Electron harness app in a
 * temp dir (no main process, no preload — the mock IS `window.openBot`),
 * and mounts the real `ConnectedAppsView` once per scenario:
 *
 *   apps:     loading | loaded (2 apps) | empty | error + retry
 *   composio: loading | empty | error + retry
 *
 * The retry cases reject on the first IPC call and answer on the
 * second, so clicking the retry button must turn the error into the
 * loaded state. Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/connected-apps-v067b-renderer.test.mjs
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
const CDP_PORT = 9750 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-connected-apps-v067b-'));
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
    const ok = await evalJs(`typeof window.__mountConnectedApps === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountConnectedApps within 30s');
}

async function launchHarness() {
  // Minimal Electron app: a window that loads the harness page. The
  // bundle (React + the real ConnectedAppsView) runs in the renderer;
  // `window.openBot` is the mock the harness itself installs.
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v067b-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>Connected apps v0.67b harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'connected-apps-v067b-harness.tsx')],
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
  assert.equal(await evalJs(`window.__mountConnectedApps(${JSON.stringify(scenario)})`), true, `mounting ${scenario}`);
}

const hasTestId = (id) => `!!document.querySelector('[data-testid=${JSON.stringify(id)}]')`;
const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: apps loading / loaded / empty / error + retry', { skip: !hasDisplay }, async () => {
  // Loading: apps:list never settles, Composio loads fine.
  await mountScenario('apps-loading');
  await waitFor(hasTestId('apps-loading'), 10_000, 'apps loading line to appear');
  assert.equal(await evalJs(hasTestId('apps-empty')), false, 'no empty state while loading');
  assert.equal(await evalJs(bodyHas('Composio (tích hợp thêm, opt-in)')), true, 'Composio section loads independently');

  // Loaded: two apps, no loading line, no empty state.
  await mountScenario('apps-loaded');
  await waitFor(bodyHas('Local Notes'), 10_000, 'first sample app to list');
  assert.equal(await evalJs(bodyHas('Local Files')), true, 'second sample app lists too');
  assert.equal(await evalJs(hasTestId('apps-loading')), false, 'no loading line once loaded');
  assert.equal(await evalJs(hasTestId('apps-empty')), false, 'no empty state when apps exist');

  // Empty: the list answered with no apps.
  await mountScenario('apps-empty');
  await waitFor(hasTestId('apps-empty'), 10_000, 'apps empty state to appear');
  assert.equal(await evalJs(bodyHas('Chưa có app nào được kết nối.')), true, 'empty line text');
  assert.equal(await evalJs(bodyHas('Kết nối app trong mục này')), true, 'empty hint text');
  assert.equal(await evalJs(hasTestId('apps-loading')), false, 'no loading line once the empty answer arrived');

  // Error + retry: first call rejects, retry answers with the apps.
  await mountScenario('apps-error');
  await waitFor(hasTestId('apps-retry'), 10_000, 'apps retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách app.')), true, 'apps load error text');
  assert.equal(await evalJs(`(() => { const b = document.querySelector('[data-testid="apps-retry"]'); if (!b || b.disabled) return false; b.click(); return true; })()`), true, 'clicking apps retry');
  await waitFor(bodyHas('Local Notes'), 10_000, 'apps to list after retry');
  assert.equal(await evalJs(hasTestId('apps-retry')), false, 'retry button gone after a successful retry');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách app.')), false, 'error text gone after a successful retry');
});

test('renderer: Composio loading / empty / error + retry', { skip: !hasDisplay }, async () => {
  // Loading: get-state never settles, apps load fine.
  await mountScenario('composio-loading');
  await waitFor(hasTestId('composio-loading'), 10_000, 'Composio loading line to appear');
  assert.equal(await evalJs(hasTestId('composio-empty')), false, 'no empty state while loading');
  assert.equal(await evalJs(bodyHas('Local Notes')), true, 'apps list loads independently');

  // Empty: get-state answered null (method not exposed).
  await mountScenario('composio-empty');
  await waitFor(hasTestId('composio-empty'), 10_000, 'Composio empty state to appear');
  assert.equal(await evalJs(bodyHas('Chưa có trạng thái Composio.')), true, 'empty line text');
  assert.equal(await evalJs(bodyHas('Composio chưa gửi trạng thái về')), true, 'empty hint text');
  assert.equal(await evalJs(hasTestId('composio-loading')), false, 'no loading line once the empty answer arrived');

  // Error + retry: first call rejects, retry answers with the state.
  await mountScenario('composio-error');
  await waitFor(hasTestId('composio-retry'), 10_000, 'Composio retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được trạng thái Composio.')), true, 'Composio load error text');
  assert.equal(await evalJs(`(() => { const b = document.querySelector('[data-testid="composio-retry"]'); if (!b || b.disabled) return false; b.click(); return true; })()`), true, 'clicking Composio retry');
  await waitFor(bodyHas('Composio (tích hợp thêm, opt-in)'), 10_000, 'Composio section to appear after retry');
  assert.equal(await evalJs(hasTestId('composio-retry')), false, 'retry button gone after a successful retry');
  assert.equal(await evalJs(bodyHas('Không tải được trạng thái Composio.')), false, 'error text gone after a successful retry');
  assert.equal(await evalJs(bodyHas('Chưa có Composio API key')), true, 'loaded section shows the key-missing line');
});

test('renderer: GitHub PAT flow — paste token, save, connected, disconnect', { skip: !hasDisplay }, async () => {
  // v0.68b: the GitHub token app renders a password input + save button
  // while not connected. Typing a visibly fake PAT and saving must call
  // 'apps:set-token' exactly once with that token, flip the status to
  // connected, hide the form and show the disconnect button; disconnect
  // must bring the form back. No real token is used anywhere.
  await mountScenario('github-token');
  await waitFor(hasTestId('app-token-input-github'), 10_000, 'GitHub PAT input to appear');
  assert.equal(await evalJs(bodyHas('GitHub')), true, 'GitHub app lists');
  assert.equal(await evalJs(bodyHas('github.com')), true, 'PAT hint tells where to create the token');
  assert.equal(await evalJs(hasTestId('app-disconnect-github')), false, 'no disconnect button while not connected');
  assert.equal(
    await evalJs(`(() => { const i = document.querySelector('[data-testid="app-token-input-github"]'); return i ? i.type : null; })()`),
    'password',
    'PAT input is a password field',
  );

  // Type into the React controlled input via the native value setter.
  assert.equal(
    await evalJs(`(() => {
      const input = document.querySelector('[data-testid="app-token-input-github"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'ghp_test_fake_token_123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value === 'ghp_test_fake_token_123';
    })()`),
    true,
    'typing the fake PAT into the input',
  );
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-testid="app-token-save-github"]'); if (!b || b.disabled) return false; b.click(); return true; })()`),
    true,
    'clicking the PAT save button',
  );
  await waitFor(bodyHas('Đã kết nối'), 10_000, 'GitHub status to flip to connected');
  assert.deepEqual(
    await evalJs('window.__githubTokenCalls'),
    [{ appId: 'github', token: 'ghp_test_fake_token_123' }],
    'exactly one set-token call with the pasted PAT',
  );
  assert.equal(await evalJs(hasTestId('app-token-input-github')), false, 'PAT form hides once connected');
  assert.equal(await evalJs(hasTestId('app-token-save-github')), false, 'PAT save button hides once connected');
  assert.equal(await evalJs(hasTestId('app-disconnect-github')), true, 'disconnect button shows once connected');

  // Disconnect: the token is revoked and the PAT form comes back.
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-testid="app-disconnect-github"]'); if (!b || b.disabled) return false; b.click(); return true; })()`),
    true,
    'clicking disconnect',
  );
  await waitFor(hasTestId('app-token-input-github'), 10_000, 'PAT form to come back after disconnect');
  assert.deepEqual(
    await evalJs('window.__githubDisconnectCalls'),
    [{ appId: 'github' }],
    'exactly one disconnect call for github',
  );
  assert.equal(await evalJs(bodyHas('Chưa kết nối')), true, 'GitHub status back to not connected');
});
