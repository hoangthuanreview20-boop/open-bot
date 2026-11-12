/**
 * Checkpoint/resume sau mỗi step của một run (v0.12 mục 4).
 *
 * Vấn đề: AgentRunner chạy tuyến tính trong bộ nhớ — crash / dừng giữa
 * turn là mất toàn bộ trạng thái giữa chừng (message history đã gửi cho
 * model + kết quả các tool call đã chạy xong), phải chạy lại từ đầu,
 * tốn token và có thể chạy lại tool có side-effect.
 *
 * Module này lưu một checkpoint bền vào SQLite (bảng `run_checkpoints`,
 * xem `BotMemory`) sau mỗi step, và đọc lại để resume đúng từ step đó
 * mà không chạy lại các step trước.
 *
 * Một checkpoint chứa ĐỦ để resume đúng:
 *  - `messages`: toàn bộ message history tính tới cuối step đó, đúng
 *    thứ tự gửi cho model — gồm system/user, assistant message KÈM
 *    `toolCalls` của nó, và message `tool` chứa kết quả từng call
 *    (loop.ts push cả 3 loại này vào `messages`, nên lưu nguyên mảng
 *    là đủ; provider nào cũng yêu cầu assistant message mang tool
 *    call đi trước message tool result tương ứng).
 *  - `toolCalls`: danh sách `{ call, result }` đã chạy xong tới step
 *    đó — để bên resume biết tool nào đã xong (không gọi lại) và có
 *    kết quả để đối chiếu/ghi log; `result: null` nghĩa là call đã
 *    ghi nhận nhưng chưa có kết quả (vd bị ngắt giữa chừng).
 *  - `tokensUsed`: tổng token đã dùng tới step đó (cộng dồn).
 *
 * KHÔNG sửa loop.ts/coordinator.ts ở đây — chỉ expose 2 hàm để điều
 * phối viên nối vào loop sau (xem "ĐIỂM NỐI" cuối file):
 *  - `saveStepCheckpoint(...)`: gọi sau mỗi step trong `AgentRunner.run()`
 *    (sau khi đã push assistant message + tool result vào `messages`).
 *  - `buildResumeState(checkpoint)` / `resumeFromCheckpoint(...)`:
 *    coordinator dùng để tạo run mới với `initialMessages` +
 *    `nextStepIndex` từ checkpoint, rồi chạy loop tiếp từ step đó.
 *
 * An toàn:
 *  - Lưu đè cùng `(runId, stepIndex)` thì ghi đè (upsert) thay vì lỗi
 *    trùng — lưu lại cùng step sau khi sửa không tạo 2 bản ghi.
 *  - `pruneCheckpoints` giữ N checkpoint mới nhất mỗi run để DB không
 *    phình (mỗi checkpoint giữ nguyên cả history nên khá nặng).
 *  - JSON hỏng trong DB thì ném lỗi rõ ràng thay vì resume sai trạng
 *    thái trong im lặng.
 */

import type { ChatMessage, ToolCall, ToolResult } from '../types';
import type { BotMemory, CheckpointRow } from './memory';

/** Một tool call đã chạy xong trong step này (kèm kết quả của nó). */
export interface CheckpointToolCallRecord {
  call: ToolCall;
  /** Kết quả tool; null khi call đã ghi nhận nhưng chưa có kết quả. */
  result: ToolResult | null;
}

/** Một checkpoint đã lưu — một step của một run. */
export interface RunCheckpoint {
  id: string;
  runId: string;
  botId: string;
  /** Step đã hoàn thành (0-based, khớp vòng `for (step...)` trong loop). */
  stepIndex: number;
  /** Message history tới cuối step này, đúng thứ tự gửi cho model. */
  messages: ChatMessage[];
  /** Tool call + kết quả đã chạy tới cuối step này. */
  toolCalls: CheckpointToolCallRecord[];
  /** Tổng token đã dùng tới cuối step này (cộng dồn). */
  tokensUsed: number;
  createdAt: string;
}

/**
 * State để AgentRunner chạy tiếp từ một checkpoint — KHÔNG chứa step
 * đã xong, chỉ chứa những gì step tiếp theo cần.
 */
