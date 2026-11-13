/**
 * Router targets — khám phá các đích CLI / API mà router được phép
 * route tới (v0.98, Đội T2).
 *
 * v0.96 chỉ offer 2 đích: default của bot + Ollama local (probe
 * `/api/tags`). Hai họ đích còn lại bị bỏ qua vì coordinator "không
 * có key/binary của nó" (docs/router-v096.md). Module này đóng đúng
 * lỗ đó, bằng dữ liệu main/coordinator ĐÃ có sẵn:
 *
 * - CLI: snapshot của `DetectedEngineRegistry` (binary đã tìm thấy
 *   trên PATH + trạng thái đăng nhập + opt-in của user). Chỉ engine
 *   `available` VÀ đã bật mới thành target; engine chưa cài / chưa
 *   đăng nhập / user tắt thì không bao giờ xuất hiện — router không
 *   được route sang CLI không chạy được. Custom ACP bị bỏ qua có chủ
 *   ý: snapshot không mang `acpArgs` (nằm trong state file riêng),
 *   route sang đó sẽ dựng provider thiếu argv.
 * - API: danh sách provider id mà main đã seed key cho coordinator
 *   (RPC `router.setApiKey`, đúng mẫu seed key Composio/media).
 *   Không có key seed thì không có target — key KHÔNG BAO GIỜ được
 *   đọc từ Vault trong module này, chỉ nhận id đã có key.
 *
 * Mọi hàm ở đây đều thuần (không I/O, không spawn) nên test được mà
 * không cần máy thật. Giá USD và context limit là ƯỚC TÍNH công khai
 * (ghi rõ trong bảng) — chỉ dùng để tính tiền tiết kiệm ước tính và
 * xếp hạng "model mạnh" khi default là local; không phải cam kết giá
 * của nhà cung cấp.
 */

import { PROVIDERS } from '../providers/index';
import type { ProviderMeta } from '../providers/index';
import {
  isEngineUsable,
  isEngineUsableAllowingUnknown,
} from '../detected/index';
import type {
  DetectedEnginesSnapshot,
  DetectedEngineSnapshot,
} from '../detected/index';
import type { RouterTarget } from './router';

/** Giá ước tính USD / 1000 token cho model mặc định của provider API. */
export const ESTIMATED_API_COST_PER_1K_USD: Record<string, number> = {
  openai: 0.01,
  anthropic: 0.015,
  gemini: 0.0025,
  xai: 0.005,
  'openai-compatible': 0.01,
};

/**
 * Context window ước tính (token) cho model mặc định của provider.
 * Dùng để `pickCapable` xếp hạng đích mạnh khi default của bot là
 * local yếu — số lớn hơn = giữ được mạch dài hơn. CLI chạy bằng
 * subscription đăng nhập sẵn nên chi phí biên coi như 0 (không tốn
 * key API theo token).
 */
export const ESTIMATED_CONTEXT_LIMIT: Record<string, number> = {
  // API (model mặc định của từng provider).
  openai: 128_000,
  anthropic: 200_000,
  gemini: 1_000_000,
  xai: 131_072,
  'openai-compatible': 128_000,
  // CLI (model mặc định của CLI đó).
  'claude-code': 200_000,
  codex: 400_000,
  'grok-cli': 131_072,
  opencode: 200_000,
  'gemini-cli': 1_000_000,
  'cursor-cli': 200_000,
  aider: 128_000,
  'continue-cli': 128_000,
  'amazon-q-cli': 200_000,
  'copilot-cli': 128_000,
  windsurf: 200_000,
  'kiro-cli': 200_000,
};

/** Provider API mà router được phép offer khi đã có key seed. */
export function isRoutableApiProvider(meta: ProviderMeta): boolean {
  if (meta.kind === 'cli') return false;
  if (meta.id === 'ollama' || meta.id === 'mock') return false;
  if (!meta.defaultModel) return false;
  return true;
}

/** Provider id của CLI tương ứng với một detected engine kind. */
export function cliProviderIdForKind(kind: string): string | null {
  const meta = PROVIDERS.find(
    (p) => p.kind === 'cli' && p.detectedKind === kind,
  );
  return meta ? meta.id : null;
}

/**
 * Một engine có dùng được làm đích router không: phải `available`
 * (đã cài + đã đăng nhập) VÀ user đã bật (opt-in). Windsurf được
 * nới như main process: trạng thái 'unknown' vẫn dùng được khi đã
 * bật (xem `providerConfigFor` trong apps/desktop/src/main/main.ts).
 */
export function isEngineRoutable(
  snapshot: DetectedEnginesSnapshot,
  kind: string,
): boolean {
  const allowUnknown = kind === 'windsurf';
  return allowUnknown
    ? isEngineUsableAllowingUnknown(snapshot, kind)
    : isEngineUsable(snapshot, kind);
}

/**
 * Map snapshot detected engines → đích CLI.
 *
 * Bỏ qua: engine không dùng được (xem `isEngineRoutable`), engine
 * không có binaryPath (không dựng được provider — driver throw),
 * provider custom-acp (thiếu acpArgs), và mọi provider id nằm trong
 * `excludeProviderIds` (thường là provider của chính bot đang chạy
 * — default đã đại diện cho nó).
 */
export function discoverCliTargets(
  snapshot: DetectedEnginesSnapshot | null | undefined,
  excludeProviderIds: string[] = [],
): RouterTarget[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const excluded = new Set(excludeProviderIds);
  const targets: RouterTarget[] = [];
  for (const engine of Object.values(snapshot.engines ?? {})) {
    const target = cliTargetFromEngine(snapshot, engine);
    if (!target) continue;
    if (excluded.has(target.providerId)) continue;
    targets.push(target);
  }
  // Ổn định: CLI subscription trước (không tốn key), rồi theo tên.
  targets.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return targets;
}

