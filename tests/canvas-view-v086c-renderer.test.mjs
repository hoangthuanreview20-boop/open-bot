/**
 * Renderer test for v0.86c — CanvasView: list a bot's canvases, open
 * one to view its blocks (markdown render, code as text, html in a
 * sandboxed iframe that never runs scripts), delete with confirm,
 * and the empty state.
 *
 * Mounts the real CanvasView in a REAL Electron renderer (Chromium)
 * under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/canvas-view-v086c-harness.tsx):
 *   loaded:     2 canvases; open c1 shows the markdown heading +
 *               the code block; open c2 shows the sandboxed html
 *               iframe (the <script> inside must NOT run — the
 *               test fails on any uncaught renderer exception);
 *               copy shows "Đã sao chép."; delete removes c2.
 *   empty:      no canvases -> the empty message, no crash.
 *   load-fails: listCanvases rejects -> the load error, no crash.
 *
 * Fails on any uncaught renderer exception.
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/canvas-view-v086c-renderer.test.mjs
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
import { createCdpHarness } from './cdp-wait.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const CDP_PORT = 9800 + (process.pid % 200);

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-canvas-view-v086c-'));
const bundlePath = path.join(tmpDir, 'bundle.js');

let child = null;
let ws = null;
const pageExceptions = [];

// v0.94b: shared CDP harness (tests/cdp-wait.mjs) — 5s evaluate
// attempts retried until the step deadline, EVAL_BUSY sentinel (a
// timeout is never a pass), plus ensureFocus() for the clipboard step.
// The closure reads the CURRENT ws, so reconnects keep working.
const cdp = createCdpHarness((text) => ws.send(text));
const { evalJs, evalJsStrict, waitFor } = cdp;

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
      cdp.handleMessage(m);
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
  cdp.send('Runtime.enable');
  // v0.94b: mount poll via the shared waitFor — short 5s attempts
  // retried until the unchanged 30s deadline (the old single 15s
  // evaluate could abort the whole wait, same bug as tts-voice v0.93c).
  await waitFor(`typeof window.__mountCanvas === 'function'`, 30_000, 'harness to expose __mountCanvas');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v086c-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>CanvasView v0.86c harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  // esbuild resolves './markdown' (imported by Markdown.tsx) to
  // Markdown.tsx itself on case-insensitive lookup (.tsx wins over
  // .ts), while the real Vite build resolves it to markdown.ts.
  // Pin the import to the lowercase module for the harness bundle.
  const markdownAlias = {
    name: 'canvas-v086c-markdown-lowercase',
    setup(b) {
      b.onResolve({ filter: /^\.\/markdown$/ }, (args) => {
        if (args.importer.endsWith('Markdown.tsx')) {
          return {
            path: path.join(
              REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'markdown.ts',
            ),
          };
        }
        return undefined;
      });
    },
  };
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'canvas-view-v086c-harness.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    outfile: bundlePath,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
    plugins: [markdownAlias],
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
  cdp.clearPending();
  if (!child) return;
  const proc = child;
  child = null;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
}

const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
const clickTestId = (testId) => `(() => { const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]'); if (!el || el.disabled) return false; el.click(); return true; })()`;

/**
 * v0.94b — the copy notice has two outcomes, and the test must tell
 * them apart: 'ok' (clipboard.writeText succeeded, "Đã sao chép."),
 * 'error' (it rejected — the app shows "Không sao chép được."), or
 * 'timeout' (no notice at all). The old waitFor for the success text
 * alone could not distinguish "focus lost" from "app slow", so a
 * focus failure read as a 10s timeout. Polls with the shared evalJs,
 * so a slow evaluate is a retry, not a failure.
 */
async function waitForCopyNotice(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Non-strict on purpose: a slow evaluate here is "retry", and the
    // loop's own 10s deadline is the failure condition.
    const notice = await evalJs(`(() => { const b = document.body.textContent; if (b.includes('Đã sao chép')) return 'ok'; if (b.includes('Không sao chép được')) return 'error'; return ''; })()`);
    if (notice === 'ok' || notice === 'error') return notice;
    await sleep(300);
  }
  return 'timeout';
}

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: list shows both canvases, opening c1 renders markdown + code', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJsStrict(`window.__mountCanvas('loaded')`), true, 'mounting CanvasView loaded');
  await waitFor(bodyHas('Ghi chú tuần'), 10_000, 'canvas list to load');
  assert.equal(await evalJsStrict(bodyHas('Trang HTML')), true, 'second canvas listed too');
  assert.equal(await evalJsStrict(clickTestId('canvas-open-c1')), true, 'clicking open on c1');
  await waitFor(`!!document.querySelector('[data-testid="canvas-content"]')`, 10_000, 'canvas content to open');
  await waitFor(bodyHas('Kế hoạch'), 10_000, 'markdown block to render');
  assert.equal(await evalJsStrict(bodyHas('console.log(1);')), true, 'code block shown as text');
  assert.equal(
    await evalJsStrict(`document.querySelector('[data-testid="canvas-code-block"]')?.textContent.includes('console.log(1);')`),
    true,
    'code block is a <pre>, not executed markup',
  );
});

