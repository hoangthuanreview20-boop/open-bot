/**
 * Hook script runner (v0.18, gap v0.10/v0.14).
 *
 * Runs ONE hook from an external script file OUT-OF-PROCESS: the script
 * is spawned as `node <script>` in its own process group, so a hanging,
 * crashing or misbehaving script can never take down the coordinator
 * (same principle as the out-of-process plugin sandbox, v0.14 — but a
 * much simpler protocol: one JSON line in on stdin, one JSON line out
 * on stdout, no long-lived IPC).
 *
 * Protocol (the script author implements this):
 * - stdin: a single JSON line `{ event, ...input }`, where `event` is
 *   the HookEventKind (e.g. `"PreToolUse"`) and the rest are that
 *   event's fields (e.g. `toolName`, `toolCallId`, `args`).
 * - stdout: the script may print anything for debugging, but the LAST
 *   non-empty line must be a JSON decision object with the same shape a
 *   `HookFn` returns (`HookDecision`): `{ action: 'allow' | 'block' |
 *   'modify', reason?, args?, output?, context? }`. For convenience an
 *   `action` may also be spelled `decision` (`{ decision: 'block',
 *   reason: '...' }`); `decision` as a nested object
 *   (`{ decision: { action: 'block', ... } }`) is accepted too.
 *   Any other stdout line is ignored (logged via `opts.logger` when
 *   one is given). No output, or a last line that is not valid JSON
 *   with a valid action, is a hook-script error.
 * - exit code: non-zero is an error, even when a decision line was
 *   printed (a script that fails must say so by exiting non-zero).
 *
 * Safety:
 * - The child inherits ONLY a minimal allowlisted env (`safeEnv()` —
 *   same allowlist as `safeEnvForMcp` in `../mcp/client` and `safeEnv`
 *   in tools/sandbox, copied here so core does not import from tools).
 *   Secrets / API keys of the parent process are never passed down.
 * - The script file must exist and lie inside an allowed directory
 *   (`opts.workspaceDir` and/or `opts.allowedDirs`); `..` escapes and
 *   symlinks pointing outside are rejected (realpath-checked).
 * - Per-invocation timeout (default 10s): on expiry the whole process
 *   GROUP is SIGKILLed and the call rejects with a timeout error.
 * - stderr is captured, capped (~10KB tail), and included in error
 *   messages — never printed raw (it could contain secrets).
 *
 * This module NEVER throws synchronously for a bad script at run time:
 * `runHookScript` rejects, and the registry wrapper turns that into a
 * throwing `HookFn` — which `HookRunner` already treats as a hook
 * error (never a run crash; see runner.ts). Registration-time problems
 * (missing file, path outside the allowed dirs) throw
 * `HookRegistrationError` from `registerScriptHook` instead, so a bad
 * bundle hook is caught at wiring time.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookDecision, HookEventKind } from './types';
import { HookRegistrationError } from './types';

/** Default per-invocation timeout for a hook script. */
export const DEFAULT_HOOK_SCRIPT_TIMEOUT_MS = 10_000;

/** Max stderr chars kept (tail) for error messages / logging. */
export const MAX_HOOK_SCRIPT_STDERR_CHARS = 10 * 1024;

/**
 * Max stdout chars kept (tail). Only the LAST stdout line is parsed,
 * so keeping a tail is enough and a chatty script cannot grow memory
 * unboundedly.
 */
export const MAX_HOOK_SCRIPT_STDOUT_CHARS = 64 * 1024;

export interface HookScriptOptions {
  /** Per-invocation timeout in ms. Default `DEFAULT_HOOK_SCRIPT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Working directory of the script (its `process.cwd()`), and the
   * default allowed root for the script path. Defaults to the parent's
   * cwd. The coordinator passes the bot workspace dir.
   */
  workspaceDir?: string;
  /**
   * Extra directories the script file may live in (in addition to
   * `workspaceDir`). The coordinator passes the bundle dir here, so a
   * bundle hook script (which lives in the bundle, not the workspace)
   * is allowed.
   */
  allowedDirs?: string[];
  /** Where non-decision stdout lines / lifecycle notes are logged. */
  logger?: (message: string) => void;
  /** Node binary to spawn. Defaults to `process.execPath`. */
  nodePath?: string;
}

