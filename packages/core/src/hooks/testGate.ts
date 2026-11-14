/**
 * SubagentStop test gate (v1.01, T2).
 *
 * The quality gate for finished subagents: when a subagent stops, run
 * the project's test suite (or any check command — typecheck, lint,
 * …) and, while it fails, BLOCK the stop and hand the failure back as
 * `additionalContext` so the subagent goes back and fixes its work
 * instead of the run accepting broken output.
 *
 * Wiring (see `agent/loop.ts` `runSubagent`): the loop fires
 * `SubagentStop` after the child settles; a `block` decision there
 * re-runs the child once with the gate's `additionalContext` appended
 * to its task. The gate itself is just a hook — `createTestGateHook`
 * returns a `HookDefinition` for `SubagentStop` that any `HookRegistry`
 * can hold, and the coordinator registers one built-in preset
 * (`subagent-test-gate`) that is only effective when a test command is
 * configured.
 *
 * Design decisions:
 * - The gate only checks subagents that claim to be `done`. A subagent
 *   that timed out or errored already reports itself; running the
 *   suite on its half-finished work would only add noise.
 * - A missing/empty test command NEVER blocks: the hook allows with a
 *   reason saying the gate is unconfigured. A gate that blocks
 *   everything because nobody configured it would wedge every
 *   subagent; the misconfiguration must be fixed in Settings, not by
 *   failing work.
 * - `passed` is exactly "exit code 0". A timeout is a failure (the
 *   suite did not prove the work good), but it is reported as a
 *   timeout, not as a test failure, so the subagent knows the suite
 *   itself never finished.
 * - The `additionalContext` sent back is a trimmed failure digest, not
 *   the raw suite output: failure-looking lines first (lines matching
 *   `FAIL` / `✕` / `Error` / `not ok` / …), else the last lines, capped
 *   at `maxOutputChars`. The model gets what failed and where, not
 *   10.000 lines of passing dots.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookDefinition, HookFn, SubagentStopEvent } from './types';
import { blockStopDecision, allowDecision } from './types';
import { runShellCommand } from './shellCommandRunner';

/** Registry name of the built-in test-gate preset hook. */
export const TEST_GATE_HOOK_NAME = 'subagent-test-gate';

/** File holding the test-gate config (`{ command | commands[], timeoutMs? }`, under the hooks state dir). */
export const TEST_GATE_CONFIG_FILE = 'hooks-test-gate.json';

/** Max check commands in one gate config (keeps a typo from spawning a suite marathon). */
export const MAX_TEST_GATE_COMMANDS = 10;

/** Config for the test-gate preset hook (from `hooks-test-gate.json`). */
export interface TestGateConfig {
  /** Test command, e.g. `npm test`. Empty/absent = gate unconfigured (never blocks). */
  command?: string;
  /**
   * Ordered check commands, e.g. [`npm run typecheck`, `npm test`].
   * When present and non-empty it wins over `command`. Runs run
   * sequentially and stop at the first failure, so the subagent gets
   * exactly one digest to fix at a time.
   */
  commands?: string[];
  /** Per-run timeout in ms (applies to EACH command, not the whole chain). */
  timeoutMs?: number;
}

/**
 * Normalise an untrusted test-gate config object (parsed JSON, IPC
 * payload, …) into a `TestGateConfig`, or null when it carries no usable
 * command. Pure — never throws. Used by `readTestGateConfig` and by the
 * desktop main process when saving from Settings, so both paths accept
 * exactly the same shapes.
 */
export function normalizeTestGateConfig(raw: unknown): TestGateConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const config: TestGateConfig = {};
  if (Array.isArray(obj['commands'])) {
    const list = obj['commands']
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .slice(0, MAX_TEST_GATE_COMMANDS);
    if (list.length > 0) config.commands = list;
  }
  if (typeof obj['command'] === 'string' && obj['command'].trim() !== '') {
    config.command = obj['command'].trim();
  }
  if (typeof obj['timeoutMs'] === 'number' && Number.isFinite(obj['timeoutMs'])) {
    const t = Math.floor(obj['timeoutMs']);
    if (t >= 100 && t <= 300_000) config.timeoutMs = t;
  }
  if (!config.commands && !config.command) return null;
  return config;
}

