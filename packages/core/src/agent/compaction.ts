/**
 * Compaction / tóm tắt ngữ cảnh tự động (v0.12 mục 7 — W4d).
 *
 * Khi lịch sử của một run vượt ngưỡng token, module này tóm tắt các
 * message cũ thành một bản tóm tắt ngắn, giữ lại system prompt + các
 * message gần nhất, rồi run tiếp tục với lịch sử đã gọn — thay vì chạm
 * trần context rồi lỗi.
 *
 * Module PURE + dễ test: mọi hàm đều nhận dữ liệu đầu vào rõ ràng, không
 * đọc file, không gọi mạng. Việc tóm tắt bằng model đi qua callback
 * `Summarizer` (test dùng hàm giả) hoặc qua `compactWithProvider`
 * (gọi chính provider của run).
 *
 * NỐI VÀO LOOP (dành cho điều phối viên — KHÔNG sửa ở đây):
 * - Thêm option `compaction?: { contextLimit, threshold?, keepRecent?,
 *   language?, summarizerModel? }` vào `AgentRunnerOptions` (loop.ts).
 * - Trong `AgentRunner.run()`, sau mỗi step (sau khi đã push tool result
 *   vào `messages`, trước lần `provider.chat()` tiếp theo), gọi:
 *       const r = await checkAndCompact(messages, this.provider, {
 *         model: this.bot.model, contextLimit, ...this.compactionOpts,
 *       });
 *       if (r.compacted) messages = r.messages;
 *   `contextLimit` là context window (token) của model đang chạy — lấy
 *   từ model registry / provider meta; không có nó thì không compaction.
 * - KHÔNG gọi compaction giữa một assistant tool-call và các tool result
 *   của nó: `compactMessages` tự dịch điểm cắt để không tách cặp này.
 */

import type { ChatMessage, Provider } from '../types';
import { estimateTokens } from './tokens';

/** Ngưỡng mặc định: compaction khi đạt 80% context window của model. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.8;
/** Số message gần nhất mặc định được giữ nguyên sau khi compaction. */
export const DEFAULT_KEEP_RECENT_MESSAGES = 10;
/** Ước tính token: `DEFAULT_CHARS_PER_TOKEN` chỉ còn là fallback khi text
 *  rỗng (0 token) — text có nội dung dùng `estimateTokens` (tokens.ts),
 *  heuristic theo loại đoạn text, sát hơn chars/4. */
export const DEFAULT_CHARS_PER_TOKEN = 4;
/** Độ dài tối đa của bản tóm tắt (ký tự) — tránh tóm tắt phình lại. */
export const DEFAULT_MAX_SUMMARY_CHARS = 4000;
/** Số ký tự tối đa lấy từ mỗi message cũ khi đưa vào prompt tóm tắt. */
export const DEFAULT_MAX_MESSAGE_CHARS_IN_PROMPT = 1500;

export type CompactionLanguage = 'vi' | 'en';

export interface CompactionOptions {
  /** Số message gần nhất giữ nguyên. Mặc định 10. */
  keepRecent?: number;
  /** Ngôn ngữ của bản tóm tắt + prompt tóm tắt. Mặc định 'vi'. */
  language?: CompactionLanguage;
  /** Độ dài tối đa của bản tóm tắt (ký tự). Mặc định 4000. */
  maxSummaryChars?: number;
  /** Số ký tự tối đa lấy từ mỗi message cũ khi đưa vào prompt tóm tắt. */
  maxMessageCharsInPrompt?: number;
}

export interface CompactionResult {
  /** Lịch sử sau compaction (hoặc nguyên vẹn khi không cần compact). */
  messages: ChatMessage[];
  /** True khi lịch sử đã được rút gọn (tóm tắt hoặc fallback cắt bớt). */
  compacted: boolean;
  /** Số message cũ đã được tóm tắt / cắt bỏ. */
  summarizedCount: number;
  /** Token ước tính của message tóm tắt (0 khi dùng fallback cắt bớt). */
  summaryTokens: number;
  tokensBefore: number;
  tokensAfter: number;
  /** True khi summarizer lỗi và đã dùng fallback cắt message cũ nhất. */
  fallbackUsed: boolean;
  /** Nội dung bản tóm tắt ('' khi không compact hoặc dùng fallback). */
  summaryText: string;
}

