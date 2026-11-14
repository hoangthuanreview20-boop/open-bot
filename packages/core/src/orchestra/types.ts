/**
 * Multi-agent orchestration — shared types (v1.02 rescue port of the
 * v0.99 work).
 *
 * A supervisor bot decomposes a goal into subtasks, hands them to
 * worker bots, watches progress, and merges the results
 * (fan-out/fan-in). Workers talk through a handoff envelope and
 * share a blackboard (key-value + event log, optimistic locking)
 * inside one session.
 *
 * This module is pure + local-store: it never calls a provider or
 * the network and never touches the coordinator directly — the
 * coordinator plugs in through `OrchestraService` (see `service.ts`),
 * and real workers run through a `runBot` callback the coordinator
 * supplies. Ideas only, learned from the v0.99 survey (supervisor /
 * swarm, handoff, blackboard, fan-out with merge + conflict
 * resolution) — all code written fresh for open-bot.
 */

/** Lifecycle of one orchestration session. */
export type OrchestraSessionStatus =
  | 'created'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled';

/** Lifecycle of one subtask inside a session. */
export type OrchestraSubtaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'escalated';

/** Priority of a handoff / subtask (1 = lowest, 5 = highest). */
export type OrchestraPriority = 1 | 2 | 3 | 4 | 5;

/** Word-form priority in a handoff envelope (for workers to read). */
export type OrchestraHandoffPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Map a numeric priority to its word form. */
export function priorityToWord(priority: OrchestraPriority): OrchestraHandoffPriority {
  if (priority <= 1) return 'low';
  if (priority === 2) return 'normal';
  if (priority === 3) return 'normal';
  if (priority === 4) return 'high';
  return 'urgent';
}

/**
 * What a worker bot can do — the supervisor uses it to split work.
 * `maxParallel` is how many subtasks the worker takes at once
 * (default 1, 0 = unlimited).
 */
export interface WorkerCapability {
  id: string;
  name: string;
  description: string;
  model?: string;
  tools: string[];
  computer?: string;
  maxParallel?: number;
}

/** What a worker returns for a subtask. */
export interface WorkerResult {
  output: string;
  /** Files the worker created or changed (relative paths). */
  filesChanged?: string[];
  /** Tokens the worker used (when reported). */
  tokensUsed?: number;
  durationMs?: number;
}

/** One subtask of an orchestration session. */
export interface OrchestraSubtask {
  id: string;
  sessionId: string;
  title: string;
  detail?: string;
  status: OrchestraSubtaskStatus;
  assigneeWorkerId?: string | null;
  /** Subtasks that must finish before this one runs. */
  dependsOn?: string[];
  priority: OrchestraPriority;
  /** Relative deadline (ms from session start; unset = no deadline). */
  deadlineMs?: number;
  /** Attempts so far (including retries to another worker). */
  attempts: number;
  /** Max attempts (default 3: first worker + 2 retries). */
  maxAttempts: number;
  /** Workers already tried (retries never go back to them). */
  triedWorkerIds: string[];
  /** Routing score of the assigned worker (0..1). */
  routingScore?: number;
  result?: WorkerResult;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** One orchestration session (a goal + its subtasks). */
export interface OrchestraSession {
  id: string;
  goal: string;
  status: OrchestraSessionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  subtaskIds: string[];
  /** Id of the supervisor bot (when a bot supervises). */
  supervisorBotId?: string;
  /** How subtasks were split ('manual' | 'auto'). */
  planSource?: string;
  summary?: string;
  error?: string;
}

/** Score a worker for a subtask (0..1): keyword match on description + tools. */
export function scoreWorkerForSubtask(worker: WorkerCapability, subtask: OrchestraSubtask): number {
  const haystack = `${worker.description} ${worker.tools.join(' ')}`.toLowerCase();
  const needles = `${subtask.title} ${subtask.detail ?? ''}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3);
  if (needles.length === 0) return 0.1;
  let hits = 0;
  for (const needle of new Set(needles)) if (haystack.includes(needle)) hits++;
  const keywordScore = hits / new Set(needles).size;
  const toolBonus = worker.tools.length > 0 ? 0.1 : 0;
  return Math.min(1, keywordScore * 0.9 + toolBonus);
}
