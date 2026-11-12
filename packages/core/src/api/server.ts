/**
 * Local API server (v0.5) — node:http only, no added dependencies.
 *
 * Serves third-party apps/scripts on the same machine:
 *
 *   GET  /v1/health               -> { ok: true }            (no auth)
 *   GET  /v1/bots                 -> ApiBotSummary[]
 *   POST /v1/bots/:id/run         -> { runId, status: 'running' } (202)
 *        Body: `{ "text": "<string>" }` (v0.5); v0.89a adds optional
 *        `"attachments": [{ "mimeType", "data" (base64), "name"? }]`
 *        (same shape + limits as `RunParams.attachments`: max 5 images,
 *        PNG/JPEG/GIF/WebP — invalid → 400, nothing runs). `text` may
 *        be empty when attachments are present (image-only turn).
 *        Practical bound: the JSON body cap is 1 MB, so this carries
 *        one small image (~750 KB decoded) per request; the desktop
 *        composer (no such cap) stays the path for big images.
 *   GET  /v1/runs/:id             -> ApiRunRecord
 *   GET  /v1/bots/:id/history?limit=N
 *   GET  /v1/bots/:id/tasks
 *   POST /v1/automations/:id/webhook -> AutomationRun (200, v0.59)
 *        — deliver a webhook to a webhook-trigger automation.
 *        Requires the Local API auth (Bearer + X-Open-Bot-Team) AND
 *        the HMAC header `x-open-bot-signature` (`sha256=<hex>` over
 *        the EXACT raw body bytes). The handler verifies the signature
 *        before running any action; a bad/missing/malformed signature
 *        -> 401 and no run is recorded. Unknown automation -> 404;
 *        disabled / non-webhook / no key -> 400. Handler not mounted
 *        -> 404. The raw body is verified, never re-serialised.
 *   POST /v1/automations/:id/composio-trigger -> AutomationRun (200, v0.83b)
 *        — deliver a Composio trigger event to a Composio-trigger
 *        automation. This route is checked BEFORE the Local API Bearer gate
 *        ON PURPOSE (see the route): Composio cannot send the local
 *        token, so the Composio webhook signature (`webhook-signature`
 *        over `${webhook-id}.${timestamp}.${rawBody}`, 300 s tolerance)
 *        or the `?token=` fallback IS the auth. Bad/missing auth -> 401
 *        and no run is recorded; slug mismatch / disabled / non-composio
 *        / no secret -> 400; unknown automation -> 404; handler not
 *        mounted -> 404.
 *   GET  /v1/bots/:id/run/stream?text=...  (WebSocket, v0.8)
 *        -> streams `{ kind, data }` JSON messages (kind = delta |
 *           toolcall | toolresult | summary | error), then closes
 *           (1000) when the run finishes or errors (1011 + an `error`
 *           event). Same Bearer + X-Open-Bot-Team auth as the HTTP
 *           routes, checked BEFORE the upgrade is accepted.
 *        v0.9a: the stream is TWO-WAY. The server first sends
 *        `{ kind: 'run-started', data: { runId } }`, then forwards
 *        `approval-needed` / `ask-user` / `input-required` / `stopped`
 *        events as the run progresses. The client may send control
 *        messages `{ type: 'stop' }`, `{ type: 'approval-response',
 *        callId, approved }`, `{ type: 'ask-user-response', requestId,
 *        answer }`, `{ type: 'elicitation-response', elicitationId,
 *        action, content? }` — parsed here and routed to the run through the
 *        ApiHandlers (`stopRun` / `respondApproval` / `respondAskUser` /
 *        `respondElicitation`). P1-10 adds the unified reply
 *        `{ type: 'answer', ... }`: the client sends whichever id the
 *        run is waiting on (`callId` / `requestId` / `elicitationId`)
 *        and the server routes it to the matching response handler —
 *        same pending-id check, same `error` event on an unknown id.
 *        A client that disconnects stops its run (the record becomes
 *        `stopped`); a malformed control message gets an `error` event
 *        back without closing the socket, except non-JSON text, which
 *        closes it (1007) and stops the run.
 *
 *   v0.13 (optional mounts, passed in CreateApiServerOptions):
 *   POST /mcp                         -> MCP server JSON-RPC (one request/response per POST)
 *   GET  /.well-known/agent-card.json -> A2A Agent Card (public, like /v1/health)
 *   POST /a2a                         -> A2A JSON-RPC (message:send runs to completion;
 *                                        message:stream streams SSE when the mounted
 *                                        server supports startStream, else also runs
 *                                        to completion — see the POST /a2a handler)
 *   GET  /a2a/tasks/:id               -> one A2A task
 *   GET  /a2a/tasks                    -> { tasks, total, nextCursor } (v0.25;
 *        query `limit?` (mặc định 50, kẹp 100), `offset?`, `cursor?`,
 *        `contextId?`, `summary?` — lọc/phân trang tái dùng đúng
 *        JSON-RPC `tasks/list` của server đã mount, xem handler)
 *        Mounts are absent by default (those routes answer 404); the
 *        MCP mount answers inline only (no SSE stream). The A2A mount
 *        streams `message:stream` over SSE exactly like the standalone
 *        A2A HTTP server (same events, same order) when the mounted
 *        server is a real `createA2aServer` result; a minimal mount
 *        without `startStream` falls back to run-to-completion JSON.
 *   v0.25: task A2A bền vững qua restart — host tạo A2A server với
 *   `taskStore: createFileTaskStore(<userData>/a2a-tasks.json)` (từ
 *   `a2a/store.ts`) TRƯỚC khi mount vào đây (nơi tạo server là
 *   `startApiServer` ở main process, nơi có `app.getPath('userData')`
 *   — Local API chỉ nhận server đã mount nên không tự tạo store;
 *   không có store thì mount vẫn chạy in-memory như cũ).
 *   v0.19: which tools POST /mcp exposes is configured with
 *   `CreateApiServerOptions.mcpTools` (`'all-read-only'` by default
 *   = the 5 read-only tools, unchanged behaviour) + `allowWriteTools`
 *   (explicit opt-in for write tools); see `resolveMcpMountTools`.
 *   W19c: `strictReadOnly: true` narrows `'all-read-only'` to
 *   tools with an explicit `readOnlyHint: true` annotation only
 *   (unannotated tools are not exposed); default `false`.
 *
 * Auth: every route except /v1/health requires
 * `Authorization: Bearer <token>`. Missing/wrong token -> 401 JSON
 * `{ error: ... }`. v0.7: when the server is bound to a team, every
 * route except /v1/health ALSO requires `X-Open-Bot-Team: <teamId>`
 * matching the bound team; missing/mismatching header -> 403.
 * Service-account tokens are accepted as Bearer tokens too.
 * v0.59: POST /v1/automations/:id/webhook additionally requires the
 * HMAC header `x-open-bot-signature` — the Local API auth alone is
 * NOT enough to fire an automation (see the route).
 * v0.83b: POST /v1/automations/:id/composio-trigger is the ONE
 * exception to the Bearer gate — it is checked BEFORE it, because
 * Composio (public internet) cannot send the local token. Its auth
 * is the Composio webhook signature (or the `?token=` fallback),
 * verified by the scheduler before any action runs; the Bearer
 * token is neither required nor accepted as a substitute there.
 *
 * WebSocket framing (v0.8) is implemented by hand on top of node:http's
 * `upgrade` event (RFC 6455: handshake + frame parse/serialise) — no
 * new dependency. Node 22+ ships a WebSocket *client* globally, but
 * no server, so the server side is ~150 lines of framing code here.
 * Incoming client frames must be masked (per spec); ping is answered
 * with pong; oversized messages (> 1 MB) close the socket (1009).
 *
 * Token comparison is timing-safe (crypto.timingSafeEqual, v0.7).
 * The server still binds to loopback (127.0.0.1) only.
 *
 * Runs are stored in-memory only (a Map). Restarting the app drops
 * the run history; that is deliberate for v0.5 — runs are ephemeral
 * jobs, not durable records.
 *
 * v0.90d (Đội G — củng cố local harness server):
 * - Rate limiting: token bucket 120 request/phút/client (mặc định,
 *   cấu hình qua `rateLimitPerMinute`, `0` = tắt) — vượt → 429 +
 *   header `Retry-After` + body lỗi rõ; miễn `/v1/health` và
 *   `/.well-known/agent-card.json`; WS run-stream không bị rate
 *   limit (cap kết nối là lưới chặn cho nó).
 * - Giới hạn kết nối: `server.maxConnections` (mặc định 100) +
 *   tối đa 20 kết nối/IP (mặc định) — vượt thì socket bị destroy
 *   ngay + 1 dòng log (chỉ IP, không token); `headersTimeout`
 *   30s + `requestTimeout` 300s (chỉ tính lúc NHẬN request nên
 *   SSE/WS dài hạn không bị cắt — đã kiểm chứng bằng probe).
 * - `onUnexpectedClose`: báo cho host khi server đóng mà không
 *   qua `stop()` để host khởi động lại có backoff (xem
 *   `restart.ts`); `stop()` có chủ đích không gọi callback này.
 */

import * as http from 'node:http';
import type { Socket } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { extractSendText } from '../a2a/types';
import type { A2aMessage, A2aTask } from '../a2a/types';
import type { A2aStreamEvent } from '../a2a/server';
import type {
  ApiBotSummary,
  ApiExtraToken,
  ApiHandlers,
  ApiRunRecord,
  ApiStreamEvent,
  CreateApiServerOptions,
  HarnessStreamEvent,
  McpMountToolsOption,
  MountedMcpToolDefinition,
  RunBotOptions,
} from './types';
import type { ServiceAccountScope } from '../team/types';
import { validateVisionAttachments } from '../agent/vision';
import { HARNESS_EVENT_KINDS } from '../ipc/validate';
import type { VisionAttachment } from '../types';

/** Maximum JSON request body accepted (1 MB). Larger -> 400. */
export const MAX_JSON_BODY_BYTES = 1_048_576;

/** Maximum single WebSocket message accepted (1 MB). Larger -> close 1009. */
export const MAX_WS_MESSAGE_BYTES = 1_048_576;

/** RFC 6455 handshake GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Default history limit when `?limit=` is absent. */
export const DEFAULT_HISTORY_LIMIT = 50;
/** Hard cap for `?limit=` (prevents one request dumping the whole DB). */
export const MAX_HISTORY_LIMIT = 200;

// ---------------------------------------------------------------------------
// v0.90d (Đội G): rate limiting + giới hạn kết nối + timeout.
// ---------------------------------------------------------------------------

/** v0.90d: số request/phút mặc định cho mỗi client (REST, token bucket). */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
/** v0.90d: cửa sổ của token bucket (1 phút). */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** v0.90d: số kết nối TCP đồng thời tối đa (`server.maxConnections`). */
export const MAX_API_CONNECTIONS = 100;
/** v0.90d: số kết nối đồng thời tối đa trên mỗi IP (loopback nên đây là giới hạn ràng buộc thực tế). */
export const MAX_CONNECTIONS_PER_IP = 20;
/** v0.90d: timeout nhận header request (ms). */
export const API_HEADERS_TIMEOUT_MS = 30_000;
/** v0.90d: timeout nhận toàn bộ request (ms) — bằng mặc định của Node; chỉ tính lúc NHẬN request nên SSE/WS dài hạn không bị cắt. */
export const API_REQUEST_TIMEOUT_MS = 300_000;
/**
 * v0.90d: chu kỳ Node kiểm tra headersTimeout/requestTimeout (ms)
 * — bằng mặc định của Node. Timeout chỉ được thực thi ở mỗi lần
 * kiểm tra này, nên một request quá hạn có thể sống thêm tối đa
 * một chu kỳ nữa (vd requestTimeout 300s → cắt chậm nhất ~330s).
 */
export const API_CONNECTIONS_CHECKING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// v0.19: MCP mount tool selection (mcpTools / allowWriteTools).
// ---------------------------------------------------------------------------

/**
 * v0.19: tên các tool GHI đã biết — mount MCP của Local API coi
 * chúng là tool ghi và chặn mặc định (chỉ mở khi host truyền
 * `allowWriteTools: true` rõ ràng).
 *
 * Suy ra từ registry tool của agent (`packages/tools/src`):
 * mọi tên dưới đây có `needsApproval: true` — tức agent không bao
 * giờ chạy chúng mà không hỏi người dùng trước — cộng
 * `FILE_WRITE_TOOLS` của core (`agent/rules.ts`: write_file,
 * delete_file, apply_diff). Đây là backstop theo TÊN cho các tool
 * agent hay được bắc cầu sang MCP server; cơ chế tổng quát cho
 * tool tự đăng ký là annotation MCP (`readOnlyHint: false` /
 * `destructiveHint: true`, xem `isWriteToolByAnnotations` — lọc
 * lúc `tools/list` và chặn `tools/call` sau khi đã thấy annotation
 * đó). W13e: server thật từ `createMcpServer` expose
 * `listToolDefinitions()` nên mount đọc được annotation ĐỒNG BỘ
 * lúc mount và phân loại tool ghi theo annotation ngay từ đầu —
 * tool ghi mang tên lạ vẫn bị chặn cả khi client gọi `tools/call`
 * trước `tools/list`. Một tool ghi mang tên lạ VÀ không gắn
 * annotation ghi thì mount vẫn không nhận diện được lúc mount —
 * host phải gắn annotation đúng hoặc đưa tên vào danh sách này;
 * đó là giới hạn đã biết, không phải đảm bảo an toàn tuyệt đối.
 * Server ngoài / cũ không expose `listToolDefinitions()` thì
 * fallback hành vi W12c (gate theo tên + annotation chỉ sau khi
 * đã `tools/list` một lần).
 */
