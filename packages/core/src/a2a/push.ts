/**
 * Push notifications A2A (v0.97, Đội T2) — `tasks/pushNotificationConfig`.
 *
 * A2A 1.0 cho client đăng ký một webhook URL cho một task: khi task
 * tới trạng thái cuối (completed/failed/cancelled...), server POST
 * task cuối tới URL đó thay vì bắt client poll mãi. Trước sóng này
 * capability `pushNotifications` báo false và không có method nào.
 *
 * Thiết kế:
 *  - Config theo taskId: `{ taskId, url, token? }` — token (nếu có)
 *    gửi kèm header `Authorization: Bearer <token>`.
 *  - URL webhook cũng chịu policy mạng: loopback mặc định; URL ngoài
 *    chỉ khi policy cho phép expose ngoài (xem `a2a/network.ts`).
 *  - Gửi tối đa 3 lần (lần đầu + 2 retry, backoff 1s → 2s), timeout
 *    mỗi lần 10s; hết lượt vẫn lỗi thì ghi event log, không crash
 *    server, task vẫn giữ trạng thái cuối của nó.
 *  - Payload POST: `{ taskId, state, task }` (task đầy đủ để receiver
 *    không cần gọi lại `tasks/get`).
 *  - Store config trong bộ nhớ theo mặc định; caller có thể truyền
 *    `A2aPushConfigStore` (vd file-backed) để config sống qua restart.
 *    Config của task đã tới trạng thái cuối thì tự xoá sau khi gửi.
 *
 * Chỉ dùng global `fetch` + Node stdlib, không thêm dependency.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { A2aPushNotificationConfig, A2aTask, A2aTaskState } from './types';
import { isA2aTerminalState } from './types';

export type { A2aPushNotificationConfig };
import {
  checkA2aUrlAllowed,
  type A2aNetworkPolicy,
} from './network';

/** Store config push — tối giản, đồng bộ như `A2aTaskStore`. */
export interface A2aPushConfigStore {
  load(): A2aPushNotificationConfig[];
  save(configs: A2aPushNotificationConfig[]): void;
}

/** Số lần gửi tối đa cho một lần notify (1 lần đầu + 2 retry). */
export const A2A_PUSH_MAX_ATTEMPTS = 3;
/** Timeout mỗi lần POST (10s). */
export const A2A_PUSH_TIMEOUT_MS = 10_000;
/** Delay trước retry đầu tiên (1s, nhân đôi mỗi lần). */
export const A2A_PUSH_RETRY_DELAY_MS = 1_000;

/** Kết quả một lần gửi push. */
export interface A2aPushDeliveryResult {
  ok: boolean;
  attempts: number;
  /** HTTP status lần cuối (undefined khi lỗi mạng/timeout). */
  status?: number;
  error?: string;
}

/** Validate config push: taskId + URL http(s) hợp lệ. */
export function validatePushConfig(
  config: unknown,
): { ok: true; config: A2aPushNotificationConfig } | { ok: false; reason: string } {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { ok: false, reason: 'Push config phải là object { taskId, url, token? }.' };
  }
  const rec = config as Record<string, unknown>;
  if (typeof rec['taskId'] !== 'string' || (rec['taskId'] as string).trim().length === 0) {
    return { ok: false, reason: 'Push config cần taskId (string, không rỗng).' };
  }
  if (typeof rec['url'] !== 'string' || (rec['url'] as string).trim().length === 0) {
    return { ok: false, reason: 'Push config cần url (webhook http(s)).' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rec['url'] as string);
  } catch {
    return { ok: false, reason: `Push url không hợp lệ: ${rec['url'] as string}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Push url phải là http(s), không phải "${parsed.protocol}".` };
  }
  if (rec['token'] !== undefined && typeof rec['token'] !== 'string') {
    return { ok: false, reason: 'Push token (nếu có) phải là string.' };
  }
  return {
    ok: true,
    config: {
      taskId: (rec['taskId'] as string).trim(),
      url: (rec['url'] as string).trim(),
      ...(typeof rec['token'] === 'string' && (rec['token'] as string).length > 0
        ? { token: rec['token'] as string }
        : {}),
    },
  };
}

/** Payload POST tới webhook khi task tới trạng thái cuối. */
export function buildPushPayload(task: A2aTask): {
  taskId: string;
  state: A2aTaskState;
  task: A2aTask;
} {
  return { taskId: task.id, state: task.status.state, task };
}

/**
 * Gửi một lần POST push (có retry + backoff). `sleep` tiêm được
 * để test không chờ thật. Chỉ trả về khi đã gửi xong hoặc hết lượt
 * — không throw (lỗi nằm trong result).
 */
export async function deliverPushNotification(
  config: A2aPushNotificationConfig,
  task: A2aTask,
  options: {
    timeoutMs?: number;
    maxAttempts?: number;
    initialDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<A2aPushDeliveryResult> {
  const timeoutMs = options.timeoutMs ?? A2A_PUSH_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? A2A_PUSH_MAX_ATTEMPTS));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let delayMs = Math.max(0, options.initialDelayMs ?? A2A_PUSH_RETRY_DELAY_MS);
  let lastError = '';
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify(buildPushPayload(task)),
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.ok) return { ok: true, attempts: attempt, status: res.status };
      lastError = `Webhook trả HTTP ${res.status}.`;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') lastError = `Timeout sau ${timeoutMs}ms.`;
      else lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) {
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
  return { ok: false, attempts: maxAttempts, status: lastStatus, error: lastError };
}

