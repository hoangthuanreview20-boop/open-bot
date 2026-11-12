/**
 * Renderer tests for v0.94a — plugin marketplace UI: Downgrade button
 * + trusted-keys management (apps/desktop/src/renderer/components/
 * McpMarketplaceView.tsx, plugins tab).
 *
 * Mounts the real McpMarketplaceView in a REAL Electron renderer
 * (Chromium) under xvfb, with a mocked `window.openBot` (see
 * tests/fixtures/plugin-marketplace-ui-v094a-harness.tsx):
 *   downgrade: the button shows only for the plugin whose
 *     downgrade-info says it can downgrade; clicking it asks for
 *     confirmation, then calls `downgradePluginMarketplace` once and
 *     the notice names the version it went back to (v2.0.0 -> v1.0.0).
 *   downgrade-fails: the IPC rejects — the error surfaces, no
 *     success notice appears, the plugin stays on v2.0.0.
 *   no-previous: downgrade-info says the snapshot is gone — no
 *     button at all, and the reason is shown instead.
 *   trusted keys: the list shows keyId + label (never key material);
 *     removing a key asks for confirmation, then calls the IPC and
 *     the row disappears; adding a key sends the PEM + label and the
 *     new row appears; a malformed PEM is refused client-side with
 *     no IPC call; a failing list shows an error + Retry.
 *
 * Fails on any uncaught renderer exception.
 * Skips the Electron part when there is no DISPLAY — same convention
 * as the other smoke/renderer tests. Static wiring checks run
 * without a display.
 *
 * Run: xvfb-run -a node --test tests/plugin-marketplace-ui-v094a.test.mjs
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
const CDP_PORT = 9860 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mktui-v094a-'));
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
    const ok = await evalJs(`typeof window.__mountMarketplace === 'function'`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('harness did not expose __mountMarketplace within 30s');
}

async function launchHarness() {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'open-bot-v094a-harness', private: true, version: '0.0.0', main: 'main.js',
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
<title>Plugin marketplace UI v0.94a harness</title>
<div id="root"></div>
<script src="./bundle.js"></script>
`, 'utf8');
  await build({
    entryPoints: [path.join(REPO, 'tests', 'fixtures', 'plugin-marketplace-ui-v094a-harness.tsx')],
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

const hasTestId = (id) => `!!document.querySelector('[data-testid=${JSON.stringify(id)}]')`;
const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
const clickTestId = (id) => `(() => { const b = document.querySelector('[data-testid=${JSON.stringify(id)}]'); if (!b || b.disabled) return false; b.click(); return true; })()`;

/** Switch to the Plugins tab (the view mounts on the MCP tab). */
async function openPluginsTab() {
  assert.equal(
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Plugin');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`),
    true,
    'clicking the Plugin tab',
  );
  await waitFor(bodyHas('Plugin đã cài'), 10_000, 'plugins tab to show');
}

async function mountScenario(scenario) {
  assert.equal(await evalJs(`window.__mountMarketplace(${JSON.stringify(scenario)})`), true, `mounting ${scenario}`);
  // Wait for the main panel, not just the title: the loading branch
  // also shows the title, but has no tab buttons yet.
  await waitFor(bodyHas('Server MCP'), 10_000, 'marketplace main panel to appear');
  await openPluginsTab();
}

