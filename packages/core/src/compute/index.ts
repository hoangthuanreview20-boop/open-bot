/**
 * Máy tính riêng cho từng bot — public surface của
 * `packages/core/src/compute/` (sóng B, đội platform).
 *
 * - probe.ts: dò cấu hình máy thật (CPU/RAM/đĩa/OS/ảo hoá/GPU/mạng).
 * - planner.ts: chia tài nguyên (thuần, không I/O) — luôn chừa headroom
 *   cho host, chọn mức cách ly theo sức máy.
 * - runtime.ts: thang cách ly + vòng đời máy-tính-bot (box -> container
 *   -> VM), backend detect, QEMU boot, giảm tải khi host bận.
 * - cgroup.ts (v0.78): enforce RAM vật lý thật bằng cgroup v2
 *   (`memory.max`) cho mức box/container; VM không dùng cgroup (RAM
 *   của VM đã bị chặn bởi QEMU `-m`).
 * - guestAgent.ts + guest-agent.mjs (v0.78): host<->guest NDJSON qua
 *   Unix socket của QEMU virtio-serial — chạy lệnh trong VM.
 * - scheduler.ts (v0.90c, đội G gói C): hàng đợi chờ khi hết chỗ +
 *   thử lại khi rảnh + chọn máy tự giảm tải (opt-in).
 * Xem types.ts (nguyên tắc trung thực) và docs/team-b-platform.md.
 */
export { DEFAULT_PLANNER_POLICY, GB, LEVEL_DEFAULTS, isHostBusy, levelFeasible, planComputers, resolvePlannerPolicy, suggestShedOrder } from './planner';
export { probeMachine, fakeMachineProfile } from './probe';
export type { ProbeCommandResult, ProbeDeps } from './probe';
export { BotComputerRuntime, COMPUTERS_FILE, DEFAULT_COMPUTER_MAX_PROCESSES, buildQemuBootArgs, detectComputerBackends } from './runtime';
export type { BotComputerRuntimeOptions } from './runtime';
export {
  CGROUP_MIN_MEMORY_BYTES,
  CGROUP_NAME_PREFIX,
  CGROUP_ROOT_DEFAULT,
  CgroupMemoryLimiter,
  probeCgroupMemory,
} from './cgroup';
export type { CgroupMemoryLimiterOptions, CgroupMemoryProbe } from './cgroup';
export {
  GUEST_AGENT_DEFAULT_TIMEOUT_MS,
  GUEST_AGENT_MAX_OUTPUT_BYTES,
  GUEST_AGENT_MAX_RECONNECT_ATTEMPTS,
  GUEST_AGENT_PING_TIMEOUT_MS,
  GUEST_AGENT_PORT_NAME,
  GUEST_AGENT_RECONNECT_DELAY_MS,
  GUEST_AGENT_VERSION,
  GuestAgentClient,
} from './guestAgent';
export type { GuestAgentExecOptions, GuestAgentExecResult, GuestAgentInfo, GuestAgentPingResult } from './guestAgent';
export {
  COMPUTER_AUTO_SHED_AUDIT_ACTION,
  DEFAULT_COMPUTER_PRIORITY,
  MAX_QUEUE_ENTRIES,
  clampPriority,
  emptySchedulerState,
  enqueueRequest,
  parseSchedulerState,
  removeFromQueue,
  selectAutoShedCandidates,
  setQueuePriority,
  sortQueueEntries,
  tryPromoteQueue,
} from './scheduler';
export { GUEST_AGENT_INSTALL_HINT, GUEST_HEALTH_CHECK_MIN_INTERVAL_MS } from './runtime';
export type {
  BotComputer,
  BotComputerRequest,
  ComputerAllocation,
  ComputerBackend,
  ComputerBackendKind,
  ComputerLevel,
  ComputerPlan,
  ComputerQueueEntry,
  ComputerSchedulerState,
  ComputerState,
  ComputerStatusView,
  CpuInfo,
  DiskInfo,
  GpuInfo,
  GuestAgentHealth,
  GuestAgentHealthStatus,
  MachineProfile,
  MemoryInfo,
  NetworkInfo,
  PlannerPolicy,
  ProbeOs,
  SchedulerTickResult,
  VirtualizationInfo,
} from './types';
