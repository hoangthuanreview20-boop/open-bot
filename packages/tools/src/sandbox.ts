/**
 * Sandbox helpers for @open-bot/tools.
 *
 * Every file / shell operation in this package MUST go through these
 * helpers so nothing can escape the agent's workspace directory:
 *  - resolveWithin() confines paths (including symlink escapes) to the workspace.
 *  - runShell() confines the working directory, blocks denylisted commands,
 *    strips secret-bearing env vars, and caps output / runtime.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_OUTPUT_CHARS = 200_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

/** Resolve `targetPath` (absolute or relative to `workspaceDir`) and throw
 *  if the result escapes `workspaceDir` — including via symlinks. */
export function resolveWithin(workspaceDir: string, targetPath: string): string {
  const workspaceReal = fs.realpathSync(path.resolve(workspaceDir));
  const joined = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspaceDir, targetPath);

  // Resolve symlinks for the longest existing ancestor, then re-append
  // the non-existing tail, so `link -> /etc` inside the workspace is caught
  // even when the final file does not exist yet.
  let existing = joined;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached filesystem root
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const realExisting = fs.existsSync(existing)
    ? fs.realpathSync(existing)
    : existing;
  const resolved = tail.length > 0 ? path.join(realExisting, ...tail) : realExisting;

  if (resolved !== workspaceReal && !resolved.startsWith(workspaceReal + path.sep)) {
    throw new Error(
      `Path escapes workspace: "${targetPath}" resolves to "${resolved}", ` +
        `outside "${workspaceReal}".`,
    );
  }
  return resolved;
}

/**
 * Commands that are never allowed, even inside the workspace. Each entry is
 * matched against the whole command string. Keep this list conservative:
 * it is a safety net, not a replacement for approval (destructive tools
 * still have needsApproval: true).
 */
export const DENYLIST_COMMANDS: RegExp[] = [
  // rm -rf / , rm -rf ~ , rm -rf $HOME (any flag order / long flags)
  /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\/|~|\$HOME|%USERPROFILE%)(?:\s|$|[;&|])/,
  /\brm\s+[^;&|]*\s--no-preserve-root\b/,
  // Filesystem destruction / raw disk access
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^;&|]*\bif=/,
  // Power / system state
  /\b(shutdown|reboot|halt|poweroff)\b/,
  // Permission carpet-bombing outside the workspace
  /\bchmod\s+(?:-R\s+)?777\s+\//,
  /\bchown\s+(?:-R\s+)?\S+\s+\//,
  // Piping a download (or anything) straight into a shell
  /\|\s*(sh|bash|zsh|fish|powershell|pwsh|cmd)\b/,
  // Privilege escalation / credential changes
  /\bsudo\b/,
  /\bsu\s+(-\s*)?\S/,
  /\bpasswd\b/,
  /\buseradd\b|\buserdel\b|\busermod\b/,
  // Fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
];

/** Throw if `command` matches any denylisted pattern. */
export function assertCommandAllowed(command: string): void {
  for (const pattern of DENYLIST_COMMANDS) {
    if (pattern.test(command)) {
      throw new Error(
        `Command blocked by sandbox denylist (${pattern}): "${truncate(command, 200)}"`,
      );
    }
  }
}

export interface RunShellOptions {
  timeoutMs?: number;
  /** If given, `cwd` must resolve inside this directory. */
  workspaceDir?: string;
  signal?: AbortSignal;
}

export interface RunShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Env vars that are safe to pass to a child process. Anything whose name
 *  looks like a secret is dropped even if it appears in this list. */
const SAFE_ENV_ALLOWLIST = new Set([
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

const SECRET_ENV_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!SAFE_ENV_ALLOWLIST.has(key)) continue;
    if (SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated, ${text.length - maxChars} more chars ...]`;
}

/**
 * Run `command` in `cwd` via the platform shell (`/bin/sh -c` on
 * Linux/macOS, `powershell -NoProfile -Command` on Windows).
 * `cwd` must exist, be a directory, and — when `opts.workspaceDir` is
 * given — lie inside it. Kills the process after `timeoutMs`
 * (default 60s); returns `code: null` on timeout.
 */
export function runShell(
  command: string,
  cwd: string,
  opts: RunShellOptions = {},
): Promise<RunShellResult> {
  assertCommandAllowed(command);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const resolvedCwd = path.resolve(cwd);
  if (opts.workspaceDir !== undefined) {
    // Throws if cwd escapes the workspace (incl. via symlinks).
    resolveWithin(opts.workspaceDir, resolvedCwd);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedCwd);
  } catch {
    return Promise.reject(new Error(`Shell cwd does not exist: "${resolvedCwd}"`));
  }
  if (!stat.isDirectory()) {
    return Promise.reject(new Error(`Shell cwd is not a directory: "${resolvedCwd}"`));
  }

  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell' : '/bin/sh';
  const shellArgs = isWindows
    ? ['-NoProfile', '-Command', command]
    : ['-c', command];

  return new Promise<RunShellResult>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(shell, shellArgs, {
      cwd: resolvedCwd,
      env: safeEnv(),
      signal: opts.signal,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead; the 'close' handler below will settle.
      }
    }, timeoutMs);
    // No unref(): the timer is always cleared in the 'close'/'error'
    // handlers below, so it never outlives the child process.

    const append = (chunk: Buffer | string, which: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += text;
      } else if (stderr.length < MAX_OUTPUT_CHARS) {
        stderr += text;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        stderr += `\n[runShell: killed after ${timeoutMs}ms timeout]`;
      }
      resolvePromise({
        stdout: truncate(stdout, MAX_OUTPUT_CHARS),
        stderr: truncate(stderr, MAX_OUTPUT_CHARS),
        code: timedOut ? null : code,
      });
    });
  });
}
