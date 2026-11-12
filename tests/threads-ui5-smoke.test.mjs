/**
 * CDP smoke test for threads / conversation list + search (UI-5, v0.59).
 *
 * Launches the REAL Electron app (apps/desktop, production build) under
 * xvfb with an isolated XDG_CONFIG_HOME, then drives the real UI:
 *   1. fresh profile shows onboarding (v0.61: no silent default bot) —
 *      one click creates the sample bot; the sidebar shows the bot and
 *      its auto-created default thread
 *   2. create a second thread from the sidebar — 2 thread rows
 *   3. seed a message into the second thread (sendChat saves the user
 *      message even though the run fails without an API key) — after a
 *      reload the thread is auto-titled from that message
 *   4. resume: clicking each thread loads exactly its messages
 *      (thread 1: empty chat; thread 2: the seeded message)
 *   5. search "phở" — only the seeded thread matches; clearing the
 *      query restores both rows
 *   6. delete the seeded thread through the in-app confirm modal —
 *      only the default thread remains
 *
 * Clicks/typing go through CDP `Runtime.evaluate` on the real DOM
 * (no xdotool: this flow has no native dialog, so DOM clicks exercise
 * the same React handlers a real click would). No mocks: threads,
 * search and persistence are the production build.
 *
 * Run under xvfb (needs a real X display):
 *   xvfb-run -a node --test tests/threads-ui5-smoke.test.mjs
 * Without DISPLAY the file skips with a clear message (same convention
 * as tests/settings-ui4-smoke.test.mjs).
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
const CDP_PORT = 9500 + (process.pid % 500);
const JS_TIMEOUT_MS = 5000;

/**
 * v0.93c — root cause of the threads-ui5 flake (measured, not guessed).
 *
 * The flake signature was `timed out waiting for: default thread row
 * (last: false)` (full-suite runs v0.92-merge2 + a local repro at load
 * 7.3). Probing the real flow under load (probe /tmp/flake93-probe-ui5.mjs,
 * load 8.6–12) showed the renderer was HEALTHY the whole time — every
 * poll answered in ≤106ms returning false — but the default thread row
 * genuinely took 8.2s / 13.2s / 17.0s to appear after clicking
 * 'Tạo bot mẫu'. The chain is main-process bound: createSampleBot does
 * listTemplates IPC → createBot IPC → React state flip → bot-switch
 * effect → listThreads IPC (BotMemory SQLite creates the default thread)
 * → render, and under contention each main-process hop stretches. The
 * old 10s waitFor therefore failed a healthy app. 30s below is >1.7x
 * the worst measured 17.0s; every other step in this file measured
 * ≤400ms under the same load, so only this one deadline moves.
 *
 * Second bug in the same area: evalJs used to resolve
 * `{ __blocked: true }` on timeout — a TRUTHY value — and waitFor
 * treated any truthy value as "condition met", so a timed-out poll
 * could fake a pass and fail later with a misleading assert. The
 * sentinel below is a symbol; waitFor treats it as "renderer busy,
 * not ready yet" and keeps polling until the real deadline.
 */
const EVAL_BUSY = Symbol('cdp-evaluate-busy');
const isEvalBusy = (v) => v === EVAL_BUSY;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child = null;
let ws = null;
let msgId = 0;
const pending = new Map();
let xdgDir = '';

function evalJs(expression, timeoutMs = JS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      // v0.93c: resolve the EVAL_BUSY sentinel, never a truthy object —
      // a slow renderer means "busy, retry", not a value. Polling loops
      // treat it as not-ready; direct callers fail honestly (see below).
      pending.delete(id);
      resolve(EVAL_BUSY);
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
  await waitForMount();
}

async function waitForMount() {
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

async function waitFor(expression, timeoutMs = 10_000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let busyPolls = 0;
  while (Date.now() < deadline) {
    last = await evalJs(expression);
    // v0.93c: a timed-out evaluate is "renderer busy", NOT success —
    // keep polling until the real deadline.
    if (isEvalBusy(last)) { busyPolls++; }
    else if (last) return last;
    await sleep(300);
  }
  assert.fail(`timed out waiting for: ${label} (last: ${JSON.stringify(last)}; slow-evaluate polls: ${busyPolls})`);
}

/** Click the first button whose text contains `text`. */
async function clickButton(text) {
  const ok = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  // v0.93c: a busy renderer is not "button not found" — say so honestly
  // instead of failing the step with a misleading message.
  assert.ok(!isEvalBusy(ok), `CDP evaluate timed out (renderer busy under load) while clicking button ${JSON.stringify(text)}`);
  assert.equal(ok, true, `button containing ${JSON.stringify(text)} not found`);
  await sleep(500);
}

/** Click a button by its title attribute (icon buttons). */
async function clickButtonByTitle(title) {
  const ok = await evalJs(`(() => {
    const b = document.querySelector('button[title=' + JSON.stringify(${JSON.stringify(title)}) + ']');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  assert.ok(!isEvalBusy(ok), `CDP evaluate timed out (renderer busy under load) while clicking button[title=${JSON.stringify(title)}]`);
  assert.equal(ok, true, `button[title=${JSON.stringify(title)}] not found`);
  await sleep(500);
}

/** Type into an input found by testid (React controlled input). */
async function setInputByTestId(testId, value) {
  const got = await evalJs(`(() => {
    const input = document.querySelector('[data-testid="${testId}"]');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  assert.ok(!isEvalBusy(got), `CDP evaluate timed out (renderer busy under load) while typing into [data-testid="${testId}"]`);
  assert.equal(got, value, `input [data-testid="${testId}"] not found or value did not stick`);
  await sleep(500);
}

async function threadRowTitles() {
  return evalJs(`[...document.querySelectorAll('[data-testid="thread-row"]')].map((row) => row.textContent.trim())`);
}

async function threadRowCount() {
  return evalJs(`document.querySelectorAll('[data-testid="thread-row"]').length`);
}

async function reloadPage() {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method: 'Page.reload', params: {} }));
  await sleep(1000);
  await waitForMount();
  await sleep(1000);
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
  xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui5-smoke-xdg-'));
  await launchApp();
});

