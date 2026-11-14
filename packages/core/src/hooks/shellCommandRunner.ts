/**
 * Shell-command hook runner (v1.01, T2).
 *
 * Runs ONE hook as a SHELL COMMAND configured in settings, out-of-process:
 * the command is spawned through the platform shell (`/bin/sh -c` on
 * POSIX, `cmd.exe /c` on Windows) in its own process group, so a hanging,
 * crashing or misbehaving command can never take down the coordinator
 * (same principle as the node-script runner in `scriptRunner.ts`, but
 * for arbitrary shell commands the user typed in Settings).
 *
 * Protocol (the command author implements this):
 * - stdin: a single JSON line `{ event, ...input }`, where `event` is
 *   the HookEventKind (e.g. `"PreToolUse"`) and the rest are that
 *   event's fields (e.g. `toolName`, `toolCallId`, `args`).
 * - stdout: the command may print anything for debugging, but the LAST
 *   non-empty line MAY be a JSON decision object with the same shape a
 *   `HookFn` returns (`HookDecision`): `{ action: 'allow' | 'block' |
 *   'modify', reason?, args?, output?, context?, additionalContext? }`.
 *   For convenience an `action` may also be spelled `decision`
 *   (`{ decision: 'block', reason: '...' }`); `decision` as a nested
 *   object (`{ decision: { action: 'block', ... } }`) is accepted too.
 * - exit code (the Claude Code convention, re-implemented here):
 *   - `0` → the command's decision applies: the JSON decision line when
 *     present (and parseable), otherwise plain `allow`. A command that
 *     prints nothing and exits 0 simply allows.
 *   - `2` → BLOCK. The reason is the last non-empty stdout line when it
 *     is not a JSON decision (plain text is fine), else the stderr tail,
 *     else a default message. A `block` decision on stdout is honoured
 *     too, but exit 2 alone is enough — a one-line `echo …; exit 2`
 *     gate needs no JSON at all.
 *   - any other non-zero exit / signal / timeout / spawn failure → a
 *     hook error: `runHookCommand` rejects, and `HookRunner` treats it
 *     exactly like a throwing function hook (recorded as a `HookError`,
 *     never a run crash, fail-closed by default).
 *
 * Safety:
 * - The child inherits ONLY a minimal allowlisted env (same allowlist
 *   as `safeEnvForHookScript` in `scriptRunner.ts`, copied here so this
 *   module stays self-contained) + `OPENBOT_HOOK_EVENT=<event>` + the
 *   hook's own `env` entries from settings (validated: secret-looking
 *   names are rejected at validation time, never passed down).
 *   Secrets / API keys of the parent process are never passed down.
 * - Per-invocation timeout (default 10s): on expiry the whole process
 *   GROUP is SIGKILLed and the call rejects with a timeout error.
 * - stderr is captured, capped (~10KB tail), and included in error
 *   messages — never printed raw (it could contain secrets).
 * - The command runs with cwd = the bot workspace dir (from
 *   `HookContext.workspaceDir` at call time, or the configured
 *   `workspaceDir`); a command hook has no access to anything the
 *   workspace dir does not already give it.
 *
 * This module NEVER throws synchronously for a bad command at run time:
 * `runHookCommand` rejects, and the registry wrapper turns that into a
 * throwing `HookFn` — which `HookRunner` already treats as a hook error.
 * Configuration problems (empty command, bad events, secret-looking env
 * names) are caught EARLIER by `validateHookCommandEntry`, which the
 * registry and the main-process IPC both call before registering.
 */

import { spawn } from 'node:child_process';
import type { HookDecision, HookEventKind } from './types';
import {
  ALL_HOOK_EVENTS,
  DEFAULT_HOOK_COMMAND_TIMEOUT_MS,
  HOOK_NAME_RE,
  HookRegistrationError,
  MAX_HOOK_COMMAND_TIMEOUT_MS,
  MIN_HOOK_COMMAND_TIMEOUT_MS,
} from './types';
import type { HookCommandSettingsEntry } from './types';

/** Exit code a hook command uses to BLOCK the event it saw. */
export const HOOK_COMMAND_BLOCK_EXIT_CODE = 2;

/** Max stderr chars kept (tail) for error messages / logging. */
export const MAX_HOOK_COMMAND_STDERR_CHARS = 10 * 1024;

