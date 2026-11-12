/**
 * Đăng ký handler mặc định cho dispatcher của MCP client (v0.13, integration).
 *
 * W5a đưa dispatcher, W5b đưa elicitation — file này là chỗ nối hai thứ
 * lại với nhau, cộng thêm `roots/list`:
 *
 *  - `elicitation/create` — hỏi user qua `elicitationPrompt` do caller
 *    tiêm vào (desktop: modal ở renderer, qua event `mcp.elicitation-needed`
 *    + RPC `respondElicitation`; test: hàm giả). Không có prompt thì
 *    KHÔNG đăng ký handler và KHÔNG quảng cáo capability `elicitation`
 *    — server nào đòi elicitation sẽ nhận `-32601` thay vì treo chờ
 *    một câu trả lời không bao giờ tới.
 *  - `roots/list` — trả workspace root (`file://<workspaceDir>`) khi
 *    caller cho biết workspace. Không có workspace thì không đăng ký.
 *  - `sampling/createMessage` — chỉ khi caller tiêm `samplingHandler`
 *    (một provider thật). Mặc định KHÔNG có: `createSamplingHandler`
 *    (cuối file) nối sampling với provider của bot đang chạy — coordinator
 *    tiêm nó khi kết nối MCP client (xem `callSystemToolFor`). Không có
 *    handler thì không đăng ký sampling và không quảng cáo capability.
 *    Handler hỗ trợ tool (SEP-1577, v0.20 W15b): xem `createSamplingHandler`.
 *  - `notifications/elicitation/complete` — notification URL-mode:
 *    đánh dấu tracker xong để prompt nào đang chờ ngoài băng được giải phóng.
 *
 * `connectMcp` gọi hàm này trước `initialize()` khi config có
 * `clientHandlers`, và quảng cáo đúng capability theo handler thật có
 * (`buildMcpClientCapabilities`) — không bao giờ claim capability
 * không honour được.
 */
import { pathToFileURL } from 'node:url';
import type { ChatMessage, Provider, ToolDefinition } from '../types';
import { estimateTokens } from '../agent/tokens';
import type { McpClient } from './types';
import type { SamplingContextStore } from './samplingContext';
import {
  createElicitationHandler,
  ElicitationUrlTracker,
  parseElicitationCompleteNotification,
} from './elicitation';
import type { ElicitationPrompt } from './elicitation';

/** Handler cho `sampling/createMessage` do server gửi (khi có). */
export type McpSamplingHandler = (params: unknown) => unknown | Promise<unknown>;

export interface McpClientHandlerOptions {
  /** Tên server — UI hiển thị cho user biết ai đang hỏi (mặc định 'MCP server'). */
  serverName?: string;
  /** Thư mục workspace làm root cho `roots/list`. Không có thì không đăng ký roots. */
  workspaceDir?: string;
  /** Hàm hỏi user khi server gửi `elicitation/create`. Không có thì không đăng ký elicitation. */
  elicitationPrompt?: ElicitationPrompt;
  /** Handler cho `sampling/createMessage`. Không có thì không đăng ký sampling. */
  samplingHandler?: McpSamplingHandler;
  /**
   * v0.85 (P2-8): timeout (ms) chờ server báo hoàn tất một URL-mode
   * elicitation (`notifications/elicitation/complete`) sau khi user
   * accept — nối vào `createElicitationHandler` cùng tracker. Không
   * đặt thì dùng `DEFAULT_ELICITATION_URL_COMPLETION_TIMEOUT_MS`
   * (10 phút, cùng cửa sổ với timeout hỏi user của coordinator).
   */
  urlCompletionTimeoutMs?: number;
}

export interface RegisteredMcpClientHandlers {
  /** Tracker URL-mode — prompt nào cần chờ notification complete thì dùng. */
  urlTracker: ElicitationUrlTracker;
  /** Capability đã quảng cáo (trùng với cái `connectMcp` đưa vào `initialize`). */
  capabilities: Record<string, unknown>;
}

/**
 * Capability client quảng cáo trong `initialize`, tính từ handler thật
 * có: elicitation chỉ khi có prompt hỏi user, roots chỉ khi có workspace,
 * sampling chỉ khi có handler. Luôn có `experimental: {}` như trước.
 */
export function buildMcpClientCapabilities(
  options?: McpClientHandlerOptions,
): Record<string, unknown> {
  const caps: Record<string, unknown> = { experimental: {} };
  if (options?.elicitationPrompt) caps['elicitation'] = {};
  if (options?.workspaceDir) caps['roots'] = { listChanged: false };
  if (options?.samplingHandler) caps['sampling'] = {};
  return caps;
}

/**
 * Đăng ký handler mặc định lên dispatcher của client. Client nào không
 * có dispatcher (`getDispatcher` vắng) thì throw rõ ràng — caller phải
 * dùng StdioMcpClient / StreamableHttpMcpClient.
 */
export function registerDefaultMcpClientHandlers(
  client: McpClient,
  options: McpClientHandlerOptions = {},
): RegisteredMcpClientHandlers {
  const dispatcher = client.getDispatcher?.();
  if (!dispatcher) {
    throw new Error(
      'MCP client này không có dispatcher — không đăng ký được handler mặc định.',
    );
  }
  const serverName = options.serverName?.trim() || 'MCP server';
  const urlTracker = new ElicitationUrlTracker();

  if (options.elicitationPrompt) {
    // v0.85 (P2-8): nối tracker vào handler — URL-mode accept thì
    // handler chờ notification complete (có timeout) rồi mới trả kết
    // quả; notification tới thì `complete()` giải phóng lượt chờ.
    const handler = createElicitationHandler(options.elicitationPrompt, {
      urlTracker,
      ...(options.urlCompletionTimeoutMs !== undefined
        ? { urlCompletionTimeoutMs: options.urlCompletionTimeoutMs }
        : {}),
    });
    dispatcher.register('elicitation/create', (params) => handler(params, serverName));
    dispatcher.register('notifications/elicitation/complete', (params, ctx) => {
      const id = parseElicitationCompleteNotification(ctx.method, params);
      if (id) urlTracker.complete(id);
    });
  }

  if (options.workspaceDir) {
    const workspaceDir = options.workspaceDir;
    dispatcher.register('roots/list', () => ({
      roots: [
        {
          uri: pathToFileURL(workspaceDir).href,
          name: workspaceDir.split(/[\\/]/).filter(Boolean).pop() ?? workspaceDir,
        },
      ],
    }));
  }

  if (options.samplingHandler) {
    const samplingHandler = options.samplingHandler;
    dispatcher.register('sampling/createMessage', (params) => samplingHandler(params));
  }

  return { urlTracker, capabilities: buildMcpClientCapabilities(options) };
}

// ---------------------------------------------------------------------------
// sampling/createMessage — handler thật, nối với provider của bot (v0.13+)
// ---------------------------------------------------------------------------

