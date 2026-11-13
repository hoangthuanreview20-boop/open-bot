/**
 * Agent loop: drives one user turn — send messages + tools to the provider,
 * execute any tool calls (asking approval first when required), feed the
 * results back, and repeat until the model answers with plain text or
 * `maxSteps` is reached.
 *
 * Text is delivered through `events.onText`. Providers in 0.1.0 are
 * non-streaming, so onText is called once per round with the full text of
 * that round; if a provider later streams, it can call onText per chunk.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentEvents,
  ApprovalDecision,
  BotConfig,
  ChatMessage,
  Provider,
  SubagentOptions,
  Tool,
  ToolCall,
  ToolResult,
} from '../types';
import type { AgentPermissions } from './permissions';
import { ESSENTIAL_TOOLS, filterTools, groupTools, isReadOnlyTool } from './toolFilter';
import type { ActiveSkillInput } from './toolFilter';
import { applyAppToolCaps } from '../apps/toolCap';
import type { AppCapReport } from '../apps/toolCap';
import type { AgentMode } from './coordination';
import type { HookContext, HookRunner } from '../hooks/index';
import type { GuardrailRegistry } from '../guardrails/index';
import { GuardrailTripwireError } from '../guardrails/index';
import type { Tracer } from '../tracing/index';
import type { AutoApproveRule } from '../approval/index';
import type { BotApprovalLevel } from '../approval/levels';
import { isSelfReadCall, shouldAskForCall } from '../approval/index';
import { ELEVATED_TOOL_NAME } from '../elevate/elevate';
import type { BotMemory } from './memory';
import { saveStepCheckpoint } from './checkpoints';
import type { CheckpointToolCallRecord } from './checkpoints';
import {
  INTERRUPT_CANCELLED_TEXT,
  InterruptController,
  interruptNoHandlerText,
  matchesInterruptPoint,
  normalizeInterruptPoints,
} from './interrupt';
import type { InterruptDecision, InterruptHandler, InterruptPoint, InterruptReason } from './interrupt';
import { checkAndCompact } from './compaction';
import {
  buildStructuredPromptHint,
  buildStructuredRetryHint,
  formatStructuredError,
  parseStructuredOutput,
} from './structured';
import type { StructuredOutputOptions } from './structured';
import { buildSubagentSystemPrompt, mergeParallelResults, runSpecializedSubagentsParallel } from './subagent';
import type { SpecializedSubagentTask } from './subagent';
import {
  DEFAULT_ROLE_REGISTRY,
  SubagentRoleRegistry,
} from '../subagents/roles';
import { createShadow } from './worktree';
import { throwIfAborted } from '../providers/abort';
import {
  assertFitsSmallModel,
  effectiveContextLimit,
  estimateFirstRequestTokens,
  isSmallContextModel,
} from './smallModel';
import {
  providerSupportsVision,
  validateVisionAttachments,
  visionUnsupportedMessage,
} from './vision';
import type { VisionAttachment } from '../types';
import type { HarnessEventKind } from '../harness/types';
import type { AgUiRuntimeEmitter } from '../agui/runtime';

/**
 * v0.53 (P1-7): sink for the tool-call history — the structural shape
 * a recorder must satisfy (the tools package's `ToolCallHistoryStore`
 * satisfies it; core must not import tools, so the coordinator adapts
 * one). `record` is best-effort: it must never throw into a run, and
 * the loop swallows recorder errors. One record per executed call,
 * with the replay triple (`tool_call_id` / `tool_name` / `args_json`)
 * plus timing (Grok `ToolCall` #57/#59/#60).
 */
export interface ToolCallRecorder {
  record(record: {
    tool_call_id: string;
    tool_name: string;
    args_json: string;
    started_at_ms?: number;
    completed_at_ms?: number;
    status?: 'ok' | 'error' | 'denied';
    result_preview?: string;
  }): void;
}

export interface AgentRunnerOptions {
  bot: BotConfig;
  events: AgentEvents;
  /** Max provider round-trips per user turn. Default 25. */
  maxSteps?: number;
  /** Abort signal for this turn; forwarded to tools as ctx.signal (v0.2). */
  signal?: AbortSignal;
  /**
   * Optional per-bot tool permissions (v0.6). When set, executeCall
   * enforces allow/deny/ask before the needsApproval check.
   */
  permissions?: AgentPermissions;
  /** v0.10: deterministic hooks (Pre/PostToolUse, SessionStart/End/Stop). */
  hooks?: HookRunner;
  /** v0.10: content guardrails (input/output/tool layers). */
  guardrails?: GuardrailRegistry;
  /** v0.10: run tracer — spans are emitted when set, skipped otherwise. */
  tracer?: Tracer;
  /**
   * v0.35 (P1-7): auto-approve rules — khi một tool call sắp phải hỏi
   * duyệt (policy 'ask' hoặc tool có needsApproval), loop hỏi callback
   * này trước: trả về rule khớp thì tool chạy ngay không cần bấm duyệt
   * (ghi log + span trace rõ rule nào), trả về undefined thì hỏi duyệt
   * tay như cũ. Callback do host (coordinator) cung cấp từ
   * `AutoApproveRuleStore`; không set = không có rule nào (mặc định tắt,
   * fail-closed). Callback KHÔNG được vượt denylist: loop đã từ chối
   * lệnh cấm trước khi tới đây (hook PreToolUse + checkToolCall), và
   * rule tự nó cũng kiểm tra denylist lúc khớp (xem `approval/rules`).
   */
  autoApproveCheck?: (input: {
    botId: string;
    toolName: string;
    args: Record<string, unknown>;
    workspaceDir?: string;
  }) => AutoApproveRule | undefined;
  /**
   * v0.50 (M8): mức approval riêng của bot (xem `approval/levels.ts`).
   * Không set → lấy `bot.approvalLevel`, không có nữa → `ask-for-writes`
   * (hành vi cũ). Mức chỉ quyết định có HIỆN THẺ hay không.
   */
  approvalLevel?: BotApprovalLevel;
  /**
   * v0.53 (P1-7): recorder for the tool-call history (`tool_call_id`
   * / `tool_name` / `args_json` + timings) that `tool_call_replay`
   * reads back. Absent = no history is recorded (hành vi cũ).
   * Recording is best-effort and never breaks a turn.
   */
  toolCallRecorder?: ToolCallRecorder;
  /**
   * v0.90a (Đội G): sink ghi event của loop lên harness bus + NDJSON
   * ThreadLog (turn-start/end, text, tool_call, result, error,
   * approval_denied). Coordinator truyền closure nối tới
   * `LocalHarness.publishLoopEvent` (đã sanitize + không throw);
   * không set = loop chạy như cũ, không có overhead đáng kể (một
   * kiểm tra null mỗi event). Sink KHÔNG BAO GIỜ được throw vào run
   * (loop nuốt lỗi sink). Subagent con không kế thừa sink này
   * (runSubagent dựng runner mới không truyền nó).
   */
  harnessSink?: (kind: HarnessEventKind, payload: Record<string, unknown>) => void;
  /**
   * v0.97 (Team T3): AG-UI runtime emitter for this run — the loop
   * calls it at the same points where it emits harness events (run
   * start/end, text, tool calls). Absent = no AG-UI events (old
   * behaviour). The emitter itself is a no-op for provider 'mock'
   * and CLI-kind providers (see shouldEmitAgUiForProvider in
   * agui/runtime.ts) and for silent runs, so the coordinator may
   * pass one unconditionally; it never probes the network or Ollama.
   * Every call is best-effort inside the emitter — a failing emit
   * never breaks a run.
   */
  agUiEmitter?: AgUiRuntimeEmitter;
  /**
   * v0.33 (P0-1 fork-execution): skills with `context: fork` that
   * matched this run, with bodies already loaded by the coordinator.
   * Each one runs in its own subagent at the start of `run()` (after
   * the input guardrail) and only its summary reaches the parent.
   * Empty/absent = no fork work. Never forwarded to child runners.
   */
  forkSkills?: ForkSkillInput[];
  /**
   * v0.33 (P0-1 fork-execution): nesting depth of this runner inside
   * fork subagents (0 = top-level run). Fork skills only execute at
   * depth 0 — `runSubagent` passes `forkDepth + 1` to every child.
   */
  forkDepth?: number;
  /** v0.33: per-run override of `FORK_SKILL_TIMEOUT_MS` (tests / host tuning). */
  forkTimeoutMs?: number;
  /** v0.33: per-run override of `FORK_SKILL_MAX_STEPS` (tests / host tuning). */
  forkMaxSteps?: number;
  /**
   * v0.10: per-turn tool filtering (mode + active skills; grouping on by
   * default). When omitted, the bot allowlist still filters (no policy =
   * keep all, v0.1 behaviour) — the full 119-tool list only reaches the
   * model when the bot is actually allowed to use all of it.
   * v0.28 (P0-4 fallback): an empty filter result falls back to the
   * bot-allowlist (+ mode) baseline with a warning, never past the
   * allowlist or plan/review read-only boundary (see
   * `resolveFilteredTools`).
   */
  toolFilter?: { mode?: AgentMode; activeSkills?: ActiveSkillInput[]; group?: boolean };
  /**
   * v0.51 (M7 cap wiring): cap tool theo từng app, áp TRƯỚC
   * `filterTools` mỗi turn (xem `apps/toolCap.ts` — mặc định 10
   * tool/app/turn, giữ thứ tự catalog, tool không thuộc app nào giữ
   * nguyên). `capsByApp` ghi đè theo từng app (coordinator đọc từ
   * SharedAppAuthStore qua `getToolCaps()` mỗi run); `registry` cho
   * biết tool nào thuộc app nào (mặc định catalog built-in — host
   * dùng registry riêng thì truyền vào đây). Không set thì loop giữ
   * hành vi cũ (không cap gì).
   */
  appToolCaps?: {
    capsByApp?: Record<string, number>;
    registry?: { appIdForTool(toolName: string): string | undefined };
  };
  /**
   * v0.12: checkpoint sau mỗi step — cần cả `memory` và `runId`. Không
   * set thì không lưu checkpoint (hành vi cũ).
   */
  memory?: BotMemory;
  runId?: string;
  /**
   * v0.12: resume từ checkpoint — messages + step bắt đầu, thay cho
   * `[system, user]` + step 0. Dùng kèm `resumeFrom()` hoặc khi tạo
   * runner cho run nối tiếp.
   */
  initialMessages?: ChatMessage[];
  /**
   * v0.60: history của thread đã chọn, nạp làm context cho lượt này.
   * `run()` chèn vào giữa system prompt và tin mới của user:
   * `[system, ...historyMessages, user]` — system prompt vẫn được
   * dựng đầy đủ trong `run()` (hook SessionStart, fork skills,
   * structured hint), khác với `initialMessages` (dùng nguyên xi,
   * resume đã có sẵn messages của run cũ nên history bị bỏ qua khi
   * cả hai cùng set). Coordinator cắt history theo cap (số message +
   * token, xem `agent/threadHistory.ts`) trước khi truyền vào đây;
   * runner chỉ chèn, không cắt thêm. Không set → chạy như cũ.
   */
  historyMessages?: ChatMessage[];
  /**
   * v0.63 (vision channel): images attached to this turn's user
   * message (from `RunParams.attachments`, via the coordinator).
   * `run()` validates them (limits/mime/base64) and refuses the
   * turn with a friendly message when the provider/model cannot do
   * vision — the bytes never reach a provider that would 400 or
   * silently drop them. Valid attachments are set on the new user
   * message only (`[system, ...history, user+attachments]`);
   * resume runs ignore them (the checkpoint already holds the old
   * messages) and subagent children never inherit them (their
   * `runSubagent` call builds a fresh runner without this option).
   */
  attachments?: VisionAttachment[];
  startStep?: number;
  /**
   * v0.54 (P1-8): human-in-the-loop interrupt (§12.4).
   *  - `interruptController`: host/UI gọi `controller.request()` (hoặc
   *    `runner.interrupt()`) để dừng run ở biên an toàn tiếp theo.
   *  - `onInterrupt`: handler hỏi user rồi trả quyết định (tiếp tục /
   *    tiếp tục kèm message / từ chối tool / hủy). Không set → run dừng
   *    an toàn (lưu checkpoint rồi kết thúc) thay vì treo chờ mãi.
   *  - `interruptBeforeTools`: điểm dừng trước tool call — tên tool hoặc
   *    predicate; mở rộng plan-approval 1 bước thành dừng được ở bất kỳ
   *    tool nguy hiểm nào, giữa run dài.
   */
  interruptController?: InterruptController;
  onInterrupt?: InterruptHandler;
  interruptBeforeTools?: InterruptPoint | readonly InterruptPoint[];
  /**
   * v0.12: compaction khi context vượt ngưỡng. `contextLimit` bắt buộc
   * thì mới compact (không có → không đoán, không compact).
   */
  compaction?: {
    contextLimit?: number;
    threshold?: number;
    keepRecent?: number;
    summarizerModel?: string;
    language?: 'vi' | 'en';
  };
  /** v0.12: kết quả cuối phải theo JSON Schema (validate + thử lại). */
  structuredOutput?: StructuredOutputOptions;
  /**
   * v0.37 (P1-4): role subagent chuyên biệt (xem `subagents/roles.ts`).
   * `roleRegistry` thắng `customRoles`; `customRoles` (role custom đã
   * load từ file, vd qua `loadRolesFromDir`) được gộp lên trên role
   * built-in (trùng id built-in thì throw lúc tạo runner). Không set
   * thì chỉ có 5 role built-in. Coordinator chưa truyền gì thì host
   * dùng trực tiếp AgentRunner vẫn nhận role custom qua đây.
   */
  roleRegistry?: SubagentRoleRegistry;
  customRoles?: readonly unknown[];
  /**
   * v0.19 (W12a): small-model guardrail — context window (token) của
   * model đang chạy, khi biết chắc (vd model local 4.096 token). Không
   * set thì lấy từ `compaction.contextLimit` (coordinator đã truyền
   * `contextLimitForModel(providerId, model)` vào đó), rồi heuristic
   * theo tên model (`smallModel.ts`). Khi model nhỏ (≤ 8k) loop ép
   * filtering + grouping ở mức mạnh nhất (plan mode + grouping) và dừng
   * run với lỗi tiếng Việt rõ ràng nếu ước lượng vẫn vượt context —
   * thay vì để provider trả 400 khó hiểu. `enabled: false` tắt guard.
   */
  smallModel?: {
    contextLimit?: number;
    enabled?: boolean;
  };
}

