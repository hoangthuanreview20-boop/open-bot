/**
 * JSON-RPC 2.0 peer over NDJSON — shared transport for the ACP agent
 * side and the ACP client side (v1.02 rescue port of the v0.99 work).
 *
 * Unlike the one-way client in `providers/cli/jsonRpc.ts`, this peer is
 * fully bidirectional on any pair of Node streams (real stdin/stdout,
 * or an in-memory PassThrough pair for the built-in provider + tests):
 * - send a request and await its response (matched by id),
 * - receive requests from the other side and answer via `onRequest`
 *   (a handler throw becomes a JSON-RPC error; no handler -> -32601),
 * - send/receive notifications (no id, no wait),
 * - `$/cancel_request`: notification `{id}` asks to cancel a running
 *   request — the peer cancels the AbortController of that handler;
 *   the sender uses `cancelRequest(id)` (notification only; the
 *   promise still awaits the other side answering with error -32800
 *   or a result).
 *
 * Defense: a non-JSON line or an over-long line is counted in stats
 * and skipped (never crashes the peer); a strange message (no id, no
 * method) is only counted. Nothing but ACP messages is ever written
 * to stdout — logging goes through `logger` (silent by default;
 * the agent stdio host routes it to stderr).
 *
 * Node stdlib only, no extra dependency.
 */

import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

import {
  ACP_JSON_RPC_INTERNAL_ERROR,
  ACP_JSON_RPC_INVALID_REQUEST,
  ACP_JSON_RPC_METHOD_NOT_FOUND,
  ACP_JSON_RPC_REQUEST_CANCELLED,
  type JsonRpcErrorObject,
  type JsonRpcId,
  isRecord,
} from './types';

export type { JsonRpcId } from './types';

/** Error returned by the peer (or raised by the transport itself). */
export class AcpJsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(error: JsonRpcErrorObject) {
    super(`JSON-RPC error ${error.code}: ${error.message}`);
    this.name = 'AcpJsonRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface AcpTransportStats {
  /** Requests we sent. */
  requestsSent: number;
  /** Notifications we sent. */
  notificationsSent: number;
  /** Responses / notifications / requests received and handled. */
  messagesReceived: number;
  /** Lines skipped (not JSON, too long, or malformed). */
  linesSkipped: number;
  /** Requests currently awaiting a response. */
  pendingRequests: number;
}

/** Handler for an incoming request. Return value becomes `result`. */
export type AcpRequestHandler = (
  params: Record<string, unknown> | undefined,
  signal: AbortSignal,
) => Promise<unknown> | unknown;

/** Handler for an incoming notification. */
export type AcpNotificationHandler = (params: Record<string, unknown> | undefined) => void;

export interface AcpPeerOptions {
  /** Max bytes of one NDJSON line (default 1 MiB). Longer lines are skipped. */
  maxLineBytes?: number;
  /** Optional logger (default: silent). Never writes to stdout. */
  logger?: (message: string) => void;
  /** Called for requests with no registered handler (default: -32601). */
  onUnhandledRequest?: (method: string, params: Record<string, unknown> | undefined) => Promise<unknown> | unknown;
  /** Called for notifications with no registered handler. */
  onUnhandledNotification?: (method: string, params: Record<string, unknown> | undefined) => void;
}

/** Default max NDJSON line length (1 MiB). */
export const ACP_DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

/**
 * A bidirectional JSON-RPC 2.0 peer over newline-delimited JSON.
 * Create with `createAcpPeerPair()` for in-memory tests, or attach
 * to real streams with `new AcpJsonRpcPeer(input, output, options)`.
 */
