/**
 * Subagent chuyên biệt hoá — v0.12 mục 3.
 *
 * Mở rộng cơ chế subagent hiện có (AgentRunner.runSubagent trong loop.ts:
 * cùng provider, cùng tool, cùng bot) theo hướng chuyên biệt hoá:
 * mỗi subagent nhận instructions riêng, tool list riêng (subset), model
 * riêng và timeout riêng; nhiều subagent chạy song song rồi gộp kết quả.
 *
 * Module này là tầng pure + helper, KHÔNG sửa loop.ts/coordinator.ts:
 * - Định nghĩa spec + validate + lọc tool subset + dựng system prompt.
 * - Chạy song song qua một `runner` do caller tiêm vào (hàm chạy một
 *   subagent với spec cho trước) — điều phối viên sẽ nối runner này với
 *   AgentRunner thật (tạo runner con với model/tool/instructions của spec).
 * - Gộp kết quả: nối theo thứ tự spec + tóm tắt xung đột nếu có.
 *
 * Vì vậy module này không import loop.ts (tránh cycle) và không gọi
 * provider trực tiếp — mọi test dùng runner giả (mock).
 */

export interface SpecializedSubagentSpec {
  /** Tên hiển thị, vd "researcher" — dùng làm tiêu đề khi gộp kết quả. */
  name: string;
  /** Instructions riêng của subagent này (đưa vào system prompt của nó). */
  instructions: string;
  /** Tool được phép dùng (subset theo tên); trống/undefined = toàn bộ tool của runner. */
  tools?: string[];
  /** Model riêng; trống/undefined = model của bot cha. */
  model?: string;
  /** Timeout riêng cho subagent này (ms); mặc định 120_000. */
  timeoutMs?: number;
  /** Số bước tối đa của subagent; mặc định để runner tự quyết. */
  maxSteps?: number;
  /**
   * v0.37 (P1-4): role subagent chuyên biệt (xem `subagents/roles.ts`),
   * vd `researcher` — chạy qua `runSubagent({ role })` thì role quyết
   * system prompt + tool allowlist + giới hạn; `instructions`/`tools`/
   * `model`/`maxSteps`/`timeoutMs` ở đây (nếu có) thắng giá trị role.
   */
  role?: string;
  /** v0.14: true = chạy trong git worktree riêng (shadow workspace). */
  shadowWorkspace?: boolean;
}

export type SpecializedSubagentStatus = 'done' | 'error' | 'timeout';

export interface SpecializedSubagentResult {
  name: string;
  status: SpecializedSubagentStatus;
  /** Kết quả text của subagent (đã cắt ngắn khi gộp). */
  output: string;
  /** Thời gian chạy (ms). */
  durationMs: number;
  /** Lỗi, chỉ có khi status = 'error' hoặc 'timeout'. */
  error?: string;
  /**
   * Kết luận có cấu trúc của subagent (nếu runner trả về), vd "đồng ý" /
   * "từ chối" — dùng để phát hiện xung đột chắc chắn hơn so khớp text.
   */
  verdict?: string;
}

export interface SpecializedSubagentTask {
  spec: SpecializedSubagentSpec;
  /** Việc giao cho subagent này. */
  task: string;
}

/**
 * Hàm chạy một subagent chuyên biệt — do caller tiêm vào. Điều phối viên
 * sẽ nối nó với AgentRunner thật: tạo runner con với `input.spec.model`,
 * tool subset `input.spec.tools`, system prompt từ
 * `buildSubagentSystemPrompt()`, rồi `run(input.task)`.
 */
export type SpecializedSubagentRunner = (input: {
  spec: SpecializedSubagentSpec;
  task: string;
}) => Promise<SpecializedSubagentResult | string>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
export const MAX_PARALLEL_SUBAGENT_OUTPUT_CHARS = 20_000;

/** Cặp cụm từ đối lập dùng để phát hiện xung đột dạng text (heuristic, xem mergeParallelResults). */
export const DEFAULT_CONFLICT_MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['đồng ý', 'không đồng ý'],
  ['nên làm', 'không nên làm'],
  ['chấp nhận', 'từ chối'],
  ['đạt', 'không đạt'],
  ['pass', 'fail'],
];