export const MCP_MOUNT_WRITE_TOOL_NAMES: readonly string[] = [
  // Ghi file (FILE_WRITE_TOOLS).
  'write_file',
  'delete_file',
  'apply_diff',
  // Shell.
  'shell_exec',
  // Thay đổi git.
  'git_commit',
  // Computer-use: thao tác chuột/phím/ghi màn hình.
  'computer_click',
  'computer_key',
  'computer_mouse_move',
  'computer_record_start',
  'computer_record_stop',
  'computer_type',
  // Gọi tool ngoài (tác dụng phụ không biết trước) / cài đặt code.
  'mcp_call_tool',
  'skill_marketplace_install',
];

/** v0.19: true khi `name` là tool ghi đã biết (theo tên, xem trên). */
export function isMcpMountWriteTool(name: string): boolean {
  return (MCP_MOUNT_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Annotation của một tool trong response `tools/list` của MCP. */
function isWriteToolByAnnotations(annotations: unknown): boolean {
  if (!isRecord(annotations)) return false;
  return annotations['readOnlyHint'] === false || annotations['destructiveHint'] === true;
}

/**
 * W19c: true khi tool gắn annotation read-only TƯỜNG MINH
 * (`readOnlyHint: true`). Khác với "không phải tool ghi":
 * tool không gắn annotation nào cũng trả false ở đây — đó là
 * điểm của chế độ `strictReadOnly` (xem `resolveMcpMountTools`):
 * chỉ tool tự khai là read-only mới được tin.
 */
function isReadOnlyByAnnotations(annotations: unknown): boolean {
  if (!isRecord(annotations)) return false;
  return annotations['readOnlyHint'] === true;
}

/** Kết quả của `resolveMcpMountTools`. */
export interface McpMountToolsResolution {
  /**
   * Tên các tool mount được expose, hoặc `null` khi mount cho qua
   * mọi tool trừ tool ghi (chỉ xảy ra với `mcpTools` dạng từ khóa
   * khi server đã mount không expose `listToolNames()` — lúc đó
   * việc chặn tool ghi dựa vào tên + annotation lúc request).
   */
  allowedNames: Set<string> | null;
  /**
   * W13e: tên các tool đã biết là tool ghi theo annotation
   * (`readOnlyHint: false` / `destructiveHint: true`) ngay lúc
   * mount, đọc từ `knownToolDefinitions` (server expose
   * `listToolDefinitions()`). Rỗng khi server không expose defs —
   * lúc đó mount fallback hành vi W12c (chỉ gate theo tên trước
   * `tools/list`, annotation chỉ sau khi đã thấy qua `tools/list`).
   * `createApiServer` dùng tập này trong `mcpMountCallBlockReason`
   * để chặn `tools/call` cho tool ghi tên lạ ngay cả trước
   * `tools/list` đầu tiên.
   */
  annotationWriteToolNames: Set<string>;
}

/**
 * v0.19: giải quyết option `mcpTools` / `allowWriteTools` thành
 * tập tool mount được expose. Ném lỗi cấu hình rõ ràng (throw, lúc
 * `createApiServer` — tức lúc mount) khi:
 * - `mcpTools` / `allowWriteTools: true` được đặt mà không mount
 *   MCP server nào;
 * - `mcpTools` không phải `string[] | 'all-read-only' | 'all'`,
 *   hoặc danh sách chứa tên không phải chuỗi không rỗng;
 * - `mcpTools: 'all'` mà không có `allowWriteTools: true`;
 * - danh sách cụ thể mà server đã mount không expose
 *   `listToolNames()` (không kiểm tra được sự tồn tại);
 * - danh sách cụ thể chứa tool không tồn tại trên server đã mount;
 * - danh sách cụ thể chứa tool ghi mà không có `allowWriteTools: true`
 *   (theo tên HOẶC theo annotation lúc mount — W13e, xem
 *   `knownToolDefinitions` dưới đây).
 *
 * `'all-read-only'` (mặc định) = mọi tool đã biết trừ tool ghi
 * theo tên; `'all'` kèm `allowWriteTools: true` = mọi tool đã biết.
 * W13e: "tool ghi" ở đây gồm cả tool ghi theo annotation lúc mount
 * (tên trong `annotationWriteToolNames` của kết quả trả về) — với
 * `'all-read-only'` chúng bị loại khỏi `allowedNames` ngay từ đầu,
 * và `createApiServer` chặn `tools/call` của chúng ngay cả trước
 * `tools/list` đầu tiên.
 * W19c (`strictReadOnly: true` + `'all-read-only'`): `allowedNames`
 * chỉ gồm tool có annotation `readOnlyHint: true` TƯỜNG MINH.
 * Tool không gắn annotation nào (kể cả tool read-only thật nhưng
 * server của nó không gắn annotation) hoặc `readOnlyHint: false` /
 * `destructiveHint: true` đều bị loại — vì ở chế độ mặc định,
 * tool ghi mang tên lạ mà KHÔNG gắn annotation vẫn lọt qua gate
 * tên + annotation (giới hạn đã biết từ W13e/W14d, ghi chú v0.22):
 * không có annotation thì mount không có bằng chứng nào để tin
 * tool đó là read-only, nên chế độ strict từ chối tin mặc định.
 * Mặc định `false` (không đổi hành vi cũ): hầu hết MCP server
 * hiện nay không gắn annotation, bật mặc định sẽ ẩn cả tool
 * read-only hợp lệ — host chỉ bật strict khi chấp nhận đánh đổi
 * này để đổi lấy an toàn. Strict CHỈ áp dụng cho từ khóa
 * `'all-read-only'`: danh sách tường minh (`string[]`) là hợp
 * đồng tường minh của host (host đã gọi tên tool đó nên strict
 * không được ghi đè), và `'all'` đã cho phép write nên strict
 * không có ý nghĩa gì ở đó. Khi server không expose defs
 * (`knownToolDefinitions` null) thì không có annotation nào để
 * kiểm chứng nên strict loại mọi tool khỏi `allowedNames`.
 */
export function resolveMcpMountTools(options: {
  mcpTools?: McpMountToolsOption;
  allowWriteTools?: boolean;
  /**
   * W19c: chỉ có ý nghĩa với `mcpTools: 'all-read-only'` (xem
   * docstring trên). Mặc định `false` — xem lý do trong docstring
   * (hầu hết MCP server hiện không gắn annotation).
   */
  strictReadOnly?: boolean;
  /** Tên tool server đã mount expose, hoặc null khi không biết được (mount tối thiểu). */
  knownToolNames: string[] | null;
  /**
   * W13e: def rút gọn của các tool server đã mount expose (chỉ tên
   * + annotations), hoặc null khi server không expose
   * `listToolDefinitions()` (server ngoài / cũ) — lúc đó phân loại
   * theo annotation lúc mount không làm được, fallback hành vi
   * W12c. Khi có defs mà `knownToolNames` là null thì tên tool
   * được suy ra từ defs. Mục def không phải record / thiếu tên
   * chuỗi thì bị bỏ qua.
   */
  knownToolDefinitions?: MountedMcpToolDefinition[] | null;
  hasMcpServer: boolean;
}): McpMountToolsResolution {
  const { mcpTools, allowWriteTools, knownToolNames, knownToolDefinitions, hasMcpServer } = options;
  const allowWrite = allowWriteTools === true;
  const strictReadOnly = options.strictReadOnly === true;
  // W13e: tool ghi theo annotation, biết được ngay lúc mount.
  const annotationWriteToolNames = new Set<string>();
  // W19c: annotation theo tên — strict cần biết tool nào gắn
  // `readOnlyHint: true` tường minh (không chỉ biết tool nào ghi).
  const annotationsByName = new Map<string, unknown>();
  const defNames: string[] = [];
  for (const def of knownToolDefinitions ?? []) {
    if (!isRecord(def) || typeof def['name'] !== 'string' || def['name'].length === 0) continue;
    const name = def['name'] as string;
    defNames.push(name);
    annotationsByName.set(name, def['annotations']);
    if (isWriteToolByAnnotations(def['annotations'])) annotationWriteToolNames.add(name);
  }
  const isWriteTool = (name: string): boolean =>
    isMcpMountWriteTool(name) || annotationWriteToolNames.has(name);
  // Tên tool đã biết: ưu tiên knownToolNames, fallback sang defs.
  const effectiveKnownToolNames = knownToolNames ?? (knownToolDefinitions ? defNames : null);
  if (!hasMcpServer) {
    if (mcpTools !== undefined) {
      throw new Error(
        'Local API MCP mount: đã đặt "mcpTools" nhưng không mount MCP server nào (mcpServer) — bỏ "mcpTools" hoặc mount một MCP server.',
      );
    }
    if (allowWrite) {
      throw new Error(
        'Local API MCP mount: đã đặt "allowWriteTools: true" nhưng không mount MCP server nào (mcpServer) — bỏ "allowWriteTools" hoặc mount một MCP server.',
      );
    }
    return { allowedNames: null, annotationWriteToolNames };
  }
  const selection = mcpTools ?? 'all-read-only';
  if (selection === 'all') {
    if (!allowWrite) {
      throw new Error(
        'Local API MCP mount: mcpTools "all" expose cả tool ghi (shell_exec, write_file, ...) qua HTTP — chỉ được khi host truyền kèm "allowWriteTools: true" rõ ràng.',
      );
    }
    return {
      allowedNames: effectiveKnownToolNames === null ? null : new Set(effectiveKnownToolNames),
      annotationWriteToolNames,
    };
  }
  if (selection === 'all-read-only') {
    if (effectiveKnownToolNames === null) return { allowedNames: null, annotationWriteToolNames };
    // W19c: strict chỉ siết chế độ từ khóa 'all-read-only' — danh
    // sách tường minh và 'all' không đi qua nhánh này nên không bị
    // ảnh hưởng. Tool không annotation bị loại ở đây vì
    // `annotationsByName` không có nó (hoặc annotation của nó
    // không có `readOnlyHint: true`).
    return {
      allowedNames: new Set(
        effectiveKnownToolNames.filter(
          (name) =>
            !isWriteTool(name) &&
            (!strictReadOnly || isReadOnlyByAnnotations(annotationsByName.get(name))),
        ),
      ),
      annotationWriteToolNames,
    };
  }
  if (Array.isArray(selection)) {
    for (const name of selection) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(
          'Local API MCP mount: "mcpTools" dạng danh sách chỉ nhận tên tool là chuỗi không rỗng.',
        );
      }
    }
    const requested = [...new Set(selection)];
    if (effectiveKnownToolNames === null) {
      throw new Error(
        'Local API MCP mount: "mcpTools" dạng danh sách cụ thể cần mounted MCP server expose "listToolNames()" để kiểm tra tool có tồn tại không (server từ createMcpServer có sẵn) — mount tối thiểu không kiểm tra được nên không nhận danh sách cụ thể.',
      );
    }
    const known = new Set(effectiveKnownToolNames);
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `Local API MCP mount: tool không tồn tại trên MCP server đã mount: ${unknown.map((n) => `"${n}"`).join(', ')}. Các tool có sẵn: ${effectiveKnownToolNames.map((n) => `"${n}"`).join(', ') || '(không có tool nào)'}.`,
      );
    }
    if (!allowWrite) {
      const writeRequested = requested.filter((name) => isWriteTool(name));
      if (writeRequested.length > 0) {
        throw new Error(
          `Local API MCP mount: tool ghi ${writeRequested.map((n) => `"${n}"`).join(', ')} không được expose qua HTTP khi chưa có "allowWriteTools: true" — bỏ tool ghi khỏi "mcpTools" hoặc truyền kèm "allowWriteTools: true".`,
        );
      }
    }
    return { allowedNames: new Set(requested), annotationWriteToolNames };
  }
  throw new Error(
    'Local API MCP mount: "mcpTools" phải là string[] | "all-read-only" | "all".',
  );
}

