/**
 * Tests for the v0.86a (P1-3) Playwright browser-automation tools:
 * BROWSER_TOOLS (browser_navigate / browser_click / browser_type /
 * browser_screenshot / browser_extract / browser_status /
 * browser_reload / browser_wait_for).
 *
 * Most cases drive a FAKE browser (injected via `createBrowser`) so
 * they need no Chromium and no network. One smoke test drives the
 * REAL Chromium — it skips itself with a clear message when no
 * Chromium build is installed (`npx playwright install chromium`).
 *
 * Run:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/browser-playwright-v086.test.mjs
 *   # real-browser smoke under Xvfb (headless Chromium needs no
 *   # display, but xvfb-run keeps the run identical to the suite):
 *   xvfb-run -a node --test tests/browser-playwright-v086.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  BROWSER_TOOLS,
  createBrowserTools,
  createBrowserSession,
  validateNavigateUrl,
} from '../packages/tools/dist/browserAutomation.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name, tools = BROWSER_TOOLS) => tools.find((t) => t.definition.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1x1 transparent PNG (valid PNG, IHDR 1x1) — what the fake returns.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-bw-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fake browser driver (implements the BrowserLauncher interface)
// ---------------------------------------------------------------------------

/** Fake page: parses id="..." elements out of a data: HTML page. */
function makeFakePage(driverState) {
  const state = {
    url: '',
    title: '',
    bodyText: '',
    elements: new Map(), // selector "#id" -> { text, value, clicked }
    screenshotCalls: 0,
    closed: false,
  };
  driverState.pages.push(state);
  return {
    _state: state,
    url: () => state.url,
    title: async () => state.title,
    goto: async (url) => {
      state.url = url;
      if (url.startsWith('data:text/html,')) {
        const html = decodeURIComponent(url.slice('data:text/html,'.length));
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        state.title = titleMatch ? titleMatch[1] : '';
        state.bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        state.elements.clear();
        // <tag ... id="x" ...>text< — enough for the test pages.
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
    screenshot: async (opts) => {
      state.screenshotCalls += 1;
      if (opts?.path) fs.writeFileSync(opts.path, PNG_1X1);
      return PNG_1X1;
    },
    innerText: async (selector) => {
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

// ---------------------------------------------------------------------------
// Registry / metadata (no browser needed)
// ---------------------------------------------------------------------------

test('browser: registry holds 8 tools with the right approval flags', () => {
  const reg = ToolRegistry.fromDefaults(BROWSER_TOOLS);
  assert.equal(reg.size(), 8);
  for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_reload']) {
    assert.equal(tool(name).needsApproval, true, `${name} must need approval`);
  }
  for (const name of ['browser_screenshot', 'browser_extract', 'browser_status', 'browser_wait_for']) {
    assert.equal(tool(name).needsApproval, false, `${name} must be read-only`);
  }
  for (const t of BROWSER_TOOLS) {
    assert.equal(t.definition.parameters.type, 'object');
    assert.equal(typeof t.definition.parameters.properties, 'object');
    assert.ok(t.definition.description.length > 20);
  }
});

test('browser: createBrowserTools returns a fresh set each call', () => {
  const a = createBrowserTools();
  const b = createBrowserTools();
  assert.equal(a.length, 8);
  assert.equal(b.length, 8);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(
    a.map((t) => t.definition.name),
    ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_extract',
     'browser_status', 'browser_reload', 'browser_wait_for'], // v0.97 (Team T6): +3
  );
});

// ---------------------------------------------------------------------------
// URL validation (no browser needed)
// ---------------------------------------------------------------------------

test('browser: validateNavigateUrl allows data: pages and public hosts, blocks the rest', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }]; // example.com
  const ok = await validateNavigateUrl('https://example.com/about', { lookupFn: publicLookup });
  assert.equal(ok.protocol, 'https:');
  const data = await validateNavigateUrl('data:text/html,<h1>hi</h1>');
  assert.equal(data.protocol, 'data:');

  await assert.rejects(validateNavigateUrl('file:///etc/passwd'), /Unsupported URL scheme/);
  await assert.rejects(validateNavigateUrl('javascript:alert(1)'), /Unsupported URL scheme/);
  await assert.rejects(validateNavigateUrl('not a url'), /Invalid URL/);
  await assert.rejects(validateNavigateUrl('data:text/plain,hello'), /Only data:text\/html/);
  // IP literals: no DNS needed — loopback / private / metadata are blocked.
  await assert.rejects(validateNavigateUrl('http://127.0.0.1:11434/'), /không|blocked|private|loopback/i);
  await assert.rejects(validateNavigateUrl('http://169.254.169.254/latest/meta-data/'), /không|blocked|private|link-local/i);
  await assert.rejects(validateNavigateUrl('http://192.168.1.10/admin'), /không|blocked|private/i);
  // Hostname resolving to a private IP is blocked too.
  const privateLookup = async () => [{ address: '10.0.0.5' }];
  await assert.rejects(
    validateNavigateUrl('https://internal.example.com/', { lookupFn: privateLookup }),
    /không|blocked|private/i,
  );
  // allowLocalUrls bypasses the guard (caller opt-in for local dev servers).
  const local = await validateNavigateUrl('http://127.0.0.1:3000/', { allowLocalUrls: true });
  assert.equal(local.hostname, '127.0.0.1');
});

