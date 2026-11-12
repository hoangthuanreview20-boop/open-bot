/**
 * Real click test for the L5 confirm dialog (audit v0.15, fixed v0.17).
 *
 * The dialog: SettingsView.changeNoStorage() asks with TWO in-app
 * ConfirmModal steps when NO_STORAGE is turned off while temporary
 * secrets exist (v0.71: the two native window.confirm boxes are gone;
 * the flow is identical, only the dialog is the shared in-app modal):
 *   1. vaultNoStorageFlushConfirm — "turning it off will save N temporary
 *      secrets to disk. Continue?"  (Cancel = do nothing)
 *   2. vaultNoStorageDiscardConfirm — "delete the N temporary secrets
 *      instead of saving them? Delete = delete, Cancel = save."
 * BEYOND-ROADMAP v0.17 noted this dialog was "chưa click thử bằng
 * tay/automation" — this file closes that gap by REALLY clicking it.
 *
 * How it works (no mocks for the click path):
 *   - Launches the REAL Electron app (apps/desktop, production build)
 *     under xvfb with an isolated XDG_CONFIG_HOME.
 *   - Seeds vault state through the app's own IPC (window.openBot):
 *     NO_STORAGE on + one temporary secret.
 *   - Clicks with the REAL computer-use tools (computer_mouse_move /
 *     computer_click from packages/tools) — the same tools the agent
 *     uses. Element positions come from CDP (locator only); the clicks
 *     themselves are genuine xdotool clicks, and the assertions read
 *     real vault state (IPC + the encrypted store file on disk + a
 *     full app restart).
 *   - Unlike the old native window.confirm (which blocked the renderer
 *     JS thread), the in-app modal never blocks JS: "modal is open" is
 *     proven by the `[data-testid="confirm-modal"]` element being in
 *     the DOM, and the test asserts JS stays responsive while it is
 *     open. Modal buttons are clicked for real at their measured
 *     screen positions, like the toggle itself.
 *
 * Full-suite flake, hardened (merge/l5-vault-hardening): the file used
 * to click once (raise, mousemove, click — three separate xdotool
 * spawns) and then wait for the modal. Under full-suite load another
 * test's app window can be raised in the gap, so the click lands in
 * the other window at the same screen coordinates and no modal ever
 * appears ("NO MODAL after click", toggle unchanged — seen twice in
 * the v0.72/v0.73 full-suite logs, each time a different test). Every
 * real click now goes through clickUntilEffect: raise, click with the
 * real computer-use tools, then poll the effect in OUR app over CDP
 * and retry the click until the effect is observed. Same clicks, same
 * assertions, same timeouts — a missed click is retried, never
 * silently accepted. See clickUntilEffect for the full analysis
 * (including why a retry is safe for every click site here).
 *
 * Hardened again (v0.85): the 8s MODAL_WAIT_MS allowed only ~2-3 real
 * clicks under full-suite load (each round costs seconds: readToggle
 * = 2 evalJs + 400ms sleep, plus geometry xdotool spawns), and the
 * loop could expire the deadline mid-measure with no final effect
 * check — click landed (toggleAfter=true), modal open, poll never saw
 * it. Fix, both halves, keeping clickUntilEffect's contract:
 * MODAL_WAIT_MS 8s -> 20s, and a 2s final grace poll decoupled from
 * the click loop (no more clicks, just observation at 100ms cadence).
 * Anti-cascade: each test now rebuilds its own start state via IPC
 * (resetVaultToTempPending / resetVaultToOffFlushed) instead of
 * assuming the previous test's end state, and afterEach logs the real
 * vault state after dismissing a leftover modal instead of assuming
 * the vault is clean.
 *
 * Fault-injection (v0.86): the v0.85 verification noted the reset
 * slow path had never run for real — every passing run took the fast
 * path (state already canonical, early return), so the rebuild +
 * reload + re-open branch was unverified code. The three tests at the
 * end of this file fix that: each one corrupts the live vault state
 * through IPC first (wrong mode, wrong keys, a stray temp-key-2 on
 * disk, a modal left open), then calls the reset and asserts the
 * canonical state is rebuilt AND the Settings checkbox reflects it
 * after the reload. `slowPathRuns` counts slow-path entries so the
 * tests prove the slow path ran, not just that the end state happens
 * to look right (a fast-path early return would leave the counter
 * unchanged and the corrupted state in place).
 *
 * Run under xvfb (needs a real X display):
 *   xvfb-run -a node --test tests/vault-confirm-l5-click.test.mjs
 * Without DISPLAY the file skips with a clear message (same convention
 * as tests/computer-use-v06.test.mjs).
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Vault } from '../packages/core/dist/index.js';
import { COMPUTER_USE_TOOLS, getDisplayGeometry } from '../packages/tools/dist/computerUse.js';
import { CDP_DEADLINE_MS } from './cdp-deadline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
const APP_DIR = path.join(REPO, 'apps', 'desktop');
const CDP_PORT = 9300 + (process.pid % 500);
// v0.85: 20s, not 8s — under full-suite load one click round costs
// seconds (readToggle = 2 evalJs + 400ms sleep, plus geometry xdotool
// spawns and a chromeOffsetY evalJs), so 8s allowed only ~2-3 real
// clicks before the wait expired even though the click had landed
// (toggleAfter=true) and the modal just had not been observed yet.
// 20s allows ~5-7 rounds; the final grace poll in clickUntilEffect
// covers a modal that appears during the last round (see there).
const MODAL_WAIT_MS = 20000;
const JS_TIMEOUT_MS = 5000;
/** How long to wait after a real click for its effect before concluding the click missed and retrying. */
const CLICK_RETRY_AFTER_MS = 1500;

