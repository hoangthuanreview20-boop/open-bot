/**
 * Metrics cho memory benchmark (v1.01, Đội T5).
 *
 * Đo trên kết quả recall của chính hệ thống (tự đo, không tin số vendor):
 *  - Recall@k: tỉ lệ task mà ít nhất 1 gold note nằm trong top-k.
 *  - Precision@k: tỉ lệ gold trong top-k (trung bình trên task).
 *  - MRR: trung bình 1/rank của gold đầu tiên (0 nếu không có gold).
 *  - Accuracy: tỉ lệ task mà đáp án trích ra từ note recall được khớp
 *    với đáp án đúng (so khớp sau chuẩn hoá — xem `answersMatch`).
 *  - Wilson interval cho accuracy (95%) — vì benchmark nhỏ, tỉ lệ thô
 *    dễ gây ảo tưởng chính xác.
 *
 * Phân tích theo loại task (single-hop / multi-hop / temporal /
 * distractor) để thấy hệ thống yếu ở đâu, thay vì chỉ một con số chung.
 */

import { normalizeNoteText } from '../types';
import type { BenchmarkTask, BenchmarkTaskKind } from './generator';

/** Kết quả recall của một task (do runner ghi). */
export interface TaskRecallResult {
  taskId: string;
  kind: BenchmarkTaskKind;
  /** Id note recall được, xếp theo thứ hạng (rank 1 = đầu tiên). */
  retrievedNoteIds: string[];
  /** Đáp án trích ra (vd từ note top-1) — vắng = không trích được. */
  extractedAnswer?: string;
}

/** Metrics cho một nhóm task (toàn bộ hoặc một loại). */
export interface MetricsSummary {
  taskCount: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  precisionAt5: number;
  mrr: number;
  accuracy: number;
  /** Khoảng tin cậy Wilson 95% cho accuracy: [low, high]. */
  accuracyWilson95: [number, number];
  /** Số task mà distractor lọt top-3 (đo mức độ bị lừa). */
  distractorInTop3: number;
  /** Số task mà note cũ (temporal) lọt top-3 thay vì bản mới. */
  staleInTop3: number;
}

/** Metrics đầy đủ: tổng + theo loại. */
export interface BenchmarkMetrics {
  overall: MetricsSummary;
  byKind: Record<BenchmarkTaskKind, MetricsSummary>;
}

const RECALL_KS = [1, 3, 5, 10] as const;

/** Chuẩn hoá đáp án để so khớp: bỏ dấu, chữ thường, bỏ dấu câu, gộp khoảng trắng. */
export function normalizeAnswer(answer: string): string {
  return normalizeNoteText(answer ?? '');
}

/**
 * Hai đáp án có khớp không. Khớp khi:
 *  - chuẩn hoá bằng nhau, hoặc
 *  - một bên chứa bên kia (vd đáp án "phở bò; chạy bộ" chứa "phở bò"),
 *  - multi-hop: mọi phần của đáp án đúng (tách bằng ';') đều xuất hiện
 *    trong đáp án trích ra.
 */
export function answersMatch(expected: string, extracted: string | undefined): boolean {
  if (extracted === undefined) return false;
  // Tách phần TRƯỚC khi chuẩn hoá: normalize biến ';' thành khoảng trắng.
  const rawParts = expected.split(';').map((p) => p.trim()).filter(Boolean);
  const got = normalizeAnswer(extracted);
  if (!got) return false;
  if (rawParts.length > 1) {
    return rawParts.every((part) => {
      const p = normalizeAnswer(part);
      return p !== '' && got.includes(p);
    });
  }
  const exp = normalizeAnswer(expected);
  if (!exp) return false;
  if (exp === got) return true;
  return got.includes(exp) || exp.includes(got);
}

/** Khoảng tin cậy Wilson 95% cho tỉ lệ (z = 1.96). */
export function wilsonInterval(successes: number, total: number, z = 1.96): [number, number] {
  if (total === 0) return [0, 0];
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  const low = Math.max(0, (center - margin) / denom);
  const high = Math.min(1, (center + margin) / denom);
  return [Number(low.toFixed(4)), Number(high.toFixed(4))];
}

