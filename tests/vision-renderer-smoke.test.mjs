/**
 * CDP smoke for the vision renderer wiring (v0.63) — the REAL Electron
 * app under xvfb.
 *
 * Launches apps/desktop with an isolated XDG_CONFIG_HOME (never touches
 * the user's real profile), creates an Ollama bot (qwen2.5:0.5b, local,
 * no key), attaches a tiny 1x1 PNG through the real file input
 * (DataTransfer — the same `change` event the attach button / drag-drop
 * / paste path feeds), and sends it with a question through the real UI
 * (textarea + Send).
 *
 * Asserts end to end, with NO live key:
 *   1. The composer chip appears (the image was read as base64).
 *   2. The optimistic user bubble shows the image thumbnail immediately.
 *   3. Clicking the thumbnail opens the large preview modal (and it closes).
 *   4. The assistant answers with the friendly "không xem được ảnh"
 *      refusal — the image travelled renderer → main (`chat:send`) →
 *      coordinator → loop, where the vision gate refused the turn for
 *      the text-only model BEFORE any provider call. That refusal is
 *      the proof the channel works: a dropped image would have produced
 *      a normal text reply (or nothing about images at all).
 *   5. (v0.65) The saved user row keeps the PLAIN typed text (no
 *      metadata line, no base64 — the DB never holds image bytes);
 *      the image lives as a file under
 *      `.open-bot/attachments/<messageId>/0.png` with a
 *      `message_attachments` row (name + mime + size), holding the
 *      exact PNG bytes.
 *   6. (v0.65) Reload the page: the app restores the bot + thread
 *      from storage and re-reads history WITH the stored images —
 *      the user bubble must show the thumbnail again (not just the
 *      file name), and clicking it still opens the large preview.
 * Fails on any uncaught renderer exception during the whole run.
 *
 * Skips (with a clear message) when there is no DISPLAY or when Ollama
 * does not have qwen2.5:0.5b — same convention as
 * tests/ui-markdown-stop-smoke-v059.test.mjs.
 *
 * Run: xvfb-run -a node --test tests/vision-renderer-smoke.test.mjs
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
// Distinct CDP port from the other smoke tests (pid-scoped).
const CDP_PORT = 9600 + (process.pid % 300);
const JS_TIMEOUT_MS = 15000;

// 1x1 red PNG (70 bytes decoded), base64 without any `data:` prefix.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-vision-smoke-xdg-'));
const wsDir = path.join(os.homedir(), 'workspace', `open-bot-vision-smoke-${process.pid}`);
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

/** Send a raw CDP command (e.g. Page.reload) and await its result. */
function cdpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out after ${JS_TIMEOUT_MS}ms`));
    }, JS_TIMEOUT_MS);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) return reject(new Error(`CDP ${m.error.message ?? JSON.stringify(m.error)}`));
      resolve(m.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
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

/**
 * v0.85: wait for real chat-ready state instead of a fixed sleep.
 * The old `sleep(6000)` after createBot waited for the bot-switch
 * effect (loadThreads -> loadHistory) to finish so a late loadHistory
 * could not wipe the just-sent messages — but 6s is not enough under
 * load and wastes time when the machine is fast. There is no DOM
 * marker for "loadHistory resolved", so poll the effect chain's
 * observable tail: chat input present + selectedBotId persisted +
 * the default thread row rendered (= loadThreads resolved, so
 * loadHistory has started) + the message count quiet for 1s (=
 * loadHistory's setMessages has landed or there is nothing to load).
 */
async function waitForChatReady(botId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let prevCount = null;
  let quietSince = 0;
  while (Date.now() < deadline) {
    let state = null;
    try {
      state = await evalJs(`(() => ({
        hasInput: !!document.querySelector('.chat-input textarea'),
        selected: localStorage.getItem('open-bot:selectedBotId'),
        threadRows: document.querySelectorAll('[data-testid="thread-row"]').length,
        msgCount: document.querySelectorAll('.msg').length,
      }))()`);
    } catch {
      // Page busy — keep polling.
    }
    if (state && state.hasInput && state.selected === botId && state.threadRows >= 1) {
      if (prevCount === state.msgCount) {
        if (quietSince === 0) quietSince = Date.now();
        if (Date.now() - quietSince >= 1000) return state;
      } else {
        prevCount = state.msgCount;
        quietSince = 0;
      }
    } else {
      prevCount = null;
      quietSince = 0;
    }
    await sleep(500);
  }
  let diag = '(diagnostic snapshot unavailable)';
  try {
    diag = JSON.stringify(await evalJs(`(() => ({
      hasInput: !!document.querySelector('.chat-input textarea'),
      selected: localStorage.getItem('open-bot:selectedBotId'),
      threadRows: document.querySelectorAll('[data-testid="thread-row"]').length,
      msgCount: document.querySelectorAll('.msg').length,
    }))()`));
  } catch {
    // Keep the timeout error when even diagnostics fail.
  }
  throw new Error(`timed out waiting for chat to be ready for bot ${botId} — diagnostics: ${diag}`);
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

/** Attach the tiny PNG through the hidden file input (same `change` event the attach button feeds). */
async function attachPngViaUi() {
  const res = await evalJs(`(() => {
    const input = document.querySelector('.chat-input input[type="file"]');
    if (!input) return 'no-input';
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'test.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'attached';
  })()`);
  assert.equal(res, 'attached', 'hidden file input must exist for the attach flow');
}

/** Read the latest saved user message for the bot from BotMemory (retries on SQLITE_BUSY). */
function readSavedUserMessage(botId) {
  const dbPath = path.join(wsDir, '.open-bot', 'memory.db');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      assert.ok(fs.existsSync(dbPath), `memory.db must exist at ${dbPath}`);
      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare(
          `SELECT id, content FROM messages WHERE botId = ? AND role = 'user' ORDER BY createdAt DESC, rowid DESC LIMIT 1`,
        ).get(botId);
        return row ? { id: String(row.id), content: String(row.content) } : null;
      } finally {
        db.close();
      }
    } catch (e) {
      if (Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

/**
 * v0.65: read the stored attachment rows of one message (retries on
 * SQLITE_BUSY, like readSavedUserMessage). Returns [] when the message
 * has no attachments.
 */
function readSavedAttachments(messageId) {
  const dbPath = path.join(wsDir, '.open-bot', 'memory.db');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const db = new DatabaseSync(dbPath);
      try {
        return db
          .prepare(
            `SELECT idx, name, mimeType, sizeBytes, fileName FROM message_attachments
             WHERE messageId = ? ORDER BY idx ASC`,
          )
          .all(messageId);
      } finally {
        db.close();
      }
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

test('smoke vision renderer: attached PNG reaches the loop and the text-only model refuses it kindly', { skip: !hasDisplay || !ollamaOk }, async () => {
  const botId = await evalJs(`(async () => {
    const bot = await window.openBot.createBot({
      name: 'SmokeVision',
      providerId: 'ollama',
      model: 'qwen2.5:0.5b',
      systemPrompt: 'You are helpful.',
      workspaceDir: ${JSON.stringify(wsDir)},
      autoApprove: true,
      smallModelGuard: false,
    });
    return bot.id;
  })()`);
  assert.ok(typeof botId === 'string' && botId.length > 0, 'createBot must return a bot id');

  await waitFor(`!!document.querySelector('.chat-input textarea')`, 30_000, 'chat input');
  // v0.85: poll for real chat-ready state instead of a fixed sleep(6000)
  // (see waitForChatReady) — the bot-switch effect must have settled
  // before we send, or a late loadHistory can wipe the just-sent messages.
  await waitForChatReady(botId);

  // 1. Attach the PNG through the real file input; the chip proves the
  //    composer read the image bytes.
  await attachPngViaUi();
  await waitFor(
    `[...document.querySelectorAll('.composer-chip')].some((c) => c.textContent.includes('test.png'))`,
    15_000,
    'composer chip for test.png',
  );

  // 2. Send with a question; the optimistic user bubble must show the
  //    thumbnail immediately (before any run result comes back).
  await sendViaUi('Trong ảnh có gì?');
  await waitFor(`!!document.querySelector('.msg.user img.msg-image-thumb')`, 15_000, 'user bubble thumbnail');
  const thumb = await evalJs(`(() => {
    const img = document.querySelector('.msg.user img.msg-image-thumb');
    if (!img) return null;
    return { srcPrefix: img.src.slice(0, 30), alt: img.alt };
  })()`);
  assert.ok(thumb, 'thumbnail must be in the DOM');
  assert.equal(thumb.srcPrefix, 'data:image/png;base64,iVBORw0K', 'thumbnail is a data URL of the attached PNG');
  assert.equal(thumb.alt, 'test.png');

  // 3. Click the thumbnail: the large preview modal opens, then closes.
  await evalJs(`document.querySelector('.msg.user .msg-image-thumb-btn').click()`);
  await waitFor(`!!document.querySelector('.image-preview-overlay img.image-preview-img')`, 15_000, 'preview modal');
  const previewSrc = await evalJs(`document.querySelector('.image-preview-overlay img.image-preview-img')?.src?.slice(0, 30) ?? null`);
  assert.equal(previewSrc, 'data:image/png;base64,iVBORw0K', 'preview shows the same attached PNG');
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.image-preview-overlay button')].find((b) => b.textContent.includes('Đóng') || b.textContent.includes('Close'));
    if (btn) btn.click();
    return true;
  })()`);
  await waitFor(`!document.querySelector('.image-preview-overlay')`, 15_000, 'preview modal to close');

  // 4. The run must end with the friendly refusal: the vision gate in
  //    the loop refuses qwen2.5:0.5b BEFORE any provider call, so the
  //    reply names the model as unable to view images. A dropped image
  //    would never produce this text. Generous timeout: the coordinator
  //    still resolves tools before the gate runs.
  const t0 = Date.now();
  await waitFor(
    `[...document.querySelectorAll('.msg.assistant')].some((b) => b.textContent.includes('không xem được ảnh'))`,
    180_000,
    'assistant refusal "không xem được ảnh"',
  );
  console.log(`[VISION-SMOKE] refusal arrived after ${Date.now() - t0}ms`);
  const reply = await evalJs(`(() => {
    const bubbles = [...document.querySelectorAll('.msg.assistant')].map((b) => b.textContent);
    return bubbles[bubbles.length - 1]?.slice(0, 400) ?? '';
  })()`);
  assert.match(reply, /qwen2\.5:0\.5b/, 'refusal names the text-only model');
  assert.match(reply, /ollama pull|qwen2\.5-vl|llava/i, 'refusal suggests a vision model');

  // 5. History (v0.65): the saved user row keeps the PLAIN typed text
  //    (no metadata line, no base64 — the DB never holds image bytes);
  //    the image lives as a file under `.open-bot/attachments/` with a
  //    `message_attachments` row, holding the exact PNG bytes.
  const saved = readSavedUserMessage(botId);
  assert.ok(saved !== null, 'a user message must be saved');
  assert.match(saved.content, /Trong ảnh có gì\?/, 'saved row keeps the typed text');
  assert.ok(!saved.content.includes('Ảnh đính kèm'), 'saved row must NOT carry the old metadata line');
  assert.ok(!saved.content.includes(PNG_B64), 'saved row must NOT contain the image base64');
  assert.ok(!saved.content.includes('bot chưa xem được ảnh'), 'saved row must NOT contain the old image note');
  const atts = readSavedAttachments(saved.id);
  assert.equal(atts.length, 1, 'exactly one attachment row for the message');
  assert.equal(atts[0].name, 'test.png');
  assert.equal(atts[0].mimeType, 'image/png');
  assert.equal(atts[0].fileName, '0.png');
  assert.equal(atts[0].sizeBytes, Buffer.from(PNG_B64, 'base64').length);
  const filePath = path.join(wsDir, '.open-bot', 'attachments', saved.id, '0.png');
  assert.ok(fs.existsSync(filePath), `attachment file must exist at ${filePath}`);
  assert.deepEqual(
    fs.readFileSync(filePath),
    Buffer.from(PNG_B64, 'base64'),
    'attachment file holds the exact PNG bytes',
  );
  // The DB file itself must never hold the image bytes either.
  assert.ok(
    !fs.readFileSync(path.join(wsDir, '.open-bot', 'memory.db')).includes(Buffer.from(PNG_B64, 'base64')),
    'memory.db must NOT contain the image bytes',
  );

  // 6. Reload the page: the app restores the bot + thread from storage
  //    (selectedBotId in localStorage) and re-reads history WITH the
  //    stored images — the user bubble must show the thumbnail again,
  //    and clicking it still opens the large preview.
  await cdpCall('Page.enable');
  await cdpCall('Page.reload', { ignoreCache: true });
  // v0.85: after a reload Electron must remount + restore the bot and
  // thread + re-read history and the attachment from disk before the
  // thumbnail renders — 30s was not enough under load, so wait for the
  // chat input first (proves the app is back) and then give the
  // thumbnail 60s. On timeout, dump diagnostics like UI-8 does.
  await waitFor(
    `!!document.querySelector('.chat-input textarea')`,
    60_000,
    'chat input after reload',
  );
  try {
    await waitFor(
      `!!document.querySelector('.msg.user img.msg-image-thumb')`,
      60_000,
      'user bubble thumbnail after reload',
    );
  } catch (e) {
    let diag = '(diagnostic snapshot unavailable)';
    try {
      diag = JSON.stringify(await evalJs(`(() => ({
        userBubbles: document.querySelectorAll('.msg.user').length,
        thumbPresent: !!document.querySelector('.msg.user img.msg-image-thumb'),
        msgCount: document.querySelectorAll('.msg').length,
        selectedBotId: localStorage.getItem('open-bot:selectedBotId'),
      }))()`));
    } catch {
      // Keep the original timeout error when even diagnostics fail.
    }
    throw new Error(`${e.message} — reload-thumbnail diagnostics: ${diag}`);
  }
  const thumbAfterReload = await evalJs(`(() => {
    const img = document.querySelector('.msg.user img.msg-image-thumb');
    if (!img) return null;
    return { srcPrefix: img.src.slice(0, 30), alt: img.alt };
  })()`);
  assert.ok(thumbAfterReload, 'thumbnail must be in the DOM after reload');
  assert.equal(thumbAfterReload.srcPrefix, 'data:image/png;base64,iVBORw0K', 'reloaded thumbnail is a data URL of the attached PNG');
  assert.equal(thumbAfterReload.alt, 'test.png');
  await evalJs(`document.querySelector('.msg.user .msg-image-thumb-btn').click()`);
  await waitFor(`!!document.querySelector('.image-preview-overlay img.image-preview-img')`, 15_000, 'preview modal after reload');
  const previewAfterReload = await evalJs(`document.querySelector('.image-preview-overlay img.image-preview-img')?.src?.slice(0, 30) ?? null`);
  assert.equal(previewAfterReload, 'data:image/png;base64,iVBORw0K', 'preview after reload shows the same attached PNG');

  assert.deepEqual(pageExceptions, [], `no uncaught renderer exceptions (saw: ${pageExceptions.join(' | ')})`);
});
