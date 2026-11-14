/**
 * MCP server — expose open-bot thành MCP server (v0.13, mục 11).
 *
 * Chỉ dùng Node stdlib, không thêm dependency, không dùng MCP SDK chính
 * thức (xem docs/mcp-sdk-evaluation.md — quyết định: chưa migrate).
 * Viết tay theo spec MCP 2025-11-25, đối xứng với client tự viết ở
 * `packages/core/src/mcp/client.ts` (cùng protocol version, cùng mã lỗi
 * JSON-RPC, cùng quy ước SEP-1303).
 *
 * Hai transport:
 *  (a) stdio — NDJSON qua stdin/stdout, một JSON object mỗi dòng.
 *      Log chỉ ra stderr, KHÔNG bao giờ ra stdout (sẽ làm hỏng stream).
 *  (b) Streamable HTTP — POST JSON-RPC tới `/mcp` (một request một
 *      response, JSON hoặc SSE tùy header Accept), GET mở SSE stream
 *      nhận thông báo từ server, DELETE đóng session.
 *
 * An toàn (mặc định khóa chặt, mở dần khi điều phối viên nối runner thật):
 *  - Chỉ expose tập tool an toàn, có allowlist cấu hình được
 *    (`allowedTools`). Tool chạy trong quyền của bot chủ — tức là chỉ
 *    những tool chỉ-đọc / không phá hoại dưới đây, cộng thêm tool do
 *    caller đăng ký tường minh qua `options.tools`.
 *  - Tool đọc file bị giam trong `workspaceDir` (chặn `..`, symlink
 *    thoát ra ngoài, giới hạn kích thước) và KHÔNG có tool ghi file,
 *    KHÔNG có tool shell — muốn mở thêm phải đăng ký tường minh và
 *    ghi vào allowlist. Điều phối viên nối tool thật của agent sau
 *    (qua `options.tools`) phải giữ nguyên nguyên tắc này.
 *  - Lỗi validate input của tool trả về tool error (`isError: true`,
 *    SEP-1303) để model tự sửa và gọi lại, không phải lỗi protocol.
 *  - Body HTTP tối đa 1 MB; server HTTP chỉ bind loopback.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import {
  buildServerDiscoverResult,
  MCP_PROTOCOL_VERSION_2026,
  parseStatelessMeta,
} from './stateless';
import {
  checkDeprecatedCapabilities,
  DeprecationShim,
  type DeprecationNotice,
} from './deprecation';
import {
  McpTaskStore,
  TaskStoreError,
  type ServerTaskHandleData,
  type McpTaskRunnerContext,
} from './taskStore';
import { McpAuditLog, summarizeMcpResult } from './auditLog';
import {
  McpNotificationHub,
  MCP_NOTIFICATION_CANCELLED,
  MCP_DEFAULT_LOG_LEVEL,
  parseMcpLogLevel,
  shouldLogMcp,
  type McpLogLevel,
  type McpLogMessage,
} from './notifications';

/** Protocol version của server này (khớp client, spec 2025-11-25). */
export const MCP_SERVER_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SERVER_PROTOCOL_VERSIONS_SUPPORTED: readonly string[] = [
  MCP_PROTOCOL_VERSION_2026,
  '2025-11-25',
  '2024-11-05',
];
export const MCP_SERVER_NAME = 'open-bot';
export const MCP_SERVER_VERSION = '0.2.0';

/** Mã lỗi JSON-RPC 2.0 chuẩn (cùng bộ mã client đã dùng). */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
/** Server chưa xong handshake `initialize` (spec: request trước initialize). */
export const JSON_RPC_NOT_INITIALIZED = -32002;

/** Body HTTP tối đa (1 MB, cùng giới hạn Local API). */
export const MCP_SERVER_MAX_BODY_BYTES = 1_048_576;
/** File đọc qua tool/resource tối đa 200.000 ký tự. */
export const MCP_SERVER_MAX_FILE_CHARS = 200_000;
/** `workspace_list_files` trả tối đa 200 mục. */
export const MCP_SERVER_MAX_LIST_FILES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

/** Kết quả một tool trả về (chuỗi là dạng gọn nhất). */
export type McpServerToolResult =
  | string
  | {
      text: string;
      /** JSON có cấu trúc kèm theo (structuredContent, spec 2025-06-18). */
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };

export type McpServerToolHandler = (
  args: Record<string, unknown>,
) => Promise<McpServerToolResult> | McpServerToolResult;

export interface McpServerToolDef {
  name: string;
  description: string;
  /** JSON Schema cho arguments (mặc định: object, không field bắt buộc). */
  inputSchema?: Record<string, unknown>;
  /** Gợi ý cho client/agent (spec 2025-06-18). Tool mặc định đều chỉ đọc. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
  handler: McpServerToolHandler;
}

/**
 * W13e: def rút gọn của một tool — chỉ tên + annotations, không
 * schema, không handler. Mount MCP của Local API đọc nó ĐỒNG BỘ
 * lúc mount để phân loại tool ghi theo annotation ngay từ đầu
 * (xem `resolveMcpMountTools`), thay vì phải đợi client gọi
 * `tools/list` mới thấy annotation.
 */
export interface McpServerToolDefinition {
  name: string;
  annotations?: McpServerToolDef['annotations'];
}

export interface McpServerResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  read: () => Promise<string> | string;
}

export interface McpServerPromptDef {
  name: string;
  description?: string;
  /** Tên các argument prompt nhận (để khai trong prompts/list). */
  arguments?: { name: string; description?: string; required?: boolean }[];
  get: (args: Record<string, string>) => Promise<
    { role: 'user' | 'assistant'; text: string }[]
  > | { role: 'user' | 'assistant'; text: string }[];
}

