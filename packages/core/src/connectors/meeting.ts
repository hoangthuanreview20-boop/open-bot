/**
 * Meeting connector (v0.7) — nhập transcript + tóm tắt rule-based.
 *
 * ROADMAP §2c: "Tham gia meeting, lấy transcript và tóm tắt cuộc họp".
 *
 * Giới hạn thật (ghi rõ):
 *  - CHƯA tự tham gia meeting thật: tham gia meeting cần bot infra của
 *    nhà cung cấp (Zoom/Meet/Teams bot SDK + server ghi âm) — open-bot
 *    local-first không có. Tool chỉ NHẬP transcript đã có (file
 *    txt/vtt/srt/json hoặc URL) rồi tóm tắt.
 *  - Tóm tắt RULE-BASED, không gọi thêm API/model: trích câu quan trọng
 *    theo đoạn (điểm theo từ khoá quyết định/hành động + vị trí câu),
 *    tách riêng "quyết định" và "hành động cần làm". Tool không có
 *    model riêng; muốn tóm tắt bằng model thì agent gọi model của
 *    provider với transcript đã nhập.
 *
 * Transcript đã nhập lưu bền: `.open-bot/meetings/<id>.json`
 * (segments + metadata), để `meeting_summarize` tóm tắt lại sau.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MEETINGS_REL_DIR = path.join('.open-bot', 'meetings');

export interface TranscriptSegment {
  speaker?: string;
  /** Bắt đầu đoạn, dạng "00:01:23" hoặc giây (tuỳ nguồn). */
  start?: string;
  text: string;
}

export type TranscriptFormat = 'txt' | 'vtt' | 'srt' | 'json';

export interface ParsedTranscript {
  format: TranscriptFormat;
  segments: TranscriptSegment[];
}

export interface StoredTranscript extends ParsedTranscript {
  id: string;
  title: string;
  source: string;
  importedAt: string;
}

export interface TranscriptSummary {
  /** Tóm tắt dạng bullet (mỗi bullet một ý chính). */
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  segmentCount: number;
}

export type FetchFn = typeof fetch;

const VTT_TIMESTAMP_RE = /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/;
const SRT_TIMESTAMP_RE = /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/;
const SPEAKER_LINE_RE = /^([^:\n]{1,60}):\s+(.+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Đoán format từ nội dung (vtt/srt/json) hoặc đuôi file. */
export function detectTranscriptFormat(text: string, hint = ''): TranscriptFormat {
  const lowerHint = hint.toLowerCase();
  if (lowerHint.endsWith('.vtt')) return 'vtt';
  if (lowerHint.endsWith('.srt')) return 'srt';
  if (lowerHint.endsWith('.json')) return 'json';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('WEBVTT')) return 'vtt';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Không phải JSON hợp lệ — rơi xuống txt.
    }
  }
  if (SRT_TIMESTAMP_RE.test(text)) return 'srt';
  return 'txt';
}