/**
 * The ordered check commands a gate config runs: `commands` when set,
 * else `[command]`, else `[]`. Pure.
 */
export function testGateCommands(config: TestGateConfig | null | undefined): string[] {
  if (!config) return [];
  if (config.commands && config.commands.length > 0) return [...config.commands];
  if (config.command && config.command.trim() !== '') return [config.command.trim()];
  return [];
}

/**
 * Read the test-gate config file from a hooks state dir. Returns null
 * when the file is absent or unparseable (never throws — an absent or
 * broken config simply means "gate unconfigured", and the coordinator
 * logs the parse problem itself when it wants to).
 */
export function readTestGateConfig(stateDir: string): TestGateConfig | null {
  try {
    const raw = fs.readFileSync(path.join(stateDir, TEST_GATE_CONFIG_FILE), 'utf8');
    return normalizeTestGateConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Default test command when none is configured (project root). */
export const DEFAULT_TEST_GATE_COMMAND = 'npm test';
/** Default per-run timeout for the test command. */
export const DEFAULT_TEST_GATE_TIMEOUT_MS = 300_000;
/** Default cap for the failure digest handed back to the subagent. */
export const DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS = 4000;
/** How many failure-looking lines the digest keeps at most. */
export const TEST_GATE_MAX_FAILURE_LINES = 40;
/** How many tail lines the digest keeps when no failure line matches. */
export const TEST_GATE_TAIL_LINES = 30;

/** Result of one test-command run. */
export interface TestGateResult {
  /** The command that ran (the failing one, or the last one when all passed). */
  command: string;
  /** True when the command exited 0. */
  passed: boolean;
  /** Process exit code (null when killed by a signal). */
  exitCode: number | null;
  /** Signal that killed the process, when any. */
  signal: NodeJS.Signals | null;
  /** True when the timeout killed the command. */
  timedOut: boolean;
  /** Wall-clock runtime in ms. */
  durationMs: number;
  /** Full captured stdout + stderr (capped, see `maxOutputChars`). */
  output: string;
  /** Trimmed failure digest for the model ('' when passed). */
  failedSummary: string;
  /**
   * Per-command results when the gate ran a chain (`commands`): one
   * entry per command that actually ran (stops at the first failure).
   * Absent for the single-command path.
   */
  results?: TestGateCommandResult[];
}

/** Per-command result inside a multi-command gate run. */
export interface TestGateCommandResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  failedSummary: string;
}

export interface TestGateOptions {
  /** Test command, e.g. `npm test` or `npm run typecheck`. Required to gate. */
  command?: string;
  /**
   * Ordered check commands. When non-empty it wins over `command`:
   * run sequentially, stop at the first failure.
   */
  commands?: string[];
  /** Working directory (the bot workspace). Defaults to the parent's cwd. */
  cwd?: string;
  /** Per-run timeout in ms. Default `DEFAULT_TEST_GATE_TIMEOUT_MS` (5 min). */
  timeoutMs?: number;
  /** Max chars of raw output kept. Default `DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS` * 4. */
  maxOutputChars?: number;
  /** Max chars of the failure digest. Default `DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS`. */
  maxDigestChars?: number;
}

/** Lines that look like a test failure (used to build the digest). */
const FAILURE_LINE_PATTERN =
  /\b(fail|failed|failure|error|not ok|✕|✖|×)\b/i;

/**
 * Build the failure digest from raw test output: failure-looking lines
 * first (up to `TEST_GATE_MAX_FAILURE_LINES`), else the last
 * `TEST_GATE_TAIL_LINES` lines. Capped at `maxChars`. Pure — no spawn.
 */
export function buildFailedSummary(
  output: string,
  maxChars: number = DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS,
): string {
  const lines = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return '';
  const failures = lines.filter((l) => FAILURE_LINE_PATTERN.test(l));
  const picked =
    failures.length > 0
      ? failures.slice(-TEST_GATE_MAX_FAILURE_LINES)
      : lines.slice(-TEST_GATE_TAIL_LINES);
  const digest = picked.join('\n');
  if (digest.length <= maxChars) return digest;
  return digest.slice(-maxChars);
}

/**
 * Format the `additionalContext` handed back to a subagent whose stop
 * was blocked by the gate: what ran, how it failed, the digest, and the
 * instruction to fix and re-run. Pure — no spawn.
 */
export function buildTestGateAdditionalContext(
  result: TestGateResult,
  subagentName?: string,
): string {
  const who = subagentName ? `subagent "${subagentName}"` : 'subagent';
  const chain =
    result.results && result.results.length > 1
      ? ` (chuỗi ${result.results.length} lệnh: ${result.results
          .map((r) => `${r.command} → ${r.passed ? 'PASS' : 'FAIL'}`)
          .join('; ')})`
      : '';
  const headline = result.timedOut
    ? `Kiểm tra sau khi ${who} kết thúc đã TIMEOUT sau ${result.durationMs}ms (lệnh: ${result.command})${chain} — bộ test chưa chạy xong, chưa chứng minh được công việc đúng.`
    : `Kiểm tra sau khi ${who} kết thúc đã FAIL (lệnh: ${result.command}, exit code ${String(result.exitCode)}, ${result.durationMs}ms)${chain} — công việc chưa được chấp nhận.`;
  const lines = [
    headline,
    '',
    'Kết quả kiểm tra:',
    result.failedSummary || '(không có output lỗi — xem lại lệnh kiểm tra)',
    '',
    'Hãy sửa các lỗi trên, rồi chạy lại đúng lệnh kiểm tra này để xác nhận trước khi kết thúc. ' +
      'Không kết thúc khi test còn fail; nếu lệnh kiểm tra bản thân nó sai (không phải code của bạn), hãy nói rõ.',
  ];
  return lines.join('\n');
}

/**
 * Run one test command through the shell and capture the result. Never
 * throws for a command that runs (any exit code is a result); rejects
 * only when the process cannot be spawned at all.
 *
 * With `opts.commands` (or a multi-command config) the commands run in
 * order and stop at the first failure: the returned result is the
 * failing command's result (or the last command's when all pass), with
 * `results` holding one entry per command that actually ran.
 */
export async function runTestGate(opts: TestGateOptions): Promise<TestGateResult> {
  const commands =
    opts.commands && opts.commands.length > 0
      ? opts.commands.map((c) => c.trim()).filter((c) => c.length > 0)
      : [(opts.command ?? '').trim()].filter((c) => c.length > 0);
  const maxOutputChars = Math.max(
    200,
    Math.floor(opts.maxOutputChars ?? DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS * 4),
  );
  const maxDigestChars = Math.max(
    200,
    Math.floor(opts.maxDigestChars ?? DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS),
  );
  const startedAt = Date.now();
  if (commands.length === 0) {
    return {
      command: '',
      passed: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      output: '',
      failedSummary: '',
    };
  }
  const results: TestGateCommandResult[] = [];
  let last: TestGateResult | null = null;
  for (const command of commands) {
    last = await runTestGateCommand(command, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxOutputChars,
      maxDigestChars,
    });
    results.push({
      command,
      passed: last.passed,
      exitCode: last.exitCode,
      signal: last.signal,
      timedOut: last.timedOut,
      durationMs: last.durationMs,
      failedSummary: last.failedSummary,
    });
    if (!last.passed) break;
  }
  const finalResult = last as TestGateResult;
  if (commands.length === 1) return finalResult;
  return { ...finalResult, results };
}

