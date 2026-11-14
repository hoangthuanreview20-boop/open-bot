/**
 * Tầng fleet đa người dùng — public surface của
 * `packages/core/src/fleet/` (đội D).
 *
 * - registry.ts: đăng ký workspace (`fleet.json`, atomic).
 * - audit.ts: audit chuỗi hash (`fleet.jsonl`) + decision log
 *   (`decisions.jsonl`).
 * - capacity.ts: kiểm tra sức chứa máy (tái dùng probe/planner
 *   của compute — luôn chừa headroom cho host).
 * - isolation.ts: cô lập đường dẫn/vault/OS user (fail-closed).
 * - service.ts + serviceWorker.ts: vòng đời service theo workspace
 *   (chỉ bind 127.0.0.1, health check cần token trong bộ nhớ).
 * - usage.ts: usage ledger (`usage.jsonl`) + đo CPU/RAM/đĩa thật.
 * - manager.ts: FleetManager điều phối toàn bộ.
 * Xem types.ts (nguyên tắc trung thực) và docs/fleet.md.
 */
export {
  FLEET_AUDIT_FILE,
  FLEET_DECISIONS_FILE,
  appendFleetAuditEvent,
  appendFleetDecision,
  getFleetAuditPath,
  getFleetDecisionsPath,
  listFleetAuditEvents,
  listFleetDecisions,
  readFleetAuditEvents,
  readFleetDecisions,
  verifyFleetAuditLog,
  verifyFleetDecisionLog,
} from './audit';
export { checkFleetCapacity, sumAllocatedFleetResources } from './capacity';
export {
  FLEET_AUTO_PORT_MAX,
  FLEET_AUTO_PORT_MIN,
  FLEET_MIN_CPU_CORES,
  FLEET_MIN_DISK_BYTES,
  FLEET_MIN_RAM_BYTES,
  FLEET_REGISTRY_FILE,
  createFleetWorkspace,
  findFleetWorkspace,
  getFleetRegistryPath,
  loadFleetWorkspaces,
  pickFreePort,
  removeFleetWorkspace,
  renameFleetWorkspace,
  saveFleetWorkspaces,
  setFleetWorkspaceStatus,
  updateFleetWorkspace,
  validateFleetWorkspace,
  validateFleetWorkspaces,
} from './registry';
export {
  assertWorkspaceRootInsideFleet,
  currentOsUser,
  fleetVaultKey,
  fleetVaultNamespace,
  getOsUserUid,
  isRunningPrivileged,
  probeOsUser,
  readWorkspaceFile,
  resolveIsolationLevel,
  resolveFleetWorkspacePath,
  writeWorkspaceFile,
} from './isolation';
export { FleetManager } from './manager';
export type { FleetManagerOptions } from './manager';
export {
  FLEET_SERVICE_HEALTH_TIMEOUT_MS,
  FLEET_SERVICE_MAX_RESTARTS,
  FLEET_SERVICE_READY_TIMEOUT_MS,
  FLEET_SERVICE_RESTART_BACKOFF_MS,
  FLEET_SERVICE_STOP_TIMEOUT_MS,
  FleetServiceManager,
} from './service';
export type { FleetServiceManagerOptions, FleetServiceStatus } from './service';
export type {
  CreateFleetWorkspaceInput,
  FleetCapacityCheck,
  FleetCapacityPolicy,
  FleetDecision,
  FleetIsolationLevel,
  FleetMember,
  FleetRole,
  FleetServiceState,
  FleetStatusView,
  FleetUsageSample,
  FleetUsageSummary,
  FleetWorkspace,
  FleetWorkspaceStatus,
  NewFleetDecisionInput,
} from './types';
export { FLEET_ROLES } from './types';
export {
  FLEET_CONSOLE_ACTIONS,
  FLEET_CONSOLE_PERMISSIONS,
  FLEET_CONSOLE_ROLES,
  FLEET_CONSOLE_USERS_FILE,
  FleetConsole,
  assertCanPerform,
  buildFleetBotOverview,
  canPerform,
  getFleetConsoleUsersPath,
  loadFleetConsoleUsers,
  saveFleetConsoleUsers,
  validateFleetConsoleUser,
} from './console';
export type {
  AddFleetConsoleUserInput,
  FleetBotOverview,
  FleetConsoleAction,
  FleetConsoleRole,
  FleetConsoleUser,
} from './console';
export {
  FLEET_QUOTAS_FILE,
  QUOTA_DEFAULT_WARN_PERCENT,
  QUOTA_MAX_ALERTS,
  checkBotQuotas,
  cpuRateFromSamples,
  evaluateBotQuota,
  getBotQuota,
  getFleetQuotasPath,
  loadBotQuotas,
  removeBotQuota,
  saveBotQuotas,
  setBotQuota,
  summarizeBotUsage,
  validateBotQuota,
} from './quotas';
export type {
  BotQuota,
  BotUsageSnapshot,
  BotUsageStats,
  QuotaAlert,
  QuotaEvaluation,
  QuotaLevel,
  QuotaResource,
  QuotaResourceStatus,
  SetBotQuotaInput,
} from './quotas';
export {
  USAGE_DISK_MAX_FILES,
  USAGE_FILE,
  USAGE_MAX_SAMPLES_PER_WORKSPACE,
  getUsagePath,
  measureDiskUsage,
  measureProcessUsage,
  measureWorkspaceUsage,
  pruneUsageLedger,
  readUsageSamples,
  readUsageSamplesFor,
  recordUsageSample,
  summarizeUsage,
  validateUsageSample,
} from './usage';
