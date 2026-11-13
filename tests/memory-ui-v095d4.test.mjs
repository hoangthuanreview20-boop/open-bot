/**
 * UI tests for v0.95d4 — profile + long-term memory.
 *
 * Part A (no display needed): i18n parity — every profile.* and memory.*
 * key exists with a non-empty string in all 6 locales, and the key
 * sets match exactly; the two new components only use keys that
 * exist; preload exposes the profile/memory API; main registers the
 * IPC channels.
 *
 * Part B (real Electron renderer under xvfb, mocked `window.openBot`
 * — see tests/fixtures/memory-v095d4-harness.tsx): MemoryView lists
 * memories + status, search filters, inline edit saves, two-step
 * delete removes the row, export calls the mock; ProfileSection
 * loads the profile and saves a patch.
 *
 * Fails on any uncaught renderer exception.
 * Skips the renderer part when there is no DISPLAY — same convention
 * as the other smoke tests.
 *
 * Run: xvfb-run -a node --test tests/memory-ui-v095d4.test.mjs
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
const CDP_PORT = 9750 + (process.pid % 200);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memory-ui-v095d4-'));
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
    const ok = await evalJs(`typeof window.__mountMemory === 'function' && typeof window.__mountProfile === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountMemory/__mountProfile within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v095d4-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>MemoryView/ProfileSection v0.95d4 harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'memory-v095d4-harness.tsx')],
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
const clickTestId = (testId) => `(() => { const b = document.querySelector('[data-testid="${testId}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
})()`;

// ---------------------------------------------------------------------------
// Part A: i18n parity + wiring (no display needed)
// ---------------------------------------------------------------------------

const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
function loadLocale(code) {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'apps/desktop/src/renderer/i18n/locales', `${code}.json`), 'utf-8'));
}

test('i18n: profile.*/memory.*/sidebar.memory — đủ 6 locale, key set khớp, không rỗng', () => {
  const dicts = LOCALES.map(loadLocale);
  const keys = Object.keys(dicts[0]).filter(
    (k) => k.startsWith('profile.') || k.startsWith('memory.') || k === 'sidebar.memory',
  );
  assert.ok(keys.length >= 50, `expected >= 50 new keys, got ${keys.length}`);
  for (let i = 1; i < dicts.length; i++) {
    for (const key of keys) {
      assert.ok(
        typeof dicts[i][key] === 'string' && dicts[i][key].trim() !== '',
        `locale ${LOCALES[i]} thiếu key ${key} (hoặc rỗng)`,
      );
    }
    const extra = Object.keys(dicts[i]).filter(
      (k) => (k.startsWith('profile.') || k.startsWith('memory.') || k === 'sidebar.memory') && !keys.includes(k),
    );
    assert.deepEqual(extra, [], `locale ${LOCALES[i]} có key thừa: ${extra.join(', ')}`);
  }
});