export interface ResumeState {
  runId: string;
  botId: string;
  /** Step tiếp theo cần chạy = checkpoint.stepIndex + 1. */
  nextStepIndex: number;
  /** History gửi cho model ở step tiếp theo (copy của checkpoint). */
  messages: ChatMessage[];
  /** Tool call đã xong — để loop/coordinator biết không gọi lại. */
  completedToolCalls: CheckpointToolCallRecord[];
  tokensUsed: number;
  checkpointId: string;
  createdAt: string;
}

export interface SaveCheckpointInput {
  runId: string;
  botId: string;
  stepIndex: number;
  messages: ChatMessage[];
  toolCalls?: CheckpointToolCallRecord[];
  tokensUsed?: number;
}

/**
 * Tóm tắt nhẹ của một checkpoint (P1-8, time-travel): đủ để UI liệt kê
 * các step có thể quay lại mà không cần tải toàn bộ message history
 * (mỗi checkpoint giữ nguyên cả history nên khá nặng).
 */
export interface CheckpointSummary {
  id: string;
  runId: string;
  botId: string;
  stepIndex: number;
  /** Số message trong history tới cuối step này. */
  messageCount: number;
  /** Số tool call đã chạy tới cuối step này. */
  toolCallCount: number;
  tokensUsed: number;
  createdAt: string;
}

/** Số checkpoint giữ lại mặc định cho mỗi run khi prune. */
export const DEFAULT_CHECKPOINTS_KEPT = 10;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseMessages(json: string, runId: string, stepIndex: number): ChatMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Checkpoint ${runId}#${stepIndex} hỏng: messagesJson không phải JSON hợp lệ.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Checkpoint ${runId}#${stepIndex} hỏng: messagesJson không phải mảng.`);
  }
  return parsed as ChatMessage[];
}

function parseToolCalls(json: string, runId: string, stepIndex: number): CheckpointToolCallRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Checkpoint ${runId}#${stepIndex} hỏng: toolCallsJson không phải JSON hợp lệ.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Checkpoint ${runId}#${stepIndex} hỏng: toolCallsJson không phải mảng.`);
  }
  return parsed as CheckpointToolCallRecord[];
}

function rowToCheckpoint(row: CheckpointRow): RunCheckpoint {
  return {
    id: row.id,
    runId: row.runId,
    botId: row.botId,
    stepIndex: row.stepIndex,
    messages: parseMessages(row.messagesJson, row.runId, row.stepIndex),
    toolCalls: parseToolCalls(row.toolCallsJson, row.runId, row.stepIndex),
    tokensUsed: row.tokensUsed,
    createdAt: row.createdAt,
  };
}

/**
 * Lưu (hoặc ghi đè) checkpoint cho một step của một run. Trả về checkpoint
 * đã lưu. `messages` nên là bản snapshot sau khi step đó hoàn thành
 * (assistant message + tool result đã push xong).
 */
export function saveCheckpoint(memory: BotMemory, input: SaveCheckpointInput): RunCheckpoint {
  if (!input.runId) throw new Error('saveCheckpoint: runId không được rỗng.');
  if (!input.botId) throw new Error('saveCheckpoint: botId không được rỗng.');
  if (!Number.isInteger(input.stepIndex) || input.stepIndex < 0) {
    throw new Error(`saveCheckpoint: stepIndex phải là số nguyên >= 0 (nhận ${input.stepIndex}).`);
  }
  const checkpoint: RunCheckpoint = {
    id: '',
    runId: input.runId,
    botId: input.botId,
    stepIndex: input.stepIndex,
    messages: cloneJson(input.messages),
    toolCalls: cloneJson(input.toolCalls ?? []),
    tokensUsed: input.tokensUsed ?? 0,
    createdAt: new Date().toISOString(),
  };
  const row = memory.insertCheckpointRow({
    id: '',
    runId: checkpoint.runId,
    botId: checkpoint.botId,
    stepIndex: checkpoint.stepIndex,
    messagesJson: JSON.stringify(checkpoint.messages),
    toolCallsJson: JSON.stringify(checkpoint.toolCalls),
    tokensUsed: checkpoint.tokensUsed,
    createdAt: checkpoint.createdAt,
  });
  return { ...checkpoint, id: row.id, createdAt: row.createdAt };
}

