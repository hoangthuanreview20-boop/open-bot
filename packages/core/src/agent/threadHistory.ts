/**
 * Thread-history seeding (v0.60, sóng sau v0.59): chọn các message gần
 * nhất của một thread để nạp làm context cho run.
 *
 * v0.59 đưa threads thành thực thể riêng trong SQLite BotMemory nhưng
 * run chưa nạp history — resume chỉ khôi phục hiển thị, model không
 * "nhớ" lượt cũ. `executeRun` (coordinator) đọc thread qua
 * `BotMemory.getThreadHistory` rồi đưa phần đã chọn vào runner qua
 * option `historyMessages` (loop chèn giữa system prompt và tin mới).
 *
 * Hàm này là pure (không chạm DB) để test được trực tiếp: đầu vào là
 * history đã đọc (cũ → mới, như `getThreadHistory` trả về), đầu ra là
 * phần giữ lại, vẫn giữ thứ tự cũ → mới.
 *
 * Thứ tự cắt (quan trọng — lượt gần nhất luôn được giữ):
 *   1. Bỏ message `tool` (bản ghi transcript, không phải lượt chat;
 *      gửi trần về provider sẽ bị từ chối vì thiếu assistant
 *      `tool_calls` đi kèm — mà `saveMessage` vốn không lưu
 *      `toolCalls` nên history không bao giờ có cặp đó).
 *   2. Bỏ message user cuối trùng hệt tin nhắn hiện tại của run
 *      (`currentText`): main (`chat:send`) lưu tin user vào BotMemory
 *      TRƯỚC khi gọi run, nên tin đó đã nằm cuối history; không bỏ
 *      thì model thấy tin hiện tại hai lần. Chỉ bỏ đúng message cuối
 *      cùng — user lặp lại đúng câu cũ ở lượt trước vẫn còn nguyên
 *      trong history (giữa hai lần lặp có lượt assistant chen vào,
 *      hoặc lượt trước không có reply thì nội dung trùng hệt nên
 *      mất cũng không mất thông tin).
 *   3. Cắt từ ĐẦU theo số message (`maxMessages`), rồi theo token
 *      (`maxTokens`, đếm bằng `estimateTokens` dùng chung với
 *      compaction/smallModel) — chỉ giữ các lượt gần nhất.
 *   4. (v0.65) Bỏ `attachments` khỏi mọi message giữ lại: ảnh cũ chỉ
 *      để hiển thị lại (đọc qua `getHistory` với
 *      `includeAttachments`), không bao giờ gửi lại lên provider ở
 *      lượt sau — vừa tiết kiệm token, vừa giữ đúng cam kết "history
 *      không mang ảnh" của kênh vision.
 * Cap là bất biến cứng: tổng token ước lượng của kết quả không bao
 * giờ vượt `maxTokens`, kể cả khi một message đơn lẻ đã vượt (lúc
 * đó history trả về rỗng và run chạy y như thread rỗng, thay vì nổ
 * context hoặc kẹt ở small-model guard).
 */

import type { ChatMessage } from '../types';
import { estimateTokens } from './tokens';

/**
 * Số message tối đa nạp từ một thread — bằng limit mặc định của
 * `getHistory`/`getThreadHistory` (50), để một lượt đọc DB là đủ.
 */
export const THREAD_HISTORY_MAX_MESSAGES = 50;

/**
 * Trần token tuyệt đối cho history đã seed — 8.000 token, khoảng
 * 25–40 lượt chat thường. Đủ để model nhớ ngữ cảnh dài mà vẫn chừa
 * chỗ cho system prompt + tool definitions + lượt mới + kết quả tool
 * trong cùng một context window.
 */
export const THREAD_HISTORY_MAX_TOKENS = 8_000;

