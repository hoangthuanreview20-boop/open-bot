/**
 * Renderer test for v0.77 — bot short description (UI parity §3.3).
 *
 * Mounts the real Sidebar + BotForm in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/bot-description-v077-harness.tsx):
 *   sidebar: bot A (has a description) shows it under its name;
 *            bot B (no description) shows no description element.
 *   form-create: the description field exists; typing a description
 *            + saving submits it in the saved config.
 *   form-edit: the field is prefilled with the bot's description.
 *   form-template: picking the template prefills the description
 *            from the template.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/bot-description-v077-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-bot-desc-v077-'));
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
    const ok = await evalJs(`typeof window.__mountSidebar === 'function' && typeof window.__mountBotForm === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose mount functions within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v077-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>BotDescription v0.77 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'bot-description-v077-harness.tsx')],
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
// React needs the native setter + input event to pick up a typed value.
const setInputValue = (selector, value) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: sidebar shows the bot description under its name, none when unset', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountSidebar()`), true, 'mounting Sidebar');
  await waitFor(bodyHas('Bot A'), 10_000, 'bot list to load');
  const descs = await evalJs(`[...document.querySelectorAll('[data-testid="bot-description"]')].map((el) => el.textContent)`);
  assert.deepEqual(descs, ['Trợ lý viết code, am hiểu TypeScript']);
});

test('renderer: BotForm create — description field saves into the submitted config', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountBotForm('create')`), true, 'mounting BotForm (create)');
  await waitFor(bodyHas('Tạo bot mới'), 10_000, 'create form to load');
  assert.equal(await evalJs(`!!document.querySelector('#bot-description')`), true, 'description field exists');
  assert.equal(await evalJs(setInputValue('#bot-name', 'Bot Mới')), true, 'typing name');
  assert.equal(await evalJs(setInputValue('#bot-description', 'Bot thử nghiệm')), true, 'typing description');
  assert.equal(await evalJs(clickButton('Lưu')), true, 'clicking save');
  const saved = await waitFor(`window.__savedBot && window.__savedBot.description === 'Bot thử nghiệm' ? window.__savedBot : null`, 10_000, 'saved config to carry the description');
  assert.equal(saved.name, 'Bot Mới');
  assert.equal(saved.description, 'Bot thử nghiệm');
});

test('renderer: BotForm edit — description prefilled; template prefills it', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountBotForm('edit')`), true, 'mounting BotForm (edit)');
  await waitFor(bodyHas('Sửa bot'), 10_000, 'edit form to load');
  assert.equal(
    await evalJs(`document.querySelector('#bot-description')?.value`),
    'Trợ lý viết code, am hiểu TypeScript',
    'description prefilled from the bot',
  );

  assert.equal(await evalJs(`window.__mountBotForm('create')`), true, 'mounting BotForm (create, template)');
  await waitFor(bodyHas('Tạo bot mới'), 10_000, 'create form to load');
  await waitFor(`!!document.querySelector('#bot-template')`, 10_000, 'template select to load');
  assert.equal(
    await evalJs(`(() => { const s = document.querySelector('#bot-template'); if (!s) return false; Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'tpl-code'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    true,
    'picking the template',
  );
  await waitFor(
    `document.querySelector('#bot-description')?.value === 'Mẫu bot viết code'`,
    10_000,
    'description prefilled from the template',
  );
});