const hasDisplay = Boolean(process.env.DISPLAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tool = (name) => COMPUTER_USE_TOOLS.find((t) => t.definition.name === name);
const CTX = (workspaceDir) => ({ workspaceDir, botId: 'l5-click-test' });

/** Run xdotool (harness helper: geometry / window list only). */
function xdo(...args) {
  return execFileSync('xdotool', args, { encoding: 'utf8' }).trim();
}

/** Geometry of one X window id: { x, y, w, h }. */
function windowGeometry(id) {
  const out = xdo('getwindowgeometry', id);
  const m = out.match(/Position:\s*(\d+),(\d+)[^\n]*\n\s*Geometry:\s*(\d+)x(\d+)/);
  assert.ok(m, `could not parse geometry for window ${id}: ${out}`);
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
}

// ---------------------------------------------------------------------------
// App harness (Electron + CDP). CDP is only a locator / state reader:
// every click goes through the computer-use tools below.
// ---------------------------------------------------------------------------

let child = null;
let ws = null;
let msgId = 0;
const pending = new Map();
let xdgDir = '';
let workDir = '';

function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error
      ? reject(new Error(`CDP ${method} failed: ${JSON.stringify(m.error)}`))
      : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Evaluate JS in the renderer. Returns `{ __blocked: true }` when the
 * call does not answer in time (a hung renderer — the in-app modal
 * never blocks JS, so a timeout here means something else is wrong).
 */
function evalJs(expression, timeoutMs = JS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ __blocked: true });
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) return reject(new Error(`CDP evaluate failed: ${JSON.stringify(m.error)}`));
      if (m.result?.exceptionDetails) {
        return reject(new Error(`page exception: ${JSON.stringify(m.result.exceptionDetails).slice(0, 400)}`));
      }
      resolve(m.result?.result?.value);
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

async function connectCdp() {
  // v0.85: 60s, not 30s — a cold Electron under full-suite load can
  // miss 30s before it serves /json/list (see tests/cdp-deadline.mjs).
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
  ws = new WebSocket(pageUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed to open'));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    // Late responses (e.g. an evaluate queued while a dialog was open)
    // arrive after their caller timed out: ignore them.
  };
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
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {
    // App stderr is noisy under xvfb (D-Bus, GPU); ignore it here.
  });
  return connectCdp();
}

async function quitApp() {
  if (!child) return;
  const proc = child;
  child = null;
  if (ws) {
    try { ws.close(); } catch { /* already closed */ }
    ws = null;
  }
  pending.clear();
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  const done = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
  if (!done) proc.kill('SIGKILL');
  await exited.catch(() => undefined);
}

/** Reload the renderer (v0.85): SettingsView fetches the vault status
 * only on mount, so after an IPC reset the checkbox is stale until the
 * view remounts. A reload remounts everything; the vault itself lives
 * in main, so its state survives. Mirrors the reload() in
 * tests/ui-13-verify-smoke.test.mjs (fire-and-forget reload, drop the
 * old socket, re-attach CDP with the same connectCdp). */
async function reloadRenderer() {
  try {
    ws.send(JSON.stringify({
      id: ++msgId, method: 'Runtime.evaluate',
      params: { expression: 'location.reload()', returnByValue: true },
    }));
  } catch {
    // Socket drops on navigation — expected.
  }
  await sleep(2000);
  pending.clear();
  try { ws.close(); } catch { /* already closed */ }
  ws = null;
  await connectCdp();
}

/** Find vault.json under the isolated XDG dir (proves where the app put it). */
function findVaultStore() {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'vault.json') hits.push(full);
    }
  };
  walk(xdgDir, 0);
  assert.equal(hits.length, 1, `expected exactly one vault.json under ${xdgDir}, found ${hits.length}`);
  return hits[0];
}

// ---------------------------------------------------------------------------
// Real clicks via the computer-use tools + dialog helpers
// ---------------------------------------------------------------------------

async function clickAt(x, y) {
  const moved = await tool('computer_mouse_move').execute({ x, y }, CTX(workDir));
  assert.doesNotMatch(moved, /^Error:/, moved);
  const clicked = await tool('computer_click').execute({ button: 'left' }, CTX(workDir));
  assert.doesNotMatch(clicked, /^Error:/, clicked);
}

/**
 * Real click with effect verification — the fix for the full-suite-only
 * L5 flake (v0.72 / v0.73 full-suite logs, twice, each time a different
 * test: `[L5] NO MODAL after click={"x":767,"y":515} toggleBefore=true
 * toggleAfter=true` — "no confirm modal containing \"secret tạm\"
 * appeared within 8000ms (last text: null)"). The coordinates were the
 * same as in the passing runs, so the click did not land in the wrong
 * place — it never reached our app at all.
 *
 * Root cause, not a timeout: the full suite runs many Electron apps on
 * ONE X display, all titled 'Open Bot' at the same 0,112 1280x800
 * geometry, fully overlapping. One click is three separate xdotool
 * spawns (raise, mousemove, click) with JS in between, so another
 * test's raise can land in the gap and our click hits the other app's
 * window at the same screen coordinates — the toggle never fires, no
 * modal ever appears, and no amount of waiting for the modal helps.
 * Two other causes were ruled out: CDP (test 1 passed with correct
 * vault state in both failures, so the WebSocket was attached to our
 * app) and geometry separation (impossible — every window is
 * full-width on a 1280x1024 screen, so any point inside ours is
 * inside the others' rects). This is the same shape as the v0.73b
 * sandbox SIGKILL fix: wait for the real readiness signal instead of
 * trusting a fire-and-forget action plus a fixed sleep.
 *
 * So instead of click-once-then-wait, every real click in this file
 * goes through here: raise, click with the real computer-use tools,
 * then poll `effect` (a CDP read of OUR app) for `retryAfterMs`; if
 * the effect is still absent the click must have missed, so measure
 * again and click again, until `timeoutMs`. A retry is safe for every
 * site used here: the toggle is controlled (a second changeNoStorage
 * just re-sets the identical pending ConfirmModal), modal buttons
 * close the modal and run idempotent vault actions (applyNoStorage
 * twice = the same end state), and nav clicks just re-render the same
 * view. Nothing here weakens an assertion: the effect itself is the
 * assertion's precondition, and the same timeouts as before
 * (MODAL_WAIT_MS — 20s since v0.85 — / 10s, plus a 2s final grace
 * poll below) still bound the wait.
 *
 * `measure` returns the screen point to click, or null when the target
 * is not measurable right now (never click blind). `effect` returns a
 * truthy value when the click took effect, else null/false. Transient
 * CDP read errors count as "no effect yet" and are reported if the
 * wait finally times out.
 */
