/**
 * Renderer test for v0.77 — tasks toggle badge (UI parity §3.7) +
 * marketplace preview (UI parity §3.7).
 *
 * Mounts the real TasksToggleButton + AgentMarketplaceView in a REAL
 * Electron renderer (Chromium) under xvfb, with a mocked
 * `window.openBot` (see
 * tests/fixtures/tasks-badge-marketplace-preview-v077-harness.tsx):
 *   badge-2:   runningCount 2 -> the toggle shows a badge "2".
 *   badge-0:   runningCount 0 -> no badge element at all.
 *   preview-template: "Xem trước" on the template card opens a modal
 *     with the full system prompt; "Dùng mẫu" inside installs the bot.
 *   preview-published: "Xem trước" on the published card shows
 *     author/installs; "Đóng" closes the modal without installing.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/tasks-badge-marketplace-preview-v077-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-badge-preview-v077-'));
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
    const ok = await evalJs(`typeof window.__mountTasksToggle === 'function' && typeof window.__mountMarketplace === 'function'`);
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
<title>BadgePreview v0.77 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'tasks-badge-marketplace-preview-v077-harness.tsx')],
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
// Nth button with exactly this label (0-based) — the preview buttons
// share one label across template + published cards.
const clickNthButton = (text, n) => `(() => { const bs = [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (bs.length <= ${n}) return false; bs[${n}].click(); return true; })()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: tasks toggle shows a running badge with the count', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTasksToggle(2)`), true, 'mounting toggle with 2 running');
  await waitFor(bodyHas('Nhiệm vụ & routine'), 10_000, 'toggle to render');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="tasks-running-badge"]')?.textContent`),
    '2',
    'badge shows 2',
  );
  assert.equal(await evalJs(`window.__mountTasksToggle(0)`), true, 'mounting toggle with 0 running');
  await waitFor(bodyHas('Nhiệm vụ & routine'), 10_000, 'toggle to re-render');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="tasks-running-badge"]')`),
    null,
    'no badge when nothing runs',
  );
});

test('renderer: marketplace preview shows the template system prompt, install from preview works', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountMarketplace()`), true, 'mounting marketplace');
  await waitFor(bodyHas('Mẫu code'), 10_000, 'templates to load');
  assert.equal(await evalJs(clickNthButton('Xem trước', 0)), true, 'opening template preview');
  await waitFor(bodyHas('Bạn là trợ lý viết code.'), 10_000, 'system prompt in preview');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="marketplace-preview"]')`),
    true,
    'preview modal is open',
  );
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-testid="marketplace-preview-action"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'installing from preview',
  );
  const installed = await waitFor(`window.__installedBot`, 10_000, 'bot installed from preview');
  assert.equal(installed.name, 'Mẫu code');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="marketplace-preview"]')`),
    false,
    'preview closes after install',
  );
});

test('renderer: marketplace preview of a published entry shows author/installs, close installs nothing', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountMarketplace()`), true, 'mounting marketplace');
  await waitFor(bodyHas('Bot đã chia sẻ'), 10_000, 'published list to load');
  assert.equal(await evalJs(clickNthButton('Xem trước', 1)), true, 'opening published preview');
  await waitFor(bodyHas('Bạn là bot chia sẻ.'), 10_000, 'published system prompt in preview');
  assert.equal(await evalJs(bodyHas('alice')), true, 'author shown in preview');
  assert.equal(await evalJs(clickButton('Đóng')), true, 'closing preview');
  await waitFor(`!document.querySelector('[data-testid="marketplace-preview"]')`, 10_000, 'preview closed');
  assert.equal(await evalJs(`window.__installedBot`), null, 'nothing installed from a closed preview');
});
