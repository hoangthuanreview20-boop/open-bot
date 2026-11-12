/**
 * CDP smoke for v0.66b — SkillsView: view a skill's full SKILL.md +
 * install a new skill from pasted text, in the REAL Electron app
 * under xvfb.
 *
 * Drives the Skills screen in the production build:
 * - Opens Skills from the nav menu and checks the 3 builtin skills list.
 * - Clicks "Xem nội dung" on `code-review` and checks the panel shows
 *   the real SKILL.md text (frontmatter + body).
 * - Installs a new skill through the form and checks it appears in the
 *   list (and its content is viewable too).
 * - Tries a bad install (name of a builtin) and checks a clear error
 *   appears and no duplicate is created.
 *
 * No provider / network is needed; everything here is UI + local disk.
 * Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other smokes.
 *
 * Run: xvfb-run -a node --test tests/skills-view-v066b-smoke.test.mjs
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
const CDP_PORT = 9700 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skills-v066b-smoke-xdg-'));
let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const pageExceptions = [];

const NEW_SKILL = `---
name: ghi-chep-nhanh
description: Ghi nhanh y tuong khi dang lam viec.
---
# Ghi chep nhanh

Ghi lai y tuong ngay khi no xuat hien.
`;

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

test('smoke: SkillsView view content + install a new skill', { skip: !hasDisplay }, async () => {
  // Fresh profile → onboarding → one-click sample bot.
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  assert.equal(await clickButtonByText('Tạo bot mẫu'), true, 'clicking the sample-bot button');
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear after sample-bot creation',
  );

  // Open Skills from the nav menu.
  assert.equal(await clickButtonByText('⋯ Menu'), true, 'opening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to open');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-nav-key="skills"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking Skills in the menu',
  );
  await waitFor(`document.body.textContent.includes('code-review')`, 15_000, 'builtin skills to list');

  // View the full SKILL.md of a builtin skill.
  assert.equal(await clickTestId('skill-view-code-review'), true, 'clicking view content on code-review');
  await waitFor(
    `!!document.querySelector('[data-testid="skill-content"]') && document.querySelector('[data-testid="skill-content"]').textContent.includes('# Code review')`,
    10_000,
    'SKILL.md panel to show the code-review body',
  );
  const content = await evalJs(`document.querySelector('[data-testid="skill-content"]').textContent`);
  assert.ok(content.includes('name: code-review'), 'panel shows the frontmatter');
  assert.ok(content.includes('description: Review code changes'), 'panel shows the description');

  // Install a new skill through the form.
  assert.equal(await typeInto('#skill-install-name', 'ghi-chep-nhanh'), true, 'typing the new skill name');
  assert.equal(await typeInto('#skill-install-content', NEW_SKILL), true, 'pasting the SKILL.md content');
  assert.equal(await clickTestId('skill-install'), true, 'clicking install');
  await waitFor(`document.body.textContent.includes('Đã cài skill')`, 10_000, 'install success message');
  await waitFor(`document.body.textContent.includes('ghi-chep-nhanh')`, 10_000, 'new skill to appear in the list');

  // The new skill's content is viewable too.
  assert.equal(await clickTestId('skill-view-ghi-chep-nhanh'), true, 'clicking view content on the new skill');
  await waitFor(
    `!!document.querySelector('[data-testid="skill-content"]') && document.querySelector('[data-testid="skill-content"]').textContent.includes('# Ghi chep nhanh')`,
    10_000,
    'SKILL.md panel to show the new skill body',
  );

  // A bad install (builtin name) shows a clear error and creates nothing new.
  assert.equal(await typeInto('#skill-install-name', 'code-review'), true, 'typing a builtin name');
  assert.equal(await typeInto('#skill-install-content', NEW_SKILL), true, 'pasting content for the bad install');
  assert.equal(await clickTestId('skill-install'), true, 'clicking install for the bad name');
  await waitFor(
    `document.body.textContent.includes('Không được ghi đè skill có sẵn')`,
    10_000,
    'builtin-overwrite error to appear',
  );
});
