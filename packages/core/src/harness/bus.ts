/**
 * Event bus (M5) — fan-in về một event chuẩn.
 *
 * Mọi event từ mọi driver CLI (text delta, tool_call, result, error,
 * abort, approval request…) đi qua MỘT bus duy nhất với envelope
 * `HarnessEvent` (instanceId, botId, threadId, engine, kind, payload,
 * at). Coordinator/UI subscribe bus thay vì callback rời rạc từng
 * driver — callback `onCliEvent` cũ của driver vẫn được giữ (giờ nó
 * chảy qua harness sink, xem harness.ts) nên API hiện có không đổi.
 *
 * Bus là đồng bộ, best-effort: handler nào throw cũng không làm hỏng
 * driver (lỗi được nuốt + đếm), publish không bao giờ throw.
 */

import type { CliEvent } from '../providers/cli/types';
import type { HarnessEvent, HarnessEventKind } from './types';
import { sanitizeHarnessPayload } from './ndjson';

/** Filter khi subscribe: lọc theo botId / engine / kind. */
export interface HarnessEventFilter {
  botId?: string;
  engine?: string;
  kinds?: readonly HarnessEventKind[];
}

export type HarnessEventHandler = (event: HarnessEvent) => void;

/** Map một `CliEvent` của driver về kind trên bus. */
export function harnessKindOfCliEvent(event: CliEvent): HarnessEventKind {
  switch (event.type) {
    case 'text':
      return 'text';
    case 'tool_call':
      return 'tool_call';
    case 'result':
      return 'result';
    case 'error':
      return 'error';
    case 'aborted':
      return 'abort';
    case 'approval_denied':
      return 'approval_denied';
    case 'approval_request':
      return 'approval_request';
    default:
      return 'lifecycle';
  }
}

/** Payload bus cho một `CliEvent` (đã sanitize, cắt ngắn). */
export function harnessPayloadOfCliEvent(event: CliEvent): Record<string, unknown> {
  switch (event.type) {
    case 'text':
      return { delta: event.delta };
    case 'tool_call':
      return {
        callId: event.call.id,
        tool: event.call.name,
        argKeys: Object.keys(event.call.args ?? {}),
      };
    case 'result':
      return {
        text: event.text,
        usage: event.usage,
        sessionId: event.sessionId,
      };
    case 'error':
      return { message: event.message };
    case 'aborted':
      return {};
    case 'approval_denied':
      return { method: event.method, detail: event.detail };
    case 'approval_request':
      return { method: event.method, detail: event.detail };
    default:
      return {};
  }
}

export class HarnessEventBus {
  private readonly subscribers = new Set<{
    filter: HarnessEventFilter;
    handler: HarnessEventHandler;
  }>();
  private publishedTotal = 0;
  private handlerErrorsTotal = 0;

  /** Tổng số event đã publish (kể cả khi không có subscriber). */
  get totalPublished(): number {
    return this.publishedTotal;
  }

  /** Tổng số lần handler subscriber throw (đã nuốt, không hỏng bus). */
  get totalHandlerErrors(): number {
    return this.handlerErrorsTotal;
  }

  /** Số subscriber hiện tại. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Subscribe event khớp filter. Trả hàm unsubscribe (gọi nhiều lần
   * cũng an toàn). Handler chạy đồng bộ trong publish(); handler
   * không được throw ra ngoài (bus nuốt + đếm).
   */
  subscribe(filter: HarnessEventFilter, handler: HarnessEventHandler): () => void {
    const entry = { filter: { ...filter }, handler };
    this.subscribers.add(entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subscribers.delete(entry);
    };
  }

  /** Publish một event đã đóng envelope (đã sanitize trước khi tới đây). */
  publish(event: HarnessEvent): void {
    this.publishedTotal += 1;
    for (const { filter, handler } of [...this.subscribers]) {
      if (filter.botId !== undefined && filter.botId !== event.botId) continue;
      if (filter.engine !== undefined && filter.engine !== event.engine) continue;
      if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) continue;
      try {
        handler(event);
      } catch {
        this.handlerErrorsTotal += 1;
      }
    }
  }

  /**
   * Đóng envelope cho một `CliEvent` của driver rồi publish.
   * Trả event đã publish (để caller ghi log NDJSON cùng envelope).
   */
  publishCliEvent(
    instanceId: string,
    botId: string,
    threadId: string,
    engine: string,
    event: CliEvent,
    at: string = new Date().toISOString(),
    // v0.90e (Đội G): run im lặng → envelope mang silent để forwarder
    // (coordinator con → main) và SSE bỏ qua, log vẫn giữ.
    silent = false,
  ): HarnessEvent {
    const kind = harnessKindOfCliEvent(event);
    const envelope: HarnessEvent = {
      instanceId,
      botId,
      threadId,
      engine,
      kind,
      payload: sanitizeHarnessPayload(kind, harnessPayloadOfCliEvent(event)),
      ...(silent ? { silent: true as const } : {}),
      at,
    };
    this.publish(envelope);
    return envelope;
  }
}
