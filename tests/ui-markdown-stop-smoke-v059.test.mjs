/**
 * CDP smoke for UI-1 + UI-2 (v0.59) — the REAL Electron app under xvfb.
 *
 * Launches apps/desktop with an isolated XDG_CONFIG_HOME (never touches
 * the user's real profile), creates an Ollama bot (qwen2.5:0.5b, local,
 * no key), and drives the chat through the real UI (textarea + Send).
 *
 * - UI-2 (deterministic): sends a prompt, clicks the Stop button as
 *   soon as it appears, and asserts the run ends cleanly — input
 *   re-enabled, Stop button gone, visible stopped state. The tiny local
 *   model needs ~45s+ just to prefill the full tool registry on this
 *   VM, so waiting for a whole run to finish is slow and flaky; the
 *   Stop path is exercised during that prefill instead.
 * - UI-1 (deterministic): seeds one user + one assistant message
 *   (rich Markdown: heading, list, code block, table, link, plus an
 *   XSS `<script>` line) into the bot's real history store
 *   (BotMemory SQLite, same rows `getHistory` returns), reloads the
 *   app, and asserts the OLD saved messages render as Markdown in the
 *   DOM — assistant as Markdown, user as plain text, the script tag as
 *   visible text only (never an element).
 * - Fails on any uncaught renderer exception during the whole run.
 *
 * Skips (with a clear message) when there is no DISPLAY or when Ollama
 * does not have qwen2.5:0.5b — same convention as
 * tests/computer-use-v06.test.mjs / vault-confirm-l5-click.test.mjs.
 *
 * Run: xvfb-run -a node --test tests/ui-markdown-stop-smoke-v059.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CDP_DEADLINE_MS } from './cdp-deadline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const CDP_PORT = 9400 + (process.pid % 500);
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-ui2-smoke-xdg-'));
const wsDir = path.join(os.homedir(), 'workspace', `open-bot-smoke-${process.pid}`);
fs.mkdirSync(wsDir, { recursive: true });

let ollamaOk = false;
try {
  const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  ollamaOk = (data.models ?? []).some((m) => String(m.name ?? '').startsWith('qwen2.5:0.5b'));
} catch {
  ollamaOk = false;
}

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
      const r = m.result?.result;
      if (r?.exceptionDetails) {
        return reject(new Error(`evaluate threw: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`));
      }
      resolve(r?.value);
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
  // Wait for React to mount.
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
    env: { ...process.env, XDG_CONFIG_HOME: xdgDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  return connectCdp();
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

/** Wait until `expression` (evaluated in the page) returns truthy, or throw. */
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

/** Type into the React-controlled textarea and click Send, like a user. */
async function sendViaUi(text) {
  await evalJs(`(() => {
    const ta = document.querySelector('.chat-input textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = [...document.querySelectorAll('.chat-input button')].find(
      (b) => b.textContent.trim() === 'Gửi' || b.textContent.trim() === 'Send',
    );
    if (!sendBtn || sendBtn.disabled) return false;
    sendBtn.click();
    return true;
  })()`);
}

/**
 * Seed one user + one assistant message into the bot's real history
 * store (BotMemory SQLite at <wsDir>/.open-bot/memory.db — the same
 * rows `getHistory` returns). Retries on SQLITE_BUSY: the coordinator
 * child holds the file open, but it is idle between runs.
 */
