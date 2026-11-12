/**
 * Small-model guardrail (v0.19, W12a).
 *
 * Gap dài hạn từ v0.10: model local nhỏ (vd context 4.096 token) lỗi 400
 * vì 119 tool nạp vào mỗi request quá nặng (~5.500 token theo
 * ARCHITECTURE.md), và trước đây chưa có rào chắn nào khi model có
 * context nhỏ — provider cứ gọi rồi mới trả 400 khó hiểu.
 *
 * Module này là API thuần (pure, không I/O):
 *  - `isSmallContextModel(model, contextLimit?)` — model có context nhỏ
 *    không (ngưỡng `SMALL_CONTEXT_THRESHOLD_TOKENS` = 8k).
 *  - `assertFitsSmallModel(...)` — ném lỗi tiếng Việt rõ ràng khi ước
 *    lượng token vượt context của model nhỏ, kèm gợi ý khắc phục.
 *  - `estimateTextTokens` / `estimateMessagesTokens` — ước lượng token
 *    bằng heuristic dùng chung ở `tokens.ts` (`estimateTokens`, sát hơn
 *    chars/4 cũ); KHÔNG viết tokenizer mới ở đây.
 *
 * Cách dùng trong loop (`agent/loop.ts`, đầu `runLoop`, trước khi gọi
 * provider lần đầu): khi model nhỏ thì ép filtering + grouping ở mức
 * mạnh nhất (plan mode + grouping, chỉ tool chỉ-đọc của plan hiện tại +
 * tool giao tiếp tối thiểu), rồi ước lượng lại — vẫn vượt thì dừng run
 * bằng lỗi của `assertFitsSmallModel` thay vì để provider trả 400.
 *
 * Nguồn của `contextLimit` (theo thứ tự ưu tiên, xem loop):
 *  1. `AgentRunnerOptions.smallModel.contextLimit` (ghi đè tường minh),
 *  2. `AgentRunnerOptions.compaction.contextLimit` (coordinator đã truyền
 *     `contextLimitForModel(providerId, model)` vào đây),
 *  3. heuristic theo tên model (`inferContextLimitFromModelName`) — chỉ
 *     nhận ra tên ghi rõ context (vd `...-4k`, `ctx4096`); tên lạ thì
 *     KHÔNG đoán (trả undefined, guard chỉ ép lọc chứ không assert số).
 */

import type { ChatMessage } from '../types';
import { estimateToolsTokens } from './toolFilter';
import { estimateTokens } from './tokens';
import type { Tool, ToolDefinition } from '../types';

/**
 * Ngưỡng context nhỏ: model có context window ≤ 8.192 token được coi là
 * model nhỏ. 8.192 vừa đủ chứa system prompt + plan-mode tools đã gom
 * nhóm (~dưới 4.096 token theo test tool-filtering), còn 4.096 thì đã
 * chật — cả hai đều cần guard.
 */
export const SMALL_CONTEXT_THRESHOLD_TOKENS = 8_192;

/** Số ký tự ước tính bằng 1 token trong heuristic chars/4 CŨ — giữ lại để
 *  tương thích, estimator hiện tại (`tokens.ts`) không dùng nó nữa. */
export const CHARS_PER_TOKEN = 4;

/**
 * Ước lượng token của một chuỗi: dùng chung `estimateTokens` (tokens.ts).
 * Chuỗi rỗng → 0. (Từ đơn dài vẫn khớp chars/4: 'a'×100 → 25.)
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return estimateTokens(text);
}

/** Ước lượng token của toàn bộ messages (cộng content từng message). */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTextTokens(typeof m.content === 'string' ? m.content : '');
  }
  return total;
}

/**
 * Đoán context window từ TÊN model. Chỉ nhận ra tên ghi rõ context:
 *  - `ctx`/`context`/`window` + số (vd `ctx4096`, `context-8k`),
 *  - hậu tố `-4k` / `-8k` (vd `qwen2.5:0.5b-4k`),
 *  - số 1024/2048/4096/8192 đứng riêng thành token (vd `llama-4096`).
 * Số tham số (`1b`, `7b`) hay phiên bản (`2.5`, `3.2`) KHÔNG phải context
 * nên không được tính. Tên lạ → undefined (không đoán).
 */
export function inferContextLimitFromModelName(model: string): number | undefined {
  const m = (model ?? '').toLowerCase().trim();
  if (!m) return undefined;
  const withCtx = m.match(/(?:ctx|context|window)[-_]?(\d+(?:\.\d+)?)\s*(k)?/);
  if (withCtx) {
    const n = Number(withCtx[1]);
    if (Number.isFinite(n) && n > 0) return Math.round(withCtx[2] ? n * 1000 : n);
  }
  const suffixK = m.match(/(?:^|[-_/:])(\d+(?:\.\d+)?)k(?:[^a-z0-9]|$)/);
  if (suffixK) {
    const n = Number(suffixK[1]);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }
  const bare = m.match(/(?:^|[-_/:])(1024|2048|4096|8192)(?:[^0-9]|$)/);
  if (bare) return Number(bare[1]);
  return undefined;
}

