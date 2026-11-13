/**
 * Harness v2 — public surface (v0.97, Team T5).
 *
 * Signed webhook receiver + routines v2 (queue + retry) + headless
 * CI-style job mode + versioned NDJSON event export + per-bot
 * computer health probe. Local-first, free, no X data, no cloud.
 */
export {
  HARNESS_V2_EVENT_VERSION,
  HARNESS_V2_EVENT_KINDS,
  HARNESS_V2_WEBHOOK_DEFAULT_PORT,
  HARNESS_V2_NDJSON_FILE,
  ROUTINES_FILE,
  WEBHOOK_DELIVERIES_FILE,
  HEADLESS_EXIT_OK,
  HEADLESS_EXIT_USAGE,
  HEADLESS_EXIT_RUN_ERROR,
  HEADLESS_EXIT_APPROVAL_DENIED,
} from './types';
export type {
  HarnessV2Event,
  HarnessV2EventKind,
  Routine,
  RoutineAction,
  RoutineQueueStatus,
  RoutineQueueItem,
  RoutineRun,
  RoutineRunStatus,
  RoutineTrigger,
  WebhookDelivery,
  WebhookReceiverStats,
  BotComputerHealth,
  BotComputerHealthStatus,
  BotComputerHealthThresholds,
  HeadlessJobFile,
  HeadlessJobResult,
} from './types';

export {
  authenticateWebhookDelivery,
  computeWebhookSignature,
  verifyWebhookSignature,
  verifyWebhookTimestamp,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_S,
} from './signature';
export type { WebhookAuthResult } from './signature';

export {
  SignedWebhookReceiver,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_DEFAULT_MAX_QUEUE,
} from './webhookReceiver';
export type {
  QueuedWebhookDelivery,
  SignedWebhookReceiverOptions,
  WebhookQueueDrop,
} from './webhookReceiver';

export {
  JsonFileRoutineStore,
  MemoryRoutineStore,
  RoutineManager,
  MAX_ROUTINE_RUN_HISTORY,
  DEFAULT_ROUTINE_MAX_ATTEMPTS,
  DEFAULT_ROUTINE_RETRY_BACKOFF_MS,
  MAX_ROUTINE_BACKOFF_MS,
  DEFAULT_ROUTINE_MAX_QUEUED,
  ROUTINE_MISSED_GRACE_MS,
  nextRoutineRunAt,
  routineBackoffMs,
  routineDue,
  validateRoutine,
} from './routines';
export type { RoutineExecutor, RoutineManagerOptions, RoutineStore } from './routines';

export {
  NdjsonEventExporter,
  followNdjsonFile,
  isExportableEventKind,
  NDJSON_EXPORT_KINDS,
  parseNdjsonEventLine,
  readNdjsonEventFile,
  readNdjsonEvents,
  tailNdjsonEvents,
} from './eventExport';
export type {
  NdjsonEventExporterOptions,
  NdjsonExportStats,
  NdjsonFollowHandle,
} from './eventExport';

export {
  BotComputerHealthProber,
  DEFAULT_HEALTH_PROBE_INTERVAL_MS,
  DEFAULT_HEALTH_THRESHOLDS,
  MAX_HEALTH_HISTORY,
  classifyBotComputerHealth,
  parseDfUsedRatio,
  probeBotComputerHealth,
} from './healthProbe';
export type {
  BotComputerTarget,
  BotComputerHealthProberOptions,
  HealthProbeDeps,
} from './healthProbe';

export {
  HeadlessJobRunner,
  APPROVAL_DENIED_TEXT,
  CLI_KIND_PROVIDER_IDS,
  DEFAULT_HEADLESS_JOB_TIMEOUT_MS,
  MAX_HEADLESS_PROMPT_CHARS,
  MAX_HEADLESS_IMAGES,
  loadHeadlessJobFile,
  parseHeadlessJobFile,
  shouldBypassRouter,
} from './headless';
export type { HeadlessBotRunner, HeadlessJobRunnerOptions, HeadlessRunOutcome } from './headless';
