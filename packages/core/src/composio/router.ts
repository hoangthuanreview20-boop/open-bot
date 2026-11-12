/**
 * Composio — Tool Router client (v0.57, tự viết, KHÔNG dùng SDK Composio).
 *
 * Transport ưu tiên: MCP Tool Router tái dùng MCP client đã có
 * (`connectMcp`, Streamable HTTP) — xem `buildMcpConfig()`. Router này
 * chỉ lo phần REST tạo session + gọi meta-tool qua một `callTool`
 * tiêm vào (host nối `connectMcp` client thật; test tiêm mock).
 * KHÔNG thêm dependency `@composio/*`.
 *
 * Endpoint/auth đã dùng (docs.composio.dev/llms-full.txt, đọc 2026-11-09):
 *  - Tạo session: `POST {base}/tool_router/session`, header
 *    `x-api-key: <COMPOSIO_API_KEY>`, body
 *    `{"user_id": "<user>", "toolkits": {"enable": [...]}}` → response có
 *    `session_id` + `mcp: { url, headers }`. LƯU Ý (live test thật
 *    v0.72): `toolkits` trên wire là OBJECT policy `{enable: [...]}`
 *    (docs.composio.dev "Configuring sessions"), KHÔNG phải mảng
 *    string — mảng string bị server trả HTTP 400
 *    `Error in payload.toolkits: Invalid input`. SDK `create()` nhận
 *    mảng string rồi tự dịch sang object này; router tự viết phải gửi
 *    đúng dạng object.
 *  - Liệt kê tool của session: `GET {base}/tool_router/session/{id}/tools?limit=&cursor=`
 *    → `{ items: [{ slug, description, input_parameters }], next_cursor }`.
 *  - MCP URL presigned: live v0.72 thấy dạng
 *    `https://backend.composio.dev/tool_router/<session_id>/mcp`
 *    (dạng `https://mcp.composio.dev/tool-router/<id>` cũng gặp trong
 *    tài liệu) — code KHÔNG tự dựng URL mà dùng đúng `mcp.url`
 *    server trả về.
 *  - Meta-tool gọi qua MCP: COMPOSIO_SEARCH_TOOLS (tìm slug theo task),
 *    COMPOSIO_MULTI_EXECUTE_TOOL (thực thi, `tools[]` mỗi item mang
 *    `arguments` lồng nhau + `account` khi nhiều tài khoản).
 *
 * An toàn:
 *  - Key thiếu → `ComposioError('composio_key_missing')`, lỗi sạch, không crash.
 *  - Mọi error message đều qua `sanitizeComposioError` (lọc key) trước khi ném.
 *  - `mcp.url` phải là https trên `*.composio.dev`, trừ loopback
 *    (http://127.0.0.1 / localhost) chỉ cho mock test local — URL lạ bị từ chối.
 *  - Session URL là secret (presigned, chứa credential nhúng): không log,
 *    không đưa vào error message.
 */

import {
  COMPOSIO_API_BASE_URL,
  COMPOSIO_GET_TOOL_SCHEMAS,
  COMPOSIO_MCP_HOST_SUFFIX,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_SEARCH_TOOL,
  ComposioError,
  type ComposioCallToolFn,
  type ComposioExecuteItem,
  type ComposioSession,
  type ComposioSessionToolRef,
  type CreateComposioSessionOptions,
} from './types';
import { redactComposioKey } from './keyStore';

export type ComposioFetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface ComposioToolRouterOptions {
  /** Composio API key của user (đọc từ Vault — không hard-code). */
  apiKey?: string | null;
  /** REST base — mặc định v3.1; test trỏ sang mock server local. */
  baseUrl?: string;
  /** Fetch tiêm được (mặc định global fetch). */
  fetchFn?: ComposioFetchFn;
}

function defaultFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; text: () => Promise<string> }> {
  return fetch(url, init).then(async (res) => ({
    status: res.status,
    text: async () => res.text(),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * MCP URL có đáng tin không: https trên *.composio.dev, hoặc loopback
 * http (chỉ cho mock test local). Mọi host khác → từ chối (chống SSRF
 * qua session URL giả).
 */
export function isTrustedComposioMcpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') {
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }
  return parsed.protocol === 'https:' && host.endsWith(COMPOSIO_MCP_HOST_SUFFIX);
}

export class ComposioToolRouter {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly fetchFn: ComposioFetchFn;

  constructor(opts: ComposioToolRouterOptions = {}) {
    const key = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    this.apiKey = key ? key : null;
    this.baseUrl = (opts.baseUrl ?? COMPOSIO_API_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? defaultFetch;
  }

  /** Đã có key chưa (chỉ boolean — không lộ key). */
  hasApiKey(): boolean {
    return this.apiKey !== null;
  }

  private sanitize(message: string): string {
    return redactComposioKey(message, this.apiKey);
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new ComposioError(
        'composio_key_missing',
        'Chưa cấu hình Composio API key — nhập key miễn phí của bạn trong Settings → Composio rồi thử lại. (Key lưu trong Vault, không gửi đi đâu khác.)',
      );
    }
    return this.apiKey;
  }

  private async requestJson(
    path: string,
    init: { method: string; body?: string },
  ): Promise<{ status: number; json: unknown }> {
    const apiKey = this.requireApiKey();
    let res: { status: number; text: () => Promise<string> };
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (err) {
      throw new ComposioError(
        'composio_session_failed',
        this.sanitize(
          `Không kết nối được tới Composio (${this.baseUrl}): ${(err as Error).message}. ` +
            'Kiểm tra mạng — app local (M7) vẫn chạy bình thường.',
        ),
      );
    }
    const text = await res.text().catch(() => '');
    if (res.status < 200 || res.status >= 300) {
      // Body lỗi có thể echo lại request — lọc key trước khi đưa vào message.
      const hint = text ? this.sanitize(text.slice(0, 300)) : '';
      throw new ComposioError(
        'composio_http_error',
        `Composio trả HTTP ${res.status} cho ${path}${hint ? `: ${hint}` : ''}.`,
      );
    }
    try {
      return { status: res.status, json: JSON.parse(text) as unknown };
    } catch {
      throw new ComposioError(
        'composio_invalid_response',
        `Composio trả response không phải JSON cho ${path}.`,
      );
    }
  }

  /**
   * Tạo Tool Router session cho user + toolkit đã bật.
   * Response kỳ vọng: `{ session_id, mcp: { url, headers } }`
   * (chấp nhận biến thể `mcp_url` / `url` ở top-level để tương thích
   * SDK cũ). `mcp.url` KHÔNG đáng tin → lỗi, không dùng.
   */
  async createSession(opts: CreateComposioSessionOptions): Promise<ComposioSession> {
    if (!opts.userId || typeof opts.userId !== 'string') {
      throw new ComposioError('composio_session_failed', 'Tạo Composio session cần userId không rỗng.');
    }
    const toolkits = [...(opts.toolkits ?? [])];
    // Live test thật v0.72: wire shape là policy object
    // `{toolkits: {enable: [...]}}` (docs "Configuring sessions") —
    // mảng string thẳng bị server trả HTTP 400 Invalid input.
    const { json } = await this.requestJson('/tool_router/session', {
      method: 'POST',
      body: JSON.stringify({
        user_id: opts.userId,
        ...(toolkits.length > 0 ? { toolkits: { enable: toolkits } } : {}),
      }),
    });
    if (!isRecord(json)) {
      throw new ComposioError('composio_invalid_response', 'Composio trả session không phải object.');
    }
    const sessionId =
      typeof json['session_id'] === 'string'
        ? (json['session_id'] as string)
        : typeof json['id'] === 'string'
          ? (json['id'] as string)
          : '';
    const mcp = isRecord(json['mcp']) ? json['mcp'] : null;
    const mcpUrl =
      (mcp && typeof mcp['url'] === 'string' ? (mcp['url'] as string) : '') ||
      (typeof json['mcp_url'] === 'string' ? (json['mcp_url'] as string) : '') ||
      (typeof json['url'] === 'string' ? (json['url'] as string) : '');
    if (!sessionId || !mcpUrl) {
      throw new ComposioError(
        'composio_invalid_response',
        'Composio trả session thiếu session_id hoặc mcp.url.',
      );
    }
    if (!isTrustedComposioMcpUrl(mcpUrl)) {
      throw new ComposioError(
        'composio_invalid_mcp_url',
        'Composio trả MCP URL không nằm trên *.composio.dev — từ chối để tránh SSRF.',
      );
    }
    const headers = mcp && isRecord(mcp['headers']) ? (mcp['headers'] as Record<string, unknown>) : {};
    const mcpHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') mcpHeaders[k] = v;
    }
    return { sessionId, userId: opts.userId, mcpUrl, mcpHeaders, toolkits };
  }

  /**
   * Liệt kê tool của session (REST, phân trang bằng cursor).
   * Trả `{ items, nextCursor }`; item có slug/description/input_parameters.
   */
  async listSessionTools(
    sessionId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: ComposioSessionToolRef[]; nextCursor?: string }> {
    if (!sessionId) {
      throw new ComposioError('composio_session_failed', 'Liệt kê tool Composio cần sessionId.');
    }
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit ?? 500));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const { json } = await this.requestJson(
      `/tool_router/session/${encodeURIComponent(sessionId)}/tools?${params.toString()}`,
      { method: 'GET' },
    );
    if (!isRecord(json) || !Array.isArray(json['items'])) {
      throw new ComposioError('composio_invalid_response', 'Composio trả danh sách tool sai định dạng.');
    }
    const items: ComposioSessionToolRef[] = [];
    for (const raw of json['items'] as unknown[]) {
      if (!isRecord(raw) || typeof raw['slug'] !== 'string') continue;
      const ref: ComposioSessionToolRef = { slug: raw['slug'] as string };
      if (typeof raw['description'] === 'string') ref.description = raw['description'] as string;
      if (isRecord(raw['input_parameters'])) {
        ref.inputParameters = raw['input_parameters'] as Record<string, unknown>;
      }
      items.push(ref);
    }
    const out: { items: ComposioSessionToolRef[]; nextCursor?: string } = { items };
    if (typeof json['next_cursor'] === 'string' && json['next_cursor']) {
      out.nextCursor = json['next_cursor'] as string;
    }
    return out;
  }

  /**
   * Config MCP cho `connectMcp` (tái dùng client đã có, Streamable HTTP).
   * Header lấy đúng từ session (`session.mcp.headers`); khi session
   * không kèm header thì dùng `x-api-key` (MCP client không log header).
   * URL presigned là secret — caller không log config này.
   */
  buildMcpConfig(session: ComposioSession): {
    name: string;
    url: string;
    headers: Record<string, string>;
  } {
    const headers =
      Object.keys(session.mcpHeaders).length > 0
        ? { ...session.mcpHeaders }
        : { 'x-api-key': this.requireApiKey() };
    return { name: 'composio-tool-router', url: session.mcpUrl, headers };
  }

  /**
   * Tìm tool theo mô tả task qua COMPOSIO_SEARCH_TOOLS.
   * Trả text thô của meta-tool (danh sách slug + execution plan) để
   * caller/model đọc; `isError` thì ném lỗi rõ ràng (không crash).
   */
  async searchTools(query: string, callTool: ComposioCallToolFn): Promise<string> {
    if (!query || typeof query !== 'string') {
      throw new ComposioError('composio_session_failed', 'Tìm tool Composio cần câu mô tả task.');
    }
    let out: { text: string; isError: boolean };
    try {
      out = await callTool(COMPOSIO_SEARCH_TOOL, { query });
    } catch (err) {
      throw new ComposioError(
        'composio_session_failed',
        this.sanitize(`COMPOSIO_SEARCH_TOOLS thất bại: ${(err as Error).message}`),
      );
    }
    if (out.isError) {
      throw new ComposioError('composio_session_failed', `COMPOSIO_SEARCH_TOOLS báo lỗi: ${out.text}`);
    }
    return out.text;
  }

  /**
   * Lấy input schema đầy đủ của slug đã tìm được qua
   * COMPOSIO_GET_TOOL_SCHEMAS. Trả text thô của meta-tool để
   * caller/model đọc; `isError` thì ném lỗi rõ ràng (không crash).
   *
   * Shape argument ĐÃ XÁC NHẬN bằng live test thật (v0.72):
   * `{ tool_slugs: [<slug>, ...] }` — shape `{ tools: [...] }` suy
   * đoán ở v0.58 bị server từ chối (`Validation error: Required at
   * "tool_slugs"`). Tool vẫn chấp nhận cả `tools` / `slugs` / `tool`
   * đơn lẻ ở ĐẦU VÀO (model gọi lệch được tha thứ), nhưng wire gửi
   * đi luôn là `tool_slugs`.
   */
  async getToolSchemas(slugs: string[], callTool: ComposioCallToolFn): Promise<string> {
    if (!Array.isArray(slugs) || slugs.length === 0) {
      throw new ComposioError(
        'composio_session_failed',
        'Lấy schema Composio cần ít nhất một slug tool.',
      );
    }
    for (const slug of slugs) {
      if (!slug || typeof slug !== 'string') {
        throw new ComposioError('composio_session_failed', 'Mỗi slug Composio phải là chuỗi không rỗng.');
      }
    }
    let out: { text: string; isError: boolean };
    try {
      out = await callTool(COMPOSIO_GET_TOOL_SCHEMAS, { tool_slugs: [...slugs] });
    } catch (err) {
      throw new ComposioError(
        'composio_session_failed',
        this.sanitize(`COMPOSIO_GET_TOOL_SCHEMAS thất bại: ${(err as Error).message}`),
      );
    }
    if (out.isError) {
      throw new ComposioError(
        'composio_session_failed',
        `COMPOSIO_GET_TOOL_SCHEMAS báo lỗi: ${out.text}`,
      );
    }
    return out.text;
  }

  /**
   * Thực thi một hoặc nhiều tool qua COMPOSIO_MULTI_EXECUTE_TOOL.
   * Mỗi item: `{ tool_slug: <slug>, arguments: {...} }` (arguments lồng
   * nhau theo hợp đồng Tool Router; `account` khi nhiều tài khoản).
   * Trả text thô của meta-tool (structured output gộp của các call).
   *
   * LƯU Ý (live test thật v0.72): wire field là `tool_slug` — gửi
   * `tool` bị server từ chối (`Validation error: Required at
   * "tools[0].tool_slug"`). Field TS nội bộ vẫn tên `tool`
   * (ComposioExecuteItem); router dịch sang `tool_slug` khi gửi.
   */
  async executeTools(items: ComposioExecuteItem[], callTool: ComposioCallToolFn): Promise<string> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ComposioError('composio_session_failed', 'Thực thi Composio cần ít nhất một tool.');
    }
    if (items.length > 50) {
      throw new ComposioError(
        'composio_session_failed',
        'COMPOSIO_MULTI_EXECUTE_TOOL chạy tối đa 50 tool mỗi call — chia nhỏ batch.',
      );
    }
    for (const item of items) {
      if (!item || typeof item.tool !== 'string' || !item.tool) {
        throw new ComposioError('composio_session_failed', 'Mỗi tool Composio cần slug không rỗng.');
      }
      if (!isRecord(item.arguments)) {
        throw new ComposioError(
          'composio_session_failed',
          `Tool "${item.tool}" cần arguments là object.`,
        );
      }
    }
    let out: { text: string; isError: boolean };
    try {
      out = await callTool(COMPOSIO_MULTI_EXECUTE_TOOL, {
        tools: items.map((item) => ({
          tool_slug: item.tool,
          arguments: item.arguments,
          ...(item.account ? { account: item.account } : {}),
        })),
      });
    } catch (err) {
      throw new ComposioError(
        'composio_session_failed',
        this.sanitize(`COMPOSIO_MULTI_EXECUTE_TOOL thất bại: ${(err as Error).message}`),
      );
    }
    if (out.isError) {
      throw new ComposioError('composio_session_failed', `COMPOSIO_MULTI_EXECUTE_TOOL báo lỗi: ${out.text}`);
    }
    return out.text;
  }

  /** Tiện ích: thực thi đúng một tool. */
  async executeTool(
    slug: string,
    args: Record<string, unknown>,
    callTool: ComposioCallToolFn,
  ): Promise<string> {
    return this.executeTools([{ tool: slug, arguments: args }], callTool);
  }
}
