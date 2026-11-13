/**
 * Harness v2 — signed webhook receiver (v0.97, Team T5).
 *
 * A small loopback HTTP server that accepts webhook deliveries from
 * outside tools (CI, git hooks, other services) and queues verified
 * work for a bot. Security posture, in order:
 *
 * 1. Bind: loopback only (`127.0.0.1` by default). Binding `0.0.0.0`
 *    or any other host requires the caller to pass it explicitly
 *    (`allowNonLoopback: true` + `host`), so a default install never
 *    listens on the LAN by accident. Tailscale / a managed tunnel is
 *    the supported way to expose it further (see the survey notes).
 * 2. Auth: every delivery must carry a valid HMAC signature
 *    (signature.ts, same scheme as v1 automations). Unsigned, wrongly
 *    signed, oversized or malformed deliveries are rejected with 4xx
 *    and logged — no run is ever enqueued for them.
 * 3. Queue: accepted deliveries go into an in-memory FIFO queue
 *    (bounded; overflow drops the oldest queued item and counts it)
 *    and the host drains it via `onDelivery` / `drain()`. The
 *    receiver never runs a bot itself and never touches a provider.
 * 4. Audit: every delivery (accepted or rejected) is appended to a
 *    NDJSON delivery log with a sanitized body preview — no secret,
 *    no full body.
 *
 * Routes:
 *   POST /webhooks/:targetId   — deliver to a routine/automation id
 *   GET  /health               — `{ ok: true, ...stats }` (no secret)
 *   any other                  — 404
 *
 * The receiver is transport only: `onDelivery` is how the host
 * (routine manager / automation scheduler) consumes the queue.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sanitizeHarnessPayload } from '../ndjson';
import { authenticateWebhookDelivery, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from './signature';
import type { WebhookDelivery, WebhookReceiverStats } from './types';
import { HARNESS_V2_WEBHOOK_DEFAULT_PORT, WEBHOOK_DELIVERIES_FILE } from './types';

/** Max request body the receiver accepts (1 MB — webhooks carry a prompt, not a file). */
export const WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024;
/** Max queued deliveries waiting to be drained. */
export const WEBHOOK_DEFAULT_MAX_QUEUE = 100;
/** Max chars kept in the sanitized body preview written to the audit log. */
const BODY_PREVIEW_CHARS = 500;

/** One queued, verified delivery waiting for the host to drain it. */
export interface QueuedWebhookDelivery {
  delivery: WebhookDelivery;
  /** Parsed JSON body (sanitized preview only is logged; the full parsed body is handed to the host). */
  payload: unknown;
  /** Raw body exactly as received (kept in memory only, for the host to re-verify if it wants). */
  rawBody: Buffer;
}

export interface SignedWebhookReceiverOptions {
  /** TCP port to listen on. Default 8800. */
  port?: number;
  /** Bind host. Default `127.0.0.1`. Anything else needs `allowNonLoopback: true`. */
  host?: string;
  /** Explicit opt-in to bind a non-loopback host. Default false. */
  allowNonLoopback?: boolean;
  /** Max queued deliveries. Default 100. */
  maxQueue?: number;
  /** Require the `x-open-bot-timestamp` replay guard. Default false. */
  requireTimestamp?: boolean;
  /** Replay tolerance in seconds (only when `requireTimestamp`). Default 300. */
  timestampToleranceSeconds?: number;
  /** Secret lookup: returns the HMAC secret for a target id, or null when none is configured. */
  secretProvider: (targetId: string) => string | null;
  /** Called for every accepted delivery (host enqueues the real work here). May be async; errors are counted, never crash the server. */
  onDelivery?: (queued: QueuedWebhookDelivery) => void | Promise<void>;
  /** Directory for the NDJSON delivery audit log (absent = no file log). */
  logDir?: string;
  /** Where to send warnings (receiver start/stop, dropped queue items). */
  logger?: { warn(message: string): void };
}

