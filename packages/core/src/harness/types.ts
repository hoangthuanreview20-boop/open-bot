/**
 * Harness local chuẩn hoá (M5) — types dùng chung.
 *
 * Harness là tầng mỏng nằm giữa driver CLI và phần còn lại của
 * open-bot (coordinator, Local API/WS, daemon): nó KHÔNG spawn process
 * (driver tự spawn như M1–M4), KHÔNG chạy model, KHÔNG giữ credential
 * — chỉ ghi nhận instance nào đang sống, gom event mọi driver về một
 * envelope chuẩn, ghi log NDJSON theo thread, snapshot trạng thái
 * engine xuống đĩa, và làm broker tập trung cho permission request.
 *
 * Nguyên tắc bảo mật (như tracing): log/snapshot/event KHÔNG BAO GIỜ
 * chứa secret/token — payload đi qua `sanitizeHarnessPayload`
 * (ndjson.ts) trước khi ghi bus/log.
 */

import type { CliEvent } from '../providers/cli/types';

/**
 * Kind của event chuẩn trên bus. Map từ `CliEvent` của driver:
 * text → text, tool_call → tool_call, result → result,
 * error → error, aborted → abort, approval_denied → approval_denied,
 * approval_request → approval_request (request mới tới, chưa quyết).
 * `permission_request` / `permission_denied` là tên đồng nghĩa dùng
 * khi nguồn là ACP `session/request_permission` (broker ghi log theo
 * tên này cho rõ); `approval_decision` là quyết định của broker;
 * `lifecycle` là spawn/exit/register/unregister của instance.
 */
export type HarnessEventKind =
  | 'text'
  | 'tool_call'
  | 'result'
  | 'error'
  | 'abort'
  | 'approval_request'
  | 'approval_denied'
  | 'permission_request'
  | 'permission_denied'
  | 'approval_decision'
  | 'lifecycle';

/** Envelope chuẩn của mọi event trên bus (fan-in từ mọi driver). */
export interface HarnessEvent {
  /** Id instance trong registry (`unregistered:<botId>` khi bot chưa đăng ký). */
  instanceId: string;
  botId: string;
  /** Thread/session của CLI (mặc định = botId khi driver không báo). */
  threadId: string;
  /** Kind engine (vd 'claude', 'codex', 'grok-cli', 'mock'). */
  engine: string;
  kind: HarnessEventKind;
  /** Payload ĐÃ sanitize (không secret, chuỗi cắt ngắn) — xem ndjson.ts. */
  payload: Record<string, unknown>;
  /**
   * v0.90e (Đội G): run im lặng (automation/dream) — event vẫn ghi
   * NDJSON log (audit) nhưng KHÔNG được đẩy về parent (coordinator
   * emit), renderer hay SSE. Chỉ set khi true; absent = run thường.
   */
  silent?: boolean;
  /** Thời điểm event (ISO string). */
  at: string;
}

/** Trạng thái sống của một instance trong registry. */
export type HarnessInstanceStatus = 'starting' | 'running' | 'idle' | 'exited' | 'killed';

/** Snapshot (đọc được, an toàn gửi qua IPC) của một instance. */
export interface HarnessInstanceSnapshot {
  instanceId: string;
  botId: string;
  /** Kind engine (vd 'claude', 'codex'). */
  engine: string;
  /** Provider id (vd 'claude-code', 'codex', 'mock'). */
  providerId: string;
  /** Thread/session id của CLI (nếu driver đã báo). */
  threadId?: string;
  /** PID process CLI (nếu driver cho biết; undefined khi chưa spawn). */
  pid?: number;
  status: HarnessInstanceStatus;
  startedAt: string;
  lastEventAt: string;
  /** Exit code khi process đã thoát (nếu biết). */
  exitCode?: number | null;
}

/** Một dòng log NDJSON theo thread (1 dòng = 1 event JSON). */
export interface ThreadLogEntry {
  at: string;
  botId: string;
  threadId: string;
  kind: HarnessEventKind;
  /** Payload ĐÃ sanitize — không secret, không nội dung nhạy cảm dài. */
  payload: Record<string, unknown>;
  /**
   * v0.90e (Đội G): event của run im lặng — đã ghi log nhưng SSE replay
   * và live stream phải bỏ qua (xem HarnessEvent.silent).
   */
  silent?: boolean;
}

