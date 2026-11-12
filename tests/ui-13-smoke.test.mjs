/**
 * CDP smoke for UI-13 (v0.61) — the REAL Electron app under xvfb.
 *
 * Drives the new UI in the production build:
 * - Nav menu: the sidebar bottom is ONE "⋯ Menu" button; opening it
 *   lists all 10 destinations; picking Settings opens Settings and
 *   closes the menu.
 * - Manual theme: Settings → General → theme select Dark sets
 *   `data-theme="dark"` on <html> and survives a reload; Light sets
 *   `data-theme="light"`.
 * - Command palette: Ctrl+K opens it; typing filters to a screen and
 *   Enter opens it; typing the bot name and Enter jumps to its chat;
 *   Esc closes the palette. Typing `/hello` picks the slash command
 *   from a second bot's real registry and inserts it into the
 *   composer (the palette → composer seam).
 * - Delete-bot modal: the bot-row 🗑️ opens the in-app confirm modal
 *   (no native dialog); Esc cancels and the bot stays; confirming
 *   deletes the bot.
 * - Cron builder: the Automations cron form shows the visual builder
 *   with a plain-language summary; the "Every hour" preset composes
 *   `0 * * * *`.
 * - Bot colour: editing the sample bot and picking the violet swatch
 *   turns its sidebar + chat-header avatar violet (#7c3aed).
 *
 * No live run is needed (the sample bot has no key); everything here
 * is UI state. Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other smokes.
 *
 * Run: xvfb-run -a node --test tests/ui-13-smoke.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP_DEADLINE_MS } from './cdp-deadline.mjs';
import { createCdpHarness } from './cdp-wait.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const CDP_PORT = 9600 + (process.pid % 400);

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-ui13-smoke-xdg-'));
// Smoke workspaces must sit under an allowed root (~/workspace).
const WORKSPACE_ROOT = path.join(os.homedir(), 'workspace');
const slashWs = path.join(WORKSPACE_ROOT, `open-bot-ui13-slash-${process.pid}`);
let child = null;
let ws = null;
const pageExceptions = [];

// v0.94b: shared CDP harness (tests/cdp-wait.mjs) — 5s evaluate
// attempts retried until the step deadline, EVAL_BUSY sentinel (a
// timeout is never a pass). Direct callers use evalJsStrict, which
// throws honestly on a slow renderer instead of returning a value
// an assert would misread. The closure reads the CURRENT ws, so the
// reloadApp reconnect keeps working.
const cdp = createCdpHarness((text) => ws.send(text));
const { evalJsStrict, waitFor } = cdp;

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
      const main = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (main) { pageUrl = main.webSocketDebuggerUrl; break; }
    } catch {
      // DevTools not up yet.
    }
    await sleep(500);
  }
  assert.ok(pageUrl, `CDP page target (index.html) did not appear in ${CDP_DEADLINE_MS / 1000}s`);
  await attachWs(pageUrl);
  cdp.send('Runtime.enable');
  // v0.94b: mount poll via the shared waitFor — short 5s attempts
  // retried until the unchanged 30s deadline (the old single 15s
  // evaluate could abort the whole wait, same bug as tts-voice v0.93c).
  await waitFor(
    `document.getElementById('root')?.children.length ?? 0`,
    30_000,
    'React to mount in the app window',
  );
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

async function reloadApp() {
  try {
    cdp.send('Runtime.evaluate', { expression: 'location.reload()', returnByValue: true });
  } catch { /* socket drops on navigation — expected */ }
  await sleep(2000);
  cdp.clearPending();
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

