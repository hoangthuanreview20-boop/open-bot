/**
 * Run budgets for coding agents (v1.02, Team T4).
 *
 * A coding run stops when any budget runs out: max steps, max tokens,
 * max estimated cost, or max wall-clock time. The tracker also counts
 * fix attempts (a failed check gets a limited number of retries) and
 * converts token usage to an estimated USD cost through the shared
 * price table (`usage/pricing`), so cost is `null` — never $0 — when
 * the model has no known price.
 */

import { estimateCost } from '../usage/pricing';

/** Budgets configured for one run. All limits are inclusive caps. */
export interface CodingBudget {
  /** Maximum reason->action loop iterations (default 25). */
  maxSteps?: number;
  /** Maximum total tokens (input + output) across the run. */
  maxTokens?: number;
  /** Maximum estimated USD cost across the run. */
  maxCostUsd?: number;
  /** Maximum wall-clock time in ms. */
  maxTimeMs?: number;
  /** Maximum fix attempts after a failed check (default 3). */
  maxFixAttempts?: number;
}

export const DEFAULT_BUDGET: Required<CodingBudget> = {
  maxSteps: 25,
  maxTokens: 200_000,
  maxCostUsd: 1,
  maxTimeMs: 15 * 60_000,
  maxFixAttempts: 3,
};

/** Which budget ran out. */
export type BudgetKind = 'steps' | 'tokens' | 'cost' | 'time';

/** Usage accumulated so far in a run. */
export interface BudgetUsage {
  stepsUsed: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost, null when the model has no known price. */
  costUsd: number | null;
  elapsedMs: number;
  fixAttempts: number;
}

/**
 * Tracks one run's consumption against its budgets. Pure except for
 * the wall clock (started at construction).
 */
export class BudgetTracker {
  readonly budget: Required<CodingBudget>;
  private readonly startedAt = Date.now();
  private stepsUsed = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd: number | null = 0;
  private costUnknown = false;
  private fixAttempts = 0;
  private readonly model: string;

  constructor(model: string, budget: CodingBudget = {}) {
    this.model = model;
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  /** Record one reasoning step (counts toward maxSteps). */
  recordStep(): void {
    this.stepsUsed += 1;
  }

  /** Record token usage for one model call; updates the cost estimate. */
  recordTokens(inputTokens: number, outputTokens: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    const cost = estimateCost(this.model, this.inputTokens, this.outputTokens);
    if (cost === null) {
      this.costUnknown = true;
      this.costUsd = null;
    } else if (!this.costUnknown) {
      this.costUsd = cost;
    }
  }

  /** Record one fix attempt after a failed check. */
  recordFixAttempt(): void {
    this.fixAttempts += 1;
  }

  /** True when another fix attempt is allowed. */
  get canFix(): boolean {
    return this.fixAttempts < this.budget.maxFixAttempts;
  }

  /** Current usage snapshot. */
  usage(): BudgetUsage {
    return {
      stepsUsed: this.stepsUsed,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      elapsedMs: Date.now() - this.startedAt,
      fixAttempts: this.fixAttempts,
    };
  }

  /**
   * Check the budgets. Returns the exceeded budget and its numbers,
   * or null when the run may continue.
   */
  checkExceeded(): { budget: BudgetKind; used: number; limit: number } | null {
    const u = this.usage();
    if (u.stepsUsed >= this.budget.maxSteps) {
      return { budget: 'steps', used: u.stepsUsed, limit: this.budget.maxSteps };
    }
    if (u.inputTokens + u.outputTokens >= this.budget.maxTokens) {
      return { budget: 'tokens', used: u.inputTokens + u.outputTokens, limit: this.budget.maxTokens };
    }
    if (u.costUsd !== null && u.costUsd >= this.budget.maxCostUsd) {
      return { budget: 'cost', used: u.costUsd, limit: this.budget.maxCostUsd };
    }
    if (u.elapsedMs >= this.budget.maxTimeMs) {
      return { budget: 'time', used: u.elapsedMs, limit: this.budget.maxTimeMs };
    }
    return null;
  }
}

/** Rough token estimate for text when a provider reports no usage (chars / 4). */
export function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}