// ---------------------------------------------------------------------------
// Fake-browser flow
// ---------------------------------------------------------------------------

const TEST_PAGE =
  'data:text/html,<title>Smoke</title><h1>hello open-bot</h1>' +
  '<input id="q"><button id="go">Go</button>';

test('browser: fake flow navigate -> extract -> type -> click -> screenshot', async () => {
  const ws = makeTempWorkspace();
  const launcher = makeFakeLauncher();
  const session = createBrowserSession({ createBrowser: launcher });
  const tools = session.tools;
  try {
    assert.equal(session.isOpen(), false);
    const nav = JSON.parse(
      await tool('browser_navigate', tools).execute({ url: TEST_PAGE }, CTX(ws)),
    );
    assert.equal(nav.ok, true);
    assert.equal(nav.title, 'Smoke');
    assert.equal(session.isOpen(), true);
    assert.equal(launcher.state.launches, 1, 'browser launched once and shared');

    const extracted = JSON.parse(
      await tool('browser_extract', tools).execute({}, CTX(ws)),
    );
    assert.equal(extracted.ok, true);
    assert.match(extracted.text, /hello open-bot/);
    assert.match(extracted.text, /Go/);

    const typed = await tool('browser_type', tools).execute(
      { selector: '#q', text: 'xin chao' },
      CTX(ws),
    );
    assert.match(typed, /Typed 8 character/);
    assert.equal(launcher.state.pages[0].elements.get('#q').value, 'xin chao');

    const clicked = await tool('browser_click', tools).execute({ selector: '#go' }, CTX(ws));
    assert.match(clicked, /Clicked "#go"/);
    assert.equal(launcher.state.pages[0].elements.get('#go').clicked, true);

    const shot = JSON.parse(
      await tool('browser_screenshot', tools).execute({ filename: 'flow.png' }, CTX(ws)),
    );
    assert.equal(shot.ok, true);
    assert.equal(shot.path, 'browser/screenshots/flow.png');
    assert.equal(shot.width, 1);
    assert.equal(shot.height, 1);
    const fullPath = path.join(ws, 'browser', 'screenshots', 'flow.png');
    assert.ok(fs.existsSync(fullPath), 'screenshot file must exist in the workspace');
    assert.ok(fs.statSync(fullPath).size > 0);

    // Second navigate reuses the same browser (no second launch).
    await tool('browser_navigate', tools).execute({ url: TEST_PAGE }, CTX(ws));
    assert.equal(launcher.state.launches, 1);
  } finally {
    await session.close();
  }
  assert.equal(session.isOpen(), false);
  assert.equal(launcher.state.closed, true, 'close() must close the browser');
});

test('browser: click/type/screenshot/extract without navigate return a clear error', async () => {
  const ws = makeTempWorkspace();
  const session = createBrowserSession({ createBrowser: makeFakeLauncher() });
  try {
    for (const [name, args] of [
      ['browser_click', { selector: '#go' }],
      ['browser_type', { selector: '#q', text: 'x' }],
      ['browser_screenshot', {}],
      ['browser_extract', {}],
    ]) {
      const out = await tool(name, session.tools).execute(args, CTX(ws));
      assert.match(out, /^Error: No page is open/, `${name} must refuse without a page`);
    }
    assert.equal(session.isOpen(), false, 'no browser launched by the failed calls');
  } finally {
    await session.close();
  }
});

