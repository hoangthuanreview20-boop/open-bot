/**
 * ConversationBudgetMeter (v1.01, Đội T3) — theo dõi token + chi phí
 * ước tính của MỘT conversation.
 *
 * Khác `usage/UsageTracker` (đếm toàn cục theo ngày/tháng/bot, chặn
 * cứng khi vượt cap): meter này sống theo conversation — reset mỗi
 * conversation mới — và chỉ CẢNH BÁO (không chặn model gọi tiếp).
 * Chặn cứng thuộc về SpendLimits; meter là đồng hồ để người dùng
 * thấy mình đang tốn bao nhiêu, trước khi hoá đơn ngày/tháng phình.
 *
 * Chi phí dùng bảng giá `usage/pricing.ts` (`estimateCost`). Model
 * chưa có giá → cost của model đó là null và `hasUnknownCost = true`;
 * tổng cost cũng null (không bao giờ báo $0 giả cho model không rõ
 * giá). Model local (Ollama) có giá 0 trong bảng → cost 0 thật.
 *
 * Ngưỡng: `warnAtRatio` (mặc định 0.8) → status `warning`, bắn alert
 * một lần; vượt cap (token hoặc cost) → status `exceeded`, bắn alert
 * một lần. Alert qua callback `onAlert` (host tự chọn cách hiển thị:
 * emit event về renderer, log, …). Không có cap nào → không bao giờ
 * warning/exceeded, chỉ đếm.
 */

import { estimateCost } from '../usage/pricing';
import type { BudgetAlert, BudgetConfig, BudgetSnapshot, BudgetStatus } from './types';

export const DEFAULT_BUDGET_WARN_RATIO = 0.8;

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  hasUnknownCost: boolean;
}

export class ConversationBudgetMeter {
  private readonly conversationId: string;
  private readonly tokenLimit: number | null;
  private readonly costLimitUsd: number | null;
  private readonly warnAtRatio: number;
  private readonly defaultModel: string | null;
  private readonly onAlert?: (alert: BudgetAlert) => void;

  private readonly byModel = new Map<string, ModelUsage>();
  private inputTokens = 0;
  private outputTokens = 0;
  private lastRecordedAtMs: number | null = null;
  private lastModel: string | null = null;
  private warned = false;
  private exceeded = false;

  constructor(conversationId: string, config: BudgetConfig = {}, onAlert?: (alert: BudgetAlert) => void) {
    this.conversationId = conversationId;
    this.tokenLimit = config.tokenLimit !== undefined && config.tokenLimit > 0 ? config.tokenLimit : null;
    this.costLimitUsd = config.costLimitUsd !== undefined && config.costLimitUsd > 0 ? config.costLimitUsd : null;
    const ratio = config.warnAtRatio ?? DEFAULT_BUDGET_WARN_RATIO;
    this.warnAtRatio = Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_BUDGET_WARN_RATIO;
    this.defaultModel = config.model ?? null;
    this.onAlert = onAlert;
  }

  get id(): string {
    return this.conversationId;
  }

  /** Tỉ lệ cảnh báo (0–1) — loop dùng để xác định cap nào bị chạm. */
  get warnRatio(): number {
    return this.warnAtRatio;
  }

