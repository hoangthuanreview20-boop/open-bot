/**
 * Renderer test for v0.86 (P2-7) — CrashReportsSection: opt-in toggle,
 * list, open detail, delete one, delete all, empty state, load error.
 *
 * Mounts the real CrashReportsSection in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/crash-reports-v086-harness.tsx):
 *   loaded:     toggle OFF + 2 reports; toggle ON shows the enabled
 *               notice; open r1 shows the redacted message + stack;
 *               delete r2 (two-step) removes it; delete-all removes
 *               the last one and the empty message appears.
 *   empty:      toggle OFF, no reports -> the empty message, no crash.
 *   load-fails: listCrashReports rejects -> the load error, no crash.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/crash-reports-v086-renderer.test.mjs
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
const CDP_PORT = 9800 + (process.pid % 200);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-crash-reports-v086-'));
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
    const ok = await evalJs(`typeof window.__mountCrashReports === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountCrashReports within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v086-crash-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>CrashReportsSection v0.86 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'crash-reports-v086-harness.tsx')],
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

test('renderer: toggle OFF by default, toggle ON shows the enabled notice', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountCrashReports('loaded')`), true, 'mounting CrashReportsSection loaded');
  await waitFor(bodyHas('Báo cáo lỗi (crash)'), 10_000, 'section title to load');
  await waitFor(`!!document.querySelector('[data-testid="crash-reports-toggle"]')`, 10_000, 'toggle to appear');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="crash-reports-toggle"]').checked`),
    false,
    'toggle defaults to OFF (opt-in)',
  );
  assert.equal(await evalJs(clickTestId('crash-reports-toggle')), true, 'clicking the toggle');
  await waitFor(bodyHas('Đã bật báo cáo lỗi'), 10_000, 'enabled notice to appear');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="crash-reports-toggle"]').checked`),
    true,
    'toggle is ON after clicking',
  );
  // Toggle back OFF — the notice changes, the list stays.
  assert.equal(await evalJs(clickTestId('crash-reports-toggle')), true, 'clicking the toggle again');
  await waitFor(bodyHas('Đã tắt báo cáo lỗi'), 10_000, 'disabled notice to appear');
});

test('renderer: list shows both reports, open shows redacted message + stack', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountCrashReports('loaded')`), true, 'mounting CrashReportsSection loaded');
  await waitFor(bodyHas('Error: boom at <home>/app.js'), 10_000, 'first report to list');
  assert.equal(await evalJs(bodyHas('TypeError: x is not a function')), true, 'second report listed too');
  assert.equal(await evalJs(clickTestId('crash-report-open-r1')), true, 'clicking open on r1');
  await waitFor(`!!document.querySelector('[data-testid="crash-report-detail"]')`, 10_000, 'detail to open');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="crash-report-stack"]')?.textContent.includes('<home>/app.js')`),
    true,
    'stack shows the redacted home path, not a real one',
  );
  assert.equal(await evalJs(bodyHas('chưa (chỉ lưu local)')), true, 'sent: no (local only) is shown');
});

test('renderer: delete one (two-step) then delete-all leaves the empty state', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountCrashReports('loaded')`), true, 'mounting CrashReportsSection loaded');
  await waitFor(bodyHas('Error: boom at <home>/app.js'), 10_000, 'list to load');
  assert.equal(await evalJs(clickTestId('crash-report-delete-r2')), true, 'clicking delete on r2');
  await waitFor(`!!document.querySelector('[data-testid="crash-report-delete-confirm-r2"]')`, 10_000, 'delete confirm to appear');
  assert.equal(await evalJs(clickTestId('crash-report-delete-confirm-r2')), true, 'confirming the delete');
  await waitFor(bodyHas('Đã xoá report.'), 10_000, 'deleted notice to appear');
  assert.equal(await evalJs(bodyHas('TypeError: x is not a function')), false, 'deleted report leaves the list');
  assert.equal(await evalJs(bodyHas('Error: boom at <home>/app.js')), true, 'the other report stays listed');
  assert.equal(await evalJs(clickTestId('crash-reports-delete-all')), true, 'clicking delete-all');
  await waitFor(`!!document.querySelector('[data-testid="crash-reports-delete-all-confirm"]')`, 10_000, 'delete-all confirm to appear');
  assert.equal(await evalJs(clickTestId('crash-reports-delete-all-confirm')), true, 'confirming delete-all');
  await waitFor(bodyHas('Đã xoá 1 báo cáo.'), 10_000, 'delete-all notice to appear');
  await waitFor(`!!document.querySelector('[data-testid="crash-reports-empty"]')`, 10_000, 'empty message to appear');
});

test('renderer: empty list shows the empty message and does not crash', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountCrashReports('empty')`), true, 'mounting CrashReportsSection empty');
  await waitFor(`!!document.querySelector('[data-testid="crash-reports-empty"]')`, 10_000, 'empty message to appear');
  assert.equal(await evalJs(bodyHas('Chưa có crash report nào.')), true, 'empty message text');
  assert.equal(await evalJs(`document.querySelectorAll('[data-testid^="crash-report-item-"]').length`), 0, 'no report rows');
});

test('renderer: load failure shows the load error and does not crash', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountCrashReports('load-fails')`), true, 'mounting CrashReportsSection load-fails');
  // Like CanvasView, the section shows the raw IPC error message.
  await waitFor(bodyHas('list failed'), 10_000, 'load error to appear');
  assert.equal(await evalJs(`document.querySelectorAll('[data-testid^="crash-report-item-"]').length`), 0, 'no report rows on load failure');
});
