/**
 * v0.90d (Đội G): khởi động lại Local API có backoff.
 *
 * Pure helper, không I/O — main process dùng nó để thử lại
 * `startApiServer()` khi khởi động thất bại (port bận, ...) hoặc
 * khi server chết đột ngột (`onUnexpectedClose` của
 * `createApiServer`), thay vì chỉ log một dòng rồi im lặng như
 * trước. Tối đa 5 lần thử, khoảng tăng dần 1s → 2s → 4s → 8s →
 * 16s; hết lần thì host báo rõ (log + `api:get.lastError` cho
 * Settings) thay vì thử vô hạn.
 *
 * Không có retry cho `EADDRINUSE` riêng — port bận có thể hết khi
 * tiến trình khác thoát, và 5 lần thử cách nhau tối đa 16s là đủ
 * rẻ; hết 5 lần thì lỗi hiện rõ trong Settings để người dùng đổi
 * port. Host huỷ vòng retry bằng `shouldRetry` (vd tắt API giữa
 * chừng, đổi cấu hình, hoặc app đang thoát).
 */

/** v0.90d: số lần thử tối đa (lần đầu + 4 lần thử lại). */
export const API_RESTART_MAX_ATTEMPTS = 5;

/** v0.90d: khoảng chờ sau lần thất bại đầu tiên (ms). */
export const API_RESTART_BASE_DELAY_MS = 1_000;

/** v0.90d: trần khoảng chờ giữa các lần thử (ms). */
export const API_RESTART_MAX_DELAY_MS = 16_000;

/**
 * v0.90d: khoảng chờ (ms) sau lần thất bại thứ `attempt`
 * (1-based: lần 1 → 1000, lần 2 → 2000, lần 3 → 4000, lần 4 →
 * 8000, từ lần 5 trở đi → 16000). Ném lỗi khi `attempt` < 1.
 */
export function apiRestartDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('apiRestartDelayMs cần attempt là số nguyên >= 1.');
  }
  return Math.min(
    API_RESTART_MAX_DELAY_MS,
    API_RESTART_BASE_DELAY_MS * 2 ** (attempt - 1),
  );
}

export interface RetryWithBackoffOptions {
  /** Số lần thử tối đa (mặc định API_RESTART_MAX_ATTEMPTS = 5). */
  maxAttempts?: number;
  /** Khoảng chờ sau lần thất bại thứ n (mặc định apiRestartDelayMs). */
  delayFor?: (attempt: number) => number;
  /**
   * Kiểm tra trước mỗi lần thử lại — trả false thì dừng ngay
   * (host dùng để huỷ khi API bị tắt / đổi cấu hình / app thoát).
   * Không kiểm tra trước lần thử đầu tiên.
   */
  shouldRetry?: () => boolean;
  /** Gọi sau mỗi lần thất bại (kể cả lần cuối, trước khi bỏ cuộc). */
  onAttemptFailed?: (error: unknown, attempt: number) => void;
}

export interface RetryWithBackoffResult {
  ok: boolean;
  /** Số lần đã thử (1 = thành công ngay lần đầu). */
  attempts: number;
  /** Lỗi của lần thử cuối (chỉ khi ok === false). */
  error?: unknown;
}

/**
 * v0.90d: thử `fn()` tới khi thành công hoặc hết `maxAttempts`,
 * chờ `delayFor(attempt)` giữa các lần thử. Không bao giờ throw —
 * kết quả nằm trong `{ ok, attempts, error }` để host quyết định
 * báo lỗi ra sao (log + UI). `shouldRetry() === false` thì dừng
 * ngay sau lần thất bại hiện tại (không chờ thêm).
 */
export async function retryWithBackoff(
  fn: () => Promise<void> | void,
  options: RetryWithBackoffOptions = {},
): Promise<RetryWithBackoffResult> {
  const maxAttempts = options.maxAttempts ?? API_RESTART_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('retryWithBackoff cần maxAttempts là số nguyên >= 1.');
  }
  const delayFor = options.delayFor ?? apiRestartDelayMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await fn();
      return { ok: true, attempts: attempt };
    } catch (err) {
      options.onAttemptFailed?.(err, attempt);
      if (attempt >= maxAttempts) return { ok: false, attempts: attempt, error: err };
      if (options.shouldRetry && !options.shouldRetry()) {
        return { ok: false, attempts: attempt, error: err };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, delayFor(attempt))),
      );
    }
  }
}
