/**
 * Risk budget types (v1.01, Đội T3).
 *
 * Ý tưởng học từ OpenHands (SecurityAnalyzer + ConfirmationPolicy),
 * thiết kế và code của open-bot, không copy repo nào.
 *
 * Ba khái niệm tách biệt:
 *  - Risk rating: một tool call "nguy hiểm tới đâu" (low/medium/high).
 *  - Confirmation policy: có cần HỎI NGƯỜI trước khi chạy không.
 *  - Budget meter: conversation này đã tốn bao nhiêu token / tiền.
 *
 * Policy không bao giờ quyết định "có được phép không" — quyền thuộc
 * về `agent/permissions.ts` (allow/ask/deny), hook và guardrail, tất cả
 * chạy TRƯỚC risk gate trong loop. Risk gate chỉ siết thêm (ép hỏi,
 * hoặc chặn denylist), không nới lỏng bất kỳ lệnh cấm nào.
 */

/** Mức rủi ro của một tool call. */
export type RiskLevel = 'low' | 'medium' | 'high';

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high'];

/** Thứ tự mức rủi ro — dùng để so sánh (low < medium < high). */
export const RISK_LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

/** Kết quả chấm risk cho một tool call. */
export interface RiskAssessment {
  /** Mức rủi ro cao nhất trong các rule đã khớp (hoặc mức nền theo tool). */
  level: RiskLevel;
  /** Điểm 0–100: < 40 low, 40–69 medium, >= 70 high. */
  score: number;
  /** Lý do đọc được (hiển thị trên thẻ duyệt). */
  reasons: string[];
  /** Id các rule đã khớp (built-in hoặc cấu hình). */
  matchedRuleIds: string[];
  /**
   * True khi call khớp denylist cấu hình: loop chặn cứng, không hỏi
   * duyệt (hỏi một lệnh cấm là vô nghĩa — người dùng không nên duyệt
   * thứ đã bị cấm tường minh).
   */
  denied: boolean;
  /** Tool + args đã chấm (để audit log không cần tra lại call). */
  toolName: string;
  /** Epoch ms lúc chấm. */
  assessedAtMs: number;
}

/**
 * Một rule chấm risk. Rule khớp khi: tên tool khớp (chuỗi chính xác
 * hoặc pattern) VÀ (không có điều kiện args, hoặc ít nhất một điều
 * kiện args khớp). Điều kiện args là regex chạy trên JSON của args
 * (đơn giản, không phụ thuộc schema từng tool) hoặc trên một key
 * cụ thể.
 */
export interface RiskRule {
  /** Id ổn định, hiển thị trong audit log + UI (vd `shell-rm-rf`). */
  id: string;
  /** Mô tả ngắn, hiển thị làm lý do trên thẻ duyệt. */
  description: string;
  /** Mức rủi ro rule này gán khi khớp. */
  level: RiskLevel;
  /** Điểm rule này đóng góp (mức cuối lấy max điểm các rule khớp). */
  score: number;
  /** Tool khớp: tên chính xác, hoặc `*` = mọi tool. */
  tool?: string;
  /** Pattern (regex source) khớp tên tool. */
  toolPattern?: string;
  /** Regex source chạy trên JSON.stringify(args). */
  argsPattern?: string;
  /** Chỉ xét giá trị của key này trong args (chuỗi hoá rồi match). */
  argsKey?: string;
}

/** Cấu hình cho RiskAnalyzer. */
export interface RiskAnalyzerOptions {
  /** Rule bổ sung / ghi đè (id trùng built-in thì ghi đè built-in). */
  extraRules?: RiskRule[];
  /**
   * Allowlist: tên tool, hoặc `tool:regex` (regex chạy trên JSON args).
   * Khớp → ép risk về low (trừ khi denylist cũng khớp — denylist thắng).
   * Dùng cho tool nội bộ đã tin tưởng.
   */
  allowlist?: string[];
  /**
   * Denylist: tên tool, hoặc `tool:regex`. Khớp → level high +
   * `denied: true` (loop chặn cứng). Denylist thắng mọi thứ khác,
   * kể cả allowlist và rule extra.
   */
  denylist?: string[];
  /** Bỏ qua rule built-in theo id (vd tắt một rule gây nhiễu). */
  disabledBuiltinRuleIds?: string[];
}

/** Chính sách duyệt theo risk — cấu hình theo bot (BotConfig). */
export type ConfirmationPolicy = 'allow-all' | 'confirm-risky' | 'confirm-all';

export const CONFIRMATION_POLICIES: readonly ConfirmationPolicy[] = [
  'allow-all',
  'confirm-risky',
  'confirm-all',
];

/** Mặc định khi bot chưa cấu hình: chỉ hỏi tool medium/high. */
export const DEFAULT_CONFIRMATION_POLICY: ConfirmationPolicy = 'confirm-risky';

export function isConfirmationPolicy(value: unknown): value is ConfirmationPolicy {
  return (
    typeof value === 'string' && (CONFIRMATION_POLICIES as readonly string[]).includes(value)
  );
}

