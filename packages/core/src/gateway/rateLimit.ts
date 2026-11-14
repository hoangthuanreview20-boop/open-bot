/**
 * Gateway rate limit — per-sender token bucket (v1.02 rescue port
 * of the v1.00 work).
 *
 * A flooded channel cannot drown the bot: each sender gets a budget
 * (default 30 messages/minute). Over the limit, the message is
 * dropped with a short "slow down" reply, not processed.
 */

export interface RateLimitOptions {
  /** Max messages per window (default 30). */
  maxPerWindow?: number;
  /** Window length in ms (default 60s). */
  windowMs?: number;
}

/** Per-sender token bucket (in-memory, sliding window). */
export class GatewayRateLimiter {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(options: RateLimitOptions = {}) {
    this.maxPerWindow = options.maxPerWindow ?? 30;
    this.windowMs = options.windowMs ?? 60_000;
  }

  /**
   * Try to consume one message for a sender. Returns false when the
   * sender is over the limit (the message should be dropped with a
   * short "slow down" reply, not processed).
   */
  tryConsume(senderKey: string, now = Date.now()): boolean {
    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(senderKey) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.maxPerWindow) {
      this.hits.set(senderKey, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(senderKey, timestamps);
    return true;
  }

  /** Messages remaining in the current window for a sender. */
  remaining(senderKey: string, now = Date.now()): number {
    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(senderKey) ?? []).filter((t) => t > windowStart);
    return Math.max(0, this.maxPerWindow - timestamps.length);
  }
}
