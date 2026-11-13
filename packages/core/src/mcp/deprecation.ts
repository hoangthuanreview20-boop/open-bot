/**
 * MCP 2.0 deprecation shim (v0.97, Team T1).
 *
 * MCP 2.0 (SEP-2577) deprecates sampling, roots and logging:
 * they keep working, and nothing is removed before 2027-07-28, but
 * new implementations should not use them — servers should call an
 * LLM API directly instead of `sampling/createMessage`, read their
 * own workspace instead of `roots/list`, and log to stderr / OpenTelemetry
 * instead of `notifications/message`.
 *
 * This module is the compatibility shim that lets the old surface
 * keep running while steering callers to the replacement:
 *   - `DEPRECATED_MCP_METHODS`: the deprecated method names, the
 *     version they were deprecated in, the date they may be removed,
 *     and what replaces each one.
 *   - `DeprecationShim`: wraps a handler so the first call logs a
 *     deprecation warning (once per method per shim, with a count of
 *     later suppressed calls) and every call still runs the original
 *     handler. Nothing is dropped, nothing is renamed.
 *   - `checkDeprecatedCapability`: when a client advertises a
 *     deprecated capability in `initialize` / `_meta`, the server
 *     records one notice per capability (used by `server.ts`) so the
 *     operator can see, in one place, which old clients still rely
 *     on the deprecated surface.
 *
 * The shim is opt-out, never opt-in: existing callers get warnings,
 * not breakage. Removal is a 2027 decision, not a v0.97 one.
 */

/** Deprecation metadata for one MCP method or capability. */
export interface DeprecatedMcpMethod {
  /** Method name, e.g. `sampling/createMessage`. */
  method: string;
  /** Capability key the client/server advertises, e.g. `sampling`. */
  capability: string;
  /** Spec version that deprecated it. */
  deprecatedIn: string;
  /** Earliest removal date (spec promise: not before this date). */
  removeAfter: string;
  /** What to use instead. */
  replacement: string;
  /** Why it was deprecated (one line, for the warning text). */
  reason: string;
}

export const MCP_DEPRECATION_REMOVE_AFTER = '2027-07-28';

export const DEPRECATED_MCP_METHODS: readonly DeprecatedMcpMethod[] = [
  {
    method: 'sampling/createMessage',
    capability: 'sampling',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
    replacement: 'Call the LLM API directly, or use MRTR needs_sampling (see mrtr.ts).',
    reason: 'Server-initiated callbacks were removed in MCP 2.0; sampling is now a client-driven MRTR round.',
  },
  {
    method: 'roots/list',
    capability: 'roots',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
    replacement: 'Read the workspace roots from local configuration, or use MRTR needs_roots.',
    reason: 'Server-initiated callbacks were removed in MCP 2.0; roots are now supplied per request in _meta.',
  },
  {
    method: 'roots/subscribe',
    capability: 'roots',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
    replacement: 'Watch the workspace with the host file watcher instead of a roots subscription.',
    reason: 'Server-initiated callbacks were removed in MCP 2.0.',
  },
  {
    method: 'notifications/message',
    capability: 'logging',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
    replacement: 'Log to stderr or OpenTelemetry; surface user-visible progress with notifications/progress.',
    reason: 'Logging over the MCP channel was deprecated; servers should log out of band.',
  },
  {
    method: 'logging/setLevel',
    capability: 'logging',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
    replacement: 'Configure the log level in the server configuration / environment.',
    reason: 'Logging over the MCP channel was deprecated; servers should log out of band.',
  },
  {
    method: 'elicitation/create',
    capability: 'elicitation',
    deprecatedIn: '2026-07-28',
    removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
    replacement: 'Use MRTR needs_elicitation (see mrtr.ts).',
    reason: 'Server-initiated elicitation was removed in MCP 2.0; elicitation is now a client-driven MRTR round.',
  },
];

const DEPRECATED_BY_METHOD = new Map<string, DeprecatedMcpMethod>(
  DEPRECATED_MCP_METHODS.map((m) => [m.method, m]),
);

/** Look up deprecation metadata for a method, or null when it is current. */
export function getDeprecatedMethod(method: string): DeprecatedMcpMethod | null {
  return DEPRECATED_BY_METHOD.get(method) ?? null;
}

/** True when the method is deprecated under MCP 2.0. */
export function isDeprecatedMcpMethod(method: string): boolean {
  return DEPRECATED_BY_METHOD.has(method);
}