test('i18n: MemoryView/ProfileSection chỉ dùng key đã có trong vi.json', () => {
  const vi = loadLocale('vi');
  const sources = ['MemoryView.tsx', 'ProfileSection.tsx'].map((f) =>
    fs.readFileSync(path.join(REPO, 'apps/desktop/src/renderer/components', f), 'utf-8'),
  ).join('\n');
  const used = new Set([...sources.matchAll(/t\('([a-z]+\.[a-zA-Z]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 20, `expected > 20 t() keys, got ${used.size}`);
  for (const key of used) {
    assert.ok(typeof vi[key] === 'string', `component dùng key i18n chưa có: ${key}`);
  }
});

test('wiring: preload expose đủ 7 API profile/memory, main đăng ký đủ 7 kênh IPC', () => {
  const preload = fs.readFileSync(path.join(REPO, 'apps/desktop/src/main/preload.ts'), 'utf-8');
  for (const api of ['getUserProfile', 'updateUserProfile', 'listMemories', 'updateMemory', 'deleteMemory', 'exportMemories', 'getMemoryStatus']) {
    assert.ok(preload.includes(api), `preload thiếu ${api}`);
  }
  const main = fs.readFileSync(path.join(REPO, 'apps/desktop/src/main/main.ts'), 'utf-8');
  for (const channel of ['profile:get', 'profile:update', 'memory:list', 'memory:update', 'memory:delete', 'memory:export', 'memory:status']) {
    assert.ok(main.includes(`'${channel}'`), `main thiếu IPC ${channel}`);
  }
});

// ---------------------------------------------------------------------------
// Part B: real renderer (needs DISPLAY)
// ---------------------------------------------------------------------------

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: MemoryView — liệt kê + status, tìm kiếm lọc, sửa inline, xoá 2 bước, xuất JSON', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountMemory()`), true, 'mounting MemoryView ok');
  await waitFor(bodyHas('Trí nhớ dài hạn'), 10_000, 'MemoryView title');
  await waitFor(bodyHas('sở thích ăn uống'), 10_000, 'shared memory row');
  assert.equal(await evalJs(bodyHas('đang làm open-bot')), true, 'bot memory row');
  assert.equal(await evalJs(bodyHas('2 memory')), true, 'status shows total 2');
  assert.equal(await evalJs(bodyHas('1 đã embed')), true, 'status shows embedded 1');
  // Tìm kiếm lọc còn 1 dòng.
  assert.equal(await evalJs(setInput('[data-testid="memory-search"]', 'phở')), true, 'typing search');
  assert.equal(await evalJs(clickTestId('memory-search-btn')), true, 'clicking search');
  await waitFor(`document.querySelectorAll('[data-testid^="memory-row-"]').length === 1`, 10_000, 'search filters to 1 row');
  assert.equal(await evalJs(bodyHas('đang làm open-bot')), false, 'non-matching row filtered out');
  // Xoá bộ lọc rồi sửa inline mem-1.
  assert.equal(await evalJs(setInput('[data-testid="memory-search"]', '')), true, 'clearing search');
  assert.equal(await evalJs(clickTestId('memory-search-btn')), true, 're-listing');
  await waitFor(`document.querySelectorAll('[data-testid^="memory-row-"]').length === 2`, 10_000, 'both rows back');
  assert.equal(await evalJs(clickTestId('memory-edit-mem-1')), true, 'clicking edit');
  assert.equal(await evalJs(setInput('[data-testid="memory-edit-value-mem-1"]', 'thích phở gà')), true, 'editing value');
  assert.equal(await evalJs(clickTestId('memory-save-mem-1')), true, 'clicking save');
  await waitFor(bodyHas('Đã cập nhật memory.'), 10_000, 'update notice');
  assert.equal(await evalJs(bodyHas('thích phở gà')), true, 'edited value renders');
  assert.equal(await evalJs(`window.__memoryCalls.memoryUpdates.length`), 1, 'one update call recorded');
  // Xoá mem-2: bấm xoá lần 1 chỉ hiện xác nhận, chưa xoá.
  assert.equal(await evalJs(clickTestId('memory-delete-mem-2')), true, 'clicking delete (step 1)');
  await waitFor(bodyHas('Xoá thật?'), 10_000, 'delete confirm appears');
  assert.equal(await evalJs(`document.querySelector('[data-testid="memory-row-mem-2"]') !== null`), true, 'row still there before confirm');
  assert.equal(await evalJs(clickTestId('memory-delete-confirm-mem-2')), true, 'confirming delete');
  await waitFor(bodyHas('Đã xoá memory.'), 10_000, 'delete notice');
  assert.equal(await evalJs(`document.querySelector('[data-testid="memory-row-mem-2"]') === null`), true, 'row gone after delete');
  assert.deepEqual(await evalJs(`window.__memoryCalls.memoryDeletes`), ['mem-2'], 'delete recorded once');
  // Xuất JSON: mock ghi nhận, blob URL được tạo (không mở hộp thoại download).
  assert.equal(await evalJs(clickTestId('memory-export')), true, 'clicking export');
  await waitFor(bodyHas('Đã xuất file JSON.'), 10_000, 'export notice');
  assert.equal(await evalJs(`window.__memoryCalls.exports.length`), 1, 'one export call recorded');
  assert.equal(await evalJs(`window.__memoryCalls.blobUrls.length`), 1, 'blob URL created for download');
});

test('renderer: ProfileSection — tải hồ sơ, đổi cách xưng hô, lưu xong báo đã lưu', { skip: !hasDisplay }, async () => {
  assert.equal(await evalJs(`window.__mountProfile()`), true, 'mounting ProfileSection ok');
  await waitFor(bodyHas('Hồ sơ của bạn'), 10_000, 'ProfileSection title');
  assert.equal(await evalJs(`document.querySelector('[data-testid="profile-display-name"]').value`), 'Huy', 'display name loaded');
  assert.equal(await evalJs(`document.querySelector('[data-testid="profile-address-form"]').value`), 'bạn', 'address form loaded');
  assert.equal(await evalJs(bodyHas('Chỉ lưu trên máy này')), true, 'local-only note shown');
  assert.equal(await evalJs(setInput('[data-testid="profile-address-form"]', 'anh')), true, 'changing address form');
  assert.equal(await evalJs(clickTestId('profile-save')), true, 'clicking save');
  await waitFor(bodyHas('Đã lưu hồ sơ.'), 10_000, 'save notice');
  assert.equal(await evalJs(`window.__memoryCalls.profileUpdates.length`), 1, 'one profile update recorded');
  assert.equal(await evalJs(`window.__memoryCalls.profileUpdates[0].addressForm`), 'anh', 'patch carries new address form');
});
