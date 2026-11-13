/**
 * Consolidation — "sleep-time compute" cho bộ nhớ (v0.96, Đội T1).
 *
 * Ý tưởng kiểu MemGPT/Letta (gom memory rời rạc lúc rảnh thành fact
 * đã hợp nhất) nhưng tự thiết kế lại hoàn toàn, chạy 100% local, KHÔNG
 * gọi model: mọi quyết định đều là luật xác định trên text, để kết quả
 * kiểm chứng được và không bao giờ "sáng tác" fact mới.
 *
 * Một lần consolidate làm 3 việc, theo thứ tự:
 *  1. Dedupe — memory trùng nhau (cùng key + cùng value sau chuẩn
 *     hoá) chỉ giữ bản mới nhất; bản cũ chuyển vào file archive.
 *  2. Resolve conflict — cùng key nhưng value khác nhau: bản mới hơn
 *     thắng (hoà thì độ tin cậy cao hơn thắng); bản thua chuyển vào
 *     archive KÈM ghi rõ nguồn (id, value, updatedAt) trong report.
 *  3. Promote — fact quan trọng (confidence >= ngưỡng, mặc định 0.9,
 *     hoặc mang tag `quan trọng`/`important`) được đẩy lên block
 *     `human` (tạo mới nếu chưa có) dưới dạng bullet `- key: value`,
 *     bỏ qua dòng đã có sẵn trong block.
 *
 * Archive: các entry bị loại KHÔNG bị xoá hẳn — chúng được ghi vào
 * `.open-bot/memory-archive-<timestamp>.json` rồi mới gỡ khỏi kho
 * live (qua `forgetById`), để user luôn khôi phục/xem lại được.
 *
 * Chạy tay qua tool `memory_consolidate` (action `run`), hoặc tự động
 * khi bot idle: `ConsolidationScheduler` đọc cấu hình trong chính file
 * memory-blocks (`enabled` + `idleMinutes`, MẶC ĐỊNH TẮT) và chỉ chạy
 * khi khoảng idle đã đủ dài. Coordinator gọi
 * `runIdleConsolidationIfDue()` lúc setup turn (best-effort, fail-open).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LongTermMemory, LongTermMemoryEntry } from './longterm';
import { MemoryBlockStore } from './blocks';

export const MEMORY_ARCHIVE_REL_DIR = path.join('.open-bot', 'memory-archives');
/** Ngưỡng confidence mặc định để một fact được đẩy lên block human. */
export const DEFAULT_PROMOTE_MIN_CONFIDENCE = 0.9;
/** Tag mặc định đánh dấu fact quan trọng (luôn được promote). */
export const DEFAULT_PROMOTE_TAGS = ['quan trọng', 'important'] as const;
/** Giới hạn ký tự của block human khi consolidation tạo mới. */
export const HUMAN_BLOCK_CHAR_LIMIT = 10000;

export interface ConsolidationOptions {
  /** Confidence tối thiểu để promote (mặc định 0.9). */
  minConfidenceToPromote?: number;
  /** Tag đánh dấu fact quan trọng (mặc định ['quan trọng','important']). */
  promoteTags?: string[];
  /** Label block nhận fact quan trọng (mặc định 'human'). */
  humanBlockLabel?: string;
  /** Actor ghi vào audit (mặc định 'system:consolidate'). */
  actor?: string;
  /** Số entry tối đa xét trong một lần chạy (mặc định 200). */
  limit?: number;
}

export interface ConflictResolution {
  key: string;
  winnerId: string;
  winnerValue: string;
  winnerUpdatedAt: string;
  superseded: Array<{ id: string; value: string; updatedAt: string }>;
}

export interface ConsolidationReport {
  ranAt: string;
  /** Số entry đã xét. */
  examined: number;
  /** Số bản trùng đã gỡ (giữ lại bản mới nhất). */
  deduped: number;
  /** Số nhóm xung đột đã giải quyết (bản mới hơn thắng). */
  conflictsResolved: number;
  /** Chi tiết từng xung đột (ghi rõ nguồn của bản thua). */
  conflicts: ConflictResolution[];
  /** Số fact đã đẩy lên block human. */
  promoted: number;
  /** Số fact quan trọng KHÔNG đẩy được (block human đã đầy). */
  promotedSkipped: number;
  /** Id block human (vắng khi không promote gì). */
  promotedBlockId?: string;
  /** Số entry đã chuyển vào archive. */
  archived: number;
  /** Đường dẫn file archive (vắng khi không có gì để archive). */
  archivedFile?: string;
  /** Dòng tóm tắt để hiển thị/log. */
  details: string[];
}

