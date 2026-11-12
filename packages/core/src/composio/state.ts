/**
 * Composio — trạng thái persist + state view cho main process (v0.57 IPC).
 *
 * Module thuần (không Electron, không Vault thật): main process dùng để
 * - đọc trạng thái đã lưu trong settings.json (`composio: { enabled,
 *   toolkits }` — CHỈ trạng thái bật/tắt, KHÔNG BAO GIỜ chứa key;
 *   key nằm trong Vault, xem keyStore.ts),
 * - áp trạng thái đó lên ComposioAppSource lúc khởi động,
 * - dựng state view cho IPC `composio:get-state` / renderer.
 *
 * Test: tests/composio-ipc-v057.test.mjs (không cần Electron).
 */

import { COMPOSIO_TOOLKITS, COMPOSIO_TOOLKIT_SLUGS } from './toolkits';
import type { ComposioAppSource } from './source';

/** Trạng thái Composio đã lưu (settings.json — không chứa key). */
export interface ComposioPersistedState {
  /** Toàn bộ source đang bật không (mặc định TẮT — opt-in). */
  enabled: boolean;
  /** Toolkit đang bật (slug). Mặc định cả 4 khi source bật. */
  toolkits: string[];
}

/** Một app trong state view gửi về renderer (không chứa key/token). */
export interface ComposioAppStateView {
  toolkit: string;
  label: string;
  icon: string;
  enabled: boolean;
}

/** State view đầy đủ cho IPC `composio:get-state` / Settings UI. */
export interface ComposioStateView {
  enabled: boolean;
  keyConfigured: boolean;
  /** v0.88b: đã cấu hình Composio user id chưa (chỉ boolean — không lộ giá trị). */
  userIdConfigured: boolean;
  apps: ComposioAppStateView[];
}

/** Trạng thái mặc định: TẮT, cả 22 toolkit đều "sẽ bật" khi source bật. */
export function defaultComposioPersistedState(): ComposioPersistedState {
  return { enabled: false, toolkits: [...COMPOSIO_TOOLKIT_SLUGS] };
}

/**
 * Validate + chuẩn hoá trạng thái đã lưu (dữ liệu ngoài, có thể hỏng):
 * - `enabled` chỉ true khi đúng `true` (mọi giá trị khác = tắt,
 *   fail-closed).
 * - `toolkits` chỉ giữ slug hợp lệ, bỏ trùng; thiếu/không phải mảng thì
 *   mặc định cả 22 (để khi user bật source lần đầu, 22 app đều sẵn).
 */
export function resolveComposioPersistedState(raw: unknown): ComposioPersistedState {
  const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const enabled = obj.enabled === true;
  const rawToolkits = Array.isArray(obj.toolkits) ? obj.toolkits : null;
  const toolkits =
    rawToolkits === null
      ? [...COMPOSIO_TOOLKIT_SLUGS]
      : [
          ...new Set(
            rawToolkits.filter(
              (t): t is string =>
                typeof t === 'string' && (COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(t),
            ),
          ),
        ];
  return { enabled, toolkits };
}

/**
 * Áp trạng thái đã lưu lên source: bật/tắt source rồi bật/tắt từng
 * toolkit theo danh sách. Gọi lặp cùng trạng thái là idempotent
 * (ComposioAppSource.setEnabled / setToolkitEnabled đã idempotent).
 */
export function applyComposioPersistedState(
  source: ComposioAppSource,
  state: ComposioPersistedState,
): void {
  source.setEnabled(state.enabled);
  for (const slug of COMPOSIO_TOOLKIT_SLUGS) {
    source.setToolkitEnabled(slug, state.toolkits.includes(slug));
  }
}

/** Trạng thái hiện tại của source, để persist lại vào settings.json. */
export function composioStateToPersist(source: ComposioAppSource): ComposioPersistedState {
  return { enabled: source.isEnabled(), toolkits: source.enabledToolkits() };
}

/**
 * Dựng state view cho UI: label/icon lấy từ catalog (không bịa),
 * enabled từng app lấy từ source. Không chứa key/token/user id —
 * chỉ boolean đã cấu hình chưa.
 */
export function buildComposioStateView(
  source: ComposioAppSource,
  keyConfigured: boolean,
  userIdConfigured = false,
): ComposioStateView {
  return {
    enabled: source.isEnabled(),
    keyConfigured,
    userIdConfigured,
    apps: COMPOSIO_TOOLKITS.map((t) => ({
      toolkit: t.slug,
      label: t.label,
      icon: t.icon,
      enabled: source.isToolkitEnabled(t.slug),
    })),
  };
}
