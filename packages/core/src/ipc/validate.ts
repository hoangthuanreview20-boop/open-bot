/**
 * IPC input validation (v0.7, ROADMAP §2a: "IPC kênh hẹp có kiểm chứng").
 *
 * Pure functions, no Electron import: the main process calls them at
 * the top of every ipcMain.handle/on handler, and the unit tests
 * exercise them directly (an Electron main process cannot run under
 * node:test). Every validator throws a clear Error on bad input —
 * handlers surface that message to the renderer, never a stack trace.
 *
 * Limits are deliberately small: IPC payloads are UI-driven, so a
 * multi-KB string or a path escaping the allowed roots is never
 * legitimate input from the renderer.
 */
import * as path from 'node:path';

export const MAX_ID_CHARS = 128;
export const MAX_NAME_CHARS = 200;
export const MAX_TEXT_CHARS = 200_000;
export const MAX_URL_CHARS = 2048;
export const MAX_BASE64_CHARS = 33_554_432; // ~25 MB of audio bytes

/** IDs the app itself generates: uuids, `sa-<uuid>`, short slugs. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Require a non-empty string within `max` chars; returns the trimmed value. */
export function requireString(value: unknown, what: string, max = MAX_NAME_CHARS): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Tham số "${what}" phải là chuỗi không rỗng.`);
  }
  if (value.length > max) {
    throw new Error(`Tham số "${what}" quá dài (tối đa ${max} ký tự).`);
  }
  return value.trim();
}

/** Optional string: '' / null / undefined -> undefined; otherwise validated. */
export function optionalString(value: unknown, what: string, max = MAX_NAME_CHARS): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, what, max);
}

/** Require a string matching the app id shape (bot id, member id, ...). */
export function requireId(value: unknown, what = 'id'): string {
  const s = requireString(value, what, MAX_ID_CHARS);
  if (!ID_RE.test(s)) {
    throw new Error(`Tham số "${what}" không hợp lệ: chỉ gồm chữ, số, ".", "_" và "-".`);
  }
  return s;
}

/** Chat / prompt text: non-empty, capped so one IPC call cannot flood memory. */
export function requireText(value: unknown, what = 'text'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Tham số "${what}" không được để trống.`);
  }
  if (value.length > MAX_TEXT_CHARS) {
    throw new Error(`Tham số "${what}" quá dài (tối đa ${MAX_TEXT_CHARS} ký tự).`);
  }
  return value;
}

/** Require a boolean (accepts only a real boolean, never 0/1/"true"). */
export function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Tham số "${what}" phải là true/false.`);
  }
  return value;
}

/** Require an integer inside [min, max] (ports, limits, ...). */
export function requireInt(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Tham số "${what}" phải là số nguyên từ ${min} đến ${max}.`);
  }
  return value;
}

/**
 * Require an array of non-empty strings (e.g. command args from the
 * renderer). `undefined`/`null` means "not provided" and returns
 * undefined so the caller can keep its default; an empty array is a
 * real value (explicitly no args). Every item is trimmed; the count
 * and each item are capped so one IPC call cannot flood memory.
 */
export function requireStringArray(
  value: unknown,
  what: string,
  maxItems = 64,
  maxItemChars = 1000,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Tham số "${what}" phải là một mảng chuỗi.`);
  }
  if (value.length > maxItems) {
    throw new Error(`Tham số "${what}" quá dài (tối đa ${maxItems} mục).`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`Tham số "${what}"[${i}] phải là chuỗi không rỗng.`);
    }
    if (item.length > maxItemChars) {
      throw new Error(`Tham số "${what}"[${i}] quá dài (tối đa ${maxItemChars} ký tự).`);
    }
    return item.trim();
  });
}

/** Require a http(s) URL within the length cap. */
export function requireHttpUrl(value: unknown, what = 'url'): string {
  const s = requireString(value, what, MAX_URL_CHARS);
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`Tham số "${what}" không phải URL hợp lệ.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Tham số "${what}" phải bắt đầu bằng http:// hoặc https://.`);
  }
  return s;
}

/**
 * Require a ws(s) URL within the length cap (v0.95, Đội D3).
 * Realtime endpoints are WebSockets (`wss://api.openai.com/...`,
 * `wss://generativelanguage.googleapis.com/...`) — `requireHttpUrl`
 * rejects them, so `realtimeUrl` in settings is validated with
 * this instead. Plain `ws://` is allowed for local realtime
 * endpoints (e.g. a local OpenAI-compatible realtime server).
 */
