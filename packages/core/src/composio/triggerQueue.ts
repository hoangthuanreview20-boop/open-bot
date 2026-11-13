/**
 * Composio trigger event queue + long-poll (v0.96 Team T4).
 *
 * Vấn đề: webhook receiver hiện có (v0.83, `triggers.ts` +
 * `automations/webhook.ts`) verify HMAC rồi chạy automation NGAY —
 * event đến dồn dập (vd GitHub push nhiều commit) thì chạy chồng
 * nhau, event trùng (Composio retry delivery) thì chạy 2 lần, và
 * automation nào muốn "chờ event rồi mới chạy" không có chỗ đợi.
 *
 * Module này là lớp đệm NHẬN — không tạo trigger instance trong
 * Composio (user tạo trong dashboard, như cũ), không chạy automation:
 *  - `enqueue(event)`: nhận event đã parse + verify, dedupe theo
 *    `eventId` (Composio retry cùng `msg_...` chỉ vào queue 1 lần),
 *    cap số lượng (fail-closed: đầy thì drop event CŨ NHẤT đã quá
 *    hạn, không bao giờ crash), TTL hết hạn thì tự rơi.
 *  - `waitForEvents(...)`: long-poll — automation/scheduler chờ tới
 *    `timeoutMs` để có event khớp filter (theo triggerSlug và/hoặc
 *    triggerId); có event là trả ngay, hết timeout trả rỗng. Không
 *    busy-loop: waiter được đánh thức đúng lúc enqueue.
 *  - `drain(filter?)`: lấy + xoá các event đang chờ (kiểu consumer
 *    kéo tay); `peek` chỉ đọc không xoá.
 *  - `stats()`: đếm enqueue/deduped/dropped/expired để UI/debug thấy
 *    queue có đang nghẽn không.
 *
 * Toàn bộ in-memory, không ghi đĩa: event đã xử lý xong thì không
 * cần giữ; restart app thì queue trống (Composio sẽ retry delivery
 * chưa ack nếu cần — webhook route vẫn trả 200 sau khi enqueue).
 * Secret/key không bao giờ đi qua đây — event chỉ mang metadata +
 * data đã parse.
 */

import type { ComposioTriggerEvent } from './triggers';

/** Một event trong queue, kèm thời điểm nhận (ms epoch). */
export interface QueuedComposioTriggerEvent {
  /** Event đã parse (V3 envelope). */
  event: ComposioTriggerEvent;
  /** ms epoch lúc enqueue (để tính TTL). */
  receivedAtMs: number;
}

/** Filter khi chờ/lấy event khỏi queue. */
export interface ComposioTriggerQueueFilter {
  /** Chỉ event của trigger slug này (vd 'GMAIL_NEW_GMAIL_MESSAGE'). */
  triggerSlug?: string;
  /** Chỉ event của trigger instance này (vd 'ti_xyz789'). */
  triggerId?: string;
  /** Chỉ event của connected account này (vd 'ca_def456'). */
  connectedAccountId?: string;
}

/** Thống kê queue (đếm tích luỹ từ lúc tạo — không reset khi drain). */
export interface ComposioTriggerQueueStats {
  /** Số event đã enqueue thành công. */
  enqueued: number;
  /** Số delivery trùng eventId đã bị dedupe (không enqueue lần 2). */
  deduped: number;
  /** Số event đã bị drop vì queue đầy. */
  droppedFull: number;
  /** Số event đã hết TTL và bị loại khi quét. */
  expired: number;
  /** Số event đang chờ trong queue lúc này. */
  pending: number;
  /** Số waiter long-poll đang chờ lúc này. */
  waiters: number;
}

export interface ComposioTriggerQueueOptions {
  /** Số event tối đa trong queue (mặc định 500). */
  maxSize?: number;
  /** TTL của event trong queue, ms (mặc định 10 phút). */
  ttlMs?: number;
  /** Clock tiêm được (test). */
  now?: () => number;
}

