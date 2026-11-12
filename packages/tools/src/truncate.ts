/**
 * Shared tool-result truncation (v0.41 follow-up: blob-truncation dedup).
 *
 * Trước đây mỗi nhóm tool trong `packages/tools/src` định nghĩa một bản
 * sao y hệt của `truncate()` (cắt cứng ở 20.000 ký tự + footer
 * `[... truncated to <N> chars ...]`): accessTools, agentDataTools,
 * ciTools, codeTools, computerUse, gitTools, integrationTools,
 * localBridge, localTools, mcpSystemTools, mcpTools, shellTools,
 * webMedia và plugins/loader — 14 bản sao, cộng bản blob-aware trong
 * tools.ts và bản fallback trong blobStore.ts. Tất cả nay dùng chung
 * hai hàm dưới đây; các module cũ giữ nguyên tên export của hằng số
 * (re-export từ đây) nên code import từ chúng không phải sửa.
 *
 * Hành vi được giữ nguyên tuyệt đối (không đổi limit, không đổi
 * footer): `truncateText` là đúng bản sao cũ; `truncateTextWithRemainder`
 * là đúng bản `truncate()` riêng của sandbox.ts (footer của nó ghi số
 * ký tự còn lại: `[... truncated, <N> more chars ...]`).
 *
 * Không dùng cho `truncateWithBlob` (blobStore.ts): khi có workspaceDir
 * thì kết quả dài được lưu blob thay vì cắt bỏ; chỉ nhánh fallback
 * (không workspaceDir / ghi blob lỗi) mới gọi `truncateText`.
 */

/** Giới hạn mặc định cho kết quả tool: 20.000 ký tự (giữ nguyên). */
export const MAX_TOOL_RESULT_CHARS = 20_000;
/** Bí danh theo từng nhóm tool — cùng giá trị 20.000, giữ nguyên tên cũ. */
export const MAX_MCP_RESULT_CHARS = MAX_TOOL_RESULT_CHARS;
export const MAX_LOCAL_BRIDGE_RESULT_CHARS = MAX_TOOL_RESULT_CHARS;
export const MAX_PLUGIN_TOOL_OUTPUT_CHARS = MAX_TOOL_RESULT_CHARS;

/**
 * Cắt `text` về tối đa `maxChars` ký tự; ngắn hơn hoặc bằng giới hạn
 * thì trả nguyên văn. Chuỗi dài hơn bị cắt + footer
 * `\n[... truncated to <maxChars> chars ...]`.
 */
export function truncateText(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated to ${maxChars} chars ...]`;
}

/**
 * Biến thể dùng riêng cho sandbox (`sandbox.ts`): footer ghi số ký tự
 * còn lại thay vì giới hạn, `\n[... truncated, <N> more chars ...]`.
 * Không có giá trị mặc định — mọi call site truyền `maxChars` rõ ràng.
 */
export function truncateTextWithRemainder(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated, ${text.length - maxChars} more chars ...]`;
}
