/**
 * CDP smoke test for Settings tabs + search + Connected apps (UI-4, v0.59).
 *
 * Launches the REAL Electron app (apps/desktop, production build) under
 * xvfb with an isolated XDG_CONFIG_HOME, then drives the real UI:
 *   1. open Settings — General tab by default (language section shown,
 *      Advanced sections hidden)
 *   2. switch tabs — Advanced shows the Local API section, Security
 *      shows Vault, Bot & Model shows provider cards
 *   3. switch tabs without losing state — a typed Ollama pull input
 *      survives a round-trip to another tab and back
 *   4. search — "webhook" shows only the API section, "vault" shows
 *      only Vault, clearing the query restores the active tab
 *   5. Connected apps — opens from the sidebar into its own view
 *      (apps section present), Back returns to chat
 *
 * Clicks/typing go through CDP `Runtime.evaluate` on the real DOM
 * (no xdotool: this flow has no native dialog, so DOM clicks exercise
 * the same React handlers a real click would). No mocks: sections,
 * tabs and navigation are the production build.
 *
 * Run under xvfb (needs a real X display):
 *   xvfb-run -a node --test tests/settings-ui4-smoke.test.mjs
 * Without DISPLAY the file skips with a clear message (same convention
 * as tests/vault-confirm-l5-click.test.mjs).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP_DEADLINE_MS } from './cdp-deadline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const CDP_PORT = 9400 + (process.pid % 500);
const JS_TIMEOUT_MS = 5000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child = null;
let ws = null;
let msgId = 0;
const pending = new Map();
let xdgDir = '';

function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error
      ? reject(new Error(`CDP ${method} failed: ${JSON.stringify(m.error)}`))
      : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function evalJs(expression, timeoutMs = JS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ __blocked: true });
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) return reject(new Error(`CDP evaluate failed: ${JSON.stringify(m.error)}`));
      if (m.result?.exceptionDetails) {
        return reject(new Error(`page exception: ${JSON.stringify(m.result.exceptionDetails).slice(0, 400)}`));
      }
      resolve(m.result?.result?.value);
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
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
      const main = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (main) { pageUrl = main.webSocketDebuggerUrl; break; }
    } catch {
      // DevTools not up yet.
    }
    await sleep(500);
  }
  assert.ok(pageUrl, `CDP page target (index.html) did not appear in ${CDP_DEADLINE_MS / 1000}s`);
  ws = new WebSocket(pageUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed to open'));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const mountDeadline = Date.now() + 30_000;
  while (Date.now() < mountDeadline) {
    const n = await evalJs(`document.getElementById('root')?.children.length ?? 0`);
    if (typeof n === 'number' && n > 0) return;
    await sleep(500);
  }
  throw new Error('React did not mount in the app window within 30s');
}

function launchApp() {
  child = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {
    // App stderr is noisy under xvfb (D-Bus, GPU); ignore it here.
  });
  return connectCdp();
}

async function quitApp() {
  if (!child) return;
  const proc = child;
  child = null;
  if (ws) {
    try { ws.close(); } catch { /* already closed */ }
    ws = null;
  }
  pending.clear();
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  const done = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
  if (!done) proc.kill('SIGKILL');
  await exited.catch(() => undefined);
}

// --- UI helpers (real DOM, real React handlers) ---

/** Sections currently rendered (`data-section` markers). */
async function visibleSections() {
  return evalJs(`[...document.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))`);
}

async function waitFor(expression, timeoutMs = 10_000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evalJs(expression);
    if (last) return last;
    await sleep(300);
  }
  assert.fail(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
}

/** Click the first button whose text contains `text`. */
async function clickButton(text) {
  const ok = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  assert.equal(ok, true, `button containing ${JSON.stringify(text)} not found`);
  await sleep(500);
}

