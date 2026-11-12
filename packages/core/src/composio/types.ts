/**
 * Composio — kiểu chung + hằng số (v0.57, tích hợp tối thiểu đã duyệt).
 *
 * Nguồn (đọc 2026-11-09, KHÔNG sao chép code/text từ Composio):
 *  - docs.composio.dev/llms-full.txt — REST v3.1, Tool Router sessions,
 *    7 meta-tool, `POST /api/v3.1/tools/execute/{slug}`.
 *  - composio.dev — hướng dẫn Tool Router theo framework (ADK/Mastra/
 *    Claude Code): `composio.create(userId, { toolkits })` trả
 *    `session.mcp.url` + `session.mcp.headers`.
 *  - composio.dev/content/how-composio-rebuilt-credential-security-after-may-2026
 *    + blog/composio-may-2026-security-incident (cập nhật 16/09/2026).
 *
 * Thiết kế (xem docs/composio-integration.md): Composio là MỘT nguồn
 * app nữa cắm SAU AppRegistry của M7, mặc định TẮT, opt-in. Transport
 * ưu tiên MCP Tool Router tái dùng `connectMcp` đã có — KHÔNG dùng SDK
 * Composio (không thêm dependency), KHÔNG viết MCP client mới. Tool
 * Composio đi qua AppRegistry để cap M7 + filterTools áp dụng chung —
 * không có đường tool song song.
 *
 * Key Composio là key MIỄN PHÍ của chính người dùng, lưu trong Vault
 * (namespace 'provider', key 'composio') như provider key khác —
 * KHÔNG vào code, KHÔNG vào log, KHÔNG gửi đi đâu ngoài tài khoản
 * Composio của chính người dùng. Mọi error message đều được lọc key
 * trước khi ném (xem router.ts `sanitizeComposioError`).
 */

/**
 * REST base của Composio (v3.1 — bản mới nhất theo llms-full.txt;
 * v3 vẫn hỗ trợ nhưng đóng băng với pinned tool-version defaults).
 */
export const COMPOSIO_API_BASE_URL = 'https://backend.composio.dev/api/v3.1';

/** Host MCP của Tool Router (URL presigned dạng https://mcp.composio.dev/tool-router/<session_id>). */
export const COMPOSIO_MCP_HOST_SUFFIX = '.composio.dev';

/**
 * 7 meta-tool mà một Tool Router session expose (theo docs chính thức):
 * search → schemas → execute; manage/wait connections; workbench/bash
 * remote. Agent chỉ gọi các meta-tool này; slug cụ thể của app (vd
 * GMAIL_SEND_EMAIL) là ARGUMENT của COMPOSIO_MULTI_EXECUTE_TOOL, không
 * phải tool riêng. COMPOSIO_MULTI_EXECUTE_TOOL chạy tối đa 50 tool
 * song song mỗi call; mỗi item trong `tools[]` mang `arguments` lồng
 * nhau + `account` khi nhiều tài khoản.
 */
export const COMPOSIO_META_TOOLS: readonly string[] = [
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MULTI_EXECUTE_TOOL',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
  'COMPOSIO_REMOTE_WORKBENCH',
  'COMPOSIO_REMOTE_BASH_TOOL',
] as const;

/** Meta-tool dùng cho discovery (tìm slug theo mô tả task). */
export const COMPOSIO_SEARCH_TOOL = 'COMPOSIO_SEARCH_TOOLS';
/** Meta-tool lấy input schema đầy đủ của slug đã tìm được. */
export const COMPOSIO_GET_TOOL_SCHEMAS = 'COMPOSIO_GET_TOOL_SCHEMAS';
/** Meta-tool dùng cho thực thi (một hoặc nhiều slug trong `tools[]`). */
export const COMPOSIO_MULTI_EXECUTE_TOOL = 'COMPOSIO_MULTI_EXECUTE_TOOL';
/** Meta-tool dùng để quản lý OAuth connection của app. */
export const COMPOSIO_MANAGE_CONNECTIONS_TOOL = 'COMPOSIO_MANAGE_CONNECTIONS';

