/**
 * Renderer test for v0.83a — TTS stop button + browser `speechSynthesis`
 * fallback in ChatView.
 *
 * Mounts the real ChatView in a REAL Electron renderer (Chromium)
 * under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/tts-v083-harness.tsx):
 *   slow:         TTS available, speakText never resolves on its own;
 *                 clicking the speaker button shows "⏹ Dừng", clicking
 *                 it again calls stopTts and the button goes back to
 *                 "🔊 Nghe" with no notice.
 *   browser:      no system engine, but the browser has voices (fake
 *                 speechSynthesis): the voice/rate picker appears with
 *                 the browser voices + the "giọng trình duyệt" hint;
 *                 clicking the speaker button speaks through the fake
 *                 and the stop button cancels it.
 *   browser-late: no voices yet — the picker stays hidden until
 *                 `voiceschanged` fires, then it appears.
 *   none:         no system engine and no browser voices: no picker,
 *                 clicking the speaker button shows the honest
 *                 no-engine notice.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/tts-stop-v083-renderer.test.mjs
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tts-v083-'));
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
    const ok = await evalJs(`typeof window.__mountTtsV083 === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountTtsV083 within 30s');
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
<title>ChatView v0.83 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'tts-v083-harness.tsx')],
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

test('renderer: stop button kills a long utterance and resets the button', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTtsV083('slow')`), true, 'mounting ChatView slow');
  await waitFor(`!!document.querySelector('[data-testid="speak-m2"]')`, 10_000, 'speaker button to appear');
  // Wait for the voice select: it only appears once getTtsStatus
  // resolved with available=true — clicking earlier would take the
  // not-yet-known no-engine path instead of speakText.
  await waitFor(`!!document.querySelector('[data-testid="tts-voice"]')`, 10_000, 'voice select to appear (engine known)');
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(`window.__speakCalls.length === 1`, 10_000, 'speakText to be called');
  // While it speaks, the same button is Stop (not disabled).
  await waitFor(bodyHas('⏹ Dừng'), 10_000, 'stop button to appear while speaking');
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="speak-m2"]').disabled`),
    false,
    'stop button is clickable while speaking',
  );
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(`window.__stopCalls.length === 1`, 10_000, 'stopTts to be called');
  await waitFor(bodyHas('🔊 Nghe'), 10_000, 'button back to Listen after stop');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="tts-notice"]')`),
    false,
    'no failure notice after a clean stop',
  );
});

test('renderer: browser fallback speaks with browser voices and stops via cancel', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTtsV083('browser')`), true, 'mounting ChatView browser');
  await waitFor(`!!document.querySelector('[data-testid="tts-voice"]')`, 10_000, 'voice select to appear (browser voices)');
  assert.equal(
    await evalJs(`[...document.querySelector('#tts-voice').options].map((o) => o.value).join(',')`),
    ',Google Tiếng Việt,Google US English',
    'voice options are the browser voices (+ default)',
  );
  await waitFor(`!!document.querySelector('[data-testid="tts-browser-source"]')`, 10_000, 'browser-source hint to appear');
  assert.equal(
    await evalJs(`document.body.textContent.includes('Giọng trình duyệt')`),
    true,
    'the source is named honestly (browser voice, not system engine)',
  );
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(`window.__browserCalls.length === 1`, 10_000, 'browser speak to be called');
  assert.equal(
    await evalJs(`window.__browserCalls[0].text`),
    'Xin chào, đây là câu trả lời.',
    'browser speak got the answer text',
  );
  assert.equal(
    await evalJs(`window.__speakCalls.length`),
    0,
    'main speakText is never called on the fallback path',
  );
  await waitFor(bodyHas('⏹ Dừng'), 10_000, 'stop button to appear while the browser speaks');
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(`window.__browserCancels.length === 1`, 10_000, 'speechSynthesis.cancel to be called');
  await waitFor(bodyHas('🔊 Nghe'), 10_000, 'button back to Listen after browser stop');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="tts-notice"]')`),
    false,
    'no failure notice after a clean browser stop (cancelled -> stopped, not an error)',
  );
  // v0.84c: speak again after the stop — the stop must not poison
  // the state (seq / speaking id / source ref): a fresh utterance
  // starts, can be stopped again, and still shows no notice.
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(`window.__browserCalls.length === 2`, 10_000, 'browser speak to be called again after stop');
  await waitFor(bodyHas('⏹ Dừng'), 10_000, 'stop button to appear again while the browser speaks');
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(`window.__browserCancels.length === 2`, 10_000, 'speechSynthesis.cancel to be called again');
  await waitFor(bodyHas('🔊 Nghe'), 10_000, 'button back to Listen after the second browser stop');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="tts-notice"]')`),
    false,
    'still no failure notice after the second browser stop',
  );
});

test('renderer: voices arriving late (voiceschanged) reveal the picker', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTtsV083('browser-late')`), true, 'mounting ChatView browser-late');
  await waitFor(`!!document.querySelector('[data-testid="speak-m2"]')`, 10_000, 'speaker button to appear');
  await sleep(1500);
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="tts-voice"]')`),
    false,
    'no voice select while the browser has no voices yet',
  );
  assert.equal(await evalJs(`window.__fireBrowserVoices()`), true, 'firing voiceschanged');
  await waitFor(`!!document.querySelector('[data-testid="tts-voice"]')`, 10_000, 'voice select to appear after voiceschanged');
});

test('renderer: no engine and no browser voices shows the honest notice, no picker', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountTtsV083('none')`), true, 'mounting ChatView none');
  await waitFor(`!!document.querySelector('[data-testid="speak-m2"]')`, 10_000, 'speaker button to appear');
  await sleep(1500);
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="tts-voice"]')`),
    false,
    'no voice select when neither engine nor browser voices exist',
  );
  await evalJs(`document.querySelector('[data-testid="speak-m2"]').click()`);
  await waitFor(bodyHas('Máy này chưa có engine đọc giọng nói'), 10_000, 'no-engine notice to appear');
});