/**
 * Max stdout chars kept (tail). Only the LAST stdout line is parsed,
 * so keeping a tail is enough and a chatty command cannot grow memory
 * unboundedly.
 */
export const MAX_HOOK_COMMAND_STDOUT_CHARS = 64 * 1024;

/** Env var carrying the event kind into the child (in addition to stdin JSON). */
export const HOOK_EVENT_ENV_VAR = 'OPENBOT_HOOK_EVENT';

export interface HookCommandOptions {
  /** Per-invocation timeout in ms. Default `DEFAULT_HOOK_COMMAND_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Working directory of the command (its `process.cwd()`). Defaults to the parent's cwd. */
  workspaceDir?: string;
  /** Extra env vars for the child (already validated — see `validateHookCommandEntry`). */
  env?: Record<string, string>;
  /** Where non-decision stdout lines / lifecycle notes are logged. */
  logger?: (message: string) => void;
  /** Max stdout chars kept (tail). Default `MAX_HOOK_COMMAND_STDOUT_CHARS`. */
  maxStdoutChars?: number;
  /** Max stderr chars kept (tail). Default `MAX_HOOK_COMMAND_STDERR_CHARS`. */
  maxStderrChars?: number;
}

// ---------------------------------------------------------------------------
// Safe env (copied allowlist — see module header)
// ---------------------------------------------------------------------------

/**
 * Biến môi trường an toàn được truyền cho hook command con. Copy đúng
 * allowlist của `safeEnvForHookScript` (`scriptRunner.ts`) — KHÔNG import
 * từ đó để module này tự đứng được. Mọi tên trông như secret đều bị chặn
 * dù có trong allowlist.
 */