// ---------------------------------------------------------------------------
// Validate + lọc tool
// ---------------------------------------------------------------------------

/** Kiểm tra spec hợp lệ; ném lỗi tiếng Việt rõ ràng khi sai. */
export function validateSpecializedSpec(spec: SpecializedSubagentSpec): SpecializedSubagentSpec {
  const name = spec.name.trim();
  if (!name) throw new Error('Subagent chuyên biệt cần tên (name) không rỗng.');
  const instructions = spec.instructions.trim();
  const role = spec.role?.trim() ? spec.role.trim() : undefined;
  // v0.37 (P1-4): spec có role thì instructions được phép rỗng — role
  // tự mang systemPrompt, runSubagent resolve sau (không fallback lặng).
  if (!instructions && !role) {
    throw new Error(`Subagent "${name}" cần instructions riêng không rỗng (hoặc role).`);
  }
  const timeoutMs = spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Subagent "${name}" cần timeoutMs > 0 (nhận ${String(spec.timeoutMs)}).`);
  }
  if (spec.maxSteps !== undefined && (!Number.isFinite(spec.maxSteps) || spec.maxSteps <= 0)) {
    throw new Error(`Subagent "${name}" cần maxSteps > 0 (nhận ${String(spec.maxSteps)}).`);
  }
  const tools = spec.tools
    ? [...new Set(spec.tools.map((t) => t.trim()).filter((t) => t.length > 0))]
    : undefined;
  return {
    name,
    instructions,
    ...(tools !== undefined ? { tools } : {}),
    ...(spec.model?.trim() ? { model: spec.model.trim() } : {}),
    ...(role !== undefined ? { role } : {}),
    timeoutMs: Math.floor(timeoutMs),
    ...(spec.maxSteps !== undefined ? { maxSteps: Math.floor(spec.maxSteps) } : {}),
    ...(spec.shadowWorkspace === true ? { shadowWorkspace: true } : {}),
  };
}

/**
 * Lọc danh sách tool đầy đủ về subset mà spec cho phép (giữ đúng thứ tự
 * gốc). Trả về cả tên tool không tìm thấy để caller báo rõ thay vì im lặng.
 */
export function filterToolsForSubagent<T extends { definition: { name: string } }>(
  allTools: readonly T[],
  spec: SpecializedSubagentSpec,
): { tools: T[]; missing: string[] } {
  const allowed = spec.tools;
  if (!allowed || allowed.length === 0) return { tools: [...allTools], missing: [] };
  const byName = new Map(allTools.map((t) => [t.definition.name, t]));
  const tools: T[] = [];
  const missing: string[] = [];
  for (const name of allowed) {
    const tool = byName.get(name);
    if (tool) tools.push(tool);
    else missing.push(name);
  }
  return { tools, missing };
}

/**
 * Dựng system prompt cho subagent chuyên biệt: system prompt gốc của bot
 * cha (nếu có) + instructions riêng + danh sách tool được phép + ghi chú
 * về model/timeout. Bot cha chỉ cần truyền `basePrompt` là system prompt
 * hiện tại của nó.
 */
export function buildSubagentSystemPrompt(
  spec: SpecializedSubagentSpec,
  basePrompt = '',
): string {
  const clean = validateSpecializedSpec(spec);
  const parts: string[] = [];
  if (basePrompt.trim()) parts.push(basePrompt.trim());
  parts.push(
    `[subagent chuyên biệt: ${clean.name}]`,
    `Nhiệm vụ riêng của bạn: ${clean.instructions}`,
    `Bạn là subagent chuyên biệt — chỉ làm đúng nhiệm vụ trên, trả kết quả ngắn gọn, ` +
      `ghi rõ kết luận cuối cùng của bạn.`,
  );
  if (clean.tools && clean.tools.length > 0) {
    parts.push(`Bạn chỉ được dùng các tool sau: ${clean.tools.join(', ')}.`);
  }
  if (clean.model) parts.push(`Model của bạn: ${clean.model}.`);
  parts.push(`Thời gian tối đa cho nhiệm vụ này: ${clean.timeoutMs}ms — hết giờ sẽ bị dừng.`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Chạy song song
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... đã cắt ngắn còn ${maxChars} ký tự ...]`;
}

