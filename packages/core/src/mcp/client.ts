/**
 * MCP client — hand-written JSON-RPC 2.0, NO MCP SDK dependency.
 * Only Node stdlib: `node:child_process` (stdio transport) and global
 * `fetch` (streamable-HTTP transport).
 *
 * Transports:
 *  (a) stdio: spawn the server's command, speak newline-delimited
 *      JSON-RPC over stdin/stdout, one JSON object per line.
 *  (b) streamable HTTP: POST each JSON-RPC request to `config.url`
 *      with `config.headers`. After `initialize()` the client also
 *      opens a GET SSE stream (v0.13, `StreamableHttpTransport`) so
 *      server-initiated requests can be answered — responses go back
 *      via POST. The legacy SSE transport (server-sent events over a
 *      long-lived GET) is NOT supported.
 *
 * Limits (v0.9):
 *  - 30s timeout per request.
 *  - No persistent session reuse at this layer — the tools layer pools
 *    clients (see packages/tools/src/mcpTools.ts).
 *  - OAuth: the streamable-HTTP client sends the token from
 *    `config.authProvider` when one is wired (see types.ts); on HTTP
 *    401 it refreshes once and retries the request. Without an
 *    authProvider only a static `Authorization` header from config is
 *    sent. Header values are never logged.
 *  - JSON-RPC errors are surfaced as plain `Error`s with a clear
 *    message; a bad server response never crashes the client.
 *  - Tool execution errors (`isError: true`) are returned as text
 *    (SEP-1303), not thrown — only transport / protocol errors throw.
 *    v0.70 extends the same rule to the other typed methods: a
 *    `-32602` for `tools/list` / `resources/list` returns `[]` and for
 *    `resources/read` returns tool-error text; other codes still throw.
 *  - v0.13 (W5a): server-initiated messages go through `McpDispatcher`
 *    (see mcp/dispatcher.ts) instead of being dropped; `tools/call`
 *    supports progress (`progressToken` in `_meta`,
 *    `notifications/progress` → `onProgress`) and cancellation
 *    (`AbortSignal` → `notifications/cancelled`); `callToolStructured`
 *    returns validated `structuredContent`, tool annotations, icons
 *    and `resource_link` blocks.
 *  - v0.13 (integration): `connectMcp` registers the default dispatcher
 *    handlers (`clientHandlers.ts`: elicitation / roots / sampling) and
 *    advertises only the capabilities those handlers can honour; the
 *    streamable-HTTP client opens a GET SSE stream after `initialize()`
 *    and POSTs answers to server-initiated requests back through it;
 *    on HTTP 401 with a `WWW-Authenticate` scope challenge the client
 *    tries `config.onAuthStepUp` (step-up scope) before the plain refresh.
 *  - v0.40 (P0-4): reconnect theo số liệu `mcp_reconnect_config` của
 *    Grok Bot 0.79.3 (deep-dive §8.2) — `McpReconnectPolicy`:
 *    retry nhanh 5 lần (5s→60s) rồi retry định kỳ (5→30 phút, không
 *    giới hạn), session 404 quá 5 lần thì tombstone, keepalive 5 phút
 *    ± jitter 30s + degraded probe 30s × 3, ổn định 30s thì reset bộ
 *    đếm retry, tool call idle 120s / tổng 60 phút, lỗi kết nối stdio
 *    không retry (đánh dấu `McpError.nonRetryable`).
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpDispatcher } from './dispatcher';
import { buildMcpClientCapabilities, registerDefaultMcpClientHandlers } from './clientHandlers';
import { parseStepUpScope } from './oauth';
import { discoverServer, type ServerDiscoverResult } from './stateless';
import { StreamableHttpTransport } from './transport';
import type {
  McpCallToolOptions,
  McpClient,
  McpContentBlock,
  McpProgressCallback,
  McpProgressNotification,
  McpRequestOptions,
  McpResource,
  McpResourceLink,
  McpServerConfig,
  McpServerInfo,
  McpToolAnnotations,
  McpToolCallResult,
  McpToolDef,
  McpToolIcon,
} from './types';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
/**
 * v0.97 (MCP 2.0): the stateless protocol version (spec 2026-07-28).
 * No `initialize` handshake, no session id — every request carries
 * its own `_meta`. See `stateless.ts` for the full stateless surface.
 */
export const MCP_PROTOCOL_VERSION_2026 = '2026-07-28';
/**
 * Protocol versions this client can speak. The client offers
 * `MCP_PROTOCOL_VERSION` in `initialize`; when the server answers with
 * an older version from this list, the client accepts it and records it
 * as the negotiated version (see `negotiateProtocolVersion`) instead of
 * failing — a server that only knows 2024-11-05 keeps working.
 */
export const MCP_PROTOCOL_VERSIONS_SUPPORTED: readonly string[] = [
  MCP_PROTOCOL_VERSION_2026,
  '2025-11-25',
  '2024-11-05',
];
export const MCP_CLIENT_NAME = 'open-bot';
export const MCP_CLIENT_VERSION = '0.2.0';
export const MCP_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Reconnect / resilience — P0-4, số liệu `mcp_reconnect_config` của Grok
// Bot 0.79.3 (xem docs/rea-grokbot-deep-dive.md §8.2). Đây là CÙNG cơ chế
// reconnect đã có trong repo (GET-stream reconnect của
// `StreamableHttpTransport` + pool ở mcpTools.ts), chỉ mở rộng nó bằng
// config + policy, không viết cơ chế thứ hai.
// ---------------------------------------------------------------------------

/**
 * Cấu hình reconnect / resilience theo đúng số liệu Grok
 * (`mcp_reconnect_config`, đọc tĩnh từ client thật — xem deep-dive §8.2).
 * Mọi giá trị đều có thể override từng phần qua
 * `McpServerConfig.reconnect` (xem `resolveMcpReconnectConfig`).
 */
export interface McpReconnectConfig {
  /** Delay cơ sở của retry nhanh (ms). */
  fastRetryBaseDelayMs: number;
  /** Trần delay của retry nhanh (ms) — backoff mũ, dừng ở trần. */
  fastRetryMaxDelayMs: number;
  /** Số lần retry nhanh tối đa trước khi chuyển sang retry định kỳ. */
  fastRetryMaxAttempts: number;
  /** Delay cơ sở của retry định kỳ (ms). */
  periodicRetryBaseDelayMs: number;
  /** Trần delay của retry định kỳ (ms). */
  periodicRetryMaxDelayMs: number;
  /** Số chu kỳ retry định kỳ tối đa; null = không giới hạn. */
  maxPeriodicCycles: number | null;
  /** Cooldown retry khi app lấy lại focus (ms) — config có sẵn, chưa nối
   *  vào đường live nào (open-bot không có sự kiện focus riêng). */
  focusRetryCooldownMs: number;
  /** Cooldown tối thiểu giữa các lần reconnect inline (ms) — config có
   *  sẵn, chưa nối vào đường live nào (pool chỉ reconnect khi tool gọi). */
  inlineReconnectCooldownMs: number;
  /** Khoảng poll chờ OAuth backend refresh xong (ms) — config có sẵn,
   *  chưa nối vào đường live nào (open-bot refresh token đồng bộ). */
  oauthBackendRefreshHydrationPollIntervalMs: number;
  /** Số lần HTTP 404 liên tiếp của session thì "tombstone" (đánh dấu
   *  chết, dừng retry, tạo session mới thay vì retry vô hạn). */
  streamableHttpSession404TombstoneThreshold: number;
  /** Timeout cho một health/keepalive probe (ms). */
  healthProbeTimeoutMs: number;
  /** Bật timeout có giới hạn cho tool call (idle + tổng). */
  toolCallBoundedTimeoutEnabled: boolean;
  /** Tool call không có tiến độ (progress) quá lâu này thì huỷ (ms). */
  toolCallIdleTimeoutMs: number;
  /** Tool call chạy quá lâu này thì huỷ bất kể tiến độ (ms). */
  toolCallMaxTotalTimeoutMs: number;
  /** Delay giữa các lần probe khi server đang degraded (ms). */
  degradedProbeDelayMs: number;
  /** Số lần probe degraded thất bại liên tiếp thì đánh dấu degraded. */
  maxDegradedProbeFailures: number;
  /** Khoảng giữa các lần keepalive probe (ms). */
  keepaliveProbeDelayMs: number;
  /** Jitter ± cho keepalive (±ms, ngẫu nhiên đều). */
  keepaliveJitterMs: number;
  /** Kết nối phải ổn định liên tục lâu này mới coi là recovered — khi đó
   *  bộ đếm retry nhanh / chu kỳ định kỳ được reset (ms). */
  stabilityThresholdMs: number;
  /** Lỗi kết nối stdio không retry (fail ngay — stdio lỗi thường là
   *  config sai, retry vô ích). */
  stdioConnectFailuresAreNonRetryable: boolean;
}

/**
 * Mặc định = đúng số liệu Grok (`mcp_reconnect_config`):
 * retry nhanh 5 lần (5s→60s), rồi retry định kỳ (5→30 phút, không giới
 * hạn chu kỳ); tool call idle 120s / tổng 60 phút; session 404 quá 5 lần
 * thì tombstone; probe degraded 30s × 3 lần fail; keepalive 5 phút ±
 * jitter 30s; ổn định 30s mới coi là recovered; stdio lỗi không retry.
 */
export const DEFAULT_MCP_RECONNECT_CONFIG: Readonly<McpReconnectConfig> = {
  fastRetryBaseDelayMs: 5_000,
  fastRetryMaxDelayMs: 60_000,
  fastRetryMaxAttempts: 5,
  periodicRetryBaseDelayMs: 5 * 60_000,
  periodicRetryMaxDelayMs: 30 * 60_000,
  maxPeriodicCycles: null,
  focusRetryCooldownMs: 5 * 60_000,
  inlineReconnectCooldownMs: 5 * 60_000,
  oauthBackendRefreshHydrationPollIntervalMs: 500,
  streamableHttpSession404TombstoneThreshold: 5,
  healthProbeTimeoutMs: 10_000,
  toolCallBoundedTimeoutEnabled: true,
  toolCallIdleTimeoutMs: 120_000,
  toolCallMaxTotalTimeoutMs: 60 * 60_000,
  degradedProbeDelayMs: 30_000,
  maxDegradedProbeFailures: 3,
  keepaliveProbeDelayMs: 5 * 60_000,
  keepaliveJitterMs: 30_000,
  stabilityThresholdMs: 30_000,
  stdioConnectFailuresAreNonRetryable: true,
} as const;