export interface McpServerOptions {
  /** Tên server trong serverInfo (mặc định 'open-bot'). */
  name?: string;
  version?: string;
  /** Thư mục workspace cho tool/resource đọc file. Không có thì các
   *  tool workspace bị tắt (gọi vào trả tool error rõ ràng). */
  workspaceDir?: string;
  /** Allowlist tên tool được expose. Không đặt = expose mọi tool đã
   *  đăng ký (mặc định + caller đăng ký). Đặt rỗng = không expose tool nào. */
  allowedTools?: string[];
  /** Tool bổ sung do caller đăng ký (điều phối viên nối tool thật ở đây). */
  tools?: McpServerToolDef[];
  /** Resource bổ sung (ngoài resource mặc định). */
  resources?: McpServerResourceDef[];
  /** Prompt bổ sung (ngoài prompt mặc định). */
  prompts?: McpServerPromptDef[];
  /** Ghi log server (mặc định: im lặng; stdio thì log ra stderr). */
  onLog?: (message: string) => void;
  /**
   * v0.97 (MCP 2.0): bật task store của server — `tasks/get` /
   * `tasks/cancel` / `tasks/update` được phục vụ và
   * `submitLongTask()` nhận job chạy nền. Mặc định bật: store trống
   * thì không tốn gì, và client cũ không gọi các method này.
   */
  tasksEnabled?: boolean;
  /**
   * v1.02 (protocol stack): audit log every request this server
   * answers (method, tool, redacted args, outcome, duration). Not
   * set = no audit. The log redacts secrets itself, so passing it
   * here is safe. Not serializable — injected at runtime.
   */
  auditLogger?: McpAuditLog;
  /**
   * v1.02: notification hub for server-initiated notifications
   * (`notifications/*_list_changed`, `notifications/message`,
   * `notifications/cancelled`). Not set = the server creates its own
   * hub (accessible via the `notificationHub` getter).
   */
  notificationHub?: McpNotificationHub;
  /**
   * v1.02: caller label written into audit entries (e.g. the bot id
   * the request runs for). Defaults to the server name.
   */
  caller?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Giải quyết đường dẫn `rel` bên trong workspace: chặn `..`, đường
 * dẫn tuyệt đối, và symlink thoát ra ngoài. Trả null khi không hợp lệ.
 */
export function resolveWorkspacePath(
  workspaceDir: string,
  rel: string,
): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (path.isAbsolute(rel)) return null;
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.existsSync(resolved)
      ? fs.realpathSync(resolved)
      : path.resolve(realRoot, path.relative(root, resolved));
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  } catch {
    return null;
  }
  return resolved;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Tool mặc định — tập an toàn, chỉ đọc. Không có ghi file, không shell,
 * không mạng, không chạy code. Tool nào cần workspace mà không có
 * `workspaceDir` thì trả tool error rõ ràng thay vì crash.
 */
export function createDefaultMcpServerTools(
  workspaceDir: string | undefined,
  serverName: string,
): McpServerToolDef[] {
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
  const needWorkspace = (): string => {
    if (!workspaceDir) {
      throw new Error(
        'Tool này cần workspaceDir — server MCP này chạy không gắn workspace.',
      );
    }
    return workspaceDir;
  };
  return [
    {
      name: 'bot_info',
      description: 'Thông tin về open-bot server này (tên, phiên bản, protocol, số tool đang expose).',
      inputSchema: objectSchema({}),
      annotations: { ...readOnly, title: 'Thông tin bot' },
      handler: () => JSON.stringify(
        { name: serverName, version: MCP_SERVER_VERSION, protocolVersion: MCP_SERVER_PROTOCOL_VERSION },
        null,
        2,
      ),
    },
    {
      name: 'time_now',
      description: 'Giờ hiện tại của máy chủ (ISO 8601, UTC).',
      inputSchema: objectSchema({}),
      annotations: { ...readOnly, title: 'Giờ hiện tại' },
      handler: () => new Date().toISOString(),
    },
    {
      name: 'echo',
      description: 'Trả lại đúng đoạn text đã nhận (kiểm tra kết nối tool).',
      inputSchema: objectSchema(
        { message: { type: 'string', description: 'Đoạn text cần trả lại.' } },
        ['message'],
      ),
      annotations: { ...readOnly, title: 'Echo' },
      handler: (args) => {
        const message = args['message'];
        if (typeof message !== 'string' || message.length === 0) {
          throw new Error('Tham số "message" phải là chuỗi không rỗng.');
        }
        return message;
      },
    },
    {
      name: 'workspace_list_files',
      description: 'Liệt kê file/thư mục trong workspace (tối đa 200 mục, chỉ đọc).',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Thư mục con trong workspace (mặc định: gốc workspace).' },
      }),
      annotations: { ...readOnly, title: 'Liệt kê file workspace' },
      handler: (args) => {
        const dir = needWorkspace();
        const rel = typeof args['path'] === 'string' ? args['path'] : '.';
        const target = resolveWorkspacePath(dir, rel);
        if (!target) throw new Error(`Đường dẫn "${rel}" nằm ngoài workspace, không được phép.`);
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          throw new Error(`Không có thư mục "${rel}" trong workspace.`);
        }
        const entries = fs.readdirSync(target, { withFileTypes: true });
        const lines = entries.slice(0, MCP_SERVER_MAX_LIST_FILES).map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );
        if (entries.length > MCP_SERVER_MAX_LIST_FILES) {
          lines.push(`… và ${entries.length - MCP_SERVER_MAX_LIST_FILES} mục nữa`);
        }
        return lines.join('\n') || '(thư mục trống)';
      },
    },
    {
      name: 'workspace_read_file',
      description: 'Đọc nội dung một file text trong workspace (tối đa 200.000 ký tự, chỉ đọc).',
      inputSchema: objectSchema(
        { path: { type: 'string', description: 'Đường dẫn file tương đối trong workspace.' } },
        ['path'],
      ),
      annotations: { ...readOnly, title: 'Đọc file workspace' },
      handler: (args) => {
        const dir = needWorkspace();
        const rel = args['path'];
        if (typeof rel !== 'string' || rel.length === 0) {
          throw new Error('Tham số "path" phải là chuỗi đường dẫn tương đối không rỗng.');
        }
        const target = resolveWorkspacePath(dir, rel);
        if (!target) throw new Error(`Đường dẫn "${rel}" nằm ngoài workspace, không được phép.`);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`Không có file "${rel}" trong workspace.`);
        }
        const text = fs.readFileSync(target, 'utf-8');
        if (text.includes('\0')) {
          throw new Error(`File "${rel}" không phải file text.`);
        }
        return text.length > MCP_SERVER_MAX_FILE_CHARS
          ? text.slice(0, MCP_SERVER_MAX_FILE_CHARS) + '\n… (file đã cắt ở 200.000 ký tự)'
          : text;
      },
    },
  ];
}

