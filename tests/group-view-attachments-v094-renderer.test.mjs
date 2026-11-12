/**
 * Renderer test for v0.94c — GroupView attachments (group chat nhận ảnh).
 *
 * Mounts the real GroupView in a REAL Electron renderer (Chromium)
 * under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/group-view-v073-harness.tsx, scenario
 * `with-attachments`):
 *   thumbnail:  message có ảnh → thumbnail img hiện với data URL đúng
 *               bytes (tải lười qua `group:get-attachment`).
 *   image-only: chọn 1 file ảnh (DataTransfer) → chip hiện → bấm Gửi
 *               khi không có text → postGroupMessage nhận đúng bytes
 *               ảnh (base64) + text rỗng.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/group-view-attachments-v094-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-group-view-v094-'));
const bundlePath = path.join(tmpDir, 'bundle.js');

let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const pageExceptions = [];

// PNG 1x1 trong suốt (base64) — cùng bytes với harness.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';

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
    const ok = await evalJs(`typeof window.__mountGroup === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountGroup within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v094-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>GroupView v0.94 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'group-view-v073-harness.tsx')],
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

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: message có ảnh hiện thumbnail đúng bytes', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountGroup('with-attachments')`), true, 'mounting GroupView with-attachments');
  await waitFor(bodyHas('Nhóm 1'), 10_000, 'group list to load');
  await waitFor(bodyHas('xem ảnh này'), 10_000, 'message with attachment to load');
  const src = await waitFor(
    `(() => { const img = document.querySelector('[data-testid="group-thumb-att-1"]'); return img ? img.getAttribute('src') : null; })()`,
    10_000,
    'thumbnail img to appear',
  );
  assert.ok(src.startsWith('data:image/png;base64,'), 'thumbnail is a data URL');
  assert.ok(src.endsWith(PNG_1X1), 'thumbnail carries the exact stored bytes');
  assert.ok((await evalJs(`window.__attachCalls ?? 0`)) >= 1, 'bytes fetched through getGroupAttachment');
});

test('renderer: chọn ảnh rồi Gửi khi không có text → gửi đúng bytes ảnh', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountGroup('with-attachments')`), true, 'mounting GroupView with-attachments');
  await waitFor(bodyHas('Nhóm 1'), 10_000, 'group list to load');
  // Đặt 1 file PNG vào input file (DataTransfer) rồi dispatch change.
  const setFile = await evalJs(`(() => {
    const input = document.querySelector('[data-testid="group-attach-input"]');
    if (!input) return 'no-input';
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_1X1)}), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'anh-test.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  assert.equal(setFile, 'ok', 'setting the file on the attach input');
  await waitFor(bodyHas('anh-test.png'), 10_000, 'attach chip to appear');
  // Nút Gửi phải bật khi chỉ có ảnh (không text).
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-testid="group-send-button"]'); return b ? !b.disabled : false; })()`),
    true,
    'send button enabled with image-only message',
  );
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-testid="group-send-button"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'clicking Send',
  );
  const posted = await waitFor(`window.__lastGroupPost ?? null`, 10_000, 'postGroupMessage to be called');
  assert.equal(posted.text, '', 'image-only message sends empty text');
  assert.equal(posted.attachments?.length, 1, 'one attachment sent');
  assert.equal(posted.attachments[0].mimeType, 'image/png');
  assert.equal(posted.attachments[0].data, PNG_1X1, 'sent bytes match the picked file');
  assert.equal(posted.attachments[0].name, 'anh-test.png');
});
