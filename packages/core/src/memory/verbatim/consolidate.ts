/**
 * Consolidation cho verbatim memory (v1.01, Đội T4).
 *
 * Verbatim lưu nhiều text thô nên vấn đề khó chuyển sang "vệ sinh
 * corpus": cùng một câu có thể được lưu nhiều lần ở wing/room khác
 * nhau, hoặc gần giống nhau (dấu câu/chữ hoa khác nhau). Dedup theo
 * hash của store chỉ bắt trùng KHỚP CHÍNH XÁC trong cùng wing+room —
 * module này bắt trùng MỀM:
 *
 *  - Nhóm record theo text đã chuẩn hoá MỀM (bỏ dấu, bỏ dấu câu, chữ
 *    thường — tái dùng `normalizeGraphText` của graph): cùng key mềm
 *    → một nhóm trùng.
 *  - Trong nhóm, giữ record CŨ NHẤT (bằng chứng gốc đầu tiên), các
 *    record còn lại là ứng viên xoá (KHÔNG tự xoá — trả báo cáo để
 *    user/host duyệt rồi mới xoá).
 *  - Ngoài ra phát hiện record "gần trùng" bằng Jaccard trên tập token
 *    (ngưỡng mặc định 0.85) cho các cặp trong cùng wing — để bắt câu
 *    chỉ khác vài từ.
 *
 * Mọi quyết định xoá đều ở ngoài module này (host gọi `delete` sau
 * khi user duyệt). Module chỉ PHÂN TÍCH + BÁO CÁO, không bao giờ tự
 * sửa store — an toàn cho dữ liệu gốc.
 */
import { normalizeGraphText } from '../graph/types';
import type { VerbatimMemoryStore } from './store';
import type { VerbatimRecord } from './types';

/** Một nhóm record trùng mềm. */
export interface VerbatimDuplicateGroup {
  /** Key chuẩn hoá mềm chung của nhóm. */
  key: string;
  /** Record gốc được giữ (cũ nhất). */
  keep: VerbatimRecord;
  /** Record trùng, ứng viên xoá (mới hơn, xếp theo thời gian). */
  duplicates: VerbatimRecord[];
}

/** Một cặp record gần trùng (Jaccard token ≥ ngưỡng). */
export interface VerbatimNearDuplicatePair {
  a: VerbatimRecord;
  b: VerbatimRecord;
  /** Jaccard similarity trên tập token (0..1). */
  similarity: number;
}

export interface VerbatimConsolidateReport {
  /** Tổng record đã xét. */
  examined: number;
  /** Số nhóm trùng mềm (≥ 2 record). */
  groups: VerbatimDuplicateGroup[];
  /** Số record trùng có thể xoá (tổng duplicates trong mọi nhóm). */
  removable: number;
  /** Cặp gần trùng (khác nhóm mềm nhưng Jaccard cao). */
  nearDuplicates: VerbatimNearDuplicatePair[];
}

export interface VerbatimConsolidateOptions {
  /** Chỉ xét record trong wing này (vắng = mọi wing). */
  wing?: string;
  /** Ngưỡng Jaccard cho near-duplicate (mặc định 0.85). */
  nearDuplicateThreshold?: number;
  /** Giới hạn số record xét (mặc định 10.000 — store lớn hơn nên chạy theo wing). */
  limit?: number;
  /** Bỏ qua record ngắn hơn N ký tự khi xét near-duplicate (mặc định 40 — câu ngắn trùng nhau là bình thường). */
  minLengthForNearDuplicate?: number;
}

/** Chuẩn hoá mềm: bỏ dấu + dấu câu + chữ thường (để "Phở bò!" khớp "pho bo"). */
export function softNormalizeVerbatimText(text: string): string {
  return normalizeGraphText(text);
}

/** Tập token của text (đã chuẩn hoá mềm). */
export function verbatimTokenSet(text: string): Set<string> {
  return new Set(softNormalizeVerbatimText(text).split(' ').filter((t) => t !== ''));
}

