/**
 * Browser automation tools for @open-bot/tools (v0.86a, P1-3).
 *
 * Drive a real Chromium browser via Playwright — navigate, click, type,
 * screenshot, extract text — as the counterpart to the X11 computer-use
 * tools (computerUse.ts), which can only see the local desktop. Where
 * computer-use moves the OS mouse/keyboard, these tools drive the web
 * page itself (CSS selectors, DOM text), so they work headless and do
 * not need an X display.
 *
 * Safety rules (same spirit as computerUse.ts / sandbox.ts):
 *  - One shared browser session per factory call, kept in a closure
 *    (like the recording table in computerUse.ts). The browser is
 *    launched lazily on the first tool call and closed after an idle
 *    timeout (default 5 minutes) or via `close()` on the session, so
 *    a forgotten browser never leaks a Chromium process.
 *  - Every operation has a hard timeout (navigation 30 s, actions
 *    10 s by default); a timeout closes the page/browser state
 *    cleanly and reports `Error: ...`, never hangs the agent loop.
 *  - URL allowlist for `browser_navigate`: `data:text/html,...` pages
 *    (local test pages) and `http(s):` URLs that pass the SSRF guard
 *    (`assertPublicUrl` — no loopback / private / link-local /
 *    cloud-metadata targets). Every other scheme (`file:`,
 *    `javascript:`, `chrome:`, ...) is refused. Pass
 *    `allowLocalUrls: true` only when the caller deliberately wants
 *    localhost automation (local dev servers); the coordinator does
 *    NOT enable it by default.
 *  - All output files (screenshots) are confined to the agent
 *    workspace via resolveWithin(), under `browser/screenshots/`.
 *  - `browser_type` must NEVER be used to type passwords, secrets or
 *    API keys: it refuses strings that look like long random tokens
 *    (same heuristic as computer_type) and its description says so.
 *  - Extracted text is truncated to MAX_TOOL_RESULT_CHARS; the
 *    browser never returns cookies, localStorage or page JS values,
 *    so no credential can leak through a tool result.
 *  - `browser_navigate` / `browser_click` / `browser_type` mutate
 *    the page and need approval; `browser_screenshot` and
 *    `browser_extract` are read-only.
 *
 * Testability: the real Playwright driver is behind the small
 * `BrowserLauncher` interface — tests inject a fake launcher
 * (`opts.createBrowser`) so most cases run without a real Chromium,
 * and one smoke test drives the real browser under xvfb.
 *
 * Exported as BROWSER_TOOLS (defaults) + createBrowserTools() /
 * createBrowserSession() (overridable timeouts / launcher), mirroring
 * COMPUTER_USE_TOOLS in computerUse.ts. This module registers
 * nothing itself; the coordinator wires it into the registry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import type { Tool, ToolContext } from '@open-bot/core';
import { MAX_OUTPUT_CHARS, resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';
import { assertPublicUrl } from './ssrf';
import { looksLikeSecretToken, parsePngDimensions } from './computerUse';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_CLOSE_MS = 5 * 60_000; // 5 minutes without a call -> close browser
const MAX_URL_CHARS = 8_000;
const MAX_SELECTOR_CHARS = 1_000;
const MAX_TYPE_CHARS = 1_000;

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Driver abstraction (real Playwright behind a small interface)
// ---------------------------------------------------------------------------

/** Minimal page surface the tools need — implemented by Playwright and by test fakes. */
export interface BrowserPageDriver {
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts?: { timeout?: number }): Promise<void>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, text: string, opts?: { timeout?: number }): Promise<void>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  /** Visible text of the element (or of <body> when no selector). */
  innerText(selector?: string): Promise<string>;
  close(): Promise<void>;
}

/** Minimal browser surface the tools need. */
export interface BrowserDriver {
  newPage(): Promise<BrowserPageDriver>;
  close(): Promise<void>;
}

/** Launches a browser. The real one uses Playwright Chromium (headless). */
export type BrowserLauncher = (opts: { headless: boolean }) => Promise<BrowserDriver>;

