/**
 * Structural scorer — tầng 1 của router v0.96 (Đội T3).
 *
 * Ý tưởng (học từ các semantic-router / classifier lai): trước khi tốn
 * một lần gọi model, hãy đo "độ khó cấu trúc" của prompt bằng các tín
 * hiệu rẻ và xác định được — độ dài, code, từ khoá suy luận, ràng buộc
 * cứng, số yêu cầu. Tầng này KHÔNG gọi model, KHÔNG gọi mạng, thuần
 * hàm (pure): cùng input luôn cho cùng score, chạy xong trong <1ms
 * với prompt thông thường (đo được bằng `performance.now()` trong test).
 *
 * Thiết kế tự viết lại từ đầu cho open-bot:
 * - 6 nhóm tín hiệu, mỗi nhóm cho điểm 0..1, cộng có trọng số rồi kẹp
 *   về 0..1. Trọng số và ngưỡng đều cấu hình được qua
 *   `StructuralScoreOptions` — UI chỉnh ngưỡng không cần sửa code.
 * - Song ngữ Anh + Việt (open-bot đa ngôn ngữ từ đầu): từ khoá suy
 *   luận / ràng buộc có cả hai thứ tiếng, đếm không phân biệt hoa
 *   thường, khớp theo ranh giới từ để "proving" không nhầm "prove".
 * - Trả cả `breakdown` để UI giải thích được "vì sao prompt này bị
 *   xếp khó" thay vì chỉ một con số bí ẩn.
 */

/** Các ngưỡng / trọng số của scorer — mọi giá trị đều có mặc định. */
export interface StructuralScoreOptions {
  /** Trọng số từng nhóm tín hiệu (không cần cộng bằng 1, sẽ chuẩn hoá). */
  weights?: Partial<Record<StructuralSignal, number>>;
  /** Số ký tự mà tại đó tín hiệu độ dài bão hoà (mặc định 4000). */
  lengthSaturationChars?: number;
  /** Số code block mà tại đó tín hiệu code bão hoà (mặc định 3). */
  codeSaturationBlocks?: number;
  /** Số yêu cầu mà tại đó tín hiệu đa-yêu-cầu bão hoà (mặc định 5). */
  taskSaturationCount?: number;
}

/** Tên 6 nhóm tín hiệu cấu trúc. */
export type StructuralSignal =
  | 'length'
  | 'code'
  | 'reasoning'
  | 'constraints'
  | 'tasks'
  | 'context';

/** Điểm chi tiết từng nhóm (0..1) + điểm tổng. */
export interface StructuralScore {
  /** Điểm tổng 0..1 — càng cao càng "khó", càng cần model mạnh. */
  score: number;
  /** Điểm từng nhóm tín hiệu. */
  breakdown: Record<StructuralSignal, number>;
  /** Số ký tự của prompt (sau khi trim). */
  chars: number;
  /** Số từ ước lượng (tách theo khoảng trắng). */
  words: number;
  /** Số code block (fence ``` hoặc `inline`) tìm thấy. */
  codeBlocks: number;
  /** Số từ khoá suy luận khớp được. */
  reasoningHits: number;
  /** Số từ khoá ràng buộc khớp được. */
  constraintHits: number;
  /** Số yêu cầu / câu hỏi đếm được. */
  taskCount: number;
  /** Phân loại nhanh từ điểm tổng (dùng ngưỡng mặc định, xem dưới). */
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
}

/** Ngưỡng phân loại mặc định (điểm tổng). Hiệu chuẩn 2026-11-13:
 *  điểm là trung bình có trọng số nên prompt thường chỉ đạt 0.02
 *  (chào hỏi) – 0.35 (chứng minh toán có ràng buộc) – 0.8 (prompt
 *  dày đặc từ khoá + code + nhiều yêu cầu); ngưỡng "khó" 0.3 bắt
 *  đúng nhóm prompt cần model mạnh mà không bắt nhầm câu hỏi vừa. */
export const STRUCTURAL_TRIVIAL_MAX = 0.15;
export const STRUCTURAL_SIMPLE_MAX = 0.3;
export const STRUCTURAL_MODERATE_MAX = 0.6;

/** Trọng số mặc định — suy luận + ràng buộc nặng nhất vì chúng là
 *  dấu hiệu mạnh nhất của "model nhỏ sẽ làm sai". */
export const DEFAULT_STRUCTURAL_WEIGHTS: Record<StructuralSignal, number> = {
  length: 1,
  code: 2,
  reasoning: 3,
  constraints: 3,
  tasks: 2,
  context: 1,
};

