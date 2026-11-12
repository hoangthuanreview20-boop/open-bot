/**
 * Handoff phiên làm việc (v0.37, P1-3 — kiểu Claude Code / Cursor handoff).
 *
 * Khác với handoff trực tiếp v0.12 (`transfer_to_X` trong
 * `agent/handoff.ts` — chuyển việc NGAY trong một run, bot đích chạy luôn
 * rồi trả lời về): record ở đây là một **bản ghi bền** để chuyển giao công
 * việc GIỮA các phiên/bot — bot A tóm tắt trạng thái + việc còn lại rồi
 * lưu lại, bot B (người hoặc agent khác, có thể nhiều giờ/ngày sau) nạp
 * record và tiếp tục từ đúng chỗ đó, không cần toàn bộ transcript.
 *
 * Một record gồm: công việc là gì, trạng thái hiện tại, việc đã xong,
 * việc còn lại + bước tiếp theo, file đã đổi/liên quan, quyết định quan
 * trọng, lỗi/blocker đang gặp, và một đoạn transcript rút gọn để lấy ngữ
 * cảnh. Không nhét toàn bộ transcript — mọi trường đều có giới hạn ký tự
 * và cắt ngắn thông minh (giữ đầu + cuối), trường nào bị cắt đều ghi vào
 * `truncatedFields`.
 *
 * An toàn: record KHÔNG BAO GIỜ chứa secret/API key — mọi chuỗi text đều
 * qua `redactHandoffText` (Bearer + dạng `sk-…`/`xai-…` + `apiKey: …` +
 * secret đã biết) trước khi lưu, giống cách tracing khử secret (xem
 * `tracing/tracer.ts`). `redacted: true` khi có nội dung đã bị khử.
 *
 * Tương thích ngược: record cũ (thiếu trường, thiếu `version`) vẫn đọc
 * được qua `parseSessionHandoffRecord` — trường thiếu nhận giá trị mặc
 * định, chỉ bản ghi không phải object hoặc thiếu hẳn `fromBotId` mới bị
 * loại.
 */

/** Phiên bản format record hiện tại (tăng khi đổi shape không tương thích). */
export const SESSION_HANDOFF_FORMAT_VERSION = 1;

/** Tên file lưu record trong thư mục dữ liệu local (userData). */
export const SESSION_HANDOFFS_FILE_NAME = 'handoffs.json';

/** Số record tối đa giữ trên đĩa — lưu thêm thì record cũ nhất bị bỏ. */
export const MAX_SESSION_HANDOFFS = 50;

/** Trạng thái công việc lúc tạo handoff (không phải trạng thái record). */
export type SessionHandoffWorkStatus = 'in-progress' | 'blocked' | 'waiting-input' | 'done';

/** Một dòng hội thoại rút gọn mang theo record (tương thích ChatMessage). */
export interface SessionHandoffMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** Một quyết định quan trọng đã chốt trong lúc làm việc. */
export interface SessionHandoffDecision {
  decision: string;
  /** Vì sao chốt như vậy (tùy chọn). */
  reason?: string;
}

/** Một lỗi/blocker đang gặp (kèm những gì đã thử, nếu có). */
export interface SessionHandoffBlocker {
  description: string;
  /** Đã thử gì để gỡ (tùy chọn). */
  attempted?: string;
}

/**
 * Bản ghi handoff phiên làm việc (version 1).
 *
 * `completed` / `remaining` là danh sách việc (mỗi mục một chuỗi ngắn);
 * mục đầu của `remaining` nên là bước làm ngay tiếp theo (trùng
 * `nextStep`). `chain` là id các record trước trong cùng chuỗi chuyển
 * giao (cũ nhất trước) để lần theo lịch sử A → B → C.
 */