/**
 * Hàm loop-facing: gọi sau mỗi step trong AgentRunner (xem "ĐIỂM NỐI"
 * cuối file). Chỉ là tên rõ nghĩa hơn của `saveCheckpoint`.
 */
export function saveStepCheckpoint(memory: BotMemory, input: SaveCheckpointInput): RunCheckpoint {
  return saveCheckpoint(memory, input);
}

/** Toàn bộ checkpoint của một run, theo stepIndex tăng dần. */
export function listCheckpoints(memory: BotMemory, runId: string): RunCheckpoint[] {
  return memory.listCheckpointRows(runId).map(rowToCheckpoint);
}

/**
 * Lấy checkpoint của một step, hoặc `'latest'` để lấy step cao nhất.
 * Trả null khi run/step chưa có checkpoint nào.
 */
export function getCheckpoint(
  memory: BotMemory,
  runId: string,
  stepIndex: number | 'latest',
): RunCheckpoint | null {
  if (stepIndex === 'latest') {
    const rows = memory.listCheckpointRows(runId);
    if (rows.length === 0) return null;
    return rowToCheckpoint(rows[rows.length - 1]);
  }
  const row = memory.getCheckpointRow(runId, stepIndex);
  return row ? rowToCheckpoint(row) : null;
}

/**
 * Chuyển một checkpoint thành state để chạy tiếp. Thuần túy (không đọc
 * DB): copy sâu messages/toolCalls để caller sửa state resume không làm
 * bẩn checkpoint gốc; `nextStepIndex = stepIndex + 1`.
 */
export function buildResumeState(checkpoint: RunCheckpoint): ResumeState {
  return {
    runId: checkpoint.runId,
    botId: checkpoint.botId,
    nextStepIndex: checkpoint.stepIndex + 1,
    messages: cloneJson(checkpoint.messages),
    completedToolCalls: cloneJson(checkpoint.toolCalls),
    tokensUsed: checkpoint.tokensUsed,
    checkpointId: checkpoint.id,
    createdAt: checkpoint.createdAt,
  };
}

/**
 * Tóm tắt nhẹ của toàn bộ checkpoint của một run (theo stepIndex tăng
 * dần) — cho UI resume/time-travel liệt kê mà không tải full history.
 * Đọc `messagesJson`/`toolCallsJson` chỉ để đếm (không parse sâu): JSON
 * hỏng thì summary đó báo `messageCount: -1` thay vì ném lỗi cả danh sách.
 */
export function listCheckpointSummaries(memory: BotMemory, runId: string): CheckpointSummary[] {
  return memory.listCheckpointRows(runId).map((row) => {
    let messageCount = -1;
    let toolCallCount = -1;
    try {
      const messages = JSON.parse(row.messagesJson) as unknown;
      if (Array.isArray(messages)) messageCount = messages.length;
    } catch {
      // JSON hỏng: giữ -1 để UI biết checkpoint này lỗi, không crash list.
    }
    try {
      const toolCalls = JSON.parse(row.toolCallsJson) as unknown;
      if (Array.isArray(toolCalls)) toolCallCount = toolCalls.length;
    } catch {
      // Như trên.
    }
    return {
      id: row.id,
      runId: row.runId,
      botId: row.botId,
      stepIndex: row.stepIndex,
      messageCount,
      toolCallCount,
      tokensUsed: row.tokensUsed,
      createdAt: row.createdAt,
    };
  });
}

/**
 * Đọc checkpoint (mặc định step mới nhất) rồi trả về state để
 * AgentRunner chạy tiếp từ step đó. Trả null khi run chưa có checkpoint
 * nào — caller khi đó chạy run mới từ đầu như bình thường.
 */
export function resumeFromCheckpoint(
  memory: BotMemory,
  runId: string,
  stepIndex: number | 'latest' = 'latest',
): ResumeState | null {
  const checkpoint = getCheckpoint(memory, runId, stepIndex);
  return checkpoint ? buildResumeState(checkpoint) : null;
}