after(async () => {
  await quitApp();
  if (xdgDir) fs.rmSync(xdgDir, { recursive: true, force: true });
});

test('UI-5 smoke: thread list, create, resume, search, delete', async (t) => {
  if (skipWithoutDisplay(t)) return;

  // Fresh profile (v0.61: no silent default bot any more — first run
  // shows onboarding): create the sample bot in one click, then its
  // sidebar shows the auto-created default thread.
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  await clickButton('Tạo bot mẫu');
  await waitFor(`document.querySelector('[data-testid="thread-new"]') !== null`, 10_000, 'thread section');
  await waitFor(`document.body.textContent.includes('Trợ lý mẫu')`, 10_000, 'sample bot');
  const bots = await evalJs(`window.openBot.listBots()`);
  assert.ok(Array.isArray(bots) && bots.length >= 1, `expected a seeded bot, got ${JSON.stringify(bots)}`);
  const bot = bots[0];
  // v0.93c: 30s, not 10s — the default thread row is main-process bound
  // (createBot IPC → bot-switch effect → listThreads IPC → SQLite
  // default-thread creation → render) and measured 8.2s @ load 8.6,
  // 13.2s @ load ~12, 17.0s @ load ~9. 10s failed a healthy app.
  await waitFor(`document.querySelectorAll('[data-testid="thread-row"]').length === 1`, 30_000, 'default thread row');
  assert.equal(await threadRowCount(), 1, 'a new bot must have exactly its default thread');
  assert.ok(
    (await threadRowTitles()).some((title) => title.includes('Cuộc trò chuyện mới')),
    `default thread must be titled 'Cuộc trò chuyện mới', got ${JSON.stringify(await threadRowTitles())}`,
  );

  // Create a second thread from the sidebar.
  await clickButton('Hội thoại mới');
  await waitFor(`document.querySelectorAll('[data-testid="thread-row"]').length === 2`, 10_000, 'second thread row');
  assert.equal(await threadRowCount(), 2);

  // Seed a message into the second (newest) thread. The run has no API
  // key and takes over a minute to fail (provider retries), so the
  // send is fired WITHOUT awaiting it: main saves the user message
  // into the thread before the run starts, which is all this needs.
  const threads = await evalJs(`window.openBot.listThreads(${JSON.stringify(bot.id)})`);
  assert.equal(threads.length, 2, `expected 2 threads, got ${JSON.stringify(threads)}`);
  const second = threads[0];
  await evalJs(
    `window.openBot.sendChat(${JSON.stringify(bot.id)}, 'phở bò smoke test', ${JSON.stringify(second.id)}); 'fired'`,
  );
  await sleep(3000);
  await reloadPage();

  // After reload the second thread is auto-titled from its first message.
  await waitFor(`document.body.textContent.includes('phở bò smoke test')`, 10_000, 'auto-titled thread');
  let titles = await threadRowTitles();
  assert.ok(titles.some((title) => title.includes('phở bò smoke test')), `second thread must be auto-titled, got ${JSON.stringify(titles)}`);

  // Resume: the default thread loads an empty chat; the seeded thread
  // loads exactly its message (not the bot's whole history).
  await clickButton('Cuộc trò chuyện mới');
  await waitFor(`document.querySelectorAll('.msg').length === 0`, 10_000, 'default thread shows empty chat');
  await clickButton('phở bò smoke test');
  await waitFor(`document.body.textContent.includes('phở bò smoke test')`, 10_000, 'seeded thread shows its message');
  const chatHasSeed = await evalJs(`[...document.querySelectorAll('.msg.user')].some((el) => el.textContent.includes('phở bò smoke test'))`);
  assert.equal(chatHasSeed, true, 'resuming the seeded thread must show its user message');

  // Search "phở": only the seeded thread matches; clearing restores both.
  await setInputByTestId('thread-search', 'phở');
  await waitFor(`document.querySelectorAll('[data-testid="thread-row"]').length === 1`, 10_000, 'search narrows to 1 row');
  titles = await threadRowTitles();
  assert.ok(titles[0].includes('phở bò smoke test'), `search hit must be the seeded thread, got ${JSON.stringify(titles)}`);
  await setInputByTestId('thread-search', '');
  await waitFor(`document.querySelectorAll('[data-testid="thread-row"]').length === 2`, 10_000, 'clearing search restores 2 rows');

  // Delete the seeded thread through the in-app confirm modal (no
  // window.confirm): the modal names the thread, Delete removes only it.
  await clickButton('phở bò smoke test');
  await clickButtonByTitle('Xoá hội thoại');
  await waitFor(`document.body.textContent.includes('Xoá hội thoại “phở bò smoke test”?')`, 10_000, 'delete confirm modal');
  await clickButton('Xoá hội thoại');
  await waitFor(`document.querySelectorAll('[data-testid="thread-row"]').length === 1`, 10_000, 'one thread left after delete');
  titles = await threadRowTitles();
  assert.ok(titles.some((title) => title.includes('Cuộc trò chuyện mới')), `default thread must survive, got ${JSON.stringify(titles)}`);
  assert.ok(!titles.some((title) => title.includes('phở bò')), `deleted thread must be gone, got ${JSON.stringify(titles)}`);
});
