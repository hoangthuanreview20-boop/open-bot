/**
 * Webhook trigger for automations (v0.52, P0-5).
 *
 * An external caller delivers a webhook by POSTing a body to the host
 * (the host — main process / Local API — forwards the raw body and the
 * signature to the scheduler; see `scheduler.handleWebhook`). The
 * delivery is authenticated with HMAC-SHA256:
 *
 *   signature = `sha256=` + hex(HMAC-SHA256(secret, rawBody))
 *
 * sent in the `x-open-bot-signature` header. The secret lives in the
 * Vault under namespace `automation-webhook-keys/` (see
 * `webhookKeys.ts`) and is never logged, never returned to the
 * renderer except once at creation, and never stored on the
 * automation record.
 *
 * Security rules:
 * - Verification runs BEFORE any action executes. A bad, missing or
 *   malformed signature throws and no run is recorded.
 * - Comparison is timing-safe (`crypto.timingSafeEqual`) on
 *   fixed-length buffers; a length mismatch is rejected without
 *   comparing.
 * - The raw body is verified, not a re-serialised one: the host must
 *   pass the exact bytes it received.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Automation, AutomationAction, AutomationHandlers, AutomationRun } from './types';
import { executeAutomation } from './engine';

/** Header carrying the webhook signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-open-bot-signature';

/** Prefix of the signature value: `sha256=<hex>`. */
export const WEBHOOK_SIGNATURE_PREFIX = 'sha256=';

/**
 * Compute the signature value for a raw body: `sha256=<hex HMAC-SHA256>`.
 * The host uses this to sign its own test deliveries; external callers
 * compute the same value with the shared secret.
 */
export function computeWebhookSignature(secret: string, rawBody: string | Buffer): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return `${WEBHOOK_SIGNATURE_PREFIX}${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Verify a webhook signature against the secret. Returns false (never
 * throws) for a missing, malformed or mismatched signature. The secret
 * is never logged.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signature: string | null | undefined,
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof signature !== 'string' || !signature.startsWith(WEBHOOK_SIGNATURE_PREFIX)) return false;
  const expectedHex = computeWebhookSignature(secret, rawBody).slice(WEBHOOK_SIGNATURE_PREFIX.length);
  const givenHex = signature.slice(WEBHOOK_SIGNATURE_PREFIX.length);
  const expected = Buffer.from(expectedHex, 'utf8');
  const given = Buffer.from(givenHex, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Parse a webhook body as JSON. Throws a clear error on invalid JSON. */
export function parseWebhookPayload(rawBody: string | Buffer): unknown {
  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Webhook body is not valid JSON.');
  }
}

/**
 * Apply a webhook payload to an action, returning a copy.
 * - `run-agent`: the payload JSON is appended to the prompt as context.
 * - `run-tool`: object payload keys fill in args the action does not
 *   already set (explicit action args win over payload keys).
 * - Other actions: unchanged (the payload is still recorded on the run
 *   for retry, it just does not change the action).
 */
export function applyTriggerInputToAction(action: AutomationAction, input: unknown): AutomationAction {
  if (action.kind === 'run-agent') {
    if (input === undefined || input === null) return action;
    const rendered = typeof input === 'string' ? input : JSON.stringify(input);
    return { ...action, prompt: `${action.prompt}\n\n[webhook input]\n${rendered}` };
  }
  if (action.kind === 'run-tool') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return action;
    return { ...action, args: { ...(input as Record<string, unknown>), ...(action.args ?? {}) } };
  }
  return action;
}

export interface WebhookDeliveryOptions {
  /** Raw request body, exactly as received (string or bytes). */
  rawBody: string | Buffer;
  /** Value of the `x-open-bot-signature` header. */
  signature: string | null | undefined;
  /** The shared secret for this automation's webhook key (from the Vault). Null = no key configured. */
  secret: string | null;
  handlers: AutomationHandlers;
  now?: Date;
  /**
   * Passed through to `executeAutomation`: called with the run record
   * while it is still `running`, after the signature has verified and
   * before the action executes. Auth failures never reach it, so a
   * rejected delivery still records no run.
   */
  onStarted?: (run: AutomationRun) => void;
}

/**
 * Authenticate a webhook delivery and run the automation's action.
 * Throws (and runs nothing) when the automation is disabled, when no
 * key is configured, or when the signature does not verify. The caller
 * (scheduler) records the returned run; auth failures produce no run.
 */
export async function handleWebhookDelivery(
  automation: Automation,
  opts: WebhookDeliveryOptions,
): Promise<AutomationRun> {
  if (automation.trigger.kind !== 'webhook') {
    throw new Error(`Automation "${automation.name}" does not have a webhook trigger.`);
  }
  if (!automation.enabled) {
    throw new Error(`Automation "${automation.name}" is disabled.`);
  }
  if (opts.secret === null) {
    throw new Error(
      `Automation "${automation.name}" has no webhook key yet — create one before delivering webhooks.`,
    );
  }
  if (!verifyWebhookSignature(opts.secret, opts.rawBody, opts.signature)) {
    throw new Error('Invalid webhook signature: delivery rejected before running any action.');
  }
  const input = parseWebhookPayload(opts.rawBody);
  const action = applyTriggerInputToAction(automation.action, input);
  const run = await executeAutomation(
    { ...automation, action },
    opts.handlers,
    opts.now ?? new Date(),
    { triggerInput: input, onStarted: opts.onStarted },
  );
  return run;
}