/** Parse transcript text thành các segment theo format. */
export function parseTranscript(text: string, hint = ''): ParsedTranscript {
  const format = detectTranscriptFormat(text, hint);
  if (format === 'json') {
    const parsed: unknown = JSON.parse(text);
    const items = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed['segments'])
        ? (parsed['segments'] as unknown[])
        : isRecord(parsed) && typeof parsed['transcript'] === 'string'
          ? null
          : null;
    if (items === null && isRecord(parsed) && typeof parsed['transcript'] === 'string') {
      return parseTranscript(parsed['transcript'] as string);
    }
    if (items === null) throw new Error('JSON transcript must be an array of segments or {segments: [...]}.');
    const segments: TranscriptSegment[] = [];
    for (const item of items) {
      if (typeof item === 'string') {
        if (item.trim()) segments.push({ text: item.trim() });
      } else if (isRecord(item) && typeof item['text'] === 'string') {
        segments.push({
          speaker: typeof item['speaker'] === 'string' ? item['speaker'] : undefined,
          start:
            typeof item['start'] === 'string'
              ? item['start']
              : typeof item['timestamp'] === 'string'
                ? item['timestamp']
                : undefined,
          text: (item['text'] as string).trim(),
        });
      }
    }
    return { format: 'json', segments };
  }

  if (format === 'vtt' || format === 'srt') {
    const tsRe = format === 'vtt' ? VTT_TIMESTAMP_RE : SRT_TIMESTAMP_RE;
    const segments: TranscriptSegment[] = [];
    const blocks = text.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;
      let start: string | undefined;
      const textLines: string[] = [];
      for (const line of lines) {
        if (line === 'WEBVTT') continue;
        if (/^\d+$/.test(line) && format === 'srt') continue; // số thứ tự cue
        const m = tsRe.exec(line);
        if (m) {
          start = m[1];
          continue;
        }
        textLines.push(line);
      }
      const joined = textLines.join(' ').trim();
      if (!joined) continue;
      const speakerMatch = SPEAKER_LINE_RE.exec(joined);
      segments.push(
        speakerMatch
          ? { speaker: speakerMatch[1]?.trim(), start, text: (speakerMatch[2] as string).trim() }
          : { start, text: joined },
      );
    }
    return { format, segments };
  }

  // txt: mỗi dòng là một segment; "Tên: nội dung" tách speaker.
  const segments: TranscriptSegment[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = SPEAKER_LINE_RE.exec(line);
    segments.push(
      m
        ? { speaker: m[1]?.trim(), text: (m[2] as string).trim() }
        : { text: line },
    );
  }
  return { format: 'txt', segments };
}

// --- Rule-based summarization (không gọi model) ---------------------------

const DECISION_WORDS = [
  'quyết định', 'quyet dinh', 'decided', 'decision', 'đồng ý', 'dong y', 'agreed',
  'chốt', 'chot', 'thống nhất', 'thong nhat',
];
const ACTION_WORDS = [
  'cần', 'can', 'phải', 'phai', 'todo', 'action', 'deadline', 'hạn', 'han',
  'giao cho', 'assign', 'làm', 'lam', 'sẽ làm', 'se lam', 'next step', 'bước tiếp', 'buoc tiep',
];
const KEY_WORDS = [
  ...DECISION_WORDS,
  ...ACTION_WORDS,
  'quan trọng', 'quan trong', 'important', 'vấn đề', 'van de', 'issue',
  'kết quả', 'ket qua', 'result', 'kế hoạch', 'ke hoach', 'plan',
];

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function scoreSentence(sentence: string, position: number, total: number): number {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const word of KEY_WORDS) {
    if (lower.includes(word)) score += 2;
  }
  // Câu đầu/cuối đoạn thường mang ý chính.
  if (position === 0) score += 1;
  if (position === total - 1) score += 0.5;
  // Ưu tiên câu có nội dung (không quá ngắn, không quá dài).
  if (sentence.length >= 40 && sentence.length <= 240) score += 1;
  return score;
}

function containsAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

/**
 * Tóm tắt rule-based từ segment (hoặc text thô — tự parse trước).
 * Không gọi model/API. Trả keyPoints + decisions + actionItems riêng.
 */
export function summarizeTranscript(
  input: ParsedTranscript | string,
  maxPoints = 8,
): TranscriptSummary {
  const parsed = typeof input === 'string' ? parseTranscript(input) : input;
  const sentences: Array<{ text: string; score: number; order: number }> = [];
  let order = 0;
  for (const segment of parsed.segments) {
    const parts = splitSentences(segment.text);
    parts.forEach((sentence, idx) => {
      sentences.push({
        text: segment.speaker ? `${segment.speaker}: ${sentence}` : sentence,
        score: scoreSentence(sentence, idx, parts.length),
        order: order++,
      });
    });
  }
  const ranked = [...sentences].sort((a, b) => b.score - a.score || a.order - b.order);
  const top = ranked.slice(0, Math.max(1, maxPoints)).sort((a, b) => a.order - b.order);
  const keyPoints = top.map((s) => s.text);
  const decisions = sentences
    .filter((s) => containsAny(s.text, DECISION_WORDS))
    .map((s) => s.text);
  const actionItems = sentences
    .filter((s) => containsAny(s.text, ACTION_WORDS))
    .map((s) => s.text);
  const summary =
    keyPoints.length > 0
      ? keyPoints.map((p) => `- ${p}`).join('\n')
      : '(không trích được ý chính từ transcript này)';
  return {
    summary,
    keyPoints,
    decisions: [...new Set(decisions)],
    actionItems: [...new Set(actionItems)],
    segmentCount: parsed.segments.length,
  };
}