/** Real Playwright launcher (headless Chromium). */
export async function launchPlaywrightBrowser(opts: {
  headless: boolean;
}): Promise<BrowserDriver> {
  let browser;
  try {
    // Root (containers / this VM) cannot use the Chromium sandbox.
    const launchArgs =
      typeof process.getuid === 'function' && process.getuid() === 0
        ? ['--no-sandbox']
        : [];
    browser = await chromium.launch({ headless: opts.headless, args: launchArgs });
  } catch (err) {
    throw new Error(
      `Failed to launch Chromium via Playwright: ${(err as Error).message} ` +
        `(Is a Chromium build installed? Run \`npx playwright install chromium\`.)`,
    );
  }
  return {
    async newPage(): Promise<BrowserPageDriver> {
      const page = await browser.newPage();
      return {
        url: () => page.url(),
        title: () => page.title(),
        goto: (url, gotoOpts) =>
          page.goto(url, { timeout: gotoOpts?.timeout, waitUntil: 'domcontentloaded' }).then(() => undefined),
        click: (selector, clickOpts) =>
          page.locator(selector).first().click({ timeout: clickOpts?.timeout }).then(() => undefined),
        fill: (selector, text, fillOpts) =>
          page.locator(selector).first().fill(text, { timeout: fillOpts?.timeout }).then(() => undefined),
        screenshot: (shotOpts) => page.screenshot({ path: shotOpts?.path, fullPage: shotOpts?.fullPage }),
        innerText: (selector) =>
          selector
            ? page.locator(selector).first().innerText()
            : page.locator('body').innerText(),
        close: () => page.close().catch(() => undefined),
      };
    },
    close: () => browser.close().catch(() => undefined),
  };
}

// ---------------------------------------------------------------------------
// Session (one shared browser per factory call)
// ---------------------------------------------------------------------------

export interface BrowserAutomationOptions {
  /** Navigation timeout in ms (default 30_000). */
  defaultNavigationTimeoutMs?: number;
  /** Click/type/screenshot timeout in ms (default 10_000). */
  defaultActionTimeoutMs?: number;
  /** Idle time with no tool call after which the browser closes (default 5 min, 0 = never). */
  idleCloseMs?: number;
  /** Allow http(s) URLs to loopback/private hosts (default false — SSRF guard applies). */
  allowLocalUrls?: boolean;
  /** DNS resolver for the SSRF check (tests inject a fake; default: real dns.lookup). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Override the browser launcher (tests inject a fake; default: real Playwright Chromium). */
  createBrowser?: BrowserLauncher;
}

type ResolvedBrowserOptions = Required<
  Omit<BrowserAutomationOptions, 'createBrowser' | 'allowLocalUrls' | 'lookupFn'>
> &
  Pick<BrowserAutomationOptions, 'createBrowser' | 'allowLocalUrls' | 'lookupFn'>;

export interface BrowserSession {
  tools: Tool[];
  /** True while a browser is currently open for this session. */
  isOpen(): boolean;
  /** Close the browser now (no-op when already closed). */
  close(): Promise<void>;
}

interface SessionState {
  driver: BrowserDriver | null;
  page: BrowserPageDriver | null;
  idleTimer: NodeJS.Timeout | null;
  closing: Promise<void> | null;
}

async function closeSessionState(state: SessionState): Promise<void> {
  if (state.closing) return state.closing;
  state.closing = (async () => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    const page = state.page;
    const driver = state.driver;
    state.page = null;
    state.driver = null;
    if (page) await page.close().catch(() => undefined);
    if (driver) await driver.close().catch(() => undefined);
  })();
  try {
    await state.closing;
  } finally {
    state.closing = null;
  }
}

function armIdleTimer(
  state: SessionState,
  idleCloseMs: number,
): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
  if (idleCloseMs <= 0) return;
  state.idleTimer = setTimeout(() => {
    void closeSessionState(state).catch(() => undefined);
  }, idleCloseMs);
  if (typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
}