/**
 * Chuẩn hoá text để so sánh trùng/xung đột: chữ thường, bỏ dấu tiếng
 * Việt, bỏ dấu câu, gộp khoảng trắng. So sánh trên dạng chuẩn hoá nên
 * "Thích phở bò!" và "thich pho bo" được coi là một fact.
 */
export function normalizeFactText(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nhóm các entry trùng nhau: cùng key chuẩn hoá + cùng value chuẩn
 * hoá. Mỗi nhóm trả về entry giữ lại (mới nhất; hoà thì confidence
 * cao hơn) và danh sách bản trùng bị loại.
 */
export function groupDuplicateEntries(
  entries: LongTermMemoryEntry[],
): Array<{ keep: LongTermMemoryEntry; duplicates: LongTermMemoryEntry[] }> {
  const groups = new Map<string, LongTermMemoryEntry[]>();
  for (const entry of entries) {
    const signature = `${normalizeFactText(entry.key)}::${normalizeFactText(entry.value)}`;
    const list = groups.get(signature) ?? [];
    list.push(entry);
    groups.set(signature, list);
  }
  const out: Array<{ keep: LongTermMemoryEntry; duplicates: LongTermMemoryEntry[] }> = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.confidence - a.confidence ||
        b.createdAt.localeCompare(a.createdAt),
    );
    out.push({ keep: sorted[0] as LongTermMemoryEntry, duplicates: sorted.slice(1) });
  }
  return out;
}

/**
 * Tìm xung đột: cùng key chuẩn hoá nhưng value chuẩn hoá khác nhau.
 * Mỗi nhóm trả về bản thắng (mới nhất; hoà thì confidence cao hơn)
 * và các bản thua kèm nguồn đầy đủ để ghi vào report/archive.
 */
export function findConflicts(
  entries: LongTermMemoryEntry[],
): Array<{ key: string; winner: LongTermMemoryEntry; losers: LongTermMemoryEntry[] }> {
  const groups = new Map<string, LongTermMemoryEntry[]>();
  for (const entry of entries) {
    const key = normalizeFactText(entry.key);
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const out: Array<{ key: string; winner: LongTermMemoryEntry; losers: LongTermMemoryEntry[] }> = [];
  for (const [key, list] of groups.entries()) {
    const distinctValues = new Set(list.map((e) => normalizeFactText(e.value)));
    if (list.length < 2 || distinctValues.size < 2) continue;
    const sorted = [...list].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.confidence - a.confidence ||
        b.createdAt.localeCompare(a.createdAt),
    );
    out.push({
      key: list[0]?.key ?? key,
      winner: sorted[0] as LongTermMemoryEntry,
      losers: sorted.slice(1),
    });
  }
  return out;
}

/** Một entry có đủ "quan trọng" để đẩy lên block human không. */
export function isPromotable(
  entry: LongTermMemoryEntry,
  opts: { minConfidence: number; promoteTags: string[] },
): boolean {
  if (entry.confidence >= opts.minConfidence) return true;
  const tags = new Set(entry.tags.map((t) => t.toLowerCase()));
  return opts.promoteTags.some((t) => tags.has(t.toLowerCase()));
}

interface ArchivedEntry {
  entry: LongTermMemoryEntry;
  archivedReason: 'duplicate' | 'conflict-loser';
  keptEntryId?: string;
}