export interface LocalApiServer {
  /** Port actually bound (useful when `port: 0` was requested). */
  readonly port: number;
  readonly isRunning: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of all runs known so far (copy, newest last). */
  listRuns(): ApiRunRecord[];
  getRun(runId: string): ApiRunRecord | undefined;
  /** v0.90d: số kết nối TCP đang mở (dùng cho test cap + chẩn đoán). */
  getConnectionCount(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * v0.13+: mount A2A nào có `startStream` (server thật từ
 * `createA2aServer`) thì mount stream SSE được cho `message:stream`;
 * mount tối thiểu chỉ có 3 method trong `MountedA2aServer` thì không
 * — `message:stream` rơi xuống chạy-tới-hoàn-thành như trước. Check
 * structural ở runtime để không phải sửa `MountedA2aServer` trong
 * types.ts (mount vẫn nhận mọi server đủ 3 method cũ).
 */
interface A2aStreamCapableMount {
  startStream(
    input: { message: A2aMessage; text: string; contextId?: string },
    onEvent: (event: A2aStreamEvent) => void,
  ): { taskId: string; task: A2aTask; done: Promise<A2aTask>; cancel: () => void };
}

function asStreamCapableMount(server: unknown): A2aStreamCapableMount | null {
  if (!isRecord(server) || typeof server['startStream'] !== 'function') return null;
  return server as unknown as A2aStreamCapableMount;
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket server framing (v0.8, no dependency).
// ---------------------------------------------------------------------------

function computeWsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Serialise one server -> client frame (servers never mask). */
function buildWsFrame(opcode: number, payload: Buffer): Buffer {
  const finOpcode = 0x80 | (opcode & 0x0f);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([finOpcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = finOpcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = finOpcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface WsConnectionHandlers {
  /** A complete text message arrived (binary frames are refused). */
  onMessage?: (text: string) => void;
  /** The socket closed (cleanly or not); no more sends will succeed. */
  onClose?: (code: number) => void;
}

/** What `startStreamRun` hands back so the upgrade handler can route socket events into the run (v0.9a). */
interface StreamRunControl {
  run: ApiRunRecord;
  /** One client -> server control message (JSON text). */
  handleControlMessage: (text: string) => void;
  /** The socket closed; the run stops with it. */
  handleSocketClose: () => void;
}

/**
 * One accepted WebSocket connection: parses client frames (masked,
 * fragmented, ping/pong/close handled) and sends text frames.
 * Text messages are delivered to `handlers.onMessage` — since v0.9a
 * the stream endpoint uses them as control messages (stop /
 * approval-response / ask-user-response); the server decides what
 * each message means.
 */
class WsConnection {
  private buf = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly handlers: WsConnectionHandlers,
  ) {
    socket.on('error', () => this.closeLocally(1011));
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed;
  }

  /** Feed bytes read from the socket (including the upgrade `head`). */
  push(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    try {
      this.parseLoop();
    } catch {
      // A framing error already closed the socket; nothing more to do.
    }
  }

  sendText(text: string): void {
    if (this.isClosed) return;
    try {
      this.socket.write(buildWsFrame(0x1, Buffer.from(text, 'utf-8')));
    } catch {
      this.closeLocally(1011);
    }
  }

  sendClose(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const reasonBuf = Buffer.from(reason, 'utf-8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this.socket.write(buildWsFrame(0x8, payload));
    } catch {
      // Best-effort: the socket may already be gone.
    }
    this.socket.end();
  }

  private closeLocally(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose?.(code);
    try {
      this.socket.destroy();
    } catch {
      // Already gone.
    }
  }

  private protocolError(): never {
    this.sendClose(1002, 'Protocol error.');
    throw new Error('WebSocket protocol error.');
  }

  private parseLoop(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (rsv !== 0) this.protocolError();
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_MESSAGE_BYTES)) {
          this.sendClose(1009, 'Message too big.');
          throw new Error('WebSocket message too big.');
        }
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_WS_MESSAGE_BYTES) {
        this.sendClose(1009, 'Message too big.');
        throw new Error('WebSocket message too big.');
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      this.buf = this.buf.subarray(offset + maskLen + len);
      this.handleFrame(fin, opcode, masked, payload);
      if (this.closed) return;
    }
  }

  private handleFrame(fin: boolean, opcode: number, masked: boolean, payload: Buffer): void {
    // Control frames (8/9/10) must not be fragmented; data frames from
    // a client must be masked (RFC 6455 §5.1/§5.5).
    if (opcode >= 0x8) {
      if (!fin) this.protocolError();
      if (!masked) this.protocolError();
      if (opcode === 0x8) {
        // Close: echo it back, then end. Code 1005 = no code sent.
        let code = 1005;
        if (payload.length >= 2) code = payload.readUInt16BE(0);
        this.sendClose(Number.isNaN(code) ? 1000 : code);
        this.handlers.onClose?.(code);
        return;
      }
      if (opcode === 0x9) {
        // Ping -> pong with the same payload.
        try {
          this.socket.write(buildWsFrame(0xa, payload));
        } catch {
          this.closeLocally(1011);
        }
        return;
      }
      if (opcode === 0xa) return; // pong: ignore.
      this.protocolError();
    }
    if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) this.protocolError();
    if (!masked) this.protocolError();
    if (opcode === 0x2) {
      // Binary frames are not part of this protocol.
      this.sendClose(1003, 'Binary frames are not supported.');
      throw new Error('WebSocket binary frame.');
    }
    if (opcode === 0x0) {
      // Continuation of a fragmented message.
      if (this.fragments.length === 0 && this.fragmentOpcode === 0) this.protocolError();
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_WS_MESSAGE_BYTES) {
        this.sendClose(1009, 'Message too big.');
        throw new Error('WebSocket message too big.');
      }
      if (fin) this.deliverMessage();
      return;
    }
    // Text frame: start of a (possibly fragmented) message.
    if (this.fragments.length > 0) this.protocolError();
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments.push(payload);
      this.fragmentBytes = payload.length;
      return;
    }
    this.fragments = [payload];
    this.fragmentOpcode = opcode;
    this.deliverMessage();
  }

  private deliverMessage(): void {
    const payload = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentBytes = 0;
    this.handlers.onMessage?.(payload.toString('utf-8'));
  }
}

/**
 * W19c: `strictReadOnly?: boolean` (mặc định `false`) — xem docstring
 * ở `CreateApiServerOptions` (types.ts). Chỉ có ý nghĩa khi mount MCP
 * ở chế độ `'all-read-only'`; danh sách tường minh và `'all'` không
 * bị ảnh hưởng (xem `resolveMcpMountTools`).
 */
