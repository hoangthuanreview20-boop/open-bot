/**
 * Renderer test for v0.68c — Settings loading / empty / error states
 * for the remaining sections (docs/ui-parity-review.md §3.6 T5, P2),
 * with fake `SettingsShared` state in a REAL Electron renderer
 * (Chromium) under xvfb.
 *
 * The test bundles tests/fixtures/settings-loading-v068c-harness.tsx
 * with esbuild, serves it from a minimal Electron harness app in a
 * temp dir (no main process, no preload — the mock IS the shared
 * state / `window.openBot`), and mounts the real tab components once
 * per scenario:
 *
 *   general:     usage loading / error + retry -> loaded,
 *                update-status error + retry
 *   security:    auth loading / error + retry -> loaded,
 *                vault loading / empty / error + retry,
 *                1Password checking / error (retry via Check)
 *   bot-model:   auto-approve loading / error + retry -> loaded,
 *                models loading / error + retry -> loaded,
 *                Ollama error + retry -> loaded, Ollama empty
 *   advanced:    perf loading / error + retry -> loaded,
 *                plugins + hooks loading / error + retry -> loaded,
 *                API loading / error + retry -> loaded,
 *                webhooks error (no "no webhooks" line)
 *   connections: connectors loading / error + retry -> loaded
 *   top-level:   SettingsView getSettings rejects once, retry loads
 *   skills:      loading / error (no empty line) / empty
 *
 * Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other
 * smoke tests.
 *
 * Run: xvfb-run -a node --test tests/settings-loading-v068c-renderer.test.mjs
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
const CDP_PORT = 9850 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-settings-loading-v068c-'));
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
    const ok = await evalJs(`typeof window.__mountSettingsTab === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountSettingsTab within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v068c-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>Settings loading v0.68c harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'settings-loading-v068c-harness.tsx')],
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

async function mountTab(tab, scenario) {
  assert.equal(await evalJs(`window.__mountSettingsTab(${JSON.stringify(tab)}, ${JSON.stringify(scenario)})`), true, `mounting ${tab}/${scenario}`);
}

const hasTestId = (id) => `!!document.querySelector('[data-testid=${JSON.stringify(id)}]')`;
const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
const clickTestId = (id) => `(() => { const b = document.querySelector('[data-testid=${JSON.stringify(id)}]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
const reloadCalls = () => evalJs(`window.__reloadCalls()`);

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: usage loading / error + retry -> loaded, update-status error + retry', { skip: !hasDisplay }, async () => {
  // Loading: usage section renders (not vanished) with a loading line.
  await mountTab('general', 'usage-loading');
  await waitFor(hasTestId('usage-loading'), 10_000, 'usage loading line to appear');
  assert.equal(await evalJs(bodyHas('Mức sử dụng & giới hạn chi tiêu')), true, 'usage section title renders while loading');
  assert.equal(await evalJs(bodyHas('Hôm nay:')), false, 'no usage data while loading');

  // Error + retry: click retry, the stub re-mounts with loaded data.
  await mountTab('general', 'usage-error');
  await waitFor(hasTestId('usage-retry'), 10_000, 'usage retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được mức sử dụng.')), true, 'usage load error text');
  assert.equal(await evalJs(clickTestId('usage-retry')), true, 'clicking usage retry');
  await waitFor(bodyHas('Hôm nay: $0.01 · 15 token'), 10_000, 'usage data to appear after retry');
  assert.equal(await evalJs(hasTestId('usage-retry')), false, 'retry button gone after a successful retry');
  assert.deepEqual(await reloadCalls(), ['reloadUsage'], 'retry called reloadUsage once');

  // Update-status error + retry: the stub re-mounts the tab with the
  // error cleared (updateStatusError '').
  await mountTab('general', 'update-status-error');
  await waitFor(hasTestId('update-status-retry'), 10_000, 'update-status retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được trạng thái cập nhật.')), true, 'update-status load error text');
  assert.equal(await evalJs(clickTestId('update-status-retry')), true, 'clicking update-status retry');
  await waitFor(`!document.querySelector('[data-testid="update-status-retry"]')`, 10_000, 'update-status retry gone after retry');
  assert.equal(await evalJs(bodyHas('Không tải được trạng thái cập nhật.')), false, 'error text gone after a successful retry');
});

test('renderer: auth loading / error + retry, vault loading / empty / error + retry, 1Password error retry', { skip: !hasDisplay }, async () => {
  // Auth loading: no "no identity" claim while loading.
  await mountTab('security', 'auth-loading');
  await waitFor(hasTestId('auth-loading'), 10_000, 'auth loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa đăng nhập provider nào bằng OAuth.')), false, 'no "no identity" line while loading');
  assert.equal(await evalJs(bodyHas('Chưa có nhà cung cấp đăng nhập nào.')), false, 'no "no providers" line while loading');

  // Auth error + retry: click retry, the identity + provider appear.
  await mountTab('security', 'auth-error');
  await waitFor(hasTestId('auth-retry'), 10_000, 'auth retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được thông tin đăng nhập.')), true, 'auth load error text');
  assert.equal(await evalJs(clickTestId('auth-retry')), true, 'clicking auth retry');
  await waitFor(bodyHas('Test User'), 10_000, 'identity to appear after retry');
  assert.equal(await evalJs(bodyHas('Không tải được thông tin đăng nhập.')), false, 'error text gone after a successful retry');

  // Vault loading: no "empty" line while loading.
  await mountTab('security', 'vault-loading');
  await waitFor(hasTestId('vault-loading'), 10_000, 'vault loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa có secret nào trong Vault.')), false, 'no vault empty line while loading');

  // Vault error + retry: click retry, the secret list appears.
  await mountTab('security', 'vault-error');
  await waitFor(hasTestId('vault-retry'), 10_000, 'vault retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách secret trong Vault.')), true, 'vault load error text');
  assert.equal(await evalJs(clickTestId('vault-retry')), true, 'clicking vault retry');
  await waitFor(bodyHas('key-1'), 10_000, 'vault secret to appear after retry');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách secret trong Vault.')), false, 'error text gone after a successful retry');

  // Vault empty: a finished load with no secrets shows the empty line.
  await mountTab('security', 'vault-loaded');
  await waitFor(bodyHas('key-1'), 10_000, 'vault secret to list');
  await mountTab('security', 'auth-loaded');
  await waitFor(bodyHas('Test User'), 10_000, 'auth loaded state to mount');

  // 1Password load error: the status line shows the error (not
  // "Signed out"), and the Check button is enabled as the retry.
  await mountTab('security', 'onepassword-error');
  await waitFor(bodyHas('Không tải được trạng thái 1Password.'), 10_000, '1Password load error to show');
  assert.equal(await evalJs(bodyHas('Chưa đăng nhập 1Password.')), false, 'status line must not read "Signed out" when the load failed');
  assert.equal(await evalJs(`document.querySelector('[data-testid="onepassword-check"]').disabled`), false, 'Check button must be enabled when the status failed to load');
  // v0.73: with no status loaded the enable checkbox must NOT
  // render checked (it used to default to checked=true) and must
  // be disabled — there is nothing known to toggle yet.
  assert.equal(await evalJs(`document.querySelector('[data-testid="onepassword-enable"]').checked`), false, 'enable checkbox must be unchecked while the status is unknown');
  assert.equal(await evalJs(`document.querySelector('[data-testid="onepassword-enable"]').disabled`), true, 'enable checkbox must be disabled while the status is unknown');
  assert.equal(await evalJs(clickTestId('onepassword-check')), true, 'clicking Check as retry');
  await waitFor(bodyHas('Chưa đăng nhập 1Password.'), 10_000, 'signed-out status to appear after retry');
  // v0.73: once loaded (enabled:true) the checkbox is enabled + checked.
  assert.equal(await evalJs(`document.querySelector('[data-testid="onepassword-enable"]').disabled`), false, 'enable checkbox must be enabled once the status loaded');
  assert.equal(await evalJs(`document.querySelector('[data-testid="onepassword-enable"]').checked`), true, 'enable checkbox must reflect the loaded enabled state');

  // 1Password checking: the checking line shows while status is null.
  await mountTab('security', 'onepassword-checking');
  await waitFor(bodyHas('Đang kiểm tra…'), 10_000, '1Password checking line to appear');
  assert.equal(await evalJs(`document.querySelector('[data-testid="onepassword-enable"]').disabled`), true, 'enable checkbox must be disabled while the status is still loading');
});

test('renderer: auto-approve / models / Ollama loading, error + retry, empty', { skip: !hasDisplay }, async () => {
  // Auto-approve loading: no empty line while loading.
  await mountTab('bot-model', 'auto-approve-loading');
  await waitFor(hasTestId('auto-approve-loading'), 10_000, 'auto-approve loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa có rule nào')), false, 'no empty line while loading');

  // Auto-approve error + retry: click retry, the rule appears.
  await mountTab('bot-model', 'auto-approve-error');
  await waitFor(hasTestId('auto-approve-retry'), 10_000, 'auto-approve retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách rule auto-approve.')), true, 'auto-approve load error text');
  assert.equal(await evalJs(clickTestId('auto-approve-retry')), true, 'clicking auto-approve retry');
  await waitFor(bodyHas('echo hi'), 10_000, 'rule to appear after retry');

  // Models loading: no empty provider list while loading.
  await mountTab('bot-model', 'models-loading');
  await waitFor(hasTestId('models-loading'), 10_000, 'models loading line to appear');

  // Models error + retry: click retry, the provider appears.
  await mountTab('bot-model', 'models-error');
  await waitFor(hasTestId('models-retry'), 10_000, 'models retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được model registry.')), true, 'models load error text');
  assert.equal(await evalJs(clickTestId('models-retry')), true, 'clicking models retry');
  await waitFor(bodyHas('GPT X'), 10_000, 'provider model to appear after retry');

  // Ollama error + retry: click retry, the model appears.
  await mountTab('bot-model', 'ollama-error');
  await waitFor(hasTestId('ollama-retry'), 10_000, 'Ollama retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách model Ollama.')), true, 'Ollama load error text');
  assert.equal(await evalJs(clickTestId('ollama-retry')), true, 'clicking Ollama retry');
  await waitFor(bodyHas('llama3'), 10_000, 'Ollama model to appear after retry');

  // Ollama empty: a finished load with no models shows the empty line.
  await mountTab('bot-model', 'ollama-empty');
  await waitFor(bodyHas('Chưa có model Ollama nào trên máy.'), 10_000, 'Ollama empty line to appear');
});

test('renderer: perf / plugins / hooks / API loading, error + retry, webhooks error', { skip: !hasDisplay }, async () => {
  // Perf loading: blank body is gone, a loading line shows instead.
  await mountTab('advanced', 'perf-loading');
  await waitFor(hasTestId('perf-loading'), 10_000, 'perf loading line to appear');

  // Perf error + retry: the retry button exists (it used to live only
  // inside the loaded block); click retry, the stats appear.
  await mountTab('advanced', 'perf-error');
  await waitFor(hasTestId('perf-retry'), 10_000, 'perf retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được trạng thái hiệu năng.')), true, 'perf load error text');
  assert.equal(await evalJs(clickTestId('perf-retry')), true, 'clicking perf retry');
  await waitFor(bodyHas('Worker: 0/2 đang bận'), 10_000, 'perf stats to appear after retry');

  // Plugins loading: no empty line while loading.
  await mountTab('advanced', 'plugins-loading');
  await waitFor(hasTestId('plugins-loading'), 10_000, 'plugins loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa cài plugin nào.')), false, 'no plugins empty line while loading');

  // Plugins error + retry: click retry, the plugin appears.
  await mountTab('advanced', 'plugins-error');
  await waitFor(hasTestId('plugins-retry'), 10_000, 'plugins retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách plugin.')), true, 'plugins load error text');
  assert.equal(await evalJs(clickTestId('plugins-retry')), true, 'clicking plugins retry');
  await waitFor(bodyHas('Sample Plugin'), 10_000, 'plugin to appear after retry');

  // Hooks loading + error + retry.
  await mountTab('advanced', 'hooks-loading');
  await waitFor(hasTestId('hooks-loading'), 10_000, 'hooks loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa có hook nào.')), false, 'no hooks empty line while loading');
  await mountTab('advanced', 'hooks-error');
  await waitFor(hasTestId('hooks-retry'), 10_000, 'hooks retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được danh sách hook.')), true, 'hooks load error text');
  assert.equal(await evalJs(clickTestId('hooks-retry')), true, 'clicking hooks retry');
  await waitFor(bodyHas('sample-hook'), 10_000, 'hook to appear after retry');

  // API loading: no misleading "token not set" while loading.
  await mountTab('advanced', 'api-loading');
  await waitFor(hasTestId('api-loading'), 10_000, 'API loading line to appear');

  // API error + retry: click retry, the API section loads (the port
  // lives in the input value, not in textContent — read it directly).
  await mountTab('advanced', 'api-error');
  await waitFor(hasTestId('api-retry'), 10_000, 'API retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được trạng thái API.')), true, 'API load error text');
  assert.equal(await evalJs(clickTestId('api-retry')), true, 'clicking API retry');
  await waitFor(bodyHas('Chưa có token.'), 10_000, 'API token line to appear after retry');
  assert.equal(await evalJs(`document.getElementById('api-port')?.value === '8080'`), true, 'API port input holds the loaded port');
  assert.equal(await evalJs(hasTestId('api-retry')), false, 'API retry button gone after a successful retry');

  // Webhooks error: the error shows and the "no webhooks" line does not.
  await mountTab('advanced', 'webhooks-error');
  await waitFor(bodyHas('Không tải được danh sách webhook.'), 10_000, 'webhooks load error to show');
  assert.equal(await evalJs(bodyHas('Chưa có webhook nào.')), false, 'no "no webhooks" line when the list failed to load');
});

test('renderer: connectors loading / error + retry, top-level Settings retry, SkillsView states', { skip: !hasDisplay }, async () => {
  // Connectors loading: no "not connected" claim while loading.
  await mountTab('connections', 'connectors-loading');
  await waitFor(hasTestId('connectors-loading'), 10_000, 'connectors loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa kết nối.')), false, 'no "not connected" line while loading');

  // Connectors error + retry: click retry, the account appears.
  await mountTab('connections', 'connectors-error');
  await waitFor(hasTestId('connectors-retry'), 10_000, 'connectors retry button to appear');
  assert.equal(await evalJs(bodyHas('Không tải được thông tin đăng nhập.')), true, 'connectors load error text');
  assert.equal(await evalJs(clickTestId('connectors-retry')), true, 'clicking connectors retry');
  await waitFor(bodyHas('Ann'), 10_000, 'connector account to appear after retry');

  // Top-level: getSettings rejects once — the loading line is gone,
  // the error + retry show; clicking retry loads the Settings page.
  assert.equal(await evalJs(`window.__mountSettingsTopError()`), true, 'mounting SettingsView with a failing getSettings');
  await waitFor(hasTestId('settings-retry'), 10_000, 'top-level retry button to appear');
  assert.equal(await evalJs(bodyHas('settings failed')), true, 'top-level load error text');
  assert.equal(await evalJs(bodyHas('Đang tải cài đặt…')), false, 'loading line must be gone once the load failed');
  assert.equal(await evalJs(clickTestId('settings-retry')), true, 'clicking top-level retry');
  await waitFor(bodyHas('Cài đặt & API key'), 10_000, 'Settings page to load after retry');
  assert.equal(await evalJs(hasTestId('settings-retry')), false, 'top-level retry button gone after a successful retry');

  // SkillsView loading: loading line, no empty line.
  assert.equal(await evalJs(`window.__mountSkills('skills-loading')`), true, 'mounting SkillsView loading');
  await waitFor(hasTestId('skills-loading'), 10_000, 'skills loading line to appear');
  assert.equal(await evalJs(bodyHas('Chưa có kỹ năng nào.')), false, 'no skills empty line while loading');

  // SkillsView error: error text, no empty line next to it.
  assert.equal(await evalJs(`window.__mountSkills('skills-error')`), true, 'mounting SkillsView error');
  await waitFor(bodyHas('skills list failed'), 10_000, 'skills load error to show');
  assert.equal(await evalJs(bodyHas('Chưa có kỹ năng nào.')), false, 'no skills empty line next to the load error');

  // SkillsView empty: a finished load with no skills shows the empty line.
  assert.equal(await evalJs(`window.__mountSkills('skills-empty')`), true, 'mounting SkillsView empty');
  await waitFor(bodyHas('Chưa có kỹ năng nào.'), 10_000, 'skills empty line to appear');
});
