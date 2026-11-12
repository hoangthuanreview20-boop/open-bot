/**
 * CDP smoke for the v0.64 ConfirmModal + automation run history — the
 * REAL Electron app under xvfb.
 *
 * Drives the Automations screen in the production build:
 * - Creates a notify automation through the UI, runs it now, and checks
 *   the new "Run history" tab lists the run (status ok) and the detail
 *   panel shows its log text (`Notified: ...`).
 * - Deletes the automation: the in-app confirm modal opens (no native
 *   dialog); Cancel leaves the automation in place; confirming deletes
 *   it. This is the behavioural check for ConfirmModal — Cancel runs
 *   nothing, Confirm runs the action.
 *
 * No live run is needed (a notify action needs no provider); everything
 * here is UI state. Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other smokes.
 *
 * Run: xvfb-run -a node --test tests/confirm-modal-automations-smoke.test.mjs
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
const CDP_PORT = 9800 + (process.pid % 400);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-confirm-smoke-xdg-'));
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

async function clickButtonByText(text) {
  return evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(${JSON.stringify(text)}));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

/** Click an element by test id (returns false when absent/disabled). */
async function clickTestId(testId) {
  return evalJs(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`);
}

/** Type into a React-controlled <input>/<textarea> (native setter + input event). */
async function typeInto(selector, text) {
  return evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
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

test('smoke: run history tab + confirm modal on automation delete', { skip: !hasDisplay }, async () => {
  // Fresh profile → onboarding → one-click sample bot.
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  assert.equal(await clickButtonByText('Tạo bot mẫu'), true, 'clicking the sample-bot button');
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear after sample-bot creation',
  );

  // Open Automations from the nav menu.
  assert.equal(await clickButtonByText('⋯ Menu'), true, 'opening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to open');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-nav-key="automations"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking Automations in the menu',
  );
  await waitFor(`!!document.querySelector('#automation-name')`, 15_000, 'automation create form');

  // Create a notify automation (defaults: interval trigger, notify action).
  assert.equal(await typeInto('#automation-name', 'Smoke Notify'), true, 'typing the automation name');
  assert.equal(await typeInto('#automation-message', 'smoke hi'), true, 'typing the notify message');
  assert.equal(await clickTestId('automation-create'), true, 'clicking create');
  await waitFor(`document.body.textContent.includes('Smoke Notify')`, 10_000, 'automation card to appear');

  // Run it now, then check the history tab.
  assert.equal(await clickTestId('automation-run-now'), true, 'clicking run now');
  assert.equal(await clickTestId('automations-tab-history'), true, 'opening the history tab');
  await waitFor(
    `!!document.querySelector('[data-testid="run-history-row"][data-run-status="ok"]')`,
    15_000,
    'history row with ok status',
  );
  const rowText = await evalJs(`document.querySelector('[data-testid="run-history-row"]')?.textContent ?? ''`);
  assert.ok(rowText.includes('Smoke Notify'), `history row names the automation, got: ${rowText}`);

  // Detail panel shows the run log.
  assert.equal(await clickTestId('run-history-row'), true, 'clicking the history row');
  await waitFor(`!!document.querySelector('[data-testid="run-history-detail"]')`, 10_000, 'detail panel to open');
  const detailText = await evalJs(`document.querySelector('[data-testid="run-history-detail"]')?.textContent ?? ''`);
  assert.ok(detailText.includes('Notified: smoke hi'), `detail shows the run output, got: ${detailText.slice(0, 300)}`);

  // Delete: Cancel first — the automation must stay.
  assert.equal(await clickTestId('automations-tab-list'), true, 'back to the automation list');
  assert.equal(await clickTestId('automation-delete'), true, 'clicking delete');
  await waitFor(`!!document.querySelector('[data-testid="confirm-modal"]')`, 10_000, 'confirm modal to open');
  const modalText = await evalJs(`document.querySelector('[data-testid="confirm-modal"]')?.textContent ?? ''`);
  assert.ok(modalText.includes('Smoke Notify'), `modal asks about the automation, got: ${modalText.slice(0, 200)}`);
  assert.equal(await clickTestId('confirm-modal-cancel'), true, 'clicking Cancel');
  await waitFor(`!document.querySelector('[data-testid="confirm-modal"]')`, 10_000, 'modal to close on Cancel');
  assert.ok(
    await evalJs(`document.body.textContent.includes('Smoke Notify')`),
    'Cancel must leave the automation in place',
  );

  // Delete again and confirm — the automation must go.
  assert.equal(await clickTestId('automation-delete'), true, 'clicking delete again');
  await waitFor(`!!document.querySelector('[data-testid="confirm-modal"]')`, 10_000, 'confirm modal to reopen');
  assert.equal(await clickTestId('confirm-modal-confirm'), true, 'clicking Confirm');
  await waitFor(`!document.body.textContent.includes('Smoke Notify')`, 10_000, 'automation gone after confirm');
});
