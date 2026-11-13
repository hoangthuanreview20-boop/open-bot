/**
 * Router history — lịch sử quyết định bền vững + thống kê tổng hợp
 * + validate/persist cấu hình router (v0.98, Đội T2).
 *
 * v0.96 chỉ giữ quyết định trong ring buffer bộ nhớ của ModelRouter
 * (mất khi coordinator respawn) và thống kê cũng chỉ tính trên log
 * đó. Module này cho RouterPanel dữ liệu thật qua các phiên:
 *
 * - `RouterDecisionStore`: file `<dataDir>/router-decisions.json`
 *   (`{version: 1, bots: {botId: StoredRouterDecision[]}}`), tối đa
 *   200 quyết định/bot, tối đa 50 bot (bot lâu không hoạt động nhất
 *   bị tỉa trước). Ghi atomic (tmp + rename) nên coordinator chết
 *   giữa chừng không làm hỏng file. Mọi lỗi I/O đều nuốt (trả false
 *   / về rỗng) — store không bao giờ làm hỏng turn.
 * - `computeRouterStats`: thống kê tổng hợp dùng chung cho cả log
 *   bộ nhớ (ModelRouter.getStats) lẫn store: tổng lượt, local/cli/
 *   api, theo tầng, theo provider, độ trễ trung bình + p50/p95, tỉ
 *   lệ fallback (quyết định rời khỏi đích mặc định của bot), tiền
 *   ước tính tiết kiệm được. Tỉ lệ fallback chỉ tính trên quyết
 *   định nào biết đích mặc định (`defaultTargetId`); quyết định cũ
 *   không có trường này không bị đếm sai thành fallback.
 * - `validateRouterConfigPatch` + `load/saveRouterConfigFile`: cấu
 *   hình router bền vững (`<dataDir>/router-config.json`) để
 *   coordinator respawn vẫn giữ cấu hình user đã chỉnh trong panel.
 *   Patch sai kiểu / ngoài khoảng / key lạ đều bị từ chối kèm lý do
 *   rõ ràng, không đoán mò (fail-closed); số ngoài khoảng được kẹp
 *   về biên hợp lệ thay vì lỗi (slider UI gửi số lẻ là chuyện
 *   thường).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  RouterConfig,
  RouterLayer,
  RouterStats,
  RoutingDecision,
} from './router';

export const ROUTER_DECISIONS_FILE = 'router-decisions.json';
export const ROUTER_CONFIG_FILE = 'router-config.json';
/** Số quyết định tối đa giữ cho mỗi bot (file vẫn nhỏ, đủ vẽ lịch sử). */
export const MAX_DECISIONS_PER_BOT = 200;
/** Số bot tối đa giữ trong file (bot cũ nhất bị tỉa khi vượt). */
export const MAX_BOTS_IN_STORE = 50;

/** Một quyết định đã lưu: quyết định gốc + đích mặc định lúc đó. */
export interface StoredRouterDecision {
  decision: RoutingDecision;
  /** Id đích mặc định của bot lúc route (để tính tỉ lệ fallback). */
  defaultTargetId: string;
  /** Tiền ước tính tiết kiệm của quyết định này (USD, 0 khi không có). */
  savingsUsd: number;
}

export interface RouterDecisionsFile {
  version: 1;
  bots: Record<string, StoredRouterDecision[]>;
}

export function emptyDecisionsFile(): RouterDecisionsFile {
  return { version: 1, bots: {} };
}

/** Ghi JSON atomic: tmp cùng thư mục + rename (không bao giờ nửa file). */
export function atomicWriteJson(filePath: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

function isStoredDecision(value: unknown): value is StoredRouterDecision {
  if (!value || typeof value !== 'object') return false;
  const entry = value as StoredRouterDecision;
  if (!entry.decision || typeof entry.decision !== 'object') return false;
  const d = entry.decision as RoutingDecision;
  return (
    typeof d.botId === 'string' &&
    typeof d.at === 'number' &&
    !!d.target &&
    typeof d.target.id === 'string' &&
    typeof entry.defaultTargetId === 'string'
  );
}

function parseDecisionsFile(raw: string): RouterDecisionsFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyDecisionsFile();
    const bots = (parsed as RouterDecisionsFile).bots;
    if (!bots || typeof bots !== 'object' || Array.isArray(bots)) {
      return emptyDecisionsFile();
    }
    const clean: Record<string, StoredRouterDecision[]> = {};
    for (const [botId, list] of Object.entries(bots)) {
      if (typeof botId !== 'string' || !Array.isArray(list)) continue;
      const entries = list.filter(isStoredDecision).slice(-MAX_DECISIONS_PER_BOT);
      if (entries.length > 0) clean[botId] = entries;
    }
    return { version: 1, bots: clean };
  } catch {
    return emptyDecisionsFile();
  }
}

