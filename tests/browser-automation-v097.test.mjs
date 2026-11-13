/**
 * Tests for the browser-automation extension added in v0.97 (Team T6):
 * browser_status, browser_reload, browser_wait_for
 * (packages/tools/src/browserAutomation.ts).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/browser-automation-v097.test.mjs
 *
 * A FAKE browser (injected via `createBrowser`) drives every case —
 * no Chromium, no network. The fake can reveal a selector / text
 * after N innerText probes, so browser_wait_for's polling is tested
 * for real instead of only for the already-present case.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createBrowserSession, createBrowserTools } from '../packages/tools/dist/browserAutomation.js';

const tmpDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-bw097-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = (workspaceDir) => ({ workspaceDir, signal: undefined });
const DATA_PAGE =
  'data:text/html,<html><head><title>Fake Page</title></head><body><h1 id="title">Hello</h1><p>static body text</p></body></html>';

// ---------------------------------------------------------------------------
// Fake browser driver (same shape as browser-playwright-v086.test.mjs,
// plus reveal hooks so wait_for can watch something appear)
// ---------------------------------------------------------------------------

function makeFakePage(driverState) {
  const state = {
    url: '',
    title: '',
    bodyText: '',
    elements: new Map(),
    gotoCalls: [],
    innerTextCalls: 0,
    closed: false,
    // { selector, text, afterCalls } — element appears after N probes.
    revealSelector: null,
    // { text, afterCalls } — text appears in the body after N probes.
    revealText: null,
  };
  driverState.pages.push(state);
  const page = {
    _state: state,
    url: () => state.url,
    title: async () => state.title,
    goto: async (url) => {
      state.gotoCalls.push(url);
      state.url = url;
      if (url.startsWith('data:text/html,')) {
        const html = decodeURIComponent(url.slice('data:text/html,'.length));
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        state.title = titleMatch ? titleMatch[1] : '';
        state.bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        state.elements.clear();
        const re = /<[^>]*\sid="([^"]+)"[^>]*>([^<]*)/g;
        let m;
        while ((m = re.exec(html)) !== null) {
          state.elements.set(`#${m[1]}`, { text: (m[2] ?? '').trim(), value: '', clicked: false });
        }
      } else {
        state.title = '';
        state.bodyText = '';
        state.elements.clear();
      }
    },
    click: async (selector) => {
      const el = state.elements.get(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      el.clicked = true;
    },
    fill: async (selector, text) => {
      const el = state.elements.get(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      el.value = text;
    },
    screenshot: async () => Buffer.from('fake-png'),
    innerText: async (selector) => {
      state.innerTextCalls += 1;
      // Reveal hooks fire on probe count, so wait_for sees the page change.
      if (state.revealSelector && state.innerTextCalls >= state.revealSelector.afterCalls) {
        state.elements.set(state.revealSelector.selector, { text: state.revealSelector.text, value: '', clicked: false });
      }
      if (state.revealText && state.innerTextCalls >= state.revealText.afterCalls) {
        if (!state.bodyText.includes(state.revealText.text)) {
          state.bodyText = `${state.bodyText} ${state.revealText.text}`;
        }
      }
      if (selector) {
        const el = state.elements.get(selector);
        if (!el) throw new Error(`element not found: ${selector}`);
        return el.text || el.value;
      }
      return state.bodyText;
    },
    close: async () => {
      state.closed = true;
    },
  };
  return page;
}

function makeFakeLauncher() {
  const driverState = { launches: 0, closed: false, pages: [] };
  const launcher = async () => {
    driverState.launches += 1;
    let page = null;
    return {
      _state: driverState,
      newPage: async () => {
        page = makeFakePage(driverState);
        return page;
      },
      close: async () => {
        driverState.closed = true;
      },
    };
  };
  launcher.state = driverState;
  return launcher;
}

const tool = (name, tools) => tools.find((t) => t.definition.name === name);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('browser v097: 8 tools, new ones have the right approval flags', () => {
  const tools = createBrowserTools();
  assert.equal(tools.length, 8);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_screenshot',
      'browser_extract',
      'browser_status',
      'browser_reload',
      'browser_wait_for',
    ],
  );
  assert.equal(tool('browser_status', tools).needsApproval, false);
  assert.equal(tool('browser_reload', tools).needsApproval, true);
  assert.equal(tool('browser_wait_for', tools).needsApproval, false);
  for (const t of tools) {
    assert.ok(t.definition.description.length > 20, `${t.definition.name} needs a description`);
  }
});

// ---------------------------------------------------------------------------
// browser_status
// ---------------------------------------------------------------------------

test('browser v097: browser_status reports closed without launching a browser', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  try {
    const out = await tool('browser_status', session.tools).execute({}, CTX(makeTempWorkspace()));
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.open, false);
    assert.equal(parsed.url, null);
    assert.equal(parsed.title, null);
    assert.equal(launcher.state.launches, 0, 'status must never launch a browser');
  } finally {
    await session.close();
  }
});

test('browser v097: browser_status reports url + title once a page is open', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    const out = await tool('browser_status', session.tools).execute({}, CTX(ws));
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.open, true);
    assert.equal(parsed.url, DATA_PAGE);
    assert.equal(parsed.title, 'Fake Page');
    assert.equal(launcher.state.launches, 1);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// browser_reload
// ---------------------------------------------------------------------------

test('browser v097: browser_reload re-navigates to the same URL', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    const out = await tool('browser_reload', session.tools).execute({}, CTX(ws));
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.url, DATA_PAGE);
    assert.equal(parsed.title, 'Fake Page');
    const page = launcher.state.pages[0];
    assert.deepEqual(page.gotoCalls, [DATA_PAGE, DATA_PAGE]);
  } finally {
    await session.close();
  }
});

test('browser v097: browser_reload with no page open is a clear error', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  try {
    const out = await tool('browser_reload', session.tools).execute({}, CTX(makeTempWorkspace()));
    assert.match(out, /^Error: No page is open/);
    assert.equal(launcher.state.launches, 0, 'reload must not launch a browser just to fail');
  } finally {
    await session.close();
  }
});

test('browser v097: browser_reload validates its timeout', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    const out = await tool('browser_reload', session.tools).execute({ timeoutMs: 0 }, CTX(ws));
    assert.match(out, /^Error: timeoutMs must be a number between 1 and 120000/);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// browser_wait_for
// ---------------------------------------------------------------------------

test('browser v097: browser_wait_for returns at once when the selector is already there', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    const out = await tool('browser_wait_for', session.tools).execute(
      { selector: '#title', timeoutMs: 5000 },
      CTX(ws),
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.url, DATA_PAGE);
    assert.ok(parsed.waitedMs < 5000, `should return fast, waited ${parsed.waitedMs}ms`);
  } finally {
    await session.close();
  }
});

test('browser v097: browser_wait_for sees a selector appear after a few polls', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    launcher.state.pages[0].revealSelector = { selector: '#late', text: 'now here', afterCalls: 3 };
    const out = await tool('browser_wait_for', session.tools).execute(
      { selector: '#late', timeoutMs: 5000 },
      CTX(ws),
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true, out);
    assert.ok(launcher.state.pages[0].innerTextCalls >= 3);
  } finally {
    await session.close();
  }
});

test('browser v097: browser_wait_for sees text appear in the page body', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    launcher.state.pages[0].revealText = { text: 'loaded-async', afterCalls: 2 };
    const out = await tool('browser_wait_for', session.tools).execute(
      { text: 'loaded-async', timeoutMs: 5000 },
      CTX(ws),
    );
    assert.equal(JSON.parse(out).ok, true, out);
  } finally {
    await session.close();
  }
});

test('browser v097: browser_wait_for times out with a clear error', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    const started = Date.now();
    const out = await tool('browser_wait_for', session.tools).execute(
      { selector: '#never-there', timeoutMs: 600 },
      CTX(ws),
    );
    const elapsed = Date.now() - started;
    assert.match(out, /^Error: Timed out after 600ms waiting for selector "#never-there"/);
    assert.ok(elapsed >= 550 && elapsed < 5000, `timeout must fire near 600ms, took ${elapsed}ms`);
  } finally {
    await session.close();
  }
});

test('browser v097: browser_wait_for needs selector or text, and refuses an empty text', async () => {
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher, idleCloseMs: 0 });
  const ws = makeTempWorkspace();
  try {
    await tool('browser_navigate', session.tools).execute({ url: DATA_PAGE }, CTX(ws));
    const neither = await tool('browser_wait_for', session.tools).execute({}, CTX(ws));
    assert.match(neither, /^Error: Give "selector", "text", or both/);
    const empty = await tool('browser_wait_for', session.tools).execute({ text: '' }, CTX(ws));
    assert.match(empty, /^Error: "text" must not be empty/);
    const noPage = await createBrowserSession({ createBrowser: makeFakeLauncher(), idleCloseMs: 0 }).tools;
    const missing = await tool('browser_wait_for', noPage).execute({ selector: '#x' }, CTX(ws));
    assert.match(missing, /^Error: No page is open/);
  } finally {
    await session.close();
  }
});
