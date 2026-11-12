/**
 * Composio — đường thực thi (v0.58).
 *
 * v0.57 chỉ có metadata: 3 meta-tool nằm trong catalog (`toolkits.ts`)
 * nhưng chưa có implementation runnable nào — model chưa thể gọi thật
 * trong turn. Module này nối đường đó:
 *
 *   model gọi tool → `ComposioSessionManager` (lazy tạo Tool Router
 *   session + `connectMcp` client, cache theo vòng đời coordinator)
 *   → `ComposioToolRouter` (REST tạo session + gọi meta-tool qua MCP)
 *   → Composio Tool Router (mock ở test, thật ở live test sau).
 *
 * Đặt ở core (KHÔNG đặt ở @open-bot/tools) vì mọi dependency của
 * đường này đã nằm trong core: `ComposioToolRouter`, `keyStore`,
 * `connectMcp`, `Vault`. Đặt ở tools sẽ bắt tools import runtime của
 * core (đi sâu thêm vòng core <-> tools mà `coordinator.ts` đã cảnh
 * báo) mà không được gì — tool ở đây là tool của tiến trình
 * coordinator, không phải tool dùng chung. `defaultToolFactory`
 * (core) gọi thẳng `createComposioMetaTools` khi gate bật.
 *
 * Key: manager KHÔNG giữ key — mỗi lần cần session nó gọi lại
 * `getApiKey()` do host tiêm vào. Coordinator tiêm reader đọc trực
 * tiếp file Vault của main (`createComposioVaultFileKeyReader`, xem
 * keyStore.ts § giới hạn: chỉ mở được khi Vault dùng LocalEncryptor
 * fallback; safeStorage/NO_STORAGE thì đọc thất bại → fail-closed).
 * Key KHÔNG bao giờ qua RPC stdio, không vào log (mọi error qua
 * `redactComposioKey` trước khi ném).
 *
 * An toàn thực thi:
 *  - Key thiếu / không đọc được / source tắt → `ComposioError`
 *    sạch (`composio_key_missing` / `composio_disabled`), không crash
 *    turn — loop xử lý như tool lỗi bình thường.
 *  - KHÔNG retry một call đã lỗi: lỗi MCP có thể là lỗi sau khi
 *    server đã thực thi (vd ghi mail) — retry sẽ ghi trùng. Call lỗi
 *    chỉ làm mất session/client cache để lần gọi SAU nối lại mới.
 *  - Session + MCP client được cache theo (key, toolkit đang bật):
 *    đổi key hoặc đổi toolkit → session cũ bị huỷ, lần gọi sau tạo
 *    session mới đúng toolkit. Hai tool call đồng thời chỉ tạo một
 *    session (promise `connecting` dùng chung).
 *  - `COMPOSIO_MULTI_EXECUTE_TOOL` vẫn bị chặn ở 50 tool/call bởi
 *    router (như v0.57).
 */

import type { Tool } from '../types';
import { connectMcp } from '../mcp/client';
import type { McpClient } from '../mcp/types';
import {
  COMPOSIO_GET_TOOL_SCHEMAS,
  COMPOSIO_MANAGE_CONNECTIONS_TOOL,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_SEARCH_TOOL,
  ComposioError,
  type ComposioConnectionStatus,
  type ComposioExecuteItem,
  type ComposioSession,
  type ComposioToolkitConnection,
} from './types';
import { ComposioToolRouter, type ComposioFetchFn } from './router';
import { redactComposioKey, validateComposioUserId } from './keyStore';
import { COMPOSIO_TOOLKIT_SLUGS } from './toolkits';

/**
 * User id gắn với Tool Router session. Desktop là single-user nên
 * mặc định dùng hằng số local; user cấu hình user id thật trong
 * Settings → Composio (v0.88b) thì host truyền qua
 * `ComposioSessionManagerOptions.userId` lúc tạo manager, hoặc đổi
 * lúc chạy bằng `setUserId()` — đổi id thì session cũ bị huỷ ngay
 * (xem `setUserId`), lần gọi sau tạo session mới đúng id.
 */
export const COMPOSIO_LOCAL_USER_ID = 'local-user';

