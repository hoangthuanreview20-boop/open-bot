/**
 * Hook test-run (v1.01, T2).
 *
 * A command hook the user just typed in Settings cannot be tried by
 * triggering the real event — blocking a real tool call to test a gate
 * is the wrong way to learn whether the command works. This module runs
 * ONE hook command once, with a SYNTHETIC event payload, and returns
 * everything the caller needs to show the user: the decision, the exit
 * code, the captured stdout/stderr tails, whether it timed out, and how
 * long it took.
 *
 * Used by:
 * - the Settings UI ("Chạy thử" button, via main IPC `hooks:commands-test`),
 * - the headless CLI (`open-bot hooks test <name> [--event <Event>]`).
 *
 * The sample payloads are deliberately boring and read-only: a test run
 * must never write files, call a real tool, or spawn a real subagent.
 * A command that decides from the payload fields (e.g. "block every
 * `rm`") still sees realistic values; a command that only checks the
 * exit-code protocol sees exactly what the real runner would send.
 *
 * This module NEVER throws for a command that runs and exits (any exit
 * code is reported in the result); it rejects only when the command
 * config itself is invalid or the process cannot be spawned at all.
 */

import type { HookCommandSettingsEntry, HookDecision, HookEventKind } from './types';
import { ALL_HOOK_EVENTS } from './registry';
import {
  assertValidHookCommandEntry,
  MAX_HOOK_COMMAND_STDERR_CHARS,
  MAX_HOOK_COMMAND_STDOUT_CHARS,
  parseHookDecisionLine,
  runShellCommand,
  stdoutLines,
} from './shellCommandRunner';

/** Result of one hook test-run (shown in Settings / CLI). */
export interface HookTestRunResult {
  /** Name of the hook that was test-run. */
  name: string;
  /** Event kind the sample payload pretended to be. */
  event: HookEventKind;
  /** Working directory the command ran in. */
  cwd: string;
  /** Decision the command produced (absent when it errored). */
  decision?: HookDecision;
  /** True when the command produced a decision (exit 0/2 with a usable answer). */
  ok: boolean;
  /** Error message when the command failed (non-zero exit / timeout / spawn). */
  error?: string;
  /** Process exit code (null when killed by a signal). */
  exitCode: number | null;
  /** Signal that killed the process, when any. */
  signal: NodeJS.Signals | null;
  /** True when the timeout killed the command. */
  timedOut: boolean;
  /** Wall-clock runtime in ms. */
  durationMs: number;
  /** Stdout tail (capped) — the decision line + any debug output. */
  stdout: string;
  /** Stderr tail (capped). */
  stderr: string;
}

export interface TestRunHookCommandOptions {
  /** Event kind to pretend (must be one of the hook's events). Defaults to the hook's first event. */
  event?: HookEventKind;
  /** Working directory. Defaults to the parent's cwd. */
  workspaceDir?: string;
  /** Per-invocation timeout override (ms). Defaults to the entry's `timeoutMs`. */
  timeoutMs?: number;
  /** Extra env vars for the child (validated like the entry's own env). */
  env?: Record<string, string>;
}

/**
 * Build a synthetic event payload for a test run. Every payload is
 * read-only and self-contained: `toolName` values are harmless reads,
 * `prompt` is a greeting, the subagent "finished" with a one-line
 * output. A hook that pattern-matches on the payload still exercises
 * its real logic; a hook that shells out to the network / filesystem
 * is the author's responsibility, exactly as in production.
 */
export function buildSampleEvent(
  kind: HookEventKind,
): Record<string, unknown> {
  switch (kind) {
    case 'PreToolUse':
      return {
        toolName: 'read_file',
        toolCallId: 'test-run-1',
        args: { path: 'README.md' },
      };
    case 'PostToolUse':
      return {
        toolName: 'read_file',
        toolCallId: 'test-run-1',
        args: { path: 'README.md' },
        result: { ok: true, output: '# open-bot\n' },
      };
    case 'SessionStart':
      return { source: 'test-run' };
    case 'SessionEnd':
      return { reason: 'test-run' };
    case 'Stop':
      return { reason: 'test-run' };
    case 'SubagentStart':
      return {
        subagentId: 'test-run-subagent',
        name: 'test-runner',
        task: 'Summarise README.md in one sentence.',
        instructions: 'Be brief.',
      };
    case 'SubagentStop':
      return {
        subagentId: 'test-run-subagent',
        name: 'test-runner',
        status: 'done',
        output: 'open-bot is a local-first agent platform.',
        durationMs: 1234,
      };
    case 'PreCompact':
      return { messageCount: 42, tokensBefore: 9000, contextLimit: 10000 };
    case 'PostCompact':
      return {
        summarizedCount: 32,
        tokensBefore: 9000,
        tokensAfter: 1200,
        summaryText: 'The user asked for a summary; the plan is X.',
        fallbackUsed: false,
      };
    case 'UserPromptSubmit':
      return { prompt: 'Hello, please summarise README.md.' };
    default:
      return {};
  }
}

