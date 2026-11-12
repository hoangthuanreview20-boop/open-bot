/**
 * Sandbox helpers for @open-bot/tools.
 *
 * Every file / shell operation in this package MUST go through these
 * helpers so nothing can escape the agent's workspace directory:
 *  - resolveWithin() confines paths (including symlink escapes) to the workspace.
 *  - runShell() confines the working directory, blocks denylisted commands,
 *    strips secret-bearing env vars, and caps output / runtime.
 *
 * v0.11c: denylist lệnh sống ở rule engine dùng chung trong
 * `@open-bot/core` (`packages/core/src/agent/rules.ts`) — xem
 * `DENYLIST_COMMANDS` bên dưới. Whitelist lệnh an toàn / lệnh nhạy cảm
 * dùng để auto-approve cũng ở đó (`classifyCommand`).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookDefinition } from '@open-bot/core';
// v0.11c (P1-7): denylist + phân loại lệnh sống ở rule engine dùng chung
// trong @open-bot/core (`packages/core/src/agent/rules.ts`) — sandbox chỉ
// dùng lại, không định nghĩa riêng nữa. Import theo đường dẫn sâu như
// `agentDataTools.ts` đã làm với `@open-bot/core/dist/agent/export`
// (index.ts của core nằm ngoài phạm vi v0.11c nên chưa re-export ở đó).
import {
  BLOCKED_COMMAND_PATTERNS,
  matchBlockedCommandPattern,
} from '@open-bot/core/dist/agent/rules';
// P0-2: egress policy chung của core — runShell kiểm tra đích mạng
// trong lệnh (curl/wget/git clone/ssh/URL) TRƯỚC khi spawn.
import {
  checkEgress,
  EgressError,
  extractNetworkTargets,
  type EgressContext,
  type EgressPolicy,
} from '@open-bot/core/dist/egress/policy';
import { killProcessGroup } from './killProcessGroup';
import { truncateTextWithRemainder as truncate } from './truncate';

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
 *
 * v0.11c: danh sách này là bí danh của `BLOCKED_COMMAND_PATTERNS` trong
 * rule engine dùng chung (`@open-bot/core/dist/agent/rules`) — cùng một
 * nơi định nghĩa với whitelist/sensitive mà `AgentPermissions` dùng để
 * quyết định auto-approve theo lệnh. Đừng sửa list ở đây, sửa ở rules.ts.
 */
export const DENYLIST_COMMANDS: RegExp[] = BLOCKED_COMMAND_PATTERNS;

/** Throw if `command` matches any denylisted pattern. */
export function assertCommandAllowed(command: string): void {
  const pattern = matchBlockedCommandPattern(command);
  if (pattern !== undefined) {
    throw new Error(
      `Command blocked by sandbox denylist (${pattern}): "${truncate(command, 200)}"`,
    );
  }
}

/**
 * The sandbox denylist as a default PreToolUse hook (v0.10, P0-2).
 *
 * Same check as `assertCommandAllowed()` — the denylist is still the
 * single source of truth, this hook just runs it BEFORE the tool
 * executes instead of inside it — but expressed as a hook so the agent
 * loop can block a dangerous call deterministically, with a reason the
 * model can see, instead of waiting for a human approval click or
 * letting the tool fail mid-execution.
 *
 * Behaviour is intentionally identical to the old in-tool check:
 * - Only tool calls carrying a string `command` arg are inspected
 *   (covers `shell_exec`, `exec_task`, shell sessions, …). Any other
 *   tool call is allowed through untouched.
 * - A denylisted command returns `{ action: 'block', reason }` where
 *   `reason` is the exact `assertCommandAllowed` error message, so a
 *   test asserting on the old message still matches.
 * - The in-tool `assertCommandAllowed()` call in `runShell()` /
 *   `shell_exec` is KEPT as defence-in-depth: a tool executed without
 *   going through the hook runner is still blocked, just later.
 *
 * Register it into a `HookRegistry` from `@open-bot/core`:
 *   registry.register(createDenylistHook());
 * The coordinator wires `HookRunner.runPreToolUse` into
 * `AgentRunner.executeCall` in a later step; this factory only builds
 * the hook definition.
 */
export const DENYLIST_HOOK_NAME = 'sandbox-denylist';

