/**
 * MCP server-initiated notifications (v1.02, Team T3 — protocol stack).
 *
 * The MCP spec (2025-11-25) defines notifications the server sends
 * without a request id: `notifications/tools/list_changed`,
 * `notifications/resources/list_changed`,
 * `notifications/prompts/list_changed`, `notifications/message`
 * (log messages, gated by `logging/setLevel`) and
 * `notifications/cancelled`. Before this module the open-bot server
 * silently dropped every notification except `notifications/initialized`
 * and never told clients when its tool/resource/prompt lists changed,
 * so a client could keep calling a tool the server had just removed.
 *
 * This module is the shared vocabulary + a small pub/sub hub:
 *  - `McpNotificationHub` — server side: emit list changes, log
 *    messages and cancellations; track cancelled request ids so a
 *    long task can stop early instead of running to completion.
 *  - `registerMcpListChangedHandlers` — client side: hook the three
 *    `list_changed` notifications into an `McpDispatcher` and call
 *    back so the client can invalidate its cached lists.
 *  - Log levels — `logging/setLevel` levels with a total order, so the
 *    server only emits messages at or above the level the client asked
 *    for (spec default is `info`).
 *
 * No transport code here: the hub only calls listeners, the server and
 * the client wire it to stdio / Streamable HTTP themselves.
 */

import type { McpDispatcher } from './dispatcher';

/** JSON-RPC method names for the notifications this module covers. */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';
export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = 'notifications/resources/list_changed';
export const MCP_NOTIFICATION_PROMPTS_LIST_CHANGED = 'notifications/prompts/list_changed';
export const MCP_NOTIFICATION_MESSAGE = 'notifications/message';
export const MCP_NOTIFICATION_CANCELLED = 'notifications/cancelled';
export const MCP_NOTIFICATION_INITIALIZED = 'notifications/initialized';

/** Which list changed — the client invalidates exactly that cache. */
export type McpListKind = 'tools' | 'resources' | 'prompts';

/** Method name for one list kind. */
export function mcpListChangedMethod(kind: McpListKind): string {
  if (kind === 'tools') return MCP_NOTIFICATION_TOOLS_LIST_CHANGED;
  if (kind === 'resources') return MCP_NOTIFICATION_RESOURCES_LIST_CHANGED;
  return MCP_NOTIFICATION_PROMPTS_LIST_CHANGED;
}

/**
 * MCP log levels (spec `logging/setLevel`). Ordered least → most
 * severe; a message is emitted when its level is at or above the
 * configured minimum.
 */
export type McpLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export const MCP_LOG_LEVELS: readonly McpLogLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
];

/** Default minimum level: the spec default is `info`. */
export const MCP_DEFAULT_LOG_LEVEL: McpLogLevel = 'info';

/** Parse a level from an unknown value; null when it is not a level. */
export function parseMcpLogLevel(value: unknown): McpLogLevel | null {
  if (typeof value !== 'string') return null;
  return (MCP_LOG_LEVELS as readonly string[]).includes(value) ? (value as McpLogLevel) : null;
}

/** True when `level` is at or above `minimum` in severity. */
export function shouldLogMcp(level: McpLogLevel, minimum: McpLogLevel): boolean {
  return MCP_LOG_LEVELS.indexOf(level) >= MCP_LOG_LEVELS.indexOf(minimum);
}

/** Payload of a `notifications/message` log message. */
export interface McpLogMessage {
  level: McpLogLevel;
  /** Logger name, e.g. the tool or subsystem that emitted the message. */
  logger?: string;
  /** Message payload (already redacted by the emitter). */
  data: unknown;
}

/** Payload of a `notifications/cancelled` notification. */
export interface McpCancellation {
  requestId: string | number;
  reason?: string;
}

export type McpListChangedListener = (kind: McpListKind) => void;
export type McpLogMessageListener = (message: McpLogMessage) => void;
export type McpCancellationListener = (cancellation: McpCancellation) => void;