function normalizeRunnerOutput(
  name: string,
  startedAt: number,
  value: SpecializedSubagentResult | string,
): SpecializedSubagentResult {
  const durationMs = Date.now() - startedAt;
  if (typeof value === 'string') {
    return { name, status: 'done', output: value, durationMs };
  }
  return { ...value, name, durationMs: value.durationMs ?? durationMs };
}

/**
 * Chạy một subagent chuyên biệt qua runner đã tiêm, với timeout riêng
 * của spec (race với timer — runner không tự timeout thì timer vẫn chặn).
 * Timeout / lỗi của runner được chuyển thành result status tương ứng,
 * không throw — để chạy song song không bị một subagent hỏng kéo sập cả nhóm.
 */
export async function runSpecializedSubagent(
  runner: SpecializedSubagentRunner,
  task: SpecializedSubagentTask,
): Promise<SpecializedSubagentResult> {
  const spec = validateSpecializedSpec(task.spec);
  const startedAt = Date.now();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      runner({ spec, task: task.task }).then(
        (value) => ({ kind: 'done' as const, value }),
        (err: unknown) => ({ kind: 'error' as const, error: err }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs);
      }),
    ]);
    if (outcome.kind === 'timeout') {
      return {
        name: spec.name,
        status: 'timeout',
        output: '',
        durationMs: Date.now() - startedAt,
        error: `Subagent "${spec.name}" timeout sau ${timeoutMs}ms — đã dừng, kết quả chưa hoàn tất.`,
      };
    }
    if (outcome.kind === 'error') {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return {
        name: spec.name,
        status: 'error',
        output: '',
        durationMs: Date.now() - startedAt,
        error: `Subagent "${spec.name}" lỗi: ${message}`,
      };
    }
    return normalizeRunnerOutput(spec.name, startedAt, outcome.value);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Chạy nhiều subagent song song (Promise.all — tất cả bắt đầu cùng lúc),
 * mỗi cái với spec riêng. Kết quả trả về đúng thứ tự tasks đã đưa vào,
 * kể cả khi có subagent lỗi/timeout (không throw).
 */