/** Lỗi parse / chạy sampling — dispatcher chuyển thành lỗi MCP `-32603` rõ ràng. */
export class SamplingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SamplingError';
  }
}

/**
 * Hàm thực thi một tool mà provider gọi trong lúc sampling.
 * Trả về text kết quả để đưa lại vào messages cho provider.
 * Caller thường nối với MCP server đang xin sampling
 * (`client.callTool.bind(client)` — gọi `tools/call` ngược về server),
 * hoặc với tool registry của bot. Ném lỗi khi tool thất bại — handler
 * chuyển thành `SamplingError` rõ ràng, không crash run.
 */
export type SamplingToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** `toolChoice` của sampling request (spec MCP 2025-11-25, SEP-1577). */
export interface SamplingToolChoice {
  type: 'auto' | 'none' | 'tool';
  /** Chỉ có khi `type === 'tool'`: tên tool duy nhất được phép gọi. */
  name?: string;
}

export interface SamplingHandlerOptions {
  /**
   * Model gửi cho `provider.chat` và ghi vào kết quả trả server.
   * Mặc định là model của bot đang chạy; `modelPreferences.hints`
   * của server có thể đổi model này khi hint khớp model provider có
   * (xem `createSamplingHandler`) — không khớp thì giữ model này.
   */
  model: string;
  /**
   * Trần `maxTokens` server được xin (mặc định 4096). Server xin hơn
   * thì bị kẹp xuống trần này thay vì lỗi — sampling là một lần chat
   * ngắn, không phải một run đầy đủ.
   */
  maxTokensCap?: number;
  /**
   * `maxTokens` dùng khi server không gửi (spec nói là bắt buộc nhưng
   * cứ khoan dung). Mặc định 1024.
   */
  defaultMaxTokens?: number;
  /** Timeout cho một lần gọi provider (mặc định 60_000ms). */
  timeoutMs?: number;
  /**
   * System prompt phụ, đặt TRƯỚC `systemPrompt` server gửi (nếu có).
   * Coordinator hiện không truyền gì ở đây — system prompt của bot
   * không tự động đưa vào sampling.
   */
  systemPrompt?: string;
  /**
   * Đường gọi tool NGƯỢC về MCP server đang xin sampling — thường là
   * `client.callTool.bind(client)` của chính client đó (gọi
   * `tools/call` trên server). Ưu tiên hơn `executeTool`. v0.23:
   * coordinator (`callSystemToolFor`) và pool (`withMcpClient`) đã
   * nối sẵn qua holder gán sau `connectMcp`; caller khác không truyền
   * thì provider gọi tool sẽ lỗi rõ ràng thay vì im lặng bỏ qua tools.
   */
  callServerTool?: SamplingToolExecutor;
  /**
   * Fallback khi không có `callServerTool`: thực thi tool bằng tool
   * registry của bot (caller tự nối). Chỉ dùng khi `callServerTool`
   * vắng; cả hai đều vắng thì tool provider gọi sẽ lỗi rõ ràng.
   */
  executeTool?: SamplingToolExecutor;
  /**
   * Provider có hỗ trợ tool calling không. Mặc định lấy từ
   * `provider.supportsToolCalling` (provider nào cũng có thể gắn cờ
   * này) — vắng thì coi là CÓ (cả 6 provider built-in đều hỗ trợ
   * tools qua `ChatCompletionRequest.tools`: họ OpenAI-compatible,
   * Anthropic, Gemini). Đặt `false` (ở đây hoặc trên provider) mà
   * request có tools thì handler lỗi rõ ngay, không gọi provider.
   */
  supportsToolCalling?: boolean;
  /**
   * Số vòng thực thi tool tối đa trong một lần sampling (mặc định 3,
   * kẹp trong khoảng 1..3 — quá 3 cũng chỉ chạy 3 vòng rồi dừng).
   */
  maxToolRounds?: number;
  /**
   * Tên server của handler này — dùng làm khóa khi ghi lịch sử vào
   * `contextStore` (mặc định `'default'`). Đường system truyền
   * `'system'`; đường pool không biết tên server (caller pool chỉ
   * truyền `callServerTool`) nên để mặc định — mọi handler pool của
   * cùng bot vẫn ghi chung một khóa, và đọc `'allServers'` lấy toàn
   * bộ lịch sử nên không ảnh hưởng kết quả.
   */
  serverName?: string;
  /**
   * Store lịch sử sampling dùng chung giữa các handler của cùng một
   * bot (v0.24 W17d — xem `mcp/samplingContext.ts`). Khi có store và
   * request xin `includeContext: 'allServers'`, handler đọc lịch sử
   * của MỌI server trong store thay vì chỉ lịch sử riêng; sau mỗi lần
   * sampling thành công handler append lượt của mình vào store để
   * server khác đọc được. Không có store thì `'allServers'` fallback
   * về lịch sử thisServer như trước (ghi rõ trong comment, không im
   * lặng giả vờ đủ). Mặc định KHÔNG có store — không dùng biến
   * global/module; coordinator tạo một store cho mỗi bot và tiêm vào
   * đây (xem `BotEntry.samplingContextStore`).
   */
  contextStore?: SamplingContextStore;
}

/** Một request sampling đã parse xong, sẵn đưa vào `provider.chat`. */
export interface ParsedSamplingRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens: number;
  /**
   * Tool definitions MCP (`tools` của request) đã đổi sang
   * `ToolDefinition` của bot (`inputSchema` -> `parameters`).
   * Vắng = request không xin tool.
   */
  tools?: ToolDefinition[];
  /** `toolChoice` của request; vắng = `'auto'` (provider tự quyết). */
  toolChoice?: SamplingToolChoice;
  /**
   * Tên model từ `modelPreferences.hints`, giữ nguyên thứ tự server
   * gửi. Vắng/rỗng = server không gợi ý model nào.
   */
  modelHintNames?: string[];
  /**
   * `includeContext` của request (spec MCP 2025-11-25, v0.23 W16b,
   * v0.24 W17d): `'none'` (vắng = mặc định — chat độc lập, không kèm
   * lịch sử), `'thisServer'` (kèm lịch sử sampling của chính handler
   * instance này), `'allServers'` (kèm lịch sử của MỌI server của bot
   * — đọc từ `contextStore` khi handler được tiêm store; không có
   * store thì fallback về lịch sử thisServer — xem
   * `createSamplingHandler`).
   */
  includeContext?: 'none' | 'thisServer' | 'allServers';
  /**
   * `stopSequences` của request (v0.23 W16b): provider dừng sinh text
   * ở lần xuất hiện đầu tiên của bất kỳ chuỗi nào. Vắng/rỗng = không
   * dừng sớm. Handler truyền xuống `provider.chat` dưới tên `stop`
   * (nối native ở 3 provider built-in) và cắt client-side làm backstop.
   *
   * v0.26 (W19b, cách (b)): đây là DANH SÁCH ĐẦY ĐỦ server gửi (sau
   * khử trùng, giữ nguyên thứ tự) — KHÔNG bị kẹp ở đây, vì backstop
   * client-side (`truncateAtStopSequence` trong `finish()`) phải dùng
   * đủ list gốc để cắt đúng cả chuỗi provider không nhận được. List
   * đưa xuống provider mới bị kẹp: handler kẹp trần chung 5
   * (`SAMPLING_PROVIDER_STOP_SEQUENCES_MAX`) rồi mỗi provider kẹp
   * tiếp theo giới hạn của nó (OpenAI 4, Gemini 5; Anthropic không có
   * giới hạn số lượng trong doc chính thức nên provider đó không kẹp
   * thêm — xem comment ở `anthropic.ts`). Chuỗi thừa (vượt trần) bị
   * bỏ khỏi request gửi provider nhưng vẫn cắt được ở backstop.
   */
  stopSequences?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ép một sampling message thành `ChatMessage` (chỉ text).
 * Spec 2025-11-25: `content` là một block `text` hoặc `image` (hoặc
 * mảng các block — khoan dung thêm). Ảnh không gửi được qua chat text
 * nên thành placeholder ghi rõ; block lạ thì thành JSON text thay vì
 * làm hỏng cả request.
 */
