/**
 * Renderer test for v0.83b — AutomationsView Composio trigger form + row.
 *
 * Mounts the real AutomationsView in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/automations-composio-v083-harness.tsx) that records
 * every Composio IPC call in `window.__composioCalls`:
 *   create: pick trigger kind "composio" -> defs load -> pick
 *           GITHUB_ISSUE_CREATED -> paste secret -> create with a
 *           notify action -> the row shows the slug summary and
 *           "Secret webhook Composio: đã có." and the mock recorded
 *           the secret (never rendered back).
 *   row:    an existing composio automation without a secret shows
 *           "chưa có" + a paste field; saving the secret flips the
 *           status; "Tạo token URL" shows the token exactly once;
 *           "Gửi sự kiện thử" records one test delivery + one ok run.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/automations-composio-v083-renderer.test.mjs
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
const CDP_PORT = 9950 + (process.pid % 200);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-comp-v083-'));
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
    name: 'open-bot-v083-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>AutomationsView composio v0.83b harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'automations-composio-v083-harness.tsx')],
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
// React controlled inputs need the native setter + a bubbling event.
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
})()`;
const clickButtonByText = (text) => `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled);
  if (!b) return false;
  b.click();
  return true;
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

test('renderer: tạo automation Composio — chọn slug + dán secret, lưu xong hiện tóm tắt + secret đã có', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountAutomations('empty')`), true, 'mounting AutomationsView ok');
  await waitFor(bodyHas('Tạo automation'), 10_000, 'create button to render');
  assert.equal(await evalJs(setInput('#automation-name', 'Issue mới → báo')), true, 'typing the name');
  assert.equal(await evalJs(setInput('#automation-trigger', 'composio')), true, 'picking the composio trigger kind');
  await waitFor(bodyHas('GITHUB_ISSUE_CREATED'), 10_000, 'curated defs to load into the picker');
  // v0.84d: the form tells the user open-bot cannot create the trigger
  // itself, with the steps + a link to the Composio docs.
  assert.equal(await evalJs(bodyHas('không tự tạo trigger được')), true, 'setup hint explains open-bot cannot create the trigger');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="automation-composio-setup-hint"] a')?.getAttribute('href')`),
    'https://docs.composio.dev/docs/setting-up-triggers/creating-triggers',
    'setup hint links to the Composio creating-triggers docs',
  );
  assert.equal(await evalJs(setInput('#automation-composio-slug', 'GITHUB_ISSUE_CREATED')), true, 'picking the slug');
  assert.equal(await evalJs(setInput('#automation-composio-secret', 'whsec-form-123')), true, 'pasting the signing secret');
  assert.equal(await evalJs(setInput('#automation-message', 'Có issue mới')), true, 'typing the notify message');
  assert.equal(await evalJs(clickTestId('automation-create')), true, 'clicking create');
  await waitFor(bodyHas('Khi có trigger Composio · GITHUB_ISSUE_CREATED'), 10_000, 'slug summary to show');
  await waitFor(bodyHas('Secret webhook Composio: đã có.'), 10_000, 'secret status to show as set');
  // The secret must have reached the mock Vault (via IPC) and must NOT
  // be rendered back anywhere on the page.
  assert.equal(await evalJs(`Object.keys(window.__composioCalls.secrets).length`), 1, 'exactly one secret stored');
  assert.equal(await evalJs(bodyHas('whsec-form-123')), false, 'the pasted secret must never be rendered back');
  assert.equal(await evalJs(bodyHas('/v1/automations/')), true, 'route hint shows the Local API path');
});

test('renderer: automation Composio chưa có secret — dán secret ở dòng + tạo token + gửi sự kiện thử', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountAutomations('with-composio')`), true, 'mounting AutomationsView with-composio');
  await waitFor(bodyHas('Mail mới → báo'), 10_000, 'composio automation to load');
  assert.equal(await evalJs(bodyHas('Secret webhook Composio: chưa có')), true, 'secret missing is shown');
  assert.equal(
    await evalJs(`(() => {
      const el = document.querySelector('input[aria-label="Secret webhook Composio"]');
      if (!el) return false;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'whsec-row-456');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`),
    true,
    'pasting the secret on the row',
  );
  assert.equal(await evalJs(clickButtonByText('Lưu secret')), true, 'clicking save secret');
  await waitFor(bodyHas('Secret webhook Composio: đã có.'), 10_000, 'secret status flips to set');
  assert.equal(await evalJs(`window.__composioCalls.secrets['comp-1']`), 'whsec-row-456', 'row secret stored under the automation id');
  assert.equal(await evalJs(clickButtonByText('Tạo token URL')), true, 'clicking create URL token');
  await waitFor(bodyHas('tok-test-123'), 10_000, 'token shown exactly once');
  assert.equal(await evalJs(bodyHas('chỉ hiện đúng một lần')), true, 'shown-once warning present');
  assert.equal(await evalJs(clickButtonByText('Gửi sự kiện thử')), true, 'clicking send test event');
  await waitFor(`window.__composioCalls.tests.length === 1`, 10_000, 'test event delivered once');
  await waitFor(bodyHas('Lịch sử chạy gần đây'), 10_000, 'run history appears after the test event');
});
