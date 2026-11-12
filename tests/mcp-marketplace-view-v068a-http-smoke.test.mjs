/**
 * CDP smoke for v0.68a — MCP marketplace: HTTP probe live in the REAL
 * Electron app + probe-cache invalidation when the registry changes.
 *
 * Drives the MCP marketplace screen in the production build:
 * - Registry pre-seeded with a fake HTTP server (local Node http
 *   server speaking streamable-HTTP MCP, tools http_echo /
 *   http_no_args) plus Memory and Brave Search.
 * - Creates the sample bot from onboarding, opens MCP marketplace
 *   from the nav menu, clicks "View tools" on the fake HTTP server:
 *   the two HTTP tools appear (live HTTP probe through the real
 *   main-process IPC `mcp-marketplace:tools`).
 * - Then the test rewrites the registry file ON DISK (same server id
 *   `fake-http`, now pointing at a SECOND fake HTTP server whose only
 *   tool is http_alt_only), reloads the renderer so the view drops
 *   its own cached panel, and clicks "View tools" again: the NEW
 *   tool (http_alt_only) appears and the OLD one (http_echo) does
 *   NOT — proving the main-process probe cache was invalidated by the
 *   registry change instead of serving the stale result.
 *
 * No provider / network is needed; both fake servers are local Node
 * scripts on 127.0.0.1. Fails on any uncaught renderer exception.
 *
 * Skips when there is no DISPLAY — same convention as the other smokes.
 *
 * Run: xvfb-run -a node --test tests/mcp-marketplace-view-v068a-http-smoke.test.mjs
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
const FAKE_HTTP_SERVER = path.join(REPO, 'tests', 'mcp-marketplace-probe-fake-http-server.mjs');
const CDP_PORT = 9900 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-v068a-smoke-xdg-'));
let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const pageExceptions = [];
const fakeServers = [];
let httpPortA = 0;
let httpPortB = 0;

function startFakeHttp(mode) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [FAKE_HTTP_SERVER, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fakeServers.push(proc);
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`fake HTTP server (${mode}) did not print READY`)), 10_000);
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/READY (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      resolve();
    }, 3000).unref?.();
  });
}

function registryJson(httpPort) {
  return {
    servers: [
      {
        id: 'fake-http',
        name: 'Fake HTTP',
        description: 'Fake MCP server over streamable HTTP for the marketplace smoke test.',
        transport: 'http',
        url: `http://127.0.0.1:${httpPort}/mcp`,
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
}

function seedRegistry(httpPort) {
  for (const appDir of ['@open-bot/desktop', 'open-bot']) {
    const dir = path.join(xdgDir, appDir, 'marketplace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp-servers.json'),
      JSON.stringify(registryJson(httpPort), null, 2),
      'utf8',
    );
  }
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

/** Click "Xem tools" on the card whose heading contains `name`. */
async function clickToolsOnCard(name) {
  return evalJs(`(() => {
    const card = [...document.querySelectorAll('.panel .card')].find((c) => c.textContent.includes(${JSON.stringify(name)}));
    if (!card) return false;
    const b = [...card.querySelectorAll('button')].find((el) => el.textContent.includes('Xem tools'));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

async function openMarketplace() {
  assert.equal(await clickButtonByText('⋯ Menu'), true, 'opening the nav menu');
  await waitFor(`!!document.querySelector('[data-testid="sidebar-nav-dropdown"]')`, 10_000, 'nav dropdown to open');
  assert.equal(
    await evalJs(`(() => { const b = document.querySelector('[data-nav-key="mcp"]'); if (!b) return false; b.click(); return true; })()`),
    true,
    'picking MCP marketplace in the menu',
  );
  await waitFor(`document.body.textContent.includes('Fake HTTP')`, 15_000, 'fake HTTP server to list');
}

test.before(async () => {
  if (!hasDisplay) return;
  httpPortA = await startFakeHttp('ok');
  httpPortB = await startFakeHttp('ok-alt');
  seedRegistry(httpPortA);
  await launchApp();
});

test.after(async () => {
  await quitApp();
  while (fakeServers.length > 0) {
    await stopServer(fakeServers.pop());
  }
  fs.rmSync(xdgDir, { recursive: true, force: true });
  assert.equal(pageExceptions.length, 0, `renderer threw: ${pageExceptions.slice(0, 3).join('\n')}`);
});

test('smoke: HTTP probe live + cache invalidated after registry rewrite', { skip: !hasDisplay }, async () => {
  // Fresh profile → onboarding → one-click sample bot.
  await waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding on a fresh profile');
  assert.equal(await clickButtonByText('Tạo bot mẫu'), true, 'clicking the sample-bot button');
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear after sample-bot creation',
  );

  // View tools on the fake HTTP server: live HTTP probe, both tools show.
  await openMarketplace();
  assert.equal(await clickToolsOnCard('Fake HTTP'), true, 'clicking View tools on the fake HTTP server');
  await waitFor(`document.body.textContent.includes('http_echo')`, 20_000, 'http_echo tool to appear');
  await waitFor(`document.body.textContent.includes('http_no_args')`, 10_000, 'http_no_args tool to appear');

  // Registry changes on disk: same id, now pointing at server B.
  seedRegistry(httpPortB);

  // Reload the renderer so the view drops its own cached panel; the
  // next "View tools" must go through IPC again. If the main-process
  // cache were still keyed by server id only, it would serve the
  // stale http_echo result here.
  ws.send(JSON.stringify({
    id: nextId++,
    method: 'Runtime.evaluate',
    params: { expression: 'location.reload()', returnByValue: true },
  }));
  await waitForMount();
  await waitFor(
    `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
    30_000,
    'chat to appear again after reload',
  );

  await openMarketplace();
  assert.equal(await clickToolsOnCard('Fake HTTP'), true, 'clicking View tools on the fake HTTP server after reload');
  await waitFor(`document.body.textContent.includes('http_alt_only')`, 20_000, 'http_alt_only tool to appear after registry change');
  assert.equal(
    await evalJs(`document.body.textContent.includes('http_echo')`),
    false,
    'stale http_echo must NOT appear after the registry changed',
  );
});
