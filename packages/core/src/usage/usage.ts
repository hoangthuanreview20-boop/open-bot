/**
 * Usage tracking + spend limits (v0.4).
 *
 * STORAGE CHOICE — plain JSON file, not SQLite. `BotMemory`
 * (packages/core/src/agent/memory.ts) uses SQLite because chat history
 * is many rows queried by bot/time. Usage data is the opposite shape:
 * a small append-mostly log plus one limits object, read whole on
 * every call — exactly the pattern `team.json` and the marketplace
 * `agents.json` already use in this codebase. One file
 * (`<userData>/usage.json`, path supplied by the caller) keeps the
 * host's data dir uniform and avoids a second database to back up.
 * Writes are atomic (temp file + rename), mode 0600.
 *
 * WHAT IS COUNTED — every provider call that reports
 * `ProviderResponse.usage` (input/output tokens). Cost is estimated
 * from the built-in price table in pricing.ts; a model with no price
 * still counts its tokens, but its cost is `null` (unknown — never
 * silently $0). Calls through the Ollama provider are free by
 * construction (local model), so they record cost 0.
 *
 * LIMITS — daily / monthly / total caps, global and per bot. The
 * `MeteredProvider` wrapper checks limits BEFORE calling the inner
 * provider and throws `SpendLimitError` when a cap is already
 * exceeded. It cannot know the cost of the call it is about to make,
 * so a single call may push spend slightly past a cap; the NEXT call
 * is then blocked. Day/month windows use the machine's LOCAL date.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatCompletionRequest, Provider, ProviderResponse } from '../types';
import { estimateCost } from './pricing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageRecord {
  id: string;
  botId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost. null = model has no known price (tokens still counted). */
  costUsd: number | null;
  /** ISO timestamp of the call. */
  at: string;
}

export interface SpendLimits {
  /** Max estimated USD spend per local calendar day (all bots). */
  dailyUsd?: number;
  /** Max estimated USD spend per local calendar month (all bots). */
  monthlyUsd?: number;
  /** Max estimated USD spend ever (all bots, all time). */
  totalUsd?: number;
  /** Per-bot caps; same three scopes, checked only for that bot. */
  perBot?: Record<string, { dailyUsd?: number; monthlyUsd?: number; totalUsd?: number }>;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  /** Sum of known costs, or null when ANY record in scope is unpriced. */
  costUsd: number | null;
  /** Number of provider calls in scope. */
  calls: number;
  /** Calls whose cost is unknown (unpriced model). */
  unpricedCalls: number;
}

/** One window of the spend banner: totals + limit + usage percentage. */
export interface SpendWindow extends UsageSummary {
  /** The cap for this window, when one is set. */
  limitUsd?: number;
  /** costUsd / limitUsd * 100, or null when no limit or cost is unknown. */
  percentUsed: number | null;
}

export interface SpendStatus {
  today: SpendWindow;
  month: SpendWindow;
  total: SpendWindow;
}

export type LimitScope = 'daily' | 'monthly' | 'total' | 'bot-daily' | 'bot-monthly' | 'bot-total';

export interface LimitViolation {
  scope: LimitScope;
  spentUsd: number;
  limitUsd: number;
  botId?: string;
}

/**
 * Thrown by MeteredProvider (and `assertWithinLimits`) when a spend
 * cap is already exceeded. Message is English and always carries the
 * spent amount and the limit, so the UI can show it verbatim.
 */
export class SpendLimitError extends Error {
  readonly scope: LimitScope;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly botId?: string;

  constructor(violation: LimitViolation) {
    const scopeLabel =
      violation.scope === 'daily'
        ? 'daily'
        : violation.scope === 'monthly'
          ? 'monthly'
          : violation.scope === 'total'
            ? 'total'
            : violation.scope === 'bot-daily'
              ? `daily for bot ${violation.botId ?? ''}`.trim()
              : violation.scope === 'bot-monthly'
                ? `monthly for bot ${violation.botId ?? ''}`.trim()
                : `total for bot ${violation.botId ?? ''}`.trim();
    super(
      `Spend limit exceeded (${scopeLabel}): spent $${violation.spentUsd.toFixed(2)} ` +
        `of $${violation.limitUsd.toFixed(2)} limit. ` +
        `Raise the limit in Settings or wait for the limit to reset.`,
    );
    this.name = 'SpendLimitError';
    this.scope = violation.scope;
    this.spentUsd = violation.spentUsd;
    this.limitUsd = violation.limitUsd;
    this.botId = violation.botId;
  }
}

