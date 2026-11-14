/**
 * Risk report (v1.01, Đội T3) — bản báo cáo đọc được cho một run /
 * conversation: risk đã chấm cho từng tool call + quyết định duyệt +
 * budget cuối. Dùng cho audit (user xem lại "bot đã làm gì, cái nào
 * tôi đã duyệt, tốn bao nhiêu") và cho CLI `risk report`.
 *
 * Pure: nhận audit log (ConfirmationQueue) + snapshot budget (+ danh
 * sách assessment đã chấm, nếu host giữ lại) rồi render Markdown hoặc
 * JSON. Không đọc file, không gọi mạng.
 */

import type { BudgetSnapshot, ConfirmationAuditEntry, RiskAssessment } from './types';

export interface RiskReportInput {
  /** Bot / run mà báo cáo nói tới (hiển thị ở đầu báo cáo). */
  botId: string;
  conversationId: string;
  /** Audit log quyết định duyệt (mới nhất cuối). */
  audit: ConfirmationAuditEntry[];
  /** Snapshot budget cuối của conversation (null = không có meter). */
  budget: BudgetSnapshot | null;
  /** Assessment đã chấm (host giữ lại từ loop, nếu có). */
  assessments?: RiskAssessment[];
}

export interface RiskReportSummary {
  totalCalls: number;
  approved: number;
  denied: number;
  edited: number;
  expired: number;
  highRisk: number;
  mediumRisk: number;
  lowRisk: number;
  totalTokens: number;
  costUsd: number | null;
}

export function summarizeRiskReport(input: RiskReportInput): RiskReportSummary {
  let approved = 0;
  let denied = 0;
  let edited = 0;
  let expired = 0;
  let highRisk = 0;
  let mediumRisk = 0;
  let lowRisk = 0;
  for (const entry of input.audit) {
    if (entry.status === 'approved') approved += 1;
    else if (entry.status === 'denied') denied += 1;
    else if (entry.status === 'edited') edited += 1;
    else if (entry.status === 'expired') expired += 1;
    if (entry.riskLevel === 'high') highRisk += 1;
    else if (entry.riskLevel === 'medium') mediumRisk += 1;
    else lowRisk += 1;
  }
  for (const a of input.assessments ?? []) {
    if (a.level === 'high') highRisk += 1;
    else if (a.level === 'medium') mediumRisk += 1;
    else lowRisk += 1;
  }
  return {
    totalCalls: input.audit.length,
    approved,
    denied,
    edited,
    expired,
    highRisk,
    mediumRisk,
    lowRisk,
    totalTokens: input.budget?.totalTokens ?? 0,
    costUsd: input.budget?.costUsd ?? null,
  };
}

function formatCost(costUsd: number | null, hasUnknownCost: boolean): string {
  if (costUsd === null) return hasUnknownCost ? 'không rõ (có model chưa có giá)' : '$0.00';
  return `$${costUsd.toFixed(4)}`;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

/** Render báo cáo Markdown (đọc được, paste vào issue/chat). */
export function buildRiskReportMarkdown(input: RiskReportInput): string {
  const summary = summarizeRiskReport(input);
  const lines: string[] = [];
  lines.push(`# Risk report — bot ${input.botId}`);
  lines.push('');
  lines.push(`Conversation: \`${input.conversationId}\``);
  lines.push('');
  lines.push('## Tổng quan');
  lines.push('');
  lines.push(`- Tool call cần duyệt: ${summary.totalCalls}`);
  lines.push(`  - Đã duyệt: ${summary.approved}`);
  lines.push(`  - Từ chối: ${summary.denied}`);
  lines.push(`  - Duyệt kèm sửa args: ${summary.edited}`);
  lines.push(`  - Hết hạn (mặc định từ chối): ${summary.expired}`);
  lines.push(`- Mức risk: high ${summary.highRisk} / medium ${summary.mediumRisk} / low ${summary.lowRisk}`);
  if (input.budget) {
    lines.push(`- Token: ${input.budget.totalTokens.toLocaleString('en-US')} (${input.budget.inputTokens.toLocaleString('en-US')} vào / ${input.budget.outputTokens.toLocaleString('en-US')} ra)`);
    lines.push(`- Chi phí ước tính: ${formatCost(input.budget.costUsd, input.budget.hasUnknownCost)}`);
    lines.push(`- Trạng thái budget: ${input.budget.status}`);
  } else {
    lines.push('- Budget: không có meter cho conversation này.');
  }
  lines.push('');
  if (input.audit.length > 0) {
    lines.push('## Quyết định duyệt');
    lines.push('');
    lines.push('| Thời điểm | Tool | Risk | Quyết định | Bởi |');
    lines.push('|---|---|---|---|---|');
    for (const entry of input.audit) {
      const when = formatTime(entry.atMs);
      const decision =
        entry.status === 'approved'
          ? 'duyệt'
          : entry.status === 'denied'
            ? 'từ chối'
            : entry.status === 'edited'
              ? 'duyệt + sửa args'
              : 'hết hạn';
      lines.push(`| ${when} | ${entry.toolName} | ${entry.riskLevel} (${entry.riskScore}) | ${decision} | ${entry.decidedBy} |`);
    }
    lines.push('');
  }
  if ((input.assessments ?? []).length > 0) {
    lines.push('## Tool call đã chấm risk (không cần duyệt)');
    lines.push('');
    for (const a of input.assessments ?? []) {
      lines.push(`- \`${a.toolName}\` — ${a.level} (${a.score}/100): ${a.reasons.join('; ')}`);
    }
    lines.push('');
  }
  lines.push('_Báo cáo risk là heuristic trên tên tool + args — không phải chứng minh an toàn. Chi phí là ước tính từ bảng giá tĩnh._');
  return lines.join('\n');
}

/** Render báo cáo JSON (máy đọc, CLI `risk report --json`). */
export function buildRiskReportJson(input: RiskReportInput): Record<string, unknown> {
  return {
    botId: input.botId,
    conversationId: input.conversationId,
    generatedAtMs: Date.now(),
    summary: summarizeRiskReport(input),
    decisions: input.audit.map((e) => ({
      confirmationId: e.confirmationId,
      callId: e.callId,
      toolName: e.toolName,
      riskLevel: e.riskLevel,
      riskScore: e.riskScore,
      policy: e.policy,
      status: e.status,
      decidedBy: e.decidedBy,
      atMs: e.atMs,
      ...(e.editedArgs !== undefined ? { editedArgs: e.editedArgs } : {}),
    })),
    budget: input.budget,
    assessments: (input.assessments ?? []).map((a) => ({
      toolName: a.toolName,
      level: a.level,
      score: a.score,
      reasons: a.reasons,
      matchedRuleIds: a.matchedRuleIds,
      denied: a.denied,
      assessedAtMs: a.assessedAtMs,
    })),
  };
}
