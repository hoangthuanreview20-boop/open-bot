/**
 * Orchestra policy — limits that keep a session safe (v1.02 rescue
 * port of the v0.99 work).
 *
 * The policy caps how much a session may fan out, retry, and run,
 * and decides when a failed subtask escalates to the supervisor
 * instead of retrying forever. All limits are explicit numbers the
 * host can tune; the defaults are deliberately small.
 */

import type { OrchestraPriority } from './types';

export interface OrchestraPolicy {
  /** Max subtasks in one session. */
  maxSubtasks: number;
  /** Max workers in one wave. */
  maxParallelWorkers: number;
  /** Max attempts per subtask (first try + retries). */
  maxAttempts: number;
  /** Max wall-clock ms for a whole session (0 = no limit). */
  maxSessionMs: number;
  /** Retry a failed subtask on another worker (false = fail at once). */
  retryOnFailure: boolean;
  /** Escalate to the supervisor after this many failures in a row. */
  escalateAfterFailures: number;
  /** Default priority for subtasks without one. */
  defaultPriority: OrchestraPriority;
}

/** Conservative defaults (small fan-out, few retries). */
export const DEFAULT_ORCHESTRA_POLICY: OrchestraPolicy = {
  maxSubtasks: 50,
  maxParallelWorkers: 6,
  maxAttempts: 3,
  maxSessionMs: 0,
  retryOnFailure: true,
  escalateAfterFailures: 2,
  defaultPriority: 3,
};

/** Merge a partial policy over the defaults (unknown keys ignored). */
export function resolveOrchestraPolicy(partial: Partial<OrchestraPolicy> = {}): OrchestraPolicy {
  return {
    ...DEFAULT_ORCHESTRA_POLICY,
    ...partial,
    maxSubtasks: Math.max(1, partial.maxSubtasks ?? DEFAULT_ORCHESTRA_POLICY.maxSubtasks),
    maxParallelWorkers: Math.max(1, partial.maxParallelWorkers ?? DEFAULT_ORCHESTRA_POLICY.maxParallelWorkers),
    maxAttempts: Math.max(1, partial.maxAttempts ?? DEFAULT_ORCHESTRA_POLICY.maxAttempts),
    escalateAfterFailures: Math.max(1, partial.escalateAfterFailures ?? DEFAULT_ORCHESTRA_POLICY.escalateAfterFailures),
  };
}

/** Should a failed subtask be retried (attempts left + policy allows)? */
export function shouldRetrySubtask(policy: OrchestraPolicy, attempts: number, consecutiveFailures: number): boolean {
  if (!policy.retryOnFailure) return false;
  if (attempts >= policy.maxAttempts) return false;
  if (consecutiveFailures >= policy.escalateAfterFailures) return false;
  return true;
}

/** Should a failure escalate to the supervisor now? */
export function shouldEscalate(policy: OrchestraPolicy, consecutiveFailures: number): boolean {
  return consecutiveFailures >= policy.escalateAfterFailures;
}
