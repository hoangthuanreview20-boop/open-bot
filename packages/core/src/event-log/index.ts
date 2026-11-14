/**
 * Event-sourced run log (v1.01, Đội T1) — public exports.
 *
 * Append-only log bất biến theo run (JSONL + hash chain SHA-256),
 * deterministic replay, pause/resume/fork, audit trail.
 * Xem `docs/survey-v101-t1-event-log.md` để biết thiết kế đầy đủ.
 */

export { GENESIS_PREV_HASH, digestReplayState, eventHashInput, hashRunEvent, verifyEventHash } from './canonical';
/** Alias riêng (tránh đụng `sha256Hex`/`stableStringify` đã có trong core index). */
export { sha256Hex as runLogSha256Hex, stableStringify as runLogStableStringify } from './canonical';
export {
  RunControlRegistry,
  RunGateAbortedError,
  RunPauseGate,
  forkRun,
  pauseRun,
  resumeRun,
} from './control';
export type { ForkRunResult, PauseResumeResult, RunPauseGateLike } from './control';
export {
  foldEvents,
  replayDeterministically,
  replayMatches,
} from './replay';
export type { ReplayDriverHandlers } from './replay';
export { RunLogRecorder } from './recorder';
export type { LoopRunLogWiring, RunLogRecorderOptions, RunLogSink } from './recorder';
export {
  RUN_LOG_ARRAY_LIMIT,
  RUN_LOG_DEPTH_LIMIT,
  RUN_LOG_OUTPUT_LIMIT,
  RUN_LOG_STRING_LIMIT,
  extractFirstError,
  fileChangeKindForTool,
  isBuildToolCall,
  isFileWriteTool,
  sanitizeRunLogPayload,
  sanitizeRunLogString,
  toolArgKeys,
} from './sanitize';
export { RunLogStore, safeRunFileName } from './store';
export type { ReadRunResult, RunLogStoreOptions } from './store';
export { queryAudit, replayRunState, summarizeAudit, verifyAllRuns } from './audit';
export type {
  AuditEventEntry,
  AuditIntegrityReport,
  AuditQuery,
  AuditSummary,
} from './audit';
export type {
  AnyRunEvent,
  ApprovalPayload,
  CheckpointSavedPayload,
  CompileErrorPayload,
  DeterministicReplayResult,
  FileChangePayload,
  ModelResponsePayload,
  NewRunEvent,
  ReplayedRunState,
  ReplayedToolCall,
  ReplayedTranscriptEntry,
  RunEndPayload,
  RunEvent,
  RunEventPayloadMap,
  RunEventQuery,
  RunEventType,
  RunForkedPayload,
  RunLogMeta,
  RunLogVerification,
  RunPausePayload,
  RunPromptPayload,
  RunStartedPayload,
  RunStatus,
  ToolCallPayload,
  ToolResultPayload,
} from './types';
