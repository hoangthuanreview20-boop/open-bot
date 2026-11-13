/**
 * Cầu nối poll → trigger queue (v0.96, Team T4).
 *
 * `ComposioPoller` phát hiện item mới bằng polling (vd. Gmail 15
 * phút); `ComposioTriggerQueue` là nơi automations long-poll
 * (`waitForEvents`). Cầu nối này biến mỗi item mới thành một
 * synthetic `ComposioTriggerEvent` và enqueue — để consumer chỉ cần
 * đọc MỘT nguồn (queue) dù event đến từ webhook thật hay từ polling.
 *
 * Synthetic event khác webhook thật ở 2 điểm:
 * - `eventId` là `poll:{triggerSlug}:{itemId}` (dedupe tự nhiên theo
 *   id item; item không có id thì dedupe theo hash của JSON item).
 * - `type` là `composio.trigger.poll` (không phải
 *   `composio.trigger.message`) để consumer phân biệt được nguồn.
 * `triggerId`/`connectedAccountId` để trống (poll không đi qua
 * trigger instance của Composio — instance do user tạo trong
 * Composio chỉ dùng cho webhook thật).
 */

import type { ComposioTriggerEvent } from './triggers';
import type { ComposioPollResult, ComposioPoller } from './polling';
import { composioPollItemId } from './polling';
import type { ComposioTriggerQueue } from './triggerQueue';

/** Nguồn event poll → queue. */
export const COMPOSIO_POLL_TRIGGER_EVENT_TYPE = 'composio.trigger.poll';

/**
 * Slug cho event tổng hợp từ polling Gmail: dùng slug trigger thật
 * của Gmail (`GMAIL_NEW_GMAIL_MESSAGE`) để automation nghe slug đó
 * nhận được cả event webhook lẫn event poll mà không cần sửa rule.
 */
export const COMPOSIO_GMAIL_POLL_TRIGGER_SLUG = 'GMAIL_NEW_GMAIL_MESSAGE';

export interface ComposioPollToQueueBridgeOptions {
  /**
   * Slug trigger gắn cho synthetic event. Mặc định
   * `GMAIL_NEW_GMAIL_MESSAGE` (Gmail poll preset). Với poller khác,
   * host truyền slug trigger thật của toolkit đó (vd.
   * `SLACK_CHANNEL_MESSAGE_RECEIVED`).
   */
  triggerSlug?: string;
  /** Field id trong item (mặc định `id` — xem `composioPollItemId`). */
  idField?: string;
  /**
   * Tên field chứa item trong `data` của event. Mặc định `item`
   * (event.data = `{ item }`). Đặt `null` để data CHÍNH là item.
   */
  dataField?: string | null;
  /**
   * Bỏ qua item không có id? Mặc định false — item không id vẫn
   * được enqueue (dedupe theo hash JSON), vì bỏ sót tệ hơn trùng
   * (cùng quy tắc với `ComposioPoller`).
   */
  skipItemsWithoutId?: boolean;
}

export interface ComposioPollToQueueBridge {
  /** `true` sau khi `start()` và trước `stop()`. */
  readonly running: boolean;
  /** Bắt đầu poll (gọi `poller.start` với bridge làm consumer). */
  start(): void;
  /** Dừng poll. Event đã enqueue vẫn ở trong queue. */
  stop(): void;
}

/**
 * Băm JSON ngắn gọn, ổn định cho item không có id — dùng làm hậu tố
 * eventId để dedupe. Không phải hash mật mã (chỉ cần tránh va chạm
 * trong cửa sổ 10 phút của queue); FNV-1a 32-bit là đủ và nhanh.
 */
export function hashComposioPollItem(item: Record<string, unknown>): string {
  const json = JSON.stringify(item);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Biến một poll result thành synthetic events và enqueue từng cái.
 * Trả về số event đã enqueue (0 khi không có item mới hoặc result
 * có lỗi). Lỗi enqueue của một item không chặn các item còn lại.
 */
export function enqueueComposioPollResult(
  queue: ComposioTriggerQueue,
  result: ComposioPollResult,
  opts: ComposioPollToQueueBridgeOptions = {},
): number {
  const triggerSlug = opts.triggerSlug ?? COMPOSIO_GMAIL_POLL_TRIGGER_SLUG;
  if (result.error || result.newItems.length === 0) return 0;
  let enqueued = 0;
  for (const item of result.newItems) {
    const itemId = composioPollItemId(item, opts.idField);
    if (itemId === undefined && opts.skipItemsWithoutId === true) continue;
    const suffix = itemId ?? `no-id-${hashComposioPollItem(item)}`;
    const event: ComposioTriggerEvent = {
      eventId: `poll:${triggerSlug}:${suffix}`,
      type: COMPOSIO_POLL_TRIGGER_EVENT_TYPE,
      triggerSlug,
      data:
        opts.dataField === null
          ? item
          : { [opts.dataField ?? 'item']: item },
    };
    try {
      // enqueue() trả 'duplicate' khi eventId đã thấy (Composio
      // retry / poll lặp) — chỉ đếm khi thật sự vào queue.
      if (queue.enqueue(event) === 'enqueued') enqueued++;
    } catch {
      // Queue đầy/hỏng là lỗi của buffer — không chặn item sau.
    }
  }
  return enqueued;
}

/**
 * Tạo cầu nối: `bridge.start()` → poller chạy, mỗi lần có item mới
 * thì `enqueueComposioPollResult` đẩy vào queue. `bridge.stop()` →
 * dừng poller. Queue và poller do host sở hữu (bridge không tạo
 * thêm kết nối nào).
 */
export function createComposioPollToQueueBridge(
  poller: ComposioPoller,
  queue: ComposioTriggerQueue,
  opts: ComposioPollToQueueBridgeOptions = {},
): ComposioPollToQueueBridge {
  let running = false;
  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      poller.start((result) => {
        if (!running) return;
        enqueueComposioPollResult(queue, result, opts);
      });
    },
    stop() {
      if (!running) return;
      running = false;
      poller.stop();
    },
  };
}
