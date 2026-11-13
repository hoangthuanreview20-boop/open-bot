/**
 * ModelRouter — gộp 3 tầng (structural → semantic → decision) thành
 * quyết định cuối cho mỗi turn (v0.96, Đội T3).
 *
 * Luồng quyết định (rẻ trước, đắt sau — chỉ leo tầng khi tầng dưới
 * chưa đủ tự tin):
 *   1. structural (không gọi model, <1ms): quá dễ → local, quá khó
 *      → model mạnh, còn lại → tầng 2.
 *   2. semantic (1 lần embed local): route đủ tự tin → theo gợi ý
 *      của route; không biết / hai route giằng co → tầng 3.
 *   3. decision (1 lần gọi model nhỏ local): đủ tự tin → theo model;
 *      không thì dùng model mặc định của bot.
 *   4. Bất cứ tầng nào lỗi/timeout cũng fail-open: trả model mặc
 *      định, KHÔNG BAO GIỜ làm hỏng turn (coordinator dựa vào đó).
 *
 * Ngoài ra router giữ 3 trách nhiệm vận hành:
 * - SESSION PINNING: đã chọn model cho một thread thì giữ nguyên
 *   (tránh nhảy model giữa chừng làm mất mạch hội thoại), trừ khi
 *   user đổi model, hết TTL lượt, hoặc context sắp đầy (>= 90%).
 * - FALLBACK LADDER: model chính lỗi → model dự phòng → local.
 *   Router giữ danh sách target "không khoẻ" (kèm cooldown) và thứ
 *   tự dự phòng; coordinator thử dựng provider theo thứ tự đó.
 * - LOG + ƯỚC TÍNH TIẾT KIỆM: mọi quyết định vào ring buffer (UI
 *   RouterPanel đọc) + thống kê local-vs-cloud và số tiền ước tính
 *   tiết kiệm được khi đi local thay vì cloud.
 *
 * Router không biết gì về provider thật: nó chỉ chọn trong danh sách
 * `availableTargets` mà caller (coordinator) đưa — caller là bên duy
 * nhất biết dựng provider nào (key, cliBinary, Ollama...).
 */

import { OllamaEmbeddings, DEFAULT_OLLAMA_BASE_URL } from '../memory/embeddings';
import type { Embedder } from '../memory/embeddings';
import { structuralScore, structuralVerdict } from './structuralScore';
import type { StructuralScore } from './structuralScore';
import { SemanticRouter } from './semanticRouter';
import type { SemanticRouteResult } from './semanticRouter';
import { DecisionRouter } from './decisionRouter';
import type { DecisionResult } from './decisionRouter';
import { computeRouterStats } from './history';
import type { RouterStatsEntry } from './history';
import { compareCapable } from './targets';

/** Một đích có thể route tới (do coordinator cung cấp). */
export interface RouterTarget {
  /** Id ổn định trong phiên (vd 'bot-default', 'ollama-local'). */
  id: string;
  /** Provider id của open-bot (vd 'ollama', 'openai', 'claude-code'). */
  providerId: string;
  /** Tên model (vd 'qwen2.5:0.5b'). */
  model: string;
  /** Loại đích: local (chạy trên máy, $0) / cli (CLI đã đăng nhập) / api (cần key). */
  kind: 'local' | 'cli' | 'api';
  /** Giá ước tính USD / 1000 token (0 với local) — để tính tiết kiệm. */
  costPer1kUsd?: number;
  /** Context window ước tính (token) — để tầng pinning biết khi nào đầy. */
  contextLimit?: number;
  /**
   * v0.98: đường dẫn tuyệt đối tới binary CLI (chỉ đích kind 'cli',
   * do detector tìm thấy). Trống = coordinator không dựng được
   * provider cho đích này (driver CLI throw fail-closed).
   */
  cliBinary?: string;
  /** v0.98: argv ACP cho CLI tuỳ chỉnh (chỉ đích custom-acp). */
  cliArgs?: string[];
}

/** Tầng nào đã ra quyết định cuối. */
export type RouterLayer =
  | 'pinned'
  | 'structural'
  | 'semantic'
  | 'decision'
  | 'default'
  | 'router-error';