/**
 * True khi model có context nhỏ (≤ 8k). `contextLimit` tường minh thắng
 * heuristic theo tên: có số thì so số đó với ngưỡng; không có số thì
 * dùng `inferContextLimitFromModelName(model)`; tên lạ → false (không
 * đoán mò — caller muốn chắc chắn thì truyền `contextLimit`).
 */
export function isSmallContextModel(model: string, contextLimit?: number): boolean {
  if (typeof contextLimit === 'number' && Number.isFinite(contextLimit)) {
    return contextLimit <= SMALL_CONTEXT_THRESHOLD_TOKENS;
  }
  const inferred = inferContextLimitFromModelName(model);
  return inferred !== undefined && inferred <= SMALL_CONTEXT_THRESHOLD_TOKENS;
}

/** Context window hiệu lực để assert: số tường minh, nếu không thì số suy ra từ tên. */
export function effectiveContextLimit(
  model: string,
  contextLimit?: number,
): number | undefined {
  if (typeof contextLimit === 'number' && Number.isFinite(contextLimit)) return contextLimit;
  return inferContextLimitFromModelName(model);
}

export interface AssertFitsSmallModelInput {
  /** Tên model (để báo lỗi + suy ra context khi không có `contextLimit`). */
  model: string;
  /** Context window (token) của model, nếu biết chắc (vd từ settings). */
  contextLimit?: number;
  /** Ước lượng token của request sắp gửi (messages + tool definitions theo `estimateTokens` dùng chung). */
  estimatedTokens: number;
  /** Số tool definition sẽ gửi kèm (để báo lỗi + gợi ý). */
  toolCount: number;
}

/**
 * Lỗi ném khi request ước tính vượt context của model nhỏ. Mang theo số
 * liệu để caller/test assert được, message tiếng Việt để user đọc hiểu.
 */
export class SmallModelContextError extends Error {
  readonly model: string;
  readonly contextLimit: number;
  readonly estimatedTokens: number;
  readonly toolCount: number;

  constructor(input: AssertFitsSmallModelInput & { contextLimit: number }) {
    const over = input.estimatedTokens - input.contextLimit;
    super(
      `Model "${input.model}" chỉ có context ${input.contextLimit.toLocaleString('vi-VN')} token ` +
        `nhưng request này ước tính cần ~${input.estimatedTokens.toLocaleString('vi-VN')} token ` +
        `cho ${input.toolCount} tool — vượt ~${over.toLocaleString('vi-VN')} token, ` +
        `provider sẽ trả lỗi 400. Gợi ý: bật plan mode (chỉ giữ tool chỉ-đọc), ` +
        `bật grouping để gom tool thành nhóm, giảm số tool nạp vào mỗi request ` +
        `(tắt skill/MCP không cần thiết), rút gọn system prompt, hoặc đổi sang ` +
        `model có context lớn hơn (từ 32k trở lên).`,
    );
    this.name = 'SmallModelContextError';
    this.model = input.model;
    this.contextLimit = input.contextLimit;
    this.estimatedTokens = input.estimatedTokens;
    this.toolCount = input.toolCount;
  }
}

/**
 * Ném `SmallModelContextError` (tiếng Việt, kèm gợi ý) khi ước lượng
 * token vượt context của model nhỏ. Không làm gì khi:
 *  - model không nhỏ (`isSmallContextModel` false), hoặc
 *  - không xác định được context window (không có `contextLimit` mà tên
 *    model cũng không ghi rõ context — không đoán mò để chặn nhầm), hoặc
 *  - ước lượng vẫn vừa trong context.
 */
export function assertFitsSmallModel(input: AssertFitsSmallModelInput): void {
  if (!isSmallContextModel(input.model, input.contextLimit)) return;
  const limit = effectiveContextLimit(input.model, input.contextLimit);
  if (limit === undefined) return;
  if (input.estimatedTokens <= limit) return;
  throw new SmallModelContextError({ ...input, contextLimit: limit });
}

/**
 * Ước lượng token của request đầu tiên: messages + tool definitions
 * (messages dùng heuristic dùng chung `estimateTokens`, tool definitions
 * vẫn dùng `estimateToolsTokens` chars/4 của toolFilter). Dùng chung cho
 * loop guard và test.
 */
export function estimateFirstRequestTokens(
  messages: readonly ChatMessage[],
  tools: Array<Tool | ToolDefinition>,
): number {
  return estimateMessagesTokens(messages) + estimateToolsTokens(tools);
}
