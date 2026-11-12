/**
 * Shell / execution tools for @open-bot/tools (v0.6) — the "Shell & thực
 * thi trên máy" group of the ROADMAP (section 2b).
 *
 * Tools:
 *   exec_task / exec_task_status / exec_task_stop — run a shell command
 *     as a tracked background task (start returns a taskId immediately;
 *     status polls partial output; stop kills it).
 *   shell_session_start / shell_session_write / shell_session_read /
 *     shell_session_close — one persistent interactive shell: write to
 *     its stdin, read new output since the last read.
 *   sandbox_prepare — prepare an isolated workspace directory for an
 *     agent run (from an empty dir or a template dir inside the
 *     workspace), with an env allowlist file and a resource-limits
 *     metadata file.
 *
 * v0.74b: đường session local (không daemon) nay kiểm tra từng dòng
 * stdin qua module dùng chung `daemon/sessionLine.ts` — denylist +
 * var expansion + heredoc + egress, fragment dở + flush lúc đóng —
 * đúng một logic với daemon (trước đây đường local ghi thẳng stdin,
 * `sudo` trong session_write chạy được tới root).
 *
 * `shell_exec` itself already exists in ./tools.ts (verified working in
 * v0.6: denylist, cwd confinement, daemon path + in-process fallback);
 * these tools build on the same sandbox rules and the same daemon.
 *
 * Safety rules (same as tools.ts):
 *  - Every command goes through assertCommandAllowed() (denylist) and
 *    every path through resolveWithin() — nothing escapes ctx.workspaceDir.
 *  - Child env is safeEnv() only (allowlist, secret-looking names dropped).
 *  - Output is capped per stream at MAX_EXEC_OUTPUT_CHARS (200k) in the
 *    daemon AND in the local fallback, so a runaway command cannot grow
 *    memory unbounded. Tool results are truncated to 20k chars.
 *  - Sessions are in-memory only, capped at MAX_SESSIONS concurrent,
 *    and idle sessions are closed after SESSION_IDLE_TIMEOUT_MS.
 *
 * Factory:
 *   createShellTools(getDaemon?) -> Tool[]   (bound, usable)
 *   createShellTools({ getDaemon, ... }) -> Tool[]  (options form)
 *   SHELL_TOOLS                             (daemon-less placeholder:
 *                                            execs/sessions run locally
 *                                            via runShell / spawn)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import type { EgressPolicy } from '@open-bot/core/dist/egress/policy';
import {
  assertCommandAllowed,
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  resolveWithin,
  runShell,
  safeEnv,
} from './sandbox';
import type { ShellDaemon } from './daemon/types';
import { MAX_EXEC_OUTPUT_CHARS } from './daemon/types';
// v0.74b: kiểm tra từng dòng stdin đường local dùng CHUNG module
// `sessionLine.ts` với daemon (trước đây đường local ghi thẳng stdin
// không kiểm tra gì — `sudo` trong session_write chạy được).
import {
  checkSessionLineEgress,
  checkSessionLineEgressSync,
  createSessionLineState,
  decideSessionLine,
  MAX_PENDING_PARTIAL_LINE_CHARS,
  type SessionLineState,
} from './daemon/sessionLine';
import { SESSION_CLOSE_KILL_DELAY_MS } from './daemon/daemon';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';
// v0.86 (P2-10): elevate — pure helpers sống ở core (xây argv sudo -n,
// validate lệnh trong + lý do, nhận diện lỗi cần password). Import theo
// đường dẫn sâu như sandbox.ts làm với `@open-bot/core/dist/agent/rules`.
import {
  buildElevatedArgv,
  DEFAULT_ELEVATE_TIMEOUT_MS,
  ELEVATED_TOOL_NAME,
  formatElevatedResult,
  MAX_ELEVATE_TIMEOUT_MS,
  validateElevateRequest,
  type ElevatedRunResult,
} from '@open-bot/core/dist/elevate/elevate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };
/** Tracked exec tasks kept per factory instance (finished ones pruned). */
export const MAX_TRACKED_TASKS = 32;
/** Interactive shell sessions alive at once, per factory instance. */
export const MAX_SESSIONS = 8;
/** A session with no read/write for this long is closed on next use. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Per-stream output kept per task/session (mirrors the daemon cap). */
export const MAX_TASK_OUTPUT_CHARS = MAX_EXEC_OUTPUT_CHARS;

