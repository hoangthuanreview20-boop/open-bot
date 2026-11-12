/**
 * Renderer test for v0.74d — AutomationsView "Nạp dữ liệu mẫu" button.
 *
 * Mounts the real AutomationsView in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/automations-seed-v074-harness.tsx):
 *   ok:             click "Nạp dữ liệu mẫu" -> the 4 sample
 *                   automations appear in the list + "Đã nạp 4
 *                   automation mẫu (0 đã có sẵn)."
 *   already-seeded: store already holds the 4 samples -> click
 *                   shows "Dữ liệu mẫu đã có đủ (4 automation)."
 *                   and the list still holds exactly 4.
 *   seed-fails:     seedSampleAutomations rejects -> the IPC error
 *                   ("seed boom") shows, the list stays empty.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/automations-seed-samples-v074-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-seed-v074-'));
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
    const ok = await evalJs(`typeof window.__mountAutomations === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountAutomations within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v074-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>AutomationsView seed v0.74d harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'automations-seed-v074-harness.tsx')],
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
const clickTestId = (testId) => `(() => { const b = document.querySelector('[data-testid="${testId}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
const countSampleNames = `['Morning brief (auto)', 'Weekly report (auto)', 'Notes changed — update index', 'Agent finished — notify'].filter((n) => document.body.textContent.includes(n)).length`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: bấm "Nạp dữ liệu mẫu" thì 4 sample xuất hiện + báo đã nạp 4', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountAutomations('ok')`), true, 'mounting AutomationsView ok');
  await waitFor(bodyHas('Nạp dữ liệu mẫu'), 10_000, 'seed button to render');
  assert.equal(await evalJs(bodyHas('Morning brief (auto)')), false, 'no samples before seeding');
  assert.equal(await evalJs(clickTestId('automations-seed-samples')), true, 'clicking seed button');
  await waitFor(bodyHas('Đã nạp 4 automation mẫu (0 đã có sẵn).'), 10_000, 'seed success message to show');
  assert.equal(await evalJs(countSampleNames), 4, 'all 4 sample automations must be listed');
});

test('renderer: seed khi đã đủ mẫu thì báo đã có đủ, danh sách vẫn đúng 4', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountAutomations('already-seeded')`), true, 'mounting AutomationsView already-seeded');
  await waitFor(bodyHas('Morning brief (auto)'), 10_000, 'seeded list to load');
  assert.equal(await evalJs(countSampleNames), 4, '4 samples listed before re-seeding');
  assert.equal(await evalJs(clickTestId('automations-seed-samples')), true, 'clicking seed button again');
  await waitFor(bodyHas('Dữ liệu mẫu đã có đủ (4 automation).'), 10_000, 'already-seeded message to show');
  assert.equal(await evalJs(countSampleNames), 4, 're-seeding must not duplicate samples');
});

test('renderer: seed lỗi thì hiện lỗi IPC, danh sách vẫn trống', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountAutomations('seed-fails')`), true, 'mounting AutomationsView seed-fails');
  await waitFor(bodyHas('Nạp dữ liệu mẫu'), 10_000, 'seed button to render');
  assert.equal(await evalJs(clickTestId('automations-seed-samples')), true, 'clicking seed button');
  await waitFor(bodyHas('seed boom'), 10_000, 'seed IPC error to show');
  assert.equal(await evalJs(bodyHas('Đã nạp')), false, 'must NOT show a success message on seed failure');
  assert.equal(await evalJs(countSampleNames), 0, 'no samples listed after failed seed');
});