function createDefaultMcpServerPrompts(): McpServerPromptDef[] {
  return [
    {
      name: 'greet',
      description: 'Chào người dùng bằng tên, ngắn gọn và thân thiện.',
      arguments: [{ name: 'name', description: 'Tên người cần chào.', required: false }],
      get: (args) => [
        { role: 'user' as const, text: `Hãy chào ${args['name'] ?? 'bạn'} bằng một câu ngắn gọn, thân thiện.` },
      ],
    },
    {
      name: 'summarize',
      description: 'Tóm tắt một đoạn text thành vài gạch đầu dòng.',
      arguments: [{ name: 'text', description: 'Đoạn text cần tóm tắt.', required: true }],
      get: (args) => [
        {
          role: 'user' as const,
          text: `Tóm tắt đoạn sau thành tối đa 5 gạch đầu dòng, giữ đúng ý chính:\n\n${args['text'] ?? ''}`,
        },
      ],
    },
    {
      name: 'plan-task',
      description: 'Lập kế hoạch các bước làm một việc, trước khi thực thi.',
      arguments: [{ name: 'goal', description: 'Việc cần làm.', required: true }],
      get: (args) => [
        {
          role: 'user' as const,
          text: `Lập kế hoạch từng bước để làm việc sau, chỉ liệt kê bước và điều cần quyết — chưa thực thi:\n\n${args['goal'] ?? ''}`,
        },
      ],
    },
  ];
}

/** Một MCP server: giữ trạng thái handshake + dispatch JSON-RPC. */
export class McpServer {
  readonly name: string;
  readonly version: string;
  private readonly workspaceDir: string | undefined;
  private readonly allowedTools: Set<string> | null;
  private readonly tools = new Map<string, McpServerToolDef>();
  private readonly resources = new Map<string, McpServerResourceDef>();
  private readonly prompts = new Map<string, McpServerPromptDef>();
  private readonly sessions = new Set<string>();
  private initialized = false;
  private negotiatedProtocolVersion = MCP_SERVER_PROTOCOL_VERSION;
  private readonly onLog: ((message: string) => void) | undefined;
  /** v0.97: server-side task store (Tasks extension, spec 2026-07-28). */
  private readonly taskStore: McpTaskStore;
  private readonly tasksEnabled: boolean;
  /** v0.97: deprecation shim — sampling/roots/logging vẫn chạy, có cảnh báo. */
  private readonly deprecationShim: DeprecationShim;
  /** v1.02: audit log for answered requests (undefined = no audit). */
  private readonly auditLogger: McpAuditLog | undefined;
  /** v1.02: hub for server-initiated notifications. */
  readonly notificationHub: McpNotificationHub;
  /** v1.02: minimum log level for `notifications/message` (spec default `info`). */
  private logLevel: McpLogLevel = MCP_DEFAULT_LOG_LEVEL;
  /** v1.02: caller label written into audit entries. */
  private readonly callerLabel: string;