/** Từ khoá suy luận / toán / lập luận — khớp theo ranh giới từ. */
export const REASONING_KEYWORDS: readonly string[] = [
  // Toán & logic (Anh).
  'prove', 'proof', 'theorem', 'lemma', 'integral', 'derivative',
  'equation', 'solve for', 'algorithm', 'complexity', 'big-o', 'big o',
  'recurrence', 'induction', 'contradiction', 'deduce', 'infer',
  'optimize', 'optimization', 'constraint satisfaction', 'graph theory',
  'probability', 'statistics', 'regression', 'calculus', 'algebra',
  'geometry', 'combinatorial', 'asymptotic',
  // Toán & logic (Việt).
  'chứng minh', 'định lý', 'bổ đề', 'tích phân', 'đạo hàm', 'phương trình',
  'giải phương trình', 'độ phức tạp', 'quy nạp', 'phản chứng', 'suy luận',
  'suy diễn', 'tối ưu', 'xác suất', 'thống kê', 'hồi quy', 'giải tích',
  'đại số', 'hình học', 'tổ hợp', 'tiệm cận',
  // Lập kế hoạch & phân tích (Anh + Việt).
  'architect', 'design pattern', 'trade-off', 'tradeoff', 'compare and contrast',
  'root cause', 'strategy', 'roadmap', 'threat model',
  'kiến trúc', 'mẫu thiết kế', 'đánh đổi', 'nguyên nhân gốc', 'chiến lược',
  'lộ trình', 'phân tích',
];

/** Từ khoá ràng buộc cứng — prompt kiểu này sai một chi tiết là hỏng. */
export const CONSTRAINT_KEYWORDS: readonly string[] = [
  'must', 'must not', 'never', 'always', 'exactly', 'precisely',
  'step by step', 'step-by-step', 'in order', 'strictly', 'do not',
  'without fail', 'at least', 'at most', 'no more than', 'no less than',
  'required', 'mandatory', 'forbidden', 'only', 'exactly',
  'phải', 'không được', 'tuyệt đối', 'chính xác', 'từng bước',
  'theo thứ tự', 'nghiêm ngặt', 'bắt buộc', 'cấm', 'ít nhất',
  'nhiều nhất', 'không quá', 'không ít hơn', 'duy nhất',
];

/** Động từ mệnh lệnh thường mở đầu một yêu cầu (Anh + Việt). */
export const TASK_VERBS: readonly string[] = [
  'write', 'create', 'build', 'implement', 'fix', 'debug', 'refactor',
  'explain', 'summarize', 'summarise', 'translate', 'review', 'analyze',
  'analyse', 'compare', 'generate', 'design', 'test', 'deploy', 'convert',
  'viết', 'tạo', 'xây dựng', 'triển khai', 'sửa', 'gỡ lỗi', 'tái cấu trúc',
  'giải thích', 'tóm tắt', 'dịch', 'đánh giá', 'phân tích', 'so sánh',
  'thiết kế', 'kiểm thử', 'chuyển đổi',
];

/** Regex ranh giới từ — escape trước khi nối vào pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWordMatcher(keywords: readonly string[]): RegExp {
  const parts = keywords.map((k) => escapeRegExp(k));
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${parts.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

/** Đếm số lần khớp (không trùng) của một matcher trong text. */
function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) {
    n++;
    // Tránh vòng lặp vô hạn với match rỗng (không xảy ra với pattern
    // này, nhưng giữ guard cho chắc).
    if (re.lastIndex === 0) break;
  }
  return n;
}

const reasoningMatcher = buildWordMatcher(REASONING_KEYWORDS);
const constraintMatcher = buildWordMatcher(CONSTRAINT_KEYWORDS);
const taskVerbMatcher = buildWordMatcher(TASK_VERBS);

/** Đếm code block: fence ``` (mở hoặc đóng) + inline `code` + đường
 *  dẫn file / tên file có đuôi mở rộng quen thuộc. */