/**
 * Pub/sub hub for server-initiated MCP notifications.
 *
 * The server owns one hub and emits into it; transports / the client
 * subscribe. Listeners are synchronous and must not throw — a throwing
 * listener is caught and reported through `onListenerError` instead of
 * breaking the emit loop (one bad UI subscriber must not kill the
 * server's notification path).
 */
export class McpNotificationHub {
  private readonly listListeners = new Set<McpListChangedListener>();
  private readonly logListeners = new Set<McpLogMessageListener>();
  private readonly cancelListeners = new Set<McpCancellationListener>();
  private readonly cancelledIds = new Set<string | number>();
  private readonly onListenerError: ((err: unknown) => void) | undefined;

  constructor(options: { onListenerError?: (err: unknown) => void } = {}) {
    this.onListenerError = options.onListenerError;
  }

  /** Subscribe to list changes; returns an unsubscribe function. */
  onListChanged(listener: McpListChangedListener): () => void {
    this.listListeners.add(listener);
    return () => {
      this.listListeners.delete(listener);
    };
  }

  /** Subscribe to log messages; returns an unsubscribe function. */
  onLogMessage(listener: McpLogMessageListener): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  /** Subscribe to cancellations; returns an unsubscribe function. */
  onCancelled(listener: McpCancellationListener): () => void {
    this.cancelListeners.add(listener);
    return () => {
      this.cancelListeners.delete(listener);
    };
  }

  /** Number of listeners per channel (diagnostics / tests). */
  listenerCount(channel: 'list' | 'log' | 'cancelled'): number {
    if (channel === 'list') return this.listListeners.size;
    if (channel === 'log') return this.logListeners.size;
    return this.cancelListeners.size;
  }

  /** Emit a list change (also the JSON-RPC method name, for transports). */
  emitListChanged(kind: McpListKind): void {
    for (const listener of [...this.listListeners]) {
      try {
        listener(kind);
      } catch (err) {
        this.onListenerError?.(err);
      }
    }
  }

  /** Emit a log message (the caller already applied the level gate). */
  emitLogMessage(message: McpLogMessage): void {
    for (const listener of [...this.logListeners]) {
      try {
        listener(message);
      } catch (err) {
        this.onListenerError?.(err);
      }
    }
  }

  /**
   * Record a cancellation and notify listeners. The id stays in the
   * cancelled set so a long task can check `isCancelled(id)` later.
   */
  emitCancelled(cancellation: McpCancellation): void {
    this.cancelledIds.add(cancellation.requestId);
    for (const listener of [...this.cancelListeners]) {
      try {
        listener(cancellation);
      } catch (err) {
        this.onListenerError?.(err);
      }
    }
  }

  /** True when this request id was cancelled (server side). */
  isCancelled(requestId: string | number): boolean {
    return this.cancelledIds.has(requestId);
  }

  /** Forget one cancelled id (after the task stopped). */
  forgetCancelled(requestId: string | number): void {
    this.cancelledIds.delete(requestId);
  }

  /** All cancelled request ids currently tracked. */
  cancelledRequestIds(): (string | number)[] {
    return [...this.cancelledIds];
  }

  /** Drop all listeners and cancelled ids (tests / shutdown). */
  clear(): void {
    this.listListeners.clear();
    this.logListeners.clear();
    this.cancelListeners.clear();
    this.cancelledIds.clear();
  }
}

/**
 * Client side: register the three `notifications/*_list_changed`
 * handlers on a dispatcher. When the server announces a change the
 * callback fires with the kind, so the client can drop its cached
 * list and re-fetch on next use. Returns an unsubscribe function that
 * removes all three handlers.
 *
 * The dispatcher replaces a handler when the same method is
 * registered twice, so calling this again with a new callback simply
 * swaps the target — no duplicate delivery.
 */
export function registerMcpListChangedHandlers(
  dispatcher: McpDispatcher,
  onChanged: McpListChangedListener,
): () => void {
  const kinds: McpListKind[] = ['tools', 'resources', 'prompts'];
  for (const kind of kinds) {
    dispatcher.register(mcpListChangedMethod(kind), () => {
      onChanged(kind);
    });
  }
  return () => {
    for (const kind of kinds) {
      dispatcher.unregister(mcpListChangedMethod(kind));
    }
  };
}