export interface ShellToolsOptions {
  /** Lazily resolved per call, so a dead daemon is re-created by the caller. */
  getDaemon?: () => ShellDaemon | null;
  /** Max concurrent interactive sessions (default MAX_SESSIONS). */
  maxSessions?: number;
  /** Idle time after which a session is closed (default 10 minutes). */
  sessionIdleTimeoutMs?: number;
  /**
   * v0.55: resolver policy egress hiệu lực của team hiện tại (coordinator
   * truyền xuống, xem `ToolFactoryHost`). Resolve lười mỗi lần chạy:
   *  - `exec_task` đường in-process: resolver đi thẳng vào `runShell`
   *    (provider thắng policy module; `undefined` → fail-closed).
   *  - `exec_task` / `shell_session_start` đường daemon: policy đã
   *    resolve được mang theo từng request/session (daemon ưu tiên
   *    policy request hơn policy chung của nó); `undefined`/`null` thì
   *    không mang theo (daemon tự resolve/fail-closed theo policy
   *    của nó).
   */
  getEgressPolicy?: () => EgressPolicy | null | undefined;
  /**
   * v0.86 (P2-10): runner chạy lệnh elevate (mặc định: spawn `sudo -n`
   * thật). Chỉ dùng để test inject runner giả — production không truyền
   * gì (dùng `defaultElevateRunner` bên dưới). Runner nhận argv đầy đủ
   * (`sudo -n /bin/sh -c <command>`), cwd + env đã lọc secret, timeout.
   */
  elevateRunner?: (
    argv: string[],
    opts: { timeoutMs: number; cwd: string; env: Record<string, string> },
  ) => Promise<ElevatedRunResult>;
}


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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Argument "${name}" must be a positive number.`);
  }
  return Math.min(Math.floor(value), max);
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings`);
  }
  return value as string[];
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function platformShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell', args: ['-NoProfile', '-Command'] };
  }
  return { command: '/bin/sh', args: ['-c'] };
}

function platformInteractiveShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell', args: ['-NoProfile'] };
  }
  return { command: '/bin/sh', args: [] };
}

/**
 * Default elevate runner (v0.86, P2-10): spawn argv thật
 * (`sudo -n /bin/sh -c <command>`). `sudo -n` fail ngay khi cần
 * password (không treo hỏi); timeout thì kill cả process group.
 * Output mỗi stream cap ở MAX_EXEC_OUTPUT_CHARS như daemon. Không
 * bao giờ truyền password, không đọc stdin (stdin đóng ngay để sudo
 * không chờ nhập gì).
 */