  /** Ghi một lần gọi model (input/output token). Token âm → bỏ qua. */
  record(model: string, inputTokens: number, outputTokens: number): BudgetSnapshot {
    const inT = Math.max(0, Math.floor(inputTokens) || 0);
    const outT = Math.max(0, Math.floor(outputTokens) || 0);
    const cost = estimateCost(model, inT, outT);
    let usage = this.byModel.get(model);
    if (!usage) {
      usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, hasUnknownCost: false };
      this.byModel.set(model, usage);
    }
    usage.inputTokens += inT;
    usage.outputTokens += outT;
    if (cost === null) {
      usage.hasUnknownCost = true;
    } else {
      usage.costUsd = (usage.costUsd ?? 0) + cost;
    }
    this.inputTokens += inT;
    this.outputTokens += outT;
    this.lastRecordedAtMs = Date.now();
    this.lastModel = model;
    const snapshot = this.snapshot();
    this.maybeAlert(snapshot);
    return snapshot;
  }

  /** Tổng token đã dùng trong conversation. */
  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  /** Snapshot hiện tại (UI hiển thị trực tiếp). */
  snapshot(): BudgetSnapshot {
    const totalTokens = this.totalTokens;
    let costUsd: number | null = 0;
    let hasUnknownCost = false;
    const byModel: BudgetSnapshot['byModel'] = {};
    for (const [model, usage] of this.byModel) {
      byModel[model] = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        // Model chưa có giá → cost null (không báo $0 giả cho model đó).
        costUsd: usage.hasUnknownCost ? null : usage.costUsd,
      };
      if (usage.hasUnknownCost) hasUnknownCost = true;
      if (costUsd !== null) {
        costUsd += usage.costUsd ?? 0;
      }
    }
    if (hasUnknownCost) costUsd = null;

    const tokenPercentUsed =
      this.tokenLimit !== null ? (totalTokens / this.tokenLimit) * 100 : null;
    const costPercentUsed =
      this.costLimitUsd !== null && costUsd !== null
        ? (costUsd / this.costLimitUsd) * 100
        : null;
    const percentUsed =
      tokenPercentUsed !== null || costPercentUsed !== null
        ? Math.max(tokenPercentUsed ?? 0, costPercentUsed ?? 0)
        : null;

    let status: BudgetStatus = 'ok';
    if (
      (this.tokenLimit !== null && totalTokens >= this.tokenLimit) ||
      (this.costLimitUsd !== null && costUsd !== null && costUsd >= this.costLimitUsd)
    ) {
      status = 'exceeded';
    } else if (
      percentUsed !== null && percentUsed >= this.warnAtRatio * 100
    ) {
      status = 'warning';
    }

    return {
      conversationId: this.conversationId,
      model: this.lastModel ?? this.defaultModel,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens,
      costUsd,
      hasUnknownCost,
      tokenLimit: this.tokenLimit,
      costLimitUsd: this.costLimitUsd,
      tokenPercentUsed,
      costPercentUsed,
      percentUsed,
      status,
      modelCount: this.byModel.size,
      byModel,
      lastRecordedAtMs: this.lastRecordedAtMs,
    };
  }

  /** Reset cho conversation mới (giữ nguyên config, alert state reset). */
  reset(): void {
    this.byModel.clear();
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.lastRecordedAtMs = null;
    this.lastModel = null;
    this.warned = false;
    this.exceeded = false;
  }

  private maybeAlert(snapshot: BudgetSnapshot): void {
    if (!this.onAlert) return;
    if (snapshot.status === 'exceeded' && !this.exceeded) {
      this.exceeded = true;
      this.warned = true;
      this.emitAlert('exceeded', snapshot);
      return;
    }
    if (snapshot.status === 'warning' && !this.warned) {
      this.warned = true;
      this.emitAlert('warning', snapshot);
    }
  }

  private emitAlert(kind: 'warning' | 'exceeded', snapshot: BudgetSnapshot): void {
    const tokenHit =
      this.tokenLimit !== null && snapshot.totalTokens >= (kind === 'exceeded' ? this.tokenLimit : this.tokenLimit * this.warnAtRatio);
    const costHit =
      this.costLimitUsd !== null &&
      snapshot.costUsd !== null &&
      snapshot.costUsd >= (kind === 'exceeded' ? this.costLimitUsd : this.costLimitUsd * this.warnAtRatio);
    const basis = tokenHit && costHit ? 'both' : tokenHit ? 'tokens' : 'cost';
    try {
      this.onAlert?.({
        conversationId: this.conversationId,
        kind,
        basis,
        snapshot,
        atMs: Date.now(),
      });
    } catch {
      // Alert không được phá turn.
    }
  }
}
