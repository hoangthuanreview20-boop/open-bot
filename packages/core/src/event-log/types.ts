/**
 * Event-sourced run log (v1.01, Đội T1).
 *
 * Một *run* là một lượt chạy của AgentRunner (một user turn, hoặc một
 * run con fork ra). Mọi thứ xảy ra trong run đều được ghi thành event
 * bất biến, append-only, nối nhau bằng hash chain — trạng thái của run
 * được suy ra hoàn toàn từ dãy event (xem `replay.ts`).
 *
 * Event nào cũng có:
 * - `seq`: số thứ tự trong run, bắt đầu từ 1, tăng đều, không lỗ hổng.
 * - `runId`: id của run sở hữu event.
 * - `at`: thời điểm ghi (ISO 8601).
 * - `type`: loại event (xem `RunEventType`).
 * - `payload`: dữ liệu riêng từng loại — đã sanitize (không secret,
 *   chuỗi cắt ngắn, tool args chỉ giữ tên key; xem `sanitize.ts`).
 * - `prevHash` / `hash`: hash chain SHA-256 (xem `canonical.ts`).
 *   Event đầu tiên của run có `prevHash` là chuỗi rỗng.
 */

/** Mọi loại event mà run log ghi. */
export type RunEventType =
  | 'run.started'
  | 'run.prompt'
  | 'model.response'
  | 'tool.call'
  | 'tool.result'
  | 'file.change'
  | 'compile.error'
  | 'run.paused'
  | 'run.resumed'
  | 'run.forked'
  | 'run.completed'
  | 'run.failed'
  | 'run.aborted'
  | 'approval.request'
  | 'approval.decision'
  | 'checkpoint.saved';

/** Trạng thái cuối cùng (hoặc hiện tại) của một run. */
export type RunStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'forked';

/** Payload của `run.started`. */
export interface RunStartedPayload {
  /** Bot chạy run này. */
  botId: string;
  /** Model/provider đã route cho run (có thể khác model mặc định). */
  model?: string;
  providerId?: string;
  /** Số step tối đa của run. */
  maxSteps?: number;
  /** Run cha — chỉ có khi run này được fork ra. */
  parentRunId?: string;
  /** Seq trong run cha mà fork bắt đầu sao chép từ đó (bao gồm seq này). */
  forkFromSeq?: number;
  /** Tiêu đề ngắn của run (vd 200 ký tự đầu của prompt). */
  title?: string;
}

/** Payload của `run.prompt`. */
export interface RunPromptPayload {
  /** Prompt của user (đã cắt ngắn + sanitize). */
  text: string;
  /** Số message history kèm theo (không ghi nội dung). */
  historyMessages?: number;
  /** Có ảnh đính kèm hay không (không ghi nội dung ảnh). */
  hasAttachments?: boolean;
}

/** Một tool call mà model yêu cầu (đã sanitize: chỉ tên key args). */
export interface RecordedToolCall {
  callId: string;
  tool: string;
  /** Tên các key của args — không ghi value. */
  argKeys: string[];
}

/** Payload của `model.response`. */
export interface ModelResponsePayload {
  /** Step (0-based) mà response này thuộc về. */
  step: number;
  /** Text trả về của model (đã cắt ngắn + sanitize). */
  text: string;
  /** Tool call model yêu cầu ở step này. */
  toolCalls: RecordedToolCall[];
  /** Token usage của lần gọi này (nếu provider báo). */
  inputTokens?: number;
  outputTokens?: number;
  /** Model thực tế trả response (khi router đổi model giữa chừng). */
  model?: string;
}

/** Payload của `tool.call`. */
export interface ToolCallPayload {
  callId: string;
  tool: string;
  argKeys: string[];
  step: number;
  /** Đường dẫn file từ args (nếu tool ghi file) — để suy ra `file.change`. */
  path?: string;
}

/** Payload của `tool.result`. */
export interface ToolResultPayload {
  callId: string;
  tool: string;
  /** `ok` | `error` | `denied` (user từ chối duyệt). */
  status: 'ok' | 'error' | 'denied';
  /** Output đã cắt ngắn + sanitize (tối đa vài trăm ký tự). */
  outputPreview: string;
  /** Thời gian chạy tool (ms). */
  durationMs: number;
  step: number;
}