export interface RouterConfig {
  /** Bật router (mặc định true; tắt = luôn dùng model mặc định). */
  enabled: boolean;
  /** Bật/tắt từng tầng (mặc định bật cả 3). */
  layers: { structural: boolean; semantic: boolean; decision: boolean };
  /** Ngưỡng structural: <= simpleMax → local (mặc định 0.15). */
  simpleMax: number;
  /** Ngưỡng structural: >= complexMin → model mạnh (mặc định 0.3). */
  complexMin: number;
  /** Cosine tối thiểu để tin semantic (mặc định 0.35). */
  minSemanticConfidence: number;
  /** Margin tối thiểu giữa route nhất/nhì (mặc định 0.08). */
  minSemanticMargin: number;
  /** Confidence tối thiểu để tin decision model (mặc định 0.5). */
  minDecisionConfidence: number;
  /** Timeout gọi decision model (ms, mặc định 4000). */
  decisionTimeoutMs: number;
  /** Số lượt tối đa giữ pin (0 = vô hạn tới khi unpin, mặc định 0). */
  pinTtlTurns: number;
  /** Tỉ lệ context mà tại đó pin bị gỡ để route lại (mặc định 0.9). */
  pinBreakContextRatio: number;
  /** Số quyết định tối đa giữ trong log (mặc định 100). */
  maxLogEntries: number;
  /** Base URL Ollama (mặc định http://127.0.0.1:11434). */
  ollamaBaseUrl: string;
  /** Model decision nhỏ (mặc định qwen2.5:0.5b). */
  decisionModel: string;
  /**
   * v0.98: cho phép route tới đích local / CLI / API không (mặc định
   * bật cả 3). Tắt một loại thì đích loại đó không được offer — trừ
   * đích mặc định của bot (luôn giữ để turn còn đường chạy).
   */
  allowLocal: boolean;
  allowCli: boolean;
  allowApi: boolean;
  /**
   * v0.98: provider id user tắt routing tới (vd không muốn router
   * đụng tới 'gemini'). Đích mặc định của bot không bao giờ bị loại
   * bởi danh sách này.
   */
  disabledProviders: string[];
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  enabled: true,
  layers: { structural: true, semantic: true, decision: true },
  simpleMax: 0.15,
  complexMin: 0.3,
  minSemanticConfidence: 0.35,
  minSemanticMargin: 0.08,
  minDecisionConfidence: 0.5,
  decisionTimeoutMs: 4000,
  pinTtlTurns: 0,
  pinBreakContextRatio: 0.9,
  maxLogEntries: 100,
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  decisionModel: 'qwen2.5:0.5b',
  allowLocal: true,
  allowCli: true,
  allowApi: true,
  disabledProviders: [],
};

export interface RouteInput {
  /** Tin nhắn user của turn. */
  text: string;
  /** Bot đang chạy (để pin theo bot). */
  botId: string;
  /** Thread của turn (pin theo thread; vắng = pin theo bot). */
  threadId?: string;
  /** Đích mặc định của bot (luôn có trong availableTargets). */
  defaultTarget: RouterTarget;
  /** Mọi đích caller có thể dựng provider cho. */
  availableTargets: RouterTarget[];
  /** Tỉ lệ context đã dùng (0..1) — >= ngưỡng thì gỡ pin route lại. */
  contextUsageRatio?: number;
  /** Bỏ qua pin, route lại từ đầu (user đổi model / đổi ý). */
  forceReroute?: boolean;
}