// --- Import / store --------------------------------------------------------

function resolveWithinWorkspace(workspaceDir: string, relPath: string): string {
  const resolved = path.resolve(workspaceDir, relPath);
  const root = path.resolve(workspaceDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${relPath}" escapes the workspace.`);
  }
  return resolved;
}

/**
 * Nhập transcript từ file trong workspace (txt/vtt/srt/json) hoặc URL
 * (http/https, fetch). Lưu bền vào `.open-bot/meetings/<id>.json` và
 * trả về transcript đã lưu + tóm tắt rule-based.
 */
export async function importTranscript(
  workspaceDir: string,
  source: string,
  opts: { title?: string; fetchFn?: FetchFn } = {},
): Promise<{ transcript: StoredTranscript; summary: TranscriptSummary }> {
  if (!source) throw new Error('Meeting transcript source (file path or URL) is required.');
  let text: string;
  let hint = source;
  if (/^https?:\/\//i.test(source)) {
    const fetchFn = opts.fetchFn ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchFn(source);
    } catch (err) {
      throw new Error(`Failed to fetch transcript URL: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`Transcript URL returned HTTP ${res.status}.`);
    text = await res.text();
  } else {
    const full = resolveWithinWorkspace(workspaceDir, source);
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      throw new Error(`Transcript file not found in workspace: "${source}"`);
    }
  }
  if (!text.trim()) throw new Error('Transcript is empty.');
  let parsed: ParsedTranscript;
  try {
    parsed = parseTranscript(text, hint);
  } catch (err) {
    throw new Error(`Cannot parse transcript: ${(err as Error).message}`);
  }
  if (parsed.segments.length === 0) throw new Error('Transcript has no readable segments.');
  const id = randomUUID();
  const transcript: StoredTranscript = {
    ...parsed,
    id,
    title: opts.title ?? path.basename(source),
    source,
    importedAt: new Date().toISOString(),
  };
  const dir = path.join(workspaceDir, MEETINGS_REL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(transcript, null, 2), 'utf8');
  return { transcript, summary: summarizeTranscript(parsed) };
}

/** Đọc transcript đã lưu theo id (ném lỗi khi không có). */
export function loadStoredTranscript(workspaceDir: string, id: string): StoredTranscript {
  const filePath = path.join(workspaceDir, MEETINGS_REL_DIR, `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredTranscript;
  } catch {
    throw new Error(`Unknown meeting transcript "${id}".`);
  }
}

/** Tóm tắt lại transcript đã lưu (rule-based, không gọi model). */
export function summarizeStoredTranscript(
  workspaceDir: string,
  id: string,
  maxPoints = 8,
): { transcript: StoredTranscript; summary: TranscriptSummary } {
  const transcript = loadStoredTranscript(workspaceDir, id);
  return { transcript, summary: summarizeTranscript(transcript, maxPoints) };
}

/** Liệt kê transcript đã nhập (mới nhất trước). */
export function listStoredTranscripts(workspaceDir: string): StoredTranscript[] {
  const dir = path.join(workspaceDir, MEETINGS_REL_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: StoredTranscript[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')) as StoredTranscript);
    } catch {
      // File hỏng — bỏ qua.
    }
  }
  out.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  return out;
}
