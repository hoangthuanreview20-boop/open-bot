/**
 * ConversationBudgetHistory (v1.01, Đội T3) — lịch sử budget theo
 * conversation, lưu bền trong file JSON.
 *
 * `ConversationBudgetMeter` chỉ sống trong một run (reset mỗi
 * conversation mới). Store này giữ lại snapshot CUỐI của từng
 * conversation đã kết thúc để user xem lại ("hôm qua bot này tốn bao
 * nhiêu"), cộng dồn theo bot, và cắt ngắn theo giới hạn.
 *
 * File mặc định: `<dataDir>/budget-history.json` (coordinator truyền
 * dataDir). Shape: { version: 1, entries: BudgetHistoryEntry[] }.
 * Entry: conversationId, botId, model, token/cost, status lúc kết thúc,
 * endedAtMs. Ghi append + atomic rewrite (giống usage.ts / store.ts).
 * File hỏng → bắt đầu rỗng, không crash app.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BudgetSnapshot, BudgetStatus } from './types';

export const BUDGET_HISTORY_FILE_NAME = 'budget-history.json';
export const BUDGET_HISTORY_FILE_VERSION = 1;

/** Tối đa entry giữ lại (FIFO — conversation cũ nhất bị xoá trước). */
export const MAX_BUDGET_HISTORY_ENTRIES = 500;

export interface BudgetHistoryEntry {
  conversationId: string;
  botId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** null = có model chưa có giá trong conversation đó. */
  costUsd: number | null;
  hasUnknownCost: boolean;
  status: BudgetStatus;
  endedAtMs: number;
}

export interface BudgetHistoryTotals {
  botId: string;
  conversations: number;
  totalTokens: number;
  /** null = có ít nhất một conversation chứa model chưa có giá. */
  totalCostUsd: number | null;
  hasUnknownCost: boolean;
  exceededCount: number;
  warningCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validEntry(value: unknown): BudgetHistoryEntry | undefined {
  if (!isRecord(value)) return undefined;
  const conversationId = typeof value.conversationId === 'string' ? value.conversationId : '';
  const botId = typeof value.botId === 'string' ? value.botId : '';
  const inputTokens = typeof value.inputTokens === 'number' ? value.inputTokens : NaN;
  const outputTokens = typeof value.outputTokens === 'number' ? value.outputTokens : NaN;
  const totalTokens = typeof value.totalTokens === 'number' ? value.totalTokens : NaN;
  const endedAtMs = typeof value.endedAtMs === 'number' ? value.endedAtMs : NaN;
  const status = value.status;
  if (
    !conversationId ||
    !botId ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(totalTokens) ||
    !Number.isFinite(endedAtMs) ||
    (status !== 'ok' && status !== 'warning' && status !== 'exceeded')
  ) {
    return undefined;
  }
  const costUsd =
    value.costUsd === null || typeof value.costUsd === 'number' ? value.costUsd : undefined;
  if (costUsd === undefined) return undefined;
  return {
    conversationId,
    botId,
    model: typeof value.model === 'string' ? value.model : null,
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    totalTokens: Math.floor(totalTokens),
    costUsd,
    hasUnknownCost: value.hasUnknownCost === true,
    status,
    endedAtMs: Math.floor(endedAtMs),
  };
}

export class ConversationBudgetHistory {
  private readonly filePath: string | undefined;
  private readonly onInvalid?: (reason: string) => void;
  private entries: BudgetHistoryEntry[] = [];

  constructor(dataDir?: string, options: { onInvalid?: (reason: string) => void } = {}) {
    this.filePath = dataDir ? path.join(dataDir, BUDGET_HISTORY_FILE_NAME) : undefined;
    this.onInvalid = options.onInvalid;
    this.load();
  }

  /** Đường dẫn file (undefined = chỉ giữ trong bộ nhớ). */
  get path(): string | undefined {
    return this.filePath;
  }

