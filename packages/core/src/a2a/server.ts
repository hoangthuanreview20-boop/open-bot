/**
 * A2A server tối thiểu (v0.13, mục 12) — spec A2A 1.0.
 *
 * Chỉ dùng Node stdlib, không thêm dependency. Agent chạy qua callback
 * `runner` do caller tiêm vào — server không import coordinator/loop
 * (tránh cycle); điều phối viên nối runner thật sau.
 *
 * Endpoint (HTTP, loopback):
 *  - GET  /.well-known/agent-card.json -> Agent Card (discovery)
 *  - POST /  (và POST /a2a)            -> JSON-RPC 2.0:
 *       `message:send`   nhận message, chạy agent, trả Task
 *       `message:stream` như send nhưng trả SSE (task → status-update
 *                          → artifact-update → task cuối)
 *       `tasks/get`      trạng thái task
 *       `tasks/list`     liệt kê task, mới nhất trước; params tùy
 *                          chọn `{ limit?, offset?, cursor?,
 *                          contextId?, summary? }` — `limit` mặc định
 *                          50, tối đa 100; `offset`/`cursor` (chuỗi
 *                          số thập phân = offset) để phân trang;
 *                          `summary: true` → mỗi task chỉ có `id`/
 *                          `status`/`contextId`/`createdAt`/`updatedAt`
 *                          (không `history`/`artifacts`); mặc định
 *                          full task. Trả `{ tasks, total, nextCursor }`
 *                          (`nextCursor` null khi hết trang).
 *                          Mỗi task kèm `createdAt`/`updatedAt`
 *                          (ISO-8601; `updatedAt` đổi mỗi lần trạng
 *                          thái đổi).
 *       `tasks/cancel`   hủy task đang chạy (AbortSignal cho runner);
 *                          task đã xong (settled hoặc trạng thái cuối)
 *                          thì lỗi -32602 rõ ràng, không crash.
 *  - GET  /tasks/:id                   -> Task (tiện cho debug/poll tay)
 *
 * Lifecycle task chuẩn: submitted → working → completed / failed /
 * cancelled (+ input-required khi runner cần thêm thông tin,
 * auth-required/rejected giữ sẵn trong type nhưng server tối thiểu
 * này không dùng). Task lưu trong bộ nhớ (Map), tối đa 200 task —
 * restart là mất, giống run của Local API (v0.5) — TRỪ khi caller
 * truyền `options.taskStore` (v0.25, xem `a2a/store.ts`):
 * `createFileTaskStore(<userData>/a2a-tasks.json)` load task cũ lúc
 * tạo server và save đồng bộ mỗi khi task đổi, nên task sống qua
 * restart; task đang chạy dở lúc restart (chưa tới trạng thái cuối)
 * thì runner đã mất nên được đánh dấu `failed` rõ ràng khi load lại
 * thay vì kẹt mãi ở `working`.
 *
 * Auth (L2, audit bảo mật v0.15): `createA2aServer` BẮT BUỘC có token —
 * thiếu `options.token` thì throw ngay, trừ khi caller truyền tường
 * minh `allowUnauthenticated: true` (chỉ dùng cho test/local, server
 * khi đó log cảnh báo stderr rõ ràng). Token được đặt thì mọi route
 * HTTP (kể cả Agent Card) yêu cầu `Authorization: Bearer <token>` —
 * so sánh timing-safe. Khi A2A được mount vào Local API thì auth do
 * Local API thực thi, nhưng caller vẫn phải truyền cùng token vào
 * đây để không tạo server không auth một cách im lặng.
 * Body JSON tối đa 1 MB.
 */
import * as http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  extractSendText,
  isA2aTerminalState,
  makeTextMessage,
  partsToText,
  type A2aAgentCard,
  type A2aAgentRunner,
  type A2aAgentSkill,
  type A2aArtifact,
  type A2aMessage,
  type A2aRunResult,
  type A2aTask,
  type A2aTaskState,
} from './types';
import type { A2aTaskStore } from './store';
import {
  A2A_PERSIST_MAX_ATTEMPTS,
  A2A_PERSIST_RETRY_DELAY_MS,
  saveTaskStoreWithRetry,
} from './store';
import {
  A2aPushNotifier,
  validatePushConfig,
  type A2aPushNotificationConfig,
} from './push';
import {
  A2aEventLog,
  appendA2aTransition,
  makeA2aTransition,
} from './history';
import { A2A_PROTOCOL_VERSION } from './version';
import {
  isLoopbackHost,
  resolveA2aBindHost,
  type A2aNetworkPolicy,
} from './network';
import {
  signAgentCard,
  type A2aSigningKeyPair,
} from './signing';
export { A2aPushNotifier } from './push';
export {
  A2A_PUSH_CONFIGS_FILE_NAME,
  createFilePushConfigStore,
} from './push';
export type { A2aPushNotificationConfig } from './push';
export { A2aEventLog } from './history';
export type { A2aTaskEvent, A2aTaskTransition } from './history';
export { A2A_PROTOCOL_VERSION, A2A_SUPPORTED_PROTOCOL_VERSIONS } from './version';
export {
  A2A_DEFAULT_BIND_HOST,
  A2A_DEFAULT_NETWORK_POLICY,
  A2A_EXTERNAL_BIND_HOST,
  isA2aExternalAllowed,
  isLoopbackHost,
  isLoopbackUrl,
  normalizeA2aNetworkPolicy,
  resolveA2aBindHost,
} from './network';
export type { A2aNetworkPolicy } from './network';
export {
  A2A_SIGNING_KEY_FILE_NAME,
  generateA2aSigningKey,
  loadOrCreateA2aSigningKey,
  signAgentCard,
  verifyAgentCardSignature,
  verifyAgentCardTrust,
} from './signing';

/** File-backed store cho task A2A (v0.25) — xem `a2a/store.ts`. */
export { A2A_TASKS_FILE_NAME, createFileTaskStore } from './store';
export {
  A2A_PERSIST_MAX_ATTEMPTS,
  A2A_PERSIST_RETRY_DELAY_MS,
  saveTaskStoreWithRetry,
} from './store';
export type { A2aPersistResult, A2aTaskStore, SaveWithRetryOptions } from './store';

/** Mã lỗi JSON-RPC 2.0 (cùng bộ mã MCP server dùng). */
export const A2A_JSON_RPC_PARSE_ERROR = -32700;
export const A2A_JSON_RPC_INVALID_REQUEST = -32600;
export const A2A_JSON_RPC_METHOD_NOT_FOUND = -32601;
export const A2A_JSON_RPC_INVALID_PARAMS = -32602;
export const A2A_JSON_RPC_INTERNAL_ERROR = -32603;

/** Số task tối đa giữ trong bộ nhớ (task cũ nhất bị xóa khi đầy). */
export const A2A_MAX_TASKS = 200;
/** Body JSON tối đa (1 MB, cùng giới hạn Local API). */
export const A2A_MAX_BODY_BYTES = 1_048_576;