/** Mã lỗi của lớp Composio — message kèm theo KHÔNG bao giờ chứa key. */
export type ComposioErrorCode =
  | 'composio_disabled'
  | 'composio_key_missing'
  | 'composio_session_failed'
  | 'composio_http_error'
  | 'composio_invalid_response'
  | 'composio_invalid_mcp_url'
  | 'composio_unknown_toolkit'
  /**
   * v0.89c (Team E): toolkit cần thực thi chưa có connection Active
   * trong session — kiểm tra trước lần thực thi đầu tiên
   * (COMPOSIO_MANAGE_CONNECTIONS) thấy `initiated`/`none`. Lỗi này
   * kèm hướng dẫn (connect trong dashboard + kiểm tra user id),
   * thay cho lỗi "No active connection found" khó hiểu của server.
   */
  | 'composio_connection_inactive';

/**
 * v0.89c (Team E): trạng thái một toolkit trong Tool Router session
 * (theo COMPOSIO_MANAGE_CONNECTIONS). `active` = có connected
 * account đang hoạt động; `initiated` = đã bắt đầu luồng kết nối
 * nhưng chưa hoàn tất (link OAuth đang chờ, hết hạn sau 10 phút);
 * `none` = không có connection nào cho toolkit đó trong session.
 */
export type ComposioConnectionStatus = 'active' | 'initiated' | 'none';

/**
 * v0.89c (Team E): trạng thái connection của một toolkit — dữ liệu
 * duy nhất đi từ coordinator về UI/IPC. Chỉ chứa toolkit + trạng
 * thái + nhãn tài khoản đã kết nối (vd login GitHub / email Gmail /
 * tên team Slack); KHÔNG chứa user id, KHÔNG chứa link OAuth
 * (redirect_url), KHÔNG chứa key/token.
 */
export interface ComposioToolkitConnection {
  /** Slug toolkit, vd 'github'. */
  toolkit: string;
  /** Trạng thái connection trong session hiện tại. */
  status: ComposioConnectionStatus;
  /** Nhãn tài khoản đã kết nối (chỉ khi status = 'active'). */
  accountLabel?: string;
}

/** Lỗi của lớp Composio: có `code` để caller/UI phân biệt, không chứa secret. */
export class ComposioError extends Error {
  readonly code: ComposioErrorCode;
  constructor(code: ComposioErrorCode, message: string) {
    super(message);
    this.name = 'ComposioError';
    this.code = code;
  }
}

/** Một Tool Router session đã tạo (user-scoped, ngắn hạn). */
export interface ComposioSession {
  /** Id session (`session_id` trong response REST). */
  sessionId: string;
  /** User id mà session thuộc về (do host cấp, vd id user local). */
  userId: string;
  /** Presigned MCP URL của session — coi như secret (chứa credential nhúng). */
  mcpUrl: string;
  /** Header đi kèm MCP URL (thường gồm `x-api-key`). KHÔNG log. */
  mcpHeaders: Record<string, string>;
  /** Toolkit slug đã yêu cầu cho session này. */
  toolkits: string[];
}

/** Tham số tạo Tool Router session. */
export interface CreateComposioSessionOptions {
  /** User id (Composio gọi là user_id; session gắn với user này). */
  userId: string;
  /** Toolkit slug muốn mở (vd ['gmail', 'github']); rỗng = mọi toolkit đã kết nối. */
  toolkits?: string[];
}

/** Một tool trong `tools[]` của COMPOSIO_MULTI_EXECUTE_TOOL. */
export interface ComposioExecuteItem {
  /**
   * Slug tool Composio, vd 'GMAIL_SEND_EMAIL'. Tên field NỘI BỘ —
   * khi gửi lên wire, router dịch thành `tool_slug` (server thật
   * bắt buộc `tool_slug`, live test v0.72).
   */
  tool: string;
  /** Argument của tool, đặt trong object `arguments` lồng nhau. */
  arguments: Record<string, unknown>;
  /** Tài khoản cần dùng khi user có nhiều connected account cùng app. */
  account?: string;
}

/** Hàm gọi một MCP tool — host tiêm `connectMcp` client hoặc mock (test). */
export type ComposioCallToolFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; isError: boolean }>;

/** Một tool liệt kê từ `GET /tool_router/session/{id}/tools` (REST). */
export interface ComposioSessionToolRef {
  /** Slug tool, vd 'GMAIL_SEND_EMAIL'. */
  slug: string;
  /** Mô tả tool. */
  description?: string;
  /** JSON Schema tham số (trường `input_parameters` trong response). */
  inputParameters?: Record<string, unknown>;
}
