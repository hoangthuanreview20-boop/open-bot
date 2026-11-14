/**
 * Parallel fan-out + rubric grading — v1.01 (Team T6).
 *
 * Lead agent chia việc cho nhiều subagent chạy song song, chấm từng
 * kết quả theo rubric, task chưa đạt được gửi sửa lại kèm feedback của
 * grader, tối đa N vòng. Module pure: runner thật do caller tiêm vào
 * (cùng kiểu `SpecializedSubagentRunner` của `agent/subagent.ts` nên
 * `AgentRunner` nối thẳng được); test dùng runner giả.
 *
 * Dùng lại `runSpecializedSubagent` (timeout + lỗi từng subagent không
 * kéo sập nhóm) thay vì viết executor mới — chỉ thêm 2 thứ chưa có:
 * giới hạn đồng thời (semaphore) và vòng chấm/sửa lại.
 */

import {
  runSpecializedSubagent,
  type SpecializedSubagentResult,
  type SpecializedSubagentRunner,
  type SpecializedSubagentTask,
} from '../agent/subagent';
import {
  gradeOutput,
  type GradeResult,
  type GraderFn,
  type Rubric,
} from './grader';

export const DEFAULT_FANOUT_CONCURRENCY = 4;
export const DEFAULT_FANOUT_MAX_ROUNDS = 3;

export interface FanOutTaskInput {
  /** Tên subagent (duy nhất trong một lần fan-out). */
  name: string;
  /** Việc giao cho subagent. */
  task: string;
  /**
   * Spec riêng (instructions/tool/model/timeout/role) — mọi field đều
   * tuỳ chọn; thiếu instructions + role thì dùng hướng dẫn mặc định.
   */
  spec?: Partial<Omit<import('../agent/subagent').SpecializedSubagentSpec, 'name'>>;
}

export interface FanOutOptions {
  /** Số subagent chạy cùng lúc tối đa. Mặc định 4. */
  concurrency?: number;
  /** Số vòng tối đa (vòng 1 = chạy lần đầu). Mặc định 3. */
  maxRounds?: number;
  /** Grader chấm kết quả (keyword hoặc LLM — xem grader.ts). */
  grader: GraderFn;
  /**
   * Callback theo dõi tiến độ (mỗi lần một task xong một vòng, hoặc
   * bắt đầu vòng sửa lại). Không set = không báo gì.
   */
  onEvent?: (event: FanOutEvent) => void;
}

export type FanOutEvent =
  | { type: 'round-start'; round: number; taskNames: string[] }
  | { type: 'task-graded'; round: number; name: string; grade: GradeResult; status: SpecializedSubagentResult['status'] }
  | { type: 'task-retry'; round: number; name: string; feedback: string }
  | { type: 'task-gave-up'; round: number; name: string; grade: GradeResult };

export interface FanOutTaskRound {
  round: number;
  output: string;
  status: SpecializedSubagentResult['status'];
  durationMs: number;
  error?: string;
  grade: GradeResult;
}

export interface FanOutTaskResult {
  name: string;
  /** true khi vòng cuối đạt rubric (hoặc task xong mà không cần chấm lại). */
  passed: boolean;
  roundsUsed: number;
  /** Kết quả vòng cuối (điểm + output của vòng đó). */
  final: FanOutTaskRound;
  /** Toàn bộ lịch sử các vòng (để UI/debug xem quá trình sửa lại). */
  history: FanOutTaskRound[];
}

export interface FanOutResult {
  rubricId: string;
  rubricName: string;
  totalRounds: number;
  passed: number;
  failed: number;
  tasks: FanOutTaskResult[];
  /** Tóm tắt text để đưa thẳng cho lead agent / user. */
  summary: string;
}

/**
 * Chạy một task qua runner, chấm output bằng grader. Runner lỗi/timeout
 * → grade rỗng (điểm 0 mọi tiêu chí) + feedback nêu rõ lỗi để vòng sau
 * sửa lại có căn cứ; không throw.
 */
