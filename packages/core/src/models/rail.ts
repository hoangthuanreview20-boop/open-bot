/**
 * Provider rail (M4, mốc mở rộng quy mô) — chia provider thành 3 nhóm
 * (subscription / API key / custom) để ModelPicker vẽ, theo mẫu
 * OpenMausBot `splitEngineRail` (xem docs/research-openmausbot.md §8):
 * subscription = CLI đã đăng nhập trên máy user, api = provider chạy
 * bằng API key (hoặc local như Ollama), custom = provider tuỳ chỉnh
 * (openai-compatible + Custom ACP CLI).
 *
 * Module này là hàm thuần (không đọc Vault, không đọc file, không gọi
 * mạng): caller truyền snapshot detector + catalogue model + hai hàm
 * kiểm tra key/cấu hình. Nhờ đó test được mà không cần credential thật
 * và rail KHÔNG BAO GIỜ chứa secret — `hasApiKey` chỉ trả boolean,
 * `accountLabel` chỉ là nhãn đã có trong snapshot detector.
 */

import type { DetectedEnginesSnapshot, EngineUnavailableReason } from '../detected/types';

/** Nhóm trên rail. Thứ tự hiển thị: subscription → api → custom. */
export type RailGroup = 'subscription' | 'api' | 'custom';

/** Trạng thái chọn được của một provider trên rail. */
export type RailStatus =
  | 'usable' // chọn được ngay
  | 'unknown' // chọn được nhưng trạng thái đăng nhập chưa rõ (custom ACP không có lệnh status)
  | 'disabled' // nguồn CLI đang tắt (opt-in)
  | 'unavailable'; // không chọn được, kèm lý do

/** Mã lý do khi provider không chọn được (UI map sang text i18n). */
export type RailReason =
  | EngineUnavailableReason
  | 'no-api-key' // provider cần API key mà Vault chưa có key
  | 'not-configured' // provider tuỳ chỉnh chưa cấu hình (vd openai-compatible chưa có baseUrl)
  | 'bot-disabled' // v0.90b: provider bị tắt riêng cho bot này (xem filterRailForBot)
  | 'unknown-status'; // custom ACP: không có lệnh kiểm tra đăng nhập

/** Nguồn chạy model — chỉ nhãn, không bao giờ là token/key. */
export type RailSourceKind =
  | 'account' // chạy qua tài khoản subscription của CLI (kèm accountLabel)
  | 'api-key' // chạy qua API key trong Vault (chỉ hiện chữ "API key (Vault)")
  | 'local' // chạy local, không cần tài khoản/key (Ollama)
  | 'custom'; // provider tuỳ chỉnh (openai-compatible / custom ACP)

/** Một provider trên rail. */
export interface RailEntry {
  providerId: string;
  /** Tên hiển thị của provider (vd 'Claude Code (CLI)'). */
  label: string;
  group: RailGroup;
  status: RailStatus;
  /** True khi user bấm chọn được (usable hoặc unknown). */
  selectable: boolean;
  /** Mã lý do khi không chọn được (hoặc 'unknown-status' cho unknown). */
  reason?: RailReason;
  /** Chi tiết kỹ thuật đã cắt ngắn (từ snapshot) — không secret. */
  reasonDetail?: string;
  /** Nhãn tài khoản CLI đã đăng nhập (chỉ khi status usable + có account). */
  accountLabel?: string;
  /** Cách tài khoản đăng nhập (subscription/oauth/…) — chỉ nhãn. */
  accountMethod?: string;
  /** Kind của detected engine tương ứng (chỉ provider CLI). */
  detectedKind?: string;
  /** Tên binary CLI (chỉ provider CLI). */
  binary?: string;
  /** Version CLI đã probe (chỉ provider CLI). */
  version?: string | null;
  /** Version tối thiểu mà driver yêu cầu (chỉ provider CLI). */
  minVersion?: string;
  /** Nguồn đang bật hay tắt (chỉ provider CLI; API provider không có). */
  enabled?: boolean;
  /** Nguồn chạy model (để UI hiện "chạy qua tài khoản nào"). */
  sourceKind: RailSourceKind;
  /** Model của provider (CLI: 1 model; API: catalogue; custom-acp: slug các CLI dùng được). */
  models: string[];
  /** Model mặc định (model đầu tiên dùng được). */
  defaultModel: string;
}