/** Payload của `file.change` — tool ghi/sửa/xoá file. */
export interface FileChangePayload {
  /** `write` | `edit` | `delete` | `create`. */
  kind: 'write' | 'edit' | 'delete' | 'create';
  /** Đường dẫn tương đối trong workspace (không ghi nội dung file). */
  path: string;
  /** Tool đã gây ra thay đổi. */
  tool: string;
  callId: string;
  /** Số byte ghi (nếu biết). */
  bytes?: number;
}

/** Payload của `compile.error` — build/typecheck/lint trả lỗi. */
export interface CompileErrorPayload {
  /** Lệnh/tool đã chạy (vd `tsc`, `npm run build`). */
  command: string;
  /** Tool đã chạy lệnh đó. */
  tool: string;
  callId: string;
  /** Dòng lỗi đầu tiên (đã cắt ngắn + sanitize). */
  firstError: string;
  /** Tổng số lỗi đếm được (nếu parse được). */
  errorCount?: number;
}

/** Payload của `run.paused` / `run.resumed`. */
export interface RunPausePayload {
  /** Step mà run dừng lại / tiếp tục. */
  step: number;
  /** Lý do pause (vd user bấm pause, host yêu cầu). */
  reason?: string;
}

/** Payload của `run.forked` — ghi ở CẢ run cha và run con. */
export interface RunForkedPayload {
  /** Run còn lại trong cặp fork (cha nhìn thấy con, con nhìn thấy cha). */
  otherRunId: string;
  /** Seq trong run này mà fork xảy ra. */
  atSeq: number;
  /** `parent` khi event nằm trong run cha, `child` khi nằm trong run con. */
  side: 'parent' | 'child';
}

/** Payload của `run.completed` / `run.failed` / `run.aborted`. */
export interface RunEndPayload {
  /** Text cuối cùng của run (đã cắt ngắn). Chỉ `run.completed` có. */
  finalText?: string;
  /** Thông báo lỗi. Chỉ `run.failed`/`run.aborted` có. */
  message?: string;
  /** Tổng số step đã chạy. */
  steps: number;
  /** Tổng số tool call đã chạy. */
  toolCalls: number;
  /** Tổng token đã dùng (nếu đếm được). */
  tokensUsed?: number;
  /** Thời gian chạy (ms) từ `run.started`. */
  durationMs: number;
}

/** Payload của `approval.request` / `approval.decision`. */
export interface ApprovalPayload {
  callId: string;
  tool: string;
  /** Chỉ `approval.decision` có: user cho chạy hay từ chối. */
  allowed?: boolean;
  /** Lý do (rule auto-approve nào khớp, hoặc lý do user từ chối). */
  reason?: string;
}

/** Payload của `checkpoint.saved`. */
export interface CheckpointSavedPayload {
  step: number;
  /** Số message trong checkpoint. */
  messages: number;
  /** Số tool call đã hoàn thành trong checkpoint. */
  toolCalls: number;
}

/** Map từ loại event sang payload của nó. */
export interface RunEventPayloadMap {
  'run.started': RunStartedPayload;
  'run.prompt': RunPromptPayload;
  'model.response': ModelResponsePayload;
  'tool.call': ToolCallPayload;
  'tool.result': ToolResultPayload;
  'file.change': FileChangePayload;
  'compile.error': CompileErrorPayload;
  'run.paused': RunPausePayload;
  'run.resumed': RunPausePayload;
  'run.forked': RunForkedPayload;
  'run.completed': RunEndPayload;
  'run.failed': RunEndPayload;
  'run.aborted': RunEndPayload;
  'approval.request': ApprovalPayload;
  'approval.decision': ApprovalPayload;
  'checkpoint.saved': CheckpointSavedPayload;
}

/**
 * Một event trong run log. Dạng generic theo type để payload được
 * kiểm tra kiểu tĩnh; `RunEvent` là union của mọi loại.
 */
export interface RunEvent<T extends RunEventType = RunEventType> {
  seq: number;
  runId: string;
  at: string;
  type: T;
  payload: RunEventPayloadMap[T];
  /** Hash của event trước trong cùng run ('' ở event đầu tiên). */
  prevHash: string;
  /** SHA-256 hex của event này (tính trên nội dung đã chuẩn hoá). */
  hash: string;
}

/** Union mọi event — dùng khi đọc log mà chưa biết type trước. */
export type AnyRunEvent = {
  [K in RunEventType]: RunEvent<K>;
}[RunEventType];