/** A queued item dropped because the queue was full. */
export interface WebhookQueueDrop {
  targetId: string;
  deliveryId: string;
  droppedAt: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function bodyPreview(payload: unknown): string | undefined {
  try {
    const text =
      typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    const clean = sanitizeHarnessPayload('text', { body: text })['body'];
    const preview = typeof clean === 'string' ? clean : text;
    return preview.length > BODY_PREVIEW_CHARS
      ? `${preview.slice(0, BODY_PREVIEW_CHARS)}…[truncated]`
      : preview;
  } catch {
    return undefined;
  }
}

export class SignedWebhookReceiver {
  readonly port: number;
  readonly host: string;
  private readonly opts: SignedWebhookReceiverOptions;
  private server: http.Server | null = null;
  private readonly queue: QueuedWebhookDelivery[] = [];
  private readonly deliveries: WebhookDelivery[] = [];
  private readonly rejectedByReason = new Map<string, number>();
  private readonly drops: WebhookQueueDrop[] = [];
  private onDeliveryErrors = 0;
  private lastDeliveryAt: string | undefined;

  constructor(opts: SignedWebhookReceiverOptions) {
    this.opts = opts;
    this.port = opts.port ?? HARNESS_V2_WEBHOOK_DEFAULT_PORT;
    this.host = opts.host ?? '127.0.0.1';
    if (!isLoopback(this.host) && opts.allowNonLoopback !== true) {
      throw new Error(
        `SignedWebhookReceiver refuses to bind non-loopback host "${this.host}" without allowNonLoopback: true — ` +
          `webhooks are loopback-only by default; expose via a tunnel instead.`,
      );
    }
    if (this.port < 0 || this.port > 65535 || !Number.isInteger(this.port)) {
      throw new Error(`Invalid webhook receiver port: ${this.port}.`);
    }
  }

  /** TCP port actually listening on (differs from `port` when port 0 asked the OS to pick). */
  get listeningPort(): number | null {
    if (!this.server) return null;
    const addr = this.server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : null;
  }

  /** True while the HTTP server is listening. */
  get listening(): boolean {
    return this.server !== null;
  }

  /** Number of verified deliveries waiting in the queue. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Deliveries dropped because the queue was full (oldest first). */
  get dropped(): readonly WebhookQueueDrop[] {
    return this.drops;
  }

  /** How many times `onDelivery` threw (counted, swallowed). */
  get deliveryHandlerErrors(): number {
    return this.onDeliveryErrors;
  }

  /** Start listening. Safe to call twice (second call is a no-op). */
  async start(): Promise<void> {
    if (this.server !== null) return;
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((err: unknown) => {
        try {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
        } catch {
          // Response already gone — nothing to do.
        }
        this.warn(`webhook receiver: request handler failed: ${(err as Error).message}`);
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** Stop listening. Safe to call twice. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Do not hang shutdown on keep-alive connections.
      server.closeAllConnections?.();
    });
  }

  /** Receiver statistics (no secret, safe for UI/CLI). */
  stats(): WebhookReceiverStats {
    const total = this.deliveries.length;
    const accepted = this.deliveries.filter((d) => d.verified).length;
    return {
      total,
      accepted,
      rejected: total - accepted,
      rejectedByReason: Object.fromEntries(this.rejectedByReason),
      ...(this.lastDeliveryAt !== undefined ? { lastDeliveryAt: this.lastDeliveryAt } : {}),
    };
  }

  /** All deliveries seen so far (audit view, newest last). */
  listDeliveries(): WebhookDelivery[] {
    return [...this.deliveries];
  }

  /**
   * Drain the queue: returns and removes every queued delivery, in
   * arrival order. The host calls this (or relies on `onDelivery`)
   * to turn verified webhooks into routine runs.
   */
  drain(): QueuedWebhookDelivery[] {
    return this.queue.splice(0, this.queue.length);
  }

  private warn(message: string): void {
    try {
      this.opts.logger?.warn(message);
    } catch {
      // Logger must never break the receiver.
    }
  }