/**
 * Callback tóm tắt: nhận các message cũ, trả về bản tóm tắt dạng text.
 * Test dùng hàm giả; production truyền hàm gọi provider (xem
 * `compactWithProvider`). Ném lỗi (hoặc trả về chuỗi rỗng) → fallback
 * cắt bớt, không crash run.
 */
export type Summarizer = (
  toSummarize: ChatMessage[],
  opts: { language: CompactionLanguage },
) => Promise<string>;

// ---------------------------------------------------------------------------
// Ước tính token
// ---------------------------------------------------------------------------

/** Ước tính token của một message: `estimateTokens` (tokens.ts) + 4 token
 *  overhead. Text rỗng → fallback chars/4 (= 0) + overhead. */
export function estimateMessageTokens(message: ChatMessage): number {
  const text =
    message.content + (message.toolCalls ? JSON.stringify(message.toolCalls) : '');
  const bodyTokens =
    text.length === 0 ? Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN) : estimateTokens(text);
  return bodyTokens + 4;
}

/** Ước tính token của cả lịch sử (tổng từng message). */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ---------------------------------------------------------------------------
// Kiểm tra ngưỡng
// ---------------------------------------------------------------------------

/**
 * Lịch sử có cần compaction không?
 * - `tokenEstimate`: token hiện tại; bỏ qua thì tự ước tính từ messages.
 * - `limit`: context window của model (token); không có / <= 0 → false.
 * - `threshold`: tỉ lệ ngưỡng, mặc định 0.8 (80% context window).
 */
export function needsCompaction(
  messages: ChatMessage[],
  tokenEstimate?: number,
  limit?: number,
  threshold: number = DEFAULT_COMPACTION_THRESHOLD,
): boolean {
  if (!limit || limit <= 0) return false;
  if (threshold <= 0) return false;
  const tokens = tokenEstimate ?? estimateMessagesTokens(messages);
  return tokens >= limit * threshold;
}

// ---------------------------------------------------------------------------
// Nội dung bản tóm tắt
// ---------------------------------------------------------------------------

/** Nội dung message tóm tắt: ghi rõ đây là tóm tắt của N message cũ. */
export function buildSummaryMessageContent(
  summarizedCount: number,
  summarizedTokens: number,
  summaryText: string,
  language: CompactionLanguage = 'vi',
): string {
  if (language === 'en') {
    return (
      `[Context summary — summary of ${summarizedCount} older messages ` +
      `(estimated ~${summarizedTokens} tokens). The original messages were replaced ` +
      `by this summary to save context; continue from the summary and the recent ` +
      `messages below, do not ask again about what is already settled in the summary.]\n` +
      summaryText
    );
  }
  return (
    `[Tóm tắt ngữ cảnh — tóm tắt của ${summarizedCount} tin nhắn cũ ` +
    `(ước tính ~${summarizedTokens} token). Nội dung gốc đã được thay bằng bản ` +
    `tóm tắt này để tiết kiệm context; hãy tiếp tục dựa trên bản tóm tắt và ` +
    `các tin nhắn gần nhất bên dưới, đừng hỏi lại những gì đã chốt trong tóm tắt.]\n` +
    summaryText
  );
}

/** Một message thành một dòng transcript `[role] nội dung` (đã cắt ngắn). */
export function formatTranscriptLine(message: ChatMessage, maxChars: number): string {
  const content =
    message.content.length > maxChars
      ? message.content.slice(0, maxChars) + '…'
      : message.content;
  const suffix =
    message.toolCalls && message.toolCalls.length > 0
      ? ` [gọi tool: ${message.toolCalls.map((c) => c.name).join(', ')}]`
      : '';
  return `[${message.role}] ${content}${suffix}`;
}

