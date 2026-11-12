/**
 * Detected CLI engines (M1) — public surface of packages/core/src/detected/.
 *
 * Registry phát hiện CLI agent trên máy user (Claude Code, Codex, Grok,
 * OpenCode, Gemini CLI, Cursor CLI) để mượn model/tài khoản đăng nhập
 * sẵn của chúng. Xem README.md trong thư mục này.
 */
export { DetectedEngineRegistry, DETECT_CACHE_TTL_MS, DETECTED_ENGINES_FILE, KNOWN_ENGINE_KINDS } from './registry';
export type { DetectedEngineRegistryOptions } from './registry';
export { isEngineUsable, isEngineUsableAllowingUnknown, usableCustomEngineBinary, usableEngineBinary } from './visibility';
export { BUILTIN_DETECTORS } from './definitions';
export {
  CUSTOM_ACP_KIND_PREFIX,
  customAcpDetectorDefinition,
  customAcpIdFromKind,
  customAcpKind,
  isCustomAcpKind,
  validateCustomAcpCliConfig,
} from './custom';
export type {
  AuthCheck,
  CustomAcpCliConfig,
  DetectedEngineKind,
  DetectedEngineSnapshot,
  DetectedEnginesSnapshot,
  DetectedEnginesStateFile,
  DetectorDefinition,
  EngineAccount,
  EngineStatus,
  EngineUnavailableReason,
  ProbeResult,
} from './types';
export {
  AUTH_PROBE_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  compareVersions,
  findOnPath,
  meetsMinVersion,
  parseVersion,
  runProbe,
  truncateText,
} from './probe';