export function requireWsUrl(value: unknown, what = 'url'): string {
  const s = requireString(value, what, MAX_URL_CHARS);
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`Tham số "${what}" không phải URL hợp lệ.`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Tham số "${what}" phải bắt đầu bằng ws:// hoặc wss://.`);
  }
  return s;
}

/**
 * Resolve `target` against the allowed roots and reject anything that
 * escapes them (`..`, absolute paths outside the roots, symlinks are
 * NOT resolved here — the caller checks existence separately).
 * Returns the absolute, normalized path inside one of the roots.
 */
export function resolveWithin(roots: string[], target: string, what = 'path'): string {
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new Error(`Tham số "${what}" phải là đường dẫn không rỗng.`);
  }
  if (target.length > 4096) {
    throw new Error(`Tham số "${what}" quá dài.`);
  }
  const resolved = path.resolve(target);
  for (const root of roots) {
    const base = path.resolve(root);
    if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  }
  throw new Error(`Đường dẫn "${what}" nằm ngoài thư mục cho phép.`);
}

/**
 * Validate a workspace dir supplied by the renderer: empty means
 * "use the app default"; otherwise it must resolve inside one of the
 * allowed roots (normally userData, plus an explicit workspaces dir).
 */
export function validateWorkspaceDir(
  value: unknown,
  roots: string[],
): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new Error('Tham số "workspaceDir" phải là chuỗi.');
  }
  return resolveWithin(roots, value.trim(), 'workspaceDir');
}

/** Validate a base64 payload (voice audio): charset + size cap, no decode. */
export function requireBase64(value: unknown, what = 'audioBase64'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tham số "${what}" không được để trống.`);
  }
  if (value.length > MAX_BASE64_CHARS) {
    throw new Error(`Tham số "${what}" quá lớn (tối đa ~25 MB).`);
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    throw new Error(`Tham số "${what}" không phải base64 hợp lệ.`);
  }
  return value;
}

/**
 * v0.90a (Đội G): mọi kind event harness (bus + NDJSON log + SSE).
 * Đồng bộ với `HarnessEventKind` (packages/core/src/harness/types.ts)
 * — giữ danh sách ở đây (validate.ts, pure) để cả IPC main, Local API
 * server và test đều dùng chung một nguồn thay vì hard-code riêng lẻ.
 */
export const HARNESS_EVENT_KINDS: readonly string[] = [
  'text',
  'tool_call',
  'result',
  'error',
  'abort',
  'approval_request',
  'approval_denied',
  'permission_request',
  'permission_denied',
  'approval_decision',
  'lifecycle',
  'router.decision',
  // v0.97 (Team T5): harness v2 kinds — keep in sync with
  // HARNESS_V2_EVENT_KINDS (packages/core/src/harness/v2/types.ts).
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
 * v0.90a (Đội G): parse + validate params IPC `harness:thread-log`
 * (main gọi ở đầu handler; test gọi trực tiếp — main process Electron
 * không chạy được dưới node:test). `limit` mặc định 100, kẹp 1..1000
 * (khớp ThreadLog.read); `offset` mặc định 0; `kinds` vắng → không lọc,
 * có thì mỗi kind phải nằm trong HARNESS_EVENT_KINDS.
 */
export function parseHarnessThreadLogParams(payload: unknown): {
  threadId: string;
  limit: number;
  offset: number;
  kinds?: string[];
} {
  if (!isRecord(payload)) {
    throw new Error('Tham số "harness:thread-log" phải là object.');
  }
  const threadId = requireString(payload['threadId'], 'threadId', MAX_ID_CHARS);
  const limit =
    payload['limit'] === undefined ? 100 : requireInt(payload['limit'], 'limit', 1, 1000);
  const offset =
    payload['offset'] === undefined ? 0 : requireInt(payload['offset'], 'offset', 0, 1_000_000);
  const kinds = requireStringArray(payload['kinds'], 'kinds', HARNESS_EVENT_KINDS.length, 32);
  if (kinds !== undefined) {
    for (const kind of kinds) {
      if (!HARNESS_EVENT_KINDS.includes(kind)) {
        throw new Error(`Tham số "kinds" chứa kind không hợp lệ: ${kind}.`);
      }
    }
  }
  return {
    threadId,
    limit,
    offset,
    ...(kinds !== undefined ? { kinds } : {}),
  };
}
