/**
 * CDP smoke for v0.67b — Connected apps in the REAL Electron app
 * under xvfb.
 *
 * Launches apps/desktop with an isolated XDG_CONFIG_HOME (never
 * touches the user's real profile), creates the sample bot from
 * onboarding, opens Connected apps from the nav menu, and checks the
 * screen is never blank: the apps section shows the real catalog
 * (Slack, Gmail, ...) from the real `apps:list` IPC, the loading
 * line is gone, and the Composio section renders from the real
 * `composio:get-state` IPC.
 *
 * No provider / network is needed; everything here is UI + local IPC.
 * Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other smokes.
 *
 * Run: xvfb-run -a node --test tests/connected-apps-v067b-smoke.test.mjs
 */
import test from 'node:test';
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
const CDP_PORT = 9760 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-connected-apps-v067b-smoke-xdg-'));
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
      const main = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (main) { pageUrl = main.webSocketDebuggerUrl; break; }
    } catch {
      // DevTools not up yet.
    }
    await sleep(500);
  }
  assert.ok(pageUrl, `CDP page target (index.html) did not appear in ${CDP_DEADLINE_MS / 1000}s`);
  await attachWs(pageUrl);
  ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.enable', params: {} }));
  const mountDeadline = Date.now() + 30_000;
  while (Date.now() < mountDeadline) {
    const n = await evalJs(`document.getElementById('root')?.children.length ?? 0`);
    if (typeof n === 'number' && n > 0) return;
    await sleep(500);
  }
  throw new Error('React did not mount in the app window within 30s');
}

async function launchApp() {
  child = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: APP_DIR,
    env: { ...process.env, XDG_CONFIG_HOME: xdgDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
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

async function clickTestId(testId) {
  return evalJs(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`);
}

async function clickButtonByText(text) {
  return evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(${JSON.stringify(text)}));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

test.before(async () => {
  if (!hasDisplay) return;
  await launchApp();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(xdgDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('smoke: Connected apps screen lists the real apps (never a blank screen)', { skip: !hasDisplay }, async () => {
  // Fresh profile → onboarding → one-click sample bot.
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  assert.equal(await clickButtonByText('Tạo bot mẫu'), true, 'clicking the sample-bot button');
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear after sample-bot creation',
  );

  // Open Connected apps from the nav menu.
  assert.equal(await clickTestId('sidebar-nav-menu'), true, 'opening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to open');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-nav-key="connected-apps"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking Connected apps in the menu',
  );

  // The apps section must show the real catalog from `apps:list` —
  // the v0.67b point is that this screen never sits blank: either
  // the loading line shows first, then the list (or an empty /
  // error state), never nothing at all.
  await waitFor(`!!document.querySelector('[data-section="apps"]')`, 15_000, 'apps section to appear');
  await waitFor(
    `document.body.textContent.includes('Slack') && document.body.textContent.includes('Gmail')`,
    15_000,
    'real catalog apps (Slack, Gmail) to list',
  );
  assert.equal(await evalJs(`!!document.querySelector('[data-testid="apps-loading"]')`), false, 'loading line gone once the list arrived');
  assert.equal(await evalJs(`!!document.querySelector('[data-testid="apps-empty"]')`), false, 'no empty state when the catalog lists');
  assert.equal(await evalJs(`!!document.querySelector('[data-testid="apps-retry"]')`), false, 'no retry button when the load succeeded');

  // The Composio section renders from the real get-state IPC too.
  await waitFor(`!!document.querySelector('[data-section="composio"]')`, 10_000, 'Composio section to appear');
  assert.equal(
    await evalJs(`document.body.textContent.includes('Composio (tích hợp thêm, opt-in)')`),
    true,
    'Composio section title renders',
  );
  assert.equal(await evalJs(`!!document.querySelector('[data-testid="composio-loading"]')`), false, 'no Composio loading line once the state arrived');
  assert.equal(await evalJs(`!!document.querySelector('[data-testid="composio-empty"]')`), false, 'no Composio empty state when the state arrived');
});