  constructor(options: McpServerOptions = {}) {
    this.name = options.name ?? MCP_SERVER_NAME;
    this.version = options.version ?? MCP_SERVER_VERSION;
    this.workspaceDir = options.workspaceDir;
    this.onLog = options.onLog;
    this.tasksEnabled = options.tasksEnabled ?? true;
    this.auditLogger = options.auditLogger;
    this.notificationHub = options.notificationHub ?? new McpNotificationHub();
    this.callerLabel = options.caller ?? this.name;
    this.taskStore = new McpTaskStore();
    this.deprecationShim = new DeprecationShim({
      onWarning: (_notice, message) => this.log(message),
    });
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : null;
    for (const tool of createDefaultMcpServerTools(this.workspaceDir, this.name)) {
      this.registerTool(tool);
    }
    for (const tool of options.tools ?? []) this.registerTool(tool);
    // Resource mặc định: metadata server + danh sách workspace.
    this.registerResource({
      uri: 'open-bot://info',
      name: 'Thông tin open-bot',
      description: 'Tên, phiên bản, protocol và số tool/resource/prompt server đang expose.',
      mimeType: 'application/json',
      read: () => JSON.stringify(
        {
          name: this.name,
          version: this.version,
          protocolVersion: MCP_SERVER_PROTOCOL_VERSION,
          tools: this.listToolNames(),
          resources: [...this.resources.keys()],
          prompts: [...this.prompts.keys()],
          workspaceDir: this.workspaceDir ?? null,
        },
        null,
        2,
      ),
    });
    if (this.workspaceDir) {
      const dir = this.workspaceDir;
      this.registerResource({
        uri: 'open-bot://workspace',
        name: 'Danh sách workspace',
        description: 'Danh sách file ở gốc workspace (tối đa 200 mục).',
        mimeType: 'text/plain',
        read: () => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          return entries.slice(0, MCP_SERVER_MAX_LIST_FILES)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join('\n');
        },
      });
    }
    for (const resource of options.resources ?? []) this.registerResource(resource);
    for (const prompt of createDefaultMcpServerPrompts()) this.registerPrompt(prompt);
    for (const prompt of options.prompts ?? []) this.registerPrompt(prompt);
  }

  /** Tên các tool đang expose (sau allowlist). */
  listToolNames(): string[] {
    return [...this.tools.values()]
      .filter((t) => !this.allowedTools || this.allowedTools.has(t.name))
      .map((t) => t.name);
  }

  /**
   * W13e: def rút gọn của các tool đang expose (sau allowlist) —
   * chỉ tên + annotations, không schema/handler. Đồng bộ nên mount
   * MCP của Local API đọc được ngay lúc mount, trước bất kỳ
   * `tools/list` / `tools/call` nào của client.
   */
  listToolDefinitions(): McpServerToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => !this.allowedTools || this.allowedTools.has(t.name))
      .map((t) =>
        t.annotations
          ? { name: t.name, annotations: { ...t.annotations } }
          : { name: t.name },
      );
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * v0.97 (MCP 2.0): submit a long-running job to the server task
   * store. Returns the handle at once (`tasks/get` polls it later).
   * The coordinator wires real long work here (e.g. a slow tool call
   * that asked for a task via `_meta.task`).
   */
  submitLongTask(
    method: string,
    params: Record<string, unknown>,
    runner: (ctx: McpTaskRunnerContext) => Promise<unknown>,
  ): ServerTaskHandleData {
    if (!this.tasksEnabled) throw new Error('Tasks extension chưa bật trên server này.');
    return this.taskStore.submit(method, params, runner);
  }

  /** v0.97: tasks the server currently stores (newest first). */
  listServerTasks(): ServerTaskHandleData[] {
    return this.taskStore.list().map((t) => this.taskStore.toHandleData(t));
  }

  /** v0.97: drop expired tasks from the store. Returns how many were removed. */
  sweepServerTasks(): number {
    return this.taskStore.sweepExpired();
  }

  /** v0.97: deprecation notices recorded so far (sampling/roots/logging use). */
  getDeprecationNotices(): DeprecationNotice[] {
    return this.deprecationShim.getNotices();
  }

  /** Đăng ký thêm tool sau khi tạo server (chỉ trước khi có client). */
  registerTool(tool: McpServerToolDef): void {
    if (!tool.name || typeof tool.handler !== 'function') {
      throw new Error('Tool MCP cần có "name" và "handler" là function.');
    }
    this.tools.set(tool.name, tool);
    // v1.02: clients cache `tools/list` — announce the change so they
    // re-fetch instead of calling a tool that no longer exists.
    this.notificationHub.emitListChanged('tools');
  }

  registerResource(resource: McpServerResourceDef): void {
    this.resources.set(resource.uri, resource);
    // v1.02: announce, like tools above.
    this.notificationHub.emitListChanged('resources');
  }

  /** v1.02: register a prompt (announces `prompts/list_changed`). */
  registerPrompt(prompt: McpServerPromptDef): void {
    this.prompts.set(prompt.name, prompt);
    this.notificationHub.emitListChanged('prompts');
  }

  /** v1.02: current minimum level for `notifications/message`. */
  getLogLevel(): McpLogLevel {
    return this.logLevel;
  }

  /**
   * v1.02: emit a `notifications/message` log message when `level`
   * is at or above the level the client set with `logging/setLevel`.
   * `data` must already be redacted by the caller — the hub does not
   * inspect payloads. Also mirrors to `onLog` for local diagnostics.
   */
  notifyLogMessage(level: McpLogLevel, logger: string | undefined, data: unknown): void {
    if (!shouldLogMcp(level, this.logLevel)) return;
    const message: McpLogMessage = {
      level,
      ...(logger !== undefined ? { logger } : {}),
      data,
    };
    this.notificationHub.emitLogMessage(message);
    this.log(typeof data === 'string' ? data : JSON.stringify(data));
  }

  /** v1.02: true when this request id was cancelled by the client. */
  isRequestCancelled(requestId: string | number): boolean {
    return this.notificationHub.isCancelled(requestId);
  }

  /** v1.02: the audit log this server records into (undefined = none). */
  get auditLog(): McpAuditLog | undefined {
    return this.auditLogger;
  }

  private log(message: string): void {
    try {
      this.onLog?.(message);
    } catch {
      // Log không bao giờ được làm hỏng request.
    }
  }

  private ok(id: number | string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private fail(
    id: number | string | null,
    code: number,
    message: string,
  ): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  private negotiate(clientVersion: unknown): string {
    if (
      typeof clientVersion === 'string' &&
      (MCP_SERVER_PROTOCOL_VERSIONS_SUPPORTED as readonly string[]).includes(clientVersion)
    ) {
      return clientVersion;
    }
    return MCP_SERVER_PROTOCOL_VERSION;
  }

  /**
   * Xử lý một message JSON-RPC đã parse. Trả null cho notification
   * (không có `id`) — caller không gửi gì đáp lại. Mọi lỗi protocol
   * trả đúng mã JSON-RPC; lỗi trong lúc chạy tool trả tool error
   * (`isError: true`) theo SEP-1303.
   *
   * v1.02: this is the audited entry point — it times the inner
   * handler and records one audit entry per message (when an
   * `auditLogger` was configured). Audit never changes the response
   * and never throws: a logging failure is swallowed here.
   */
  async handleJsonRpc(
    msg: unknown,
    auditCtx?: { sessionId?: string },
  ): Promise<JsonRpcResponse | null> {
    const logger = this.auditLogger;
    if (!logger) return this.handleJsonRpcInner(msg);
    const startedAt = Date.now();
    const at = new Date(startedAt).toISOString();
    let response: JsonRpcResponse | null;
    try {
      response = await this.handleJsonRpcInner(msg);
    } catch (err) {
      // The inner handler only throws on unexpected bugs (protocol
      // errors are `fail()` responses). Audit it, then rethrow so
      // the transport still reports the internal error.
      this.recordAudit(logger, msg, null, 'error', Date.now() - startedAt, at, {
        errorCode: JSON_RPC_INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : 'Lỗi nội bộ server.',
        ...(auditCtx?.sessionId !== undefined ? { sessionId: auditCtx.sessionId } : {}),
      });
      throw err;
    }
    this.recordAudit(logger, msg, response, null, Date.now() - startedAt, at, {
      ...(auditCtx?.sessionId !== undefined ? { sessionId: auditCtx.sessionId } : {}),
    });
    return response;
  }

  /**
   * v1.02: build one audit entry for a handled message. `thrownError`
   * is set only when the inner handler threw instead of answering.
   */
  private recordAudit(
    logger: McpAuditLog,
    msg: unknown,
    response: JsonRpcResponse | null,
    thrownError: 'error' | null,
    durationMs: number,
    at: string,
    extra: { errorCode?: number; errorMessage?: string; sessionId?: string },
  ): void {
    try {
      const record = isRecord(msg) ? msg : {};
      const method = typeof record['method'] === 'string' ? (record['method'] as string) : '(invalid)';
      const params = isRecord(record['params']) ? (record['params'] as Record<string, unknown>) : {};
      const requestId =
        typeof record['id'] === 'string' || typeof record['id'] === 'number'
          ? (record['id'] as string | number)
          : undefined;
      let outcome: 'ok' | 'tool-error' | 'error' | 'cancelled' = 'ok';
      let errorCode = extra.errorCode;
      let errorMessage = extra.errorMessage;
      let resultSummary: string | undefined;
      if (thrownError === 'error') {
        outcome = 'error';
      } else if (response === null) {
        // Notification answered with nothing — `notifications/cancelled`
        // is its own outcome so the log shows the cancellation.
        outcome = method === MCP_NOTIFICATION_CANCELLED ? 'cancelled' : 'ok';
      } else if (response.error) {
        outcome = 'error';
        errorCode = response.error.code;
        errorMessage = response.error.message;
      } else {
        resultSummary = summarizeMcpResult(response.result);
        if (isRecord(response.result) && response.result['isError'] === true) outcome = 'tool-error';
      }
      // Audit arguments: for `tools/call` the arguments live under
      // `params.arguments`; other methods audit their params as-is.
      const args =
        method === 'tools/call' && isRecord(params['arguments'])
          ? (params['arguments'] as Record<string, unknown>)
          : params;
      logger.record({
        direction: 'server',
        server: this.name,
        method,
        ...(method === 'tools/call' && typeof params['name'] === 'string'
          ? { tool: params['name'] as string }
          : {}),
        ...(method === 'resources/read' && typeof params['uri'] === 'string'
          ? { resourceUri: params['uri'] as string }
          : {}),
        ...(method === 'prompts/get' && typeof params['name'] === 'string'
          ? { promptName: params['name'] as string }
          : {}),
        caller: this.callerLabel,
        ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        args,
        ...(resultSummary !== undefined ? { resultSummary } : {}),
        outcome,
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        durationMs,
        at,
      });
    } catch {
      // Audit must never break the request it records.
    }
  }

  private async handleJsonRpcInner(msg: unknown): Promise<JsonRpcResponse | null> {
    if (!isRecord(msg) || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string') {
      const id = isRecord(msg) && (typeof msg['id'] === 'number' || typeof msg['id'] === 'string')
        ? (msg['id'] as number | string)
        : null;
      return this.fail(id, JSON_RPC_INVALID_REQUEST, 'Request phải là JSON-RPC 2.0 { jsonrpc, method }.');
    }
    const req = msg as JsonRpcRequest;
    const id = req.id ?? null;
    const isNotification = req.id === undefined || req.id === null;
    const method = req.method as string;
    const params = isRecord(req.params) ? req.params : {};

    // Notification: không đáp lại (kể cả notification lạ).
    if (isNotification) {
      if (method === 'notifications/initialized') this.initialized = true;
      // v1.02: `notifications/cancelled` — remember the request id so
      // a long task can stop early (`isRequestCancelled`), and tell
      // hub listeners (the task runner) about it.
      if (method === MCP_NOTIFICATION_CANCELLED) {
        const requestId = params['requestId'];
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          this.notificationHub.emitCancelled({
            requestId,
            ...(typeof params['reason'] === 'string' ? { reason: params['reason'] as string } : {}),
          });
        }
      }
      return null;
    }

    // v0.97 (MCP 2.0): `server/discover` — server tự mô tả mà không
    // cần handshake. Trả lời trước cả gate initialize, cho cả client
    // stateless lẫn client cũ đang thăm dò.
    if (method === 'server/discover') {
      return this.ok(
        id,
        buildServerDiscoverResult({
          name: this.name,
          version: this.version,
          hasTools: this.listToolNames().length > 0,
          hasResources: this.resources.size > 0,
          hasPrompts: this.prompts.size > 0,
          tasksSupported: this.tasksEnabled,
          appsSupported: true,
        }),
      );
    }

    if (method === 'initialize') {
      this.negotiatedProtocolVersion = this.negotiate(params['protocolVersion']);
      // v0.97: ghi nhận capability deprecated client quảng cáo
      // (sampling / roots / logging) — vẫn cho kết nối, chỉ cảnh báo.
      for (const meta of checkDeprecatedCapabilities(
        isRecord(params['capabilities']) ? (params['capabilities'] as Record<string, unknown>) : undefined,
      )) {
        this.deprecationShim.record(meta.method);
      }
      const sessionId = randomUUID();
      this.sessions.add(sessionId);
      this.initialized = true;
      return {
        ...this.ok(id, {
          protocolVersion: this.negotiatedProtocolVersion,
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            logging: {},
          },
          serverInfo: { name: this.name, version: this.version },
        }),
        // Session id đi kèm response initialize (Streamable HTTP).
        // Caller HTTP đọc trường này để set header Mcp-Session-Id.
        // Đặt ở đây thay vì header riêng để handleJsonRpc dùng được
        // cho cả stdio (stdio bỏ qua trường này).
        sessionId,
      } as JsonRpcResponse & { sessionId: string };
    }

    if (method === 'ping') return this.ok(id, {});

    // v1.02: `logging/setLevel` — the client sets the minimum level
    // for `notifications/message`. Invalid level → -32602.
    if (method === 'logging/setLevel') {
      const level = parseMcpLogLevel(params['level']);
      if (!level) {
        return this.fail(
          id,
          JSON_RPC_INVALID_PARAMS,
          'logging/setLevel cần { level: "debug"|"info"|"notice"|"warning"|"error"|"critical"|"alert"|"emergency" }.',
        );
      }
      this.logLevel = level;
      return this.ok(id, {});
    }

    // v0.97 (MCP 2.0): stateless request — request tự mang protocol
    // version + capabilities trong `_meta` nên không cần handshake
    // trước. Chỉ chấp nhận version server biết; version lạ thì rơi
    // xuống gate initialize cũ (client cũ không gửi `_meta` nên
    // không đổi hành vi).
    const statelessMeta = parseStatelessMeta(params['_meta']);
    if (statelessMeta) {
      if (
        (MCP_SERVER_PROTOCOL_VERSIONS_SUPPORTED as readonly string[]).includes(
          statelessMeta.protocolVersion,
        )
      ) {
        this.negotiatedProtocolVersion = statelessMeta.protocolVersion;
        for (const meta of checkDeprecatedCapabilities(
          statelessMeta.clientCapabilities as unknown as Record<string, unknown> | undefined,
        )) {
          this.deprecationShim.record(meta.method);
        }
      } else {
        return this.fail(
          id,
          JSON_RPC_INVALID_PARAMS,
          `Protocol version không hỗ trợ: "${statelessMeta.protocolVersion}".`,
        );
      }
    } else if (!this.initialized) {
      // Mọi method khác đều cần handshake initialize xong trước.
      return this.fail(id, JSON_RPC_NOT_INITIALIZED, 'Server chưa initialize — hãy gửi "initialize" trước.');
    }

    switch (method) {
      case 'tasks/get': {
        if (!this.tasksEnabled) {
          return this.fail(id, JSON_RPC_METHOD_NOT_FOUND, 'Tasks extension chưa bật trên server này.');
        }
        const taskId = params['taskId'];
        if (typeof taskId !== 'string' || taskId.length === 0) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, 'tasks/get cần { taskId: string }.');
        }
        try {
          return this.ok(id, this.taskStore.toHandleData(this.taskStore.get(taskId)));
        } catch (err) {
          if (err instanceof TaskStoreError) {
            return this.fail(id, JSON_RPC_INVALID_PARAMS, err.message);
          }
          throw err;
        }
      }
      case 'tasks/cancel': {
        if (!this.tasksEnabled) {
          return this.fail(id, JSON_RPC_METHOD_NOT_FOUND, 'Tasks extension chưa bật trên server này.');
        }
        const taskId = params['taskId'];
        if (typeof taskId !== 'string' || taskId.length === 0) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, 'tasks/cancel cần { taskId: string }.');
        }
        try {
          return this.ok(id, this.taskStore.cancel(taskId));
        } catch (err) {
          if (err instanceof TaskStoreError) {
            return this.fail(id, JSON_RPC_INVALID_PARAMS, err.message);
          }
          throw err;
        }
      }
      case 'tasks/update': {
        if (!this.tasksEnabled) {
          return this.fail(id, JSON_RPC_METHOD_NOT_FOUND, 'Tasks extension chưa bật trên server này.');
        }
        const taskId = params['taskId'];
        if (typeof taskId !== 'string' || taskId.length === 0) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, 'tasks/update cần { taskId: string, input?: object }.');
        }
        try {
          const input = isRecord(params['input']) ? (params['input'] as Record<string, unknown>) : {};
          return this.ok(id, this.taskStore.update(taskId, input));
        } catch (err) {
          if (err instanceof TaskStoreError) {
            return this.fail(id, JSON_RPC_INVALID_PARAMS, err.message);
          }
          throw err;
        }
      }
      case 'tasks/result': {
        // Shape 2025-11-25: client lấy kết quả cuối sau khi completed.
        if (!this.tasksEnabled) {
          return this.fail(id, JSON_RPC_METHOD_NOT_FOUND, 'Tasks extension chưa bật trên server này.');
        }
        const taskId = params['taskId'];
        if (typeof taskId !== 'string' || taskId.length === 0) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, 'tasks/result cần { taskId: string }.');
        }
        try {
          const task = this.taskStore.get(taskId);
          if (task.status === 'completed') return this.ok(id, { result: task.result ?? null });
          if (task.status === 'failed') {
            return this.fail(id, JSON_RPC_INTERNAL_ERROR, task.error ?? 'Task failed.');
          }
          return this.fail(
            id,
            JSON_RPC_INVALID_PARAMS,
            `Task ${taskId} đang ${task.status}; chưa có kết quả cuối.`,
          );
        } catch (err) {
          if (err instanceof TaskStoreError) {
            return this.fail(id, JSON_RPC_INVALID_PARAMS, err.message);
          }
          throw err;
        }
      }
      case 'tasks/list': {
        // Shape 2025-11-25 (bỏ ở extension 2026-07-28): liệt kê task.
        if (!this.tasksEnabled) {
          return this.fail(id, JSON_RPC_METHOD_NOT_FOUND, 'Tasks extension chưa bật trên server này.');
        }
        const status = params['status'];
        const validStatus =
          status === 'working' || status === 'input_required' || status === 'completed' ||
          status === 'failed' || status === 'cancelled'
            ? status
            : undefined;
        return this.ok(id, {
          tasks: this.taskStore.list(validStatus).map((t) => this.taskStore.toHandleData(t)),
        });
      }
      case 'tools/list': {
        const tools = [...this.tools.values()]
          .filter((t) => !this.allowedTools || this.allowedTools.has(t.name))
          .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
            ...(t.annotations ? { annotations: t.annotations } : {}),
          }));
        return this.ok(id, { tools });
      }
      case 'tools/call': {
        const name = params['name'];
        if (typeof name !== 'string' || name.length === 0) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, 'tools/call cần { name: string, arguments?: object }.');
        }
        if (this.allowedTools && !this.allowedTools.has(name)) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, `Tool "${name}" không nằm trong allowlist của server này.`);
        }
        const tool = this.tools.get(name);
        if (!tool) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, `Không có tool tên "${name}".`);
        }
        const args = asArgs(params['arguments']);
        try {
          const raw = await tool.handler(args);
          const text = typeof raw === 'string' ? raw : raw.text;
          const structured = typeof raw === 'string' ? undefined : raw.structuredContent;
          const isError = typeof raw === 'string' ? false : raw.isError === true;
          return this.ok(id, {
            content: [textBlock(text)],
            ...(structured ? { structuredContent: structured } : {}),
            isError,
          });
        } catch (err) {
          // SEP-1303: lỗi validate/thực thi tool là tool error, để
          // model đọc và sửa lại — không phải lỗi protocol.
          const message = err instanceof Error ? err.message : 'Tool chạy thất bại.';
          this.log(`tool "${name}" lỗi: ${message}`);
          return this.ok(id, { content: [textBlock(message)], isError: true });
        }
      }
      case 'resources/list': {
        const resources = [...this.resources.values()].map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        }));
        return this.ok(id, { resources });
      }
      case 'resources/templates/list': {
        if (!this.workspaceDir) return this.ok(id, { resourceTemplates: [] });
        return this.ok(id, {
          resourceTemplates: [
            {
              uriTemplate: 'workspace://{path}',
              name: 'Tệp trong workspace',
              description: 'Đọc một file text trong workspace theo đường dẫn tương đối.',
              mimeType: 'text/plain',
            },
          ],
        });
      }
      case 'resources/read': {
        const uri = params['uri'];
        if (typeof uri !== 'string' || uri.length === 0) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, 'resources/read cần { uri: string }.');
        }
        try {
          const text = await this.readResource(uri);
          return this.ok(id, {
            contents: [{ uri, mimeType: this.guessMime(uri), text }],
          });
        } catch (err) {
          return this.fail(
            id,
            JSON_RPC_INVALID_PARAMS,
            err instanceof Error ? err.message : `Không đọc được resource "${uri}".`,
          );
        }
      }
      case 'prompts/list': {
        const prompts = [...this.prompts.values()].map((p) => ({
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          ...(p.arguments ? { arguments: p.arguments } : {}),
        }));
        return this.ok(id, { prompts });
      }
      case 'prompts/get': {
        const name = params['name'];
        if (typeof name !== 'string' || name.length === 0) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, 'prompts/get cần { name: string, arguments?: object }.');
        }
        const prompt = this.prompts.get(name);
        if (!prompt) {
          return this.fail(id, JSON_RPC_INVALID_PARAMS, `Không có prompt tên "${name}".`);
        }
        const rawArgs = asArgs(params['arguments']);
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawArgs)) {
          if (typeof v === 'string') args[k] = v;
        }
        for (const a of prompt.arguments ?? []) {
          if (a.required && !(a.name in args)) {
            return this.fail(id, JSON_RPC_INVALID_PARAMS, `Prompt "${name}" cần argument "${a.name}".`);
          }
        }
        const messages = await prompt.get(args);
        return this.ok(id, {
          description: prompt.description ?? '',
          messages: messages.map((m) => ({
            role: m.role,
            content: { type: 'text', text: m.text },
          })),
        });
      }
      default:
        return this.fail(id, JSON_RPC_METHOD_NOT_FOUND, `Không hỗ trợ method "${method}".`);
    }
  }

  private guessMime(uri: string): string {
    if (uri.endsWith('.json')) return 'application/json';
    if (uri.endsWith('.md')) return 'text/markdown';
    return 'text/plain';
  }

  /** Đọc một resource: resource đăng ký, hoặc `workspace://<path>`. */
  async readResource(uri: string): Promise<string> {
    const registered = this.resources.get(uri);
    if (registered) return registered.read();
    if (uri.startsWith('workspace://')) {
      if (!this.workspaceDir) {
        throw new Error('Server MCP này chạy không gắn workspace nên không đọc được workspace://.');
      }
      const rel = decodeURIComponent(uri.slice('workspace://'.length));
      const target = resolveWorkspacePath(this.workspaceDir, rel);
      if (!target) throw new Error(`Đường dẫn "${rel}" nằm ngoài workspace, không được phép.`);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error(`Không có file "${rel}" trong workspace.`);
      }
      const text = fs.readFileSync(target, 'utf-8');
      if (text.includes('\0')) throw new Error(`File "${rel}" không phải file text.`);
      return text.length > MCP_SERVER_MAX_FILE_CHARS
        ? text.slice(0, MCP_SERVER_MAX_FILE_CHARS) + '\n… (file đã cắt ở 200.000 ký tự)'
        : text;
    }
    throw new Error(`Không có resource "${uri}".`);
  }

  /** Hủy một session Streamable HTTP (DELETE). Trả true khi có session đó. */
  dropSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Phục vụ stdio: đọc từng dòng JSON ở `input`, ghi response JSON
   * mỗi dòng ra `output`. Resolve khi input đóng. Log ra stderr qua
   * `onLog` mặc định (console.error) — không bao giờ ghi stdout.
   */
  serveStdio(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    const log = this.onLog ?? ((m: string) => console.error(`[mcp-server] ${m}`));
    const rl = readline.createInterface({ input, terminal: false });
    // Xử lý tuần tự theo thứ tự dòng đến: response ghi ra đúng thứ
    // tự request (kể cả lỗi parse JSON — ghi đồng bộ sẽ nhảy lên
    // trước response async nếu không xếp hàng). stdin đóng thì đợi
    // hàng đợi xong hết rồi mới resolve, không bỏ response nào.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (job: () => Promise<void>): void => {
      chain = chain.then(job, job);
    };
    return new Promise<void>((resolve) => {
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          enqueue(async () => {
            const res: JsonRpcResponse = {
              jsonrpc: '2.0',
              id: null,
              error: { code: JSON_RPC_PARSE_ERROR, message: 'Request không phải JSON hợp lệ.' },
            };
            output.write(JSON.stringify(res) + '\n');
          });
          return;
        }
        enqueue(async () => {
          try {
            const res = await this.handleJsonRpc(msg);
            if (res) output.write(JSON.stringify(res) + '\n');
          } catch (err: unknown) {
            const res: JsonRpcResponse = {
              jsonrpc: '2.0',
              id: isRecord(msg) && typeof msg['id'] === 'number' ? (msg['id'] as number) : null,
              error: {
                code: JSON_RPC_INTERNAL_ERROR,
                message: err instanceof Error ? err.message : 'Lỗi nội bộ server.',
              },
            };
            try {
              output.write(JSON.stringify(res) + '\n');
            } catch {
              // Output đã đóng.
            }
          }
        });
      });
      rl.on('close', () => {
        void chain.then(() => {
          log('stdio đóng, server dừng.');
          resolve();
        });
      });
    });
  }
}

