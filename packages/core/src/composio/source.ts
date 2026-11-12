/**
 * Composio — nguồn app opt-in cắm sau AppRegistry (v0.57).
 *
 * Nguyên tắc (theo docs/composio-evaluation.md §4 giai đoạn 1):
 *  - Composio là MỘT nguồn app thêm trong lớp apps, KHÔNG phải não,
 *    KHÔNG phải tài khoản bắt buộc, mặc định TẮT.
 *  - Bật source → đăng ký app router + 22 toolkit vào AppRegistry đã có
 *    (host truyền vào, thường là defaultAppRegistry); tắt → gỡ ra,
 *    M7 local chạy lại như cũ (rollback = tắt flag).
 *  - Bật/tắt được TỪNG toolkit: tắt một app thì gỡ đúng app đó khỏi
 *    registry và loại toolkit khỏi session lần sau.
 *  - Tool Composio KHÔNG có đường riêng: đã nằm trong AppRegistry thì
 *    cap M7 (`applyAppToolCaps`) + `filterTools` áp dụng chung như tool
 *    local — source này không tự cắt tool, không tự lọc.
 *  - Trạng thái auth ở đây chỉ nói "đã cấu hình key Composio chưa":
 *    key có → 'connected' (nghĩa là key đã lưu trong Vault; trạng thái
 *    OAuth từng app Gmail/Slack… nằm phía Composio, chỉ biết chắc khi
 *    gọi thử — xem docs/composio-integration.md). Key chưa có →
 *    'not_connected'. Không có trạng thái 'local' cho app Composio.
 *  - Source này không cầm key, không cầm token: nó chỉ hỏi host qua
 *    `hasApiKey()` (boolean) — host nối Vault thật (`hasComposioApiKey`).
 */

import { AppRegistry } from '../apps/catalog';
import { DEFAULT_APP_TOOL_CAP } from '../apps/toolCap';
import type { AppAuthStatus, AppDefinition, AppStatusView } from '../apps/types';
import { ComposioError } from './types';
import {
  COMPOSIO_ROUTER_APP_ID,
  COMPOSIO_TOOLKITS,
  COMPOSIO_TOOLKIT_SLUGS,
  composioAppId,
  createComposioAppDefinitions,
  toolkitForComposioAppId,
} from './toolkits';

export interface ComposioAppSourceOptions {
  /** Registry để đăng ký/gỡ app Composio (host truyền defaultAppRegistry). */
  registry?: AppRegistry;
  /** Host cho biết đã có key Composio trong Vault chưa (chỉ boolean). */
  hasApiKey?: () => boolean;
}

export class ComposioAppSource {
  private readonly registry: AppRegistry;
  private readonly hasApiKeyFn: () => boolean;
  /** Source bật hay tắt (mặc định TẮT — opt-in). */
  private enabled = false;
  /** Toolkit đang bật (mặc định cả 22 bật khi source bật). */
  private readonly enabledToolkitSet = new Set<string>(COMPOSIO_TOOLKIT_SLUGS);
  /** App id Composio đang đăng ký trong registry (để gỡ đúng). */
  private readonly registered = new Set<string>();

  constructor(opts: ComposioAppSourceOptions = {}) {
    this.registry = opts.registry ?? new AppRegistry();
    this.hasApiKeyFn = opts.hasApiKey ?? (() => false);
  }

  /** Source đang bật không. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Toolkit đang bật không (chỉ có nghĩa khi source bật). */
  isToolkitEnabled(toolkit: string): boolean {
    return this.enabledToolkitSet.has(toolkit);
  }

  /** Toolkit slug đang bật (để đưa vào createSession). */
  enabledToolkits(): string[] {
    return COMPOSIO_TOOLKIT_SLUGS.filter((slug) => this.enabledToolkitSet.has(slug));
  }

  /** App id Composio đang đăng ký (router + toolkit đang bật). */
  registeredAppIds(): string[] {
    return [...this.registered].sort();
  }