export async function defaultElevateRunner(
  argv: string[],
  opts: { timeoutMs: number; cwd: string; env: Record<string, string> },
): Promise<ElevatedRunResult> {
  const [command, ...args] = argv;
  const stdout = { text: '', truncated: false };
  const stderr = { text: '', truncated: false };
  return new Promise<ElevatedRunResult>((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (result: ElevatedRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawn(command!, args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `Failed to start elevate runner: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Already dead.
      }
    }, opts.timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => appendCapped(stdout, chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => appendCapped(stderr, chunk.toString('utf8')));
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      finish({
        exitCode: null,
        signal: null,
        stdout: stdout.text,
        stderr: `${stderr.text}\n[ elevate runner failed to start: ${err.message} ]`,
        timedOut: false,
      });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      finish({
        exitCode: code,
        signal: signal,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
      });
    });
  });
}

/** Append a chunk to a capped buffer; returns true when truncated. */
function appendCapped(
  buf: { text: string; truncated: boolean },
  chunk: string,
): void {
  if (buf.truncated) return;
  const remaining = MAX_TASK_OUTPUT_CHARS - buf.text.length;
  if (chunk.length <= remaining) {
    buf.text += chunk;
  } else {
    buf.text += chunk.slice(0, Math.max(0, remaining));
    buf.text += `\n[... output truncated at ${MAX_TASK_OUTPUT_CHARS} chars ...]`;
    buf.truncated = true;
  }
}

// ---------------------------------------------------------------------------
// exec_task — tracked background shell tasks
// ---------------------------------------------------------------------------

type ExecTaskStatus = 'running' | 'done' | 'failed' | 'stopped' | 'timed_out';

interface ExecTask {
  taskId: string;
  execId: string;
  command: string;
  status: ExecTaskStatus;
  stdout: { text: string; truncated: boolean };
  stderr: { text: string; truncated: boolean };
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number | null;
  stoppedByUser: boolean;
  abort: AbortController | null;
}

function taskSnapshot(task: ExecTask): Record<string, unknown> {
  return {
    taskId: task.taskId,
    command: task.command,
    status: task.status,
    exitCode: task.exitCode,
    signal: task.signal,
    timedOut: task.timedOut,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    stdoutChars: task.stdout.text.length,
    stderrChars: task.stderr.text.length,
    truncated: task.stdout.truncated || task.stderr.truncated,
    // Partial output, capped so the tool result stays readable. The
    // full buffered output (up to 200k chars/stream) is NOT returned
    // whole — poll again for the tail via a later status call is not
    // supported; use a smaller command or read the workspace files.
    stdout: truncate(task.stdout.text, 8000),
    stderr: truncate(task.stderr.text, 8000),
  };
}

// ---------------------------------------------------------------------------
// shell_session — persistent interactive shells
// ---------------------------------------------------------------------------

interface ShellSession {
  sessionId: string;
  daemonSessionId: string | null;
  child: ChildProcess | null;
  buffer: { text: string; truncated: boolean };
  readOffset: number;
  createdAt: number;
  lastActivity: number;
  closed: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  cwd: string;
  /**
   * v0.74b: trạng thái kiểm tra dòng của session local (biến shell đã
   * track + heredoc đang mở + policy egress đã đóng băng) — cùng
   * `SessionLineState` daemon dùng; đường local nay kiểm tra từng
   * dòng stdin như daemon thay vì ghi thẳng.
   */
  lineState: SessionLineState;
  /** Fragment dòng dở chưa có `\n`, giữ lại cho lần ghi sau (như daemon). */
  pendingPartialLine: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShellTools(
  getDaemonOrOptions?: (() => ShellDaemon | null) | ShellToolsOptions,
): Tool[] {
  const options: ShellToolsOptions =
    typeof getDaemonOrOptions === 'function'
      ? { getDaemon: getDaemonOrOptions }
      : (getDaemonOrOptions ?? {});
  const getDaemon = options.getDaemon;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const sessionIdleTimeoutMs =
    options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;

  const tasks = new Map<string, ExecTask>();
  const sessions = new Map<string, ShellSession>();
  let daemonSubscribed = false;

  // --- exec_task helpers ---------------------------------------------------

  function pruneFinishedTasks(): void {
    if (tasks.size < MAX_TRACKED_TASKS) return;
    for (const [id, task] of [...tasks]) {
      if (task.status !== 'running') tasks.delete(id);
      if (tasks.size < MAX_TRACKED_TASKS) break;
    }
  }

  async function startTask(
    command: string,
    cwd: string,
    workspaceDir: string,
    timeoutMs: number,
  ): Promise<ExecTask> {
    pruneFinishedTasks();
    if (tasks.size >= MAX_TRACKED_TASKS) {
      throw new Error(
        `Too many tracked exec tasks (${MAX_TRACKED_TASKS} running); ` +
          `wait for one to finish or stop it with exec_task_stop first.`,
      );
    }
    const task: ExecTask = {
      taskId: randomUUID(),
      execId: randomUUID(),
      command,
      status: 'running',
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      exitCode: null,
      signal: null,
      timedOut: false,
      startedAt: Date.now(),
      finishedAt: null,
      stoppedByUser: false,
      abort: null,
    };
    tasks.set(task.taskId, task);

    const daemon = getDaemon?.() ?? null;
    // v0.55: policy egress của team hiện tại (resolve một lần cho cả
    // task này; xem ShellToolsOptions.getEgressPolicy).
    const egressPolicy = options.getEgressPolicy?.();
    if (daemon) {
      const shell = platformShell();
      const finish = (result: { exitCode: number | null; signal: string | null; timedOut: boolean }): void => {
        if (task.status !== 'running') return;
        task.exitCode = result.exitCode;
        task.signal = result.signal;
        task.timedOut = result.timedOut;
        task.finishedAt = Date.now();
        if (task.stoppedByUser) task.status = 'stopped';
        else if (result.timedOut) task.status = 'timed_out';
        else if (result.exitCode === 0) task.status = 'done';
        else task.status = 'failed';
      };
      daemon
        .exec(
          {
            command: shell.command,
            args: [...shell.args, command],
            cwd,
            // v0.16 (M1 đa bot): giam exec này theo đúng workspace của
            // bot gọi — daemon dùng chung cho nhiều bot nên mỗi request
            // phải mang theo workspaceDir của mình.
            workspaceDir,
            env: { ...safeEnv() } as Record<string, string>,
            timeoutMs,
            // v0.55: policy egress của team mang theo request (chỉ khi
            // resolve ra policy thật; `undefined`/`null` thì để daemon
            // tự resolve/fail-closed theo policy của nó).
            ...(egressPolicy ? { egressPolicy } : {}),
          },
          {
            onStdout: (chunk) => appendCapped(task.stdout, chunk),
            onStderr: (chunk) => appendCapped(task.stderr, chunk),
          },
          task.execId,
        )
        .then(finish)
        .catch((err: Error) => {
          if (task.status !== 'running') return;
          task.finishedAt = Date.now();
          task.status = task.stoppedByUser ? 'stopped' : 'failed';
          task.stderr.text += `\n[exec_task: failed to start: ${err.message}]`;
        });
    } else {
      // No daemon: run in-process via runShell in the background. The
      // task outlives the tool call, so ctx.signal is NOT passed — only
      // exec_task_stop (via this AbortController) can stop it.
      const abort = new AbortController();
      task.abort = abort;
      runShell(command, cwd, {
        workspaceDir,
        timeoutMs,
        signal: abort.signal,
        // v0.55: policy egress của team hiện tại (resolve lười).
        getEgressPolicy: options.getEgressPolicy,
      })
        .then((result) => {
          if (task.status !== 'running') return;
          task.stdout.text = result.stdout;
          task.stderr.text = result.stderr;
          task.exitCode = result.code;
          task.timedOut = result.code === null && !task.stoppedByUser;
          task.finishedAt = Date.now();
          if (task.stoppedByUser) task.status = 'stopped';
          else if (task.timedOut) task.status = 'timed_out';
          else if (result.code === 0) task.status = 'done';
          else task.status = 'failed';
        })
        .catch((err: Error) => {
          if (task.status !== 'running') return;
          task.finishedAt = Date.now();
          task.status = task.stoppedByUser ? 'stopped' : 'failed';
          task.stderr.text += `\n[exec_task: failed to start: ${err.message}]`;
        });
    }
    return task;
  }

  // --- shell_session helpers ------------------------------------------------

  /** Close idle/closed sessions; returns how many sessions are alive. */
  function sweepSessions(): void {
    const now = Date.now();
    for (const [id, session] of [...sessions]) {
      if (session.closed) {
        sessions.delete(id);
        continue;
      }
      if (now - session.lastActivity > sessionIdleTimeoutMs) {
        void closeSession(session, 'idle timeout');
        sessions.delete(id);
      }
    }
  }

  /** Kill process group của shell local (POSIX) / process (Windows). */
  function killLocalChild(child: ChildProcess): void {
    try {
      if (child.pid !== undefined && process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Already dead.
    }
  }

  /**
   * Flush phần dòng dở (`pendingPartialLine`) còn lại của một session
   * local khi đóng (v0.74b, mirror `flushPendingPartialLine` của
   * daemon): fragment qua cùng `decideSessionLine` + egress sync như
   * `session_write`; vi phạm thì bỏ và ghi log stderr (không ghi vào
   * stdin); lành thì ghi nốt kèm `\n` để shell chạy nốt dòng cuối.
   * Best-effort: stdin đã đóng / shell đã thoát thì false, không
   * throw — thao tác đóng không được fail vì flush. Sau khi gọi,
   * `pendingPartialLine` luôn là ''.
   */
  function flushLocalPendingPartialLine(session: ShellSession): boolean {
    const fragment = session.pendingPartialLine;
    session.pendingPartialLine = '';
    if (session.lineState.workspaceDir === undefined) return false;
    if (fragment.trim() === '') return false;
    const stdin = session.child?.stdin;
    if (session.exited || stdin === undefined || stdin === null) return false;
    const decision = decideSessionLine(session.lineState, fragment);
    if (!decision.write) {
      process.stderr.write(
        `[shell session] session "${session.sessionId}": dòng dở cuối bị chặn bởi denylist, bỏ không flush: ${decision.blockedMessage ?? 'COMMAND_BLOCKED'}\n`,
      );
      return false;
    }
    const egressError = checkSessionLineEgressSync(session.lineState, fragment, {
      fragment: true,
    });
    if (egressError !== null) {
      process.stderr.write(
        `[shell session] session "${session.sessionId}": dòng dở cuối bị chặn bởi egress, bỏ không flush: ${egressError.message}\n`,
      );
      return false;
    }
    try {
      stdin.write(fragment + '\n', 'utf8');
      return true;
    } catch (err) {
      process.stderr.write(
        `[shell session] session "${session.sessionId}": không flush được dòng dở cuối: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return false;
    }
  }

  async function closeSession(session: ShellSession, _reason: string): Promise<boolean> {
    if (session.closed) return false;
    session.closed = true;
    if (session.daemonSessionId !== null) {
      const daemon = getDaemon?.() ?? null;
      if (daemon) {
        try {
          await daemon.closeSession(session.daemonSessionId);
        } catch {
          // Daemon gone — the session is dead with it.
        }
      }
    } else if (session.child !== null) {
      // v0.74b: mirror `handleSessionClose` của daemon — flush dòng dở
      // còn lại rồi mới kill: đã flush thì đóng stdin (EOF) để shell
      // chạy nốt dòng đó rồi tự thoát, hẹn kill sau 500ms nếu shell
      // không thoát; chưa flush thì kill ngay như trước.
      const flushed = flushLocalPendingPartialLine(session);
      if (!session.exited) {
        if (flushed) {
          try {
            session.child.stdin?.end();
          } catch {
            killLocalChild(session.child);
          }
          const timer = setTimeout(() => {
            if (!session.exited && session.child !== null) killLocalChild(session.child);
          }, SESSION_CLOSE_KILL_DELAY_MS);
          timer.unref?.();
        } else {
          killLocalChild(session.child);
        }
      }
    }
    return true;
  }

  function subscribeDaemonEvents(): void {
    if (daemonSubscribed) return;
    const daemon = getDaemon?.() ?? null;
    if (!daemon || typeof daemon.onEvent !== 'function') return;
    daemonSubscribed = true;
    daemon.onEvent((event, data) => {
      if (typeof data !== 'object' || data === null) return;
      const d = data as Record<string, unknown>;
      if (typeof d['sessionId'] !== 'string') return;
      // The daemon's event carries the DAEMON session id, while this
      // manager keys sessions by its own tool-level id — look the
      // session up by its daemonSessionId.
      const daemonSessionId = d['sessionId'];
      const session = [...sessions.values()].find(
        (s) => s.daemonSessionId === daemonSessionId,
      );
      if (!session || session.closed) return;
      session.lastActivity = Date.now();
      if (event === 'session.stdout' || event === 'session.stderr') {
        if (typeof d['chunk'] === 'string') appendCapped(session.buffer, d['chunk']);
      } else if (event === 'session.exit') {
        session.exited = true;
        session.exitCode = typeof d['exitCode'] === 'number' ? d['exitCode'] : null;
        session.signal = typeof d['signal'] === 'string' ? d['signal'] : null;
      }
    });
  }

  async function startSession(cwd: string, workspaceDir: string): Promise<ShellSession> {
    sweepSessions();
    if (sessions.size >= maxSessions) {
      throw new Error(
        `Too many open shell sessions (${maxSessions}); ` +
          `close one with shell_session_close first.`,
      );
    }
    const sessionId = randomUUID();
    // v0.55/v0.74b: policy egress của team — resolve một lần cho cả
    // đời session; daemon branch mang theo request, local branch đóng
    // băng vào `lineState` (kiểm tra egress từng dòng stdin).
    const egressPolicy = options.getEgressPolicy?.() ?? undefined;
    const session: ShellSession = {
      sessionId,
      daemonSessionId: null,
      child: null,
      buffer: { text: '', truncated: false },
      readOffset: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      closed: false,
      exited: false,
      exitCode: null,
      signal: null,
      cwd,
      lineState: createSessionLineState(workspaceDir, egressPolicy, 'local'),
      pendingPartialLine: '',
    };
    sessions.set(sessionId, session);

    const daemon = getDaemon?.() ?? null;
    if (daemon) {
      subscribeDaemonEvents();
      const shell = platformInteractiveShell();
      try {
        // v0.55: policy egress của team mang theo session — daemon đóng
        // băng policy này cho cả đời session (chỉ khi resolve ra policy
        // thật; `undefined`/`null` thì để daemon tự resolve theo policy
        // của nó).
        const started = await daemon.startSession({
          command: shell.command,
          args: shell.args,
          cwd,
          // v0.16 (M1 đa bot): giam session này theo đúng workspace của
          // bot gọi (cwd đã được caller validate/giam, daemon kiểm tra
          // lại theo workspaceDir này như defence-in-depth).
          workspaceDir,
          env: { ...safeEnv() } as Record<string, string>,
          ...(egressPolicy ? { egressPolicy } : {}),
        });
        session.daemonSessionId = started.sessionId;
      } catch (err) {
        // Do not leave a zombie session behind when the spawn failed.
        sessions.delete(sessionId);
        throw err;
      }
    } else {
      const shell = platformInteractiveShell();
      try {
        const child = spawn(shell.command, shell.args, {
          cwd,
          env: safeEnv(),
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        session.child = child;
        child.stdout?.on('data', (chunk: Buffer) => {
          appendCapped(session.buffer, chunk.toString('utf8'));
          session.lastActivity = Date.now();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          appendCapped(session.buffer, chunk.toString('utf8'));
          session.lastActivity = Date.now();
        });
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          session.exited = true;
          session.exitCode = code;
          session.signal = signal;
          session.lastActivity = Date.now();
        });
      } catch (err) {
        sessions.delete(sessionId);
        throw err;
      }
    }
    return session;
  }

  function getLiveSession(sessionId: string): ShellSession {
    sweepSessions();
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Unknown shell session "${sessionId}" (it may have been closed or timed out after ${sessionIdleTimeoutMs}ms idle).`,
      );
    }
    return session;
  }

  /**
   * Ghi text vào stdin của session LOCAL (v0.74b) — mirror
   * `handleSessionWrite` của daemon: từng dòng đầy đủ qua
   * `decideSessionLine` (denylist + var expansion + heredoc) rồi
   * `checkSessionLineEgress` (async, có DNS); dòng trống đi thẳng;
   * fragment dở giữ lại cho lần sau (vượt 64k thì kiểm tra như dòng
   * rồi ghi ngay, không kèm `\n`). Dòng bị chặn chỉ bị bỏ (ghi nhận
   * dòng đầu vào lỗi), các dòng lành vẫn ghi, session sống. Session
   * không giam (`workspaceDir` undefined) thì ghi thô như trước
   * v0.74b — cùng điều kiện daemon dùng. Throw khi stdin ghi lỗi
   * (execute bọc thành errorResult).
   */
  async function writeLocalSessionInput(
    session: ShellSession,
    input: string,
  ): Promise<{ blockedMessage?: string; blockedCode?: string }> {
    const state = session.lineState;
    const stdin = session.child?.stdin;
    if (stdin === undefined || stdin === null) {
      throw new Error(
        `Shell session "${session.sessionId}" has no writable stdin.`,
      );
    }
    if (state.workspaceDir === undefined) {
      stdin.write(input, 'utf8');
      return {};
    }
    const combined = session.pendingPartialLine + input;
    const parts = combined.split('\n');
    // Phần tử cuối là fragment chưa hoàn chỉnh ('' khi input kết thúc
    // bằng `\n`); mọi phần tử trước nó là dòng đầy đủ, đã có `\n`.
    const fragment = parts.pop() ?? '';
    const safeLines: string[] = [];
    let blockedMessage: string | undefined;
    let blockedCode = 'COMMAND_BLOCKED';
    for (const line of parts) {
      if (line.trim() === '') {
        safeLines.push(line);
        continue;
      }
      const decision = decideSessionLine(state, line);
      if (!decision.write) {
        if (blockedMessage === undefined) {
          blockedMessage = decision.blockedMessage;
          blockedCode = 'COMMAND_BLOCKED';
        }
        continue;
      }
      const egressError = await checkSessionLineEgress(state, line);
      if (egressError !== null) {
        if (blockedMessage === undefined) {
          blockedMessage = egressError.message;
          blockedCode = egressError.code;
        }
        continue;
      }
      safeLines.push(line);
    }
    let flushFragmentNow = '';
    if (fragment.length > MAX_PENDING_PARTIAL_LINE_CHARS) {
      const decision = decideSessionLine(state, fragment);
      if (!decision.write) {
        if (blockedMessage === undefined) {
          blockedMessage = decision.blockedMessage;
          blockedCode = 'COMMAND_BLOCKED';
        }
      } else {
        const egressError = await checkSessionLineEgress(state, fragment);
        if (egressError !== null) {
          if (blockedMessage === undefined) {
            blockedMessage = egressError.message;
            blockedCode = egressError.code;
          }
        } else {
          flushFragmentNow = fragment;
        }
      }
      session.pendingPartialLine = '';
    } else {
      session.pendingPartialLine = fragment;
    }
    const safeInput = safeLines.length > 0 ? safeLines.join('\n') + '\n' : '';
    if (safeInput !== '' || flushFragmentNow !== '') {
      try {
        if (safeInput !== '') stdin.write(safeInput, 'utf8');
        if (flushFragmentNow !== '') stdin.write(flushFragmentNow, 'utf8');
      } catch (err) {
        throw new Error(
          `shell session: failed to write to session "${session.sessionId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return blockedMessage === undefined ? {} : { blockedMessage, blockedCode };
  }

  // --- tools ----------------------------------------------------------------

  const execTaskTool: Tool = {
    definition: toolDef(
      'exec_task',
      'Run a shell command as a tracked background task. Returns a taskId immediately; ' +
        'poll exec_task_status for progress/partial output and exec_task_stop to stop it. ' +
        'Same sandbox denylist as shell_exec. Timeout 60s by default (max 10 minutes).',
      {
        command: { type: 'string', description: 'Shell command to run.' },
        timeout_ms: { type: 'number', description: 'Kill the command after this many ms (default 60000, max 600000).' },
      },
      ['command'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const command = getStringArg(args, 'command');
        assertCommandAllowed(command);
        const cwd = resolveWithin(ctx.workspaceDir, ctx.workspaceDir);
        const timeoutMs = getNumberArg(args, 'timeout_ms', DEFAULT_SHELL_TIMEOUT_MS, 600_000);
        const task = await startTask(command, cwd, ctx.workspaceDir, timeoutMs);
        return JSON.stringify(
          { taskId: task.taskId, command: task.command, status: task.status, startedAt: task.startedAt },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const execTaskStatusTool: Tool = {
    definition: toolDef(
      'exec_task_status',
      'Read the status and partial output of a tracked exec task started by exec_task. Read-only.',
      {
        taskId: { type: 'string', description: 'Task id returned by exec_task.' },
      },
      ['taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const taskId = getStringArg(args, 'taskId');
        const task = tasks.get(taskId);
        if (!task) return errorResult(`Unknown exec task "${taskId}".`);
        return truncate(JSON.stringify(taskSnapshot(task), null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const execTaskStopTool: Tool = {
    definition: toolDef(
      'exec_task_stop',
      'Stop a running exec task started by exec_task (kills the whole process group). Idempotent: stopping a finished task reports stopped: false.',
      {
        taskId: { type: 'string', description: 'Task id returned by exec_task.' },
      },
      ['taskId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const taskId = getStringArg(args, 'taskId');
        const task = tasks.get(taskId);
        if (!task) return errorResult(`Unknown exec task "${taskId}".`);
        if (task.status !== 'running') {
          return JSON.stringify({ taskId, status: task.status, stopped: false }, null, 2);
        }
        task.stoppedByUser = true;
        const daemon = getDaemon?.() ?? null;
        if (daemon) {
          await daemon.kill(task.execId).catch(() => undefined);
        } else if (task.abort) {
          task.abort.abort();
        }
        // Give the kill a moment to settle, then report. The status
        // flips to "stopped" when the exec promise settles.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return JSON.stringify(
          { taskId, status: task.status, stopped: task.status !== 'running' },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const shellSessionStartTool: Tool = {
    definition: toolDef(
      'shell_session_start',
      'Open a persistent interactive shell session in the workspace. Returns a sessionId; ' +
        'use shell_session_write to send input and shell_session_read to read new output. ' +
        'Sessions are in-memory, max 8 at once, closed after 10 minutes idle.',
      {
        cwd: {
          type: 'string',
          description: 'Working directory inside the workspace (default: workspace root).',
        },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const relCwd = args['cwd'] === undefined ? '.' : getStringArg(args, 'cwd', false);
        const cwd = resolveWithin(ctx.workspaceDir, relCwd);
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) return errorResult(`Not a directory: "${relCwd}"`);
        const session = await startSession(cwd, ctx.workspaceDir);
        return JSON.stringify(
          {
            sessionId: session.sessionId,
            cwd: path.relative(ctx.workspaceDir, cwd) || '.',
            note: 'Session is open. Write with shell_session_write, read with shell_session_read, close with shell_session_close.',
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const shellSessionWriteTool: Tool = {
    definition: toolDef(
      'shell_session_write',
      'Write text to the stdin of a running interactive shell session (e.g. a command followed by "\\n"). When the session is confined to a workspace, each line IS checked against the shell denylist and the egress policy — a blocked line is dropped with COMMAND_BLOCKED (or EGRESS_UNCONFIGURED/EGRESS_BLOCKED) and the session stays alive; other lines in the same write still go through. Approval happens at shell_session_start.',
      {
        sessionId: { type: 'string', description: 'Session id returned by shell_session_start.' },
        input: { type: 'string', description: 'Text to write to the shell stdin.' },
      },
      ['sessionId', 'input'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const input = getStringArg(args, 'input');
        const session = getLiveSession(sessionId);
        if (session.exited) {
          return errorResult(`Shell session "${sessionId}" has exited (code ${String(session.exitCode)}).`);
        }
        session.lastActivity = Date.now();
        if (session.daemonSessionId !== null) {
          const daemon = getDaemon?.() ?? null;
          if (!daemon) return errorResult('Shell daemon is unavailable; the session cannot be written to.');
          await daemon.writeSession(session.daemonSessionId, input);
        } else if (session.child) {
          // v0.74b: đường local nay kiểm tra từng dòng như daemon
          // (denylist + egress) thay vì ghi thẳng stdin.
          const checked = await writeLocalSessionInput(session, input);
          if (checked.blockedMessage !== undefined) {
            return errorResult(checked.blockedMessage);
          }
        } else {
          return errorResult(`Shell session "${sessionId}" has no writable stdin.`);
        }
        return JSON.stringify({ sessionId, writtenChars: input.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const shellSessionReadTool: Tool = {
    definition: toolDef(
      'shell_session_read',
      'Read NEW output from an interactive shell session since the last shell_session_read (stdout and stderr combined, in arrival order). Read-only.',
      {
        sessionId: { type: 'string', description: 'Session id returned by shell_session_start.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const session = getLiveSession(sessionId);
        session.lastActivity = Date.now();
        const output = session.buffer.text.slice(session.readOffset);
        session.readOffset = session.buffer.text.length;
        return truncate(
          JSON.stringify(
            {
              sessionId,
              exited: session.exited,
              exitCode: session.exitCode,
              truncated: session.buffer.truncated,
              output: output === '' ? '(no new output)' : output,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const shellSessionCloseTool: Tool = {
    definition: toolDef(
      'shell_session_close',
      'Close an interactive shell session (kills the shell process group). Idempotent.',
      {
        sessionId: { type: 'string', description: 'Session id returned by shell_session_start.' },
      },
      ['sessionId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const session = sessions.get(sessionId);
        if (!session) {
          return JSON.stringify({ sessionId, closed: false, note: 'Unknown session (already closed or timed out).' }, null, 2);
        }
        const closed = await closeSession(session, 'explicit close');
        sessions.delete(sessionId);
        return JSON.stringify({ sessionId, closed }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sandboxPrepareTool: Tool = {
    definition: toolDef(
      'sandbox_prepare',
      'Prepare an isolated workspace directory for an agent run, under .open-bot/sandboxes/<name> inside the workspace. ' +
        'Starts empty, or copies a template directory from inside the workspace. Writes env.allowlist.json (allowed env var names only — never values/secrets) and sandbox.json (resource limits metadata). Returns the paths and limits.',
      {
        name: { type: 'string', description: 'Sandbox name: letters, digits, ".", "-" and "_" only (e.g. "task-123").' },
        template: {
          type: 'string',
          description: 'Template directory inside the workspace to copy, or "empty" (default) for a fresh empty directory.',
        },
        env_vars: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra env var NAMES to allow in this sandbox (names only, never values; secret-looking names are rejected).',
        },
      },
      ['name'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const name = getStringArg(args, 'name');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
          return errorResult(
            `Invalid sandbox name "${name}": use letters, digits, ".", "-" and "_" only, starting with a letter or digit.`,
          );
        }
        const template = getOptionalStringArg(args, 'template') ?? 'empty';
        const extraEnv = getStringArrayArg(args, 'env_vars');
        const secretPattern = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;
        for (const varName of extraEnv) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
            return errorResult(`Invalid env var name "${varName}".`);
          }
          if (secretPattern.test(varName)) {
            return errorResult(`Env var name "${varName}" looks like a secret and is not allowed in a sandbox allowlist.`);
          }
        }

        const targetDir = resolveWithin(ctx.workspaceDir, path.join('.open-bot', 'sandboxes', name));
        if (fs.existsSync(targetDir)) {
          const entries = fs.readdirSync(targetDir);
          if (entries.length > 0) {
            return errorResult(
              `Sandbox "${name}" already exists and is not empty (${entries.length} entries). Pick another name.`,
            );
          }
        }
        fs.mkdirSync(targetDir, { recursive: true });

        if (template !== 'empty') {
          const templateDir = resolveWithin(ctx.workspaceDir, template);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(templateDir);
          } catch {
            return errorResult(`Template directory does not exist: "${template}"`);
          }
          if (!stat.isDirectory()) return errorResult(`Template is not a directory: "${template}"`);
          copyDir(templateDir, targetDir);
        }

        const allowedEnv = [...new Set([...Object.keys(safeEnv()), ...extraEnv])].sort();
        const envFile = path.join(targetDir, 'env.allowlist.json');
        fs.writeFileSync(
          envFile,
          JSON.stringify({ allowedEnvVars: allowedEnv, note: 'Names only — never put secret values in this file.' }, null, 2),
          'utf8',
        );
        const limits = {
          maxOutputChars: MAX_OUTPUT_CHARS,
          maxExecOutputChars: MAX_EXEC_OUTPUT_CHARS,
          defaultTimeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
          maxConcurrentExecs: 8,
          maxSessions,
        };
        const metaFile = path.join(targetDir, 'sandbox.json');
        fs.writeFileSync(
          metaFile,
          JSON.stringify(
            { name, template, createdAt: new Date().toISOString(), limits, envAllowlistFile: 'env.allowlist.json' },
            null,
            2,
          ),
          'utf8',
        );
        const rel = path.relative(ctx.workspaceDir, targetDir).replace(/\\/g, '/');
        return JSON.stringify(
          {
            name,
            path: rel,
            template,
            envAllowlistFile: `${rel}/env.allowlist.json`,
            metadataFile: `${rel}/sandbox.json`,
            limits,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- v0.86 (P2-10): shell_elevate — chạy MỘT lệnh với quyền cao hơn ---
  //
  // Đây là đường nâng quyền DUY NHẤT trong open-bot. `sudo` vẫn nằm
  // trong denylist nên shell_exec / exec_task / session KHÔNG BAO GIỜ
  // chạy được sudo — chỉ tool này mới gọi `sudo -n`, và chỉ sau khi:
  //   1. lệnh trong (`command`) qua denylist (rm -rf / vẫn chặn);
  //   2. `reason` không rỗng (hiện trên thẻ phê duyệt để user biết
  //      VÌ SAO cần quyền cao hơn);
  //   3. loop hỏi duyệt từng lần: tool có needsApproval: true, bị loại
  //      khỏi auto-approve ở mọi lớp (approval/rules.ts +
  //      loop.tryAutoApprove), và loop ép hỏi cả khi bot bật
  //      autoApprove. Không có "allow always" cho elevate.
  // Chạy qua `sudo -n` (non-interactive — cần password thì fail ngay
  // với ELEVATE_PASSWORD_REQUIRED, không treo hỏi); timeout kill cả
  // process group; không lưu password, không tự escalate, Windows thì
  // từ chối fail-closed. Lệnh elevate KHÔNG đi qua runShell (nó sẽ
  // chặn chữ `sudo` trong argv) mà spawn trực tiếp argv đã build.
  const shellElevateTool: Tool = {
    definition: toolDef(
      ELEVATED_TOOL_NAME,
      'Run ONE shell command with elevated privileges (sudo -n, non-interactive). ' +
        'Requires explicit user approval EVERY time — never auto-approved, no permanent grant. ' +
        'You must explain WHY in "reason" (shown on the approval card). ' +
        'The inner command still goes through the shell denylist (rm -rf /, nested sudo, ... stay blocked). ' +
        'Fails cleanly with ELEVATE_PASSWORD_REQUIRED when sudo needs a password (no password is ever asked for or stored). ' +
        'Not supported on Windows.',
      {
        command: { type: 'string', description: 'Shell command to run elevated (inner command, without sudo).' },
        reason: { type: 'string', description: 'Why this command needs elevated privileges (shown on the approval card, min 8 chars).' },
        timeout_ms: { type: 'number', description: 'Kill the command after this many ms (default 60000, max 600000).' },
      },
      ['command', 'reason'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const errors = validateElevateRequest({ command: args['command'], reason: args['reason'] });
        if (errors.length > 0) return errorResult(errors.join(' '));
        const command = (args['command'] as string).trim();
        const timeoutMs = getNumberArg(args, 'timeout_ms', DEFAULT_ELEVATE_TIMEOUT_MS, MAX_ELEVATE_TIMEOUT_MS);
        const argv = buildElevatedArgv(command);
        const runner = options.elevateRunner ?? defaultElevateRunner;
        const startedAt = Date.now();
        const result = await runner(argv, {
          timeoutMs,
          cwd: ctx.workspaceDir,
          env: { ...safeEnv() } as Record<string, string>,
        });
        const timedOut = result.timedOut || Date.now() - startedAt >= timeoutMs;
        return truncate(formatElevatedResult(result, command, timedOut));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    execTaskTool,
    execTaskStatusTool,
    execTaskStopTool,
    shellSessionStartTool,
    shellSessionWriteTool,
    shellSessionReadTool,
    shellSessionCloseTool,
    sandboxPrepareTool,
    shellElevateTool,
  ];
}

/** Copy a directory tree, skipping .git / node_modules / .open-bot. */
function copyDir(src: string, dest: string): void {
  const skip = new Set(['.git', 'node_modules', '.open-bot']);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
    // Symlinks and special files are NOT copied (fail-closed).
  }
}

/**
 * Unbound placeholder: same tool shapes, daemon-less (execs/sessions run
 * locally via runShell / spawn). Real usage with a daemon:
 *   const tools = createShellTools(() => daemonClient);
 */
export const SHELL_TOOLS: Tool[] = createShellTools();

export type { ToolContext };