/**
 * History không bao giờ chiếm quá 1/4 context window của model —
 * phần còn lại dành cho system prompt, tools, lượt mới và tool
 * results. Với model Ollama đo được 4.096 token thì ngân sách là
 * 1.024 token (vài lượt gần nhất); model ≥ 32k token thì trần tuyệt
 * đối 8.000 token mới là giới hạn binding.
 */
export const THREAD_HISTORY_CONTEXT_FRACTION = 0.25;

/**
 * Ngân sách token cho history từ context window của model (khi biết):
 * `min(THREAD_HISTORY_MAX_TOKENS, floor(limit * fraction))`. Limit
 * không hợp lệ/không biết → trần tuyệt đối.
 */
export function threadHistoryTokenBudget(contextLimit?: number): number {
  if (
    typeof contextLimit !== 'number' ||
    !Number.isFinite(contextLimit) ||
    contextLimit <= 0
  ) {
    return THREAD_HISTORY_MAX_TOKENS;
  }
  return Math.min(
    THREAD_HISTORY_MAX_TOKENS,
    Math.max(0, Math.floor(contextLimit * THREAD_HISTORY_CONTEXT_FRACTION)),
  );
}

export interface SelectThreadHistoryOptions {
  /** Số message tối đa giữ lại (mặc định THREAD_HISTORY_MAX_MESSAGES). */
  maxMessages?: number;
  /** Tổng token ước lượng tối đa (mặc định THREAD_HISTORY_MAX_TOKENS). */
  maxTokens?: number;
  /**
   * Nội dung tin nhắn hiện tại của run — message user cuối history
   * trùng hệt chuỗi này sẽ bị bỏ (đã lưu trước khi run, xem ghi chú
   * đầu file). Không truyền thì không bỏ gì.
   */
  currentText?: string;
}

/**
 * Chọn phần history giữ lại làm context. Không mutate mảng đầu vào.
 * Trả về mảng mới (có thể rỗng): thứ tự cũ → mới, chỉ gồm role
 * `user`/`assistant`/`system`, tổng token ước lượng ≤ `maxTokens`,
 * số message ≤ `maxMessages`.
 */
export function selectThreadHistory(
  messages: readonly ChatMessage[],
  opts: SelectThreadHistoryOptions = {},
): ChatMessage[] {
  const maxMessages = opts.maxMessages ?? THREAD_HISTORY_MAX_MESSAGES;
  const maxTokens = opts.maxTokens ?? THREAD_HISTORY_MAX_TOKENS;
  if (maxMessages <= 0 || maxTokens <= 0) return [];

  // 1. Bỏ message `tool` (xem ghi chú đầu file).
  let kept = messages.filter((m) => m.role !== 'tool');

  // 2. Bỏ message user cuối trùng hệt tin hiện tại (đã lưu trước run).
  if (opts.currentText !== undefined && opts.currentText !== '' && kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last && last.role === 'user' && last.content === opts.currentText) {
      kept = kept.slice(0, -1);
    }
  }

  // 3a. Cắt theo số message: chỉ giữ `maxMessages` lượt gần nhất.
  if (kept.length > maxMessages) kept = kept.slice(kept.length - maxMessages);

  // 3b. Cắt theo token: bỏ dần từ đầu (lượt cũ nhất) cho tới khi vừa
  // ngân sách. Đếm mỗi message một lần bằng estimator dùng chung.
  const costs = kept.map((m) => estimateTokens(typeof m.content === 'string' ? m.content : ''));
  let total = costs.reduce((sum, c) => sum + c, 0);
  let start = 0;
  while (start < kept.length && total > maxTokens) {
    total -= costs[start] ?? 0;
    start += 1;
  }
  if (start > 0) kept = kept.slice(start);
  // 4. (v0.65) Bỏ `attachments`: ảnh cũ không gửi lại lên provider —
  // dù caller có đưa history mang ảnh vào thì đường này vẫn lột sạch.
  return kept.map((m) => {
    if (!m.attachments) return m;
    const { attachments: _dropped, ...rest } = m;
    return rest;
  });
}
