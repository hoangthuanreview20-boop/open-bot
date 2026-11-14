/**
 * Per-bot resource quotas (fleet v2).
 *
 * The v1 fleet layer allocates CPU/RAM/disk per *workspace* at creation
 * time. Quotas are the runtime guard on top of that allocation: one
 * quota per bot (workspace id), with a warning threshold (default 80%
 * of the limit). A quota is evaluated against *measured* usage only —
 * never against the allocation itself — so a warning always means the
 * bot really is using that much.
 *
 * Usage inputs:
 * - RAM: latest RSS from the usage ledger (`rssBytesLatest`).
 * - Disk: latest measured workspace size (`diskBytesLatest`).
 * - CPU: the usage ledger stores *cumulative* CPU seconds, so a quota
 *   needs a rate. `cpuRateFromSamples` derives cores-used from the
 *   delta between the last two samples (delta CPU seconds / delta wall
 *   seconds). With fewer than two usable samples the CPU level is
 *   'unknown' — reported honestly instead of guessed.
 *
 * Quotas live in `<fleetRoot>/fleet-quotas.json` (atomic write, mode
 * 0600, same posture as the workspace registry and console users).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetUsageSample } from './types';

/** One bot's resource quota (bot id = fleet workspace id). */
export interface BotQuota {
  /** Workspace id the quota applies to. */
  botId: string;
  /** Max CPU cores the bot may use (rate, e.g. 0.5 = half a core). */
  cpuCoresMax: number;
  /** Max RAM in bytes. */
  ramBytesMax: number;
  /** Max disk in bytes. */
  diskBytesMax: number;
  /** Warn at this fraction of the limit (0 < warnPercent < 1). */
  warnPercent: number;
  /** Disabled quotas are stored but never evaluated. */
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export const FLEET_QUOTAS_FILE = 'fleet-quotas.json';
/** Warn at 80% of the limit unless the admin picks another threshold. */
export const QUOTA_DEFAULT_WARN_PERCENT = 0.8;
/** Keep at most this many alerts per evaluation (newest first). */
export const QUOTA_MAX_ALERTS = 100;

export function getFleetQuotasPath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('bot quotas need a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_QUOTAS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Validate one stored quota (throws on any bad field). */
export function validateBotQuota(raw: unknown): BotQuota {
  if (!isRecord(raw)) throw new Error('bot quota must be an object.');
  const { botId, cpuCoresMax, ramBytesMax, diskBytesMax, warnPercent, enabled, updatedAt, updatedBy } = raw;
  if (typeof botId !== 'string' || botId.trim().length === 0) {
    throw new Error('bot quota needs a non-empty botId.');
  }
  if (!isPositiveFinite(cpuCoresMax)) throw new Error('bot quota cpuCoresMax must be a number > 0.');
  if (!isPositiveFinite(ramBytesMax)) throw new Error('bot quota ramBytesMax must be a number > 0.');
  if (!isPositiveFinite(diskBytesMax)) throw new Error('bot quota diskBytesMax must be a number > 0.');
  if (
    typeof warnPercent !== 'number' ||
    !Number.isFinite(warnPercent) ||
    warnPercent <= 0 ||
    warnPercent >= 1
  ) {
    throw new Error('bot quota warnPercent must be a number between 0 and 1 (exclusive).');
  }
  if (typeof enabled !== 'boolean') throw new Error('bot quota enabled must be a boolean.');
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) {
    throw new Error('bot quota needs a non-empty updatedAt.');
  }
  if (typeof updatedBy !== 'string' || updatedBy.trim().length === 0) {
    throw new Error('bot quota needs a non-empty updatedBy.');
  }
  return {
    botId: botId.trim(),
    cpuCoresMax: cpuCoresMax as number,
    ramBytesMax: ramBytesMax as number,
    diskBytesMax: diskBytesMax as number,
    warnPercent: warnPercent as number,
    enabled,
    updatedAt: updatedAt as string,
    updatedBy: updatedBy as string,
  };
}

/** Load all quotas (missing file = no quotas yet). */
export function loadBotQuotas(rootDir: string): BotQuota[] {
  const filePath = getFleetQuotasPath(rootDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${FLEET_QUOTAS_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_QUOTAS_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateBotQuota(entry);
    } catch (err) {
      throw new Error(`${FLEET_QUOTAS_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Save all quotas (atomic tmp + rename, mode 0600). */
export function saveBotQuotas(rootDir: string, quotas: BotQuota[]): void {
  const valid = quotas.map((q) => validateBotQuota(q));
  const filePath = getFleetQuotasPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

export interface SetBotQuotaInput {
  botId: string;
  cpuCoresMax: number;
  ramBytesMax: number;
  diskBytesMax: number;
  warnPercent?: number;
  enabled?: boolean;
}

/** Create or replace a bot's quota. Returns the stored quota. */
export function setBotQuota(rootDir: string, input: SetBotQuotaInput, updatedBy: string): BotQuota {
  if (typeof updatedBy !== 'string' || updatedBy.trim().length === 0) {
    throw new Error('setBotQuota needs a non-empty updatedBy.');
  }
  const quota: BotQuota = {
    botId: '',
    cpuCoresMax: 0,
    ramBytesMax: 0,
    diskBytesMax: 0,
    warnPercent: QUOTA_DEFAULT_WARN_PERCENT,
    enabled: true,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy.trim(),
  };
  // validateBotQuota enforces every field, so build through it.
  const validated = validateBotQuota({
    ...quota,
    botId: input.botId,
    cpuCoresMax: input.cpuCoresMax,
    ramBytesMax: input.ramBytesMax,
    diskBytesMax: input.diskBytesMax,
    ...(input.warnPercent !== undefined ? { warnPercent: input.warnPercent } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
  const quotas = loadBotQuotas(rootDir);
  const next = quotas.some((q) => q.botId === validated.botId)
    ? quotas.map((q) => (q.botId === validated.botId ? validated : q))
    : [...quotas, validated];
  saveBotQuotas(rootDir, next);
  return validated;
}

/** One bot's quota, or undefined when none is set. */
export function getBotQuota(rootDir: string, botId: string): BotQuota | undefined {
  return loadBotQuotas(rootDir).find((q) => q.botId === botId);
}

/** Remove a bot's quota. Returns true when a quota was removed. */
export function removeBotQuota(rootDir: string, botId: string): boolean {
  const quotas = loadBotQuotas(rootDir);
  const next = quotas.filter((q) => q.botId !== botId);
  if (next.length === quotas.length) return false;
  saveBotQuotas(rootDir, next);
  return true;
}

/** Quota level for one resource. 'unknown' = never measured, not zero. */
export type QuotaLevel = 'ok' | 'warning' | 'breach' | 'unknown';

export type QuotaResource = 'cpu' | 'ram' | 'disk';

export interface QuotaResourceStatus {
  resource: QuotaResource;
  /** Actually used (cores for cpu, bytes for ram/disk) — null when unmeasured. */
  used: number | null;
  limit: number;
  /** Used / limit as a 0..1+ fraction — null when unmeasured. */
  percent: number | null;
  level: QuotaLevel;
}

export interface QuotaEvaluation {
  botId: string;
  resources: QuotaResourceStatus[];
  /** Worst level across resources ('unknown' only when nothing was measured). */
  overall: QuotaLevel;
  at: number;
}

/** Measured usage to evaluate a quota against (null = not measured). */
export interface BotUsageSnapshot {
  /** CPU cores currently used (rate from cpuRateFromSamples). */
  cpuCoresUsed: number | null;
  ramBytesUsed: number | null;
  diskBytesUsed: number | null;
}

const LEVEL_RANK: Record<QuotaLevel, number> = { ok: 0, unknown: 1, warning: 2, breach: 3 };

function evaluateResource(
  resource: QuotaResource,
  used: number | null,
  limit: number,
  warnPercent: number,
): QuotaResourceStatus {
  if (used === null || !Number.isFinite(used) || used < 0) {
    return { resource, used: null, limit, percent: null, level: 'unknown' };
  }
  const percent = used / limit;
  const level: QuotaLevel = percent >= 1 ? 'breach' : percent >= warnPercent ? 'warning' : 'ok';
  return { resource, used, limit, percent, level };
}

/**
 * Evaluate one quota against measured usage. Disabled quotas evaluate
 * to all-'unknown' with overall 'unknown' (stored but never enforced).
 */
export function evaluateBotQuota(
  quota: BotQuota,
  usage: BotUsageSnapshot,
  at: number = Date.now(),
): QuotaEvaluation {
  if (!quota.enabled) {
    const resources: QuotaResourceStatus[] = (['cpu', 'ram', 'disk'] as const).map((resource) => ({
      resource,
      used: null,
      limit: resource === 'cpu' ? quota.cpuCoresMax : resource === 'ram' ? quota.ramBytesMax : quota.diskBytesMax,
      percent: null,
      level: 'unknown' as QuotaLevel,
    }));
    return { botId: quota.botId, resources, overall: 'unknown', at };
  }
  const resources: QuotaResourceStatus[] = [
    evaluateResource('cpu', usage.cpuCoresUsed, quota.cpuCoresMax, quota.warnPercent),
    evaluateResource('ram', usage.ramBytesUsed, quota.ramBytesMax, quota.warnPercent),
    evaluateResource('disk', usage.diskBytesUsed, quota.diskBytesMax, quota.warnPercent),
  ];
  const overall = resources.reduce<QuotaLevel>(
    (worst, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[worst] ? r.level : worst),
    'ok',
  );
  return { botId: quota.botId, resources, overall, at };
}

/**
 * CPU cores used, derived from the last two usable samples: the delta
 * of cumulative CPU seconds over the delta of wall-clock seconds.
 * Returns null when fewer than two samples carry cpuSeconds, when the
 * samples are out of order, or when the wall-clock delta is not
 * positive. Clamped to >= 0 (a backwards clock never yields negative use).
 */
export function cpuRateFromSamples(samples: FleetUsageSample[]): number | null {
  const usable = samples
    .filter((s) => s.cpuSeconds !== null && Number.isFinite(s.cpuSeconds))
    .sort((a, b) => a.at - b.at);
  if (usable.length < 2) return null;
  const last = usable[usable.length - 1];
  const prev = usable[usable.length - 2];
  const dtSeconds = (last.at - prev.at) / 1000;
  if (dtSeconds <= 0) return null;
  const dCpu = (last.cpuSeconds as number) - (prev.cpuSeconds as number);
  if (dCpu < 0) return null;
  return dCpu / dtSeconds;
}

/** Aggregate usage statistics for one bot over its samples. */
export interface BotUsageStats {
  botId: string;
  samples: number;
  firstAt: number | null;
  lastAt: number | null;
  /** Highest RSS seen (bytes) — null when never measured. */
  peakRssBytes: number | null;
  /** Mean RSS over measured samples (bytes) — null when never measured. */
  avgRssBytes: number | null;
  /** Highest disk use seen (bytes) — null when never measured. */
  peakDiskBytes: number | null;
  /** Total CPU seconds consumed across the window (last - first cumulative). */
  cpuSecondsTotal: number | null;
  /** Latest RSS (bytes) — null when never measured. */
  latestRssBytes: number | null;
  /** Latest disk use (bytes) — null when never measured. */
  latestDiskBytes: number | null;
}

export function summarizeBotUsage(botId: string, samples: FleetUsageSample[]): BotUsageStats | null {
  const mine = samples
    .filter((s) => s.workspaceId === botId)
    .sort((a, b) => a.at - b.at);
  if (mine.length === 0) return null;
  const rss = mine.filter((s) => s.rssBytes !== null).map((s) => s.rssBytes as number);
  const disk = mine.filter((s) => s.diskBytes !== null).map((s) => s.diskBytes as number);
  const cpu = mine.filter((s) => s.cpuSeconds !== null).map((s) => s.cpuSeconds as number);
  const avg = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  const max = (values: number[]): number | null => (values.length === 0 ? null : Math.max(...values));
  return {
    botId,
    samples: mine.length,
    firstAt: mine[0].at,
    lastAt: mine[mine.length - 1].at,
    peakRssBytes: max(rss),
    avgRssBytes: avg(rss),
    peakDiskBytes: max(disk),
    cpuSecondsTotal: cpu.length >= 2 ? cpu[cpu.length - 1] - cpu[0] : cpu.length === 1 ? cpu[0] : null,
    latestRssBytes: rss.length === 0 ? null : (mine.filter((s) => s.rssBytes !== null).pop()?.rssBytes ?? null),
    latestDiskBytes: disk.length === 0 ? null : (mine.filter((s) => s.diskBytes !== null).pop()?.diskBytes ?? null),
  };
}

/** One quota warning or breach, for the console alert list. */
export interface QuotaAlert {
  botId: string;
  resource: QuotaResource;
  level: 'warning' | 'breach';
  /** Used / limit as a fraction (e.g. 0.92 = 92% of the limit). */
  percent: number;
  used: number;
  limit: number;
  at: number;
}

/**
 * Evaluate every enabled quota against the latest usage snapshot per
 * bot and return warnings/breaches, newest first. `samplesByBot` maps
 * bot id -> that bot's usage samples (newest last). Bots without a
 * quota or without measurements produce no alert.
 */
export function checkBotQuotas(
  quotas: BotQuota[],
  samplesByBot: Record<string, FleetUsageSample[]>,
  at: number = Date.now(),
): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  for (const quota of quotas) {
    if (!quota.enabled) continue;
    const samples = samplesByBot[quota.botId] ?? [];
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a.at - b.at);
    const latest = sorted[sorted.length - 1];
    const usage: BotUsageSnapshot = {
      cpuCoresUsed: cpuRateFromSamples(sorted),
      ramBytesUsed: latest.rssBytes,
      diskBytesUsed: latest.diskBytes,
    };
    const evaluation = evaluateBotQuota(quota, usage, at);
    for (const resource of evaluation.resources) {
      if (resource.level !== 'warning' && resource.level !== 'breach') continue;
      if (resource.used === null || resource.percent === null) continue;
      alerts.push({
        botId: quota.botId,
        resource: resource.resource,
        level: resource.level,
        percent: resource.percent,
        used: resource.used,
        limit: resource.limit,
        at,
      });
    }
  }
  return alerts.slice(0, QUOTA_MAX_ALERTS);
}