export interface UsageTrackerOptions {
  /** Path of the JSON store file, e.g. `<userData>/usage.json`. */
  storePath: string;
  /** Clock override (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
}

interface UsageStoreFile {
  version: 1;
  limits: SpendLimits;
  records: UsageRecord[];
}

// ---------------------------------------------------------------------------
// Date helpers (LOCAL calendar)
// ---------------------------------------------------------------------------

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localMonth(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// UsageTracker
// ---------------------------------------------------------------------------

export class UsageTracker {
  private readonly storePath: string;
  private readonly now: () => Date;
  private limits: SpendLimits;
  private records: UsageRecord[];

  constructor(options: UsageTrackerOptions) {
    if (!options.storePath) throw new Error('UsageTracker needs a storePath.');
    this.storePath = options.storePath;
    this.now = options.now ?? (() => new Date());
    const loaded = this.loadStore();
    this.limits = loaded.limits;
    this.records = loaded.records;
  }

  /** Path of the JSON store file. */
  get path(): string {
    return this.storePath;
  }

  // --- Recording ------------------------------------------------------------

  /**
   * Record one provider call. `usage` is `ProviderResponse.usage`.
   * Returns the stored record. Cost is estimated from pricing.ts;
   * Ollama (local) calls cost 0; unpriced models get costUsd null.
   */
  record(
    botId: string,
    providerId: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number },
  ): UsageRecord {
    if (!botId || !providerId || !model) {
      throw new Error('UsageTracker.record needs botId, providerId and model.');
    }
    if (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0) {
      throw new Error('UsageTracker.record needs a non-negative integer inputTokens.');
    }
    if (!Number.isInteger(usage.outputTokens) || usage.outputTokens < 0) {
      throw new Error('UsageTracker.record needs a non-negative integer outputTokens.');
    }
    const costUsd =
      providerId === 'ollama' ? 0 : estimateCost(model, usage.inputTokens, usage.outputTokens);
    const record: UsageRecord = {
      id: randomUUID(),
      botId,
      providerId,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      at: this.now().toISOString(),
    };
    this.records.push(record);
    this.saveStore();
    return record;
  }

  /**
   * Record a whole `ProviderResponse` (no-op when it carries no usage).
   * Convenience for the MeteredProvider / agent loop.
   */
  recordResponse(
    botId: string,
    providerId: string,
    model: string,
    response: Pick<ProviderResponse, 'usage'>,
  ): UsageRecord | null {
    if (!response.usage) return null;
    return this.record(botId, providerId, model, response.usage);
  }

  // --- Summaries --------------------------------------------------------------

  /**
   * Totals for a window. `range` is relative to the local calendar:
   * 'today' = current local day, 'month' = current local month,
   * 'all' = everything. `botId` narrows to one bot.
   * costUsd is null when any record in scope is unpriced (the number
   * would otherwise understate the real spend).
   */
  getSummary(range: 'today' | 'month' | 'all', botId?: string): UsageSummary {
    const now = this.now();
    const day = localDay(now);
    const month = localMonth(now);
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let calls = 0;
    let unpricedCalls = 0;
    for (const r of this.records) {
      if (botId !== undefined && r.botId !== botId) continue;
      if (range === 'today' && localDay(new Date(r.at)) !== day) continue;
      if (range === 'month' && localMonth(new Date(r.at)) !== month) continue;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      calls += 1;
      if (r.costUsd === null) unpricedCalls += 1;
      else cost += r.costUsd;
    }
    return {
      inputTokens,
      outputTokens,
      costUsd: unpricedCalls > 0 ? null : cost,
      calls,
      unpricedCalls,
    };
  }

  /**
   * Spend banner data: today / this month / all-time, each with its
   * limit and percentage used. `botId` narrows to one bot AND applies
   * that bot's per-bot limits (falling back to the global limit when
   * the bot has no cap of its own for a scope).
   */
  getSpendStatus(botId?: string): SpendStatus {
    const today = this.getSummary('today', botId);
    const month = this.getSummary('month', botId);
    const total = this.getSummary('all', botId);
    const perBot = botId !== undefined ? this.limits.perBot?.[botId] : undefined;
    const window = (summary: UsageSummary, limitUsd: number | undefined): SpendWindow => ({
      ...summary,
      limitUsd,
      percentUsed:
        limitUsd !== undefined && summary.costUsd !== null && limitUsd > 0
          ? (summary.costUsd / limitUsd) * 100
          : null,
    });
    return {
      today: window(today, perBot?.dailyUsd ?? this.limits.dailyUsd),
      month: window(month, perBot?.monthlyUsd ?? this.limits.monthlyUsd),
      total: window(total, perBot?.totalUsd ?? this.limits.totalUsd),
    };
  }

  // --- Limits -----------------------------------------------------------------

  getLimits(): SpendLimits {
    return JSON.parse(JSON.stringify(this.limits)) as SpendLimits;
  }

  /**
   * Replace the limits wholesale. Values must be positive finite
   * numbers when present. Pass `{}` to clear all limits.
   */
  setLimits(limits: SpendLimits): void {
    const check = (value: number | undefined, what: string): void => {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`Spend limit ${what} must be a positive number (got ${value}).`);
      }
    };
    check(limits.dailyUsd, 'dailyUsd');
    check(limits.monthlyUsd, 'monthlyUsd');
    check(limits.totalUsd, 'totalUsd');
    for (const [botId, caps] of Object.entries(limits.perBot ?? {})) {
      check(caps.dailyUsd, `perBot.${botId}.dailyUsd`);
      check(caps.monthlyUsd, `perBot.${botId}.monthlyUsd`);
      check(caps.totalUsd, `perBot.${botId}.totalUsd`);
    }
    this.limits = JSON.parse(JSON.stringify(limits)) as SpendLimits;
    this.saveStore();
  }

  /**
   * Every cap that is currently exceeded, global first then per-bot.
   * A window whose cost is unknown (unpriced records) can never be
   * reported as exceeded — the known cost is a lower bound, so the
   * check is conservative in the user's favour. `botId` narrows the
   * per-bot checks to that bot (global checks always run).
   */
  checkLimits(botId?: string): LimitViolation[] {
    const violations: LimitViolation[] = [];
    const check = (
      scope: LimitScope,
      summary: UsageSummary,
      limitUsd: number | undefined,
      forBot?: string,
    ): void => {
      if (limitUsd === undefined) return;
      if (summary.costUsd === null) return;
      if (summary.costUsd > limitUsd) {
        violations.push({ scope, spentUsd: summary.costUsd, limitUsd, botId: forBot });
      }
    };
    const global = this.getSpendStatus();
    check('daily', global.today, this.limits.dailyUsd);
    check('monthly', global.month, this.limits.monthlyUsd);
    check('total', global.total, this.limits.totalUsd);
    if (botId !== undefined) {
      const caps = this.limits.perBot?.[botId];
      if (caps) {
        const perBot = this.getSpendStatus(botId);
        check('bot-daily', perBot.today, caps.dailyUsd, botId);
        check('bot-monthly', perBot.month, caps.monthlyUsd, botId);
        check('bot-total', perBot.total, caps.totalUsd, botId);
      }
    }
    return violations;
  }

  /** Throws SpendLimitError on the first exceeded cap (if any). */
  assertWithinLimits(botId?: string): void {
    const violations = this.checkLimits(botId);
    if (violations.length > 0) throw new SpendLimitError(violations[0]);
  }

  // --- Reload -------------------------------------------------------------------

  /**
   * Re-read limits + records from disk, discarding in-memory state.
   * Needed because the usage file has TWO writers: the coordinator
   * child (records every call) and the main process (sets limits /
   * resets on user action). `MeteredProvider.chat()` calls this
   * before every limit check so a limit changed in Settings applies
   * to the very next call. Last-writer-wins: a record written by the
   * coordinator in the same instant main saves limits could be lost;
   * in practice main only writes on explicit user action, so the
   * window is negligible for a local single-user app.
   */
  reload(): void {
    const loaded = this.loadStore();
    this.limits = loaded.limits;
    this.records = loaded.records;
  }

  // --- Reset ------------------------------------------------------------------

  /**
   * Delete records: 'day' = today's local-day records, 'month' = this
   * local month's records, 'all' = everything (limits are kept).
   * Returns how many records were removed. This is a manual,
   * user-initiated action (Settings -> "Reset usage") — the tracker
   * itself never deletes history on its own; day/month windows are
   * computed from timestamps, so a new day/month starts clean
   * automatically without losing history.
   */
  reset(scope: 'day' | 'month' | 'all'): number {
    const now = this.now();
    const day = localDay(now);
    const month = localMonth(now);
    const before = this.records.length;
    if (scope === 'all') {
      this.records = [];
    } else if (scope === 'day') {
      this.records = this.records.filter((r) => localDay(new Date(r.at)) !== day);
    } else {
      this.records = this.records.filter((r) => localMonth(new Date(r.at)) !== month);
    }
    const removed = before - this.records.length;
    if (removed > 0) this.saveStore();
    return removed;
  }

  // --- Persistence --------------------------------------------------------------

  private loadStore(): UsageStoreFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.storePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, limits: {}, records: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Usage store is not valid JSON: ${this.storePath}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as UsageStoreFile).version !== 1 ||
      !Array.isArray((parsed as UsageStoreFile).records)
    ) {
      throw new Error(`Usage store has an unsupported shape: ${this.storePath}`);
    }
    const store = parsed as UsageStoreFile;
    return {
      version: 1,
      limits: typeof store.limits === 'object' && store.limits !== null ? store.limits : {},
      records: store.records,
    };
  }

  private saveStore(): void {
    const file: UsageStoreFile = { version: 1, limits: this.limits, records: this.records };
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.storePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.storePath);
  }
}

