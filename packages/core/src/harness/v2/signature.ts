/**
 * Harness v2 — signed webhook verification (v0.97, Team T5).
 *
 * The v1 automation webhook (`automations/webhook.ts`) already verifies
 * `sha256=<hex HMAC-SHA256(secret, rawBody)>` from the
 * `x-open-bot-signature` header. Harness v2 reuses exactly that scheme
 * (same header, same prefix, same timing-safe compare) so existing
 * senders keep working, and adds an optional replay guard: when the
 * sender also sends `x-open-bot-timestamp` (unix seconds), the
 * receiver rejects deliveries whose timestamp is too far from the
 * receiver clock (default 300 s tolerance, same as the Composio and
 * Slack routes). The timestamp is NOT part of the HMAC input, so
 * senders that only sign the body stay compatible.
 *
 * The secret itself is never logged here; callers pass it in and the
 * functions only return booleans.
 */

import { computeWebhookSignature, verifyWebhookSignature } from '../../automations/webhook';

export { computeWebhookSignature, verifyWebhookSignature };
export { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_SIGNATURE_PREFIX } from '../../automations/webhook';

/** Header carrying the sender's unix-seconds timestamp (optional). */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-open-bot-timestamp';
/** Default replay tolerance for the timestamp header (5 minutes). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_S = 300;

/**
 * Check a `x-open-bot-timestamp` value against the receiver clock.
 * Returns false for a missing, non-numeric or out-of-tolerance value.
 * `now` is injectable so tests can pin the clock.
 */
export function verifyWebhookTimestamp(
  timestamp: string | null | undefined,
  now: Date = new Date(),
  toleranceSeconds: number = WEBHOOK_TIMESTAMP_TOLERANCE_S,
): boolean {
  if (typeof timestamp !== 'string' || timestamp.trim() === '') return false;
  const seconds = Number(timestamp.trim());
  if (!Number.isFinite(seconds)) return false;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return Math.abs(nowSeconds - seconds) <= toleranceSeconds;
}

/** Outcome of a full delivery authentication check. */
export interface WebhookAuthResult {
  ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  reason?:
    | 'missing-secret'
    | 'missing-signature'
    | 'bad-signature'
    | 'missing-timestamp'
    | 'stale-timestamp';
}

/**
 * Authenticate one delivery: secret must exist, the HMAC signature
 * must verify, and — only when the caller requires a timestamp — the
 * timestamp header must be present and fresh. Verification runs
 * before any parsing or execution; a failure returns `{ ok: false }`
 * and the caller records no run.
 */
export function authenticateWebhookDelivery(opts: {
  secret: string | null;
  rawBody: string | Buffer;
  signature: string | null | undefined;
  timestamp?: string | null | undefined;
  requireTimestamp?: boolean;
  now?: Date;
  toleranceSeconds?: number;
}): WebhookAuthResult {
  if (opts.secret === null || opts.secret === '') {
    return { ok: false, reason: 'missing-secret' };
  }
  if (typeof opts.signature !== 'string' || opts.signature === '') {
    return { ok: false, reason: 'missing-signature' };
  }
  if (!verifyWebhookSignature(opts.secret, opts.rawBody, opts.signature)) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (opts.requireTimestamp === true) {
    if (typeof opts.timestamp !== 'string' || opts.timestamp === '') {
      return { ok: false, reason: 'missing-timestamp' };
    }
    if (
      !verifyWebhookTimestamp(opts.timestamp, opts.now ?? new Date(), opts.toleranceSeconds)
    ) {
      return { ok: false, reason: 'stale-timestamp' };
    }
  }
  return { ok: true };
}
