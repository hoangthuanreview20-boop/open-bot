/**
 * Renderer smoke for v0.96 (Team T6) — DashboardView + PlanView mount
 * in a REAL Electron renderer (Chromium) under xvfb (see
 * tests/fixtures/ui-planning-v096-harness.tsx).
 *
 * - Dashboard: the mocked IPC sources aggregate into the cards
 *   (2 runs today, 3 tool calls, 1 error, 300 tokens, 12 memory
 *   blocks, 2 Composio apps, 3 automations) and the top-tools list
 *   names read_file; clicking a bot row opens that bot.
 * - PlanView: the create form (title + one step per line) creates a
 *   plan; dispatch assigns the first step to the chosen bot; the
 *   step can be completed and the progress line updates.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/ui-planning-v096-renderer.test.mjs
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
const CDP_PORT = 9690 + (process.pid % 150);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-ui-planning-v096-'));
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
    const ok = await evalJs(`typeof window.__mountDashboard === 'function' && typeof window.__mountPlan === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountDashboard/__mountPlan within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v096-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>UI planning v0.96 harness</title>
<link rel="stylesheet" href="./styles.css">
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  fs.copyFileSync(
    path.join(REPO, 'apps/desktop/src/renderer/styles.css'),
    path.join(tmpDir, 'styles.css'),
  );
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'ui-planning-v096-harness.tsx')],
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
// Set a React controlled input/textarea value (the native setter +
// input event, so React picks the change up).
const setInputValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`;
const setSelectValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
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

test('renderer: dashboard aggregates the mocked sources into cards', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountDashboard()`), true, 'mounting DashboardView');
  await waitFor(bodyHas('Tổng quan'), 10_000, 'dashboard to mount');
  await waitFor(
    `document.querySelectorAll('[data-testid="dashboard-card"]').length === 9`,
    15_000,
    'dashboard cards to load',
  );
  // 9 cards: bots, runs, tokens, tool calls, errors, memory, router, Composio, automations.
  assert.equal(
    await evalJs(`document.querySelectorAll('[data-testid="dashboard-card"]').length`),
    9,
    'dashboard shows 9 cards',
  );
  const cards = await evalJs(
    `[...document.querySelectorAll('[data-testid="dashboard-card"]')].map((c) => c.textContent).join('|')`,
  );
  // 2 bots, 2 runs today, 3 tool calls, 1 error, 300 tokens, 12 memory blocks, 2 Composio, 3 automations.
  for (const [label, value] of [
    ['Bot', '2'],
    ['Lượt chạy hôm nay', '2'],
    ['Lượt gọi tool hôm nay', '3'],
    ['Lỗi hôm nay', '1'],
    ['Token ước tính hôm nay', '300'],
    ['Khối memory', '12'],
    ['App Composio đã kết nối', '2'],
    ['Automation', '3'],
  ]) {
    assert.ok(cards.includes(label), `card ${label} present`);
    assert.ok(cards.includes(value), `card ${label} shows ${value}`);
  }
  assert.ok(await evalJs(bodyHas('read_file')), 'top tools list names read_file');
  assert.ok(await evalJs(bodyHas('Bot A')), 'per-bot table lists Bot A');
});

test('renderer: dashboard bot row opens that bot', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountDashboard()`), true, 'mounting DashboardView');
  await waitFor(bodyHas('Bot B'), 10_000, 'dashboard to mount');
  await waitFor(
    `document.querySelectorAll('[data-testid="dashboard-card"]').length === 9`,
    15_000,
    'dashboard cards to load',
  );
  assert.equal(
    await evalJs(`(() => { const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Bot B'); if (btns.length === 0) return false; btns[0].click(); return true; })()`),
    true,
    'clicking the Bot B row button',
  );
  assert.equal(await evalJs(`window.__lastOpened`), 'bot-b', 'dashboard opens Bot B');
});

test('renderer: seeded stuck plan shows the stuck banner on mount', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountSeededPlan()`), true, 'mounting PlanView with a stuck plan');
  await waitFor(bodyHas('Seeded plan'), 10_000, 'seeded plan to mount');
  await waitFor(bodyHas('Agent có vẻ đang bị kẹt'), 10_000, 'stuck banner to appear');
  assert.ok(
    await evalJs(`document.querySelector('[data-testid="plan-stuck-banner"]') !== null`),
    'stuck banner element present',
  );
  assert.ok(await evalJs(bodyHas('Thử tool khác')), 'banner suggests trying another tool');
});

test('renderer: plan create form -> dispatch -> complete updates progress', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountPlan()`), true, 'mounting PlanView');
  await waitFor(bodyHas('Tạo kế hoạch mới'), 10_000, 'plan view to mount');
  assert.equal(await evalJs(setInputValue('[data-testid="plan-new-title"]', 'Launch v1')), 'ok', 'typing the plan title');
  assert.equal(await evalJs(setInputValue('[data-testid="plan-new-steps"]', 'Research\nBuild\nShip')), 'ok', 'typing the steps');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-testid="plan-create"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'clicking create',
  );
  await waitFor(bodyHas('Launch v1'), 10_000, 'plan row to appear');
  assert.ok(await evalJs(bodyHas('Research')), 'first step renders');
  assert.ok(await evalJs(bodyHas('0/3')), 'progress starts at 0/3');
  // Dispatch the first step to Bot A.
  assert.equal(await evalJs(setSelectValue('[data-testid="plan-dispatch-bot"]', 'bot-a')), 'ok', 'choosing Bot A');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-testid="plan-dispatch"]'); if (!b || b.disabled) return false; b.click(); return true; })()`),
    true,
    'clicking dispatch',
  );
  await waitFor(bodyHas('đang chạy'), 10_000, 'dispatched step runs');
  // Complete it: the first step's "Hoàn thành" button.
  assert.equal(
    await evalJs(`(() => { const b = [...document.querySelectorAll('[data-testid="plan-step"] button')].find((x) => x.textContent.trim() === 'Hoàn thành'); if (!b) return false; b.click(); return true; })()`),
    true,
    'clicking complete on the running step',
  );
  await waitFor(bodyHas('1/3'), 10_000, 'progress moves to 1/3');
  assert.ok(await evalJs(bodyHas('xong')), 'completed step shows the done status');
});