// ---------------------------------------------------------------------------
// MeteredProvider — limit-checking wrapper around any Provider
// ---------------------------------------------------------------------------

export interface MeteredProviderOptions {
  /** Bot the calls belong to (per-bot limits + per-bot usage). */
  botId?: string;
}

/**
 * Wraps any Provider: checks spend limits BEFORE each chat() call and
 * throws SpendLimitError when a cap is already exceeded, then records
 * the call's token usage afterwards. `listModels()` is passed through
 * untouched (it costs nothing). The inner provider is never called
 * when a limit is exceeded.
 */
export class MeteredProvider implements Provider {
  readonly id: string;
  readonly label: string;
  private readonly inner: Provider;
  private readonly tracker: UsageTracker;
  private readonly botId: string;

  /**
   * v0.94c: forward vision capability — chỉ khi provider gốc có method
   * này (gán có điều kiện trong constructor). Không có nó, loop tưởng
   * provider bọc MeteredProvider không xem được ảnh (dù provider gốc
   * có) và từ chối lượt có ảnh. Gán vô điều kiện sẽ sai ngược: provider
   * gốc không có method thì fallback theo id trong
   * `providerSupportsVision` (vd openai/xai → true) phải được chạy,
   * nên field này vắng mặt khi inner không có method.
   */
  supportsVision?: (model: string) => boolean;

  constructor(inner: Provider, tracker: UsageTracker, options: MeteredProviderOptions = {}) {
    this.inner = inner;
    this.tracker = tracker;
    this.botId = options.botId ?? 'default';
    this.id = inner.id;
    this.label = inner.label;
    if (typeof inner.supportsVision === 'function') {
      const fn = inner.supportsVision.bind(inner);
      this.supportsVision = (model: string) => fn(model) === true;
    }
  }

  get wrapped(): Provider {
    return this.inner;
  }

  get usageTracker(): UsageTracker {
    return this.tracker;
  }

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    // Pick up limits / records written by the main process (Settings)
    // since this tracker was created — see UsageTracker.reload().
    this.tracker.reload();
    this.tracker.assertWithinLimits(this.botId);
    const res = await this.inner.chat(req);
    this.tracker.recordResponse(this.botId, this.inner.id, req.model, res);
    return res;
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }
}