/** Tính metrics cho một nhóm task (kèm distractor/stale tracking). */
export function computeMetrics(
  tasks: BenchmarkTask[],
  results: TaskRecallResult[],
): MetricsSummary {
  const byId = new Map(results.map((r) => [r.taskId, r]));
  const taskCount = tasks.length;
  if (taskCount === 0) {
    return {
      taskCount: 0,
      recallAt1: 0, recallAt3: 0, recallAt5: 0, recallAt10: 0,
      precisionAt5: 0, mrr: 0, accuracy: 0,
      accuracyWilson95: [0, 0], distractorInTop3: 0, staleInTop3: 0,
    };
  }
  const recallHits: Record<number, number> = { 1: 0, 3: 0, 5: 0, 10: 0 };
  let precisionSum = 0;
  let mrrSum = 0;
  let correct = 0;
  let distractorInTop3 = 0;
  let staleInTop3 = 0;

  for (const task of tasks) {
    const result = byId.get(task.id);
    const retrieved = result?.retrievedNoteIds ?? [];
    const gold = new Set(task.goldNoteIds);
    for (const k of RECALL_KS) {
      if (retrieved.slice(0, k).some((id) => gold.has(id))) recallHits[k]++;
    }
    const top5 = retrieved.slice(0, 5);
    const goldInTop5 = top5.filter((id) => gold.has(id)).length;
    precisionSum += top5.length > 0 ? goldInTop5 / top5.length : 0;
    const firstGoldRank = retrieved.findIndex((id) => gold.has(id));
    if (firstGoldRank >= 0) mrrSum += 1 / (firstGoldRank + 1);
    if (answersMatch(task.expectedAnswer, result?.extractedAnswer)) correct++;
    const top3 = new Set(retrieved.slice(0, 3));
    if (task.distractorNoteIds.some((id) => top3.has(id))) {
      if (task.kind === 'distractor') distractorInTop3++;
      if (task.kind === 'temporal') staleInTop3++;
    }
  }

  const round4 = (n: number) => Number(n.toFixed(4));
  return {
    taskCount,
    recallAt1: round4(recallHits[1] / taskCount),
    recallAt3: round4(recallHits[3] / taskCount),
    recallAt5: round4(recallHits[5] / taskCount),
    recallAt10: round4(recallHits[10] / taskCount),
    precisionAt5: round4(precisionSum / taskCount),
    mrr: round4(mrrSum / taskCount),
    accuracy: round4(correct / taskCount),
    accuracyWilson95: wilsonInterval(correct, taskCount),
    distractorInTop3,
    staleInTop3,
  };
}

/** Tính metrics tổng + theo loại task. */
export function computeBenchmarkMetrics(
  tasks: BenchmarkTask[],
  results: TaskRecallResult[],
): BenchmarkMetrics {
  const overall = computeMetrics(tasks, results);
  const kinds: BenchmarkTaskKind[] = ['single-hop', 'multi-hop', 'temporal', 'distractor'];
  const byKind = {} as Record<BenchmarkTaskKind, MetricsSummary>;
  for (const kind of kinds) {
    byKind[kind] = computeMetrics(
      tasks.filter((t) => t.kind === kind),
      results.filter((r) => r.kind === kind),
    );
  }
  return { overall, byKind };
}

/** Task nào fail recall@5 — để report liệt kê lỗi sai hàng đầu. */
export function recallFailures(
  tasks: BenchmarkTask[],
  results: TaskRecallResult[],
  k = 5,
): Array<{ task: BenchmarkTask; retrievedTopK: string[] }> {
  const byId = new Map(results.map((r) => [r.taskId, r]));
  const out: Array<{ task: BenchmarkTask; retrievedTopK: string[] }> = [];
  for (const task of tasks) {
    const retrieved = byId.get(task.id)?.retrievedNoteIds ?? [];
    if (!retrieved.slice(0, k).some((id) => task.goldNoteIds.includes(id))) {
      out.push({ task, retrievedTopK: retrieved.slice(0, k) });
    }
  }
  return out;
}