function archiveEntries(
  workspaceDir: string,
  archived: ArchivedEntry[],
  conflicts: ConflictResolution[],
): string | undefined {
  if (archived.length === 0 && conflicts.length === 0) return undefined;
  const dir = path.join(workspaceDir, MEMORY_ARCHIVE_REL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `archive-${stamp}.json`);
  const payload = {
    version: 1,
    archivedAt: new Date().toISOString(),
    reason: 'consolidate',
    count: archived.length,
    entries: archived,
    conflicts,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return filePath;
}

/**
 * Chạy một lần consolidate (đồng bộ, không gọi model, không gọi mạng).
 * Trả về report đầy đủ; không throw khi kho rỗng (trả report 0).
 */
export function consolidate(
  longTerm: LongTermMemory,
  blocks: MemoryBlockStore,
  opts: ConsolidationOptions = {},
): ConsolidationReport {
  const ranAt = new Date().toISOString();
  const actor = opts.actor ?? 'system:consolidate';
  const minConfidence = opts.minConfidenceToPromote ?? DEFAULT_PROMOTE_MIN_CONFIDENCE;
  const promoteTags = opts.promoteTags ?? [...DEFAULT_PROMOTE_TAGS];
  const humanLabel = opts.humanBlockLabel ?? 'human';
  const limit = opts.limit !== undefined ? Math.min(Math.max(Math.floor(opts.limit), 1), 200) : 200;
  const details: string[] = [];

  const entries = longTerm.recall({ limit });
  const examined = entries.length;
  const archived: ArchivedEntry[] = [];
  const conflicts: ConflictResolution[] = [];

  // 1. Dedupe — giữ bản mới nhất mỗi nhóm trùng.
  let deduped = 0;
  for (const group of groupDuplicateEntries(entries)) {
    for (const dup of group.duplicates) {
      archived.push({ entry: dup, archivedReason: 'duplicate', keptEntryId: group.keep.id });
      deduped += 1;
    }
  }

  // 2. Resolve conflict — bản mới hơn thắng; bản thua vào archive.
  // Xét trên các entry còn sống sau dedupe (bản trùng đã bị loại).
  const duplicateIds = new Set(archived.map((a) => a.entry.id));
  const survivors = entries.filter((e) => !duplicateIds.has(e.id));
  let conflictsResolved = 0;
  for (const conflict of findConflicts(survivors)) {
    conflictsResolved += 1;
    conflicts.push({
      key: conflict.key,
      winnerId: conflict.winner.id,
      winnerValue: conflict.winner.value,
      winnerUpdatedAt: conflict.winner.updatedAt,
      superseded: conflict.losers.map((l) => ({
        id: l.id,
        value: l.value,
        updatedAt: l.updatedAt,
      })),
    });
    for (const loser of conflict.losers) {
      archived.push({ entry: loser, archivedReason: 'conflict-loser', keptEntryId: conflict.winner.id });
    }
  }

  // Ghi archive TRƯỚC khi gỡ khỏi kho live (archive là bản sao lưu).
  const archivedFile = archiveEntries(longTerm.dir, archived, conflicts);
  const removedIds = new Set(archived.map((a) => a.entry.id));
  for (const id of removedIds) longTerm.forgetById(id);
  const archivedCount = removedIds.size;
  if (deduped > 0) details.push(`Đã gộp ${deduped} bản trùng (giữ bản mới nhất).`);
  if (conflictsResolved > 0) {
    details.push(
      `Đã giải quyết ${conflictsResolved} xung đột (bản mới hơn thắng): ` +
        conflicts.map((c) => `"${c.key}"`).join(', ') +
        '.',
    );
  }

  // 3. Promote — fact quan trọng lên block human (bỏ qua dòng đã có).
  let promoted = 0;
  let promotedSkipped = 0;
  let promotedBlockId: string | undefined;
  const live = entries.filter((e) => !removedIds.has(e.id));
  const promotable = live.filter((e) =>
    isPromotable(e, { minConfidence, promoteTags }),
  );
  if (promotable.length > 0) {
    const human = blocks.ensureBlock(
      humanLabel,
      {
        description: 'Sự thật quan trọng về người dùng (do consolidation đẩy lên).',
        charLimit: HUMAN_BLOCK_CHAR_LIMIT,
      },
      actor,
    );
    promotedBlockId = human.id;
    const existingLines = new Set(
      human.content
        .split('\n')
        .map((line) => normalizeFactText(line.replace(/^-\s*/, ''))),
    );
    for (const entry of promotable) {
      const bullet = `- ${entry.key}: ${entry.value}`;
      if (existingLines.has(normalizeFactText(bullet.replace(/^-\s*/, '')))) continue;
      try {
        blocks.append(human.id, bullet, actor);
        existingLines.add(normalizeFactText(bullet.replace(/^-\s*/, '')));
        promoted += 1;
      } catch {
        // Block human đầy (vượt giới hạn ký tự) — ghi nhận, không fail cả lần chạy.
        promotedSkipped += 1;
      }
    }
    if (promoted > 0) details.push(`Đã đẩy ${promoted} fact quan trọng lên block "${humanLabel}".`);
    if (promotedSkipped > 0) {
      details.push(`${promotedSkipped} fact quan trọng không đẩy được vì block "${humanLabel}" đã đầy.`);
    }
  }

  if (details.length === 0) details.push('Không có gì để gộp — bộ nhớ đã gọn.');
  blocks.audit(
    'consolidate',
    promotedBlockId ?? 'consolidation',
    actor,
    `examined=${examined} deduped=${deduped} conflicts=${conflictsResolved} promoted=${promoted} archived=${archivedCount}`,
  );
  return {
    ranAt,
    examined,
    deduped,
    conflictsResolved,
    conflicts,
    promoted,
    promotedSkipped,
    ...(promotedBlockId ? { promotedBlockId } : {}),
    archived: archivedCount,
    ...(archivedFile ? { archivedFile } : {}),
    details,
  };
}

// ---------------------------------------------------------------------------
// Idle scheduler — chạy consolidate khi bot đã idle đủ lâu (mặc định TẮT)
// ---------------------------------------------------------------------------

export interface IdleConsolidationState {
  enabled: boolean;
  idleMinutes: number;
  lastActivityAt?: string;
  lastRunAt?: string;
}

/** Ghi nhận "bot vừa hoạt động" (gọi mỗi lần turn bắt đầu/kết thúc). */
export function noteConsolidationActivity(blocks: MemoryBlockStore, now = new Date()): void {
  blocks.setConsolidationConfig({ lastActivityAt: now.toISOString() }, 'system:consolidate');
}

/** Đủ điều kiện chạy lúc idle chưa: đã bật + đã idle >= idleMinutes. */
export function shouldConsolidateNow(blocks: MemoryBlockStore, now = new Date()): boolean {
  const cfg = blocks.getConsolidationConfig();
  if (!cfg.enabled) return false;
  if (!cfg.lastActivityAt) return false;
  const idleMs = now.getTime() - new Date(cfg.lastActivityAt).getTime();
  return idleMs >= cfg.idleMinutes * 60_000;
}

/**
 * Chạy consolidate nếu đã đủ idle (best-effort: chưa đủ/không bật thì
 * trả null; lỗi trong lúc chạy thì trả null thay vì throw để caller ở
 * đường setup turn không bao giờ bị chặn).
 */
export function runIdleConsolidationIfDue(
  longTerm: LongTermMemory,
  blocks: MemoryBlockStore,
  opts: ConsolidationOptions = {},
  now = new Date(),
): ConsolidationReport | null {
  if (!shouldConsolidateNow(blocks, now)) return null;
  try {
    const report = consolidate(longTerm, blocks, opts);
    blocks.setConsolidationConfig({ lastRunAt: now.toISOString(), lastActivityAt: now.toISOString() }, 'system:consolidate');
    return report;
  } catch {
    return null;
  }
}

/**
 * Scheduler giữ state idle trong bộ nhớ (dùng cho test và cho host
 * muốn tự quản lý vòng đời thay vì đọc config từ file mỗi lần).
 */
export class ConsolidationScheduler {
  private lastActivityAt: number | null = null;
  private lastRunAt: number | null = null;
  private enabled: boolean;
  private idleMinutes: number;

  constructor(opts: { enabled?: boolean; idleMinutes?: number } = {}) {
    this.enabled = opts.enabled === true;
    this.idleMinutes =
      opts.idleMinutes !== undefined
        ? Math.min(24 * 60, Math.max(1, Math.floor(opts.idleMinutes)))
        : 30;
  }

  get state(): IdleConsolidationState {
    return {
      enabled: this.enabled,
      idleMinutes: this.idleMinutes,
      ...(this.lastActivityAt !== null
        ? { lastActivityAt: new Date(this.lastActivityAt).toISOString() }
        : {}),
      ...(this.lastRunAt !== null ? { lastRunAt: new Date(this.lastRunAt).toISOString() } : {}),
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled === true;
  }

  setIdleMinutes(minutes: number): void {
    this.idleMinutes = Math.min(24 * 60, Math.max(1, Math.floor(minutes)));
  }

  noteActivity(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  shouldRun(now = Date.now()): boolean {
    if (!this.enabled) return false;
    if (this.lastActivityAt === null) return false;
    return now - this.lastActivityAt >= this.idleMinutes * 60_000;
  }

  /**
   * Chạy consolidate nếu đủ idle; sau khi chạy thì cập nhật lastRun +
   * coi như vừa hoạt động (để không chạy lại ngay turn sau).
   */
  runIfDue(
    longTerm: LongTermMemory,
    blocks: MemoryBlockStore,
    opts: ConsolidationOptions = {},
    now = Date.now(),
  ): ConsolidationReport | null {
    if (!this.shouldRun(now)) return null;
    const report = consolidate(longTerm, blocks, opts);
    this.lastRunAt = now;
    this.lastActivityAt = now;
    return report;
  }
}
