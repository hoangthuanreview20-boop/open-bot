/**
 * Renderer test for v0.90c (team G, package C) — ComputersView live
 * refresh + scheduler queue UI + guest health display.
 *
 * Mounts the real ComputersView in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/computers-v090c-harness.tsx):
 *   poll: `computers:list` is called on mount and then every 5s
 *     while the screen is open (call counts prove the polling
 *     really happens — no fake timers).
 *   queue: the waiting bot shows with its reason; changing its
 *     priority to 80 and clicking Apply really calls
 *     `computers:set-priority` with { botId, priority: 80 }.
 *   auto-shed: the opt-in checkbox starts unchecked; checking it
 *     calls `computers:set-auto-shed` with { enabled: true }.
 *   guest: the VM row shows guest status 'unknown' + 'not
 *     connected'; clicking Check calls `computers:guest-health`
 *     and the row then shows healthy + version 0.90c.
 *   paused reason: the paused box computer shows its pause reason.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/computers-v090c-renderer.test.mjs
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
const CDP_PORT = 9900 + (process.pid % 200);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-computers-v090c-'));
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
    const ok = await evalJs(`typeof window.__mountComputersView === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose mount function within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v090c-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>ComputersView v0.90c harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'computers-v090c-harness.tsx')],
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
const clickButton = (text) => `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: ComputersView polls computers:list every 5s while open; queue + pause reason shown', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountComputersView()`), true, 'mounting ComputersView');
  await waitFor(bodyHas('Bot One'), 10_000, 'box computer row to show');
  await waitFor(bodyHas('Hàng đợi'), 10_000, 'queue section to show');
  assert.equal(await evalJs(bodyHas('Trạng thái tự cập nhật mỗi 5 giây')), true, 'live note shown');
  // Queue: waiting bot + its reason.
  assert.equal(await evalJs(bodyHas('Bot Three')), true, 'queued bot shown');
  assert.equal(await evalJs(bodyHas('hết chỗ lúc tạo')), true, 'queue reason shown');
  // Paused box computer shows its pause reason.
  assert.equal(await evalJs(bodyHas('Lý do tạm dừng')), true, 'pause reason label shown');
  assert.equal(await evalJs(bodyHas('Tự giảm tải: máy host đang bận')), true, 'pause reason detail shown');
  // Auto-shed opt-in starts unchecked (off by default).
  assert.equal(await evalJs(`(() => { const c = document.querySelector('input[type="checkbox"]'); return c ? !c.checked : null; })()`), true, 'auto-shed starts unchecked');
  // Polling: list is called on mount, then again after ~5s and ~10s.
  const firstCalls = await evalJs(`window.__listCalls`);
  assert.ok(firstCalls >= 1, `list called at least once on mount (got ${firstCalls})`);
  await waitFor(`window.__listCalls >= ${firstCalls + 2}`, 15_000, 'list to be polled at least twice more');
});

test('renderer: ComputersView queue priority + auto-shed toggle call the real IPC', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountComputersView()`), true, 'mounting ComputersView');
  await waitFor(bodyHas('Hàng đợi'), 10_000, 'queue section to show');
  // v0.98 merge-fix: wait for the priority input itself, not just the
  // queue heading — under full-suite load the section header renders
  // before the queue rows (and their inputs) mount, so setting the
  // value immediately can find no input at all (1 red in the v0.98
  // merge run; green in isolation).
  await waitFor(`!!document.querySelector('input[type="number"]')`, 10_000, 'priority input to mount');
  // Change the queued priority to 80 (native setter so React sees it).
  assert.equal(await evalJs(`(() => { const input = document.querySelector('input[type="number"]'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '80'); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value === '80'; })()`), true, 'setting priority input to 80');
  assert.equal(await evalJs(clickButton('Áp dụng')), true, 'clicking Apply');
  await waitFor(`window.__priorityCalls && window.__priorityCalls.length >= 1`, 10_000, 'set-priority to be called');
  assert.deepEqual(await evalJs(`window.__priorityCalls[0]`), { botId: 'bot-3', priority: 80 }, 'set-priority payload');
  // Auto-shed toggle: checking the box calls set-auto-shed { enabled: true }.
  assert.equal(await evalJs(`(() => { const c = document.querySelector('input[type="checkbox"]'); if (!c) return false; c.click(); return true; })()`), true, 'clicking auto-shed checkbox');
  await waitFor(`window.__autoShedCalls && window.__autoShedCalls.length >= 1`, 10_000, 'set-auto-shed to be called');
  assert.deepEqual(await evalJs(`window.__autoShedCalls[0]`), { enabled: true }, 'set-auto-shed payload');
  assert.equal(await evalJs(`(() => { const c = document.querySelector('input[type="checkbox"]'); return c ? c.checked : null; })()`), true, 'checkbox checked after enabling');
});

test('renderer: ComputersView guest health — unknown first, Check shows healthy + version', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountComputersView()`), true, 'mounting ComputersView');
  await waitFor(bodyHas('Bot Two'), 10_000, 'VM computer row to show');
  assert.equal(await evalJs(bodyHas('Guest agent')), true, 'guest label shown on VM row');
  assert.equal(await evalJs(bodyHas('chưa rõ')), true, 'guest status unknown first');
  assert.equal(await evalJs(bodyHas('chưa kết nối')), true, 'guest not-connected shown');
  assert.equal(await evalJs(clickButton('Kiểm tra')), true, 'clicking guest Check');
  await waitFor(`window.__guestHealthCalls && window.__guestHealthCalls.length >= 1`, 10_000, 'guest-health to be called');
  assert.deepEqual(await evalJs(`window.__guestHealthCalls[0]`), 'bot-2', 'guest-health called for the VM bot');
  await waitFor(bodyHas('đang chạy tốt'), 10_000, 'guest healthy label to show');
  assert.equal(await evalJs(bodyHas('bản 0.90c')), true, 'guest version shown');
});
