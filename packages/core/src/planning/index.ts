/**
 * Planning module (v0.96, Team T6) — plan steps with a lifecycle,
 * multi-agent dispatch, and the stuck-state detector.
 * v0.98 (Team T4 — planning v2): run binding (plans follow live
 * coordinator runs), replan proposals, templates, file persistence.
 */
export { PlanEngine, planProgress } from './engine';
export type { Plan, PlanEngineOptions, PlanProgress, PlanStep, PlanStepStatus } from './engine';
export {
  StuckDetector,
  checkErrorRepeat,
  checkNoProgress,
  checkRepeatedCalls,
  checkStall,
  checkToolCycle,
  normalizeToolError,
  toolCallSignature,
  trailingCycle,
  trailingRepeatRun,
  DEFAULT_STALL_MS,
} from './stuck';
export type { StuckDetectorOptions, StuckReason, StuckReport, ToolCallRecord } from './stuck';
export {
  getPlanTemplate,
  instantiatePlanTemplate,
  listPlanTemplates,
  PLAN_TEMPLATES,
} from './templates';
export type {
  InstantiatedPlan,
  PlanTemplate,
  PlanTemplateStep,
  PlanTemplateVariable,
} from './templates';
export { applyReplan, proposeReplan, rejectReplan, stuckStepOf } from './replan';
export type {
  ReplanChange,
  ReplanChangeType,
  ReplanDecision,
  ReplanProposal,
  ReplanProposalOptions,
} from './replan';
export { PlanFileStore, RUN_PLANS_DIR } from './persistence';
export type { ResumeResult, StoredRunPlan } from './persistence';
export { RunPlanBinding } from './runBinding';
export type {
  EndRunOutcome,
  PlanRunEvent,
  PlanRunEventType,
  RunPlanBindingOptions,
} from './runBinding';