/** Kết quả đọc lại log theo thread (phân trang, lọc theo kind). */
export interface ThreadLogPage {
  threadId: string;
  entries: ThreadLogEntry[];
  /** Tổng số entry khớp filter (trước phân trang). */
  total: number;
  offset: number;
  limit: number;
}

/**
 * Một permission/approval request từ CLI (Codex approval server→client,
 * ACP `session/request_permission`).
 */
export interface HarnessPermissionRequest {
  requestId: string;
  botId: string;
  threadId?: string;
  /** Kind engine (vd 'codex', 'grok-cli'). */
  engine: string;
  /** Method xin duyệt (vd `execCommandApproval`, `session/request_permission`). */
  method: string;
  /** Mô tả ngắn (tên tool/lệnh — đã cắt ngắn, không secret). */
  detail?: string;
  /**
   * True khi broker CÓ THỂ trả lời "cho phép" cho method này.
   * ACP: true (chọn option allow_once). Codex: false — shape trả lời
   * "cho phép" của Codex chưa xác minh được từ schema thật (chỉ có
   * shape deny, xem codexAppServer.ts) nên broker luôn từ chối và ghi
   * rõ lý do, thay vì đoán shape sai.
   */
  allowable: boolean;
  /** Thời điểm request tới (ISO string). */
  requestedAt: string;
}

/** Nguồn gốc của một quyết định permission (để audit + chẩn đoán). */
export type PermissionDecisionSource =
  | 'default-deny' // không có UI handler → từ chối ngay (fail-closed)
  | 'allow-not-supported' // method không có đường cho phép an toàn (vd Codex)
  | 'ui' // user quyết qua thẻ duyệt / decide()
  | 'timeout' // hết timeout chờ UI → từ chối, không treo turn
  | 'shutdown'; // broker bị đóng / bot bị xoá trong lúc chờ → từ chối

/** Một quyết định permission đã ghi log (audit). */
export interface PermissionDecisionRecord {
  requestId: string;
  botId: string;
  engine: string;
  method: string;
  detail?: string;
  allowed: boolean;
  reason: string;
  source: PermissionDecisionSource;
  /** Thời điểm quyết (ISO string). */
  decidedAt: string;
  /** Số ms đã chờ quyết định (0 khi từ chối ngay). */
  waitedMs: number;
}

/** File snapshot engine bền vững (`<dataDir>/harness-snapshot.json`). */
export interface HarnessSnapshotFile {
  version: 1;
  savedAt: string;
  /** Snapshot detector (engines) — chỉ nhãn/trạng thái, không secret. */
  engines: Record<string, unknown>;
  /** Snapshot các instance đang sống lúc lưu (chỉ để khôi phục HIỂN THỊ). */
  instances: HarnessInstanceSnapshot[];
}

/** Trạng thái tổng hợp của harness (Local API / RPC `harnessStatus`). */
export interface HarnessStatusResult {
  /** True khi harness được bật (coordinator nhận `harness` trong options). */
  enabled: boolean;
  instances: HarnessInstanceSnapshot[];
  /** Request permission đang chờ quyết định của user. */
  pendingPermissions: HarnessPermissionRequest[];
  /** Số quyết định permission đã ghi (audit). */
  decisionsTotal: number;
  /** Thư mục log NDJSON (undefined khi harness chạy không ghi đĩa). */
  logDir?: string;
  /** File snapshot (undefined khi harness chạy không ghi đĩa). */
  snapshotFile?: string;
}

/** Kết quả `harnessThreadLog` (RPC / Local API). */
export type HarnessThreadLogResult = ThreadLogPage;

/** Kết quả `harnessDecidePermission` (RPC / Local API). */
export interface HarnessDecidePermissionResult {
  requestId: string;
  /** True khi request đang chờ thật và đã được quyết. */
  found: boolean;
  allowed?: boolean;
}

/** Re-export để caller của harness không cần import từ providers/cli. */
export type { CliEvent };
