/**
 * Planning module (v0.96, Team T6) — plan steps with a lifecycle,
 * multi-agent dispatch, and the stuck-state detector.
 */
export { PlanEngine, planProgress } from './engine';
export type { Plan, PlanEngineOptions, PlanProgress, PlanStep, PlanStepStatus } from './engine';
export {
  StuckDetector,
  checkNoProgress,
  checkRepeatedCalls,
  toolCallSignature,
  trailingRepeatRun,
} from './stuck';
export type { StuckDetectorOptions, StuckReason, StuckReport, ToolCallRecord } from './stuck';
