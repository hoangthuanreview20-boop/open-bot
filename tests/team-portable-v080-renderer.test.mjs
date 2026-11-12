/**
 * Renderer test for v0.80 — TeamView portable team bundle (export/import).
 *
 * Mounts the real TeamView in a REAL Electron renderer (Chromium)
 * under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/team-portable-v080-harness.tsx):
 *   export:          exportTeam resolves with a fake path; clicking
 *                    the export button shows the saved-path notice.
 *   import-conflict: importTeam resolves with one bot conflict; the
 *                    conflict modal appears and choosing "only what's
 *                    new" calls importTeamApply with overwrite=false
 *                    and shows the imported notice.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/team-portable-v080-renderer.test.mjs
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
const CDP_PORT = 9660 + (process.pid % 150);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-team-portable-v080-'));
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
    const ok = await evalJs(`typeof window.__mountTeamPortable === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountTeamPortable within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v080-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>TeamView v0.80 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'team-portable-v080-harness.tsx')],
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

test('renderer: export button shows the saved-path notice', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTeamPortable('export')`), true, 'mounting TeamView export');
  await waitFor(bodyHas('Xuất / nhập team'), 10_000, 'portable section to load');
  await evalJs(`document.querySelector('[data-testid="team-export"]').click()`);
  await waitFor(bodyHas('Đã xuất team ra /tmp/open-bot-team-team-1.json'), 10_000, 'export notice to appear');
});

test('renderer: export with an oversize skill names it with its size (v0.82)', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTeamPortable('export-skipped')`), true, 'mounting TeamView export-skipped');
  await waitFor(bodyHas('Xuất / nhập team'), 10_000, 'portable section to load');
  await evalJs(`document.querySelector('[data-testid="team-export"]').click()`);
  await waitFor(bodyHas('big-skill'), 10_000, 'skipped skill name to appear in the notice');
  assert.equal(await evalJs(bodyHas('312450')), true, 'skipped skill size is reported');
  assert.equal(await evalJs(bodyHas('200000')), true, 'the 200k cap is reported');
});

test('renderer: import with a conflict shows the modal and "only new" applies without overwrite', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTeamPortable('import-conflict')`), true, 'mounting TeamView import-conflict');
  await waitFor(bodyHas('Xuất / nhập team'), 10_000, 'portable section to load');
  await evalJs(`document.querySelector('[data-testid="team-import"]').click()`);
  await waitFor(bodyHas('Đã có dữ liệu trùng'), 10_000, 'conflict modal to appear');
  assert.equal(await evalJs(bodyHas('Bot bot-a đã có')), true, 'conflict list names the existing bot');
  await evalJs(`document.querySelector('[data-testid="team-import-keep"]').click()`);
  // The one bot already exists, so keep-existing adds 0 bots (it is
  // skipped) but still imports the automation and the skill.
  await waitFor(bodyHas('Đã nhập: 0 bot, 1 automation, 1 skill.'), 10_000, 'import-done notice to appear');
  assert.equal(await evalJs(bodyHas('Bỏ qua 1 mục đã có.')), true, 'skipped count is reported');
  assert.equal(await evalJs(`window.__applied.length`), 1, 'importTeamApply called once');
  assert.equal(await evalJs(`window.__applied[0].overwrite`), false, 'keep-existing applies with overwrite=false');
});
