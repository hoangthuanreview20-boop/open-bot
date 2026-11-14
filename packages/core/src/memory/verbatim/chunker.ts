/**
 * Chunker cho verbatim memory (v1.01, Đội T4).
 *
 * Transcript/session dài không lưu nguyên một record khổng lồ: chẻ
 * thành chunk vừa (mặc định ≤ 2000 ký tự) để recall BM25/embedding
 * chính xác hơn. NGUYÊN TẮC: chẻ KHÔNG tóm tắt, KHÔNG diễn giải —
 * mỗi chunk là đoạn text gốc cắt ra, kèm span nguồn (vị trí bắt đầu/
 * kết thúc trong text gốc + chỉ số turn) để truy vết ngược.
 *
 * Chẻ theo ranh giới tự nhiên theo thứ tự ưu tiên: đoạn văn (dòng
 * trống) → câu (dấu kết câu) → dòng → từ — không bao giờ cắt giữa từ
 * trừ khi một "từ" dài bất thường (URL, mã hash). Chunk có overlap
 * nhỏ ở biên câu (mặc định 0 — verbatim không cần overlap vì mỗi
 * chunk tự đủ nghĩa; overlap chỉ bật khi host yêu cầu qua options).
 */
import type { VerbatimSource } from './types';

/** Một chunk verbatim kèm vị trí trong nguồn. */
export interface VerbatimChunk {
  /** Text gốc của chunk (không chỉnh sửa, trừ trim đầu/cuối). */
  text: string;
  /** Vị trí ký tự bắt đầu trong text nguồn. */
  startOffset: number;
  /** Vị trí ký tự kết thúc (exclusive) trong text nguồn. */
  endOffset: number;
  /** Chỉ số turn nguồn (khi chẻ theo turn). */
  turnIndex?: number;
  /** Nguồn của turn (user/agent/tool). */
  source?: VerbatimSource;
}

export interface VerbatimChunkOptions {
  /** Số ký tự tối đa mỗi chunk (mặc định 2000). */
  maxChars?: number;
  /** Số ký tự tối thiểu để giữ chunk (chunk ngắn hơn bị gộp/bỏ, mặc định 20). */
  minChars?: number;
  /** Số ký tự overlap giữa chunk liên tiếp (mặc định 0). */
  overlapChars?: number;
}

export const VERBATIM_DEFAULT_MAX_CHUNK_CHARS = 2000;
export const VERBATIM_DEFAULT_MIN_CHUNK_CHARS = 20;

/** Chẻ một đoạn text dài thành chunk verbatim (giữ nguyên văn). */
export function chunkVerbatimText(
  text: string,
  opts: VerbatimChunkOptions = {},
): VerbatimChunk[] {
  const maxChars = Math.max(200, opts.maxChars ?? VERBATIM_DEFAULT_MAX_CHUNK_CHARS);
  const minChars = Math.max(1, opts.minChars ?? VERBATIM_DEFAULT_MIN_CHUNK_CHARS);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? 0, Math.floor(maxChars / 4)));
  const source = (text ?? '').replace(/\r\n/g, '\n');
  if (source.trim().length === 0) return [];
  if (source.trim().length <= maxChars) {
    const start = leadingWhitespace(source);
    const end = source.length - trailingWhitespace(source);
    if (end - start < minChars) return [];
    return [{ text: source.slice(start, end), startOffset: start, endOffset: end }];
  }

  // Tách thành "đơn vị" theo ranh giới tự nhiên, giữ offset từng đơn vị.
  const units = splitIntoUnits(source);
  const chunks: VerbatimChunk[] = [];
  let current: VerbatimChunk[] = [];
  let currentLen = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) return;
    const textSlice = source.slice(first.startOffset, last.endOffset).trim();
    if (textSlice.length >= minChars) {
      chunks.push({
        text: textSlice,
        startOffset: first.startOffset,
        endOffset: last.endOffset,
      });
    }
    current = [];
    currentLen = 0;
  };

  for (const unit of units) {
    // Đơn vị đơn lẻ đã quá dài → chẻ cứng theo từ (không cắt giữa từ).
    if (unit.text.length > maxChars) {
      flush();
      for (const hard of hardSplitUnit(source, unit, maxChars, minChars)) chunks.push(hard);
      continue;
    }
    if (currentLen > 0 && currentLen + unit.text.length > maxChars) flush();
    current.push(unit);
    currentLen += unit.text.length;
  }
  flush();

  if (overlap <= 0) return chunks;
  // Overlap: mở rộng chunk sau lùi về trước tối đa `overlap` ký tự,
  // chỉ cắt ở biên khoảng trắng để không cắt giữa từ.
  return chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = chunks[i - 1];
    if (prev === undefined) return chunk;
    const wantStart = Math.max(chunk.startOffset - overlap, prev.endOffset - overlap);
    let start = wantStart;
    while (start > chunk.startOffset - overlap && start > prev.startOffset && source[start - 1] !== ' ' && source[start - 1] !== '\n') {
      start -= 1;
    }
    if (start >= chunk.startOffset) return chunk;
    return { ...chunk, text: source.slice(start, chunk.endOffset).trim(), startOffset: start };
  });
}