function seedHistory(botId, threadId) {
  const dbPath = path.join(wsDir, '.open-bot', 'memory.db');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      assert.ok(fs.existsSync(dbPath), `memory.db must exist at ${dbPath} (bot created?)`);
      const db = new DatabaseSync(dbPath);
      try {
        const now = Date.now();
        const insert = db.prepare(
          'INSERT INTO messages (id, botId, role, content, createdAt, threadId) VALUES (?, ?, ?, ?, ?, ?)',
        );
        insert.run(`seed-user-${process.pid}`, botId, 'user', '# not a heading **bold**', new Date(now).toISOString(), threadId);
        insert.run(
          `seed-asst-${process.pid}`,
          botId,
          'assistant',
          '# Hello\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two\n\n```python\nprint(\'hello\')\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n',
          new Date(now + 1000).toISOString(),
          threadId,
        );
      } finally {
        db.close();
      }
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

test.before(async () => {
  if (!hasDisplay || !ollamaOk) return;
  await launchApp();
});

test.after(async () => {
  await quitApp();
  fs.rmSync(xdgDir, { recursive: true, force: true });
  fs.rmSync(wsDir, { recursive: true, force: true });
});

test('smoke UI-1 + UI-2: Stop ends the run, saved Markdown renders', { skip: !hasDisplay || !ollamaOk }, async () => {
  // Fresh profile: no bot yet — create one through the real IPC bridge.
  const botId = await evalJs(`(async () => {
    const bot = await window.openBot.createBot({
      name: 'Smoke',
      providerId: 'ollama',
      model: 'qwen2.5:0.5b',
      systemPrompt: 'You are helpful. Reply in Markdown.',
      workspaceDir: ${JSON.stringify(wsDir)},
      autoApprove: true,
      smallModelGuard: false,
    });
    return bot.id;
  })()`);
  assert.ok(typeof botId === 'string' && botId.length > 0, 'createBot must return a bot id');

  // ChatView for the new bot (auto-selected as the only bot).
  await waitFor(`!!document.querySelector('.chat-input textarea')`, 30_000, 'chat input');
  assert.equal(
    await evalJs(`!!document.querySelector('[data-testid="stop-run-button"]')`),
    false,
    'no Stop button while idle',
  );
  // Let the bot-switch effect finish (UI-5 threads + history load):
  // sending while loadHistory is still in flight can wipe the
  // just-sent messages from view when it resolves afterwards.
  await sleep(6000);

  // --- UI-2: send, click Stop as soon as it appears, run must settle. ---
  // Diagnostics: timings + failure dump to identify which path the run
  // took (pending-stop vs run finished vs run errored) when it fails.
  const tSendStart = Date.now();
  await sendViaUi('Viết một bài văn rất dài, ít nhất 800 từ, về lịch sử hàng hải.');
  await waitFor(`!!document.querySelector('[data-testid="stop-run-button"]')`, 60_000, 'Stop button to appear');
  const tStopSeen = Date.now();
  await evalJs(`document.querySelector('[data-testid="stop-run-button"]').click()`);
  const tStopClicked = Date.now();
  // v0.60 (P0 Stop race): on settle timeout, snapshot the DOM so the
  // failure says WHICH stage hung — (a) run still executing (Stop
  // still there, input disabled, no stopped text) vs (b) run done but
  // the UI never updated (Stop gone yet input still disabled, or a
  // stale "stopping" state). Without this the timeout error only says
  // "run to settle" with a bare boolean.
  try {
    await waitFor(
      `(() => { const ta = document.querySelector('.chat-input textarea'); return ta && !ta.disabled && !document.querySelector('[data-testid="stop-run-button"]'); })()`,
      60_000,
      'run to settle after Stop (input enabled, Stop gone)',
    );
  } catch (e) {
    let diag = '(diagnostic snapshot unavailable)';
    try {
      diag = JSON.stringify(await evalJs(`(() => {
        const ta = document.querySelector('.chat-input textarea');
        const stopBtn = document.querySelector('[data-testid="stop-run-button"]');
        const lastAsst = [...document.querySelectorAll('.msg.assistant')].pop();
        return {
          inputDisabled: ta ? ta.disabled : 'no-textarea',
          stopButtonPresent: !!stopBtn,
          stopButtonText: stopBtn?.textContent?.trim() ?? null,
          notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent),
          assistantBubbles: document.querySelectorAll('.msg.assistant').length,
          lastAssistantHead: (lastAsst?.textContent ?? '').slice(0, 200),
        };
      })()`));
    } catch {
      // Keep the original timeout error when even diagnostics fail.
    }
    throw new Error(`${e.message} — settle-timeout diagnostics: ${diag}`);
  }
  const stoppedState = await evalJs(`(() => {
    const notices = [...document.querySelectorAll('.notice')].map((n) => n.textContent);
    const bubbles = [...document.querySelectorAll('.msg.assistant')].map((b) => b.textContent);
    const ta = document.querySelector('.chat-input textarea');
    return {
      notices,
      bubbles: bubbles.map((b) => b.slice(0, 300)),
      inputDisabled: ta ? ta.disabled : 'no-textarea',
      stopPresent: !!document.querySelector('[data-testid="stop-run-button"]'),
      stoppedNotice: notices.some((t) => t.includes('Đã dừng')),
      stoppedText: bubbles.some((t) => t.includes('Đã dừng')),
    };
  })()`);
  // Diagnostics: what did main actually save for this turn?
  // Distinguishes "run finished before Stop" (essay in DB) from
  // "main returned stopped text but the renderer dropped it" (DB has
  // 'Đã dừng...' yet the bubble does not) from "run errored" (DB has
  // an error / nothing). Best-effort: never fail the test on diagnostics.
  let dbDiag = '(db read unavailable)';
  try {
    const dbPath = path.join(wsDir, '.open-bot', 'memory.db');
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const db = new DatabaseSync(dbPath);
        try {
          const row = db.prepare(
            `SELECT content FROM messages WHERE botId = ? AND role = 'assistant' ORDER BY createdAt DESC LIMIT 1`,
          ).get(botId);
          dbDiag = row ? JSON.stringify(String(row.content).slice(0, 300)) : '(no assistant row)';
        } finally {
          db.close();
        }
        break;
      } catch (e) {
        if (attempt === 9) dbDiag = `(db read failed: ${e.message})`;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  } catch (e) {
    dbDiag = `(db diag threw: ${e.message})`;
  }
  console.log(`[STOP-DIAG] send->stopSeen=${tStopSeen - tSendStart}ms stopSeen->clicked=${tStopClicked - tStopSeen}ms settleMs=${Date.now() - tStopClicked}ms notices=${JSON.stringify(stoppedState.notices)} bubbles=${JSON.stringify(stoppedState.bubbles)} dbAssistant=${dbDiag}`);
  // Diagnostics: is the empty chat transient (a late effect re-run
  // wiped messages and a late loadHistory repopulates them) or
  // permanent? Poll 5s and compare rendered DOM vs getHistory IPC.
  if (!stoppedState.stoppedNotice && !stoppedState.stoppedText) {
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const probe = await evalJs(`(() => {
        const notices = [...document.querySelectorAll('.notice')].map((n) => n.textContent);
        const bubbles = [...document.querySelectorAll('.msg.assistant')].map((b) => b.textContent.slice(0, 120));
        const users = [...document.querySelectorAll('.msg.user')].map((b) => b.textContent.slice(0, 80));
        return { notices, bubbles, users, msgCount: document.querySelectorAll('.msg').length };
      })()`);
      let hist = '(hist read failed)';
      try {
        hist = JSON.stringify(await evalJs(`(async () => {
          const threads = await window.openBot.listThreads(${JSON.stringify(botId)});
          const out = { threads: threads.map((th) => th.id) };
          for (const th of threads) {
            const rows = await window.openBot.getHistory(${JSON.stringify(botId)}, 50, th.id);
            out[th.id] = rows.map((r) => ({ role: r.role, text: String(r.text ?? '').slice(0, 80) }));
          }
          const rowsNoThread = await window.openBot.getHistory(${JSON.stringify(botId)}, 50);
          out.noThreadArg = rowsNoThread.map((r) => ({ role: r.role, text: String(r.text ?? '').slice(0, 80) }));
          return out;
        })()`));
      } catch (e) {
        hist = `(hist threw: ${e.message})`;
      }
      console.log(`[STOP-DIAG2] +${(i + 1) * 500}ms dom=${JSON.stringify(probe)} history=${hist}`);
      if (probe.bubbles.some((b) => b.includes('Đã dừng')) || probe.notices.some((n) => n.includes('Đã dừng'))) break;
    }
  }
  assert.ok(
    stoppedState.stoppedNotice || stoppedState.stoppedText,
    `a stopped state must be visible after Stop (notices=${JSON.stringify(stoppedState.notices)} bubbles=${JSON.stringify(stoppedState.bubbles)} inputDisabled=${stoppedState.inputDisabled} stopPresent=${stoppedState.stopPresent} dbAssistant=${dbDiag})`,
  );

  // --- UI-1: seed Markdown history, reload, old messages must render. ---
  const threadId = await evalJs(`(async () => {
    const threads = await window.openBot.listThreads(${JSON.stringify(botId)});
    return threads[0]?.id ?? null;
  })()`);
  assert.ok(typeof threadId === 'string' && threadId.length > 0, 'default thread must exist');
  seedHistory(botId, threadId);

  // Reload the app (the evaluate never resolves across a navigation).
  try {
    ws.send(JSON.stringify({
      id: nextId++, method: 'Runtime.evaluate',
      params: { expression: 'location.reload()', returnByValue: true },
    }));
  } catch { /* socket drops on navigation — expected */ }
  await sleep(2000);
  await connectCdp();
  await waitFor(`!!document.querySelector('.chat-input textarea')`, 60_000, 'chat input after reload');
  // A fresh mount auto-selects the saved bot (localStorage keeps the
  // smoke bot selected across the reload) — wait for that selection to
  // prove the new page has actually loaded (not the stale pre-reload
  // DOM), then click the smoke bot in the sidebar: its bot-switch
  // effect loads the seeded history via the real path.
  await waitFor(
    `document.querySelector('.bot-item.active')?.textContent?.includes('Smoke')`,
    30_000,
    'fresh mount to select the smoke bot',
  );
  await evalJs(`(() => {
    // NOTE: each sidebar row is a div.bot-item wrapping a
    // button.bot-item that carries the onClick — clicking the div
    // does nothing.
    const item = [...document.querySelectorAll('button.bot-item')].find((b) => b.textContent.includes('Smoke'));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  await waitFor(
    `document.querySelector('.bot-item.active')?.textContent?.includes('Smoke')`,
    30_000,
    'smoke bot to become active',
  );
  await waitFor(`!!document.querySelector('.msg.assistant .md')`, 60_000, 'seeded assistant message to render');

  const rendered = await evalJs(`(() => {
    const bubbles = [...document.querySelectorAll('.msg.assistant')];
    const seeded = bubbles.find((b) => b.textContent.includes("print('hello')"));
    if (!seeded) return null;
    const user = [...document.querySelectorAll('.msg.user')].find((b) => b.textContent.includes('not a heading'));
    return {
      headings: seeded.querySelectorAll('h3, h4, h5').length,
      lists: seeded.querySelectorAll('ul.md-list, ol.md-list').length,
      codeBlocks: seeded.querySelectorAll('.md-code').length,
      tables: seeded.querySelectorAll('table.md-table').length,
      links: seeded.querySelectorAll('a[href="https://example.com"]').length,
      codeText: seeded.querySelector('.md-code')?.textContent ?? '',
      scriptElements: seeded.querySelectorAll('script').length,
      scriptVisible: seeded.textContent.includes('<script>'),
      userHasHeading: !!user?.querySelector('h3, h4, h5, strong'),
    };
  })()`);
  assert.ok(rendered, 'seeded assistant message must be in the DOM');
  assert.ok(rendered.headings >= 1, 'seeded heading must render as a heading');
  assert.ok(rendered.lists >= 1, 'seeded list must render as a list');
  assert.ok(rendered.codeBlocks >= 1, 'seeded code block must render');
  assert.ok(rendered.codeText.includes("print('hello')"), 'code block must keep its text');
  assert.ok(rendered.tables >= 1, 'seeded table must render');
  assert.ok(rendered.links >= 1, 'seeded link must render as an anchor');
  assert.equal(rendered.scriptElements, 0, 'seeded <script> must never become an element');
  assert.ok(rendered.scriptVisible, 'seeded <script> must stay visible as text');
  assert.equal(rendered.userHasHeading, false, 'user message must stay plain text (no Markdown)');

  assert.deepEqual(pageExceptions, [], `no uncaught renderer exceptions (saw: ${pageExceptions.join(' | ')})`);
});
