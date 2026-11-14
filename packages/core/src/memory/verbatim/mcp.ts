/**
 * MCP memory server cho verbatim memory (v1.01, Đội T4).
 *
 * Expose verbatim store qua MCP để agent khác (Claude Code, Codex CLI,
 * Cursor, Gemini CLI…) dùng chung một kho memory với open-bot. Dựng
 * trên `McpServer` hand-rolled có sẵn của repo (stdio + HTTP, spec
 * MCP 2025-11-25) — chỉ đăng ký thêm 5 tool, không viết lại protocol:
 *
 *   memory.save    — lưu một record nguyên văn (destructive)
 *   memory.search  — recall hybrid (read-only)
 *   memory.list    — liệt kê / lọc metadata (read-only)
 *   memory.delete  — xoá một record theo id (destructive)
 *   memory.stats   — thống kê store (read-only)
 *
 * An toàn:
 * - Server này CHỈ expose 5 tool memory (allowedTools khoá đúng 5
 *   tên) — không kèm tool mặc định đọc file/shell của McpServer.
 * - Output không bao giờ kèm vector embedding.
 * - `memory.save`/`memory.delete` cần host bật `allowWrites` (mặc
 *   định true cho stdio local; host dùng chung qua HTTP nên tắt và
 *   chỉ để read-only).
 * - Log chỉ ra stderr (quy ước stdio của McpServer — stdout là kênh
 *   JSON-RPC, không được pollute).
 */
import type { McpServer, McpServerToolDef } from '../../mcp/server';
import { createMcpServer, startMcpHttpServer } from '../../mcp/server';
import type { VerbatimMemoryStore } from './store';
import type { VerbatimFilter, VerbatimSource } from './types';
import { publicVerbatimRecord } from './types';

/** Tên 5 tool MCP (dot-notation, theo yêu cầu sóng v1.01). */
export const VERBATIM_MCP_TOOL_NAMES = [
  'memory.save',
  'memory.search',
  'memory.list',
  'memory.delete',
  'memory.stats',
] as const;

export type VerbatimMcpToolName = (typeof VERBATIM_MCP_TOOL_NAMES)[number];

export interface VerbatimMcpServerOptions {
  /** Tên server trong serverInfo (mặc định 'open-bot-verbatim-memory'). */
  name?: string;
  /** Version server (mặc định '1.0.0'). */
  version?: string;
  /** Cho phép ghi (save/delete). Mặc định true (stdio local). */
  allowWrites?: boolean;
  /** Ghi log (mặc định: stderr khi chạy stdio, im lặng khi khác). */
  onLog?: (message: string) => void;
}

const WRITE_TOOLS: VerbatimMcpToolName[] = ['memory.save', 'memory.delete'];

function asString(value: unknown, name: string, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Thiếu tham số bắt buộc: "${name}".`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Tham số "${name}" phải là chuỗi.`);
  return value;
}

function asOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Tham số "${name}" phải là chuỗi.`);
  return value;
}

function asNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Tham số "${name}" phải là số.`);
  }
  return value;
}

function asStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Tham số "${name}" phải là mảng chuỗi.`);
  }
  return value as string[];
}

function parseFilter(args: Record<string, unknown>): VerbatimFilter {
  const filter: VerbatimFilter = {};
  const wing = asOptionalString(args['wing'], 'wing');
  if (wing !== undefined) filter.wing = wing;
  const room = asOptionalString(args['room'], 'room');
  if (room !== undefined) filter.room = room;
  const drawer = asOptionalString(args['drawer'], 'drawer');
  if (drawer !== undefined) filter.drawer = drawer;
  const source = asOptionalString(args['source'], 'source');
  if (source !== undefined) filter.source = source as VerbatimSource;
  const botId = asOptionalString(args['botId'], 'botId');
  if (botId !== undefined) filter.botId = botId;
  const userId = asOptionalString(args['userId'], 'userId');
  if (userId !== undefined) filter.userId = userId;
  const tags = args['tags'];
  if (tags !== undefined) filter.tags = asStringArray(tags, 'tags');
  return filter;
}

function toolResultJson(value: unknown): { text: string } {
  return { text: JSON.stringify(value, null, 2) };
}

function toolError(message: string): { text: string; isError: true } {
  return { text: `Error: ${message}`, isError: true };
}

/** Tạo 5 tool def cho verbatim store (dùng chung cho McpServer). */
export function createVerbatimMcpTools(
  store: VerbatimMemoryStore,
  opts: { allowWrites?: boolean } = {},
): McpServerToolDef[] {
  const allowWrites = opts.allowWrites ?? true;
  const needWrites = (): void => {
    if (!allowWrites) {
      throw new Error('Server đang ở chế độ chỉ đọc (allowWrites=false) — memory.save/memory.delete bị tắt.');
    }
  };
  const tools: McpServerToolDef[] = [
    {
      name: 'memory.save',
      description:
        'Lưu một memory NGUYÊN VĂN (verbatim) — đúng câu chữ đưa vào, không tóm tắt. ' +
        'Dùng khi user nói rõ muốn lưu ("hãy nhớ…") hoặc khi autosave đã chọn câu đáng nhớ. ' +
        'Text trùng (cùng wing+room+text) sẽ trả record đã có thay vì nhân đôi.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text nguyên văn cần lưu.' },
          wing: { type: 'string', description: 'Wing: người/dự án (mặc định "default").' },
          room: { type: 'string', description: 'Room: chủ đề (mặc định "general").' },
          drawer: { type: 'string', description: 'Drawer: nhóm con tuỳ ý.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag tự do.' },
          source: { type: 'string', description: 'Nguồn: user|agent|tool|import|autosave|manual.' },
          botId: { type: 'string', description: 'Bot sở hữu record (mặc định "").' },
          sessionId: { type: 'string', description: 'Session đã sinh ra record.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        try {
          needWrites();
          const text = asString(args['text'], 'text');
          const result = await store.save({
            text,
            wing: asOptionalString(args['wing'], 'wing'),
            room: asOptionalString(args['room'], 'room'),
            drawer: asOptionalString(args['drawer'], 'drawer'),
            tags: asStringArray(args['tags'], 'tags'),
            source: (asOptionalString(args['source'], 'source') as VerbatimSource | undefined) ?? 'manual',
            botId: asOptionalString(args['botId'], 'botId'),
            sessionId: asOptionalString(args['sessionId'], 'sessionId'),
          });
          return toolResultJson({ ...publicVerbatimRecord(result.record), created: result.created });
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: 'memory.search',
      description:
        'Tìm memory nguyên văn liên quan tới query (hybrid: BM25 từ khoá + embedding ngữ nghĩa khi có Ollama, ' +
        'fallback về từ khoá khi không có vector). Lọc trước theo wing/room/tags/botId khi cần. Trả record kèm score.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Câu hỏi / từ khoá cần tìm.' },
          limit: { type: 'number', description: 'Số hit tối đa (mặc định 10, tối đa 50).' },
          wing: { type: 'string' },
          room: { type: 'string' },
          drawer: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          botId: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async (args) => {
        try {
          const query = asString(args['query'], 'query');
          const result = await store.search(query, {
            limit: asNumber(args['limit'], 'limit', 10),
            filter: parseFilter(args),
          });
          return toolResultJson({
            hits: result.hits.map((h) => ({
              ...publicVerbatimRecord(h.record),
              score: h.score,
              keywordScore: h.keywordScore,
              semanticScore: h.semanticScore,
            })),
            usedFallback: result.usedFallback,
            fallbackReason: result.fallbackReason,
            candidates: result.candidates,
          });
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: 'memory.list',
      description:
        'Liệt kê memory nguyên văn (mới nhất trước), lọc theo wing/room/tags/source/botId/sessionId, có phân trang.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Số record tối đa (mặc định 50, tối đa 1000).' },
          offset: { type: 'number', description: 'Bỏ qua N record đầu.' },
          wing: { type: 'string' },
          room: { type: 'string' },
          drawer: { type: 'string' },
          source: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          botId: { type: 'string' },
          sessionId: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async (args) => {
        try {
          const result = await store.list({
            limit: asNumber(args['limit'], 'limit', 50),
            offset: asNumber(args['offset'], 'offset', 0),
            filter: parseFilter(args),
          });
          return toolResultJson(result);
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: 'memory.delete',
      description: 'Xoá một memory nguyên văn theo id. Không khôi phục được — chỉ xoá khi user xác nhận.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id của record cần xoá.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false },
      handler: async (args) => {
        try {
          needWrites();
          const id = asString(args['id'], 'id');
          const deleted = await store.delete(id);
          return toolResultJson({ id, deleted });
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: 'memory.stats',
      description: 'Thống kê verbatim store: tổng record, số đã embed, số wing/room, phân bố theo source/wing, backend đang dùng.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async () => {
        try {
          return toolResultJson(await store.stats());
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
  return tools;
}

/**
 * Tạo McpServer chỉ expose 5 tool memory (không kèm tool mặc định
 * của McpServer — `allowedTools` khoá đúng 5 tên). Dùng cho stdio
 * (Claude Code / Codex CLI / Cursor…) hoặc nhúng vào host khác.
 */
export function createVerbatimMemoryMcpServer(
  store: VerbatimMemoryStore,
  opts: VerbatimMcpServerOptions = {},
): McpServer {
  const allowWrites = opts.allowWrites ?? true;
  return createMcpServer({
    name: opts.name ?? 'open-bot-verbatim-memory',
    version: opts.version ?? '1.0.0',
    allowedTools: [...VERBATIM_MCP_TOOL_NAMES],
    tools: createVerbatimMcpTools(store, { allowWrites }),
    onLog: opts.onLog,
  });
}

/**
 * Chạy MCP server qua stdio (stdin/stdout NDJSON) — entry cho CLI
 * `open-bot memory-mcp`. Resolve khi stdin đóng.
 */
export async function runVerbatimMemoryMcpStdio(
  store: VerbatimMemoryStore,
  opts: VerbatimMcpServerOptions = {},
): Promise<void> {
  const server = createVerbatimMemoryMcpServer(store, opts);
  await server.serveStdio(process.stdin, process.stdout);
}

export interface VerbatimMcpHttpOptions extends VerbatimMcpServerOptions {
  /** Cổng HTTP (mặc định 0 = tự chọn cổng trống). */
  port?: number;
  /** Host bind (mặc định '127.0.0.1' — loopback only, không bind 0.0.0.0). */
  host?: string;
  /** Đường dẫn RPC (mặc định '/mcp'). */
  path?: string;
}

/**
 * Chạy MCP server qua Streamable HTTP trên loopback (cho team /
 * multi-machine: agent ở máy khác trỏ MCP client tới URL này).
 * Ghi KHÔNG được phép qua HTTP mặc định (allowWrites=false) trừ khi
 * host bật tường minh — tránh xoá nhầm từ xa.
 */
export async function runVerbatimMemoryMcpHttp(
  store: VerbatimMemoryStore,
  opts: VerbatimMcpHttpOptions = {},
): Promise<{ port: number; url: string; isRunning: boolean; close: () => Promise<void> }> {
  const server = createVerbatimMemoryMcpServer(store, {
    ...opts,
    allowWrites: opts.allowWrites ?? false,
  });
  return startMcpHttpServer(server, {
    port: opts.port ?? 0,
    host: opts.host ?? '127.0.0.1',
    path: opts.path ?? '/mcp',
  });
}

/** Kiểm tra một tên tool có phải tool memory.* không (để host validate allowlist). */
export function isVerbatimMcpToolName(name: string): name is VerbatimMcpToolName {
  return (VERBATIM_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Tên tool ghi trong số 5 tool (cần allowWrites). */
export function isVerbatimMcpWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name);
}
