/**
 * Renderer test for v0.87c — NotificationsSection: per-kind toggles,
 * "Send test" button, unsupported-machine notice, load failure.
 *
 * Mounts the real NotificationsSection in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/notifications-v087c-harness.tsx):
 *   loaded:           all four toggles ON (v0.94c adds project-update); toggling approval OFF
 *                     persists via setSettings; "Send test" shows
 *                     the sent notice.
 *   test-unsupported: "Send test" returns { shown: false, reason:
 *                     'unsupported' } -> the not-shown notice names
 *                     the reason (no fake claim of a popup).
 *   load-fails:       getSettings rejects -> the load error, no crash.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/notifications-v087c-renderer.test.mjs
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
const CDP_PORT = 10200 + (process.pid % 100);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-notifications-v087c-'));
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
        const cb = pending.get(m.id);
        pending.delete(m.id);
        cb(m);
      }
    };
  });
}

async function connectCdp() {
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
    const ok = await evalJs(`typeof window.__mountNotifications === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountNotifications within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v087c-notifications-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>NotificationsSection v0.87c harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'notifications-v087c-harness.tsx')],
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

const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
const clickTestId = (testId) => `(() => { const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]'); if (!el || el.disabled) return false; el.click(); return true; })()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: all four toggles ON by default, toggling approval OFF persists', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountNotifications('loaded')`), true, 'mounting NotificationsSection loaded');
  await waitFor(bodyHas('Thông báo hệ thống'), 10_000, 'section title to load');
  // v0.94c: the fourth toggle is the project-update digest (every 6h).
  for (const id of ['notifications-toggle-run-complete', 'notifications-toggle-approval', 'notifications-toggle-run-error', 'notifications-toggle-project-update']) {
    await waitFor(`!!document.querySelector('[data-testid="${id}"]')`, 10_000, `${id} to appear`);
    assert.equal(
      await evalJs(`document.querySelector('[data-testid="${id}"]').checked`),
      true,
      `${id} defaults to ON`,
    );
  }
  assert.equal(await evalJs(clickTestId('notifications-toggle-approval')), true, 'clicking the approval toggle');
  await waitFor(
    `document.querySelector('[data-testid="notifications-toggle-approval"]').checked === false`,
    10_000,
    'approval toggle to turn OFF',
  );
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="notifications-toggle-run-complete"]').checked`),
    true,
    'toggling approval leaves run-complete ON',
  );
});

test('renderer: "Send test" shows the sent notice when main reports shown', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountNotifications('loaded')`), true, 'mounting NotificationsSection loaded');
  await waitFor(`!!document.querySelector('[data-testid="notifications-test"]')`, 10_000, 'test button to appear');
  assert.equal(await evalJs(clickTestId('notifications-test')), true, 'clicking Send test');
  await waitFor(bodyHas('Đã gửi thông báo thử.'), 10_000, 'sent notice to appear');
});

test('renderer: "Send test" names the reason when main reports not shown', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountNotifications('test-unsupported')`), true, 'mounting NotificationsSection test-unsupported');
  await waitFor(`!!document.querySelector('[data-testid="notifications-test"]')`, 10_000, 'test button to appear');
  assert.equal(await evalJs(clickTestId('notifications-test')), true, 'clicking Send test');
  await waitFor(bodyHas('Thông báo thử không hiện (unsupported).'), 10_000, 'not-shown notice to appear');
  assert.equal(await evalJs(bodyHas('Đã gửi thông báo thử.')), false, 'no fake sent notice');
});

test('renderer: load failure shows the load error and does not crash', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountNotifications('load-fails')`), true, 'mounting NotificationsSection load-fails');
  await waitFor(bodyHas('settings failed'), 10_000, 'load error to appear');
  assert.equal(await evalJs(`document.querySelectorAll('[data-testid^="notifications-toggle-"]').length`), 0, 'no toggles on load failure');
});