/** Một quyết định routing hoàn chỉnh (ghi log + đẩy lên UI). */
export interface RoutingDecision {
  /** Đích được chọn. */
  target: RouterTarget;
  /** Tầng đã ra quyết định. */
  layer: RouterLayer;
  /** Id route ngữ nghĩa / decision (nếu có). */
  routeId: string | null;
  /** Điểm cấu trúc (nếu tầng structural chạy). */
  structural?: StructuralScore;
  /** Kết quả semantic (nếu tầng semantic chạy). */
  semantic?: SemanticRouteResult | null;
  /** Kết quả decision model (nếu tầng decision chạy). */
  decision?: DecisionResult | null;
  /** Lý do ngắn gọn, đọc được (UI hiển thị). */
  reason: string;
  /** Tổng thời gian route (ms) — không tính thời gian provider chạy. */
  latencyMs: number;
  /** true khi quyết định này giữ pin cũ của thread. */
  pinned: boolean;
  /** Thứ tự dự phòng sau đích chính (fallback ladder). */
  fallbackLadder: RouterTarget[];
  /** Thời điểm quyết định (ms epoch). */
  at: number;
  /** Bot + thread của quyết định (để UI lọc). */
  botId: string;
  threadId?: string;
  /**
   * v0.98: id đích mặc định của bot lúc route — để tính tỉ lệ
   * fallback (quyết định rời khỏi default) trong thống kê bền vững.
   */
  defaultTargetId?: string;
  /**
   * v0.98: tiền ước tính tiết kiệm của quyết định này (USD, 0 khi
   * đi default/cloud) — store cộng dồn thay vì tính lại từ giá.
   */
  savingsUsd?: number;
}

export interface RouterStats {
  totalDecisions: number;
  localTurns: number;
  cloudTurns: number;
  /** v0.98: lượt đi qua CLI đã đăng nhập (một phần của cloudTurns). */
  cliTurns: number;
  /** v0.98: lượt đi qua provider API (một phần của cloudTurns). */
  apiTurns: number;
  pinnedTurns: number;
  decisionsByLayer: Record<RouterLayer, number>;
  /** v0.98: lượt theo kind đích (local/cli/api). */
  decisionsByKind: Record<'local' | 'cli' | 'api', number>;
  /** v0.98: lượt theo provider id của đích được chọn. */
  decisionsByProvider: Record<string, number>;
  /** v0.98: lượt rời khỏi đích mặc định của bot. */
  fallbackTurns: number;
  /** v0.98: fallbackTurns / số quyết định biết đích mặc định (0..1). */
  fallbackRate: number;
  avgLatencyMs: number;
  /** v0.98: p50 độ trễ route (ms). */
  latencyP50Ms: number;
  /** v0.98: p95 độ trễ route (ms). */
  latencyP95Ms: number;
  /** USD ước tính tiết kiệm được nhờ đi local thay vì default. */
  estimatedSavingsUsd: number;
  /** Số target đang bị đánh dấu không khoẻ. */
  unhealthyTargets: number;
}

export interface ModelRouterDeps {
  /** Embedder cho tầng semantic (mặc định OllamaEmbeddings). */
  embedder?: Embedder;
  /** Semantic router inject được (test dùng route/cấu hình riêng). */
  semanticRouter?: SemanticRouter;
  /** Decision router inject được (test dùng fake). */
  decisionRouter?: DecisionRouter;
  /** Callback mỗi khi có quyết định (coordinator nối vào harness). */
  onDecision?: (decision: RoutingDecision) => void;
  /** Fetch inject được (discoverLocalTarget dùng /api/tags). */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface Pin {
  targetId: string;
  turns: number;
}

const LOCAL_MODELS_CACHE_TTL_MS = 60_000;

export class ModelRouter {
  readonly config: RouterConfig;
  private readonly semantic: SemanticRouter;
  private readonly decision: DecisionRouter;
  private readonly onDecision?: (decision: RoutingDecision) => void;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly pins = new Map<string, Pin>();
  private readonly unhealthy = new Map<string, number>();
  private readonly log: RoutingDecision[] = [];
  private totalLatencyMs = 0;
  private estimatedSavingsUsd = 0;
  private localModelsCache: { at: number; models: Array<{ name: string; size: number }> } | null =
    null;