/**
 * Prompt tóm tắt gửi cho model: system = hướng dẫn tóm tắt (giữ mục
 * tiêu, quyết định đã chốt, file đã đổi, lỗi còn tồn đọng, bước tiếp
 * theo — không bịa thêm), user = transcript các message cũ.
 */
export function buildCompactionPrompt(
  messages: ChatMessage[],
  language: CompactionLanguage = 'vi',
  maxMessageChars: number = DEFAULT_MAX_MESSAGE_CHARS_IN_PROMPT,
): { system: string; user: string } {
  const system =
    language === 'en'
      ? 'Summarize the conversation below into a short summary in English. Keep: the user\'s goal, decisions already made, files created or changed, errors still unresolved, and the next steps. Do not invent information that is not in the conversation. Return plain text only, no JSON, no markdown fences.'
      : 'Hãy tóm tắt đoạn hội thoại sau thành một bản tóm tắt ngắn gọn bằng tiếng Việt. Giữ lại: mục tiêu của người dùng, các quyết định đã chốt, file đã tạo hoặc sửa, các lỗi còn tồn đọng và bước tiếp theo. Không bịa thêm thông tin không có trong hội thoại. Chỉ trả về văn bản thuần, không dùng JSON, không dùng markdown fence.';
  const transcript = messages.map((m) => formatTranscriptLine(m, maxMessageChars)).join('\n');
  const user =
    language === 'en'
      ? `Conversation to summarize:\n${transcript}`
      : `Đoạn hội thoại cần tóm tắt:\n${transcript}`;
  return { system, user };
}

// ---------------------------------------------------------------------------
// Tách lịch sử: system + cũ + gần nhất (không tách cặp tool-call/result)
// ---------------------------------------------------------------------------

interface SplitMessages {
  system: ChatMessage[];
  old: ChatMessage[];
  recent: ChatMessage[];
}

function splitMessages(messages: ChatMessage[], keepRecent: number): SplitMessages {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length <= keepRecent) return { system, old: [], recent: rest };
  let cut = rest.length - keepRecent;
  // Dịch điểm cắt để không tách một assistant tool-call khỏi các tool
  // result của nó (provider sẽ reject tool result không có call đi kèm,
  // xem loop.ts): message tool đầu tiên trong recent → kéo cả assistant
  // call vào recent; assistant có toolCalls cuối old → đẩy cả tool result
  // vào old. Lặp tới khi ổn định.
  for (let guard = 0; guard < rest.length; guard++) {
    const firstRecent = rest[cut];
    const lastOld = rest[cut - 1];
    if (firstRecent?.role === 'tool' && cut > 0) {
      cut -= 1;
      continue;
    }
    if (lastOld?.role === 'assistant' && (lastOld.toolCalls?.length ?? 0) > 0 && cut < rest.length) {
      cut += 1;
      continue;
    }
    break;
  }
  return { system, old: rest.slice(0, cut), recent: rest.slice(cut) };
}

// ---------------------------------------------------------------------------
// Compaction chính
// ---------------------------------------------------------------------------

/**
 * Rút gọn lịch sử: tóm tắt các message cũ bằng `summarizer`, giữ system
 * prompt + `keepRecent` message gần nhất. Khi summarizer lỗi (provider
 * lỗi, trả về rỗng, timeout…) thì FALLBACK: cắt bỏ message cũ nhất, giữ
 * system + message gần nhất — không bao giờ crash run.
 */
