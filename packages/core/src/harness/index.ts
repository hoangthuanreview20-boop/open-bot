/**
 * Harness local chuẩn hoá (M5) — public surface of packages/core/src/harness/.
 *
 * Registry instance → process sống, event bus fan-in về một event
 * chuẩn, NDJSON log theo thread, snapshot engine ghi atomic, permission
 * broker fail-closed. Xem README.md trong thư mục này.
 */
export { HarnessEventBus, harnessKindOfCliEvent, harnessPayloadOfCliEvent } from './bus';
export type { HarnessEventFilter, HarnessEventHandler } from './bus';
export { PermissionBroker, PERMISSION_DEFAULT_TIMEOUT_MS } from './broker';
export type { PermissionBrokerOptions, PermissionRequestInput } from './broker';
export { LocalHarness } from './harness';
export type { HarnessAttachableProvider, LocalHarnessOptions } from './harness';
export { ThreadLog, safeThreadFileName, sanitizeHarnessPayload, HARNESS_LOG_STRING_LIMIT } from './ndjson';
export type { ThreadLogOptions } from './ndjson';
export { HarnessRegistry } from './registry';
export type { HarnessShutdownResult, RegisterInstanceOptions } from './registry';
export {
  HARNESS_SNAPSHOT_FILE_NAME,
  readHarnessSnapshot,
  writeHarnessSnapshotAtomic,
} from './snapshot';
export type { ReadHarnessSnapshotResult } from './snapshot';
export type {
  CliEvent,
  HarnessDecidePermissionResult,
  HarnessEvent,
  HarnessEventKind,
  HarnessInstanceSnapshot,
  HarnessInstanceStatus,
  HarnessPermissionRequest,
  HarnessSnapshotFile,
  HarnessStatusResult,
  HarnessThreadLogResult,
  PermissionDecisionRecord,
  PermissionDecisionSource,
  ThreadLogEntry,
  ThreadLogPage,
} from './types';

// v0.97 (Team T5): harness v2 — signed webhooks, routines v2, headless
// jobs, versioned NDJSON export, per-bot-computer health probe.
export * from './v2/index';
