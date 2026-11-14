/**
 * Run traces and aggregate statistics (v1.02, Team T4).
 *
 * Observability for coding runs, in two layers:
 *
 * - `RunTrace`: one entry per loop step — thought, action, observation,
 *   duration, tokens and cost. A run's trace is the human-readable
 *   version of its event log.
 * - `TraceStore`: aggregates many runs into totals — success rate,
 *   average steps / tokens / cost / duration, and a histogram of
 *   failure reasons. The numbers the eval harness and the UI report.
 */

import type { CodingAction, ActionObservation } from './actions';
import { describeAction } from './actions';
import type { BudgetUsage } from './budget';
import type { CodingRunStatus } from './events';

/** One loop step, as observed. */
export interface TraceStep {
  step: number;
  thought: string;
  action: string;
  actionKind: CodingAction['kind'];
  observationOk: boolean;
  observation: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** The full trace of one run. */
export interface RunTrace {
  runId: string;
  task: string;
  model: string;
  status: CodingRunStatus;
  summary: string;
  steps: TraceStep[];
  usage: BudgetUsage;
  durationMs: number;
  /** Total estimated USD cost, null when the model has no known price. */
  costUsd: number | null;
}

/** A run summarized for aggregation (no step detail). */
export interface RunSummary {
  runId: string;
  task: string;
  model: string;
  status: CodingRunStatus;
  summary: string;
  stepsUsed: number;
  filesChanged: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  failureReason?: string;
}

/** Aggregate statistics across many runs. */
export interface AggregateStats {
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgSteps: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Total estimated USD cost, null when any run had unknown cost. */
  totalCostUsd: number | null;
  avgCostUsd: number | null;
  /** Failure reason -> count. */
  failureReasons: Record<string, number>;
}

/** Build a trace from collected steps. */
export function buildTrace(
  runId: string,
  task: string,
  model: string,
  status: CodingRunStatus,
  summary: string,
  steps: TraceStep[],
  usage: BudgetUsage,
  durationMs: number,
): RunTrace {
  return {
    runId,
    task,
    model,
    status,
    summary,
    steps,
    usage,
    durationMs,
    costUsd: usage.costUsd,
  };
}

/** Aggregate many run summaries into totals. */
export function aggregateStats(summaries: RunSummary[]): AggregateStats {
  const runs = summaries.length;
  const succeeded = summaries.filter((s) => s.status === 'succeeded').length;
  const totalSteps = summaries.reduce((n, s) => n + s.stepsUsed, 0);
  const totalDuration = summaries.reduce((n, s) => n + s.durationMs, 0);
  const totalInput = summaries.reduce((n, s) => n + s.inputTokens, 0);
  const totalOutput = summaries.reduce((n, s) => n + s.outputTokens, 0);
  const anyUnknownCost = summaries.some((s) => s.costUsd === null);
  const totalCost = anyUnknownCost
    ? null
    : summaries.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const failureReasons: Record<string, number> = {};
  for (const s of summaries) {
    // Counted whenever present: an eval task can fail its checks even
    // when the run itself reported success.
    if (s.failureReason) {
      failureReasons[s.failureReason] = (failureReasons[s.failureReason] ?? 0) + 1;
    }
  }
  return {
    runs,
    succeeded,
    failed: runs - succeeded,
    successRate: runs === 0 ? 0 : succeeded / runs,
    avgSteps: runs === 0 ? 0 : totalSteps / runs,
    avgDurationMs: runs === 0 ? 0 : totalDuration / runs,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCostUsd: totalCost,
    avgCostUsd: totalCost === null || runs === 0 ? null : totalCost / runs,
    failureReasons,
  };
}

/** One-line text summary of a trace step, for logs and reports. */
export function formatTraceStep(step: TraceStep): string {
  const action = step.action;
  return `step ${step.step} [${step.durationMs}ms] ${step.thought} → ${action} (${step.observationOk ? 'ok' : 'FAIL'}: ${step.observation})`;
}

/** Render a run trace as Markdown (used by eval reports and exports). */
export function renderTraceMarkdown(trace: RunTrace): string {
  const lines: string[] = [
    `# Coding run ${trace.runId}`,
    '',
    `- Task: ${trace.task}`,
    `- Model: ${trace.model}`,
    `- Status: ${trace.status}`,
    `- Steps: ${trace.steps.length}`,
    `- Tokens: ${trace.usage.inputTokens} in / ${trace.usage.outputTokens} out`,
    `- Cost: ${trace.costUsd === null ? 'unknown' : `$${trace.costUsd.toFixed(4)}`}`,
    `- Duration: ${trace.durationMs}ms`,
    '',
    '## Steps',
    '',
  ];
  for (const step of trace.steps) {
    lines.push(`### Step ${step.step}`);
    lines.push('');
    lines.push(`- Thought: ${step.thought}`);
    lines.push(`- Action: ${step.action}`);
    lines.push(`- Observation (${step.observationOk ? 'ok' : 'FAIL'}): ${step.observation}`);
    lines.push(`- Tokens: ${step.inputTokens} in / ${step.outputTokens} out, ${step.durationMs}ms`);
    lines.push('');
  }
  return lines.join('\n');
}