/** Toàn bộ rail: 3 nhóm theo thứ tự hiển thị. */
export interface ProviderRail {
  groups: Record<RailGroup, RailEntry[]>;
  /** Tất cả entry theo đúng thứ tự nhóm (tiện cho test/UI lặp một lượt). */
  entries: RailEntry[];
}

/** Meta tối thiểu của một provider mà rail cần (lấy từ PROVIDERS). */
export interface RailProviderMeta {
  id: string;
  label: string;
  defaultModel: string;
  needsKey: boolean;
  kind?: 'api' | 'cli';
  detectedKind?: string;
}

export interface BuildProviderRailInput {
  /** PROVIDERS (thứ tự gốc được giữ trong mỗi nhóm trước khi sắp xếp theo trạng thái). */
  providers: RailProviderMeta[];
  /** Snapshot detector hiện tại (null = chưa detect lần nào → mọi CLI đều unavailable). */
  engines: DetectedEnginesSnapshot | null;
  /** providerId -> model ids trong catalogue (từ ModelRegistry.snapshot()). */
  modelsByProvider: Record<string, string[]>;
  /** True khi Vault đã có API key cho provider này. */
  hasApiKey: (providerId: string) => boolean;
  /**
   * True khi provider tuỳ chỉnh đã được cấu hình đủ để chạy (mặc định:
   * openai-compatible cần baseUrl; caller truyền từ settings — chỉ
   * boolean, không truyền URL/key).
   */
  isConfigured?: (providerId: string) => boolean;
}

export const RAIL_GROUP_ORDER: RailGroup[] = ['subscription', 'api', 'custom'];

/** Thứ tự sắp xếp trong một nhóm: chọn được trước, chưa rõ sau, không chọn được cuối. */
function statusRank(status: RailStatus): number {
  switch (status) {
    case 'usable':
      return 0;
    case 'unknown':
      return 1;
    case 'disabled':
      return 2;
    case 'unavailable':
      return 3;
  }
}

function groupFor(meta: RailProviderMeta): RailGroup {
  if (meta.kind === 'cli') {
    return (meta.detectedKind ?? '').startsWith('custom-acp') ? 'custom' : 'subscription';
  }
  if (meta.id === 'openai-compatible') return 'custom';
  return 'api';
}

/**
 * Dựng rail từ snapshot + catalogue. Không throw với input lạ: provider
 * không có trong catalogue thì models = [defaultModel] (CLI) hoặc []
 * (API, kèm lý do not-configured khi cần key mà chưa có).
 */
