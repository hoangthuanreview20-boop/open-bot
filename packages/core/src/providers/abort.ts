/**
 * v0.15 — AbortSignal cho một lần gọi provider.
 *
 * Plumbing chung để hủy một lần gọi chat đang chạy (người dùng bấm dừng,
 * timeout của run, subagent bị dừng...). Luồng chuẩn:
 *
 *   1. Người gọi tạo controller bằng `createAbortController()` (hoặc dùng
 *      signal của run đã có sẵn, vd `AgentRunnerOptions.signal`).
 *   2. Truyền `signal` vào `ChatCompletionRequest` (`types.ts`).
 *   3. Provider kiểm tra `throwIfAborted(signal)` trước khi gọi fetch và
 *      truyền signal đã gộp timeout xuống `fetch` — xem
 *      `providers/openaiCompatible.ts`.
 *
 * Không có signal = hành vi cũ (backward compatible): mọi helper đều
 * chấp nhận `undefined` và không làm gì thêm.
 */

/** Request có thể hủy được — mọi `chat()` của provider đều nhận dạng này. */
export interface AbortableRequest {
  signal?: AbortSignal;
}

/** Tạo controller mới cho một lần gọi provider (hoặc một run). */
export function createAbortController(): AbortController {
  return new AbortController();
}

/**
 * Ném lỗi rõ ràng khi signal đã bị hủy. Không làm gì khi signal
 * undefined hoặc chưa hủy — để provider nào cũng gọi được ở đầu `chat()`
 * mà không cần kiểm tra `undefined` trước.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal || !signal.aborted) return;
  const err = new Error('Đã hủy yêu cầu provider (abort signal).');
  err.name = 'AbortError';
  throw err;
}

/** True khi lỗi là do hủy (AbortError) — dùng để phân biệt hủy với lỗi mạng. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export interface WithTimeoutResult {
  /** Signal đã gộp: hủy khi signal gốc hủy HOẶC khi hết `ms`. */
  signal: AbortSignal | undefined;
  /** Dọn timer + listener — gọi trong `finally` sau khi fetch xong. */
  dispose(): void;
}

/**
 * Gộp một signal có sẵn với timeout (ms) thành một signal duy nhất.
 *
 * - Không có `ms` → trả lại signal gốc, `dispose()` không làm gì.
 * - Không có signal gốc, có `ms` → signal chỉ hủy khi hết timeout.
 * - Cả hai đều không có → signal `undefined` (fetch chạy không giới hạn
 *   thêm — provider vẫn có timeout nội bộ riêng nếu nó tự đặt).
 * - Signal gốc đã hủy sẵn → signal trả về đã hủy ngay, không chờ timer.
 *
 * Lưu ý: không dùng `AbortSignal.any()` để code chạy được cả trên
 * Node cũ hơn; việc gộp làm thủ công bằng một AbortController + listener.
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number | undefined,
): WithTimeoutResult {
  if (ms === undefined || ms === null || !(ms > 0)) {
    return { signal, dispose: () => undefined };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) {
      // Hủy ngay, không đặt timer nữa.
      controller.abort(signal.reason);
      return { signal: controller.signal, dispose: () => undefined };
    }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  timer = setTimeout(() => {
    controller.abort(new Error(`Hết thời gian chờ sau ${ms}ms.`));
  }, ms);
  // Không giữ process sống chỉ vì timer timeout của provider.
  if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref(): void }).unref();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onParentAbort);
    },
  };
}
