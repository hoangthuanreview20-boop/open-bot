/**
 * OAuth một lần, chia sẻ cho mọi bot (M7).
 *
 * Vấn đề: trước M7, mỗi bot seed TokenSet riêng lúc createBot
 * (coordinator.connectorTokenSets) và token nối sau khi bot đã tạo
 * không tới được bot cũ (ghi chú v0.19). Lớp này là KHO TOKEN DUY
 * NHẤT cho connected apps:
 *
 *  - Một lần kết nối app (OAuth flow đã có ở connectors/framework.ts
 *    + main.ts startOAuthLogin — KHÔNG viết flow mới) thì token ghi
 *    MỘT lần vào TokenStore (thường là vaultTokenStore: Vault
 *    namespace 'connector', key = connector id).
 *  - Mọi bot đọc chung đúng TokenSet đó qua getAccessToken() — bot
 *    nào cũng thấy token mới ngay khi kết nối, kể cả bot tạo trước.
 *  - Thu hồi (disconnect) một chỗ thì xóa khỏi store + cache ngay:
 *    mọi bot mất quyền ngay lập tức (lần lấy token sau trả null).
 *  - Token không bao giờ đi vào log hay trạng thái hiển thị: trạng
 *    thái chỉ nói chưa kết nối / đã kết nối / hết hạn / lỗi, kèm
 *    nhãn tài khoản (display name/email) khi host cung cấp.
 *
 * Auto-refresh tái dùng getValidAccessToken của framework (refresh
 * trước 5 phút, dedup) — store này không tự viết refresh.
 *
 * v0.68b: app token (PAT dán tay, vd GitHub) dùng chung kho này qua
 * callback đọc/ghi/xóa token thô của host (getPlainToken /
 * setPlainToken / clearPlainToken trong SharedAppAuthStoreOptions):
 * `connectPlainToken` / `getStatus` / `getAccessToken` / `disconnect`
 * đều có nhánh token. Token PAT không có hạn nên không refresh, không
 * hết hạn — chỉ có chưa kết nối / đã kết nối / lỗi đọc.
 *
 * v0.70: riêng app 'github', `getStatus` xác thực LẠI PAT với
 * api.github.com (qua GithubPatRevalidator trong githubToken.ts —
 * timeout 10s, fail-closed, cache kết quả hợp lệ 1 giờ) để phát hiện
 * token bị thu hồi SAU khi lưu: 401 → trạng thái 'expired' + chi tiết
 * hướng dẫn dán lại token; lỗi mạng/timeout/rate-limit → giữ trạng
 * thái cũ + ghi rõ lý do. App token khác (hiện chưa có) giữ hành vi
 * cũ: chỉ kiểm tra sự tồn tại, không gọi API ngoài.
 */

import {
  getValidAccessToken,
  isTokenRevokedError,
  type ConnectorDefinition,
  type FetchFn,
  type TokenSet,
  type TokenStore,
} from '../connectors/framework';
import { GMAIL_CONNECTOR } from '../connectors/email';
import { GithubPatRevalidator, type GithubPatFetchFn } from './githubToken';
import { SLACK_CONNECTOR } from '../connectors/slack';
import { TEAMS_CONNECTOR } from '../connectors/teams';
import { AppRegistry, defaultAppRegistry } from './catalog';
import { DEFAULT_APP_TOOL_CAP } from './toolCap';
import type { AppAuthStatus, AppDefinition, AppStatusView } from './types';

/** ConnectorDefinition OAuth2 theo connector id (chỉ 3 connector có TokenSet + tokenUrl). */
const OAUTH_CONNECTOR_DEFS: Record<string, ConnectorDefinition> = {
  slack: SLACK_CONNECTOR,
  gmail: GMAIL_CONNECTOR,
  teams: TEAMS_CONNECTOR,
};

/** Client credentials OAuth của một app (host cấp, không bao giờ log). */
export interface AppClientConfig {
  clientId: string;
  clientSecret?: string;
}

