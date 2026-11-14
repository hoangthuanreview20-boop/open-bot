/**
 * RunLogRecorder — API cao cấp ghi run log cho loop/coordinator
 * (v1.01, Đội T1).
 *
 * Một recorder gắn với MỘT run (một runId). Coordinator tạo một
 * recorder khi run bắt đầu, truyền sink/gate của nó vào AgentRunner
 * qua options (`runLogSink`, `runLogGate`), rồi gọi `complete` /
 * `fail` / `abort` khi run kết thúc. Recorder tự đếm step/tool call/
 * token để ghi event kết thúc đúng số liệu.
 *
 * Mọi phương thức đều best-effort: ghi log lỗi KHÔNG BAO GIỜ throw
 * vào run (nuốt lỗi, đếm vào `droppedEvents`). Đây là hợp đồng bắt
 * buộc — log là quan sát viên, không phải một bước của run.
 *
 * Suy luận event phụ sống ở MỘT chỗ — `noteEvent()`, chạy sau mỗi
 * lần `record()` thành công:
 * - `model.response` → cập nhật step/token.
 * - `tool.call` → đếm tool call, nhớ lại call để suy ra kết quả sau.
 * - `tool.result` → tool ghi file + ok thì thêm `file.change`;
 *   tool build/compile + lỗi thì thêm `compile.error`.
 * Nhờ đó loop chỉ cần gọi sink `record()` thô, còn `recordToolCall` /
 * `recordToolResult` cũng chỉ là wrapper mỏng qua `record()` — không
 * có hai nơi suy luận trùng nhau.
 */

import { forkRun, pauseRun, resumeRun, RunControlRegistry, RunPauseGate } from './control';
import type { ForkRunResult, PauseResumeResult } from './control';
import { extractFirstError, fileChangeKindForTool, isBuildToolCall, isFileWriteTool, RUN_LOG_OUTPUT_LIMIT, sanitizeRunLogString } from './sanitize';
import type { RunLogStore } from './store';
import type {
  AnyRunEvent,
  FileChangePayload,
  ModelResponsePayload,
  RunEndPayload,
  RunEventType,
  RunStartedPayload,
  ToolCallPayload,
  ToolResultPayload,
} from './types';

export interface RunLogRecorderOptions {
  runId: string;
  botId: string;
  store: RunLogStore;
  /** Registry gate dùng chung (coordinator cấp) — mặc định tự tạo riêng. */
  registry?: RunControlRegistry;
  /** Model/provider đã route cho run. */
  model?: string;
  providerId?: string;
  /** Số step tối đa của run. */
  maxSteps?: number;
  /** Tiêu đề ngắn của run. */
  title?: string;
}

/** Sink tối thiểu mà AgentRunner gọi (tương tự `harnessSink`). */
export interface RunLogSink {
  /** Ghi một event (đã sanitize + hash chain ở store). Không throw. */
  record<T extends RunEventType>(type: T, payload: AnyRunEvent['payload']): void;
  /** RunId của recorder này. */
  readonly runId: string;
}

/** Gói trả về cho loop: sink ghi event + gate chờ pause. */
export interface LoopRunLogWiring {
  sink: RunLogSink;
  gate: RunPauseGate;
}

/** Tool call mà recorder đã thấy (để suy ra file.change/compile.error từ result). */
interface SeenToolCall {
  tool: string;
  argKeys: string[];
  step: number;
  startedAtMs: number;
  /** Đường dẫn file từ args (nếu tool ghi file và args có key path/file). */
  path?: string;
}

export class RunLogRecorder {
  readonly runId: string;
  readonly botId: string;
  private readonly store: RunLogStore;
  private readonly registry: RunControlRegistry;
  private readonly gate: RunPauseGate;
  private readonly startedAtMs = Date.now();
  private step = 0;
  private toolCalls = 0;
  private tokensUsed = 0;
  private ended = false;
  private readonly seenCalls = new Map<string, SeenToolCall>();
  /** Số event đã nuốt lỗi (đĩa lỗi, store lỗi, …). */
  droppedEvents = 0;

  constructor(options: RunLogRecorderOptions) {
    this.runId = options.runId;
    this.botId = options.botId;
    this.store = options.store;
    this.registry = options.registry ?? new RunControlRegistry();
    this.gate = this.registry.getOrCreate(this.runId);
    const started: RunStartedPayload = {
      botId: this.botId,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
    };
    this.record('run.started', started);
  }

  /** Sink + gate để truyền vào `AgentRunnerOptions`. */
  asLoopSink(): LoopRunLogWiring {
    const sink: RunLogSink = {
      runId: this.runId,
      record: (type, payload) => {
        this.record(type, payload);
      },
    };
    return { sink, gate: this.gate };
  }

