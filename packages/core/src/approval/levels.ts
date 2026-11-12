/**
 * Mức approval theo từng bot (M8).
 *
 * Mỗi bot có MỘT mức duyệt riêng, quyết định khi nào agent phải hiện
 * thẻ duyệt (card Allow/Deny) và khi nào được tự chạy:
 *
 *  - `ask-always` — hỏi mọi tool call cần duyệt, kể cả tool chỉ-đọc
 *    (vd `read_file` ngoài workspace của bot). Nặng tay nhất; dùng cho
 *    bot chạy trên dữ liệu nhạy cảm hoặc bot mới chưa tin tưởng.
 *  - `ask-for-writes` — mặc định. Chỉ hỏi tool ghi/thực thi (tool có
 *    `needsApproval`, tool bị policy `ask`, lệnh shell nhạy cảm); tool
 *    chỉ-đọc chạy ngay không hỏi. Đây là hành vi cũ của open-bot.
 *  - `auto-approve-safe` — tự duyệt mọi tool chỉ-đọc (kể cả khi policy
 *    nói `ask`), chỉ hỏi tool ghi/thực thi. Dùng cho bot đã tin tưởng,
 *    hay đọc nhiều.
 *
 * An toàn theo thiết kế (fail-closed):
 *  - Mức này KHÔNG BAO GIỜ vượt denylist: lệnh bị chặn (`rm -rf /`,
 *    `sudo`, …), hook PreToolUse, guardrail và policy `deny` vẫn chạy
 *    trước/sau như cũ (xem `agent/loop.ts`). Mức chỉ quyết định có
 *    HIỆN THẺ hay không, không quyết định có được PHÉP hay không.
 *  - Mức không hợp lệ / không đặt → `ask-for-writes` (hành vi cũ).
 *  - `auto-approve-safe` không tự duyệt tool ghi: tool ghi vẫn hỏi
 *    như thường. Muốn tự duyệt cả tool ghi thì dùng rule auto-approve
 *    tường minh (`approval/rules.ts`) hoặc cờ legacy `autoApprove`.
 *
 * Module PURE (không I/O): quyết định + parse/validate, dùng được
 * trong loop, coordinator, CLI và test mà không cần store.
 */

export type BotApprovalLevel = 'ask-always' | 'ask-for-writes' | 'auto-approve-safe';

export const BOT_APPROVAL_LEVELS: readonly BotApprovalLevel[] = [
  'ask-always',
  'ask-for-writes',
  'auto-approve-safe',
];

/** Mức mặc định khi bot chưa cấu hình (hành vi cũ của open-bot). */
export const DEFAULT_BOT_APPROVAL_LEVEL: BotApprovalLevel = 'ask-for-writes';

export function isBotApprovalLevel(value: unknown): value is BotApprovalLevel {
  return typeof value === 'string' && (BOT_APPROVAL_LEVELS as readonly string[]).includes(value);
}

/**
 * Chuẩn hoá mức approval từ cấu hình bot (settings.json / BotConfig).
 * Giá trị lạ / thiếu → mặc định `ask-for-writes`, không throw.
 */
export function parseBotApprovalLevel(value: unknown): BotApprovalLevel {
  return isBotApprovalLevel(value) ? value : DEFAULT_BOT_APPROVAL_LEVEL;
}

/** Input cho quyết định hỏi/tự duyệt của một tool call. */
export interface ApprovalLevelDecisionInput {
  /** Tool có phải tool ghi/thực thi không (needsApproval hoặc policy ask). */
  isWrite: boolean;
  /** Tool có phải tool chỉ-đọc không (`isReadOnlyTool`). */
  isReadOnly: boolean;
}

/**
 * Mức approval nói gì về tool call này: `'ask'` = hiện thẻ duyệt,
 * `'auto'` = chạy ngay không hỏi (chỉ khi tool an toàn theo mức).
 *
 * Bảng quyết định:
 *  - ask-always: hỏi mọi tool call (cả chỉ-đọc lẫn ghi).
 *  - ask-for-writes: hỏi tool ghi, tự chạy tool chỉ-đọc.
 *  - auto-approve-safe: hỏi tool ghi, tự chạy tool chỉ-đọc (giống
 *    ask-for-writes ở đây — khác biệt nằm ở loop: mức này còn bỏ qua
 *    cả policy `ask` cho tool chỉ-đọc, xem `shouldAskForCall`).
 *
 * Lưu ý: hàm này chỉ trả lời "có hỏi không", không trả lời "có được
 * phép không" — denylist/policy vẫn chặn trước đó trong loop.
 */
export function decideApprovalLevel(
  level: BotApprovalLevel,
  input: ApprovalLevelDecisionInput,
): 'ask' | 'auto' {
  if (level === 'ask-always') return 'ask';
  if (input.isWrite) return 'ask';
  return 'auto';
}

/**
 * Quyết định cuối trong loop cho một tool call sắp vào nhánh duyệt:
 * có hiện thẻ duyệt không? `askedByPolicyOrNeedsApproval` = loop đã
 * quyết định phải hỏi theo policy `ask` / `needsApproval` (hành vi cũ).
 *
 *  - Quy tắc self-read (xem `approval/selfRead.ts`) thắng mọi mức:
 *    bot đọc file của chính nó thì không bao giờ hỏi.
 *  - `auto-approve-safe` + tool chỉ-đọc → không hỏi, kể cả khi policy
 *    nói `ask` (policy `ask` cho tool chỉ-đọc thường là do lệnh shell
 *    nhạy cảm — nhưng tool chỉ-đọc theo tên thì không chạy shell).
 *  - `ask-always` → hỏi cả khi loop chưa định hỏi (tool chỉ-đọc bình
 *    thường cũng hiện thẻ).
 *  - Mặc định (`ask-for-writes`) → giữ nguyên quyết định cũ của loop.
 */
export function shouldAskForCall(options: {
  level: BotApprovalLevel | undefined;
  askedByPolicyOrNeedsApproval: boolean;
  isReadOnly: boolean;
  isSelfRead: boolean;
}): boolean {
  if (options.isSelfRead) return false;
  const level = parseBotApprovalLevel(options.level);
  if (level === 'auto-approve-safe' && options.isReadOnly) return false;
  if (level === 'ask-always') return true;
  return options.askedByPolicyOrNeedsApproval;
}