/** Human-readable one-liner describing a sample event (Settings / CLI). */
export function describeSampleEvent(kind: HookEventKind): string {
  switch (kind) {
    case 'PreToolUse':
      return 'PreToolUse: tool read_file { path: README.md }';
    case 'PostToolUse':
      return 'PostToolUse: tool read_file finished ok';
    case 'SessionStart':
      return 'SessionStart: source test-run';
    case 'SessionEnd':
      return 'SessionEnd: reason test-run';
    case 'Stop':
      return 'Stop: reason test-run';
    case 'SubagentStart':
      return 'SubagentStart: subagent "test-runner" about to run';
    case 'SubagentStop':
      return 'SubagentStop: subagent "test-runner" finished done';
    case 'PreCompact':
      return 'PreCompact: 42 messages, ~9000 tokens';
    case 'PostCompact':
      return 'PostCompact: 32 messages summarised, 9000 → 1200 tokens';
    case 'UserPromptSubmit':
      return 'UserPromptSubmit: "Hello, please summarise README.md."';
    default:
      return kind;
  }
}

/**
 * Test-run one shell-command hook: validate the entry, pick the event
 * (explicit `opts.event`, else the hook's first event), send the sample
 * payload on stdin, and apply the same exit-code protocol as the real
 * runner (0 = decision/allow, 2 = block, other = error). The result
 * always carries stdout/stderr tails so the user can see what the
 * command actually printed.
 */
export async function testRunHookCommand(
  rawEntry: HookCommandSettingsEntry | unknown,
  opts: TestRunHookCommandOptions = {},
): Promise<HookTestRunResult> {
  const entry = assertValidHookCommandEntry(rawEntry);
  const event = opts.event ?? entry.events[0]!;
  if (!entry.events.includes(event)) {
    throw new Error(
      `Hook "${entry.name}" không chạy cho event "${event}" (chỉ chạy cho: ${entry.events.join(', ')}).`,
    );
  }
  if (!ALL_HOOK_EVENTS.includes(event)) {
    throw new Error(`Event không hợp lệ: "${String(event)}".`);
  }
  const cwd = opts.workspaceDir ?? process.cwd();
  const payload = JSON.stringify({ event, ...buildSampleEvent(event) });
  const timeoutMs = opts.timeoutMs ?? entry.timeoutMs ?? 10_000;

  const res = await runShellCommand(entry.command, {
    timeoutMs,
    cwd,
    env: {
      OPENBOT_HOOK_EVENT: event,
      ...(entry.env ?? {}),
      ...(opts.env ?? {}),
    },
    stdinText: `${payload}\n`,
  });

  const base: Omit<HookTestRunResult, 'decision' | 'ok' | 'error'> = {
    name: entry.name,
    event,
    cwd,
    exitCode: res.exitCode,
    signal: res.signal,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    stdout: res.stdout.slice(-MAX_HOOK_COMMAND_STDOUT_CHARS),
    stderr: res.stderr.slice(-MAX_HOOK_COMMAND_STDERR_CHARS),
  };

  if (res.timedOut) {
    return {
      ...base,
      ok: false,
      error: `Hook command timed out after ${timeoutMs}ms.`,
    };
  }
  if (res.signal !== null && res.exitCode === null) {
    return {
      ...base,
      ok: false,
      error: `Hook command was killed by signal ${res.signal}.`,
    };
  }
  const exitCode = res.exitCode ?? -1;
  const lines = stdoutLines(res.stdout);
  if (exitCode === 2) {
    const lastLine = lines.length > 0 ? lines[lines.length - 1]! : '';
    const decision = lastLine ? parseHookDecisionLine(lastLine) : null;
    if (decision && decision.action === 'block') {
      return { ...base, ok: true, decision };
    }
    const reason =
      (decision?.reason ?? (lastLine || '') ?? '') ||
      res.stderr.trim() ||
      `Blocked by hook command "${entry.name}" (exit 2).`;
    return { ...base, ok: true, decision: { action: 'block', reason: reason.slice(0, 1000) } };
  }
  if (exitCode !== 0) {
    return {
      ...base,
      ok: false,
      error:
        `Hook command exited with code ${exitCode}` +
        (res.stderr.trim() ? ` (stderr: ${res.stderr.trim().slice(-500)})` : ''),
    };
  }
  if (lines.length === 0) {
    return { ...base, ok: true, decision: { action: 'allow' } };
  }
  const decision = parseHookDecisionLine(lines[lines.length - 1]!);
  return {
    ...base,
    ok: true,
    decision: decision ?? { action: 'allow' },
  };
}
