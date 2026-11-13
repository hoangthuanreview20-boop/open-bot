/**
 * Fact extraction — bước 1 của pipeline kiểu Mem0 v3 (v0.98, Đội T1).
 *
 * Pipeline có 2 bước tách rời (xem consolidateGraph.ts):
 *  1. Extraction (file này): rút fact ứng viên từ từng turn hội thoại.
 *  2. Consolidation: so fact ứng viên với fact cũ → ADD / UPDATE /
 *     DELETE / QUARANTINE.
 *
 * Extractor mặc định là LUẬT XÁC ĐỊNH trên text (không gọi model):
 * kết quả kiểm chứng được, không bao giờ "sáng tác" fact, chạy được
 * offline hoàn toàn. Mỗi pattern gồm regex (tiếng Việt + tiếng Anh)
 * và hàm map match → CandidateFact (subject/predicate/object +
 * confidence). Chỉ turn nào KHỚP pattern mới sinh fact — câu không
 * khớp không sinh fact rác (không có fallback "câu nào cũng thành
 * fact").
 *
 * Khi muốn rút sâu hơn, dùng `OllamaFactExtractor`: gọi model local
 * qua Ollama `/api/chat` (mặc định `qwen2.5:0.5b` — model nhỏ đã có
 * sẵn trên máy; đổi được qua options), ép model trả JSON danh sách
 * fact, parse + validate chặt (bỏ fact thiếu trường, bỏ predicate
 * lạ). Model lỗi / timeout / trả JSON hỏng → fallback về luật xác
 * định, KHÔNG bao giờ throw ra ngoài pipeline.
 *
 * Predicate chuẩn (dùng chung cho cả 2 extractor — consolidation và
 * search đều dựa vào tập này):
 *  likes, dislikes, lives_in, works_at, works_as, name_is, speaks,
 *  prefers, owns, wants, allergic_to, favorite_food, favorite_drink,
 *  favorite_movie, favorite_music, hobby, goal, birthday, location,
 *  states (khẳng định chung, confidence thấp).
 */

import type { CandidateFact, EntityKind, MemoryScope } from './types';
import { normalizeGraphText } from './types';

/** Predicate nào được phép (mọi extractor khác đều bị lọc qua đây). */
export const ALLOWED_PREDICATES = new Set([
  'likes',
  'dislikes',
  'lives_in',
  'works_at',
  'works_as',
  'name_is',
  'speaks',
  'prefers',
  'owns',
  'wants',
  'allergic_to',
  'favorite_food',
  'favorite_drink',
  'favorite_movie',
  'favorite_music',
  'hobby',
  'goal',
  'birthday',
  'location',
  'states',
]);

export function isAllowedPredicate(predicate: string): boolean {
  return ALLOWED_PREDICATES.has(normalizeGraphText(predicate).replace(/\s+/g, '_'));
}

/** Interface extractor — luật xác định và LLM đều khớp nó. */
export interface FactExtractor {
  /** Rút fact ứng viên từ một turn (text thô). */
  extract(text: string, scope: MemoryScope, sourceText: string): Promise<CandidateFact[]>;
  /** Tên extractor (ghi vào log chạy để biết fact từ đâu ra). */
  readonly name: string;
}

interface Pattern {
  /** Regex có 1 group bắt object (vd "thích X"). */
  re: RegExp;
  predicate: string;
  /** Subject mặc định của pattern (thường là "user"). */
  subjectName: string;
  kind: EntityKind;
  objectIsEntity: boolean;
  confidence: number;
  /** Chuẩn hoá object trước khi ghi (vd bỏ "ở" thừa). */
  clean?: (raw: string) => string;
}

const stripTrailing = (raw: string): string =>
  raw
    .trim()
    .replace(/[.!,?;:]+$/u, '')
    .trim();

const stripLeadingPrep = (raw: string): string => raw.trim().replace(/^(ở|tại|o|at|in)\s+/iu, '').trim();

/**
 * Bảng pattern — mỗi dòng là một cách người dùng diễn đạt một fact.
 * Giữ pattern chặt (yêu cầu "tôi/mình/em/mình là..." hoặc "my/..."):
 * pattern lỏng sẽ rút fact sai từ câu hỏi, câu trích dẫn, câu đùa.
 */