  /** Gate pause của run này (UI/CLI dùng để pause/resume/abort). */
  get pauseGate(): RunPauseGate {
    return this.gate;
  }

  /** Ghi một event bất kỳ. Không throw — lỗi được nuốt + đếm. */
  record<T extends RunEventType>(type: T, payload: AnyRunEvent['payload']): AnyRunEvent | null {
    let event: AnyRunEvent | null;
    try {
      event = this.store.append(this.runId, { type, payload: payload as never });
    } catch {
      this.droppedEvents += 1;
      return null;
    }
    this.noteEvent(type, payload);
    return event;
  }

  /**
   * Cập nhật bộ đếm + suy ra event phụ sau mỗi lần ghi thành công.
   * Chỉ chạy cho event vừa ghi — không đọc lại file.
   */
  private noteEvent(type: RunEventType, payload: AnyRunEvent['payload']): void {
    if (type === 'model.response') {
      const p = payload as ModelResponsePayload;
      this.step = Math.max(this.step, p.step);
      this.tokensUsed += (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
      return;
    }
    if (type === 'tool.call') {
      const p = payload as ToolCallPayload;
      this.toolCalls += 1;
      this.seenCalls.set(p.callId, {
        tool: p.tool,
        argKeys: [...p.argKeys],
        step: p.step,
        startedAtMs: Date.now(),
        ...(p.path !== undefined ? { path: p.path } : {}),
      });
      return;
    }
    if (type === 'tool.result') {
      const p = payload as ToolResultPayload;
      const seen = this.seenCalls.get(p.callId);
      this.seenCalls.delete(p.callId);
      if (p.status === 'ok' && isFileWriteTool(p.tool)) {
        const changePath = seen?.path ?? extractPathFromOutput(p.outputPreview) ?? '';
        const change: FileChangePayload = {
          kind: fileChangeKindForTool(p.tool),
          path: sanitizeRunLogString(changePath, 500),
          tool: p.tool,
          callId: p.callId,
        };
        this.record('file.change', change);
      }
      if (p.status === 'error' && isBuildToolCall(p.tool, seen?.argKeys ?? [])) {
        const { firstError, errorCount } = extractFirstError(p.outputPreview);
        this.record('compile.error', {
          command: p.tool,
          tool: p.tool,
          callId: p.callId,
          firstError: sanitizeRunLogString(firstError, RUN_LOG_OUTPUT_LIMIT),
          ...(errorCount !== undefined ? { errorCount } : {}),
        });
      }
    }
  }

  /** Ghi prompt của user (đầu run). */
  recordPrompt(text: string, historyMessages?: number, hasAttachments?: boolean): void {
    this.record('run.prompt', {
      text: sanitizeRunLogString(text),
      ...(historyMessages !== undefined ? { historyMessages } : {}),
      ...(hasAttachments !== undefined ? { hasAttachments } : {}),
    });
  }

  /**
   * Ghi response của model ở một step (tool call trong response chỉ
   * mang tên tool + tên key args — sanitize ở store).
   */
  recordModelResponse(input: {
    step: number;
    text: string;
    toolCalls: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  }): void {
    const payload: ModelResponsePayload = {
      step: input.step,
      text: sanitizeRunLogString(input.text),
      toolCalls: input.toolCalls.map((c) => ({
        callId: c.id,
        tool: c.name,
        argKeys: Object.keys(c.args ?? {}).sort(),
      })),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    };
    this.record('model.response', payload);
  }

  /** Ghi một tool call bắt đầu chạy (kèm path file nếu biết). */
  recordToolCall(input: {
    callId: string;
    tool: string;
    args?: Record<string, unknown>;
    step: number;
    path?: string;
  }): void {
    this.record('tool.call', {
      callId: input.callId,
      tool: input.tool,
      argKeys: Object.keys(input.args ?? {}).sort(),
      step: input.step,
      ...(input.path !== undefined ? { path: input.path } : {}),
    });
  }

  /**
   * Ghi kết quả một tool call. `durationMs` tính từ lúc `tool.call`
   * được thấy (nếu có), không thì lấy từ input.
   */
  recordToolResult(input: {
    callId: string;
    tool: string;
    status: 'ok' | 'error' | 'denied';
    output: string;
    step: number;
    durationMs?: number;
  }): void {
    const seen = this.seenCalls.get(input.callId);
    const durationMs =
      input.durationMs ?? (seen ? Math.max(0, Date.now() - seen.startedAtMs) : 0);
    this.record('tool.result', {
      callId: input.callId,
      tool: input.tool,
      status: input.status,
      outputPreview: sanitizeRunLogString(input.output, RUN_LOG_OUTPUT_LIMIT),
      durationMs,
      step: seen?.step ?? input.step,
    });
  }

  /** Ghi một thay đổi file trực tiếp (khi host đã biết path chắc chắn). */
  recordFileChange(change: FileChangePayload): void {
    this.record('file.change', change);
  }

  /** Ghi một lỗi biên dịch trực tiếp (khi host đã parse sẵn). */
  recordCompileError(input: { command: string; tool: string; callId: string; firstError: string; errorCount?: number }): void {
    this.record('compile.error', {
      command: input.command,
      tool: input.tool,
      callId: input.callId,
      firstError: sanitizeRunLogString(input.firstError, RUN_LOG_OUTPUT_LIMIT),
      ...(input.errorCount !== undefined ? { errorCount: input.errorCount } : {}),
    });
  }

  /** Ghi yêu cầu duyệt tool (trước khi hỏi user/rule). */
  recordApprovalRequest(callId: string, tool: string, reason?: string): void {
    this.record('approval.request', {
      callId,
      tool,
      ...(reason !== undefined ? { reason: sanitizeRunLogString(reason, 500) } : {}),
    });
  }

  /** Ghi quyết định duyệt tool (cho chạy / từ chối + lý do). */
  recordApprovalDecision(callId: string, tool: string, allowed: boolean, reason?: string): void {
    this.record('approval.decision', {
      callId,
      tool,
      allowed,
      ...(reason !== undefined ? { reason: sanitizeRunLogString(reason, 500) } : {}),
    });
  }

  /** Ghi checkpoint đã lưu sau một step. */
  recordCheckpoint(step: number, messages: number, toolCalls: number): void {
    this.record('checkpoint.saved', { step, messages, toolCalls });
  }

  /** Tạm dừng run (ghi event + đóng gate). */
  pause(reason?: string): PauseResumeResult {
    return pauseRun(this.store, this.registry, this.runId, {
      step: this.step,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /** Tiếp tục run đã pause (ghi event + mở gate). */
  resume(reason?: string): PauseResumeResult {
    return resumeRun(this.store, this.registry, this.runId, {
      step: this.step,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Fork run này tại seq hiện tại (hoặc seq chỉ định). Trả về run con.
   * Run con chưa có recorder — caller tạo recorder mới với
   * `childRunId` nếu muốn ghi tiếp vào con.
   */
  fork(fromSeq?: number): ForkRunResult {
    return forkRun(this.store, this.runId, { fromSeq, botId: this.botId });
  }

  /** Kết thúc run thành công (ghi `run.completed`, gỡ gate khỏi registry). */
  complete(finalText?: string): void {
    if (this.ended) return;
    this.ended = true;
    const end: RunEndPayload = {
      ...(finalText !== undefined ? { finalText: sanitizeRunLogString(finalText) } : {}),
      steps: this.step + 1,
      toolCalls: this.toolCalls,
      tokensUsed: this.tokensUsed,
      durationMs: Date.now() - this.startedAtMs,
    };
    this.record('run.completed', end);
    this.registry.remove(this.runId);
  }

  /** Kết thúc run vì lỗi (ghi `run.failed`, gỡ gate). */
  fail(message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.record('run.failed', {
      message: sanitizeRunLogString(message, RUN_LOG_OUTPUT_LIMIT),
      steps: this.step + 1,
      toolCalls: this.toolCalls,
      tokensUsed: this.tokensUsed,
      durationMs: Date.now() - this.startedAtMs,
    });
    this.registry.remove(this.runId);
  }

  /** Kết thúc run vì bị huỷ/abort (ghi `run.aborted`, gỡ gate + abort gate đang chờ). */
  abort(message?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.gate.abort();
    this.record('run.aborted', {
      ...(message !== undefined ? { message: sanitizeRunLogString(message, RUN_LOG_OUTPUT_LIMIT) } : {}),
      steps: this.step + 1,
      toolCalls: this.toolCalls,
      tokensUsed: this.tokensUsed,
      durationMs: Date.now() - this.startedAtMs,
    });
    this.registry.remove(this.runId);
  }

  /** true khi run đã kết thúc (complete/fail/abort đã gọi). */
  get isEnded(): boolean {
    return this.ended;
  }
}

/**
 * Trích đường dẫn file từ output của tool ghi file (dạng `Wrote
 * <path>` / `Created <path>` / `Updated <path>`). Trả về undefined
 * khi không đoán được — `file.change` vẫn ghi với path rỗng để giữ
 * đủ số lượng event.
 */
function extractPathFromOutput(output: string): string | undefined {
  const m = /(?:wrote|created|updated|edited|deleted)\s+([^\s\n'"]+)/i.exec(output);
  return m?.[1];
}
