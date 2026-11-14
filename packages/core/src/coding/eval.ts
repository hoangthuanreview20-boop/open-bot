/**
 * Eval harness for coding agents (v1.02, Team T4).
 *
 * A small, honest benchmark: each eval task sets up a workspace,
 * gives the agent a task + a scripted reasoner (deterministic, so
 * the eval measures the LOOP, not a model's mood), runs it, then
 * scores pass/fail checks against the resulting workspace.
 *
 * Checks are plain facts about the workspace — a file exists, a file
 * contains a string, a command exits 0 — never a model's opinion of
 * its own work. The report lists every task, every check, and the
 * aggregate stats, as JSON and as Markdown.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodingAgent, type CodingCheck, type CodingRunResult } from './agent';
import type { CodingBudget } from './budget';
import { ScriptedReasoner, type ScriptedStep } from './reasoner';
import { runSandboxed } from './sandboxExec';
import { aggregateStats, type AggregateStats, type RunSummary } from './trace';
import { toRunSummary } from './agent';
import { Workspace } from './workspace';

/** One check scored against the workspace after a run. */
export type EvalCheck =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-not-exists'; path: string }
  | { kind: 'file-contains'; path: string; text: string }
  | { kind: 'file-not-contains'; path: string; text: string }
  | { kind: 'command'; argv: string[]; expectExitCode?: number };

/** One eval task: setup + task text + script + checks. */
export interface EvalTask {
  id: string;
  title: string;
  /** Task text handed to the agent. */
  task: string;
  /** Files created in the workspace before the run. */
  setupFiles?: Record<string, string>;
  /** Scripted reasoner steps (deterministic behaviour to evaluate). */
  script: ScriptedStep[];
  /** Checks scored after the run. */
  checks: EvalCheck[];
  /** Checks the agent loop itself verifies (run as loop checks). */
  loopChecks?: CodingCheck[];
  budget?: CodingBudget;
}

/** Result of one check. */
export interface EvalCheckResult {
  check: EvalCheck;
  passed: boolean;
  detail: string;
}

/** Result of one eval task. */
export interface EvalTaskResult {
  taskId: string;
  title: string;
  passed: boolean;
  status: string;
  summary: string;
  stepsUsed: number;
  durationMs: number;
  checks: EvalCheckResult[];
  run: CodingRunResult;
}

/** Whole-eval report. */
export interface EvalReport {
  generatedAt: string;
  tasks: EvalTaskResult[];
  passedTasks: number;
  failedTasks: number;
  stats: AggregateStats;
}

/** Score one check against a workspace. */
export function scoreCheck(check: EvalCheck, workspace: Workspace): EvalCheckResult {
  switch (check.kind) {
    case 'file-exists': {
      const ok = workspace.exists(check.path);
      return { check, passed: ok, detail: ok ? `${check.path} exists` : `${check.path} is missing` };
    }
    case 'file-not-exists': {
      const ok = !workspace.exists(check.path);
      return { check, passed: ok, detail: ok ? `${check.path} is absent` : `${check.path} still exists` };
    }
    case 'file-contains': {
      if (!workspace.exists(check.path)) {
        return { check, passed: false, detail: `${check.path} is missing` };
      }
      const ok = workspace.read(check.path).includes(check.text);
      return { check, passed: ok, detail: ok ? `${check.path} contains the text` : `${check.path} lacks the text` };
    }
    case 'file-not-contains': {
      if (!workspace.exists(check.path)) {
        return { check, passed: false, detail: `${check.path} is missing` };
      }
      const ok = !workspace.read(check.path).includes(check.text);
      return { check, passed: ok, detail: ok ? `${check.path} does not contain the text` : `${check.path} still contains the text` };
    }
    case 'command': {
      // Command checks run through the sandboxed executor in the
      // runner (async); this sync scorer marks them unsupported here.
      return { check, passed: false, detail: 'command checks need the async runner' };
    }
  }
}