async function clickTab(tabId) {
  const ok = await evalJs(`(() => {
    const b = document.querySelector('[data-tab="${tabId}"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  assert.equal(ok, true, `tab [data-tab="${tabId}"] not found`);
  await sleep(500);
}

/** Type into the Settings search box (React controlled input). */
async function setSearch(value) {
  const got = await evalJs(`(() => {
    const input = document.querySelector('[data-testid="settings-search"]');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  assert.equal(got, value, 'search input not found or value did not stick');
  await sleep(500);
}

/** Type into an input by id (React controlled input). */
async function setInputValue(id, value) {
  const got = await evalJs(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  assert.equal(got, value, `input #${id} not found or value did not stick`);
  await sleep(300);
}

function skipWithoutDisplay(t) {
  if (!hasDisplay) {
    t.skip('needs a real X display — run under xvfb-run -a');
    return true;
  }
  return false;
}

before(async () => {
  if (!hasDisplay) return;
  assert.ok(fs.existsSync(ELECTRON), `Electron binary not found at ${ELECTRON}`);
  xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui4-smoke-xdg-'));
  await launchApp();
});

after(async () => {
  await quitApp();
  if (xdgDir) fs.rmSync(xdgDir, { recursive: true, force: true });
});

test('UI-4 smoke: Settings tabs, search, state kept across tabs, Connected apps', async (t) => {
  if (skipWithoutDisplay(t)) return;

  // Open Settings from the sidebar (default locale is vi).
  // v0.61 (UI-13): Settings lives in the sidebar nav menu now — open
  // the menu first, then the "Cài đặt" entry appears in the dropdown.
  const menuOpened = await evalJs(`(() => { const b = document.querySelector('[data-testid="sidebar-nav-menu"]'); if (!b) return false; b.click(); return true; })()`);
  assert.equal(menuOpened, true, 'nav menu button not found');
  await sleep(500);
  await clickButton('Cài đặt');
  await waitFor(`document.querySelector('[data-tab="general"]') !== null`, 10_000, 'settings tab bar');
  let sections = await visibleSections();
  assert.ok(sections.includes('language'), `General tab must show language, got ${sections}`);
  assert.ok(sections.includes('update'), `General tab must show update, got ${sections}`);
  assert.ok(!sections.includes('api'), `General tab must NOT show the API section, got ${sections}`);

  // Advanced tab: Local API visible, General sections hidden.
  await clickTab('advanced');
  sections = await visibleSections();
  assert.ok(sections.includes('api'), `Advanced tab must show api, got ${sections}`);
  assert.ok(sections.includes('dream'), `Advanced tab must show dream, got ${sections}`);
  assert.ok(!sections.includes('language'), `Advanced tab must NOT show language, got ${sections}`);

  // Security tab: Vault (+ 1Password) visible.
  await clickTab('security');
  sections = await visibleSections();
  assert.ok(sections.includes('vault'), `Security tab must show vault, got ${sections}`);
  assert.ok(sections.includes('onePassword'), `Security tab must show onePassword, got ${sections}`);
  assert.ok(!sections.includes('api'), `Security tab must NOT show api, got ${sections}`);

  // Bot & Model tab: provider cards visible; type a draft, leave, come back.
  await clickTab('bot-model');
  sections = await visibleSections();
  assert.ok(sections.includes('provider-openai'), `Bot & Model tab must show provider cards, got ${sections}`);
  assert.ok(sections.includes('models'), `Bot & Model tab must show models, got ${sections}`);
  await setInputValue('ollama-pull', 'smoke-model');
  await clickTab('general');
  await clickTab('bot-model');
  const ollamaValue = await evalJs(`document.getElementById('ollama-pull')?.value ?? null`);
  assert.equal(ollamaValue, 'smoke-model', 'switching tabs must not lose the typed Ollama input');

  // Search: "webhook" finds only the API section (across tabs).
  await setSearch('webhook');
  sections = await visibleSections();
  assert.deepEqual(sections, ['api'], `search "webhook" must show only api, got ${sections}`);
  // Search: "vault" finds Vault (+ 1Password, a password vault).
  await setSearch('vault');
  sections = await visibleSections();
  assert.deepEqual(sections, ['vault', 'onePassword'], `search "vault" must show vault + onePassword, got ${sections}`);
  // Clearing the query restores the active tab (Bot & Model).
  await setSearch('');
  sections = await visibleSections();
  assert.ok(sections.includes('provider-openai'), `clearing search must restore the active tab, got ${sections}`);

  // Connected apps: its own view from the sidebar.
  // v0.61 (UI-13): same nav-menu move as Settings above.
  const menuOpened2 = await evalJs(`(() => { const b = document.querySelector('[data-testid="sidebar-nav-menu"]'); if (!b) return false; b.click(); return true; })()`);
  assert.equal(menuOpened2, true, 'nav menu button not found');
  await sleep(500);
  await clickButton('App đã kết nối');
  await waitFor(`document.querySelector('[data-section="apps"]') !== null`, 10_000, 'connected apps section');
  sections = await visibleSections();
  assert.ok(sections.includes('apps'), `Connected apps view must show apps, got ${sections}`);
  assert.ok(sections.includes('composio'), `Connected apps view must show composio, got ${sections}`);
  assert.ok(!sections.includes('language'), `Connected apps view must NOT show Settings sections, got ${sections}`);

  // Back returns to chat (fresh profile: no bot yet, so the chat pane
  // shows the empty state, not the input box).
  await clickButton('Quay lại chat');
  await waitFor(`document.querySelector('.empty') !== null`, 10_000, 'chat empty state after Back');
  sections = await visibleSections();
  assert.deepEqual(sections, [], `chat must show no settings sections, got ${sections}`);
});
