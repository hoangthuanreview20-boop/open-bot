/**
 * Benchmark runner — chạy recall của memory system trên suite synthetic
 * (v1.01, Đội T5).
 *
 * Luồng:
 *  1. Ingest toàn bộ `documents` của suite vào một store (mặc định:
 *     store in-memory mới; có thể truyền store có sẵn).
 *  2. Với temporal task: document cũ được supersede bằng document mới
 *     (qua `store.supersedeNote`) — để đo xem recall có trả bản mới
 *     nhất không, thay vì bản cũ.
 *  3. Với mỗi task: gọi `adapter.recall(question, k)` → danh sách note
 *     id theo thứ hạng; trích đáp án từ note top-1 (heuristic: lấy
 *     `expectedAnswer` nếu nó xuất hiện trong body note — đây là cách
 *     chấm "đáp án có trong note recall được không", KHÔNG cần LLM).
 *  4. Tính metrics (R@k / accuracy / MRR) + ghi report.
 *
 * Adapter mặc định dùng `EvolvingNoteStore.search` (BM25 local). Muốn
 * đo hệ thống khác (vd long-term memory, hybrid + embedding) thì truyền
 * adapter riêng — runner không biết store là gì, chỉ biết recall.
 */

import type { BenchmarkSuite, BenchmarkTask } from './generator';
import { shuffleTasks } from './generator';
import type { TaskRecallResult } from './metrics';
import { computeBenchmarkMetrics } from './metrics';
import type { BenchmarkMetrics } from './metrics';
import type { EvolvingNoteStore } from '../store';
import { normalizeAnswer } from './metrics';

/** Adapter recall: bất kỳ memory system nào cũng đo được qua interface này. */
export interface MemoryRecallAdapter {
  /** Tên hệ thống đang đo (ghi vào report). */
  name: string;
  /** Trả id note theo thứ hạng cho một query (tối đa k). */
  recall(query: string, k: number): Promise<string[]> | string[];
  /** Trả nội dung note theo id (để trích đáp án). */
  getNoteText?(noteId: string): Promise<string | undefined> | string | undefined;
}

/** Adapter mặc định: EvolvingNoteStore.search (BM25 local). */
export function noteStoreAdapter(store: EvolvingNoteStore, name = 'evolving-notes-bm25'): MemoryRecallAdapter {
  return {
    name,
    recall(query: string, k: number): string[] {
      return store.search(query, { topK: k }).map((h) => h.note.id);
    },
    getNoteText(noteId: string): string | undefined {
      const note = store.getNote(noteId);
      return note ? `${note.title}. ${note.body}` : undefined;
    },
  };
}

/** Tuỳ chọn chạy benchmark. */
export interface RunBenchmarkOptions {
  /** Số kết quả recall lấy cho mỗi task (mặc định 10). */
  topK?: number;
  /** Xáo trộn thứ tự task bằng seed (mặc định: không xáo — giữ thứ tự sinh). */
  shuffleSeed?: number;
  /** Scope ingest/search (mặc định: user 'benchmark', bot 'benchmark'). */
  scope?: { userId: string; botId: string };
  /** Giới hạn số task chạy (mặc định: toàn bộ). */
  taskLimit?: number;
  /** Lọc chỉ chạy một loại task. */
  onlyKind?: BenchmarkTask['kind'];
}

/** Kết quả một lần chạy benchmark đầy đủ. */
export interface BenchmarkRunResult {
  suiteSeed: number;
  adapterName: string;
  ranAt: string;
  taskCount: number;
  metrics: BenchmarkMetrics;
  /** Kết quả từng task (để report chi tiết / debug). */
  perTask: TaskRecallResult[];
}

/**
 * Ingest documents của suite vào store. Document có `supersededBy`
 * được tạo trước rồi supersede bằng document mới — để kho có cả lịch
 * sử (bản cũ status superseded) như dữ liệu thật.
 */
export function ingestSuiteDocuments(
  store: EvolvingNoteStore,
  suite: BenchmarkSuite,
  scope: { userId: string; botId: string },
): Map<string, string> {
  const idMap = new Map<string, string>(); // suite noteId → store note id
  const byId = new Map(suite.documents.map((d) => [d.noteId, d]));
  // Ingest bản cũ trước (để supersede sau), bản mới sau.
  const ordered = [...suite.documents].sort((a, b) => {
    const aOld = a.supersededBy ? 0 : 1;
    const bOld = b.supersededBy ? 0 : 1;
    return aOld - bOld;
  });
  for (const doc of ordered) {
    const created = store.createNote({
      title: doc.title,
      body: doc.body,
      kind: doc.kind,
      tags: doc.tags,
      scope: { userId: scope.userId, botId: scope.botId, runId: 'benchmark' },
    });
    idMap.set(doc.noteId, created.id);
  }
  // Supersede: bản cũ → bản mới (note cũ giữ lại, status superseded).
  for (const doc of suite.documents) {
    if (!doc.supersededBy) continue;
    const oldStoreId = idMap.get(doc.noteId);
    const newDoc = byId.get(doc.supersededBy);
    const newStoreId = newDoc ? idMap.get(newDoc.noteId) : undefined;
    if (!oldStoreId || !newStoreId) continue;
    const oldNote = store.getNote(oldStoreId);
    const newNote = store.getNote(newStoreId);
    if (!oldNote || !newNote || oldNote.status !== 'active') continue;
    // Dùng API store trực tiếp: đóng bản cũ, nối supersededBy/supersedes.
    // (Không tạo note mới — bản mới đã ingest ở trên.)
    store.supersedeLinkOnly(oldStoreId, newStoreId);
  }
  return idMap;
}