async function clickUntilEffect(measure, effect, { timeoutMs = 10_000, retryAfterMs = CLICK_RETRY_AFTER_MS, label = 'click' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let rounds = 0;
  let clicks = 0;
  let lastEffect = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastEffect = await effect();
    } catch (e) {
      lastError = String(e).slice(0, 200);
      lastEffect = null;
    }
    if (lastEffect) return lastEffect;
    rounds += 1;
    let p = null;
    try {
      p = await measure();
    } catch (e) {
      // The target itself vanished (view unmounted, app gone): that is
      // a real failure, not a missed click — fail fast with the cause.
      throw new Error(`${label}: could not measure click target on round ${rounds}: ${e.message}`);
    }
    if (p) {
      raiseMainWindow();
      await clickAt(p.x, p.y);
      clicks += 1;
    }
    const pollUntil = Math.min(Date.now() + retryAfterMs, deadline);
    while (Date.now() < pollUntil) {
      await sleep(100);
      try {
        lastEffect = await effect();
      } catch (e) {
        lastError = String(e).slice(0, 200);
        lastEffect = null;
      }
      if (lastEffect) return lastEffect;
    }
    console.log(`[L5] click retry ${rounds} (${label}): no effect yet${clicks === 0 ? ' (target not measurable, no click sent)' : `, ${clicks} click(s) sent`}, trying again`);
  }
  // v0.85: final grace poll, DECOUPLED from the click loop — the
  // deadline can expire mid-measure/mid-click, after the last poll
  // window closed, so a modal that appeared during that final round
  // was never observed (the 8s failure shape: click landed, modal
  // open, poll never saw it). No more clicks here, just observation
  // at waitForModalText's 100ms cadence, before giving up.
  const graceUntil = Date.now() + 2000;
  while (Date.now() < graceUntil) {
    try {
      lastEffect = await effect();
    } catch (e) {
      lastError = String(e).slice(0, 200);
      lastEffect = null;
    }
    if (lastEffect) return lastEffect;
    await sleep(100);
  }
  throw new Error(`${label}: no effect after ${clicks} click(s) in ${timeoutMs}ms${clicks === 0 ? ' (target never measurable)' : ''} (last effect: ${JSON.stringify(lastEffect)}${lastError ? `, last read error: ${lastError}` : ''})`);
}

async function mainWindowGeometry() {
  const id = mainWindowId();
  assert.ok(id, 'main window "Open Bot" not found');
  return windowGeometry(id);
}

/**
 * Our app's main window id. `search --name 'Open Bot'` alone is not
 * enough: the full suite runs many Electron apps on ONE X display, all
 * titled 'Open Bot' at the same 0,112 1280x800 geometry (fully
 * overlapping). Our pid owns two windows — a 10x10 'electron' helper
 * and the 1280x800 main window — so intersecting the pid's windows
 * with the title match identifies ours and only ours. Falls back to
 * the first title match when the pid lookup fails (same geometry
 * either way, so coordinates are unaffected).
 */
function mainWindowId() {
  try {
    const byPid = new Set(
      xdo('search', '--pid', String(child.pid)).split('\n').filter(Boolean),
    );
    const named = xdo('search', '--name', 'Open Bot').split('\n').filter(Boolean);
    return named.find((id) => byPid.has(id)) ?? named[0] ?? null;
  } catch {
    try {
      return xdo('search', '--name', 'Open Bot').split('\n')[0] ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Raise our main window above every other test's app window before a
 * real screen click lands on it. Under plain xvfb there is no window
 * manager, so windowactivate/getactivewindow do not work — but
 * windowraise (plain XRaiseWindow) does, and `search` order follows
 * the stacking order (verified: raising a window moves it last).
 * Without this, a click at our coordinates hits whichever app happens
 * to be topmost — the full-suite-only flake where a nav/toggle click
 * silently lands in another test's window and no dialog ever appears.
 * Best-effort: if the raise fails the click still goes ahead.
 * NOTE: never raise before a click on the native confirm dialog
 * itself — the dialog is a separate top-level window, already
 * topmost, and raising main would cover it.
 *
 * After raising, verify our window is actually topmost: `search`
 * order follows the stacking order, so our id must be last. If
 * another test raised its window in between, raise once more — the
 * clickUntilEffect retry loop is the backstop when even that loses
 * the race, so this never throws.
 */
function raiseMainWindow() {
  try {
    const id = mainWindowId();
    if (!id) return;
    xdo('windowraise', id);
    const order = xdo('search', '--name', 'Open Bot').split('\n').filter(Boolean);
    if (order.length > 1 && order[order.length - 1] !== id) {
      // Lost the race already (another test raised its window after
      // ours): raise once more before the click below.
      xdo('windowraise', id);
    }
  } catch {
    // Best-effort only; the click below still runs.
  }
}

/** Native menu-bar height above the web viewport (Electron menu). */
async function chromeOffsetY() {
  const v = await evalJs(`window.outerHeight - window.innerHeight`);
  assert.equal(typeof v, 'number');
  return v;
}

/** Viewport rect (CDP) -> absolute screen point. */
function toScreen(rect, win, chromeY) {
  return {
    x: Math.round(win.x + rect.x + rect.w / 2),
    y: Math.round(win.y + chromeY + rect.y + rect.h / 2),
  };
}

/**
 * In-app ConfirmModal helpers (v0.71: the native window.confirm boxes
 * are gone, the two L5 steps are the shared ConfirmModal). Unlike a
 * native dialog, the modal never blocks the renderer JS thread, so
 * detection is a plain DOM query over CDP — no X window scan, no
 * blocked-thread probe. The buttons are still clicked for real
 * (computer-use tools at the measured screen position).
 */

/** Full text of the open ConfirmModal, or null when no modal is open. */
async function modalText() {
  return evalJs(`document.querySelector('[data-testid="confirm-modal"]')?.textContent ?? null`);
}

/**
 * Wait until a ConfirmModal is open whose text contains `substring`
 * (the two L5 steps are told apart by their message: the flush step
 * mentions saving the temporary secrets, the discard step mentions
 * deleting them instead). Returns the modal text.
 */
async function waitForModalText(substring, timeoutMs = MODAL_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await modalText();
    if (typeof last === 'string' && last.includes(substring)) return last;
    await sleep(100);
  }
  throw new Error(`no confirm modal containing ${JSON.stringify(substring)} appeared within ${timeoutMs}ms (last text: ${JSON.stringify(last)})`);
}

/** Wait until no ConfirmModal is open. */
async function waitForModalGone(timeoutMs = MODAL_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await modalText()) === null) return;
    await sleep(100);
  }
  throw new Error('confirm modal did not close within ' + timeoutMs + 'ms');
}

/**
 * Click a ConfirmModal button for real: measure its bounding rect over
 * CDP, convert to screen coordinates, click with the computer-use
 * tools. `which` is 'confirm' (the action button) or 'cancel'.
 * The click goes through clickUntilEffect: under full-suite load the
 * raise-then-click race can send the click to another test's window,
 * so the click is retried until its effect is observed — the modal
 * closing (default) or the next step's text appearing (pass
 * `{ waitGone: false }` when the confirm opens the next modal step:
 * React batches the two setPendingConfirm calls, so the modal never
 * unmounts between the L5 steps — wait for the new step's text
 * instead). The button rect is re-measured on every attempt, so a
 * retry never clicks a stale position after the modal moved or closed.
 */
