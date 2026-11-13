/**
 * IPC validation — public surface of packages/core/src/ipc/ (v0.7).
 */
export {
  isRecord,
  requireBase64,
  requireBoolean,
  requireHttpUrl,
  requireWsUrl,
  requireId,
  requireInt,
  requireString,
  requireStringArray,
  requireText,
  optionalString,
  resolveWithin,
  validateWorkspaceDir,
  HARNESS_EVENT_KINDS,
  parseHarnessThreadLogParams,
  MAX_BASE64_CHARS,
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  MAX_TEXT_CHARS,
  MAX_URL_CHARS,
} from './validate';