/**
 * Trích đáp án từ note recall được: đáp án đúng khi `expectedAnswer`
 * (hoặc từng phần của nó, tách bằng ';') xuất hiện trong text note.
 * Trả về phần đáp án tìm thấy (chuẩn hoá để `answersMatch` chấm).
 */
export function extractAnswerFromNotes(
  expectedAnswer: string,
  noteTexts: Array<string | undefined>,
): string | undefined {
  const parts = expectedAnswer.split(';').map((p) => p.trim()).filter(Boolean);
  const found: string[] = [];
  for (const part of parts) {
    const needle = normalizeAnswer(part);
    if (!needle) continue;
    for (const text of noteTexts) {
      if (text && normalizeAnswer(text).includes(needle)) {
        found.push(part);
        break;
      }
    }
  }
  if (found.length === 0) return undefined;
  return found.join('; ');
}

/** Chạy benchmark trên một suite với một adapter. */
export async function runBenchmark(
  suite: BenchmarkSuite,
  adapter: MemoryRecallAdapter,
  opts: RunBenchmarkOptions = {},
): Promise<BenchmarkRunResult> {
  const topK = opts.topK ?? 10;
  let tasks = suite.tasks;
  if (opts.onlyKind) tasks = tasks.filter((t) => t.kind === opts.onlyKind);
  if (opts.shuffleSeed !== undefined) tasks = shuffleTasks(tasks, opts.shuffleSeed);
  if (opts.taskLimit !== undefined) tasks = tasks.slice(0, opts.taskLimit);

  const perTask: TaskRecallResult[] = [];
  for (const task of tasks) {
    const retrieved = await adapter.recall(task.question, topK);
    let extracted: string | undefined;
    if (adapter.getNoteText && retrieved.length > 0) {
      const texts: Array<string | undefined> = [];
      for (const id of retrieved.slice(0, 3)) {
        texts.push(await adapter.getNoteText(id));
      }
      extracted = extractAnswerFromNotes(task.expectedAnswer, texts);
    }
    perTask.push({
      taskId: task.id,
      kind: task.kind,
      retrievedNoteIds: retrieved,
      ...(extracted !== undefined ? { extractedAnswer: extracted } : {}),
    });
  }
  const metrics = computeBenchmarkMetrics(tasks, perTask);
  return {
    suiteSeed: suite.seed,
    adapterName: adapter.name,
    ranAt: new Date().toISOString(),
    taskCount: tasks.length,
    metrics,
    perTask,
  };
}

/**
 * Chạy benchmark end-to-end trên store: ingest suite → adapter mặc
 * định → chạy → trả kết quả (kèm map id để caller đối chiếu gold).
 * Store được truyền vào phải RỖNG (hoặc caller tự chịu trách nhiệm về
 * note cũ làm nhiễu recall — report ghi rõ store có sẵn bao nhiêu note).
 */
export async function runBenchmarkOnStore(
  suite: BenchmarkSuite,
  store: EvolvingNoteStore,
  opts: RunBenchmarkOptions & { adapterName?: string } = {},
): Promise<BenchmarkRunResult & { idMap: Map<string, string>; notesBefore: number }> {
  const scope = opts.scope ?? { userId: 'benchmark', botId: 'benchmark' };
  const notesBefore = store.listNotes({ status: 'all', limit: 10000 }).length;
  const idMap = ingestSuiteDocuments(store, suite, scope);
  // Map lại gold/distractor id của suite sang id thật trong store.
  const mappedSuite: BenchmarkSuite = {
    ...suite,
    tasks: suite.tasks.map((t) => ({
      ...t,
      goldNoteIds: t.goldNoteIds.map((id) => idMap.get(id) ?? id),
      distractorNoteIds: t.distractorNoteIds.map((id) => idMap.get(id) ?? id),
    })),
  };
  const adapter = noteStoreAdapter(store, opts.adapterName ?? 'evolving-notes-bm25');
  const result = await runBenchmark(mappedSuite, adapter, opts);
  return { ...result, idMap, notesBefore };
}