export interface SharedAppAuthStoreOptions {
  /** Nơi lưu token bền vững (thường vaultTokenStore). */
  store: TokenStore;
  /** Catalog app (mặc định registry mặc định). */
  registry?: AppRegistry;
  /** Fetch injectable cho refresh token (test dùng mock). */
  fetchFn?: FetchFn;
  /**
   * v0.68b: đọc token PAT thô của app token (authType 'token') theo vị
   * trí Vault đã khai trong AppDefinition (vd 'github'/'token'). Host
   * nối vào nguồn thật của mình (coordinator: token đã seed trong bộ
   * nhớ; test: biến local). Không nối → app token luôn báo
   * 'not_connected' (fail-closed, không đoán). Không bao giờ log giá
   * trị trả về.
   */
  getPlainToken?: (namespace: string, key: string) => string | null | Promise<string | null>;
  /** v0.68b: ghi token PAT thô (đi cùng getPlainToken). Không nối → connectPlainToken ném lỗi rõ. */
  setPlainToken?: (namespace: string, key: string, value: string) => void | Promise<void>;
  /** v0.68b: xóa token PAT thô (đi cùng getPlainToken). Không nối → disconnect của app token ném lỗi rõ. */
  clearPlainToken?: (namespace: string, key: string) => void | Promise<void>;
  /**
   * v0.70: fetch injectable để xác thực lại PAT GitHub lúc kiểm tra
   * trạng thái (test dùng mock; production dùng global fetch). Chỉ
   * dùng cho app 'github' — app token khác không gọi API ngoài.
   */
  githubPatFetchFn?: GithubPatFetchFn;
  /** v0.70: thời gian cache kết quả xác thực lại PAT hợp lệ (ms). Mặc định 1 giờ. */
  githubPatRevalidateCacheMs?: number;
  /** v0.70: đồng hồ (ms) cho cache xác thực lại — test bơm thời gian giả. Mặc định Date.now. */
  nowMs?: () => number;
}

/**
 * Trạng thái xác thực suy ra thuần từ một TokenSet đã lưu (không I/O):
 *  - null -> 'not_connected'.
 *  - expiresAt parse không được -> 'error' (giá trị lưu hỏng).
 *  - đã hết hạn và không có refreshToken -> 'expired'.
 *  - còn lại -> 'connected' (kể cả sắp hết hạn: framework tự
 *    refresh khi dùng; token không hạn thì dùng tiếp như cũ).
 */
