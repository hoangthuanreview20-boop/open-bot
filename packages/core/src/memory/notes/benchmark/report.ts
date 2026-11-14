/**
 * Report cho memory benchmark (v1.01, Đội T5).
 *
 * Xuất kết quả chạy thành JSON (máy đọc) + Markdown (người đọc, hiển
 * thị trong UI). Report ghi rõ:
 *  - suite seed, adapter, số task, thời gian chạy;
 *  - metrics tổng + theo loại task;
 *  - CẢNH BÁO phương pháp: benchmark synthetic tự tạo — đo recall của
 *    chính hệ thống trên dữ liệu mình sinh, KHÔNG phải chất lượng
 *    memory trên hội thoại thật, KHÔNG so được với số vendor.
 */

import type { BenchmarkSuite, BenchmarkTaskKind } from './generator';
import type { BenchmarkRunResult } from './runner';
import { recallFailures } from './metrics';
import type { MetricsSummary } from './metrics';

/** Report JSON đầy đủ (lưu file). */
export interface BenchmarkReportJson {
  generatedAt: string;
  suiteSeed: number;
  adapterName: string;
  ranAt: string;
  taskCount: number;
  taskCounts: Record<BenchmarkTaskKind, number>;
  metrics: BenchmarkRunResult['metrics'];
  /** Task fail recall@5 (tối đa 20) — để debug. */
  failures: Array<{
    taskId: string;
    kind: BenchmarkTaskKind;
    question: string;
    expectedAnswer: string;
    retrievedTopK: string[];
  }>;
  methodNote: string;
}

export const BENCHMARK_METHOD_NOTE =
  'Benchmark synthetic tự tạo (seeded PRNG, nội dung bịa hoàn toàn): đo recall/accuracy của chính hệ thống trên dữ liệu mình sinh. Không phải chất lượng memory trên hội thoại thật, không so được với số vendor.';

/** Build report JSON từ kết quả chạy + suite gốc. */
export function buildBenchmarkReportJson(
  result: BenchmarkRunResult,
  suite: BenchmarkSuite,
): BenchmarkReportJson {
  const byId = new Map(suite.tasks.map((t) => [t.id, t]));
  const failures = recallFailures(suite.tasks, result.perTask, 5)
    .slice(0, 20)
    .map(({ task, retrievedTopK }) => ({
      taskId: task.id,
      kind: task.kind,
      question: task.question,
      expectedAnswer: task.expectedAnswer,
      retrievedTopK,
    }));
  void byId;
  return {
    generatedAt: new Date().toISOString(),
    suiteSeed: result.suiteSeed,
    adapterName: result.adapterName,
    ranAt: result.ranAt,
    taskCount: result.taskCount,
    taskCounts: suite.taskCounts,
    metrics: result.metrics,
    failures,
    methodNote: BENCHMARK_METHOD_NOTE,
  };
}

function metricsRow(label: string, m: MetricsSummary): string {
  return `| ${label} | ${m.taskCount} | ${m.recallAt1} | ${m.recallAt3} | ${m.recallAt5} | ${m.recallAt10} | ${m.precisionAt5} | ${m.mrr} | ${m.accuracy} |`;
}

/** Build report Markdown từ kết quả chạy + suite gốc. */
export function buildBenchmarkReportMarkdown(
  result: BenchmarkRunResult,
  suite: BenchmarkSuite,
): string {
  const { overall, byKind } = result.metrics;
  const lines: string[] = [
    '# Memory Benchmark Report — Evolving Notes',
    '',
    `- Adapter: \`${result.adapterName}\``,
    `- Suite seed: \`${result.suiteSeed}\` (dữ liệu synthetic tự tạo, chạy lại cho cùng kết quả)`,
    `- Thời gian chạy: ${result.ranAt}`,
    `- Số task: ${result.taskCount} (single-hop ${suite.taskCounts['single-hop']}, multi-hop ${suite.taskCounts['multi-hop']}, temporal ${suite.taskCounts.temporal}, distractor ${suite.taskCounts.distractor})`,
    '',
    '## Metrics tổng',
    '',
    '| Nhóm | Task | R@1 | R@3 | R@5 | R@10 | P@5 | MRR | Accuracy |',
    '|---|---|---|---|---|---|---|---|---|',
    metricsRow('Tổng', overall),
    metricsRow('single-hop', byKind['single-hop']),
    metricsRow('multi-hop', byKind['multi-hop']),
    metricsRow('temporal', byKind.temporal),
    metricsRow('distractor', byKind.distractor),
    '',
    `- Accuracy (Wilson 95%): [${overall.accuracyWilson95[0]}, ${overall.accuracyWilson95[1]}]`,
    `- Task distractor lọt top-3: ${overall.distractorInTop3} (càng thấp càng tốt)`,
    `- Task temporal mà bản cũ lọt top-3: ${overall.staleInTop3} (càng thấp càng tốt)`,
    '',
    '## Cách đọc',
    '',
    '- **R@k**: tỉ lệ task mà ít nhất 1 gold note nằm trong top-k recall.',
    '- **Accuracy**: tỉ lệ task mà đáp án trích được từ note recall khớp đáp án đúng.',
    '- **temporal thấp** = hệ thống hay trả bản cũ đã bị supersede; **distractor cao** = hay bị note gần giống lừa.',
    '',
    `> ${BENCHMARK_METHOD_NOTE}`,
  ];
  const failures = recallFailures(suite.tasks, result.perTask, 5).slice(0, 10);
  if (failures.length > 0) {
    lines.push('', '## Task fail R@5 (tối đa 10)', '');
    for (const { task } of failures) {
      lines.push(`- [${task.kind}] ${task.question} — đáp án đúng: ${task.expectedAnswer}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