  /**
   * Bật/tắt toàn bộ source. Bật → đăng ký router + toolkit đang bật;
   * tắt → gỡ hết app Composio khỏi registry (M7 local không ảnh hưởng).
   * Gọi lặp cùng trạng thái không làm gì thêm (idempotent).
   */
  setEnabled(next: boolean): void {
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) {
      this.registerAll();
    } else {
      this.unregisterAll();
    }
  }

  /**
   * Bật/tắt một toolkit. Tắt → gỡ app đó khỏi registry ngay (tool của
   * nó không còn expose từ turn sau); bật lại (khi source đang bật) →
   * đăng ký lại. Toolkit lạ → ném lỗi rõ ràng.
   */
  setToolkitEnabled(toolkit: string, next: boolean): void {
    if (!(COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(toolkit)) {
      throw new ComposioError(
        'composio_unknown_toolkit',
        `Không rõ toolkit Composio "${toolkit}" — chỉ có: ${COMPOSIO_TOOLKIT_SLUGS.join(', ')}.`,
      );
    }
    if (next) {
      this.enabledToolkitSet.add(toolkit);
      if (this.enabled) this.registerApp(composioAppId(toolkit));
    } else {
      this.enabledToolkitSet.delete(toolkit);
      this.unregisterApp(composioAppId(toolkit));
    }
  }

  /** Tool của app Composio có được expose không — qua AppRegistry như tool local. */
  appIdForTool(toolName: string): string | undefined {
    return this.registry.appIdForTool(toolName);
  }

  /**
   * Trạng thái đầy đủ các app Composio đang đăng ký (cho UI/API) —
   * không chứa token/key, chỉ trạng thái + cap như AppStatusView của M7.
   * App chưa đăng ký (source tắt / toolkit tắt) không xuất hiện.
   */
  listStatusViews(): AppStatusView[] {
    const keyPresent = this.hasApiKeyFn();
    const authStatus: AppAuthStatus = keyPresent ? 'connected' : 'not_connected';
    const out: AppStatusView[] = [];
    for (const appId of this.registeredAppIds()) {
      const app = this.registry.get(appId);
      if (!app) continue;
      const exposed = Math.min(app.tools.length, DEFAULT_APP_TOOL_CAP);
      out.push({
        app,
        authStatus,
        toolCap: DEFAULT_APP_TOOL_CAP,
        exposedToolCount: exposed,
        cappedOutToolNames: app.tools.slice(exposed).map((t) => t.name),
      });
    }
    return out;
  }

  /** Chặn đường gọi khi source tắt — lỗi sạch, không crash. */
  requireEnabled(): void {
    if (!this.enabled) {
      throw new ComposioError(
        'composio_disabled',
        'Tích hợp Composio đang TẮT — bật trong Settings → Composio rồi thử lại. App local vẫn dùng được.',
      );
    }
  }

  private registerAll(): void {
    for (const def of createComposioAppDefinitions()) {
      if (def.id === COMPOSIO_ROUTER_APP_ID) {
        this.registerApp(def.id, def);
        continue;
      }
      const toolkit = toolkitForComposioAppId(def.id);
      if (toolkit && this.enabledToolkitSet.has(toolkit)) {
        this.registerApp(def.id, def);
      }
    }
  }

  private registerApp(appId: string, def?: AppDefinition): void {
    if (this.registered.has(appId)) return;
    const definition =
      def ??
      createComposioAppDefinitions().find((d) => d.id === appId);
    if (!definition) return;
    // App có thể đã có trong registry do host đăng ký trước (vd main
    // đăng ký lúc khởi động): khi đó chỉ ghi nhận, không đăng ký trùng.
    if (!this.registry.has(appId)) {
      this.registry.register(definition);
    }
    this.registered.add(appId);
  }

  private unregisterApp(appId: string): void {
    if (!this.registered.has(appId)) return;
    this.registry.unregister(appId);
    this.registered.delete(appId);
  }

  private unregisterAll(): void {
    for (const appId of [...this.registered]) {
      this.unregisterApp(appId);
    }
  }
}

/** Danh sách toolkit slug hợp lệ (cho UI/host kiểm tra đầu vào). */
export { COMPOSIO_TOOLKITS, COMPOSIO_TOOLKIT_SLUGS };