export interface A2aServerOptions {
  /** Tên agent trong Agent Card (mặc định 'open-bot'). */
  name?: string;
  description?: string;
  version?: string;
  /** Skill khai trong Agent Card (mô tả năng lực cho client khác). */
  skills?: A2aAgentSkill[];
  /** URL endpoint ghi vào Agent Card — server HTTP tự điền khi start,
   *  caller nhúng vào Local API thì điền URL thật của mình. */
  url?: string;
  /** Bearer token cho HTTP — BẮT BUỘC (L2, audit v0.15). Thiếu token
   *  thì `createA2aServer` throw, trừ khi `allowUnauthenticated`
   *  được bật tường minh. Khi A2A mount vào Local API, truyền cùng
   *  token của Local API (auth lúc đó do Local API thực thi). */
  token?: string;
  /**
   * Đường thoát hiểm cho test/local: cho phép tạo server không token
   * một cách tường minh. Khi bật, server log cảnh báo stderr rõ ràng
   * lúc tạo. KHÔNG dùng trong app thật — server khi đó chỉ còn lớp
   * bảo vệ loopback (bind 127.0.0.1).
   */
  allowUnauthenticated?: boolean;
  /** Runner chạy agent cho mỗi task — bắt buộc (không có runner thì
   *  server chỉ trả card + lỗi rõ ràng khi nhận message). */
  runner?: A2aAgentRunner;
  /**
   * v0.25: store bền vững cho task (vd `createFileTaskStore(...)`
   * từ `a2a/store.ts`). Khi có thì server load task cũ lúc tạo và
   * save ĐỒNG BỘ mỗi khi task được tạo/đổi state/prune (không
   * debounce — task không đổi liên tục nên save đồng bộ là đơn
   * giản và chắc chắn nhất: file luôn đúng bằng bộ nhớ sau mỗi
   * lần đổi). Không truyền → giữ Map trong bộ nhớ như cũ, restart
   * là mất task. Lỗi ghi file được thử lại tối đa 3 lần với backoff
   * (v0.28) rồi mới log stderr + báo lên UI qua `getPersistStatus()` /
   * `onPersistStatusChange` — server không crash, task vẫn giữ
   * trong bộ nhớ.
   */
  taskStore?: A2aTaskStore;
  /**
   * v0.28: số lần thử lưu tối đa khi `taskStore.save` lỗi (mặc định 3:
   * 1 lần đầu + 2 retry, xem `a2a/store.ts`). Chỉ có tác dụng khi có
   * `taskStore`.
   */
  persistMaxAttempts?: number;
  /**
   * v0.28: thời gian chờ trước retry đầu tiên, ms (mặc định 50; mỗi
   * lần retry nhân đôi: 50ms → 100ms). Chỉ có tác dụng khi có
   * `taskStore`.
   */
  persistRetryDelayMs?: number;
  /**
   * v0.28: callback khi trạng thái lưu task đổi — lần lưu thất bại
   * sau hết retry (`status.ok === false`), hoặc lần lưu thành công
   * đầu tiên sau một chuỗi thất bại (`status.ok === true`,
   * `consecutiveFailures` vừa reset về 0). Main process dùng callback
   * này để đẩy cảnh báo lên UI (người dùng thấy được lỗi, không mất
   * lặng); callback lỗi không được làm hỏng server (được try/catch).
   */
  onPersistStatusChange?: (status: A2aPersistStatus) => void;
  onLog?: (message: string) => void;
  /**
   * v0.97: key Ed25519 ký Agent Card (tạo bằng
   * `loadOrCreateA2aSigningKey(<userData>/a2a-signing-key.pem)`).
   * Có signer → card trả về có `signature`; không có → card không
   * ký (agent cũ / test). Key KHÔNG bao giờ rời máy này.
   */
  signer?: A2aSigningKeyPair;
  /**
   * v0.97: notifier push notification (`tasks/pushNotificationConfig`).
   * Có notifier → capability `pushNotifications: true`; không có →
   * false (như trước). Notifier do caller tạo để tự chọn store/policy.
   */
  pushNotifier?: A2aPushNotifier;
  /**
   * v0.97: policy mạng A2A — mặc định loopback-only. `startA2aHttpServer`
   * bind 0.0.0.0 chỉ khi policy cho phép expose ngoài (cả hai cờ).
   */
  networkPolicy?: A2aNetworkPolicy;
  /**
   * v0.97: event log task (ring buffer trong bộ nhớ). Không truyền →
   * server tự tạo một log mặc định (capacity 500).
   */
  eventLog?: A2aEventLog;
}

/**
 * v0.28: trạng thái lần lưu task A2A gần nhất xuống store — UI đọc qua
 * `getPersistStatus()` (kèm IPC `a2a:persist-status`) để cảnh báo khi
 * lưu thất bại. `ok === false` nghĩa là lần lưu gần nhất đã thử hết
 * retry mà vẫn lỗi: task vẫn giữ trong bộ nhớ nhưng sẽ MẤT khi restart.
 */