export interface EvalRunnerOptions {
  /** Parent dir for per-task temp workspaces (default os.tmpdir()). */
  workspacesDir?: string;
  /** Keep temp workspaces after the run (default false — cleaned up). */
  keepWorkspaces?: boolean;
}

/**
 * Runs eval tasks, one temp workspace each. Returns the full report.
 * Workspaces are removed afterwards unless `keepWorkspaces` is set.
 */
export async function runEval(tasks: EvalTask[], options: EvalRunnerOptions = {}): Promise<EvalReport> {
  const parentDir = options.workspacesDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-coding-eval-'));
  const results: EvalTaskResult[] = [];
  const summaries: RunSummary[] = [];

  for (const task of tasks) {
    const workspaceRoot = path.join(parentDir, task.id);
    const workspace = new Workspace(workspaceRoot);
    for (const [rel, content] of Object.entries(task.setupFiles ?? {})) {
      workspace.write(rel, content);
    }
    const agent = new CodingAgent({
      workspaceRoot,
      reasoner: new ScriptedReasoner(task.script),
      budget: task.budget,
      checks: task.loopChecks,
    });
    const startedAt = Date.now();
    const run = await agent.run(task.task);
    const durationMs = Date.now() - startedAt;

    const checkResults: EvalCheckResult[] = [];
    for (const check of task.checks) {
      if (check.kind === 'command') {
        const result = await runSandboxed(check.argv, {
          workspaceRoot,
          timeoutMs: 30_000,
        });
        const expected = check.expectExitCode ?? 0;
        checkResults.push({
          check,
          passed: result.exitCode === expected && !result.timedOut && !result.blocked,
          detail: result.blocked
            ? `blocked: ${result.blockReason}`
            : `exit ${result.exitCode} (expected ${expected})`,
        });
      } else {
        checkResults.push(scoreCheck(check, workspace));
      }
    }
    const checksPassed = checkResults.every((c) => c.passed);
    const passed = run.status === 'succeeded' && checksPassed;
    const failureReason = !checksPassed
      ? 'check failed'
      : run.status !== 'succeeded'
        ? `run ${run.status}`
        : undefined;
    summaries.push(toRunSummary(run, failureReason));
    results.push({
      taskId: task.id,
      title: task.title,
      passed,
      status: run.status,
      summary: run.summary,
      stepsUsed: run.stepsUsed,
      durationMs,
      checks: checkResults,
      run,
    });
    if (!options.keepWorkspaces) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  const passedTasks = results.filter((r) => r.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    tasks: results,
    passedTasks,
    failedTasks: results.length - passedTasks,
    stats: aggregateStats(summaries),
  };
}

/** Render an eval report as Markdown. */
export function renderEvalReportMarkdown(report: EvalReport): string {
  const lines: string[] = [
    '# Coding agent eval report',
    '',
    `Generated: ${report.generatedAt}`,
    `Tasks: ${report.passedTasks}/${report.tasks.length} passed`,
    `Success rate: ${(report.stats.successRate * 100).toFixed(1)}%`,
    `Avg steps: ${report.stats.avgSteps.toFixed(1)}`,
    `Avg duration: ${Math.round(report.stats.avgDurationMs)}ms`,
    `Total tokens: ${report.stats.totalInputTokens} in / ${report.stats.totalOutputTokens} out`,
    `Total cost: ${report.stats.totalCostUsd === null ? 'unknown' : `$${report.stats.totalCostUsd.toFixed(4)}`}`,
    '',
  ];
  for (const task of report.tasks) {
    lines.push(`## ${task.passed ? 'PASS' : 'FAIL'} — ${task.title} (${task.taskId})`);
    lines.push('');
    lines.push(`- Status: ${task.status}, steps: ${task.stepsUsed}, ${task.durationMs}ms`);
    lines.push(`- Summary: ${task.summary}`);
    for (const c of task.checks) {
      lines.push(`- [${c.passed ? 'x' : ' '}] ${describeEvalCheck(c.check)} — ${c.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** One-line description of an eval check. */
export function describeEvalCheck(check: EvalCheck): string {
  switch (check.kind) {
    case 'file-exists':
      return `file exists: ${check.path}`;
    case 'file-not-exists':
      return `file absent: ${check.path}`;
    case 'file-contains':
      return `file contains: ${check.path} / "${check.text}"`;
    case 'file-not-contains':
      return `file lacks: ${check.path} / "${check.text}"`;
    case 'command':
      return `command exits ${check.expectExitCode ?? 0}: ${check.argv.join(' ')}`;
  }
}

/**
 * Built-in sample tasks for the eval harness. These are the smoke
 * evals: they exercise create/edit/delete + a passing check through
 * the real loop, with deterministic scripted reasoners.
 */
export function sampleEvalTasks(): EvalTask[] {
  return [
    {
      id: 'create-greeting',
      title: 'Create a greeting module',
      task: 'Create src/greet.ts exporting a greet function that returns "hello".',
      script: [
        {
          thought: 'Creating the greeting module.',
          action: { kind: 'create_file', path: 'src/greet.ts', content: 'export function greet(): string {\n  return "hello";\n}\n' },
        },
        {
          thought: 'Module created; finishing.',
          action: { kind: 'finish', summary: 'Created src/greet.ts.', success: true },
        },
      ],
      checks: [
        { kind: 'file-exists', path: 'src/greet.ts' },
        { kind: 'file-contains', path: 'src/greet.ts', text: 'export function greet' },
      ],
    },
    {
      id: 'fix-typo',
      title: 'Fix a typo and verify',
      task: 'Fix the typo in src/msg.mjs (helo -> hello) and verify with node.',
      setupFiles: { 'src/msg.mjs': 'export const msg = "helo";\n' },
      script: [
        {
          thought: 'Running the verify command first to confirm the typo.',
          action: {
            kind: 'run_command',
            argv: ['node', '-e', 'process.exit(require("fs").readFileSync("src/msg.mjs","utf8").includes(\'"hello"\') ? 0 : 1)'],
          },
        },
        {
          thought: 'Check failed as expected; fixing the typo.',
          action: { kind: 'edit_file', path: 'src/msg.mjs', oldText: '"helo"', newText: '"hello"' },
        },
        {
          thought: 'Re-running the verify command.',
          action: {
            kind: 'run_command',
            argv: ['node', '-e', 'process.exit(require("fs").readFileSync("src/msg.mjs","utf8").includes(\'"hello"\') ? 0 : 1)'],
          },
        },
        {
          thought: 'Typo fixed and check passed.',
          action: { kind: 'finish', summary: 'Fixed the typo; content check passed.', success: true },
        },
      ],
      checks: [
        { kind: 'file-contains', path: 'src/msg.mjs', text: '"hello"' },
        { kind: 'file-not-contains', path: 'src/msg.mjs', text: 'helo' },
      ],
      loopChecks: [
        {
          name: 'content',
          argv: ['node', '-e', 'process.exit(require("fs").readFileSync("src/msg.mjs","utf8").includes(\'"hello"\') ? 0 : 1)'],
        },
      ],
    },
    {
      id: 'remove-dead-file',
      title: 'Remove a dead file',
      task: 'Delete the obsolete src/old.ts file.',
      setupFiles: { 'src/old.ts': 'export const old = true;\n', 'src/keep.ts': 'export const keep = true;\n' },
      script: [
        {
          thought: 'Deleting the obsolete file.',
          action: { kind: 'delete_file', path: 'src/old.ts' },
        },
        {
          thought: 'Deleted; finishing.',
          action: { kind: 'finish', summary: 'Deleted src/old.ts.', success: true },
        },
      ],
      checks: [
        { kind: 'file-not-exists', path: 'src/old.ts' },
        { kind: 'file-exists', path: 'src/keep.ts' },
      ],
    },
  ];
}
