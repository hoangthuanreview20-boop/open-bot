/**
 * Agent SDK — `query()` — v1.01 (Team T6).
 *
 * API lập trình cho open-bot, kiểu Claude Code Agent SDK `query()`:
 * gọi agent loop trong chính process của mình, nhận về async iterator
 * các event (text / tool_call / tool_result / done / error), dùng được
 * từ script/CI mà không cần mở app desktop.
 *
 *   const handle = query('Tóm tắt file README.md', {
 *     provider: myProvider, // hoặc providerId + apiKey + model
 *     tools: [readFileTool],
 *   });
 *   for await (const event of handle) {
 *     if (event.type === 'text') process.stdout.write(event.text);
 *   }
 *   const result = await handle.result();
 *
 * Không tạo agent loop mới: dùng `AgentRunner` có sẵn, chỉ nối
 * `AgentEvents` vào hàng đợi event. Provider không được tiêm thì tạo
 * qua `createProvider` (fail-closed: thiếu providerId/model/apiKey
 * theo yêu cầu của provider thì throw lỗi rõ, không dùng mock ngầm).
 * Tool cần duyệt: mặc định TỪ CHỐI (autoApprove=false) — script/CI
 * không treo chờ người bấm duyệt; chỉ `autoApprove: true` tường minh
 * mới tự duyệt.
 */

import { AgentRunner } from '../agent/loop';
import { createProvider } from '../providers/index';
import type { SubagentTreeSnapshot } from '../subagents/nested';
import type {
  BotConfig,
  Provider,
  Tool,
  ToolCall,
  ToolResult,
} from '../types';

export type QueryEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | {
      type: 'done';
      text: string;
      /** Số round provider đã chạy (đếm qua provider wrapper). */
      turns: number;
      /** Số tool call đã chạy. */
      toolCalls: number;
      aborted: boolean;
    }
  | { type: 'error'; message: string };

export interface QueryResult {
  /** Text cuối cùng của agent loop. */
  text: string;
  /** Số round provider đã chạy. */
  turns: number;
  /** Số tool call đã chạy. */
  toolCalls: number;
  /** true khi run bị abort (handle.abort() hoặc signal ngoài). */
  aborted: boolean;
}

export interface QueryOptions {
  /** Provider đã tạo sẵn (test dùng fake/mock, script dùng provider thật). */
  provider?: Provider;
  /** Id provider cho createProvider (vd 'openai', 'gemini', 'ollama'). */
  providerId?: string;
  /** API key cho provider tạo qua providerId (provider nào cần thì bắt buộc). */
  apiKey?: string;
  /** baseUrl cho provider OpenAI-compatible. */
  baseUrl?: string;
  /** Model chạy (bắt buộc khi dùng providerId; provider tiêm sẵn thì mặc định 'default'). */
  model?: string;
  /** System prompt của agent (mặc định: trợ lý chung ngắn gọn). */
  systemPrompt?: string;
  /** Tool agent được dùng (mặc định: không có tool). */
  tools?: Tool[];
  /** Số round provider tối đa (mặc định 25, như AgentRunner). */
  maxTurns?: number;
  /** Thư mục làm việc cho tool (mặc định process.cwd()). */
  workspaceDir?: string;
  /** Id bot hiển thị trong log/trace (mặc định 'sdk-query'). */
  botId?: string;
  /**
   * true = tự duyệt mọi tool call. Mặc định false: tool cần duyệt bị
   * từ chối ngay, run tiếp tục/kết thúc mà không treo chờ người.
   */
  autoApprove?: boolean;
  /** AbortSignal ngoài — abort thì run dừng, result.aborted = true. */
  signal?: AbortSignal;
  /**
   * Chính sách nested subagent cho run này (depth tối đa, spawn budget,
   * context budget — xem `subagents/nested.ts`). Không set = mặc định
   * (maxDepth 5).
   */
  subagentPolicy?: import('../subagents/nested').NestedSubagentPolicy;
  /** Callback nhận từng event (ngoài async iterator). */
  onEvent?: (event: QueryEvent) => void;
}

export interface QueryHandle extends AsyncIterable<QueryEvent> {
  /** Promise resolve khi run xong (text cuối + số liệu). */
  result(): Promise<QueryResult>;
  /** Dừng run (abort signal nội bộ). */
  abort(): void;
  /**
   * Snapshot cây nested subagent của run này (xem subagents/nested.ts)
   * — undefined khi run chưa tạo cây (chỉ xảy ra trước khi run bắt đầu).
   */
  treeSnapshot(): SubagentTreeSnapshot | undefined;
}

export const DEFAULT_SDK_SYSTEM_PROMPT =
  'Bạn là trợ lý AI chạy trong open-bot SDK. Trả lời ngắn gọn, chính xác, ghi rõ kết luận cuối cùng.';
export const DEFAULT_SDK_BOT_ID = 'sdk-query';
export const DEFAULT_SDK_MAX_TURNS = 25;

/** Hàng đợi event cho async iterator: push + take, kết thúc bằng done/error. */
class EventQueue {
  private readonly buffered: QueryEvent[] = [];
  private readonly waiters: Array<(event: QueryEvent | null) => void> = [];
  private closed = false;