// ---------------------------------------------------------------------------
// Safe env (copied allowlist — see module header)
// ---------------------------------------------------------------------------

/**
 * Biến môi trường an toàn được truyền cho hook script con. Copy đúng
 * allowlist của `safeEnvForMcp` (`../mcp/client.ts`) — KHÔNG import từ
 * tools để tránh phụ thuộc chéo core → tools. Mọi tên trông như secret
 * đều bị chặn dù có trong allowlist.
 */
const HOOK_SCRIPT_SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'TERM',
  'SHELL',
  'NODE_ENV',
]);

/** Tên biến môi trường trông như secret — giống `SECRET_ENV_PATTERN` của sandbox. */
const HOOK_SCRIPT_SECRET_ENV_PATTERN =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;

/**
 * Lọc môi trường chỉ còn allowlist tối thiểu, chặn mọi tên giống secret.
 * Hook script là code bên thứ ba — không được thấy API key/token của
 * tiến trình chính. Tham số `source` chỉ để test (truyền env giả thay
 * vì sửa `process.env` thật).
 */
export function safeEnvForHookScript(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!HOOK_SCRIPT_SAFE_ENV_ALLOWLIST.has(key)) continue;
    if (HOOK_SCRIPT_SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate + resolve a hook script path: it must exist, be a file, and
 * lie inside one of `allowedDirs` (realpath-checked, so `..` escapes
 * and symlinks pointing outside are rejected). Returns the absolute
 * path. Throws `HookRegistrationError` on any violation.
 */
export function resolveHookScriptPath(
  scriptPath: string,
  allowedDirs: string[],
): string {
  if (typeof scriptPath !== 'string' || scriptPath.trim() === '') {
    throw new HookRegistrationError('Hook script path must be a non-empty string.');
  }
  if (allowedDirs.length === 0) {
    throw new HookRegistrationError(
      `Hook script "${scriptPath}" has no allowed directory to run from.`,
    );
  }
  const abs = path.resolve(scriptPath);
  let real: string;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      throw new HookRegistrationError(
        `Hook script "${scriptPath}" is not a file.`,
      );
    }
    real = fs.realpathSync(abs);
  } catch (err) {
    if (err instanceof HookRegistrationError) throw err;
    throw new HookRegistrationError(
      `Hook script "${scriptPath}" does not exist or cannot be read: ` +
        `${(err as Error).message}`,
    );
  }
  for (const dir of allowedDirs) {
    try {
      const realDir = fs.realpathSync(path.resolve(dir));
      if (real === realDir || real.startsWith(realDir + path.sep)) return real;
    } catch {
      // Allowed dir does not exist (yet): it simply cannot contain the script.
      continue;
    }
  }
  throw new HookRegistrationError(
    `Hook script "${scriptPath}" lies outside the allowed directories ` +
      `(${allowedDirs.join(', ')}).`,
  );
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set(['allow', 'block', 'modify']);