async function runAndGradeOne(
  runner: SpecializedSubagentRunner,
  name: string,
  task: string,
  spec: FanOutTaskInput['spec'],
  rubric: Rubric,
  grader: GraderFn,
  round: number,
): Promise<FanOutTaskRound> {
  const result = await runSpecializedSubagent(runner, {
    spec: {
      name,
      // Không có instructions lẫn role thì dùng hướng dẫn mặc định —
      // nếu không validateSpecializedSpec sẽ throw và vỡ cả nhóm.
      instructions:
        spec?.instructions?.trim() || spec?.role
          ? (spec?.instructions ?? '')
          : 'Hoàn thành task được giao một cách chính xác, ngắn gọn, ghi rõ kết luận cuối cùng.',
      ...(spec?.tools !== undefined ? { tools: spec.tools } : {}),
      ...(spec?.model !== undefined ? { model: spec.model } : {}),
      ...(spec?.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec?.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
      ...(spec?.role !== undefined ? { role: spec.role } : {}),
      ...(spec?.shadowWorkspace === true ? { shadowWorkspace: true } : {}),
    },
    task,
  });
  if (result.status !== 'done') {
    // Lỗi/timeout: chấm 0 điểm với feedback nêu lỗi — vòng sau có cơ
    // hội chạy lại thay vì rớt ngay.
    const grade = await gradeOutput('', rubric, async (_output, resolved) =>
      resolved.criteria.map((c) => ({
        criterionId: c.id,
        score: 0,
        comment:
          result.status === 'timeout'
            ? `Subagent timeout sau ${result.durationMs}ms — chưa có output để chấm.`
            : `Subagent lỗi: ${result.error ?? 'không rõ lý do'} — chưa có output để chấm.`,
      })),
    );
    return {
      round,
      output: '',
      status: result.status,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
      grade,
    };
  }
  const grade = await gradeOutput(result.output, rubric, grader);
  return {
    round,
    output: result.output,
    status: result.status,
    durationMs: result.durationMs,
    grade,
  };
}

/** Chạy các hàm bất đồng bộ với giới hạn đồng thời, giữ đúng thứ tự kết quả. */
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<FanOutTaskRound>,
): Promise<FanOutTaskRound[]> {
  const results: FanOutTaskRound[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          results[index] = await fn(items[index] as T, index);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * Fan-out: chia việc cho nhiều subagent chạy song song, chấm từng kết
 * quả theo rubric, task chưa đạt gửi sửa lại kèm feedback (tối đa
 * `maxRounds` vòng). Trả về kết quả từng task + lịch sử từng vòng.
 *
 * - Task trùng tên → throw trước khi chạy (giữ đúng luật của
 *   `runSpecializedSubagentsParallel`).
 * - Một task lỗi/timeout ở vòng cuối vẫn có mặt trong kết quả với
 *   `passed: false` — không throw, không kéo sập nhóm.
 * - Feedback vòng sau = feedback của grader + output vòng trước đã cắt
 *   ngắn, để subagent biết mình sai ở đâu mà không nhận lại toàn bộ
 *   output cũ.
 */
export async function runFanOutWithGrading(
  runner: SpecializedSubagentRunner,
  tasks: FanOutTaskInput[],
  rubric: Rubric,
  opts: FanOutOptions,
): Promise<FanOutResult> {
  if (tasks.length === 0) {
    return {
      rubricId: rubric.id?.trim() || '',
      rubricName: rubric.name?.trim() || '',
      totalRounds: 0,
      passed: 0,
      failed: 0,
      tasks: [],
      summary: 'Không có task nào để fan-out.',
    };
  }
  const names = tasks.map((t) => t.name.trim());
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Tên subagent phải duy nhất khi fan-out — trùng: ${[...new Set(duplicates)].join(', ')}.`,
    );
  }
  const concurrency = opts.concurrency ?? DEFAULT_FANOUT_CONCURRENCY;
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`Fan-out cần concurrency > 0 (nhận ${String(opts.concurrency)}).`);
  }
  const maxRounds = opts.maxRounds ?? DEFAULT_FANOUT_MAX_ROUNDS;
  if (!Number.isFinite(maxRounds) || maxRounds <= 0) {
    throw new Error(`Fan-out cần maxRounds > 0 (nhận ${String(opts.maxRounds)}).`);
  }
  const emit = opts.onEvent ?? ((): void => undefined);

  // Trạng thái mỗi task: task text hiện tại (vòng sau nối thêm feedback).
  const states = tasks.map((t) => ({
    name: t.name.trim(),
    task: t.task,
    spec: t.spec,
    history: [] as FanOutTaskRound[],
    done: false,
  }));

  let totalRounds = 0;
  for (let round = 1; round <= Math.floor(maxRounds); round += 1) {
    const pending = states.filter((s) => !s.done);
    if (pending.length === 0) break;
    totalRounds = round;
    emit({ type: 'round-start', round, taskNames: pending.map((s) => s.name) });
    const rounds = await runWithConcurrency(pending, concurrency, async (state) => {
      const graded = await runAndGradeOne(
        runner,
        state.name,
        state.task,
        state.spec,
        rubric,
        opts.grader,
        round,
      );
      state.history.push(graded);
      emit({ type: 'task-graded', round, name: state.name, grade: graded.grade, status: graded.status });
      if (graded.grade.passed) {
        state.done = true;
      } else if (round < Math.floor(maxRounds)) {
        // Gửi sửa lại: task vòng sau = task gốc + feedback grader +
        // output vòng này (cắt ngắn) để subagent biết mình sai ở đâu.
        const previous = graded.output.length > 2_000
          ? graded.output.slice(0, 2_000) + '\n[... đã cắt ngắn ...]'
          : graded.output;
        state.task =
          `${tasks.find((t) => t.name.trim() === state.name)?.task ?? state.task}\n\n` +
          `[Phản hồi từ grader sau vòng ${round} — hãy sửa lại theo feedback này, đừng làm lại từ đầu nếu phần đúng đã có:]\n` +
          `${graded.grade.feedback}` +
          (previous.trim() ? `\n\n[Output vòng ${round} của bạn:]\n${previous}` : '');
        emit({ type: 'task-retry', round, name: state.name, feedback: graded.grade.feedback });
      } else {
        state.done = true;
        emit({ type: 'task-gave-up', round, name: state.name, grade: graded.grade });
      }
      return graded;
    });
    void rounds;
  }

  const results: FanOutTaskResult[] = states.map((s) => {
    const final = s.history[s.history.length - 1] as FanOutTaskRound;
    return {
      name: s.name,
      passed: final.grade.passed,
      roundsUsed: s.history.length,
      final,
      history: s.history,
    };
  });
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const lines: string[] = [
    `Fan-out ${results.length} task, rubric "${rubric.name?.trim() || rubric.id}": ${passed} đạt, ${failed} chưa đạt sau ${totalRounds} vòng.`,
    '',
  ];
  for (const r of results) {
    const g = r.final.grade;
    lines.push(
      `## ${r.name} — ${r.passed ? 'đạt' : 'CHƯA ĐẠT'} ` +
        `(${(g.ratio * 100).toFixed(0)}%, ${r.roundsUsed} vòng, ${r.final.status}, ${r.final.durationMs}ms)`,
    );
    if (r.final.output.trim()) {
      const out = r.final.output.length > 2_000
        ? r.final.output.slice(0, 2_000) + '\n[... đã cắt ngắn ...]'
        : r.final.output;
      lines.push(out);
    } else if (r.final.error) {
      lines.push(r.final.error);
    }
    if (!r.passed) lines.push(`Feedback cuối: ${g.feedback}`);
    lines.push('');
  }
  return {
    rubricId: rubric.id?.trim() || '',
    rubricName: rubric.name?.trim() || '',
    totalRounds,
    passed,
    failed,
    tasks: results,
    summary: lines.join('\n').trim(),
  };
}