/** Tạo server MCP với option cho trước (shortcut cho `new McpServer`). */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  return new McpServer(options);
}

export interface McpHttpServer {
  readonly port: number;
  readonly url: string;
  readonly isRunning: boolean;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MCP_SERVER_MAX_BODY_BYTES) throw new Error('Request body quá lớn (tối đa 1 MB).');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Chạy MCP server qua Streamable HTTP trên loopback.
 *  - POST {path} (mặc định `/mcp`): một JSON-RPC request → một JSON
 *    response (hoặc SSE một frame khi client chỉ Accept SSE, và 202
 *    rỗng cho notification). Batching (JSON array) bị từ chối -32600
 *    vì spec đã bỏ batching từ 2025-06-18.
 *  - GET {path}: mở SSE stream giữ kết nối (server gửi comment giữ
 *    nhịp + ping JSON-RPC khi client gửi request qua POST — client
 *    resume bằng `Last-Event-ID`, server hiện chưa phát event có id
 *    nên header này được chấp nhận và bỏ qua).
 *  - DELETE {path}: đóng session (`Mcp-Session-Id`) → 204.
 * Trả về `{ port, url, close }`. Điều phối viên nối vào Local API sau
 * bằng cách dùng `McpServer.handleJsonRpc` trực tiếp thay vì chạy
 * server HTTP riêng.
 */