async function clickModalButton(which, { waitGone = true } = {}) {
  const effect = waitGone
    ? async () => ((await modalText()) === null ? true : null)
    : async () => {
        const m = await modalText();
        return (typeof m === 'string' && m.includes('thay vì lưu xuống đĩa')) ? m : null;
      };
  await clickUntilEffect(
    async () => {
      const win = await mainWindowGeometry();
      const chromeY = await chromeOffsetY();
      const rect = await evalJs(`(() => {
        const b = document.querySelector('[data-testid="confirm-modal-${which}"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
      return rect ? toScreen(rect, win, chromeY) : null;
    },
    effect,
    { timeoutMs: MODAL_WAIT_MS, label: `confirm modal ${which}${waitGone ? '' : ' (step 1 -> step 2)'}` },
  );
}

// --- vault state readers (through the app's own IPC / disk) ---

async function vaultStatus() {
  const s = await evalJs(`window.openBot.getVaultNoStorage()`);
  assert.ok(s && typeof s.enabled === 'boolean', `bad vault status: ${JSON.stringify(s)}`);
  return s;
}

async function vaultKeys(namespace) {
  const all = await evalJs(`window.openBot.listVaultSecrets()`);
  return (all && all[namespace]) || [];
}

// ---------------------------------------------------------------------------
// Anti-cascade start-state resets (v0.85): each test rebuilds its own
// start state from whatever a previous (failed) test left behind,
// instead of assuming the previous test's end state. IPC only, so no
// modal ever appears (the modal lives in the Settings UI handler,
// not in IPC). Fast path: when the live state is already canonical
// the reset is a no-op — the passing sequence needs no reset and no
// reload. Slow path: SettingsView fetches the vault status only on
// mount, so after an IPC reset the checkbox is stale until the view
// remounts — reload the renderer and re-open Settings (the toggle is
// then re-read from the live state).
// ---------------------------------------------------------------------------

/**
 * Slow-path entry counter (v0.86 fault-injection): incremented each
 * time a reset takes the rebuild branch (i.e. the fast-path check
 * above it did NOT early-return). The fault-injection tests assert
 * this counter moves, proving the slow path really executed — the
 * end-state asserts alone could not prove that, because a fast-path
 * return on already-canonical state yields the same end state.
 */
const slowPathRuns = { tempPending: 0, offFlushed: 0 };

/**
 * Dismiss any leftover ConfirmModal with a DOM Cancel click (the
 * in-app modal never blocks JS, so a DOM click is enough — same as
 * afterEach). Returns whether a modal was open. NOTE: cancelling a
 * leftover step-2 modal SAVES the temp secrets — the callers
 * normalise the vault via IPC afterwards, so that is fine.
 */
async function dismissLeftoverModal() {
  const hadModal = await evalJs(`!!document.querySelector('[data-testid="confirm-modal"]')`);
  if (!hadModal) return false;
  await evalJs(`document.querySelector('[data-testid="confirm-modal-cancel"]')?.click()`);
  await waitForModalGone(2000).catch(() => undefined);
  return true;
}

/**
 * Rebuild the canonical start state for tests 1–2 —
 * { enabled: true, pendingSecrets: 1 } with exactly `temp-key`
 * pending — from whatever a previous (failed) test left behind:
 *   1. dismiss any leftover modal;
 *   2. NO_STORAGE off = flush pending temps to disk (pending 0);
 *   3. while OFF, deletes persist to disk: drop stray temp keys a
 *      failed run may have flushed (temp-key-2 from a failed test 3),
 *      re-seed base-key on disk;
 *   4. NO_STORAGE on (baseline = disk state), seed temp-key → pending 1.
 */
async function resetVaultToTempPending() {
  const s = await vaultStatus().catch(() => null);
  const keys = await vaultKeys('l5test');
  if (s && s.enabled === true && s.pendingSecrets === 1 && keys.includes('temp-key')) return;
  slowPathRuns.tempPending += 1; // v0.86: slow path really taken
  console.log(`[L5] resetVaultToTempPending: live state was ${JSON.stringify(s)}, rebuilding`);
  await dismissLeftoverModal();
  await evalJs(`window.openBot.setVaultNoStorage(false)`);
  await evalJs(`window.openBot.deleteVaultSecret('l5test','temp-key')`);
  await evalJs(`window.openBot.deleteVaultSecret('l5test','temp-key-2')`);
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','base-key','base-value')`), true);
  assert.deepEqual(await vaultStatus(), { enabled: false, pendingSecrets: 0 });
  assert.deepEqual(await evalJs(`window.openBot.setVaultNoStorage(true)`), { enabled: true, pendingSecrets: 0 });
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key','temp-value')`), true);
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 1 });
  await reloadRenderer();
  await openSettingsAndFindToggle();
}

/**
 * Rebuild the canonical start state for tests 3–4 —
 * { enabled: false, pendingSecrets: 0 } with base-key + temp-key on
 * disk and NO temp-key-2 anywhere (a failed test 3 can leave
 * temp-key-2 flushed to disk via its own afterEach Cancel at step 2).
 * Same IPC-only normalisation as resetVaultToTempPending, minus the
 * re-enable + seed. `{ reopenSettings: false }` skips the reload +
 * re-open (test 4 restarts the whole app right after, which remounts
 * Settings by itself — it only reads vault state over IPC anyway).
 */
async function resetVaultToOffFlushed({ reopenSettings = true } = {}) {
  const s = await vaultStatus().catch(() => null);
  const keys = await vaultKeys('l5test');
  if (
    s && s.enabled === false && s.pendingSecrets === 0
    && keys.includes('base-key') && keys.includes('temp-key') && !keys.includes('temp-key-2')
  ) return;
  slowPathRuns.offFlushed += 1; // v0.86: slow path really taken
  console.log(`[L5] resetVaultToOffFlushed: live state was ${JSON.stringify(s)} keys=${JSON.stringify(keys)}, rebuilding`);
  await dismissLeftoverModal();
  await evalJs(`window.openBot.setVaultNoStorage(false)`); // flush pending temps to disk
  await evalJs(`window.openBot.deleteVaultSecret('l5test','temp-key-2')`);
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','base-key','base-value')`), true);
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key','temp-value')`), true);
  assert.deepEqual(await vaultStatus(), { enabled: false, pendingSecrets: 0 });
  const keysAfter = await vaultKeys('l5test');
  assert.ok(keysAfter.includes('base-key') && keysAfter.includes('temp-key') && !keysAfter.includes('temp-key-2'),
    `unexpected keys after reset: ${JSON.stringify(keysAfter)}`);
  if (!reopenSettings) return;
  await reloadRenderer();
  await openSettingsAndFindToggle();
}

