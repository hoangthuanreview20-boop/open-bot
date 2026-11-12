/**
 * Renderer test for v0.70 (milestone 1) — TemplatePluginModal loading
 * / error + retry states, with a mocked `window.openBot` in a REAL
 * Electron renderer (Chromium) under xvfb.
 *
 * Uses tests/fixtures/template-plugin-modal-v070-harness.tsx, which
 * mounts the real `TemplatePluginModal`:
 *
 *   loading: the list call never settles — the loading line shows,
 *            no empty line, no retry button.
 *   error:   the first call rejects, later calls answer with one
 *            template — the error shows WITH a retry button and
 *            WITHOUT the loading line; clicking retry loads the
 *            template and clears the error (the old bug: the error
 *            showed with no way to retry except closing and
 *            reopening the modal).
 *   loaded:  one template renders in the select, no loading line.
 *   empty:   a finished load with no templates shows the empty line,
 *            no loading line, no retry button.
 *
 * Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/template-plugin-modal-v070.test.mjs
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
const CDP_PORT = 10160 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-template-modal-v070-'));
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
    const ok = await evalJs(`typeof window.__mountTemplateModal === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountTemplateModal within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v070-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>Template plugin modal v0.70 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'template-plugin-modal-v070-harness.tsx')],
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

async function mountModal(scenario) {
  assert.equal(await evalJs(`window.__mountTemplateModal(${JSON.stringify(scenario)})`), true, `mounting ${scenario}`);
}

const hasTestId = (id) => `!!document.querySelector('[data-testid=${JSON.stringify(id)}]')`;
const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
const clickTestId = (id) => `(() => { const b = document.querySelector('[data-testid=${JSON.stringify(id)}]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
const loadCalls = () => evalJs(`window.__templateLoadCalls()`);

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: templates loading line while the first load is in flight', { skip: !hasDisplay }, async () => {
  await mountModal('loading');
  await waitFor(hasTestId('templates-loading'), 10_000, 'templates loading line to appear');
  assert.equal(await evalJs(bodyHas('Đang tải danh sách plugin…')), true, 'loading line text');
  assert.equal(await evalJs(bodyHas('Chưa có mẫu plugin nào.')), false, 'no empty line while loading');
  assert.equal(await evalJs(hasTestId('templates-retry')), false, 'no retry button while loading');
  assert.equal(await loadCalls(), 1, 'exactly one list call while loading');
});

test('renderer: templates error + retry -> loaded, error cleared', { skip: !hasDisplay }, async () => {
  await mountModal('error');
  await waitFor(hasTestId('templates-retry'), 10_000, 'templates retry button to appear');
  assert.equal(await evalJs(bodyHas('ipc-boom')), true, 'load error text');
  assert.equal(await evalJs(hasTestId('templates-loading')), false, 'loading line gone once the load failed');
  assert.equal(await evalJs(bodyHas('Chưa có mẫu plugin nào.')), false, 'no empty line on load error');
  assert.equal(await evalJs(clickTestId('templates-retry')), true, 'clicking templates retry');
  await waitFor(bodyHas('Quick Notes'), 10_000, 'template to appear after retry');
  assert.equal(await evalJs(bodyHas('ipc-boom')), false, 'error text gone after a successful retry');
  assert.equal(await evalJs(hasTestId('templates-retry')), false, 'retry button gone after a successful retry');
  assert.equal(await evalJs(hasTestId('templates-loading')), false, 'no loading line after a successful retry');
  assert.ok((await loadCalls()) >= 2, 'retry re-ran the list call');
});

test('renderer: templates loaded, no loading line or retry', { skip: !hasDisplay }, async () => {
  await mountModal('loaded');
  await waitFor(bodyHas('Quick Notes'), 10_000, 'template to appear');
  assert.equal(await evalJs(hasTestId('templates-loading')), false, 'no loading line once loaded');
  assert.equal(await evalJs(hasTestId('templates-retry')), false, 'no retry button once loaded');
});

test('renderer: templates empty, no loading line or retry', { skip: !hasDisplay }, async () => {
  await mountModal('empty');
  await waitFor(bodyHas('Chưa có mẫu plugin nào.'), 10_000, 'empty line to appear');
  assert.equal(await evalJs(hasTestId('templates-loading')), false, 'no loading line once the load finished');
  assert.equal(await evalJs(hasTestId('templates-retry')), false, 'no retry button on an empty list');
});