test('renderer: opening c2 shows the html in a sandboxed iframe (script never runs)', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJsStrict(`window.__mountCanvas('loaded')`), true, 'mounting CanvasView loaded');
  await waitFor(bodyHas('Trang HTML'), 10_000, 'canvas list to load');
  assert.equal(await evalJsStrict(clickTestId('canvas-open-c2')), true, 'clicking open on c2');
  await waitFor(`!!document.querySelector('[data-testid="canvas-html-preview"]')`, 10_000, 'html preview iframe to appear');
  const sandbox = await evalJsStrict(`document.querySelector('[data-testid="canvas-html-preview"]').getAttribute('sandbox')`);
  assert.equal(sandbox, '', 'iframe sandbox is empty (no scripts, no same-origin)');
  const srcDoc = await evalJsStrict(`document.querySelector('[data-testid="canvas-html-preview"]').getAttribute('srcdoc')`);
  assert.ok(srcDoc.includes('<h1>Xin chào</h1>'), 'iframe carries the canvas html');
  // Give the srcDoc a moment to parse: the <script> inside would run
  // synchronously while parsing if the sandbox let it, and its only
  // job is to set a flag on the parent window.
  await sleep(1500);
  assert.equal(
    await evalJsStrict(`window.__canvasPwned`),
    undefined,
    'the <script> inside the canvas html never ran',
  );
  // The frame itself must be opaque-origin — contentDocument is null
  // for a cross-origin frame (or access throws SecurityError) — or,
  // if the embedder can still read it, it must show the rendered h1.
  // Either way the sandbox held and the script had no effect.
  const probe = await evalJsStrict(`(() => {
    try {
      const d = document.querySelector('[data-testid="canvas-html-preview"]').contentDocument;
      if (!d) return 'null';
      return 'readable:' + (d.body ? d.body.textContent.slice(0, 30) : 'no-body');
    } catch (e) { return 'threw:' + e.name; }
  })()`);
  assert.ok(
    probe === 'null' || probe.startsWith('threw:SecurityError') || probe.includes('Xin chào'),
    `sandboxed iframe is opaque or renders the html (got: ${probe})`,
  );
});

test('renderer: copy shows the copied notice and delete removes the canvas', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJsStrict(`window.__mountCanvas('loaded')`), true, 'mounting CanvasView loaded');
  await waitFor(bodyHas('Ghi chú tuần'), 10_000, 'canvas list to load');
  assert.equal(await evalJsStrict(clickTestId('canvas-open-c1')), true, 'clicking open on c1');
  await waitFor(`!!document.querySelector('[data-testid="canvas-content"]')`, 10_000, 'canvas content to open');
  // v0.94b — root cause of the cluster flake (measured, not guessed):
  // `navigator.clipboard.writeText` rejects when the document has no
  // X focus, and the app then shows "Không sao chép được." instead of
  // "Đã sao chép.". Focus probe (FOCUS_STEAL, other Electron windows
  // stealing X focus): focused → "Đã sao chép." in 4–218ms; unfocused
  // → "Không sao chép được." in 8–81ms (clipboard-write permission
  // stayed `granted` — pure focus, not permission). The copy itself is
  // fast, so no deadline fixes this: take focus first
  // (Page.bringToFront — `window.focus()` does NOT restore X focus
  // under xvfb, measured), then click. One bounded retry covers the
  // race where another window takes focus between bringToFront and the
  // click; the assertion still requires the success notice.
  let copied = false;
  for (let attempt = 1; attempt <= 2 && !copied; attempt++) {
    assert.ok(
      await cdp.ensureFocus(),
      `harness window could not take X focus for the clipboard copy (attempt ${attempt})`,
    );
    assert.equal(await evalJsStrict(clickTestId('canvas-copy')), true, 'clicking copy content');
    const notice = await waitForCopyNotice(10_000);
    if (notice === 'ok') { copied = true; break; }
    assert.notEqual(
      notice, 'timeout',
      'no copy notice appeared within 10s after clicking copy (neither success nor error)',
    );
    // notice === 'error': focus was lost between bringToFront and the
    // click — retry once with a fresh focus handshake.
  }
  assert.ok(copied, 'copy showed the copy-error notice twice even after refocusing — clipboard.writeText needs X focus');
  // Back to the list, delete c2 (two-step confirm).
  assert.equal(await evalJsStrict(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Đóng'); if (!b) return false; b.click(); return true; })()`), true, 'closing the canvas');
  assert.equal(await evalJsStrict(clickTestId('canvas-delete-c2')), true, 'clicking delete on c2');
  await waitFor(`!!document.querySelector('[data-testid="canvas-delete-confirm-c2"]')`, 10_000, 'delete confirm to appear');
  assert.equal(await evalJsStrict(clickTestId('canvas-delete-confirm-c2')), true, 'confirming the delete');
  await waitFor(bodyHas('Đã xoá canvas.'), 10_000, 'deleted notice to appear');
  assert.equal(await evalJsStrict(bodyHas('Trang HTML')), false, 'deleted canvas leaves the list');
  assert.equal(await evalJsStrict(bodyHas('Ghi chú tuần')), true, 'the other canvas stays listed');
});

test('renderer: empty list shows the empty message and does not crash', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJsStrict(`window.__mountCanvas('empty')`), true, 'mounting CanvasView empty');
  await waitFor(`!!document.querySelector('[data-testid="canvas-empty"]')`, 10_000, 'empty message to appear');
  assert.equal(await evalJsStrict(bodyHas('chưa có canvas nào')), true, 'empty message text');
  assert.equal(await evalJsStrict(`document.querySelectorAll('[data-testid^="canvas-item-"]').length`), 0, 'no canvas rows');
});

test('renderer: failed list shows the load error and does not crash', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJsStrict(`window.__mountCanvas('load-fails')`), true, 'mounting CanvasView load-fails');
  // The view shows the failure's message (same pattern as SkillsView:
  // e.message when present, i18n loadError otherwise).
  await waitFor(bodyHas('list failed'), 10_000, 'load error to appear');
  assert.equal(await evalJsStrict(`document.querySelectorAll('[data-testid^="canvas-item-"]').length`), 0, 'no canvas rows on load failure');
});