function normalizeScriptDecision(raw: unknown): HookDecision | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // `{ decision: { action: 'block', ... } }` — nested form.
  let candidate: Record<string, unknown> = obj;
  if (
    obj['action'] === undefined &&
    obj['decision'] !== undefined &&
    typeof obj['decision'] === 'object' &&
    obj['decision'] !== null &&
    !Array.isArray(obj['decision'])
  ) {
    candidate = obj['decision'] as Record<string, unknown>;
  }
  // `{ decision: 'block', reason }` — string alias for `action`.
  const action = candidate['action'] ?? candidate['decision'];
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) return null;
  const decision: HookDecision = { action: action as HookDecision['action'] };
  if (typeof candidate['reason'] === 'string') decision.reason = candidate['reason'];
  if (
    candidate['args'] !== undefined &&
    typeof candidate['args'] === 'object' &&
    candidate['args'] !== null &&
    !Array.isArray(candidate['args'])
  ) {
    decision.args = candidate['args'] as Record<string, unknown>;
  }
  if (typeof candidate['output'] === 'string') decision.output = candidate['output'];
  if (typeof candidate['context'] === 'string') decision.context = candidate['context'];
  return decision;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run one hook script out-of-process and return its decision.
 *
 * Sends `{ event, ...input }` as one JSON line on stdin, reads the
 * LAST non-empty stdout line as the JSON decision, and rejects with a
 * clear Error on timeout, non-zero exit, missing/invalid output, or
 * spawn failure. Never hangs: the timeout always kills the process
 * group, even if the caller (e.g. `HookRunner`'s own per-hook timeout)
 * has already given up on the returned promise.
 */
export function runHookScript(
  scriptPath: string,
  event: HookEventKind,
  input: Record<string, unknown>,
  opts: HookScriptOptions = {},
): Promise<HookDecision> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_SCRIPT_TIMEOUT_MS;
  const cwd = opts.workspaceDir ?? process.cwd();
  const allowedDirs = [
    cwd,
    ...(opts.allowedDirs ?? []).filter((d) => typeof d === 'string' && d !== ''),
  ];
  // Validate eagerly so a bad path fails before spawning anything.
  const resolved = resolveHookScriptPath(scriptPath, allowedDirs);
  const logger = opts.logger;

  return new Promise<HookDecision>((resolvePromise, rejectPromise) => {
    let settled = false;
    const resolve = (decision: HookDecision): void => {
      if (settled) return;
      settled = true;
      resolvePromise(decision);
    };
    const reject = (err: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(err);
    };

    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let spawnFailed = false;

    let child;
    try {
      child = spawn(opts.nodePath ?? process.execPath, [resolved], {
        cwd,
        env: safeEnvForHookScript(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group on POSIX so the timeout kill takes the
        // script's own children with it (a script that spawns a
        // grandchild and hangs must not outlive the kill).
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(
        new Error(
          `Failed to start hook script "${scriptPath}": ${(err as Error).message}`,
        ),
      );
      return;
    }

    const killGroup = (): void => {
      if (child.pid === undefined) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead.
        }
        return;
      }
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Not a group leader (or already dead): fall through to kill single.
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    // Don't let the timer alone keep the event loop alive: the child
    // pipes already do that while the script runs.
    timer.unref?.();

    const finishWithError = (message: string): void => {
      clearTimeout(timer);
      const tail = stderrTail.trim();
      reject(
        new Error(
          tail.length > 0
            ? `${message} (stderr: ${tail})`
            : message,
        ),
      );
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-MAX_HOOK_SCRIPT_STDOUT_CHARS);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-MAX_HOOK_SCRIPT_STDERR_CHARS);
    });
    child.on('error', (err: Error) => {
      spawnFailed = true;
      clearTimeout(timer);
      reject(
        new Error(`Failed to start hook script "${scriptPath}": ${err.message}`),
      );
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (spawnFailed || settled) return;
      if (timedOut) {
        finishWithError(
          `Hook script "${scriptPath}" timed out after ${timeoutMs}ms` +
            (signal ? ` (killed with ${signal})` : ''),
        );
        return;
      }
      if (code !== 0) {
        finishWithError(
          `Hook script "${scriptPath}" exited with code ${String(code)}` +
            (signal ? ` (signal ${signal})` : ''),
        );
        return;
      }
      const lines = stdoutTail
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) {
        finishWithError(
          `Hook script "${scriptPath}" produced no output (expected a JSON decision line on stdout).`,
        );
        return;
      }
      // Log the non-decision lines (script debug output), capped.
      if (logger && lines.length > 1) {
        for (const line of lines.slice(0, -1)) {
          logger(`[hook-script ${path.basename(resolved)}] ${line.slice(0, 500)}`);
        }
      }
      const lastLine = lines[lines.length - 1]!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        finishWithError(
          `Hook script "${scriptPath}" returned invalid JSON on stdout: ` +
            `${lastLine.slice(0, 200)}`,
        );
        return;
      }
      const decision = normalizeScriptDecision(parsed);
      if (decision === null) {
        finishWithError(
          `Hook script "${scriptPath}" returned an invalid decision ` +
            `(expected { action: 'allow' | 'block' | 'modify' }): ${lastLine.slice(0, 200)}`,
        );
        return;
      }
      resolve(decision);
    });

    // Send the event, then close stdin. A script that exits before
    // reading gets EPIPE on our side — swallow it; 'close' settles.
    try {
      const payload = JSON.stringify({ event, ...input });
      child.stdin.on('error', () => {
        // EPIPE / closed stdin: the child exited early; 'close' settles.
      });
      child.stdin.write(`${payload}\n`);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to send input to hook script "${scriptPath}": ${(err as Error).message}`,
        ),
      );
    }
  });
}
