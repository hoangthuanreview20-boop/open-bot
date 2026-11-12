/**
 * Egress gate (local) — proxy HTTP chỉ cho địa chỉ public (M6).
 *
 * Gate là một HTTP proxy nhỏ chạy trên loopback (127.0.0.1, port cấu
 * hình được, mặc định 0 = chọn port trống). Mọi request mạng từ trong
 * box phải đi qua gate (box đặt `http_proxy`/`https_proxy` trỏ vào gate
 * — xem `proxyEnv()`); gate KHÔNG phải là đường bypass egress.
 *
 * Quyết định tái dùng `checkEgress`/`checkEgressSync` của `egress/`
 * (không viết policy thứ hai):
 *  - loopback / LAN / link-local / metadata (169.254.169.254...) → chặn,
 *    trừ allow-list local-service mà egress đã làm (context
 *    'local-service' không dùng ở gate: client trong box luôn là
 *    context 'agent', nên 127.0.0.1 từ trong box cũng bị chặn).
 *  - fail-closed: policy thiếu/tắt, DNS lỗi, đích không xác minh được
 *    → chặn.
 *  - request bị chặn trả 403 với mã egress (không echo URL đích).
 *
 * Log quyết định: chỉ host + kind + reason (như telemetry egress) —
 * KHÔNG ghi URL đầy đủ (path/query có thể chứa secret), KHÔNG ghi
 * header/body. Xem `GateDecisionLog`.
 *
 * Hỗ trợ: request absolute-form (GET/POST/... qua http/https) và
 * CONNECT (tunnel TCP — dùng cho https qua proxy). Gate KHÔNG tự
 * terminate TLS: với absolute-form https, gate forward bằng client
 * https thật; với CONNECT, gate chỉ mở tunnel sau khi checkEgress qua.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';

import { checkEgress, EgressError } from '../egress/index';
import type { EgressPolicy } from '../egress/types';
import type { EgressGateOptions, GateDecisionLog } from './types';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

/** Đọc hết body của request (giới hạn 10 MB). */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_PROXY_BODY_BYTES) {
        reject(new Error('Proxy request body too large (max 10 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface ForwardResult {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/** Forward HTTP/HTTPS thật (mặc định): request tới URL đích, trả response. */
function defaultForward(request: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}): Promise<ForwardResult> {
  const target = new URL(request.url);
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  }
  return new Promise((resolve, reject) => {
    const upstream = lib.request(
      {
        method: request.method,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : isHttps ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const outHeaders: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) outHeaders[key] = value;
          }
          resolve({ status: res.statusCode ?? 502, headers: outHeaders, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    upstream.on('error', reject);
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Upstream timeout (30s).')));
    if (request.body.length > 0) upstream.write(request.body);
    upstream.end();
  });
}

export interface EgressGateInfo {
  host: string;
  port: number;
  /** URL proxy (vd 'http://127.0.0.1:3128'). */
  url: string;
}

export class EgressGate {
  readonly boxId: string;
  readonly policy: EgressPolicy;
  private readonly options: EgressGateOptions;
  private readonly decisionLog: GateDecisionLog[] = [];
  private server: http.Server | null = null;
  private port = 0;

  constructor(boxId: string, options: EgressGateOptions) {
    this.boxId = boxId;
    this.policy = options.policy;
    this.options = options;
  }

  /** Port đang chạy (0 khi chưa start). */
  get runningPort(): number {
    return this.port;
  }

  /** True khi gate đang chạy. */
  get running(): boolean {
    return this.server !== null;
  }

  /** Mọi quyết định gate đã ghi (chỉ host + kind — không URL đầy đủ). */
  decisions(): GateDecisionLog[] {
    return [...this.decisionLog];
  }

  /** Env proxy để đưa vào box (`http_proxy`/`https_proxy` trỏ vào gate). */
  proxyEnv(): Record<string, string> {
    const url = `http://127.0.0.1:${this.port}`;
    return { http_proxy: url, https_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url };
  }

  /** Khởi động gate trên 127.0.0.1 (port cấu hình hoặc port trống). */
  async start(): Promise<EgressGateInfo> {
    if (this.server) return { host: '127.0.0.1', port: this.port, url: `http://127.0.0.1:${this.port}` };
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on('connect', (req, socket) => {
      void this.handleConnect(req, socket as net.Socket);
    });
    const port = this.options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address() as { port: number };
    this.port = address.port;
    return { host: '127.0.0.1', port: this.port, url: `http://127.0.0.1:${this.port}` };
  }

  /** Dừng gate (best-effort). Đóng cả connection tunnel còn mở để stop không treo. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = 0;
    try {
      server.closeAllConnections?.();
    } catch {
      // Node cũ không có closeAllConnections — close() vẫn chờ hết connection.
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // --- Xử lý request ---------------------------------------------------------

  private logDecision(
    method: string,
    host: string,
    allowed: boolean,
    kind: string,
    reason?: string,
  ): void {
    const entry: GateDecisionLog = {
      at: new Date().toISOString(),
      boxId: this.boxId,
      method,
      host,
      allowed,
      kind,
      ...(reason !== undefined ? { reason } : {}),
    };
    this.decisionLog.push(entry);
    this.options.onDecision?.(entry);
  }

  private deny(res: http.ServerResponse, err: EgressError, method: string, host: string): void {
    this.logDecision(method, host, false, err.kind, err.code);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.code ?? 'egress_blocked', kind: err.kind }));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '';
    // Chỉ nhận absolute-form (proxy request). Origin-form (request
    // trực tiếp, không qua proxy) → 400.
    if (!/^https?:\/\//i.test(rawUrl)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'egress_bad_request', kind: 'blocked' }));
      return;
    }
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'egress_invalid_target', kind: 'blocked' }));
      return;
    }
    const host = target.hostname.toLowerCase();
    try {
      const decision = await checkEgress(target, this.policy, {
        context: 'agent',
        ...(this.options.lookupFn !== undefined ? { lookupFn: this.options.lookupFn } : {}),
        telemetry: null,
      });
      this.logDecision(method, host, true, 'allowed', decision.reason);
    } catch (err) {
      if (err instanceof EgressError) {
        this.deny(res, err, method, host);
        return;
      }
      // Lỗi khác (không phải EgressError) → fail-closed, chặn luôn.
      this.logDecision(method, host, false, 'blocked', 'egress_check_failed');
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'egress_blocked', kind: 'blocked' }));
      return;
    }
    // Qua gate → forward (mặc định request thật, test có thể inject fake).
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'egress_body_too_large', kind: 'blocked' }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
    const forward = this.options.forwardFn ?? defaultForward;
    try {
      const result = await forward({ method, url: rawUrl, headers, body });
      const outHeaders: Record<string, string | string[] | number> = {};
      for (const [key, value] of Object.entries(result.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
      }
      res.writeHead(result.status, outHeaders);
      res.end(result.body);
    } catch (err) {
      // Lỗi forward (mạng đích sập...) → 502, không rò URL đích vào body.
      this.options.logger?.warn(`egress gate: forward tới "${host}" lỗi: ${(err as Error).message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'egress_upstream_error', kind: 'unreachable' }));
    }
  }

  private async handleConnect(
    req: http.IncomingMessage,
    socket: net.Socket,
  ): Promise<void> {
    const authority = req.url ?? '';
    const [hostRaw, portRaw] = authority.split(':');
    const host = (hostRaw ?? '').toLowerCase();
    const port = portRaw ? Number(portRaw) : 443;
    if (host === '' || !Number.isFinite(port)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.end();
      return;
    }
    try {
      const decision = await checkEgress({ host, scheme: 'https' }, this.policy, {
        context: 'agent',
        ...(this.options.lookupFn !== undefined ? { lookupFn: this.options.lookupFn } : {}),
        telemetry: null,
      });
      this.logDecision('CONNECT', host, true, 'allowed', decision.reason);
    } catch (err) {
      if (err instanceof EgressError) {
        this.logDecision('CONNECT', host, false, err.kind, err.code);
      } else {
        this.logDecision('CONNECT', host, false, 'blocked', 'egress_check_failed');
      }
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.end();
      return;
    }
    const connectFn =
      this.options.connectFn ??
      ((h: string, p: number) =>
        new Promise<net.Socket>((resolve, reject) => {
          const upstream = net.connect(p, h);
          upstream.once('connect', () => resolve(upstream));
          upstream.once('error', reject);
        }));
    try {
      const upstream = await connectFn(host, port);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    } catch {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.end();
    }
  }
}
