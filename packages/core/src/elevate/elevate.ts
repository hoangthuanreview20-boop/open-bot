/**
 * Privilege escalation ("elevate") — pure helpers (v0.86, P2-10).
 *
 * Design (fail-closed, approval-first — see `docs/elevate.md`):
 *  - There is NO silent sudo anywhere: `sudo` stays on the shell
 *    denylist (`agent/rules.ts`), so `shell_exec` / `exec_task` /
 *    shell sessions can never run it, with or without approval.
 *  - The ONLY elevated path is the `shell_elevate` tool, which:
 *      1. validates the INNER command against the same denylist
 *         (`rm -rf /` is still blocked, even elevated);
 *      2. requires a non-empty `reason` (shown on the approval card);
 *      3. has `needsApproval: true` AND is excluded from auto-approve
 *         entirely (see `approval/rules.ts` — no rule can match it,
 *         and creating such a rule is rejected);
 *      4. runs through `sudo -n` (non-interactive: fails at once
 *         when a password is needed instead of hanging on a prompt);
 *      5. never stores a password, never escalates by itself, and
 *         each call needs its own approval — there is no permanent
 *         grant, no "allow always" for elevate.
 *  - Windows has no `sudo -n`: elevate is unsupported there and the
 *    tool fails closed with a clear error (no `runas` prompt).
 *  - `pkexec` is NOT used: it can pop a graphical auth prompt and
 *    hang a headless run. If `sudo` is missing, the tool fails with
 *    a clear error instead of guessing another escalator.
 *
 * This module is pure (no spawn, no I/O): it only builds the argv
 * and classifies results. The actual spawn lives in
 * `packages/tools/src/shellTools.ts` (`shell_elevate` tool), which is
 * also where tests inject a fake runner.
 */

import { matchBlockedCommandPattern } from '../agent/rules';

/** Tool name of the only elevated-execution tool. */
export const ELEVATED_TOOL_NAME = 'shell_elevate';

/** Default timeout for an elevated command (60s, like `shell_exec`). */
export const DEFAULT_ELEVATE_TIMEOUT_MS = 60_000;
/** Max timeout an elevated command may request (10 minutes). */
export const MAX_ELEVATE_TIMEOUT_MS = 600_000;
/** `reason` must be at least this long — a real reason, not "x". */
export const MIN_ELEVATE_REASON_CHARS = 8;

/** Error code when sudo needs a password (non-interactive run). */
export const ELEVATE_PASSWORD_REQUIRED = 'ELEVATE_PASSWORD_REQUIRED';
/** Error code when elevate is refused before running anything. */
export const ELEVATE_DENIED = 'ELEVATE_DENIED';
/** Error code when the platform cannot elevate. */
export const ELEVATE_UNSUPPORTED = 'ELEVATE_UNSUPPORTED';

/**
 * Build the argv that runs `command` elevated, for the given
 * platform. POSIX: `sudo -n /bin/sh -c <command>` — argv array, no
 * shell interpolation, so the command is passed verbatim to one
 * shell. Windows: throws (unsupported, fail-closed).
 */
export function buildElevatedArgv(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    throw new Error(
      `${ELEVATE_UNSUPPORTED}: elevate (chạy lệnh với quyền cao hơn) không hỗ trợ trên Windows — không có sudo -n, và open-bot không dùng runas (hỏi password tương tác).`,
    );
  }
  return ['sudo', '-n', '/bin/sh', '-c', command];
}

/** Is this platform able to elevate at all (POSIX only)? */
export function isElevateSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/**
 * Does this sudo failure mean "a password is required"? `sudo -n`
 * exits non-zero and prints `sudo: a password is required` (or the
 * locale variant) to stderr. Matching is deliberately loose
 * (substring, case-insensitive) so a translated sudo still maps to
 * the clean `ELEVATE_PASSWORD_REQUIRED` error instead of a raw dump.
 */
