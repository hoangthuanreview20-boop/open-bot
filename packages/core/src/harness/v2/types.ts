/**
 * Harness v2 — shared types (v0.97, Team T5).
 *
 * Ideas only, learned from the repo survey (docs/repo-survey-v097.md
 * section 5): a signed local webhook receiver, routines v2 (schedule +
 * trigger queue with retry), a headless CI-style `open-bot run` job
 * mode, a versioned NDJSON event bus export, and a per-bot-computer
 * health probe. No code, text or asset is copied from any other repo.
 *
 * Design notes:
 * - Everything here is local-first and free: no X data, no Grok
 *   Imagine, no cloud VM / account / payment. The webhook receiver
 *   binds loopback only unless the user explicitly opts into another
 *   host, and secrets live in the Vault (never in these records).
 * - Routine / webhook / health records never contain secrets: payloads
 *   go through the same redaction rules as the v1 harness log
 *   (`sanitizeHarnessPayload`) before they are persisted or exported.
 * - New behaviour that is ON by default must exempt provider 'mock'
 *   and CLI-kind bots (v0.96 regression: the router routed mock bots
 *   to a real local Ollama). The headless runner in headless.ts
 *   applies that exemption; the routine manager itself never picks a
 *   provider, it only calls the host-supplied executor.
 */

/** Version of the v2 NDJSON event envelope (see eventExport.ts). */
export const HARNESS_V2_EVENT_VERSION = 2;

/**
 * Kinds introduced by harness v2. They extend (never replace) the v1
 * `HarnessEventKind` list; `HARNESS_EVENT_KINDS` in ipc/validate.ts
 * must list them too so IPC / Local API filters accept them.
 */
export type HarnessV2EventKind =
  | 'webhook.received'
  | 'webhook.rejected'
  | 'routine.started'
  | 'routine.completed'
  | 'routine.failed'
  | 'health.probe'
  | 'cli.job.started'
  | 'cli.job.completed';

/** All v2 event kinds, in a stable order (used by tests + UI filters). */
export const HARNESS_V2_EVENT_KINDS: readonly HarnessV2EventKind[] = [
  'webhook.received',
  'webhook.rejected',
  'routine.started',
  'routine.completed',
  'routine.failed',
  'health.probe',
  'cli.job.started',
  'cli.job.completed',
];

/**
 * One versioned event on the v2 NDJSON bus. The shape is stable:
 * consumers may rely on `v`, `seq`, `at`, `kind`, `botId`,
 * `threadId` and `payload` always being present; new optional fields
 * may be added but existing fields never change meaning.
 */
export interface HarnessV2Event {
  /** Envelope version (always 2 for v2 events). */
  v: 2;
  /** Monotonic sequence number within one exporter instance. */
  seq: number;
  /** ISO timestamp when the event was emitted. */
  at: string;
  kind: HarnessV2EventKind;
  /** Bot the event belongs to ('' = harness-wide, no single bot). */
  botId: string;
  /** Thread / session id ('' when there is no thread). */
  threadId: string;
  /** Sanitized payload (no secrets, strings truncated). */
  payload: Record<string, unknown>;
}

/** How a routine is triggered. */
export type RoutineTrigger =
  | { kind: 'interval'; /** Run every N minutes (min 1). */ minutes: number }
  | {
      kind: 'cron';
      /** Minimal 5-field cron: `minute hour day month weekday`. */
      expression: string;
    }
  | { kind: 'webhook'; /** Webhook key id in the Vault (routine id). */ keyId: string }
  | { kind: 'event'; /** Named harness event, e.g. `agent-done`. */ event: string }
  | { kind: 'manual' };

/** What a routine does when it fires. */
export type RoutineAction =
  | { kind: 'run-agent'; botId: string; prompt: string }
  | { kind: 'run-tool'; tool: string; args?: Record<string, unknown> }
  | { kind: 'notify'; message: string };

/**
 * A routine v2: a named, schedulable unit of work. Compared with v1
 * automations it adds an explicit trigger queue, per-run status and
 * retry with backoff — the scheduler never runs two copies of the
 * same routine at once and never fires a catch-up burst after the
 * app was off (missed runs are recorded as `skipped`).
 */
