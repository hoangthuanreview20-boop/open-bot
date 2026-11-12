/**
 * Renderer test for v0.82 — TTS voice/rate selection in ChatView.
 *
 * Mounts the real ChatView in a REAL Electron renderer (Chromium)
 * under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/tts-v082-harness.tsx):
 *   ok:        TTS available + 3 voices; the voice/rate selects
 *              appear, picking vi-vn-x-south + 1.25x and clicking
 *              the speaker button calls speakText with the answer
 *              text AND { voice, rate }.
 *   no-engine: getTtsStatus reports unavailable; the voice/rate
 *              controls stay hidden entirely.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/tts-voice-v082-renderer.test.mjs
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
const CDP_PORT = 9630 + (process.pid % 150);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tts-v082-'));
const bundlePath = path.join(tmpDir, 'bundle.js');

let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const pageExceptions = [];

function evalJs(expression, timeoutMs = JS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP evaluate timed out after ${timeoutMs}ms: ${expression.slice(0, 120)}`));
    }, timeoutMs);
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
  // v0.93c — root cause of the "CDP evaluate timed out after 15000ms"
  // flake (full-suite v0.86-verify4: both tests died in test.before):
  // the mount poll sent ONE evaluate with a 15s timeout and let that
  // timeout abort the whole wait, even though the mount deadline is
  // 30s. Under full-suite load the renderer main thread can be busy
  // parsing/executing the harness bundle, so a single evaluate can sit
  // unanswered for seconds while the app is healthy — measured mount
  // evaluates took up to ~2s at load 8–12, and the 15s timer fires on
  // a starved renderer, not a dead one. A slow evaluate is therefore
  // "not ready yet", never a failure: short attempts (5s, >2.5x the
  // worst measured) retried until the real 30s mount deadline. The
  // deadline itself does not move, and no assertion is weakened.
  const mountDeadline = Date.now() + 30_000;
  let slowEvals = 0;
  while (Date.now() < mountDeadline) {
    let ok = false;
    try {
      ok = await evalJs(`typeof window.__mountTtsV082 === 'function'`, 5000);
    } catch {
      slowEvals++;
    }
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`harness did not expose __mountTtsV082 within 30s (slow-evaluate attempts: ${slowEvals})`);
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v082-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>ChatView v0.82 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'tts-v082-harness.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    outfile: bundlePath,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
    // esbuild resolves Markdown.tsx's `./markdown` import to the
    // component file (case-insensitive match) instead of the parser
    // `markdown.ts` — Vite's real build resolves it correctly, so
    // only this test bundle needs the explicit redirect. The same
    // goes for ChatView's `?url` worklet import: Vite emits it as a
    // file asset (a URL string), while esbuild would bundle and
    // execute the worklet in the renderer, where
    // `AudioWorkletProcessor` does not exist.
    plugins: [{
      name: 'markdown-case',
      setup(build) {
        build.onResolve({ filter: /^\.\/markdown$/ }, (args) => {
          if (args.importer.endsWith('Markdown.tsx')) {
            return { path: path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'markdown.ts') };
          }
          return undefined;
        });
        build.onResolve({ filter: /\?url$/ }, () => ({ path: 'worklet-url-stub', namespace: 'tts-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'tts-stub' }, () => ({
          contents: 'module.exports = "worklet-stub.js";',
          loader: 'js',
        }));
      },
    }],
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

test('renderer: voice/rate selects appear and speak passes the chosen voice+rate', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTtsV082('ok')`), true, 'mounting ChatView ok');
  await waitFor(`!!document.querySelector('[data-testid="tts-voice"]')`, 10_000, 'voice select to appear');
  await waitFor(`!!document.querySelector('[data-testid="tts-rate"]')`, 10_000, 'rate select to appear');
  // The voice list must carry the mocked voices (real <option>s).
  assert.equal(
    await evalJs(`[...document.querySelector('#tts-voice').options].map((o) => o.value).join(',')`),
    ',vi,vi-vn-x-south,en',
    'voice options are the mocked voice list (+ default)',
  );
  // Pick a voice + rate through React's native value setter so the
  // controlled onChange fires.
  await evalJs(`(() => {
    const set = (id, value) => {
      const el = document.querySelector(id);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('#tts-voice', 'vi-vn-x-south');
    set('#tts-rate', '1.25');
    return true;
  })()`);
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(`window.__speakCalls.length === 1`, 10_000, 'speakText to be called');
  assert.equal(await evalJs(`window.__speakCalls[0].text`), 'Xin chào, đây là câu trả lời.', 'speakText got the answer text');
  assert.deepEqual(
    await evalJs(`window.__speakCalls[0].opts`),
    { voice: 'vi-vn-x-south', rate: 1.25 },
    'speakText got the chosen voice + rate',
  );
});

test('renderer: no engine hides the voice/rate controls', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTtsV082('no-engine')`), true, 'mounting ChatView no-engine');
  await waitFor(`!!document.querySelector('[data-testid="speak-m2"]')`, 10_000, 'speaker button to appear');
  await sleep(1500);
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="tts-voice"]')`),
    false,
    'no voice select when the machine has no TTS engine',
  );
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="tts-rate"]')`),
    false,
    'no rate select when the machine has no TTS engine',
  );
});