export function countCodeSignals(text: string): number {
  let n = 0;
  const fences = text.match(/```/g);
  if (fences) n += Math.floor(fences.length / 2);
  const inline = text.match(/`[^`\n]{1,80}`/g);
  if (inline) n += inline.length;
  // Đường dẫn file hoặc tên file .ts/.py/.js/... (không tính URL).
  const files = text.match(/(?:^|[\s('"`])(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b|(?:^|[\s('"`])[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|md|sql|sh)\b/gi);
  if (files) n += files.length;
  return n;
}

/** Đếm yêu cầu: mục đánh số / gạch đầu dòng + câu hỏi + mệnh lệnh. */
export function countTasks(text: string): number {
  let n = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (/^(\d+[.)]|\d+\s*[-–—)]|[-*•·]\s+)\S/.test(t)) n++;
  }
  const questions = text.match(/\?/g);
  if (questions) n += questions.length;
  n += countMatches(text, taskVerbMatcher);
  return n;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Chấm điểm cấu trúc của một prompt. Thuần hàm, không I/O, không
 * trạng thái — cùng input + cùng options luôn cho cùng output.
 */
export function structuralScore(
  text: string,
  opts: StructuralScoreOptions = {},
): StructuralScore {
  const input = typeof text === 'string' ? text.trim() : '';
  const chars = input.length;
  const words = input === '' ? 0 : input.split(/\s+/).length;
  const lengthSat = opts.lengthSaturationChars ?? 4000;
  const codeSat = opts.codeSaturationBlocks ?? 3;
  const taskSat = opts.taskSaturationCount ?? 5;

  const codeBlocks = countCodeSignals(input);
  const reasoningHits = countMatches(input, reasoningMatcher);
  const constraintHits = countMatches(input, constraintMatcher);
  const taskCount = countTasks(input);

  // Tín hiệu độ dài: bão hoà log — prompt 4000 ký tự đã "dài", 20000
  // ký tự không gấp 5 lần khó.
  const lengthScore = clamp01(Math.log1p(chars) / Math.log1p(lengthSat));
  // Code: bão hoà nhanh — 1 block đã là dấu hiệu làm việc với code.
  const codeScore = clamp01(codeBlocks / codeSat);
  // Suy luận: mỗi từ khoá +0.25, tối đa 1 (4 từ khoá trở lên là chắc chắn).
  const reasoningScore = clamp01(reasoningHits * 0.25);
  // Ràng buộc: mỗi từ khoá +0.2, tối đa 1.
  const constraintScore = clamp01(constraintHits * 0.2);
  // Số yêu cầu: bão hoà ở taskSat.
  const taskScore = clamp01(taskCount / taskSat);
  // Bối cảnh: câu dài + nhiều câu → prompt có cấu trúc phức tạp.
  // Dùng số câu (dấu . ! ? cuối câu) và độ dài trung bình mỗi từ.
  const sentences = (input.match(/[.!?]+[\s$]/g) ?? []).length + (input ? 1 : 0);
  const avgWordLen = words > 0 ? chars / words : 0;
  const contextScore = clamp01(
    Math.min(sentences / 12, 1) * 0.6 + clamp01((avgWordLen - 4) / 4) * 0.4,
  );

  const breakdown: Record<StructuralSignal, number> = {
    length: lengthScore,
    code: codeScore,
    reasoning: reasoningScore,
    constraints: constraintScore,
    tasks: taskScore,
    context: contextScore,
  };
  const weights: Record<StructuralSignal, number> = {
    ...DEFAULT_STRUCTURAL_WEIGHTS,
    ...(opts.weights ?? {}),
  };
  let weighted = 0;
  let weightSum = 0;
  (Object.keys(breakdown) as StructuralSignal[]).forEach((k) => {
    const w = Math.max(0, weights[k] ?? 0);
    weighted += breakdown[k] * w;
    weightSum += w;
  });
  const score = weightSum > 0 ? clamp01(weighted / weightSum) : 0;
  const complexity: StructuralScore['complexity'] =
    score <= STRUCTURAL_TRIVIAL_MAX
      ? 'trivial'
      : score <= STRUCTURAL_SIMPLE_MAX
        ? 'simple'
        : score <= STRUCTURAL_MODERATE_MAX
          ? 'moderate'
          : 'complex';
  return {
    score,
    breakdown,
    chars,
    words,
    codeBlocks,
    reasoningHits,
    constraintHits,
    taskCount,
    complexity,
  };
}

/**
 * Quyết định nhanh từ điểm cấu trúc: prompt "quá dễ" → local, "quá
 * khó" → model mạnh, còn lại → để tầng ngữ nghĩa quyết. Ngưỡng cấu
 * hình được (mặc định: dễ ≤ 0.15, khó ≥ 0.3 — xem ghi chú hiệu chuẩn
 * ở STRUCTURAL_*_MAX).
 */
export function structuralVerdict(
  score: number,
  opts: { simpleMax?: number; complexMin?: number } = {},
): 'local' | 'capable' | 'undecided' {
  const simpleMax = opts.simpleMax ?? STRUCTURAL_TRIVIAL_MAX;
  const complexMin = opts.complexMin ?? STRUCTURAL_SIMPLE_MAX;
  if (score <= simpleMax) return 'local';
  if (score >= complexMin) return 'capable';
  return 'undecided';
}