export async function runSpecializedSubagentsParallel(
  runner: SpecializedSubagentRunner,
  tasks: SpecializedSubagentTask[],
): Promise<SpecializedSubagentResult[]> {
  if (tasks.length === 0) return [];
  const names = tasks.map((t) => t.spec.name.trim());
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Tên subagent phải duy nhất khi chạy song song — trùng: ${[...new Set(duplicates)].join(', ')}.`,
    );
  }
  return Promise.all(tasks.map((task) => runSpecializedSubagent(runner, task)));
}

// ---------------------------------------------------------------------------
// Phát hiện xung đột + gộp kết quả
// ---------------------------------------------------------------------------

export interface DetectedConflict {
  /** Mô tả xung đột, vd 'verdict khác nhau: "đồng ý" vs "từ chối"'. */
  description: string;
  /** Tên các subagent mâu thuẫn nhau. */
  subagents: string[];
}

/**
 * Phát hiện xung đột giữa các kết quả:
 * 1. verdict có cấu trúc khác nhau (chắc chắn nhất — cần runner trả verdict).
 * 2. Text chứa cặp marker đối lập ở 2 subagent khác nhau (heuristic mặc
 *    định, có thể tắt bằng cách truyền `conflictMarkerPairs: []`).
 * Trả về [] khi không thấy xung đột — không có xung đột không có nghĩa
 * là các kết quả đồng nhất, chỉ là không phát hiện được mâu thuẫn rõ ràng.
 */
export function detectConflicts(
  results: SpecializedSubagentResult[],
  opts: { conflictMarkerPairs?: ReadonlyArray<readonly [string, string]> } = {},
): DetectedConflict[] {
  const conflicts: DetectedConflict[] = [];
  const done = results.filter((r) => r.status === 'done');
  // 1. Verdict khác nhau.
  const verdicts = new Map<string, string[]>();
  for (const r of done) {
    if (!r.verdict?.trim()) continue;
    const key = r.verdict.trim().toLowerCase();
    const names = verdicts.get(key) ?? [];
    names.push(r.name);
    verdicts.set(key, names);
  }
  if (verdicts.size > 1) {
    const parts = [...verdicts.entries()].map(([v, names]) => `"${v}" (${names.join(', ')})`);
    conflicts.push({
      description: `Kết luận khác nhau: ${parts.join(' vs ')} — cần bot cha xem xét và quyết định.`,
      subagents: [...verdicts.values()].flat(),
    });
  }
  // 2. Marker đối lập trong text.
  const pairs = opts.conflictMarkerPairs ?? DEFAULT_CONFLICT_MARKER_PAIRS;
  for (const [a, b] of pairs) {
    const withA = done.filter((r) => r.output.toLowerCase().includes(a.toLowerCase()));
    const withB = done.filter((r) => r.output.toLowerCase().includes(b.toLowerCase()));
    const namesA = withA.map((r) => r.name);
    const namesB = withB.map((r) => r.name);
    const clash = namesA.some((n) => !namesB.includes(n)) && namesB.length > 0 && namesA.length > 0;
    if (clash) {
      conflicts.push({
        description:
          `Mâu thuẫn dạng text: "${a}" xuất hiện ở ${namesA.join(', ')} nhưng "${b}" xuất hiện ở ${namesB.join(', ')}.`,
        subagents: [...new Set([...namesA, ...namesB])],
      });
    }
  }
  return conflicts;
}

export interface MergedParallelResult {
  /** Toàn bộ kết quả đã gộp (đưa thẳng cho bot cha / user). */
  text: string;
  /** Số subagent xong / lỗi / timeout. */
  counts: { done: number; error: number; timeout: number; total: number };
  conflicts: DetectedConflict[];
}

/**
 * Gộp kết quả chạy song song: nối theo đúng thứ tự spec, mỗi subagent
 * một mục có tiêu đề + trạng thái; cuối cùng là mục xung đột (nếu có)
 * để bot cha biết cần phân xử. Output mỗi subagent cắt ngắn ở 20.000 ký tự.
 */
export function mergeParallelResults(
  results: SpecializedSubagentResult[],
  opts: { conflictMarkerPairs?: ReadonlyArray<readonly [string, string]> } = {},
): MergedParallelResult {
  const counts = {
    done: results.filter((r) => r.status === 'done').length,
    error: results.filter((r) => r.status === 'error').length,
    timeout: results.filter((r) => r.status === 'timeout').length,
    total: results.length,
  };
  const conflicts = detectConflicts(results, opts);
  const lines: string[] = [
    `Kết quả ${counts.total} subagent chạy song song: ${counts.done} xong, ${counts.error} lỗi, ${counts.timeout} timeout.`,
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.name} (${r.status}, ${r.durationMs}ms)`);
    if (r.status === 'done') {
      lines.push(truncate(r.output, MAX_PARALLEL_SUBAGENT_OUTPUT_CHARS));
      if (r.verdict?.trim()) lines.push(`Kết luận: ${r.verdict.trim()}`);
    } else {
      lines.push(r.error ?? `Subagent "${r.name}" không hoàn tất (trạng thái: ${r.status}).`);
    }
    lines.push('');
  }
  if (conflicts.length > 0) {
    lines.push('## Xung đột cần phân xử');
    for (const c of conflicts) lines.push(`- ${c.description}`);
    lines.push(
      'Bot cha cần xem xét các kết quả trên và quyết định cuối cùng — không tự động chọn một bên.',
    );
  } else if (counts.done > 1) {
    lines.push('Không phát hiện xung đột giữa các kết quả.');
  }
  return { text: lines.join('\n').trim(), counts, conflicts };
}
