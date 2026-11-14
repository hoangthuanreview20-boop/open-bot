/**
 * Wake-up memory cho verbatim memory (v1.01, Đội T4).
 *
 * Khi session bắt đầu (hook `SessionStart`), agent thường "quên" mọi
 * thứ từ session trước. Wake-up giải quyết bằng cách lắp một khối
 * context ngắn vào đầu session — KHÔNG phải toàn bộ memory, mà là:
 *  1. N record MỚI NHẤT của wing hiện tại (để nhớ "hôm qua đang làm gì"),
 *  2. N record LIÊN QUAN NHẤT tới chủ đề session (recall hybrid theo
 *     query host cung cấp — vd tên dự án / câu mở đầu của user),
 *  3. Gộp, dedup, cắt theo giới hạn ký tự để không phình context.
 *
 * Output là text thuần (danh sách gạch đầu dòng kèm wing/room + thời
 * gian) để host chèn vào system prompt hoặc SessionStart context.
 * Không gọi model, không cần API key. Host quyết định query + wing
 * (mặc định: wing 'default', không query → chỉ lấy mới nhất).
 */
import type { HookContext, HookDefinition, HookEvent } from '../../hooks/types';
import { modifyContextDecision } from '../../hooks/types';
import type { VerbatimMemoryStore } from './store';
import type { VerbatimRecord } from './types';

export interface VerbatimWakeUpOptions {
  /** Wing của session (mặc định 'default'). */
  wing?: string;
  /** Room của session (vắng = mọi room trong wing). */
  room?: string;
  /** Query để recall record liên quan (vắng = chỉ lấy mới nhất). */
  query?: string;
  /** Số record mới nhất (mặc định 5). */
  recentCount?: number;
  /** Số record liên quan theo query (mặc định 5). */
  relevantCount?: number;
  /** Giới hạn ký tự cho toàn bộ khối wake-up (mặc định 4000). */
  maxChars?: number;
  /** Giới hạn ký tự mỗi record trong khối (mặc định 500 — record dài bị cắt có đánh dấu). */
  maxCharsPerRecord?: number;
  /** Bot id để lọc (mặc định: mọi bot + shared). */
  botId?: string;
}

export interface VerbatimWakeUpSection {
  /** Tiêu đề section ('recent' | 'relevant'). */
  kind: 'recent' | 'relevant';
  records: VerbatimRecord[];
}

export interface VerbatimWakeUpResult {
  /** Các section đã lấy (recent trước, relevant sau). */
  sections: VerbatimWakeUpSection[];
  /** Text đã format, sẵn chèn vào context (rỗng khi không có record nào). */
  text: string;
  /** Tổng số record trong khối. */
  totalRecords: number;
  /** Có record nào bị cắt ký tự không. */
  truncated: boolean;
}

export const VERBATIM_WAKEUP_DEFAULT_RECENT = 5;
export const VERBATIM_WAKEUP_DEFAULT_RELEVANT = 5;
export const VERBATIM_WAKEUP_DEFAULT_MAX_CHARS = 4000;
export const VERBATIM_WAKEUP_DEFAULT_MAX_CHARS_PER_RECORD = 500;
/** Tên hook wake-up trong HookRegistry. */
export const VERBATIM_WAKEUP_HOOK_NAME = 'verbatim-wakeup';