  push(event: QueryEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.buffered.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async take(): Promise<QueryEvent | null> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return buffered;
    if (this.closed) return null;
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function resolveProvider(options: QueryOptions): Provider {
  if (options.provider) return options.provider;
  const providerId = options.providerId?.trim();
  if (!providerId) {
    throw new Error(
      'query() cần provider (đã tạo sẵn) hoặc providerId + model — không có provider mặc định.',
    );
  }
  const model = options.model?.trim();
  if (!model) {
    throw new Error(
      `query() với providerId "${providerId}" cần model — truyền options.model (vd "gpt-4o", "gemini-2.5-flash").`,
    );
  }
  return createProvider({
    id: providerId,
    label: providerId,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    defaultModel: model,
  });
}

/**
 * Chạy một agent loop cho `prompt`, trả về handle để đọc event theo
 * dạng stream + lấy kết quả cuối. Run bắt đầu NGAY khi gọi query()
 * (không đợi lần `next()` đầu tiên) để script/CI không phải đợi.
 */
export function query(prompt: string, options: QueryOptions = {}): QueryHandle {
  const cleanPrompt = prompt?.trim();
  if (!cleanPrompt) {
    throw new Error('query() cần prompt không rỗng.');
  }
  const maxTurns = options.maxTurns ?? DEFAULT_SDK_MAX_TURNS;
  if (!Number.isFinite(maxTurns) || maxTurns <= 0) {
    throw new Error(`query() cần maxTurns > 0 (nhận ${String(options.maxTurns)}).`);
  }
  const provider = resolveProvider(options);
  const model = options.model?.trim() || 'default';

  const queue = new EventQueue();
  const emit = (event: QueryEvent): void => {
    queue.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      // Callback của caller lỗi thì không làm vỡ run.
    }
  };

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }

  const bot: BotConfig = {
    id: options.botId?.trim() || DEFAULT_SDK_BOT_ID,
    name: options.botId?.trim() || DEFAULT_SDK_BOT_ID,
    providerId: provider.id,
    model,
    systemPrompt: options.systemPrompt?.trim() || DEFAULT_SDK_SYSTEM_PROMPT,
    workspaceDir: options.workspaceDir ?? process.cwd(),
    autoApprove: options.autoApprove ?? false,
  };

  let turns = 0;
  let toolCalls = 0;
  let runner: AgentRunner | undefined;

  const runnerPromise = (async (): Promise<AgentRunner> => {
    // Đếm số round provider CHÍNH XÁC bằng cách bọc provider: onText
    // chỉ bắn khi round có text, nên đếm onText sẽ thiếu round chỉ
    // toàn tool call (vd round 1 của mock trong script ví dụ).
    const countingProvider: Provider = {
      ...provider,
      id: provider.id,
      label: provider.label,
      chat: async (req) => {
        turns += 1;
        return provider.chat(req);
      },
    };
    const created = new AgentRunner(countingProvider, options.tools ?? [], {
      bot,
      events: {
        onText: (text) => {
          emit({ type: 'text', text });
        },
        onToolCall: (call) => {
          toolCalls += 1;
          emit({ type: 'tool_call', call });
        },
        onToolResult: (result) => {
          emit({ type: 'tool_result', result });
        },
        onApprovalNeeded: async () => options.autoApprove ?? false,
      },
      maxSteps: Math.floor(maxTurns),
      signal: controller.signal,
      // v1.01 (Team T6): policy nested subagent do caller truyền (nếu có).
      ...(options.subagentPolicy !== undefined
        ? { subagentPolicy: options.subagentPolicy }
        : {}),
    });
    runner = created;
    return created;
  })();

  const resultPromise: Promise<QueryResult> = (async () => {
    try {
      const created = await runnerPromise;
      const text = await created.run(cleanPrompt);
      const aborted = controller.signal.aborted;
      emit({ type: 'done', text, turns, toolCalls, aborted });
      return { text, turns, toolCalls, aborted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = controller.signal.aborted;
      // Abort giữa run là kết thúc có kiểm soát, không phải lỗi lạ:
      // vẫn emit done (aborted) để consumer phân biệt được.
      if (aborted) {
        emit({ type: 'done', text: '', turns, toolCalls, aborted: true });
        return { text: '', turns, toolCalls, aborted: true };
      }
      emit({ type: 'error', message });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      queue.close();
      options.signal?.removeEventListener('abort', abort);
    }
  })();
  // Tránh unhandled rejection khi caller chỉ đọc iterator mà không gọi result().
  resultPromise.catch(() => undefined);

  const handle: QueryHandle = {
    async *[Symbol.asyncIterator](): AsyncIterator<QueryEvent> {
      for (;;) {
        const event = await queue.take();
        if (event === null) return;
        yield event;
        if (event.type === 'done' || event.type === 'error') return;
      }
    },
    result: () => resultPromise,
    abort,
    treeSnapshot: () => runner?.subagentTreeSnapshot(),
  };
  return handle;
}
