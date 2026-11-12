/**
 * CDP smoke for v0.67a — MCP marketplace: search / tag filter /
 * per-server "View tools" panel, in the REAL Electron app under xvfb.
 *
 * Drives the MCP marketplace screen in the production build:
 * - Creates the sample bot from onboarding, opens MCP marketplace
 *   from the nav menu (registry pre-seeded with a fake stdio server
 *   plus a few catalogue entries).
 * - Searches "fake": only the fake server stays listed; clearing the
 *   search brings the others back.
 * - Clicks the "test" tag chip: only the fake server stays; "All"
 *   brings the others back.
 * - Clicks "View tools" on the fake server: the two fake tools
 *   (fake_echo with its `text` param, fake_no_args) appear.
 * - Clicks "View tools" on Brave Search (needs a key): the
 *   needs-key state appears and no probe is attempted.
 *
 * No provider / network is needed; the fake server is a local node
 * script speaking JSON-RPC over stdio. Fails on any uncaught
 * renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other smokes.
 *
 * Run: xvfb-run -a node --test tests/mcp-marketplace-view-v067a-smoke.test.mjs
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
const FAKE_SERVER = path.join(REPO, 'tests', 'mcp-marketplace-probe-fake-server.mjs');
const CDP_PORT = 9800 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-v067a-smoke-xdg-'));
let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const pageExceptions = [];

// Pre-seed the marketplace registry before launch so the catalogue
// holds the fake probe server. userData is <XDG_CONFIG_HOME>/@open-bot/desktop
// for the dev app (package.json name "@open-bot/desktop"); seed the
// packaged name too, in case the app resolves it differently.
const REGISTRY = {
  servers: [
    {
      id: 'fake-tools',
      name: 'Fake Tools',
      description: 'Fake MCP server for the marketplace smoke test.',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_SERVER, 'ok'],
      tags: ['test'],
    },
    {
      id: 'memory',
      name: 'Memory',
      description:
        'Official MCP reference server: a persistent knowledge graph the agent can remember facts in across sessions.',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      tags: ['memory', 'official'],
    },
    {
      id: 'brave-search',
      name: 'Brave Search',
      description: 'Official MCP reference server: web search via the Brave Search API.',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      needsKey:
        'BRAVE_API_KEY — a Brave Search API key (get one at https://brave.com/search/api/); set it as the BRAVE_API_KEY environment variable for this server in .open-bot/mcp.json',
      tags: ['web', 'search'],
    },
  ],
};
for (const appDir of ['@open-bot/desktop', 'open-bot']) {
  const dir = path.join(xdgDir, appDir, 'marketplace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp-servers.json'), JSON.stringify(REGISTRY, null, 2), 'utf8');
}

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

test('smoke: marketplace search + tag filter + View tools on a fake server', { skip: !hasDisplay }, async () => {
  // Fresh profile → onboarding → one-click sample bot.
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  assert.equal(await clickButtonByText('Tạo bot mẫu'), true, 'clicking the sample-bot button');
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear after sample-bot creation',
  );

  // Open MCP marketplace from the nav menu.
  assert.equal(await clickButtonByText('⋯ Menu'), true, 'opening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to open');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-nav-key="mcp"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking MCP marketplace in the menu',
  );
  await waitFor(`document.body.textContent.includes('Fake Tools')`, 15_000, 'fake server to list');

  // Search: only the fake server matches "fake". (The page has other
  // search boxes — bot list, threads — so select this one by test id.)
  assert.equal(await typeInto('[data-testid="mcp-marketplace-search"]', 'fake'), true, 'typing into the search box');
  await waitFor(
    `(() => { const t = [...document.querySelectorAll('.panel .card h3')].map((h) => h.textContent); return t.length === 1 && t[0].includes('Fake Tools'); })()`,
    10_000,
    'search "fake" to leave only the fake server',
  );
  assert.equal(await typeInto('[data-testid="mcp-marketplace-search"]', ''), true, 'clearing the search box');
  await waitFor(
    `[...document.querySelectorAll('.panel .card h3')].some((h) => h.textContent.includes('Memory'))`,
    10_000,
    'Memory server to come back after clearing the search',
  );

  // Tag chip: "test" leaves only the fake server; "All" restores the list.
  assert.equal(await clickButtonByText('test'), true, 'clicking the test tag chip');
  await waitFor(
    `(() => { const t = [...document.querySelectorAll('.panel .card h3')].map((h) => h.textContent); return t.length === 1 && t[0].includes('Fake Tools'); })()`,
    10_000,
    'tag "test" to leave only the fake server',
  );
  assert.equal(await clickButtonByText('Tất cả'), true, 'clicking the All tag chip');
  await waitFor(
    `[...document.querySelectorAll('.panel .card h3')].some((h) => h.textContent.includes('Brave Search'))`,
    10_000,
    'Brave Search to come back after selecting All tags',
  );

  // View tools on the fake server: both fake tools + the `text` param show up.
  assert.equal(await clickButtonByText('Xem tools'), true, 'clicking View tools on the fake server');
  await waitFor(`document.body.textContent.includes('fake_echo')`, 20_000, 'fake_echo tool to appear');
  await waitFor(`document.body.textContent.includes('fake_no_args')`, 10_000, 'fake_no_args tool to appear');
  assert.ok(
    await evalJs(`document.body.textContent.includes('text')`),
    'the fake_echo text param is shown',
  );

  // View tools on Brave Search (needs a key): needs-key state, no probe.
  assert.equal(
    await evalJs(`(() => {
      const card = [...document.querySelectorAll('.panel .card')].find((c) => c.textContent.includes('Brave Search'));
      if (!card) return false;
      const b = [...card.querySelectorAll('button')].find((el) => el.textContent.includes('Xem tools'));
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`),
    true,
    'clicking View tools on Brave Search',
  );
  await waitFor(
    `document.body.textContent.includes('cần credential')`,
    20_000,
    'needs-key state to appear for Brave Search',
  );
});