export function buildProviderRail(input: BuildProviderRailInput): ProviderRail {
  const { providers, engines, modelsByProvider, hasApiKey } = input;
  const isConfigured = input.isConfigured ?? (() => false);
  const entries: RailEntry[] = [];

  for (const meta of providers) {
    const group = groupFor(meta);
    const catalogModels = modelsByProvider[meta.id] ?? [];
    if (meta.kind === 'cli') {
      const kind = meta.detectedKind ?? meta.id;
      // custom-acp là tiền tố: engine thật là `custom-acp:<slug>`.
      if (kind === 'custom-acp') {
        const customs = Object.values(engines?.engines ?? {}).filter((e) =>
          e.kind.startsWith('custom-acp:'),
        );
        const usable = customs.filter(
          (e) => e.enabled && (e.status === 'available' || e.status === 'unknown'),
        );
        const slugs = usable.map((e) => e.kind.slice('custom-acp:'.length));
        const anyEnabled = customs.some((e) => e.enabled);
        const status: RailStatus =
          usable.length > 0
            ? usable.some((e) => e.status === 'unknown') && usable.every((e) => e.status === 'unknown')
              ? 'unknown'
              : 'usable'
            : customs.length === 0
              ? 'unavailable'
              : anyEnabled
                ? 'unavailable'
                : 'disabled';
        entries.push({
          providerId: meta.id,
          label: meta.label,
          group,
          status,
          selectable: usable.length > 0,
          reason:
            status === 'unavailable'
              ? customs.length === 0
                ? 'not-installed'
                : 'not-signed-in'
              : status === 'disabled'
                ? 'disabled'
                : status === 'unknown'
                  ? 'unknown-status'
                  : undefined,
          reasonDetail:
            status === 'unknown'
              ? 'CLI tuỳ chỉnh không khai lệnh kiểm tra đăng nhập — trạng thái đăng nhập không rõ.'
              : undefined,
          detectedKind: kind,
          sourceKind: 'custom',
          models: slugs.length > 0 ? slugs : [meta.defaultModel],
          defaultModel: slugs[0] ?? meta.defaultModel,
        });
        continue;
      }
      const engine = engines?.engines[kind];
      const engineModels =
        catalogModels.length > 0 ? catalogModels : [meta.defaultModel];
      if (!engine) {
        entries.push({
          providerId: meta.id,
          label: meta.label,
          group,
          status: 'unavailable',
          selectable: false,
          reason: 'not-installed',
          detectedKind: kind,
          sourceKind: 'account',
          models: engineModels,
          defaultModel: meta.defaultModel,
        });
        continue;
      }
      if (!engine.enabled) {
        entries.push({
          providerId: meta.id,
          label: meta.label,
          group,
          status: 'disabled',
          selectable: false,
          reason: 'disabled',
          detectedKind: kind,
          binary: engine.binary,
          version: engine.version,
          minVersion: engine.minVersion,
          enabled: false,
          sourceKind: 'account',
          models: engineModels,
          defaultModel: meta.defaultModel,
        });
        continue;
      }
      if (engine.status === 'available') {
        entries.push({
          providerId: meta.id,
          label: meta.label,
          group,
          status: 'usable',
          selectable: true,
          accountLabel: engine.account?.label,
          accountMethod: engine.account?.method,
          detectedKind: kind,
          binary: engine.binary,
          version: engine.version,
          minVersion: engine.minVersion,
          enabled: true,
          sourceKind: 'account',
          models: engineModels,
          defaultModel: meta.defaultModel,
        });
        continue;
      }
      if (engine.status === 'unknown') {
        entries.push({
          providerId: meta.id,
          label: meta.label,
          group,
          status: 'unknown',
          selectable: true,
          reason: 'unknown-status',
          reasonDetail: engine.reasonDetail,
          detectedKind: kind,
          binary: engine.binary,
          version: engine.version,
          minVersion: engine.minVersion,
          enabled: true,
          sourceKind: 'account',
          models: engineModels,
          defaultModel: meta.defaultModel,
        });
        continue;
      }
      entries.push({
        providerId: meta.id,
        label: meta.label,
        group,
        status: 'unavailable',
        selectable: false,
        reason: engine.reason ?? 'not-signed-in',
        reasonDetail: engine.reasonDetail,
        detectedKind: kind,
        binary: engine.binary,
        version: engine.version,
        minVersion: engine.minVersion,
        enabled: true,
        sourceKind: 'account',
        models: engineModels,
        defaultModel: meta.defaultModel,
      });
      continue;
    }

    // --- Provider API / local ---
    const models = catalogModels.length > 0 ? catalogModels : [meta.defaultModel].filter((m) => m !== '');
    if (meta.id === 'ollama') {
      entries.push({
        providerId: meta.id,
        label: meta.label,
        group,
        status: 'usable',
        selectable: true,
        sourceKind: 'local',
        models,
        defaultModel: meta.defaultModel,
      });
      continue;
    }
    if (meta.id === 'openai-compatible') {
      const configured = isConfigured(meta.id);
      entries.push({
        providerId: meta.id,
        label: meta.label,
        group,
        status: configured ? 'usable' : 'unavailable',
        selectable: configured,
        reason: configured ? undefined : 'not-configured',
        sourceKind: 'custom',
        models,
        defaultModel: meta.defaultModel,
      });
      continue;
    }
    if (meta.needsKey && !hasApiKey(meta.id)) {
      entries.push({
        providerId: meta.id,
        label: meta.label,
        group,
        status: 'unavailable',
        selectable: false,
        reason: 'no-api-key',
        sourceKind: 'api-key',
        models,
        defaultModel: meta.defaultModel,
      });
      continue;
    }
    entries.push({
      providerId: meta.id,
      label: meta.label,
      group,
      status: 'usable',
      selectable: true,
      sourceKind: 'api-key',
      models,
      defaultModel: meta.defaultModel,
    });
  }

  const groups: Record<RailGroup, RailEntry[]> = {
    subscription: [],
    api: [],
    custom: [],
  };
  for (const entry of entries) groups[entry.group].push(entry);
  for (const group of RAIL_GROUP_ORDER) {
    groups[group].sort(
      (a, b) => statusRank(a.status) - statusRank(b.status) || a.label.localeCompare(b.label),
    );
  }
  const ordered = RAIL_GROUP_ORDER.flatMap((g) => groups[g]);
  return { groups, entries: ordered };
}

