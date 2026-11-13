/**
 * Turn context — nối profile + long-term memory recall vào system
 * prompt của một turn (v0.95, Đội D4).
 *
 * Chạy ở coordinator (`run()`), best-effort: mọi lỗi đều nuốt thành
 * section rỗng, turn chạy như cũ không có memory. Không gọi mạng
 * ngoài — embedder duy nhất là Ollama local; Ollama chết thì fallback
 * về tìm kiếm từ khoá (ghi rõ `usedFallback` + lý do, không lặng lẽ).
 *
 * Ngân sách: toàn bộ section (profile + recall) mặc định tối đa 6000
 * ký tự (~1500 token ước lượng thô 4 ký tự/token). Profile luôn được
 * ưu tiên trước recall; recall cắt theo từng hit cho tới khi hết ngân
 * sách. Recall tối đa 5 memory/turn (mặc định).
 */
import type { Embedder } from './embeddings';
import {
  LongTermMemory,
  type SemanticFallbackReason,
  type SemanticRecallHit,
} from './longterm';
import { buildProfileContext, type UserProfile } from './profile';

/** Ngân sách ký tự mặc định cho cả section profile + recall (~1500 token). */
export const MEMORY_TURN_MAX_CHARS = 6000;
/** Số memory tối đa recall vào một turn. */
export const MEMORY_TURN_MAX_MEMORIES = 5;
/** Cache kết quả probe Ollama khả dụng trong 60s (tránh probe mỗi turn). */
export const EMBEDDER_AVAILABILITY_TTL_MS = 60_000;
/** Timeout probe Ollama (ms) — quá hạn coi như chưa sẵn sàng. */
export const EMBEDDER_PROBE_TIMEOUT_MS = 1500;

export interface MemoryTurnContextOptions {
  /** Profile user (null = chưa có — bỏ qua phần profile). */
  profile?: UserProfile | null;
  /** Long-term memory store của workspace bot đang chạy. */
  store?: LongTermMemory;
  /** Bot đang chạy (recall gồm memory của bot này + memory chung). */
  botId?: string;
  /** User hiện tại (recall gồm memory của user này + legacy chưa gắn user). */
  userId?: string;
  /** Tin nhắn user của turn — dùng làm query recall. */
  userText: string;
  /** Embedder Ollama local (vắng = recall từ khoá). */
  embedder?: Embedder;
  /** Ngân sách ký tự cho cả section (mặc định 6000). */
  maxChars?: number;
  /** Số memory tối đa (mặc định 5). */
  maxMemories?: number;
}

export interface MemoryTurnContextResult {
  /** Section đầy đủ để nối vào system prompt ('' khi không có gì). */
  section: string;
  /** Các memory đã recall (kèm score; rỗng khi không recall được gì). */
  recalled: SemanticRecallHit[];
  /** true khi recall phải fallback về từ khoá (không phải ngữ nghĩa). */
  usedFallback: boolean;
  /** Lý do fallback (vắng khi recall ngữ nghĩa thật). */
  fallbackReason?: SemanticFallbackReason;
  /** true khi recall dùng embedding ngữ nghĩa thật. */
  embedded: boolean;
  /** true khi profile có nội dung và đã đưa vào section. */
  profileIncluded: boolean;
  /** true khi section bị cắt vì hết ngân sách ký tự. */
  truncated: boolean;
}

const availabilityCache = new WeakMap<Embedder, { available: boolean; at: number }>();

/**
 * Probe Ollama có sẵn sàng không (qua `isAvailable()`), cache 60s.
 * Embedder không có `isAvailable` thì coi như sẵn sàng (để `embed`
 * tự báo lỗi rõ, recallSemantic fallback tiếp). Probe timeout 1.5s.
 */
export async function isEmbedderAvailableCached(embedder: Embedder): Promise<boolean> {
  const cached = availabilityCache.get(embedder);
  if (cached && Date.now() - cached.at < EMBEDDER_AVAILABILITY_TTL_MS) {
    return cached.available;
  }
  let available = true;
  if (typeof embedder.isAvailable === 'function') {
    try {
      available = await Promise.race([
        embedder.isAvailable(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EMBEDDER_PROBE_TIMEOUT_MS)),
      ]);
    } catch {
      available = false;
    }
  }
  availabilityCache.set(embedder, { available, at: Date.now() });
  return available;
}

