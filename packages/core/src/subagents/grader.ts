/**
 * Rubric grader — v1.01 (Team T6).
 *
 * Chấm kết quả của một subagent theo rubric (tiêu chí + trọng số).
 * Module pure: grader là hàm do caller tiêm vào, nên chấm được bằng
 * keyword xác định (test/CI, không cần LLM) hoặc bằng model (LLM
 * grader trả JSON). Không gọi provider trực tiếp, không import loop.
 *
 * Điểm = tổng có trọng số (score/maxScore * weight), chuẩn hoá về
 * ratio 0..1; `passed = ratio >= passThreshold`.
 */

export interface RubricCriterion {
  /** Id ổn định, vd 'correctness'. */
  id: string;
  /** Nhãn hiển thị, vd 'Tính đúng đắn'. */
  label: string;
  /** Mô tả tiêu chí — LLM grader đọc mô tả này để chấm. */
  description: string;
  /** Trọng số (mặc định 1). */
  weight?: number;
  /** Điểm tối đa cho tiêu chí (mặc định 10). */
  maxScore?: number;
}

export interface Rubric {
  id: string;
  name: string;
  /** Ngưỡng đạt, 0..1 (mặc định 0.7). */
  passThreshold?: number;
  criteria: RubricCriterion[];
}

export interface CriterionScore {
  criterionId: string;
  label: string;
  /** Điểm đã cho (đã kẹp về 0..maxScore). */
  score: number;
  maxScore: number;
  weight: number;
  /** Nhận xét ngắn (keyword rule nào khớp / model viết gì). */
  comment?: string;
}

export interface GradeResult {
  rubricId: string;
  rubricName: string;
  totalScore: number;
  maxScore: number;
  /** totalScore / maxScore, 0..1. */
  ratio: number;
  passed: boolean;
  passThreshold: number;
  perCriterion: CriterionScore[];
  /**
   * Feedback hành động được cho vòng sửa lại: liệt kê tiêu chí chưa
   * đạt + gợi ý sửa. Fan-out nối feedback này vào task vòng sau.
   */
  feedback: string;
}

export interface ResolvedRubricCriterion {
  id: string;
  label: string;
  description: string;
  weight: number;
  maxScore: number;
}

export interface ResolvedRubric {
  id: string;
  name: string;
  passThreshold: number;
  criteria: ResolvedRubricCriterion[];
}

export const DEFAULT_PASS_THRESHOLD = 0.7;
export const DEFAULT_CRITERION_MAX_SCORE = 10;