export interface Routine {
  id: string;
  /** Bot this routine belongs to ('' = global). */
  botId: string;
  name: string;
  description?: string;
  trigger: RoutineTrigger;
  action: RoutineAction;
  enabled: boolean;
  /** Max attempts per run including the first (1 = no retry). Default 3. */
  maxAttempts?: number;
  /** Base backoff between attempts in ms (exponential: base * 2^n). Default 5000. */
  retryBackoffMs?: number;
  /** Max queued (not yet started) runs; further triggers drop with a log. Default 10. */
  maxQueuedRuns?: number;
  /** ISO timestamp of the last run attempt, or null. */
  lastRunAt?: string | null;
  /** ISO timestamp of the next scheduled run (schedule triggers only). */
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-run status of a routine run. */
export type RoutineRunStatus =
  | 'queued'
  | 'running'
  | 'ok'
  | 'error'
  | 'skipped'
  | 'retrying';

/** One execution of a routine (one queue item, possibly retried). */
export interface RoutineRun {
  id: string;
  routineId: string;
  /** Source that enqueued the run: schedule tick, webhook, event, manual, retry. */
  source: 'schedule' | 'webhook' | 'event' | 'manual' | 'retry';
  status: RoutineRunStatus;
  /** Attempt number (1-based). */
  attempt: number;
  /** Max attempts for this run (copied from the routine at enqueue time). */
  maxAttempts: number;
  /** ISO timestamp when the run was enqueued. */
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** ISO timestamp of the next retry attempt (only while `retrying`). */
  nextRetryAt?: string;
  /** Action output (truncated) or the skip/error reason. */
  output?: string;
  error?: string;
  /** Sanitized trigger input JSON (truncated); never contains secrets. */
  triggerInput?: string;
  /** Id of the run this run retries, if any. */
  retriedFromRunId?: string;
}

/** One queued trigger waiting for a worker slot. */
export interface RoutineQueueItem {
  run: RoutineRun;
  /** Trigger input for the run (sanitized copy, not persisted raw). */
  input?: unknown;
}

/** Snapshot of a routine's queue (for UI + CLI). */
export interface RoutineQueueStatus {
  routineId: string;
  queued: number;
  running: boolean;
  /** Ids of queued runs, oldest first. */
  queuedRunIds: string[];
}

/**
 * A webhook delivery as seen by the signed receiver. The raw body is
 * never stored (only a short sanitized preview); the secret is never
 * stored or logged — verification happens against the Vault secret
 * supplied by the host at delivery time.
 */
export interface WebhookDelivery {
  id: string;
  /** Routine / automation the delivery targets. */
  targetId: string;
  /** HTTP method + path as received (for the audit log). */
  method: string;
  path: string;
  /** ISO timestamp when the delivery arrived. */
  receivedAt: string;
  /** Outcome of signature verification. */
  verified: boolean;
  /** Why a delivery was rejected (absent when accepted). */
  rejectReason?: string;
  /** Short sanitized preview of the JSON body (max 500 chars). */
  bodyPreview?: string;
  /** Id of the routine run enqueued for an accepted delivery. */
  runId?: string;
  /** HTTP status the receiver answered with. */
  httpStatus: number;
}

/** Receiver statistics (UI + CLI + health). */
export interface WebhookReceiverStats {
  /** Total deliveries seen since the receiver started. */
  total: number;
  accepted: number;
  rejected: number;
  /** Rejections by reason (e.g. `bad-signature`, `missing-secret`). */
  rejectedByReason: Record<string, number>;
  /** ISO timestamp of the last delivery, if any. */
  lastDeliveryAt?: string;
}

/** Health of one bot computer (per-bot, probed in the background). */
export type BotComputerHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** One health probe result for a bot computer. */
export interface BotComputerHealth {
  botId: string;
  /** Computer id / label ('' = the bot's own computer). */
  computerId: string;
  status: BotComputerHealthStatus;
  /** CPU load as 0..1 of one core-equivalent (loadavg / cores), if measurable. */
  cpuLoad?: number;
  /** RAM used as 0..1 of total, if measurable. */
  memoryUsedRatio?: number;
  /** Disk used as 0..1 of the volume, if measurable. */
  diskUsedRatio?: number;
  /** True when the bot process pid (if known) is still alive. */
  processAlive?: boolean;
  /** ISO timestamp of the last heartbeat from the bot process, if any. */
  lastHeartbeatAt?: string;
  /** Milliseconds since the last heartbeat (undefined when never seen). */
  heartbeatAgeMs?: number;
  /** Human-readable reasons for degraded/unhealthy (empty when healthy). */
  reasons: string[];
  /** ISO timestamp of this probe. */
  probedAt: string;
  /** Probe duration in ms (a slow probe is itself a signal). */
  probeDurationMs: number;
}

/** Thresholds that decide healthy / degraded / unhealthy. */
export interface BotComputerHealthThresholds {
  /** CPU load above this is degraded. Default 0.85. */
  cpuDegradedAt?: number;
  /** CPU load above this is unhealthy. Default 0.97. */
  cpuUnhealthyAt?: number;
  /** Memory ratio above this is degraded. Default 0.9. */
  memoryDegradedAt?: number;
  /** Memory ratio above this is unhealthy. Default 0.97. */
  memoryUnhealthyAt?: number;
  /** Disk ratio above this is degraded. Default 0.9. */
  diskDegradedAt?: number;
  /** Disk ratio above this is unhealthy. Default 0.97. */
  diskUnhealthyAt?: number;
  /** Heartbeat older than this is degraded. Default 60_000 ms. */
  heartbeatDegradedAfterMs?: number;
  /** Heartbeat older than this is unhealthy. Default 300_000 ms. */
  heartbeatUnhealthyAfterMs?: number;
  /** Probe slower than this is degraded. Default 5_000 ms. */
  slowProbeDegradedAfterMs?: number;
}

/** A headless CI-style job file (`open-bot run --job job.json`). */
export interface HeadlessJobFile {
  /** Job file version (currently 1). */
  version: 1;
  /** Human-readable job name (for logs / NDJSON). */
  name?: string;
  /** Existing bot id (or name) from `<dataDir>/bots.json`. */
  bot?: string;
  /** Temporary provider + model (used when `bot` is absent). */
  provider?: string;
  model?: string;
  /** Prompt to run. Required unless `imageFiles` is non-empty. */
  prompt?: string;
  /** Workspace-relative or absolute image files (max 5). */
  imageFiles?: string[];
  /** Run timeout in ms (default 300_000). */
  timeoutMs?: number;
  /** Auto-approve tool calls in this run (default false, fail-closed). */
  autoApprove?: boolean;
  /** Emit NDJSON events to stdout as the run progresses (default false). */
  ndjson?: boolean;
  /** Write the NDJSON event stream to this file as well. */
  ndjsonFile?: string;
  /** Routine id to record this job against (optional, audit only). */
  routineId?: string;
}

/** Result of one headless job run. */
export interface HeadlessJobResult {
  jobName?: string;
  botId: string;
  botName: string;
  text: string;
  stopped: boolean;
  runId: string;
  /** True when the run stopped because an approval was denied headless. */
  approvalDenied: boolean;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
  /** Process exit code for this result (0 ok, 2 run error, 3 approval denied). */
  exitCode: 0 | 2 | 3;
  /** Number of NDJSON events emitted for this run. */
  eventsEmitted: number;
}

/**
 * Exit codes for headless runs (shared by the core runner and the
 * CLI so both agree): 0 = done, 1 = usage / config error, 2 = run
 * error, 3 = approval denied headless.
 */
export const HEADLESS_EXIT_OK = 0;
export const HEADLESS_EXIT_USAGE = 1;
export const HEADLESS_EXIT_RUN_ERROR = 2;
export const HEADLESS_EXIT_APPROVAL_DENIED = 3;

/** Default webhook receiver port (loopback only). */
export const HARNESS_V2_WEBHOOK_DEFAULT_PORT = 8800;
/** Default harness v2 NDJSON file name (per thread, under the log dir). */
export const HARNESS_V2_NDJSON_FILE = 'harness-v2.ndjson';
/** Default routines store file name (under the state dir). */
export const ROUTINES_FILE = 'routines-v2.json';
/** Default webhook delivery log file name (under the state dir). */
export const WEBHOOK_DELIVERIES_FILE = 'webhook-deliveries-v2.ndjson';