/** Đầu vào cho `computeRouterStats` (quyết định + đích mặc định). */
export interface RouterStatsEntry {
  target: RoutingDecision['target'];
  layer: RouterLayer;
  latencyMs: number;
  pinned: boolean;
  at: number;
  botId: string;
  /** Id đích mặc định lúc route; vắng = không tính vào tỉ lệ fallback. */
  defaultTargetId?: string;
  /** Tiền tiết kiệm của quyết định này (USD). */
  savingsUsd?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Thống kê tổng hợp từ một danh sách quyết định (đã sort hay chưa
 * đều được). `unhealthyTargets` do caller điền (store không biết).
 */
export function computeRouterStats(
  entries: RouterStatsEntry[],
  opts: { unhealthyTargets?: number } = {},
): RouterStats {
  const byLayer = {} as Record<RouterLayer, number>;
  const byKind = { local: 0, cli: 0, api: 0 } as Record<'local' | 'cli' | 'api', number>;
  const byProvider: Record<string, number> = {};
  let local = 0;
  let cloud = 0;
  let pinned = 0;
  let fallbackTurns = 0;
  let fallbackKnown = 0;
  let totalLatencyMs = 0;
  let savings = 0;
  const latencies: number[] = [];
  for (const e of entries) {
    byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
    if (e.target.kind === 'local') {
      local++;
      byKind.local++;
    } else {
      cloud++;
      if (e.target.kind === 'cli') byKind.cli++;
      else byKind.api++;
    }
    byProvider[e.target.providerId] = (byProvider[e.target.providerId] ?? 0) + 1;
    if (e.pinned) pinned++;
    if (e.defaultTargetId !== undefined) {
      fallbackKnown++;
      if (e.target.id !== e.defaultTargetId) fallbackTurns++;
    }
    totalLatencyMs += e.latencyMs;
    latencies.push(e.latencyMs);
    savings += e.savingsUsd ?? 0;
  }
  latencies.sort((a, b) => a - b);
  return {
    totalDecisions: entries.length,
    localTurns: local,
    cloudTurns: cloud,
    cliTurns: byKind.cli,
    apiTurns: byKind.api,
    pinnedTurns: pinned,
    decisionsByLayer: byLayer,
    decisionsByKind: byKind,
    decisionsByProvider: byProvider,
    fallbackTurns,
    fallbackRate: fallbackKnown > 0 ? fallbackTurns / fallbackKnown : 0,
    avgLatencyMs: entries.length > 0 ? totalLatencyMs / entries.length : 0,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    estimatedSavingsUsd: savings,
    unhealthyTargets: opts.unhealthyTargets ?? 0,
  };
}

export interface RouterDecisionStoreOptions {
  /** Đường dẫn file đầy đủ (ưu tiên khi có). */
  filePath?: string;
  /** Thư mục data (dùng khi không có filePath). */
  dataDir?: string;
  /** Số quyết định tối đa mỗi bot (mặc định 200). */
  maxPerBot?: number;
}

/**
 * Store lịch sử quyết định router bền vững theo từng bot.
 * Không có filePath/dataDir → store chỉ giữ trong bộ nhớ (test).
 */
export class RouterDecisionStore {
  private readonly filePath: string | null;
  private readonly maxPerBot: number;
  private data: RouterDecisionsFile;
  private loaded = false;

  constructor(opts: RouterDecisionStoreOptions = {}) {
    this.filePath = opts.filePath ?? (opts.dataDir ? path.join(opts.dataDir, ROUTER_DECISIONS_FILE) : null);
    this.maxPerBot = opts.maxPerBot ?? MAX_DECISIONS_PER_BOT;
    this.data = emptyDecisionsFile();
  }

  /** Đọc file vào bộ nhớ (lười — lần dùng đầu; file lỗi → rỗng). */
  load(): RouterDecisionsFile {
    if (this.loaded) return this.data;
    this.loaded = true;
    if (!this.filePath) return this.data;
    try {
      this.data = parseDecisionsFile(fs.readFileSync(this.filePath, 'utf-8'));
    } catch {
      this.data = emptyDecisionsFile();
    }
    return this.data;
  }

  private save(): boolean {
    if (!this.filePath) return true;
    return atomicWriteJson(this.filePath, this.data);
  }

