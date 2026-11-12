/**
 * A2A (Agent-to-Agent, spec 1.0) — types dùng chung cho server + client.
 *
 * A2A là wire protocol cho agent ↔ agent (MCP lo capability agent ↔
 * tool, A2A lo collaboration agent ↔ agent). Chỉ dùng type + helper
 * thuần, không dependency ngoài, không gọi mạng ở đây.
 *
 * Khái niệm lõi (theo docs/research-a2a-claudecode-frameworks.md §2):
 *  - Agent Card tại `/.well-known/agent-card.json`: discovery.
 *  - Task: đơn vị công việc, lifecycle chuẩn.
 *  - Message: payload hội thoại, nhiều part (text/file/dữ liệu).
 *  - Artifact: kết quả task trả về, mỗi part có mediaType riêng.
 *  - Transport: HTTP(S) + JSON-RPC 2.0; streaming qua SSE.
 */

/** Trạng thái task chuẩn A2A 1.0. */
export type A2aTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

/** Trạng thái cuối — task đã dừng, không đổi nữa. */
export const A2A_TERMINAL_STATES: readonly A2aTaskState[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
];

export function isA2aTerminalState(state: A2aTaskState): boolean {
  return (A2A_TERMINAL_STATES as readonly A2aTaskState[]).includes(state);
}

/** Một phần của message/artifact: text, file, hoặc dữ liệu có cấu trúc. */
export type A2aPart =
  | { kind: 'text'; text: string; metadata?: Record<string, unknown> }
  | {
      kind: 'file';
      file: { name?: string; mimeType?: string; bytes?: string; uri?: string };
      metadata?: Record<string, unknown>;
    }
  | { kind: 'data'; data: Record<string, unknown>; metadata?: Record<string, unknown> };

export interface A2aMessage {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: A2aPart[];
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
  state: A2aTaskState;
  /** Tin nhắn kèm theo trạng thái (vd lý do failed, câu hỏi khi input-required). */
  message?: A2aMessage;
  timestamp?: string;
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
  /** ISO-8601 lúc tạo task (server A2A điền; task ngoài có thể vắng). */
  createdAt?: string;
  /** ISO-8601 lần cuối trạng thái task đổi (server A2A điền). */
  updatedAt?: string;
}

/** Một skill trong Agent Card. */
export interface A2aAgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** Agent Card (A2A 1.0) — client đọc trước khi giao việc. */
export interface A2aAgentCard {
  name: string;
  description: string;
  version?: string;
  /** URL endpoint JSON-RPC của agent (vd http://127.0.0.1:PORT/). */
  url: string;
  protocolVersion?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: A2aAgentSkill[];
  /** Binding transport (ghi rõ để client khác biết cách gọi). */
  supportedInterfaces?: {
    url: string;
    protocolBinding: string;
    protocolVersion?: string;
  }[];
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: Record<string, unknown>[];
}

/** Kết quả runner trả về khi chạy xong một task. */
export interface A2aRunResult {
  /** Text kết quả chính (thành artifact text). */
  text?: string;
  /** Artifact bổ sung (mặc định: một artifact text từ `text`). */
  artifacts?: A2aArtifact[];
  /** Runner cần thêm thông tin → task sang `input-required` kèm câu hỏi. */
  needsInput?: string;
  /** Runner lỗi có kiểm soát → task `failed` với thông báo này. */
  error?: string;
}

/** Input runner nhận khi server giao một task. */
export interface A2aRunnerInput {
  taskId: string;
  contextId: string;
  /** Text gộp từ các part text của message người gửi. */
  text: string;
  /** Message gốc (đầy đủ part) để runner dùng khi cần file/data. */
  message: A2aMessage;
  /** Abort khi client hủy task (tasks/cancel) hoặc server dừng. */
  signal: AbortSignal;
  /** Đẩy tiến độ từng phần (server stream về client qua SSE). */
  onProgress: (partialText: string) => void;
}

/**
 * Runner của agent — callback do caller tiêm vào, server KHÔNG import
 * coordinator/loop trực tiếp (tránh cycle). Điều phối viên nối runner
 * thật (chạy agent loop) vào đây sau. Runner ném lỗi → task `failed`;
 * runner kiểm tra `signal.aborted` để dừng sớm khi bị hủy.
 */
export type A2aAgentRunner = (input: A2aRunnerInput) => Promise<A2aRunResult>;

/** Lỗi A2A — luôn có message rõ ràng, không throw khó hiểu. */
export class A2aError extends Error {
  readonly code?: number;
  readonly status?: number;
  constructor(message: string, code?: number, status?: number) {
    super(message);
    this.name = 'A2aError';
    this.code = code;
    this.status = status;
  }
}

/** Gộp các part text của một message thành một chuỗi. */
export function partsToText(parts: A2aPart[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  const out: string[] = [];
  for (const part of parts) {
    if (part && part.kind === 'text' && typeof part.text === 'string') out.push(part.text);
    else if (part && part.kind === 'data') out.push(JSON.stringify(part.data));
    else if (part && part.kind === 'file' && part.file?.uri) out.push(`[file: ${part.file.uri}]`);
  }
  return out.join('\n');
}

/** Tạo một message text (user hoặc agent). */
export function makeTextMessage(
  role: 'user' | 'agent',
  text: string,
  messageId?: string,
): A2aMessage {
  return {
    kind: 'message',
    messageId: messageId ?? `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    role,
    parts: [{ kind: 'text', text }],
  };
}

/**
 * Trích text từ params `message:send` — chấp nhận cả dạng chuẩn
 * `{ message: { parts: [...] } }` và dạng gọn `{ message: "text" }`,
 * `{ text: "..." }` để client nội bộ gọi cho tiện. Trả null khi
 * không trích được gì.
 */
export function extractSendText(params: unknown): { text: string; message: A2aMessage } | null {
  if (typeof params === 'string') {
    const text = params.trim();
    if (!text) return null;
    return { text, message: makeTextMessage('user', text) };
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const rec = params as Record<string, unknown>;
  const rawMessage = rec['message'];
  if (typeof rawMessage === 'string') {
    const text = rawMessage.trim();
    if (!text) return null;
    return { text, message: makeTextMessage('user', text) };
  }
  if (typeof rec['text'] === 'string' && (rec['text'] as string).trim()) {
    const text = (rec['text'] as string).trim();
    return { text, message: makeTextMessage('user', text) };
  }
  if (typeof rawMessage === 'object' && rawMessage !== null && !Array.isArray(rawMessage)) {
    const m = rawMessage as Record<string, unknown>;
    const parts = Array.isArray(m['parts']) ? (m['parts'] as A2aPart[]) : [];
    const text = partsToText(parts).trim();
    if (!text && parts.length === 0) return null;
    return {
      text,
      message: {
        kind: 'message',
        messageId: typeof m['messageId'] === 'string' ? (m['messageId'] as string) : `msg-${Date.now()}`,
        role: m['role'] === 'agent' ? 'agent' : 'user',
        parts,
        ...(typeof m['contextId'] === 'string' ? { contextId: m['contextId'] as string } : {}),
      },
    };
  }
  return null;
}