export interface SessionHandoffRecord {
  version: number;
  /** Id ổn định (uuid), sinh lúc tạo — dùng để nạp/xoá + nối chuỗi. */
  id: string;
  /** Tiêu đề ngắn, vd "Thêm tool create_handoff cho open-bot". */
  title: string;
  /** ISO 8601 lúc tạo record. */
  createdAt: string;
  /** Bot nguồn (id + tên hiển thị lúc tạo). */
  fromBotId: string;
  fromBotName: string;
  /** Bot đích (nếu đã chọn — chỉ bot này mới được nhận; trống = bot nào cũng nhận được). */
  toBotId?: string;
  toBotName?: string;
  /** Id run đã tạo ra record (nếu tạo từ trong run). */
  runId?: string;
  /** Trạng thái công việc lúc bàn giao. */
  workStatus: SessionHandoffWorkStatus;
  /** Công việc đang làm là gì (tối đa 2.000 ký tự). */
  taskSummary: string;
  /** Trạng thái hiện tại: đang ở đâu, vừa làm gì xong (tối đa 2.000 ký tự). */
  currentState: string;
  /** Việc đã xong (tối đa 20 mục, mỗi mục 500 ký tự). */
  completed: string[];
  /** Việc còn lại, theo thứ tự làm (tối đa 20 mục, mỗi mục 500 ký tự). */
  remaining: string[];
  /** Bước làm ngay tiếp theo (tối đa 500 ký tự). */
  nextStep: string;
  /** File đã đổi trong lúc làm (tối đa 30 file, mỗi đường dẫn 200 ký tự). */
  filesChanged: string[];
  /** File liên quan cần đọc để tiếp tục (tối đa 30 file). */
  filesRelevant: string[];
  /** Quyết định quan trọng đã chốt (tối đa 10). */
  decisions: SessionHandoffDecision[];
  /** Lỗi/blocker đang gặp (tối đa 10). */
  blockers: SessionHandoffBlocker[];
  /** Ngữ cảnh cần thiết khác — không nhét transcript (tối đa 8.000 ký tự). */
  context: string;
  /** Đoạn transcript rút gọn (tối đa 10.000 ký tự tổng). */
  transcriptExcerpt: SessionHandoffMessage[];
  /** Id record trước trong cùng chuỗi (nếu handoff này nối tiếp một handoff cũ). */
  previousHandoffId?: string;
  /** Id các record trước trong chuỗi, cũ nhất trước. */
  chain: string[];
  /** Bot nào đã nhận record này (nhận lại thì ghi đè lần nhận mới nhất). */
  acceptedByBotId?: string;
  acceptedByBotName?: string;
  /** ISO 8601 lúc nhận. */
  acceptedAt?: string;
  /** Id run đã nạp record (khi nhận qua tham số run `handoffId`). */
  acceptedRunId?: string;
  /** True khi ít nhất một trường đã bị cắt ngắn. */
  truncated: boolean;
  /** Tên các trường đã bị cắt ngắn (vd ['context', 'transcriptExcerpt']). */
  truncatedFields: string[];
  /** True khi có nội dung đã bị khử secret lúc tạo. */
  redacted: boolean;
}

/** Dạng xem gọn của record — thứ RPC `listHandoffs` trả về (không có transcript). */
export interface SessionHandoffSummary {
  id: string;
  title: string;
  createdAt: string;
  fromBotId: string;
  fromBotName: string;
  toBotId?: string;
  toBotName?: string;
  workStatus: SessionHandoffWorkStatus;
  /** Số việc đã xong / còn lại (để UI hiện tiến độ mà không cần đọc cả record). */
  completedCount: number;
  remainingCount: number;
  nextStep: string;
  /** Số file đã đổi + liên quan. */
  filesChangedCount: number;
  filesRelevantCount: number;
  blockersCount: number;
  truncated: boolean;
  redacted: boolean;
  acceptedByBotId?: string;
  acceptedByBotName?: string;
  acceptedAt?: string;
}

/** Kết quả nạp record vào một run — xác nhận những gì bot nhận đã nạp. */
export interface AcceptedHandoffConfirmation {
  id: string;
  title: string;
  fromBotId: string;
  fromBotName: string;
  workStatus: SessionHandoffWorkStatus;
  completedCount: number;
  remainingCount: number;
  filesChangedCount: number;
  truncated: boolean;
  redacted: boolean;
  /** ISO 8601 lúc nhận (lần nhận này). */
  acceptedAt: string;
}