export function parseConfirmationPolicy(value: unknown): ConfirmationPolicy {
  return isConfirmationPolicy(value) ? value : DEFAULT_CONFIRMATION_POLICY;
}

/** Kết quả quyết định duyệt của policy cho một tool call. */
export interface ConfirmationDecision {
  /** Có cần hiện thẻ duyệt (dừng run chờ người) không. */
  needsConfirmation: boolean;
  /** Lý do (hiển thị trong log / thẻ duyệt). */
  reason: string;
}

/** Trạng thái của một run (AgentRunner). */
export type RunState =
  | 'idle'
  | 'running'
  | 'waiting-for-confirmation'
  | 'waiting-for-user'
  | 'done'
  | 'error';

export const RUN_STATES: readonly RunState[] = [
  'idle',
  'running',
  'waiting-for-confirmation',
  'waiting-for-user',
  'done',
  'error',
];

/** Trạng thái của một yêu cầu duyệt trong ConfirmationQueue. */
export type PendingConfirmationStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'edited'
  | 'expired';

export const PENDING_CONFIRMATION_STATUSES: readonly PendingConfirmationStatus[] = [
  'pending',
  'approved',
  'denied',
  'edited',
  'expired',
];

/** Một yêu cầu duyệt đang chờ (hoặc đã có quyết định) trong queue. */
export interface PendingConfirmation {
  /** Id yêu cầu — trùng callId của tool call (duy nhất trong run). */
  id: string;
  callId: string;
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
  risk: RiskAssessment;
  policy: ConfirmationPolicy;
  status: PendingConfirmationStatus;
  createdAtMs: number;
  resolvedAtMs?: number;
  /** Args đã sửa bởi người duyệt (chỉ khi status = 'edited'). */
  editedArgs?: Record<string, unknown>;
  /** Ai quyết định: 'user' | 'timeout' | 'system'. */
  decidedBy?: 'user' | 'timeout' | 'system';
}

/** Một dòng audit log: mọi quyết định duyệt đều ghi lại. */
export interface ConfirmationAuditEntry {
  confirmationId: string;
  callId: string;
  botId: string;
  toolName: string;
  riskLevel: RiskLevel;
  riskScore: number;
  policy: ConfirmationPolicy;
  status: PendingConfirmationStatus;
  decidedBy: 'user' | 'timeout' | 'system';
  atMs: number;
  /** Args đã sửa (chỉ khi edited) — đã redact secret ở tầng gọi nếu cần. */
  editedArgs?: Record<string, unknown>;
}

/** Quyết định người dùng đưa ra cho một yêu cầu duyệt. */
export type ConfirmationResolution =
  | { decision: 'approve' }
  | { decision: 'deny' }
  | { decision: 'edit'; args: Record<string, unknown> };

/** Cấu hình cho ConversationBudgetMeter. */
export interface BudgetConfig {
  /** Cap token cho conversation (input + output). Không đặt = không cap token. */
  tokenLimit?: number;
  /** Cap chi phí ước tính (USD) cho conversation. Không đặt = không cap cost. */
  costLimitUsd?: number;
  /** Tỉ lệ (0–1) bắt đầu cảnh báo. Mặc định 0.8. */
  warnAtRatio?: number;
  /** Model mặc định hiển thị khi chưa có call nào (vd model của bot). */
  model?: string;
}

/** Trạng thái budget của một conversation. */
export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export const BUDGET_STATUSES: readonly BudgetStatus[] = ['ok', 'warning', 'exceeded'];

/** Snapshot budget — dữ liệu UI (BudgetMeter) hiển thị. */
export interface BudgetSnapshot {
  conversationId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Chi phí ước tính USD; null khi có model chưa có giá (không báo $0 giả). */
  costUsd: number | null;
  /** True khi có ít nhất một model chưa có giá trong breakdown. */
  hasUnknownCost: boolean;
  tokenLimit: number | null;
  costLimitUsd: number | null;
  /** % token đã dùng so với tokenLimit (null khi không có cap). */
  tokenPercentUsed: number | null;
  /** % cost đã dùng so với costLimitUsd (null khi không có cap / cost null). */
  costPercentUsed: number | null;
  /** % lớn nhất trong hai loại cap (null khi không có cap nào). */
  percentUsed: number | null;
  status: BudgetStatus;
  /** Số model đã dùng trong conversation. */
  modelCount: number;
  /** Token theo từng model (để UI breakdown). */
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number | null }>;
  /** Epoch ms của call gần nhất (null khi chưa có call). */
  lastRecordedAtMs: number | null;
}

/** Cảnh báo budget bắn ra khi vượt ngưỡng (mỗi ngưỡng một lần). */
export interface BudgetAlert {
  conversationId: string;
  /** Ngưỡng vừa vượt: cảnh báo (80%) hay đã vượt cap. */
  kind: 'warning' | 'exceeded';
  /** Cap nào bị chạm: token, cost, hay cả hai. */
  basis: 'tokens' | 'cost' | 'both';
  snapshot: BudgetSnapshot;
  atMs: number;
}