const PATTERNS: Pattern[] = [
  { re: /(?:tôi|mình|em|anh|chị|tớ|mình)\s+thích\s+(?:ăn\s+)?(.{2,80})/iu, predicate: 'likes', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.9, clean: stripTrailing },
  { re: /\bi\s+(?:really\s+)?like\s+(.{2,80})/iu, predicate: 'likes', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.9, clean: stripTrailing },
  { re: /(?:tôi|mình|em|anh|chị|tớ)\s+ghét\s+(.{2,80})/iu, predicate: 'dislikes', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.9, clean: stripTrailing },
  { re: /\bi\s+(?:really\s+)?(?:hate|dislike)\s+(.{2,80})/iu, predicate: 'dislikes', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.9, clean: stripTrailing },
  { re: /(?:tôi|mình|em|anh|chị|tớ)\s+(?:đang\s+)?sống\s+(?:ở|tại)\s+(.{2,80})/iu, predicate: 'lives_in', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.92, clean: (s) => stripTrailing(stripLeadingPrep(s)) },
  { re: /\bi\s+live\s+in\s+(.{2,80})/iu, predicate: 'lives_in', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.92, clean: stripTrailing },
  { re: /(?:tôi|mình|em|anh|chị|tớ)\s+(?:đang\s+)?làm\s+(?:việc\s+)?(?:ở|tại|cho)?\s*(.{2,80})/iu, predicate: 'works_at', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.85, clean: (s) => stripTrailing(stripLeadingPrep(s)) },
  { re: /\bi\s+work\s+(?:at|for)\s+(.{2,80})/iu, predicate: 'works_at', subjectName: 'user', kind: 'person', objectIsEntity: true, confidence: 0.85, clean: stripTrailing },
  { re: /(?:tôi|mình|em|anh|chị|tớ)\s+là\s+(?:một\s+)?(.{2,80})/iu, predicate: 'works_as', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.8, clean: stripTrailing },
  { re: /(?:tên\s+(?:tôi|mình|em)\s+là|tôi\s+tên\s+là|my\s+name\s+is)\s+(.{2,60})/iu, predicate: 'name_is', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.95, clean: stripTrailing },
  { re: /(?:tôi|mình|em)\s+nói\s+(?:được\s+)?tiếng\s+(.{2,40})/iu, predicate: 'speaks', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.9, clean: stripTrailing },
  { re: /\bi\s+spea[kk]\s+(.{2,40})/iu, predicate: 'speaks', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.9, clean: stripTrailing },
  { re: /(?:tôi|mình|em)\s+dị\s+ứng\s+(?:với\s+)?(.{2,60})/iu, predicate: 'allergic_to', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.95, clean: stripTrailing },
  { re: /\bi\s*(?:'m|am)\s+allergic\s+to\s+(.{2,60})/iu, predicate: 'allergic_to', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.95, clean: stripTrailing },
  { re: /(?:món\s+ăn\s+)?(?:yêu\s+thích|ưa\s+thích)\s+(?:của\s+(?:tôi|mình)\s+)?(?:là\s+)?(.{2,80})/iu, predicate: 'favorite_food', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.88, clean: stripTrailing },
  { re: /my\s+favorite\s+food\s+is\s+(.{2,80})/iu, predicate: 'favorite_food', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.88, clean: stripTrailing },
  { re: /(?:phim\s+)?(?:yêu\s+thích|ưa\s+thích)\s+(?:của\s+(?:tôi|mình)\s+)?(?:là\s+)?(.{2,80})/iu, predicate: 'favorite_movie', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.85, clean: stripTrailing },
  { re: /my\s+favorite\s+(?:movie|film)\s+is\s+(.{2,80})/iu, predicate: 'favorite_movie', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.85, clean: stripTrailing },
  { re: /(?:sở\s+thích|thú\s+vui)\s+(?:của\s+(?:tôi|mình)\s+)?(?:là\s+)?(.{2,80})/iu, predicate: 'hobby', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.85, clean: stripTrailing },
  { re: /my\s+hobby\s+is\s+(.{2,80})/iu, predicate: 'hobby', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.85, clean: stripTrailing },
  { re: /(?:tôi|mình|em)\s+muốn\s+(.{2,80})/iu, predicate: 'wants', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.75, clean: stripTrailing },
  { re: /\bi\s+want\s+(?:to\s+)?(.{2,80})/iu, predicate: 'wants', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.75, clean: stripTrailing },
  { re: /(?:tôi|mình|em)\s+có\s+(?:một\s+)?(?:cái\s+)?(.{2,80})/iu, predicate: 'owns', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.7, clean: stripTrailing },
  { re: /(?:nhớ\s+rằng|hãy\s+nhớ|remember\s+that)\s+(.{2,200})/iu, predicate: 'states', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.85, clean: stripTrailing },
  { re: /(?:sinh\s+nhật\s+(?:của\s+)?(?:tôi|mình)\s+(?:là\s+)?|my\s+birthday\s+is\s+)(.{2,40})/iu, predicate: 'birthday', subjectName: 'user', kind: 'person', objectIsEntity: false, confidence: 0.9, clean: stripTrailing },
];

/** Chuẩn hoá object: bỏ từ thừa, giới hạn độ dài, bỏ object rỗng/vô nghĩa. */
function cleanObject(raw: string, clean?: (raw: string) => string): string | null {
  let out = clean ? clean(raw) : stripTrailing(raw);
  out = out.replace(/\s+(nữa|nhé|nha|đấy|đó|thôi|ạ|nhỉ)$/iu, '').trim();
  if (out.length < 2 || out.length > 200) return null;
  // Bỏ object chỉ toàn từ dừng / đại từ (vd "thích nó", "là vậy").
  if (/^(nó|này|kia|vậy|thế|đó|it|that|this)$/iu.test(out)) return null;
  return out;
}

/**
 * Extractor luật xác định — chạy offline, không gọi model, kết quả
 * tái lập được 100% với cùng input.
 */
export class RuleBasedFactExtractor implements FactExtractor {
  readonly name = 'rule-based-v1';

  async extract(text: string, _scope: MemoryScope, sourceText: string): Promise<CandidateFact[]> {
    void _scope;
    const out: CandidateFact[] = [];
    const seen = new Set<string>();
    if (typeof text !== 'string' || text.trim() === '') return out;
    // Tách câu để mỗi pattern chỉ ăn một câu (tránh object nuốt cả đoạn).
    const sentences = text.split(/(?<=[.!?\n])\s+/u);
    for (const sentence of sentences) {
      for (const pattern of PATTERNS) {
        const match = pattern.re.exec(sentence);
        if (!match) continue;
        const objectText = cleanObject(match[1] ?? '', pattern.clean);
        if (objectText === null) continue;
        const key = `${pattern.subjectName}|${pattern.predicate}|${normalizeGraphText(objectText)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          subjectName: pattern.subjectName,
          kind: pattern.kind,
          predicate: pattern.predicate,
          objectText,
          objectIsEntity: pattern.objectIsEntity,
          confidence: pattern.confidence,
          sourceText: sourceText.slice(0, 500),
        });
      }
    }
    return out;
  }
}

export interface OllamaExtractorOptions {
  baseUrl?: string;
  /** Model chat local (mặc định qwen2.5:0.5b — nhỏ, có sẵn trên máy). */
  model?: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Extractor dự phòng khi LLM lỗi (mặc định: luật xác định). */
  fallback?: FactExtractor;
}

const EXTRACT_SYSTEM_PROMPT =
  'You extract personal facts from one conversation turn. ' +
  'Return ONLY a JSON array, no other text. Each item: ' +
  '{"subject":"user","predicate":"<one of likes,dislikes,lives_in,works_at,works_as,name_is,speaks,prefers,owns,wants,allergic_to,favorite_food,favorite_drink,favorite_movie,favorite_music,hobby,goal,birthday,location,states>","object":"<short fact, max 20 words>","confidence":0.0-1.0}. ' +
  'Extract only facts the user states about themselves. If none, return [].';

/**
 * Extractor LLM local qua Ollama — rút được fact mà luật không phủ
 * (vd diễn đạt gián tiếp). Không bao giờ throw: lỗi nào cũng fallback
 * về extractor luật xác định.
 */
export class OllamaFactExtractor implements FactExtractor {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly fallback: FactExtractor;

  constructor(opts: OllamaExtractorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = opts.model ?? 'qwen2.5:0.5b';
    this.fetchFn = opts.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fallback = opts.fallback ?? new RuleBasedFactExtractor();
    this.name = `ollama:${this.model}`;
  }

  async extract(text: string, scope: MemoryScope, sourceText: string): Promise<CandidateFact[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            messages: [
              { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
              { role: 'user', content: text.slice(0, 4000) },
            ],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return this.fallback.extract(text, scope, sourceText);
        const body = (await res.json()) as { message?: { content?: string } };
        const content = body?.message?.content ?? '';
        return this.parseLlmFacts(content, sourceText);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return this.fallback.extract(text, scope, sourceText);
    }
  }

  /** Parse + validate JSON fact từ LLM — bỏ mọi mục không hợp lệ. */
  parseLlmFacts(content: string, sourceText: string): CandidateFact[] {
    const out: CandidateFact[] = [];
    const seen = new Set<string>();
    const jsonText = extractJsonArray(content);
    if (jsonText === null) return out;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch {
      return out;
    }
    if (!Array.isArray(parsed)) return out;
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const subject = typeof rec.subject === 'string' ? rec.subject.trim() : '';
      const predicate = typeof rec.predicate === 'string' ? rec.predicate.trim() : '';
      const object = typeof rec.object === 'string' ? rec.object.trim() : '';
      if (subject === '' || object === '' || !isAllowedPredicate(predicate)) continue;
      const cleaned = cleanObject(object);
      if (cleaned === null) continue;
      const confidence =
        typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
          ? Math.min(1, Math.max(0, rec.confidence))
          : 0.7;
      const key = `${subject}|${predicate}|${normalizeGraphText(cleaned)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        subjectName: subject,
        kind: 'person',
        predicate: normalizeGraphText(predicate).replace(/\s+/g, '_'),
        objectText: cleaned,
        objectIsEntity: predicate === 'lives_in' || predicate === 'works_at',
        confidence,
        sourceText: sourceText.slice(0, 500),
      });
    }
    return out;
  }
}

/** Lấy mảng JSON đầu tiên trong text LLM (model hay thêm chữ thừa). */
export function extractJsonArray(content: string): string | null {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  return content.slice(start, end + 1);
}

/** Extractor mock — test dùng để giả lập LLM trả fact cố định. */
export class MockFactExtractor implements FactExtractor {
  readonly name = 'mock';
  constructor(private readonly facts: CandidateFact[]) {}

  async extract(_text: string, _scope: MemoryScope, _sourceText: string): Promise<CandidateFact[]> {
    void _text;
    void _scope;
    void _sourceText;
    return this.facts.map((f) => ({ ...f }));
  }
}