/** Mặc định: queue tối đa 500 event, mỗi event sống 10 phút. */
export const COMPOSIO_TRIGGER_QUEUE_DEFAULT_MAX_SIZE = 500;
export const COMPOSIO_TRIGGER_QUEUE_DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Long-poll tối đa 60s một lần chờ (automation gọi lại nếu cần chờ tiếp). */
export const COMPOSIO_TRIGGER_LONG_POLL_MAX_TIMEOUT_MS = 60_000;

interface Waiter {
  filter: ComposioTriggerQueueFilter;
  resolve: (events: QueuedComposioTriggerEvent[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

function matchesFilter(entry: QueuedComposioTriggerEvent, filter: ComposioTriggerQueueFilter): boolean {
  if (filter.triggerSlug !== undefined && entry.event.triggerSlug !== filter.triggerSlug) return false;
  if (filter.triggerId !== undefined && entry.event.triggerId !== filter.triggerId) return false;
  if (filter.connectedAccountId !== undefined && entry.event.connectedAccountId !== filter.connectedAccountId) {
    return false;
  }
  return true;
}

/**
 * Hàng đợi event trigger Composio dùng chung của app (singleton):
 * scheduler (main) enqueue delivery đã verify vào đây, automation
 * long-poll `waitForEvents` đọc ra. Một instance duy nhất cho cả
 * tiến trình — tạo ở đây để main và scheduler không phải truyền
 * tay nhau qua nhiều lớp. Test nên tạo `new ComposioTriggerQueue()`
 * riêng thay vì dùng singleton này (tránh rò rỉ state giữa test).
 */
let sharedComposioTriggerQueue: ComposioTriggerQueue | undefined;
export function getSharedComposioTriggerQueue(): ComposioTriggerQueue {
  if (!sharedComposioTriggerQueue) {
    sharedComposioTriggerQueue = new ComposioTriggerQueue();
  }
  return sharedComposioTriggerQueue;
}

/**
 * Hàng đợi event trigger Composio (in-memory).
 *
 * Dedupe: giữ tập eventId đã thấy trong cửa sổ TTL (event không có
 * eventId thì dedupe theo triggerSlug + timestamp + JSON data — vẫn
 * tốt hơn là chạy trùng). Queue đầy: drop event cũ nhất (FIFO) để
 * chỗ cho event mới — automation chạy event mới nhất thì đúng hơn là
 * kẹt ở event cũ.
 */
export class ComposioTriggerQueue {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries: QueuedComposioTriggerEvent[] = [];
  private readonly seenEventIds = new Map<string, number>();
  private readonly waiters = new Set<Waiter>();
  private enqueuedCount = 0;
  private dedupedCount = 0;
  private droppedFullCount = 0;
  private expiredCount = 0;

  constructor(opts: ComposioTriggerQueueOptions = {}) {
    this.maxSize = opts.maxSize !== undefined && opts.maxSize > 0 ? Math.floor(opts.maxSize) : COMPOSIO_TRIGGER_QUEUE_DEFAULT_MAX_SIZE;
    this.ttlMs = opts.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : COMPOSIO_TRIGGER_QUEUE_DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Số event đang chờ. */
  get size(): number {
    return this.entries.length;
  }

  /** Key dedupe của một event (eventId có thì dùng, không thì hash nội dung). */
  private dedupeKey(event: ComposioTriggerEvent): string {
    if (event.eventId) return `id:${event.eventId}`;
    return `body:${event.triggerSlug}:${event.timestamp ?? ''}:${JSON.stringify(event.data)}`;
  }

  /** Loại event hết TTL khỏi queue + khỏi tập dedupe; trả số event đã loại. */
  purgeExpired(nowMs?: number): number {
    const now = nowMs ?? this.now();
    let removed = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (now - this.entries[i].receivedAtMs > this.ttlMs) {
        this.entries.splice(i, 1);
        removed++;
      }
    }
    for (const [key, at] of [...this.seenEventIds.entries()]) {
      if (now - at > this.ttlMs) this.seenEventIds.delete(key);
    }
    this.expiredCount += removed;
    return removed;
  }

  /**
   * Nhận một event đã parse + verify. Trả 'enqueued' | 'duplicate'
   * (trùng eventId — Composio retry) | 'dropped-full' (không xảy ra
   * với cap FIFO: đầy thì drop cũ nhất, event mới luôn vào — giá trị
   * này giữ cho API ổn định, hiện không dùng).
   */
  enqueue(event: ComposioTriggerEvent): 'enqueued' | 'duplicate' | 'dropped-full' {
    const now = this.now();
    this.purgeExpired(now);
    const key = this.dedupeKey(event);
    if (this.seenEventIds.has(key)) {
      this.dedupedCount++;
      return 'duplicate';
    }
    while (this.entries.length >= this.maxSize) {
      this.entries.shift();
      this.droppedFullCount++;
    }
    const entry: QueuedComposioTriggerEvent = { event, receivedAtMs: now };
    this.entries.push(entry);
    this.seenEventIds.set(key, now);
    this.enqueuedCount++;
    this.wakeWaiters();
    return 'enqueued';
  }

  /** Đánh thức waiter nào có event khớp filter (trả đúng các event khớp, xoá khỏi queue). */
  private wakeWaiters(): void {
    if (this.waiters.size === 0) return;
    for (const waiter of [...this.waiters]) {
      const matched: QueuedComposioTriggerEvent[] = [];
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (matchesFilter(this.entries[i], waiter.filter)) {
          matched.unshift(this.entries.splice(i, 1)[0]);
        }
      }
      if (matched.length > 0) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(matched);
      }
    }
  }

  /**
   * Long-poll: chờ tới `timeoutMs` để có event khớp filter. Có event
   * sẵn thì trả ngay (không chờ); hết timeout trả []. Timeout bị cap
   * ở 60s — caller muốn chờ lâu hơn thì gọi lại. Trả event theo thứ
   * tự nhận; event đã trả thì rời khỏi queue.
   */
  waitForEvents(
    filter: ComposioTriggerQueueFilter = {},
    timeoutMs = 30_000,
  ): Promise<QueuedComposioTriggerEvent[]> {
    this.purgeExpired();
    const ready: QueuedComposioTriggerEvent[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (matchesFilter(this.entries[i], filter)) {
        ready.unshift(this.entries.splice(i, 1)[0]);
      }
    }
    if (ready.length > 0) return Promise.resolve(ready);
    const capped = Math.max(0, Math.min(timeoutMs, COMPOSIO_TRIGGER_LONG_POLL_MAX_TIMEOUT_MS));
    return new Promise<QueuedComposioTriggerEvent[]>((resolve) => {
      const waiter: Waiter = {
        filter,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve([]);
        }, capped),
      };
      // Timer không giữ process sống (queue chỉ là đệm trong app desktop).
      if (typeof waiter.timer === 'object' && waiter.timer !== null && 'unref' in waiter.timer) {
        (waiter.timer as { unref: () => void }).unref();
      }
      this.waiters.add(waiter);
    });
  }

  /** Lấy + xoá mọi event khớp filter (consumer kéo tay, không chờ). */
  drain(filter: ComposioTriggerQueueFilter = {}): QueuedComposioTriggerEvent[] {
    this.purgeExpired();
    const out: QueuedComposioTriggerEvent[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (matchesFilter(this.entries[i], filter)) {
        out.unshift(this.entries.splice(i, 1)[0]);
      }
    }
    return out;
  }

  /** Chỉ đọc các event khớp filter, không xoá. */
  peek(filter: ComposioTriggerQueueFilter = {}): QueuedComposioTriggerEvent[] {
    this.purgeExpired();
    return this.entries.filter((e) => matchesFilter(e, filter));
  }

  /** Thống kê tích luỹ + trạng thái hiện tại. */
  stats(): ComposioTriggerQueueStats {
    return {
      enqueued: this.enqueuedCount,
      deduped: this.dedupedCount,
      droppedFull: this.droppedFullCount,
      expired: this.expiredCount,
      pending: this.entries.length,
      waiters: this.waiters.size,
    };
  }

  /** Xoá toàn bộ queue + waiter (test / shutdown). */
  clear(): void {
    this.entries.length = 0;
    this.seenEventIds.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters.clear();
  }
}