/** Gộp config reconnect từng phần của caller lên mặc định (Grok). */
export function resolveMcpReconnectConfig(
  partial?: Partial<McpReconnectConfig>,
): McpReconnectConfig {
  return { ...DEFAULT_MCP_RECONNECT_CONFIG, ...(partial ?? {}) };
}

/** Đồng hồ + random tiêm được — test dùng fake clock/random, code thật dùng mặc định. */
export interface McpReconnectClock {
  now: () => number;
  random: () => number;
}

const DEFAULT_RECONNECT_CLOCK: McpReconnectClock = {
  now: () => Date.now(),
  random: () => Math.random(),
};

/** Snapshot trạng thái reconnect — để diagnostics / UI (không chứa secret). */
export interface McpReconnectState {
  fastAttempts: number;
  periodicCycles: number;
  consecutiveSession404: number;
  degradedProbeFailures: number;
  degraded: boolean;
  tombstoned: boolean;
}

/**
 * State machine reconnect theo config Grok — logic thuần (không I/O),
 * dùng chung cho GET-stream reconnect (qua `StreamableHttpTransport`)
 * và keepalive/degraded probe của HTTP client. Test dùng fake clock
 * + fake random nên không phải chờ thật.
 *
 * - `nextReconnectDelayMs()`: pha nhanh (backoff mũ base→max, tối đa
 *   N lần) rồi pha định kỳ (backoff mũ base→max, không giới hạn chu kỳ
 *   khi `maxPeriodicCycles` là null). Trả -1 khi đã hết chu kỳ định kỳ
 *   cho phép (chỉ khi `maxPeriodicCycles` là số).
 * - `recordSession404()`: đếm 404 liên tiếp; trả true khi chạm ngưỡng
 *   tombstone (dừng retry, session coi như chết).
 * - `nextKeepaliveDelayMs()`: keepalive base ± jitter đều.
 * - `recordDegradedProbeFailure/Success()`: đếm probe fail liên tiếp.
 * - `recordStable()`: khi kết nối ổn định liên tục quá
 *   `stabilityThresholdMs` thì reset bộ đếm retry (recovered).
 */
export class McpReconnectPolicy {
  private readonly config: McpReconnectConfig;
  private readonly clock: McpReconnectClock;
  private fastAttempts = 0;
  private periodicCycles = 0;
  private consecutiveSession404 = 0;
  private degradedProbeFailures = 0;
  private stableSinceMs: number | null = null;

  constructor(config: McpReconnectConfig = DEFAULT_MCP_RECONNECT_CONFIG, clock: McpReconnectClock = DEFAULT_RECONNECT_CLOCK) {
    this.config = config;
    this.clock = clock;
  }

  /** Config đang dùng (bản sao). */
  getConfig(): McpReconnectConfig {
    return { ...this.config };
  }

  /** Delay cho lần reconnect tiếp theo (ms); -1 = hết lượt, dừng retry. */
  nextReconnectDelayMs(): number {
    if (this.fastAttempts < this.config.fastRetryMaxAttempts) {
      const delay = Math.min(
        this.config.fastRetryBaseDelayMs * 2 ** this.fastAttempts,
        this.config.fastRetryMaxDelayMs,
      );
      this.fastAttempts += 1;
      return delay;
    }
    if (
      this.config.maxPeriodicCycles !== null &&
      this.periodicCycles >= this.config.maxPeriodicCycles
    ) {
      return -1;
    }
    const delay = Math.min(
      this.config.periodicRetryBaseDelayMs * 2 ** this.periodicCycles,
      this.config.periodicRetryMaxDelayMs,
    );
    this.periodicCycles += 1;
    return delay;
  }

  /** Đang ở pha retry định kỳ (đã hết lượt nhanh) chưa. */
  isInPeriodicPhase(): boolean {
    return this.fastAttempts >= this.config.fastRetryMaxAttempts;
  }

  /**
   * Ghi nhận một lần session 404. Trả true khi chạm ngưỡng tombstone
   * (dừng retry, session chết) — false nghĩa là vẫn được retry.
   */
  recordSession404(): boolean {
    this.consecutiveSession404 += 1;
    return this.consecutiveSession404 >= this.config.streamableHttpSession404TombstoneThreshold;
  }

  /** Session còn sống (mở stream / nhận message thành công): reset đếm 404. */
  recordSessionOk(): void {
    this.consecutiveSession404 = 0;
  }

  /** Session đã tombstone (đủ 404 liên tiếp) chưa. */
  isTombstoned(): boolean {
    return this.consecutiveSession404 >= this.config.streamableHttpSession404TombstoneThreshold;
  }

  /** Delay keepalive tiếp theo: base ± jitter đều (kẹp tối thiểu 0). */
  nextKeepaliveDelayMs(): number {
    const jitter = (this.clock.random() * 2 - 1) * this.config.keepaliveJitterMs;
    return Math.max(0, this.config.keepaliveProbeDelayMs + jitter);
  }

  /**
   * Ghi nhận một lần probe degraded thất bại. Trả true khi chạm ngưỡng
   * degraded (đủ lần fail liên tiếp).
   */
  recordDegradedProbeFailure(): boolean {
    this.degradedProbeFailures += 1;
    return this.degradedProbeFailures >= this.config.maxDegradedProbeFailures;
  }

  /** Probe thành công: reset đếm fail degraded. */
  recordDegradedProbeSuccess(): void {
    this.degradedProbeFailures = 0;
  }

  /** Server đang degraded (đủ lần probe fail liên tiếp) chưa. */
  isDegraded(): boolean {
    return this.degradedProbeFailures >= this.config.maxDegradedProbeFailures;
  }

  /**
   * Đánh dấu thời điểm kết nối bắt đầu ổn định trở lại. Khi đã ổn định
   * liên tục quá `stabilityThresholdMs` thì reset bộ đếm retry nhanh /
   * chu kỳ định kỳ (recovered) và trả true; chưa đủ lâu thì false.
   */
  recordStable(): boolean {
    const now = this.clock.now();
    if (this.stableSinceMs === null) {
      this.stableSinceMs = now;
      return false;
    }
    if (now - this.stableSinceMs < this.config.stabilityThresholdMs) return false;
    this.fastAttempts = 0;
    this.periodicCycles = 0;
    this.stableSinceMs = now;
    return true;
  }

  /** Kết nối vừa đứt / vừa fail: mốc ổn định tính lại từ đầu. */
  noteInstability(): void {
    this.stableSinceMs = null;
  }

  /** Reset toàn bộ trạng thái (vd tạo session mới sau tombstone). */
  reset(): void {
    this.fastAttempts = 0;
    this.periodicCycles = 0;
    this.consecutiveSession404 = 0;
    this.degradedProbeFailures = 0;
    this.stableSinceMs = null;
  }

  /** Snapshot trạng thái (diagnostics / UI). */
  snapshot(): McpReconnectState {
    return {
      fastAttempts: this.fastAttempts,
      periodicCycles: this.periodicCycles,
      consecutiveSession404: this.consecutiveSession404,
      degradedProbeFailures: this.degradedProbeFailures,
      degraded: this.isDegraded(),
      tombstoned: this.isTombstoned(),
    };
  }
}

/**
 * Capabilities this client honestly offers the server in `initialize`
 * when the caller wires no `clientHandlers` (MCP 2025-11-25). The
 * client initiates every request and answers no server-initiated
 * request on its own — sampling / elicitation / roots are honoured
 * only when `clientHandlers` are wired (v0.13), so nothing is claimed
 * beyond the `experimental` marker here. When `clientHandlers` ARE
 * wired, `connectMcp` advertises the capabilities matching the real
 * handlers instead (see `buildMcpClientCapabilities` in
 * clientHandlers.ts). Never claim a capability the client cannot
 * honour: a server that relies on it would hang waiting for an answer
 * that never comes.
 */
export const MCP_CLIENT_CAPABILITIES: Record<string, unknown> = {
  experimental: {},
};

/**
 * Pick the protocol version to use after `initialize`: the server's
 * version when it is one we support, else the version we requested.
 * A server answering with an unknown (newer) version falls back to our
 * requested version rather than failing the handshake.
 */
export function negotiateProtocolVersion(serverVersion: string | undefined): string {
  if (
    typeof serverVersion === 'string' &&
    (MCP_PROTOCOL_VERSIONS_SUPPORTED as readonly string[]).includes(serverVersion)
  ) {
    return serverVersion;
  }
  return MCP_PROTOCOL_VERSION;
}

export class McpError extends Error {
  readonly code?: number;
  /**
   * Lỗi không nên retry (vd lỗi kết nối stdio — Grok:
   * `stdioConnectFailuresAreNonRetryable`). Pool / caller thấy cờ này
   * thì báo lỗi thẳng, không tự nối lại trong vòng lặp.
   */
  readonly nonRetryable?: boolean;
  constructor(message: string, code?: number, nonRetryable?: boolean) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.nonRetryable = nonRetryable;
  }
}

/** Lý do một tool call có giới hạn bị huỷ (idle / tổng / caller huỷ). */
export type ToolCallAbortReason = 'idle' | 'total' | 'caller';

interface BoundedToolCall {
  /** Signal gộp: caller signal + idle timeout + total timeout. */
  signal: AbortSignal;
  /** Gọi mỗi khi có tiến độ (progress) — reset idle timer. */
  noteActivity: () => void;
  /** Lý do huỷ do timeout gây ra (null khi chưa huỷ / caller huỷ). */
  abortReason: () => ToolCallAbortReason | null;
  /** Dọn timer (gọi khi call xong). */
  cleanup: () => void;
}

/**
 * Timeout có giới hạn cho một tool call (Grok: idle 120s + tổng 60 phút,
 * `toolCallBoundedTimeoutEnabled`). Idle timer reset mỗi khi có progress;
 * total timer là trần tuyệt đối. Khi `enabled` là false hoặc caller đã
 * truyền `timeoutMs` riêng thì chỉ dùng signal của caller (hành vi cũ).
 * Timer đều `unref` nên server treo không giữ process sống.
 */