/** Run a single gate command (the inner step of `runTestGate`). */
async function runTestGateCommand(
  command: string,
  opts: Pick<TestGateOptions, 'cwd' | 'timeoutMs' | 'maxOutputChars' | 'maxDigestChars'>,
): Promise<TestGateResult> {
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS * 4;
  const maxDigestChars = opts.maxDigestChars ?? DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS;
  const res = await runShellCommand(command, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TEST_GATE_TIMEOUT_MS,
    cwd: opts.cwd,
    maxStdoutChars: maxOutputChars,
    maxStderrChars: maxOutputChars,
  });
  const output = [res.stdout, res.stderr]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n--- stderr ---\n');
  const passed = !res.timedOut && res.exitCode === 0;
  return {
    command,
    passed,
    exitCode: res.exitCode,
    signal: res.signal,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    output: output.slice(-maxOutputChars),
    failedSummary: passed ? '' : buildFailedSummary(output, maxDigestChars),
  };
}

export interface CreateTestGateHookOptions extends TestGateOptions {
  /** Registry name. Default `TEST_GATE_HOOK_NAME` (`subagent-test-gate`). */
  name?: string;
  /** Human-readable description (shown in Settings). */
  description?: string;
  /** Where gate runs are logged (one line per run). */
  logger?: (message: string) => void;
}