/** Jaccard similarity giữa hai tập token. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Phân tích trùng lặp trong store. Chỉ đọc — không sửa gì.
 * Near-duplicate chỉ xét trong cùng wing để tránh O(n²) toàn store
 * và tránh báo trùng vô nghĩa giữa hai dự án khác nhau.
 */
export async function consolidateVerbatim(
  store: VerbatimMemoryStore,
  opts: VerbatimConsolidateOptions = {},
): Promise<VerbatimConsolidateReport> {
  const threshold = opts.nearDuplicateThreshold ?? 0.85;
  const minLength = opts.minLengthForNearDuplicate ?? 40;
  const limit = Math.min(Math.max(opts.limit ?? 10_000, 1), 100_000);
  const { records } = await store.list({
    limit,
    order: 'oldest',
    filter: opts.wing !== undefined ? { wing: opts.wing } : {},
  });
  // store.list trả bản public (không embedding) — đủ cho consolidate
  // (embedding là optional trong VerbatimRecord).
  const full = records as VerbatimRecord[];

  // 1. Nhóm trùng mềm theo key chuẩn hoá.
  const byKey = new Map<string, VerbatimRecord[]>();
  for (const record of full) {
    const key = softNormalizeVerbatimText(record.text);
    if (key === '') continue;
    const group = byKey.get(key);
    if (group !== undefined) group.push(record);
    else byKey.set(key, [record]);
  }
  const groups: VerbatimDuplicateGroup[] = [];
  const groupedIds = new Set<string>();
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    // Giữ record cũ nhất (đã xếp oldest trước).
    const [keep, ...duplicates] = members as [VerbatimRecord, ...VerbatimRecord[]];
    if (keep === undefined) continue;
    groups.push({ key, keep, duplicates });
    for (const m of members) groupedIds.add(m.id);
  }
  groups.sort((a, b) => b.duplicates.length - a.duplicates.length);
  const removable = groups.reduce((n, g) => n + g.duplicates.length, 0);

  // 2. Near-duplicate (Jaccard) giữa các record CHƯA nằm trong nhóm
  //    trùng mềm, cùng wing, đủ dài.
  const nearDuplicates: VerbatimNearDuplicatePair[] = [];
  const singles = full.filter((r) => !groupedIds.has(r.id) && r.text.length >= minLength);
  const byWing = new Map<string, VerbatimRecord[]>();
  for (const record of singles) {
    const list = byWing.get(record.wing);
    if (list !== undefined) list.push(record);
    else byWing.set(record.wing, [record]);
  }
  for (const members of byWing.values()) {
    const tokenSets = members.map((r) => verbatimTokenSet(r.text));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        const setA = tokenSets[i];
        const setB = tokenSets[j];
        if (a === undefined || b === undefined || setA === undefined || setB === undefined) continue;
        // Lọc nhanh: chênh lệch độ dài tập token quá lớn thì Jaccard
        // không thể đạt ngưỡng — bỏ qua không tính.
        const maxLen = Math.max(setA.size, setB.size);
        const minLen = Math.min(setA.size, setB.size);
        if (minLen === 0 || minLen / maxLen < threshold) continue;
        const similarity = jaccardSimilarity(setA, setB);
        if (similarity >= threshold) nearDuplicates.push({ a, b, similarity });
      }
    }
  }
  nearDuplicates.sort((a, b) => b.similarity - a.similarity);

  return { examined: full.length, groups, removable, nearDuplicates };
}

/**
 * Xoá các record trùng trong một báo cáo consolidate (sau khi user
 * duyệt). Chỉ xoá `duplicates` trong từng nhóm — KHÔNG xoá record
 * `keep`, KHÔNG xoá near-duplicate (cần user quyết từng cặp).
 * Trả số đã xoá thật.
 */
export async function applyVerbatimDedup(
  store: VerbatimMemoryStore,
  report: VerbatimConsolidateReport,
): Promise<number> {
  let deleted = 0;
  for (const group of report.groups) {
    for (const dup of group.duplicates) {
      if (await store.delete(dup.id)) deleted += 1;
    }
  }
  return deleted;
}
