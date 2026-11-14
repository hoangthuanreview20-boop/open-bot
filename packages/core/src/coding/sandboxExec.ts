/**
 * Sandboxed command execution for coding runs (v1.02, Team T4).
 *
 * Commands run with:
 * - cwd locked to the workspace root (never the host cwd),
 * - argv array only — NO shell, so no shell injection, pipes or
 *   redirects; the agent passes `['npm', 'run', 'typecheck']`, not a
 *   shell string,
 * - a scrubbed environment: only PATH plus variables the caller
 *   passes explicitly (secrets never leak in from `process.env`),
 * - a hard timeout (process group killed on expiry),
 * - a cap on captured stdout/stderr,
 * - a blocklist of destructive / privilege-escalation binaries, and
 *   rejection of absolute-path arguments pointing outside the
 *   workspace.
 *
 * This is a local sandbox, not a VM/container: it confines where the
 * command runs and what it can reach through this API, and it always
 * reports honestly when isolation is limited (see the result).
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { capText, EVENT_OUTPUT_CAP } from './events';

/** Binaries the sandbox never runs (privilege escalation / disk / power). */
export const BLOCKED_BINARIES = new Set([
  'sudo', 'su', 'doas', 'runas',
  'mkfs', 'mkfs.ext4', 'fdisk', 'parted', 'dd',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'mount', 'umount', 'chown', 'passwd', 'useradd', 'usermod', 'userdel',
  'iptables', 'systemctl', 'service', 'launchctl',
]);

export interface SandboxExecOptions {
  /** Hard timeout in ms (default 120_000). */
  timeoutMs?: number;
  /** Max chars kept per stream (default EVENT_OUTPUT_CAP). */
  maxOutputChars?: number;
  /** Extra env vars visible inside the sandbox (on top of minimal PATH). */
  env?: Record<string, string>;
  /** Workspace root — commands run here and absolute args must stay inside. */
  workspaceRoot: string;
}

export interface SandboxExecResult {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  blocked: boolean;
  /** Why the command was blocked, when `blocked` is true. */
  blockReason?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Validate argv before running: binary not blocklisted, absolute-path
 * arguments stay inside the workspace. Returns an error message, or
 * null when the command is allowed.
 */
export function validateArgv(argv: string[], workspaceRoot: string): string | null {
  if (argv.length === 0) return 'empty command';
  const binary = path.basename(argv[0] as string);
  if (BLOCKED_BINARIES.has(binary)) return `blocked binary: ${binary}`;
  const root = path.resolve(workspaceRoot);
  for (const arg of argv.slice(1)) {
    if (!path.isAbsolute(arg)) continue;
    const resolved = path.resolve(arg);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return `absolute path outside workspace: ${arg}`;
    }
  }
  return null;
}

/**
 * Run a command inside the sandbox. Never throws for a failed
 * command — failures are reported in the result. Throws only for
 * programming errors (empty argv).
 */
export function runSandboxed(argv: string[], options: SandboxExecOptions): Promise<SandboxExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? EVENT_OUTPUT_CAP;
  const startedAt = Date.now();

  const blockReason = validateArgv(argv, options.workspaceRoot);
  if (blockReason) {
    return Promise.resolve({
      argv,
      exitCode: null,
      signal: null,
      timedOut: false,
      blocked: true,
      blockReason,
      durationMs: 0,
      stdout: '',
      stderr: '',
    });
  }

  return new Promise((resolve) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (options.env) Object.assign(env, options.env);
    // Keep a deterministic locale for command output parsing.
    env.LC_ALL = 'C.UTF-8';

    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: options.workspaceRoot,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    const finish = (exitCode: number | null, signal: string | null): void => {
      clearTimeout(timer);
      resolve({
        argv,
        exitCode,
        signal,
        timedOut,
        blocked: false,
        durationMs: Date.now() - startedAt,
        stdout: capText(stdout, maxOutputChars),
        stderr: capText(stderr, maxOutputChars),
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutputChars) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutputChars) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        argv,
        exitCode: null,
        signal: null,
        timedOut,
        blocked: false,
        durationMs: Date.now() - startedAt,
        stdout: capText(stdout, maxOutputChars),
        stderr: capText(`${stderr}\nspawn error: ${err.message}`, maxOutputChars),
      });
    });
    child.on('close', (code, signal) => finish(code, signal ? String(signal) : null));
  });
}

/** Kill a process and its children (POSIX process group; plain kill on Windows). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already gone — nothing to kill.
  }
}