async function clickButtonByText(text) {
  return evalJsStrict(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(${JSON.stringify(text)}));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

/** Set a React-controlled <select> value (native setter + change event). */
async function setSelect(selector, value) {
  return evalJsStrict(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

/** Type into a React-controlled <input> (native setter + input event). */
async function typeIntoInput(selector, text) {
  return evalJsStrict(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function dispatchKey(targetSelector, key, extra = {}) {
  return evalJsStrict(`(() => {
    const target = ${targetSelector ? `document.querySelector(${JSON.stringify(targetSelector)})` : 'document.body'};
    if (!target) return false;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }));
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
  fs.rmSync(slashWs, { recursive: true, force: true });
});

test('smoke UI-13: nav menu, theme, palette, delete modal, cron builder', { skip: !hasDisplay }, async () => {
  // Fresh profile → onboarding → one-click sample bot (the UI-10 flow
  // the rest of this test builds on).
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  assert.equal(await clickButtonByText('Tạo bot mẫu'), true, 'clicking the sample-bot button');
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear after sample-bot creation',
  );

  // --- Nav menu: one button, 14 destinations, pick Settings. ---
  // v0.90a (Đội G): thêm 'eventlog' (harness event log) → 13 → 14.
  assert.equal(
    await evalJsStrict(`document.querySelectorAll('.sidebar > button.btn.secondary').length`),
    0,
    'no loose nav buttons left at the sidebar bottom',
  );
  assert.equal(await clickButtonByText('⋯ Menu'), true, 'opening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to open');
  const navKeys = await evalJsStrict(`[...document.querySelectorAll('[data-testid="sidebar-nav-dropdown"] [data-nav-key]')].map((b) => b.getAttribute('data-nav-key')).sort().join(',')`);
  assert.equal(
    navKeys,
    'a2a,automations,canvas,computers,connected-apps,eventlog,fleet,group,marketplace,mcp,settings,skills,team,tools',
    `dropdown must list all 14 destinations, got ${navKeys}`,
  );
  assert.equal(
    await evalJsStrict(`(() => { const b = document.querySelector('[data-nav-key="settings"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking Settings in the menu',
  );
  await waitFor(`!!document.querySelector('[data-testid="theme-select"]')`, 15_000, 'Settings General tab with the theme select');
  assert.equal(
    await evalJsStrict(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`),
    false,
    'menu must close after picking a destination',
  );

  // --- Theme: Dark applies + survives reload; Light applies. ---
  assert.equal(await setSelect('[data-testid="theme-select"]', 'dark'), true, 'choosing Dark');
  assert.equal(
    await evalJsStrict(`document.documentElement.getAttribute('data-theme')`),
    'dark',
    'data-theme must be dark after picking Dark',
  );
  await reloadApp();
  await waitFor(`!!document.querySelector('.chat-input textarea')`, 30_000, 'chat input after reload');
  assert.equal(
    await evalJsStrict(`document.documentElement.getAttribute('data-theme')`),
    'dark',
    'data-theme must still be dark after reload (persisted choice)',
  );
  assert.equal(
    await evalJsStrict(`localStorage.getItem('open-bot:theme')`),
    'dark',
    'theme choice must be stored in localStorage',
  );
  assert.equal(await clickButtonByText('⋯ Menu'), true, 'reopening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to reopen');
  assert.equal(
    await evalJsStrict(`(() => { const b = document.querySelector('[data-nav-key="settings"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking Settings again',
  );
  await waitFor(`!!document.querySelector('[data-testid="theme-select"]')`, 15_000, 'theme select again');
  assert.equal(await setSelect('[data-testid="theme-select"]', 'light'), true, 'choosing Light');
  assert.equal(
    await evalJsStrict(`document.documentElement.getAttribute('data-theme')`),
    'light',
    'data-theme must be light after picking Light',
  );
  assert.equal(await setSelect('[data-testid="theme-select"]', 'system'), true, 'back to System');
  assert.equal(
    await evalJsStrict(`document.documentElement.getAttribute('data-theme')`),
    null,
    'data-theme must be gone again in System mode',
  );

  // --- Palette: Ctrl+K → filter to a screen → Enter opens it. ---
  assert.equal(await dispatchKey(null, 'k', { ctrlKey: true }), true, 'dispatching Ctrl+K');
  await waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, 10_000, 'palette to open on Ctrl+K');
  assert.equal(await typeIntoInput('[data-testid="command-palette-input"]', 'tự động'), true, 'typing in the palette');
  await waitFor(
    `(() => { const items = [...document.querySelectorAll('.palette-item-label')].map((el) => el.textContent); return items.some((t) => t.includes('Tự động')); })()`,
    10_000,
    'palette to filter to Automations',
  );
  assert.equal(await dispatchKey('[data-testid="command-palette-input"]', 'Enter'), true, 'pressing Enter in the palette');
  await waitFor(
    `!document.querySelector('[data-testid="command-palette"]') && document.body.textContent.includes('Tự động hoá')`,
    15_000,
    'palette to close and Automations view to open',
  );

  // --- Palette: Ctrl+K → bot name → Enter jumps to its chat. ---
  assert.equal(await dispatchKey(null, 'k', { ctrlKey: true }), true, 'dispatching Ctrl+K again');
  await waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, 10_000, 'palette to reopen');
  assert.equal(await typeIntoInput('[data-testid="command-palette-input"]', 'mẫu'), true, 'typing the bot name');
  await waitFor(
    `[...document.querySelectorAll('.palette-item-label')].some((el) => el.textContent.includes('Trợ lý mẫu'))`,
    10_000,
    'palette to show the sample bot',
  );
  assert.equal(await dispatchKey('[data-testid="command-palette-input"]', 'Enter'), true, 'pressing Enter on the bot row');
  await waitFor(
    `!document.querySelector('[data-testid="command-palette"]') && !!document.querySelector('.chat-input textarea')`,
    15_000,
    'palette to close and chat to show',
  );

  // --- Palette: Esc closes it. ---
  assert.equal(await dispatchKey(null, 'k', { ctrlKey: true }), true, 'dispatching Ctrl+K a third time');
  await waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, 10_000, 'palette to open a third time');
  assert.equal(await dispatchKey('[data-testid="command-palette-input"]', 'Escape'), true, 'pressing Esc in the palette');
  await waitFor(`!document.querySelector('[data-testid="command-palette"]')`, 10_000, 'palette to close on Esc');

  // --- Palette slash insert: a second bot with a real command seeded in
  // its explicit workspace; pick /hello in the palette, the composer
  // must get `/hello `. (The seam is the new externalInsert path — the
  // composer popup already proved slash insertion in the UI-6 smoke;
  // this proves the palette path.)
  const slashCmdDir = path.join(slashWs, '.open-bot', 'commands');  fs.mkdirSync(slashCmdDir, { recursive: true });
  fs.writeFileSync(
    path.join(slashCmdDir, 'hello.md'),
    '# Say hello in Vietnamese\n\nSay hello to the user in Vietnamese, warmly and briefly.\n',
  );
  const slashBot = await evalJsStrict(
    `window.openBot.createBot({ name: 'Smoke Slash', providerId: 'ollama', model: 'qwen2.5:0.5b', workspaceDir: ${JSON.stringify(slashWs)}, systemPrompt: 'You are a test bot.' })`,
  );
  assert.ok(slashBot?.id, 'creating the slash bot via IPC');
  await waitFor(
    `[...document.querySelectorAll('[data-testid="bot-row"]')].some((el) => el.textContent.includes('Smoke Slash'))`,
    15_000,
    'slash bot to appear in the sidebar',
  );
  assert.equal(
    await evalJsStrict(`(() => { const b = document.querySelector('button[title="Smoke Slash"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'selecting the slash bot in the sidebar',
  );
  await waitFor(`!!document.querySelector('.chat-input textarea')`, 15_000, 'chat to show for the slash bot');
  assert.equal(await dispatchKey(null, 'k', { ctrlKey: true }), true, 'dispatching Ctrl+K for the slash pick');
  await waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, 10_000, 'palette to open for the slash pick');
  assert.equal(await typeIntoInput('[data-testid="command-palette-input"]', '/hello'), true, 'typing /hello in the palette');
  // v0.94b — root cause of the cluster flake (measured, not guessed):
  // the /hello row only appears once the palette's `slash:list` IPC
  // returns, and that call creates the slash bot's runtime first
  // (main.ts `getOrCreateRuntime(bot)` — the bot never ran before).
  // That cold runtime creation is CPU-bound and stretches hard under
  // load: probe /tmp/probe94-ui13.mjs, no-warm (the palette's own call
  // is the cold one, exactly like this test): the row took 31.2s /
  // 23.8s / 27.9s under hog load 6.6–26.5, while EVERY other step in
  // the file measured ≤808ms under the same load; the direct
  // `listSlashCommands` IPC measured 2.4s solo, 18.1–19.9s at load
  // 7–12. The renderer stayed responsive the whole time (polls
  // 2–165ms) — the app is healthy, the 10s deadline was just shorter
  // than the cold IPC. 60s is ~1.9x the worst measured 31.2s (same
  // 1.7–1.9x rule as threads-ui5 v0.93c: 17.0s → 30s); no other
  // deadline in this file moves.
  await waitFor(
    `[...document.querySelectorAll('.palette-item-label')].some((el) => el.textContent === '/hello')`,
    60_000,
    'palette to show the /hello command from the registry',
  );
  assert.equal(await dispatchKey('[data-testid="command-palette-input"]', 'Enter'), true, 'Enter on the /hello row');
  await waitFor(
    `!document.querySelector('[data-testid="command-palette"]') && document.querySelector('.chat-input textarea')?.value === '/hello '`,
    15_000,
    'palette to close and composer to contain "/hello "',
  );
  // Clear the composer for the sections below.
  await evalJsStrict(`(() => {
    const ta = document.querySelector('.chat-input textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  // --- Cron builder: Automations → cron trigger → builder + summary. ---
  assert.equal(await clickButtonByText('⋯ Menu'), true, 'opening the nav menu for Automations');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown for Automations');
  assert.equal(
    await evalJsStrict(`(() => { const b = document.querySelector('[data-nav-key="automations"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking Automations in the menu',
  );
  await waitFor(`!!document.querySelector('#automation-trigger')`, 15_000, 'Automations form');
  assert.equal(await setSelect('#automation-trigger', 'cron'), true, 'choosing the cron trigger');
  await waitFor(`!!document.querySelector('[data-testid="cron-builder"]')`, 10_000, 'cron builder to appear');
  const defaultSummary = await evalJsStrict(`document.querySelector('[data-testid="cron-summary"]')?.textContent ?? ''`);
  assert.ok(
    defaultSummary.includes('Thứ 2') && defaultSummary.includes('09:00'),
    `default cron summary must read as weekdays 09:00, got ${JSON.stringify(defaultSummary)}`,
  );
  assert.equal(await clickButtonByText('Mỗi giờ'), true, 'clicking the hourly preset');
  await waitFor(
    `document.querySelector('#automation-cron')?.value === '0 * * * *'`,
    10_000,
    'hourly preset to compose 0 * * * *',
  );
  const hourlySummary = await evalJsStrict(`document.querySelector('[data-testid="cron-summary"]')?.textContent ?? ''`);
  assert.ok(
    hourlySummary.includes('Mỗi giờ'),
    `hourly summary must say so, got ${JSON.stringify(hourlySummary)}`,
  );

  // --- Bot colour: edit the sample bot, pick violet, avatar follows. ---
  assert.equal(
    await evalJsStrict(`(() => { const b = document.querySelector('button[title="Sửa bot"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'opening the bot edit form',
  );
  await waitFor(
    `[...document.querySelectorAll('.modal [data-color]')].length === 8`,
    10_000,
    '8 colour swatches in the form',
  );
  assert.equal(
    await evalJsStrict(`(() => { const s = document.querySelector('.modal [data-color="#7c3aed"]'); if (!s) return false; s.click(); return true; })()`),
    true,
    'picking the violet swatch',
  );
  assert.equal(
    await evalJsStrict(`(() => { const b = [...document.querySelectorAll('.modal .btn')].find((el) => el.textContent.trim() === 'Lưu'); if (!b || b.disabled) return false; b.click(); return true; })()`),
    true,
    'saving the bot form',
  );
  await waitFor(
    `(() => { const av = document.querySelector('[data-testid="bot-avatar"]'); return av && getComputedStyle(av).backgroundColor === 'rgb(124, 58, 237)'; })()`,
    15_000,
    'sidebar avatar to turn violet (#7c3aed)',
  );
  const avatarLetter = await evalJsStrict(`document.querySelector('[data-testid="bot-avatar"]')?.textContent ?? ''`);
  assert.equal(avatarLetter, 'T', `avatar must show the bot initial, got ${JSON.stringify(avatarLetter)}`);
  // saveBot does not switch views (the edit started from Automations),
  // so jump back to chat first, then check the header avatar there.
  assert.equal(await dispatchKey(null, 'k', { ctrlKey: true }), true, 'dispatching Ctrl+K to go back to chat');
  await waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, 10_000, 'palette to open for the way back');
  assert.equal(await typeIntoInput('[data-testid="command-palette-input"]', 'mẫu'), true, 'typing the bot name');
  await waitFor(
    `[...document.querySelectorAll('.palette-item-label')].some((el) => el.textContent.includes('Trợ lý mẫu'))`,
    10_000,
    'palette to show the sample bot',
  );
  assert.equal(await dispatchKey('[data-testid="command-palette-input"]', 'Enter'), true, 'Enter on the bot row');
  await waitFor(`!!document.querySelector('.chat-input textarea')`, 15_000, 'chat to show');
  assert.equal(
    await evalJsStrict(`(() => { const av = document.querySelector('.chat-header .bot-avatar'); return av ? getComputedStyle(av).backgroundColor : null; })()`),
    'rgb(124, 58, 237)',
    'chat header avatar must match the picked colour',
  );

  // --- Delete-bot modal: Esc cancels (bot stays), confirm deletes. ---
  // Back to chat first (the bot row lives in the sidebar either way,
  // but the chat header proves which bot is selected).
  assert.equal(await dispatchKey(null, 'k', { ctrlKey: true }), true, 'dispatching Ctrl+K for the way back');
  await waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, 10_000, 'palette for the way back');
  assert.equal(await typeIntoInput('[data-testid="command-palette-input"]', 'mẫu'), true, 'typing the bot name again');
  await waitFor(
    `[...document.querySelectorAll('.palette-item-label')].some((el) => el.textContent.includes('Trợ lý mẫu'))`,
    10_000,
    'palette to show the sample bot again',
  );
  assert.equal(await dispatchKey('[data-testid="command-palette-input"]', 'Enter'), true, 'Enter on the bot row');
  await waitFor(`!!document.querySelector('.chat-input textarea')`, 15_000, 'chat to show again');
  assert.equal(
    await evalJsStrict(`(() => { const row = [...document.querySelectorAll('[data-testid="bot-row"]')].find((el) => el.textContent.includes('Trợ lý mẫu')); const b = row?.querySelector('button[title="Xoá bot"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'clicking the bot delete button',
  );
  await waitFor(`!!document.querySelector('[data-testid="delete-bot-modal"]')`, 10_000, 'delete modal to open');
  const modalText = await evalJsStrict(`document.querySelector('[data-testid="delete-bot-modal"]')?.textContent ?? ''`);
  assert.ok(modalText.includes('Trợ lý mẫu'), `modal must name the bot, got ${JSON.stringify(modalText)}`);
  assert.equal(await dispatchKey(null, 'Escape'), true, 'pressing Esc with the modal open');
  await waitFor(`!document.querySelector('[data-testid="delete-bot-modal"]')`, 10_000, 'modal to close on Esc');
  assert.equal(
    await evalJsStrict(`document.body.textContent.includes('Trợ lý mẫu')`),
    true,
    'bot must still exist after Esc-cancel',
  );
  assert.equal(
    await evalJsStrict(`(() => { const row = [...document.querySelectorAll('[data-testid="bot-row"]')].find((el) => el.textContent.includes('Trợ lý mẫu')); const b = row?.querySelector('button[title="Xoá bot"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'clicking the bot delete button again',
  );
  await waitFor(`!!document.querySelector('[data-testid="delete-bot-modal"]')`, 10_000, 'delete modal to reopen');
  assert.equal(
    await evalJsStrict(`(() => { const b = document.querySelector('[data-testid="delete-bot-confirm"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'confirming the delete',
  );
  await waitFor(
    `!document.querySelector('[data-testid="delete-bot-modal"]') && !document.body.textContent.includes('Trợ lý mẫu')`,
    15_000,
    'bot to be gone after confirm',
  );

  assert.deepEqual(pageExceptions, [], `no uncaught renderer exceptions (saw: ${pageExceptions.join(' | ')})`);
});