export interface A2aPersistStatus {
  /** Lần lưu gần nhất có thành công không (chưa lưu lần nào → true). */
  ok: boolean;
  /** Thông báo lỗi lần lưu cuối (null khi lần lưu gần nhất thành công). */
  lastError: string | null;
  /** ISO-8601 lúc thử lưu gần nhất (null khi chưa lưu lần nào). */
  lastAttemptAt: string | null;
  /** ISO-8601 lúc lưu thành công gần nhất (null khi chưa lưu được lần nào). */
  lastSuccessAt: string | null;
  /** Số lần thử `save` của lần lưu gần nhất (1 = thành công ngay). */
  lastAttempts: number;
  /** Số lần lưu thất bại liên tiếp (0 = lần lưu gần nhất thành công). */
  consecutiveFailures: number;
  /** Tổng số lần lưu thất bại từ lúc tạo server. */
  totalFailures: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function agentMessage(text: string): A2aMessage {
  return makeTextMessage('agent', text);
}

export interface A2aServer {
  /** Agent Card hiện tại (url được điền sau khi start HTTP). */
  getAgentCard(): A2aAgentCard;
  /**
   * v0.28: trạng thái lần lưu task gần nhất xuống store — UI dùng để
   * cảnh báo khi lưu thất bại sau hết retry.
   */
  getPersistStatus(): A2aPersistStatus;
  /** Xử lý một message JSON-RPC đã parse; null cho notification. */
  handleJsonRpc(msg: unknown): Promise<Record<string, unknown> | null>;
  getTask(id: string): A2aTask | undefined;
  /** Mọi task đã tạo, mới nhất trước (thứ tự tạo đảo ngược). */
  listTasks(): A2aTask[];
  /**
   * v0.97: lịch sử chuyển trạng thái của một task (mảng rỗng khi
   * task không có / task cũ trước v0.97). Client dùng để hiện
   * timeline thay vì chỉ trạng thái hiện tại.
   */
  getTaskTransitions(id: string): import('./types').A2aTaskTransition[];
  /** Event log của server (mới nhất trước) — debug/activity. */
  getEventLog(): import('./history').A2aTaskEvent[];
  /**
   * v0.97: đăng ký push notification cho một task (ghi đè config cũ
   * của cùng taskId). URL ngoài loopback bị chặn khi policy chưa cho
   * phép. Throw khi config sai.
   */
  setPushNotificationConfig(config: A2aPushNotificationConfig): A2aPushNotificationConfig;
  /** v0.97: config push đã đăng ký cho task (undefined khi chưa có). */
  getPushNotificationConfig(taskId: string): A2aPushNotificationConfig | undefined;
  /**
   * v0.97: `tasks/resubscribe` — client nối lại sau khi mất kết nối:
   * trả task hiện tại (kèm toàn bộ `transitions`) để client đồng bộ
   * lại trạng thái mà không cần gửi lại message. Trả undefined khi
   * không có task.
   */
  resubscribe(taskId: string): A2aTask | undefined;
  /**
   * v0.97: re-attach stream cho một task đang chạy (`GET
   * /tasks/:id/events`): đẩy ngay event `task` hiện tại rồi đăng ký
   * nhận event tiếp theo. Trả hàm hủy đăng ký, hoặc undefined khi
   * không có task. Hủy đăng ký CHỈ ngắt stream, KHÔNG hủy task
   * (khác `startStream` — resubscribe không sở hữu run).
   */
  subscribeToTask(
    taskId: string,
    onEvent: (event: A2aStreamEvent) => void,
  ): (() => void) | undefined;
  /**
   * Hủy task đang chạy; trả task sau khi hủy (hoặc undefined khi
   * không có task). Task đã settle (chạy xong) thì no-op — trả task
   * nguyên trạng; tầng JSON-RPC (`tasks/cancel`) tự chặn trường hợp
   * này bằng lỗi rõ ràng thay vì gọi hàm này.
   */
  cancelTask(id: string): A2aTask | undefined;
  /**
   * Bắt đầu một run streaming cho một `message:stream` đã parse xong.
   * Tạo task, đăng ký `onEvent` rồi chạy runner ngay: mọi event SSE
   * (`task` → `status-update` → `artifact-update` → task cuối) đều
   * đi qua `onEvent`, theo đúng thứ tự server độc lập vẫn gửi. Event
   * `task` đầu tiên (trạng thái `submitted`) được đẩy đồng bộ trước
   * khi runner chạy — HTTP layer PHẢI ghi header SSE trước khi gọi
   * hàm này, nếu không event đầu sẽ đi trước header. `done` resolve
   * với task cuối khi run settle (kể cả failed/cancelled — lỗi runner
   * đã ghi vào task, không throw ra ngoài); `cancel()` hủy run (client
   * ngắt stream). Listener tự gỡ khi `done` settle. HTTP layer chỉ
   * việc chuyển mỗi event thành một frame `data:` — logic stream chỉ
   * viết một lần ở đây, server độc lập và mount Local API dùng chung.
   */
  startStream(
    input: { message: A2aMessage; text: string; contextId?: string },
    onEvent: (event: A2aStreamEvent) => void,
  ): { taskId: string; task: A2aTask; done: Promise<A2aTask>; cancel: () => void };
}

interface TaskRecord {
  task: A2aTask;
  controller: AbortController;
  /** Runner đã chạy xong hay chưa (để cancel sau khi xong là no-op). */
  settled: boolean;
  /** Client stream đang bám task này (đẩy SSE) — HTTP layer đăng ký. */
  listeners: Set<(event: A2aStreamEvent) => void>;
  /** ISO-8601 lúc tạo task (status.timestamp đổi theo trạng thái nên
   *  không dùng được làm createdAt — lưu riêng ở đây). */
  createdAt: string;
  /** ISO-8601 lần cuối trạng thái task đổi (setState cập nhật). */
  updatedAt: string;
}

/** Một event SSE của `message:stream`. */
export type A2aStreamEvent =
  | { kind: 'task'; task: A2aTask }
  | { kind: 'status-update'; taskId: string; contextId: string; status: A2aTask['status']; final: boolean }
  | { kind: 'artifact-update'; taskId: string; contextId: string; artifact: A2aArtifact; lastChunk: boolean };

export function createA2aServer(options: A2aServerOptions = {}): A2aServer {
  // L2 (audit v0.15): không cho tạo server không token một cách im
  // lặng — caller tương lai/test vô tình mở A2A không auth. Muốn
  // không auth thì phải nói rõ bằng allowUnauthenticated: true.
  if (!options.token) {
    if (!options.allowUnauthenticated) {
      throw new Error(
        'createA2aServer yêu cầu options.token (Bearer token cho A2A HTTP). ' +
          'Nếu cố tình chạy không auth (chỉ test/local, loopback), ' +
          'truyền tường minh allowUnauthenticated: true.',
      );
    }
    console.error(
      '[open-bot A2A] CẢNH BÁO: tạo A2A server KHÔNG CÓ token ' +
        '(allowUnauthenticated: true) — mọi process local đều gọi được, ' +
        'chỉ dùng cho test/local, không dùng trong app thật.',
    );
  }
  const name = options.name ?? 'open-bot';
  const description =
    options.description ??
    'open-bot — agent local-first: nhận việc qua chuẩn A2A, chạy bằng model và tool của bot chủ.';
  const version = options.version ?? '0.2.0';
  const runner = options.runner;
  const onLog = options.onLog;
  // v0.97: signer (ký card) + push notifier + event log. Không truyền
  // thì card không ký, push tắt, log dùng mặc định — hành vi cũ giữ nguyên.
  const signer = options.signer;
  const pushNotifier = options.pushNotifier;
  const eventLog = options.eventLog ?? new A2aEventLog();
  let cardUrl = options.url ?? '';
  const skills: A2aAgentSkill[] = options.skills ?? [
    {
      id: 'chat',
      name: 'Trò chuyện và làm việc',
      description: 'Nhận yêu cầu bằng text, dùng tool của bot để làm và trả kết quả.',
      tags: ['chat', 'agent'],
      examples: ['Tóm tắt file README trong workspace', 'Liệt kê file trong thư mục hiện tại'],
    },
  ];

  const tasks = new Map<string, TaskRecord>();
  const taskStore = options.taskStore;
  const persistMaxAttempts = options.persistMaxAttempts ?? A2A_PERSIST_MAX_ATTEMPTS;
  const persistRetryDelayMs = options.persistRetryDelayMs ?? A2A_PERSIST_RETRY_DELAY_MS;
  const onPersistStatusChange = options.onPersistStatusChange;

  // v0.28: trạng thái lưu task — cập nhật trong `persistTasks()`, UI
  // đọc qua `getPersistStatus()` / callback `onPersistStatusChange`.
  let persistStatus: A2aPersistStatus = {
    ok: true,
    lastError: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastAttempts: 0,
    consecutiveFailures: 0,
    totalFailures: 0,
  };

  function getPersistStatus(): A2aPersistStatus {
    return { ...persistStatus };
  }

  function notifyPersistStatusChange(): void {
    try {
      onPersistStatusChange?.(getPersistStatus());
    } catch {
      // Callback UI lỗi không được làm hỏng server.
    }
  }

  /**
   * v0.28: lưu toàn bộ task xuống store (nếu có) — đồng bộ, gọi mỗi
   * khi task đổi (tạo mới / đổi state / prune). Không có store thì
   * no-op. Ghi lỗi được thử lại tối đa `persistMaxAttempts` lần với
   * backoff (xem `saveTaskStoreWithRetry` trong `a2a/store.ts`); hết
   * retry vẫn lỗi thì chỉ log stderr + cập nhật trạng thái + báo
   * callback cho UI — task vẫn giữ trong bộ nhớ, server không crash
   * vì lỗi đĩa.
   */
  function persistTasks(): void {
    if (!taskStore) return;
    const result = saveTaskStoreWithRetry(
      taskStore,
      // Map giữ thứ tự tạo (cũ → mới); file lưu cùng thứ tự đó để
      // lúc load lại giữ nguyên thứ tự và prune đúng task cũ nhất.
      [...tasks.values()].map((r) => r.task),
      { maxAttempts: persistMaxAttempts, initialDelayMs: persistRetryDelayMs },
    );
    const now = nowIso();
    if (result.ok) {
      const wasFailing = !persistStatus.ok;
      persistStatus = {
        ok: true,
        lastError: null,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastAttempts: result.attempts,
        consecutiveFailures: 0,
        totalFailures: persistStatus.totalFailures,
      };
      // Chỉ báo khi vừa hồi phục sau chuỗi lỗi (tránh spam callback
      // cho mọi lần lưu thành công bình thường).
      if (wasFailing) notifyPersistStatusChange();
      return;
    }
    const message = result.error?.message ?? 'Không rõ nguyên nhân.';
    persistStatus = {
      ok: false,
      lastError: message,
      lastAttemptAt: now,
      lastSuccessAt: persistStatus.lastSuccessAt,
      lastAttempts: result.attempts,
      consecutiveFailures: persistStatus.consecutiveFailures + 1,
      totalFailures: persistStatus.totalFailures + 1,
    };
    console.error(
      `[open-bot A2A] Không lưu được task A2A xuống file store sau ${result.attempts} lần thử — task vẫn giữ trong bộ nhớ (sẽ mất khi restart):`,
      message,
    );
    notifyPersistStatusChange();
  }

  // v0.25: load task cũ từ store (nếu có). Store đã tự xử file
  // thiếu/hỏng (trả [] + log stderr) nên server vẫn khởi động bình
  // thường với danh sách rỗng; lỗi load bất ngờ ở đây cũng chỉ log.
  if (taskStore) {
    let loaded: A2aTask[] = [];
    try {
      loaded = taskStore.load();
    } catch (err) {
      console.error(
        '[open-bot A2A] Không đọc được task A2A từ file store — bắt đầu với danh sách rỗng:',
        err instanceof Error ? err.message : err,
      );
      loaded = [];
    }
    const valid = loaded.filter(
      (t): t is A2aTask =>
        isRecord(t) &&
        typeof t.id === 'string' &&
        t.id.length > 0 &&
        isRecord(t.status) &&
        typeof t.status.state === 'string',
    );
    // File không bao giờ quá 200 nếu chỉ server này ghi (prune +
    // save sau mỗi lần tạo), nhưng file sửa tay có thể dài hơn —
    // chỉ giữ 200 task mới nhất.
    const kept = valid.slice(-A2A_MAX_TASKS);
    let changed = kept.length !== valid.length;
    for (const task of kept) {
      const now = nowIso();
      const createdAt =
        typeof task.createdAt === 'string' ? task.createdAt : (task.status.timestamp ?? now);
      const updatedAt =
        typeof task.updatedAt === 'string' ? task.updatedAt : (task.status.timestamp ?? createdAt);
      const record: TaskRecord = {
        task: {
          ...task,
          artifacts: [...(task.artifacts ?? [])],
          history: [...(task.history ?? [])],
          createdAt,
          updatedAt,
        },
        controller: new AbortController(),
        settled: isA2aTerminalState(task.status.state),
        listeners: new Set(),
        createdAt,
        updatedAt,
      };
      // Task chưa tới trạng thái cuối lúc restart thì runner đã mất —
      // không thể chạy tiếp: đánh dấu `failed` rõ ràng thay vì để
      // kẹt mãi ở `working`/`submitted`/`input-required`.
      if (!record.settled) {
        record.task.status = {
          state: 'failed',
          timestamp: now,
          message: agentMessage('Task bị gián đoạn vì server A2A khởi động lại trước khi chạy xong.'),
        };
        record.task.updatedAt = now;
        record.updatedAt = now;
        record.settled = true;
        changed = true;
      }
      tasks.set(record.task.id, record);
    }
    if (changed) persistTasks();
  }

  function log(message: string): void {
    try {
      onLog?.(message);
    } catch {
      // Log không được làm hỏng request.
    }
  }

  function getAgentCard(): A2aAgentCard {
    const card: A2aAgentCard = {
      name,
      description,
      version,
      url: cardUrl,
      protocolVersion: A2A_PROTOCOL_VERSION,
      capabilities: {
        streaming: true,
        // v0.97: push chỉ true khi caller gắn notifier thật; history
        // luôn true vì server giờ ghi transitions cho mọi task.
        pushNotifications: pushNotifier !== undefined,
        stateTransitionHistory: true,
      },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills,
      supportedInterfaces: cardUrl
        ? [{ url: cardUrl, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }]
        : [],
    };
    // v0.97: ký card bằng key local khi có signer — client verify
    // được card này do open-bot publish, không bị sửa sau khi ký.
    if (signer) return signAgentCard(card, signer);
    return card;
  }

  function setCardUrl(url: string): void {
    cardUrl = url;
  }

  function pruneTasks(): void {
    while (tasks.size > A2A_MAX_TASKS) {
      const oldest = tasks.keys().next().value as string | undefined;
      if (!oldest) break;
      tasks.delete(oldest);
    }
  }

  function newTask(message: A2aMessage, contextId: string | undefined): TaskRecord {
    const id = `task-${randomUUID()}`;
    const ctx = contextId ?? `ctx-${randomUUID()}`;
    const now = nowIso();
    const task: A2aTask = {
      id,
      contextId: ctx,
      status: { state: 'submitted', timestamp: now },
      artifacts: [],
      history: [message],
      createdAt: now,
      updatedAt: now,
      // v0.97: transition đầu tiên (tạo task) — lịch sử bắt đầu ở đây.
      transitions: [makeA2aTransition(null, 'submitted', now)],
    };
    const record: TaskRecord = {
      task,
      controller: new AbortController(),
      settled: false,
      listeners: new Set(),
      createdAt: now,
      updatedAt: now,
    };
    tasks.set(id, record);
    eventLog.append({ kind: 'task-created', taskId: id, contextId: ctx, state: 'submitted' });
    pruneTasks();
    persistTasks();
    return record;
  }

  function setState(record: TaskRecord, state: A2aTaskState, message?: A2aMessage): void {
    const now = nowIso();
    const from = record.task.status.state;
    // v0.97: ghi transition vào task (kèm cờ legal) + event log.
    // Chuyển bất hợp lệ (vd từ trạng thái cuối) vẫn ghi lại nhưng
    // log cảnh báo stderr để lộ lỗi lập trình, không giấu lịch sử.
    const transition = makeA2aTransition(from, state, now, message ? partsToText(message.parts) : undefined);
    if (!transition.legal) {
      console.error(
        `[open-bot A2A] Chuyển trạng thái task KHÔNG HỢP LỆ: ${record.task.id} ${from} → ${state} (ghi lại để debug, không chặn).`,
      );
    }
    record.task.transitions = appendA2aTransition(record.task.transitions, transition);
    record.task.status = { state, timestamp: now, ...(message ? { message } : {}) };
    record.task.updatedAt = now;
    record.updatedAt = now;
    eventLog.append({
      kind: 'state-changed',
      taskId: record.task.id,
      contextId: record.task.contextId,
      state,
      detail: `${from} → ${state}`,
    });
    persistTasks();
    // v0.97: task tới trạng thái cuối → gửi push (nếu client đã đăng
    // ký). Fire-and-forget: lỗi gửi push chỉ ghi event log, không
    // làm hỏng task hay throw ra ngoài.
    if (pushNotifier && isA2aTerminalState(state)) {
      void pushNotifier
        .notifyIfTerminal(record.task)
        .then(({ notified, result }) => {
          if (notified) {
            eventLog.append({
              kind: 'push-notified',
              taskId: record.task.id,
              contextId: record.task.contextId,
              state,
              detail: result?.ok ? `Push OK sau ${result.attempts} lần gửi.` : `Push lỗi: ${result?.error ?? 'không rõ'}.`,
            });
          }
        })
        .catch(() => {
          // notifyIfTerminal không throw, nhưng vẫn chặn mọi lỗi lạ.
        });
    }
  }

  function emit(record: TaskRecord, event: A2aStreamEvent): void {
    for (const listener of [...record.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener lỗi không được làm hỏng run.
      }
    }
  }

  function emitTask(record: TaskRecord): void {
    emit(record, { kind: 'task', task: { ...record.task, artifacts: [...(record.task.artifacts ?? [])] } });
  }

  /** Chạy runner cho một task đã tạo; trả task cuối cùng. */
  async function runTask(record: TaskRecord, message: A2aMessage, text: string): Promise<A2aTask> {
    const { task, controller } = record;
    setState(record, 'working');
    emitTask(record);
    if (!runner) {
      setState(record, 'failed', agentMessage('Server A2A này chưa gắn agent runner — điều phối viên cần nối runner thật.'));
      record.settled = true;
      emitTask(record);
      return record.task;
    }
    const onProgress = (partialText: string): void => {
      if (record.settled) return;
      emit(record, {
        kind: 'status-update',
        taskId: task.id,
        contextId: task.contextId,
        status: { state: 'working', timestamp: nowIso(), message: agentMessage(partialText) },
        final: false,
      });
    };
    let result: A2aRunResult;
    try {
      result = await runner({
        taskId: task.id,
        contextId: task.contextId,
        text,
        message,
        signal: controller.signal,
        onProgress,
      });
    } catch (err) {
      // Runner ném lỗi mà task chưa bị hủy → failed, không throw ra ngoài.
      if (!record.settled && !controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : 'Agent chạy thất bại.';
        setState(record, 'failed', agentMessage(msg));
        record.settled = true;
        emitTask(record);
      } else if (!record.settled) {
        setState(record, 'cancelled');
        record.settled = true;
        emitTask(record);
      }
      return record.task;
    }
    // Task đã bị hủy trong lúc runner chạy → kết quả của runner bị bỏ.
    if (record.settled || controller.signal.aborted) {
      if (!record.settled) {
        setState(record, 'cancelled');
        record.settled = true;
        emitTask(record);
      }
      return record.task;
    }
    if (result.error) {
      setState(record, 'failed', agentMessage(result.error));
    } else if (result.needsInput) {
      setState(record, 'input-required', agentMessage(result.needsInput));
    } else {
      const artifacts: A2aArtifact[] = result.artifacts ?? [];
      if (typeof result.text === 'string' && result.text.length > 0) {
        artifacts.unshift({
          artifactId: `artifact-${randomUUID()}`,
          name: 'Kết quả',
          parts: [{ kind: 'text', text: result.text }],
        });
      }
      record.task.artifacts = artifacts;
      for (const artifact of artifacts) {
        emit(record, {
          kind: 'artifact-update',
          taskId: task.id,
          contextId: task.contextId,
          artifact,
          lastChunk: artifact === artifacts[artifacts.length - 1],
        });
      }
      setState(record, 'completed');
    }
    record.settled = true;
    emit(record, {
      kind: 'status-update',
      taskId: task.id,
      contextId: task.contextId,
      status: { ...record.task.status },
      final: true,
    });
    emitTask(record);
    return record.task;
  }

  function rpcOk(id: number | string | null, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id, result };
  }

