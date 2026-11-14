/**
 * Migration vào verbatim memory (v1.01, Đội T4).
 *
 * Hai nguồn import:
 *  1. `LongTermMemory` hiện có (key/value đã rút gọn): mỗi entry thành
 *     MỘT record verbatim dạng `"<key>: <value>"` — text này là text
 *     đã lưu trong longterm (không phải nguyên văn hội thoại gốc, nên
 *     source ghi 'import' + tag 'from-longterm' để phân biệt).
 *  2. Transcript file (JSON: mảng turn `{role, text}` hoặc `{role,
 *     content}`): chẻ bằng chunker rồi lưu từng chunk nguyên văn,
 *     giữ turnIndex + sessionId.
 *
 * Migration KHÔNG xoá nguồn (chỉ đọc), idempotent nhờ dedup theo
 * hash của store (chạy lại lần 2 chỉ đếm duplicate, không nhân đôi).
 */
import * as fs from 'node:fs';
import type { LongTermMemory } from '../longterm';
import { chunkTranscriptTurns } from './chunker';
import type { VerbatimMemoryStore } from './store';
import type { SaveVerbatimInput } from './types';

export interface MigrateLongTermResult {
  /** Số record verbatim mới tạo. */
  created: number;
  /** Số entry đã có sẵn (dedup). */
  duplicates: number;
  /** Số entry bỏ qua (rỗng / lỗi shape). */
  skipped: number;
}

export interface MigrateTranscriptOptions {
  /** Wing gán cho mọi record import (mặc định 'default'). */
  wing?: string;
  /** Room gán cho mọi record import (mặc định 'imported'). */
  room?: string;
  /** Session id gán cho record (mặc định lấy từ tên file). */
  sessionId?: string;
  /** Bot id gán cho record (mặc định ''). */
  botId?: string;
  /** Số ký tự tối đa mỗi chunk (mặc định 2000). */
  maxChunkChars?: number;
}

export interface MigrateTranscriptResult {
  /** Số chunk verbatim mới tạo. */
  created: number;
  /** Số chunk đã có sẵn (dedup). */
  duplicates: number;
  /** Số turn đã đọc. */
  turns: number;
  /** Số chunk đã chẻ. */
  chunks: number;
}

/**
 * Import toàn bộ entry của một `LongTermMemory` vào verbatim store.
 * Entry nào đã có (cùng key+value+wing+room) thì đếm duplicate.
 */
export async function migrateLongTermToVerbatim(
  longterm: LongTermMemory,
  store: VerbatimMemoryStore,
  opts: { wing?: string; room?: string } = {},
): Promise<MigrateLongTermResult> {
  const wing = opts.wing ?? 'default';
  const room = opts.room ?? 'longterm';
  const entries = longterm.list();
  let created = 0;
  let duplicates = 0;
  let skipped = 0;
  for (const entry of entries) {
    const key = (entry.key ?? '').trim();
    const value = (entry.value ?? '').trim();
    if (key === '' && value === '') {
      skipped += 1;
      continue;
    }
    const input: SaveVerbatimInput = {
      text: value === '' ? key : `${key}: ${value}`,
      source: 'import',
      wing,
      room,
      tags: ['from-longterm', ...(entry.tags ?? [])],
      botId: entry.botId ?? '',
      userId: entry.userId,
      createdAt: entry.createdAt,
    };
    const result = await store.save(input);
    if (result.created) created += 1;
    else duplicates += 1;
  }
  return { created, duplicates, skipped };
}

/** Shape tối thiểu của một turn trong transcript file. */
export interface TranscriptTurnInput {
  role: string;
  text?: string;
  content?: string;
}

/** Đọc transcript file JSON → mảng turn (hỗ trợ `{turns: [...]}` hoặc mảng trực tiếp). */
export function readTranscriptFile(filePath: string): TranscriptTurnInput[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const arr: unknown = Array.isArray(parsed)
    ? parsed
    : (typeof parsed === 'object' && parsed !== null ? (parsed as { turns?: unknown }).turns : undefined);
  if (!Array.isArray(arr)) {
    throw new Error('Transcript file không đúng dạng (cần mảng turn hoặc {turns: [...]}).');
  }
  const turns: TranscriptTurnInput[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t['role'] !== 'string') continue;
    const text = typeof t['text'] === 'string' ? t['text'] : typeof t['content'] === 'string' ? t['content'] : '';
    turns.push({ role: t['role'], text });
  }
  return turns;
}

/**
 * Import transcript file vào verbatim store: chẻ từng turn thành
 * chunk nguyên văn (giữ turnIndex + sessionId), lưu qua store.
 */
export async function migrateTranscriptToVerbatim(
  filePath: string,
  store: VerbatimMemoryStore,
  opts: MigrateTranscriptOptions = {},
): Promise<MigrateTranscriptResult> {
  const turns = readTranscriptFile(filePath);
  const wing = opts.wing ?? 'default';
  const room = opts.room ?? 'imported';
  const sessionId = opts.sessionId;
  const chunks = chunkTranscriptTurns(
    turns.map((t, i) => ({ role: t.role, text: t.text ?? '' , index: i })),
    { maxChars: opts.maxChunkChars },
  );
  let created = 0;
  let duplicates = 0;
  for (const chunk of chunks) {
    const input: SaveVerbatimInput = {
      text: chunk.text,
      source: chunk.source ?? 'import',
      wing,
      room,
      tags: ['from-transcript'],
      botId: opts.botId ?? '',
      sessionId,
      turnIndex: chunk.turnIndex,
    };
    const result = await store.save(input);
    if (result.created) created += 1;
    else duplicates += 1;
  }
  return { created, duplicates, turns: turns.length, chunks: chunks.length };
}
