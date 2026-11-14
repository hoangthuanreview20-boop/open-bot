/**
 * Rule-based extraction cho verbatim memory (v1.01, Đội T4).
 *
 * Khác với extractor của memory graph (rút fact có cấu trúc
 * subject/predicate/object): extractor này KHÔNG rút fact, KHÔNG diễn
 * giải lại — nó chỉ CHỌN câu nguyên văn nào đáng lưu, và lưu đúng câu
 * đó. Mỗi candidate giữ nguyên text gốc của user (kèm vị trí turn/
 * câu để truy vết), chỉ thêm kind + confidence + tag gợi ý.
 *
 * Hai nhóm pattern (tiếng Việt + tiếng Anh, viết mới cho sóng này):
 *  1. Lệnh nhớ tường minh: user nói rõ muốn lưu ("hãy nhớ…",
 *     "remember that…") → confidence cao, lưu phần sau lệnh.
 *  2. Câu khẳng định về bản thân/quyết định: sở thích, công việc, nơi
 *     ở, tên, sinh nhật, dị ứng, mục tiêu, quyết định… → confidence
 *     vừa. Câu không khớp pattern nào thì KHÔNG sinh candidate (không
 *     có fallback "câu nào cũng thành memory" — tránh rác).
 *
 * Không gọi model: chạy offline hoàn toàn, kết quả kiểm chứng được.
 * Muốn rút sâu hơn, host truyền `llmExtractor` (xem autosave.ts) —
 * extractor đó trả về candidate cùng shape, vẫn giữ nguyên văn.
 */
import type { VerbatimSource } from './types';

/** Một turn hội thoại đưa vào extractor. */
export interface VerbatimTurn {
  role: string;
  text: string;
  /** Chỉ số turn trong session (để ghi nguồn). */
  index?: number;
}

/** Một câu nguyên văn ứng viên để lưu. */
export interface VerbatimCandidate {
  /** Text NGUYÊN VĂN (câu gốc, không chỉnh sửa ngoài trim). */
  text: string;
  /** Nhóm pattern đã khớp. */
  kind: 'explicit-remember' | 'preference' | 'identity' | 'work' | 'decision' | 'goal' | 'statement';
  /** Độ tin cậy 0..1 (explicit-remember cao nhất). */
  confidence: number;
  /** Tag gợi ý (vd ['preference']). */
  tags: string[];
  /** Chỉ số turn nguồn. */
  turnIndex?: number;
  /** Nguồn của turn (luôn 'user' với extractor mặc định). */
  source: VerbatimSource;
}

export interface VerbatimExtractOptions {
  /** Độ dài tối thiểu của câu (ký tự, mặc định 12). */
  minLength?: number;
  /** Độ dài tối đa của câu (ký tự, mặc định 2000 — câu dài hơn bị bỏ, không cắt). */
  maxLength?: number;
  /** Chỉ xét turn của user (mặc định true — agent nói không tự thành memory). */
  userOnly?: boolean;
  /** Bỏ qua câu chứa dấu hiệu secret (mặc định true). */
  skipSecrets?: boolean;
}

export const VERBATIM_EXTRACT_MIN_LENGTH = 12;
export const VERBATIM_EXTRACT_MAX_LENGTH = 2000;