/**
 * Notifier push của server: giữ config theo taskId, gửi khi task
 * tới trạng thái cuối. Server gọi `notifyIfTerminal(task)` sau mỗi
 * lần `setState` — task chưa tới trạng thái cuối thì no-op.
 */
export class A2aPushNotifier {
  private readonly configs = new Map<string, A2aPushNotificationConfig>();
  private readonly store?: A2aPushConfigStore;
  private readonly networkPolicy?: A2aNetworkPolicy;
  private readonly deliver: typeof deliverPushNotification;
  /** Lịch sử gửi gần nhất theo taskId (để debug/UI đọc). */
  private readonly lastResults = new Map<string, A2aPushDeliveryResult>();

  constructor(
    options: {
      store?: A2aPushConfigStore;
      networkPolicy?: A2aNetworkPolicy;
      deliver?: typeof deliverPushNotification;
    } = {},
  ) {
    this.store = options.store;
    this.networkPolicy = options.networkPolicy;
    this.deliver = options.deliver ?? deliverPushNotification;
    if (this.store) {
      try {
        for (const c of this.store.load()) {
          const v = validatePushConfig(c);
          if (v.ok) this.configs.set(v.config.taskId, v.config);
        }
      } catch {
        // Store hỏng → bắt đầu rỗng, không crash server.
      }
    }
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.save([...this.configs.values()]);
    } catch {
      // Lỗi ghi store push không được làm hỏng task — log stderr.
      console.error('[open-bot A2A] Không lưu được push config xuống store.');
    }
  }

  /**
   * Đăng ký config push cho một task. URL ngoài loopback bị chặn
   * khi policy chưa cho phép (throw lỗi rõ ràng). Ghi đè config cũ
   * của cùng taskId.
   */
  setConfig(config: A2aPushNotificationConfig): A2aPushNotificationConfig {
    const v = validatePushConfig(config);
    if (!v.ok) throw new Error(v.reason);
    const check = checkA2aUrlAllowed(v.config.url, this.networkPolicy);
    if (!check.allowed) throw new Error(check.reason ?? 'Push URL không được phép theo policy mạng A2A.');
    this.configs.set(v.config.taskId, v.config);
    this.persist();
    return v.config;
  }

  getConfig(taskId: string): A2aPushNotificationConfig | undefined {
    return this.configs.get(taskId);
  }

  removeConfig(taskId: string): boolean {
    const had = this.configs.delete(taskId);
    if (had) this.persist();
    return had;
  }

  listConfigs(): A2aPushNotificationConfig[] {
    return [...this.configs.values()];
  }

  getLastResult(taskId: string): A2aPushDeliveryResult | undefined {
    return this.lastResults.get(taskId);
  }

  /**
   * Gửi push khi task tới trạng thái cuối; task chưa cuối → no-op
   * (trả `{ notified: false }`). Config tự xoá sau khi gửi (dù
   * thành công hay hết lượt) để không gửi trùng khi task bị chạm
   * lại. Không bao giờ throw.
   */
  async notifyIfTerminal(task: A2aTask): Promise<{ notified: boolean; result?: A2aPushDeliveryResult }> {
    if (!isA2aTerminalState(task.status.state)) return { notified: false };
    const config = this.configs.get(task.id);
    if (!config) return { notified: false };
    this.configs.delete(task.id);
    this.persist();
    let result: A2aPushDeliveryResult;
    try {
      result = await this.deliver(config, task);
    } catch (err) {
      result = {
        ok: false,
        attempts: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.lastResults.set(task.id, result);
    return { notified: true, result };
  }
}

/** Tên file push config mặc định dưới userData (`a2a-push-configs.json`). */
export const A2A_PUSH_CONFIGS_FILE_NAME = 'a2a-push-configs.json';

/**
 * Store push config xuống file JSON (ghi atomic, mode 0600 — config
 * có thể kèm token nhạy cảm trong header, không để quyền đọc cho
 * user khác). `load()`: file thiếu/hỏng → `[]` + log stderr, không
 * throw; entry hỏng lẻ thì bỏ entry đó. `save()` throw khi không ghi
 * được (notifier bắt lỗi này ở `persist()` nên không crash server).
 */
export function createFilePushConfigStore(filePath: string): A2aPushConfigStore {
  return {
    load(): A2aPushNotificationConfig[] {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        console.error(
          `[open-bot A2A] Không đọc được file push config (${filePath}) — bắt đầu rỗng:`,
          err instanceof Error ? err.message : err,
        );
        return [];
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error(
          `[open-bot A2A] File push config hỏng (không phải JSON): ${filePath} — bỏ qua, bắt đầu rỗng.`,
        );
        return [];
      }
      if (!Array.isArray(parsed)) {
        console.error(
          `[open-bot A2A] File push config hỏng (JSON không phải mảng): ${filePath} — bỏ qua, bắt đầu rỗng.`,
        );
        return [];
      }
      const valid: A2aPushNotificationConfig[] = [];
      for (const entry of parsed) {
        const v = validatePushConfig(entry);
        if (v.ok) valid.push(v.config);
      }
      if (valid.length !== parsed.length) {
        console.error(
          `[open-bot A2A] File push config (${filePath}) có ${parsed.length - valid.length} entry hỏng — đã bỏ qua, giữ ${valid.length} config hợp lệ.`,
        );
      }
      return valid;
    },

    save(configs: A2aPushNotificationConfig[]): void {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify(configs);
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      try {
        fs.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
        try {
          fs.chmodSync(filePath, 0o600);
        } catch {
          // Best-effort.
        }
      } catch (err) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // File tạm có thể chưa được tạo.
        }
        throw err;
      }
    },
  };
}