export function deriveAppAuthStatus(
  token: TokenSet | null,
  nowMs: number = Date.now(),
): AppAuthStatus {
  if (!token) return 'not_connected';
  if (token.expiresAt === undefined) return 'connected';
  const expiresMs = new Date(token.expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return 'error';
  if (expiresMs <= nowMs && !token.refreshToken) return 'expired';
  return 'connected';
}

const MAX_TOOL_CAP = 100;

export class SharedAppAuthStore {
  private readonly store: TokenStore;
  private readonly registry: AppRegistry;
  private readonly fetchFn?: FetchFn;
  /** v0.68b: callback đọc/ghi/xóa token PAT thô của app token (host nối, xem SharedAppAuthStoreOptions). */
  private readonly getPlainToken?: SharedAppAuthStoreOptions['getPlainToken'];
  private readonly setPlainToken?: SharedAppAuthStoreOptions['setPlainToken'];
  private readonly clearPlainToken?: SharedAppAuthStoreOptions['clearPlainToken'];
  /** v0.70: xác thực lại PAT GitHub + cache kết quả hợp lệ 1 giờ (chỉ app 'github'). */
  private readonly githubPatRevalidator: GithubPatRevalidator;
  /** v0.70: chi tiết trạng thái PAT theo app id (token hết hạn / chưa kiểm tra được do mạng) — hiển thị ở UI, không chứa token. */
  private readonly patStatusDetails = new Map<string, string>();
  /** Cache TokenSet theo connector id (đồng bộ với store sau mỗi connect/disconnect/refresh). */
  private readonly cache = new Map<string, TokenSet>();
  /** Nhãn tài khoản theo app id (display name/email do host cấp khi connect — chỉ ở bộ nhớ, không phải secret). */
  private readonly accountLabels = new Map<string, string>();
  /** Lỗi gần nhất theo app id (refresh/revoke thất bại) — trạng thái 'error' tới khi connect lại thành công. */
  private readonly errors = new Map<string, string>();
  /** Client config OAuth theo app id (để refresh được). */
  private readonly clientConfigs = new Map<string, AppClientConfig>();
  /** Cap tool theo app id (ghi đè mặc định). */
  private readonly caps = new Map<string, number>();

  constructor(opts: SharedAppAuthStoreOptions) {
    this.store = opts.store;
    this.registry = opts.registry ?? defaultAppRegistry;
    this.fetchFn = opts.fetchFn;
    this.getPlainToken = opts.getPlainToken;
    this.setPlainToken = opts.setPlainToken;
    this.clearPlainToken = opts.clearPlainToken;
    this.githubPatRevalidator = new GithubPatRevalidator({
      ...(opts.githubPatFetchFn ? { fetchFn: opts.githubPatFetchFn } : {}),
      ...(opts.githubPatRevalidateCacheMs !== undefined
        ? { cacheMs: opts.githubPatRevalidateCacheMs }
        : {}),
      ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    });
  }

  private connectorIdFor(app: AppDefinition): string {
    return app.connectorId as string;
  }

  /** Vị trí Vault của token PAT (đã validate ở catalog) cho app token. */
  private vaultLocationFor(app: AppDefinition): { namespace: string; key: string } {
    return {
      namespace: app.vaultNamespace as string,
      key: app.vaultKey as string,
    };
  }

  private requireTokenApp(appId: string): AppDefinition {
    const app = this.registry.get(appId);
    if (!app) throw new Error(`Không rõ app "${appId}".`);
    if (app.authType !== 'token' || !app.vaultNamespace || !app.vaultKey) {
      throw new Error(`App "${appId}" không dùng token PAT — không có token thô để lưu.`);
    }
    return app;
  }

  private requireOAuthApp(appId: string): AppDefinition {
    const app = this.registry.get(appId);
    if (!app) throw new Error(`Không rõ app "${appId}".`);
    if (app.authType !== 'oauth2' || !app.connectorId) {
      throw new Error(`App "${appId}" không dùng OAuth — không có token để lưu.`);
    }
    return app;
  }

  /** Ghi client config OAuth cho một app (để refresh token được). */
  setClientConfig(appId: string, config: AppClientConfig): void {
    this.requireOAuthApp(appId);
    if (!config.clientId || typeof config.clientId !== 'string') {
      throw new Error(`App "${appId}" cần clientId không rỗng.`);
    }
    this.clientConfigs.set(appId, { ...config });
  }

  getClientConfig(appId: string): AppClientConfig | undefined {
    const config = this.clientConfigs.get(appId);
    return config ? { ...config } : undefined;
  }

  /** Cap số tool của một app (1..100, mặc định DEFAULT_APP_TOOL_CAP). */
  setToolCap(appId: string, cap: number): void {
    if (!this.registry.has(appId)) throw new Error(`Không rõ app "${appId}".`);
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_TOOL_CAP) {
      throw new Error(`Tool cap của app "${appId}" phải là số nguyên 1..${MAX_TOOL_CAP}.`);
    }
    this.caps.set(appId, cap);
  }

  getToolCap(appId: string): number {
    if (!this.registry.has(appId)) throw new Error(`Không rõ app "${appId}".`);
    return this.caps.get(appId) ?? DEFAULT_APP_TOOL_CAP;
  }

  /**
   * v0.51 (M7 cap wiring): toàn bộ cap ghi đè theo app (bản sao) —
   * coordinator đọc mỗi run để nối vào loop (`appToolCaps.capsByApp`).
   * App không có trong map dùng mặc định DEFAULT_APP_TOOL_CAP (loop
   * tự áp), nên map này chỉ chứa app đã ghi đè qua setToolCap().
   */
  getToolCaps(): Record<string, number> {
    return Object.fromEntries(this.caps);
  }

  /**
   * Kết nối app: lưu TokenSet MỘT lần vào store (Vault) + cache.
   * Mọi bot đọc chung token này từ đây trở đi. Nhãn tài khoản
   * (không phải secret) lưu kèm để UI hiển thị.
   */
  async connect(
    appId: string,
    token: TokenSet,
    accountLabel?: string,
  ): Promise<void> {
    const app = this.requireOAuthApp(appId);
    if (!token || typeof token.accessToken !== 'string' || !token.accessToken) {
      throw new Error(`Không thể kết nối app "${appId}": TokenSet thiếu accessToken.`);
    }
    const connectorId = this.connectorIdFor(app);
    await this.store.setToken(connectorId, { ...token });
    this.cache.set(connectorId, { ...token });
    this.errors.delete(appId);
    if (accountLabel !== undefined) {
      if (accountLabel) this.accountLabels.set(appId, accountLabel);
      else this.accountLabels.delete(appId);
    }
  }

  /**
   * v0.68b: kết nối app token (PAT dán tay): lưu token thô MỘT lần qua
   * callback setPlainToken của host (coordinator: vào bộ nhớ
   * `githubToken`; main đã ghi Vault trước khi gọi RPC này). Mọi bot
   * đọc chung token này từ đây trở đi (host đọc qua getPlainToken).
   * Nhãn tài khoản (không phải secret) lưu kèm để UI hiển thị.
   */
  async connectPlainToken(
    appId: string,
    token: string,
    accountLabel?: string,
  ): Promise<void> {
    const app = this.requireTokenApp(appId);
    if (!this.setPlainToken) {
      throw new Error(
        `Không thể kết nối app "${appId}": host chưa nối kho token PAT (setPlainToken).`,
      );
    }
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error(`Không thể kết nối app "${appId}": token PAT rỗng.`);
    }
    const { namespace, key } = this.vaultLocationFor(app);
    await this.setPlainToken(namespace, key, token.trim());
    this.errors.delete(appId);
    // v0.70: token mới phải được xác thực lại từ đầu — cache hợp lệ
    // của token cũ (nếu có) không được dùng cho token này.
    this.githubPatRevalidator.clear();
    this.patStatusDetails.delete(appId);
    if (accountLabel !== undefined) {
      if (accountLabel) this.accountLabels.set(appId, accountLabel);
      else this.accountLabels.delete(appId);
    }
  }

  /**
   * Ngắt kết nối app: xóa token khỏi store + cache + nhãn + lỗi.
   * Mọi bot mất quyền ngay (lần lấy token sau trả null). Trả true
   * khi trước đó có token, false khi app vốn chưa kết nối.
   * v0.68b: app token xóa token PAT thô qua callback clearPlainToken
   * của host (coordinator: xóa `githubToken` trong bộ nhớ; main xóa
   * Vault song song).
   */
  async disconnect(appId: string): Promise<boolean> {
    const app = this.registry.get(appId);
    if (!app) throw new Error(`Không rõ app "${appId}".`);
    if (app.authType === 'token') {
      this.requireTokenApp(appId);
      if (!this.clearPlainToken) {
        throw new Error(
          `Không thể ngắt kết nối app "${appId}": host chưa nối kho token PAT (clearPlainToken).`,
        );
      }
      const { namespace, key } = this.vaultLocationFor(app);
      const had = (await this.getPlainTokenValue(appId)) !== null;
      await this.clearPlainToken(namespace, key);
      this.accountLabels.delete(appId);
      this.errors.delete(appId);
      // v0.70: token đã xóa thì cache xác thực lại + chi tiết trạng
      // thái của nó cũng hết hiệu lực.
      this.githubPatRevalidator.clear();
      this.patStatusDetails.delete(appId);
      return had;
    }
    const oauthApp = this.requireOAuthApp(appId);
    const connectorId = this.connectorIdFor(oauthApp);
    const had = (await this.getTokenSet(appId)) !== null;
    await this.store.clearToken(connectorId);
    this.cache.delete(connectorId);
    this.accountLabels.delete(appId);
    this.errors.delete(appId);
    return had;
  }

  /**
   * v0.68b: token PAT thô đã lưu của app token (null khi chưa kết nối
   * hoặc host chưa nối reader). Chuỗi rỗng/toàn khoảng trắng coi như
   * chưa có token. Không bao giờ log giá trị trả về.
   */
  private async getPlainTokenValue(appId: string): Promise<string | null> {
    const app = this.registry.get(appId);
    if (!app || app.authType !== 'token' || !app.vaultNamespace || !app.vaultKey) return null;
    if (!this.getPlainToken) return null;
    const value = await this.getPlainToken(app.vaultNamespace, app.vaultKey);
    if (typeof value !== 'string' || !value.trim()) return null;
    return value;
  }

  /** TokenSet đã lưu của app (cache trước, store sau), null khi chưa kết nối. */
  async getTokenSet(appId: string): Promise<TokenSet | null> {
    const app = this.registry.get(appId);
    if (!app || app.authType !== 'oauth2' || !app.connectorId) return null;
    const cached = this.cache.get(app.connectorId);
    // Cache có thể cũ khi token được refresh qua đường khác
    // (connectorTokenProviderFor ghi thẳng vào store): token cache đã
    // hết hạn thì đọc lại store để lấy bản mới nhất.
    const cachedStale =
      cached !== undefined &&
      cached.expiresAt !== undefined &&
      !Number.isNaN(new Date(cached.expiresAt).getTime()) &&
      new Date(cached.expiresAt).getTime() <= Date.now();
    if (cached && !cachedStale) return { ...cached };
    const stored = await this.store.getToken(app.connectorId);
    if (!stored) return null;
    // Token hỏng định dạng (store trả về nhưng không có accessToken
    // chuỗi): coi như lỗi, không cache để lần sau đọc lại được.
    if (typeof stored.accessToken !== 'string' || !stored.accessToken) {
      this.errors.set(appId, 'Token đã lưu hỏng định dạng (thiếu accessToken).');
      return null;
    }
    this.cache.set(app.connectorId, { ...stored });
    return { ...stored };
  }

  /** Trạng thái xác thực hiện tại của một app (không chứa token). */
  async getStatus(appId: string): Promise<AppAuthStatus> {
    const app = this.registry.get(appId);
    if (!app) throw new Error(`Không rõ app "${appId}".`);
    if (app.authType === 'none') return 'local';
    if (this.errors.has(appId)) return 'error';
    if (app.authType === 'token') {
      // v0.70: app token khác github chỉ kiểm tra sự tồn tại như cũ
      // (có token → connected, chưa có → not_connected, lỗi đọc →
      // error, ghi lại để lần sau vẫn error tới khi kết nối lại thành
      // công). Riêng 'github' xác thực LẠI PAT với api.github.com để
      // phát hiện token bị thu hồi sau khi lưu: 401 → 'expired' +
      // chi tiết hướng dẫn dán lại; lỗi mạng/timeout/rate-limit →
      // giữ 'connected' (token vẫn còn trong kho) + ghi rõ lý do.
      try {
        const token = await this.getPlainTokenValue(appId);
        if (token === null) {
          this.patStatusDetails.delete(appId);
          this.githubPatRevalidator.clear();
          return 'not_connected';
        }
        if (appId !== 'github') return 'connected';
        const check = await this.githubPatRevalidator.check(token);
        if (check.outcome === 'valid') {
          this.patStatusDetails.delete(appId);
          if (check.login) this.accountLabels.set(appId, check.login);
          return 'connected';
        }
        if (check.outcome === 'invalid') {
          this.patStatusDetails.set(appId, check.detail ?? '');
          return 'expired';
        }
        this.patStatusDetails.set(appId, check.detail ?? '');
        return 'connected';
      } catch (err) {
        this.errors.set(appId, (err as Error).message);
        return 'error';
      }
    }
    return deriveAppAuthStatus(await this.getTokenSet(appId));
  }

  /** Nhãn tài khoản đã kết nối (undefined khi chưa biết/chưa kết nối). */
  getAccountLabel(appId: string): string | undefined {
    return this.accountLabels.get(appId);
  }

  setAccountLabel(appId: string, label: string | undefined): void {
    if (!this.registry.has(appId)) throw new Error(`Không rõ app "${appId}".`);
    if (label) this.accountLabels.set(appId, label);
    else this.accountLabels.delete(appId);
  }

  /** Lý do lỗi gần nhất của app (undefined khi không có lỗi). */
  getError(appId: string): string | undefined {
    return this.errors.get(appId);
  }

  /**
   * v0.70: chi tiết trạng thái PAT của app (token GitHub không còn
   * hiệu lực + hướng dẫn dán lại, hoặc lý do chưa kiểm tra được do
   * mạng) — undefined khi trạng thái không cần giải thích thêm. Không
   * bao giờ chứa token.
   */
  getStatusDetail(appId: string): string | undefined {
    return this.patStatusDetails.get(appId);
  }

  /**
   * Access token dùng chung cho mọi bot. Tự refresh (qua framework)
   * khi có client config + refresh token; token tĩnh không hạn thì
   * trả tiếp như cũ. Trả null khi app chưa kết nối. Ném
   * TokenRevokedError/TokenExpiredError (và ghi trạng thái 'error')
   * khi token đã bị thu hồi / hết hạn mà refresh không được — caller
   * báo user kết nối lại, không retry vô hạn.
   */
  async getAccessToken(appId: string): Promise<string | null> {
    const app = this.registry.get(appId);
    if (!app) throw new Error(`Không rõ app "${appId}".`);
    if (app.authType === 'none') return null;
    // v0.68b: app token trả thẳng PAT thô (không hạn, không refresh).
    // Lỗi đọc kho thì ghi trạng thái 'error' rồi ném — caller báo
    // user kết nối lại, giống đường OAuth hết hạn ở dưới.
    if (app.authType === 'token') {
      try {
        return await this.getPlainTokenValue(appId);
      } catch (err) {
        this.errors.set(appId, (err as Error).message);
        throw err;
      }
    }
    const connectorId = this.connectorIdFor(app);
    const def = OAUTH_CONNECTOR_DEFS[connectorId];
    const config = this.clientConfigs.get(appId);
    if (def && config) {
      try {
        const token = await getValidAccessToken(def, this.store, {
          clientId: config.clientId,
          ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        });
        // Refresh thành công ghi lại store qua framework — đồng bộ cache.
        if (token) {
          const fresh = await this.store.getToken(connectorId);
          if (fresh) this.cache.set(connectorId, { ...fresh });
          this.errors.delete(appId);
        }
        return token;
      } catch (err) {
        if (isTokenRevokedError(err)) {
          this.errors.set(appId, 'Token đã bị thu hồi — hãy kết nối lại.');
        } else {
          this.errors.set(appId, (err as Error).message);
        }
        throw err;
      }
    }
    const stored = await this.getTokenSet(appId);
    if (!stored) return null;
    if (deriveAppAuthStatus(stored) === 'expired') {
      this.errors.set(appId, 'Token đã hết hạn và không tự refresh được — hãy kết nối lại.');
      throw new Error(
        `Token của app "${appId}" đã hết hạn và không tự refresh được — hãy kết nối lại.`,
      );
    }
    return stored.accessToken;
  }

  /** Trạng thái đầy đủ mọi app trong catalog (cho UI/API). */
  async listStatuses(): Promise<AppStatusView[]> {
    const out: AppStatusView[] = [];
    for (const app of this.registry.list()) {
      const authStatus = await this.getStatus(app.id);
      const detail = this.patStatusDetails.get(app.id);
      const toolCap = this.getToolCap(app.id);
      const exposed = Math.min(app.tools.length, toolCap);
      out.push({
        app: { ...app, tools: app.tools.map((t) => ({ ...t })) },
        authStatus,
        ...(detail ? { authStatusDetail: detail } : {}),
        ...(this.accountLabels.get(app.id)
          ? { accountLabel: this.accountLabels.get(app.id) as string }
          : {}),
        toolCap,
        exposedToolCount: exposed,
        cappedOutToolNames: app.tools.slice(exposed).map((t) => t.name),
      });
    }
    return out;
  }
}
