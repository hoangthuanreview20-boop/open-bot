/**
 * CDP smoke verifying the three UI P1 gaps left open in v0.60
 * (docs/ui-parity-review.md §5) — the REAL Electron app under xvfb.
 *
 * - UI-6: type `/` in the real chat composer, the popup lists REAL slash
 *   commands from the registry (`slash:list` over
 *   `<workspace>/.open-bot/commands/*.md`), pick one with the mouse and
 *   one with the keyboard, and assert each inserts `/name ` into the
 *   textarea.
 * - UI-8: run a REAL turn against the local Ollama bot (qwen2.5:0.5b)
 *   and assert the per-turn usage footer (`[data-testid="turn-usage"]`)
 *   shows real token counts under the assistant bubble.
 * - UI-10: launch with a COMPLETELY fresh profile (fresh XDG dir, no
 *   bots) and assert the 3-step onboarding shows, the one-click sample
 *   bot is created, and the welcome screen never comes back (even after
 *   a reload).
 *
 * UI-6 + UI-8 share one app instance (profile A); UI-10 uses a second
 * instance (profile B) because it needs a bot-less first run.
 *
 * Skips (with a clear message) when there is no DISPLAY or when Ollama
 * does not have qwen2.5:0.5b — same convention as
 * tests/ui-markdown-stop-smoke-v059.test.mjs.
 *
 * Run: xvfb-run -a node --test tests/ui-13-verify-smoke.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const JS_TIMEOUT_MS = 15000;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ollamaOk = false;
try {
  const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  ollamaOk = (data.models ?? []).some((m) => String(m.name ?? '').startsWith('qwen2.5:0.5b'));
} catch {
  ollamaOk = false;
}

/** One launched Electron app + its CDP connection. */
class AppHandle {
  constructor(tag) {
    this.tag = tag;
    this.cdpPort = 9500 + (process.pid % 400) + (tag === 'B' ? 200 : 0);
    this.xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), `open-bot-ui13-${tag}-xdg-`));
    this.child = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.pageExceptions = [];
  }

  evalJs(expression) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP evaluate timed out after ${JS_TIMEOUT_MS}ms: ${expression.slice(0, 120)}`));
      }, JS_TIMEOUT_MS);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) return reject(new Error(`CDP ${m.error.message ?? JSON.stringify(m.error)}`));
        // A rejected promise surfaces here: `exceptionDetails` lives on
        // the top-level evaluate result (`m.result`), NOT inside
        // `m.result.result` (checking the wrong place silently resolved
        // rejections as `undefined` — found by the first UI-6 run).
        const details = m.result?.exceptionDetails;
        if (details) {
          return reject(new Error(`evaluate threw: ${JSON.stringify(details).slice(0, 500)}`));
        }
        const r = m.result?.result;
        resolve(r?.value);
      });
      this.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
  }

  attachWs(pageUrl) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(pageUrl);
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP websocket failed to open'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.exceptionThrown') {
          this.pageExceptions.push(JSON.stringify(m.params?.exceptionDetails ?? m).slice(0, 1000));
          return;
        }
        if (m.id && this.pending.has(m.id)) {
          this.pending.get(m.id)(m);
          this.pending.delete(m.id);
        }
      };
    });
  }

  async connectCdp() {
    // v0.84f: 60s, not 30s — under full-suite load on this small VM a
    // cold second Electron instance can take >30s before it serves its
    // CDP page (the v0.84 suite missed 30s; the app itself was fine
    // and served the page shortly after). The assertion is unchanged,
    // only the load allowance grows.
    const deadline = Date.now() + 60_000;
    let pageUrl = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`)).json();
        const main = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
        if (main) { pageUrl = main.webSocketDebuggerUrl; break; }
      } catch {
        // DevTools not up yet.
      }
      await sleep(500);
    }
    assert.ok(pageUrl, 'CDP page target (index.html) did not appear in 60s');
    await this.attachWs(pageUrl);
    this.ws.send(JSON.stringify({ id: this.nextId++, method: 'Runtime.enable', params: {} }));
    this.ws.send(JSON.stringify({ id: this.nextId++, method: 'Page.enable', params: {} }));
    const mountDeadline = Date.now() + 30_000;
    while (Date.now() < mountDeadline) {
      const n = await this.evalJs(`document.getElementById('root')?.children.length ?? 0`);
      if (typeof n === 'number' && n > 0) return;
      await sleep(500);
    }
    throw new Error('React did not mount in the app window within 30s');
  }

  async launch() {
    this.child = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${this.cdpPort}`], {
      cwd: APP_DIR,
      env: { ...process.env, XDG_CONFIG_HOME: this.xdgDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {});
    await this.connectCdp();
  }

  async reload() {
    try {
      this.ws.send(JSON.stringify({
        id: this.nextId++, method: 'Runtime.evaluate',
        params: { expression: 'location.reload()', returnByValue: true },
      }));
    } catch { /* socket drops on navigation — expected */ }
    await sleep(2000);
    this.pending.clear();
    await this.connectCdp();
  }

  async quit() {
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } this.ws = null; }
    this.pending.clear();
    if (!this.child) return;
    const proc = this.child;
    this.child = null;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
  }

  cleanup() {
    fs.rmSync(this.xdgDir, { recursive: true, force: true });
  }

  async waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evalJs(expression);
        if (last) return last;
      } catch {
        // Page busy / reloading — keep polling.
      }
      await sleep(300);
    }
    throw new Error(`timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
  }

  async screenshot(filePath) {
    const id = this.nextId++;
    const shot = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('screenshot timed out')), JS_TIMEOUT_MS);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) return reject(new Error(`CDP screenshot: ${JSON.stringify(m.error)}`));
        // captureScreenshot answers { result: { data } } — NOT the
        // Runtime.evaluate shape { result: { result: { value } } }.
        resolve(m.result?.data ?? null);
      });
      this.ws.send(JSON.stringify({
        id, method: 'Page.captureScreenshot', params: { format: 'png' },
      }));
    });
    if (shot) fs.writeFileSync(filePath, Buffer.from(shot, 'base64'));
    return filePath;
  }
}