/**
 * Validate a navigation URL. `data:text/html` pages are always fine
 * (local test pages, no network). http(s) URLs go through the SSRF
 * guard unless the caller explicitly allowed local URLs. Anything
 * else is refused.
 */
export async function validateNavigateUrl(
  rawUrl: string,
  opts: { allowLocalUrls?: boolean; lookupFn?: (hostname: string) => Promise<Array<{ address: string }>> } = {},
): Promise<URL> {
  if (rawUrl.length === 0) throw new Error('Missing required argument: "url"');
  if (rawUrl.length > MAX_URL_CHARS) {
    throw new Error(`URL is ${rawUrl.length} chars, over the ${MAX_URL_CHARS} char limit.`);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }
  if (url.protocol === 'data:') {
    if (!url.pathname.startsWith('text/html')) {
      throw new Error(
        `Only data:text/html pages are allowed, got "${url.pathname.slice(0, 40)}".`,
      );
    }
    return url;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!opts.allowLocalUrls) {
      // SSRF guard: DNS-resolves the host and refuses loopback /
      // private / link-local / metadata targets (fail-closed on
      // DNS errors). Throws with a clear message when blocked.
      await assertPublicUrl(url, { lookupFn: opts.lookupFn });
    }
    return url;
  }
  throw new Error(
    `Unsupported URL scheme "${url.protocol}": browser_navigate only allows http(s) URLs and data:text/html pages.`,
  );
}

function validateSelector(selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.length === 0) throw new Error('Missing required argument: "selector"');
  if (trimmed.length > MAX_SELECTOR_CHARS) {
    throw new Error(`Selector is ${trimmed.length} chars, over the ${MAX_SELECTOR_CHARS} char limit.`);
  }
  return trimmed;
}