function startBoundedToolCall(
  options: McpCallToolOptions | undefined,
  config: McpReconnectConfig,
): BoundedToolCall {
  const controller = new AbortController();
  let reason: ToolCallAbortReason | null = null;
  const timers: NodeJS.Timeout[] = [];
  const callerSignal = options?.signal;
  const onCallerAbort = (): void => {
    if (reason === null) reason = 'caller';
    controller.abort();
  };
  // Signal đã abort TRƯỚC khi gọi: event 'abort' không bắn lại nữa nên
  // phải abort controller ngay, không thì request vẫn gửi đi (hồi quy
  // test cancellation "signal đã abort trước").
  if (callerSignal?.aborted) {
    reason = 'caller';
    controller.abort();
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  }
  const totalMs = options?.timeoutMs ?? config.toolCallMaxTotalTimeoutMs;
  const idleMs = config.toolCallIdleTimeoutMs;
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (reason === null) reason = 'idle';
      controller.abort();
    }, idleMs);
    idleTimer.unref?.();
    timers.push(idleTimer);
  };
  if (config.toolCallBoundedTimeoutEnabled && options?.timeoutMs === undefined) {
    // Total timeout là trần tuyệt đối cho cả call (thay cho timeout 30s
    // mặc định của request — tool dài hợp lệ không được chết ở 30s).
    const totalTimer = setTimeout(() => {
      if (reason === null) reason = 'total';
      controller.abort();
    }, totalMs);
    totalTimer.unref?.();
    timers.push(totalTimer);
    armIdle();
  }
  return {
    signal: controller.signal,
    noteActivity: () => {
      if (config.toolCallBoundedTimeoutEnabled && options?.timeoutMs === undefined) armIdle();
    },
    abortReason: () => reason,
    cleanup: () => {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      for (const t of timers) clearTimeout(t);
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}

/**
 * Timeout (ms) truyền xuống `request()` cho một tool call: caller truyền
 * riêng thì tôn trọng; không thì dùng trần tổng của config khi bounded
 * timeout bật, còn không thì mặc định 30s như trước.
 */
function toolCallRequestTimeoutMs(
  options: McpCallToolOptions | undefined,
  config: McpReconnectConfig,
): number {
  if (options?.timeoutMs !== undefined) return options.timeoutMs;
  if (config.toolCallBoundedTimeoutEnabled) return config.toolCallMaxTotalTimeoutMs;
  return MCP_REQUEST_TIMEOUT_MS;
}

interface PreparedToolCall {
  bounded: BoundedToolCall;
  params: Record<string, unknown>;
  progressToken: string | number | undefined;
  timeoutMs: number;
  onProgress: McpProgressCallback | undefined;
}

/**
 * Chuẩn bị một `tools/call` có timeout giới hạn (P0-4): khi bounded
 * timeout bật và caller không truyền `timeoutMs` riêng, client LUÔN gửi
 * `progressToken` (kể cả khi caller không đăng ký `onProgress`) để
 * server báo tiến độ — mỗi progress reset idle timer. Không có token thì
 * server không thể báo tiến độ và tool dài hợp lệ sẽ chết oan ở idle.
 */
function prepareToolCall(
  name: string,
  args: Record<string, unknown>,
  options: McpCallToolOptions | undefined,
  config: McpReconnectConfig,
): PreparedToolCall {
  const bounded = startBoundedToolCall(options, config);
  const trackProgress =
    config.toolCallBoundedTimeoutEnabled && options?.timeoutMs === undefined;
  const onProgress =
    options?.onProgress !== undefined || trackProgress
      ? (n: McpProgressNotification) => {
          bounded.noteActivity();
          options?.onProgress?.(n);
        }
      : undefined;
  const { params, progressToken } = buildCallToolParams(
    name,
    args,
    onProgress ? { ...options, onProgress } : options,
  );
  return {
    bounded,
    params,
    progressToken,
    timeoutMs: toolCallRequestTimeoutMs(options, config),
    onProgress,
  };
}

/** Dịch lỗi abort do timeout (idle / tổng) thành McpError rõ nghĩa. */
function translateBoundedToolCallError(
  err: unknown,
  bounded: BoundedToolCall,
  serverName: string,
  toolName: string,
  config: McpReconnectConfig,
): unknown {
  const reason = bounded.abortReason();
  if (reason === 'idle') {
    return new McpError(
      `MCP tool call "${toolName}" tới "${serverName}" hết thời gian chờ idle ` +
        `(${config.toolCallIdleTimeoutMs}ms không có tiến độ)`,
    );
  }
  if (reason === 'total') {
    return new McpError(
      `MCP tool call "${toolName}" tới "${serverName}" hết thời gian chờ tổng ` +
        `(${config.toolCallMaxTotalTimeoutMs}ms)`,
    );
  }
  return err;
}

/**
 * SEP-1303 follow-up (v0.69d, ghi chú v0.29): khi server trả JSON-RPC
 * `-32602` (invalid params) cho `tools/call` thì đó là lỗi thực thi
 * tool — vd model gọi tool với args sai/thiếu — không phải lỗi protocol.
 * Trả về dạng tool result `isError` để model thấy lý do và sửa args gọi
 * lại, thay vì throw `McpError` làm vỡ cả run. Chỉ áp cho `-32602`;
 * các mã khác (vd `-32601` method không tồn tại, lỗi kết nối, timeout)
 * vẫn throw như cũ. `callTool` (bản string) đã chuyển `isError` thành
 * text `MCP tool error: …` nên cả hai đường gọi đều hưởng.
 *
 * v0.70 (mở rộng): cùng quy tắc áp cho các method typed còn lại của
 * client — `tools/list` / `resources/list` trả `[]`, `resources/read`
 * trả text `MCP tool error: …` — vì đó là lỗi ở tầng tool/list chứ
 * không phải lỗi protocol. `requestJsonRpc` (thô), `ping` và
 * `initialize` KHÔNG đổi: vẫn throw, để adapter (tasks/prompts) và
 * caller tự xử lý mã lỗi.
 *
 * v0.71 (follow-up — đánh đổi ở `tools/list` / `resources/list` đã
 * được ghi ở trên): kiểu trả về là mảng nên message của server không
 * có chỗ chứa — caller chỉ thấy "không có tool/resource", không thấy
 * lý do. Cách sửa KHÔNG phá vỡ kiểu trả về: client báo lý do qua
 * callback optional `McpServerConfig.onWarning` (theo tiền lệ các
 * callback runtime-injected khác trên config: `authProvider`,
 * `onAuthStepUp`) — xem `reportInvalidParamsListWarning` dưới đây.
 * Không dùng `console.*` (core client không có kênh log nào — không
 * có tiền lệ log trong file này) và không đổi kiểu trả về thành
 * `{ items, warning }` (phá vỡ mọi caller). Caller nào không quan
 * tâm thì không truyền callback và hành vi cũ giữ nguyên: `[]`.
 * `resources/read` không cần callback này vì message đã nằm trong
 * text `MCP tool error: …` trả về.
 */
function isInvalidParamsError(err: unknown): err is McpError {
  return err instanceof McpError && err.code === -32602;
}

/** Message của server sau khi bỏ prefix `MCP server "..." error -32602: `. */
function invalidParamsDetail(err: McpError): string {
  return err.message.replace(/^MCP server "[^"]*" error -32602: /, '');
}

/**
 * v0.71 (SEP-1303 follow-up): báo lý do `-32602` của một list call
 * qua `config.onWarning` (nếu caller truyền) rồi trả `[]` như cũ.
 * Gọi ở cả 4 điểm list của 2 transport (stdio + streamable HTTP).
 * Callback được bọc try/catch: một onWarning lỗi không được biến
 * một list `[]` hiền thành throw.
 */
function reportInvalidParamsListWarning(
  config: McpServerConfig,
  method: 'tools/list' | 'resources/list',
  err: McpError,
): void {
  const onWarning = config.onWarning;
  if (typeof onWarning !== 'function') return;
  const detail = invalidParamsDetail(err);
  try {
    onWarning({
      method,
      code: -32602,
      message:
        `MCP server "${config.name}" rejected ${method} ` +
        `(invalid params, code -32602): ${detail}`,
      detail,
    });
  } catch {
    // A failing warning callback must not turn a quiet [] into a throw.
  }
}

function invalidParamsToolCallResult(
  err: unknown,
  serverName: string,
  toolName: string,
): McpToolCallResult | null {
  if (!isInvalidParamsError(err)) return null;
  const detail = invalidParamsDetail(err);
  const text =
    `MCP tool error: server "${serverName}" rejected the call to "${toolName}" ` +
    `(invalid params, code -32602): ${detail} — check the tool arguments and retry.`;
  return {
    text,
    isError: true,
    content: [{ type: 'text', text }],
    structuredContentValid: false,
    resourceLinks: [],
  };
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** One raw HTTP round-trip outcome (status + body + content type + 401 challenge). */
interface HttpOutcome {
  status: number;
  text: string;
  contentType: string;
  /** Raw `WWW-Authenticate` header (null when absent) — for OAuth discovery / step-up. */
  wwwAuthenticate: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new McpError(`MCP server returned a non-object ${what}`);
  return value;
}

/**
 * Merge a `tools/call` result's `content` blocks into plain text.
 * SEP-1303: a tool execution error (`isError: true`) is tool output, not
 * a protocol error — return it as text (prefixed so the model can tell
 * it failed) instead of throwing, so the model can read it and retry
 * with fixed input. Only transport / protocol failures throw.
 */
export function toolResultToText(result: unknown): string {
  const parsed = parseToolCallResult(result);
  if (parsed.isError) return `MCP tool error: ${parsed.text || '(no message)'}`;
  return parsed.text;
}

function contentBlocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content as McpContentBlock[]) {
    if (!isRecord(block)) {
      parts.push(JSON.stringify(block));
      continue;
    }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    } else if (block['type'] === 'resource_link') {
      // Spec 2025-06-18: render as a readable link, not raw JSON.
      const label =
        (typeof block['title'] === 'string' && block['title']) ||
        (typeof block['name'] === 'string' && block['name']) ||
        (typeof block['uri'] === 'string' ? block['uri'] : '');
      const uri = typeof block['uri'] === 'string' ? block['uri'] : '';
      parts.push(uri && label !== uri ? `[resource_link: ${label} (${uri})]` : `[resource_link: ${uri || label}]`);
    } else if (block['type'] === 'resource') {
      // Either a flat `{ type: 'resource', text | uri }` or the spec
      // shape `{ type: 'resource', resource: { uri, text } }`.
      const nested = isRecord(block['resource']) ? block['resource'] : null;
      const text = block['text'] ?? nested?.['text'];
      const uri = block['uri'] ?? nested?.['uri'];
      if (typeof text === 'string') parts.push(text);
      else if (typeof uri === 'string') parts.push(`[resource: ${uri}]`);
      else parts.push(JSON.stringify(block));
    } else if (block['type'] === 'image') {
      parts.push('[image content — not shown as text]');
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join('\n');
}

/**
 * Pull `resource_link` blocks out of a `tools/call` result's content
 * (spec 2025-06-18) so the UI / later tools can render them as links
 * and read them with `resources/read`.
 */
export function extractResourceLinks(content: unknown): McpResourceLink[] {
  if (!Array.isArray(content)) return [];
  const out: McpResourceLink[] = [];
  for (const block of content as unknown[]) {
    if (!isRecord(block) || block['type'] !== 'resource_link') continue;
    if (typeof block['uri'] !== 'string' || typeof block['name'] !== 'string') continue;
    const link: McpResourceLink = { uri: block['uri'], name: block['name'] };
    if (typeof block['title'] === 'string') link.title = block['title'];
    if (typeof block['description'] === 'string') link.description = block['description'];
    if (typeof block['mimeType'] === 'string') link.mimeType = block['mimeType'];
    if (typeof block['size'] === 'number') link.size = block['size'];
    const annotations = parseAnnotations(block['annotations']);
    if (annotations) link.annotations = annotations;
    const icons = parseIcons(block['icons']);
    if (icons) link.icons = icons;
    out.push(link);
  }
  return out;
}

/**
 * Validate a value against a small, documented subset of JSON Schema
 * 2020-12 — enough for MCP `outputSchema` checks without pulling in a
 * validator dependency: `type` (incl. arrays of types), `enum`,
 * `const`, `required`, `properties` (recursive), `items`,
 * `additionalProperties: false`. Anything the subset cannot express
 * is treated as "no constraint" (valid) rather than failing the tool.
 * Returns `{ valid, errors }`; `errors` are Vietnamese, for logs/UI.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  path = '$',
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(schema)) return { valid: true, errors };
  const check = (val: unknown, sch: Record<string, unknown>, at: string): void => {
    const type = sch['type'];
    if (typeof type === 'string') {
      if (!matchesType(val, type)) {
        errors.push(`${at}: kiểu dữ liệu phải là ${type}`);
        return; // no point checking deeper on a type mismatch
      }
    } else if (Array.isArray(type)) {
      if (!type.some((t) => typeof t === 'string' && matchesType(val, t))) {
        errors.push(`${at}: kiểu dữ liệu phải là một trong [${type.join(', ')}]`);
        return;
      }
    }
    if (Array.isArray(sch['enum'])) {
      if (!sch['enum'].some((e) => JSON.stringify(e) === JSON.stringify(val))) {
        errors.push(`${at}: giá trị không nằm trong danh sách cho phép (enum)`);
      }
    }
    if ('const' in sch && JSON.stringify(sch['const']) !== JSON.stringify(val)) {
      errors.push(`${at}: giá trị phải bằng hằng số đã khai báo (const)`);
    }
    if (isRecord(val)) {
      const required = sch['required'];
      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === 'string' && !(key in val)) {
            errors.push(`${at}: thiếu trường bắt buộc "${key}"`);
          }
        }
      }
      const properties = sch['properties'];
      if (isRecord(properties)) {
        for (const [key, sub] of Object.entries(properties)) {
          if (key in val) check(val[key], isRecord(sub) ? sub : {}, `${at}.${key}`);
        }
        if (sch['additionalProperties'] === false) {
          for (const key of Object.keys(val)) {
            if (!(key in properties)) errors.push(`${at}: trường "${key}" không được phép (additionalProperties: false)`);
          }
        }
      }
    }
    if (Array.isArray(val) && sch['items'] !== undefined) {
      const items = sch['items'];
      if (isRecord(items)) {
        val.forEach((item, i) => check(item, items, `${at}[${i}]`));
      } else if (Array.isArray(items)) {
        items.forEach((sub, i) => {
          if (i < val.length) check(val[i], isRecord(sub) ? sub : {}, `${at}[${i}]`);
        });
      }
    }
  };
  check(value, schema, path);
  return { valid: errors.length === 0, errors };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return true; // unknown type name: do not fail the tool on it
  }
}

/**
 * Parse a full `tools/call` result (v0.13, W5a): text + content blocks
 * + validated `structuredContent` + resource links. `outputSchema`
 * comes from `tools/list` (or `options.outputSchema`); without a
 * schema, `structuredContent` is passed through unvalidated. When
 * validation fails, `structuredContent` is dropped and the error is
 * recorded — `text` always stays usable as fallback.
 */
export function parseToolCallResult(result: unknown, outputSchema?: unknown): McpToolCallResult {
  const rec = asRecord(result, 'tools/call result');
  const isError = rec['isError'] === true;
  const contentRaw = rec['content'];
  const content: McpContentBlock[] = Array.isArray(contentRaw)
    ? (contentRaw as McpContentBlock[])
    : [];
  let text = contentBlocksToText(contentRaw);
  if (!text && typeof rec['text'] === 'string') text = rec['text'];
  if (!content.length && typeof rec['text'] !== 'string' && rec['content'] === undefined) {
    text = JSON.stringify(result);
  }
  const out: McpToolCallResult = {
    text,
    isError,
    content,
    structuredContentValid: false,
    resourceLinks: extractResourceLinks(contentRaw),
  };
  if ('structuredContent' in rec) {
    const structured = rec['structuredContent'];
    if (isRecord(outputSchema)) {
      const { valid, errors } = validateAgainstSchema(structured, outputSchema);
      if (valid) {
        out.structuredContent = structured;
        out.structuredContentValid = true;
      } else {
        out.structuredContentError = `structuredContent không khớp outputSchema: ${errors.join('; ')}`;
      }
    } else {
      // No schema to check against — pass through, text stays fallback.
      out.structuredContent = structured;
      out.structuredContentValid = true;
    }
  }
  return out;
}

/** Parse tool `annotations` (spec 2025-06-18); unknown fields ignored. */
export function parseAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const out: McpToolAnnotations = {};
  if (typeof raw['title'] === 'string') out.title = raw['title'];
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse `icons` (SEP-973, spec 2025-11-25); entries without `src` dropped. */
export function parseIcons(raw: unknown): McpToolIcon[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: McpToolIcon[] = [];
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item['src'] !== 'string') continue;
    const icon: McpToolIcon = { src: item['src'] };
    if (typeof item['mimeType'] === 'string') icon.mimeType = item['mimeType'];
    if (Array.isArray(item['sizes'])) {
      const sizes = (item['sizes'] as unknown[]).filter((s): s is string => typeof s === 'string');
      if (sizes.length > 0) icon.sizes = sizes;
    } else if (typeof item['sizes'] === 'string') {
      icon.sizes = [item['sizes']];
    }
    if (typeof item['theme'] === 'string') icon.theme = item['theme'];
    out.push(icon);
  }
  return out.length > 0 ? out : undefined;
}