/**
 * Build the test-gate hook: a `HookDefinition` for `SubagentStop` that
 * runs the configured test command when a subagent claims to be done.
 *
 * - Tests pass → `allow` (with a reason, so the log shows the gate ran).
 * - Tests fail / time out → `block` + `additionalContext` (the digest).
 * - Subagent did not finish `done` → `allow` (nothing to gate).
 * - No command configured → `allow` with a reason (see module header:
 *   an unconfigured gate must never wedge subagents).
 *
 * The hook never throws: a spawn failure is an `allow` with a reason
 * saying the gate itself errored (the failure is also logged via
 * `opts.logger` when given). Failing OPEN here is deliberate — the
 * gate is a quality aid, not a security boundary; the denylist hook
 * (fail-closed) is the security layer. A gate that blocks all work
 * because `npm` is missing would be worse than a gate that reports
 * itself broken.
 */
export function createTestGateHook(opts: CreateTestGateHookOptions = {}): HookDefinition {
  const commands =
    opts.commands && opts.commands.length > 0
      ? opts.commands.map((c) => c.trim()).filter((c) => c.length > 0)
      : [(opts.command ?? '').trim()].filter((c) => c.length > 0);
  const command = commands[0] ?? '';
  const name = (opts.name ?? TEST_GATE_HOOK_NAME).trim() || TEST_GATE_HOOK_NAME;
  const logger = opts.logger;

  const handler: HookFn = async (event, ctx) => {
    if (event.event !== 'SubagentStop') return allowDecision();
    const stop = event as SubagentStopEvent;
    if (stop.status !== 'done') {
      return allowDecision(
        `Test gate bỏ qua subagent "${stop.name ?? stop.subagentId}" (trạng thái: ${stop.status}).`,
      );
    }
    if (commands.length === 0) {
      return allowDecision(
        'Test gate chưa cấu hình lệnh kiểm tra (vd "npm test") — subagent được chấp nhận, hãy cấu hình gate trong Settings → Hooks.',
      );
    }
    let result: TestGateResult;
    try {
      result = await runTestGate({
        commands,
        cwd: ctx.workspaceDir ?? opts.cwd,
        timeoutMs: opts.timeoutMs,
        maxOutputChars: opts.maxOutputChars,
        maxDigestChars: opts.maxDigestChars,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.(`[test-gate] không chạy được lệnh kiểm tra "${command}": ${message}`);
      return allowDecision(
        `Test gate lỗi khi chạy "${command}": ${message} — subagent được chấp nhận, hãy kiểm tra lại lệnh gate.`,
      );
    }
    logger?.(
      `[test-gate] subagent "${stop.name ?? stop.subagentId}": ` +
        `${command} → ${result.passed ? 'PASS' : 'FAIL'} (${result.durationMs}ms)`,
    );
    if (result.passed) {
      return allowDecision(
        commands.length > 1
          ? `Test gate PASS: ${commands.length} lệnh kiểm tra chạy xong (${result.durationMs}ms).`
          : `Test gate PASS: "${command}" chạy xong trong ${result.durationMs}ms.`,
      );
    }
    return blockStopDecision(
      buildTestGateAdditionalContext(result, stop.name ?? stop.subagentId),
      result.timedOut
        ? `Test gate TIMEOUT sau ${result.durationMs}ms — subagent quay lại sau khi kiểm tra lại.`
        : `Test gate FAIL (exit ${String(result.exitCode)}) — subagent cần sửa lỗi rồi chạy lại test.`,
    );
  };

  return {
    name,
    description:
      opts.description ??
      (commands.length > 1
        ? `Chạy ${commands.length} lệnh kiểm tra (${commands.join(' → ')}) khi subagent kết thúc; lệnh nào fail thì chặn subagent dừng lại và gửi nó quay lại sửa.`
        : `Chạy "${command || 'npm test'}" khi subagent kết thúc; test fail thì chặn subagent dừng lại và gửi nó quay lại sửa.`),
    events: ['SubagentStop'],
    handler,
    source: 'builtin',
    enabled: true,
  };
}