/** Dữ liệu cần để tạo một event mới (store tự điền seq/hash). */
export type NewRunEvent<T extends RunEventType = RunEventType> = {
  type: T;
  payload: RunEventPayloadMap[T];
  /** Ghi đè thời gian (mặc định `new Date().toISOString()`). Chủ yếu cho test. */
  at?: string;
};

/** Metadata tóm tắt của một run (đọc từ file log của nó). */
export interface RunLogMeta {
  runId: string;
  botId: string;
  title?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  lastSeq: number;
  parentRunId?: string;
  /** Số tool call / file change / lỗi — đếm nhanh cho UI. */
  toolCalls: number;
  fileChanges: number;
  errors: number;
  /** Digest trạng thái cuối (xem `replay.ts`) — có khi run đã kết thúc. */
  finalDigest?: string;
}

/** Điều kiện lọc khi đọc/query event. */
export interface RunEventQuery {
  /** Chỉ lấy các loại này (không set = tất cả). */
  types?: RunEventType[];
  /** Chỉ lấy seq >= giá trị này. */
  fromSeq?: number;
  /** Chỉ lấy seq <= giá trị này. */
  toSeq?: number;
  /** Chỉ lấy event từ thời điểm này (ISO, bao gồm). */
  fromAt?: string;
  /** Chỉ lấy event tới thời điểm này (ISO, bao gồm). */
  toAt?: string;
  /** Giới hạn số event trả về (mặc định không giới hạn). */
  limit?: number;
  /** Bỏ qua N event đầu sau khi lọc (phân trang). */
  offset?: number;
}

/** Kết quả kiểm chứng hash chain của một run. */
export interface RunLogVerification {
  runId: string;
  /** true khi toàn bộ chuỗi hash + seq đều đúng. */
  ok: boolean;
  eventCount: number;
  /** Seq đầu tiên bị lỗi (undefined khi ok). */
  firstBadSeq?: number;
  /** Mô tả lỗi đầu tiên (undefined khi ok). */
  reason?: string;
}

/** Trạng thái của một run được tái tạo bằng cách fold event (replay). */
export interface ReplayedRunState {
  runId: string;
  botId: string;
  status: RunStatus;
  /** Prompt gốc của user. */
  prompt: string;
  /** Transcript: text assistant + tool call/result theo thứ tự. */
  transcript: ReplayedTranscriptEntry[];
  /** Mọi tool call đã chạy (theo thứ tự), kèm kết quả nếu có. */
  toolCalls: ReplayedToolCall[];
  /** Mọi thay đổi file đã ghi. */
  fileChanges: FileChangePayload[];
  /** Mọi lỗi biên dịch đã ghi. */
  compileErrors: CompileErrorPayload[];
  /** Mọi lỗi run (message của `run.failed` + tool error). */
  errors: string[];
  steps: number;
  tokensUsed: number;
  startedAt: string;
  endedAt?: string;
  /** Digest SHA-256 của trạng thái này — hai lần replay cùng log phải cho cùng digest. */
  digest: string;
}

/** Một dòng trong transcript tái tạo. */
export type ReplayedTranscriptEntry =
  | { kind: 'text'; step: number; text: string }
  | { kind: 'tool_call'; step: number; call: RecordedToolCall }
  | { kind: 'tool_result'; step: number; callId: string; tool: string; status: string; outputPreview: string }
  | { kind: 'file_change'; step: number; change: FileChangePayload }
  | { kind: 'error'; step: number; message: string };

/** Một tool call trong trạng thái tái tạo. */
export interface ReplayedToolCall {
  callId: string;
  tool: string;
  argKeys: string[];
  step: number;
  status?: 'ok' | 'error' | 'denied';
  outputPreview?: string;
  durationMs?: number;
}

/** Kết quả replay xác định (deterministic): chạy lại driver với bản ghi. */
export interface DeterministicReplayResult {
  runId: string;
  /** true khi replay chạy hết log không lỗi nội bộ. */
  ok: boolean;
  /** Digest của trạng thái replay — so với digest gốc để khẳng định cùng kết quả. */
  digest: string;
  /** Số event đã phát lại. */
  eventsReplayed: number;
  /** Lỗi gặp trong lúc replay (nếu có). */
  error?: string;
}
