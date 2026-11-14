/**
 * Multi-agent orchestration — public surface of
 * `packages/core/src/orchestra/`.
 *
 * A supervisor decomposes a goal, fans subtasks out to worker bots
 * (through a host-injected `runBot`), and merges the results.
 * Workers share a blackboard and receive handoff envelopes; every
 * state change is an event. Pure + local-store: no provider calls,
 * no network.
 */
export {
  priorityToWord,
  scoreWorkerForSubtask,
} from './types';
export type {
  OrchestraHandoffPriority,
  OrchestraPriority,
  OrchestraSession,
  OrchestraSessionStatus,
  OrchestraSubtask,
  OrchestraSubtaskStatus,
  WorkerCapability,
  WorkerResult,
} from './types';
export { Blackboard, BlackboardConflictError } from './blackboard';
export type { BlackboardEntry, BlackboardEvent } from './blackboard';
export { OrchestraEventLog } from './events';
export type { OrchestraEvent, OrchestraEventKind } from './events';
export { buildHandoffEnvelope, isValidHandoffEnvelope } from './handoff';
export type { HandoffEnvelope } from './handoff';
export { planFanOut, runFanOutWave } from './fanout';
export type { FanOutPlan } from './fanout';
export { mergeResults, resolveFileConflicts } from './merge';
export type { MergedResult } from './merge';
export { DEFAULT_ORCHESTRA_POLICY, resolveOrchestraPolicy, shouldEscalate, shouldRetrySubtask } from './policy';
export type { OrchestraPolicy } from './policy';
export { Supervisor } from './supervisor';
export type { SupervisorOptions, SupervisorRunResult } from './supervisor';
export { OrchestraStore } from './store';
export type { StoredOrchestraSession } from './store';
export { planToSubtasks, subtasksToPlan } from './planAdapter';
export type { PlanStep } from './planAdapter';
export { OrchestraService } from './service';
export type { OrchestraRunRequest, OrchestraServiceOptions } from './service';
