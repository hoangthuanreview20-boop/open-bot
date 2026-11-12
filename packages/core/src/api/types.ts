/**
 * Local API — shared types (v0.5).
 *
 * The local API lets third-party apps/scripts on the SAME machine call
 * an agent, send it a task and read the result (ROADMAP §2f). It is
 * local-first by design: the server only ever binds to loopback
 * (127.0.0.1), the token is a random secret kept in the Vault, and
 * there is no cloud backend of open-bot involved.
 *
 * The core package must NOT depend on Electron, so the main process
 * injects the real behaviour through `ApiHandlers` (see server.ts).
 * Everything in this file is plain data — no I/O, no runtime imports
 * (the one `import type` below is erased at compile time).
 */
import type { ServiceAccountScope } from '../team/types';
import type { VisionAttachment } from '../types';

/** One bot, as exposed to API clients. No secrets, no system prompt. */
export interface ApiBotSummary {
  id: string;
  name: string;
  providerId: string;
  model: string;
}

/** A background run started by POST /v1/bots/:id/run. */
export interface ApiRunRecord {
  runId: string;
  botId: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  /** Final assistant text, present only when status === 'done'. */
  text?: string;
  /** Error message, present only when status === 'error'. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/**
 * One streaming event sent over the WebSocket run endpoint (v0.8,
 * extended v0.9a with WS control messages).
 *
 * - `run-started`: first event of every stream, `{ runId }` — the
 *   client uses this id for every control message it sends back.
 * - `approval-needed`: the run waits for a human to approve a tool
 *   call, `{ callId, call }` (same payload the coordinator emits).
 * - `ask-user`: the run waits for an answer, `{ requestId, question,
 *   options? }` (same payload the coordinator emits).
 * - `elicitation-needed` (v0.13): an MCP server asks the user a
 *   question, `{ elicitationId, serverName, message, mode, url?,
 *   fields? }` — answer with the `elicitation-response` control message.
 * - `input-required`: the run entered a waiting-for-input state —
 *   sent right after `approval-needed` / `ask-user` /
 *   `elicitation-needed`, so a client that only watches for "waiting"
 *   does not need to know all kinds.
 *   `{ runId, waitingFor: 'approval-needed' | 'ask-user' | 'elicitation-needed', callId?,
 *   requestId?, elicitationId? }`.
 * - `stopped`: the run was stopped by a client control message or by
 *   the socket closing, `{ runId, reason? }`. Sent before the socket
 *   closes (1000); no `summary` follows it.
 * - `progress`: informational progress message from the coordinator.
 */
export type ApiStreamEventKind =
  | 'delta'
  | 'toolcall'
  | 'toolresult'
  | 'summary'
  | 'error'
  | 'run-started'
  | 'approval-needed'
  | 'ask-user'
  | 'elicitation-needed'
  | 'stopped'
  | 'input-required'
  | 'progress';

/** One streaming event: `{ kind, data }` JSON per WebSocket message. */
export interface ApiStreamEvent {
  kind: ApiStreamEventKind;
  /** delta/summary: string | toolcall: ToolCall | toolresult: ToolResult | error: { error: string } | run-started: { runId: string } | stopped: { runId: string; reason?: string } | input-required: { runId: string; waitingFor: 'approval-needed' | 'ask-user' | 'elicitation-needed'; callId?: string; requestId?: string; elicitationId?: string } | approval-needed: { callId: string; call: unknown } | ask-user: { requestId: string; question: string; options?: string[] } | elicitation-needed: { elicitationId: string; serverName: string; message: string; mode: 'form' | 'url'; url?: string; fields?: unknown } | progress: string */
  data: unknown;
}

/**
 * One control message a WebSocket client sends to the server (v0.9a).
 * Parsed in server.ts; a malformed message gets an `error` event back
 * (the socket stays open) except for non-JSON text, which closes the
 * socket (1007) — the run is then stopped like any other disconnect.
 */
export type ApiControlMessage =
  /** Stop the run of this socket (or the named run of this socket). */
  | { type: 'stop'; runId?: string }
  /** Alias of `stop`, kept for A2A-style clients. */
  | { type: 'cancel'; runId?: string }
  /** Answer a pending approval: `callId` from an `approval-needed` event. */
  | { type: 'approval-response'; callId: string; approved: boolean }
  /** Answer a pending question: `requestId` from an `ask-user` event. */
  | { type: 'ask-user-response'; requestId: string; answer: string }
  /**
   * Answer a pending MCP elicitation: `elicitationId` from an
   * `elicitation-needed` event. `content` only for `accept` in
   * form-mode (the validated form object).
   */
  | {
      type: 'elicitation-response';
      elicitationId: string;
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
    }
  /**
   * Unified answer (v0.31): routes by the id present — `callId` →
   * approval, `requestId` → ask-user, `elicitationId` → elicitation.
   * Same handling as the three specific `*-response` messages above.
   */
  | { type: 'answer'; callId: string; approved: boolean }
  | { type: 'answer'; requestId: string; answer: string }
  | {
      type: 'answer';
      elicitationId: string;
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
    };

/** Options the server passes to a streaming `runBotStream` handler (v0.9a). */
export interface RunBotStreamOptions {
  /**
   * Id of the run this stream belongs to — the same id sent to the
   * client in the `run-started` event and stored in the ApiRunRecord.
   * The handler uses it to map control messages (stop/answer) to the
   * right run.
   */
  runId: string;
  /**
   * Aborted when the client asks to stop (control message) or the
   * socket closes. The handler aborts the underlying run when this
   * fires; the server marks the run `stopped` either way.
   */
  signal: AbortSignal;
}

/** Options for `ApiHandlers.runBot` (v0.89a — vision over the Local API). */
export interface RunBotOptions {
  /**
   * Image attachments for this turn (same `VisionAttachment` shape as
   * `RunParams.attachments`: `{ mimeType, data (base64), name? }`).
   * The server validates them with `validateVisionAttachments`
   * (max 5 images) before starting the run; invalid → 400, nothing
   * runs. Practical bound: the JSON body cap is 1 MB, so in practice
   * this carries one small image (~750 KB decoded) per request.
   */
  attachments?: VisionAttachment[];
}

/**
 * v0.90a (Đội G): một event harness trên SSE `GET /v1/harness/events`
 * — envelope đã sanitize (bus) hoặc dòng NDJSON đã sanitize (replay).
 * Replay từ log không có `instanceId`/`engine` (log chỉ lưu at/botId/
 * threadId/kind/payload) nên 2 field này optional; live event có đủ.
 */
export interface HarnessStreamEvent {
  at: string;
  botId: string;
  threadId: string;
  kind: string;
  payload: Record<string, unknown>;
  instanceId?: string;
  engine?: string;
  /**
   * v0.90e (Đội G): event của run im lặng — live stream và replay đều
   * bỏ qua (log NDJSON vẫn giữ để audit).
   */
  silent?: boolean;
}

/** v0.90a (Đội G): filter client gửi lên SSE `GET /v1/harness/events`. */
export interface HarnessEventsFilter {
  threadId?: string;
  botId?: string;
  kinds?: string[];
}

/** Handlers the main process injects into the API server. */
export interface ApiHandlers {
  /** All bots the API may see (same list as `bots:list`). */
  listBots: () => ApiBotSummary[] | Promise<ApiBotSummary[]>;
  /**
   * Run one agent turn for a bot and resolve with the assistant text.
   * The server runs this in the background and polls the run record;
   * the handler itself must NOT block the HTTP request.
   *
   * v0.89a: `opts.attachments` carries image attachments (see
   * `RunBotOptions`); `text` may be empty when attachments are
   * present (image-only turn). Handlers written before v0.89a ignore
   * the 3rd argument — text-only runs behave exactly as before.
   */
  runBot: (botId: string, text: string, opts?: RunBotOptions) => Promise<{ text: string }>;
  /**
   * v0.8: streaming variant of `runBot`, used by the WebSocket endpoint
   * `GET /v1/bots/:id/run/stream`. The handler calls `emit` with
   * `{ kind, data }` events (delta / toolcall / toolresult / summary)
   * as the turn progresses and resolves with the final text. Optional:
   * when absent, the server falls back to `runBot` and synthesises one
   * `delta` + one `summary` event from the final text.
   *
   * v0.9a: the server sends a `run-started` event with the run id
   * BEFORE calling this handler, then passes `opts` carrying that same
   * `runId` and an AbortSignal that fires when the client stops the
   * run (control message or socket close). The handler should abort
   * the underlying run when the signal fires; the server marks the
   * run `stopped` either way. Handlers written before v0.9a ignore the
   * 4th argument — the server still stops the stream, it just cannot
   * stop the run underneath.
   */
  runBotStream?: (
    botId: string,
    text: string,
    emit: (event: ApiStreamEvent) => void,
    opts?: RunBotStreamOptions,
  ) => Promise<{ text: string }>;
  /**
   * v0.9a: stop one run by id (used for WS `{type:"stop"}` control
   * messages). Optional — when absent, the server still aborts the
   * stream's signal and marks the run `stopped`; the run underneath
   * just keeps going until it settles. Resolves `{ stopped: true }`
   * when a run was actually stopped, `{ stopped: false, reason }`
   * when there was no such running run.
   */
  stopRun?: (runId: string) => Promise<{ runId: string; stopped: boolean; reason?: string }> | { runId: string; stopped: boolean; reason?: string };
  /**
   * v0.9a: answer a pending approval (WS `{type:"approval-response"}`).
   * Optional — when absent, the server answers the client with an
   * `error` event and the run keeps waiting until the coordinator
   * timeout. Resolves `{ found: true }` when a pending request with
   * this callId existed and was answered.
   */
  respondApproval?: (callId: string, approved: boolean) => Promise<{ found: boolean }> | { found: boolean };
  /**
   * v0.9a: answer a pending ask-user question (WS
   * `{type:"ask-user-response"}`). Same contract as `respondApproval`.
   */
  respondAskUser?: (requestId: string, answer: string) => Promise<{ found: boolean }> | { found: boolean };
  /**
   * v0.13: answer a pending MCP elicitation (WS
   * `{type:"elicitation-response"}`). Same contract as `respondApproval`;
   * `content` only for `accept` in form-mode.
   */
  respondElicitation?: (
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => Promise<{ found: boolean }> | { found: boolean };
  /** Recent chat history for a bot (main-process ChatMessage shape). */
  getHistory: (botId: string, limit: number) => unknown[] | Promise<unknown[]>;
  /** Tracked tasks for a bot (main-process TaskItem shape). */
  listTasks: (botId: string) => unknown[] | Promise<unknown[]>;
  /**
   * M5 — trạng thái harness (registry instance + permission đang chờ).
   * Optional: khi chưa mount, `GET /v1/harness/status` trả 404.
   * Desktop main mount handler này bằng cách gọi coordinator RPC
   * `harnessStatus` (CoordinatorClient.harnessStatus).
   */
  harnessStatus?: () => unknown | Promise<unknown>;
  /**
   * M5 — đọc NDJSON log theo thread (phân trang, lọc theo kind).
   * Optional: khi chưa mount, route log trả 404.
   */
  harnessThreadLog?: (
    threadId: string,
    opts: { limit: number; offset: number; kinds?: string[] },
  ) => unknown | Promise<unknown>;
  /**
   * M5 — quyết một permission request đang chờ (thẻ Allow/Deny qua
   * Local API). Optional: khi chưa mount, route trả 404.
   */
  respondHarnessPermission?: (
    requestId: string,
    allowed: boolean,
  ) => Promise<{ found: boolean; allowed?: boolean }> | { found: boolean; allowed?: boolean };
  /**
   * v0.90a (Đội G): subscribe live event harness cho SSE
   * `GET /v1/harness/events`. Server gọi khi client mở stream; handler
   * đăng ký listener rồi trả hàm unsubscribe (server gọi khi client
   * đóng stream). Event emit đã sanitize ở harness (bus) nên handler
   * KHÔNG được gửi payload thô. Optional: khi chưa mount, route trả
   * 404. Replay từ NDJSON log (Last-Event-ID) do server tự làm qua
   * `harnessThreadLog` ở trên — handler này chỉ lo live.
   */
  subscribeHarnessEvents?: (
    filter: HarnessEventsFilter,
    emit: (event: HarnessStreamEvent) => void,
  ) => (() => void) | Promise<() => void>;
  /**
   * v0.59 — deliver một webhook tới automation
   * (`POST /v1/automations/:id/webhook`). Optional: khi chưa mount,
   * route trả 404. `rawBody` là đúng byte nhận được (Buffer hoặc
   * string) — handler PHẢI verify chữ ký HMAC trên raw body này
   * (xem `AutomationScheduler.handleWebhook`) TRƯỚC khi chạy bất kỳ
   * action nào; chữ ký sai/thiếu/malformed thì handler ném lỗi và
   * không ghi run nào. `signature` là giá trị header
   * `x-open-bot-signature` (null khi thiếu). Trả về run đã ghi
   * (shape `AutomationRun` của core — server trả nguyên vẹn).
   */
  deliverAutomationWebhook?: (
    automationId: string,
    rawBody: string | Buffer,
    signature: string | null,
  ) => unknown | Promise<unknown>;
  /**
   * v0.83b — deliver một Composio trigger event tới automation
   * (`POST /v1/automations/:id/composio-trigger`). Optional: khi
   * chưa mount, route trả 404. `rawBody` là đúng byte nhận được —
   * handler PHẢI verify chữ ký Composio (`webhook-signature` trên
   * `${webhookId}.${timestamp}.${rawBody}`, xem
   * `AutomationScheduler.handleComposioTrigger`) hoặc `?token=`
   * TRƯỚC khi chạy bất kỳ action nào; auth sai/thiếu thì handler
   * ném lỗi và không ghi run nào. `auth` gom các header Composio +
   * token query (null khi thiếu). Trả về run đã ghi (shape
   * `AutomationRun` của core — server trả nguyên vẹn).
   */
  deliverComposioTrigger?: (
    automationId: string,
    rawBody: string | Buffer,
    auth: {
      webhookId: string | null;
      webhookTimestamp: string | null;
      webhookSignature: string | null;
      token: string | null;
    },
  ) => unknown | Promise<unknown>;
  /**
   * v0.87a (P2-2) — deliver a direct-Slack Events API / interactivity
   * payload (`POST /v1/automations/:id/slack-inbound`). Optional:
   * when unmounted, the route returns 404. `rawBody` is the exact
   * bytes received — the handler MUST verify the Slack signing
   * secret (`x-slack-signature` over `v0:{timestamp}:{rawBody}`, see
   * `AutomationScheduler.handleSlackInbound`) BEFORE parsing or
   * running any action; a bad/missing signature throws and no run is
   * recorded. `auth` carries the two Slack headers (null when
   * missing); `contentType` is the request's Content-Type (needed to
   * recognise form-encoded interactivity bodies). Returns the
   * finished run, or `{ kind: 'url_verification', challenge }` for
   * the Slack URL check, or `{ kind: 'ignored', ok: true, reason }`
   * for bot messages / non-message subtypes (no run either way).
   */
  deliverSlackInbound?: (
    automationId: string,
    rawBody: string | Buffer,
    auth: { signature: string | null; timestamp: string | null },
    contentType?: string | null,
  ) => unknown | Promise<unknown>;
}

/**
 * v0.85a (P0-1): one extra accepted Bearer token for the Local API.
 * A bare string is a legacy unscoped token (full access — see the
 * `extraTokens` doc on `CreateApiServerOptions`). The object form
 * carries the service-account scope from `team.json` so the server
 * can enforce it per request; `scope` absent on the object form is
 * treated the same as a bare string (full access).
 */
export type ApiExtraToken =
  | string
  | { token: string; scope?: ServiceAccountScope };

export interface CreateApiServerOptions {
  /** TCP port to listen on. `0` = let the OS pick a free port (tests). */
  port?: number;
  /**
   * Bearer token clients must send (`Authorization: Bearer <token>`).
   * The main process generates it (32 random bytes, hex) and stores it
   * in the Vault under namespace 'api', key 'token'.
   */
  token: string;
  /**
   * v0.7: extra accepted Bearer tokens (e.g. service-account tokens
   * from the Vault). All belong to the same team as `teamId`.
   *
   * v0.85a (P0-1): each extra token may carry its service-account
   * scope (`{ token, scope }`). Scope `'run'` may only run bots
   * (POST /v1/bots/:id/run, the WS run stream, read-only GETs); it
   * is refused with 403 on admin-only routes (POST
   * /v1/harness/permissions/:id, POST /mcp, POST /a2a, and the WS
   * `approval-response` control message — a `run` token must never
   * approve its own dangerous tool call). Scope `'admin'` keeps full
   * access, same as the main token. A bare string token carries NO
   * scope and keeps the pre-v0.85a behaviour (full access) — that is
   * a deliberate backwards-compatibility decision: old callers
   * (e.g. tests, hosts that pass plain strings) are not silently
   * locked out; only tokens that explicitly declare `scope: 'run'`
   * are restricted. Hosts that want enforcement must pass the
   * `{ token, scope }` form (the desktop main process does).
   */
  extraTokens?: ApiExtraToken[];
  /**
   * v0.7: team the token(s) are bound to. When set, every request
   * except /v1/health must ALSO send `X-Open-Bot-Team: <teamId>`
   * with exactly this value; a missing/mismatching header is 403.
   * When unset, the team header is not required (backwards
   * compatible with pre-v0.7 clients).
   */
  teamId?: string;
  handlers: ApiHandlers;
  /**
   * Called (best-effort, never awaited by the server) when a
   * background run finishes — the main process uses it to fire the
   * `run.done` / `run.error` webhook events.
   */
  onRunSettled?: (run: ApiRunRecord) => void;
  /**
   * v0.90a (Đội G): chu kỳ heartbeat SSE `GET /v1/harness/events`
   * (ms). Mặc định 15000. Chỉ dùng để test rút ngắn chu kỳ (test
   * truyền 50ms để assert heartbeat tới mà không phải chờ 15s).
   */
  harnessEventsHeartbeatMs?: number;
  /**
   * v0.90d (Đội G): giới hạn tốc độ REST (token bucket theo client).
   * Số request/phút cho mỗi client (mặc định
   * `DEFAULT_RATE_LIMIT_PER_MINUTE` = 120). Vượt → 429 + header
   * `Retry-After` (giây) + body lỗi rõ. Miễn `GET /v1/health` và
   * `GET /.well-known/agent-card.json` (public, như auth); WS
   * run-stream KHÔNG bị rate limit (mỗi upgrade đã tốn một run, và
   * cap kết nối ở dưới là lưới chặn cho nó). Bucket phân biệt theo
   * IP + fingerprint (sha256 rút gọn) của token đã khớp — request
   * không/không đúng token chung một bucket theo IP. `0` = tắt
   * giới hạn (chỉ host local tin cậy mới nên tắt).
   *
   * Main process KHÔNG tự gọi Local API của chính nó qua HTTP
   * (đã kiểm tra: main chỉ gọi provider userinfo qua fetch, còn
   * Settings đọc trạng thái qua IPC `api:get`) nên không cần miễn
   * request nội bộ.
   */
  rateLimitPerMinute?: number;
  /**
   * v0.90d (Đội G): số kết nối TCP đồng thời tối đa của server
   * (`server.maxConnections`, mặc định `MAX_API_CONNECTIONS` = 100).
   * Vượt → Node đóng socket mới ngay (đã kiểm chứng bằng probe:
   * socket thứ 3 khi maxConnections = 2 được accept ở TCP rồi đóng
   * trong ~2ms, không dữ liệu, không treo).
   */
  maxConnections?: number;
  /**
   * v0.90d (Đội G): số kết nối đồng thời tối đa trên MỖI IP
   * (mặc định `MAX_CONNECTIONS_PER_IP` = 20). Loopback chỉ có
   * 127.0.0.1 / ::1 nên đây mới là giới hạn ràng buộc thực tế —
   * 20 là thừa cho client hợp lệ (vài script + SSE/WS stream) và
   * đủ chặn một client flood kết nối. Vượt → socket bị destroy
   * ngay + 1 dòng log (chỉ IP, không token) hoặc callback
   * `onConnectionRejected` khi host truyền vào.
   */
  maxConnectionsPerIp?: number;
  /**
   * v0.90d (Đội G): timeout nhận header request (ms, mặc định
   * `API_HEADERS_TIMEOUT_MS` = 30.000). Client mở kết nối rồi
   * không gửi header sẽ bị đóng sau từng này (trả 408). `0` = tắt.
   * Phải <= `requestTimeoutMs` khi cả hai > 0 (luật của Node —
   * sai thì `createApiServer` throw rõ thay vì để Node swap ngầm).
   */
  headersTimeoutMs?: number;
  /**
   * v0.90d (Đội G): timeout nhận toàn bộ request (ms, mặc định
   * `API_REQUEST_TIMEOUT_MS` = 300.000 = mặc định của Node). Chỉ
   * tính thời gian NHẬN request, từ lúc message bắt đầu (không
   * reset khi có thêm byte body — client nhỏ giọt vẫn hết hạn) —
   * đã kiểm chứng bằng probe: response SSE đã gửi header thì
   * KHÔNG bị cắt khi hết timeout (stream harness sống bình
   * thường), nên giá trị này an toàn cho SSE/WS dài hạn. `0` = tắt
   * (theo Node). Thực thi theo chu kỳ
   * `connectionsCheckingIntervalMs` (mặc định 30s) nên request quá
   * hạn có thể sống thêm tối đa một chu kỳ nữa.
   */
  requestTimeoutMs?: number;
  /**
   * v0.90d (Đội G): chu kỳ Node kiểm tra headersTimeout /
   * requestTimeout (ms, mặc định
   * `API_CONNECTIONS_CHECKING_INTERVAL_MS` = 30.000 = mặc định
   * của Node). Chỉ dùng để test rút ngắn chu kỳ (test truyền
   * 50ms để assert timeout bắn mà không phải chờ 30s). Không nên
   * đặt quá nhỏ ở production (tốn CPU mỗi lần quét).
   */
  connectionsCheckingIntervalMs?: number;
  /**
   * v0.90d (Đội G): gọi khi http.Server đóng mà KHÔNG qua
   * `LocalApiServer.stop()` — tức server chết/dừng đột ngột.
   * Host (main process) dùng nó để lên lịch khởi động lại có
   * backoff (xem `retryWithBackoff` ở restart.ts). `stop()` có
   * chủ đích KHÔNG gọi callback này.
   */
  onUnexpectedClose?: () => void;
  /**
   * v0.90d (Đội G): gọi khi một kết nối bị từ chối vì vượt cap
   * trên mỗi IP (xem `maxConnectionsPerIp`). Khi host không
   * truyền callback, server log 1 dòng `console.warn` (chỉ IP,
   * không token). `reason` hiện chỉ có `'per-ip-cap'`.
   */
  onConnectionRejected?: (info: {
    remoteAddress: string;
    reason: 'per-ip-cap';
  }) => void;
  /**
   * v0.13: MCP server mounted at `POST /mcp` (one JSON-RPC
   * request/response per POST; no SSE stream — the mounted server
   * answers inline). Minimal structural type on purpose: the API
   * layer must not import the MCP server module (keeps the layer
   * boundary thin; main passes `createMcpServer(...)` in).
   * Absent = `POST /mcp` answers 404.
   *
   * v0.19: which tools the mount exposes is configured with
   * `mcpTools` / `allowWriteTools` below — the mounted server
   * itself is never mutated (its own allowlist / other transports
   * keep working as before); the API layer filters `tools/list`
   * and blocks `tools/call` for tools outside the mount's set.
   */
  mcpServer?: MountedMcpServer;
  /**
   * v0.19: tools the MCP mount exposes.
   * - `'all-read-only'` (mặc định): mọi tool của server đã mount
   *   trừ tool ghi (xem `MCP_MOUNT_WRITE_TOOL_NAMES` ở server.ts —
   *   danh mục tool ghi suy ra từ `needsApproval` của registry +
   *   `FILE_WRITE_TOOLS`, cộng với annotation MCP
   *   `readOnlyHint: false` / `destructiveHint: true` — W13e:
   *   server expose `listToolDefinitions()` thì annotation được
   *   đọc ngay lúc mount, còn server ngoài / cũ không có method
   *   này thì annotation chỉ thấy khi request `tools/list`). Với
   *   `createMcpServer()` mặc định thì đúng 5
   *   tool read-only cũ — hành vi mặc định không đổi.
   * - `'all'`: mọi tool của server đã mount, KỂ CẢ tool ghi — chỉ
   *   được khi host truyền kèm `allowWriteTools: true` rõ ràng.
   * - `string[]`: chỉ đúng các tool đó. Tool không tồn tại trên
   *   server đã mount → lỗi cấu hình rõ lúc mount (không im lặng
   *   bỏ qua); tool ghi trong danh sách → bị chặn trừ khi
   *   `allowWriteTools: true`.
   * Chỉ có ý nghĩa khi có `mcpServer`; đặt mà không mount MCP
   * server → lỗi cấu hình lúc tạo server.
   */
  mcpTools?: McpMountToolsOption;
  /**
   * v0.19: opt-in tường minh cho phép tool ghi qua mount MCP
   * (`mcpTools: 'all'` hoặc danh sách có tool ghi). Mặc định
   * `false`: tool ghi qua HTTP mount là mặt tấn công (bất kỳ app
   * nào có token API đều chạy được shell/ghi file) nên phải mở
   * tường minh. Không có tác dụng khi không mount MCP server.
   */
  allowWriteTools?: boolean;
  /**
   * v0.25 (W19c): opt-in thắt chặt mount MCP ở chế độ `'all-read-only'`
   * (mặc định của `mcpTools`): khi `true`, mount chỉ expose tool gắn
   * annotation `readOnlyHint: true` tường minh; tool không annotation
   * hoặc `readOnlyHint: false` / `destructiveHint: true` đều bị loại
   * khỏi `tools/list` và bị chặn ở `tools/call` (-32602). Danh sách
   * tường minh (`mcpTools: string[]`) và `'all'` không bị ảnh hưởng.
   * Mặc định `false` vì hầu hết MCP server hiện không gắn annotation —
   * bật mặc định sẽ ẩn cả tool read-only hợp lệ; desktop không truyền
   * gì nên giữ nguyên hành vi cũ.
   */
  strictReadOnly?: boolean;
  /**
   * v0.13: A2A server mounted at `POST /a2a` (JSON-RPC) +
   * `GET /.well-known/agent-card.json` (public, like /v1/health) +
   * `GET /a2a/tasks/:id`. `message:send` runs to completion and
   * returns the final task — true SSE streaming (`message:stream`)
   * lives in the standalone A2A HTTP server, not in this mount.
   * Absent = the A2A routes answer 404.
   */
  a2aServer?: MountedA2aServer;
}

/**
 * W13e: def rút gọn của một tool trên server đã mount — chỉ tên +
 * annotations, không schema/handler. Đồng bộ nên API layer đọc
 * được ngay lúc mount để phân loại tool ghi theo annotation.
 */
export interface MountedMcpToolDefinition {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

/** MCP server mounted into the Local API (structural — see CreateApiServerOptions). */
export interface MountedMcpServer {
  /** Handle one parsed JSON-RPC message; `null` for a notification. */
  handleJsonRpc(msg: unknown): Promise<unknown>;
  /**
   * v0.19: tên các tool server này expose (server thật từ
   * `createMcpServer` có sẵn method này). API layer dùng nó để
   * kiểm tra `mcpTools` dạng danh sách ngay lúc mount (tool không
   * tồn tại → lỗi cấu hình rõ). Mount tối thiểu không có method
   * này vẫn chạy được với `mcpTools` dạng `'all-read-only'` /
   * `'all'` (lọc theo tên + annotation lúc request), nhưng danh
   * sách cụ thể thì cần nó — thiếu sẽ lỗi cấu hình rõ thay vì im
   * lặng bỏ qua tool lạ.
   */
  listToolNames?: () => string[];
  /**
   * W13e: def rút gọn của các tool server này expose (chỉ tên +
   * annotations). Server thật từ `createMcpServer` có sẵn method
   * này; API layer đọc nó ĐỒNG BỘ lúc mount để phân loại tool ghi
   * theo annotation ngay từ đầu — tool có `readOnlyHint: false`
   * hoặc `destructiveHint: true` bị coi là tool ghi ngay cả khi
   * tên lạ, kể cả khi client gọi `tools/call` trước `tools/list`.
   * Server ngoài / cũ không có method này → fallback hành vi
   * W12c (gate theo tên + annotation chỉ sau khi đã `tools/list`).
   */
  listToolDefinitions?: () => MountedMcpToolDefinition[];
}

/**
 * v0.19: option chọn tool expose trên mount MCP của Local API
 * (xem `CreateApiServerOptions.mcpTools`).
 */
export type McpMountToolsOption = string[] | 'all-read-only' | 'all';

/** A2A server mounted into the Local API (structural — see CreateApiServerOptions). */
export interface MountedA2aServer {
  /** Current Agent Card (the mount fills no URL itself — main sets it after start). */
  getAgentCard(): unknown;
  /** Handle one parsed JSON-RPC message; `null` for a notification. */
  handleJsonRpc(msg: unknown): Promise<unknown>;
  /** One task by id, or `undefined` when unknown. */
  getTask(id: string): unknown;
}

/** Webhook event kinds the local API can emit (v0.5). */
export type WebhookEventKind = 'run.done' | 'run.error' | 'approval.needed' | 'automation.notify';

/** One event delivered to registered webhooks. */
export interface WebhookEvent {
  kind: WebhookEventKind;
  /** ISO-8601 timestamp of when the event happened. */
  at: string;
  /** Event payload; shape depends on `kind` (see webhooks.ts). */
  data: unknown;
}

/** A registered webhook endpoint. */
export interface WebhookRegistration {
  id: string;
  url: string;
  events: WebhookEventKind[];
}

/** Outcome of delivering one event to one webhook. */
export interface WebhookDispatchResult {
  webhookId: string;
  url: string;
  ok: boolean;
  /** HTTP status received, when the endpoint answered at all. */
  status?: number;
  /** Network/timeout/parse error message; never throws out of dispatch. */
  error?: string;
}

export interface WebhookDispatcherOptions {
  /** Path of the JSON store file, e.g. `<userData>/webhooks.json`. */
  storePath: string;
  /**
   * v0.8: HMAC secret used to sign every webhook POST
   * (`X-Open-Bot-Signature: sha256=<hex>` over
   * `"<timestamp>.<raw body>"`, plus `X-Open-Bot-Timestamp`).
   * The HOST reads it from the Vault (namespace `webhook`, key
   * `hmac-secret`) and passes it in — the dispatcher never reads the
   * Vault itself. When absent/empty, deliveries go out UNSIGNED and
   * the dispatcher logs one warning (never crashes).
   */
  hmacSecret?: string;
}