/**
 * v0.90b (đội G): chỉ giữ các provider id đã biết trong danh sách tắt
 * nguồn theo bot — id lạ / không phải chuỗi bị bỏ (main log cảnh báo,
 * như sanitizeDenySkills), thứ tự gốc được giữ, trùng lặp gộp một.
 * Trả [] (không undefined) để caller luôn có mảng dùng được.
 */
export function cleanDisabledProviders(value: unknown, knownIds: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(knownIds);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0 || !known.has(v) || seen.has(v)) continue;
    seen.add(v);
    kept.push(v);
  }
  return kept;
}

/**
 * v0.90b (đội G): áp danh sách nguồn tắt theo bot lên một rail đã dựng.
 * Hàm thuần (không đọc Vault/file/mạng) để main + test dùng chung:
 *
 * - Entry bị tắt (và KHÔNG phải provider hiện tại của bot) bị ẨN khỏi
 *   rail — picker của bot đó chỉ hiện nguồn đang bật.
 * - Entry bị tắt mà LÀ provider hiện tại (`currentProviderId`) được
 *   GIỮ LẠI nhưng đánh `status: 'unavailable'`, `selectable: false`,
 *   `reason: 'bot-disabled'` — để UI báo rõ cho user biết model đang
 *   chạy thuộc nguồn đã tắt, kèm gợi ý thay thế. KHÔNG tự đổi model.
 * - `suggestion` = entry chọn được đầu tiên trong rail đã lọc mà khác
 *   provider hiện tại (null khi không có — vd mọi nguồn đều tắt, hoặc
 *   provider hiện tại không bị tắt thì không cần gợi ý).
 * - `currentDisabled` = true khi và chỉ khi provider hiện tại bị tắt.
 * - Rail không có gì bị tắt → trả lại rail gốc (cùng tham chiếu) +
 *   currentDisabled false + suggestion null (không copy thừa).
 * - Id lạ trong `disabledProviders` (không có trên rail) bị bỏ qua
 *   lặng lẽ — không crash, không ẩn nhầm provider khác.
 */
export function filterRailForBot(
  rail: ProviderRail,
  disabledProviders: readonly string[] | undefined,
  currentProviderId?: string,
): { rail: ProviderRail; currentDisabled: boolean; suggestion: RailEntry | null } {
  const disabled = new Set(disabledProviders ?? []);
  if (disabled.size === 0) {
    return { rail, currentDisabled: false, suggestion: null };
  }
  const currentDisabled = !!currentProviderId && disabled.has(currentProviderId);
  const entries: RailEntry[] = [];
  for (const entry of rail.entries) {
    if (!disabled.has(entry.providerId)) {
      entries.push(entry);
      continue;
    }
    if (entry.providerId === currentProviderId) {
      entries.push({
        ...entry,
        status: 'unavailable',
        selectable: false,
        reason: 'bot-disabled',
        reasonDetail: undefined,
      });
    }
    // Disabled non-current entries are hidden from this bot's picker.
  }
  const groups: Record<RailGroup, RailEntry[]> = {
    subscription: [],
    api: [],
    custom: [],
  };
  for (const entry of entries) groups[entry.group].push(entry);
  const filtered: ProviderRail = { groups, entries };
  const suggestion =
    currentDisabled
      ? (entries.find((e) => e.selectable && e.providerId !== currentProviderId) ?? null)
      : null;
  return { rail: filtered, currentDisabled, suggestion };
}

/**
 * Nhãn nguồn chạy model cho một entry — chỉ gồm nhãn đã có trong
 * snapshot/catalogue, KHÔNG BAO GIỜ gồm token/key/secret. UI dùng
 * `sourceKind` + `accountLabel` để ghép câu i18n; hàm này chỉ để test
 * và log khẳng định không có secret lọt vào chuỗi hiển thị.
 */
export function sourceLabelText(entry: RailEntry): string {
  switch (entry.sourceKind) {
    case 'account':
      return entry.accountLabel
        ? `${entry.label} · ${entry.accountLabel}`
        : entry.status === 'unknown'
          ? `${entry.label} · Chưa rõ`
          : entry.label;
    case 'api-key':
      return `${entry.label} · API key (Vault)`;
    case 'local':
      return `${entry.label} · Local`;
    case 'custom':
      return entry.label;
  }
}