  /** Thêm một quyết định (không throw; trả false khi ghi file lỗi). */
  append(decision: RoutingDecision, defaultTargetId?: string): boolean {
    this.load();
    const entry: StoredRouterDecision = {
      decision,
      defaultTargetId: defaultTargetId ?? decision.defaultTargetId ?? decision.target.id,
      savingsUsd: decision.savingsUsd ?? 0,
    };
    const list = this.data.bots[decision.botId] ?? [];
    list.push(entry);
    if (list.length > this.maxPerBot) {
      list.splice(0, list.length - this.maxPerBot);
    }
    this.data.bots[decision.botId] = list;
    // Tỉa bot cũ nhất khi vượt giới hạn bot.
    const botIds = Object.keys(this.data.bots);
    if (botIds.length > MAX_BOTS_IN_STORE) {
      const byLastSeen = botIds
        .map((id) => {
          const entries = this.data.bots[id] ?? [];
          return { id, last: entries[entries.length - 1]?.decision.at ?? 0 };
        })
        .sort((a, b) => a.last - b.last);
      for (const victim of byLastSeen.slice(0, botIds.length - MAX_BOTS_IN_STORE)) {
        delete this.data.bots[victim.id];
      }
    }
    return this.save();
  }

  /** Quyết định gần nhất (mới nhất trước), lọc theo bot khi có. */
  getDecisions(botId?: string, limit = 20): RoutingDecision[] {
    this.load();
    const entries = this.getEntries(botId);
    return entries
      .slice(-limit)
      .reverse()
      .map((e) => e.decision);
  }

  /** Entry đầy đủ (kèm đích mặc định) cho tính thống kê. */
  getEntries(botId?: string): StoredRouterDecision[] {
    this.load();
    if (botId !== undefined) {
      return [...(this.data.bots[botId] ?? [])];
    }
    const all = Object.values(this.data.bots).flat();
    all.sort((a, b) => a.decision.at - b.decision.at);
    return all;
  }

  /** Thống kê tổng hợp (toàn bộ hoặc một bot). */
  getStats(botId?: string): RouterStats {
    const entries = this.getEntries(botId).map((e) => ({
      target: e.decision.target,
      layer: e.decision.layer,
      latencyMs: e.decision.latencyMs,
      pinned: e.decision.pinned,
      at: e.decision.at,
      botId: e.decision.botId,
      defaultTargetId: e.defaultTargetId,
      savingsUsd: e.savingsUsd,
    }));
    return computeRouterStats(entries);
  }

  /** Bot id đã có lịch sử (mới nhất trước). */
  botIds(): string[] {
    this.load();
    return Object.entries(this.data.bots)
      .map(([id, list]) => ({ id, last: list[list.length - 1]?.decision.at ?? 0 }))
      .sort((a, b) => b.last - a.last)
      .map((e) => e.id);
  }