/**
 * Time-travel replay (P1-8, §12.4): quay lại một step cũ của run rồi
 * chạy tiếp từ đó — để debug ("từ step này model đã quyết định sai, cho
 * chạy lại với prompt khác"). Khác `resumeFromCheckpoint` ở chỗ:
 *  - ném lỗi rõ ràng khi run/step không có checkpoint (resume trả null
 *    để caller tự quyết chạy mới; replay là hành động tường minh nên lỗi
 *    ngay khi không có gì để quay lại);
 *  - state trả về dùng để chạy lại từ step đó với provider call MỚI:
 *    các tool call đã xong NẰM TRONG `messages` nên KHÔNG chạy lại
 *    (không side-effect lặp), model chỉ tiếp tục từ history đó.
 *  - checkpoint gốc không bị xoá: step chạy lại sẽ ghi đè checkpoint
 *    cùng step (upsert) khi lưu — muốn giữ bản gốc thì prune/đổi runId
 *    trước khi replay (xem docs).
 */
export function replayFromCheckpoint(
  memory: BotMemory,
  runId: string,
  stepIndex: number | 'latest' = 'latest',
): ResumeState {
  const checkpoint = getCheckpoint(memory, runId, stepIndex);
  if (!checkpoint) {
    throw new Error(
      stepIndex === 'latest'
        ? `Không replay được run "${runId}" — chưa có checkpoint nào cho run này.`
        : `Không replay được run "${runId}" — chưa có checkpoint ở step ${stepIndex}.`,
    );
  }
  return buildResumeState(checkpoint);
}

/**
 * Xoá checkpoint cũ của một run, chỉ giữ `keepLastN` checkpoint mới
 * nhất (theo stepIndex). `keepLastN = 0` xoá hết. Trả về số dòng đã xoá.
 */
export function pruneCheckpoints(memory: BotMemory, runId: string, keepLastN = DEFAULT_CHECKPOINTS_KEPT): number {
  if (!Number.isInteger(keepLastN) || keepLastN < 0) {
    throw new Error(`pruneCheckpoints: keepLastN phải là số nguyên >= 0 (nhận ${keepLastN}).`);
  }
  return memory.pruneCheckpointRows(runId, keepLastN);
}

// ---------------------------------------------------------------------------
// ĐIỂM NỐI — dành cho điều phối viên (KHÔNG làm trong W4b, chỉ ghi chú)
// ---------------------------------------------------------------------------
// 1. Lưu sau mỗi step — trong `AgentRunner.run()` (loop.ts), cuối mỗi vòng
//    `for (step...)`, sau khi đã push assistant message + mọi tool result
//    của step đó vào `messages`:
//      saveStepCheckpoint(this.memory, {
//        runId, botId: this.bot.id, stepIndex: step,
//        messages,                       // mảng `messages` của run()
//        toolCalls,                      // [{ call, result }] đã chạy tới step này
//        tokensUsed,                     // cộng dồn từ res.usage mỗi step
//      });
//    Cần: AgentRunner nhận thêm `memory?: BotMemory` + `runId` (sinh bằng
//    randomUUID() khi bắt đầu run, hoặc lấy từ RunParams khi coordinator
//    đã có runId — xem v0.9 WS control) và tích luỹ tokensUsed.
//    Lưu ý: checkpoint ghi đè cùng step nên lưu lại sau retry là an toàn.
// 2. Resume run — API/coordinator thêm phương thức resume, vd
//    `resumeRun({ runId, stepIndex?: number | 'latest' })`:
//      const state = resumeFromCheckpoint(memory, runId, stepIndex ?? 'latest');
//      if (!state) throw new Error(`Không thấy checkpoint cho run ${runId}`);
//      // tạo AgentRunner mới với initialMessages = state.messages và
//      // bắt đầu vòng lặp từ state.nextStepIndex (cần loop hỗ trợ
//      // `startStep` + `initialMessages` trong AgentRunnerOptions —
//      // hiện loop.ts luôn bắt đầu từ step 0 với [system, user]).
//      // Tool đã xong trong state.completedToolCalls KHÔNG được gọi lại:
//      // loop chỉ gọi provider.chat với state.messages (đã chứa tool
//      // result) nên model tự tiếp tục từ đó.
// 3. Prune — sau khi run kết thúc thành công/lỗi, gọi
//    `pruneCheckpoints(memory, runId)` (mặc định giữ 10 checkpoint mới
//    nhất) để DB không phình; run đã xong hẳn có thể prune với 0 hoặc
//    giữ checkpoint cuối để debug.
// ---------------------------------------------------------------------------
