/**
 * Shared CDP wait/evaluate harness for Electron smoke/renderer tests
 * (v0.94b — extracted from the v0.93c fixes in
 * tests/threads-ui5-smoke.test.mjs and tests/tts-voice-v082-renderer.test.mjs,
 * which each grew their own copy of this pattern).
 *
 * The convention, measured not guessed (v0.93c + v0.94b probes):
 *
 * 1. SHORT POLL ATTEMPTS, LONG STEP DEADLINES. One evaluate gets
 *    5s (CDP_EVAL_ATTEMPT_MS) — >2.5x the worst measured slow evaluate
 *    (~2s at load 8–12). A slow evaluate is "renderer busy, retry",
 *    never a failure: waitFor retries short attempts until the STEP
 *    deadline (10s default, 30s for main-process-bound steps such as
 *    the threads-ui5 default thread row or the ui-13 /hello palette
 *    row, whose first `slash:list` IPC measured 18–20s under load).
 *    The old pattern (one 15s evaluate, or a 15s evaluate inside a
 *    10s waitFor) let a single starved evaluate eat the whole wait.
 *
 * 2. A TIMEOUT IS NEVER A PASS. evalJs resolves the unique
 *    EVAL_BUSY sentinel on timeout — never a truthy object — and
 *    waitFor treats it as "not ready yet" and keeps polling until the
 *    real deadline. Direct callers that need a value must use
 *    evalJsStrict, which throws `CDP evaluate timed out (renderer
 *    busy)` instead of returning a value that a later assert would
 *    misread (the old `{ __blocked: true }` truthy bug, v0.93c).
 *
 * 3. FOCUS BEFORE CLIPBOARD. `navigator.clipboard.writeText` rejects
 *    when the document has no X focus — under xvfb with many Electron
 *    windows, a window can simply never hold focus, and the app then
 *    shows its copy-error notice in <100ms (measured v0.94b: focused
 *    4–218ms → "Đã sao chép.", unfocused 8–81ms → "Không sao chép
 *    được."). No deadline fixes that; use ensureFocus() (CDP
 *    Page.bringToFront + a hasFocus check — `window.focus()` does NOT
 *    restore X focus here, measured) before any clipboard step.
 *
 * This is a helper, not a test: the name carries no `.test.` segment
 * (same precedent as tests/cdp-deadline.mjs), so `node --test` never
 * picks it up as a test file.
 */
export const EVAL_BUSY = Symbol('cdp-evaluate-busy');
export const isEvalBusy = (v) => v === EVAL_BUSY;

/** One evaluate attempt: 5s, >2.5x the worst measured slow evaluate. */
export const CDP_EVAL_ATTEMPT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {(text: string) => void} send — sends a JSON CDP message on
 *   the CURRENT websocket. Pass a closure over the file's `let ws`
 *   (e.g. `(text) => ws.send(text)`) so reconnects (reloadApp) keep
 *   working without re-creating the harness.
 * @param {number} [evaluateTimeoutMs] — per-attempt evaluate timeout.
 */
export function createCdpHarness(send, { evaluateTimeoutMs = CDP_EVAL_ATTEMPT_MS } = {}) {
  let nextId = 1;
  const pending = new Map();

  /**
   * Route one parsed incoming CDP message. Call from ws.onmessage
   * AFTER handling Runtime.exceptionThrown (page exceptions are the
   * file's business, not the harness's). Returns true if the message
   * answered a pending call.
   */
  function handleMessage(m) {
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return true;
    }
    return false;
  }

  function clearPending() {
    pending.clear();
  }

  /** Fire-and-forget CDP send (e.g. location.reload() on navigation). */
  function sendMethod(method, params = {}) {
    send(JSON.stringify({ id: nextId++, method, params }));
  }

  /** One CDP call with a response (e.g. Page.bringToFront). */
  function cdpCall(method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) return reject(new Error(`CDP ${method} failed: ${JSON.stringify(m.error)}`));
        resolve(m.result);
      });
      send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate JS in the page. Resolves EVAL_BUSY when the attempt times
   * out (renderer busy — retry, don't fail); rejects only on a CDP
   * error or a page exception. `awaitPromise: true` so async
   * expressions (IPC calls) resolve to their value.
   */
  function evalJs(expression, timeoutMs = evaluateTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        // v0.93c: resolve the sentinel, never a truthy object — a slow
        // renderer means "busy, retry", not a value.
        pending.delete(id);
        resolve(EVAL_BUSY);
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) return reject(new Error(`CDP evaluate failed: ${JSON.stringify(m.error)}`));
        if (m.result?.exceptionDetails) {
          return reject(new Error(`page exception: ${JSON.stringify(m.result.exceptionDetails).slice(0, 400)}`));
        }
        resolve(m.result?.result?.value);
      });
      send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
  }

  /**
   * evalJs for direct callers that need a real value: throws
   * `CDP evaluate timed out (renderer busy)` instead of returning
   * EVAL_BUSY, so an assert never misreads a timeout as a value.
   */
  async function evalJsStrict(expression, timeoutMs = evaluateTimeoutMs) {
    const v = await evalJs(expression, timeoutMs);
    if (isEvalBusy(v)) {
      throw new Error(`CDP evaluate timed out (renderer busy) after ${timeoutMs}ms: ${expression.slice(0, 120)}`);
    }
    return v;
  }

  /**
   * Poll `expression` until it returns truthy or the step deadline
   * passes. Slow evaluates count as busy polls, never as success;
   * the failure message reports the last value AND how many polls
   * were slow, so a timeout under load reads as load, not as a
   * broken app.
   */
  async function waitFor(expression, timeoutMs, label, { pollMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    let busyPolls = 0;
    while (Date.now() < deadline) {
      last = await evalJs(expression);
      if (isEvalBusy(last)) busyPolls++;
      else if (last) return last;
      await sleep(pollMs);
    }
    throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)}; slow-evaluate polls: ${busyPolls})`);
  }

  /**
   * Focus handshake for clipboard steps (v0.94b canvas root cause):
   * bring the page to front and verify document.hasFocus(). Returns
   * true once focused, false after `attempts` tries. `window.focus()`
   * alone does NOT restore X focus under xvfb (measured) — only
   * Page.bringToFront does.
   */
  async function ensureFocus({ attempts = 5, settleMs = 300 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        await cdpCall('Page.bringToFront');
      } catch {
        // bringToFront failing means the target is gone; hasFocus
        // below will confirm either way.
      }
      await sleep(settleMs);
      if (await evalJs(`document.hasFocus()`)) return true;
    }
    return false;
  }

  return { evalJs, evalJsStrict, waitFor, cdpCall, send: sendMethod, ensureFocus, handleMessage, clearPending };
}