/** Set a textarea/input value the way React notices it (native setter + input event). */
const setFieldValue = (testId, value) => `(() => {
  const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

test.before(async () => {
  if (!hasDisplay) return;
  await launchHarness();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('renderer: Downgrade button shows only for the downgradable plugin', { skip: !hasDisplay }, async () => {
  await mountScenario('loaded');
  await waitFor(bodyHas('Demo Plugin'), 10_000, 'demo plugin to list');
  assert.equal(await evalJs(bodyHas('Plain Plugin')), true, 'plain plugin lists too');
  assert.equal(await evalJs(hasTestId('plugin-downgrade-demo-plugin')), true, 'downgrade button on the demo plugin');
  assert.equal(await evalJs(hasTestId('plugin-downgrade-plain-plugin')), false, 'no downgrade button without a previous version');
  assert.equal(await evalJs(bodyHas('Có thể hạ cấp về v1.0.0.')), true, 'downgrade target hint shows the previous version');
});

test('renderer: downgrade asks first, then calls the IPC and names the restored version', { skip: !hasDisplay }, async () => {
  await mountScenario('loaded');
  await waitFor(hasTestId('plugin-downgrade-demo-plugin'), 10_000, 'downgrade button to appear');
  assert.equal(await evalJs(clickTestId('plugin-downgrade-demo-plugin')), true, 'clicking Downgrade');
  await waitFor(hasTestId('confirm-modal'), 10_000, 'confirmation modal to appear');
  assert.equal(
    await evalJs(bodyHas('Hạ cấp “Demo Plugin” từ v2.0.0 về v1.0.0?')),
    true,
    'confirmation names the plugin and both versions',
  );
  assert.equal(await evalJs(`window.__downgradeCalls.length`), 0, 'no downgrade IPC before confirming');
  assert.equal(await evalJs(clickTestId('confirm-modal-confirm')), true, 'confirming the downgrade');
  await waitFor(`window.__downgradeCalls.length === 1`, 10_000, 'downgrade IPC to be called once');
  assert.deepEqual(await evalJs(`window.__downgradeCalls`), ['demo-plugin'], 'downgrade IPC called with the plugin id');
  await waitFor(bodyHas('Đã hạ cấp “Demo Plugin” từ v2.0.0 về v1.0.0.'), 10_000, 'downgrade notice to show');
  // The list reloads: the card now shows v1.0.0, and the versions
  // swapped roles, so the button offers the way back to v2.0.0.
  await waitFor(bodyHas('Có thể hạ cấp về v2.0.0.'), 10_000, 'downgrade target swaps after the downgrade');
});

test('renderer: a failing downgrade surfaces the error and claims no success', { skip: !hasDisplay }, async () => {
  await mountScenario('downgrade-fails');
  await waitFor(hasTestId('plugin-downgrade-demo-plugin'), 10_000, 'downgrade button to appear');
  assert.equal(await evalJs(clickTestId('plugin-downgrade-demo-plugin')), true, 'clicking Downgrade');
  await waitFor(hasTestId('confirm-modal'), 10_000, 'confirmation modal to appear');
  assert.equal(await evalJs(clickTestId('confirm-modal-confirm')), true, 'confirming the downgrade');
  await waitFor(bodyHas('snapshot is missing from disk'), 10_000, 'downgrade error to surface');
  assert.equal(await evalJs(bodyHas('Đã hạ cấp')), false, 'no success notice on a failed downgrade');
  assert.equal(await evalJs(bodyHas('Có thể hạ cấp về v1.0.0.')), true, 'plugin still on v2.0.0 with its previous version');
});

test('renderer: no button when the snapshot is gone — the reason is shown instead', { skip: !hasDisplay }, async () => {
  await mountScenario('no-previous');
  await waitFor(bodyHas('Demo Plugin'), 10_000, 'demo plugin to list');
  assert.equal(await evalJs(hasTestId('plugin-downgrade-demo-plugin')), false, 'no downgrade button when it cannot downgrade');
  assert.equal(await evalJs(bodyHas('Không thể hạ cấp:')), true, 'unavailable reason is shown');
  assert.equal(await evalJs(bodyHas('snapshot is missing from disk')), true, 'reason names the missing snapshot');
});

test('renderer: trusted keys list shows keyId + label, never key material', { skip: !hasDisplay }, async () => {
  await mountScenario('loaded');
  await waitFor(bodyHas('Khoá tin cậy'), 10_000, 'trusted keys section to show');
  assert.equal(await evalJs(bodyHas('Acme')), true, 'key label lists');
  assert.equal(
    await evalJs(bodyHas('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899')),
    true,
    'keyId lists in full',
  );
  assert.equal(await evalJs(bodyHas('-----BEGIN PUBLIC KEY-----')), false, 'no PEM ever renders in the list');
  assert.equal(await evalJs(bodyHas('Chưa có khoá tin cậy nào.')), false, 'no empty state when a key exists');
});

test('renderer: removing a key asks first, then calls the IPC and drops the row', { skip: !hasDisplay }, async () => {
  await mountScenario('loaded');
  const removeId = 'plugin-remove-key-aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
  await waitFor(hasTestId(removeId), 10_000, 'remove button to appear');
  assert.equal(await evalJs(clickTestId(removeId)), true, 'clicking Remove on the Acme key');
  await waitFor(hasTestId('confirm-modal'), 10_000, 'confirmation modal to appear');
  assert.equal(await evalJs(bodyHas('Gỡ khoá tin cậy “Acme”?')), true, 'confirmation names the key label');
  assert.equal(await evalJs(`window.__removeKeyCalls.length`), 0, 'no remove IPC before confirming');
  assert.equal(await evalJs(clickTestId('confirm-modal-confirm')), true, 'confirming the removal');
  await waitFor(`window.__removeKeyCalls.length === 1`, 10_000, 'remove IPC to be called once');
  assert.deepEqual(
    await evalJs(`window.__removeKeyCalls`),
    ['aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'],
    'remove IPC called with the keyId',
  );
  await waitFor(bodyHas('Đã gỡ khoá tin cậy “Acme”.'), 10_000, 'remove notice to show');
  // The notice itself names "Acme", so the row is proven gone by its
  // keyId (which appears nowhere else) and its Remove button.
  assert.equal(await evalJs(hasTestId(removeId)), false, 'remove button gone after removal');
  assert.equal(
    await evalJs(bodyHas('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899')),
    false,
    'keyId gone after removal',
  );
  assert.equal(await evalJs(bodyHas('Chưa có khoá tin cậy nào.')), true, 'empty state shows once the last key is gone');
});

test('renderer: adding a key sends the PEM + label and the new row appears', { skip: !hasDisplay }, async () => {
  await mountScenario('keys-empty');
  await waitFor(bodyHas('Chưa có khoá tin cậy nào.'), 10_000, 'empty state to show');
  const pem = await evalJs(`window.__fakePem`);
  assert.ok(typeof pem === 'string' && pem.includes('BEGIN PUBLIC KEY'), 'harness exposes the fake PEM');
  assert.equal(await evalJs(setFieldValue('plugin-add-key-pem', pem)), true, 'typing the PEM');
  assert.equal(await evalJs(setFieldValue('plugin-add-key-label', 'Beta')), true, 'typing the label');
  assert.equal(await evalJs(clickTestId('plugin-add-key-button')), true, 'clicking Add key');
  await waitFor(`window.__addKeyCalls.length === 1`, 10_000, 'add IPC to be called once');
  assert.deepEqual(
    await evalJs(`window.__addKeyCalls[0]`),
    { publicKey: pem, label: 'Beta' },
    'PEM + label reach the add IPC',
  );
  await waitFor(bodyHas('Beta'), 10_000, 'new key row to appear');
  assert.equal(await evalJs(bodyHas('Đã thêm khoá tin cậy')), true, 'add notice to show');
  // The form clears the PEM as soon as it is stored.
  assert.equal(
    await evalJs(`document.querySelector('[data-testid="plugin-add-key-pem"]')?.value`),
    '',
    'PEM field cleared after adding',
  );
});

test('renderer: a malformed PEM is refused client-side with no IPC call', { skip: !hasDisplay }, async () => {
  await mountScenario('keys-empty');
  await waitFor(bodyHas('Chưa có khoá tin cậy nào.'), 10_000, 'empty state to show');
  assert.equal(await evalJs(setFieldValue('plugin-add-key-pem', 'not a pem')), true, 'typing a bad PEM');
  assert.equal(await evalJs(clickTestId('plugin-add-key-button')), true, 'clicking Add key');
  await waitFor(bodyHas('Public key phải là PEM bắt đầu bằng'), 10_000, 'PEM format error to show');
  assert.equal(await evalJs(`window.__addKeyCalls.length`), 0, 'no add IPC for a malformed PEM');
  assert.equal(await evalJs(bodyHas('Đã thêm khoá tin cậy')), false, 'no success notice for a refused key');
});

test('renderer: a failing key list shows an error + Retry, and retry loads the keys', { skip: !hasDisplay }, async () => {
  await mountScenario('keys-error');
  await waitFor(hasTestId('plugin-trusted-keys-retry'), 10_000, 'retry button to appear');
  assert.equal(await evalJs(bodyHas('keys store unreadable')), true, 'list error text surfaces');
  assert.equal(await evalJs(clickTestId('plugin-trusted-keys-retry')), true, 'clicking Retry');
  await waitFor(bodyHas('Acme'), 10_000, 'keys to list after retry');
  assert.equal(await evalJs(hasTestId('plugin-trusted-keys-retry')), false, 'retry button gone after a successful retry');
});

// ---------------------------------------------------------------------------
// Static checks (run without a display)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf-8');
const renderer = path.join(repo, 'apps/desktop/src/renderer');

test('static: view calls the downgrade + trusted-key IPC through the real preload shape', () => {
  const view = read(path.join(renderer, 'components/McpMarketplaceView.tsx'));
  for (const fn of [
    'getPluginDowngradeInfo',
    'downgradePluginMarketplace',
    'listTrustedMarketplaceKeys',
    'addTrustedMarketplaceKey',
    'removeTrustedMarketplaceKey',
  ]) {
    assert.ok(
      view.includes(`window.openBot.${fn}(`),
      `view must call window.openBot.${fn}()`,
    );
  }
  // The Downgrade button is gated on the info (canDowngrade), not on
  // the list record alone — a recorded previous version whose
  // snapshot is gone must not offer a button that can only fail.
  assert.match(view, /downgradeTargetOf\(plugin\)/);
  assert.match(view, /info\.canDowngrade \? info\.previousVersion : null/);
  // The confirm step runs before the downgrade IPC.
  assert.match(view, /pendingConfirm[\s\S]*?plugin\.downgradeConfirm[\s\S]*?doDowngrade/);
  // Success is only announced from the IPC result, never assumed.
  assert.match(view, /downgradePluginMarketplace\(plugin\.id\)[\s\S]*?plugin\.downgradedOk/);
});

test('static: trusted-keys UI shows keyId + label only — no key material, no private key', () => {
  const view = read(path.join(renderer, 'components/McpMarketplaceView.tsx'));
  assert.match(view, /key\.keyId/);
  assert.match(view, /key\.label/);
  assert.doesNotMatch(view, /key\.publicKey/, 'the list must never render a public key PEM');
  assert.doesNotMatch(view, /privateKey/i, 'no private key anywhere in the view');
  // Adding validates the PEM shape before any IPC call.
  assert.match(view, /looksLikePublicKeyPem\(pem\)/);
  assert.match(view, /-----BEGIN PUBLIC KEY-----/);
  // The PEM field clears once the key is stored.
  assert.match(view, /setNewKeyPem\(''\)/);
});

test('static: every new v0.94a i18n key exists in all six locales with matching placeholders', () => {
  const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));
  const keys = [
    'plugin.downgrade',
    'plugin.downgradeAvailable',
    'plugin.downgradeConfirm',
    'plugin.downgradeUnavailable',
    'plugin.downgradedOk',
    'plugin.trustedKeysTitle',
    'plugin.trustedKeysHint',
    'plugin.trustedKeysEmpty',
    'plugin.trustedKeysLoading',
    'plugin.trustedKeysLoadError',
    'plugin.trustedKeyAddedAt',
    'plugin.addKeyTitle',
    'plugin.addKeyPemLabel',
    'plugin.addKeyPemPlaceholder',
    'plugin.addKeyLabelLabel',
    'plugin.addKeyLabelPlaceholder',
    'plugin.addKeyButton',
    'plugin.addKeyInvalidPem',
    'plugin.addKeyOk',
    'plugin.removeKey',
    'plugin.removeKeyConfirm',
    'plugin.removeKeyOk',
  ];
  assert.equal(keys.length, 22, 'the wave adds exactly 22 keys');
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const code of ['vi', 'en', 'zh', 'ja', 'es', 'fr']) {
    const dict = JSON.parse(read(path.join(renderer, `i18n/locales/${code}.json`)));
    for (const key of keys) {
      assert.ok(key in dict, `${key} missing in ${code}.json`);
      assert.deepEqual(
        placeholders(dict[key]),
        placeholders(en[key]),
        `placeholders differ for ${key} in ${code}.json`,
      );
    }
  }
});

test('static: preload + renderer types declare the five v0.94a IPC functions', () => {
  const preload = read(path.join(repo, 'apps/desktop/src/main/preload.ts'));
  for (const fn of [
    'getPluginDowngradeInfo',
    'downgradePluginMarketplace',
    'listTrustedMarketplaceKeys',
    'addTrustedMarketplaceKey',
    'removeTrustedMarketplaceKey',
  ]) {
    assert.ok(preload.includes(fn), `preload must expose ${fn}`);
  }
  const api = read(path.join(renderer, 'global.d.ts'));
  assert.match(api, /getPluginDowngradeInfo\(id: string\): Promise<PluginDowngradeInfoLike>/);
  assert.match(api, /downgradePluginMarketplace\(id: string\): Promise<PluginDowngradeResultLike>/);
  assert.match(api, /listTrustedMarketplaceKeys\(\): Promise<TrustedMarketplaceKeyLike\[\]>/);
  assert.match(api, /addTrustedMarketplaceKey\(publicKey: string, label\?: string\): Promise<\{ keyId: string \}>/);
  assert.match(api, /removeTrustedMarketplaceKey\(keyId: string\): Promise<boolean>/);
});