/**
 * Dựng section memory cho một turn: profile trước, recall sau, cắt
 * theo ngân sách. Không throw — lỗi recall/profile đều thành section
 * rỗng hoặc chỉ còn phần làm được.
 */
export async function buildMemoryTurnContext(
  opts: MemoryTurnContextOptions,
): Promise<MemoryTurnContextResult> {
  const maxChars = opts.maxChars ?? MEMORY_TURN_MAX_CHARS;
  const maxMemories = opts.maxMemories ?? MEMORY_TURN_MAX_MEMORIES;
  const empty: MemoryTurnContextResult = {
    section: '',
    recalled: [],
    usedFallback: false,
    embedded: false,
    profileIncluded: false,
    truncated: false,
  };
  const profileSection = buildProfileContext(opts.profile ?? null);
  const profileIncluded = profileSection !== '';
  let recalled: SemanticRecallHit[] = [];
  let usedFallback = false;
  let fallbackReason: SemanticFallbackReason | undefined;
  let embedded = false;
  if (opts.store && opts.userText.trim() !== '') {
    try {
      // v0.95 (merge): fast path khi kho rỗng — không có memory nào trong
      // scope thì bỏ qua cả probe Ollama lẫn recallSemantic. Probe mạng
      // (GET /api/tags) có độ trễ rất biến động (đo được 5–823ms) mà lại
      // nằm trên đường setup của turn: turn đầu tiên sẽ trả chậm và
      // stopRun trong lúc setup thấy run "chưa bắt đầu" (hồi quy
      // tests/ws-control.test.mjs). `recall({limit: 1})` đồng bộ, dùng
      // đúng scope của recallSemantic nên không bỏ sót memory chung.
      const inScope = opts.store.recall({
        ...(opts.botId !== undefined ? { botId: opts.botId, includeShared: true } : {}),
        ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
        limit: 1,
      });
      if (inScope.length > 0) {
        let embedder: Embedder | undefined;
        if (opts.embedder && (await isEmbedderAvailableCached(opts.embedder))) {
          embedder = opts.embedder;
        }
        const result = await opts.store.recallSemantic(opts.userText, {
          ...(embedder ? { embedder } : {}),
          ...(opts.botId !== undefined ? { botId: opts.botId, includeShared: true } : {}),
          ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
          limit: maxMemories,
        });
        recalled = result.hits;
        usedFallback = result.usedFallback;
        fallbackReason = result.fallbackReason;
        embedded = !result.usedFallback && recalled.length > 0;
      }
    } catch {
      // Recall lỗi thì turn vẫn chạy không có memory (không throw).
      recalled = [];
      usedFallback = false;
      fallbackReason = undefined;
      embedded = false;
    }
  }
  const parts: string[] = [];
  if (profileIncluded) parts.push(profileSection);
  if (recalled.length > 0) {
    const lines = recalled.map((hit) => {
      const e = hit.entry;
      const scope = e.botId ? `bot ${e.botId}` : 'chung';
      const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
      return `- ${e.key} (${scope}, độ tin cậy ${e.confidence.toFixed(2)}): ${e.value}${tags}`;
    });
    parts.push(
      '[Trí nhớ dài hạn — những điều đã lưu về người dùng (chỉ dùng khi liên quan tới câu hỏi hiện tại; đừng nhắc lại máy móc khi không liên quan):]\n' +
        lines.join('\n'),
    );
  }
  if (parts.length === 0) return { ...empty, usedFallback, fallbackReason, embedded };
  let section = parts.join('\n\n');
  let truncated = false;
  if (section.length > maxChars) {
    section = section.slice(0, maxChars) + '\n…(đã rút gọn theo ngân sách bộ nhớ)';
    truncated = true;
  }
  return {
    section,
    recalled,
    usedFallback,
    fallbackReason,
    embedded,
    profileIncluded,
    truncated,
  };
}

/** Re-export để caller không cần import cả longterm chỉ để lấy class. */
export { LongTermMemory };