/** Chẻ một transcript (mảng turn) thành chunk, giữ turnIndex + source từng chunk. */
export function chunkTranscriptTurns(
  turns: { role: string; text: string }[],
  opts: VerbatimChunkOptions & { sourceOf?: (role: string) => VerbatimSource } = {},
): VerbatimChunk[] {
  const chunks: VerbatimChunk[] = [];
  turns.forEach((turn, turnIndex) => {
    const source = opts.sourceOf !== undefined ? opts.sourceOf(turn.role) : roleToSource(turn.role);
    if (source === undefined) return;
    for (const chunk of chunkVerbatimText(turn.text, opts)) {
      chunks.push({ ...chunk, turnIndex, source });
    }
  });
  return chunks;
}

/** Map role hội thoại → VerbatimSource (role lạ → undefined = bỏ qua). */
export function roleToSource(role: string): VerbatimSource | undefined {
  const r = (role ?? '').trim().toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'agent' || r === 'bot') return 'agent';
  if (r === 'tool' || r === 'system') return 'tool';
  return undefined;
}

function leadingWhitespace(s: string): number {
  const m = /^\s*/.exec(s);
  return m === null ? 0 : m[0].length;
}

function trailingWhitespace(s: string): number {
  const m = /\s*$/.exec(s);
  return m === null ? 0 : m[0].length;
}

/**
 * Tách text thành đơn vị nhỏ theo ranh giới tự nhiên (đoạn văn → câu →
 * dòng), giữ nguyên offset. Mỗi đơn vị kèm khoảng trắng sau nó để khi
 * gộp lại không mất dấu câu/khoảng trắng gốc.
 */
function splitIntoUnits(source: string): VerbatimChunk[] {
  const units: VerbatimChunk[] = [];
  // Ranh giới đoạn văn (2+ newline) là ranh giới mạnh nhất.
  const paragraphs = splitKeepOffsets(source, /\n\s*\n/);
  for (const para of paragraphs) {
    if (para.text.trim() === '') continue;
    // Trong đoạn: tách theo câu (dấu . ! ? … + khoảng trắng + chữ hoa/số).
    const sentences = splitKeepOffsets(para.text, /(?<=[.!?…])\s+(?=[A-ZÀ-Ỹ0-9"\u201c])/u);
    for (const sentence of sentences) {
      const absStart = para.startOffset + sentence.startOffset;
      const absEnd = para.startOffset + sentence.endOffset;
      if (sentence.text.trim() === '') continue;
      units.push({ text: sentence.text, startOffset: absStart, endOffset: absEnd });
    }
  }
  return units;
}

/** Tách chuỗi theo regex nhưng giữ offset tuyệt đối của từng mảnh. */
function splitKeepOffsets(
  text: string,
  separator: RegExp,
): { text: string; startOffset: number; endOffset: number }[] {
  const parts: { text: string; startOffset: number; endOffset: number }[] = [];
  const re = new RegExp(separator.source, separator.flags.includes('g') ? separator.flags : `${separator.flags}g`);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push({ text: text.slice(last, m.index), startOffset: last, endOffset: m.index });
    last = m.index + m[0].length;
  }
  parts.push({ text: text.slice(last), startOffset: last, endOffset: text.length });
  return parts;
}

/** Chẻ cứng một đơn vị quá dài theo từ (không cắt giữa từ). */
function hardSplitUnit(
  source: string,
  unit: VerbatimChunk,
  maxChars: number,
  minChars: number,
): VerbatimChunk[] {
  const out: VerbatimChunk[] = [];
  let start = unit.startOffset;
  const end = unit.endOffset;
  while (start < end) {
    let cut = Math.min(start + maxChars, end);
    if (cut < end) {
      // Lùi về khoảng trắng gần nhất để không cắt giữa từ.
      let back = cut;
      while (back > start && source[back] !== ' ' && source[back] !== '\n') back -= 1;
      if (back > start + minChars) cut = back;
    }
    const text = source.slice(start, cut).trim();
    if (text.length >= minChars) out.push({ text, startOffset: start, endOffset: cut });
    start = cut;
    while (start < end && (source[start] === ' ' || source[start] === '\n')) start += 1;
  }
  return out;
}