/** Merge a `resources/read` result's `contents` into plain text. */
export function resourceResultToText(result: unknown): string {
  const rec = asRecord(result, 'resources/read result');
  const contents = rec['contents'];
  if (typeof contents === 'string') return contents;
  if (!Array.isArray(contents)) return JSON.stringify(result);
  const parts: string[] = [];
  for (const item of contents as Array<Record<string, unknown>>) {
    if (!isRecord(item)) {
      parts.push(JSON.stringify(item));
      continue;
    }
    if (typeof item['text'] === 'string') parts.push(item['text']);
    else if (typeof item['blob'] === 'string') parts.push(`[binary content, ${item['blob'].length} base64 chars]`);
    else parts.push(JSON.stringify(item));
  }
  return parts.join('\n');
}

function parseToolDefs(result: unknown): McpToolDef[] {
  const rec = asRecord(result, 'tools/list result');
  if (!Array.isArray(rec['tools'])) return [];
  const out: McpToolDef[] = [];
  for (const t of rec['tools'] as unknown[]) {
    if (!isRecord(t) || typeof t['name'] !== 'string') continue;
    const def: McpToolDef = {
      name: t['name'],
      description: typeof t['description'] === 'string' ? t['description'] : undefined,
      inputSchema: isRecord(t['inputSchema']) ? t['inputSchema'] : undefined,
    };
    if (typeof t['title'] === 'string') def.title = t['title'];
    const annotations = parseAnnotations(t['annotations']);
    if (annotations) def.annotations = annotations;
    if (isRecord(t['outputSchema'])) def.outputSchema = t['outputSchema'];
    const icons = parseIcons(t['icons']);
    if (icons) def.icons = icons;
    out.push(def);
  }
  return out;
}

function parseResources(result: unknown): McpResource[] {
  const rec = asRecord(result, 'resources/list result');
  if (!Array.isArray(rec['resources'])) return [];
  const out: McpResource[] = [];
  for (const r of rec['resources'] as unknown[]) {
    if (!isRecord(r) || typeof r['uri'] !== 'string') continue;
    const res: McpResource = {
      uri: r['uri'],
      name: typeof r['name'] === 'string' ? r['name'] : undefined,
      description: typeof r['description'] === 'string' ? r['description'] : undefined,
      mimeType: typeof r['mimeType'] === 'string' ? r['mimeType'] : undefined,
    };
    if (typeof r['size'] === 'number') res.size = r['size'];
    const annotations = parseAnnotations(r['annotations']);
    if (annotations) res.annotations = annotations;
    const icons = parseIcons(r['icons']);
    if (icons) res.icons = icons;
    out.push(res);
  }
  return out;
}

/**
 * Build the `tools/call` params for one call, resolving the progress
 * token: use the caller's token when given, generate one when an
 * `onProgress` callback is given without a token, else send no `_meta`.
 * The token is returned so the caller can route progress notifications
 * to this call until it settles.
 */
function buildCallToolParams(
  name: string,
  args: Record<string, unknown>,
  options: McpCallToolOptions | undefined,
): { params: Record<string, unknown>; progressToken: string | number | undefined } {
  const progressToken =
    options?.progressToken ?? (options?.onProgress ? randomUUID() : undefined);
  const params: Record<string, unknown> = { name, arguments: args };
  if (progressToken !== undefined) params['_meta'] = { progressToken };
  return { params, progressToken };
}

/**
 * Route one `notifications/progress` to the callback registered for
 * its token. Unknown tokens (e.g. a late notification after the call
 * settled) are ignored — never crash, never call the wrong callback.
 */