  function rpcFail(
    id: number | string | null,
    code: number,
    message: string,
  ): Record<string, unknown> {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  function taskParams(params: unknown): { id: string } | null {
    if (!isRecord(params) || typeof params['id'] !== 'string') return null;
    return { id: params['id'] as string };
  }

  /**
   * Params `tasks/list` — mọi field tùy chọn. `limit` mặc định 50,
   * kẹp tối đa 100; `offset` mặc định 0; `cursor` (chuỗi số thập phân
   * do server trả ở `nextCursor`) thắng `offset` khi cả hai có mặt.
   * `contextId` lọc task theo context. `summary` (mặc định false):
   * `true` → mỗi task chỉ trả dạng gọn (xem `toTaskSummary`); sai
   * kiểu → null (caller trả -32602). Store là Map trong bộ nhớ nên
   * `offset`/`cursor` đều khả thi — không cần con trỏ ngoài.
   */
  function listParams(
    params: unknown,
  ): { limit: number; offset: number; contextId?: string; summary: boolean } | null {
    if (params === undefined || params === null) return { limit: 50, offset: 0, summary: false };
    if (!isRecord(params)) return null;
    let limit = 50;
    let offset = 0;
    if (params['limit'] !== undefined) {
      const v = params['limit'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return null;
      limit = Math.min(v, 100);
    }
    if (params['offset'] !== undefined) {
      const v = params['offset'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null;
      offset = v;
    }
    if (params['cursor'] !== undefined) {
      const v = params['cursor'];
      if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
      offset = Number(v);
    }
    let contextId: string | undefined;
    if (params['contextId'] !== undefined) {
      if (typeof params['contextId'] !== 'string') return null;
      contextId = params['contextId'];
    }
    let summary = false;
    if (params['summary'] !== undefined) {
      if (typeof params['summary'] !== 'boolean') return null;
      summary = params['summary'];
    }
    return { limit, offset, summary, ...(contextId !== undefined ? { contextId } : {}) };
  }

  /**
   * Dạng tóm tắt gọn của một task (khi `tasks/list` có `summary: true`):
   * chỉ `id`, `status`, `contextId` (nếu có), `createdAt`, `updatedAt` —
   * KHÔNG kèm `history`/`artifacts` hay field nặng khác.
   */
  function toTaskSummary(
    task: A2aTask,
  ): Pick<A2aTask, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { contextId?: string } {
    return {
      id: task.id,
      ...(typeof task.contextId === 'string' ? { contextId: task.contextId } : {}),
      status: task.status,
      ...(typeof task.createdAt === 'string' ? { createdAt: task.createdAt } : {}),
      ...(typeof task.updatedAt === 'string' ? { updatedAt: task.updatedAt } : {}),
    };
  }

  async function handleJsonRpc(msg: unknown): Promise<Record<string, unknown> | null> {
    if (!isRecord(msg) || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string') {
      const id = isRecord(msg) && (typeof msg['id'] === 'number' || typeof msg['id'] === 'string')
        ? (msg['id'] as number | string)
        : null;
      return rpcFail(id, A2A_JSON_RPC_INVALID_REQUEST, 'Request phải là JSON-RPC 2.0 { jsonrpc, method }.');
    }
    const id = (msg['id'] ?? null) as number | string | null;
    const isNotification = msg['id'] === undefined || msg['id'] === null;
    if (isNotification) return null;
    const method = msg['method'] as string;
    const params = msg['params'];

    // Method A2A dùng dấu ':' (message:send). Chấp nhận thêm dạng '/'
    // để client nội bộ cũ / gọi tay không bị vỡ.
    switch (method) {
      case 'message:send':
      case 'message/send':
      case 'message:stream':
      case 'message/stream': {
        const extracted = extractSendText(params);
        if (!extracted) {
          return rpcFail(
            id,
            A2A_JSON_RPC_INVALID_PARAMS,
            'message:send cần { message: { role: "user", parts: [{ kind: "text", text }] } }.',
          );
        }
        const contextId =
          isRecord(params) && typeof (params as Record<string, unknown>)['contextId'] === 'string'
            ? ((params as Record<string, unknown>)['contextId'] as string)
            : undefined;
        const record = newTask(extracted.message, contextId);
        // message/stream qua handleJsonRpc trực tiếp: chạy xong rồi trả
        // task cuối (SSE chỉ có ở tầng HTTP — xem startA2aHttpServer).
        // Client muốn stream thật thì dùng HTTP + A2aClient.streamMessage.
        const task = await runTask(record, extracted.message, extracted.text);
        return rpcOk(id, task);
      }
      case 'tasks:get':
      case 'tasks/get': {
        const p = taskParams(params);
        if (!p) return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, 'tasks/get cần { id: string }.');
        const record = tasks.get(p.id);
        if (!record) return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, `Không có task "${p.id}".`);
        return rpcOk(id, record.task);
      }
      case 'tasks:list':
      case 'tasks/list': {
        const p = listParams(params);
        if (!p) {
          return rpcFail(
            id,
            A2A_JSON_RPC_INVALID_PARAMS,
            'tasks/list cần params tùy chọn { limit?: number (1..100, mặc định 50), offset?: number (>= 0), cursor?: string, contextId?: string, summary?: boolean }.',
          );
        }
        // listTasks() đã mới nhất trước; lọc context rồi cắt trang.
        const all = p.contextId === undefined
          ? listTasks()
          : listTasks().filter((t) => t.contextId === p.contextId);
        const page = all.slice(p.offset, p.offset + p.limit);
        const nextOffset = p.offset + page.length;
        return rpcOk(id, {
          tasks: p.summary ? page.map(toTaskSummary) : page,
          total: all.length,
          nextCursor: nextOffset < all.length ? String(nextOffset) : null,
        });
      }
      case 'tasks:cancel':
      case 'tasks/cancel': {
        const p = taskParams(params);
        if (!p) return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, 'tasks/cancel cần { id: string }.');
        const record = tasks.get(p.id);
        if (!record) return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, `Không có task "${p.id}".`);
        // Task đã xong (runner đã settle, hoặc trạng thái cuối) thì
        // không hủy được nữa — lỗi rõ thay vì no-op im lặng. Trường
        // hợp 'cancelled' cũng tính là đã xong (hủy lần 2 là lỗi).
        if (record.settled || isA2aTerminalState(record.task.status.state)) {
          const state = record.task.status.state;
          const message =
            state === 'completed'
              ? `Task "${p.id}" đã hoàn thành (task already completed) — không thể hủy.`
              : `Task "${p.id}" đã kết thúc ở trạng thái "${state}" — không thể hủy.`;
          return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, message);
        }
        cancelTask(p.id);
        return rpcOk(id, record.task);
      }
      // v0.97: push notification config — client đăng ký webhook cho
      // một task, server POST task cuối khi task tới trạng thái cuối.
      case 'tasks:pushNotificationConfig/set':
      case 'tasks/pushNotificationConfig/set': {
        if (!pushNotifier) {
          return rpcFail(
            id,
            A2A_JSON_RPC_METHOD_NOT_FOUND,
            'Server này chưa bật pushNotifications (không gắn A2aPushNotifier) — không nhận đăng ký push.',
          );
        }
        const checked = validatePushConfig(params);
        if (!checked.ok) return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, checked.reason);
        const record = tasks.get(checked.config.taskId);
        if (!record) {
          return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, `Không có task "${checked.config.taskId}".`);
        }
        if (isA2aTerminalState(record.task.status.state)) {
          return rpcFail(
            id,
            A2A_JSON_RPC_INVALID_PARAMS,
            `Task "${checked.config.taskId}" đã kết thúc ở trạng thái "${record.task.status.state}" — đăng ký push sau khi task xong không có tác dụng.`,
          );
        }
        try {
          const saved = pushNotifier.setConfig(checked.config);
          return rpcOk(id, { taskId: saved.taskId, url: saved.url });
        } catch (err) {
          return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, err instanceof Error ? err.message : String(err));
        }
      }
      case 'tasks:pushNotificationConfig/get':
      case 'tasks/pushNotificationConfig/get': {
        const p = taskParams(params);
        if (!p) {
          return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, 'tasks/pushNotificationConfig/get cần { id: string }.');
        }
        const config = pushNotifier?.getConfig(p.id);
        if (!config) return rpcOk(id, { taskId: p.id, url: null });
        return rpcOk(id, { taskId: config.taskId, url: config.url });
      }
      // v0.97: resubscribe — client nối lại sau khi mất kết nối, lấy
      // task hiện tại kèm toàn bộ transitions để đồng bộ lại.
      case 'tasks/resubscribe':
      case 'tasks:resubscribe': {
        const p = taskParams(params);
        if (!p) return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, 'tasks/resubscribe cần { id: string }.');
        const record = tasks.get(p.id);
        if (!record) return rpcFail(id, A2A_JSON_RPC_INVALID_PARAMS, `Không có task "${p.id}".`);
        return rpcOk(id, record.task);
      }
      default:
        return rpcFail(id, A2A_JSON_RPC_METHOD_NOT_FOUND, `Không hỗ trợ method "${method}".`);
    }
  }

  function getTask(taskId: string): A2aTask | undefined {
    const record = tasks.get(taskId);
    return record
      ? {
          ...record.task,
          artifacts: [...(record.task.artifacts ?? [])],
          transitions: [...(record.task.transitions ?? [])],
        }
      : undefined;
  }

  function listTasks(): A2aTask[] {
    // Map giữ thứ tự tạo (cũ → mới); list trả mới nhất trước.
    return [...tasks.values()].reverse().map((r) => ({ ...r.task }));
  }

  function cancelTask(taskId: string): A2aTask | undefined {
    const record = tasks.get(taskId);
    if (!record) return undefined;
    if (!record.settled && !isA2aTerminalState(record.task.status.state)) {
      record.controller.abort();
      record.settled = true;
      setState(record, 'cancelled');
      emitTask(record);
      log(`task ${taskId} đã hủy theo yêu cầu client.`);
    }
    return record.task;
  }

  // API nội bộ cho tầng HTTP: tạo task + chạy có stream event.
  const internals = {
    setCardUrl,
    createTaskForStream(
      message: A2aMessage,
      contextId: string | undefined,
    ): TaskRecord {
      return newTask(message, contextId);
    },
    runTask,
    subscribe(record: TaskRecord, listener: (event: A2aStreamEvent) => void): () => void {
      record.listeners.add(listener);
      return () => record.listeners.delete(listener);
    },
  };

  const server: A2aServer & { _internals: typeof internals } = {
    getAgentCard,
    getPersistStatus,
    handleJsonRpc,
    getTask,
    listTasks,
    cancelTask,
    getTaskTransitions(taskId: string) {
      const record = tasks.get(taskId);
      return record ? [...(record.task.transitions ?? [])] : [];
    },
    getEventLog() {
      return eventLog.list();
    },
    setPushNotificationConfig(config: A2aPushNotificationConfig) {
      if (!pushNotifier) {
        throw new Error('Server này chưa bật pushNotifications (không gắn A2aPushNotifier).');
      }
      return pushNotifier.setConfig(config);
    },
    getPushNotificationConfig(taskId: string) {
      return pushNotifier?.getConfig(taskId);
    },
    resubscribe(taskId: string) {
      return getTask(taskId);
    },
    subscribeToTask(taskId: string, onEvent: (event: A2aStreamEvent) => void) {
      const record = tasks.get(taskId);
      if (!record) return undefined;
      // Replay trạng thái hiện tại trước để client đồng bộ ngay.
      onEvent({ kind: 'task', task: getTask(taskId) as A2aTask });
      // Task đã tới trạng thái cuối: không còn event nào nữa — client
      // tự đóng stream sau khi nhận event replay này.
      if (record.settled || isA2aTerminalState(record.task.status.state)) {
        return () => undefined;
      }
      record.listeners.add(onEvent);
      return () => record.listeners.delete(onEvent);
    },
    startStream(input, onEvent) {
      const record = internals.createTaskForStream(input.message, input.contextId);
      const unsubscribe = internals.subscribe(record, onEvent);
      // Event đầu (task vừa tạo, trạng thái `submitted`) đẩy ngay để
      // client biết task id sớm — giống server độc lập trước đây.
      onEvent({ kind: 'task', task: getTask(record.task.id) as A2aTask });
      const done = internals
        .runTask(record, input.message, input.text)
        .finally(() => unsubscribe());
      return {
        taskId: record.task.id,
        task: getTask(record.task.id) as A2aTask,
        done,
        cancel: () => {
          cancelTask(record.task.id);
        },
      };
    },
    _internals: internals,
  };
  return server;
}