test('browser: type refuses secret-looking tokens; click on missing element errors', async () => {
  const ws = makeTempWorkspace();
  const session = createBrowserSession({ createBrowser: makeFakeLauncher() });
  const tools = session.tools;
  try {
    await tool('browser_navigate', tools).execute({ url: TEST_PAGE }, CTX(ws));
    const refused = await tool('browser_type', tools).execute(
      { selector: '#q', text: 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd' },
      CTX(ws),
    );
    assert.match(refused, /^Error: Refusing to type/);
    assert.equal(session.tools.length, 8);

    const missing = await tool('browser_click', tools).execute({ selector: '#nope' }, CTX(ws));
    assert.match(missing, /^Error: Click on "#nope" failed/);

    const tooLong = await tool('browser_type', tools).execute(
      { selector: '#q', text: 'x'.repeat(1001) },
      CTX(ws),
    );
    assert.match(tooLong, /over the 1000 char limit/);
  } finally {
    await session.close();
  }
});

test('browser: screenshot path traversal stays inside the workspace', async () => {
  const ws = makeTempWorkspace();
  const session = createBrowserSession({ createBrowser: makeFakeLauncher() });
  try {
    await tool('browser_navigate', session.tools).execute({ url: TEST_PAGE }, CTX(ws));
    // From browser/screenshots/, 4x "../" escapes the workspace root.
    // (2x "../" would only land at the workspace root — still inside,
    // so resolveWithin legitimately allows it.)
    const out = await tool('browser_screenshot', session.tools).execute(
      { filename: '../../../../evil.png' },
      CTX(ws),
    );
    assert.match(out, /^Error:/);
    assert.ok(!fs.existsSync(path.join(path.dirname(ws), 'evil.png')), 'must not escape the workspace');
    assert.ok(!fs.existsSync(path.join(ws, 'evil.png')));
  } finally {
    await session.close();
  }
});

test('browser: sessions are independent; idle timeout closes the browser', async () => {
  const ws = makeTempWorkspace();
  const launcherA = makeFakeLauncher();
  const launcherB = makeFakeLauncher();
  const a = createBrowserSession({ createBrowser: launcherA, idleCloseMs: 60 });
  const b = createBrowserSession({ createBrowser: launcherB, idleCloseMs: 0 });
  try {
    await tool('browser_navigate', a.tools).execute({ url: TEST_PAGE }, CTX(ws));
    await tool('browser_navigate', b.tools).execute({ url: TEST_PAGE }, CTX(ws));
    assert.equal(a.isOpen(), true);
    assert.equal(b.isOpen(), true);
    await sleep(150);
    assert.equal(a.isOpen(), false, 'idle session A must auto-close');
    assert.equal(b.isOpen(), true, 'idleCloseMs 0 means session B stays open');
    await b.close();
    assert.equal(b.isOpen(), false);
  } finally {
    await a.close();
    await b.close();
  }
});

test('browser: extract by selector returns only that element', async () => {
  const ws = makeTempWorkspace();
  const session = createBrowserSession({ createBrowser: makeFakeLauncher() });
  try {
    await tool('browser_navigate', session.tools).execute({ url: TEST_PAGE }, CTX(ws));
    const out = JSON.parse(
      await tool('browser_extract', session.tools).execute({ selector: '#go' }, CTX(ws)),
    );
    assert.equal(out.ok, true);
    assert.equal(out.text, 'Go');
    const missing = await tool('browser_extract', session.tools).execute({ selector: '#nope' }, CTX(ws));
    assert.match(missing, /^Error: Extract from "#nope" failed/);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// REAL Chromium smoke test (skips cleanly when no browser is installed)
// ---------------------------------------------------------------------------

test('browser: REAL Chromium smoke — navigate data: page, type, click, screenshot', async (t) => {
  const ws = makeTempWorkspace();
  const session = createBrowserSession({ idleCloseMs: 0 });
  const tools = session.tools;
  try {
    // Probe first: skip (do not fail) when Chromium is not installed.
    // (browser_navigate never throws — it returns "Error: ..." strings.)
    const probe = await tool('browser_navigate', tools).execute({ url: TEST_PAGE }, CTX(ws));
    if (probe.startsWith('Error:')) {
      t.skip(`Chromium thật chưa cài được (${probe}) — chạy \`npx playwright install chromium\`.`);
      return;
    }
    assert.equal(session.isOpen(), true, 'browser must be open after a successful navigate');
    const extracted = JSON.parse(
      await tool('browser_extract', tools).execute({}, CTX(ws)),
    );
    assert.equal(extracted.ok, true, `extract must succeed, got: ${JSON.stringify(extracted)}`);
    assert.match(extracted.text, /hello open-bot/);

    const typed = await tool('browser_type', tools).execute({ selector: '#q', text: 'xin chao' }, CTX(ws));
    assert.match(typed, /Typed 8 character/);
    const clicked = await tool('browser_click', tools).execute({ selector: '#go' }, CTX(ws));
    assert.match(clicked, /Clicked "#go"/);

    const shot = JSON.parse(
      await tool('browser_screenshot', tools).execute({ filename: 'smoke.png' }, CTX(ws)),
    );
    assert.equal(shot.ok, true, `screenshot must succeed, got: ${JSON.stringify(shot)}`);
    assert.equal(shot.width, 1280, 'default Chromium viewport is 1280 wide');
    assert.equal(shot.height, 720, 'default Chromium viewport is 720 high');
    const fullPath = path.join(ws, 'browser', 'screenshots', 'smoke.png');
    assert.ok(fs.existsSync(fullPath), 'real screenshot file must exist');
    assert.ok(fs.statSync(fullPath).size > 0, 'real screenshot must not be empty');
  } finally {
    await session.close();
  }
  assert.equal(session.isOpen(), false);
});