/**
 * v0.88b: chuẩn hoá user id cho session. `null`/undefined/rỗng →
 * về mặc định 'local-user' (chưa cấu hình); chuỗi khác validate
 * như `validateComposioUserId` (định dạng Composio cấp, vd
 * `pg-test-...` — không validate quá chặt). Sai định dạng → ném lỗi rõ.
 */
export function resolveComposioUserId(userId: unknown): string {
  if (userId === null || userId === undefined) return COMPOSIO_LOCAL_USER_ID;
  if (typeof userId !== 'string' || !userId.trim()) return COMPOSIO_LOCAL_USER_ID;
  return validateComposioUserId(userId);
}

/** 3 meta-tool mà model thực sự gọi được (v0.58 — có implementation). */
export const COMPOSIO_RUNNABLE_META_TOOLS: readonly string[] = [
  COMPOSIO_SEARCH_TOOL,
  COMPOSIO_GET_TOOL_SCHEMAS,
  COMPOSIO_MULTI_EXECUTE_TOOL,
] as const;

/** Tối thiểu MCP client mà session manager cần (connectMcp thật khớp shape này). */
export interface ComposioMcpClientLike {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface ComposioSessionManagerOptions {
  /** Đọc key lúc cần (host tiêm Vault-file reader) — không giữ key lâu. */
  getApiKey: () => string | null;
  /** User id cho session (mặc định COMPOSIO_LOCAL_USER_ID khi host không truyền). */
  userId?: string;
  /** Toolkit đang bật — session tạo theo danh sách này lúc gọi. */
  getEnabledToolkits: () => string[];
  /** REST base — mặc định v3.1; test trỏ sang mock server local. */
  baseUrl?: string;
  /** Fetch tiêm được (mặc định global fetch qua router). */
  fetchFn?: ComposioFetchFn;
  /** Tạo MCP client — mặc định `connectMcp` thật; test có thể tiêm mock. */
  createMcpClient?: (config: {
    name: string;
    url: string;
    headers: Record<string, string>;
  }) => Promise<ComposioMcpClientLike>;
}

function defaultCreateMcpClient(config: {
  name: string;
  url: string;
  headers: Record<string, string>;
}): Promise<McpClient> {
  return connectMcp(config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Giữ một Tool Router session + MCP client cho vòng đời coordinator.
 * Một manager cho mỗi tiến trình coordinator (coordinator sở hữu,
 * tool của mọi bot dùng chung) — session tạo lười ở lần gọi tool đầu
 * tiên, không tạo lúc khởi động (khởi động không cần mạng/key).
 */
export class ComposioSessionManager {
  private readonly getApiKeyFn: () => string | null;
  /** v0.88b: user id hiện tại — đổi được lúc chạy qua `setUserId()`. */
  private userId: string;
  private readonly getEnabledToolkitsFn: () => string[];
  private readonly baseUrl?: string;
  private readonly fetchFn?: ComposioFetchFn;
  private readonly createMcpClientFn: (
    config: { name: string; url: string; headers: Record<string, string> },
  ) => Promise<ComposioMcpClientLike>;

  private router: ComposioToolRouter | null = null;
  private routerKey: string | null = null;
  private session: ComposioSession | null = null;
  private sessionToolkitsKey = '';
  /**
   * v0.89c (Team E): session đã được kiểm tra connection Active
   * (key = user id + toolkit đang bật). Đặt lại mỗi lần invalidate
   * (đổi key/user id/toolkit) để lần thực thi sau kiểm tra lại.
   */
  private connectionsCheckedKey = '';
  private client: ComposioMcpClientLike | null = null;
  /** Promise nối session đang chạy — hai call đồng thời dùng chung một session. */
  private connecting: Promise<ComposioMcpClientLike> | null = null;
  private createdSessions = 0;

  constructor(opts: ComposioSessionManagerOptions) {
    this.getApiKeyFn = opts.getApiKey;
    this.userId = resolveComposioUserId(opts.userId);
    this.getEnabledToolkitsFn = opts.getEnabledToolkits;
    this.baseUrl = opts.baseUrl;
    this.fetchFn = opts.fetchFn;
    this.createMcpClientFn = opts.createMcpClient ?? defaultCreateMcpClient;
  }

  /** Số session REST đã tạo thành công (cho test chứng minh cache). */
  sessionsCreated(): number {
    return this.createdSessions;
  }

  /** User id mà session tiếp theo sẽ dùng (chỉ để test/status — không log). */
  getUserId(): string {
    return this.userId;
  }

  /**
   * v0.88b: đổi user id lúc chạy — có hiệu lực NGAY, không cần
   * restart app. `null`/rỗng = về mặc định 'local-user'; sai định
   * dạng → ném lỗi, giữ nguyên id cũ. Id đổi thật thì session +
   * client cache cũ bị huỷ (session cũ key theo id cũ không được
   * dùng tiếp); lần gọi tool sau tạo session mới đúng id. Id giữ
   * nguyên thì session cũ giữ nguyên (không invalidate thừa).
   * Trả true khi id thật sự đổi.
   */
  async setUserId(userId: string | null | undefined): Promise<boolean> {
    const next = resolveComposioUserId(userId);
    if (next === this.userId) return false;
    this.userId = next;
    await this.invalidate();
    return true;
  }

  /** Đã có session + client sống không (chỉ để quan sát, không lộ secret). */
  isConnected(): boolean {
    return this.session !== null && this.client !== null;
  }

  /** Huỷ session + client cache (đổi toolkit/tắt source/shutdown gọi). Lần gọi sau tạo mới. */
  async invalidate(): Promise<void> {
    this.connecting = null;
    const client = this.client;
    this.client = null;
    this.session = null;
    this.sessionToolkitsKey = '';
    this.connectionsCheckedKey = '';
    if (client) {
      try {
        await client.close();
      } catch {
        // Đóng client cũ lỗi cũng không làm hỏng lần gọi sau.
      }
    }
  }

  /** Đóng hẳn (shutdown coordinator) — tương đương invalidate(). */
  async close(): Promise<void> {
    await this.invalidate();
  }

  /** Tìm tool theo mô tả task qua COMPOSIO_SEARCH_TOOLS. */
  async searchTools(query: string): Promise<string> {
    const callTool = await this.ensureCallTool();
    try {
      return await this.routerFor().searchTools(query, callTool);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /** Lấy input schema của slug qua COMPOSIO_GET_TOOL_SCHEMAS. */
  async getToolSchemas(slugs: string[]): Promise<string> {
    const callTool = await this.ensureCallTool();
    try {
      return await this.routerFor().getToolSchemas(slugs, callTool);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /**
   * v0.89c (Team E): trạng thái connection từng toolkit trong session
   * hiện tại — qua COMPOSIO_MANAGE_CONNECTIONS (meta-tool của chính
   * Tool Router, không thêm endpoint). Chỉ trả {toolkit, status,
   * accountLabel}: KHÔNG trả redirect_url (link OAuth — UI không cần,
   * tránh rò link kết nối ra log/renderer), KHÔNG trả user id/key.
   * Toolkit không có trong kết quả → 'none'. Lỗi MCP/transport →
   * ComposioError 'composio_session_failed' (caller quyết định hiển
   * thị hay fail-open).
   *
   * LƯU Ý side effect của API: gọi MANAGE_CONNECTIONS cho toolkit
   * chưa có connection sẽ khởi tạo một luồng kết nối pending (link
   * hết hạn sau 10 phút, không link gì cho tới khi user hoàn tất
   * trong trình duyệt) — vì vậy UI chỉ gọi khi user bấm "Kiểm tra",
   * không tự gọi lúc mở Settings.
   */
  async getConnectionStatus(
    toolkits?: string[],
  ): Promise<ComposioToolkitConnection[]> {
    const wanted = [
      ...new Set(
        (toolkits ?? this.enabledToolkits()).filter(
          (t) => typeof t === 'string' && t.trim(),
        ),
      ),
    ];
    if (wanted.length === 0) return [];
    const callTool = await this.ensureCallTool();
    let text: string;
    try {
      const out = await callTool(COMPOSIO_MANAGE_CONNECTIONS_TOOL, { toolkits: wanted });
      if (out.isError) throw new Error(out.text.slice(0, 500));
      text = out.text;
    } catch (err) {
      throw this.wrapError(err);
    }
    const results = parseManageConnectionsResults(text);
    return wanted.map((toolkit) => {
      const entry = results[toolkit];
      const status = toConnectionStatus(entry?.status);
      const out: ComposioToolkitConnection = { toolkit, status };
      if (status === 'active') {
        const label = accountLabelFromUserInfo(entry?.current_user_info);
        if (label) out.accountLabel = label;
      }
      return out;
    });
  }

  /**
   * v0.89c (Team E): kiểm tra connection Active trước lần thực thi
   * đầu tiên của mỗi session — chỉ kiểm tra toolkit mà lần thực thi
   * này thật sự cần (suy từ prefix slug, vd GITHUB_ → github).
   * Toolkit nào chưa Active → ném ComposioError
   * 'composio_connection_inactive' kèm hướng dẫn rõ (connect trong
   * dashboard Composio + kiểm tra user id trong Settings → Composio
   * khớp User ID trên dashboard), thay cho lỗi "No active connection
   * found" khó hiểu của server. Chỉ kiểm tra một lần mỗi session
   * (cache theo user id + toolkit đang bật); đổi user id/key/toolkit
   * → kiểm tra lại. Kiểm tra lỗi vì mạng → fail-open (cho thực thi
   * chạy tiếp, lỗi thật của nó sẽ hiện ra; lần sau kiểm tra lại).
   */
  private async ensureConnectionsActive(items: ComposioExecuteItem[]): Promise<void> {
    const needed = [
      ...new Set(
        items
          .map((it) => toolkitForSlug(it.tool))
          .filter((t): t is string => t !== undefined),
      ),
    ];
    if (needed.length === 0) return;
    const key = `${this.userId}|${this.enabledToolkitsKey()}`;
    if (this.connectionsCheckedKey === key) return;
    let statuses: ComposioToolkitConnection[];
    try {
      statuses = await this.getConnectionStatus(needed);
    } catch {
      // Kiểm tra trạng thái lỗi (mạng/session) → không chặn thực thi;
      // lần thực thi sau sẽ kiểm tra lại (không cache).
      return;
    }
    const inactive = statuses
      .filter((s) => s.status !== 'active')
      .map((s) => s.toolkit);
    if (inactive.length > 0) {
      throw new ComposioError(
        'composio_connection_inactive',
        `Chưa có kết nối Composio đang hoạt động cho: ${inactive.join(', ')}. ` +
          `Kết nối app trong dashboard Composio (dashboard.composio.dev → Auth Configs → Connect Account) rồi thử lại. ` +
          `Nếu đã kết nối mà vẫn lỗi, kiểm tra Composio user id trong Settings → Composio có khớp User ID trên dashboard không (session dùng id khác sẽ không thấy kết nối).`,
      );
    }
    this.connectionsCheckedKey = key;
  }

  /** Thực thi một/nhiều tool qua COMPOSIO_MULTI_EXECUTE_TOOL (tối đa 50/call). */
  async executeTools(items: ComposioExecuteItem[]): Promise<string> {
    try {
      // v0.89c: kiểm tra connection Active trước lần thực thi đầu
      // tiên của session (chỉ toolkit lần này cần; đã cache thì bỏ
      // qua). Kiểm tra trước khi lấy callTool: nếu kiểm tra lỗi vì
      // mạng làm mất session thì lần lấy sau tạo lại mới (fail-open).
      await this.ensureConnectionsActive(items);
      const callTool = await this.ensureCallTool();
      return await this.routerFor().executeTools(items, callTool);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /**
   * Router hiện tại (đã gắn key). Chỉ gọi được sau ensureCallTool —
   * router luôn tồn tại lúc đó; gọi ngoài thì lỗi rõ thay vì null.
   */
  private routerFor(): ComposioToolRouter {
    if (!this.router) {
      throw new ComposioError(
        'composio_session_failed',
        'Chưa có Composio session — gọi tool Composio lần đầu để tạo session.',
      );
    }
    return this.router;
  }

  /** Lọc key khỏi error trước khi ném ra ngoài (mọi đường đều qua đây). */
  private wrapError(err: unknown): Error {
    if (err instanceof ComposioError) {
      // Router đã lọc key bằng key của nó — lọc lại bằng key hiện tại
      // cho chắc (key có thể đã đổi giữa chừng), không đổi code.
      const clean = redactComposioKey(err.message, this.routerKey);
      return clean === err.message
        ? err
        : new ComposioError(err.code, clean);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new ComposioError(
      'composio_session_failed',
      redactComposioKey(`Composio thất bại: ${message}`, this.routerKey),
    );
  }

  /**
   * Đọc key (fail-closed khi thiếu/không đọc được), đổi router khi
   * key đổi, trả hàm `callTool` cho router dùng. Hai call đồng thời
   * chờ chung một lần nối (`connecting`).
   */
  private async ensureCallTool(): Promise<
    (toolName: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>
  > {
    const toolkitsKey = this.enabledToolkitsKey();
    if (this.client && this.session && this.sessionToolkitsKey === toolkitsKey) {
      return this.callToolFn(this.client);
    }
    if (this.connecting) {
      const client = await this.connecting;
      return this.callToolFn(client);
    }
    const connecting = this.connectSession(toolkitsKey);
    this.connecting = connecting;
    try {
      const client = await connecting;
      return this.callToolFn(client);
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  /** Toolkit đang bật (đã sắp xếp, lọc rỗng) — nguồn cho session + kiểm tra connection. */
  private enabledToolkits(): string[] {
    let toolkits: string[];
    try {
      toolkits = this.getEnabledToolkitsFn() ?? [];
    } catch {
      toolkits = [];
    }
    return [...new Set(toolkits.filter((t) => typeof t === 'string' && t.trim()))].sort();
  }

  private enabledToolkitsKey(): string {
    return this.enabledToolkits().join(',');
  }

  /** Bọc MCP client thành `ComposioCallToolFn` (map 'MCP tool error:' → isError). */
  private callToolFn(
    client: ComposioMcpClientLike,
  ): (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }> {
    return async (toolName, args) => {
      let text: string;
      try {
        text = await client.callTool(toolName, args);
      } catch (err) {
        // Lỗi transport — client có thể đã chết: huỷ cache để lần gọi
        // SAU nối lại mới. Không retry call này (tránh thực thi trùng).
        await this.invalidate();
        throw err;
      }
      return { text, isError: text.startsWith('MCP tool error:') };
    };
  }

  /** Tạo session REST + nối MCP client (chạy một lần nhờ `connecting`). */
  private async connectSession(toolkitsKey: string): Promise<ComposioMcpClientLike> {
    let apiKey: string | null;
    try {
      apiKey = this.getApiKeyFn();
    } catch {
      throw new ComposioError(
        'composio_key_missing',
        'Không đọc được Composio API key trong Vault — nhập key miễn phí của bạn trong Settings → Composio rồi thử lại.',
      );
    }
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new ComposioError(
        'composio_key_missing',
        'Chưa cấu hình Composio API key — nhập key miễn phí của bạn trong Settings → Composio rồi thử lại. (Key lưu trong Vault, không gửi đi đâu khác.)',
      );
    }
    const key = apiKey.trim();
    try {
      if (!this.router || this.routerKey !== key) {
        this.router = new ComposioToolRouter({
          apiKey: key,
          ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        });
        this.routerKey = key;
      }
      // Key đổi hoặc toolkit đổi → session cũ không còn đúng nữa.
      if (this.session && this.sessionToolkitsKey !== toolkitsKey) {
        await this.invalidate();
      }
      if (this.client && this.session) {
        return this.client;
      }
      const toolkits = toolkitsKey ? toolkitsKey.split(',') : [];
      const session = await this.router.createSession({ userId: this.userId, toolkits });
      this.createdSessions += 1;
      const config = this.router.buildMcpConfig(session);
      const client = await this.createMcpClientFn(config);
      this.session = session;
      this.sessionToolkitsKey = toolkitsKey;
      this.client = client;
      return client;
    } catch (err) {
      // Lỗi tạo session/nối MCP: không giữ client nửa vời.
      if (err instanceof ComposioError) throw err;
      throw new ComposioError(
        'composio_session_failed',
        redactComposioKey(
          `Không tạo được Composio session: ${err instanceof Error ? err.message : String(err)}`,
          key,
        ),
      );
    }
  }
}

export interface CreateComposioMetaToolsDeps {
  /** Session manager dùng chung của tiến trình coordinator (cache session/MCP client). */
  manager: ComposioSessionManager;
}

function requireQuery(args: Record<string, unknown>): string {
  const query = args['query'];
  if (typeof query !== 'string' || !query.trim()) {
    throw new ComposioError(
      'composio_session_failed',
      'COMPOSIO_SEARCH_TOOLS cần `query` là chuỗi mô tả task, không rỗng.',
    );
  }
  return query.trim();
}

/** Toolkit từ prefix slug tool (vd 'GITHUB_CREATE_AN_ISSUE' → 'github'); lạ → undefined. */
function toolkitForSlug(slug: string): string | undefined {
  const prefix = slug.split('_')[0]?.toLowerCase() ?? '';
  return (COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(prefix) ? prefix : undefined;
}

/** Chuẩn hoá status thô từ MANAGE_CONNECTIONS về 3 trạng thái. */
function toConnectionStatus(raw: unknown): ComposioConnectionStatus {
  if (raw === 'active') return 'active';
  if (raw === 'initiated') return 'initiated';
  return 'none';
}

/**
 * Nhãn tài khoản từ `current_user_info` của MANAGE_CONNECTIONS
 * (GitHub `login` / Gmail `email` / Slack `team` / `name`).
 */
function accountLabelFromUserInfo(info: unknown): string | undefined {
  if (!isRecord(info)) return undefined;
  for (const key of ['login', 'email', 'team', 'name']) {
    const v = info[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Parse output COMPOSIO_MANAGE_CONNECTIONS thành map toolkit → entry.
 * Shape thật: {successful, data: {results: {<toolkit>: {status,
 * connected_account_id, current_user_info, ...}}}} (có thể stringify
 * 2 lần qua MCP). Trả {} khi không parse được (caller coi là 'none').
 */
function parseManageConnectionsResults(text: string): Record<string, Record<string, unknown>> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
    // MCP đôi khi trả JSON đã stringify 2 lần: lần parse đầu ra
    // string thì parse tiếp một lần nữa.
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch {
    return {};
  }
  const data = isRecord(parsed) ? parsed['data'] : null;
  const results = isRecord(data) ? data['results'] : null;
  if (!isRecord(results)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [toolkit, entry] of Object.entries(results)) {
    if (isRecord(entry)) out[toolkit] = entry;
  }
  return out;
}

/**
 * Slug cần lấy schema: chấp nhận `tools: [...]` (chuẩn), `slugs:
 * [...]`, hoặc `tool`/`slug` đơn lẻ — chuẩn hoá hết về mảng slug
 * trước khi gọi meta-tool (tha thứ đầu vào, nghiêm đầu ra).
 */
function requireSlugs(args: Record<string, unknown>): string[] {
  const raw = args['tools'] ?? args['slugs'] ?? args['tool'] ?? args['slug'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const slugs = list.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  if (slugs.length === 0) {
    throw new ComposioError(
      'composio_session_failed',
      'COMPOSIO_GET_TOOL_SCHEMAS cần `tools` là mảng slug tool (vd ["GMAIL_SEND_EMAIL"]), không rỗng.',
    );
  }
  return slugs.map((s) => s.trim());
}

/** Item `tools[]` của COMPOSIO_MULTI_EXECUTE_TOOL — validate ở tool, router chặn lại lần nữa. */
function requireExecuteItems(args: Record<string, unknown>): ComposioExecuteItem[] {
  const raw = args['tools'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ComposioError(
      'composio_session_failed',
      'COMPOSIO_MULTI_EXECUTE_TOOL cần `tools` là mảng không rỗng, mỗi item có `tool_slug` (slug, alias `tool`) + `arguments` (object).',
    );
  }
  // Chặn ở tool (trước khi tạo session/gọi mạng), router chặn lại lần
  // nữa làm backstop — lỗi validate không được tốn một session.
  if (raw.length > 50) {
    throw new ComposioError(
      'composio_session_failed',
      'COMPOSIO_MULTI_EXECUTE_TOOL chạy tối đa 50 tool mỗi call — chia nhỏ batch.',
    );
  }
  const items: ComposioExecuteItem[] = [];
  for (const entry of raw) {
    // Live test thật v0.72: inputSchema thật của MULTI_EXECUTE gọi
    // field slug là `tool_slug`; chấp nhận cả `tool_slug` (mới) lẫn
    // `tool` (cũ, model/tool cũ dùng) ở đầu vào — router dịch về
    // `tool_slug` khi gửi lên wire.
    if (!isRecord(entry)) {
      throw new ComposioError(
        'composio_session_failed',
        'Mỗi tool Composio cần `tool_slug` (hoặc `tool`) là slug không rỗng.',
      );
    }
    const slug =
      (typeof entry['tool_slug'] === 'string' && entry['tool_slug'].trim()) ||
      (typeof entry['tool'] === 'string' && entry['tool'].trim()) ||
      '';
    if (!slug) {
      throw new ComposioError(
        'composio_session_failed',
        'Mỗi tool Composio cần `tool_slug` (hoặc `tool`) là slug không rỗng.',
      );
    }
    const argsValue = entry['arguments'];
    if (argsValue !== undefined && !isRecord(argsValue)) {
      throw new ComposioError(
        'composio_session_failed',
        `Tool "${slug}" cần \`arguments\` là object.`,
      );
    }
    const item: ComposioExecuteItem = {
      tool: slug,
      arguments: isRecord(argsValue) ? argsValue : {},
    };
    if (typeof entry['account'] === 'string' && entry['account'].trim()) {
      item.account = (entry['account'] as string).trim();
    }
    items.push(item);
  }
  return items;
}

/**
 * 3 meta-tool runnable cho model. Mỗi execute đi qua session manager
 * dùng chung (lazy session + cache MCP client); mọi error đã qua
 * `redactComposioKey` trong manager/router nên tool chỉ việc ném tiếp
 * — không log, không crash turn khi Composio tắt/mất mạng/hết key.
 *
 * needsApproval: SEARCH + GET_SCHEMAS = false (chỉ đọc/discovery);
 * MULTI_EXECUTE = true (thực thi — có thể ghi mail/issue/tin nhắn).
 * Cap M7 + filterTools áp dụng ở loop như tool local (app 'composio'
 * trong AppRegistry) — tool ở đây không tự cắt/lọc.
 */
export function createComposioMetaTools(deps: CreateComposioMetaToolsDeps): Tool[] {
  const { manager } = deps;
  return [
    {
      definition: {
        name: COMPOSIO_SEARCH_TOOL,
        description:
          'Tìm tool Composio phù hợp với mô tả task (discovery động qua Tool Router). Trả danh sách slug + execution plan; dùng trước khi thực thi.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Mô tả task bằng ngôn ngữ tự nhiên, vd "gửi mail cho Lan" hay "tạo issue GitHub".',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      needsApproval: false,
      async execute(args) {
        return manager.searchTools(requireQuery(args));
      },
    },
    {
      definition: {
        name: COMPOSIO_GET_TOOL_SCHEMAS,
        description:
          'Lấy input schema đầy đủ của slug tool Composio đã tìm được (để biết đúng tên field + kiểu dữ liệu trước khi thực thi).',
        parameters: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Slug tool cần lấy schema, vd ["GMAIL_SEND_EMAIL"].',
            },
          },
          required: ['tools'],
          additionalProperties: false,
        },
      },
      needsApproval: false,
      async execute(args) {
        return manager.getToolSchemas(requireSlugs(args));
      },
    },
    {
      definition: {
        name: COMPOSIO_MULTI_EXECUTE_TOOL,
        description:
          'Thực thi một hoặc nhiều tool Composio đã tìm được (tối đa 50 tool/call). Mỗi item gồm slug tool + arguments lồng nhau; dùng sau khi đã search + lấy schema.',
        parameters: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  // Live v0.72: schema thật gọi field này là `tool_slug`;
                  // giữ `tool` làm alias để tool cũ/model cũ vẫn gọi được.
                  tool_slug: { type: 'string', description: 'Slug tool Composio, vd "GMAIL_SEND_EMAIL".' },
                  tool: { type: 'string', description: 'Alias của tool_slug (tương thích cũ).' },
                  arguments: {
                    type: 'object',
                    description: 'Argument của tool (object, vd {"recipient_email": "lan@example.com"}).',
                  },
                  account: {
                    type: 'string',
                    description: 'Tài khoản cần dùng khi user có nhiều connected account cùng app (không bắt buộc).',
                  },
                },
                required: ['arguments'],
                additionalProperties: false,
              },
            },
          },
          required: ['tools'],
          additionalProperties: false,
        },
      },
      needsApproval: true,
      async execute(args) {
        return manager.executeTools(requireExecuteItems(args));
      },
    },
  ];
}