/** Launch the browser (if needed) and return the shared page. */
async function ensurePage(
  state: SessionState,
  opts: ResolvedBrowserOptions,
  signal?: AbortSignal,
): Promise<BrowserPageDriver> {
  if (signal?.aborted) throw new Error('Operation aborted before it started.');
  if (state.page) {
    armIdleTimer(state, opts.idleCloseMs);
    return state.page;
  }
  const launcher = opts.createBrowser ?? launchPlaywrightBrowser;
  const driver = await launcher({ headless: true });
  state.driver = driver;
  try {
    state.page = await driver.newPage();
  } catch (err) {
    await closeSessionState(state).catch(() => undefined);
    throw new Error(`Failed to open a browser page: ${(err as Error).message}`);
  }
  armIdleTimer(state, opts.idleCloseMs);
  return state.page;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function makeNavigateTool(
  state: SessionState,
  opts: ResolvedBrowserOptions,
): Tool {
  return {
    definition: {
      name: 'browser_navigate',
      description:
        'Open a URL in the shared headless Chromium browser (Playwright) and wait until the page loads. Only http(s) URLs to public hosts and data:text/html pages are allowed — private/loopback hosts are blocked by the SSRF guard. Returns the final URL and page title. The browser stays open for later browser_* calls and closes after 5 minutes idle.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open (http(s) to a public host, or a data:text/html page). Max 8000 chars.',
          },
          timeoutMs: {
            type: 'number',
            description: `Navigation timeout in ms (default ${opts.defaultNavigationTimeoutMs}, max 120000).`,
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const url = getStringArg(args, 'url');
        const timeoutMs = args['timeoutMs'] === undefined ? opts.defaultNavigationTimeoutMs : args['timeoutMs'];
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
          return errorResult(`timeoutMs must be a number between 1 and 120000, got ${String(timeoutMs)}.`);
        }
        await validateNavigateUrl(url, { allowLocalUrls: opts.allowLocalUrls, lookupFn: opts.lookupFn });
        const page = await ensurePage(state, opts, ctx.signal);
        try {
          await page.goto(url, { timeout: timeoutMs });
        } catch (err) {
          // A failed navigation may leave a broken page behind; drop
          // the session so the next call starts from a clean browser.
          await closeSessionState(state).catch(() => undefined);
          return errorResult(`Navigation to "${url}" failed: ${(err as Error).message}`);
        }
        const title = await page.title().catch(() => '');
        return truncate(
          JSON.stringify({ ok: true, url: page.url(), title }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeClickTool(
  state: SessionState,
  opts: ResolvedBrowserOptions,
): Tool {
  return {
    definition: {
      name: 'browser_click',
      description:
        'Click an element on the current page, found by CSS selector (e.g. "button.submit", "#login", "a[href=\'/about\']"). Waits up to the timeout for the element to be clickable. Open a page first with browser_navigate.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element to click (max 1000 chars).',
          },
          timeoutMs: {
            type: 'number',
            description: `How long to wait for the element in ms (default ${opts.defaultActionTimeoutMs}, max 60000).`,
          },
        },
        required: ['selector'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const selector = validateSelector(getStringArg(args, 'selector'));
        const timeoutMs = args['timeoutMs'] === undefined ? opts.defaultActionTimeoutMs : args['timeoutMs'];
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
          return errorResult(`timeoutMs must be a number between 1 and 60000, got ${String(timeoutMs)}.`);
        }
        if (!state.page) {
          return errorResult('No page is open: call browser_navigate first.');
        }
        const page = await ensurePage(state, opts, ctx.signal);
        try {
          await page.click(selector, { timeout: timeoutMs });
        } catch (err) {
          return errorResult(`Click on "${selector}" failed: ${(err as Error).message}`);
        }
        return `Clicked "${selector}" on ${page.url()}.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeTypeTool(
  state: SessionState,
  opts: ResolvedBrowserOptions,
): Tool {
  return {
    definition: {
      name: 'browser_type',
      description:
        'Type text into an input/textarea on the current page, found by CSS selector (e.g. "input[name=\'q\']", "#search"). Replaces the field content. NEVER use this to type passwords, secrets, API keys or tokens — the tool refuses strings that look like long random tokens. Open a page first with browser_navigate.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the input/textarea to type into (max 1000 chars).',
          },
          text: {
            type: 'string',
            description: 'Text to type (max 1000 characters). Must not be a password, secret or token.',
          },
          timeoutMs: {
            type: 'number',
            description: `How long to wait for the element in ms (default ${opts.defaultActionTimeoutMs}, max 60000).`,
          },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const selector = validateSelector(getStringArg(args, 'selector'));
        const text = getStringArg(args, 'text');
        const timeoutMs = args['timeoutMs'] === undefined ? opts.defaultActionTimeoutMs : args['timeoutMs'];
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
          return errorResult(`timeoutMs must be a number between 1 and 60000, got ${String(timeoutMs)}.`);
        }
        if (text.length === 0) return errorResult('Nothing to type: "text" is empty.');
        if (text.length > MAX_TYPE_CHARS) {
          return errorResult(`Text is ${text.length} chars, over the ${MAX_TYPE_CHARS} char limit. Split it into smaller chunks.`);
        }
        if (looksLikeSecretToken(text)) {
          return errorResult(
            'Refusing to type a string that looks like a long random secret/token. browser_type must never be used to enter passwords, API keys or tokens.',
          );
        }
        if (!state.page) {
          return errorResult('No page is open: call browser_navigate first.');
        }
        const page = await ensurePage(state, opts, ctx.signal);
        try {
          await page.fill(selector, text, { timeout: timeoutMs });
        } catch (err) {
          return errorResult(`Type into "${selector}" failed: ${(err as Error).message}`);
        }
        return `Typed ${text.length} character(s) into "${selector}" on ${page.url()}.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeScreenshotTool(
  state: SessionState,
  opts: ResolvedBrowserOptions,
): Tool {
  return {
    definition: {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of the current page and save it as a PNG inside the workspace. Read-only. Returns the file path, page URL, image size and file size. Open a page first with browser_navigate.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description:
              'Optional file name for the PNG (default: screenshot-<timestamp>-<id>.png). Saved under browser/screenshots/ in the workspace.',
          },
          fullPage: {
            type: 'boolean',
            description: 'Capture the full scrollable page instead of only the viewport (default: false).',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      try {
        if (!state.page) {
          return errorResult('No page is open: call browser_navigate first.');
        }
        const page = await ensurePage(state, opts, ctx.signal);
        const rawName = args['filename'] === undefined ? '' : getStringArg(args, 'filename', false);
        const filename =
          rawName.trim() === ''
            ? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`
            : rawName.endsWith('.png')
              ? rawName
              : `${rawName}.png`;
        const relPath = path.posix.join('browser', 'screenshots', filename);
        const fullPath = resolveWithin(ctx.workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        const fullPage = getBooleanArg(args, 'fullPage');
        let png: Buffer;
        try {
          png = await page.screenshot({ path: fullPath, fullPage });
        } catch (err) {
          return errorResult(`Screenshot failed: ${(err as Error).message}`);
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          throw new Error('Screenshot failed: the browser reported success but no PNG file was created.');
        }
        if (stat.size === 0) throw new Error('Screenshot failed: the PNG file is empty.');
        const dims = parsePngDimensions(png.subarray(0, 24));
        return truncate(
          JSON.stringify({
            ok: true,
            path: relPath,
            url: page.url(),
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            sizeBytes: stat.size,
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeExtractTool(
  state: SessionState,
  opts: ResolvedBrowserOptions,
): Tool {
  return {
    definition: {
      name: 'browser_extract',
      description:
        'Extract the visible text of the current page (or of one element by CSS selector). Read-only. Returns the page URL, title and truncated text — never cookies, storage or script values. Open a page first with browser_navigate.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'Optional CSS selector: extract only this element\'s text (default: the whole page body). Max 1000 chars.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      try {
        if (!state.page) {
          return errorResult('No page is open: call browser_navigate first.');
        }
        const page = await ensurePage(state, opts, ctx.signal);
        const selector =
          args['selector'] === undefined ? undefined : validateSelector(getStringArg(args, 'selector', false));
        let text: string;
        try {
          text = await page.innerText(selector);
        } catch (err) {
          return errorResult(
            selector
              ? `Extract from "${selector}" failed: ${(err as Error).message}`
              : `Extract failed: ${(err as Error).message}`,
          );
        }
        const title = await page.title().catch(() => '');
        return truncate(
          JSON.stringify({
            ok: true,
            url: page.url(),
            title,
            textLength: text.length,
            text,
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Exports (kept separate from ALL_TOOLS — the coordinator integrates them)
// ---------------------------------------------------------------------------

/**
 * Build a browser-automation session: 5 tools sharing one Chromium
 * browser (launched lazily, closed after idle or via `close()`).
 * Each call gets its own session, so two registries never share (or
 * close) each other's browser. `opts` overrides timeouts, the idle
 * close delay, the local-URL policy and the browser launcher (tests
 * inject a fake launcher here).
 */
export function createBrowserSession(opts: BrowserAutomationOptions = {}): BrowserSession {
  const resolved: ResolvedBrowserOptions = {
    defaultNavigationTimeoutMs: opts.defaultNavigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    defaultActionTimeoutMs: opts.defaultActionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    idleCloseMs: opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS,
    allowLocalUrls: opts.allowLocalUrls ?? false,
    lookupFn: opts.lookupFn,
    createBrowser: opts.createBrowser,
  };
  const state: SessionState = { driver: null, page: null, idleTimer: null, closing: null };
  const tools: Tool[] = [
    makeNavigateTool(state, resolved),
    makeClickTool(state, resolved),
    makeTypeTool(state, resolved),
    makeScreenshotTool(state, resolved),
    makeExtractTool(state, resolved),
  ];
  return {
    tools,
    isOpen: () => state.driver !== null,
    close: () => closeSessionState(state),
  };
}

/** Build just the 5 browser tools (a fresh session per call). */
export function createBrowserTools(opts: BrowserAutomationOptions = {}): Tool[] {
  return createBrowserSession(opts).tools;
}

export const BROWSER_TOOLS: Tool[] = createBrowserTools();

export { MAX_OUTPUT_CHARS };