function dispatchProgress(
  progressHandlers: Map<string | number, McpProgressCallback>,
  params: unknown,
): void {
  if (!isRecord(params)) return;
  const token = params['progressToken'];
  if (typeof token !== 'string' && typeof token !== 'number') return;
  const handler = progressHandlers.get(token);
  if (!handler) return;
  const progress = params['progress'];
  if (typeof progress !== 'number') return;
  const notification: McpProgressNotification = { progressToken: token, progress };
  if (typeof params['total'] === 'number') notification.total = params['total'];
  if (typeof params['message'] === 'string') notification.message = params['message'];
  try {
    handler(notification);
  } catch {
    // A throwing progress callback must not break the client.
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

/**
 * Biến môi trường an toàn được truyền cho MCP server con (v0.15, M8 audit).
 * Copy đúng allowlist của `safeEnv()` trong
 * `packages/tools/src/sandbox.ts` — KHÔNG import từ tools để tránh phụ
 * thuộc chéo core → tools. Mọi tên trông như secret đều bị chặn dù có
 * trong allowlist (xem `MCP_SECRET_ENV_PATTERN`).
 */
const MCP_SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'TERM',
  'SHELL',
  'NODE_ENV',
]);

/** Tên biến môi trường trông như secret — giống `SECRET_ENV_PATTERN` của sandbox. */
const MCP_SECRET_ENV_PATTERN =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;

/**
 * Lọc môi trường chỉ còn allowlist tối thiểu, chặn mọi tên giống secret.
 * MCP server con là code bên thứ ba — không được thấy API key/token của
 * tiến trình chính. Mặc định lọc `process.env`; tham số `source` chỉ để
 * test (truyền env giả thay vì sửa `process.env` thật).
 */
export function safeEnvForMcp(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!MCP_SAFE_ENV_ALLOWLIST.has(key)) continue;
    if (MCP_SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Tên các biến trong `env` trông như secret — chỉ trả về TÊN, không bao
 * giờ trả về hay in giá trị. Dùng để cảnh báo khi `mcp.json` khai `env`
 * chứa secret (xem `ensureStarted`).
 */
export function findSecretLikeEnvNames(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).filter((name) => MCP_SECRET_ENV_PATTERN.test(name));
}