function vaultOnDisk() {
  return new Vault({ storePath: findVaultStore() });
}

// --- UI navigation ---

async function openSettingsAndFindToggle() {
  // Measure a DOM rect's screen point fresh on every attempt: the
  // window can move between retries, so no geometry is cached.
  const screenPoint = async (rect) => {
    const win = await mainWindowGeometry();
    const chromeY = await chromeOffsetY();
    return toScreen(rect, win, chromeY);
  };
  // v0.61 (UI-13): the bottom nav is one "⋯ Menu" button now — open
  // it first; the Settings entry lives in the dropdown (it is not in
  // the sidebar DOM until the menu opens).
  await evalJs(`document.querySelector('[data-testid="sidebar-nav-menu"]')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await clickUntilEffect(
    async () => {
      const r = await evalJs(`(() => {
        const b = document.querySelector('[data-testid="sidebar-nav-menu"]');
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return { x: q.x, y: q.y, w: q.width, h: q.height };
      })()`);
      return r ? screenPoint(r) : null;
    },
    async () => (await evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Cài đặt'))`)) ? true : null,
    { label: 'nav menu button' },
  );
  // v0.59 (UI-5, integration): the sidebar can overflow the viewport
  // once the thread list is shown, pushing the nav buttons below the
  // fold (the sidebar scrolls since v0.59, but the button must be
  // scrolled into view before a real click can land on it).
  await evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Cài đặt'))?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await clickUntilEffect(
    async () => {
      const r = await evalJs(`(() => {
        const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Cài đặt'));
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return { x: q.x, y: q.y, w: q.width, h: q.height };
      })()`);
      return r ? screenPoint(r) : null;
    },
    async () => (await evalJs(`!!document.querySelector('button[data-tab]')`)) ? true : null,
    { label: 'Settings nav button' },
  );
  // v0.59 (UI-4, integration): Settings is tabbed now — the NO_STORAGE
  // toggle lives in the "security" tab (Bảo mật & Vault), not the
  // default tab. Click that tab with a real click like the Settings
  // button above; the effect is the NO_STORAGE label appearing.
  try {
    await clickUntilEffect(
      async () => {
        const r = await evalJs(`(() => {
          const b = document.querySelector('button[data-tab="security"]');
          if (!b) return null;
          const q = b.getBoundingClientRect();
          return { x: q.x, y: q.y, w: q.width, h: q.height };
        })()`);
        return r ? screenPoint(r) : null;
      },
      async () => (await evalJs(`[...document.querySelectorAll('label')].some((l) => l.textContent.includes('không lưu trữ'))`)) ? true : null,
      { label: 'Settings security tab' },
    );
  } catch (e) {
    // Diag: the label never appeared even after retried clicks, so this
    // is not a missed click — the rendered view (tabs/labels/headings)
    // tells whether Settings itself failed to render.
    try {
      const view = await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('button[data-tab]')].map((b) => ({ tab: b.getAttribute('data-tab'), active: b.className.includes('active') }));
        const labels = [...document.querySelectorAll('label')].map((l) => l.textContent.slice(0, 60));
        const settingsBtn = !!([...document.querySelectorAll('button')].find((b) => b.textContent.includes('Cài đặt')));
        const headings = [...document.querySelectorAll('h1,h2')].map((h) => h.textContent.slice(0, 60));
        return { tabs, labelCount: labels.length, labels: labels.slice(0, 12), settingsBtn, headings };
      })()`);
      console.log(`[L5] NO_STORAGE toggle missing: view=${JSON.stringify(view)}`);
    } catch (diagErr) {
      console.log(`[L5] toggle-missing diag failed: ${diagErr.message}`);
    }
    throw e;
  }
  // The toggle defaults to OFF (useState(false)) and only reflects the
  // real state after the async IPC fetch lands. Under full-suite load
  // that fetch is slow: wait until the checkbox agrees with the IPC
  // status before any test reads it, or the first read races.
  await waitForToggleChecked((await vaultStatus()).enabled);
}

/**
 * Poll the NO_STORAGE checkbox until its checked state equals `expected`
 * (default 10s). The checkbox is a controlled input whose state arrives
 * asynchronously from main via IPC, so a single immediate read can see
 * the initial `false` even when the vault is really ON.
 */
async function waitForToggleChecked(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await readToggle()).checked;
    if (last === expected) return;
    await sleep(300);
  }
  assert.equal(last, expected, `NO_STORAGE toggle never settled to ${expected}`);
}

async function readToggle() {
  const t = await evalJs(`(() => {
    const l = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('không lưu trữ'));
    if (!l) return null;
    l.scrollIntoView({ block: 'center', behavior: 'instant' });
    const i = l.querySelector('input');
    const r = i.getBoundingClientRect();
    return { checked: i.checked, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  })()`);
  assert.ok(t, 'NO_STORAGE toggle not found');
  // Re-read after the scroll settles so the click lands on the checkbox.
  await sleep(400);
  const t2 = await evalJs(`(() => {
    const l = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('không lưu trữ'));
    const i = l.querySelector('input');
    const r = i.getBoundingClientRect();
    return { checked: i.checked, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  })()`);
  return t2;
}

/** Click the NO_STORAGE checkbox and wait for the first ConfirmModal
 * (the flush step). Returns the modal text. The checkbox is a
 * controlled input: while the modal is open the toggle itself has not
 * flipped yet — the change only applies when a modal button confirms
 * it — so a re-read here still shows the pre-click state.
 *
 * The click goes through clickUntilEffect: this is the site that
 * flaked in the v0.72/v0.73 full-suite runs (click at the toggle's
 * position, no modal, toggle unchanged) because the click landed in
 * another test's overlapping window. A retry re-fires changeNoStorage,
 * which is safe — it just re-sets the identical pending ConfirmModal.
 */
async function clickToggleExpectModal() {
  let toggleBefore = null;
  try {
    const text = await clickUntilEffect(
      async () => {
        const t = await readToggle();
        toggleBefore = t.checked;
        const win = await mainWindowGeometry();
        const chromeY = await chromeOffsetY();
        return toScreen(t.rect, win, chromeY);
      },
      async () => {
        const m = await modalText();
        return (typeof m === 'string' && m.includes('secret tạm')) ? m : null;
      },
      { timeoutMs: MODAL_WAIT_MS, label: 'NO_STORAGE toggle off' },
    );
    console.log(`[L5] modal 1 open: toggleBefore=${toggleBefore}`);
    return text;
  } catch (e) {
    // Modal never appeared: did the clicks even reach our checkbox?
    // The toggle re-read tells the two apart: unchanged = the clicks
    // missed (or the app never ran changeNoStorage); flipped = the
    // modal opened but the DOM poll could not see it.
    let toggleAfter = null;
    try {
      toggleAfter = (await readToggle()).checked;
    } catch (err) {
      toggleAfter = `(readToggle failed: ${String(err).slice(0, 120)})`;
    }
    console.log(`[L5] NO MODAL toggleBefore=${toggleBefore} toggleAfter=${toggleAfter}`);
    throw new Error(`${e.message} — clickDiag: toggleBefore=${toggleBefore} toggleAfter=${toggleAfter}`);
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

before(async () => {
  if (!hasDisplay) {
    // Same convention as computer-use-v06: needs a real X display.
    // node:test has no built-in "skip the whole file" here, so the
    // tests below check hasDisplay themselves; this hook only prepares
    // when a display exists.
    return;
  }
  assert.ok(fs.existsSync(ELECTRON), `Electron binary not found at ${ELECTRON}`);
  const screen = await getDisplayGeometry();
  assert.ok(screen.width >= 1280 && screen.height >= 800,
    `screen ${screen.width}x${screen.height} is too small for the 1280x800 app window`);
  xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-click-xdg-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-click-work-'));
  await launchApp();

  // Seed through the app's own IPC: one secret on disk, then NO_STORAGE
  // on, then one temporary secret (pending = 1).
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','base-key','base-value')`), true);
  assert.deepEqual(await evalJs(`window.openBot.setVaultNoStorage(true)`), { enabled: true, pendingSecrets: 0 });
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key','temp-value')`), true);
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 1 });
  assert.ok(fs.existsSync(findVaultStore()), 'vault.json was not created under the isolated userData');
  await openSettingsAndFindToggle();
});

