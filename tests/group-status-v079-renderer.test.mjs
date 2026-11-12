/**
 * Renderer test for v0.79a — GroupView shows per-bot running status in
 * group chat (UI parity §7): a running bot gets a green dot + the
 * "đang trả lời…" typing line; when no bot runs, there is no typing
 * line and every member shows the idle dot.
 *
 * Mounts the real GroupView in a REAL Electron renderer (Chromium)
 * under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/group-status-v079-harness.tsx):
 *   running: getGroupBotStatus reports bot-a running.
 *   idle:    getGroupBotStatus reports nobody running.
 *   interrupted (v0.82): getGroupBotStatus reports bot-a interrupted
 *            (cut short when the app stopped) — the warning line shows
 *            and Dismiss removes it for good.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/group-status-v079-renderer.test.mjs
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
const CDP_PORT = 9750 + (process.pid % 150);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-group-status-v079-'));
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
    const ok = await evalJs(`typeof window.__mountGroupStatus === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountGroupStatus within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v079-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>GroupView v0.79a harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'group-status-v079-harness.tsx')],
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

test('renderer: running bot shows typing line + running chip, idle bot shows idle chip', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountGroupStatus('running')`), true, 'mounting GroupView running');
  await waitFor(bodyHas('Nhóm 1'), 10_000, 'group list to load');
  await waitFor(`!!document.querySelector('[data-testid="group-typing"]')`, 10_000, 'typing line to appear');
  assert.equal(await evalJs(bodyHas('Bot A đang trả lời…')), true, 'typing line names the running bot');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="group-member-running"][data-bot-id="bot-a"]')`),
    true,
    'Bot A member chip is running',
  );
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="group-member-idle"][data-bot-id="bot-b"]')`),
    true,
    'Bot B member chip stays idle',
  );
});

test('renderer: no running bot shows no typing line', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountGroupStatus('idle')`), true, 'mounting GroupView idle');
  await waitFor(bodyHas('Nhóm 1'), 10_000, 'group list to load');
  // Let at least one poll cycle run (2s) so a stale typing line would appear.
  await sleep(2500);
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="group-typing"]')`),
    false,
    'no typing line when nobody runs',
  );
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="group-member-idle"][data-bot-id="bot-a"]')`),
    true,
    'Bot A member chip is idle',
  );
});

test('renderer: interrupted bot shows the warning line (not typing) and Dismiss removes it', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountGroupStatus('interrupted')`), true, 'mounting GroupView interrupted');
  await waitFor(bodyHas('Nhóm 1'), 10_000, 'group list to load');
  await waitFor(`!!document.querySelector('[data-testid="group-interrupted-bot-a"]')`, 10_000, 'interrupted line to appear');
  assert.equal(await evalJs(bodyHas('Bot A đang trả lời dở thì app dừng')), true, 'warning names the interrupted bot');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="group-typing"]')`),
    false,
    'an interrupted bot is NOT shown as replying',
  );
  await evalJs(`document.querySelector('[data-testid="dismiss-interrupted-bot-a"]').click()`);
  await waitFor(`!document.querySelector('[data-testid="group-interrupted-bot-a"]')`, 10_000, 'interrupted line to disappear');
  assert.deepEqual(
    await evalJs(`window.__dismissCalls`),
    [{ groupId: 'g1', botId: 'bot-a' }],
    'dismiss called main once with the right ids',
  );
  // Let a poll cycle run: the dismissed entry must NOT come back.
  await sleep(2500);
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="group-interrupted-bot-a"]')`),
    false,
    'dismissed interruption stays gone after the next poll',
  );
});