export type A2aServerWithInternals = ReturnType<typeof createA2aServer> & {
  _internals: {
    setCardUrl: (url: string) => void;
    createTaskForStream: (message: A2aMessage, contextId: string | undefined) => TaskRecord;
    runTask: (record: TaskRecord, message: A2aMessage, text: string) => Promise<A2aTask>;
    subscribe: (record: TaskRecord, listener: (event: A2aStreamEvent) => void) => () => void;
  };
};

export interface A2aHttpServer {
  readonly port: number;
  /** URL gốc (endpoint JSON-RPC) — cũng là `url` trong Agent Card. */
  readonly url: string;
  readonly cardUrl: string;
  readonly isRunning: boolean;
  close(): Promise<void>;
}

function tokenMatches(presented: string, accepted: string[]): boolean {
  const presentedBuf = Buffer.from(presented, 'utf8');
  for (const candidate of accepted) {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (presentedBuf.length !== candidateBuf.length) continue;
    if (timingSafeEqual(presentedBuf, candidateBuf)) return true;
  }
  return false;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > A2A_MAX_BODY_BYTES) throw new Error('Request body quá lớn (tối đa 1 MB).');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Chạy A2A server qua HTTP trên loopback. `options` là option của
 * `createA2aServer` (runner, skill, token...). Trả `{ port, url,
 * cardUrl, close }`. Điều phối viên nối vào Local API sau bằng cách
 * dùng `createA2aServer` + `handleJsonRpc`/`getAgentCard` trực tiếp
 * thay vì chạy server HTTP riêng.
 */
