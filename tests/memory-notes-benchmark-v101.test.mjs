/**
 * Tests for v1.01 (Đội T5) — benchmark harness + tools:
 * packages/core/src/memory/notes/benchmark/*.ts và
 * packages/tools/src/memoryNotesTools.ts.
 *
 * Bao phủ: generator (seeded — cùng seed cho cùng suite; 6 task/persona;
 * temporal có supersededBy; distractor có note gây nhiễu), metrics
 * (R@k / P@k / MRR / accuracy / Wilson / answersMatch), runner
 * (ingest + supersede link, recall BM25, end-to-end trên store in-memory,
 * temporal đo được bản mới), report (JSON + Markdown), tools factory
 * (12 tool, tên đúng, approval đúng, CRUD/search/revisit/benchmark chạy
 * được qua execute).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-notes-benchmark-v101.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EvolvingNoteStore,
  generateBenchmarkSuite,
  shuffleTasks,
  seededRandom,
  computeBenchmarkMetrics,
  computeMetrics,
  answersMatch,
  wilsonInterval,
  runBenchmark,
  runBenchmarkOnStore,
  ingestSuiteDocuments,
  noteStoreAdapter,
  buildBenchmarkReportJson,
  buildBenchmarkReportMarkdown,
  BENCHMARK_METHOD_NOTE,
} from '../packages/core/dist/memory/notes/index.js';
import {
  createMemoryNotesTools,
  MEMORY_NOTES_TOOL_NAMES,
} from '../packages/tools/dist/memoryNotesTools.js';

const SCOPE = { userId: 'benchmark', botId: 'benchmark', runId: 'benchmark' };

// ------------------------------------------------------------------ generator

test('seededRandom: cùng seed cho cùng dãy', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [seededRandom(43)(), seededRandom(43)(), seededRandom(43)(), seededRandom(43)(), seededRandom(43)()]);
});

test('generateBenchmarkSuite: cùng seed → cùng suite; 6 task/persona', () => {
  const s1 = generateBenchmarkSuite({ seed: 10101, personas: 10 });
  const s2 = generateBenchmarkSuite({ seed: 10101, personas: 10 });
  // generatedAt là thời gian chạy (khác nhau vài ms) — so sánh trừ field này.
  const { generatedAt: _g1, ...rest1 } = s1;
  const { generatedAt: _g2, ...rest2 } = s2;
  void _g1;
  void _g2;
  assert.deepEqual(rest1, rest2);
  assert.equal(s1.tasks.length, 60);
  assert.deepEqual(s1.taskCounts, { 'single-hop': 20, 'multi-hop': 20, temporal: 10, distractor: 10 });
  assert.ok(s1.documents.length >= 60);
  const s3 = generateBenchmarkSuite({ seed: 999, personas: 10 });
  assert.notDeepEqual(s1.tasks, s3.tasks);
});

test('generateBenchmarkSuite: temporal có supersededBy, distractor có note gây nhiễu', () => {
  const suite = generateBenchmarkSuite({ seed: 7, personas: 3 });
  const temporal = suite.tasks.find((t) => t.kind === 'temporal');
  assert.ok(temporal);
  assert.equal(temporal.distractorNoteIds.length, 1);
  const oldDoc = suite.documents.find((d) => d.noteId === temporal.distractorNoteIds[0]);
  assert.ok(oldDoc.supersededBy);
  assert.equal(oldDoc.supersededBy, temporal.goldNoteIds[0]);
  const distractor = suite.tasks.find((t) => t.kind === 'distractor');
  assert.ok(distractor.distractorNoteIds.length >= 1);
  // gold + distractor đều có trong documents.
  const docIds = new Set(suite.documents.map((d) => d.noteId));
  for (const task of suite.tasks) {
    for (const id of [...task.goldNoteIds, ...task.distractorNoteIds]) {
      assert.ok(docIds.has(id), `task ${task.id} trỏ tới document không tồn tại: ${id}`);
    }
    assert.ok(task.expectedAnswer.length > 0);
    assert.ok(task.question.length > 0);
  }
});

test('shuffleTasks: cùng seed cho cùng thứ tự, khác seed khác thứ tự', () => {
  const suite = generateBenchmarkSuite({ seed: 5, personas: 4 });
  const a = shuffleTasks(suite.tasks, 1);
  const b = shuffleTasks(suite.tasks, 1);
  const c = shuffleTasks(suite.tasks, 2);
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
  assert.notDeepEqual(a.map((t) => t.id), c.map((t) => t.id));
  assert.deepEqual(new Set(a.map((t) => t.id)), new Set(suite.tasks.map((t) => t.id)));
});

// ------------------------------------------------------------------ metrics

test('answersMatch: chuẩn hoá bỏ dấu, multi-hop cần đủ phần', () => {
  assert.ok(answersMatch('phở bò', 'Tôi thích ăn phở bò.'));
  assert.ok(answersMatch('pho bo', 'Phở bò'));
  assert.ok(answersMatch('mèo; chạy bộ', 'Tôi nuôi mèo và thích chạy bộ.'));
  assert.ok(!answersMatch('mèo; chạy bộ', 'Tôi nuôi mèo.'));
  assert.ok(!answersMatch('Hà Nội', 'Tôi sống ở Sài Gòn.'));
  assert.ok(!answersMatch('Hà Nội', undefined));
});

test('wilsonInterval: khoảng hợp lệ, thu hẹp khi n lớn', () => {
  const [lo1, hi1] = wilsonInterval(9, 10);
  const [lo2, hi2] = wilsonInterval(90, 100);
  assert.ok(lo1 >= 0 && hi1 <= 1 && lo1 < hi1);
  assert.ok(hi2 - lo2 < hi1 - lo1);
  assert.deepEqual(wilsonInterval(0, 0), [0, 0]);
});

test('computeMetrics: R@k / MRR / accuracy trên kết quả giả', () => {
  const tasks = [
    { id: 't1', kind: 'single-hop', goldNoteIds: ['g1'], distractorNoteIds: [], expectedAnswer: 'a', question: 'q', language: 'vi' },
    { id: 't2', kind: 'single-hop', goldNoteIds: ['g2'], distractorNoteIds: [], expectedAnswer: 'b', question: 'q', language: 'vi' },
    { id: 't3', kind: 'temporal', goldNoteIds: ['g3'], distractorNoteIds: ['old3'], expectedAnswer: 'c', question: 'q', language: 'vi' },
  ];
  const results = [
    { taskId: 't1', kind: 'single-hop', retrievedNoteIds: ['g1', 'x'], extractedAnswer: 'a' },
    { taskId: 't2', kind: 'single-hop', retrievedNoteIds: ['x', 'y', 'g2'], extractedAnswer: 'b' },
    { taskId: 't3', kind: 'temporal', retrievedNoteIds: ['old3', 'x'] }, // không trích được đáp án từ note cũ
  ];
  const m = computeMetrics(tasks, results);
  assert.equal(m.taskCount, 3);
  assert.equal(m.recallAt1, 0.3333); // làm tròn 4 chữ số thập phân
  assert.equal(m.recallAt3, 0.6667);
  assert.equal(m.accuracy, 0.6667); // làm tròn 4 chữ số thập phân
  assert.ok(Math.abs(m.mrr - (1 + 1 / 3 + 0) / 3) < 0.0001);
  assert.equal(m.staleInTop3, 1);
  const full = computeBenchmarkMetrics(tasks, results);
  assert.equal(full.byKind['single-hop'].recallAt1, 0.5);
  assert.equal(full.byKind.temporal.recallAt5, 0);
});

// ------------------------------------------------------------------ runner

test('ingestSuiteDocuments: ingest đủ document, bản cũ superseded', () => {
  const suite = generateBenchmarkSuite({ seed: 11, personas: 2 });
  const store = EvolvingNoteStore.inMemory();
  const idMap = ingestSuiteDocuments(store, suite, SCOPE);
  assert.equal(idMap.size, suite.documents.length);
  const stats = store.stats(SCOPE);
  assert.equal(stats.total, suite.documents.length);
  // Mỗi persona có 1 bản cũ bị supersede.
  assert.equal(stats.superseded, 2);
  assert.equal(stats.active, suite.documents.length - 2);
});

test('runBenchmarkOnStore end-to-end: R@k cao trên dữ liệu synthetic của chính mình', async () => {
  const suite = generateBenchmarkSuite({ seed: 10101, personas: 10 });
  const store = EvolvingNoteStore.inMemory();
  const result = await runBenchmarkOnStore(suite, store, { topK: 10 });
  assert.equal(result.taskCount, 60);
  assert.equal(result.adapterName, 'evolving-notes-bm25');
  assert.equal(result.notesBefore, 0);
  // BM25 local phải recall tốt trên dữ liệu synthetic (câu hỏi chứa từ khoá gold).
  assert.ok(result.metrics.overall.recallAt5 >= 0.8, `R@5=${result.metrics.overall.recallAt5} quá thấp`);
  assert.ok(result.metrics.overall.recallAt10 >= result.metrics.overall.recallAt5);
  assert.ok(result.metrics.overall.accuracy >= 0.7, `accuracy=${result.metrics.overall.accuracy} quá thấp`);
  assert.ok(result.metrics.byKind['single-hop'].recallAt3 >= 0.8);
});

test('runBenchmarkOnStore: temporal — bản mới phải thắng bản cũ ở R@1 phần lớn', async () => {
  const suite = generateBenchmarkSuite({ seed: 10101, personas: 10 });
  const store = EvolvingNoteStore.inMemory();
  const result = await runBenchmarkOnStore(suite, store, { topK: 10, onlyKind: 'temporal' });
  assert.equal(result.taskCount, 10);
  // Bản mới có câu "hiện tại / đã chuyển tới" + trùng tên thành phố với câu hỏi "hiện tại".
  assert.ok(result.metrics.overall.recallAt1 >= 0.5, `temporal R@1=${result.metrics.overall.recallAt1}`);
  assert.ok(result.metrics.overall.recallAt5 >= 0.9, `temporal R@5=${result.metrics.overall.recallAt5}`);
});

test('runBenchmark với adapter giả: đo được adapter yếu', async () => {
  const suite = generateBenchmarkSuite({ seed: 3, personas: 2 });
  const badAdapter = {
    name: 'empty-adapter',
    recall: () => [],
  };
  const result = await runBenchmark(suite, badAdapter, { topK: 10 });
  assert.equal(result.metrics.overall.recallAt10, 0);
  assert.equal(result.metrics.overall.accuracy, 0);
  assert.equal(result.metrics.overall.mrr, 0);
});

test('noteStoreAdapter: recall trả id theo thứ hạng BM25', () => {
  const store = EvolvingNoteStore.inMemory();
  const note = store.createNote({ title: 'Phở bò', body: 'Tôi thích phở bò.', scope: SCOPE });
  const adapter = noteStoreAdapter(store);
  assert.equal(adapter.name, 'evolving-notes-bm25');
  const ids = adapter.recall('phở bò', 5);
  assert.ok(ids.includes(note.id));
  assert.ok(adapter.getNoteText(note.id).includes('phở bò'));
});

// ------------------------------------------------------------------ report

test('buildBenchmarkReportJson + Markdown: đầy đủ số, ghi rõ phương pháp', async () => {
  const suite = generateBenchmarkSuite({ seed: 10101, personas: 2 });
  const store = EvolvingNoteStore.inMemory();
  const result = await runBenchmarkOnStore(suite, store, { topK: 5 });
  const json = buildBenchmarkReportJson(result, suite);
  assert.equal(json.suiteSeed, 10101);
  assert.equal(json.taskCount, 12);
  assert.ok(json.methodNote.includes('synthetic'));
  assert.ok(json.metrics.overall.recallAt5 >= 0);
  const md = buildBenchmarkReportMarkdown(result, suite);
  assert.ok(md.includes('# Memory Benchmark Report'));
  assert.ok(md.includes('R@5'));
  assert.ok(md.includes(BENCHMARK_METHOD_NOTE.slice(0, 40)));
});

// ------------------------------------------------------------------ tools

test('MEMORY_NOTES_TOOL_NAMES: đủ 12 tool', () => {
  assert.equal(MEMORY_NOTES_TOOL_NAMES.length, 12);
  assert.ok(MEMORY_NOTES_TOOL_NAMES.includes('notes_benchmark_run'));
  assert.ok(MEMORY_NOTES_TOOL_NAMES.includes('notes_revisit'));
});

test('createMemoryNotesTools: CRUD + search + revisit + benchmark qua execute', async () => {
  const store = EvolvingNoteStore.inMemory();
  const tools = createMemoryNotesTools({ notesStore: store });
  assert.equal(tools.length, 12);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  // Approval: ghi cần duyệt, đọc không.
  assert.equal(byName.get('notes_create').needsApproval, true);
  assert.equal(byName.get('notes_update').needsApproval, true);
  assert.equal(byName.get('notes_search').needsApproval, false);
  assert.equal(byName.get('notes_benchmark_run').needsApproval, false);

  const ctx = { workspaceDir: '/tmp', botId: 'bot-a', runId: 'run-1' };
  const createdRaw = await byName.get('notes_create').execute({ title: 'Phở bò', body: 'Tôi thích phở bò ở Hà Nội.', kind: 'preference', tags: ['an-uong'] }, ctx);
  const created = JSON.parse(createdRaw);
  assert.ok(created.note.id);
  assert.equal(store.listNotes({}).length, 1);

  const searchedRaw = await byName.get('notes_search').execute({ query: 'phở bò' }, ctx);
  const searched = JSON.parse(searchedRaw);
  assert.equal(searched.hits[0].id, created.note.id);

  const revisitedRaw = await byName.get('notes_revisit').execute({ noteId: created.note.id, newText: 'Tôi không còn thích phở bò nữa.', mode: 'analyze' }, ctx);
  const revisited = JSON.parse(revisitedRaw);
  assert.equal(revisited.analysis.decision, 'contradiction');

  const graphRaw = await byName.get('notes_graph').execute({ format: 'json' }, ctx);
  const graph = JSON.parse(graphRaw);
  assert.equal(graph.nodeCount, 1);

  const benchRaw = await byName.get('notes_benchmark_run').execute({ seed: 10101, personas: 2, topK: 5 }, ctx);
  const bench = JSON.parse(benchRaw);
  assert.equal(bench.taskCount, 12);
  assert.ok(bench.metrics.overall.recallAt5 >= 0.5);
  // Benchmark chạy trên store in-memory riêng — kho thật không bị đụng.
  assert.equal(store.listNotes({ status: 'all', limit: 10000 }).length, 1);
});

test('createMemoryNotesTools không có store thì trả Error, không throw', async () => {
  const tools = createMemoryNotesTools();
  const ctx = { workspaceDir: '/tmp', botId: 'bot-a' };
  const out = await tools.find((t) => t.definition.name === 'notes_search').execute({ query: 'x' }, ctx);
  assert.ok(out.startsWith('Error:'));
});