/** Pattern lệnh nhớ tường minh: [regex, độ dài prefix cần bỏ để lấy phần nhớ]. */
const EXPLICIT_REMEMBER_PATTERNS: { re: RegExp; kind: VerbatimCandidate['kind']; confidence: number; tags: string[] }[] = [
  { re: /^(hãy\s+)?nhớ\s+(rằng\s+|là\s+)?/i, kind: 'explicit-remember', confidence: 0.95, tags: ['explicit'] },
  { re: /^ghi\s+nhớ\s+(rằng\s+|là\s+)?/i, kind: 'explicit-remember', confidence: 0.95, tags: ['explicit'] },
  { re: /^lưu\s+lại\s+(rằng\s+|là\s+)?/i, kind: 'explicit-remember', confidence: 0.95, tags: ['explicit'] },
  { re: /^đừng\s+quên\s+(rằng\s+|là\s+)?/i, kind: 'explicit-remember', confidence: 0.9, tags: ['explicit'] },
  { re: /^(please\s+)?remember\s+(that\s+)?/i, kind: 'explicit-remember', confidence: 0.95, tags: ['explicit'] },
  { re: /^note\s+(that\s+)?/i, kind: 'explicit-remember', confidence: 0.9, tags: ['explicit'] },
  { re: /^keep\s+in\s+mind\s+(that\s+)?/i, kind: 'explicit-remember', confidence: 0.9, tags: ['explicit'] },
  { re: /^don't\s+forget\s+(that\s+)?/i, kind: 'explicit-remember', confidence: 0.9, tags: ['explicit'] },
];

/** Pattern câu khẳng định: khớp phần đầu câu → kind + confidence + tag. */
const STATEMENT_PATTERNS: { re: RegExp; kind: VerbatimCandidate['kind']; confidence: number; tags: string[] }[] = [
  { re: /^(tôi|tớ|mình|em|anh|chị)\s+(thích|yêu|mê|ghét|không\s+thích|không\s+ưa)(?![\p{L}\p{N}])/iu, kind: 'preference', confidence: 0.8, tags: ['preference'] },
  { re: /^i\s+(like|love|hate|dislike|enjoy|prefer)\b/i, kind: 'preference', confidence: 0.8, tags: ['preference'] },
  { re: /^(my\s+favorite|món\s+.*yêu\s+thích|tôi\s+thích\s+nhất)/i, kind: 'preference', confidence: 0.85, tags: ['preference', 'favorite'] },
  { re: /^(tên\s+(tôi|tớ|mình)\s+là|tôi\s+tên\s+là|my\s+name\s+is|i'?m\s+called)(?![\p{L}\p{N}])/iu, kind: 'identity', confidence: 0.9, tags: ['identity', 'name'] },
  { re: /^(tôi|tớ|mình)\s+(sống\s+(ở|tại)|ở\s+(tại|ở)|đang\s+ở)(?![\p{L}\p{N}])/iu, kind: 'identity', confidence: 0.8, tags: ['identity', 'location'] },
  { re: /^(i\s+live\s+in|i\s+am\s+from|i\s+was\s+born)/i, kind: 'identity', confidence: 0.8, tags: ['identity', 'location'] },
  { re: /^(tôi|tớ|mình)\s+(làm\s+(việc\s+)?(ở|tại|cho)|đang\s+làm)/i, kind: 'work', confidence: 0.8, tags: ['work'] },
  { re: /^(i\s+work\s+(at|for|as)|i'?m\s+a\s+\w+\s+(at|for)|my\s+job\s+is)/i, kind: 'work', confidence: 0.8, tags: ['work'] },
  { re: /^(sinh\s+nhật\s+(tôi|tớ|mình)|my\s+birthday\s+is|i\s+was\s+born\s+on)/i, kind: 'identity', confidence: 0.9, tags: ['identity', 'birthday'] },
  { re: /^(tôi|tớ|mình)\s+(bị\s+)?dị\s+ứng/i, kind: 'identity', confidence: 0.85, tags: ['identity', 'allergy'] },
  { re: /^(i'?m\s+allergic\s+to|i\s+have\s+an\s+allergy)/i, kind: 'identity', confidence: 0.85, tags: ['identity', 'allergy'] },
  { re: /^(tôi|tớ|mình)\s+(nói|biết)\s+(tiếng|ngôn\s+ngữ)/i, kind: 'identity', confidence: 0.8, tags: ['identity', 'language'] },
  { re: /^(i\s+speak|i\s+can\s+speak|my\s+first\s+language\s+is)/i, kind: 'identity', confidence: 0.8, tags: ['identity', 'language'] },
  { re: /^(quyết\s+định|tôi\s+quyết\s+định|mình\s+quyết\s+định)/i, kind: 'decision', confidence: 0.85, tags: ['decision'] },
  { re: /^(i(\s+have)?\s+decided|we(\s+have)?\s+decided|i'?ve\s+decided)/i, kind: 'decision', confidence: 0.85, tags: ['decision'] },
  { re: /^(mục\s+tiêu\s+(của\s+)?(tôi|tớ|mình)|tôi\s+muốn\s+(trở\s+thành|đạt|học))/i, kind: 'goal', confidence: 0.8, tags: ['goal'] },
  { re: /^(my\s+goal\s+is|i\s+want\s+to\s+(become|achieve|learn)|my\s+dream\s+is)/i, kind: 'goal', confidence: 0.8, tags: ['goal'] },
  { re: /^(tôi|tớ|mình)\s+(luôn|thường|hay)\s+/i, kind: 'statement', confidence: 0.6, tags: ['habit'] },
  { re: /^(i\s+(always|usually|often|never))\b/i, kind: 'statement', confidence: 0.6, tags: ['habit'] },
];

/** Dấu hiệu secret/token trong text — câu chứa thì bị bỏ (không lưu secret vào memory). */
const SECRET_HINTS: RegExp[] = [
  /\b(sk-[A-Za-z0-9]{8,})\b/,
  /\b(ghp_[A-Za-z0-9]{20,})\b/,
  /\b(gho_[A-Za-z0-9]{20,})\b/,
  /\b(AKIA[0-9A-Z]{16})\b/,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /\b(api[_-]?key|api[_-]?token)\s*[:=]\s*\S{8,}/i,
  /\b(mật\s+khẩu|password)\s*[:=]\s*\S{4,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/,
];

function looksLikeSecret(text: string): boolean {
  return SECRET_HINTS.some((re) => re.test(text));
}

/** Tách turn thành câu (giữ nguyên văn từng câu, trim hai đầu). */
export function splitIntoSentences(text: string): string[] {
  const source = (text ?? '').replace(/\r\n/g, '\n');
  const sentences: string[] = [];
  // Tách theo dấu kết câu + xuống dòng; giữ lại dấu câu trong câu.
  const re = /[^.!?…\n]+(?:[.!?…]+["”']?|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const sentence = m[0].trim();
    if (sentence !== '') sentences.push(sentence);
  }
  // Câu không có dấu kết (vd một dòng ngắn) mà regex bỏ sót → lấy phần còn lại.
  if (sentences.length === 0 && source.trim() !== '') sentences.push(source.trim());
  return sentences;
}

/**
 * Rút candidate verbatim từ các turn (mặc định chỉ turn user).
 * Mỗi candidate là MỘT câu nguyên văn — không gộp, không diễn giải.
 */
export function extractVerbatimCandidates(
  turns: VerbatimTurn[],
  opts: VerbatimExtractOptions = {},
): VerbatimCandidate[] {
  const minLength = opts.minLength ?? VERBATIM_EXTRACT_MIN_LENGTH;
  const maxLength = opts.maxLength ?? VERBATIM_EXTRACT_MAX_LENGTH;
  const userOnly = opts.userOnly ?? true;
  const skipSecrets = opts.skipSecrets ?? true;
  const seen = new Set<string>();
  const candidates: VerbatimCandidate[] = [];

  for (const turn of turns) {
    const role = (turn.role ?? '').trim().toLowerCase();
    const isUser = role === 'user' || role === 'human';
    if (userOnly && !isUser) continue;
    if (!isUser && role !== 'assistant' && role !== 'agent') continue;
    const text = (turn.text ?? '').trim();
    if (text === '') continue;

    for (const sentence of splitIntoSentences(text)) {
      if (sentence.length < minLength || sentence.length > maxLength) continue;
      if (skipSecrets && looksLikeSecret(sentence)) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;

      // 1. Lệnh nhớ tường minh: lưu phần SAU lệnh (bỏ prefix lệnh),
      //    nhưng vẫn là nguyên văn của user.
      let matched = false;
      for (const pattern of EXPLICIT_REMEMBER_PATTERNS) {
        const m = pattern.re.exec(sentence);
        if (m === null) continue;
        const rest = sentence.slice(m[0].length).trim().replace(/^[,:–—-]\s*/, '');
        if (rest.length < minLength) continue;
        if (skipSecrets && looksLikeSecret(rest)) continue;
        const restKey = rest.toLowerCase();
        if (seen.has(restKey)) {
          matched = true;
          break;
        }
        seen.add(key);
        seen.add(restKey);
        candidates.push({
          text: rest,
          kind: pattern.kind,
          confidence: pattern.confidence,
          tags: [...pattern.tags],
          turnIndex: turn.index,
          source: 'user',
        });
        matched = true;
        break;
      }
      if (matched) continue;

      // 2. Câu khẳng định: lưu NGUYÊN CÂU.
      for (const pattern of STATEMENT_PATTERNS) {
        if (!pattern.re.test(sentence)) continue;
        seen.add(key);
        candidates.push({
          text: sentence,
          kind: pattern.kind,
          confidence: pattern.confidence,
          tags: [...pattern.tags],
          turnIndex: turn.index,
          source: 'user',
        });
        matched = true;
        break;
      }
      void matched;
    }
  }
  return candidates;
}

/** Đếm số candidate theo kind (để log/summary autosave). */
export function countCandidatesByKind(candidates: VerbatimCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) out[c.kind] = (out[c.kind] ?? 0) + 1;
  return out;
}
