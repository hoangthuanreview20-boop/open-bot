/**
 * Renderer test for v0.95 (Team D2) — MediaKeysSection: Settings →
 * Media keys (provider list, save/clear flows, load error).
 *
 * Mounts the real MediaKeysSection in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/media-keys-v095d2-harness.tsx):
 *   loaded:     7 providers; openai configured (suffix 4444), the
 *               other 6 missing; saving a typed fake key for gemini
 *               shows its suffix and clears the input; clearing the
 *               openai key flips it back to missing. The full fake
 *               key never appears in the page text.
 *   load-fails: getMediaKeyStatus rejects -> the load error, no crash.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/media-keys-v095d2-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-media-keys-v095d2-'));
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
    const ok = await evalJs(`typeof window.__mountMediaKeys === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountMediaKeys within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v095d2-media-keys-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>MediaKeysSection v0.95d2 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'media-keys-v095d2-harness.tsx')],
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
// Type into a React controlled input (direct .value assignment alone
// does not fire React's onChange — use the native setter + input event).
const typeInto = (testId, value) => `(() => {
  const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value === ${JSON.stringify(value)};
})()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: 7 providers render, configured shows suffix only, missing shows the hint', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountMediaKeys('loaded')`), true, 'mounting MediaKeysSection loaded');
  await waitFor(bodyHas('Khóa media'), 10_000, 'section title to load');
  await waitFor(`!!document.querySelector('[data-testid="media-key-status-openai"]')`, 10_000, 'provider rows to load');
  for (const name of ['OpenAI', 'Gemini', 'Stability AI', 'Replicate', 'Runway', 'Luma', 'Pika']) {
    assert.equal(await evalJs(bodyHas(name)), true, `${name} must be listed`);
  }
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="media-key-status-openai"]').textContent`),
    'Đã lưu khóa (…4444)',
    'openai shows the saved suffix, not the full key',
  );
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="media-key-status-gemini"]').textContent`),
    'Chưa có khóa — chưa tạo được ảnh/video bằng provider này.',
    'gemini shows the missing state',
  );
  assert.equal(await evalJs(bodyHas('sk-fake')), false, 'no full fake key may appear in the page');
  assert.equal(await evalJs(bodyHas('4444')), true, 'the suffix is visible');
});

test('renderer: save a typed key shows its suffix and clears the input', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountMediaKeys('loaded')`), true, 'mounting MediaKeysSection loaded');
  await waitFor(bodyHas('Khóa media'), 10_000, 'section title to load');
  await waitFor(`!!document.querySelector('[data-testid="media-key-input-gemini"]')`, 10_000, 'provider rows to load');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="media-key-save-gemini"]').disabled`),
    true,
    'save is disabled with an empty input',
  );
  assert.equal(await evalJs(typeInto('media-key-input-gemini', 'AIzaFake-test-7777')), true, 'typing the fake key');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="media-key-save-gemini"]').disabled`),
    false,
    'save is enabled once typed',
  );
  assert.equal(await evalJs(clickTestId('media-key-save-gemini')), true, 'clicking save on gemini');
  await waitFor(
    `document.querySelector('[data-testid="media-key-status-gemini"]').textContent.includes('7777')`,
    10_000,
    'gemini status to show the new suffix',
  );
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="media-key-input-gemini"]').value`),
    '',
    'the input is cleared after a successful save',
  );
  assert.equal(await evalJs(bodyHas('AIzaFake-test-7777')), false, 'the full typed key never appears');
});

test('renderer: clear removes the configured key and flips it back to missing', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountMediaKeys('loaded')`), true, 'mounting MediaKeysSection loaded');
  await waitFor(bodyHas('Khóa media'), 10_000, 'section title to load');
  await waitFor(`!!document.querySelector('[data-testid="media-key-clear-openai"]')`, 10_000, 'provider rows to load');
  assert.equal(await evalJs(clickTestId('media-key-clear-openai')), true, 'clicking clear on openai');
  await waitFor(
    `document.querySelector('[data-testid="media-key-status-openai"]').textContent.includes('Chưa có khóa')`,
    10_000,
    'openai status to flip back to missing',
  );
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="media-key-clear-openai"]')`),
    false,
    'the clear button disappears once the key is gone',
  );
});

test('renderer: load failure shows the load error and does not crash', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountMediaKeys('load-fails')`), true, 'mounting MediaKeysSection load-fails');
  // The section shows the generic load error (not the raw IPC message).
  await waitFor(bodyHas('Không tải được khóa media.'), 10_000, 'load error to appear');
  assert.equal(
    await evalJs(`document.querySelectorAll('[data-testid^="media-key-input-"]').length`),
    0,
    'no provider inputs on load failure',
  );
});