export async function compactMessages(
  messages: ChatMessage[],
  summarizer: Summarizer,
  opts: CompactionOptions = {},
): Promise<CompactionResult> {
  const keepRecent = Math.max(1, Math.floor(opts.keepRecent ?? DEFAULT_KEEP_RECENT_MESSAGES));
  const language: CompactionLanguage = opts.language ?? 'vi';
  const maxSummaryChars = Math.max(
    200,
    Math.floor(opts.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS),
  );
  const tokensBefore = estimateMessagesTokens(messages);
  const noChange = (overrides: Partial<CompactionResult> = {}): CompactionResult => ({
    messages,
    compacted: false,
    summarizedCount: 0,
    summaryTokens: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
    fallbackUsed: false,
    summaryText: '',
    ...overrides,
  });

  const { system, old, recent } = splitMessages(messages, keepRecent);
  if (old.length === 0) return noChange();

  const oldTokens = estimateMessagesTokens(old);
  let summaryText = '';
  let fallbackUsed = false;
  try {
    const raw = await summarizer(old, { language });
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error('summarizer trả về bản tóm tắt rỗng');
    }
    summaryText = raw.trim().slice(0, maxSummaryChars);
  } catch {
    // Fallback: cắt message cũ nhất thay vì crash — run tiếp tục được
    // với system + message gần nhất, chỉ mất ngữ cảnh cũ.
    fallbackUsed = true;
    summaryText = '';
  }

  const summaryMessage: ChatMessage | null = fallbackUsed
    ? null
    : {
        role: 'user',
        content: buildSummaryMessageContent(old.length, oldTokens, summaryText, language),
      };
  const compactedMessages = [
    ...system,
    ...(summaryMessage ? [summaryMessage] : []),
    ...recent,
  ];
  return {
    messages: compactedMessages,
    compacted: true,
    summarizedCount: old.length,
    summaryTokens: summaryMessage ? estimateMessageTokens(summaryMessage) : 0,
    tokensBefore,
    tokensAfter: estimateMessagesTokens(compactedMessages),
    fallbackUsed,
    summaryText,
  };
}

// ---------------------------------------------------------------------------
// Compaction bằng chính provider của run
// ---------------------------------------------------------------------------

export interface ProviderCompactionOptions extends CompactionOptions {
  /** Model đang chạy run này (dùng để gọi tóm tắt khi không có model riêng). */
  model: string;
  /**
   * Model riêng (rẻ/local) để tóm tắt — vd model local Ollama. Bỏ qua
   * thì dùng chính `model` của run.
   */
  summarizerModel?: string;
  /** Context window của model (token) — cần cho kiểm tra ngưỡng. */
  contextLimit?: number;
  /** Tỉ lệ ngưỡng, mặc định 0.8. */
  threshold?: number;
}

/**
 * Tóm tắt bằng chính provider của run: gửi transcript các message cũ
 * cho model (prompt tiếng Việt/Anh theo `language`), lấy text trả về
 * làm bản tóm tắt. Provider lỗi → `compactMessages` tự fallback cắt bớt.
 */
export async function compactWithProvider(
  messages: ChatMessage[],
  provider: Provider,
  opts: ProviderCompactionOptions,
): Promise<CompactionResult> {
  const summarizer: Summarizer = async (toSummarize, { language }) => {
    const prompt = buildCompactionPrompt(
      toSummarize,
      language,
      opts.maxMessageCharsInPrompt ?? DEFAULT_MAX_MESSAGE_CHARS_IN_PROMPT,
    );
    const res = await provider.chat({
      model: opts.summarizerModel ?? opts.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });
    return res.text;
  };
  return compactMessages(messages, summarizer, opts);
}

/**
 * Điểm nối duy nhất cho loop: kiểm tra ngưỡng rồi compact nếu cần.
 * Dưới ngưỡng → trả nguyên lịch sử, KHÔNG gọi provider (không tốn token).
 * Dùng trong `AgentRunner.run()` sau mỗi step — xem ghi chú đầu file.
 */
export async function checkAndCompact(
  messages: ChatMessage[],
  provider: Provider,
  opts: ProviderCompactionOptions & { tokenEstimate?: number },
): Promise<CompactionResult> {
  const tokens = opts.tokenEstimate ?? estimateMessagesTokens(messages);
  if (
    !needsCompaction(
      messages,
      tokens,
      opts.contextLimit ?? 0,
      opts.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
    )
  ) {
    return {
      messages,
      compacted: false,
      summarizedCount: 0,
      summaryTokens: 0,
      tokensBefore: tokens,
      tokensAfter: tokens,
      fallbackUsed: false,
      summaryText: '',
    };
  }
  return compactWithProvider(messages, provider, opts);
}