export function createApiServer(
  options: CreateApiServerOptions,
): LocalApiServer {
  if (!options.token || typeof options.token !== 'string') {
    throw new Error('Local API needs a non-empty token.');
  }
  if (!options.handlers) throw new Error('Local API needs handlers.');
  const requestedPort = options.port ?? 0;
  const { token, handlers, onRunSettled, mcpServer, a2aServer } = options;
  // v0.19: giải quyết mcpTools / allowWriteTools NGAY lúc mount —
  // cấu hình sai (tool không tồn tại, xin tool ghi không opt-in,
  // 'all' không kèm allowWriteTools) ném lỗi rõ ở đây, trước khi
  // server bind, thay vì im lặng expose sai tập tool.
  const allowWriteTools = options.allowWriteTools === true;
  // W19c: strictReadOnly — xem docstring trên createApiServer.
  const strictReadOnly = options.strictReadOnly === true;
  const mcpMount = resolveMcpMountTools({
    mcpTools: options.mcpTools,
    allowWriteTools,
    strictReadOnly,
    knownToolNames:
      mcpServer && typeof mcpServer.listToolNames === 'function'
        ? mcpServer.listToolNames()
        : null,
    // W13e: đọc defs (tên + annotations) ĐỒNG BỘ lúc mount để
    // phân loại tool ghi theo annotation ngay từ đầu. Server
    // không có method này (ngoài / cũ) → null, fallback W12c.
    knownToolDefinitions:
      mcpServer && typeof mcpServer.listToolDefinitions === 'function'
        ? mcpServer.listToolDefinitions()
        : null,
    hasMcpServer: mcpServer !== undefined && mcpServer !== null,
  });
  /**
   * W17c: chế độ chọn tool của mount này — quyết định
   * `currentAllowedNames` có được làm mới theo defs hiện tại hay
   * không (xem `refreshMcpMountToolSets` dưới đây):
   * - `'all-read-only'` / `'all'` (dạng từ khóa): `allowedNames`
   *   lúc mount chỉ là ảnh chụp defs lúc đó, được tính LẠI mỗi
   *   lần refresh — tool read-only mới (`'all-read-only'`) hoặc
   *   tool mới bất kỳ (`'all'`, chỉ dùng kèm `allowWriteTools:
   *   true`) được hợp nhất vào tập; tool đã bị server gỡ khỏi
   *   defs bị LOẠI khỏi tập (server không còn cung cấp nó nên giữ
   *   tên trong allowlist cũng vô nghĩa — và giữ lại sẽ để
   *   `tools/call` lọt qua gate của mount rồi mới lỗi ở server
   *   dưới).
   * - Danh sách tường minh (`string[]`): `allowedNames` ĐÓNG BĂNG
   *   đúng list host đã khai lúc mount — không tự thêm tool lạ
   *   (kể cả read-only), cũng không tự bớt tool khỏi list (list
   *   là hợp đồng tường minh của host; tool trong list mà server
   *   đã gỡ thì server tự không trả nó trong `tools/list` / tự
   *   lỗi khi `tools/call`, nên giữ tên trong allowlist không
   *   expose thêm gì — và gate tool ghi theo annotation/tên vẫn
   *   chặn trước gate allowlist nếu tool đó đăng ký lại dưới dạng
   *   tool ghi).
   * - `allowedNames === null` (mount tối thiểu, server không
   *   expose tên/defs lúc mount): không có tập để làm mới — mọi
   *   tool qua được gate allowlist, chỉ gate tool ghi còn hiệu lực.
   */
  const mcpMountSelection: McpMountToolsOption = options.mcpTools ?? 'all-read-only';
  const mcpMountIsExplicitList = Array.isArray(mcpMountSelection);
  /** W17c: tập tool mount được expose HIỆN TẠI (xem trên). */
  let currentAllowedNames: Set<string> | null = mcpMount.allowedNames;
  /**
   * v0.19: annotation ghi đã thấy qua response `tools/list` của
   * server đã mount (tên tool -> có phải tool ghi không). Dùng để
   * chặn `tools/call` cho tool ghi mang tên lạ mà lúc mount không
   * nhận diện được bằng tên — chỉ có hiệu lực sau khi client đã
   * gọi `tools/list` một lần; trước đó chỉ có gate theo tên.
   * W13e: với server expose `listToolDefinitions()` thì lớp này
   * chỉ còn là backstop cho tool đăng ký SAU lúc mount (hoặc
   * server ngoài không có defs lúc mount) — tool ghi đã biết
   * lúc mount nằm trong `mcpMount.annotationWriteToolNames` và
   * bị chặn ngay cả trước `tools/list` đầu tiên.
   * W14d: lớp này giờ chỉ còn là backstop cho server KHÔNG có
   * `listToolDefinitions()` — với server có method đó thì
   * `refreshMcpMountToolSets()` (dưới đây) đọc lại defs mỗi lần
   * xử lý `tools/list` / `tools/call`, nên tool đăng ký sau lúc
   * mount đã bị chặn ngay cả trước `tools/list` đầu tiên.
   */
  const mcpObservedWriteAnnotations = new Map<string, boolean>();
  /**
   * W19c: annotation read-only đã thấy qua response `tools/list`
   * của server đã mount (tên tool -> có `readOnlyHint: true`
   * tường minh không). Backstop cho mount tối thiểu
   * (`allowedNames === null`, server không expose tên/defs lúc
   * mount): ở chế độ strict + `'all-read-only'`, `tools/call`
   * của tool đã thấy qua list mà KHÔNG có `readOnlyHint: true`
   * bị chặn (xem `mcpMountCallBlockReason`). Tool chưa từng thấy
   * qua list thì không có bằng chứng nào — mount cho qua (giới
   * hạn đã biết: server tối thiểu không có defs để kiểm chứng
   * trước list; `tools/list` vẫn lọc nó ra, xem
   * `handleMcpMountJsonRpc`).
   */
  const mcpObservedReadOnlyAnnotations = new Map<string, boolean>();

  /**
   * W14d: tập tool ghi theo annotation HIỆN TẠI — khởi đầu là
   * snapshot lúc mount (`mcpMount.annotationWriteToolNames`),
   * được `refreshMcpMountToolSets()` cập nhật mỗi lần xử lý
   * `tools/list` / `tools/call` (xem dưới). Tool đăng ký lên MCP
   * server SAU lúc mount (gap W13e để lại: defs lúc mount không
   * có nó, chỉ bị chặn sau khi client đã `tools/list` một lần)
   * giờ bị chặn ngay cả khi client chưa từng `tools/list`.
   */
  let currentAnnotationWriteToolNames: Set<string> = mcpMount.annotationWriteToolNames;

  /**
   * W14d + W17c: đọc lại `listToolDefinitions()` (chỉ tên +
   * annotations, đồng bộ, rẻ) để các tập tool của mount luôn mới
   * nhất — gọi mỗi lần xử lý `tools/list` / `tools/call` có `id`
   * (xem `handleMcpMountJsonRpc`). Một lần đọc cập nhật cả hai:
   * - `currentAnnotationWriteToolNames`: tập tool ghi theo
   *   annotation hiện tại (W14d) — tool ghi đăng ký sau lúc mount
   *   bị chặn ngay cả trước `tools/list` đầu tiên.
   * - `currentAllowedNames` (W17c): chỉ với mount dạng từ khóa
   *   (`'all-read-only'` / `'all'`) và khi tập này là một `Set`
   *   (server expose được tên/defs lúc mount) — tính lại từ defs
   *   vừa đọc: tool MỚI là read-only (`readOnlyHint !== false`,
   *   `destructiveHint !== true`, tên không nằm trong
   *   `MCP_MOUNT_WRITE_TOOL_NAMES`) được hợp nhất vào tập
   *   (`'all'` thì hợp nhất mọi tool mới, kể cả write — chế độ
   *   này chỉ dùng kèm `allowWriteTools: true`); tool mới là
   *   write thì KHÔNG thêm (đã ghi vào tập annotation-write trên
   *   để chặn gọi); tool đã bị server gỡ khỏi defs thì bị LOẠI
   *   khỏi tập. W19c: với `'all-read-only'` + `strictReadOnly:
   *   true`, "read-only" ở đây nghĩa hẹp hơn — chỉ tool gắn
   *   `readOnlyHint: true` tường minh mới được thêm; tool mới
   *   không annotation không được thêm (kể cả khi nó là read-only
   *   thật). Mount danh sách tường minh giữ nguyên tập lúc
   *   mount (xem ghi chú ở `mcpMountIsExplicitList`); mount tối
   *   thiểu (`allowedNames === null`) không có tập để làm mới.
   * Chỉ gọi khi server đã mount có method đó; server không có
   * method này thì giữ nguyên các tập hiện tại (backstop là
   * `mcpObservedWriteAnnotations`). Nếu `listToolDefinitions()`
   * throw hoặc trả về không phải mảng thì giữ nguyên các tập hiện
   * tại (fallback về defs lúc mount / lần đọc tốt gần nhất) — không
   * bao giờ crash request vì lỗi đọc defs.
   */
  function refreshMcpMountToolSets(): void {
    if (!mcpServer || typeof mcpServer.listToolDefinitions !== 'function') return;
    let defs: unknown;
    try {
      defs = mcpServer.listToolDefinitions();
    } catch {
      return;
    }
    if (!Array.isArray(defs)) return;
    const freshWrite = new Set<string>();
    // W19c: tool gắn `readOnlyHint: true` tường minh trong defs
    // vừa đọc — dùng để làm mới allowedNames ở chế độ strict.
    const freshReadOnly = new Set<string>();
    const freshNames: string[] = [];
    for (const def of defs) {
      if (!isRecord(def) || typeof def['name'] !== 'string' || def['name'].length === 0) continue;
      const name = def['name'] as string;
      freshNames.push(name);
      if (isWriteToolByAnnotations(def['annotations'])) freshWrite.add(name);
      if (isReadOnlyByAnnotations(def['annotations'])) freshReadOnly.add(name);
    }
    currentAnnotationWriteToolNames = freshWrite;
    // W17c: làm mới allowedNames — chỉ mount dạng từ khóa, tập Set.
    if (currentAllowedNames === null || mcpMountIsExplicitList) return;
    if (mcpMountSelection === 'all') {
      currentAllowedNames = new Set(freshNames);
    } else {
      // 'all-read-only': chỉ tool read-only (theo tên + annotation mới).
      // W19c: strict thì chỉ tool gắn `readOnlyHint: true` tường
      // minh; tool mới không annotation không được thêm.
      currentAllowedNames = new Set(
        freshNames.filter(
          (name) =>
            !isMcpMountWriteTool(name) &&
            !freshWrite.has(name) &&
            (!strictReadOnly || freshReadOnly.has(name)),
        ),
      );
    }
  }

  /**
   * v0.19: lý do chặn `tools/call` cho `name`, hoặc null khi được
   * phép. Áp dụng cả khi mount đã lọc bằng tên (`allowedNames`)
   * và khi mount chạy ở chế độ "mọi tool trừ tool ghi"
   * (`allowedNames === null`, mount tối thiểu + từ khóa).
   */
  function mcpMountCallBlockReason(name: string): string | null {
    // Tool ghi báo lý do "tool ghi" trước (kèm cách mở allowWriteTools)
    // — hữu ích hơn "ngoài danh sách" khi mount mặc định chặn shell_exec.
    if (!allowWriteTools) {
      if (isMcpMountWriteTool(name)) {
        return `Tool ghi "${name}" không được expose trên mount MCP của Local API khi chưa có allowWriteTools: true.`;
      }
      // W13e + W14d: tool ghi theo annotation — tập này được đọc
      // lúc mount và đọc LẠI mỗi lần xử lý tools/list / tools/call
      // (xem refreshMcpMountToolSets), nên tool đăng ký sau
      // lúc mount cũng bị chặn cả khi client gọi tools/call trước
      // tools/list.
      if (currentAnnotationWriteToolNames.has(name)) {
        return `Tool ghi "${name}" (annotation readOnlyHint: false / destructiveHint: true) không được expose trên mount MCP của Local API khi chưa có allowWriteTools: true.`;
      }
      if (mcpObservedWriteAnnotations.get(name) === true) {
        return `Tool ghi "${name}" (annotation readOnlyHint: false / destructiveHint: true) không được expose trên mount MCP của Local API khi chưa có allowWriteTools: true.`;
      }
    }
    // W19c: strict + 'all-read-only' với mount tối thiểu
    // (`allowedNames === null`, server không expose tên/defs lúc
    // mount nên không có tập để gate): tool đã thấy qua
    // `tools/list` mà KHÔNG gắn `readOnlyHint: true` tường minh
    // thì bị chặn ở đây — kể cả tool không annotation (đó chính
    // là case strict sinh ra để chặn). Khi `allowedNames` là
    // một `Set` thì gate allowlist dưới đây đã loại tool đó rồi
    // (resolve + refresh đều áp strict), không cần nhánh này.
    // Tool chưa từng thấy qua list thì không có bằng chứng nào —
    // cho qua (giới hạn đã biết, xem `mcpObservedReadOnlyAnnotations`).
    if (
      strictReadOnly &&
      mcpMountSelection === 'all-read-only' &&
      currentAllowedNames === null &&
      mcpObservedReadOnlyAnnotations.get(name) === false
    ) {
      return `Tool "${name}" không được expose trên mount MCP của Local API ở chế độ strictReadOnly (chỉ tool gắn annotation readOnlyHint: true mới được expose).`;
    }
    if (currentAllowedNames && !currentAllowedNames.has(name)) {
      return `Tool "${name}" không được expose trên mount MCP của Local API (mcpTools của mount này không gồm nó).`;
    }
    return null;
  }

  /**
   * v0.19: wrapper quanh `mcpServer.handleJsonRpc` — mount KHÔNG
   * mutate server đã mount, chỉ lọc ở đây:
   * - `tools/list`: bỏ tool ngoài `allowedNames`, bỏ tool ghi khi
   *   chưa có `allowWriteTools` (theo tên + annotation trong
   *   response), đồng thời ghi nhớ annotation để chặn `tools/call`.
   * - `tools/call`: chặn trước khi gọi xuống server (mã -32602,
   *   cùng mã server gốc dùng cho tool không nằm trong allowlist)
   *   khi tool ngoài tập mount hoặc là tool ghi chưa được opt-in.
   *   Notification (không có `id`) không bao giờ thực thi trên
   *   server MCP nên cho qua nguyên vẹn.
   * Mọi method khác (initialize, ping, resources, prompts, ...)
   * cho qua nguyên vẹn.
   * W14d: trước khi xử lý `tools/list` / `tools/call` (request có
   * `id`), đọc lại `listToolDefinitions()` để tập tool ghi theo
   * annotation luôn mới nhất — tool đăng ký sau lúc mount bị chặn
   * ngay cả trước `tools/list` đầu tiên. Chỉ đọc khi server có
   * method đó; lỗi đọc defs thì fallback về tập lúc mount (không
   * crash request). Notification không thực thi nên không cần đọc.
   * W17c: cùng lần đọc đó làm mới luôn `currentAllowedNames`
   * (mount dạng từ khóa) — tool read-only đăng ký sau lúc mount
   * được expose ngay, tool đã bị server gỡ thì biến mất khỏi
   * mount; mount danh sách tường minh giữ nguyên tập lúc mount.
   */
  async function handleMcpMountJsonRpc(body: unknown): Promise<unknown> {
    if (!mcpServer) return null;
    if (
      isRecord(body) &&
      typeof body['method'] === 'string' &&
      body['id'] !== undefined &&
      body['id'] !== null
    ) {
      if (body['method'] === 'tools/list' || body['method'] === 'tools/call') {
        refreshMcpMountToolSets();
      }
      if (body['method'] === 'tools/call') {
        const params = isRecord(body['params']) ? body['params'] : {};
        const name = params['name'];
        if (typeof name === 'string' && name.length > 0) {
          const reason = mcpMountCallBlockReason(name);
          if (reason) {
            return {
              jsonrpc: '2.0',
              id: body['id'],
              error: { code: -32602, message: reason },
            };
          }
        }
        // Tên thiếu/sai kiểu: để server gốc trả -32602 của nó.
      }
    }
    const response = await mcpServer.handleJsonRpc(body);
    if (
      isRecord(body) &&
      body['method'] === 'tools/list' &&
      isRecord(response)
    ) {
      const result = response['result'];
      if (isRecord(result) && Array.isArray(result['tools'])) {
        const filtered = (result['tools'] as unknown[]).filter((entry) => {
          if (!isRecord(entry) || typeof entry['name'] !== 'string') return false;
          const name = entry['name'] as string;
          const isWrite =
            isMcpMountWriteTool(name) ||
            currentAnnotationWriteToolNames.has(name) ||
            isWriteToolByAnnotations(entry['annotations']);
          mcpObservedWriteAnnotations.set(name, isWrite);
          // W19c: ghi nhớ annotation read-only đã thấy (backstop
          // cho gate tools/call của mount tối thiểu, xem
          // `mcpMountCallBlockReason`).
          mcpObservedReadOnlyAnnotations.set(name, isReadOnlyByAnnotations(entry['annotations']));
          if (currentAllowedNames && !currentAllowedNames.has(name)) return false;
          if (!allowWriteTools && isWrite) return false;
          // W19c: strict + 'all-read-only' — chỉ tool gắn
          // `readOnlyHint: true` tường minh mới lộ trong list.
          // Không áp cho danh sách tường minh (hợp đồng của host
          // thắng strict) hay 'all' (đã cho phép write); khi
          // `allowedNames` là Set thì resolve + refresh đã loại
          // tool này rồi, nhánh này chỉ còn ý nghĩa với mount tối
          // thiểu (`allowedNames === null`).
          if (
            strictReadOnly &&
            mcpMountSelection === 'all-read-only' &&
            !isReadOnlyByAnnotations(entry['annotations'])
          ) {
            return false;
          }
          return true;
        });
        return { ...response, result: { ...result, tools: filtered } };
      }
    }
    return response;
  }
  // v0.7: tokens accepted = main API token + service-account tokens.
  // v0.85a (P0-1): each accepted token carries its scope into the
  // auth context of every request. The main token and legacy bare
  // string tokens have scope `undefined` = full access (deliberate
  // backwards compatibility — see `ApiExtraToken` in types.ts).
  // Only a token that explicitly declares `scope: 'run'` is
  // restricted. An entry whose `scope` is present but not 'run' /
  // 'admin' is a host config error and fails server creation
  // (fail-closed: never silently treat a bad scope as full access).
  interface AcceptedToken {
    token: string;
    scope: ServiceAccountScope | undefined;
  }
  function normalizeExtraToken(entry: ApiExtraToken): AcceptedToken | null {
    if (typeof entry === 'string') {
      return entry.length > 0 ? { token: entry, scope: undefined } : null;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string' || entry.token.length === 0) {
      return null;
    }
    if (entry.scope !== undefined && entry.scope !== 'run' && entry.scope !== 'admin') {
      throw new Error(
        `Local API extra token has an invalid scope ${JSON.stringify(entry.scope)} (expected 'run' or 'admin').`,
      );
    }
    return { token: entry.token, scope: entry.scope };
  }
  const acceptedTokens: AcceptedToken[] = [
    { token, scope: undefined },
    ...(options.extraTokens ?? []).map(normalizeExtraToken).filter((t): t is AcceptedToken => t !== null),
  ];
  // v0.7: team the tokens are bound to (undefined = no team check).
  const boundTeamId = options.teamId || undefined;

  // -------------------------------------------------------------------------
  // v0.90d: rate limiting (token bucket) + giới hạn kết nối.
  // -------------------------------------------------------------------------

  const rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 0) {
    throw new Error(
      'Local API rateLimitPerMinute phải là số nguyên >= 0 (0 = tắt giới hạn tốc độ).',
    );
  }
  const maxConnections = options.maxConnections ?? MAX_API_CONNECTIONS;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error('Local API maxConnections phải là số nguyên >= 1.');
  }
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;
  if (!Number.isInteger(maxConnectionsPerIp) || maxConnectionsPerIp < 1) {
    throw new Error('Local API maxConnectionsPerIp phải là số nguyên >= 1.');
  }
  const headersTimeoutMs = options.headersTimeoutMs ?? API_HEADERS_TIMEOUT_MS;
  if (!Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 0) {
    throw new Error('Local API headersTimeoutMs phải là số nguyên >= 0 (0 = tắt).');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 0) {
    throw new Error('Local API requestTimeoutMs phải là số nguyên >= 0 (0 = tắt).');
  }
  // v0.90d: luật của Node (constructor http.Server ném
  // ERR_OUT_OF_RANGE khi headersTimeout > requestTimeout) — ở đây
  // throw sớm với message rõ thay vì để Node âm thầm SWAP hai giá
  // trị trong checker (ConnectionsList::Expired swap khi
  // headersTimeout > requestTimeout), khiến requestTimeout hiệu lực
  // thành giá trị headers cũ. Test bắt được case này: chỉ truyền
  // requestTimeoutMs 300 (headers mặc định 30s) thì body dở không
  // bị cắt sau 3s vì đã bị swap thành 30s.
  if (
    requestTimeoutMs > 0 &&
    headersTimeoutMs > 0 &&
    headersTimeoutMs > requestTimeoutMs
  ) {
    throw new Error(
      `Local API headersTimeoutMs (${headersTimeoutMs}) phải <= requestTimeoutMs (${requestTimeoutMs}) — luật của Node (nếu không Node sẽ swap hai giá trị).`,
    );
  }
  const connectionsCheckingIntervalMs =
    options.connectionsCheckingIntervalMs ?? API_CONNECTIONS_CHECKING_INTERVAL_MS;
  if (!Number.isInteger(connectionsCheckingIntervalMs) || connectionsCheckingIntervalMs < 1) {
    throw new Error('Local API connectionsCheckingIntervalMs phải là số nguyên >= 1.');
  }

  interface RateBucket {
    tokens: number;
    lastRefillMs: number;
  }
  const rateBuckets = new Map<string, RateBucket>();

  /**
   * v0.90d: token bucket theo client — key = IP + fingerprint
   * (sha256 rút gọn, 12 ký tự hex) của token ĐÃ KHỚP, hoặc `anon`
   * khi request không mang Bearer hợp lệ. Bucket đầy = đúng
   * `rateLimitPerMinute` token; refill tuyến tính theo thời gian
   * (120/phút ≈ 2 token/giây). Trả `retryAfterSeconds` khi hết
   * token (làm tròn lên, tối thiểu 1s). Bucket cũ được dọn cơ hội
   * (khi map > 512 entry, xoá entry im lặng quá 2 cửa sổ).
   * Token không bao giờ được log — key chỉ chứa hash rút gọn.
   */
  function checkRateLimit(
    req: http.IncomingMessage,
    auth: AcceptedToken | null,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    if (rateLimitPerMinute === 0) return { allowed: true };
    const ip = req.socket.remoteAddress ?? 'unknown';
    const fingerprint = auth
      ? createHash('sha256').update(auth.token).digest('hex').slice(0, 12)
      : 'anon';
    const key = `${ip}|${fingerprint}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: rateLimitPerMinute, lastRefillMs: now };
      rateBuckets.set(key, bucket);
    }
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs > 0) {
      bucket.tokens = Math.min(
        rateLimitPerMinute,
        bucket.tokens + (elapsedMs * rateLimitPerMinute) / RATE_LIMIT_WINDOW_MS,
      );
      bucket.lastRefillMs = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    if (rateBuckets.size > 512) {
      for (const [k, b] of rateBuckets) {
        if (now - b.lastRefillMs > 2 * RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
      }
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((1 - bucket.tokens) * RATE_LIMIT_WINDOW_MS) / rateLimitPerMinute / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }

  /** v0.90d: số kết nối đang mở trên mỗi IP (đếm ở 'connection', trừ ở 'close'). */
  const perIpConnections = new Map<string, number>();

  /**
   * v0.90d: nhận một socket TCP mới — trả false khi vượt cap trên
   * mỗi IP (caller destroy socket ngay, không treo). Socket được
   * nhận thì vào `sockets` (để `stop()` destroy khi tắt server)
   * và đếm theo IP; 'close' trừ đếm (kể cả khi Node tự đóng socket
   * vì `maxConnections`).
   */
  function trackConnection(socket: Socket): boolean {
    const ip = socket.remoteAddress ?? 'unknown';
    const count = (perIpConnections.get(ip) ?? 0) + 1;
    if (count > maxConnectionsPerIp) {
      if (options.onConnectionRejected) {
        options.onConnectionRejected({ remoteAddress: ip, reason: 'per-ip-cap' });
      } else {
        // 1 dòng, chỉ IP (loopback) — không token, không nội dung request.
        console.warn(
          `[open-bot] Local API: từ chối kết nối từ ${ip} (vượt ${maxConnectionsPerIp} kết nối/IP).`,
        );
      }
      return false;
    }
    perIpConnections.set(ip, count);
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      const next = (perIpConnections.get(ip) ?? 1) - 1;
      if (next <= 0) perIpConnections.delete(ip);
      else perIpConnections.set(ip, next);
    });
    return true;
  }

  const runs = new Map<string, ApiRunRecord>();
  const sockets = new Set<import('node:net').Socket>();
  let server: http.Server | null = null;
  /** v0.90d: true từ lúc `stop()` bắt đầu — để 'close' của server không báo nhầm là chết đột ngột. */
  let stopping = false;
  let boundPort = 0;

  function sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendError(res: http.ServerResponse, status: number, message: string): void {
    sendJson(res, status, { error: message });
  }

  /**
   * Timing-safe comparison against every accepted token (v0.7: the
   * plain `===` of v0.5 is replaced — the server still binds loopback
   * only, but there is no reason to keep a timing leak). Different
   * lengths short-circuit to false without leaking which token.
   *
   * v0.85a (P0-1): returns the matched token's scope (or null when
   * no token matches) instead of a bare boolean — the scope is the
   * request's auth context and decides admin-only routes below.
   * `undefined` scope = main token or legacy unscoped token (full
   * access); `'run'` = run-only; `'admin'` = full access.
   */
  function matchToken(presented: string): AcceptedToken | null {
    const presentedBuf = Buffer.from(presented, 'utf8');
    for (const candidate of acceptedTokens) {
      const candidateBuf = Buffer.from(candidate.token, 'utf8');
      if (presentedBuf.length !== candidateBuf.length) continue;
      if (timingSafeEqual(presentedBuf, candidateBuf)) return candidate;
    }
    return null;
  }

  /**
   * Auth context of a request: the matched token's scope, or null
   * when the request carries no valid Bearer token.
   */
  function resolveAuth(req: http.IncomingMessage): AcceptedToken | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return null;
    return matchToken(header.slice(prefix.length));
  }

  /**
   * v0.85a (P0-1): admin-only routes refuse a `run`-scoped token
   * with a clear 403. Returns the error message when the scope is
   * `run`, null otherwise (main token, `admin` token, legacy
   * unscoped token all keep full access).
   */
  function runScopeDeniedMessage(scope: ServiceAccountScope | undefined): string | null {
    if (scope !== 'run') return null;
    return 'Token scope "run" không được phép dùng route này — cần token scope "admin" hoặc token chính của Local API.';
  }

  /**
   * v0.7: when the server is bound to a team, the client must prove
   * it knows the team too (`X-Open-Bot-Team`). The token alone is
   * not enough — a token copied from another team must not work.
   * Returns null when the check passes (or is not configured).
   */
  function teamCheckError(req: http.IncomingMessage): string | null {
    if (!boundTeamId) return null;
    const header = req.headers['x-open-bot-team'];
    const sent = Array.isArray(header) ? header[0] : header;
    if (typeof sent !== 'string' || sent.length === 0) {
      return 'Missing X-Open-Bot-Team header.';
    }
    if (sent !== boundTeamId) return 'Team header does not match this server.';
    return null;
  }

  /**
   * v0.59: read the request body as RAW bytes (no JSON parsing) —
   * the webhook route verifies an HMAC over the exact bytes received,
   * so re-serialising parsed JSON would break the signature. Same
   * 1 MB cap as `readJsonBody` (larger -> 400 via the outer catch).
   */
  async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > MAX_JSON_BODY_BYTES) {
        throw new Error('Request body too large (max 1 MB).');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const text = (await readRawBody(req)).toString('utf-8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Request body is not valid JSON.');
    }
  }

  function parseLimit(search: URLSearchParams): number {
    const raw = search.get('limit');
    if (raw === null) return DEFAULT_HISTORY_LIMIT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('Query parameter "limit" must be a positive integer.');
    }
    return Math.min(n, MAX_HISTORY_LIMIT);
  }

  async function findBot(botId: string): Promise<ApiBotSummary | undefined> {
    const bots = await handlers.listBots();
    return bots.find((b) => b.id === botId);
  }

  function startRun(botId: string, text: string, opts?: RunBotOptions): ApiRunRecord {
    const run: ApiRunRecord = {
      runId: randomUUID(),
      botId,
      status: 'running',
      startedAt: Date.now(),
    };
    runs.set(run.runId, run);
    // Run in the background: the HTTP request returns immediately with
    // status 'running'; the client polls GET /v1/runs/:id.
    void handlers
      .runBot(botId, text, opts)
      .then((result) => {
        run.status = 'done';
        run.text = result.text ?? '';
        run.finishedAt = Date.now();
      })
      .catch((err: unknown) => {
        run.status = 'error';
        run.error = err instanceof Error ? err.message : 'Run failed.';
        run.finishedAt = Date.now();
      })
      .finally(() => {
        // Best-effort webhook hook: a throwing listener must not
        // corrupt the run record.
        try {
          onRunSettled?.({ ...run });
        } catch {
          // ignore — the run itself already finished.
        }
      });
    return run;
  }

  /**
   * v0.8: stream one run over an accepted WebSocket. Mirrors startRun
   * (same run record, same onRunSettled webhook hook) but pushes
   * `{ kind, data }` events as the turn progresses and closes the
   * socket when the run settles. When `handlers.runBotStream` is
   * absent, the plain `runBot` result is delivered as one `delta` +
   * one `summary` event.
   *
   * v0.9a: two-way control. The first event is always `run-started`
   * (carrying the run id the client uses for control messages). The
   * handler receives that id plus an AbortSignal that fires when the
   * client stops the run or the socket closes. Control messages are
   * handled by `handleControlMessage` (called from the connection's
   * `onMessage`); a stop marks the run `stopped`, emits a `stopped`
   * event and closes (1000). Closing the socket also stops the run —
   * a stream client is watching THIS run, so leaving it running in
   * the background after disconnect would burn tokens for nobody.
   * (HTTP runs from POST /v1/bots/:id/run keep the old behaviour and
   * run to completion.) A stop is best-effort at the provider level:
   * an in-flight `provider.chat()` is not cancelled until v0.15, so
   * the underlying run may still finish in the background — its late
   * settlement is ignored once the record is `stopped`.
   */
  function startStreamRun(
    botId: string,
    text: string,
    conn: WsConnection,
    authScope: ServiceAccountScope | undefined,
  ): StreamRunControl {
    const run: ApiRunRecord = {
      runId: randomUUID(),
      botId,
      status: 'running',
      startedAt: Date.now(),
    };
    runs.set(run.runId, run);
    const controller = new AbortController();
    let settled = false;
    let notifiedSettled = false;
    let sawSummary = false;
    // Call/request ids this run is actually waiting on. A control
    // message may only answer one of these — a client must not answer
    // another socket's (or another run's) approval.
    const pendingApprovalCallIds = new Set<string>();
    const pendingAskUserRequestIds = new Set<string>();
    const pendingElicitationIds = new Set<string>();

    const notifySettled = (): void => {
      if (notifiedSettled) return;
      notifiedSettled = true;
      try {
        onRunSettled?.({ ...run });
      } catch {
        // ignore — the run itself already finished.
      }
    };

    const emit = (event: ApiStreamEvent): void => {
      if (conn.isClosed) return;
      if (event.kind === 'summary') sawSummary = true;
      if (event.kind === 'approval-needed' && isRecord(event.data) && typeof event.data.callId === 'string') {
        pendingApprovalCallIds.add(event.data.callId);
      }
      if (event.kind === 'ask-user' && isRecord(event.data) && typeof event.data.requestId === 'string') {
        pendingAskUserRequestIds.add(event.data.requestId);
      }
      if (event.kind === 'elicitation-needed' && isRecord(event.data) && typeof event.data.elicitationId === 'string') {
        pendingElicitationIds.add(event.data.elicitationId);
      }
      conn.sendText(JSON.stringify(event));
      // v0.9a: a run waiting on a human is in `input-required` state
      // (A2A task lifecycle) — sent right after the specific event so
      // a client can watch for "waiting" without knowing both kinds.
      if (event.kind === 'approval-needed' || event.kind === 'ask-user' || event.kind === 'elicitation-needed') {
        const waitingFor = event.kind;
        const extra =
          waitingFor === 'approval-needed'
            ? { callId: (event.data as { callId: string }).callId }
            : waitingFor === 'ask-user'
              ? { requestId: (event.data as { requestId: string }).requestId }
              : { elicitationId: (event.data as { elicitationId: string }).elicitationId };
        conn.sendText(
          JSON.stringify({
            kind: 'input-required',
            data: { runId: run.runId, waitingFor, ...extra },
          }),
        );
      }
    };

    const emitError = (message: string): void => {
      emit({ kind: 'error', data: { error: message } });
    };

    /**
     * Mark the run stopped, tell the client, close the socket.
     * Idempotent: the first settler wins (normal finish, error, or
     * stop), late settlements are ignored.
     */
    const finishStopped = (reason: string, closeCode = 1000, closeReason = ''): void => {
      if (settled) return;
      settled = true;
      controller.abort();
      run.status = 'stopped';
      run.finishedAt = Date.now();
      emit({ kind: 'stopped', data: { runId: run.runId, reason } });
      conn.sendClose(closeCode, closeReason);
      notifySettled();
    };

    /** Ask the handler to stop the real run, then stop the stream. */
    const requestStop = (reason: string, closeCode = 1000, closeReason = ''): void => {
      if (settled) return;
      // Best-effort, never blocking: a missing/slow/throwing stopRun
      // must not keep the client waiting — the stream stops regardless.
      if (handlers.stopRun) {
        try {
          void Promise.resolve(handlers.stopRun(run.runId)).catch(() => undefined);
        } catch {
          // ignore — the stream still stops below.
        }
      }
      finishStopped(reason, closeCode, closeReason);
    };

    const handleControlMessage = (messageText: string): void => {
      if (settled) return;
      let msg: unknown;
      try {
        msg = JSON.parse(messageText);
      } catch {
        // Non-JSON text is a protocol error: close (1007) and stop
        // the run, like any other disconnect.
        requestStop('control message không phải JSON', 1007, 'Control message must be JSON.');
        return;
      }
      if (!isRecord(msg) || typeof msg.type !== 'string') {
        emitError(
          'Control message phải là JSON { type: "stop" | "cancel" | "answer" | "approval-response" | "ask-user-response" | "elicitation-response", ... }.',
        );
        return;
      }
      // P1-10: `{type:"answer", ...}` là message trả lời thống nhất —
      // client không cần biết run đang chờ loại nào, chỉ cần gửi kèm
      // id của thứ đang chờ (`callId` approval / `requestId` ask-user /
      // `elicitationId` elicitation). Route theo id có mặt rồi chạy
      // đúng nhánh chuyên biệt bên dưới (cùng kiểm tra pending +
      // cùng handler RPC), nên answer với id lạ cũng nhận đúng error
      // event như message chuyên biệt. Chỉ đổi loại message hiệu lực
      // (không gán lại `msg` để khỏi mất type narrowing).
      let effectiveType = msg.type;
      if (msg.type === 'answer') {
        if (typeof msg.callId === 'string') {
          effectiveType = 'approval-response';
        } else if (typeof msg.requestId === 'string') {
          effectiveType = 'ask-user-response';
        } else if (typeof msg.elicitationId === 'string') {
          effectiveType = 'elicitation-response';
        } else {
          emitError(
            'answer cần một trong các id đang chờ: { callId, approved } (approval), { requestId, answer } (ask-user), hoặc { elicitationId, action } (elicitation).',
          );
          return;
        }
      }
      switch (effectiveType) {
        case 'stop':
        case 'cancel': {
          // A socket only controls its own run: a runId naming
          // another run is refused, never executed.
          if (typeof msg.runId === 'string' && msg.runId !== run.runId) {
            emitError(
              `Không dừng được run "${msg.runId}": socket này chỉ điều khiển run "${run.runId}".`,
            );
            return;
          }
          requestStop('client yêu cầu dừng');
          return;
        }
        case 'approval-response': {
          if (typeof msg.callId !== 'string' || typeof msg.approved !== 'boolean') {
            emitError('approval-response cần { callId: string, approved: boolean }.');
            return;
          }
          // v0.85a (P0-1): a `run`-scoped token must not approve its
          // own dangerous tool call — the HTTP permissions route is
          // not the only approval channel; the WS control message is
          // the other one, and the unified `{type:"answer", callId}`
          // message routes here too (see the `answer` mapping
          // above). Answering ask-user / elicitation questions stays
          // allowed: that is part of running, not approving.
          // Main / `admin` / legacy unscoped tokens keep full access.
          if (authScope === 'run') {
            emitError(
              'Token scope "run" không được trả lời approval — cần token scope "admin" hoặc token chính của Local API.',
            );
            return;
          }
          if (!pendingApprovalCallIds.has(msg.callId)) {
            emitError(`Không có approval nào đang chờ với callId "${msg.callId}" trong run này.`);
            return;
          }
          if (!handlers.respondApproval) {
            emitError('Server này không hỗ trợ trả lời approval qua WebSocket.');
            return;
          }
          void Promise.resolve(handlers.respondApproval(msg.callId, msg.approved))
            .then((result) => {
              if (result && result.found === true) {
                pendingApprovalCallIds.delete(msg.callId as string);
              } else {
                emitError(`Approval "${msg.callId as string}" đã được trả lời hoặc đã hết hạn.`);
              }
            })
            .catch((err: unknown) => {
              emitError(err instanceof Error ? err.message : 'Trả lời approval thất bại.');
            });
          return;
        }
        case 'ask-user-response': {
          if (typeof msg.requestId !== 'string' || typeof msg.answer !== 'string') {
            emitError('ask-user-response cần { requestId: string, answer: string }.');
            return;
          }
          if (!pendingAskUserRequestIds.has(msg.requestId)) {
            emitError(`Không có câu hỏi nào đang chờ với requestId "${msg.requestId}" trong run này.`);
            return;
          }
          if (!handlers.respondAskUser) {
            emitError('Server này không hỗ trợ trả lời ask-user qua WebSocket.');
            return;
          }
          void Promise.resolve(handlers.respondAskUser(msg.requestId, msg.answer))
            .then((result) => {
              if (result && result.found === true) {
                pendingAskUserRequestIds.delete(msg.requestId as string);
              } else {
                emitError(`Câu hỏi "${msg.requestId as string}" đã được trả lời hoặc đã hết hạn.`);
              }
            })
            .catch((err: unknown) => {
              emitError(err instanceof Error ? err.message : 'Trả lời ask-user thất bại.');
            });
          return;
        }
        case 'elicitation-response': {
          if (
            typeof msg.elicitationId !== 'string' ||
            (msg.action !== 'accept' && msg.action !== 'decline' && msg.action !== 'cancel')
          ) {
            emitError(
              'elicitation-response cần { elicitationId: string, action: "accept" | "decline" | "cancel", content?: object }.',
            );
            return;
          }
          if (msg.content !== undefined && !isRecord(msg.content)) {
            emitError('elicitation-response: content (khi có) phải là một object.');
            return;
          }
          if (!pendingElicitationIds.has(msg.elicitationId)) {
            emitError(
              `Không có elicitation nào đang chờ với elicitationId "${msg.elicitationId}" trong run này.`,
            );
            return;
          }
          if (!handlers.respondElicitation) {
            emitError('Server này không hỗ trợ trả lời elicitation qua WebSocket.');
            return;
          }
          const content = isRecord(msg.content)
            ? (msg.content as Record<string, unknown>)
            : undefined;
          void Promise.resolve(
            handlers.respondElicitation(
              msg.elicitationId,
              msg.action as 'accept' | 'decline' | 'cancel',
              content,
            ),
          )
            .then((result) => {
              if (result && result.found === true) {
                pendingElicitationIds.delete(msg.elicitationId as string);
              } else {
                emitError(
                  `Elicitation "${msg.elicitationId as string}" đã được trả lời hoặc đã hết hạn.`,
                );
              }
            })
            .catch((err: unknown) => {
              emitError(err instanceof Error ? err.message : 'Trả lời elicitation thất bại.');
            });
          return;
        }
        default:
          // Unknown control type: tell the client, keep the socket
          // open — a bad control message is not a run error.
          emitError(`Không rõ control message type "${msg.type}".`);
          return;
      }
    };

    const handleSocketClose = (): void => {
      // Client disconnected (or the socket errored): stop the run.
      // Guarded by `settled` — a close after a normal finish is a no-op.
      if (settled) return;
      requestStop('client đã đóng socket');
    };

    // The first event, before the handler runs: the client needs the
    // run id before it can send any control message.
    conn.sendText(JSON.stringify({ kind: 'run-started', data: { runId: run.runId } }));

    const stream = handlers.runBotStream;
    const work: Promise<{ text: string }> = stream
      ? stream(botId, text, emit, { runId: run.runId, signal: controller.signal })
      : handlers.runBot(botId, text).then((result) => {
          emit({ kind: 'delta', data: result.text ?? '' });
          emit({ kind: 'summary', data: result.text ?? '' });
          return result;
        });
    void work
      .then((result) => {
        if (settled) return;
        settled = true;
        run.status = 'done';
        run.text = result.text ?? '';
        run.finishedAt = Date.now();
        if (!sawSummary) emit({ kind: 'summary', data: result.text ?? '' });
        conn.sendClose(1000);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        const message = err instanceof Error ? err.message : 'Run failed.';
        run.status = 'error';
        run.error = message;
        run.finishedAt = Date.now();
        emit({ kind: 'error', data: { error: message } });
        conn.sendClose(1011, 'Run failed.');
      })
      .finally(() => {
        notifySettled();
      });
    return { run, handleControlMessage, handleSocketClose };
  }

  /**
   * v0.8: handle a WebSocket upgrade for GET /v1/bots/:id/run/stream.
   * Auth (Bearer + team) and the bot/text checks run BEFORE the 101
   * handshake — a rejected upgrade gets a plain HTTP error on the
   * socket, never a WebSocket. Only a fully authorised request is
   * upgraded, and only then does the run start.
   */
  async function handleUpgrade(
    req: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const rejectHttp = (status: number, message: string): void => {
      const payload = JSON.stringify({ error: message });
      try {
        socket.write(
          `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request'}\r\n` +
            'Content-Type: application/json; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
            'Connection: close\r\n\r\n' +
            payload,
        );
      } catch {
        // Socket already gone.
      }
      socket.destroy();
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const streamMatch = /^\/v1\/bots\/([^/]+)\/run\/stream$/.exec(path);
    if (method !== 'GET' || !streamMatch) {
      rejectHttp(404, `Unknown route: ${method} ${path}`);
      return;
    }
    // v0.85a (P0-1): keep the matched token's scope — the WS run
    // stream itself is a run route (allowed for `run`), but the
    // `approval-response` control message inside it is admin-only
    // (see startStreamRun).
    const upgradeAuth = resolveAuth(req);
    if (!upgradeAuth) {
      rejectHttp(401, 'Missing or invalid Authorization: Bearer token.');
      return;
    }
    const teamError = teamCheckError(req);
    if (teamError) {
      rejectHttp(403, teamError);
      return;
    }
    const upgradeHeader = req.headers.upgrade;
    const wsKey = req.headers['sec-websocket-key'];
    if (
      typeof upgradeHeader !== 'string' ||
      upgradeHeader.toLowerCase() !== 'websocket' ||
      typeof wsKey !== 'string' ||
      wsKey.length === 0
    ) {
      rejectHttp(400, 'This endpoint requires a WebSocket upgrade (Upgrade: websocket + Sec-WebSocket-Key).');
      return;
    }
    const botId = decodeURIComponent(streamMatch[1]);
    const bot = await findBot(botId);
    if (!bot) {
      rejectHttp(404, `Bot not found: ${botId}`);
      return;
    }
    const text = url.searchParams.get('text');
    if (typeof text !== 'string' || text.trim().length === 0) {
      rejectHttp(400, 'Query parameter "text" must be a non-empty string.');
      return;
    }
    const conn = new WsConnection(socket, {
      // v0.9a: control messages are routed into the run. The run
      // starts only after the 101 handshake below, so messages that
      // arrive in the upgrade `head` (before the run exists) are
      // queued and drained once the run is up.
      onMessage: (text) => {
        if (control) control.handleControlMessage(text);
        else queuedMessages.push(text);
      },
      onClose: () => {
        control?.handleSocketClose();
      },
    });
    let control: StreamRunControl | null = null;
    const queuedMessages: string[] = [];
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${computeWsAccept(wsKey)}\r\n\r\n`,
      );
    } catch {
      return;
    }
    socket.on('data', (chunk: Buffer) => conn.push(chunk));
    control = startStreamRun(botId, text, conn, upgradeAuth.scope);
    if (head.length > 0) conn.push(head);
    // Drain any control message that arrived in the upgrade head.
    for (const queued of queuedMessages.splice(0)) {
      control.handleControlMessage(queued);
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Health is the only unauthenticated route (so supervisors and
    // the Settings UI can probe the server without the token).
    if (method === 'GET' && path === '/v1/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // v0.13: the A2A Agent Card is public discovery (like /v1/health) —
    // loopback-only anyway, and A2A clients must fetch it before they
    // know the endpoint exists. 404 when no A2A server is mounted.
    if (method === 'GET' && path === '/.well-known/agent-card.json') {
      if (!a2aServer) {
        sendError(res, 404, 'A2A server is not mounted on this Local API.');
        return;
      }
      sendJson(res, 200, a2aServer.getAgentCard());
      return;
    }

    // v0.90d: rate limit — SAU health/agent-card (miễn, như auth),
    // TRƯỚC mọi route còn lại (kể cả composio/slack-inbound, vì
    // chúng cũng là REST và không có Bearer để phân biệt client —
    // chúng chung bucket theo IP; 120/phút là thừa cho webhook).
    // `auth` được resolve ở đây để bucket phân biệt theo token đã
    // khớp (fingerprint hash, không log) thay vì chỉ theo IP, và
    // được tái dùng ở gate auth bên dưới (không resolve 2 lần).
    const auth = resolveAuth(req);
    const rate = checkRateLimit(req, auth);
    if (!rate.allowed) {
      sendJson(
        res,
        429,
        {
          error: `Local API rate limit: tối đa ${rateLimitPerMinute} request/phút cho mỗi client — thử lại sau ${rate.retryAfterSeconds} giây.`,
        },
        {
          'Retry-After': String(rate.retryAfterSeconds),
          'X-RateLimit-Limit': String(rateLimitPerMinute),
          'X-RateLimit-Reset': String(Math.ceil((Date.now() + rate.retryAfterSeconds * 1000) / 1000)),
        },
      );
      return;
    }

    // v0.83b: POST /v1/automations/:id/composio-trigger — deliver a
    // Composio trigger event. Checked BEFORE the Bearer gate ON
    // PURPOSE: Composio (public internet) cannot send the Local API
    // token, so the Composio webhook signature (or the ?token=
    // fallback) IS the auth — the scheduler verifies it BEFORE
    // running any action, on the EXACT raw body bytes (never
    // re-serialised). The Bearer token is neither required nor
    // accepted as a substitute here. Status mapping: bad/missing
    // auth -> 401, unknown automation -> 404, disabled /
    // non-composio / no secret / slug mismatch / invalid body ->
    // 400; anything else from the handler is rethrown (-> 500 via
    // the outer catch). Handler not mounted -> 404.
    const composioMatch = /^\/v1\/automations\/([^/]+)\/composio-trigger$/.exec(path);
    if (method === 'POST' && composioMatch) {
      if (!handlers.deliverComposioTrigger) {
        sendError(res, 404, 'Composio trigger delivery is not mounted on this Local API.');
        return;
      }
      const automationId = decodeURIComponent(composioMatch[1]);
      const rawBody = await readRawBody(req);
      const header = (name: string): string | null => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
      };
      try {
        const run = await handlers.deliverComposioTrigger(automationId, rawBody, {
          webhookId: header('webhook-id'),
          webhookTimestamp: header('webhook-timestamp'),
          webhookSignature: header('webhook-signature'),
          token: url.searchParams.get('token'),
        });
        sendJson(res, 200, run);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Composio trigger delivery failed.';
        if (/Invalid Composio webhook signature|Invalid Composio trigger token|needs a signature/.test(message)) {
          sendError(res, 401, message);
          return;
        }
        if (/No automation with id/.test(message)) {
          sendError(res, 404, message);
          return;
        }
        if (
          /disabled|does not have a Composio trigger|not configured|lookup failed|has no|slug mismatch|Composio trigger body|Composio trigger slug|already running/.test(
            message,
          )
        ) {
          sendError(res, 400, message);
          return;
        }
        throw err;
      }
      return;
    }

    // v0.87a (P2-2): POST /v1/automations/:id/slack-inbound — deliver
    // a direct-Slack Events API / interactivity payload. Checked
    // BEFORE the Bearer gate ON PURPOSE (same reason as the Composio
    // route): Slack (public internet) cannot send the Local API
    // token, so the Slack signing secret (`x-slack-signature` over
    // `v0:{timestamp}:{rawBody}`) IS the auth — the scheduler
    // verifies it BEFORE parsing or running any action, on the EXACT
    // raw body bytes (never re-serialised). The Bearer token is
    // neither required nor accepted as a substitute here. Status
    // mapping: bad/missing signature -> 401, unknown automation ->
    // 404, disabled / non-Slack / no secret / slug mismatch /
    // invalid body -> 400; `url_verification` and ignored bot
    // messages -> 200 with the handler's return (challenge / ignored
    // ack, no run). Handler not mounted -> 404.
    const slackMatch = /^\/v1\/automations\/([^/]+)\/slack-inbound$/.exec(path);
    if (method === 'POST' && slackMatch) {
      if (!handlers.deliverSlackInbound) {
        sendError(res, 404, 'Slack inbound delivery is not mounted on this Local API.');
        return;
      }
      const automationId = decodeURIComponent(slackMatch[1]);
      const rawBody = await readRawBody(req);
      const header = (name: string): string | null => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
      };
      try {
        const result = await handlers.deliverSlackInbound(
          automationId,
          rawBody,
          {
            signature: header('x-slack-signature'),
            timestamp: header('x-slack-request-timestamp'),
          },
          header('content-type'),
        );
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Slack inbound delivery failed.';
        if (/Invalid Slack signature/.test(message)) {
          sendError(res, 401, message);
          return;
        }
        if (/No automation with id/.test(message)) {
          sendError(res, 404, message);
          return;
        }
        if (/disabled|does not listen for Slack|has no Slack signing secret|Slack signing secret provider|Slack signing secret lookup failed|slug mismatch|Slack .* body|Slack .* payload|Slack event|Slack url_verification|already running/.test(message)) {
          sendError(res, 400, message);
          return;
        }
        throw err;
      }
      return;
    }

    // v0.85a (P0-1): `auth` đã resolve ở đầu `handle()` (cho rate
    // limit) — tái dùng ở đây làm auth context của request; null
    // từ đây trở đi nghĩa là token thiếu/sai (đã trả 401).
    // `auth.scope` decides the admin-only routes below. Non-null
    // from here on (a missing/invalid token already returned 401).
    if (!auth) {
      sendError(res, 401, 'Missing or invalid Authorization: Bearer token.');
      return;
    }

    // v0.7: token ↔ team consistency, checked before any handler runs.
    const teamError = teamCheckError(req);
    if (teamError) {
      sendError(res, 403, teamError);
      return;
    }

    try {
      // GET /v1/bots
      if (method === 'GET' && path === '/v1/bots') {
        sendJson(res, 200, await handlers.listBots());
        return;
      }

      // POST /v1/bots/:id/run
      const runMatch = /^\/v1\/bots\/([^/]+)\/run$/.exec(path);
      if (method === 'POST' && runMatch) {
        const botId = decodeURIComponent(runMatch[1]);
        const bot = await findBot(botId);
        if (!bot) {
          sendError(res, 404, `Bot not found: ${botId}`);
          return;
        }
        const body = await readJsonBody(req);
        if (!isRecord(body) || typeof body.text !== 'string') {
          sendError(res, 400, 'Request body must be JSON { "text": "<string>" }.');
          return;
        }
        // v0.89a (vision over the Local API): optional `attachments`
        // (same shape + limits as RunParams.attachments). Invalid
        // attachments → 400 before any run starts; an image-only
        // request (empty text + attachments) is a valid turn, like
        // `chat:send` in the desktop app. Without attachments the
        // old rule stands: text must be non-empty.
        let attachments: VisionAttachment[] | undefined;
        if (body.attachments !== undefined) {
          const vision = validateVisionAttachments(body.attachments);
          if (!vision.ok) {
            sendError(res, 400, vision.error);
            return;
          }
          attachments = vision.attachments;
        }
        if (body.text.trim().length === 0 && (!attachments || attachments.length === 0)) {
          sendError(res, 400, 'Request body must be JSON { "text": "<non-empty string>" }.');
          return;
        }
        const run = startRun(botId, body.text, attachments ? { attachments } : undefined);
        sendJson(res, 202, { runId: run.runId, status: 'running' as const });
        return;
      }

      // GET /v1/runs/:id
      const runGetMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
      if (method === 'GET' && runGetMatch) {
        const run = runs.get(decodeURIComponent(runGetMatch[1]));
        if (!run) {
          sendError(res, 404, 'Run not found.');
          return;
        }
        sendJson(res, 200, run);
        return;
      }

      // GET /v1/bots/:id/history?limit=N
      const historyMatch = /^\/v1\/bots\/([^/]+)\/history$/.exec(path);
      if (method === 'GET' && historyMatch) {
        const botId = decodeURIComponent(historyMatch[1]);
        if (!(await findBot(botId))) {
          sendError(res, 404, `Bot not found: ${botId}`);
          return;
        }
        const limit = parseLimit(url.searchParams);
        sendJson(res, 200, await handlers.getHistory(botId, limit));
        return;
      }

      // GET /v1/bots/:id/tasks
      const tasksMatch = /^\/v1\/bots\/([^/]+)\/tasks$/.exec(path);
      if (method === 'GET' && tasksMatch) {
        const botId = decodeURIComponent(tasksMatch[1]);
        if (!(await findBot(botId))) {
          sendError(res, 404, `Bot not found: ${botId}`);
          return;
        }
        sendJson(res, 200, await handlers.listTasks(botId));
        return;
      }

      // v0.59: POST /v1/automations/:id/webhook — deliver a webhook to
      // a webhook-trigger automation (the public HTTP route P0-5 left
      // as a follow-up). Requires BOTH the Local API auth (Bearer +
      // X-Open-Bot-Team, checked above like every other route) AND the
      // HMAC header `x-open-bot-signature` (`sha256=<hex>` over the
      // EXACT raw body bytes — the body is read raw here and passed
      // through untouched, never re-serialised). The handler
      // (AutomationScheduler.handleWebhook, wired by main) verifies
      // the signature BEFORE running any action: a bad / missing /
      // malformed signature throws and no run is recorded, the action
      // handler is never called. The secret is never logged here.
      // Status mapping: bad signature -> 401, unknown automation ->
      // 404, disabled / non-webhook / no key / provider not
      // configured / invalid JSON body -> 400; anything else from
      // the handler is rethrown (-> 500 via the outer catch).
      const webhookMatch = /^\/v1\/automations\/([^/]+)\/webhook$/.exec(path);
      if (method === 'POST' && webhookMatch) {
        if (!handlers.deliverAutomationWebhook) {
          sendError(res, 404, 'Automation webhook is not mounted on this Local API.');
          return;
        }
        const automationId = decodeURIComponent(webhookMatch[1]);
        const rawBody = await readRawBody(req);
        const sigHeader = req.headers['x-open-bot-signature'];
        const signature =
          typeof sigHeader === 'string'
            ? sigHeader
            : Array.isArray(sigHeader)
              ? sigHeader[0]
              : null;
        try {
          const run = await handlers.deliverAutomationWebhook(automationId, rawBody, signature);
          sendJson(res, 200, run);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Webhook delivery failed.';
          if (/Invalid webhook signature/.test(message)) {
            sendError(res, 401, message);
            return;
          }
          if (/No automation with id/.test(message)) {
            sendError(res, 404, message);
            return;
          }
          if (
            /disabled|does not have a webhook trigger|has no webhook key|not configured|key lookup failed|already running|not valid JSON/.test(
              message,
            )
          ) {
            sendError(res, 400, message);
            return;
          }
          throw err;
        }
        return;
      }

      // M5: GET /v1/harness/status — trạng thái registry instance +
      // permission đang chờ của harness. Handler chưa mount → 404
      // (desktop main mount bằng coordinator RPC `harnessStatus`).
      if (method === 'GET' && path === '/v1/harness/status') {
        if (!handlers.harnessStatus) {
          sendError(res, 404, 'Harness is not mounted on this Local API.');
          return;
        }
        sendJson(res, 200, (await handlers.harnessStatus()) as Record<string, unknown>);
        return;
      }

      // M5: GET /v1/harness/threads/:threadId/log — đọc NDJSON log theo
      // thread (?limit=&offset=&kind=, kind lặp lại được để lọc nhiều kind).
      const harnessLogMatch = /^\/v1\/harness\/threads\/([^/]+)\/log$/.exec(path);
      if (method === 'GET' && harnessLogMatch) {
        if (!handlers.harnessThreadLog) {
          sendError(res, 404, 'Harness is not mounted on this Local API.');
          return;
        }
        const threadId = decodeURIComponent(harnessLogMatch[1]);
        const limit = parseLimit(url.searchParams);
        const rawOffset = url.searchParams.get('offset');
        let offset = 0;
        if (rawOffset !== null) {
          const n = Number(rawOffset);
          if (!Number.isInteger(n) || n < 0) {
            throw new Error('Query parameter "offset" must be a non-negative integer.');
          }
          offset = n;
        }
        const kinds = url.searchParams.getAll('kind');
        sendJson(
          res,
          200,
          (await handlers.harnessThreadLog(threadId, {
            limit,
            offset,
            ...(kinds.length > 0 ? { kinds } : {}),
          })) as Record<string, unknown>,
        );
        return;
      }

      // v0.90a (Đội G): GET /v1/harness/events — live stream SSE các
      // event harness đã sanitize (loop turn/tool-call + CLI driver).
      // Bearer auth như các route khác (đã kiểm tra trước khi tới đây).
      // Query: threadId?, botId?, kind= (lặp lại được, sai kind → 400).
      // Header Last-Event-ID (giá trị `at` ISO của event cuối client đã
      // nhận) → replay từ NDJSON log (tối đa 1000 entry, chỉ khi có
      // threadId + đã mount harnessThreadLog) rồi mới live. Live
      // subscribe TRƯỚC, replay SAU: event tới trong lúc replay được
      // xếp hàng rồi xả sau (lọc trùng theo `at`), nên không mất event
      // ở ranh giới. Không có threadId thì không replay được (log đọc
      // theo thread) — chỉ live từ lúc nối. Heartbeat `: heartbeat`
      // mỗi `harnessEventsHeartbeatMs` (mặc định 15s). SSE id = `at`
      // của event nên client resume bằng Last-Event-ID đúng chuẩn SSE.
      if (method === 'GET' && path === '/v1/harness/events') {
        if (!handlers.subscribeHarnessEvents) {
          sendError(res, 404, 'Harness events are not mounted on this Local API.');
          return;
        }
        const threadId = url.searchParams.get('threadId') ?? undefined;
        const botId = url.searchParams.get('botId') ?? undefined;
        const kinds = url.searchParams.getAll('kind');
        for (const kind of kinds) {
          if (!HARNESS_EVENT_KINDS.includes(kind)) {
            sendError(res, 400, `Query parameter "kind" không hợp lệ: ${kind}.`);
            return;
          }
        }
        const lastEventIdHeader = req.headers['last-event-id'];
        const lastEventId =
          typeof lastEventIdHeader === 'string' && lastEventIdHeader.length > 0
            ? lastEventIdHeader
            : undefined;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let closed = false;
        let lastReplayAt = lastEventId ?? '';
        let live = false;
        const queued: HarnessStreamEvent[] = [];
        let unsubscribe: (() => void) | undefined;
        const send = (event: HarnessStreamEvent): void => {
          if (closed) return;
          try {
            res.write(`id: ${event.at}\ndata: ${JSON.stringify(event)}\n\n`);
          } catch {
            // Client đã đóng — 'close' sẽ dọn dẹp.
          }
        };
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          try {
            unsubscribe?.();
          } catch {
            // Unsubscribe best-effort.
          }
          try {
            res.end();
          } catch {
            // Client đã đóng.
          }
        };
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            res.write(': heartbeat\n\n');
          } catch {
            // Client đã đóng — 'close' sẽ dọn dẹp.
          }
        }, options.harnessEventsHeartbeatMs ?? 15000);
        heartbeat.unref?.();
        let resolveClosed!: () => void;
        const closedPromise = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        req.on('close', () => {
          cleanup();
          resolveClosed();
        });
        // Live subscribe trước (event trong lúc replay xếp hàng).
        try {
          unsubscribe = await handlers.subscribeHarnessEvents(
            {
              ...(threadId !== undefined ? { threadId } : {}),
              ...(botId !== undefined ? { botId } : {}),
              ...(kinds.length > 0 ? { kinds } : {}),
            },
            (event) => {
              if (closed) return;
              // v0.90e (Đội G): event của run im lặng không ra SSE
              // (phòng thủ — forwarder ở coordinator con đã bỏ qua;
              // handler cẩu thả vẫn không lọt event silent ra stream).
              if (event.silent === true) return;
              // Lọc phòng thủ ở server (handler cũng đã lọc theo filter
              // nó nhận — main lọc ở Set fan-out; handler cẩu thả vẫn
              // không lọt event sai filter ra stream).
              if (threadId !== undefined && event.threadId !== threadId) return;
              if (botId !== undefined && event.botId !== botId) return;
              if (kinds.length > 0 && !kinds.includes(event.kind)) return;
              if (!live) {
                queued.push(event);
                return;
              }
              if (event.at <= lastReplayAt) return;
              send(event);
            },
          );
        } catch {
          // Subscribe lỗi sau khi header SSE đã gửi — không trả JSON
          // lỗi được nữa, chỉ đóng stream (client sẽ thấy stream kết
          // thúc mà không có event nào).
          cleanup();
          resolveClosed();
          return;
        }
        // Replay từ NDJSON log (best-effort; lỗi đọc log không chặn live).
        if (threadId !== undefined && handlers.harnessThreadLog) {
          try {
            const page = (await handlers.harnessThreadLog(threadId, {
              limit: 1000,
              offset: 0,
              ...(kinds.length > 0 ? { kinds } : {}),
            })) as { entries?: Array<HarnessStreamEvent> };
            for (const entry of page.entries ?? []) {
              if (closed) break;
              if (typeof entry?.at !== 'string') continue;
              // v0.90e (Đội G): replay không trả event của run im lặng
              // (đã ghi log để audit, nhưng SSE là kênh đẩy ra ngoài).
              if (entry.silent === true) continue;
              if (entry.at <= lastReplayAt) continue;
              send(entry);
              if (entry.at > lastReplayAt) lastReplayAt = entry.at;
            }
          } catch {
            // Replay lỗi thì live vẫn chạy (client chỉ mất quá khứ).
          }
        }
        // Xả hàng đợi (bỏ event đã replay hoặc cũ hơn Last-Event-ID),
        // rồi chuyển sang live trực tiếp.
        live = true;
        for (const event of queued) {
          if (event.at <= lastReplayAt) continue;
          send(event);
        }
        queued.length = 0;
        await closedPromise;
        return;
      }

      // M5: POST /v1/harness/permissions/:requestId {allowed} — UI quyết
      // một permission request đang chờ (thẻ Allow/Deny qua Local API).
      // v0.85a (P0-1): ADMIN-ONLY — this is the self-approval hole:
      // a `run` token deciding its own dangerous tool call must get
      // 403 here, before the body is even validated.
      const harnessPermMatch = /^\/v1\/harness\/permissions\/([^/]+)$/.exec(path);
      if (method === 'POST' && harnessPermMatch) {
        if (!handlers.respondHarnessPermission) {
          sendError(res, 404, 'Harness is not mounted on this Local API.');
          return;
        }
        const scopeError = runScopeDeniedMessage(auth.scope);
        if (scopeError) {
          sendError(res, 403, scopeError);
          return;
        }
        const body = await readJsonBody(req);
        if (!isRecord(body) || typeof body['allowed'] !== 'boolean') {
          sendError(res, 400, 'Request body must be JSON { "allowed": boolean }.');
          return;
        }
        sendJson(
          res,
          200,
          await handlers.respondHarnessPermission(
            decodeURIComponent(harnessPermMatch[1]),
            body['allowed'],
          ),
        );
        return;
      }

      // v0.13: POST /mcp — one MCP JSON-RPC message per POST, answered
      // inline. A notification (no `id`) gets 202 with an empty body;
      // a request gets its JSON-RPC response. GET /mcp is refused
      // (405): the SSE stream for server-initiated messages lives in
      // the standalone MCP HTTP server, not in this mount.
      if (path === '/mcp') {
        if (!mcpServer) {
          sendError(res, 404, 'MCP server is not mounted on this Local API.');
          return;
        }
        // v0.85a (P0-1): ADMIN-ONLY — the MCP mount exposes tools
        // (including, with allowWriteTools, write tools) outside the
        // bot-run path, so a `run` token must not reach it at all.
        // Checked before the method checks: authz precedes 405.
        const mcpScopeError = runScopeDeniedMessage(auth.scope);
        if (mcpScopeError) {
          sendError(res, 403, mcpScopeError);
          return;
        }
        if (method === 'GET') {
          sendError(
            res,
            405,
            'GET /mcp (SSE stream) is not supported on the Local API mount — use POST /mcp with one JSON-RPC message.',
          );
          return;
        }
        if (method !== 'POST') {
          sendError(res, 405, 'Only POST is supported on /mcp.');
          return;
        }
        const body = await readJsonBody(req);
        // v0.19: đi qua wrapper lọc tool của mount (mcpTools /
        // allowWriteTools), không gọi thẳng server đã mount.
        const response = await handleMcpMountJsonRpc(body);
        if (response === null || response === undefined) {
          sendJson(res, 202, {});
          return;
        }
        sendJson(res, 200, response as Record<string, unknown>);
        return;
      }

      // v0.13+: POST /a2a — one A2A JSON-RPC message per POST.
      // `message:send` runs to completion and returns the final task.
      // `message:stream` streams SSE (task → status-update →
      // artifact-update → task cuối) khi mount có `startStream` —
      // nhận biết yêu cầu stream theo đúng cách server độc lập làm:
      // method là `message:stream` (hoặc `message/stream`), không
      // cần header Accept. Mount không có `startStream` thì
      // `message:stream` vẫn chạy-tới-hoàn-thành như trước.
      if (method === 'POST' && path === '/a2a') {
        if (!a2aServer) {
          sendError(res, 404, 'A2A server is not mounted on this Local API.');
          return;
        }
        // v0.85a (P0-1): ADMIN-ONLY — A2A runs the first bot without
        // going through the Local API run/approval flow, so a `run`
        // token must not reach it (same self-approval surface as
        // POST /v1/harness/permissions/:id).
        const a2aScopeError = runScopeDeniedMessage(auth.scope);
        if (a2aScopeError) {
          sendError(res, 403, a2aScopeError);
          return;
        }
        const body = await readJsonBody(req);
        if (
          isRecord(body) &&
          (body['method'] === 'message:stream' || body['method'] === 'message/stream')
        ) {
          const streamable = asStreamCapableMount(a2aServer);
          if (streamable) {
            const rpcId = (body['id'] ?? null) as number | string | null;
            const extracted = extractSendText(body['params']);
            if (!extracted) {
              sendJson(res, 200, {
                jsonrpc: '2.0',
                id: rpcId,
                // -32602 = A2A_JSON_RPC_INVALID_PARAMS (a2a/server.ts);
                // literal ở đây để api/server.ts không import runtime
                // module a2a/server (mount chỉ cần structural type).
                error: {
                  code: -32602,
                  message: 'message:stream cần { message: { parts: [...] } }.',
                },
              });
              return;
            }
            const params = isRecord(body['params'])
              ? (body['params'] as Record<string, unknown>)
              : {};
            const contextId =
              typeof params['contextId'] === 'string' ? (params['contextId'] as string) : undefined;
            const sendEvent = (event: A2aStreamEvent): void => {
              const payload = JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: event });
              res.write(`data: ${payload}\n\n`);
            };
            try {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'A2A-Version': '1.0',
              });
              const stream = streamable.startStream(
                { message: extracted.message, text: extracted.text, contextId },
                sendEvent,
              );
              // Client ngắt stream giữa chừng: hủy task đang chạy
              // (`close` cũng bắn khi response kết thúc bình thường —
              // lúc đó cancel() là no-op vì task đã settle).
              req.on('close', () => stream.cancel());
              await stream.done;
            } catch {
              // Header SSE đã gửi nên không trả JSON lỗi được nữa —
              // chỉ kết thúc stream (lỗi runner đã ghi vào task
              // dạng failed trước khi done settle).
            } finally {
              try {
                res.end();
              } catch {
                // Client đã đóng.
              }
            }
            return;
          }
          // Mount không stream được: rơi xuống handleJsonRpc bên dưới
          // (chạy-tới-hoàn-thành, trả JSON như trước).
        }
        const response = await a2aServer.handleJsonRpc(body);
        if (response === null || response === undefined) {
          sendJson(res, 202, {});
          return;
        }
        sendJson(res, 200, response as Record<string, unknown>);
        return;
      }

      // v0.25: GET /a2a/tasks — liệt kê task A2A qua REST. Không viết
      // lại logic lọc/phân trang ở đây: route chỉ chuyển query string
      // thành params rồi gọi đúng JSON-RPC `tasks/list` của server đã
      // mount (`handleJsonRpc` — MountedA2aServer bắt buộc phải có nó,
      // kể cả mount tối thiểu) và trả `result` (`{ tasks, total,
      // nextCursor }`) nguyên vẹn. Lọc/phân trang/`summary` do
      // `listParams`/`toTaskSummary` trong a2a/server.ts quyết định
      // (limit mặc định 50, kẹp 100). Query sai kiểu → 400 rõ ràng.
      if (method === 'GET' && path === '/a2a/tasks') {
        if (!a2aServer) {
          sendError(res, 404, 'A2A server is not mounted on this Local API.');
          return;
        }
        const params: Record<string, unknown> = {};
        const rawLimit = url.searchParams.get('limit');
        if (rawLimit !== null) {
          const n = Number(rawLimit);
          if (!Number.isInteger(n) || n < 1) {
            sendError(res, 400, 'Query parameter "limit" phải là số nguyên >= 1 (mặc định 50, tối đa 100).');
            return;
          }
          params['limit'] = n;
        }
        const rawOffset = url.searchParams.get('offset');
        if (rawOffset !== null) {
          const n = Number(rawOffset);
          if (!Number.isInteger(n) || n < 0) {
            sendError(res, 400, 'Query parameter "offset" phải là số nguyên >= 0.');
            return;
          }
          params['offset'] = n;
        }
        const rawCursor = url.searchParams.get('cursor');
        if (rawCursor !== null) params['cursor'] = rawCursor;
        const rawContextId = url.searchParams.get('contextId');
        if (rawContextId !== null) params['contextId'] = rawContextId;
        const rawSummary = url.searchParams.get('summary');
        if (rawSummary !== null) {
          if (rawSummary === 'true') params['summary'] = true;
          else if (rawSummary === 'false') params['summary'] = false;
          else {
            sendError(res, 400, 'Query parameter "summary" phải là "true" hoặc "false".');
            return;
          }
        }
        const response = await a2aServer.handleJsonRpc({
          jsonrpc: '2.0',
          id: 'rest-a2a-tasks-list',
          method: 'tasks/list',
          params,
        });
        if (isRecord(response) && 'result' in response) {
          sendJson(res, 200, response['result']);
          return;
        }
        if (
          isRecord(response) &&
          isRecord(response['error']) &&
          typeof response['error']['message'] === 'string'
        ) {
          // Lỗi -32602 từ tasks/list (vd cursor không phải chuỗi số)
          // là lỗi query của client → 400 với message của server.
          sendError(res, 400, response['error']['message'] as string);
          return;
        }
        sendError(res, 500, 'A2A server trả về response tasks/list không hợp lệ.');
        return;
      }

      // v0.13: GET /a2a/tasks/:id — one A2A task.
      const a2aTaskMatch = /^\/a2a\/tasks\/([^/]+)$/.exec(path);
      if (method === 'GET' && a2aTaskMatch) {
        if (!a2aServer) {
          sendError(res, 404, 'A2A server is not mounted on this Local API.');
          return;
        }
        const task = a2aServer.getTask(decodeURIComponent(a2aTaskMatch[1]));
        if (task === undefined || task === null) {
          sendError(res, 404, 'A2A task not found.');
          return;
        }
        sendJson(res, 200, task as Record<string, unknown>);
        return;
      }

      sendError(res, 404, `Unknown route: ${method} ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error.';
      // Body too large / bad JSON / bad limit are client errors (400);
      // anything else from a handler is a server error (500) — the
      // message is the handler's own, never a secret.
      const status =
        /not valid JSON|too large|must be/.test(message) ? 400 : 500;
      sendError(res, status, message);
    }
  }

  return {
    get port() {
      return boundPort;
    },
    get isRunning() {
      return server !== null && server.listening;
    },

    start(): Promise<void> {
      if (server?.listening) return Promise.resolve();
      stopping = false;
      return new Promise<void>((resolve, reject) => {
        // v0.90d: connectionsCheckingInterval chỉ có trong
        // ServerOptions (lib @types/node 22 chưa có property này
        // trên Server) nên truyền qua constructor thay vì gán sau
        // như headersTimeout/requestTimeout.
        const srv = http.createServer(
          { connectionsCheckingInterval: connectionsCheckingIntervalMs },
          (req, res) => {
            void handle(req, res).catch(() => {
              // handle() already answers every error path; this is only
              // a last-resort guard so a socket never hangs.
              if (!res.headersSent) sendError(res, 500, 'Internal error.');
            });
          },
        );
        // v0.90d: giới hạn kết nối + timeout rõ ràng (constant có
        // tên, xem đầu file). requestTimeout chỉ tính lúc NHẬN
        // request — SSE/WS đã mở không bị cắt (đã kiểm chứng).
        // connectionsCheckingInterval là chu kỳ Node thực thi hai
        // timeout trên (mặc định 30s — xem constant).
        srv.maxConnections = maxConnections;
        srv.headersTimeout = headersTimeoutMs;
        srv.requestTimeout = requestTimeoutMs;
        srv.on('connection', (socket) => {
          // v0.90d: vượt cap trên mỗi IP thì destroy ngay (không
          // treo, không dữ liệu) — trackConnection đã log 1 dòng.
          if (!trackConnection(socket)) {
            try {
              socket.destroy();
            } catch {
              // Already gone.
            }
          }
        });
        // v0.90d: 'close' của server — chỉ báo host khi KHÔNG phải
        // do stop() có chủ đích (xem `stopping` ở stop()). Host
        // dùng callback này để khởi động lại có backoff; trường hợp
        // listen thất bại (vd EADDRINUSE) thì 'close' có thể bắn
        // trước khi server từng chạy — host tự chặn bằng cờ "đã
        // chạy" của riêng nó, ở đây chỉ cần không gọi nhầm khi stop.
        srv.on('close', () => {
          if (!stopping) options.onUnexpectedClose?.();
        });
        // v0.8: WebSocket upgrades for GET /v1/bots/:id/run/stream.
        srv.on('upgrade', (req, socket, head) => {
          // 'upgrade' types the socket as Duplex; on a TCP server it
          // is always a net.Socket (needed for .destroy() / .end()).
          const sock = socket as Socket;
          sockets.add(sock);
          sock.on('close', () => sockets.delete(sock));
          void handleUpgrade(req, sock, head).catch(() => {
            // handleUpgrade answers every failure path itself; this
            // only guards a socket that would otherwise hang.
            try {
              sock.destroy();
            } catch {
              // Already gone.
            }
          });
        });
        srv.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(
              new Error(
                `Local API port ${requestedPort} is already in use. ` +
                  'Another app (or another open-bot instance) is listening there — ' +
                  'pick a different port in Settings.',
              ),
            );
          } else {
            reject(err);
          }
        });
        // Loopback only: the API is for apps/scripts on this machine.
        srv.listen(requestedPort, '127.0.0.1', () => {
          server = srv;
          boundPort = (srv.address() as { port: number }).port;
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      if (!server) return Promise.resolve();
      // v0.90d: đánh dấu dừng có chủ đích TRƯỚC khi đóng — 'close'
      // của server sau đó không gọi onUnexpectedClose.
      stopping = true;
      const srv = server;
      server = null;
      boundPort = 0;
      return new Promise<void>((resolve) => {
        // Destroy idle keep-alive sockets so close() is not held open
        // by a client that keeps its connection alive.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        srv.close(() => resolve());
      });
    },

    listRuns(): ApiRunRecord[] {
      return [...runs.values()].map((r) => ({ ...r }));
    },

    getRun(runId: string): ApiRunRecord | undefined {
      const run = runs.get(runId);
      return run ? { ...run } : undefined;
    },

    getConnectionCount(): number {
      return sockets.size;
    },
  };
}

export type { ApiBotSummary, ApiHandlers, ApiRunRecord, CreateApiServerOptions, McpMountToolsOption } from './types';
