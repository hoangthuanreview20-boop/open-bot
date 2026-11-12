/**
 * File-backed store cho task A2A (v0.25, W18c).
 *
 * Task A2A trước đây chỉ sống trong Map bộ nhớ của `createA2aServer`
 * — restart là mất (ghi chú v0.23/v0.25). Store này giữ task qua
 * restart bằng một file JSON, KHÔNG đổi hành vi khi không dùng:
 * `createA2aServer` không nhận `taskStore` thì vẫn Map trong bộ nhớ
 * như cũ.
 *
 * Shape store (đồng bộ, cố tình đơn giản — task không đổi liên tục
 * nên save đồng bộ mỗi lần đổi là đủ, không debounce):
 *   interface A2aTaskStore { load(): A2aTask[]; save(tasks: A2aTask[]): void; }
 *
 * `createFileTaskStore(filePath)`:
 * - `load()`: file thiếu → `[]`; file hỏng (không phải JSON, không
 *   phải mảng, entry không có `id`/`status.state` hợp lệ) → `[]`
 *   (entry hỏng lẻ thì chỉ bỏ entry đó) + log stderr rõ ràng, KHÔNG
 *   throw — server vẫn khởi động bình thường.
 * - `save(tasks)`: ghi atomic (file tạm cùng thư mục + rename) với
 *   mode 0600 — task có thể chứa nội dung nhạy cảm (history/text
 *   người dùng) nên file không để quyền đọc cho user khác. Ghi lỗi
 *   (vd thư mục chỉ đọc) thì throw để caller log — server bắt lỗi
 *   này ở `persistTasks()` nên không crash; task vẫn giữ trong bộ
 *   nhớ. Thư mục cha được tạo nếu chưa có.
 *
 * File lưu mảng task theo thứ tự tạo (cũ → mới) — cùng thứ tự Map
 * trong server — để lúc load lại giữ nguyên thứ tự và prune đúng
 * task cũ nhất. Chỉ dùng Node stdlib, không thêm dependency.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { A2aTask } from './types';

/**
 * Store task A2A — tối giản, đồng bộ. `load` không bao giờ throw vì
 * file hỏng/thiếu (trả `[]`); `save` throw khi không ghi được để
 * caller tự log/quyết định (server log stderr, không crash).
 */
export interface A2aTaskStore {
  /** Mọi task đã lưu, theo thứ tự tạo (cũ → mới). File thiếu/hỏng → `[]`. */
  load(): A2aTask[];
  /** Ghi đè toàn bộ task (server gọi mỗi khi task đổi, xem `persistTasks`). */
  save(tasks: A2aTask[]): void;
}

/**
 * Tên file mặc định dưới thư mục dữ liệu của app
 * (`<userData>/a2a-tasks.json`) — main process nối store khi tạo
 * A2A server cho mount Local API (xem ghi chú ở api/server.ts).
 */
export const A2A_TASKS_FILE_NAME = 'a2a-tasks.json';

/**
 * v0.28: retry khi lưu task A2A lỗi.
 *
 * Lưu task trước đây chỉ thử đúng 1 lần: lỗi đĩa thoáng qua (vd file
 * đang bị khóa, ổ đĩa bận) là mất lần lưu đó ngay, chỉ còn log stderr
 * mà người dùng không bao giờ thấy. `saveTaskStoreWithRetry` thử lại
 * tối đa `A2A_PERSIST_MAX_ATTEMPTS` lần với backoff mũ
 * (`A2A_PERSIST_RETRY_DELAY_MS`, ×2 mỗi lần: 50ms → 100ms, tổng chờ
 * tối đa ~150ms). Store là đồng bộ theo interface `A2aTaskStore` nên
 * chờ cũng đồng bộ (`Atomics.wait`) — chỉ chạy trên đường lỗi, hiếm,
 * và tối đa 150ms nên không đáng kể với vòng lặp chính; đổi lại
 * không phải đổi toàn bộ server/store sang async chỉ vì một lần ghi.
 */
export const A2A_PERSIST_MAX_ATTEMPTS = 3;
export const A2A_PERSIST_RETRY_DELAY_MS = 50;
export const A2A_PERSIST_RETRY_BACKOFF_FACTOR = 2;

