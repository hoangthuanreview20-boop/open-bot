/**
 * Per-turn token/usage (UI-8) — pure helpers, no React, no IPC.
 *
 * The desktop `chat:send` result carries no usage (the core `RunResult`
 * has no usage field and main does not add one), and this wave stays
 * renderer-only, so App derives the turn's usage from the usage data
 * that already exists: `usage:get` (SpendStatus) before the run and
 * after it resolves. The `total` window is cumulative per bot, so its
 * diff is exactly the turn's tokens — even across midnight — unless
 * the store was reset mid-run (negative diff → no footer, never a
 * made-up number).
 *
 * Cost caveat (from UsageTracker.getSummary): a window's `costUsd` is
 * null when ANY record in scope is unpriced, so a bot that once used
 * an unpriced model shows tokens but no cost for later turns. That is
 * honest — a wrong cost would be worse than none.
 */
import type { SpendStatusData, TurnUsageView } from '../types';

/** The spend window used for the diff (`total` first, `today` fallback). */
function spendWindow(status: SpendStatusData | null | undefined) {
  if (!status) return null;
  return status.total ?? status.today ?? null;
}

/**
 * Diff two `usage:get` snapshots into one turn's usage, or null when
 * there is nothing to show: no snapshot, a reset mid-run (negative
 * diff), or zero tokens (the provider reported no usage, e.g. some
 * local models — show nothing rather than "0 token").
 */
export function diffTurnUsage(
  before: SpendStatusData | null | undefined,
  after: SpendStatusData | null | undefined,
): TurnUsageView | null {
  const b = spendWindow(before);
  const a = spendWindow(after);
  if (!b || !a) return null;
  const inputTokens = a.inputTokens - b.inputTokens;
  const outputTokens = a.outputTokens - b.outputTokens;
  const calls = a.calls - b.calls;
  if (inputTokens < 0 || outputTokens < 0 || calls < 0) return null;
  if (inputTokens + outputTokens === 0) return null;
  // Cost is only known when the whole window is priced on both sides.
  // Round to 6 decimals: plain float subtraction leaves artefacts
  // (0.07 - 0.05 = 0.020000000000000004) that would leak into the UI.
  const costUsd =
    b.costUsd === null || a.costUsd === null
      ? null
      : Math.max(0, Math.round((a.costUsd - b.costUsd) * 1e6) / 1e6);
  return { inputTokens, outputTokens, costUsd, calls: Math.max(0, calls) };
}

/** Grouped digits for a token count (deterministic across locales). */
export function formatTokenCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Cost for the footer: per-turn costs are usually sub-cent, so
 * `$0.00` (toFixed(2)) would hide real spend — show 4 decimals below
 * one cent, 2 decimals otherwise.
 */
export function formatTurnCostUsd(costUsd: number): string {
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}