after(async () => {
  await quitApp();
  for (const dir of [xdgDir, workDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Safety net: if a test fails while a confirm modal is open, dismiss
 * it with Cancel so the next test starts from a clean state instead
 * of cascading (a stale modal would swallow the next test's toggle
 * click). A DOM click is enough here — the in-app modal never blocks
 * JS. Best-effort only. NOTE: cancelling a leftover step-2 modal
 * SAVES the temporary secrets (that is what Cancel means there), so
 * a failed test may still leave the vault changed — v0.85: do NOT
 * assume the vault is clean afterwards, log the REAL vault state
 * here; the next test rebuilds its own start state anyway
 * (resetVaultToTempPending / resetVaultToOffFlushed).
 */
afterEach(async () => {
  if (!hasDisplay || !child) return;
  try {
    const hadModal = await evalJs(`!!document.querySelector('[data-testid="confirm-modal"]')`);
    if (hadModal) {
      await evalJs(`document.querySelector('[data-testid="confirm-modal-cancel"]')?.click()`);
      await waitForModalGone(2000).catch(() => undefined);
    }
    const s = await evalJs(`window.openBot.getVaultNoStorage()`).catch(() => null);
    console.log(`[L5] afterEach vault state: ${JSON.stringify(s)} (modal was ${hadModal ? 'open' : 'closed'})`);
  } catch {
    // Never fail the suite in cleanup.
  }
});

function skipWithoutDisplay(t) {
  if (!hasDisplay) {
    t.skip('needs a real X display — run under xvfb-run -a');
    return true;
  }
  return false;
}

test('L5 confirm: Cancel ở hộp 1 (từ chối) — NO_STORAGE vẫn bật, secret tạm còn nguyên', async (t) => {
  if (skipWithoutDisplay(t)) return;
  // v0.85 anti-cascade: rebuild the canonical start state instead of
  // assuming the before() seed survived (a failed earlier run may have
  // left the vault flushed/discarded). Ends asserting the same state.
  await resetVaultToTempPending();
  // Poll, don't assert once: the checkbox state arrives async from IPC.
  await waitForToggleChecked(true);

  const modal1 = await clickToggleExpectModal();
  // Modal 1 is the flush question ("...sẽ lưu 1 secret tạm xuống đĩa.
  // Tiếp tục?"); its Confirm button says "Tiếp tục", Cancel "Huỷ".
  assert.match(modal1, /sẽ lưu 1 secret tạm xuống đĩa/);
  assert.match(modal1, /Tiếp tục/);
  // Evidence: screenshot of the open modal (computer-use screenshot).
  // NOTE: the tool truncates its JSON result at 20k chars (the base64
  // thumbnail is far longer), so the returned string is NOT valid JSON —
  // assert on the prefix and verify the PNG file on disk instead.
  const shot = await tool('computer_screenshot').execute({}, CTX(workDir));
  assert.doesNotMatch(shot, /^Error:/, shot);
  assert.match(shot, /^\{"ok":true/);
  const shotsDir = path.join(workDir, 'computer-use', 'screenshots');
  const pngs = fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png'));
  assert.equal(pngs.length, 1, `expected one screenshot PNG, got ${JSON.stringify(pngs)}`);
  assert.ok(fs.statSync(path.join(shotsDir, pngs[0])).size > 0, 'screenshot PNG is empty');
  // Unlike the old native window.confirm, the in-app modal never
  // blocks the renderer JS thread — evaluate still answers.
  assert.equal(await evalJs(`1+1`, 2000), 2);

  await clickModalButton('cancel');

  // Cancel = do nothing: toggle stays on, temp secret still pending.
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 1 });
  assert.equal((await readToggle()).checked, true);
  assert.ok((await vaultKeys('l5test')).includes('temp-key'));
});

test('L5 confirm: OK hộp 1 + Cancel hộp 2 (lưu) — NO_STORAGE tắt, secret tạm được flush xuống đĩa', async (t) => {
  if (skipWithoutDisplay(t)) return;
  // v0.85 anti-cascade: same canonical start state as test 1 — do not
  // assume test 1 left it behind (it may have failed mid-flow).
  await resetVaultToTempPending();
  await waitForToggleChecked(true);
  const modal1 = await clickToggleExpectModal();
  assert.match(modal1, /sẽ lưu 1 secret tạm xuống đĩa/);
  // JS stays responsive while the modal is open (in-app modal, never
  // a thread-blocking native dialog).
  assert.equal(await evalJs(`1+1`, 2000), 2);
  // Confirm on modal 1 opens modal 2 in the same React batch, so the
  // modal never unmounts between steps — do not wait for it to close,
  // wait for the step-2 text instead.
  await clickModalButton('confirm', { waitGone: false });

  // Modal 2 (discard offer) replaces modal 1; its Confirm button says
  // "Xoá", Cancel means save (flush).
  const modal2 = await waitForModalText('thay vì lưu xuống đĩa');
  assert.match(modal2, /Xoá 1 secret tạm/);
  await clickModalButton('cancel'); // Cancel = save (flush).

  assert.deepEqual(await vaultStatus(), { enabled: false, pendingSecrets: 0 });
  assert.equal((await readToggle()).checked, false);
  const keys = await vaultKeys('l5test');
  assert.ok(keys.includes('base-key'), `base-key missing: ${keys}`);
  assert.ok(keys.includes('temp-key'), `temp-key was not flushed: ${keys}`);

  // On disk (fresh Vault instance, same encrypted store): the temp
  // secret really was written to the file.
  const disk = vaultOnDisk();
  assert.equal(disk.getSecret('l5test', 'temp-key'), 'temp-value');
  assert.equal(disk.getSecret('l5test', 'base-key'), 'base-value');
});

test('L5 confirm: OK hộp 1 + OK hộp 2 (xoá) — secret tạm bị xoá, không lưu xuống đĩa', async (t) => {
  if (skipWithoutDisplay(t)) return;
  // v0.85 anti-cascade: rebuild the OFF + flushed start state instead
  // of assuming test 2 left it (it may have failed with NO_STORAGE
  // still on, or with temp-key-2 flushed to disk).
  await resetVaultToOffFlushed();
  // Turn NO_STORAGE back on: no modal when enabling.
  const t0 = await readToggle();
  assert.equal(t0.checked, false);
  // The click is a real mouse event and the state update crosses IPC:
  // under full-suite load either can be slow (one full-suite run saw
  // enabled:false 1500ms after the click), and the raise-then-click
  // race can send the click to another test's window entirely — so
  // click through clickUntilEffect and retry until the live vault
  // status itself shows enabled, instead of trusting a fixed sleep.
  // Same assertion as before, just waited for properly — a missed
  // click is retried, not silently accepted.
  await clickUntilEffect(
    async () => {
      const t = await readToggle();
      const win = await mainWindowGeometry();
      const chromeY = await chromeOffsetY();
      return toScreen(t.rect, win, chromeY);
    },
    async () => ((await vaultStatus()).enabled ? true : null),
    { timeoutMs: 10_000, label: 'NO_STORAGE toggle on' },
  );
  const status = await vaultStatus();
  assert.equal(await modalText(), null, 'no modal should appear when turning NO_STORAGE ON');
  assert.deepEqual(status, { enabled: true, pendingSecrets: 0 });

  // A new temporary secret while NO_STORAGE is on.
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key-2','temp-value-2')`), true);
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 1 });

  const modal1 = await clickToggleExpectModal();
  assert.match(modal1, /sẽ lưu 1 secret tạm xuống đĩa/);
  await clickModalButton('confirm', { waitGone: false });
  const modal2 = await waitForModalText('thay vì lưu xuống đĩa');
  assert.match(modal2, /Xoá 1 secret tạm/);
  await clickModalButton('confirm'); // Confirm = delete the temp secrets.

  assert.deepEqual(await vaultStatus(), { enabled: false, pendingSecrets: 0 });
  assert.equal((await readToggle()).checked, false);
  const keys = await vaultKeys('l5test');
  assert.ok(keys.includes('base-key'), `base-key missing: ${keys}`);
  assert.ok(keys.includes('temp-key'), `temp-key missing after discard: ${keys}`);
  assert.ok(!keys.includes('temp-key-2'), `temp-key-2 should have been discarded: ${keys}`);

  // On disk: temp-key-2 never reached the file, temp-key is still there.
  const disk = vaultOnDisk();
  assert.equal(disk.getSecret('l5test', 'temp-key-2'), null);
  assert.equal(disk.getSecret('l5test', 'temp-key'), 'temp-value');
});

test('L5 confirm: khởi động lại app — trạng thái trên đĩa giữ đúng như đã click', async (t) => {
  if (skipWithoutDisplay(t)) return;
  // v0.85 anti-cascade: rebuild the OFF + flushed disk state first
  // (no Settings re-open needed — the restart below remounts anyway).
  await resetVaultToOffFlushed({ reopenSettings: false });
  await quitApp();
  await launchApp();

  assert.deepEqual(await vaultStatus(), { enabled: false, pendingSecrets: 0 });
  const keys = await vaultKeys('l5test');
  assert.ok(keys.includes('base-key'), `base-key missing after restart: ${keys}`);
  assert.ok(keys.includes('temp-key'), `temp-key missing after restart: ${keys}`);
  assert.ok(!keys.includes('temp-key-2'), `temp-key-2 reappeared after restart: ${keys}`);
});

// ---------------------------------------------------------------------------
// Fault-injection: the reset SLOW PATH, run for real (v0.86)
// ---------------------------------------------------------------------------
//
// The v0.85 verification ran this file 3/3 x 4/4 — but every run took
// the resets' FAST path (live state already canonical, early return),
// so the rebuild + reloadRenderer + openSettingsAndFindToggle branch
// was never executed. These three tests inject faults through IPC
// first (wrong mode, wrong keys, a stray temp-key-2 on disk, a modal
// left open) and then call the reset, asserting BOTH that the
// canonical state is rebuilt AND that slowPathRuns moved — the
// counter is what proves the slow path ran, since a fast-path return
// on already-canonical state would produce the same end state.
// They run last on purpose: they deliberately leave the vault in a
// non-canonical state before each reset, and no later test depends on
// the state they leave behind (afterEach still dismisses any modal
// and logs the real vault state).

test('L5 FI: resetVaultToTempPending slow path — vault hỏng (OFF, mất key, temp-key-2 lạ) được rebuild + reload + mở lại Settings', async (t) => {
  if (skipWithoutDisplay(t)) return;
  // Fault: start from test 4's end state (OFF + flushed) and corrupt
  // it — NO_STORAGE off, base-key + temp-key deleted from disk, a
  // stray temp-key-2 flushed to disk (the exact leftover a failed
  // test 3 used to leave behind). None of this is canonical for
  // TempPending, so the reset MUST take the slow path.
  await evalJs(`window.openBot.setVaultNoStorage(false)`);
  await evalJs(`window.openBot.deleteVaultSecret('l5test','base-key')`);
  await evalJs(`window.openBot.deleteVaultSecret('l5test','temp-key')`);
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key-2','temp-value-2')`), true);
  const corrupted = await vaultStatus();
  assert.deepEqual(corrupted, { enabled: false, pendingSecrets: 0 });
  assert.deepEqual(await vaultKeys('l5test'), ['temp-key-2']);

  const before = slowPathRuns.tempPending;
  await resetVaultToTempPending();
  // Proof the slow path ran (not a fast-path early return on state
  // that happened to look canonical): the counter moved exactly once.
  assert.equal(slowPathRuns.tempPending, before + 1, 'slow path did not run');
  // Canonical end state, live (IPC) + on disk + in the UI: the
  // reload inside the slow path remounted Settings, so the checkbox
  // must agree with IPC instead of showing its stale pre-reset value.
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 1 });
  const keys = await vaultKeys('l5test');
  assert.ok(keys.includes('base-key'), `base-key missing after rebuild: ${keys}`);
  assert.ok(keys.includes('temp-key'), `temp-key missing after rebuild: ${keys}`);
  assert.ok(!keys.includes('temp-key-2'), `stray temp-key-2 survived rebuild: ${keys}`);
  assert.equal(await modalText(), null, 'no modal should be open after a rebuild');
  assert.equal((await readToggle()).checked, true);
  const disk = vaultOnDisk();
  assert.equal(disk.getSecret('l5test', 'temp-key-2'), null);
  assert.equal(disk.getSecret('l5test', 'base-key'), 'base-value');
});