export function isPasswordRequiredError(stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  if (typeof stderr !== 'string' || stderr === '') return false;
  return /a password is required|sudo: .*password/i.test(stderr);
}

/**
 * Validate an elevate request BEFORE any approval card is shown and
 * before anything runs. Returns error strings (empty = valid).
 * Checks, in order:
 *  1. command is a non-empty string;
 *  2. reason is a non-empty string (≥ MIN_ELEVATE_REASON_CHARS);
 *  3. the platform supports elevate;
 *  4. the INNER command passes the shell denylist — an elevated
 *     `rm -rf /` is still blocked (denylist wins over approval).
 *
 * Note the denylist check runs on the inner command, NOT on the
 * wrapped `sudo -n …` argv: the wrapper itself contains the word
 * `sudo`, which the denylist rightly blocks everywhere else.
 */
export function validateElevateRequest(
  input: { command?: unknown; reason?: unknown },
  platform: NodeJS.Platform = process.platform,
): string[] {
  const errors: string[] = [];
  if (typeof input.command !== 'string' || input.command.trim() === '') {
    errors.push('Elevate cần "command" là chuỗi không rỗng.');
    return errors;
  }
  const command = input.command.trim();
  if (typeof input.reason !== 'string' || input.reason.trim().length < MIN_ELEVATE_REASON_CHARS) {
    errors.push(
      `Elevate cần "reason" giải thích vì sao cần quyền cao hơn (ít nhất ${MIN_ELEVATE_REASON_CHARS} ký tự) — lý do này hiện trên thẻ phê duyệt.`,
    );
  }
  if (!isElevateSupported(platform)) {
    errors.push(
      `${ELEVATE_UNSUPPORTED}: elevate không hỗ trợ trên nền tảng này (${platform}).`,
    );
  }
  const blocked = matchBlockedCommandPattern(command);
  if (blocked !== undefined) {
    errors.push(
      `Lệnh "${command}" bị chặn bởi sandbox denylist (${blocked}) — lệnh elevate vẫn chịu denylist như lệnh thường, kể cả khi đã duyệt.`,
    );
  }
  // Nested escalation inside the inner command is never allowed:
  // `sudo` / `su` / `passwd` inside an already-elevated command
  // would be a second, invisible privilege step.
  if (/\bsudo\b/.test(command) || /\bsu\s+(-\s*)?\S/.test(command) || /\bpasswd\b/.test(command)) {
    errors.push('Lệnh elevate không được chứa sudo / su / passwd lồng bên trong.');
  }
  return errors;
}

/** Result of one elevated run (spawned by the tools package). */
export interface ElevatedRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Turn an elevated run result into the tool's reply text. A
 * password-required failure becomes the clean
 * `ELEVATE_PASSWORD_REQUIRED` error (never a hang, never a retry);
 * anything else is reported with exit code + capped output.
 */
export function formatElevatedResult(
  result: ElevatedRunResult,
  command: string,
  timedOut: boolean,
): string {
  if (timedOut) {
    return JSON.stringify(
      {
        ok: false,
        code: 'ELEVATE_TIMEOUT',
        command,
        message: `Lệnh elevate quá thời gian (timeout) và đã bị dừng — không để sudo treo hỏi password.`,
      },
      null,
      2,
    );
  }
  if (isPasswordRequiredError(result.stderr, result.exitCode)) {
    return JSON.stringify(
      {
        ok: false,
        code: ELEVATE_PASSWORD_REQUIRED,
        command,
        message:
          'sudo cần password (chạy non-interactive với sudo -n nên fail ngay thay vì hỏi). ' +
          'Cấu hình sudoers cho lệnh này (NOPASSWD) hoặc chạy lệnh bằng tay ngoài open-bot — open-bot không bao giờ hỏi hay lưu password.',
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      ok: result.exitCode === 0,
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    null,
    2,
  );
}