export function startA2aHttpServer(
  options: A2aServerOptions = {},
  httpOptions: { port?: number; host?: string } = {},
): Promise<A2aHttpServer> {
  // v0.97: host bind theo policy mạng — mặc định 127.0.0.1. Host tường
  // minh mà không phải loopback thì chỉ cho khi policy cho phép expose
  // ngoài (cả hai cờ); nếu không thì throw ngay thay vì bind lén.
  let host: string;
  if (httpOptions.host !== undefined) {
    host = httpOptions.host;
    if (!isLoopbackHost(host) && host !== '0.0.0.0' && host !== '::') {
      throw new Error(`A2A server chỉ bind loopback hoặc 0.0.0.0, không bind host "${host}".`);
    }
    if ((host === '0.0.0.0' || host === '::') && !options.networkPolicy?.allowExternal) {
      throw new Error(
        'A2A server không bind 0.0.0.0 khi policy mạng chưa cho phép expose ngoài — ' +
          'bật "Cho phép agent ngoài mạng" trong Settings → A2A và xác nhận cảnh báo trước.',
      );
    }
    if (host === '::') host = '0.0.0.0';
  } else {
    host = resolveA2aBindHost(options.networkPolicy);
  }
  const requestedPort = httpOptions.port ?? 0;
  const server = createA2aServer(options) as A2aServerWithInternals;
  const acceptedTokens = options.token ? [options.token] : [];
  let httpServer: http.Server | null = null;
  let boundPort = 0;

  function isAuthorized(req: http.IncomingMessage): boolean {
    if (acceptedTokens.length === 0) return true;
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    return tokenMatches(header.slice('Bearer '.length), acceptedTokens);
  }

  const srv = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (!isAuthorized(req)) {
          sendJson(res, 401, { error: 'Missing or invalid Authorization: Bearer token.' });
          return;
        }

        // Agent Card — discovery (A2A 1.0, header version đi kèm).
        if (method === 'GET' && path === '/.well-known/agent-card.json') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'A2A-Version': A2A_PROTOCOL_VERSION,
          });
          res.end(JSON.stringify(server.getAgentCard()));
          return;
        }

        // GET /tasks/:id — tiện poll/debug bằng tay.
        const taskGetMatch = /^\/tasks\/([^/]+)$/.exec(path);
        if (method === 'GET' && taskGetMatch) {
          const task = server.getTask(decodeURIComponent(taskGetMatch[1]));
          if (!task) {
            sendJson(res, 404, { error: 'Task not found.' });
            return;
          }
          sendJson(res, 200, task);
          return;
        }

        // v0.97: GET /tasks/:id/events — resubscribe SSE: client mất
        // kết nối nối lại để nhận tiếp event của task đang chạy.
        // Replay task hiện tại trước, rồi stream event tiếp theo;
        // khi task tới trạng thái cuối thì đóng stream. Ngắt kết nối
        // CHỈ gỡ listener, KHÔNG hủy task (task thuộc về run gốc).
        const taskEventsMatch = /^\/tasks\/([^/]+)\/events$/.exec(path);
        if (method === 'GET' && taskEventsMatch) {
          const taskId = decodeURIComponent(taskEventsMatch[1]);
          const task = server.getTask(taskId);
          if (!task) {
            sendJson(res, 404, { error: 'Task not found.' });
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'A2A-Version': A2A_PROTOCOL_VERSION,
          });
          let closed = false;
          const sendEvent = (event: A2aStreamEvent): void => {
            if (closed) return;
            const payload = JSON.stringify({ jsonrpc: '2.0', id: null, result: event });
            res.write(`data: ${payload}\n\n`);
            // Task tới trạng thái cuối → đóng stream (client đã có task cuối).
            if (event.kind === 'task' && isA2aTerminalState(event.task.status.state)) {
              closed = true;
              try {
                res.end();
              } catch {
                // Client đã đóng.
              }
              unsubscribe();
            }
          };
          // `let` + no-op mặc định: subscribeToTask replay event hiện
          // tại ĐỒNG BỘ (gọi sendEvent ngay) — `unsubscribe` phải tồn
          // tại trước lúc đó, không được dùng `const` gán sau.
          let unsubscribe: () => void = () => undefined;
          unsubscribe = server.subscribeToTask(taskId, sendEvent) ?? (() => undefined);
          // Task đã xong từ trước: subscribeToTask đã replay event
          // cuối nhưng chưa đóng stream (trả no-op) — đóng ở đây.
          if (isA2aTerminalState(task.status.state) && !closed) {
            closed = true;
            try {
              res.end();
            } catch {
              // Client đã đóng.
            }
            unsubscribe();
          }
          req.on('close', () => {
            closed = true;
            unsubscribe();
          });
          return;
        }

        if (method === 'POST' && (path === '/' || path === '/a2a')) {
          const text = await readBody(req);
          let msg: unknown;
          try {
            msg = JSON.parse(text);
          } catch {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: null,
              error: { code: A2A_JSON_RPC_PARSE_ERROR, message: 'Request không phải JSON hợp lệ.' },
            });
            return;
          }
          if (Array.isArray(msg)) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: null,
              error: { code: A2A_JSON_RPC_INVALID_REQUEST, message: 'A2A không hỗ trợ JSON-RPC batching.' },
            });
            return;
          }
          // message:stream qua HTTP: trả SSE, không đợi task xong.
          // Logic stream (tạo task / chạy / event / hủy) nằm trong
          // server.startStream — mount Local API dùng chung hàm này.
          if (isRecord(msg) && (msg['method'] === 'message:stream' || msg['method'] === 'message/stream')) {
            const rpcId = (msg['id'] ?? null) as number | string | null;
            const extracted = extractSendText(msg['params']);
            if (!extracted) {
              sendJson(res, 200, {
                jsonrpc: '2.0',
                id: rpcId,
                error: { code: A2A_JSON_RPC_INVALID_PARAMS, message: 'message:stream cần { message: { parts: [...] } }.' },
              });
              return;
            }
            const params = isRecord(msg['params']) ? (msg['params'] as Record<string, unknown>) : {};
            const contextId = typeof params['contextId'] === 'string' ? (params['contextId'] as string) : undefined;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'A2A-Version': A2A_PROTOCOL_VERSION,
            });
            const sendEvent = (event: A2aStreamEvent): void => {
              const payload = JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: event });
              res.write(`data: ${payload}\n\n`);
            };
            const stream = server.startStream(
              { message: extracted.message, text: extracted.text, contextId },
              sendEvent,
            );
            // Client ngắt stream giữa chừng: hủy task đang chạy.
            // (`close` cũng bắn khi response kết thúc bình thường —
            // lúc đó cancel() là no-op vì task đã settle.)
            req.on('close', () => stream.cancel());
            try {
              await stream.done;
            } finally {
              try {
                res.end();
              } catch {
                // Client đã đóng.
              }
            }
            return;
          }
          const response = await server.handleJsonRpc(msg);
          if (!response) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, 200, response);
          return;
        }

        sendJson(res, 404, { error: `Unknown route: ${method} ${path}` });
      } catch (err) {
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : 'Lỗi nội bộ server.';
          sendJson(res, /quá lớn/.test(message) ? 400 : 500, { error: message });
        }
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Lỗi nội bộ server.' });
    });
  });

  return new Promise<A2aHttpServer>((resolve, reject) => {
    srv.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Cổng A2A ${requestedPort} đã có app khác dùng — chọn cổng khác.`));
      } else {
        reject(err);
      }
    });
    srv.listen(requestedPort, host, () => {
      httpServer = srv;
      boundPort = (srv.address() as { port: number }).port;
      server._internals.setCardUrl(`http://${host}:${boundPort}/`);
      resolve({
        get port() {
          return boundPort;
        },
        get url() {
          return `http://${host}:${boundPort}/`;
        },
        get cardUrl() {
          return `http://${host}:${boundPort}/.well-known/agent-card.json`;
        },
        get isRunning() {
          return httpServer !== null && httpServer.listening;
        },
        close(): Promise<void> {
          if (!httpServer) return Promise.resolve();
          const s = httpServer;
          httpServer = null;
          boundPort = 0;
          return new Promise<void>((done) => s.close(() => done()));
        },
      });
    });
  });
}