test('L5 FI: resetVaultToOffFlushed slow path — vault hỏng (ON, pending 2, mất base-key) được flush + dọn + reload', async (t) => {
  if (skipWithoutDisplay(t)) return;
  // Fault: from the previous FI test's end state (ON, pending 1),
  // corrupt it — flush, delete base-key from disk, re-enable, then
  // seed two pending changes (temp-key with a NEW value + temp-key-2).
  // NOTE on Vault semantics (learned from a first version of this
  // test that failed): pendingSecrets counts the diff against the
  // NO_STORAGE baseline, so deleting a disk key WHILE NO_STORAGE is
  // on counts as a pending change too — the corruption below deletes
  // base-key while OFF, and seeds temp-key with a different value so
  // it really counts as pending (same value = same hash = no diff).
  // Not canonical for OffFlushed, so the slow path must run.
  // `setVaultNoStorage(false)` trả về pendingSecrets tính TRƯỚC khi
  // áp dụng (xem main.ts: `vault:set-nostorage`) = số secret tạm vừa
  // được flush (1: temp-key từ test FI trước) — trạng thái SAU flush
  // phải đọc riêng qua vaultStatus().
  assert.deepEqual(await evalJs(`window.openBot.setVaultNoStorage(false)`), { enabled: false, pendingSecrets: 1 });
  assert.deepEqual(await vaultStatus(), { enabled: false, pendingSecrets: 0 });
  await evalJs(`window.openBot.deleteVaultSecret('l5test','base-key')`);
  assert.deepEqual(await evalJs(`window.openBot.setVaultNoStorage(true)`), { enabled: true, pendingSecrets: 0 });
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key','temp-value-FI2')`), true);
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key-2','temp-value-2')`), true);
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 2 });

  const before = slowPathRuns.offFlushed;
  await resetVaultToOffFlushed();
  assert.equal(slowPathRuns.offFlushed, before + 1, 'slow path did not run');
  // Canonical end state: OFF, nothing pending, temp-key-2 flushed
  // then deleted (never survives on disk), base-key + temp-key on disk.
  assert.deepEqual(await vaultStatus(), { enabled: false, pendingSecrets: 0 });
  const keys = await vaultKeys('l5test');
  assert.ok(keys.includes('base-key'), `base-key missing after rebuild: ${keys}`);
  assert.ok(keys.includes('temp-key'), `temp-key missing after rebuild: ${keys}`);
  assert.ok(!keys.includes('temp-key-2'), `temp-key-2 survived rebuild: ${keys}`);
  assert.equal(await modalText(), null, 'no modal should be open after a rebuild');
  assert.equal((await readToggle()).checked, false);
  const disk = vaultOnDisk();
  assert.equal(disk.getSecret('l5test', 'temp-key-2'), null);
  assert.equal(disk.getSecret('l5test', 'temp-key'), 'temp-value');
});