export class StdioMcpClient implements McpClient {
  private readonly config: McpServerConfig;
  /** Config reconnect (Grok) — stdio chỉ dùng cờ non-retryable + timeout tool call. */
  private readonly reconnectConfig: McpReconnectConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
      /** Gỡ listener `signal` khi request xong (tránh rò listener). */
      onAbort?: () => void;
    }
  >();
  private stdoutBuffer = '';
  private stderrTail = '';
  private closed = false;
  private spawnError: Error | null = null;
  negotiatedProtocolVersion: string | undefined;
  /**
   * Dispatcher cho mọi message do server khởi xướng (v0.13, W5a).
   * Public để coordinator đăng ký handler elicitation / sampling /
   * roots... — client chỉ đăng ký sẵn `notifications/progress` (route
   * theo token) và `ping` mặc định của dispatcher. `connectMcp` đăng
   * ký thêm handler mặc định (`clientHandlers.ts`) và quảng cáo
   * capability tương ứng trong `initialize` khi config có `clientHandlers`.
   */
  readonly dispatcher = new McpDispatcher();
  /** Callback `onProgress` theo token, chỉ sống trong lúc call đang chạy. */
  private readonly progressHandlers = new Map<string | number, McpProgressCallback>();

  constructor(config: McpServerConfig) {
    if (!config.command) throw new McpError('Stdio MCP server needs a "command" in its config');
    this.config = config;
    this.reconnectConfig = resolveMcpReconnectConfig(config.reconnect);
    this.dispatcher.register('notifications/progress', (params) => {
      dispatchProgress(this.progressHandlers, params);
    });
  }

  /** Dispatcher của client — coordinator đăng ký handler qua đây. */
  getDispatcher(): McpDispatcher {
    return this.dispatcher;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) throw new McpError('MCP client is closed');
    let child: ChildProcessWithoutNullStreams;
    // v0.15 (M8 audit): server con KHÔNG kế thừa toàn bộ process.env —
    // chỉ allowlist tối thiểu (`safeEnvForMcp`) + env user khai riêng
    // trong config. `config.env` (mcp.json CHO PHÉP `env` — xem
    // config.ts `validateServer`) được truyền nguyên, KHÔNG chặn để
    // tránh phá config hiện có; tên nào trông như secret thì chỉ cảnh
    // báo ra stderr — ghi TÊN biến, không bao giờ ghi giá trị.
    const secretLikeNames = findSecretLikeEnvNames(this.config.env);
    if (secretLikeNames.length > 0) {
      process.stderr.write(
        `[open-bot] Cảnh báo: MCP server "${this.config.name}" có biến môi trường trong config ` +
          `trông như secret (${secretLikeNames.join(', ')}) — giá trị sẽ được truyền cho server con. ` +
          `Chỉ đặt secret trong mcp.json khi bạn tin tưởng server đó.\n`,
      );
    }
    try {
      child = spawn(this.config.command as string, this.config.args ?? [], {
        env: { ...safeEnvForMcp(), ...(this.config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Grok: stdio connect failure là non-retryable (config sai thì
      // retry vô ích) — đánh dấu để pool/caller không nối lại trong vòng lặp.
      throw new McpError(
        `Failed to start MCP server "${this.config.name}": ${(err as Error).message}`,
        undefined,
        this.reconnectConfig.stdioConnectFailuresAreNonRetryable,
      );
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Keep only a tail for error messages; stderr is never logged as-is
      // (it could contain secrets) and never crashes the client.
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on('error', (err: Error) => {
      this.spawnError = err;
      this.failPending(
        new McpError(
          `MCP server "${this.config.name}" failed to start: ${err.message}`,
          undefined,
          this.reconnectConfig.stdioConnectFailuresAreNonRetryable,
        ),
      );
      this.closed = true;
    });
    child.on('exit', (code: number | null) => {
      if (!this.closed) {
        this.failPending(
          new McpError(
            `MCP server "${this.config.name}" exited (code ${code === null ? '?' : code})` +
              (this.stderrTail.trim()
                ? `: ${this.stderrTail.trim().slice(-500)}`
                : ''),
          ),
        );
      }
      this.closed = true;
    });
    return child;
  }

  private failPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.onAbort?.();
      entry.reject(err);
    }
    this.pending.clear();
    this.progressHandlers.clear();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // Malformed line from the server: ignore, never crash.
        continue;
      }
      if (!isRecord(msg)) continue;
      // Message có `method` là server-initiated (request hoặc
      // notification) — đi qua dispatcher trước, kể cả khi nó có `id`
      // số (server request có id; response của client thì không có
      // method). Kiểm tra `method` trước `id` vì lý do này (v0.13, W5a).
      if (typeof msg['method'] === 'string') {
        void this.dispatchServerMessage(msg);
        continue;
      }
      if (typeof msg['id'] !== 'number') continue;
      const entry = this.pending.get(msg['id']);
      if (!entry) continue;
      this.pending.delete(msg['id']);
      clearTimeout(entry.timer);
      entry.onAbort?.();
      const resp = msg as unknown as JsonRpcResponse;
      if (resp.error) {
        entry.reject(
          new McpError(
            `MCP server "${this.config.name}" error ${resp.error.code}: ${resp.error.message}`,
            resp.error.code,
          ),
        );
      } else {
        entry.resolve(resp.result);
      }
    }
  }

  /**
   * Đưa một server-initiated message qua dispatcher; nếu dispatcher
   * trả response (request, vd `ping` hay `elicitation/create`) thì ghi
   * trả về stdin của server. Notification không có response. Lỗi ở đây
   * không bao giờ làm chết client hay request đang chạy.
   */
  private async dispatchServerMessage(msg: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.dispatcher.dispatch(msg);
      if (response && this.child && !this.closed) {
        this.child.stdin.write(JSON.stringify(response) + '\n');
      }
    } catch {
      // Dispatcher đã tự nuốt lỗi handler; đây chỉ là phòng thủ thêm.
    }
  }

  /**
   * Hủy một request đang chờ (v0.13, W5a): gửi
   * `notifications/cancelled` (`{ requestId, reason? }`) rồi reject
   * pending call với lỗi "đã bị huỷ". Trả false khi không có request
   * nào đang chờ với id đó.
   */
  cancelRequest(requestId: number | string, reason?: string): boolean {
    const entry = this.pending.get(requestId as number);
    if (!entry) return false;
    this.notify('notifications/cancelled', {
      requestId,
      ...(reason ? { reason } : {}),
    });
    this.pending.delete(requestId as number);
    clearTimeout(entry.timer);
    entry.onAbort?.();
    entry.reject(
      new McpError(
        `MCP request tới "${this.config.name}" đã bị huỷ${reason ? `: ${reason}` : ''}`,
      ),
    );
    return true;
  }

  /**
   * Gửi một JSON-RPC request (v0.13, W5a: thêm `options`).
   *  - `signal`: abort giữa chừng → gửi `notifications/cancelled`
   *    (`{ requestId: id }`) rồi reject với lỗi "đã bị huỷ".
   *  - `progressToken` + `onProgress`: đăng ký callback nhận
   *    `notifications/progress` cho token này, gỡ khi request xong.
   *  - `timeoutMs`: timeout riêng cho call này (mặc định 30s).
   */
  private request(
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      progressToken?: string | number;
      onProgress?: McpProgressCallback;
    },
  ): Promise<unknown> {
    const child = this.ensureStarted();
    if (this.spawnError) throw this.spawnError;
    if (this.closed) throw new McpError(`MCP client for "${this.config.name}" is closed`);
    const timeoutMs = options?.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    if (options?.signal?.aborted) {
      throw new McpError(`MCP request "${method}" tới "${this.config.name}" đã bị huỷ trước khi gửi`);
    }
    const id = this.nextId++;
    const { progressToken, onProgress } = options ?? {};
    if (progressToken !== undefined && onProgress) {
      this.progressHandlers.set(progressToken, onProgress);
    }
    const cleanupProgress = (): void => {
      if (progressToken !== undefined) this.progressHandlers.delete(progressToken);
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanupProgress();
        onAbortCleanup();
        reject(
          new McpError(
            `MCP request "${method}" to "${this.config.name}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      // Unref so a hung server cannot keep the process alive on its own.
      timer.unref?.();
      const onAbort = (): void => {
        if (!this.pending.has(id)) return; // đã xong/timeout trước đó
        this.pending.delete(id);
        clearTimeout(timer);
        cleanupProgress();
        this.notify('notifications/cancelled', { requestId: id });
        reject(
          new McpError(`MCP request "${method}" tới "${this.config.name}" đã bị huỷ`),
        );
      };
      const onAbortCleanup = (): void => {
        options?.signal?.removeEventListener('abort', onAbort);
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (fn: () => void): void => {
        cleanupProgress();
        onAbortCleanup();
        fn();
      };
      this.pending.set(id, {
        resolve: (value: unknown) => settle(() => resolve(value)),
        reject: (err: Error) => settle(() => reject(err)),
        timer,
        onAbort: onAbortCleanup,
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      child.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          cleanupProgress();
          onAbortCleanup();
          reject(new McpError(`Failed to write to MCP server "${this.config.name}": ${err.message}`));
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      // Notifications are best-effort.
    }
  }

  async initialize(): Promise<McpServerInfo> {
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: this.config.capabilities ?? MCP_CLIENT_CAPABILITIES,
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    });
    const rec = asRecord(result, 'initialize result');
    const serverInfo = isRecord(rec['serverInfo']) ? rec['serverInfo'] : {};
    // Tell the server the handshake is done (notification, no reply).
    this.notify('notifications/initialized');
    // Accept an older server version (fallback) instead of failing.
    this.negotiatedProtocolVersion = negotiateProtocolVersion(
      typeof rec['protocolVersion'] === 'string' ? rec['protocolVersion'] : undefined,
    );
    return {
      name: typeof serverInfo['name'] === 'string' ? serverInfo['name'] : this.config.name,
      version: typeof serverInfo['version'] === 'string' ? serverInfo['version'] : '',
      protocolVersion: this.negotiatedProtocolVersion,
    };
  }

  /**
   * v0.97 (MCP 2.0): `server/discover` without any handshake. Returns
   * null when the server does not know the method (pre-2.0 server).
   * Records the negotiated version from the discovery document.
   */
  async discover(): Promise<ServerDiscoverResult | null> {
    const result = await discoverServer(
      { requestJsonRpc: (method, params) => this.request(method, params) },
      {
        protocolVersion: MCP_PROTOCOL_VERSION_2026,
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      },
    );
    if (result) {
      this.negotiatedProtocolVersion = negotiateProtocolVersion(result.protocolVersion);
    }
    return result;
  }

  /** Raw JSON-RPC request (v0.13) — xem `McpClient.requestJsonRpc`. */
  async requestJsonRpc(
    method: string,
    params?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<unknown> {
    return this.request(method, params, options);
  }

  async ping(): Promise<void> {
    await this.request('ping');
  }

  async listTools(): Promise<McpToolDef[]> {
    try {
      return parseToolDefs(await this.request('tools/list'));
    } catch (err) {
      // v0.70 (SEP-1303 mở rộng): -32602 cho tools/list thành danh sách
      // rỗng thay vì throw — chỉ -32602, các mã khác vẫn throw.
      // v0.71: báo lý do qua onWarning trước khi trả [].
      if (isInvalidParamsError(err)) {
        reportInvalidParamsListWarning(this.config, 'tools/list', err);
        return [];
      }
      throw err;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: McpCallToolOptions,
  ): Promise<string> {
    const result = await this.callToolStructured(name, args, options);
    if (result.isError) return `MCP tool error: ${result.text || '(no message)'}`;
    return result.text;
  }

  /**
   * `tools/call` đầy đủ (v0.13, W5a): gửi `progressToken` trong
   * `_meta` khi caller muốn theo dõi tiến độ, nhận progress qua
   * `onProgress`, huỷ qua `signal`, validate `structuredContent`
   * theo `outputSchema` (ưu tiên `options.outputSchema`, nếu không
   * có thì dùng schema từ `tools/list` khi caller tự truyền vào —
   * client không tự gọi `tools/list` ở đây để tránh thêm round-trip).
   *
   * P0-4: timeout có giới hạn (Grok) — idle 120s (reset mỗi lần có
   * progress) + tổng 60 phút thay cho timeout 30s mặc định; caller
   * truyền `timeoutMs` riêng thì vẫn tôn trọng số đó.
   */
  async callToolStructured(
    name: string,
    args: Record<string, unknown> = {},
    options?: McpCallToolOptions,
  ): Promise<McpToolCallResult> {
    const prep = prepareToolCall(name, args, options, this.reconnectConfig);
    try {
      const result = await this.request('tools/call', prep.params, {
        timeoutMs: prep.timeoutMs,
        signal: prep.bounded.signal,
        progressToken: prep.progressToken,
        onProgress: prep.onProgress,
      });
      return parseToolCallResult(result, options?.outputSchema);
    } catch (err) {
      // v0.69d (SEP-1303): -32602 cho tools/call thành tool result isError.
      const invalidParams = invalidParamsToolCallResult(err, this.config.name, name);
      if (invalidParams) return invalidParams;
      throw translateBoundedToolCallError(
        err,
        prep.bounded,
        this.config.name,
        name,
        this.reconnectConfig,
      );
    } finally {
      prep.bounded.cleanup();
    }
  }

  async listResources(): Promise<McpResource[]> {
    try {
      return parseResources(await this.request('resources/list'));
    } catch (err) {
      // v0.70 (SEP-1303 mở rộng): -32602 cho resources/list thành danh
      // sách rỗng thay vì throw — chỉ -32602, các mã khác vẫn throw.
      // v0.71: báo lý do qua onWarning trước khi trả [].
      if (isInvalidParamsError(err)) {
        reportInvalidParamsListWarning(this.config, 'resources/list', err);
        return [];
      }
      throw err;
    }
  }

  async readResource(uri: string): Promise<string> {
    try {
      const result = await this.request('resources/read', { uri });
      return resourceResultToText(result);
    } catch (err) {
      // v0.70 (SEP-1303 mở rộng): -32602 cho resources/read thành text
      // tool error (như `callTool`) thay vì throw — chỉ -32602, các mã
      // khác vẫn throw.
      if (isInvalidParamsError(err)) {
        const detail = invalidParamsDetail(err);
        return (
          `MCP tool error: server "${this.config.name}" rejected resources/read of "${uri}" ` +
          `(invalid params, code -32602): ${detail} — check the resource URI and retry.`
        );
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.closed && !this.child) return;
    this.closed = true;
    this.progressHandlers.clear();
    this.failPending(new McpError(`MCP client for "${this.config.name}" was closed`));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        resolve();
      }, 2000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Streamable-HTTP transport
// ---------------------------------------------------------------------------

export class StreamableHttpMcpClient implements McpClient {
  private readonly config: McpServerConfig;
  /** Config reconnect (Grok) + policy dùng chung cho stream + keepalive. */
  private readonly reconnectConfig: McpReconnectConfig;
  private readonly reconnectPolicy: McpReconnectPolicy;
  /** Timer keepalive probe (5 phút ± jitter); null khi chưa chạy / đã dừng. */
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private keepaliveStopped = false;
  private nextId = 1;
  private sessionId: string | null = null;
  private closed = false;
  /**
   * GET SSE stream (v0.13, integration): mở sau `initialize()` để
   * nhận message do server khởi xướng và POST response trả lại. Null
   * khi chưa mở (hoặc server không hỗ trợ GET stream — khi đó client
   * vẫn chạy bằng POST như trước, chỉ không trả lời được server
   * request).
   */
  private transport: StreamableHttpTransport | null = null;
  negotiatedProtocolVersion: string | undefined;
  /**
   * Dispatcher cho mọi message do server khởi xướng (v0.13, W5a) —
   * giống stdio client. Từ v0.13 (integration), response cho
   * server-initiated *request* ĐƯỢC gửi trả qua transport (POST) thay
   * vì bị bỏ qua như trước — xem `dispatchServerMessage`.
   */
  readonly dispatcher = new McpDispatcher();
  /** Callback `onProgress` theo token, chỉ sống trong lúc call đang chạy. */
  private readonly progressHandlers = new Map<string | number, McpProgressCallback>();

  constructor(config: McpServerConfig) {
    if (!config.url) throw new McpError('Streamable-HTTP MCP server needs a "url" in its config');
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new McpError(`Invalid MCP server URL for "${config.name}"`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new McpError(
        `MCP server "${config.name}": only http:// and https:// URLs are allowed`,
      );
    }
    this.config = config;
    this.reconnectConfig = resolveMcpReconnectConfig(config.reconnect);
    this.reconnectPolicy = new McpReconnectPolicy(this.reconnectConfig);
    this.dispatcher.register('notifications/progress', (params) => {
      dispatchProgress(this.progressHandlers, params);
    });
  }

  /**
   * Trạng thái reconnect hiện tại (diagnostics / UI): degraded,
   * tombstone, số lần retry / 404 / probe fail. Không chứa secret.
   */
  getReconnectState(): McpReconnectState {
    return this.reconnectPolicy.snapshot();
  }

  /**
   * Keepalive probe (P0-4, Grok: 5 phút ± jitter 30s, probe timeout
   * 10s): gọi `ping()` định kỳ; probe thành công thì reset đếm degraded
   * và — khi đã ổn định liên tục quá `stabilityThresholdMs` — reset bộ
   * đếm retry (recovered); probe fail thì đếm degraded, đủ 3 lần liên
   * tiếp thì đánh dấu degraded và probe lại sau 30s (thay vì 5 phút)
   * để phát hiện hồi phục sớm. Vòng lặp dừng khi `close()`.
   */
  private scheduleKeepalive(delayMs: number): void {
    if (this.closed || this.keepaliveStopped) return;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      void this.runKeepaliveProbe();
    }, delayMs);
    this.keepaliveTimer.unref?.();
  }

  private async runKeepaliveProbe(): Promise<void> {
    if (this.closed || this.keepaliveStopped) return;
    try {
      await this.pingWithTimeout(this.reconnectConfig.healthProbeTimeoutMs);
      this.reconnectPolicy.recordDegradedProbeSuccess();
      this.reconnectPolicy.recordStable();
      this.scheduleKeepalive(this.reconnectPolicy.nextKeepaliveDelayMs());
    } catch {
      this.reconnectPolicy.noteInstability();
      this.reconnectPolicy.recordDegradedProbeFailure();
      // Đang degraded thì probe lại sau degradedProbeDelayMs (30s).
      this.scheduleKeepalive(this.reconnectConfig.degradedProbeDelayMs);
    }
  }

  /** `ping()` với timeout riêng (keepalive probe dùng 10s theo Grok). */
  private async pingWithTimeout(timeoutMs: number): Promise<void> {
    await this.request('ping', undefined, { timeoutMs });
  }

  private startKeepalive(): void {
    this.keepaliveStopped = false;
    this.scheduleKeepalive(this.reconnectPolicy.nextKeepaliveDelayMs());
  }

  private stopKeepalive(): void {
    this.keepaliveStopped = true;
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** Dispatcher của client — coordinator đăng ký handler qua đây. */
  getDispatcher(): McpDispatcher {
    return this.dispatcher;
  }

  /**
   * Đưa một server-initiated message qua dispatcher; response cho
   * server request (vd `elicitation/create`) được POST trả lại qua
   * transport khi có GET stream. Notification không có response.
   * Lỗi ở đây không bao giờ làm chết client hay request đang chạy.
   */
  private dispatchServerMessage(msg: Record<string, unknown>): void {
    void this.dispatcher
      .dispatch(msg)
      .then((response) => {
        if (response && this.transport && !this.transport.isClosed()) {
          void this.transport
            .send(response as unknown as Record<string, unknown>)
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  /**
   * v0.13: mở GET SSE stream qua StreamableHttpTransport, dùng chung
   * session id + token với client (server strict đòi GET stream phải
   * thuộc session đã initialize). Best-effort: server trả 405 / không
   * hỗ trợ stream thì transport tự dừng retry và client vẫn chạy bằng
   * POST như trước.
   *
   * P0-4: transport nhận `McpReconnectPolicy` (Grok) — retry nhanh 5
   * lần (5s→60s) rồi retry định kỳ (5→30 phút), session 404 quá 5 lần
   * thì tombstone — thay cho retry cố định 3 lần / 1s trước đây.
   */
  private async openServerStream(): Promise<void> {
    if (this.closed || this.transport) return;
    const transport = new StreamableHttpTransport({
      url: this.config.url as string,
      headers: this.config.headers,
      getAuthorization: () => this.resolveAuth(false),
      refreshAuthorization: () => this.resolveAuth(true),
      reconnectPolicy: this.reconnectPolicy,
      onServerMessage: (msg) => this.dispatchServerMessage(msg),
    });
    transport.setSessionId(this.sessionId);
    this.transport = transport;
    await transport.openStream();
  }

  /**
   * Hủy một request (v0.13, W5a): gửi `notifications/cancelled`
   * (`{ requestId, reason? }`) tới server. Transport HTTP không giữ
   * pending map nên luôn trả true khi client chưa đóng (notification
   * đã được thử gửi); việc dừng fetch đang bay do `signal` của
   * `callTool` lo.
   */
  cancelRequest(requestId: number | string, reason?: string): boolean {
    if (this.closed) return false;
    void this.notify('notifications/cancelled', {
      requestId,
      ...(reason ? { reason } : {}),
    });
    return true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Resolve the `Authorization` header value from the wired OAuth
   * provider (v0.9). `forceRefresh` asks the provider for a fresh token
   * instead of a possibly-revoked cached one. Provider failures surface
   * as a clear McpError (e.g. expired with no refresh token → run
   * `mcp_auth` again); the token value itself is never included.
   */
  private async resolveAuth(forceRefresh: boolean): Promise<string | null> {
    const provider = this.config.authProvider;
    if (!provider) return null;
    try {
      return await provider(this.config.name, { forceRefresh });
    } catch (err) {
      throw new McpError(
        `MCP OAuth for "${this.config.name}" failed: ${(err as Error).message}`,
      );
    }
  }

  /** One raw HTTP round-trip. Never throws for an HTTP error status —
   *  the caller decides (401 → refresh + retry, other !ok → McpError).
   *  Only network errors / timeouts / caller abort throw. `signal`
   *  (v0.13, W5a) aborts the fetch; the caller turns that into a
   *  `notifications/cancelled` + a clear "đã bị huỷ" error.
   *
   *  v0.73 (P0 postRpcOnce): với response SSE (`text/event-stream`)
   *  thì đọc body theo luồng thay vì `await res.text()` — server giữ
   *  stream mở sau khi đã gửi frame response (gửi tiếp progress
   *  notification, hoặc không đóng stream) thì đợi hết body sẽ treo
   *  tới timeout dù response đã tới từ lâu. Đọc tới khi thấy frame
   *  khớp `expectedId` thì trả về ngay (phần text đã tích lũy đủ cho
   *  `parseRpcResponse` dispatch các message server-initiated tới
   *  trước response). Response JSON thường, notification không có id,
   *  và 202 rỗng vẫn đọc tới hết / trả '' như cũ. */
  private async postRpcOnce(
    body: Record<string, unknown>,
    authValue: string | null,
    options?: { timeoutMs?: number; signal?: AbortSignal; expectedId?: number },
  ): Promise<HttpOutcome> {
    if (this.closed) throw new McpError(`MCP client for "${this.config.name}" is closed`);
    const timeoutMs = options?.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    if (options?.signal?.aborted) {
      throw new McpError(`MCP request tới "${this.config.name}" đã bị huỷ trước khi gửi`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onCallerAbort = (): void => controller.abort();
    options?.signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.config.headers ?? {}),
      };
      // An OAuth token from the provider wins over a static header.
      if (authValue) headers['Authorization'] = authValue;
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const res = await fetch(this.config.url as string, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sessionId = res.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;
      const text = await this.readRpcBody(res, options?.expectedId);
      return {
        status: res.status,
        text,
        contentType: res.headers.get('content-type') ?? '',
        wwwAuthenticate: res.headers.get('www-authenticate'),
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (options?.signal?.aborted) {
          throw new McpError(`MCP request tới "${this.config.name}" đã bị huỷ`);
        }
        throw new McpError(
          `MCP request to "${this.config.name}" timed out after ${timeoutMs}ms`,
        );
      }
      if (err instanceof McpError) throw err;
      throw new McpError(
        `MCP request to "${this.config.name}" failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Đọc body của một POST response (v0.73, P0 postRpcOnce).
   *
   *  - SSE (`text/event-stream`) + có `expectedId`: đọc theo luồng,
   *    parse từng frame `data:` ngay khi dòng đầy đủ tới, trả về ngay
   *    khi thấy frame response khớp id (message có `method` là
   *    server-initiated nên không tính là khớp — giống
   *    `parseRpcResponse`). Stream sau đó được cancel để giải phóng
   *    kết nối; server có gửi thêm progress sau response cũng không
   *    làm client chờ nữa.
   *  - Mọi trường hợp khác (JSON thường, không có id để khớp, body
   *    null như 202 rỗng): đọc tới hết như cũ (`res.text()`).
   *
   *  Không bao giờ đưa body vào error/log (có thể chứa secret).
   *  Abort/timeout trong lúc đọc lan ra ngoài dưới dạng `AbortError`
   *  để `postRpcOnce` dịch như trước.
   */
  private async readRpcBody(res: Response, expectedId?: number): Promise<string> {
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.body || !contentType.includes('text/event-stream') || expectedId === undefined) {
      return res.text();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let lineBuf = '';
    let matched = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        lineBuf += chunk;
        let nlIdx: number;
        while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
          const rawLine = lineBuf.slice(0, nlIdx);
          lineBuf = lineBuf.slice(nlIdx + 1);
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trim();
          if (!payload) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(payload);
          } catch {
            continue; // malformed frame: ignore, never crash
          }
          if (!isRecord(msg) || typeof msg['method'] === 'string') continue;
          if (msg['id'] === expectedId) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    } finally {
      // Đã có response: hủy stream để giải phóng kết nối thay vì chờ
      // server đóng. Chưa khớp (stream đóng / lỗi) thì không cần.
      // Lỗi cancel không bao giờ làm hỏng response đã nhận được.
      if (matched) {
        try {
          await reader.cancel();
        } catch {
          // ignore — response đã có trong tay
        }
      }
    }
    return text;
  }

  /**
   * Turn a raw HTTP outcome into the JSON-RPC response for `expectedId`
   * (or null for an empty 202). Throws McpError for any non-2xx status.
   * A Streamable-HTTP response may carry several SSE `data:` frames:
   * server-initiated messages (vd `notifications/progress`) are routed
   * through the dispatcher, and only the frame whose `id` matches the
   * request is returned as the response (v0.13, W5a).
   */
  private parseRpcResponse(outcome: HttpOutcome, expectedId?: number): JsonRpcResponse | null {
    if (outcome.status < 200 || outcome.status >= 300) {
      // Never include headers / body in the error (may contain secrets).
      throw new McpError(
        `MCP server "${this.config.name}" HTTP ${outcome.status} for ${this.config.url as string}`,
      );
    }
    if (!outcome.text.trim()) return null; // e.g. 202 Accepted for a notification
    let messages: unknown[];
    if (outcome.contentType.includes('text/event-stream') || outcome.text.includes('data:')) {
      // Streamable-HTTP responses may arrive as SSE `data:` frames.
      // (This is response framing, not the legacy SSE transport.)
      messages = outcome.text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null; // malformed frame: ignore, never crash
          }
        })
        .filter((m) => m !== null);
    } else {
      messages = [JSON.parse(outcome.text) as unknown];
    }
    let response: JsonRpcResponse | null = null;
    for (const message of messages) {
      if (!isRecord(message)) continue;
      if (typeof message['method'] === 'string') {
        // Server-initiated message: route through the dispatcher.
        this.dispatchServerMessage(message);
        continue;
      }
      // Response cho request của client — lấy đúng id của request này.
      if (expectedId === undefined || message['id'] === expectedId) {
        if (!response) response = message as unknown as JsonRpcResponse;
      }
    }
    return response;
  }

  /**
   * POST one JSON-RPC request, with OAuth handling (v0.9): the token
   * from `authProvider` is attached; on HTTP 401 the token is refreshed
   * once and the request is retried once with the fresh token. A second
   * 401, or a refresh that yields no token, fails with a clear error
   * telling the user to re-authorize with `mcp_auth`.
   *
   * v0.13: step-up scope — khi server trả 401 kèm `WWW-Authenticate`
   * đòi thêm scope, client thử `config.onAuthStepUp(scopes)` TRƯỚC
   * khi refresh thường; onAuthStepUp trả null / lỗi thì rơi xuống
   * refresh thường như trước.
   */
  private async postRpc(
    body: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<JsonRpcResponse | null> {
    const hasProvider = Boolean(this.config.authProvider);
    let authValue: string | null = null;
    let refreshed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (hasProvider && attempt === 0) authValue = await this.resolveAuth(false);
      const outcome = await this.postRpcOnce(body, authValue, {
        ...options,
        // v0.73: cho postRpcOnce biết id để đọc SSE theo luồng và trả
        // về ngay khi frame response khớp tới (không đợi stream đóng).
        expectedId: typeof body['id'] === 'number' ? (body['id'] as number) : undefined,
      });
      if (outcome.status !== 401 || !hasProvider || refreshed) {
        return this.parseRpcResponse(
          outcome,
          typeof body['id'] === 'number' ? (body['id'] as number) : undefined,
        );
      }
      // HTTP 401: the token was rejected — refresh once, retry once.
      refreshed = true;
      const wantedScopes = parseStepUpScope(outcome.wwwAuthenticate ?? undefined);
      if (wantedScopes.length > 0 && this.config.onAuthStepUp) {
        try {
          const stepped = await this.config.onAuthStepUp(wantedScopes);
          if (stepped) {
            authValue = stepped;
            continue;
          }
        } catch {
          // Rơi xuống refresh thường bên dưới.
        }
      }
      const fresh = await this.resolveAuth(true);
      if (!fresh) {
        throw new McpError(
          `MCP server "${this.config.name}" rejected the OAuth token (HTTP 401) and no fresh ` +
            `token could be obtained. Run mcp_auth for "${this.config.name}" again to re-authorize.`,
        );
      }
      authValue = fresh;
    }
    // Unreachable: the loop always returns or throws.
    throw new McpError(`MCP request to "${this.config.name}" failed: unexpected retry state`);
  }

  /**
   * Gửi một JSON-RPC request (v0.13, W5a: thêm `options`).
   *  - `signal`: abort giữa chừng → abort fetch, gửi
   *    `notifications/cancelled` (`{ requestId: id }`), reject với lỗi
   *    "đã bị huỷ".
   *  - `progressToken` + `onProgress`: đăng ký callback nhận
   *    `notifications/progress` cho token này, gỡ khi request xong.
   */
  private async request(
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      progressToken?: string | number;
      onProgress?: McpProgressCallback;
    },
  ): Promise<unknown> {
    const id = this.nextId++;
    const { progressToken, onProgress } = options ?? {};
    if (progressToken !== undefined && onProgress) {
      this.progressHandlers.set(progressToken, onProgress);
    }
    try {
      const resp = await this.postRpc(
        { jsonrpc: '2.0', id, method, params },
        { timeoutMs: options?.timeoutMs, signal: options?.signal },
      );
      if (!resp) throw new McpError(`MCP server "${this.config.name}" returned no response for "${method}"`);
      if (resp.error) {
        throw new McpError(
          `MCP server "${this.config.name}" error ${resp.error.code}: ${resp.error.message}`,
          resp.error.code,
        );
      }
      return resp.result;
    } catch (err) {
      if (options?.signal?.aborted) {
        // Caller huỷ: báo server biết (best-effort, không chờ — server
        // có thể đang treo nên notify cũng có thể treo theo) rồi reject.
        void this.notify('notifications/cancelled', { requestId: id });
        throw new McpError(`MCP request "${method}" tới "${this.config.name}" đã bị huỷ`);
      }
      throw err;
    } finally {
      if (progressToken !== undefined) this.progressHandlers.delete(progressToken);
    }
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    try {
      await this.postRpc({ jsonrpc: '2.0', method, params });
    } catch {
      // Notifications are best-effort.
    }
  }

  async initialize(): Promise<McpServerInfo> {
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: this.config.capabilities ?? MCP_CLIENT_CAPABILITIES,
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    });
    const rec = asRecord(result, 'initialize result');
    const serverInfo = isRecord(rec['serverInfo']) ? rec['serverInfo'] : {};
    await this.notify('notifications/initialized');
    // Accept an older server version (fallback) instead of failing.
    this.negotiatedProtocolVersion = negotiateProtocolVersion(
      typeof rec['protocolVersion'] === 'string' ? rec['protocolVersion'] : undefined,
    );
    // v0.13: mở GET SSE stream để nhận message do server khởi xướng
    // sau handshake. Best-effort — server không hỗ trợ GET stream
    // (405) thì client vẫn chạy bằng POST như trước.
    this.openServerStream().catch(() => undefined);
    // P0-4: keepalive probe (5 phút ± jitter) + degraded probe +
    // stability — bắt đầu sau handshake thành công.
    this.startKeepalive();
    return {
      name: typeof serverInfo['name'] === 'string' ? serverInfo['name'] : this.config.name,
      version: typeof serverInfo['version'] === 'string' ? serverInfo['version'] : '',
      protocolVersion: this.negotiatedProtocolVersion,
    };
  }

  /**
   * v0.97 (MCP 2.0): `server/discover` without any handshake. Returns
   * null when the server does not know the method (pre-2.0 server).
   * Records the negotiated version from the discovery document. In
   * stateless mode no GET SSE stream is opened (there is no session
   * to stream server-initiated messages for — MRTR replaces them).
   */
  async discover(): Promise<ServerDiscoverResult | null> {
    const result = await discoverServer(
      { requestJsonRpc: (method, params) => this.request(method, params) },
      {
        protocolVersion: MCP_PROTOCOL_VERSION_2026,
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      },
    );
    if (result) {
      this.negotiatedProtocolVersion = negotiateProtocolVersion(result.protocolVersion);
    }
    return result;
  }

  /** Raw JSON-RPC request (v0.13) — xem `McpClient.requestJsonRpc`. */
  async requestJsonRpc(
    method: string,
    params?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<unknown> {
    return this.request(method, params, options);
  }

  async ping(): Promise<void> {
    await this.request('ping');
  }

  async listTools(): Promise<McpToolDef[]> {
    try {
      return parseToolDefs(await this.request('tools/list'));
    } catch (err) {
      // v0.70 (SEP-1303 mở rộng): -32602 cho tools/list thành danh sách
      // rỗng thay vì throw — chỉ -32602, các mã khác vẫn throw.
      // v0.71: báo lý do qua onWarning trước khi trả [].
      if (isInvalidParamsError(err)) {
        reportInvalidParamsListWarning(this.config, 'tools/list', err);
        return [];
      }
      throw err;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: McpCallToolOptions,
  ): Promise<string> {
    const result = await this.callToolStructured(name, args, options);
    if (result.isError) return `MCP tool error: ${result.text || '(no message)'}`;
    return result.text;
  }

  /**
   * `tools/call` đầy đủ (v0.13, W5a): như stdio client — gửi
   * `progressToken` trong `_meta`, nhận progress qua `onProgress`,
   * huỷ qua `signal`, validate `structuredContent` theo
   * `options.outputSchema`.
   *
   * P0-4: timeout có giới hạn (Grok) — idle 120s (reset mỗi lần có
   * progress) + tổng 60 phút thay cho timeout 30s mặc định.
   */
  async callToolStructured(
    name: string,
    args: Record<string, unknown> = {},
    options?: McpCallToolOptions,
  ): Promise<McpToolCallResult> {
    const prep = prepareToolCall(name, args, options, this.reconnectConfig);
    try {
      const result = await this.request('tools/call', prep.params, {
        timeoutMs: prep.timeoutMs,
        signal: prep.bounded.signal,
        progressToken: prep.progressToken,
        onProgress: prep.onProgress,
      });
      return parseToolCallResult(result, options?.outputSchema);
    } catch (err) {
      // v0.69d (SEP-1303): -32602 cho tools/call thành tool result isError.
      const invalidParams = invalidParamsToolCallResult(err, this.config.name, name);
      if (invalidParams) return invalidParams;
      throw translateBoundedToolCallError(
        err,
        prep.bounded,
        this.config.name,
        name,
        this.reconnectConfig,
      );
    } finally {
      prep.bounded.cleanup();
    }
  }

  async listResources(): Promise<McpResource[]> {
    try {
      return parseResources(await this.request('resources/list'));
    } catch (err) {
      // v0.70 (SEP-1303 mở rộng): -32602 cho resources/list thành danh
      // sách rỗng thay vì throw — chỉ -32602, các mã khác vẫn throw.
      // v0.71: báo lý do qua onWarning trước khi trả [].
      if (isInvalidParamsError(err)) {
        reportInvalidParamsListWarning(this.config, 'resources/list', err);
        return [];
      }
      throw err;
    }
  }

  async readResource(uri: string): Promise<string> {
    try {
      const result = await this.request('resources/read', { uri });
      return resourceResultToText(result);
    } catch (err) {
      // v0.70 (SEP-1303 mở rộng): -32602 cho resources/read thành text
      // tool error (như `callTool`) thay vì throw — chỉ -32602, các mã
      // khác vẫn throw.
      if (isInvalidParamsError(err)) {
        const detail = invalidParamsDetail(err);
        return (
          `MCP tool error: server "${this.config.name}" rejected resources/read of "${uri}" ` +
          `(invalid params, code -32602): ${detail} — check the resource URI and retry.`
        );
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopKeepalive();
    this.progressHandlers.clear();
    // v0.13: đóng GET stream — transport gửi DELETE session để server
    // dọn session sạch (best-effort, không chặn close).
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Factory — picks the transport from the config and runs initialize().
// ---------------------------------------------------------------------------

/**
 * Connect to an MCP server and run the `initialize` handshake.
 * stdio is used when `config.command` is set; streamable HTTP when
 * `config.url` is set (stdio wins if both are set). When
 * `config.authProvider` is set, the HTTP client sends its token on
 * every request and refreshes + retries once on HTTP 401. Throws a
 * clear `McpError` when neither transport is set or the handshake fails.
 *
 * v0.13: when `config.clientHandlers` is set, the default dispatcher
 * handlers (elicitation / roots / sampling — see `clientHandlers.ts`)
 * are registered BEFORE `initialize()` and the matching capabilities
 * are advertised, unless `config.capabilities` overrides them.
 */
export async function connectMcp(config: McpServerConfig): Promise<McpClient> {
  const effectiveConfig: McpServerConfig =
    config.capabilities || !config.clientHandlers
      ? config
      : { ...config, capabilities: buildMcpClientCapabilities(config.clientHandlers) };
  const client: McpClient = effectiveConfig.command
    ? new StdioMcpClient(effectiveConfig)
    : effectiveConfig.url
      ? new StreamableHttpMcpClient(effectiveConfig)
      : (() => {
          throw new McpError(
            `MCP server "${effectiveConfig.name}": must have "command" (stdio) or "url" (streamable HTTP) in its config`,
          );
        })();
  if (config.clientHandlers) {
    registerDefaultMcpClientHandlers(client, config.clientHandlers);
  }
  // v0.97 (MCP 2.0): stateless mode — no `initialize` handshake, no
  // session id. Best-effort `server/discover` replaces the handshake;
  // a pre-2.0 server answers -32601 (discover() returns null) and the
  // client still works, because every later request carries `_meta`.
  if (effectiveConfig.stateless) {
    try {
      await client.discover?.();
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    return client;
  }
  try {
    await client.initialize();
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}

/** Alias for `connectMcp`. */
export const createMcpClient = connectMcp;