/** Validate + chuẩn hoá rubric; ném lỗi rõ khi rubric rỗng/sai. */
export function validateRubric(rubric: Rubric): ResolvedRubric {
  const id = rubric.id?.trim();
  if (!id) throw new Error('Rubric cần id không rỗng.');
  const name = rubric.name?.trim();
  if (!name) throw new Error(`Rubric "${id}" cần name không rỗng.`);
  if (!Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
    throw new Error(`Rubric "${id}" cần ít nhất 1 tiêu chí (criteria).`);
  }
  const seen = new Set<string>();
  const criteria: ResolvedRubricCriterion[] = rubric.criteria.map((c, i) => {
    const cid = c.id?.trim();
    if (!cid) throw new Error(`Rubric "${id}": tiêu chí #${i + 1} cần id không rỗng.`);
    if (seen.has(cid)) throw new Error(`Rubric "${id}": trùng id tiêu chí "${cid}".`);
    seen.add(cid);
    const weight = c.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Rubric "${id}": tiêu chí "${cid}" cần weight > 0.`);
    }
    const maxScore = c.maxScore ?? DEFAULT_CRITERION_MAX_SCORE;
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      throw new Error(`Rubric "${id}": tiêu chí "${cid}" cần maxScore > 0.`);
    }
    return {
      id: cid,
      label: c.label?.trim() || cid,
      description: c.description?.trim() || '',
      weight,
      maxScore,
    };
  });
  const passThreshold = rubric.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 1) {
    throw new Error(`Rubric "${id}": passThreshold phải trong 0..1 (nhận ${String(rubric.passThreshold)}).`);
  }
  return { id, name, passThreshold, criteria };
}

/**
 * Hàm chấm một output theo rubric — do caller tiêm vào.
 * Trả về điểm từng tiêu chí (0..maxScore) + comment ngắn. Ném lỗi =
 * chấm thất bại, fan-out ghi điểm 0 cho output đó thay vì crash.
 */
export type GraderFn = (
  output: string,
  rubric: ResolvedRubric,
) => Promise<Array<{ criterionId: string; score: number; comment?: string }>> | Array<{ criterionId: string; score: number; comment?: string }>;

/** Kẹp điểm về 0..maxScore (model/keyword có thể trả số lạ). */
export function clampScore(score: number, maxScore: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(maxScore, Math.max(0, score));
}

/**
 * Chấm một output theo rubric bằng grader đã tiêm. Criteria nào grader
 * không trả điểm thì tính 0 + ghi chú rõ (không đoán điểm).
 */
export async function gradeOutput(
  output: string,
  rubric: Rubric,
  grader: GraderFn,
): Promise<GradeResult> {
  const resolved = validateRubric(rubric);
  const rawScores = await grader(output, resolved);
  const byId = new Map<string, { score: number; comment?: string }>();
  for (const entry of rawScores ?? []) {
    if (!entry || typeof entry.criterionId !== 'string') continue;
    // Điểm sau thắng điểm trước khi trùng id — grader trả trùng là lỗi
    // của nó, giữ cái cuối và không throw để vòng chấm không vỡ.
    byId.set(entry.criterionId, {
      score: clampScore(entry.score, resolved.criteria.find((c) => c.id === entry.criterionId)?.maxScore ?? DEFAULT_CRITERION_MAX_SCORE),
      ...(entry.comment?.trim() ? { comment: entry.comment.trim() } : {}),
    });
  }
  const perCriterion: CriterionScore[] = resolved.criteria.map((c) => {
    const found = byId.get(c.id);
    return {
      criterionId: c.id,
      label: c.label,
      score: found?.score ?? 0,
      maxScore: c.maxScore,
      weight: c.weight,
      comment: found?.comment ?? (found ? undefined : 'Grader không chấm tiêu chí này — tính 0.'),
    };
  });
  // Điểm có trọng số, chuẩn hoá: sum(score/maxScore * weight) / sum(weight).
  let weighted = 0;
  let weightTotal = 0;
  for (const c of perCriterion) {
    weighted += (c.score / c.maxScore) * c.weight;
    weightTotal += c.weight;
  }
  const ratio = weightTotal > 0 ? weighted / weightTotal : 0;
  const maxScore = resolved.criteria.reduce((sum, c) => sum + c.maxScore * c.weight, 0);
  const totalScore = perCriterion.reduce((sum, c) => sum + c.score * c.weight, 0);
  const passed = ratio >= resolved.passThreshold;
  const failed = perCriterion.filter((c) => c.score / c.maxScore < resolved.passThreshold);
  const feedbackLines: string[] = [];
  if (passed) {
    feedbackLines.push(
      `Đạt rubric "${resolved.name}" (${(ratio * 100).toFixed(0)}% >= ${(resolved.passThreshold * 100).toFixed(0)}%).`,
    );
  } else {
    feedbackLines.push(
      `Chưa đạt rubric "${resolved.name}" (${(ratio * 100).toFixed(0)}% < ${(resolved.passThreshold * 100).toFixed(0)}%) — cần sửa:`,
    );
    for (const c of failed) {
      feedbackLines.push(
        `- ${c.label}: ${c.score}/${c.maxScore}` +
          (c.comment ? ` — ${c.comment}` : '') +
          `. Hãy cải thiện phần này rồi gửi lại.`,
      );
    }
  }
  return {
    rubricId: resolved.id,
    rubricName: resolved.name,
    totalScore,
    maxScore,
    ratio,
    passed,
    passThreshold: resolved.passThreshold,
    perCriterion,
    feedback: feedbackLines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Keyword grader — chấm xác định, không cần LLM (test / CI / fallback)
// ---------------------------------------------------------------------------

export interface KeywordRule {
  /** Từ khoá phải xuất hiện trong output (không phân biệt hoa/thường). */
  keyword: string;
  /** Điểm cho khi khớp (mặc định = maxScore của tiêu chí). */
  score?: number;
}

/**
 * Tạo grader chấm bằng từ khoá: mỗi tiêu chí có danh sách rule; điểm
 * của tiêu chí = điểm cao nhất trong các rule khớp (không khớp rule
 * nào = 0). Dùng cho test/CI và làm fallback khi không có model chấm.
 * Trả về comment ghi rõ rule nào khớp để feedback sửa lại có ích.
 */
export function createKeywordGrader(
  rulesByCriterion: Record<string, KeywordRule[]>,
): GraderFn {
  return (output, rubric) => {
    const lower = output.toLowerCase();
    return rubric.criteria.map((c) => {
      const rules = rulesByCriterion[c.id] ?? [];
      let best = 0;
      let matched: string | undefined;
      for (const rule of rules) {
        const keyword = rule.keyword?.trim().toLowerCase();
        if (!keyword) continue;
        if (lower.includes(keyword)) {
          const score = rule.score ?? c.maxScore;
          if (clampScore(score, c.maxScore) > best) {
            best = clampScore(score, c.maxScore);
            matched = rule.keyword.trim();
          }
        }
      }
      return {
        criterionId: c.id,
        score: best,
        comment:
          matched !== undefined
            ? `Khớp từ khoá "${matched}".`
            : `Không khớp từ khoá nào của tiêu chí này.`,
      };
    });
  };
}

// ---------------------------------------------------------------------------
// LLM grader — gọi model, parse JSON, fail-closed
// ---------------------------------------------------------------------------

export interface LlmGraderJson {
  scores?: Record<string, number>;
  comments?: Record<string, string>;
}

/**
 * Tạo grader gọi model: gửi output + rubric cho model, model phải trả
 * JSON `{ "scores": { "<criterionId>": <0..maxScore> }, "comments": {...} }`.
 * Parse lỗi / thiếu field / model trả text ngoài JSON = chấm thất bại
 * (throw — fan-out ghi điểm 0 + feedback rõ, không đoán điểm). Không
 * gọi provider trực tiếp: `callModel` do caller tiêm vào.
 */
export function createLlmGrader(
  callModel: (prompt: string) => Promise<string>,
): GraderFn {
  return async (output, rubric) => {
    const criteriaText = rubric.criteria
      .map((c) => `- ${c.id} ("${c.label}", tối đa ${c.maxScore} điểm): ${c.description || '(không có mô tả)'}`)
      .join('\n');
    const prompt =
      `Bạn là grader. Chấm output dưới đây theo rubric, CHỈ trả JSON (không giải thích ngoài JSON):\n` +
      `{"scores": {"<criterionId>": <điểm 0..maxScore>}, "comments": {"<criterionId>": "<nhận xét ngắn>"}}` +
      `\n\nRubric "${rubric.name}":\n${criteriaText}\n\nOutput cần chấm:\n${output}`;
    const raw = await callModel(prompt);
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('LLM grader không trả JSON hợp lệ — không chấm được, tính 0 điểm.');
    }
    const scores = (parsed as LlmGraderJson).scores;
    if (!scores || typeof scores !== 'object') {
      throw new Error('LLM grader trả JSON thiếu trường "scores" — không chấm được, tính 0 điểm.');
    }
    const comments = (parsed as LlmGraderJson).comments;
    return rubric.criteria.map((c) => ({
      criterionId: c.id,
      score: clampScore(Number(scores[c.id] ?? 0), c.maxScore),
      comment:
        comments && typeof comments[c.id] === 'string' && comments[c.id].trim()
          ? (comments[c.id] as string).trim()
          : undefined,
    }));
  };
}

/**
 * Tách JSON object đầu tiên trong text model trả về (model hay bọc
 * trong ```json ... ``` hoặc thêm chữ xung quanh). Trả null khi không
 * tách/parse được — caller quyết định fail-closed.
 */
export function extractJsonObject(raw: string): unknown | null {
  if (!raw || typeof raw !== 'string') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