  /** Xoá lịch sử (một bot hoặc tất cả). Trả số quyết định đã xoá. */
  clear(botId?: string): number {
    this.load();
    let removed = 0;
    if (botId !== undefined) {
      removed = this.data.bots[botId]?.length ?? 0;
      delete this.data.bots[botId];
    } else {
      removed = Object.values(this.data.bots).reduce((sum, list) => sum + list.length, 0);
      this.data = emptyDecisionsFile();
    }
    this.save();
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Validate + persist cấu hình router
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = clampNumber(value, min, max);
  return n === null ? null : Math.round(n);
}

export interface RouterConfigValidation {
  ok: boolean;
  /** Patch đã chuẩn hoá (chỉ chứa key hợp lệ, số đã kẹp biên). */
  config: Partial<RouterConfig>;
  errors: string[];
}

/**
 * Validate một patch cấu hình router từ renderer/RPC. Key lạ bị
 * từ chối (tránh typo lặng lẽ không có hiệu lực); giá trị sai kiểu
 * bị từ chối; số ngoài khoảng được kẹp về biên. `knownProviderIds`
 * (khi có) dùng để kiểm tra `disabledProviders` — id lạ bị từ chối.
 */
export function validateRouterConfigPatch(
  patch: unknown,
  knownProviderIds?: string[],
): RouterConfigValidation {
  const errors: string[] = [];
  const config: Partial<RouterConfig> = {};
  if (!isPlainObject(patch)) {
    return { ok: false, config, errors: ['Cấu hình router phải là object.'] };
  }
  const known = new Set(knownProviderIds ?? []);
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'enabled':
      case 'allowLocal':
      case 'allowCli':
      case 'allowApi': {
        if (typeof value !== 'boolean') errors.push(`"${key}" phải là boolean.`);
        else (config as Record<string, boolean>)[key] = value;
        break;
      }
      case 'layers': {
        if (!isPlainObject(value)) {
          errors.push('"layers" phải là object {structural, semantic, decision}.');
          break;
        }
        const layers: Partial<RouterConfig['layers']> = {};
        let layerOk = true;
        for (const layerKey of ['structural', 'semantic', 'decision'] as const) {
          if (value[layerKey] === undefined) continue;
          if (typeof value[layerKey] !== 'boolean') {
            errors.push(`"layers.${layerKey}" phải là boolean.`);
            layerOk = false;
          } else {
            layers[layerKey] = value[layerKey] as boolean;
          }
        }
        for (const extra of Object.keys(value)) {
          if (!['structural', 'semantic', 'decision'].includes(extra)) {
            errors.push(`"layers.${extra}" không phải tầng router.`);
            layerOk = false;
          }
        }
        if (layerOk && Object.keys(layers).length > 0) config.layers = layers as RouterConfig['layers'];
        break;
      }
      case 'simpleMax':
      case 'complexMin': {
        const n = clampNumber(value, 0, 1);
        if (n === null) errors.push(`"${key}" phải là số 0..1.`);
        else (config as Record<string, number>)[key] = n;
        break;
      }
      case 'minSemanticConfidence':
      case 'minSemanticMargin':
      case 'minDecisionConfidence': {
        const n = clampNumber(value, 0, 1);
        if (n === null) errors.push(`"${key}" phải là số 0..1.`);
        else (config as Record<string, number>)[key] = n;
        break;
      }
      case 'decisionTimeoutMs': {
        const n = clampInt(value, 500, 60_000);
        if (n === null) errors.push('"decisionTimeoutMs" phải là số nguyên (ms).');
        else config.decisionTimeoutMs = n;
        break;
      }
      case 'pinTtlTurns': {
        const n = clampInt(value, 0, 1000);
        if (n === null) errors.push('"pinTtlTurns" phải là số nguyên >= 0.');
        else config.pinTtlTurns = n;
        break;
      }
      case 'pinBreakContextRatio': {
        const n = clampNumber(value, 0.5, 1);
        if (n === null) errors.push('"pinBreakContextRatio" phải là số 0.5..1.');
        else config.pinBreakContextRatio = n;
        break;
      }
      case 'maxLogEntries': {
        const n = clampInt(value, 10, 1000);
        if (n === null) errors.push('"maxLogEntries" phải là số nguyên 10..1000.');
        else config.maxLogEntries = n;
        break;
      }
      case 'ollamaBaseUrl': {
        if (typeof value !== 'string' || !/^https?:\/\/.+/.test(value.trim())) {
          errors.push('"ollamaBaseUrl" phải là URL http(s).');
        } else {
          config.ollamaBaseUrl = value.trim().replace(/\/+$/, '');
        }
        break;
      }
      case 'decisionModel': {
        if (typeof value !== 'string' || !value.trim()) {
          errors.push('"decisionModel" phải là tên model không rỗng.');
        } else {
          config.decisionModel = value.trim();
        }
        break;
      }
      case 'disabledProviders': {
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          errors.push('"disabledProviders" phải là mảng string (provider id).');
          break;
        }
        const bad = known.size > 0 ? (value as string[]).filter((v) => !known.has(v)) : [];
        if (bad.length > 0) {
          errors.push(`Provider không rõ trong "disabledProviders": ${bad.join(', ')}.`);
          break;
        }
        config.disabledProviders = [...new Set(value as string[])];
        break;
      }
      default:
        errors.push(`Key cấu hình router không rõ: "${key}".`);
        break;
    }
  }
  // Lưu ý: KHÔNG ép bất biến simpleMax <= complexMin ở đây — panel
  // cho chỉnh hai slider độc lập (như v0.96); ngưỡng đảo chỉ làm
  // tầng structural ưu tiên 'local' cho điểm ở giữa (xem
  // structuralVerdict), không hỏng turn. Ép ở đây sẽ từ chối cả
  // patch hợp lệ chỉ vì một giá trị bị kẹp về biên.
  return { ok: errors.length === 0, config, errors };
}

/** Đọc cấu hình router đã lưu (file lỗi / sai thì null — dùng mặc định). */
export function loadRouterConfigFile(dataDir: string | undefined): Partial<RouterConfig> | null {
  if (!dataDir) return null;
  try {
    const raw = fs.readFileSync(path.join(dataDir, ROUTER_CONFIG_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const validated = validateRouterConfigPatch(parsed);
    return validated.ok ? validated.config : null;
  } catch {
    return null;
  }
}

/** Ghi cấu hình router hiệu lực xuống file (best-effort, trả ok?). */
export function saveRouterConfigFile(
  dataDir: string | undefined,
  config: RouterConfig,
): boolean {
  if (!dataDir) return false;
  return atomicWriteJson(path.join(dataDir, ROUTER_CONFIG_FILE), config);
}
