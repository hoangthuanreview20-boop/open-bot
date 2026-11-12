/**
 * Deep-link `open-bot://` — wiring Electron main process (v0.86, P2-6).
 *
 * Module này KHÔNG import `electron`: nó nhận một `app` tối thiểu
 * (interface DeepLinkAppLike) để main.ts thật truyền `app` của Electron
 * vào, còn test truyền mock. Logic parse URL nằm ở
 * `@open-bot/core` (`parseDeepLink`, `extractDeepLinkFromArgv`).
 *
 * Luồng:
 * - `setupDeepLink()` gọi 1 lần lúc khởi động (trước `app.whenReady`):
 *   xin single-instance lock, đăng ký listener `open-url` (macOS) và
 *   `second-instance` (Windows/Linux), đăng ký scheme với OS (chỉ khi
 *   app đã đóng gói — ở dev, binary electron sẽ chiếm scheme), và trả
 *   về URL trong argv lúc khởi động (nếu có) để main xếp hàng chờ.
 * - URL tới khi app chưa sẵn / cửa sổ chưa mở: main giữ trong hàng chờ
 *   (xem `pendingDeepLink` trong main.ts) và renderer kéo về qua IPC
 *   `deep-link:pending` lúc mount; URL tới khi renderer đã sẵn thì
 *   main đẩy thẳng qua IPC `deep-link:open`.
 *
 * An toàn: URL sai/không rõ -> parseDeepLink trả `{ ok: false }`,
 * caller log lý do và bỏ qua; không bao giờ mở shell / URL ngoài,
 * không crash main.
 */
import {
  DEEP_LINK_SCHEME,
  extractDeepLinkFromArgv,
  parseDeepLink,
} from '@open-bot/core';
import type { DeepLinkRoute } from '@open-bot/core';

export { DEEP_LINK_SCHEME };
export type { DeepLinkRoute };

/** Phần API của Electron `app` mà deep-link cần (đủ cho mock trong test). */
export interface DeepLinkAppLike {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(scheme: string): boolean;
  isDefaultProtocolClient(scheme: string): boolean;
  requestSingleInstanceLock(options?: { additionalData?: unknown }): boolean;
  on(event: 'open-url', listener: (event: { preventDefault: () => void }, url: string) => void): unknown;
  on(event: 'second-instance', listener: (event: unknown, argv: string[], workingDirectory: string) => void): unknown;
  quit(): void;
}

export interface DeepLinkLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SetupDeepLinkOptions {
  app: DeepLinkAppLike;
  /** argv lúc khởi động; mặc định `process.argv`. */
  argv?: readonly string[];
  /** Gọi với URL thô mỗi khi OS giao một deep-link (open-url / second-instance). */
  onUrl: (rawUrl: string) => void;
  logger?: DeepLinkLogger;
}

export interface SetupDeepLinkResult {
  /** false = đã có instance khác đang chạy; instance này phải thoát. */
  lockAcquired: boolean;
  /** true = OS đã ghi nhận app là handler mặc định của scheme. */
  registered: boolean;
  /** URL deep-link trong argv lúc khởi động (nếu có), chưa qua onUrl. */
  initialUrl: string | null;
}

const defaultLogger: DeepLinkLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * Đăng ký protocol + single-instance lock. Không throw: mọi lỗi của
 * Electron API đều được log và trả về trạng thái fail-open (app vẫn
 * chạy, chỉ mất deep-link / lock) — trừ khi lock không lấy được, lúc
 * đó instance này tự thoát qua `app.quit()` và caller không bootstrap.
 */
export function setupDeepLink(options: SetupDeepLinkOptions): SetupDeepLinkResult {
  const { app, onUrl } = options;
  const logger = options.logger ?? defaultLogger;
  const argv = options.argv ?? process.argv;

  let lockAcquired = true;
  try {
    lockAcquired = app.requestSingleInstanceLock();
  } catch (err) {
    // Lock API lỗi (môi trường lạ): fail-open, app vẫn chạy để người
    // dùng không bị kẹt ở màn hình trắng vì một API phụ.
    logger.warn(`[deep-link] requestSingleInstanceLock lỗi, bỏ qua lock: ${(err as Error).message}`);
    lockAcquired = true;
  }
  if (!lockAcquired) {
    logger.log('[deep-link] Đã có instance open-bot đang chạy — instance này thoát.');
    try {
      app.quit();
    } catch {
      // quit() lỗi thì thôi: caller thấy lockAcquired=false và không bootstrap.
    }
    return { lockAcquired: false, registered: false, initialUrl: null };
  }

  // macOS: hệ điều hành giao URL qua event `open-url`.
  app.on('open-url', (event, url) => {
    try {
      event.preventDefault();
    } catch {
      // preventDefault không có / lỗi: vẫn xử lý URL, không crash.
    }
    onUrl(url);
  });

  // Windows/Linux: instance thứ hai nhận URL trong argv của nó; instance
  // đầu (đang chạy) nhận event này và xử lý thay.
  app.on('second-instance', (_event, secondArgv) => {
    const raw = extractDeepLinkFromArgv(secondArgv);
    if (raw !== null) onUrl(raw);
  });

  // Đăng ký scheme với OS. Chỉ khi đã đóng gói: ở dev, `electron`
  // binary sẽ chiếm scheme `open-bot` và link thật sẽ mở nhầm dev
  // build. electron-builder cũng khai báo protocol trong
  // electron-builder.yml (NSIS/macOS/Linux .desktop) nên bản đóng gói
  // đăng ký lại ở đây chỉ là khẳng định, không phải nguồn duy nhất.
  let registered = false;
  if (app.isPackaged) {
    try {
      if (!app.isDefaultProtocolClient(DEEP_LINK_SCHEME)) {
        registered = app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
      } else {
        registered = true;
      }
      logger.log(`[deep-link] Đăng ký scheme ${DEEP_LINK_SCHEME}://: ${registered ? 'ok' : 'thất bại'}`);
    } catch (err) {
      logger.warn(`[deep-link] Không đăng ký được scheme ${DEEP_LINK_SCHEME}://: ${(err as Error).message}`);
      registered = false;
    }
  } else {
    logger.log('[deep-link] Dev mode: bỏ qua setAsDefaultProtocolClient (chỉ đăng ký khi đóng gói).');
  }

  return { lockAcquired: true, registered, initialUrl: extractDeepLinkFromArgv(argv) };
}

/**
 * Xử lý một URL deep-link thô: parse rồi gọi `deliver` với route hợp
 * lệ, hoặc log lý do và bỏ qua nếu URL sai. Trả về route đã deliver
 * (null nếu bỏ qua). Không throw với mọi đầu vào.
 */
export function handleDeepLinkUrl(
  rawUrl: unknown,
  deliver: (route: DeepLinkRoute) => void,
  logger: DeepLinkLogger = defaultLogger,
): DeepLinkRoute | null {
  const parsed = parseDeepLink(rawUrl);
  if (!parsed.ok) {
    logger.warn(`[deep-link] Bỏ qua URL không hợp lệ (${parsed.reason}): ${typeof rawUrl === 'string' ? rawUrl.slice(0, 200) : typeof rawUrl}`);
    return null;
  }
  try {
    deliver(parsed.route);
  } catch (err) {
    logger.error(`[deep-link] deliver route lỗi: ${(err as Error).message}`);
    return null;
  }
  return parsed.route;
}