test('L5 FI: reset slow path với modal đang mở — modal thừa bị dismiss rồi state mới được rebuild', async (t) => {
  if (skipWithoutDisplay(t)) return;
  // Fault: from the previous FI test's end state (OFF + flushed,
  // Settings open), turn NO_STORAGE on via IPC, seed TWO pending
  // secrets, then really click the toggle so modal 1 opens — then
  // call the reset with that modal still open. The slow path must
  // dismiss the leftover modal first (Cancel at step 1 = do nothing)
  // and only then rebuild; a reset that forgot the dismiss would
  // leave the modal open over the rebuilt Settings view.
  assert.deepEqual(await evalJs(`window.openBot.setVaultNoStorage(true)`), { enabled: true, pendingSecrets: 0 });
  // Seed with a NEW value for temp-key: same value = same hash as the
  // baseline, so it would not count as pending (see the note in the
  // FI test above); the modal must report 2 pending secrets.
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key','temp-value-FI3')`), true);
  assert.equal(await evalJs(`window.openBot.setVaultSecret('l5test','temp-key-2','temp-value-2')`), true);
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 2 });
  const modal1 = await clickToggleExpectModal();
  assert.match(modal1, /sẽ lưu 2 secret tạm xuống đĩa/);

  const before = slowPathRuns.tempPending;
  await resetVaultToTempPending();
  assert.equal(slowPathRuns.tempPending, before + 1, 'slow path did not run');
  // Modal gone (dismissed by the reset, not by this test), canonical
  // state rebuilt, checkbox agreeing with IPC after the reload.
  assert.equal(await modalText(), null, 'leftover modal was not dismissed by the reset');
  assert.deepEqual(await vaultStatus(), { enabled: true, pendingSecrets: 1 });
  const keys = await vaultKeys('l5test');
  assert.ok(keys.includes('temp-key'), `temp-key missing after rebuild: ${keys}`);
  assert.ok(!keys.includes('temp-key-2'), `temp-key-2 survived rebuild: ${keys}`);
  assert.equal((await readToggle()).checked, true);
});