const MAX_SUBAGENT_SUMMARY_CHARS = 20_000;

/**
 * v0.33 (P0-1 fork-execution): one skill that must run in its own
 * subagent (`context: fork`). The coordinator matches the skill, loads
 * its body, and hands it here — the loop spawns the subagent and feeds
 * the summary back into the parent run's system prompt. Inline skills
 * never arrive through this option (their bodies are injected by the
 * coordinator as before).
 */
export interface ForkSkillInput {
  /** Skill name (frontmatter `name`). */
  name: string;
  /** Skill description (frontmatter `description`). */
  description?: string;
  /** Tier-2 instruction body — becomes the subagent's instructions. */
  body: string;
  /** Tool allowlist (`allowed-tools`); empty/undefined = the runner's full tool list. */
  allowedTools?: string[];
}

/**
 * v0.33 (P0-1 fork-execution): bounds for fork-skill subagents.
 * `FORK_SKILL_TIMEOUT_MS` / `FORK_SKILL_MAX_STEPS` bound one fork
 * run; `FORK_DEPTH_LIMIT` bounds nesting — a fork subagent never
 * forks again (its children get `forkDepth + 1` and the check in
 * `run()` refuses to fork at depth > 0). The child also never
 * receives `forkSkills`, so the depth check is defence-in-depth, not
 * the only guard.
 */
export const FORK_SKILL_TIMEOUT_MS = 120_000;
export const FORK_SKILL_MAX_STEPS = 10;
export const FORK_DEPTH_LIMIT = 0;

/**
 * v0.30 (P0-3): builtin loop-only được phép ở plan/review mode —
 * `stop_agent` không có Tool object (chạy qua handleBuiltInCall) và chỉ
 * dừng agent con, không ghi file/shell gì. Các builtin giao tiếp khác
 * (ask_user / send_*) đã nằm trong ESSENTIAL_TOOLS.
 */