export function createDenylistHook(): HookDefinition {
  return {
    name: DENYLIST_HOOK_NAME,
    description:
      'Default safety hook: blocks denylisted shell commands (rm -rf /, sudo, curl | sh, …) before the tool runs.',
    events: ['PreToolUse'],
    source: 'builtin',
    enabled: true,
    handler: (event) => {
      if (event.event !== 'PreToolUse') return { action: 'allow' };
      const command = event.args['command'];
      if (typeof command !== 'string') return { action: 'allow' };
      try {
        assertCommandAllowed(command);
        return { action: 'allow' };
      } catch (err) {
        return {
          action: 'block',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export interface RunShellOptions {
  timeoutMs?: number;
  /** If given, `cwd` must resolve inside this directory. */
  workspaceDir?: string;
  signal?: AbortSignal;
  /**
   * P0-2: egress policy áp cho lệnh này. Khi lệnh chứa đích mạng
   * (curl/wget/git clone/ssh/URL) thì mỗi đích phải qua `checkEgress`
   * TRƯỚC khi spawn — bị chặn thì reject với EgressError rõ ràng
   * (không treo/timeout khó hiểu).
   *
   * Fail-closed: không truyền policy ở đây VÀ chưa cấu hình policy
   * module (xem `configureSandboxEgress`) thì lệnh có đích mạng bị
   * chặn với `egress_unconfigured`. Lệnh không có đích mạng (echo,
   * ls, git checkout...) không bị ảnh hưởng. Loopback cho provider
   * local (Ollama 127.0.0.1) đi qua context `local-service` — dùng
   * `egressContext: 'local-service'` khi chạy lệnh thay mặt provider
   * local, không dùng cho lệnh của agent.
   */
  egressPolicy?: EgressPolicy | null;
  /**
   * v0.55: hàm resolve policy egress lúc chạy — thay cho policy module
   * khi có. Host (coordinator) truyền resolver này để shell tự lấy
   * policy egress hiệu lực của team hiện tại (team merge lên trên
   * policy chung, đọc live mỗi lần chạy nên sửa team.json có hiệu lực
   * ngay, không cần tạo lại bot). Resolver thắng policy module:
   * trả về `undefined` nghĩa là "không có policy" → fail-closed
   * `egress_unconfigured`, KHÔNG rơi tiếp về policy module (tránh
   * policy module cũ, nới hơn, lấn át quyết định của team). Trả về
   * `null` = tắt hẳn như `egressPolicy: null` (chỉ cho test/caller cũ).
   */
  getEgressPolicy?: () => EgressPolicy | null | undefined;
  /** Ngữ cảnh egress (mặc định 'agent'). */
  egressContext?: EgressContext;
  /** Hàm resolve DNS cho egress check (test inject fake). */
  egressLookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
}

/**
 * P0-2: policy egress mặc định của module (cho đường chạy in-process
 * không truyền policy từng lần — host như coordinator/desktop đặt một
 * lần lúc khởi động, từ policy chung hoặc `resolveTeamEgressPolicy`).
 * `undefined` = chưa cấu hình → runShell fail-closed với
 * `egress_unconfigured` khi lệnh có đích mạng. `null` = tắt hẳn
 * (chỉ dùng cho test/caller cũ đã tự kiểm soát — không khuyến khích).
 */
let sandboxEgressPolicy: EgressPolicy | null | undefined;

export function configureSandboxEgress(policy: EgressPolicy | null | undefined): void {
  sandboxEgressPolicy = policy;
}

export function getSandboxEgressPolicy(): EgressPolicy | null | undefined {
  return sandboxEgressPolicy;
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

export function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!SAFE_ENV_ALLOWLIST.has(key)) continue;
    if (SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
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

  // P0-2: spawn được tách ra để egress check (async) chạy trước —
  // lệnh có đích mạng mà chưa qua policy thì không bao giờ spawn.
  const spawnShell = (): Promise<RunShellResult> =>
    new Promise<RunShellResult>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // Kill the whole process GROUP, not just the shell: a shell's
    // grandchildren (e.g. `sh -c 'sleep 30'` -> sleep) inherit the
    // shell's stdio pipes, and Node's 'close' only fires once those
    // pipes are closed. Killing only the shell would leave the promise
    // hanging until the grandchild exits. The child is spawned detached
    // (own process group) on non-Windows for exactly this reason.
    // NOTE: `signal` is NOT passed to spawn — Node would kill only the
    // direct child on abort (same stall); the abort listener below kills
    // the group instead.
    const killGroup = (): void => {
      // v0.15: kill cả process group qua helper dùng chung (POSIX: kill
      // group; Windows: taskkill /T). Fallback kill trực tiếp khi helper
      // trả false (tiến trình đã chết / không phải group leader).
      if (child.pid === undefined || !killProcessGroup(child.pid)) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead; the 'close' handler below will settle.
        }
      }
    };

    const child = spawn(shell, shellArgs, {
      cwd: resolvedCwd,
      env: safeEnv(),
      windowsHide: true,
      detached: !isWindows,
    });

    const onAbort = (): void => {
      killGroup();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        return Promise.reject(new Error('Shell command aborted before it started.'));
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
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
      opts.signal?.removeEventListener('abort', onAbort);
      rejectPromise(err);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
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

  // P0-2: egress — trích đích mạng trong lệnh và kiểm tra từng đích
  // TRƯỚC khi spawn. Lệnh không có đích mạng chạy như cũ (không tốn
  // DNS, không đổi hành vi). Lệnh có đích mạng:
  //  - policy tường minh (opts.egressPolicy > getEgressPolicy() >
  //    module) → checkEgress từng đích; bị chặn thì reject với
  //    EgressError rõ ràng, không spawn. Resolver (v0.55) thắng policy
  //    module: nó trả `undefined` thì fail-closed luôn, không rơi tiếp
  //    về policy module — team đã quyết "không có policy" thì policy
  //    module cũ không được lấn át.
  //  - không có policy nào → fail-closed `egress_unconfigured`.
  //  - policy `null` → host đã tắt kiểm tra hẳn (chỉ cho test/caller
  //    cũ tự kiểm soát; không khuyến khích).
  const targets = extractNetworkTargets(command);
  if (targets.length === 0) return spawnShell();
  const egressPolicy =
    opts.egressPolicy !== undefined
      ? opts.egressPolicy
      : opts.getEgressPolicy !== undefined
        ? opts.getEgressPolicy()
        : sandboxEgressPolicy;
  if (egressPolicy === undefined) {
    return Promise.reject(
      new EgressError(
        'unconfigured',
        'Egress chưa cấu hình (egress_unconfigured): lệnh chứa đích mạng nhưng chưa có policy egress rõ ràng nên chặn, ' +
          'không chạy lệnh. Cấu hình allowlist host/IP (configureSandboxEgress / opts.egressPolicy) rồi thử lại.',
      ),
    );
  }
  if (egressPolicy === null) return spawnShell();
  return (async (): Promise<RunShellResult> => {
    for (const target of targets) {
      await checkEgress(target, egressPolicy, {
        context: opts.egressContext ?? 'agent',
        lookupFn: opts.egressLookupFn,
      });
    }
    return spawnShell();
  })();
}
