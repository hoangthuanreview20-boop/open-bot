/**
 * Renderer test for v0.90b (team G) — model picker completion:
 * per-bot source toggles + Re-detect button inside the picker.
 *
 * Mounts the real ModelPicker + BotForm in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` that applies
 * the same per-bot rail filter the main process applies (see
 * tests/fixtures/model-picker-v090b-harness.tsx):
 *   picker current-disabled: the running model's source (xai) is
 *     disabled for the bot — the picker shows a clear warning plus a
 *     suggested replacement (Ollama); clicking it picks Ollama, the
 *     picker never switches by itself.
 *   picker current-disabled-plus: a second disabled source (OpenAI)
 *     is hidden from the picker entirely.
 *   picker re-detect: the Re-detect button calls redetectEngines and
 *     reloads the rail (call counts prove the rescan really happens).
 *   form-edit: the per-bot Sources checklist shows xai unchecked and
 *     Ollama checked; unchecking Ollama and saving submits
 *     disabledProviders ['xai', 'ollama'].
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/model-picker-v090b-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-picker-v090b-'));
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
    const ok = await evalJs(`typeof window.__mountModelPicker === 'function' && typeof window.__mountBotForm === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose mount functions within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v090b-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>ModelPicker v0.90b harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'model-picker-v090b-harness.tsx')],
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

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: picker warns when the running source is disabled for the bot; suggestion switches, nothing auto-switches', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountModelPicker('current-disabled')`), true, 'mounting ModelPicker');
  await waitFor(bodyHas('Nguồn của model đang chạy đã bị tắt cho bot này'), 10_000, 'disabled-source warning to show');
  // The picker never switched by itself: no selection happened yet.
  assert.equal(await evalJs(`window.__picked`), null, 'no silent model switch');
  // The disabled current source stays visible (dimmed, with its reason)…
  assert.equal(await evalJs(bodyHas('Đã tắt cho bot này')), true, 'bot-disabled reason shown on the current row');
  // …while enabled sources stay pickable, and the suggestion names one.
  // The suggestion is the first usable source in rail order (here the
  // Claude Code CLI, first of the subscription group).
  assert.equal(await evalJs(`!!document.querySelector('[data-testid="model-picker-switch-suggestion"]')`), true, 'suggestion button exists');
  assert.equal(await evalJs(clickButton('Chuyển sang Claude Code (CLI) (claude-code)')), true, 'clicking the suggestion');
  const picked = await waitFor(`window.__picked && window.__picked.providerId === 'claude-code' ? window.__picked : null`, 10_000, 'suggestion to select Claude Code');
  assert.equal(picked.model, 'claude-code');

  // A second disabled source is hidden from this bot's picker entirely.
  assert.equal(await evalJs(`window.__mountModelPicker('current-disabled-plus')`), true, 'mounting ModelPicker (plus mode)');
  await waitFor(bodyHas('Nguồn của model đang chạy đã bị tắt cho bot này'), 10_000, 'warning to show in plus mode');
  assert.equal(await evalJs(`document.body.textContent.includes('OpenAI')`), false, 'disabled non-current source hidden');
  assert.equal(await evalJs(bodyHas('Ollama')), true, 'enabled source still shown');
});

test('renderer: picker Re-detect button rescans and reloads the rail', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountModelPicker('all-enabled')`), true, 'mounting ModelPicker');
  await waitFor(bodyHas('Ollama'), 10_000, 'rail to load');
  const before = await evalJs(`window.__railCalls`);
  assert.ok(before >= 1, 'rail loaded at least once');
  assert.equal(await evalJs(clickButton('Quét lại')), true, 'clicking Re-detect');
  const after = await waitFor(`window.__redetectCalls === 1 && window.__railCalls > ${before} ? window.__railCalls : null`, 10_000, 'redetect to run and rail to reload');
  assert.ok(after > before, `rail reloaded after rescan (${before} -> ${after})`);
});

test('renderer: BotForm per-bot Sources checklist toggles and saves disabledProviders', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountBotForm()`), true, 'mounting BotForm (edit)');
  await waitFor(bodyHas('Sửa bot'), 10_000, 'edit form to load');
  await waitFor(`!!document.querySelector('[data-testid="bot-source-xai"]')`, 10_000, 'sources checklist to load');
  // The bot's running source (xai) starts disabled; Ollama starts enabled.
  assert.equal(await evalJs(`document.querySelector('[data-testid="bot-source-xai"]').checked`), false, 'xai unchecked (disabled for this bot)');
  assert.equal(await evalJs(`document.querySelector('[data-testid="bot-source-ollama"]').checked`), true, 'ollama checked (enabled for this bot)');
  // The form's picker also warns about the disabled running source.
  assert.equal(await evalJs(bodyHas('Nguồn của model đang chạy đã bị tắt cho bot này')), true, 'warning inside the form picker');
  // Disable Ollama too, then save. (HTMLElement.click() returns
  // undefined, so the expression reports success explicitly.)
  assert.equal(await evalJs(`(() => { const el = document.querySelector('[data-testid="bot-source-ollama"]'); if (!el) return false; el.click(); return true; })()`), true, 'unchecking Ollama');
  await waitFor(`document.querySelector('[data-testid="bot-source-ollama"]').checked === false`, 10_000, 'ollama unchecked');
  assert.equal(await evalJs(clickButton('Lưu')), true, 'clicking save');
  const saved = await waitFor(
    `window.__savedBot && window.__savedBot.disabledProviders && window.__savedBot.disabledProviders.includes('ollama') ? window.__savedBot : null`,
    10_000,
    'saved config to carry the toggled sources',
  );
  assert.deepEqual([...saved.disabledProviders].sort(), ['ollama', 'xai']);
  assert.equal(saved.providerId, 'xai', 'the running model is NOT auto-switched on save');
});