const PLAN_MODE_BUILTIN_TOOLS: ReadonlySet<string> = new Set(['stop_agent']);

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated to ${maxChars} chars ...]`;
}

/**
 * v0.54 (P1-8): đếm message `tool` ở cuối mảng messages — tức kết quả
 * tool đã push trong step đang chạy (sau assistant message của step).
 * Dùng khi lưu checkpoint lúc interrupt-before-tool: phải cắt đúng số
 * message này (+ assistant message của step) để snapshot chỉ còn tới
 * cuối step trước đó.
 */
function countTrailingToolMessages(messages: ChatMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'tool') count++;
    else break;
  }
  return count;
}

interface SubagentEntry {
  id: string;
  status: string;
  controller: AbortController;
}

export class AgentRunner {
  private readonly provider: Provider;
  private readonly tools: Map<string, Tool>;
  private readonly toolsList: Tool[];
  private readonly bot: BotConfig;
  private readonly events: AgentEvents;
  private readonly maxSteps: number;
  private readonly signal?: AbortSignal;
  private readonly permissions?: AgentPermissions;
  private readonly hooks?: HookRunner;
  private readonly guardrails?: GuardrailRegistry;
  private readonly tracer?: Tracer;
  private readonly autoApproveCheck?: AgentRunnerOptions['autoApproveCheck'];
  /** v0.50 (M8): mức approval của bot cho run này (xem options). */
  private readonly approvalLevel?: BotApprovalLevel;
  /** v0.53 (P1-7): tool-call history recorder (absent = không ghi). */
  private readonly toolCallRecorder?: ToolCallRecorder;
  /** v0.90a (Đội G): sink event loop → harness (absent = không ghi). */
  private readonly harnessSink?: AgentRunnerOptions['harnessSink'];
  /** v0.97 (Team T3): AG-UI emitter for this run (absent = no AG-UI events). */
  private readonly agUiEmitter?: AgUiRuntimeEmitter;
  private readonly forkSkills: ForkSkillInput[];
  private readonly forkDepth: number;
  private readonly forkTimeoutMs: number;
  private readonly forkMaxSteps: number;
  private readonly toolFilterOptions?: { mode?: AgentMode; activeSkills?: ActiveSkillInput[]; group?: boolean };
  /** v0.51 (M7 cap wiring): cap tool theo app cho run này (xem options). */
  private readonly appToolCaps?: AgentRunnerOptions['appToolCaps'];
  /**
   * v0.51: true sau lần đầu `toolsAfterAppCap` báo tool bị cắt trong
   * run này — báo 1 lần/run thay vì lặp lại mỗi step (tối đa
   * `maxSteps` lần). Đặt lại mỗi lần `runLoop` bắt đầu.
   */
  private appToolCapWarned = false;
  /** v0.12: checkpoint — memory + runId (cả hai đều cần mới lưu). */
  private readonly memory?: BotMemory;
  private readonly runId?: string;
  private readonly initialMessages?: ChatMessage[];
  /** v0.60: history thread đã chọn (xem options) — chèn sau system. */
  private readonly historyMessages?: ChatMessage[];
  /** v0.63 (vision channel): ảnh đính kèm của lượt này (xem options). */
  private readonly attachments?: VisionAttachment[];
  private readonly startStep: number;
  /** v0.54 (P1-8): interrupt — controller có thể tạo lười qua `interrupt()`. */
  private interruptController?: InterruptController;
  private readonly onInterrupt?: InterruptHandler;
  private readonly interruptPoints: InterruptPoint[];
  private readonly compactionOpts?: AgentRunnerOptions['compaction'];
  private readonly structuredOutput?: StructuredOutputOptions;
  private readonly smallModelOpts?: AgentRunnerOptions['smallModel'];
  /** v0.37 (P1-4): registry role subagent (built-in + custom nếu host truyền). */
  private readonly roleRegistry: SubagentRoleRegistry;
  /**
   * v0.19 (W12a): true khi small-model guard đã ép filtering mạnh nhất
   * cho run hiện tại (plan mode + grouping) — `toolsForTurn()` đọc cờ
   * này mỗi step. Đặt lại mỗi lần `runLoop` bắt đầu.
   */
  private smallModelForced = false;
  /**
   * v0.28 (P0-4 fallback): true sau lần đầu `resolveFilteredTools`
   * log cảnh báo filter rỗng trong run này — cảnh báo 1 lần/run thay
   * vì lặp lại mỗi step (tối đa `maxSteps` lần). Đặt lại mỗi lần
   * `runLoop` bắt đầu.
   */
  private toolFilterEmptyWarned = false;
  /** Tools visible to the model this step (filtered + grouped, v0.10). */
  private turnTools = new Map<string, Tool>();
  /** In-memory registry of subagents spawned by this runner (v0.2). */
  private readonly subagents = new Map<string, SubagentEntry>();

  constructor(provider: Provider, tools: Tool[], opts: AgentRunnerOptions) {
    this.provider = provider;
    this.tools = new Map(tools.map((t) => [t.definition.name, t]));
    this.toolsList = [...tools];
    this.bot = opts.bot;
    this.events = opts.events;
    this.maxSteps = opts.maxSteps ?? 25;
    this.signal = opts.signal;
    this.permissions = opts.permissions;
    this.hooks = opts.hooks;
    this.guardrails = opts.guardrails;
    this.tracer = opts.tracer;
    this.autoApproveCheck = opts.autoApproveCheck;
    this.approvalLevel = opts.approvalLevel ?? opts.bot.approvalLevel;
    this.toolCallRecorder = opts.toolCallRecorder;
    this.harnessSink = opts.harnessSink;
    this.agUiEmitter = opts.agUiEmitter;
    this.forkSkills = opts.forkSkills ?? [];
    this.forkDepth = opts.forkDepth ?? 0;
    this.forkTimeoutMs = opts.forkTimeoutMs ?? FORK_SKILL_TIMEOUT_MS;
    this.forkMaxSteps = opts.forkMaxSteps ?? FORK_SKILL_MAX_STEPS;
    this.toolFilterOptions = opts.toolFilter;
    this.appToolCaps = opts.appToolCaps;
    this.memory = opts.memory;
    this.runId = opts.runId;
    this.initialMessages = opts.initialMessages;
    this.historyMessages = opts.historyMessages;
    this.attachments = opts.attachments;
    this.startStep = opts.startStep ?? 0;
    this.interruptController = opts.interruptController;
    this.onInterrupt = opts.onInterrupt;
    this.interruptPoints = normalizeInterruptPoints(opts.interruptBeforeTools);
    this.compactionOpts = opts.compaction;
    this.structuredOutput = opts.structuredOutput;
    this.smallModelOpts = opts.smallModel;
    this.roleRegistry =
      opts.roleRegistry ??
      (opts.customRoles ? new SubagentRoleRegistry(opts.customRoles) : DEFAULT_ROLE_REGISTRY);
  }

  async run(userText: string): Promise<string> {
    const hookCtx: HookContext = {
      botId: this.bot.id,
      workspaceDir: this.bot.workspaceDir,
    };
    // v0.10: SessionStart hooks may inject extra context lines.
    let systemPrompt = this.bot.systemPrompt;
    try {
      const session = await this.hooks?.runSessionStart({ source: 'chat' }, hookCtx);
      if (session && session.context.length > 0) {
        systemPrompt += '\n\n' + session.context.join('\n');
      }
    } catch {
      // Hooks never throw by contract; defensive only.
    }
    // v0.10: input guardrail — a tripwire returns a safe refusal, no LLM call.
    if (this.guardrails) {
      const guardSpan = this.tracer?.startSpan('guardrail', 'input', { input: userText });
      try {
        await this.guardrails.enforce(userText, {
          layer: 'input',
          workspaceDir: this.bot.workspaceDir,
          source: 'user',
        });
        guardSpan?.finish();
      } catch (err) {
        guardSpan?.fail(err);
        if (err instanceof GuardrailTripwireError) {
          return 'Không thể xử lý yêu cầu này: nội dung vi phạm quy tắc an toàn.';
        }
        // P0-5 fail-closed: the guardrail itself errored (registry bug,
        // …) — refuse safely instead of crashing the run or, worse,
        // letting unchecked input reach the model.
        return 'Không thể xử lý yêu cầu này: kiểm tra an toàn lỗi, chặn fail-closed.';
      }
    }
    // v0.63 (vision channel): validate + capability-gate the
    // attachments BEFORE any provider call or fork work. Invalid
    // attachments (too many / too big / wrong mime / bad base64) and
    // a provider/model without vision both end the turn here as a
    // friendly message — no provider call, no crash, and the image
    // bytes never reach a model that would 400 or silently ignore
    // them. Same fail-closed shape as the guardrail refusal above
    // (early return, no SessionEnd hook — consistent with it).
    let visionAttachments: VisionAttachment[] = [];
    if (this.attachments !== undefined && this.attachments.length > 0) {
      const validation = validateVisionAttachments(this.attachments);
      if (!validation.ok) return validation.error;
      if (!providerSupportsVision(this.provider, this.bot.model)) {
        return visionUnsupportedMessage(this.provider.label, this.bot.model);
      }
      visionAttachments = validation.attachments;
    }
    // v0.33 (P0-1 fork-execution): fork skills run in their own
    // subagents BEFORE the parent loop starts — only after the input
    // guardrail passed, so blocked input never spends subagent work.
    // A fork failure/timeout never crashes the parent: it becomes a
    // short note in the prompt and the run continues without it.
    if (this.forkSkills.length > 0 && this.forkDepth <= FORK_DEPTH_LIMIT) {
      const forkSection = await this.executeForkSkills(userText);
      if (forkSection) systemPrompt += `\n\n${forkSection}`;
    }
    // v0.12: structured output — ép model trả JSON đúng schema ngay từ đầu.
    if (this.structuredOutput) {
      systemPrompt +=
        '\n\n' +
        buildStructuredPromptHint(this.structuredOutput.schema, this.structuredOutput.language ?? 'vi');
    }
    // v0.12: resume — chạy tiếp từ messages của checkpoint thay vì bắt đầu mới.
    // v0.60: không resume thì chèn history thread đã chọn giữa system
    // prompt và tin mới: [system, ...history, user]. History rỗng thì
    // mảng này y hệt hành vi cũ ([system, user]).
    // v0.63 (vision channel): ảnh đính kèm (đã validate + gate ở trên)
    // gắn vào tin user mới — và chỉ tin đó; resume bỏ qua ảnh (messages
    // checkpoint đã có sẵn), history thread không mang ảnh.
    const messages: ChatMessage[] = this.initialMessages ?? [
      { role: 'system', content: systemPrompt },
      ...(this.historyMessages ?? []),
      {
        role: 'user',
        content: userText,
        ...(visionAttachments.length > 0 ? { attachments: visionAttachments } : {}),
      },
    ];
    try {
      return await this.runLoopWithHarness(messages, this.startStep);
    } catch (err) {
      // Abort (user stop / timeout) ends the run as a stop, not a crash:
      // fire the Stop hook, then rethrow so the caller still sees it.
      if (this.signal?.aborted) await this.fireStopHook('aborted');
      throw err;
    } finally {
      try {
        await this.hooks?.runSessionEnd({ reason: 'turn-end' }, hookCtx);
      } catch {
        // Hooks never throw by contract; defensive only.
      }
    }
  }

  /**
   * v0.33 (P0-1 fork-execution): run each `forkSkills` entry in its
   * own subagent (`runSubagent`) and return the prompt section the
   * parent loop appends to its system prompt — one summary per skill,
   * never the skill's raw context. Runs sequentially (at most 3
   * matched skills per run) so fork work stays bounded; each fork has
   * its own timeout + maxSteps and inherits the parent's mode
   * (plan/review stays read-only inside the fork — see `runSubagent`).
   *
   * The fork child's tools are the skill's `allowed-tools` (when it
   * declares any); an empty allowlist means the runner's full tool
   * list, same as any other subagent. The child's system prompt is
   * built from the parent prompt + the skill body as its instructions
   * (see `buildSubagentSystemPrompt`).
   *
   * Each fork is a `handoff` span (`skill:<name> (fork)`) with a
   * `forkStatus` attribute (`done` / `timeout` / `error`) and the
   * child's token usage (when the child reported any) — the span
   * itself stays `ok` on fork failure so one bad skill does not mark
   * the whole parent trace as errored. The parent never throws here:
   * a throw inside `runSubagent` is caught per skill and recorded as
   * a failure note.
   */
  private async executeForkSkills(userText: string): Promise<string> {
    const sections: string[] = [];
    for (const skill of this.forkSkills) {
      const span = this.tracer?.startSpan('handoff', `skill:${skill.name} (fork)`, {
        input: { skill: skill.name, task: userText },
        attributes: { skill: skill.name },
      });
      // v0.33 (P0-6): the fork child traces into its own tracer (same
      // run) — only its token totals come back onto the handoff span,
      // never its raw spans (see `Tracer.childTracer`).
      const childTracer = this.tracer?.childTracer();
      let status: 'done' | 'timeout' | 'error' = 'done';
      let summary = '';
      try {
        const raw = await this.runSubagent(userText, {
          instructions: skill.body,
          tools:
            skill.allowedTools && skill.allowedTools.length > 0 ? [...skill.allowedTools] : undefined,
          timeoutMs: this.forkTimeoutMs,
          maxSteps: this.forkMaxSteps,
          ...(childTracer ? { tracer: childTracer } : {}),
        });
        const done = raw.match(/^\[subagent [^\]]+\] done:\n([\s\S]*)$/);
        if (done) {
          summary = (done[1] ?? '').trim();
        } else {
          // Timeout / error strings from runSubagent ("[subagent …]
          // timeout …" / "[subagent …] lỗi: …") — keep them whole, they
          // are already short.
          status = /timeout/.test(raw) ? 'timeout' : 'error';
          summary = raw.trim();
        }
      } catch (err) {
        status = 'error';
        summary = `[subagent] lỗi: ${err instanceof Error ? err.message : String(err)}`;
      }
      // v0.33 (P0-6): fork status + the child's token usage land on the
      // handoff span (before finish, so the run totals pick them up).
      // A timed-out child reports no usage (its LLM call never returned).
      const childTotals = childTracer?.totals;
      span?.setAttributes({
        forkStatus: status,
        ...(childTotals && (childTotals.inputTokens > 0 || childTotals.outputTokens > 0)
          ? { inputTokens: childTotals.inputTokens, outputTokens: childTotals.outputTokens }
          : {}),
      });
      span?.finish(summary);
      const heading =
        status === 'done'
          ? `### Skill ${skill.name} (chạy trong subagent riêng)`
          : `### Skill ${skill.name} (chạy trong subagent riêng — ${status === 'timeout' ? 'hết giờ' : 'lỗi, bỏ qua skill này'})`;
      sections.push(`${heading}\n${summary || '(không có kết quả)'}`);
    }
    if (sections.length === 0) return '';
    return (
      `## Kết quả skill (chạy trong subagent riêng)\n` +
      `Các skill dưới đây đã chạy trong subagent riêng với context riêng; ` +
      `chỉ bản tóm tắt của chúng được đưa vào đây — làm việc với tóm tắt, không hỏi lại subagent.\n\n` +
      sections.join('\n\n')
    );
  }

  /**
   * v0.12: chạy tiếp một run từ messages đã có (checkpoint) — không thêm
   * user message mới, bắt đầu từ `startStep`. Dùng khi resume run sau khi
   * dừng/crash; các tool call đã xong trong messages không chạy lại.
   */
  async resumeFrom(messages: ChatMessage[], startStep: number): Promise<string> {
    return this.runLoopWithHarness([...messages], startStep);
  }

  /**
   * v0.54 (P1-8): time-travel replay — chạy lại một run từ messages của
   * một checkpoint cũ (vd step mà model bắt đầu quyết định sai), để debug
   * hoặc thử hướng khác. Cùng cơ chế với `resumeFrom` (tool đã xong nằm
   * trong messages nên không chạy lại); khác tên để caller nói rõ ý định
   * "quay lại quá khứ" thay vì "tiếp tục run bị dừng". Checkpoint gốc
   * không bị xoá — step chạy lại sẽ ghi đè checkpoint cùng step (upsert).
   */
  async replayFrom(messages: ChatMessage[], startStep: number): Promise<string> {
    return this.runLoopWithHarness([...messages], startStep);
  }

  /**
   * v0.54 (P1-8): yêu cầu dừng run ở biên an toàn tiếp theo (đầu step
   * sau, hoặc trước tool call tiếp theo) để hỏi user. An toàn khi gọi
   * bất cứ lúc nào, kể cả giữa provider call đang bay: loop chỉ kiểm
   * tra cờ ở biên nên không cắt ngang tool đang chạy. Checkpoint của
   * step cuối đã hoàn thành được lưu trước khi dừng, nên resume được
   * đúng điểm đó. Gọi nhiều lần cũng chỉ giữ một yêu cầu chờ.
   */
  interrupt(reason: InterruptReason = 'user-requested', question?: string): void {
    if (!this.interruptController) this.interruptController = new InterruptController();
    this.interruptController.request(reason, question);
  }

  /**
   * v0.54 (P1-8): xử lý một điểm dừng — lưu checkpoint của step cuối đã
   * hoàn thành rồi hỏi user qua `onInterrupt`. Trả về quyết định đã
   * chuẩn hoá cho `runLoop`:
   *  - `proceed`: chạy tiếp đúng điểm dừng.
   *  - `proceed-with-message`: đẩy user message mới vào history rồi chạy tiếp.
   *  - `deny-tool`: chỉ hợp lệ ở điểm before-tool — tool đó bị từ chối,
   *    run tiếp tục với kết quả "bị từ chối". Ở biên step (không có tool
   *    nào đang chờ) thì coi như hủy run (dừng an toàn hơn là đoán).
   *  - `cancel` / không có handler: dừng run (checkpoint đã lưu).
   *
   * Giới hạn đã biết: checkpoint lưu ở đây là step cuối HOÀN THÀNH
   * (`step - 1`); tool nào đã chạy xong TRONG step đang dở (trước điểm
   * before-tool) sẽ không có trong checkpoint đó — resume có thể gọi lại
   * tool đó. Đây là đánh đổi cố ý để history resume luôn nhất quán
   * (không chứa assistant message mang tool call mà thiếu kết quả).
   */
  private async handleInterrupt(input: {
    reason: InterruptReason;
    question?: string;
    step: number;
    messages: ChatMessage[];
    completedToolCalls: CheckpointToolCallRecord[];
    tokensUsed: number;
    /** Số tool result đã push trong step đang dở (0 ở biên step). */
    stepToolResults?: number;
    toolCall?: ToolCall;
  }): Promise<
    | { outcome: 'proceed' }
    | { outcome: 'proceed-with-message'; message: string }
    | { outcome: 'deny-tool' }
    | { outcome: 'cancel'; noHandler: boolean }
  > {
    const { step, messages, completedToolCalls, tokensUsed } = input;
    // Lưu checkpoint của step cuối đã hoàn thành (không lưu step đang dở
    // — history của nó chưa nhất quán, xem ghi chú trên). Cắt cả messages
    // lẫn completedToolCalls của step đang dở (số tool đã chạy trong step
    // này = stepToolResults) để checkpoint chỉ chứa step đã xong hẳn.
    if (step > this.startStep) {
      const drop = 1 + (input.stepToolResults ?? 0);
      const snapshot =
        input.toolCall && drop > 0 ? messages.slice(0, Math.max(0, messages.length - drop)) : messages;
      const completedSnapshot = input.toolCall
        ? completedToolCalls.slice(0, Math.max(0, completedToolCalls.length - (input.stepToolResults ?? 0)))
        : completedToolCalls;
      this.saveCheckpoint(step - 1, snapshot, completedSnapshot, tokensUsed);
    }
    if (!this.onInterrupt) {
      return { outcome: 'cancel', noHandler: true };
    }
    let decision: InterruptDecision;
    try {
      decision = await this.onInterrupt({
        runId: this.runId ?? '',
        botId: this.bot.id,
        stepIndex: step,
        reason: input.reason,
        ...(input.question ? { question: input.question } : {}),
        ...(input.toolCall ? { toolCall: input.toolCall } : {}),
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Handler lỗi thì dừng an toàn thay vì chạy tiếp không có ý user.
      return { outcome: 'cancel', noHandler: false };
    }
    switch (decision.action) {
      case 'continue':
        return { outcome: 'proceed' };
      case 'continue-with-message':
        return { outcome: 'proceed-with-message', message: decision.message };
      case 'deny-tool':
        return input.toolCall ? { outcome: 'deny-tool' } : { outcome: 'cancel', noHandler: false };
      case 'cancel':
        return { outcome: 'cancel', noHandler: false };
      default:
        return { outcome: 'cancel', noHandler: false };
    }
  }

  /**
   * v0.90a (Đội G): emit một event của loop lên harness (bus + NDJSON)
   * qua sink coordinator cấp. Best-effort tuyệt đối: không có sink thì
   * không làm gì; sink throw thì nuốt (loop không được hỏng vì log).
   * Payload thô đi vào đây — sanitize + cắt ngắn do
   * `LocalHarness.publishLoopEvent` làm (tool_call chỉ giữ tên tool +
   * tên key args, không value).
   */
  private emitHarness(kind: HarnessEventKind, payload: Record<string, unknown>): void {
    const sink = this.harnessSink;
    if (!sink) return;
    try {
      sink(kind, payload);
    } catch {
      // Sink lỗi không được làm hỏng run.
    }
  }

  /**
   * v0.97 (Team T3): emit one AG-UI moment through the run emitter.
   * Best-effort: no emitter = nothing happens; an emitter method
   * never throws into the loop (the emitter swallows its own errors).
   */
  private emitAgUi(fn: (emitter: AgUiRuntimeEmitter) => void): void {
    const emitter = this.agUiEmitter;
    if (!emitter) return;
    try {
      fn(emitter);
    } catch {
      // AG-UI emission never breaks a run.
    }
  }

  /**
   * v0.90a (Đội G): bọc `runLoop` để turn nào cũng có đủ 2 mốc vòng
   * đời trên harness — `turn-start` ở đầu `runLoop`, `turn-end` ở đây
   * (finally nên mọi đường thoát đều có: trả text, max-steps,
   * interrupt-cancel, approval-denied, throw). Lỗi run (trừ abort do
   * user dừng) còn ghi thêm một event `error` với message đã sanitize
   * ở tầng harness. `run()`/`resumeFrom()`/`replayFrom()` đều đi qua
   * đây nên resume/replay cũng có log đầy đủ.
   */
  private async runLoopWithHarness(messages: ChatMessage[], startStep: number): Promise<string> {
    let status: 'ok' | 'error' = 'ok';
    // v0.97 (Team T3): AG-UI run start — title from the last user
    // message (first 200 chars), tool count from this turn's tools.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const runTitle =
      typeof lastUser?.content === 'string' && lastUser.content.trim().length > 0
        ? lastUser.content.trim().slice(0, 200)
        : undefined;
    this.emitAgUi((emitter) =>
      emitter.runStarted({
        ...(runTitle !== undefined ? { title: runTitle } : {}),
        toolCount: this.tools.size,
      }),
    );
    try {
      const text = await this.runLoop(messages, startStep);
      this.emitAgUi((emitter) => emitter.runFinished('completed', text));
      return text;
    } catch (err) {
      status = 'error';
      const aborted = this.signal?.aborted === true;
      if (!aborted) {
        this.emitHarness('error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // v0.97 (Team T3): AG-UI run error + finish (aborted runs are
      // 'stopped', not 'failed').
      this.emitAgUi((emitter) =>
        emitter.runError(err instanceof Error ? err.message : String(err), {
          ...(aborted ? { aborted: true } : {}),
        }),
      );
      this.emitAgUi((emitter) => emitter.runFinished(aborted ? 'stopped' : 'failed'));
      throw err;
    } finally {
      this.emitHarness('lifecycle', { phase: 'turn-end', status });
    }
  }

  /**
   * Vòng step chung của `run()` và `resumeFrom()`: gọi provider, chạy tool,
   * lưu checkpoint + compact sau mỗi step, validate structured output ở
   * text cuối. `messages` bị sửa trực tiếp (push thêm từng step).
   *
   * v0.19 (W12a) small-model guardrail — chạy MỘT lần ở đầu hàm, trước
   * khi gọi provider lần đầu: khi model nhỏ (context ≤ 8k) thì (a) ép
   * tool filtering + grouping ở mức mạnh nhất (plan mode + grouping: chỉ
   * tool chỉ-đọc của plan hiện tại + tool giao tiếp tối thiểu, xem
   * `toolsForTurn()`), rồi (b) ước lượng token của request đầu tiên
   * (messages + tools đã ép, heuristic chars/4) — vẫn vượt context thì
   * ném `SmallModelContextError` (tiếng Việt, kèm gợi ý) và dừng run,
   * thay vì để provider trả lỗi 400 khó hiểu. Model lớn không bị ép gì.
   */
  private async runLoop(messages: ChatMessage[], startStep: number): Promise<string> {
    // v0.19: small-model guardrail — trước provider call đầu tiên.
    // v0.28: đặt lại cờ cảnh báo filter rỗng cho run này.
    // v0.51: đặt lại cờ báo cap tool theo app cho run này.
    // v0.90a (Đội G): mốc bắt đầu turn trên harness (cặp với turn-end
    // trong runLoopWithHarness).
    this.emitHarness('lifecycle', { phase: 'turn-start', step: startStep });
    this.toolFilterEmptyWarned = false;
    this.appToolCapWarned = false;
    this.applySmallModelGuard(messages);
    let lastText = '';
    let tokensUsed = 0;
    let lastInputTokens: number | undefined;
    const completedToolCalls: CheckpointToolCallRecord[] = [];
    let structuredRetries = 0;
    const maxStructuredRetries = this.structuredOutput?.maxRetries ?? 2;
    const structuredLang = this.structuredOutput?.language ?? 'vi';
    for (let step = startStep; step < this.maxSteps; step++) {
      // v0.15: kiểm tra abort mỗi step — abort xảy ra giữa hai step (vd
      // trong lúc chạy tool) thì không khởi động thêm round-trip mới.
      throwIfAborted(this.signal);
      // v0.54 (P1-8): interrupt ở biên step — dừng an toàn, lưu checkpoint
      // rồi hỏi user; user bảo tiếp tục thì chạy tiếp đúng step này.
      const pendingInterrupt = this.interruptController?.take();
      if (pendingInterrupt) {
        const outcome = await this.handleInterrupt({
          reason: pendingInterrupt.reason,
          question: pendingInterrupt.question,
          step,
          messages,
          completedToolCalls,
          tokensUsed,
        });
        if (outcome.outcome === 'cancel') {
          await this.fireStopHook('interrupted');
          return outcome.noHandler ? interruptNoHandlerText(step) : INTERRUPT_CANCELLED_TEXT;
        }
        if (outcome.outcome === 'proceed-with-message') {
          messages.push({ role: 'user', content: outcome.message });
        }
      }
      // v0.10: filter (+group) the tools visible to the model this step.
      const turnTools = this.toolsForTurn();
      this.turnTools = new Map(turnTools.map((t) => [t.definition.name, t]));
      const llmSpan = this.tracer?.startSpan('llm', 'provider.chat', {
        input: `${this.bot.model} · ${turnTools.length} tools · step ${step + 1}`,
        attributes: { model: this.bot.model, step: step + 1 },
      });
      let res: Awaited<ReturnType<Provider['chat']>>;
      try {
        res = await this.provider.chat({
          model: this.bot.model,
          messages,
          tools: turnTools.map((t) => t.definition),
          // v0.15: abort của run hủy luôn lần fetch đang chờ (provider
          // OpenAI-compatible đã nối signal; provider khác ít nhất được
          // kiểm tra hủy trước khi gọi nhờ wrapper createProvider).
          signal: this.signal,
        });
        // v0.33 (P0-6): token usage per LLM call — recorded as span
        // attributes (before finish) so the trace totals pick them up.
        if (res.usage) {
          llmSpan?.setAttributes({
            inputTokens: res.usage.inputTokens,
            outputTokens: res.usage.outputTokens,
          });
        }
        llmSpan?.finish({ text: res.text, toolCalls: res.toolCalls.length });
      } catch (err) {
        llmSpan?.fail(err);
        throw err;
      }
      if (res.usage) {
        tokensUsed += res.usage.inputTokens + res.usage.outputTokens;
        lastInputTokens = res.usage.inputTokens;
        // v0.97 (Team T3): AG-UI usage accounting for RUN_FINISHED.
        this.emitAgUi((emitter) => emitter.noteUsage(res.usage!.inputTokens, res.usage!.outputTokens));
      }
      // v0.97 (Team T3): AG-UI step marker (state delta `step`).
      this.emitAgUi((emitter) => emitter.noteStep());

      if (res.text) {
        this.events.onText(res.text);
        // v0.90a (Đội G): text cuối mỗi round vào harness log (đã cắt
        // ngắn + sanitize ở tầng harness).
        this.emitHarness('text', { text: res.text });
        // v0.97 (Team T3): AG-UI text stream — providers here are
        // non-streaming, so one content event holds the whole round
        // text, framed by start/end like a real stream.
        this.emitAgUi((emitter) => {
          emitter.textContent(res.text);
          emitter.textEnd();
        });
        lastText = res.text;
      }

      // No tool calls: the turn is done.
      if (res.toolCalls.length === 0) {
        if (res.text) {
          messages.push({ role: 'assistant', content: res.text });
        }
        // v0.12: structured output — validate text cuối; sai thì nhắc model
        // sửa rồi chạy thêm vòng (tối đa maxRetries), hết lượt thì báo lỗi.
        if (this.structuredOutput) {
          const parsed = parseStructuredOutput(res.text, this.structuredOutput.schema);
          if (parsed.ok) {
            this.saveCheckpoint(step, messages, completedToolCalls, tokensUsed);
            return await this.guardOutput(JSON.stringify(parsed.value));
          }
          if (structuredRetries < maxStructuredRetries) {
            structuredRetries++;
            messages.push({
              role: 'user',
              content: buildStructuredRetryHint(parsed.errors, structuredLang),
            });
            continue;
          }
          this.saveCheckpoint(step, messages, completedToolCalls, tokensUsed);
          return await this.guardOutput(formatStructuredError(parsed));
        }
        this.saveCheckpoint(step, messages, completedToolCalls, tokensUsed);
        return await this.guardOutput(res.text);
      }

      // Keep the assistant message WITH its toolCalls so the next round
      // can pair each tool result with the call that produced it.
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

      for (const call of res.toolCalls) {
        this.events.onToolCall(call);
        // v0.90a (Đội G): tool call vào harness log — chỉ tên tool +
        // tên key args (không value), sanitize ở tầng harness.
        this.emitHarness('tool_call', {
          callId: call.id,
          tool: call.name,
          argKeys: Object.keys(call.args ?? {}),
        });
        // v0.54 (P1-8): interrupt trước tool call — điểm dừng theo tool
        // (`interruptBeforeTools`) hoặc yêu cầu dừng từ host/UI chen vào
        // giữa các tool call của cùng một step. Tool bị từ chối thì ghi
        // kết quả "bị từ chối" vào history (model thấy và tự điều chỉnh)
        // thay vì dừng cả run; user hủy thì dừng run, checkpoint đã lưu.
        const toolInterrupt =
          this.interruptPoints.length > 0 && matchesInterruptPoint(call, this.interruptPoints)
            ? { reason: 'before-tool' as InterruptReason, question: undefined }
            : this.interruptController?.take();
        if (toolInterrupt) {
          const outcome = await this.handleInterrupt({
            reason: toolInterrupt.reason,
            question: toolInterrupt.question,
            step,
            messages,
            completedToolCalls,
            tokensUsed,
            // Kết quả tool đã push trong step này = số message `tool` ở
            // cuối messages sau assistant message của step (đếm ngược).
            stepToolResults: countTrailingToolMessages(messages),
            toolCall: call,
          });
          if (outcome.outcome === 'cancel') {
            await this.fireStopHook('interrupted');
            return outcome.noHandler ? interruptNoHandlerText(step) : INTERRUPT_CANCELLED_TEXT;
          }
          if (outcome.outcome === 'proceed-with-message') {
            messages.push({ role: 'user', content: outcome.message });
          }
          if (outcome.outcome === 'deny-tool') {
            const denied: ToolResult = {
              callId: call.id,
              ok: false,
              output: 'Tool call bị user từ chối tại điểm interrupt.',
            };
            this.events.onToolResult(denied);
            // v0.90a (Đội G): tool bị từ chối tại điểm interrupt cũng
            // vào harness log (kind approval_denied).
            this.emitHarness('approval_denied', { callId: call.id, tool: call.name });
            // v0.97 (Team T3): AG-UI tool call denied at interrupt.
            this.emitAgUi((emitter) => emitter.toolCallEnd(call.id, 'denied'));
            messages.push({ role: 'tool', content: denied.output, toolCallId: denied.callId });
            completedToolCalls.push({ call, result: denied });
            continue;
          }
        }
        // v0.97 (Team T3): AG-UI tool call start (name + arg keys only).
        this.emitAgUi((emitter) => emitter.toolCallStart(call.id, call.name, call.args ?? {}));
        const result = await this.executeCall(call);
        // Approval denied stops the whole turn immediately.
        if (result === null) {
          await this.fireStopHook('approval-denied');
          // v0.90a (Đội G): user từ chối duyệt tool → dừng turn, ghi
          // approval_denied vào harness log.
          this.emitHarness('approval_denied', { callId: call.id, tool: call.name });
          // v0.97 (Team T3): AG-UI tool call denied.
          this.emitAgUi((emitter) => emitter.toolCallEnd(call.id, 'denied'));
          return 'đã hủy';
        }
        this.events.onToolResult(result);
        // v0.90a (Đội G): kết quả tool vào harness log (output đã cắt
        // ngắn + sanitize ở tầng harness).
        this.emitHarness('result', {
          callId: result.callId,
          tool: call.name,
          ok: result.ok,
          output: result.output,
        });
        // v0.97 (Team T3): AG-UI tool call end + result preview.
        this.emitAgUi((emitter) => {
          emitter.toolCallEnd(result.callId, result.ok ? 'ok' : 'error');
          emitter.toolCallResult(result.callId, call.name, result.ok, result.output);
        });
        messages.push({
          role: 'tool',
          content: result.output,
          toolCallId: result.callId,
        });
        completedToolCalls.push({ call, result });
      }

      // v0.12: checkpoint sau mỗi step (để resume) + compaction khi context
      // vượt ngưỡng (giữ system + message gần nhất + bản tóm tắt).
      this.saveCheckpoint(step, messages, completedToolCalls, tokensUsed);
      if (this.compactionOpts?.contextLimit) {
        try {
          const compacted = await checkAndCompact(messages, this.provider, {
            model: this.bot.model,
            contextLimit: this.compactionOpts.contextLimit,
            threshold: this.compactionOpts.threshold,
            keepRecent: this.compactionOpts.keepRecent,
            summarizerModel: this.compactionOpts.summarizerModel,
            language: this.compactionOpts.language,
            tokenEstimate: lastInputTokens,
          });
          if (compacted.compacted) {
            messages.length = 0;
            messages.push(...compacted.messages);
          }
        } catch {
          // Compaction không được làm hỏng run — chạy tiếp với messages cũ.
        }
      }
    }

    // Max steps reached without a final answer: the agent stops.
    await this.fireStopHook('max-steps');
    return await this.guardOutput(lastText || 'Đã đạt giới hạn số bước mà chưa có câu trả lời cuối.');
  }

  /**
   * v0.29 (P0-2): fire the `Stop` hook (best-effort — a hook failure is
   * recorded by the runner and never breaks the run). Runs before
   * `SessionEnd`, which `run()` fires for every turn end.
   */
  private async fireStopHook(reason: string): Promise<void> {
    try {
      await this.hooks?.runStop(
        { reason },
        { botId: this.bot.id, workspaceDir: this.bot.workspaceDir },
      );
    } catch {
      // Hooks never throw by contract; defensive only.
    }
  }

  /**
   * v0.12: lưu checkpoint một step — chỉ khi runner được cấp cả memory
   * và runId. Lỗi lưu checkpoint không làm hỏng run (bỏ qua).
   */
  private saveCheckpoint(
    step: number,
    messages: ChatMessage[],
    toolCalls: CheckpointToolCallRecord[],
    tokensUsed: number,
  ): void {
    if (!this.memory || !this.runId) return;
    try {
      saveStepCheckpoint(this.memory, {
        runId: this.runId,
        botId: this.bot.id,
        stepIndex: step,
        messages,
        toolCalls,
        tokensUsed,
      });
    } catch {
      // Checkpoint là best-effort; run vẫn chạy tiếp.
    }
  }

  /**
   * v0.19 (W12a) small-model guardrail — xem comment ở `runLoop`.
   * Nguồn context limit (ưu tiên theo thứ tự): `smallModel.contextLimit`
   * tường minh → `compaction.contextLimit` (coordinator truyền
   * `contextLimitForModel`) → heuristic theo tên model. Không xác định
   * được limit mà tên cũng không ghi rõ context thì chỉ ép lọc (không
   * assert số để khỏi chặn nhầm model lớn). Bot allowlist/denylist là
   * ranh giới an ninh nên filtering bị ép vẫn tôn trọng nó (xem
   * `forcedSmallModelTools`).
   */
  private applySmallModelGuard(messages: ChatMessage[]): void {
    this.smallModelForced = false;
    if (this.smallModelOpts?.enabled === false) return;
    const contextLimit =
      this.smallModelOpts?.contextLimit ??
      this.compactionOpts?.contextLimit ??
      effectiveContextLimit(this.bot.model);
    if (!isSmallContextModel(this.bot.model, contextLimit)) return;
    // (a) Ép filtering + grouping ở mức mạnh nhất cho toàn bộ run này.
    this.smallModelForced = true;
    // (b) Ước lượng lại với tools đã ép — vẫn vượt thì dừng với lỗi rõ.
    const forcedTools = this.forcedSmallModelTools();
    assertFitsSmallModel({
      model: this.bot.model,
      contextLimit,
      estimatedTokens: estimateFirstRequestTokens(messages, forcedTools),
      toolCount: forcedTools.length,
    });
  }

  /**
   * v0.51 (M7 cap wiring): áp cap tool theo app cho turn chạy thật.
   *
   * Cap chạy TRƯỚC `filterTools` (xem `apps/toolCap.ts`): mỗi app chỉ
   * được expose tối đa N tool/turn theo thứ tự catalog (mặc định 10,
   * ghi đè qua `appToolCaps.capsByApp` — coordinator đọc từ
   * SharedAppAuthStore mỗi run). Tool không thuộc app nào giữ nguyên.
   * Không cấu hình `appToolCaps` thì trả nguyên `toolsList` (hành vi
   * cũ, không đổi gì cho host chưa nối cap). Gọi lại mỗi step vẫn rẻ
   * (O(n)) và cho cùng kết quả vì `toolsList` không đổi trong run.
   *
   * Tool bị cắt được báo rõ 1 lần/run: log `[agent-loop]` + event
   * progress cho UI (coordinator forward thành agent.event
   * `progress`).
   */
  private toolsAfterAppCap(): { tools: Tool[]; capped: AppCapReport[] } {
    if (!this.appToolCaps) return { tools: this.toolsList, capped: [] };
    const { tools, capped } = applyAppToolCaps(
      this.toolsList,
      this.appToolCaps.capsByApp ?? {},
      this.appToolCaps.registry,
    );
    if (capped.length > 0 && !this.appToolCapWarned) {
      this.appToolCapWarned = true;
      for (const report of capped) {
        const message =
          `App "${report.appId}": cap ${report.cap} tool/turn — ` +
          `chỉ gửi ${report.exposedCount} tool cho model, đã cắt ${report.droppedToolNames.length}: ` +
          `${report.droppedToolNames.join(', ')}`;
        console.warn(`[agent-loop] app tool cap: ${message}`);
        this.events.onProgress?.(message);
      }
    }
    return { tools, capped };
  }

  /**
   * v0.19 (W12a): tools ở mức lọc mạnh nhất cho model nhỏ — plan mode
   * (chỉ tool chỉ-đọc + tool giao tiếp tối thiểu) rồi gom nhóm. Giữ
   * nguyên bot allowlist/denylist (`permissions`) và skill đang bật
   * (chúng chỉ thu hẹp thêm, không nới ra). v0.28: fallback như
   * `resolveFilteredTools` (rỗng bất thường → baseline allowlist +
   * plan mode) TRƯỚC khi gom nhóm, để model nhỏ không bị mất hết tool.
   * v0.51: cap theo app chạy trước filter (qua `toolsAfterAppCap`).
   */
  private forcedSmallModelTools(): Tool[] {
    const base = this.toolsAfterAppCap().tools;
    const filtered = this.resolveFilteredTools(
      filterTools(base, {
        bot: this.bot,
        permissions: this.permissions,
        mode: 'plan',
        activeSkills: this.toolFilterOptions?.activeSkills,
      }),
      { mode: 'plan', activeSkills: this.toolFilterOptions?.activeSkills },
    );
    return groupTools(filtered);
  }

  /**
   * v0.28 (P0-4 fallback) — fail-open CÓ KIỂM SOÁT khi filter rỗng bất
   * thường: filter xong không còn tool nào trong lúc runner còn tool
   * (vd skill khai `allowed-tools` sai tên, không khớp tool nào) thì
   * model sẽ mất tool nó đang cần — thử lại chỉ với bot allowlist +
   * mode (bỏ lớp skill, lớp hay sai nhất) rồi trả list đó + log cảnh
   * báo `[agent-loop]` (1 lần/run). KHÔNG fallback vượt qua:
   *  - bot allowlist/denylist (`permissions`): ranh giới an ninh;
   *  - mode plan/review: chỉ-đọc — baseline cũng phải qua mode này.
   * Baseline vẫn rỗng (vd allowlist chỉ có tool ghi mà mode là plan)
   * thì trả rỗng (fail-closed) + cảnh báo: bot thật sự không có tool
   * cho ngữ cảnh này, gửi đủ tool như cũ sẽ phá vỡ ranh giới an toàn.
   * `filtered` non-empty hoặc runner không có tool nào → trả nguyên.
   */
  private resolveFilteredTools(
    filtered: Tool[],
    opts: { mode?: AgentMode; activeSkills?: ActiveSkillInput[] },
  ): Tool[] {
    // v0.51: baseline cũng đi qua cap theo app (cùng danh sách đã cap
    // mà `toolsForTurn`/`forcedSmallModelTools` dùng — cap không bị
    // fallback bỏ qua).
    const base = this.toolsAfterAppCap().tools;
    if (filtered.length > 0 || base.length === 0) return filtered;
    const baseline = filterTools(base, {
      bot: this.bot,
      permissions: this.permissions,
      mode: opts.mode,
    });
    if (!this.toolFilterEmptyWarned) {
      this.toolFilterEmptyWarned = true;
      if (baseline.length > 0) {
        console.warn(
          `[agent-loop] tool filter rỗng (bot=${this.bot.id} mode=${opts.mode ?? 'chat'} ` +
            `skills=${opts.activeSkills?.length ?? 0}) — fallback sang ` +
            `${baseline.length}/${base.length} tool (bot allowlist + mode), bỏ lớp skill.`,
        );
      } else {
        console.warn(
          `[agent-loop] tool filter rỗng và bot allowlist/mode cũng không giữ tool nào ` +
            `(bot=${this.bot.id} mode=${opts.mode ?? 'chat'}) — trả rỗng (fail-closed, bot không có tool cho ngữ cảnh này).`,
        );
      }
    }
    return baseline;
  }

  /**
   * v0.30 (P0-3): true khi run này đang ở mode chỉ-đọc (plan/review) —
   * nguồn mode duy nhất của loop là `toolFilter.mode` (coordinator đọc
   * `agent:mode` trong memory và truyền vào đây mỗi run). Không có
   * toolFilter thì không biết mode nên không ép gì (hành vi cũ cho host
   * dùng AgentRunner trực tiếp); production luôn đi qua coordinator nên
   * luôn có mode.
   */
  private isReadOnlyModeEnforced(): boolean {
    const mode = this.toolFilterOptions?.mode;
    return mode === 'plan' || mode === 'review';
  }

  /**
   * v0.10: tools visible to the model this turn — bot allowlist, active
   * skills, mode (plan/review = read-only), then grouping.
   *
   * v0.19 (W12a): khi small-model guard đã ép (`smallModelForced`),
   * mức lọc mạnh nhất thắng mọi cấu hình `toolFilter` — kể cả khi
   * không cấu hình `toolFilter` (trước đây là full list 119 tool).
   *
   * v0.28 (P0-4): không cấu hình `toolFilter` thì allowlist của bot
   * vẫn lọc (không policy = giữ hết, y hệt hành vi cũ) — model không
   * bao giờ thấy tool bot bị cấm. Mọi nhánh đều qua
   * `resolveFilteredTools` (fallback khi filter rỗng bất thường).
   *
   * v0.51 (M7 cap wiring): cap tool theo app chạy TRƯỚC mọi lớp lọc
   * trên — `toolsAfterAppCap()` cắt tool app vượt cap khỏi danh sách
   * gốc rồi mới tới `filterTools` (bot allowlist/skill/mode).
   */
  private toolsForTurn(): Tool[] {
    if (this.smallModelForced) return this.forcedSmallModelTools();
    const base = this.toolsAfterAppCap().tools;
    if (!this.toolFilterOptions) {
      return this.resolveFilteredTools(
        filterTools(base, { bot: this.bot, permissions: this.permissions }),
        {},
      );
    }
    const filtered = this.resolveFilteredTools(
      filterTools(base, {
        bot: this.bot,
        permissions: this.permissions,
        mode: this.toolFilterOptions.mode,
        activeSkills: this.toolFilterOptions.activeSkills,
      }),
      {
        mode: this.toolFilterOptions.mode,
        activeSkills: this.toolFilterOptions.activeSkills,
      },
    );
    return this.toolFilterOptions.group === false ? filtered : groupTools(filtered);
  }

  /**
   * v0.10: output guardrail on the final answer. A tripwire returns a
   * safe refusal; otherwise the (possibly redacted) text is returned.
   */
  private async guardOutput(text: string): Promise<string> {
    if (!this.guardrails || !text) return text;
    const span = this.tracer?.startSpan('guardrail', 'output', { input: text });
    try {
      const result = await this.guardrails.enforce(text, {
        layer: 'output',
        workspaceDir: this.bot.workspaceDir,
      });
      span?.finish();
      return result.redactedText ?? text;
    } catch (err) {
      span?.fail(err);
      if (err instanceof GuardrailTripwireError) {
        return 'Không thể hiển thị câu trả lời này: nội dung vi phạm quy tắc an toàn.';
      }
      // P0-5 fail-closed: guardrail error — never return the unchecked
      // answer; refuse safely instead.
      return 'Không thể hiển thị câu trả lời này: kiểm tra an toàn lỗi, chặn fail-closed.';
    }
  }

  /**
   * Execute one tool call. Returns null when the user denied approval —
   * the caller treats that as "stop the turn".
   *
   * v0.41 (P0-3, REA deep-dive lần 2 §3.3): every result carries
   * `startedAtMs` / `completedAtMs` (Grok `ToolCall` #59/#60) measured
   * around the whole call — hooks + permissions + approval +
   * guardrail + tool.execute — and the same two marks are recorded as
   * attributes on the tool span (the span's own `startedAt`/`endedAt`
   * come from the tracer clock; the attributes are the loop-measured
   * wall-clock marks, so they agree whenever the tracer uses the
   * default clock). `hookAdditionalContexts` (when a PreToolUse hook
   * injected context) is recorded as a span attribute count as well.
   */
  private async executeCall(call: ToolCall): Promise<ToolResult | null> {
    const span = this.tracer?.startSpan('tool', call.name, { input: call.args });
    const startedAtMs = Date.now();
    try {
      const result = await this.executeCallInner(call);
      const completedAtMs = Date.now();
      if (result === null) {
        span?.setAttributes({
          started_at_ms: startedAtMs,
          completed_at_ms: completedAtMs,
        });
        span?.block('approval-denied');
        // v0.53 (P1-7): denied calls are recorded too (status denied)
        // so a replay can show what was refused.
        this.recordToolCall(call, startedAtMs, completedAtMs, 'denied');
        return null;
      }
      result.startedAtMs = startedAtMs;
      result.completedAtMs = completedAtMs;
      // v0.53 (P1-7): record every executed call for tool_call_replay.
      this.recordToolCall(
        call,
        startedAtMs,
        completedAtMs,
        result.ok ? 'ok' : 'error',
        result.output,
      );
      span?.setAttributes({
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        ...(result.hookAdditionalContexts !== undefined
          ? { hookAdditionalContexts: result.hookAdditionalContexts.length }
          : {}),
      });
      if (result.ok) span?.finish({ output: result.output });
      else span?.fail(new Error(result.output));
      return result;
    } catch (err) {
      span?.setAttributes({
        started_at_ms: startedAtMs,
        completed_at_ms: Date.now(),
      });
      span?.fail(err);
      // v0.53 (P1-7): a throwing call is still recorded (status error)
      // before the error propagates.
      this.recordToolCall(call, startedAtMs, Date.now(), 'error');
      throw err;
    }
  }

  /**
   * v0.53 (P1-7): append one tool call to the history recorder, when
   * configured. Best-effort by design: a recorder failure (disk full,
   * bad args JSON) must never break the turn, so errors are swallowed
   * here. `args_json` is the JSON string of the call's args — the
   * replay triple's third leg.
   */
  private recordToolCall(
    call: ToolCall,
    startedAtMs: number,
    completedAtMs: number,
    status: 'ok' | 'error' | 'denied',
    output?: string,
  ): void {
    const recorder = this.toolCallRecorder;
    if (!recorder) return;
    try {
      recorder.record({
        tool_call_id: call.id,
        tool_name: call.name,
        args_json: JSON.stringify(call.args),
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        status,
        ...(output !== undefined ? { result_preview: output.slice(0, 500) } : {}),
      });
    } catch {
      // Recording must never break a turn.
    }
  }

  /**
   * Approval prompt with a tracing span (v0.10). v0.12 (interrupt_before):
   * trả về cả quyết định + args đã sửa (nếu người duyệt sửa tham số).
   */
  private async askApproval(call: ToolCall): Promise<ApprovalDecision> {
    const span = this.tracer?.startSpan('approval', call.name, { input: call.name });
    try {
      const raw = await this.events.onApprovalNeeded(call);
      const decision: ApprovalDecision =
        typeof raw === 'boolean' ? { approved: raw } : raw;
      span?.finish({ approved: decision.approved });
      return decision;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  /**
   * v0.35 (P1-7): kiểm tra rule auto-approve cho một tool call sắp phải
   * hỏi duyệt. Khớp thì trả về rule (caller chạy tool ngay, KHÔNG gọi
   * askApproval) và ghi rõ vào log + trace (span `approval` với
   * attributes `autoApproved: true`, `ruleId`) để người dùng xem lại
   * được "lệnh này đã tự duyệt theo rule nào". Không khớp (hoặc không
   * cấu hình callback) thì trả về undefined — caller hỏi duyệt tay như
   * cũ. Chỉ ghi log khi khớp: tool call không khớp không spam log.
   */
  private tryAutoApprove(call: ToolCall): AutoApproveRule | undefined {
    // v0.86 (P2-10): elevate KHÔNG BAO GIỜ tự duyệt — lớp phòng thủ
    // thứ ba sau validate + match trong `approval/rules.ts` (kể cả khi
    // autoApproveCheck là callback ngoài tự viết, không qua store).
    if (call.name === ELEVATED_TOOL_NAME) return undefined;
    if (!this.autoApproveCheck) return undefined;
    const rule = this.autoApproveCheck({
      botId: this.bot.id,
      toolName: call.name,
      args: call.args,
      workspaceDir: this.bot.workspaceDir,
    });
    if (!rule) return undefined;
    const span = this.tracer?.startSpan('approval', call.name, {
      input: call.name,
      attributes: { autoApproved: true, ruleId: rule.id },
    });
    span?.finish({ approved: true });
    const what =
      rule.kind === 'shell'
        ? `lệnh "${rule.pattern ?? ''}"`
        : `tool "${rule.tool ?? ''}"`;
    console.info(
      `[auto-approve] bot="${this.bot.id}" tool="${call.name}" rule="${rule.id}" ` +
        `(${what}, scope=${rule.scope}) — tự duyệt thay vì hỏi người dùng.`,
    );
    return rule;
  }

  /**
   * v0.12 (interrupt_before): áp args đã sửa từ phê duyệt. Người duyệt tự
   * sửa args nên không hỏi lại — chỉ chặn cứng khi args mới vi phạm
   * denylist (vd sửa thành `rm -rf /`), còn 'ask' thì cho qua vì user đã
   * là người sửa. `deniedReason` có giá trị thì caller trả kết quả từ
   * chối thay vì chạy tool.
   */
  private applyEditedArgs(
    call: ToolCall,
    decision: ApprovalDecision,
  ): { applied: boolean; deniedReason?: string } {
    if (!decision.approved || !decision.args || typeof decision.args !== 'object') {
      return { applied: false };
    }
    if (this.permissions) {
      const recheck = this.permissions.checkToolCall(this.bot.id, call.name, decision.args, {
        workspaceDir: this.bot.workspaceDir,
      });
      if (!recheck.allowed) {
        return { applied: false, deniedReason: recheck.reason };
      }
    }
    call.args = decision.args;
    return { applied: true };
  }

  private async executeCallInner(call: ToolCall): Promise<ToolResult | null> {
    // v0.30 (P0-3): plan/review mode ép chỉ-đọc NGAY TRONG LOOP —
    // fail-closed, không phụ thuộc system prompt hay hook. Tool filter
    // (toolsForTurn) chỉ giấu tool ghi khỏi model, nhưng executeCallInner
    // trước đây fallback về full tool map nên model gọi đúng tên vẫn chạy
    // được (coordinator.ts đã ghi chú lỗ này ở prompt plan mode). Chặn ở
    // đây, TRƯỚC cả hook và approval: tool ghi/shell không bao giờ chạy
    // và không hiện thẻ duyệt vô ích. Không dùng hook PreToolUse cho việc
    // này: hook do host đăng ký (coordinator sở hữu HookRunner), hook
    // thiếu/sai cấu hình sẽ âm thầm bỏ chặn; chặn trong loop thì mode
    // plan luôn ép chỉ đọc dù host cấu hình hook ra sao.
    // Cho qua: tool đã lộ trong turnTools (đã lọc theo mode — dispatcher
    // gom nhóm chỉ chứa thành viên chỉ-đọc nên operation ghi tự bị
    // dispatcher từ chối), tool chỉ-đọc gọi bằng tên gốc (mock/direct
    // call), tool giao tiếp thiết yếu và builtin điều khiển của loop
    // (stop_agent: chỉ dừng agent con, không ghi gì).
    if (this.isReadOnlyModeEnforced()) {
      const allowed =
        this.turnTools.has(call.name) ||
        isReadOnlyTool(call.name) ||
        ESSENTIAL_TOOLS.has(call.name) ||
        PLAN_MODE_BUILTIN_TOOLS.has(call.name);
      if (!allowed) {
        return {
          callId: call.id,
          ok: false,
          output:
            `Bị chặn ở chế độ ${this.toolFilterOptions?.mode ?? 'plan'} (chỉ đọc): ` +
            `tool "${call.name}" là tool ghi/thực thi, không được gọi khi chưa duyệt plan. ` +
            `Hãy dùng tool chỉ-đọc để khảo sát, rồi nộp plan bằng plan_create để người dùng duyệt.`,
        };
      }
    }
    // v0.10: prefer this step's filtered/grouped tools; fall back to the
    // full map (mock providers and direct calls may still use original names).
    const tool = this.turnTools.get(call.name) ?? this.tools.get(call.name);
    if (!tool) {
      return { callId: call.id, ok: false, output: `Không rõ công cụ: ${call.name}` };
    }
    // v0.29 (P0-2): PreToolUse hooks run FIRST — before permissions and
    // before any approval prompt — so a deterministic block (e.g. the
    // sandbox denylist on `rm -rf /`) never needs a human click, and the
    // user is never asked to approve a call that is already forbidden.
    // A `modify` rewrites `call.args`, so permissions, approval, the
    // guardrail and the tool itself all see the rewritten args.
    const hookCtx: HookContext = {
      botId: this.bot.id,
      workspaceDir: this.bot.workspaceDir,
    };
    // v0.41 (P0-3 — `hook_additional_contexts`): context lines PreToolUse
    // hooks inject into this tool call, in hook-run order. Passed to the
    // tool via ToolContext below and attached to the ToolResult so the
    // trace + checkpoints carry them.
    let additionalContexts: string[] = [];
    if (this.hooks) {
      const pre = await this.hooks.runPreToolUse(
        { toolName: call.name, toolCallId: call.id, args: call.args },
        hookCtx,
      );
      additionalContexts = pre.additionalContexts;
      if (pre.decision === 'block') {
        return {
          callId: call.id,
          ok: false,
          output: pre.reason ?? `Bị chặn bởi hook: ${pre.blockedBy ?? 'PreToolUse'}.`,
          ...(additionalContexts.length > 0
            ? { hookAdditionalContexts: additionalContexts }
            : {}),
        };
      }
      call.args = pre.args;
    }
    // v0.6: per-bot tool permissions — deny wins, 'ask' prompts once here
    // (tools with needsApproval already prompt below, so they are skipped
    // here to avoid asking the user twice for the same call).
    // v0.11: truyền cả `args` + `workspaceDir` để rule engine (v0.11c)
    // phân loại được lệnh shell (safe chạy ngay, sensitive hỏi, blocked
    // từ chối) và phát hiện ghi file ra ngoài workspace.
    //
    // v0.50 (M8): hai nhánh hỏi duyệt cũ (policy `ask` / `needsApproval`)
    // gộp thành MỘT quyết định `shouldAskForCall` — mức approval của bot
    // và quy tắc self-read cùng áp ở đây:
    //  - bot đọc file của chính nó (self-read) → không bao giờ hỏi;
    //  - `auto-approve-safe` + tool chỉ-đọc → không hỏi (kể cả policy ask);
    //  - `ask-always` → hỏi cả tool chỉ-đọc bình thường (loop chưa định hỏi);
    //  - mặc định (`ask-for-writes`) → giữ nguyên hành vi cũ.
    // Denylist / hook / guardrail đã chặn trước đó nên mức không bao giờ
    // nới lỏng một lệnh cấm; rule auto-approve tường minh vẫn thắng thẻ
    // (như cũ) vì đó là opt-in tường minh của người dùng.
    let policyAsk = false;
    if (this.permissions) {
      const check = this.permissions.checkToolCall(this.bot.id, call.name, call.args, {
        workspaceDir: this.bot.workspaceDir,
      });
      if (!check.allowed) {
        return { callId: call.id, ok: false, output: check.reason };
      }
      policyAsk = check.policy === 'ask' && !tool.needsApproval;
    }
    const askedByPolicyOrNeedsApproval = policyAsk || tool.needsApproval;
    // v0.86 (P2-10): elevate LUÔN hỏi duyệt — kể cả khi bot bật
    // autoApprove (cờ đó bỏ qua thẻ duyệt cho mọi tool khác, nhưng
    // nâng quyền thì không bao giờ được duyệt lặng lẽ). `tryAutoApprove`
    // + `matchAutoApproveRule` cũng đã chặn elevate ở dưới, đây là lớp
    // chặn cờ bot-level.
    const elevateAlwaysAsk = call.name === ELEVATED_TOOL_NAME;
    if (
      (!this.bot.autoApprove || elevateAlwaysAsk) &&
      (askedByPolicyOrNeedsApproval || this.approvalLevel === 'ask-always')
    ) {
      const ask = shouldAskForCall({
        level: this.approvalLevel,
        askedByPolicyOrNeedsApproval,
        isReadOnly: isReadOnlyTool(call.name),
        isSelfRead: isSelfReadCall(call.name, call.args, this.bot.workspaceDir),
      });
      if (ask) {
        // v0.35 (P1-7): rule auto-approve khớp thì chạy ngay, không hỏi.
        if (this.tryAutoApprove(call) === undefined) {
          const decision = await this.askApproval(call);
          if (!decision.approved) return null;
          const edited = this.applyEditedArgs(call, decision);
          if (edited.deniedReason) {
            return { callId: call.id, ok: false, output: edited.deniedReason };
          }
        }
      }
    }
    // Built-in subagent/user-messaging calls (v0.2) are answered by the
    // loop itself from AgentEvents / the subagent registry, so they work
    // even when the tool objects were created without event callbacks.
    const builtin = await this.handleBuiltInCall(call);
    if (builtin !== null) return builtin;
    const args: Record<string, unknown> = call.args;
    // v0.10: tool-layer guardrail (path escape, secret/injection in args).
    if (this.guardrails) {
      try {
        await this.guardrails.enforce(args, {
          layer: 'tool',
          toolName: call.name,
          workspaceDir: this.bot.workspaceDir,
        });
      } catch (err) {
        if (err instanceof GuardrailTripwireError) {
          return {
            callId: call.id,
            ok: false,
            output: `Bị chặn bởi guardrail: ${err.violations.map((v) => v.reason).join('; ')}`,
          };
        }
        // P0-5 fail-closed: guardrail error — block just this tool call
        // (never run it unchecked); the model sees the error and can
        // continue the turn.
        return {
          callId: call.id,
          ok: false,
          output: 'Bị chặn bởi guardrail: kiểm tra guardrail lỗi, không chạy tool (fail-closed).',
        };
      }
    }
    try {
      const output = await tool.execute(args, {
        workspaceDir: this.bot.workspaceDir,
        botId: this.bot.id,
        signal: this.signal,
        runSubagent: (task, opts) => this.runSubagent(task, opts),
        runSpecializedSubagents: (tasks) => this.runSpecializedSubagents(tasks),
        subagentStatus: () => this.subagentStatus(),
        // v0.41 (P0-3): hook-injected context for this tool call.
        ...(additionalContexts.length > 0 ? { additionalContexts } : {}),
      });
      // v0.10: PostToolUse hooks (may rewrite the output or block the result).
      if (this.hooks) {
        const post = await this.hooks.runPostToolUse(
          { toolName: call.name, toolCallId: call.id, args, result: { ok: true, output } },
          hookCtx,
        );
        return {
          callId: call.id,
          ok: post.ok,
          output: post.output,
          ...(additionalContexts.length > 0
            ? { hookAdditionalContexts: additionalContexts }
            : {}),
        };
      }
      return {
        callId: call.id,
        ok: true,
        output,
        ...(additionalContexts.length > 0
          ? { hookAdditionalContexts: additionalContexts }
          : {}),
      };
    } catch (err) {
      return {
        callId: call.id,
        ok: false,
        output: `Lỗi khi chạy ${call.name}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Handle the v0.2 built-in calls that need the loop's AgentEvents or
   * subagent registry. Returns null for any other tool name (caller then
   * runs the tool normally). Approval, when required, was already checked
   * by executeCall before this runs.
   */
  private async handleBuiltInCall(call: ToolCall): Promise<ToolResult | null> {
    const argString = (name: string): string => {
      const v = call.args[name];
      return typeof v === 'string' ? v : '';
    };
    switch (call.name) {
      case 'ask_user': {
        if (!this.events.onAskUser) {
          return {
            callId: call.id,
            ok: false,
            output:
              'Error: chưa hỗ trợ hỏi người dùng trong phiên này (events.onAskUser chưa được cấu hình).',
          };
        }
        const question = argString('question');
        if (!question) {
          return { callId: call.id, ok: false, output: 'Error: ask_user cần argument "question".' };
        }
        const rawOptions = call.args['options'];
        const options = Array.isArray(rawOptions)
          ? rawOptions.filter((o): o is string => typeof o === 'string')
          : undefined;
        const answer = await this.events.onAskUser(question, options);
        return { callId: call.id, ok: true, output: answer };
      }
      case 'send_message_to_user': {
        const message = argString('message');
        this.events.onText(message);
        return { callId: call.id, ok: true, output: 'Đã gửi message cho người dùng.' };
      }
      case 'send_progress_update': {
        const message = argString('message');
        if (this.events.onProgress) this.events.onProgress(message);
        else this.events.onText(`[tiến độ] ${message}`);
        return { callId: call.id, ok: true, output: 'Đã gửi cập nhật tiến độ.' };
      }
      case 'send_final_summary': {
        const summary = argString('summary');
        if (this.events.onFinalSummary) this.events.onFinalSummary(summary);
        else this.events.onText(summary);
        return { callId: call.id, ok: true, output: 'Đã gửi tóm tắt cuối.' };
      }
      case 'stop_agent': {
        const id = argString('agentId') || argString('id');
        const entry = this.subagents.get(id);
        if (!entry) {
          return {
            callId: call.id,
            ok: false,
            output: `Error: không thấy agent con với id "${id}".`,
          };
        }
        if (entry.status !== 'running') {
          return {
            callId: call.id,
            ok: false,
            output: `Error: agent "${id}" đã kết thúc (trạng thái: ${entry.status}), không thể dừng.`,
          };
        }
        entry.controller.abort();
        entry.status = 'stopped';
        return { callId: call.id, ok: true, output: `Đã dừng agent con "${id}".` };
      }
      default:
        return null;
    }
  }

  /** Snapshot of subagents spawned by this runner: [{ id, status }]. */
  private subagentStatus(): Array<{ id: string; status: string }> {
    return [...this.subagents.values()].map(({ id, status }) => ({ id, status }));
  }

  /**
   * v0.12: chạy nhiều subagent chuyên biệt song song rồi gộp kết quả
   * (xem `agent/subagent.ts`). Mỗi task có spec riêng (tên, instructions,
   * subset tool, model, timeout). Lỗi/timeout của một subagent không kéo
   * sập cả nhóm — kết quả gộp ghi rõ trạng thái từng cái + xung đột (nếu
   * có) để bot cha phân xử. Dùng qua `ctx.runSpecializedSubagents`.
   */
  async runSpecializedSubagents(
    tasks: Array<{ spec: SubagentOptions & { name: string }; task: string }>,
  ): Promise<string> {
    const normalized: SpecializedSubagentTask[] = tasks.map((t) => ({
      spec: {
        name: t.spec.name,
        instructions: t.spec.instructions ?? '',
        tools: t.spec.tools,
        model: t.spec.model,
        timeoutMs: t.spec.timeoutMs,
        maxSteps: t.spec.maxSteps,
        role: t.spec.role,
        shadowWorkspace: t.spec.shadowWorkspace,
      },
      task: t.task,
    }));
    const results = await runSpecializedSubagentsParallel(async ({ spec, task }) => {
      const text = await this.runSubagent(task, {
        instructions: spec.instructions,
        tools: spec.tools,
        model: spec.model,
        timeoutMs: spec.timeoutMs,
        maxSteps: spec.maxSteps,
        role: spec.role,
        shadowWorkspace: spec.shadowWorkspace,
      });
      // runSubagent bọc kết quả bằng "[subagent <id>] done|timeout|lỗi: ..." —
      // gỡ tiền tố để gộp sạch, đồng thời giữ đúng trạng thái từng subagent.
      const done = text.match(/^\[subagent [^\]]+\] done:\n([\s\S]*)$/);
      if (done) return done[1] ?? '';
      if (/^\[subagent [^\]]+\] timeout/.test(text)) {
        return { name: spec.name, status: 'timeout' as const, output: '', durationMs: 0, error: text };
      }
      return { name: spec.name, status: 'error' as const, output: '', durationMs: 0, error: text };
    }, normalized);
    return mergeParallelResults(results).text;
  }

  /**
   * Run a child AgentRunner in the same process with the same provider
   * and tools, await its final text (with a timeout), and return a short
   * summary. The child runs as a background sub-task of this turn; its
   * text still flows through the shared events. Aborting the parent turn
   * (or the timeout) aborts the child via AbortSignal.
   *
   * v0.12 (subagent chuyên biệt): `opts` nhận thêm `instructions`
   * (system prompt riêng), `tools` (subset theo tên), `model` riêng và
   * `maxSteps` riêng — xem `agent/subagent.ts`.
   * v0.37 (P1-4): `opts.role` chọn role built-in/custom (xem
   * `subagents/roles.ts`): con dùng system prompt + tool allowlist +
   * giới hạn của role, giao với tool cha. Role lạ → trả chuỗi lỗi rõ
   * ràng, không spawn con.
   */
  private async runSubagent(task: string, opts?: SubagentOptions): Promise<string> {
    const id = randomUUID();
    const controller = new AbortController();
    const entry: SubagentEntry = { id, status: 'running', controller };
    this.subagents.set(id, entry);
    // v0.37 (P1-4): role subagent chuyên biệt — resolve TRƯỚC khi tạo
    // agent con. Role không tồn tại / giao tool rỗng → lỗi rõ ràng, không
    // spawn con, không fallback lặng lẽ về subagent chung.
    let roleName: string | undefined;
    let roleInstructions: string | undefined;
    /** Tool con được phép (undefined = không giới hạn thêm, kế thừa cha). */
    let roleTools: string[] | undefined;
    let roleModel: string | undefined;
    let roleMaxSteps: number | undefined;
    let roleTimeoutMs: number | undefined;
    if (opts?.role) {
      try {
        const resolved = this.roleRegistry.resolveRoleOptions(
          opts.role,
          this.toolsList.map((t) => t.definition.name),
          {
            ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
          },
        );
        roleName = resolved.role.id;
        roleInstructions = resolved.instructions;
        roleTools = resolved.tools;
        roleModel = resolved.model;
        roleMaxSteps = resolved.maxSteps;
        roleTimeoutMs = resolved.timeoutMs;
      } catch (err) {
        entry.status = 'error';
        return `[subagent ${id}] lỗi: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const timeoutMs = roleTimeoutMs ?? opts?.timeoutMs ?? 120_000;
    const onParentAbort = (): void => controller.abort();
    if (this.signal) {
      if (this.signal.aborted) controller.abort();
      else this.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const childBot: BotConfig = { ...this.bot };
    if (roleModel ?? opts?.model) childBot.model = (roleModel ?? opts?.model) as string;
    // v0.14: shadow workspace — subagent làm việc trong git worktree
    // riêng, không đụng workspace chính. Không phải git repo (hoặc tạo
    // worktree lỗi) thì chạy ở workspace chính và ghi chú vào kết quả.
    let shadow: Awaited<ReturnType<typeof createShadow>> | null = null;
    let shadowNote = '';
    if (opts?.shadowWorkspace === true) {
      try {
        shadow = await createShadow(this.bot.workspaceDir);
        childBot.workspaceDir = shadow.worktree.path;
      } catch (err) {
        shadowNote =
          `Shadow workspace không tạo được — chạy ở workspace chính: ` +
          `${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // v0.37 (P1-4): khi có role, instructions = systemPrompt role (+
    // instructions gọi trực tiếp nối sau); tên subagent là id role để
    // log/trace đọc được là chuyên gia nào đang chạy.
    const effectiveInstructions = roleInstructions ?? opts?.instructions;
    if (effectiveInstructions) {
      childBot.systemPrompt = buildSubagentSystemPrompt(
        {
          name: roleName ?? 'subagent',
          instructions: effectiveInstructions,
          tools: roleTools ?? opts?.tools,
          model: roleModel ?? opts?.model,
          timeoutMs,
          maxSteps: roleMaxSteps ?? opts?.maxSteps,
        },
        this.bot.systemPrompt,
      );
    }
    // v0.37: tool con = giao (cha ∩ role ∩ gọi trực tiếp) — roleTools đã
    // giao xong trong registry; undefined = không giới hạn thêm.
    const toolsRestricted =
      roleTools !== undefined || (opts?.tools !== undefined && opts.tools.length > 0);
    const childTools = toolsRestricted
      ? this.toolsList.filter((t) => (roleTools ?? opts?.tools ?? []).includes(t.definition.name))
      : this.toolsList;
    const child = new AgentRunner(this.provider, childTools, {
      bot: childBot,
      events: this.events,
      maxSteps: roleMaxSteps ?? opts?.maxSteps ?? this.maxSteps,
      signal: controller.signal,
      // v0.33 (P0-1 fork-execution): every child runs one fork level
      // deeper, so a fork subagent never forks again (see `run()`).
      forkDepth: this.forkDepth + 1,
      // v0.37 (P1-4): con kế thừa registry role của cha (kể cả role
      // custom) để subagent lồng nhau vẫn gọi được cùng role.
      roleRegistry: this.roleRegistry,
      // v0.33 (P0-6): only a fork skill passes a tracer — its spans
      // join the parent run's trace. Other subagents (delegate, …)
      // pass nothing and stay untraced, as before.
      ...(opts?.tracer ? { tracer: opts.tracer } : {}),
      // v0.30 (P0-3): subagent kế thừa mode của bot cha — ở plan mode con
      // cũng chỉ đọc, không lách qua tool filter của run cha bằng cách
      // spawn agent con rồi cho con ghi file/chạy shell thay mình.
      // v0.33: khi subagent đã có tool list riêng (fork skill
      // `allowed-tools`, subagent chuyên biệt) thì KHÔNG kế thừa lớp
      // skill của cha — hợp `allowedTools` của skill inline của cha
      // (vd code-review) sẽ xoá hết tool của con (vd web_search của
      // skill fork research-brief). Mode chỉ-đọc vẫn kế thừa (ranh
      // giới an toàn), và khi con không khai tool riêng thì mọi lớp
      // filter của cha vẫn áp như cũ.
      // v0.37: role đã có tool list riêng thì KHÔNG kế thừa lớp skill
      // của cha (như fork skill / subagent chuyên biệt) — toolFilter
      // inheritance chỉ áp khi con không bị giới hạn tool.
      ...(this.toolFilterOptions
        ? {
            toolFilter: {
              mode: this.toolFilterOptions.mode,
              ...(toolsRestricted
                ? {}
                : { activeSkills: this.toolFilterOptions.activeSkills }),
            },
          }
        : {}),
    });
    // Attach a no-op catch now so a late child rejection (e.g. after a
    // timeout already resolved the race) never becomes unhandled.
    const childPromise = child.run(task);
    childPromise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        childPromise.then((text) => ({ kind: 'done' as const, text })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ kind: 'timeout' as const });
          }, timeoutMs);
        }),
      ]);
      if (outcome.kind === 'timeout') {
        entry.status = 'timeout';
        return `[subagent ${id}] timeout sau ${timeoutMs}ms — đã dừng agent con, kết quả chưa hoàn tất.${shadowNote ? ` (${shadowNote})` : ''}`;
      }
      entry.status = 'done';
      // Giữ đúng tiền tố `done:\n` để runSpecializedSubagents parse được;
      // ghi chú shadow (nếu có) thành dòng đầu của output.
      return `[subagent ${id}] done:\n${shadowNote ? `[Lưu ý: ${shadowNote}]\n` : ''}${truncate(outcome.text, MAX_SUBAGENT_SUMMARY_CHARS)}`;
    } catch (err) {
      entry.status = controller.signal.aborted ? 'stopped' : 'error';
      return `[subagent ${id}] lỗi: ${err instanceof Error ? err.message : String(err)}${shadowNote ? ` (${shadowNote})` : ''}`;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.signal?.removeEventListener('abort', onParentAbort);
      // Dọn worktree sau khi subagent xong (kể cả timeout/lỗi) — không
      // để worktree mồ côi trong repo.
      if (shadow) {
        await shadow.dispose().catch(() => undefined);
      }
    }
  }
}