/** Một engine snapshot → một RouterTarget, hoặc null khi không dùng được. */
export function cliTargetFromEngine(
  snapshot: DetectedEnginesSnapshot,
  engine: DetectedEngineSnapshot,
): RouterTarget | null {
  if (!engine || typeof engine.kind !== 'string') return null;
  // Custom ACP: snapshot không mang acpArgs → không dựng được provider.
  if (engine.kind.startsWith('custom-acp')) return null;
  if (!isEngineRoutable(snapshot, engine.kind)) return null;
  if (!engine.binaryPath) return null;
  const providerId = cliProviderIdForKind(engine.kind);
  if (!providerId) return null;
  const meta = PROVIDERS.find((p) => p.id === providerId);
  if (!meta || !meta.defaultModel) return null;
  return {
    id: `cli:${providerId}`,
    providerId,
    model: meta.defaultModel,
    kind: 'cli',
    costPer1kUsd: 0,
    contextLimit: ESTIMATED_CONTEXT_LIMIT[providerId] ?? 128_000,
    cliBinary: engine.binaryPath,
  };
}

/**
 * Map danh sách provider id đã có key seed → đích API.
 *
 * Bỏ qua: id lạ / provider CLI / Ollama / provider không có model
 * mặc định (vd openai-compatible chưa chọn preset), và mọi id trong
 * `excludeProviderIds` (provider của chính bot đang chạy).
 */
export function discoverApiTargets(
  providerIdsWithKeys: string[],
  excludeProviderIds: string[] = [],
): RouterTarget[] {
  const excluded = new Set(excludeProviderIds);
  const targets: RouterTarget[] = [];
  for (const id of providerIdsWithKeys) {
    if (typeof id !== 'string' || !id) continue;
    if (excluded.has(id)) continue;
    const meta = PROVIDERS.find((p) => p.id === id);
    if (!meta || !isRoutableApiProvider(meta)) continue;
    targets.push({
      id: `api:${id}`,
      providerId: id,
      model: meta.defaultModel,
      kind: 'api',
      costPer1kUsd: ESTIMATED_API_COST_PER_1K_USD[id] ?? 0.01,
      contextLimit: ESTIMATED_CONTEXT_LIMIT[id] ?? 128_000,
    });
  }
  targets.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return targets;
}

export interface AvailableTargetsInput {
  /** Đích mặc định của bot — luôn giữ, không bao giờ bị lọc. */
  defaultTarget: RouterTarget;
  /** Đích Ollama local (null khi Ollama chết / không có model chat). */
  localTarget?: RouterTarget | null;
  /** Đích CLI đã khám phá (chưa lọc theo cấu hình). */
  cliTargets?: RouterTarget[];
  /** Đích API đã khám phá (chưa lọc theo cấu hình). */
  apiTargets?: RouterTarget[];
  /**
   * Cấu hình cho phép: kind nào bị tắt thì đích loại đó rơi (trừ
   * default). Vắng = cho phép tất cả (hành vi v0.96).
   */
  allow?: { local?: boolean; cli?: boolean; api?: boolean };
  /** Provider id user tắt routing tới (default không bao giờ rơi). */
  disabledProviders?: string[];
}

/**
 * Gộp mọi nguồn đích thành danh sách duy nhất cho `router.route()`.
 * Thứ tự: default → local → CLI → API. Trùng (cùng providerId +
 * model với default hoặc với nhau) chỉ giữ một. Default không bao
 * giờ bị lọc bởi allow/disabled — lọc sai mà mất default thì turn
 * không còn đường chạy.
 */
export function buildAvailableTargets(input: AvailableTargetsInput): RouterTarget[] {
  const { defaultTarget } = input;
  const allow = input.allow ?? {};
  const disabled = new Set(input.disabledProviders ?? []);
  const seen = new Set<string>();
  const keyOf = (t: RouterTarget): string => `${t.providerId}/${t.model}`;
  const allowed = (t: RouterTarget): boolean => {
    if (t.id === defaultTarget.id) return true;
    if (disabled.has(t.providerId)) return false;
    if (t.kind === 'local' && allow.local === false) return false;
    if (t.kind === 'cli' && allow.cli === false) return false;
    if (t.kind === 'api' && allow.api === false) return false;
    return true;
  };
  const out: RouterTarget[] = [];
  const push = (t: RouterTarget | null | undefined): void => {
    if (!t) return;
    if (!allowed(t)) return;
    const key = keyOf(t);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  push(defaultTarget);
  push(input.localTarget ?? null);
  for (const t of input.cliTargets ?? []) push(t);
  for (const t of input.apiTargets ?? []) push(t);
  return out;
}

/** Xếp hạng "mạnh" cho pickCapable: context lớn trước, CLI trước API, rẻ trước. */
export function compareCapable(a: RouterTarget, b: RouterTarget): number {
  const ctx = (b.contextLimit ?? 0) - (a.contextLimit ?? 0);
  if (ctx !== 0) return ctx;
  const kindRank = (t: RouterTarget): number => (t.kind === 'cli' ? 0 : t.kind === 'api' ? 1 : 2);
  const kind = kindRank(a) - kindRank(b);
  if (kind !== 0) return kind;
  return (a.costPer1kUsd ?? 0) - (b.costPer1kUsd ?? 0);
}