const HOOK_COMMAND_SAFE_ENV_ALLOWLIST = new Set([
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
export const HOOK_COMMAND_SECRET_ENV_PATTERN =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;

/**
 * Lọc môi trường chỉ còn allowlist tối thiểu, chặn mọi tên giống secret.
 * Hook command là code bên thứ ba — không được thấy API key/token của
 * tiến trình chính. Tham số `source` chỉ để test (truyền env giả thay
 * vì sửa `process.env` thật).
 */
export function safeEnvForHookCommand(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!HOOK_COMMAND_SAFE_ENV_ALLOWLIST.has(key)) continue;
    if (HOOK_COMMAND_SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Môi trường đầy đủ cho một hook command con: safe env + event marker +
 * các biến `extra` đã validate (biến nào trông như secret trong `extra`
 * cũng bị chặn ở đây — defence-in-depth, dù validation đã chặn trước).
 */
export function buildHookCommandEnv(
  event: HookEventKind,
  extra: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = safeEnvForHookCommand(source);
  env[HOOK_EVENT_ENV_VAR] = event;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof key !== 'string' || key.trim() === '') continue;
      if (HOOK_COMMAND_SECRET_ENV_PATTERN.test(key)) continue;
      if (typeof value !== 'string') continue;
      env[key] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Config validation (pure — shared by registry + main IPC + Settings UI)
// ---------------------------------------------------------------------------

/** One validation problem with a hook-command settings entry. */
export interface HookCommandValidationIssue {
  /** Which field is bad (`name` / `command` / `events` / `timeoutMs` / `env.<KEY>`). */
  field: string;
  /** Human-readable problem (Vietnamese, shown in Settings). */
  message: string;
}

export interface HookCommandValidationResult {
  valid: boolean;
  issues: HookCommandValidationIssue[];
  /**
   * Normalised entry when valid: trimmed name/command, deduped events,
   * defaults filled in (`enabled: true`, `timeoutMs` default). Undefined
   * when invalid.
   */
  entry?: HookCommandSettingsEntry;
}

/**
 * Validate a hook-command settings entry (unknown shape tolerated —
 * Settings UI / IPC send plain JSON). Never throws; returns every issue
 * found so the caller can show them all at once. A `timeoutMs` outside
 * the hard limits is clamped into range only when it is a finite number
 * — non-numbers and negatives are issues, not silent clamps.
 */
export function validateHookCommandEntry(
  raw: unknown,
): HookCommandValidationResult {
  const issues: HookCommandValidationIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      issues: [{ field: '', message: 'Hook command phải là một object.' }],
    };
  }
  const obj = raw as Record<string, unknown>;

  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
  if (!name || !HOOK_NAME_RE.test(name)) {
    issues.push({
      field: 'name',
      message: `Tên hook "${String(obj['name'] ?? '')}" không hợp lệ: chỉ dùng chữ thường, số, "-" và "_", bắt đầu bằng chữ hoặc số.`,
    });
  }

  const command = typeof obj['command'] === 'string' ? obj['command'].trim() : '';
  if (!command) {
    issues.push({ field: 'command', message: 'Lệnh shell không được rỗng.' });
  }

  const rawEvents = obj['events'];
  const events: HookEventKind[] = [];
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    issues.push({
      field: 'events',
      message: 'Hook command cần ít nhất một event (vd PreToolUse, SubagentStop).',
    });
  } else {
    const seen = new Set<string>();
    for (const e of rawEvents) {
      if (typeof e !== 'string') {
        issues.push({ field: 'events', message: `Event không hợp lệ: ${String(e)}.` });
        continue;
      }
      if (seen.has(e)) continue;
      seen.add(e);
      // Unknown event names would silently never fire (a typo like
      // "PreTooluse" registers a hook that runs for nothing), so they
      // are rejected here instead of being dropped at apply time.
      if (!ALL_HOOK_EVENTS.includes(e as HookEventKind)) {
        issues.push({
          field: 'events',
          message: `Event không hợp lệ: "${e}". Event hợp lệ: ${ALL_HOOK_EVENTS.join(', ')}.`,
        });
        continue;
      }
      events.push(e as HookEventKind);
    }
    if (events.length === 0) {
      issues.push({ field: 'events', message: 'Hook command cần ít nhất một event hợp lệ.' });
    }
  }

  let timeoutMs = DEFAULT_HOOK_COMMAND_TIMEOUT_MS;
  if (obj['timeoutMs'] !== undefined) {
    const t = obj['timeoutMs'];
    if (typeof t !== 'number' || !Number.isFinite(t) || Math.floor(t) !== t) {
      issues.push({ field: 'timeoutMs', message: 'timeoutMs phải là số nguyên (ms).' });
    } else if (t < MIN_HOOK_COMMAND_TIMEOUT_MS || t > MAX_HOOK_COMMAND_TIMEOUT_MS) {
      issues.push({
        field: 'timeoutMs',
        message: `timeoutMs phải từ ${MIN_HOOK_COMMAND_TIMEOUT_MS}ms đến ${MAX_HOOK_COMMAND_TIMEOUT_MS}ms.`,
      });
    } else {
      timeoutMs = t;
    }
  }

  let env: Record<string, string> | undefined;
  if (obj['env'] !== undefined) {
    const rawEnv = obj['env'];
    if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
      issues.push({ field: 'env', message: 'env phải là một object { TÊN: "giá trị" }.' });
    } else {
      env = {};
      for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          issues.push({ field: `env.${key}`, message: `Giá trị của biến "${key}" phải là chuỗi.` });
          continue;
        }
        if (HOOK_COMMAND_SECRET_ENV_PATTERN.test(key)) {
          issues.push({
            field: `env.${key}`,
            message: `Biến "${key}" trông như secret — không được truyền cho hook command.`,
          });
          continue;
        }
        env[key] = value;
      }
    }
  }

  const enabled = obj['enabled'] === undefined ? true : obj['enabled'] === true;
  if (obj['enabled'] !== undefined && typeof obj['enabled'] !== 'boolean') {
    issues.push({ field: 'enabled', message: 'enabled phải là true/false.' });
  }

  const description =
    typeof obj['description'] === 'string' && obj['description'].trim() !== ''
      ? obj['description'].trim()
      : undefined;

  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    issues: [],
    entry: {
      name,
      command,
      events,
      enabled,
      timeoutMs,
      ...(env !== undefined ? { env } : {}),
      ...(description !== undefined ? { description } : {}),
    },
  };
}

/** Validate or throw `HookRegistrationError` (registration-time path). */
export function assertValidHookCommandEntry(raw: unknown): HookCommandSettingsEntry {
  const result = validateHookCommandEntry(raw);
  if (!result.valid || !result.entry) {
    throw new HookRegistrationError(
      `Hook command không hợp lệ: ${result.issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`,
    );
  }
  return result.entry;
}

// ---------------------------------------------------------------------------
// Decision parsing (same shapes as the script protocol)
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set(['allow', 'block', 'modify']);