export interface A2aPersistResult {
  /** true khi đã lưu được (kể cả sau retry); false khi hết lượt vẫn lỗi. */
  ok: boolean;
  /** Số lần đã thử `save` (1 = thành công ngay lần đầu). */
  attempts: number;
  /** Lỗi của lần thử cuối (chỉ có khi `ok` false). */
  error?: Error;
}

export interface SaveWithRetryOptions {
  /** Tổng số lần thử tối đa, kể cả lần đầu (mặc định 3). */
  maxAttempts?: number;
  /** Thời gian chờ trước retry đầu tiên, ms (mặc định 50). */
  initialDelayMs?: number;
  /** Hệ số nhân delay mỗi lần retry (mặc định 2). */
  backoffFactor?: number;
  /** Hàm chờ đồng bộ (mặc định `Atomics.wait`); test tiêm hàm giả để không chờ thật. */
  sleep?: (ms: number) => void;
}

/** Chờ đồng bộ `ms` mili-giây (dùng `Atomics.wait`, Node stdlib). */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Môi trường lạ không cho Atomics.wait: chờ bằng vòng lặp bận
    // ngắn để vẫn giữ đúng thứ tự thử lại (không throw).
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* chờ */
    }
  }
}

/**
 * Lưu task qua `store.save` với retry + backoff. Không bao giờ throw:
 * hết lượt vẫn lỗi thì trả `{ ok: false, attempts, error }` để caller
 * (A2A server) ghi log, cập nhật trạng thái và báo lên UI.
 */
export function saveTaskStoreWithRetry(
  store: A2aTaskStore,
  tasks: A2aTask[],
  options: SaveWithRetryOptions = {},
): A2aPersistResult {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? A2A_PERSIST_MAX_ATTEMPTS));
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? A2A_PERSIST_RETRY_DELAY_MS);
  const backoffFactor = Math.max(1, options.backoffFactor ?? A2A_PERSIST_RETRY_BACKOFF_FACTOR);
  const sleep = options.sleep ?? sleepSync;
  let lastError: Error | undefined;
  let delayMs = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      store.save(tasks);
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) sleep(delayMs);
      delayMs *= backoffFactor;
    }
  }
  return { ok: false, attempts: maxAttempts, error: lastError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Entry đủ tối thiểu để server khôi phục thành task dùng được. */
function isValidTask(value: unknown): value is A2aTask {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['id'] as string).length > 0 &&
    isRecord(value['status']) &&
    typeof (value['status'] as Record<string, unknown>)['state'] === 'string'
  );
}

/** Tạo store lưu task A2A xuống file JSON `filePath` (ghi atomic, mode 0600). */
export function createFileTaskStore(filePath: string): A2aTaskStore {
  return {
    load(): A2aTask[] {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        // File chưa có lần nào (chạy lần đầu) là bình thường — không log.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        console.error(
          `[open-bot A2A] Không đọc được file task A2A (${filePath}) — bắt đầu với danh sách rỗng:`,
          err instanceof Error ? err.message : err,
        );
        return [];
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error(
          `[open-bot A2A] File task A2A hỏng (không phải JSON hợp lệ): ${filePath} — bỏ qua toàn bộ, bắt đầu với danh sách rỗng.`,
        );
        return [];
      }
      if (!Array.isArray(parsed)) {
        console.error(
          `[open-bot A2A] File task A2A hỏng (JSON không phải mảng): ${filePath} — bỏ qua toàn bộ, bắt đầu với danh sách rỗng.`,
        );
        return [];
      }
      const valid = parsed.filter(isValidTask);
      if (valid.length !== parsed.length) {
        console.error(
          `[open-bot A2A] File task A2A (${filePath}) có ${parsed.length - valid.length} entry hỏng (thiếu id/status) — đã bỏ qua, giữ ${valid.length} task hợp lệ.`,
        );
      }
      return valid;
    },

    save(tasks: A2aTask[]): void {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify(tasks);
      // File tạm tên duy nhất cùng thư mục (rename cùng filesystem
      // mới atomic được) — mode 0600 ngay lúc tạo.
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      try {
        fs.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
        // rename giữ mode của file tạm; chmod lại cho chắc (vd FS lạ).
        try {
          fs.chmodSync(filePath, 0o600);
        } catch {
          // Best-effort — file đã ghi xong, mode sai không đáng crash.
        }
      } catch (err) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // File tạm có thể chưa được tạo — bỏ qua.
        }
        throw err;
      }
    },
  };
}