  /** Số conversation đã ghi. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Ghi snapshot cuối của một conversation (gọi khi run kết thúc).
   * Trùng conversationId → ghi đè entry cũ (run resume ghi lại).
   */
  record(botId: string, snapshot: BudgetSnapshot): BudgetHistoryEntry {
    const entry: BudgetHistoryEntry = {
      conversationId: snapshot.conversationId,
      botId,
      model: snapshot.model,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      totalTokens: snapshot.totalTokens,
      costUsd: snapshot.costUsd,
      hasUnknownCost: snapshot.hasUnknownCost,
      status: snapshot.status,
      endedAtMs: Date.now(),
    };
    const idx = this.entries.findIndex((e) => e.conversationId === entry.conversationId);
    if (idx === -1) this.entries.push(entry);
    else this.entries[idx] = entry;
    while (this.entries.length > MAX_BUDGET_HISTORY_ENTRIES) this.entries.shift();
    this.save();
    return { ...entry };
  }

  /** Tất cả entry (cũ nhất trước). */
  listAll(): BudgetHistoryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Entry của một bot (cũ nhất trước). */
  listForBot(botId: string): BudgetHistoryEntry[] {
    return this.entries.filter((e) => e.botId === botId).map((e) => ({ ...e }));
  }

  /** Entry của một conversation (undefined khi chưa ghi). */
  get(conversationId: string): BudgetHistoryEntry | undefined {
    const found = this.entries.find((e) => e.conversationId === conversationId);
    return found ? { ...found } : undefined;
  }

  /** Cộng dồn theo bot (để UI hiện "bot này đã tốn bao nhiêu"). */
  totalsForBot(botId: string): BudgetHistoryTotals {
    const rows = this.listForBot(botId);
    let totalTokens = 0;
    let totalCostUsd: number | null = 0;
    let hasUnknownCost = false;
    let exceededCount = 0;
    let warningCount = 0;
    for (const row of rows) {
      totalTokens += row.totalTokens;
      if (row.hasUnknownCost) hasUnknownCost = true;
      if (totalCostUsd !== null) totalCostUsd += row.costUsd ?? 0;
      if (row.status === 'exceeded') exceededCount += 1;
      if (row.status === 'warning') warningCount += 1;
    }
    return {
      botId,
      conversations: rows.length,
      totalTokens,
      // Không có conversation nào → không có chi phí (null), không fake $0.
      totalCostUsd: rows.length === 0 || hasUnknownCost ? null : totalCostUsd,
      hasUnknownCost,
      exceededCount,
      warningCount,
    };
  }

  /** Cộng dồn toàn bộ (mọi bot). */
  totalsAll(): Omit<BudgetHistoryTotals, 'botId'> & { bots: number } {
    const bots = new Set(this.entries.map((e) => e.botId)).size;
    let totalTokens = 0;
    let totalCostUsd: number | null = 0;
    let hasUnknownCost = false;
    let exceededCount = 0;
    let warningCount = 0;
    for (const row of this.entries) {
      totalTokens += row.totalTokens;
      if (row.hasUnknownCost) hasUnknownCost = true;
      if (totalCostUsd !== null) totalCostUsd += row.costUsd ?? 0;
      if (row.status === 'exceeded') exceededCount += 1;
      if (row.status === 'warning') warningCount += 1;
    }
    return {
      bots,
      conversations: this.entries.length,
      totalTokens,
      // Không có conversation nào → không có chi phí (null), không fake $0.
      totalCostUsd: this.entries.length === 0 || hasUnknownCost ? null : totalCostUsd,
      hasUnknownCost,
      exceededCount,
      warningCount,
    };
  }

  /** Xoá toàn bộ lịch sử (vd user muốn reset số liệu). */
  clear(): void {
    this.entries = [];
    this.save();
  }

  private load(): void {
    this.entries = [];
    if (!this.filePath) return; // Không có dataDir → chỉ giữ trong bộ nhớ.
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.onInvalid?.(`File ${BUDGET_HISTORY_FILE_NAME} hỏng JSON — dùng lịch sử rỗng.`);
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      this.onInvalid?.(`File ${BUDGET_HISTORY_FILE_NAME} sai shape — dùng lịch sử rỗng.`);
      return;
    }
    for (const item of parsed.entries) {
      const entry = validEntry(item);
      if (entry) this.entries.push(entry);
    }
    this.entries = this.entries.slice(-MAX_BUDGET_HISTORY_ENTRIES);
  }

  private save(): void {
    if (!this.filePath) return; // Chỉ giữ trong bộ nhớ, không ghi đĩa.
    const payload = { version: BUDGET_HISTORY_FILE_VERSION, entries: this.entries };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Hệ không hỗ trợ chmod thì bỏ qua — file đã ghi xong.
    }
  }
}