/**
 * Parse one stdout line as a hook decision. Accepts the same three
 * shapes as `scriptRunner.ts`: `{ action }`, `{ decision: 'block' }`,
 * `{ decision: { action: 'block', … } }`. Returns null when the line is
 * not a valid decision (the caller then treats plain text as a reason
 * for exit 2, or ignores it for exit 0).
 */
export function parseHookDecisionLine(line: string): HookDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === undefined || parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
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
  if (typeof candidate['additionalContext'] === 'string') {
    decision.additionalContext = candidate['additionalContext'];
  }
  return decision;
}

/** Split captured stdout into non-empty trimmed lines. */
export function stdoutLines(stdoutTail: string): string[] {
  return stdoutTail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Low-level shell spawn (shared by hook commands and the test gate)
// ---------------------------------------------------------------------------

/** Result of one shell command spawn (exit code, not a hook decision). */
export interface ShellCommandResult {
  /** Process exit code (null when killed by a signal). */
  exitCode: number | null;
  /** Signal that killed the process, when any. */
  signal: NodeJS.Signals | null;
  /** Stdout tail (capped). */
  stdout: string;
  /** Stderr tail (capped). */
  stderr: string;
  /** True when the timeout killed the process group. */
  timedOut: boolean;
  /** Wall-clock runtime in ms. */
  durationMs: number;
}

export interface RunShellCommandOptions {
  /** Per-invocation timeout in ms. Default `DEFAULT_HOOK_COMMAND_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Working directory. Defaults to the parent's cwd. */
  cwd?: string;
  /** Extra env vars (merged over the safe env; secret-looking names dropped). */
  env?: Record<string, string>;
  /** Text written to stdin, then stdin is closed. Omit for no stdin. */
  stdinText?: string;
  /** Max stdout chars kept (tail). Default `MAX_HOOK_COMMAND_STDOUT_CHARS`. */
  maxStdoutChars?: number;
  /** Max stderr chars kept (tail). Default `MAX_HOOK_COMMAND_STDERR_CHARS`. */
  maxStderrChars?: number;
}

/** Shell binary + args for the platform: `/bin/sh -c` / `cmd.exe /c`. */
export function shellForPlatform(): { command: string; argsPrefix: string[] } {
  if (process.platform === 'win32') return { command: 'cmd.exe', argsPrefix: ['/c'] };
  return { command: '/bin/sh', argsPrefix: ['-c'] };
}

/**
 * Spawn one shell command and wait for it. Never throws for a command
 * that runs and exits (any exit code is reported in the result); rejects
 * only when the process cannot be spawned at all. A timeout kills the
 * whole process GROUP (POSIX) so grandchildren die with it.
 */
export function runShellCommand(
  command: string,
  opts: RunShellCommandOptions = {},
): Promise<ShellCommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_COMMAND_TIMEOUT_MS;
  const maxStdoutChars = opts.maxStdoutChars ?? MAX_HOOK_COMMAND_STDOUT_CHARS;
  const maxStderrChars = opts.maxStderrChars ?? MAX_HOOK_COMMAND_STDERR_CHARS;
  const startedAt = Date.now();
  const shell = shellForPlatform();

  return new Promise<ShellCommandResult>((resolve, reject) => {
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let spawnFailed = false;

    let child;
    try {
      child = spawn(shell.command, [...shell.argsPrefix, command], {
        cwd: opts.cwd ?? process.cwd(),
        env: buildHookCommandEnvForShell(opts.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(
        new Error(
          `Failed to start shell command "${command.slice(0, 120)}": ${(err as Error).message}`,
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
          // Not a group leader (or already dead): fall through.
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
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-maxStdoutChars);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-maxStderrChars);
    });
    child.on('error', (err: Error) => {
      spawnFailed = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to start shell command "${command.slice(0, 120)}": ${err.message}`,
        ),
      );
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (spawnFailed) return;
      resolve({
        exitCode: code,
        signal,
        stdout: stdoutTail,
        stderr: stderrTail,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (opts.stdinText !== undefined) {
      try {
        child.stdin.on('error', () => {
          // EPIPE / closed stdin: the child exited early; 'close' settles.
        });
        child.stdin.write(opts.stdinText);
        child.stdin.end();
      } catch (err) {
        clearTimeout(timer);
        reject(
          new Error(
            `Failed to send input to shell command "${command.slice(0, 120)}": ${(err as Error).message}`,
          ),
        );
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
    }
  });
}

/**
 * Env for a plain shell spawn: safe env + `extra` (secret-looking names
 * dropped). Unlike hook commands, no `OPENBOT_HOOK_EVENT` marker — the
 * caller (test gate) is not a hook event.
 */
function buildHookCommandEnvForShell(
  extra: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env = safeEnvForHookCommand();
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof key !== 'string' || key.trim() === '') continue;
      if (HOOK_COMMAND_SECRET_ENV_PATTERN.test(key)) continue;
      if (typeof value !== 'string') continue;
      env[key] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Hook command runner (exit-code protocol)
// ---------------------------------------------------------------------------

/**
 * Run one hook command out-of-process and return its decision.
 *
 * Sends `{ event, ...input }` as one JSON line on stdin, then applies
 * the exit-code protocol (see module header): 0 → JSON decision line
 * or allow; 2 → block; anything else → reject with an Error (the
 * runner turns that into a hook error, fail-closed by default).
 * Never hangs: the timeout always kills the process group.
 */
export async function runHookCommand(
  command: string,
  event: HookEventKind,
  input: Record<string, unknown>,
  opts: HookCommandOptions = {},
): Promise<HookDecision> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_COMMAND_TIMEOUT_MS;
  const logger = opts.logger;
  const payload = JSON.stringify({ event, ...input });
  const env = buildHookCommandEnv(event, opts.env);

  const result = await runShellCommand(command, {
    timeoutMs,
    cwd: opts.workspaceDir ?? process.cwd(),
    // runShellCommand rebuilds the safe env itself; pass the hook env
    // through as extra so OPENBOT_HOOK_EVENT + validated vars survive.
    env: env as Record<string, string>,
    stdinText: `${payload}\n`,
    maxStdoutChars: opts.maxStdoutChars,
    maxStderrChars: opts.maxStderrChars,
  });

  const lines = stdoutLines(result.stdout);
  const stderrTail = result.stderr.trim();
  const displayCommand =
    command.length > 120 ? `${command.slice(0, 120)}…` : command;

  if (result.timedOut) {
    throw new Error(
      `Hook command "${displayCommand}" timed out after ${timeoutMs}ms` +
        (stderrTail ? ` (stderr: ${stderrTail.slice(-500)})` : ''),
    );
  }
  if (result.signal !== null && result.exitCode === null) {
    throw new Error(
      `Hook command "${displayCommand}" was killed by signal ${result.signal}` +
        (stderrTail ? ` (stderr: ${stderrTail.slice(-500)})` : ''),
    );
  }

  const exitCode = result.exitCode ?? -1;

  // Log the non-decision stdout lines (command debug output), capped.
  if (logger && lines.length > 1) {
    for (const line of lines.slice(0, -1)) {
      logger(`[hook-command ${displayCommand}] ${line.slice(0, 500)}`);
    }
  }

  if (exitCode === HOOK_COMMAND_BLOCK_EXIT_CODE) {
    // Exit 2 = block. Reason: a JSON decision's reason when the last
    // line is one, else the last plain-text line, else stderr, else default.
    const lastLine = lines.length > 0 ? lines[lines.length - 1]! : '';
    const decision = lastLine ? parseHookDecisionLine(lastLine) : null;
    if (decision && decision.action === 'block') return decision;
    const reason =
      (decision?.reason ??
        (lastLine && !isJsonLine(lastLine) ? lastLine : '') ??
        '') ||
      stderrTail ||
      `Blocked by hook command "${displayCommand}" (exit 2).`;
    return { action: 'block', reason: reason.slice(0, 1000) };
  }

  if (exitCode !== 0) {
    throw new Error(
      `Hook command "${displayCommand}" exited with code ${exitCode}` +
        (stderrTail ? ` (stderr: ${stderrTail.slice(-500)})` : ''),
    );
  }

  // Exit 0: last stdout line may carry a JSON decision; no output = allow.
  if (lines.length === 0) return { action: 'allow' };
  const lastLine = lines[lines.length - 1]!;
  const decision = parseHookDecisionLine(lastLine);
  if (decision !== null) return decision;
  // Plain-text stdout with exit 0 is just command output, not a decision.
  return { action: 'allow' };
}

function isJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