  private recordDelivery(delivery: WebhookDelivery): void {
    this.deliveries.push(delivery);
    this.lastDeliveryAt = delivery.receivedAt;
    if (!delivery.verified && delivery.rejectReason !== undefined) {
      this.rejectedByReason.set(
        delivery.rejectReason,
        (this.rejectedByReason.get(delivery.rejectReason) ?? 0) + 1,
      );
    }
    const logDir = this.opts.logDir;
    if (!logDir) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const line = `${JSON.stringify(delivery)}\n`;
      fs.appendFileSync(path.join(logDir, WEBHOOK_DELIVERIES_FILE), line, 'utf8');
    } catch (err) {
      this.warn(`webhook receiver: cannot write delivery log: ${(err as Error).message}`);
    }
  }

  private enqueue(queued: QueuedWebhookDelivery): void {
    const max = this.opts.maxQueue ?? WEBHOOK_DEFAULT_MAX_QUEUE;
    while (this.queue.length >= max) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.drops.push({
          targetId: dropped.delivery.targetId,
          deliveryId: dropped.delivery.id,
          droppedAt: new Date().toISOString(),
        });
        this.warn(
          `webhook receiver: queue full — dropped oldest queued delivery ${dropped.delivery.id} for ${dropped.delivery.targetId}.`,
        );
      }
    }
    this.queue.push(queued);
    const handler = this.opts.onDelivery;
    if (handler) {
      Promise.resolve()
        .then(() => handler(queued))
        .catch(() => {
          this.onDeliveryErrors += 1;
        });
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: this.host, port: this.port, ...this.stats() }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/webhooks/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    const targetId = decodeURIComponent(url.pathname.slice('/webhooks/'.length));
    if (targetId === '' || targetId.includes('/')) {
      this.recordRejected(targetId, req, 'bad-target', 400);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid target id' }));
      return;
    }
    const chunks: Buffer[] = [];
    let tooLarge = false;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      if (Buffer.concat(chunks).length > WEBHOOK_MAX_BODY_BYTES) {
        tooLarge = true;
        break;
      }
    }
    const rawBody = Buffer.concat(chunks);
    if (tooLarge) {
      this.recordRejected(targetId, req, 'body-too-large', 413);
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'body too large' }));
      return;
    }
    let secret: string | null;
    try {
      secret = this.opts.secretProvider(targetId);
    } catch {
      this.recordRejected(targetId, req, 'missing-secret', 401);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'webhook secret lookup failed' }));
      return;
    }
    const auth = authenticateWebhookDelivery({
      secret,
      rawBody,
      signature: req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined,
      timestamp: req.headers[WEBHOOK_TIMESTAMP_HEADER] as string | undefined,
      requireTimestamp: this.opts.requireTimestamp,
      toleranceSeconds: this.opts.timestampToleranceSeconds,
    });
    if (!auth.ok) {
      const reason = auth.reason ?? 'bad-signature';
      const status = reason === 'missing-secret' ? 401 : 401;
      this.recordRejected(targetId, req, reason, status);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `webhook rejected: ${reason}` }));
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      this.recordRejected(targetId, req, 'invalid-json', 400);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'body is not valid JSON' }));
      return;
    }
    const delivery: WebhookDelivery = {
      id: randomUUID(),
      targetId,
      method: req.method ?? 'POST',
      path: url.pathname,
      receivedAt: new Date().toISOString(),
      verified: true,
      bodyPreview: bodyPreview(payload),
      httpStatus: 202,
    };
    this.recordDelivery(delivery);
    this.enqueue({ delivery, payload, rawBody });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deliveryId: delivery.id, queued: this.queue.length }));
  }

  private recordRejected(
    targetId: string,
    req: http.IncomingMessage,
    reason: string,
    httpStatus: number,
  ): void {
    this.recordDelivery({
      id: randomUUID(),
      targetId,
      method: req.method ?? 'POST',
      path: req.url ?? '/',
      receivedAt: new Date().toISOString(),
      verified: false,
      rejectReason: reason,
      httpStatus,
    });
  }
}