/** Format một record thành một dòng wake-up (kèm wing/room + ngày). */
export function formatVerbatimWakeUpLine(record: VerbatimRecord, maxChars: number): { line: string; truncated: boolean } {
  const date = (record.createdAt ?? '').slice(0, 10);
  let text = record.text.replace(/\s+/g, ' ').trim();
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…`;
    truncated = true;
  }
  const where = record.drawer !== undefined ? `${record.wing}/${record.room}/${record.drawer}` : `${record.wing}/${record.room}`;
  return { line: `- [${date} · ${where}] ${text}`, truncated };
}

/**
 * Lấy wake-up context cho một session mới. Chỉ đọc store.
 * Dedup giữa recent và relevant (cùng id chỉ xuất hiện một lần —
 * ưu tiên section recent).
 */
export async function buildVerbatimWakeUp(
  store: VerbatimMemoryStore,
  opts: VerbatimWakeUpOptions = {},
): Promise<VerbatimWakeUpResult> {
  const wing = opts.wing ?? 'default';
  const recentCount = opts.recentCount ?? VERBATIM_WAKEUP_DEFAULT_RECENT;
  const relevantCount = opts.relevantCount ?? VERBATIM_WAKEUP_DEFAULT_RELEVANT;
  const maxChars = opts.maxChars ?? VERBATIM_WAKEUP_DEFAULT_MAX_CHARS;
  const maxPerRecord = opts.maxCharsPerRecord ?? VERBATIM_WAKEUP_DEFAULT_MAX_CHARS_PER_RECORD;
  const filter = {
    wing,
    ...(opts.room !== undefined ? { room: opts.room } : {}),
    ...(opts.botId !== undefined ? { botId: opts.botId } : {}),
  };

  const sections: VerbatimWakeUpSection[] = [];
  const seen = new Set<string>();

  // 1. Mới nhất trong wing.
  if (recentCount > 0) {
    const { records } = await store.list({ limit: recentCount, order: 'newest', filter });
    const fresh = records.filter((r) => !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    if (fresh.length > 0) sections.push({ kind: 'recent', records: fresh as VerbatimRecord[] });
  }

  // 2. Liên quan tới query (recall hybrid — có embedding khi store có embedder).
  if (relevantCount > 0 && opts.query !== undefined && opts.query.trim() !== '') {
    const result = await store.search(opts.query.trim(), { limit: relevantCount, filter });
    const relevant = result.hits.map((h) => h.record).filter((r) => !seen.has(r.id));
    for (const r of relevant) seen.add(r.id);
    if (relevant.length > 0) sections.push({ kind: 'relevant', records: relevant });
  }

  // 3. Format + cắt theo maxChars (cắt ở biên record, không cắt giữa dòng).
  const lines: string[] = [];
  let truncated = false;
  let used = 0;
  for (const section of sections) {
    const header = section.kind === 'recent' ? 'Memory gần đây:' : 'Memory liên quan:';
    if (used + header.length + 1 > maxChars && lines.length > 0) {
      truncated = true;
      break;
    }
    lines.push(header);
    used += header.length + 1;
    for (const record of section.records) {
      const { line, truncated: cut } = formatVerbatimWakeUpLine(record, maxPerRecord);
      if (used + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += line.length + 1;
      if (cut) truncated = true;
    }
    if (truncated) break;
  }

  const totalRecords = sections.reduce((n, s) => n + s.records.length, 0);
  return {
    sections,
    text: lines.join('\n'),
    totalRecords,
    truncated,
  };
}

/**
 * Tạo SessionStart hook definition lắp wake-up vào context của session.
 * Hook trả `modify` + `context` (extra context lines) — runner chèn
 * vào session. Wing/query lấy qua callback `getOptions` do host cung
 * cấp (vd wing = project hiện tại, query = câu mở đầu của user);
 * vắng callback thì dùng `opts` cố định. Hook mặc định TẮT (opt-in)
 * như autosave hook — host bật tường minh.
 */
export function createVerbatimWakeUpHook(
  store: VerbatimMemoryStore,
  opts: VerbatimWakeUpOptions & {
    enabled?: boolean;
    /** Callback cho host cung cấp wing/query theo từng session. */
    getOptions?: (ctx: HookContext) => VerbatimWakeUpOptions | undefined;
    onLog?: (message: string) => void;
  } = {},
): HookDefinition {
  const enabled = opts.enabled ?? false;
  const log = opts.onLog ?? ((message: string): void => {
    console.error(message);
  });
  return {
    name: VERBATIM_WAKEUP_HOOK_NAME,
    description:
      'Chèn memory nguyên văn gần đây + liên quan vào đầu session (wake-up). ' +
      'Mặc định TẮT (opt-in); chỉ đọc store, không ghi.',
    events: ['SessionStart'],
    source: 'builtin',
    enabled,
    handler: async (_event: HookEvent, ctx: HookContext) => {
      if (!enabled) return;
      const dynamic = opts.getOptions?.(ctx);
      const merged: VerbatimWakeUpOptions = { ...opts, ...(dynamic ?? {}) };
      if (merged.botId === undefined && ctx.botId !== undefined) merged.botId = ctx.botId;
      try {
        const result = await buildVerbatimWakeUp(store, merged);
        if (result.text === '' || result.totalRecords === 0) return;
        return modifyContextDecision(
          `${verbatimWakeUpHeader()}\n${result.text}`,
          `Đã chèn ${result.totalRecords} memory nguyên văn vào đầu session.`,
        );
      } catch (err) {
        log(`[verbatim-wakeup] Lỗi (${err instanceof Error ? err.message : String(err)}) — bỏ qua.`);
        return;
      }
    },
  };
}

export function verbatimWakeUpHeader(): string {
  return 'Verbatim memory (nguyên văn, local-first):';
}