function samplingMessageToChatMessage(message: unknown, index: number): ChatMessage {
  if (!isRecord(message)) {
    throw new SamplingError(
      `sampling/createMessage: messages[${index}] phải là object { role, content }.`,
    );
  }
  const role = message['role'];
  if (role !== 'user' && role !== 'assistant') {
    throw new SamplingError(
      `sampling/createMessage: messages[${index}].role phải là "user" hoặc "assistant".`,
    );
  }
  const rawContent = message['content'];
  const blocks = Array.isArray(rawContent) ? rawContent : [rawContent];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    } else if (block['type'] === 'image') {
      const mime = typeof block['mimeType'] === 'string' ? block['mimeType'] : 'image';
      parts.push(`[image content (${mime}) — sampling chỉ trả text nên ảnh không được gửi kèm]`);
    } else if (block['type'] !== undefined) {
      parts.push(JSON.stringify(block));
    }
  }
  const text = parts.join('\n').trim();
  if (!text) {
    throw new SamplingError(
      `sampling/createMessage: messages[${index}] không có nội dung text nào.`,
    );
  }
  return { role, content: text };
}

/**
 * Parse `tools` của sampling request (SEP-1577) thành `ToolDefinition`
 * của bot: `inputSchema` (chuẩn MCP) thành `parameters`; thiếu
 * `inputSchema` thì mặc định schema object rỗng; `parameters` cũng
 * được chấp nhận như bí danh. Tên trùng hoặc thiếu tên, `description`
 * / `inputSchema` sai kiểu thì ném `SamplingError` — tool định nghĩa
 * sai không được đưa lén cho provider.
 */
function parseSamplingTools(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw)) {
    throw new SamplingError('sampling/createMessage: "tools" (khi có) phải là một mảng.');
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!isRecord(entry)) {
      throw new SamplingError(`sampling/createMessage: tools[${i}] phải là một object.`);
    }
    const name = entry['name'];
    if (typeof name !== 'string' || !name.trim()) {
      throw new SamplingError(`sampling/createMessage: tools[${i}].name phải là chuỗi không rỗng.`);
    }
    if (seen.has(name)) {
      throw new SamplingError(`sampling/createMessage: tools có tên trùng nhau: "${name}".`);
    }
    seen.add(name);
    const description = entry['description'];
    if (description !== undefined && typeof description !== 'string') {
      throw new SamplingError(`sampling/createMessage: tools[${i}].description phải là chuỗi.`);
    }
    const schema = entry['inputSchema'] ?? entry['parameters'];
    if (schema !== undefined && !isRecord(schema)) {
      throw new SamplingError(`sampling/createMessage: tools[${i}].inputSchema phải là một object.`);
    }
    return {
      name,
      description: typeof description === 'string' ? description : '',
      parameters: isRecord(schema) ? (schema as Record<string, unknown>) : { type: 'object', properties: {} },
    };
  });
}

/**
 * Parse `toolChoice` (SEP-1577): `{ type: 'auto' | 'none' | 'tool',
 * name? }`. `type: 'tool'` bắt buộc có `name` không rỗng; `type` lạ
 * hoặc `name` thiếu thì ném `SamplingError` thay vì đoán.
 */
function parseSamplingToolChoice(raw: unknown): SamplingToolChoice {
  if (!isRecord(raw)) {
    throw new SamplingError('sampling/createMessage: "toolChoice" (khi có) phải là một object.');
  }
  const type = raw['type'];
  if (type !== 'auto' && type !== 'none' && type !== 'tool') {
    throw new SamplingError(
      'sampling/createMessage: toolChoice.type phải là "auto", "none" hoặc "tool".',
    );
  }
  if (type === 'tool') {
    const name = raw['name'];
    if (typeof name !== 'string' || !name.trim()) {
      throw new SamplingError(
        'sampling/createMessage: toolChoice { type: "tool" } cần "name" là tên tool không rỗng.',
      );
    }
    return { type, name };
  }
  return { type };
}

/**
 * Parse `includeContext` (spec MCP 2025-11-25): `'none' | 'thisServer' |
 * 'allServers'`. Giá trị lạ thì ném `SamplingError` thay vì đoán —
 * đoán sai (vd coi `'everything'` là `'allServers'`) sẽ kèm lịch sử
 * mà server không xin.
 */
function parseSamplingIncludeContext(raw: unknown): 'none' | 'thisServer' | 'allServers' {
  if (raw !== 'none' && raw !== 'thisServer' && raw !== 'allServers') {
    throw new SamplingError(
      'sampling/createMessage: "includeContext" (khi có) phải là "none", "thisServer" hoặc "allServers".',
    );
  }
  return raw;
}

/**
 * Parse `stopSequences`: mảng chuỗi không rỗng, khử trùng giữ nguyên
 * thứ tự. Sai kiểu / chuỗi rỗng thì ném `SamplingError` — chuỗi dừng
 * rỗng sẽ cắt mọi text về rỗng nên không được im lặng chấp nhận.
 * Trả DANH SÁCH ĐẦY ĐỦ (không kẹp số lượng ở đây): kẹp xảy ra lúc
 * gửi cho provider (trần chung 5 ở handler + kẹp riêng mỗi provider,
 * xem `SAMPLING_PROVIDER_STOP_SEQUENCES_MAX`), còn backstop
 * client-side phải dùng đủ list gốc — xem doc của
 * `ParsedSamplingRequest.stopSequences`.
 */