/** Type `text` into the React-controlled chat textarea (no send). */
async function typeIntoComposer(app, text) {
  return app.evalJs(`(() => {
    const ta = document.querySelector('.chat-input textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

/** Click the Send button, like a user. */
async function clickSend(app) {
  return app.evalJs(`(() => {
    const sendBtn = [...document.querySelectorAll('.chat-input button')].find(
      (b) => b.textContent.trim() === 'Gửi' || b.textContent.trim() === 'Send',
    );
    if (!sendBtn || sendBtn.disabled) return false;
    sendBtn.click();
    return true;
  })()`);
}

// ---------------------------------------------------------------------------
// Profile A: UI-6 (slash popup with the real registry) + UI-8 (live turn).
// ---------------------------------------------------------------------------
const wsDirA = path.join(os.homedir(), 'workspace', `open-bot-smoke-ui13-${process.pid}`);
const appA = new AppHandle('A');
let botIdA = null;

test.before(async () => {
  if (!hasDisplay || !ollamaOk) return;
  // UI-6: seed REAL slash commands the registry reads — markdown files
  // in <workspace>/.open-bot/commands (name = file, description = the
  // first `# ...` line). Written BEFORE createBot so the first
  // `slash:list` call (ChatView mount) already sees them.
  const cmdDir = path.join(wsDirA, '.open-bot', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(
    path.join(cmdDir, 'hello.md'),
    '# Say hello in Vietnamese\n\nSay hello to the user in Vietnamese, warmly and briefly.\n',
  );
  fs.writeFileSync(
    path.join(cmdDir, 'review.md'),
    '# Review this code\n\nReview the code the user pastes and list concrete issues.\n',
  );
  await appA.launch();
});

test.after(async () => {
  await appA.quit();
  appA.cleanup();
  fs.rmSync(wsDirA, { recursive: true, force: true });
});

test('smoke UI-6: slash popup lists real registry commands, mouse + keyboard pick inserts them', { skip: !hasDisplay || !ollamaOk }, async () => {
  botIdA = await appA.evalJs(`(async () => {
    const bot = await window.openBot.createBot({
      name: 'Smoke13',
      providerId: 'ollama',
      model: 'qwen2.5:0.5b',
      systemPrompt: 'You are helpful. Reply briefly.',
      workspaceDir: ${JSON.stringify(wsDirA)},
      autoApprove: true,
      // v0.85: guard ON (was false) — for the 0.5b model it forces
      // plan-mode + grouped tools instead of the full registry, so
      // the UI-8 live turn prefills a minimal tool set and its time
      // stops depending on machine load. The slash popup this test
      // checks reads the slash-command registry, not tools, so the
      // guard changes nothing here.
      smallModelGuard: true,
    });
    return bot.id;
  })()`);
  assert.ok(typeof botIdA === 'string' && botIdA.length > 0, 'createBot must return a bot id');
  console.log(`[ui-13 smoke] created bot ${botIdA} (typeof ${typeof botIdA})`);

  // `bots:create` broadcasts `bots:changed` (v0.61), so the renderer
  // reloads the list and auto-selects the new bot — the chat appears
  // without a reload.
  await appA.waitFor(`!!document.querySelector('.chat-input textarea')`, 30_000, 'chat input');
  // Let the bot-switch effect finish (threads + history load) and the
  // slash list load from the real registry.
  await sleep(6000);

  // The registry itself must see the seeded files (IPC, not DOM).
  const listed = await appA.evalJs(`window.openBot.listSlashCommands(${JSON.stringify(botIdA)})`);
  assert.ok(Array.isArray(listed), 'slash:list must return an array');
  assert.deepEqual(
    listed.map((c) => c.name).sort(),
    ['hello', 'review'],
    `slash:list must return the seeded commands, got ${JSON.stringify(listed)}`,
  );

  // Type `/` — the popup must show both real commands with their
  // real descriptions from the markdown files.
  assert.equal(await typeIntoComposer(appA, '/'), true, 'typing / into the composer');
  await appA.waitFor(
    `(() => { const p = document.querySelector('[data-testid="composer-autocomplete"]'); return p && p.textContent.includes('/hello') && p.textContent.includes('/review'); })()`,
    15_000,
    'autocomplete popup with /hello and /review',
  );
  const popup = await appA.evalJs(`(() => {
    const p = document.querySelector('[data-testid="composer-autocomplete"]');
    const items = [...p.querySelectorAll('[role="option"]')].map((el) => el.textContent);
    return { items, hasHelloDesc: p.textContent.includes('Say hello in Vietnamese'), hasReviewDesc: p.textContent.includes('Review this code') };
  })()`);
  assert.equal(popup.items.length, 2, `popup must list exactly 2 commands, got ${JSON.stringify(popup.items)}`);
  assert.ok(popup.hasHelloDesc, 'popup must show the real /hello description from hello.md');
  assert.ok(popup.hasReviewDesc, 'popup must show the real /review description from review.md');
  await appA.screenshot('/tmp/open-bot-ui13-slash-popup.png');

  // Pick /hello with the MOUSE (mousedown — the component selects on
  // mousedown so the textarea never loses focus).
  await appA.evalJs(`(() => {
    const item = [...document.querySelectorAll('[data-testid="composer-autocomplete"] [role="option"]')]
      .find((el) => el.textContent.includes('/hello'));
    if (!item) return false;
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await appA.waitFor(
    `document.querySelector('.chat-input textarea')?.value === '/hello '`,
    10_000,
    'textarea to contain "/hello " after mouse pick',
  );

  // Pick /review with the KEYBOARD: retype, arrow down, Enter.
  assert.equal(await typeIntoComposer(appA, '/rev'), true, 'typing /rev into the composer');
  await appA.waitFor(
    `(() => { const p = document.querySelector('[data-testid="composer-autocomplete"]'); return p && p.textContent.includes('/review'); })()`,
    15_000,
    'autocomplete popup with /review for query /rev',
  );
  await appA.evalJs(`(() => {
    const ta = document.querySelector('.chat-input textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await appA.waitFor(
    `document.querySelector('.chat-input textarea')?.value === '/review '`,
    10_000,
    'textarea to contain "/review " after keyboard pick',
  );
  // Clear the composer for the UI-8 turn.
  assert.equal(await typeIntoComposer(appA, ''), true, 'clearing the composer');
  assert.deepEqual(appA.pageExceptions, [], `no uncaught renderer exceptions in UI-6 (saw: ${appA.pageExceptions.join(' | ')})`);
});

test('smoke UI-8: a live Ollama turn shows a real token footer under the assistant bubble', { skip: !hasDisplay || !ollamaOk }, async () => {
  // v0.85: UI-8 no longer depends on UI-6 having run first — if the
  // UI-6 bot does not exist (UI-6 skipped/failed, or file order
  // changes), create an equivalent bot here (same minimal-tool
  // smallModelGuard setup as UI-6) instead of failing on a missing
  // botIdA.
  if (!botIdA) {
    botIdA = await appA.evalJs(`(async () => {
      const bot = await window.openBot.createBot({
        name: 'Smoke13',
        providerId: 'ollama',
        model: 'qwen2.5:0.5b',
        systemPrompt: 'You are helpful. Reply briefly.',
        workspaceDir: ${JSON.stringify(wsDirA)},
        autoApprove: true,
        smallModelGuard: true,
      });
      return bot.id;
    })()`);
    assert.ok(typeof botIdA === 'string' && botIdA.length > 0, 'createBot must return a bot id');
    console.log(`[ui-13 smoke] UI-8 created its own bot ${botIdA} (UI-6 did not run first)`);
  }
  await appA.waitFor(`!!document.querySelector('.chat-input textarea')`, 30_000, 'chat input');
  await sleep(2000);
  assert.equal(await typeIntoComposer(appA, 'Say hi in exactly 3 words.'), true, 'typing the prompt');
  assert.equal(await clickSend(appA), true, 'clicking Send');

  // v0.85: the bot now runs with smallModelGuard ON, so the tiny
  // model prefills the forced minimal tool set instead of the full
  // registry — the turn time should no longer track machine load.
  // The settle allowance still grows 240s -> 300s: the old 240s
  // budget was already exceeded twice (242s, turn still generating)
  // when the model was cold, and a slow failure is cheaper than a
  // load flake.
  const settledAt = Date.now();
  try {
    await appA.waitFor(
      `(() => { const ta = document.querySelector('.chat-input textarea'); return ta && !ta.disabled && !document.querySelector('[data-testid="stop-run-button"]') && document.querySelectorAll('.msg.assistant').length > 0; })()`,
      300_000,
      'live turn to settle (input enabled, Stop gone, assistant bubble present)',
    );
  } catch (e) {
    let diag = '(diagnostic snapshot unavailable)';
    try {
      diag = JSON.stringify(await appA.evalJs(`(() => {
        const ta = document.querySelector('.chat-input textarea');
        return {
          inputDisabled: ta ? ta.disabled : 'no-textarea',
          stopButtonPresent: !!document.querySelector('[data-testid="stop-run-button"]'),
          assistantBubbles: document.querySelectorAll('.msg.assistant').length,
          lastAssistantHead: ([...document.querySelectorAll('.msg.assistant')].pop()?.textContent ?? '').slice(0, 200),
          usageFooters: document.querySelectorAll('[data-testid="turn-usage"]').length,
        };
      })()`));
    } catch {
      // Keep the original timeout error when even diagnostics fail.
    }
    throw new Error(`${e.message} — settle-timeout diagnostics: ${diag}`);
  }
  const settleSecs = Math.round((Date.now() - settledAt) / 1000);

  const footer = await appA.evalJs(`(() => {
    const el = document.querySelector('[data-testid="turn-usage"]');
    return el ? el.textContent : null;
  })()`);
  assert.ok(
    typeof footer === 'string' && footer.length > 0,
    `turn-usage footer must be present under the assistant bubble after a live turn (settle took ${settleSecs}s)`,
  );
  const nums = [...footer.matchAll(/(\d[\d,]*)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  assert.ok(nums.length >= 2, `footer must carry input + output token counts, got ${JSON.stringify(footer)}`);
  assert.ok(nums[0] > 0 && nums[1] > 0, `footer token counts must be real (non-zero), got ${JSON.stringify(footer)}`);
  assert.ok(nums[0] + nums[1] > 0, 'footer total tokens must be > 0');

  // Cross-check: the usage store itself must have moved for this bot.
  const usage = await appA.evalJs(`window.openBot.getUsage(${JSON.stringify(botIdA)})`);
  const total = usage?.total ?? usage?.today ?? null;
  assert.ok(
    total && total.inputTokens + total.outputTokens > 0,
    `usage:get totals must be non-zero after the turn, got ${JSON.stringify(total)}`,
  );

  assert.deepEqual(appA.pageExceptions, [], `no uncaught renderer exceptions in UI-8 (saw: ${appA.pageExceptions.join(' | ')})`);
});

// ---------------------------------------------------------------------------
// Profile B: UI-10 (onboarding on a completely fresh profile).
// ---------------------------------------------------------------------------
const appB = new AppHandle('B');

test('smoke UI-10: fresh profile shows 3-step onboarding, sample bot in 1 click, never again', { skip: !hasDisplay || !ollamaOk }, async () => {
  // v0.84f: launch() is INSIDE the try — it used to sit above it, so a
  // launch/connect failure skipped the finally, leaked the Electron
  // child, and stalled the whole full suite forever (the child holds
  // the test process event loop open; seen in the v0.84 full suite:
  // CDP page target missed its 30s deadline under load, UI-10 failed,
  // and the suite hung ~20 min until the app was killed by hand).
  try {
    await appB.launch();
    // A fresh profile must show the welcome screen, not the chat.
    await appB.waitFor(`!!document.querySelector('.onboarding')`, 30_000, 'onboarding screen on a fresh profile');
    const steps = await appB.evalJs(`(() => ({
      stepCount: document.querySelectorAll('.onboarding-steps li').length,
      hasSampleButton: [...document.querySelectorAll('.onboarding button')].some((b) => b.textContent.includes('Tạo bot mẫu')),
      hasOwnButton: [...document.querySelectorAll('.onboarding button')].some((b) => b.textContent.includes('Tạo bot của tôi')),
      hasDismiss: [...document.querySelectorAll('.onboarding button')].some((b) => b.textContent.includes('Để sau')),
    }))()`);
    assert.equal(steps.stepCount, 3, `onboarding must have 3 steps, got ${steps.stepCount}`);
    assert.ok(steps.hasSampleButton, 'onboarding must offer the one-click sample bot');
    assert.ok(steps.hasOwnButton, 'onboarding must offer creating your own bot');
    assert.ok(steps.hasDismiss, 'onboarding must offer skipping it');
    await appB.screenshot('/tmp/open-bot-ui13-onboarding.png');

    // One click on the sample bot: it must be created and the welcome
    // screen must go away (replaced by the chat for the new bot).
    await appB.evalJs(`(() => {
      const btn = [...document.querySelectorAll('.onboarding button')].find((b) => b.textContent.includes('Tạo bot mẫu'));
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    await appB.waitFor(
      `!document.querySelector('.onboarding') && !!document.querySelector('.chat-input textarea')`,
      30_000,
      'onboarding to go away and chat to appear after sample-bot creation',
    );
    const bots = await appB.evalJs(`window.openBot.listBots()`);
    assert.ok(Array.isArray(bots) && bots.length === 1, `exactly one sample bot must exist, got ${JSON.stringify(bots)}`);
    assert.ok(
      typeof bots[0].name === 'string' && bots[0].name.includes('Trợ lý mẫu'),
      `sample bot must be named the onboarding sample, got ${JSON.stringify(bots[0])}`,
    );
    const flag = await appB.evalJs(`localStorage.getItem('open-bot:onboardingDone')`);
    assert.equal(flag, '1', 'onboarding-done flag must be set after creating the sample bot');

    // Reload: the welcome screen must NOT come back.
    await appB.reload();
    await appB.waitFor(`!!document.querySelector('.chat-input textarea')`, 30_000, 'chat input after reload');
    await sleep(2000);
    assert.equal(
      await appB.evalJs(`!!document.querySelector('.onboarding')`),
      false,
      'onboarding must not reappear after reload',
    );
    const botsAfter = await appB.evalJs(`window.openBot.listBots()`);
    assert.equal(botsAfter.length, 1, 'the sample bot must survive the reload');

    assert.deepEqual(appB.pageExceptions, [], `no uncaught renderer exceptions in UI-10 (saw: ${appB.pageExceptions.join(' | ')})`);
  } finally {
    await appB.quit();
    appB.cleanup();
  }
});
