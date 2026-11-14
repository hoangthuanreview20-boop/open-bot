/**
 * ConfirmationPolicy (v1.01, Đội T3) — khi nào một tool call cần hỏi
 * người dùng trước khi chạy.
 *
 * Ý tưởng học từ OpenHands ConfirmationPolicy, thiết kế của open-bot.
 *
 * Ba mức:
 *  - `allow-all` — không hỏi thêm vì risk (quyền allow/deny vẫn do
 *    permissions/hook/guardrail quyết định; tool có `needsApproval`
 *    hoặc policy `ask` vẫn hỏi theo đường cũ trong loop).
 *  - `confirm-risky` (mặc định) — hỏi khi risk medium hoặc high.
 *  - `confirm-all` — hỏi mọi tool call, kể cả low.
 *
 * Policy CHỈ quyết định "có hỏi không". Nó không cấp quyền, không bỏ
 * qua denylist, không thay thế mức approval theo bot (`approval/
 * levels.ts`) — loop gộp các nguồn hỏi lại với nhau (hỏi khi BẤT KỲ
 * nguồn nào nói hỏi), nên policy chỉ siết thêm, không nới lỏng.
 */

import type { ConfirmationDecision, ConfirmationPolicy, RiskAssessment } from './types';
import { DEFAULT_CONFIRMATION_POLICY, parseConfirmationPolicy } from './types';

export { DEFAULT_CONFIRMATION_POLICY, parseConfirmationPolicy };
export type { ConfirmationPolicy };

/**
 * Policy nói gì về tool call này (dựa trên đánh giá risk đã tính).
 * `assessment.denied` (denylist) không đi qua đây — loop chặn cứng
 * trước khi hỏi policy.
 */
export function decideConfirmation(
  policy: ConfirmationPolicy | undefined,
  assessment: RiskAssessment,
): ConfirmationDecision {
  const parsed = parseConfirmationPolicy(policy);
  switch (parsed) {
    case 'allow-all':
      return {
        needsConfirmation: false,
        reason: `Policy allow-all: tool "${assessment.toolName}" (risk ${assessment.level}) chạy không hỏi.`,
      };
    case 'confirm-all':
      return {
        needsConfirmation: true,
        reason: `Policy confirm-all: hỏi mọi tool call (risk ${assessment.level}).`,
      };
    case 'confirm-risky':
    default:
      if (assessment.level === 'low') {
        return {
          needsConfirmation: false,
          reason: `Policy confirm-risky: risk low nên tool "${assessment.toolName}" chạy không hỏi.`,
        };
      }
      return {
        needsConfirmation: true,
        reason: `Policy confirm-risky: risk ${assessment.level} (điểm ${assessment.score}) nên cần duyệt.`,
      };
  }
}

/** Nhãn hiển thị cho policy (dùng ở UI/settings). */
export const CONFIRMATION_POLICY_LABELS: Record<ConfirmationPolicy, string> = {
  'allow-all': 'Cho phép tất cả (không hỏi vì risk)',
  'confirm-risky': 'Hỏi khi tool có rủi ro (medium/high)',
  'confirm-all': 'Hỏi mọi tool call',
};
