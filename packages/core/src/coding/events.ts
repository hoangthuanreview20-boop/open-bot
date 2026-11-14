/**
 * Coding-agent event stream (v1.02, Team T4).
 *
 * OpenHands-style event-stream architecture: the agent loop is
 *   reason -> action -> environment execute -> observe
 * and every step is recorded as an immutable, append-only event.
 *
 * A run can be replayed from its event log (see `store.ts`) to rebuild
 * its final state, and inspected step by step for debugging. Events
 * carry no secrets: file contents are truncated and command output is
 * capped before being stored.
 */

/** Every event type the coding agent can emit. */
export type CodingEventType =
  | 'run.started'
  | 'plan.created'
  | 'plan.step.updated'
  | 'reasoning'
  | 'action.proposed'
  | 'action.executed'
  | 'observation'
  | 'file.changed'
  | 'command.result'
  | 'check.result'
  | 'fix.attempted'
  | 'budget.exceeded'
  | 'run.finished';

/** Final (or current) status of a coding run. */
export type CodingRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'budget-exceeded'
  | 'aborted';

/** How a file changed. */
export type CodingFileChangeKind = 'created' | 'edited' | 'deleted';

/** Payload of `run.started`. */
export interface RunStartedPayload {
  /** The task the agent was given, as written by the user. */
  task: string;
  /** Workspace root the run is confined to (absolute path). */
  workspaceRoot: string;
  /** Model id driving the run, or 'scripted' / 'rule' for local reasoners. */
  model: string;
  /** Step budget configured for the run. */
  maxSteps: number;
}

/** Payload of `plan.created`. */
export interface PlanCreatedPayload {
  /** Plan step ids in order. */
  stepIds: string[];
  /** Short description of each step, in order. */
  steps: string[];
}

/** Payload of `plan.step.updated`. */
export interface PlanStepUpdatedPayload {
  stepId: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  /** Optional note, e.g. why a step failed. */
  note?: string;
}

/** Payload of `reasoning`. */
export interface ReasoningPayload {
  /** The model's (or reasoner's) thinking for this step, truncated. */
  thought: string;
}

/** Payload of `action.proposed` / `action.executed`. */
export interface ActionPayload {
  /** Action kind, e.g. 'create_file'. */
  kind: string;
  /** Human-readable summary of the action. */
  summary: string;
  /** Action arguments, sanitized (no file contents over the cap). */
  args: Record<string, unknown>;
  /** Only on `action.executed`: whether it succeeded. */
  ok?: boolean;
  /** Only on `action.executed`: error message when it failed. */
  error?: string;
}

/** Payload of `observation`. */
export interface ObservationPayload {
  /** Whether the observed action succeeded. */
  ok: boolean;
  /** Short summary of what the environment returned. */
  summary: string;
  /** Truncated detail (command output, error text, ...). */
  detail?: string;
}

/** Payload of `file.changed`. */
export interface FileChangedPayload {
  path: string;
  kind: CodingFileChangeKind;
  /** Lines added / removed, when known. */
  linesAdded?: number;
  linesRemoved?: number;
}

/** Payload of `command.result`. */
export interface CommandResultPayload {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Truncated stdout. */
  stdout: string;
  /** Truncated stderr. */
  stderr: string;
}

/** Payload of `check.result`. */
export interface CheckResultPayload {
  /** Name of the check, e.g. 'typecheck'. */
  name: string;
  passed: boolean;
  /** Command that was run for the check. */
  argv: string[];
  durationMs: number;
}

/** Payload of `fix.attempted`. */
export interface FixAttemptedPayload {
  /** Which fix attempt this is (1-based). */
  attempt: number;
  /** Maximum fix attempts allowed. */
  maxAttempts: number;
  /** What failed and triggered the fix. */
  reason: string;
}

/** Payload of `budget.exceeded`. */
export interface BudgetExceededPayload {
  /** Which budget ran out: steps, tokens, cost or time. */
  budget: 'steps' | 'tokens' | 'cost' | 'time';
  used: number;
  limit: number;
}

/** Payload of `run.finished`. */
export interface RunFinishedPayload {
  status: CodingRunStatus;
  /** Final summary for the user. */
  summary: string;
  stepsUsed: number;
  filesChanged: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost, null when the model has no known price. */
  costUsd: number | null;
  durationMs: number;
}

/** Payload union, keyed by event type. */
export type CodingEventPayload =
  | RunStartedPayload
  | PlanCreatedPayload
  | PlanStepUpdatedPayload
  | ReasoningPayload
  | ActionPayload
  | ObservationPayload
  | FileChangedPayload
  | CommandResultPayload
  | CheckResultPayload
  | FixAttemptedPayload
  | BudgetExceededPayload
  | RunFinishedPayload;

/**
 * One immutable event in a coding run. Events are append-only and
 * chained: each event stores the SHA-256 hash of the previous event,
 * so a tampered or reordered log fails verification (see `store.ts`).
 */
export interface CodingEvent {
  /** 1-based sequence number inside the run, no gaps. */
  seq: number;
  /** Id of the run this event belongs to. */
  runId: string;
  /** ISO 8601 timestamp when the event was recorded. */
  at: string;
  /** Loop step this event belongs to (0 = before the loop starts). */
  step: number;
  type: CodingEventType;
  payload: CodingEventPayload;
  /** Hash of the previous event ('' for the first event). */
  prevHash: string;
  /** SHA-256 hash of this event's canonical form. */
  hash: string;
}

/** Maximum characters kept for a thought / output stored in an event. */
export const EVENT_TEXT_CAP = 4000;
export const EVENT_OUTPUT_CAP = 8000;

/** Truncate text stored in events so logs stay small and secret-free. */
export function capText(text: string, cap: number = EVENT_TEXT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
}