/** One deprecation notice (for logs, the activity feed, or server state). */
export interface DeprecationNotice {
  method: string;
  capability: string;
  replacement: string;
  /** How many times the method was called (including the first). */
  callCount: number;
  /** When the method was first used (ms epoch). */
  firstSeenMs: number;
  /** When the method was most recently used (ms epoch). */
  lastSeenMs: number;
}

/**
 * Format the one-line warning shown the first time a deprecated
 * method is used. States the replacement and the removal date so
 * the operator can plan, instead of a bare "deprecated".
 */
export function formatDeprecationWarning(meta: DeprecatedMcpMethod): string {
  return (
    `MCP method "${meta.method}" is deprecated since ${meta.deprecatedIn} ` +
    `(removal not before ${meta.removeAfter}). ${meta.reason} ` +
    `Use instead: ${meta.replacement}`
  );
}

/**
 * Compatibility shim: wraps deprecated handlers so they keep
 * working while warning exactly once per method. The warning goes
 * through the injected `onWarning` callback (the server logs it);
 * when no callback is given, warnings are collected in
 * `getNotices()` and nothing is printed — the shim never writes to
 * stdout/stderr on its own (stdio servers must keep stdout clean).
 */
export class DeprecationShim {
  private readonly notices = new Map<string, DeprecationNotice>();
  private readonly warned = new Set<string>();
  private readonly onWarning?: (notice: DeprecationNotice, message: string) => void;
  private readonly nowMs: () => number;

  constructor(options: {
    onWarning?: (notice: DeprecationNotice, message: string) => void;
    nowMs?: () => number;
  } = {}) {
    this.onWarning = options.onWarning;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * Wrap a handler for a possibly-deprecated method. Current methods
   * pass through untouched (no wrapper overhead in the hot path
   * beyond one map lookup); deprecated methods get the once-only
   * warning plus a call count.
   */
  wrap<TArgs extends unknown[], TResult>(
    method: string,
    handler: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    const meta = getDeprecatedMethod(method);
    if (!meta) return handler;
    return (...args: TArgs): TResult => {
      const now = this.nowMs();
      const existing = this.notices.get(method);
      if (existing) {
        existing.callCount += 1;
        existing.lastSeenMs = now;
      } else {
        const notice: DeprecationNotice = {
          method,
          capability: meta.capability,
          replacement: meta.replacement,
          callCount: 1,
          firstSeenMs: now,
          lastSeenMs: now,
        };
        this.notices.set(method, notice);
      }
      const notice = this.notices.get(method) as DeprecationNotice;
      if (!this.warned.has(method)) {
        this.warned.add(method);
        this.onWarning?.(notice, formatDeprecationWarning(meta));
      }
      return handler(...args);
    };
  }

  /** Record a use of a deprecated method without wrapping a handler. */
  record(method: string): DeprecationNotice | null {
    const meta = getDeprecatedMethod(method);
    if (!meta) return null;
    const now = this.nowMs();
    const existing = this.notices.get(method);
    if (existing) {
      existing.callCount += 1;
      existing.lastSeenMs = now;
      return existing;
    }
    const notice: DeprecationNotice = {
      method,
      capability: meta.capability,
      replacement: meta.replacement,
      callCount: 1,
      firstSeenMs: now,
      lastSeenMs: now,
    };
    this.notices.set(method, notice);
    if (!this.warned.has(method)) {
      this.warned.add(method);
      this.onWarning?.(notice, formatDeprecationWarning(meta));
    }
    return notice;
  }

  /** All deprecation notices so far, in first-seen order. */
  getNotices(): DeprecationNotice[] {
    return [...this.notices.values()];
  }

  /** True when any deprecated method has been used. */
  get hasNotices(): boolean {
    return this.notices.size > 0;
  }

  /** Forget all notices (used by tests and by server reset). */
  clear(): void {
    this.notices.clear();
    this.warned.clear();
  }
}

/**
 * Check a capabilities object (from `initialize` params or a
 * stateless `_meta`) for deprecated capability keys. Returns one
 * entry per deprecated capability found — the server records these
 * as notices so the operator sees which old clients still advertise
 * sampling / roots / logging, without rejecting the connection.
 */
export function checkDeprecatedCapabilities(
  capabilities: Record<string, unknown> | undefined,
): DeprecatedMcpMethod[] {
  if (!capabilities) return [];
  const found: DeprecatedMcpMethod[] = [];
  const seen = new Set<string>();
  for (const meta of DEPRECATED_MCP_METHODS) {
    if (meta.capability in capabilities && !seen.has(meta.capability)) {
      seen.add(meta.capability);
      found.push(meta);
    }
  }
  return found;
}
