/**
 * Renderer test for v0.79c — collapsed sidebar is an icon rail (UI
 * parity §7, responsive): bot names are visible when expanded and
 * hidden (display:none) when collapsed, while the avatar stays a
 * working select button in collapsed mode.
 *
 * Mounts the real Sidebar in a REAL Electron renderer (Chromium)
 * under xvfb (see tests/fixtures/sidebar-collapse-v079-harness.tsx).
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/sidebar-collapse-v079-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-sidebar-collapse-v079-'));
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
    const ok = await evalJs(`typeof window.__mountSidebar === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountSidebar within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v079c-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>Sidebar v0.79c harness</title>
<link rel="stylesheet" href="./styles.css">
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  // The collapsed rail is pure CSS — the harness must load the real
  // stylesheet, otherwise getComputedStyle sees no `.collapsed` rules.
  fs.copyFileSync(
    path.join(REPO, 'apps/desktop/src/renderer/styles.css'),
    path.join(tmpDir, 'styles.css'),
  );
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'sidebar-collapse-v079-harness.tsx')],
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
// Visibility of a bot name: the `.name` span is display:none in the
// collapsed rail (CSS), visible when expanded.
const nameVisible = (botName) => `(() => { const els = [...document.querySelectorAll('.bot-item .name')].filter((e) => e.textContent.includes(${JSON.stringify(botName)})); if (els.length === 0) return 'missing'; return getComputedStyle(els[0]).display !== 'none' ? 'visible' : 'hidden'; })()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: expanded sidebar shows bot names; collapsed rail hides them', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountSidebar(false)`), true, 'mounting Sidebar expanded');
  await waitFor(bodyHas('Bot A'), 10_000, 'sidebar to mount');
  assert.equal(await evalJs(nameVisible('Bot A')), 'visible', 'Bot A name visible when expanded');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="sidebar"]').classList.contains('collapsed')`),
    false,
    'aside has no collapsed class when expanded',
  );

  assert.equal(await evalJs(`window.__mountSidebar(true)`), true, 'mounting Sidebar collapsed');
  await waitFor(bodyHas('Bot A'), 10_000, 'collapsed sidebar to mount');
  assert.equal(await evalJs(nameVisible('Bot A')), 'hidden', 'Bot A name hidden when collapsed');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="sidebar"]').classList.contains('collapsed')`),
    true,
    'aside has collapsed class when collapsed',
  );
  // The sidebar is 64px wide in the collapsed rail.
  const width = await evalJs(`document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width`);
  assert.equal(width, 64, 'collapsed sidebar is a 64px rail');
});

test('renderer: avatar button still selects the bot while collapsed', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountSidebar(true)`), true, 'mounting Sidebar collapsed');
  await waitFor(bodyHas('Bot A'), 10_000, 'collapsed sidebar to mount');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('button.bot-avatar[data-bot-id="bot-b"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'clicking the collapsed avatar button',
  );
  assert.equal(await evalJs(`window.__selectedBot`), 'bot-b', 'avatar click selects Bot B');
});