function parseSamplingStopSequences(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new SamplingError('sampling/createMessage: "stopSequences" (khi có) phải là một mảng chuỗi.');
  }
  const out: string[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new SamplingError(
        `sampling/createMessage: stopSequences[${i}] phải là chuỗi không rỗng.`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * Lấy tên model từ `modelPreferences.hints` (mảng `{ name }`).
 * Hint không phải object hoặc thiếu `name` chuỗi thì bỏ qua lặng lẽ
 * (hints chỉ là gợi ý, không đáng fail cả request); `hints` sai kiểu
 * hẳn thì ném `SamplingError`.
 */
function parseModelHintNames(raw: unknown): string[] {
  if (!isRecord(raw)) {
    throw new SamplingError('sampling/createMessage: "modelPreferences" (khi có) phải là một object.');
  }
  const hints = raw['hints'];
  if (hints === undefined) return [];
  if (!Array.isArray(hints)) {
    throw new SamplingError('sampling/createMessage: modelPreferences.hints phải là một mảng.');
  }
  const names: string[] = [];
  for (const hint of hints) {
    if (isRecord(hint) && typeof hint['name'] === 'string' && hint['name'].trim()) {
      names.push((hint['name'] as string).trim());
    }
  }
  return names;
}

/**
 * Parse params thô của `sampling/createMessage` (spec MCP 2025-11-25).
 * Ném `SamplingError` khi thiếu/sai messages, role, systemPrompt hay
 * temperature/maxTokens không phải số. `maxTokens` vắng thì dùng mặc
 * định, vượt trần thì kẹp xuống trần — không ném lỗi vì số token.
 */
export function parseSamplingRequest(
  params: unknown,
  options?: { maxTokensCap?: number; defaultMaxTokens?: number },
): ParsedSamplingRequest {
  const cap =
    typeof options?.maxTokensCap === 'number' && Number.isFinite(options.maxTokensCap) && options.maxTokensCap > 0
      ? Math.floor(options.maxTokensCap)
      : 4096;
  const fallback =
    typeof options?.defaultMaxTokens === 'number' && Number.isFinite(options.defaultMaxTokens) && options.defaultMaxTokens > 0
      ? Math.floor(options.defaultMaxTokens)
      : 1024;
  if (!isRecord(params)) {
    throw new SamplingError('sampling/createMessage: params phải là một object.');
  }
  const rawMessages = params['messages'];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new SamplingError(
      'sampling/createMessage: cần "messages" là mảng không rỗng [{ role, content }].',
    );
  }
  const messages = rawMessages.map((m, i) => samplingMessageToChatMessage(m, i));
  const out: ParsedSamplingRequest = {
    messages,
    maxTokens: fallback,
  };
  if (params['systemPrompt'] !== undefined) {
    if (typeof params['systemPrompt'] !== 'string' || !params['systemPrompt'].trim()) {
      throw new SamplingError('sampling/createMessage: "systemPrompt" (khi có) phải là chuỗi không rỗng.');
    }
    out.systemPrompt = params['systemPrompt'] as string;
  }
  if (params['temperature'] !== undefined) {
    if (typeof params['temperature'] !== 'number' || !Number.isFinite(params['temperature'])) {
      throw new SamplingError('sampling/createMessage: "temperature" (khi có) phải là một số.');
    }
    out.temperature = params['temperature'] as number;
  }
  if (params['maxTokens'] !== undefined) {
    if (typeof params['maxTokens'] !== 'number' || !Number.isFinite(params['maxTokens']) || params['maxTokens'] <= 0) {
      throw new SamplingError('sampling/createMessage: "maxTokens" (khi có) phải là số dương.');
    }
    out.maxTokens = Math.min(Math.floor(params['maxTokens'] as number), cap);
  }
  if (params['tools'] !== undefined) {
    const tools = parseSamplingTools(params['tools']);
    if (tools.length > 0) out.tools = tools;
  }
  if (params['toolChoice'] !== undefined) {
    out.toolChoice = parseSamplingToolChoice(params['toolChoice']);
  }
  if (params['modelPreferences'] !== undefined) {
    const hints = parseModelHintNames(params['modelPreferences']);
    if (hints.length > 0) out.modelHintNames = hints;
  }
  if (params['includeContext'] !== undefined) {
    out.includeContext = parseSamplingIncludeContext(params['includeContext']);
  }
  if (params['stopSequences'] !== undefined) {
    const stops = parseSamplingStopSequences(params['stopSequences']);
    if (stops.length > 0) out.stopSequences = stops;
  }
  return out;
}

/**
 * Số message lịch sử sampling tối đa giữ trong một handler instance
 * (v0.23 W16b, `includeContext: 'thisServer'`). 20 message ≈ 10 lượt
 * hỏi-đáp — đủ để server hỏi tiếp theo ngữ cảnh mà không phình
 * context vô hạn.
 */
export const SAMPLING_HISTORY_MAX_MESSAGES = 20;

/**
 * Ngân sách ước lượng cho lịch sử prepend (v0.23 W16b): tổng lịch sử
 * (đếm bằng `estimateTokens`, cùng estimator với compaction/smallModel
 * ở v0.21) vượt 2048 token ước lượng thì cắt message cũ nhất cho tới
 * khi vừa ngân sách. Ngưỡng này chỉ áp cho PHẦN LỊCH SỬ prepend,
 * không tính messages mới của request hiện tại — request mới luôn được
 * gửi đủ, chỉ lịch sử bị cắt. Đây là heuristic (không phải đếm bằng
 * tokenizer thật của provider), nên provider vẫn có thể thấy nhiều
 * token hơn ước lượng một chút.
 */
export const SAMPLING_HISTORY_MAX_TOKENS = 2048;

/**
 * Trần chung số `stopSequences` handler đưa xuống `provider.chat`
 * (v0.26 W19b, cách (b) — backstop của handler).
 *
 * 5 = giới hạn lớn nhất trong các provider có giới hạn kiểm chứng
 * được (Gemini `generationConfig.stopSequences` tối đa 5; OpenAI
 * `stop` tối đa 4 — provider OpenAI kẹp tiếp xuống 4 ở tầng của nó;
 * Anthropic `stop_sequences` KHÔNG có giới hạn số lượng trong doc
 * chính thức — Messages API reference, docs.claude.com/en/api/messages,
 * kiểm tra 2026-11-09 — nên provider Anthropic không kẹp thêm, và
 * trong đường sampling nó nhận tối đa 5 nhờ trần chung này).
 *
 * List đầy đủ server gửi vẫn giữ nguyên trong
 * `ParsedSamplingRequest.stopSequences` để backstop client-side
 * (`truncateAtStopSequence`) cắt đúng cả chuỗi thứ 6 trở đi mà
 * provider không nhận được — chuỗi thừa chỉ bị bỏ khỏi request gửi
 * provider, không bị bỏ khỏi việc cắt text. Khi cắt, handler log
 * `console.warn` một dòng ghi rõ số chuỗi bị bỏ (không in nội dung
 * chuỗi ra log), để việc cắt không diễn ra im lặng.
 */
export const SAMPLING_PROVIDER_STOP_SEQUENCES_MAX = 5;

/**
 * Cắt lịch sử về vừa cả hai ngưỡng: tối đa
 * `SAMPLING_HISTORY_MAX_MESSAGES` message gần nhất, rồi cắt message cũ
 * nhất cho tới khi tổng ước lượng ≤ `SAMPLING_HISTORY_MAX_TOKENS`.
 * Trả mảng mới, không mutate mảng vào.
 */
function trimSamplingHistory(history: ChatMessage[]): ChatMessage[] {
  let trimmed = history.slice(-SAMPLING_HISTORY_MAX_MESSAGES);
  while (
    trimmed.length > 0 &&
    trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0) >
      SAMPLING_HISTORY_MAX_TOKENS
  ) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/**
 * Backstop client-side cho `stopSequences` (v0.23 W16b): cắt text ở lần
 * xuất hiện ĐẦU TIÊN của bất kỳ stop sequence nào (chuỗi dừng không nằm
 * trong text trả về). Provider hỗ trợ native đã dừng trước đó nên
 * backstop thường không cắt gì thêm; provider bỏ qua `stop` (vd
 * provider tự viết, mock trong test) thì backstop vẫn đảm bảo text trả
 * server dừng đúng chỗ — chỉ khác là không tiết kiệm được token.
 */
function truncateAtStopSequence(text: string, stops?: string[]): string {
  if (!stops || stops.length === 0 || !text) return text;
  let cut = text.length;
  for (const seq of stops) {
    const i = text.indexOf(seq);
    if (i !== -1 && i < cut) cut = i;
  }
  return text.slice(0, cut);
}

/**
 * Lý do dừng của một lần sampling, trả về cho server trong
 * `stopReason` (v0.24 W17d thêm `'stopSequence'`):
 *  - `'endTurn'` — provider dừng tự nhiên (hoặc dừng native vì stop
 *    sequence mà handler không phân biệt được — xem `finish`).
 *  - `'maxTokens'` — heuristic: `usage.outputTokens >= maxTokens`
 *    (ProviderResponse không có finish reason).
 *  - `'stopSequence'` — backstop client-side trong handler cắt text vì
 *    gặp stop sequence (text provider trả vẫn chứa stop sequence, tức
 *    provider đã bỏ qua `stop` native).
 */
export type SamplingStopReason = 'endTurn' | 'maxTokens' | 'stopSequence';

/**
 * Tạo `samplingHandler` thật từ provider của bot: server MCP xin LLM
 * thì chạy `provider.chat` với model của bot rồi trả kết quả đúng
 * shape spec (`{ role: 'assistant', content: { type: 'text', text },
 * model, stopReason: 'endTurn' | 'maxTokens' | 'stopSequence' }`).
 *
 * Tool calling (SEP-1577, v0.20 W15b) — khi request có `tools` và
 * provider hỗ trợ tool calling thì chạy vòng lặp nhỏ: gửi messages +
 * tools cho provider, provider trả tool-call thì thực thi tool rồi đưa
 * kết quả vào messages và gọi provider tiếp, tối đa `maxToolRounds`
 * (mặc định 3) vòng tool. `toolChoice: 'none'` thì không đưa tools cho
 * provider; `'auto'` thì đưa toàn bộ; `{ type: 'tool', name }` thì chỉ
 * đưa đúng tool đó (ép bằng cách thu hẹp danh sách — xem giới hạn).
 *
 * `modelPreferences.hints` — hint nào trùng model của bot thì dùng
 * model đó; không thì hỏi `provider.listModels()` (race 5s, lỗi/timeout
 * thì giữ model bot) và dùng hint đầu tiên provider có. Hint không
 * khớp model nào thì giữ model của bot, KHÔNG fail request.
 *
 * `includeContext` (v0.23 W16b, v0.24 W17d) — `'none'` (mặc định): mỗi
 *    lần sampling là một chat độc lập. `'thisServer'`: handler giữ lịch
 *    sử các lần sampling trước của CHÍNH handler instance này (mỗi
 *    lượt: messages của request + text trả về cuối, tối đa
 *    `SAMPLING_HISTORY_MAX_MESSAGES` message gần nhất và tổng ước lượng
 *    ≤ `SAMPLING_HISTORY_MAX_TOKENS` token — xem `trimSamplingHistory`),
 *    lần sau prepend lịch sử đó trước messages mới (sau system prompt).
 *    `'allServers'`: handler đọc lịch sử từ `contextStore` dùng chung
 *    (khi caller tiêm store — coordinator tiêm một store cho mỗi bot,
 *    xem `BotEntry.samplingContextStore`): lịch sử của MỌI server của
 *    bot đó, theo thứ tự thời gian, cũng cắt về vừa hai ngưỡng trên
 *    trước khi prepend. KHÔNG có store thì fallback về lịch sử
 *    thisServer (ghi rõ ở đây, không im lặng giả vờ đủ). Sau mỗi lần
 *    sampling thành công, handler append lượt của mình vào store (chỉ
 *    messages MỚI của lượt này — messages request + text cuối — không
 *    append lại phần lịch sử đã đọc nên không trùng lặp). Lịch sử
 *    riêng nằm trong closure của handler instance, KHÔNG dùng biến
 *    global/module — hai bot/handler khác nhau không thấy lịch sử của
 *    nhau (trừ khi dùng chung một store do cùng một bot tạo ra). Lưu ý
 *    vòng đời: đường system (`callSystemToolFor`) tạo handler MỚI mỗi
 *    lần gọi nhưng store sống theo bot nên lịch sử vẫn tích lũy qua
 *    các lần gọi (khác v0.23: trước kia lịch sử system-path gần như
 *    không tích lũy vì chỉ nằm trong closure handler); đường pool
 *    (`withMcpClient` / `getSamplingHandler`) handler sống theo pool
 *    entry nên lịch sử riêng tích lũy qua các lần gọi cho tới khi pool
 *    entry bị evict (5 phút idle), còn lịch sử trong store thì sống
 *    theo bot cho tới khi bot bị destroy/shutdown. Chỉ ghi lịch sử khi
 *    sampling thành công và text cuối không rỗng; tool-call/result
 *    trong một lượt KHÔNG lưu vào lịch sử (chỉ lưu messages request +
 *    text cuối) để lượt sau không replay tool.
 *  - `stopSequences` (v0.23 W16b, v0.26 W19b đổi sang cách (b)) —
 *    handler truyền xuống `provider.chat` dưới tên `stop`
 *    (`ChatCompletionRequest.stop`), nối native ở OpenAI-compatible
 *    (`stop`, cả OpenAI/xAI/Ollama kế thừa), Anthropic
 *    (`stop_sequences`) và Gemini (`generationConfig.stopSequences`)
 *    để provider dừng sinh sớm và tiết kiệm token; đồng thời cắt
 *    client-side (`truncateAtStopSequence`) làm backstop cho provider
 *    nào bỏ qua `stop`. Kẹp số lượng (W19b): handler kẹp trần chung
 *    5 chuỗi đầu tiên (`SAMPLING_PROVIDER_STOP_SEQUENCES_MAX` = max
 *    của Gemini) rồi mỗi provider kẹp tiếp theo giới hạn của nó
 *    (OpenAI 4, Gemini 5; Anthropic không có giới hạn số lượng trong
 *    doc chính thức nên không kẹp thêm ở tầng provider — trong đường
 *    sampling Anthropic vẫn chỉ nhận tối đa 5 nhờ trần chung của
 *    handler). Khi list dài hơn trần, handler log một dòng warn ghi
 *    rõ số chuỗi bị bỏ khỏi request gửi provider; backstop
 *    client-side vẫn dùng ĐẦY ĐỦ list gốc nên text trả về vẫn dừng
 *    đúng ở chuỗi thứ 6 trở đi.
 *
 * Giới hạn có chủ đích (ghi rõ cho server/caller):
 *  - Ép tool (`toolChoice: { type: 'tool' }`) chỉ bằng cách thu hẹp
 *    danh sách tools đưa cho provider — `ChatCompletionRequest` không
 *    có tham số `tool_choice` nên không ép ở tầng API được; provider
 *    vẫn có thể trả text mà không gọi tool bắt buộc. Provider gọi tool
 *    khác tool bị ép thì lỗi rõ ràng.
 *  - Đường gọi tool về server (`callServerTool`, thường là
 *    `client.callTool.bind(client)`) phải do caller tiêm vào — handler
 *    chỉ nhận `params` qua dispatcher (`McpDispatchContext` không có
 *    đường gọi ngược). v0.23: coordinator (`callSystemToolFor`, system
 *    server) và pool (`withMcpClient`) ĐÃ nối — mỗi bên dùng một holder
 *    gán client sau `connectMcp` (sampling chỉ tới sau initialize).
 *    Caller khác (test/direct) không truyền thì provider gọi tool vẫn
 *    lỗi `SamplingError` rõ ràng, không im lặng bỏ qua.
 *  - Chỉ provider nào hỗ trợ tool calling mới được chạy tools: cả 6
 *    provider built-in đều hỗ trợ (`ChatCompletionRequest.tools`),
 *    cờ `supportsToolCalling` (option hoặc trên provider) = `false`
 *    mà request có tools thì lỗi ngay trước khi gọi provider.
 *  - `stopReason: 'maxTokens'` chỉ là heuristic: `ProviderResponse`
 *    không có finish reason, nên suy ra từ
 *    `usage.outputTokens >= maxTokens`. `'stopSequence'` chỉ báo khi
 *    backstop client-side trong handler cắt text thật (text provider
 *    trả vẫn chứa stop sequence — tức provider bỏ qua `stop` native);
 *    còn lại khi provider tự dừng native vì stop thì text trả về đã
 *    không còn stop sequence nên handler không phân biệt được với dừng
 *    tự nhiên — vẫn báo `'endTurn'` (ghi rõ, không giả vờ phân biệt
 *    được).
 *  - `includeContext: 'allServers'` KHÔNG có store thì chỉ là fallback
 *    về lịch sử thisServer (xem trên) — server xin context liên-server
 *    sẽ không thấy lịch sử của server khác; muốn đủ thì caller phải
 *    tiêm `contextStore` dùng chung (coordinator đã tiêm cho mỗi bot).
 *  - Ngân sách lịch sử dùng `estimateTokens` (heuristic, không phải
 *    tokenizer thật của provider) nên số token provider thấy có thể
 *    lệch một chút so với ngưỡng 2048.
 *  - Timeout: toàn bộ handler (kể cả vòng tool + `listModels`) chịu
 *    chung một deadline `timeoutMs` (mặc định 60s) — quá hạn thì ném
 *    `SamplingError` rõ ràng, dispatcher chuyển thành lỗi MCP `-32603`,
 *    run của bot không crash, server nhận lỗi thay vì treo.
 */
export function createSamplingHandler(
  provider: Provider,
  options: SamplingHandlerOptions,
): McpSamplingHandler {
  const model = options.model?.trim();
  if (!model) {
    throw new SamplingError('createSamplingHandler cần options.model là tên model không rỗng.');
  }
  if (
    options.callServerTool !== undefined &&
    typeof options.callServerTool !== 'function'
  ) {
    throw new SamplingError('createSamplingHandler: options.callServerTool phải là một function.');
  }
  if (options.executeTool !== undefined && typeof options.executeTool !== 'function') {
    throw new SamplingError('createSamplingHandler: options.executeTool phải là một function.');
  }
  if (options.serverName !== undefined && typeof options.serverName !== 'string') {
    throw new SamplingError('createSamplingHandler: options.serverName phải là một chuỗi.');
  }
  if (options.contextStore !== undefined) {
    const store = options.contextStore as unknown as Record<string, unknown>;
    if (
      !store ||
      typeof store['getAllHistory'] !== 'function' ||
      typeof store['append'] !== 'function'
    ) {
      throw new SamplingError(
        'createSamplingHandler: options.contextStore phải là một SamplingContextStore (có getAllHistory/append).',
      );
    }
  }
  const maxTokensCap =
    typeof options.maxTokensCap === 'number' && Number.isFinite(options.maxTokensCap) && options.maxTokensCap > 0
      ? Math.floor(options.maxTokensCap)
      : 4096;
  const defaultMaxTokens =
    typeof options.defaultMaxTokens === 'number' && Number.isFinite(options.defaultMaxTokens) && options.defaultMaxTokens > 0
      ? Math.floor(options.defaultMaxTokens)
      : 1024;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : 60_000;
  const maxToolRounds =
    typeof options.maxToolRounds === 'number' && Number.isFinite(options.maxToolRounds)
      ? Math.min(3, Math.max(1, Math.floor(options.maxToolRounds)))
      : 3;
  const extraSystemPrompt = options.systemPrompt?.trim() || undefined;
  const toolExecutor = options.callServerTool ?? options.executeTool ?? null;
  // Provider có hỗ trợ tool calling không: option ép trước, rồi cờ trên
  // provider (`supportsToolCalling`, provider tự gắn), vắng cả hai thì
  // coi là CÓ (cả 6 provider built-in đều hỗ trợ tools).
  const providerSupportsTools = (() => {
    if (typeof options.supportsToolCalling === 'boolean') return options.supportsToolCalling;
    const flags = provider as unknown as {
      supportsToolCalling?: unknown;
      supportsTools?: unknown;
    };
    if (flags.supportsToolCalling === false || flags.supportsTools === false) return false;
    return true;
  })();

  // Lịch sử sampling của CHÍNH handler instance này (includeContext
  // 'thisServer', v0.23 W16b): mảng ChatMessage user/assistant, chỉ
  // trong closure này — không biến global/module nên hai handler (hai
  // bot, hai pool entry) không rò lịch sử sang nhau. Xem doc của
  // createSamplingHandler về vòng đời system-path vs pool-path.
  let samplingHistory: ChatMessage[] = [];
  // v0.24 W17d: store dùng chung cho 'allServers' (caller tiêm — một
  // store cho mỗi bot, do coordinator tạo) + tên server của handler
  // này để ghi vào store. Không có store thì 'allServers' fallback
  // về lịch sử riêng như trước.
  const contextStore = options.contextStore ?? null;
  const samplingServerName = options.serverName?.trim() || 'default';

  return async (params: unknown) => {
    const req = parseSamplingRequest(params, { maxTokensCap, defaultMaxTokens });

    // --- stopSequences: kẹp trần chung trước khi đưa xuống provider ---
    // v0.26 (W19b, cách (b)): chỉ 5 chuỗi đầu tiên (sau khử trùng) được
    // gửi cho provider — list dài hơn có thể bị provider reject thành
    // SamplingError rõ (v0.24 để lại). `req.stopSequences` giữ NGUYÊN
    // list đầy đủ: backstop client-side trong `finish()` dùng list gốc
    // để cắt đúng cả chuỗi thứ 6 trở đi. Chuỗi bị bỏ khỏi request được
    // log một dòng warn (chỉ ghi số lượng, không in nội dung chuỗi),
    // không im lặng cắt mất chuỗi server cần.
    const providerStopSequences = req.stopSequences
      ? req.stopSequences.slice(0, SAMPLING_PROVIDER_STOP_SEQUENCES_MAX)
      : undefined;
    if (
      req.stopSequences &&
      req.stopSequences.length > SAMPLING_PROVIDER_STOP_SEQUENCES_MAX
    ) {
      console.warn(
        `[mcp-sampling] stopSequences: server gửi ${req.stopSequences.length} chuỗi, ` +
          `chỉ gửi ${SAMPLING_PROVIDER_STOP_SEQUENCES_MAX} chuỗi đầu cho provider ` +
          `(${req.stopSequences.length - SAMPLING_PROVIDER_STOP_SEQUENCES_MAX} chuỗi còn lại ` +
          `vẫn được cắt client-side làm backstop).`,
      );
    }

    // --- modelPreferences.hints: đổi model khi hint khớp (W15b) ---
    // Không hints thì không gọi listModels (tránh một round-trip thừa);
    // hint trùng model bot thì dùng ngay, khỏi hỏi provider.
    let effectiveModel = model;
    if (req.modelHintNames && req.modelHintNames.length > 0) {
      if (!req.modelHintNames.includes(model)) {
        const available = await listProviderModels(provider, 5_000);
        const matched = matchHintedModel(req.modelHintNames, available);
        if (matched) effectiveModel = matched;
        // Không khớp / listModels lỗi / timeout: giữ model của bot.
      }
    }

    // --- tools / toolChoice: tính danh sách tools đưa cho provider ---
    let toolsToOffer: ToolDefinition[] | undefined;
    if (req.toolChoice?.type === 'tool' && (!req.tools || req.tools.length === 0)) {
      throw new SamplingError(
        `MCP sampling: toolChoice ép dùng tool "${req.toolChoice.name}" nhưng sampling request không có "tools" nào.`,
      );
    }
    if (req.tools && req.tools.length > 0) {
      if (req.toolChoice?.type === 'none') {
        toolsToOffer = undefined;
      } else if (req.toolChoice?.type === 'tool') {
        const forced = req.tools.find((t) => t.name === req.toolChoice?.name);
        if (!forced) {
          throw new SamplingError(
            `MCP sampling: toolChoice ép dùng tool "${req.toolChoice.name}" nhưng sampling request không có tool đó (chỉ có: ${req.tools.map((t) => t.name).join(', ') || '(không có tool nào)'}).`,
          );
        }
        toolsToOffer = [forced];
      } else {
        toolsToOffer = req.tools;
      }
    }
    if (toolsToOffer) {
      if (!providerSupportsTools) {
        throw new SamplingError(
          `MCP sampling: server yêu cầu tools (${toolsToOffer.map((t) => t.name).join(', ')}) nhưng provider "${provider.id}" không hỗ trợ tool calling — không thể chạy sampling kèm tool.`,
        );
      }
    }
    const forcedToolName =
      req.toolChoice?.type === 'tool' ? req.toolChoice.name : undefined;
    const offeredNames = new Set((toolsToOffer ?? []).map((t) => t.name));

    const messages: ChatMessage[] = [];
    const systemParts = [extraSystemPrompt, req.systemPrompt].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }
    // --- includeContext (v0.23 W16b, v0.24 W17d) ---
    // 'none'/vắng: không prepend. 'thisServer': prepend lịch sử riêng
    // của handler này. 'allServers': có store thì prepend lịch sử của
    // MỌI server trong store (theo thứ tự thời gian); không có store
    // thì fallback về lịch sử thisServer (ghi rõ, không giả vờ đủ).
    // Cả hai nguồn đều cắt về vừa ngưỡng (20 message / 2048 token ước
    // lượng) trước khi prepend. System prompt KHÔNG lưu vào lịch sử
    // (theo từng request) nên chỉ prepend sau nó.
    const includeContext = req.includeContext ?? 'none';
    const historyToPrepend =
      includeContext === 'none'
        ? []
        : includeContext === 'allServers' && contextStore
          ? trimSamplingHistory(contextStore.getAllHistory())
          : trimSamplingHistory(samplingHistory);
    messages.push(...historyToPrepend, ...req.messages);

    // --- deadline chung 60s cho toàn bộ handler (chat + vòng tool) ---
    const controller = new AbortController();
    const timeoutError = new SamplingError(
      `MCP sampling timed out sau ${timeoutMs}ms — model "${effectiveModel}" phản hồi chậm hoặc đã chết.`,
    );
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
      timer.unref?.();
    });
    // Race + signal: provider nào tôn trọng signal thì dừng sớm, provider
    // nào không thì race vẫn trả lỗi đúng hạn. Gắn catch để promise thua
    // race không thành unhandled rejection.
    const raceWithTimeout = <T>(p: Promise<T>): Promise<T> => {
      p.catch(() => undefined);
      return Promise.race([p, timeoutPromise]);
    };
    const chatOnce = async (msgs: ChatMessage[]) => {
      if (controller.signal.aborted) throw timeoutError;
      return raceWithTimeout(
        provider.chat({
          model: effectiveModel,
          messages: msgs,
          maxTokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          // v0.23 (W16b) + v0.26 (W19b): stopSequences xuống provider
          // dưới tên `stop` (nối native ở 3 provider built-in) — nhưng
          // CHỈ list đã kẹp trần chung 5 (`providerStopSequences`),
          // không phải list đầy đủ; backstop client-side ở `finish`
          // dùng list đầy đủ (`req.stopSequences`) nên vẫn cắt đúng
          // cả chuỗi provider không nhận được.
          ...(providerStopSequences ? { stop: providerStopSequences } : {}),
          ...(toolsToOffer ? { tools: toolsToOffer } : {}),
          signal: controller.signal,
        }),
      );
    };
    // stopReason 'maxTokens' là heuristic (xem doc ở trên): provider
    // không trả finish reason, chỉ có usage. Dừng vì stop sequence mà
    // provider tự dừng native thì text đã không còn stop sequence nên
    // vẫn là 'endTurn' — chỉ khi backstop client-side trong `finish`
    // cắt text thật mới báo 'stopSequence'.
    const stopReasonFor = (res: { usage?: { outputTokens?: number } }): SamplingStopReason =>
      res.usage && typeof res.usage.outputTokens === 'number' && res.usage.outputTokens >= req.maxTokens
        ? 'maxTokens'
        : 'endTurn';
    const finish = (text: string, res: { usage?: { outputTokens?: number } }) => {
      // Backstop client-side cho stopSequences: provider native đã dừng
      // thì không cắt gì thêm; provider bỏ qua `stop` thì cắt ở đây.
      // Dùng ĐẦY ĐỦ `req.stopSequences` (list gốc server gửi), KHÔNG
      // dùng list đã kẹp gửi provider — chuỗi thứ 6 trở đi bị kẹp
      // khỏi request vẫn cắt được text ở đây (v0.26 W19b).
      // Cắt thật (text ngắn đi) nghĩa là provider đã trả text chứa stop
      // sequence — tức dừng vì stop sequence — nên báo 'stopSequence'
      // thay vì 'endTurn'.
      const truncated = truncateAtStopSequence(text, req.stopSequences);
      const stoppedBySequence = truncated.length < text.length;
      return {
        role: 'assistant',
        content: { type: 'text', text: truncated },
        model: effectiveModel,
        stopReason: (stoppedBySequence ? 'stopSequence' : stopReasonFor(res)) as SamplingStopReason,
      };
    };
    // Trả kết quả + ghi lịch sử cho lượt sau (chỉ khi sampling thành
    // công và text cuối đã cắt không rỗng — tránh lịch sử lệch cặp
    // user/assistant khi provider trả rỗng; lỗi thì không ghi vì không
    // có response để lưu). Chỉ lưu messages của request + text cuối,
    // KHÔNG lưu tool-call/result trong lượt (lượt sau không replay tool).
    // v0.24 W17d: ngoài lịch sử riêng còn append lượt này vào store
    // dùng chung (để handler của server khác cùng bot đọc được qua
    // 'allServers') — chỉ append messages MỚI của lượt này, không
    // append lại phần lịch sử đã đọc nên không trùng lặp.
    const complete = (text: string, res: { usage?: { outputTokens?: number } }) => {
      const result = finish(text, res);
      if (result.content.text) {
        const newMessages: ChatMessage[] = [
          ...req.messages,
          { role: 'assistant', content: result.content.text },
        ];
        samplingHistory = trimSamplingHistory([...samplingHistory, ...newMessages]);
        contextStore?.append(samplingServerName, newMessages);
      }
      return result;
    };

    try {
      let res = await chatOnce(messages);
      // Vòng tool: tối đa maxToolRounds lần thực thi; mỗi lần thực thi
      // xong gọi provider tiếp để lấy text cuối (hoặc tool-call tiếp).
      let toolRounds = 0;
      while (res.toolCalls.length > 0) {
        if (!toolsToOffer) {
          // Không đưa tools mà provider vẫn trả tool-call: bỏ qua,
          // trả text như chat text-only (không tự bịa tool để chạy).
          break;
        }
        if (toolRounds >= maxToolRounds) {
          // Hết vòng tool mà provider vẫn đòi gọi thêm: dừng, trả text
          // hiện có (có thể rỗng) thay vì chạy vòng thứ 4.
          return complete(res.text ?? '', res);
        }
        // Ép tool: provider chỉ được gọi đúng tool bị ép (danh sách đã
        // thu hẹp về 1 tool); gọi tool khác là provider không tôn trọng
        // toolChoice -> lỗi rõ thay vì chạy tool ngoài ý server.
        for (const call of res.toolCalls) {
          if (forcedToolName && call.name !== forcedToolName) {
            throw new SamplingError(
              `MCP sampling: toolChoice ép dùng tool "${forcedToolName}" nhưng provider gọi tool "${call.name}" — không thực thi tool ngoài tool bị ép.`,
            );
          }
          if (!offeredNames.has(call.name)) {
            throw new SamplingError(
              `MCP sampling: provider gọi tool "${call.name}" mà server không cung cấp trong sampling request (chỉ có: ${[...offeredNames].join(', ') || '(không có tool nào)'}) — không thực thi tool lạ.`,
            );
          }
        }
        if (!toolExecutor) {
          const names = res.toolCalls.map((c) => c.name).join(', ');
          throw new SamplingError(
            `MCP sampling: provider gọi tool (${names}) nhưng không có đường gọi tool về MCP server — createSamplingHandler chưa được cấu hình callServerTool (client.callTool) hay executeTool, nên tools bị bỏ qua trước đây giờ thành lỗi rõ thay vì im lặng.`,
          );
        }
        // Thực thi tuần tự theo thứ tự provider gọi (xác định, tránh
        // side-effect song song), mỗi lần vẫn chịu deadline chung.
        messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          if (controller.signal.aborted) throw timeoutError;
          let output: string;
          try {
            const raw = await raceWithTimeout(
              toolExecutor(call.name, call.args ?? {}),
            );
            output = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
          } catch (err) {
            if (err instanceof SamplingError) throw err;
            throw new SamplingError(
              `MCP sampling: gọi tool "${call.name}" thất bại: ${(err as Error)?.message ?? String(err)}`,
            );
          }
          messages.push({
            role: 'tool',
            content: output,
            name: call.name,
            toolCallId: call.id,
          });
        }
        toolRounds += 1;
        res = await chatOnce(messages);
      }
      return complete(res.text ?? '', res);
    } catch (err) {
      if (err instanceof SamplingError) throw err;
      if ((err as Error)?.name === 'AbortError') throw timeoutError;
      throw new SamplingError(
        `MCP sampling thất bại: ${(err as Error)?.message ?? String(err)}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Lấy danh sách model provider có, race với `timeoutMs` (mặc định 5s
 * cho hints). Lỗi/timeout thì trả `[]` — caller giữ model bot, không
 * fail request vì một gợi ý model.
 */
async function listProviderModels(provider: Provider, timeoutMs: number): Promise<string[]> {
  try {
    const listPromise = provider.listModels();
    listPromise.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), timeoutMs);
        timer.unref?.();
      });
      const models = await Promise.race([listPromise, timeoutPromise]);
      return Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

/**
 * Hint đầu tiên khớp model provider có: khớp chính xác trước, rồi khớp
 * không phân biệt hoa/thường (trả đúng tên provider ghi). Không khớp
 * thì `null` — caller giữ model của bot.
 */
function matchHintedModel(hints: string[], available: string[]): string | null {
  for (const hint of hints) {
    if (available.includes(hint)) return hint;
  }
  for (const hint of hints) {
    const found = available.find((m) => m.toLowerCase() === hint.toLowerCase());
    if (found) return found;
  }
  return null;
}