export function startMcpHttpServer(
  server: McpServer,
  options: { port?: number; host?: string; path?: string } = {},
): Promise<McpHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const rpcPath = options.path ?? '/mcp';
  const requestedPort = options.port ?? 0;
  const sseClients = new Set<http.ServerResponse>();
  let httpServer: http.Server | null = null;
  let boundPort = 0;

  const srv = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== rpcPath) {
          sendJson(res, 404, { error: `Unknown route: ${req.method ?? ''} ${url.pathname}` });
          return;
        }
        if (req.method === 'GET') {
          // SSE stream: giữ kết nối để đẩy notification sau này.
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(': connected\n\n');
          sseClients.add(res);
          req.on('close', () => sseClients.delete(res));
          return;
        }
        if (req.method === 'DELETE') {
          const sessionId = req.headers['mcp-session-id'];
          if (typeof sessionId === 'string' && sessionId) server.dropSession(sessionId);
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: `Method ${req.method ?? ''} không hỗ trợ ở ${rpcPath}.` });
          return;
        }
        const text = await readBody(req);
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: null,
            error: { code: JSON_RPC_PARSE_ERROR, message: 'Request không phải JSON hợp lệ.' },
          });
          return;
        }
        if (Array.isArray(msg)) {
          // Spec bỏ batching từ 2025-06-18 — từ chối rõ ràng.
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: null,
            error: { code: JSON_RPC_INVALID_REQUEST, message: 'MCP không hỗ trợ JSON-RPC batching.' },
          });
          return;
        }
        const response = await server.handleJsonRpc(msg);
        if (!response) {
          res.writeHead(202);
          res.end();
          return;
        }
        const extra: Record<string, string> = {};
        const withSession = response as JsonRpcResponse & { sessionId?: string };
        if (withSession.sessionId) extra['Mcp-Session-Id'] = withSession.sessionId;
        const accept = req.headers.accept ?? '';
        const wantsSseOnly = accept.includes('text/event-stream') && !accept.includes('application/json');
        if (wantsSseOnly) {
          const payload = JSON.stringify(response);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.end(`data: ${payload}\n\n`);
          return;
        }
        const { sessionId: _ignored, ...clean } = withSession;
        sendJson(res, 200, clean, extra);
      } catch (err) {
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : 'Lỗi nội bộ server.';
          sendJson(res, /quá lớn/.test(message) ? 400 : 500, { error: message });
        }
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Lỗi nội bộ server.' });
    });
  });

  return new Promise<McpHttpServer>((resolve, reject) => {
    srv.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Cổng MCP ${requestedPort} đã có app khác dùng — chọn cổng khác.`));
      } else {
        reject(err);
      }
    });
    srv.listen(requestedPort, host, () => {
      httpServer = srv;
      boundPort = (srv.address() as { port: number }).port;
      resolve({
        get port() {
          return boundPort;
        },
        get url() {
          return `http://${host}:${boundPort}${rpcPath}`;
        },
        get isRunning() {
          return httpServer !== null && httpServer.listening;
        },
        close(): Promise<void> {
          if (!httpServer) return Promise.resolve();
          const s = httpServer;
          httpServer = null;
          boundPort = 0;
          for (const client of sseClients) {
            try {
              client.end();
            } catch {
              // Đã đóng.
            }
          }
          sseClients.clear();
          return new Promise<void>((done) => s.close(() => done()));
        },
      });
    });
  });
}