export class AcpJsonRpcPeer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly maxLineBytes: number;
  private readonly logger: (message: string) => void;
  private readonly handlers = new Map<string, AcpRequestHandler>();
  private readonly notificationHandlers = new Map<string, AcpNotificationHandler>();
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** AbortControllers of handlers currently running (keyed by request id). */
  private readonly running = new Map<JsonRpcId, AbortController>();
  private readonly stats: AcpTransportStats = {
    requestsSent: 0,
    notificationsSent: 0,
    messagesReceived: 0,
    linesSkipped: 0,
    pendingRequests: 0,
  };
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private readonly onUnhandledRequest?: AcpPeerOptions['onUnhandledRequest'];
  private readonly onUnhandledNotification?: AcpPeerOptions['onUnhandledNotification'];

  constructor(input: Readable, output: Writable, options: AcpPeerOptions = {}) {
    this.input = input;
    this.output = output;
    this.maxLineBytes = options.maxLineBytes ?? ACP_DEFAULT_MAX_LINE_BYTES;
    this.logger = options.logger ?? (() => {});
    this.onUnhandledRequest = options.onUnhandledRequest;
    this.onUnhandledNotification = options.onUnhandledNotification;
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => this.onData(chunk));
    this.input.on('end', () => this.close(new Error('ACP transport closed (input ended)')));
    this.input.on('error', (error: Error) => this.close(error));
  }

  /** Register a handler for an incoming request method. */
  onRequest(method: string, handler: AcpRequestHandler): void {
    this.handlers.set(method, handler);
  }

  /** Register a handler for an incoming notification method. */
  onNotification(method: string, handler: AcpNotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request and await its response. */
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpJsonRpcError({ code: ACP_JSON_RPC_INTERNAL_ERROR, message: 'ACP transport closed' }));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.stats.pendingRequests = this.pending.size;
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          reject(new AcpJsonRpcError({ code: ACP_JSON_RPC_REQUEST_CANCELLED, message: 'request cancelled' }));
          return;
        }
        signal.addEventListener('abort', () => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            this.stats.pendingRequests = this.pending.size;
            this.sendNotification('$/cancel_request', { id }).catch(() => {});
            reject(new AcpJsonRpcError({ code: ACP_JSON_RPC_REQUEST_CANCELLED, message: 'request cancelled' }));
          }
        }, { once: true });
      }
    });
    this.stats.requestsSent++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  /** Send a notification (fire-and-forget). */
  async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    this.stats.notificationsSent++;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Ask the other side to cancel a request we sent (by id). */
  async cancelRequest(id: JsonRpcId): Promise<void> {
    await this.sendNotification('$/cancel_request', { id });
  }

  /** Snapshot of transport counters. */
  getStats(): AcpTransportStats {
    return { ...this.stats, pendingRequests: this.pending.size };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Close the peer: pending requests fail, running handlers are aborted. */
  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const reason = error ?? new Error('ACP transport closed');
    for (const [, pending] of this.pending) pending.reject(reason);
    this.pending.clear();
    for (const [, controller] of this.running) controller.abort();
    this.running.clear();
    this.stats.pendingRequests = 0;
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.logger(`ACP write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      // Over-long line without a newline yet: drop it, do not grow memory.
      this.buffer = '';
      this.stats.linesSkipped++;
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    if (Buffer.byteLength(trimmed, 'utf8') > this.maxLineBytes) {
      this.stats.linesSkipped++;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.stats.linesSkipped++;
      return;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
      this.stats.linesSkipped++;
      return;
    }
    void this.dispatch(parsed);
  }

  private async dispatch(message: Record<string, unknown>): Promise<void> {
    this.stats.messagesReceived++;
    const id = message.id as JsonRpcId | undefined;
    const method = message.method as string | undefined;
    if (typeof method === 'string') {
      if (id !== undefined) {
        await this.handleRequest(id, method, isRecord(message.params) ? message.params : undefined);
      } else {
        this.handleNotification(method, isRecord(message.params) ? message.params : undefined);
      }
      return;
    }
    if (id !== undefined && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      this.stats.pendingRequests = this.pending.size;
      if (isRecord(message.error)) {
        const error = message.error as unknown as JsonRpcErrorObject;
        pending.reject(
          new AcpJsonRpcError({
            code: typeof error.code === 'number' ? error.code : ACP_JSON_RPC_INTERNAL_ERROR,
            message: typeof error.message === 'string' ? error.message : 'unknown error',
            data: error.data,
          }),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.stats.linesSkipped++;
  }

  private async handleRequest(id: JsonRpcId, method: string, params: Record<string, unknown> | undefined): Promise<void> {
    if (method === '$/cancel_request') {
      const targetId = params?.id as JsonRpcId | undefined;
      if (targetId !== undefined) this.running.get(targetId)?.abort();
      return;
    }
    const handler = this.handlers.get(method);
    if (!handler && !this.onUnhandledRequest) {
      this.write({ jsonrpc: '2.0', id, error: { code: ACP_JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${method}` } });
      return;
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      const result = handler
        ? await handler(params, controller.signal)
        : await this.onUnhandledRequest!(method, params);
      if (controller.signal.aborted) {
        this.write({ jsonrpc: '2.0', id, error: { code: ACP_JSON_RPC_REQUEST_CANCELLED, message: 'request cancelled' } });
        return;
      }
      this.write({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    } catch (error) {
      if (error instanceof AcpJsonRpcError) {
        this.write({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message, data: error.data } });
      } else if (error instanceof Error && error.name === 'AbortError') {
        this.write({ jsonrpc: '2.0', id, error: { code: ACP_JSON_RPC_REQUEST_CANCELLED, message: 'request cancelled' } });
      } else {
        this.write({
          jsonrpc: '2.0',
          id,
          error: {
            code: ACP_JSON_RPC_INTERNAL_ERROR,
            message: error instanceof Error ? error.message : 'internal error',
          },
        });
      }
    } finally {
      this.running.delete(id);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (method === '$/cancel_request') {
      const targetId = params?.id as JsonRpcId | undefined;
      if (targetId !== undefined) this.running.get(targetId)?.abort();
      return;
    }
    const handler = this.notificationHandlers.get(method);
    if (handler) {
      try {
        handler(params);
      } catch (error) {
        this.logger(`ACP notification handler failed (${method}): ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (this.onUnhandledNotification) {
      try {
        this.onUnhandledNotification(method, params);
      } catch (error) {
        this.logger(`ACP notification handler failed (${method}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** A pair of peers connected in memory (for tests and the built-in provider). */
export interface AcpPeerPair {
  client: AcpJsonRpcPeer;
  server: AcpJsonRpcPeer;
}

/** Create two peers wired to each other through PassThrough streams. */
export function createAcpPeerPair(options: AcpPeerOptions = {}): AcpPeerPair {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = new AcpJsonRpcPeer(serverToClient, clientToServer, options);
  const server = new AcpJsonRpcPeer(clientToServer, serverToClient, options);
  return { client, server };
}

/** Type guard: is this value a JSON-RPC error object? */
export function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string';
}

/** Build a JSON-RPC parse/invalid-request error object. */
export function jsonRpcError(code: number, message: string, data?: unknown): JsonRpcErrorObject {
  return { code, message, ...(data !== undefined ? { data } : {}) };
}

/** Validate a raw parsed value as a JSON-RPC message shape. */
export function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return false;
  if (typeof value.method === 'string') return true;
  return value.id !== undefined && ('result' in value || 'error' in value);
}