  constructor(config: Partial<RouterConfig> = {}, deps: ModelRouterDeps = {}) {
    this.config = {
      ...DEFAULT_ROUTER_CONFIG,
      ...config,
      layers: { ...DEFAULT_ROUTER_CONFIG.layers, ...(config.layers ?? {}) },
    };
    const embedder = deps.embedder ?? new OllamaEmbeddings({ baseUrl: this.config.ollamaBaseUrl });
    this.semantic =
      deps.semanticRouter ??
      new SemanticRouter(embedder, {
        minConfidence: this.config.minSemanticConfidence,
      });
    this.decision =
      deps.decisionRouter ??
      new DecisionRouter({
        baseUrl: this.config.ollamaBaseUrl,
        model: this.config.decisionModel,
        timeoutMs: this.config.decisionTimeoutMs,
      });
    this.onDecision = deps.onDecision;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /** Key pin của một (bot, thread). */
  static pinKey(botId: string, threadId?: string): string {
    return `${botId}:${threadId ?? 'default'}`;
  }

  /** Gỡ pin của một thread (user đổi model / switchModel gọi). */
  clearPin(botId: string, threadId?: string): void {
    this.pins.delete(ModelRouter.pinKey(botId, threadId));
  }

  /** Gỡ toàn bộ pin của một bot (xoá bot / reset). */
  clearPinsForBot(botId: string): void {
    for (const key of [...this.pins.keys()]) {
      if (key.startsWith(`${botId}:`)) this.pins.delete(key);
    }
  }

  /** Đánh dấu một target không khoẻ trong `cooldownMs` (mặc định 60s). */
  markUnhealthy(targetId: string, cooldownMs = 60_000): void {
    this.unhealthy.set(targetId, Date.now() + cooldownMs);
  }

  /** Target còn khoẻ không (hết cooldown thì tự khoẻ lại). */
  isHealthy(targetId: string): boolean {
    const until = this.unhealthy.get(targetId);
    if (until === undefined) return true;
    if (Date.now() >= until) {
      this.unhealthy.delete(targetId);
      return true;
    }
    return false;
  }

  /** Thứ tự dự phòng sau đích chính (fallback ladder: model chính
   *  lỗi → model dự phòng cùng loại / loại khác → local cuối cùng).
   *  Target không khoẻ bị đẩy xuống cuối (vẫn giữ để khi mọi thứ
   *  khác chết vẫn còn đường thử). */
  fallbackLadder(chosen: RouterTarget, targets: RouterTarget[]): RouterTarget[] {
    const rest = targets.filter((t) => t.id !== chosen.id);
    const healthy = rest.filter((t) => this.isHealthy(t.id));
    const sick = rest.filter((t) => !this.isHealthy(t.id));
    const byCost = (a: RouterTarget, b: RouterTarget) =>
      (a.costPer1kUsd ?? 0) - (b.costPer1kUsd ?? 0);
    const sameKind = healthy.filter((t) => t.kind === chosen.kind).sort(byCost);
    const others = healthy
      .filter((t) => t.kind !== chosen.kind && t.kind !== 'local')
      .sort(byCost);
    const local = healthy.filter((t) => t.kind === 'local').sort(byCost);
    return [...sameKind, ...others, ...local, ...sick.sort(byCost)];
  }

  /** Các quyết định gần nhất (mới nhất trước), tối đa `limit`. */
  getRecentDecisions(limit = 20): RoutingDecision[] {
    return this.log.slice(-limit).reverse();
  }

  /** Thống kê tích luỹ (local-vs-cloud, tiết kiệm ước tính). */
  getStats(): RouterStats {
    const entries: RouterStatsEntry[] = this.log.map((d) => ({
      target: d.target,
      layer: d.layer,
      latencyMs: d.latencyMs,
      pinned: d.pinned,
      at: d.at,
      botId: d.botId,
      defaultTargetId: d.defaultTargetId,
      savingsUsd: d.savingsUsd ?? 0,
    }));
    return computeRouterStats(entries, {
      unhealthyTargets: [...this.unhealthy.keys()].filter((id) => !this.isHealthy(id)).length,
    });
  }

  /** Xoá log quyết định + thống kê (giữ pin). */
  clearLog(): void {
    this.log.length = 0;
    this.totalLatencyMs = 0;
    this.estimatedSavingsUsd = 0;
  }

  /**
   * v0.98: xoá log quyết định của MỘT bot (giữ pin + quyết định của
   * bot khác). Tổng độ trễ / tiền tiết kiệm tính lại từ log còn lại
   * để thống kê không lệch. Trả số quyết định đã xoá.
   */
  clearLogForBot(botId: string): number {
    const before = this.log.length;
    const kept = this.log.filter((d) => d.botId !== botId);
    const removed = before - kept.length;
    if (removed === 0) return 0;
    this.log.length = 0;
    this.log.push(...kept);
    this.totalLatencyMs = kept.reduce((sum, d) => sum + d.latencyMs, 0);
    this.estimatedSavingsUsd = kept.reduce((sum, d) => sum + (d.savingsUsd ?? 0), 0);
    return removed;
  }

  /**
   * v0.98: áp patch cấu hình đã validate (xem
   * `validateRouterConfigPatch` trong history.ts) lên instance đang
   * chạy — RouterPanel đổi ngưỡng thì turn sau dùng ngay, không cần
   * restart coordinator. Trả bản sao cấu hình hiệu lực. Patch chưa
   * validate mà gọi thẳng vào đây thì trường sai kiểu bị bỏ qua
   * (không throw): caller chịu trách nhiệm validate trước.
   */
  updateConfig(patch: Partial<RouterConfig>): RouterConfig {
    if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled;
    if (typeof patch.allowLocal === 'boolean') this.config.allowLocal = patch.allowLocal;
    if (typeof patch.allowCli === 'boolean') this.config.allowCli = patch.allowCli;
    if (typeof patch.allowApi === 'boolean') this.config.allowApi = patch.allowApi;
    if (Array.isArray(patch.disabledProviders)) {
      this.config.disabledProviders = [...new Set(patch.disabledProviders.filter((v) => typeof v === 'string'))];
    }
    if (patch.layers) {
      for (const layer of ['structural', 'semantic', 'decision'] as const) {
        if (typeof patch.layers[layer] === 'boolean') this.config.layers[layer] = patch.layers[layer];
      }
    }
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const setNum = (key: 'simpleMax' | 'complexMin' | 'minSemanticConfidence' | 'minSemanticMargin' | 'minDecisionConfidence' | 'pinBreakContextRatio', min: number, max: number): void => {
      const v = num(patch[key]);
      if (v !== null) this.config[key] = Math.min(max, Math.max(min, v));
    };
    setNum('simpleMax', 0, 1);
    setNum('complexMin', 0, 1);
    setNum('minSemanticConfidence', 0, 1);
    setNum('minSemanticMargin', 0, 1);
    setNum('minDecisionConfidence', 0, 1);
    setNum('pinBreakContextRatio', 0.5, 1);
    const int = (v: unknown): number | null => {
      const n = num(v);
      return n === null ? null : Math.round(n);
    };
    const setInt = (key: 'decisionTimeoutMs' | 'pinTtlTurns' | 'maxLogEntries', min: number, max: number): void => {
      const v = int(patch[key]);
      if (v !== null) this.config[key] = Math.min(max, Math.max(min, v));
    };
    setInt('decisionTimeoutMs', 500, 60_000);
    setInt('pinTtlTurns', 0, 1000);
    setInt('maxLogEntries', 10, 1000);
    if (typeof patch.ollamaBaseUrl === 'string' && /^https?:\/\/.+/.test(patch.ollamaBaseUrl.trim())) {
      this.config.ollamaBaseUrl = patch.ollamaBaseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof patch.decisionModel === 'string' && patch.decisionModel.trim()) {
      this.config.decisionModel = patch.decisionModel.trim();
    }
    // maxLogEntries thu hẹp thì tỉa log ngay cho đúng giới hạn mới.
    if (this.log.length > this.config.maxLogEntries) {
      this.log.splice(0, this.log.length - this.config.maxLogEntries);
    }
    return { ...this.config, layers: { ...this.config.layers }, disabledProviders: [...this.config.disabledProviders] };
  }

  /**
   * v0.98: đích có được offer theo cấu hình không. Đích mặc định
   * của bot luôn được giữ (caller truyền isDefault=true).
   */
  isTargetAllowed(target: RouterTarget, isDefault = false): boolean {
    if (isDefault) return true;
    if (this.config.disabledProviders.includes(target.providerId)) return false;
    if (target.kind === 'local' && !this.config.allowLocal) return false;
    if (target.kind === 'cli' && !this.config.allowCli) return false;
    if (target.kind === 'api' && !this.config.allowApi) return false;
    return true;
  }

  /**
   * Hỏi Ollama `/api/tags` lấy model chat local đang cài (nhỏ nhất
   * trước), bỏ qua model embedding. Cache 60s. Trả null khi Ollama
   * chết / không có model chat nào — caller khi đó không có đích
   * local để offer.
   */
  async discoverLocalTarget(): Promise<RouterTarget | null> {
    try {
      const now = Date.now();
      if (!this.localModelsCache || now - this.localModelsCache.at > LOCAL_MODELS_CACHE_TTL_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await this.fetchFn(`${this.config.ollamaBaseUrl}/api/tags`, {
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const body = (await res.json()) as {
            models?: Array<{
              name?: string;
              size?: number;
              capabilities?: string[];
              details?: { families?: string[] };
            }>;
          };
          const models = (body.models ?? [])
            .filter((m) => {
              const name = (m.name ?? '').toLowerCase();
              if (!name || name.includes('embed')) return false;
              if ((m.capabilities ?? []).includes('embedding')) return false;
              return true;
            })
            .map((m) => ({ name: m.name ?? '', size: m.size ?? Number.MAX_SAFE_INTEGER }))
            .sort((a, b) => a.size - b.size);
          this.localModelsCache = { at: now, models };
        } finally {
          clearTimeout(timer);
        }
      }
      const first = this.localModelsCache.models[0];
      if (!first) return null;
      return {
        id: `ollama-local:${first.name}`,
        providerId: 'ollama',
        model: first.name,
        kind: 'local',
        costPer1kUsd: 0,
      };
    } catch {
      return null;
    }
  }

  /** Route một turn. Không throw — lỗi nội bộ thành quyết định
   *  'router-error' về model mặc định (fail-open). */
  async route(input: RouteInput): Promise<RoutingDecision> {
    const started = Date.now();
    const base: Pick<RoutingDecision, 'botId' | 'threadId' | 'at'> = {
      botId: input.botId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      at: started,
    };
    const finish = (partial: Omit<RoutingDecision, 'botId' | 'threadId' | 'at' | 'latencyMs' | 'fallbackLadder'> & { fallbackLadder?: RouterTarget[] }): RoutingDecision => {
      const latencyMs = Date.now() - started;
      const decision: RoutingDecision = {
        ...base,
        ...partial,
        latencyMs,
        defaultTargetId: input.defaultTarget.id,
        fallbackLadder:
          partial.fallbackLadder ?? this.fallbackLadder(partial.target, input.availableTargets),
      };
      this.record(decision, input);
      return decision;
    };
    try {
      const listed = input.availableTargets.length > 0 ? input.availableTargets : [input.defaultTarget];
      // v0.98: lọc đích theo cấu hình (allowLocal/allowCli/allowApi +
      // disabledProviders) — default luôn giữ, đích bị tắt không vào pool.
      const targets = listed.filter((t) => this.isTargetAllowed(t, t.id === input.defaultTarget.id));
      const usable = targets.length > 0 ? targets : [input.defaultTarget];
      const healthy = usable.filter((t) => this.isHealthy(t.id));
      const pool = healthy.length > 0 ? healthy : usable;
      const defaultTarget = pool.find((t) => t.id === input.defaultTarget.id) ?? pool[0] ?? input.defaultTarget;

      // Router tắt → mặc định, không tốn tầng nào.
      if (!this.config.enabled) {
        return finish({
          target: defaultTarget,
          layer: 'default',
          routeId: null,
          reason: 'Router đang tắt — dùng model mặc định của bot.',
          pinned: false,
        });
      }

      // v0.97 fix (merge verify): chỉ có một đích khả thi thì router
      // không có gì để chọn — chạy các tầng lúc này chỉ tốn 2 lần gọi
      // Ollama (embed ngữ nghĩa + decision model) cho cùng một kết
      // quả là đích mặc định, làm nghẽn llama-server vốn chỉ có 1
      // slot dưới tải suite (turn Ollama của smoke từng kẹt đủ 300s
      // vì hàng đợi model, dù mỗi call lúc rảnh chỉ ~4s). Trả default
      // ngay, không pin (đích có thể tăng thêm ở turn sau).
      if (pool.length <= 1) {
        return finish({
          target: defaultTarget,
          layer: 'default',
          routeId: null,
          reason: 'Chỉ có một đích khả thi — dùng model mặc định của bot, không chạy tầng route.',
          pinned: false,
        });
      }

      // 0. PINNING: thread đã có model thì giữ, trừ khi user ép
      // route lại, hết TTL, hoặc context sắp đầy.
      const pinKey = ModelRouter.pinKey(input.botId, input.threadId);
      const pin = this.pins.get(pinKey);
      const contextFull =
        typeof input.contextUsageRatio === 'number' &&
        input.contextUsageRatio >= this.config.pinBreakContextRatio;
      if (pin && !input.forceReroute && !contextFull) {
        const pinnedTarget = pool.find((t) => t.id === pin.targetId);
        if (pinnedTarget) {
          pin.turns++;
          if (this.config.pinTtlTurns > 0 && pin.turns >= this.config.pinTtlTurns) {
            this.pins.delete(pinKey);
          }
          return finish({
            target: pinnedTarget,
            layer: 'pinned',
            routeId: null,
            reason: `Giữ model đã chọn cho thread này (${pinnedTarget.providerId}/${pinnedTarget.model}).`,
            pinned: true,
          });
        }
        // Target bị pin không còn trong pool (vd bị đánh unhealthy
        // hết cả pool) → xoá pin, route lại từ đầu.
        this.pins.delete(pinKey);
      } else if (pin && contextFull) {
        this.pins.delete(pinKey);
      }

      const pickLocal = (): RouterTarget | null => {
        const locals = pool.filter((t) => t.kind === 'local');
        if (locals.length === 0) return null;
        locals.sort((a, b) => (a.costPer1kUsd ?? 0) - (b.costPer1kUsd ?? 0));
        return locals[0] ?? null;
      };
      /**
       * v0.98: chọn đích "mạnh" cho prompt khó. Default đã mạnh
       * (API/CLI) thì giữ default — nó là model user chọn cho bot.
       * Default là local yếu thì chọn đích mạnh nhất trong pool
       * (CLI/API đã khám phá): context lớn trước, CLI (subscription
       * sẵn, không tốn key) trước API, rẻ trước (xem `compareCapable`
       * trong targets.ts). v0.96 không có đích mạnh nào ngoài default
       * nên prompt khó của bot local vẫn ở lại local.
       */
      const pickCapable = (): RouterTarget => {
        if (defaultTarget.kind !== 'local') return defaultTarget;
        const capable = pool.filter((t) => t.kind !== 'local');
        if (capable.length === 0) return defaultTarget;
        capable.sort(compareCapable);
        return capable[0] ?? defaultTarget;
      };
      const pinAndFinish = (
        target: RouterTarget,
        layer: RouterLayer,
        routeId: string | null,
        reason: string,
        extra?: Partial<Pick<RoutingDecision, 'structural' | 'semantic' | 'decision'>>,
      ): RoutingDecision => {
        this.pins.set(pinKey, { targetId: target.id, turns: 0 });
        return finish({ target, layer, routeId, reason, pinned: false, ...extra });
      };

      // 1. STRUCTURAL — rẻ nhất, không gọi model.
      let structural: StructuralScore | undefined;
      if (this.config.layers.structural) {
        structural = structuralScore(input.text);
        const verdict = structuralVerdict(structural.score, {
          simpleMax: this.config.simpleMax,
          complexMin: this.config.complexMin,
        });
        if (verdict === 'local') {
          const local = pickLocal();
          if (local) {
            return pinAndFinish(
              local,
              'structural',
              null,
              `Prompt đơn giản (điểm cấu trúc ${structural.score.toFixed(2)}) — model local đủ sức.`,
              { structural },
            );
          }
          // Không có đích local → rơi xuống tầng sau thay vì ép default.
        } else if (verdict === 'capable') {
          return pinAndFinish(
            pickCapable(),
            'structural',
            null,
            `Prompt khó (điểm cấu trúc ${structural.score.toFixed(2)}) — cần model mạnh.`,
            { structural },
          );
        }
      }

      // 2. SEMANTIC — 1 lần embed local.
      let semantic: SemanticRouteResult | null = null;
      if (this.config.layers.semantic) {
        semantic = await this.semantic.route(input.text);
        if (semantic && semantic.routeId !== 'unknown' && semantic.suggests) {
          const confident =
            semantic.confidence >= this.config.minSemanticConfidence &&
            semantic.margin >= this.config.minSemanticMargin;
          if (confident) {
            if (semantic.suggests === 'local') {
              const local = pickLocal();
              if (local) {
                return pinAndFinish(
                  local,
                  'semantic',
                  semantic.routeId,
                  `Route "${semantic.routeId}" (tự tin ${semantic.confidence.toFixed(2)}) — model local đủ sức.`,
                  { structural, semantic },
                );
              }
            } else {
              return pinAndFinish(
                pickCapable(),
                'semantic',
                semantic.routeId,
                `Route "${semantic.routeId}" (tự tin ${semantic.confidence.toFixed(2)}) — cần model mạnh.`,
                { structural, semantic },
              );
            }
          }
          // Không đủ tự tin / margin nhỏ → tầng 3.
        }
      }

      // 3. DECISION — 1 lần gọi model nhỏ local.
      let decision: DecisionResult | null = null;
      if (this.config.layers.decision) {
        decision = await this.decision.decide(input.text);
        if (decision && decision.confidence >= this.config.minDecisionConfidence) {
          if (decision.needsPowerfulModel) {
            return pinAndFinish(
              pickCapable(),
              'decision',
              decision.route,
              `Model nhỏ quyết: cần model mạnh (tự tin ${decision.confidence.toFixed(2)}) — ${decision.reason}`,
              { structural, semantic, decision },
            );
          }
          const local = pickLocal();
          if (local) {
            return pinAndFinish(
              local,
              'decision',
              decision.route,
              `Model nhỏ quyết: model local đủ (tự tin ${decision.confidence.toFixed(2)}) — ${decision.reason}`,
              { structural, semantic, decision },
            );
          }
        }
      }

      // 4. Mặc định của bot — mọi tầng đều không quyết được.
      return pinAndFinish(
        defaultTarget,
        'default',
        semantic?.routeId ?? decision?.route ?? null,
        'Không tầng nào đủ tự tin — dùng model mặc định của bot.',
        { structural, semantic, decision },
      );
    } catch (err) {
      // Fail-open tuyệt đối: router lỗi thì turn vẫn chạy bằng default.
      return finish({
        target: input.defaultTarget,
        layer: 'router-error',
        routeId: null,
        reason: `Router lỗi (${err instanceof Error ? err.message : String(err)}) — dùng model mặc định.`,
        pinned: false,
      });
    }
  }

  /** Ghi quyết định vào log + thống kê + sink (harness/UI). */
  private record(decision: RoutingDecision, input: RouteInput): void {
    // Tiết kiệm ước tính: turn đi local thay vì default có phí.
    let savingsUsd = 0;
    if (
      decision.target.kind === 'local' &&
      input.defaultTarget.kind !== 'local' &&
      (input.defaultTarget.costPer1kUsd ?? 0) > 0
    ) {
      const estTokens = Math.max(1, Math.ceil(input.text.trim().length / 4));
      savingsUsd = (estTokens / 1000) * (input.defaultTarget.costPer1kUsd ?? 0);
    }
    decision.savingsUsd = savingsUsd;
    this.log.push(decision);
    if (this.log.length > this.config.maxLogEntries) {
      this.log.splice(0, this.log.length - this.config.maxLogEntries);
    }
    this.totalLatencyMs += decision.latencyMs;
    this.estimatedSavingsUsd += savingsUsd;
    try {
      this.onDecision?.(decision);
    } catch {
      // Sink lỗi không được làm hỏng turn.
    }
  }
}
