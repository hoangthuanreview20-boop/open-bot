/**
 * Renderer test for v0.69c — Settings loading / empty / error states
 * for the four sections v0.68c missed (engines, spend limits, Dream,
 * NO_STORAGE), with fake `SettingsShared` state in a REAL Electron
 * renderer (Chromium) under xvfb.
 *
 * Reuses the v0.68c harness fixture
 * (tests/fixtures/settings-loading-v068c-harness.tsx, extended with
 * v0.69c scenarios) — same mounting convention as
 * tests/settings-loading-v068c-renderer.test.mjs:
 *
 *   bot-model:   engines loading / error + retry -> loaded, empty
 *                (the old bug: error + the generic loading line
 *                together, no retry)
 *   general:     limits loading / error + retry -> loaded
 *   advanced:    dream loading / error + retry -> loaded
 *   security:    NO_STORAGE loading / error + retry -> loaded
 *
 * Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/settings-loading-v069c-renderer.test.mjs
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
const CDP_PORT = 10150 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-settings-loading-v069c-'));
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
    const ok = await evalJs(`typeof window.__mountSettingsTab === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountSettingsTab within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v069c-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>Settings loading v0.69c harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'settings-loading-v068c-harness.tsx')],
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

async function mountTab(tab, scenario) {
  assert.equal(await evalJs(`window.__mountSettingsTab(${JSON.stringify(tab)}, ${JSON.stringify(scenario)})`), true, `mounting ${tab}/${scenario}`);
}

const hasTestId = (id) => `!!document.querySelector('[data-testid=${JSON.stringify(id)}]')`;
const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
const clickTestId = (id) => `(() => { const b = document.querySelector('[data-testid=${JSON.stringify(id)}]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
const reloadCalls = () => evalJs(`window.__reloadCalls()`);

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: engines loading / error + retry -> loaded, empty (no stuck loading line)', { skip: !hasDisplay }, async () => {
  // Loading: the engines loading line shows, no empty line.
  await mountTab('bot-model', 'engines-loading');
  await waitFor(hasTestId('engines-loading'), 10_000, 'engines loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa phát hiện CLI nào.')), false, 'no engines empty line while loading');

  // Error + retry: the error shows WITHOUT the generic loading line
  // (the v0.68c-era bug: engines stayed null, so the "still loading"
  // line never went away). Click retry, the engine appears.
  await mountTab('bot-model', 'engines-error');
  await waitFor(hasTestId('engines-retry'), 10_000, 'engines retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách engines.')), true, 'engines load error text');
  assert.equal(await evalJs(bodyHas('Đang tải cài đặt…')), false, 'generic loading line must be gone once the load failed');
  assert.equal(await evalJs(clickTestId('engines-retry')), true, 'clicking engines retry');
  await waitFor(bodyHas('Claude Code'), 10_000, 'engine to appear after retry');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách engines.')), false, 'error text gone after a successful retry');
  assert.equal(await evalJs(hasTestId('engines-retry')), false, 'retry button gone after a successful retry');
  assert.ok((await reloadCalls()).includes('reloadEngines'), 'retry called reloadEngines');

  // Empty: a finished load with no engines shows the empty line.
  await mountTab('bot-model', 'engines-empty');
  await waitFor(bodyHas('Chưa phát hiện CLI nào.'), 10_000, 'engines empty line to appear');
  assert.equal(await evalJs(hasTestId('engines-loading')), false, 'no loading line once the load finished');
});

test('renderer: limits loading / error + retry -> loaded', { skip: !hasDisplay }, async () => {
  // Loading: the limits loading line shows above the inputs.
  await mountTab('general', 'limits-loading');
  await waitFor(hasTestId('limits-loading'), 10_000, 'limits loading line to appear');

  // Error + retry: click retry, the loaded limits fill the inputs.
  await mountTab('general', 'limits-error');
  await waitFor(hasTestId('limits-retry'), 10_000, 'limits retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được giới hạn chi tiêu.')), true, 'limits load error text');
  assert.equal(await evalJs(clickTestId('limits-retry')), true, 'clicking limits retry');
  await waitFor(`document.getElementById('limit-daily')?.value === '5'`, 10_000, 'daily limit input to hold the loaded value after retry');
  assert.equal(await evalJs(`document.getElementById('limit-monthly')?.value === '10'`), true, 'monthly limit input holds the loaded value');
  assert.equal(await evalJs(bodyHas('Không tải được giới hạn chi tiêu.')), false, 'error text gone after a successful retry');
  assert.ok((await reloadCalls()).includes('reloadLimits'), 'retry called reloadLimits');
});

test('renderer: dream loading / error + retry -> loaded', { skip: !hasDisplay }, async () => {
  // Loading: the dream loading line shows, no error.
  await mountTab('advanced', 'dream-loading');
  await waitFor(hasTestId('dream-loading'), 10_000, 'dream loading line to appear');

  // Error + retry: click retry, the loaded Dream toggle turns on.
  await mountTab('advanced', 'dream-error');
  await waitFor(hasTestId('dream-retry'), 10_000, 'dream retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được cài đặt Dream.')), true, 'dream load error text');
  assert.equal(await evalJs(clickTestId('dream-retry')), true, 'clicking dream retry');
  await waitFor(`document.querySelector('section[data-section="dream"] input[type="checkbox"]').checked === true`, 10_000, 'dream toggle to turn on after retry');
  assert.equal(await evalJs(`document.getElementById('dream-idle')?.value === '30'`), true, 'dream idle input holds the loaded value');
  assert.equal(await evalJs(bodyHas('Không tải được cài đặt Dream.')), false, 'error text gone after a successful retry');
  assert.ok((await reloadCalls()).includes('reloadDream'), 'retry called reloadDream');
});

test('renderer: NO_STORAGE loading / error + retry -> loaded', { skip: !hasDisplay }, async () => {
  // Loading: the NO_STORAGE loading line shows inside the vault section.
  await mountTab('security', 'nostorage-loading');
  await waitFor(hasTestId('nostorage-loading'), 10_000, 'NO_STORAGE loading line to appear');

  // Error + retry: click retry, the loaded NO_STORAGE toggle turns on.
  await mountTab('security', 'nostorage-error');
  await waitFor(hasTestId('nostorage-retry'), 10_000, 'NO_STORAGE retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được chế độ không lưu trữ.')), true, 'NO_STORAGE load error text');
  assert.equal(await evalJs(clickTestId('nostorage-retry')), true, 'clicking NO_STORAGE retry');
  await waitFor(`document.querySelector('section[data-section="vault"] input[type="checkbox"]').checked === true`, 10_000, 'NO_STORAGE toggle to turn on after retry');
  assert.equal(await evalJs(bodyHas('Không tải được chế độ không lưu trữ.')), false, 'error text gone after a successful retry');
  assert.ok((await reloadCalls()).includes('reloadNoStorage'), 'retry called reloadNoStorage');
});
