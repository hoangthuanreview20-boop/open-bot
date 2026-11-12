/**
 * WebhookDispatcher (v0.5) — POST JSON events to registered endpoints.
 *
 * Events:
 *   'run.done'          — an API / chat run finished (data: { botId, runId?, text? })
 *   'run.error'         — an API / chat run failed (data: { botId, runId?, error })
 *   'approval.needed'   — an agent run is waiting for approval
 *                         (data: { botId, callId, call })
 *   'automation.notify' — an automation wants to notify the outside world
 *                         (data: { message, at? } — same shape as the
 *                         automation `notify` handler)
 *
 * Delivery is best-effort: a dead endpoint, a timeout or a non-2xx
 * status is recorded in the dispatch result and NEVER throws out of
 * `dispatch()`. One bad webhook must not break the others, and must
 * never break the run that produced the event.
 *
 * Signing (v0.8): when the host passes an `hmacSecret` (read by the
 * host from Vault namespace `webhook`, key `hmac-secret`), every POST
 * carries `X-Open-Bot-Signature: sha256=<hex>` — HMAC-SHA256 over
 * `"<timestamp>.<raw JSON body>"` — plus `X-Open-Bot-Timestamp`
 * (epoch seconds). Receivers verify with the exported
 * `verifyWebhookSignature(secret, timestamp, body, signature)`, which
 * rejects timestamps more than 5 minutes off (replay protection).
 * Without a secret the POST goes out unsigned and the dispatcher logs
 * a warning on EVERY unsigned delivery (v0.15, M5 — trước đây chỉ cảnh
 * báo một lần, dễ bị bỏ qua); it never crashes and never blocks
 * delivery. Payload không đổi shape (không thêm field `signed`).
 *
 * SSRF (v0.15, M5): URL webhook phải trỏ tới đích public. Lúc đăng ký
 * (`add`, đồng bộ) chặn ngay URL là IP literal nội bộ / `localhost`;
 * trước MỖI lần gửi (`deliverOne`) kiểm tra lại bằng DNS (tên miền có
 * thể đổi IP sau khi đăng ký) — URL nội bộ thì từ chối gửi, log rõ,
 * trả kết quả lỗi, không throw. Core không được import từ tools nên
 * helper `isPrivateIp` / `assertWebhookUrlPublic` được viết lại ngay
 * trong file này, cùng danh sách dải IP với `packages/tools/src/ssrf.ts`
 * (loopback, link-local, private, CGNAT, TEST-NET, multicast, ...).
 * Host nào thật sự cần webhook nội bộ (receiver chạy trên localhost)
 * thì bật `allowInternalUrls: true` khi tạo dispatcher — mặc định tắt.
 *
 * Persistence: registrations live in `<userData>/webhooks.json`
 * (plain JSON, URLs only — no secrets). Writes are atomic
 * (temp file + rename), like the Vault store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
  WebhookDispatchResult,
  WebhookDispatcherOptions,
  WebhookEvent,
  WebhookEventKind,
  WebhookRegistration,
} from './types';

/**
 * Option mở rộng chỉ dùng trong file này (v0.15, M5). `types.ts` không
 * thuộc phạm vi sửa của worker này nên hai option dưới đọc qua cast cục
 * bộ thay vì thêm vào `WebhookDispatcherOptions`:
 *  - `allowInternalUrls`: cho phép webhook tới URL nội bộ (mặc định
 *    false = chặn SSRF). Host bật khi receiver chạy trên localhost.
 *  - `lookupFn`: hàm resolve DNS (test inject fake; mặc định dns.lookup).
 */
interface WebhookDispatcherOptionsV015 extends WebhookDispatcherOptions {
  allowInternalUrls?: boolean;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
}

/** Per-delivery HTTP timeout (5 s). A slow endpoint must not stall a run. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Max age of a webhook timestamp a receiver should accept, seconds
 * (5 minutes). `verifyWebhookSignature` rejects anything older/newer
 * than this — replay protection for signed webhooks.
 */
export const WEBHOOK_SIGNATURE_MAX_AGE_SECONDS = 300;

/**
 * Sign a webhook payload: HMAC-SHA256 over `"<timestamp>.<body>"`,
 * returned as `sha256=<hex>` (the value of the
 * `X-Open-Bot-Signature` header). `timestamp` is epoch seconds.
 */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${body}`, 'utf-8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Verify a webhook signature (for receivers, e.g. an external app
 * checking a POST really came from open-bot). Returns false when:
 * the timestamp is not an integer number of epoch seconds, it is
 * more than WEBHOOK_SIGNATURE_MAX_AGE_SECONDS (5 min) away from now
 * (replay protection), the signature is malformed, or the HMAC does
 * not match. Comparison is timing-safe. `signature` may carry the
 * `sha256=` prefix or be bare hex.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (!Number.isInteger(timestamp)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_SIGNATURE_MAX_AGE_SECONDS) return false;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const presentedHex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  if (!/^[0-9a-fA-F]+$/.test(presentedHex)) return false;
  const expected = signWebhookPayload(secret, timestamp, body).slice('sha256='.length);
  const presentedBuf = Buffer.from(presentedHex.toLowerCase(), 'utf-8');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

export const WEBHOOK_EVENT_KINDS: readonly WebhookEventKind[] = [
  'run.done',
  'run.error',
  'approval.needed',
  'automation.notify',
];

// --- Chặn SSRF cho URL webhook (v0.15, M5) ---------------------------------
// Cùng danh sách dải IP với `packages/tools/src/ssrf.ts` (core không
// được import từ tools nên viết lại ở đây — giữ hai nơi đồng bộ khi đổi
// danh sách): loopback (127/8, ::1), link-local (169.254/16, fe80::/10),
// private (10/8, 172.16/12, 192.168/16, fc00::/7), unspecified (0.0.0.0,
// ::), CGNAT (100.64/10), TEST-NET (192.0.2/24, 198.51.100/24,
// 203.0.113/24), multicast (224/4, ff00::/8), reserved (240/4), và
// IPv4-mapped IPv6 (::ffff:a.b.c.d → kiểm tra phần IPv4).

/** Kiểm tra một địa chỉ IP (v4/v6, dạng chuỗi) có phải IP không-public. */
export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (trimmed.length === 0) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) → kiểm tra phần IPv4.
  const mapped = trimmed.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : trimmed;
  if (isIP(v4) === 4) {
    const parts = v4.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 0) return true; // 0.0.0.0/8 ("this network")
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2/24 TEST-NET-1
    if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
    return false;
  }
  if (isIP(trimmed) === 6) {
    const lower = trimmed.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
    if (lower.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }
  return true; // Không phải IP hợp lệ → coi như không an toàn.
}

export interface WebhookSsrfCheckOptions {
  /** Hàm resolve DNS (test inject fake; mặc định dns.lookup). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
}

/**
 * Kiểm tra URL webhook trỏ tới đích public. Trả về URL đã parse khi OK,
 * ném lỗi tiếng Việt rõ ràng khi bị chặn (kèm host/IP để log).
 *  - hostname là IP literal → kiểm tra trực tiếp;
 *  - hostname là tên miền → resolve bằng DNS, TẤT CẢ địa chỉ trả về đều
 *    phải là IP public (một tên miền trỏ cả public + private vẫn bị chặn);
 *  - DNS resolve lỗi → chặn luôn (fail closed).
 */
export async function assertWebhookUrlPublic(
  raw: string | URL,
  opts: WebhookSsrfCheckOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new Error(`URL webhook không hợp lệ: "${String(raw)}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Webhook chỉ cho phép http:// và https://, nhận được "${url.protocol}"`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(
      `Chặn SSRF: webhook "${url.hostname}" là host nội bộ (localhost) — webhook không được POST tới service nội bộ.`,
    );
  }
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(
        `Chặn SSRF: webhook "${url.hostname}" là IP nội bộ/riêng — webhook không được POST tới service nội bộ.`,
      );
    }
    return url;
  }
  const lookupFn =
    opts.lookupFn ??
    (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupFn(host);
  } catch {
    throw new Error(
      `Chặn SSRF: webhook không resolve được "${url.hostname}" nên không xác minh được đích đến — không gửi.`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(`Chặn SSRF: webhook "${url.hostname}" không resolve ra địa chỉ nào.`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `Chặn SSRF: webhook "${url.hostname}" resolve ra IP nội bộ/riêng (${address}) — webhook không được POST tới service nội bộ.`,
      );
    }
  }
  return url;
}

const WEBHOOK_FILE_VERSION = 1;

interface WebhookStoreFile {
  version: 1;
  webhooks: WebhookRegistration[];
}

function isEventKind(value: unknown): value is WebhookEventKind {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENT_KINDS as readonly string[]).includes(value)
  );
}

export class WebhookDispatcher {
  private readonly storePath: string;
  private webhooks: WebhookRegistration[];
  /**
   * v0.8: HMAC secret for signing deliveries. Supplied by the host
   * (Vault namespace `webhook`, key `hmac-secret`) — this class never
   * reads the Vault. Empty/absent = send unsigned + warn on EVERY
   * delivery (v0.15, M5 — không còn cảnh báo một lần rồi thôi).
   */
  private hmacSecret: string;
  /**
   * v0.15 (M5): cho phép webhook tới URL nội bộ (loopback/private).
   * Mặc định false = chặn SSRF. Chỉ bật khi host biết receiver chạy
   * trên máy local và chấp nhận rủi ro.
   */
  private readonly allowInternalUrls: boolean;
  /** Hàm resolve DNS inject được (test dùng fake, mặc định dns.lookup). */
  private readonly lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;

  constructor(options: WebhookDispatcherOptions) {
    if (!options.storePath) throw new Error('WebhookDispatcher needs a storePath.');
    this.storePath = options.storePath;
    this.hmacSecret = typeof options.hmacSecret === 'string' ? options.hmacSecret : '';
    const extra = options as WebhookDispatcherOptionsV015;
    this.allowInternalUrls = extra.allowInternalUrls === true;
    this.lookupFn = extra.lookupFn;
    this.webhooks = this.loadStore();
  }

  /** Path of the JSON store file. */
  get path(): string {
    return this.storePath;
  }

  /**
   * v0.8: replace the HMAC secret at runtime (e.g. the host generated
   * one after the dispatcher was created). Pass ''/undefined to go
   * back to unsigned deliveries.
   */
  setHmacSecret(secret: string | undefined): void {
    this.hmacSecret = typeof secret === 'string' ? secret : '';
  }

  /** True when deliveries are currently signed. */
  get isSigning(): boolean {
    return this.hmacSecret.length > 0;
  }

  /** All registrations (copies — mutating the result changes nothing). */
  list(): WebhookRegistration[] {
    return this.webhooks.map((w) => ({ ...w, events: [...w.events] }));
  }

  /**
   * Register a new webhook. Throws on a non-http(s) URL, an empty
   * event list, or an unknown event kind. Also throws (v0.15, M5) when
   * the URL is an internal literal IP / localhost and the dispatcher
   * was not created with `allowInternalUrls: true` — chặn SSRF ngay lúc
   * đăng ký thay vì đợi tới lúc gửi. Returns the registration
   * (with a generated id).
   */
  add(url: string, events: string[]): WebhookRegistration {
    const parsed = validateUrl(url, this.allowInternalUrls);
    const kinds = validateEvents(events);
    const registration: WebhookRegistration = {
      id: randomUUID(),
      url: parsed.toString(),
      events: kinds,
    };
    this.webhooks.push(registration);
    this.saveStore();
    return { ...registration, events: [...registration.events] };
  }

  /** Remove a webhook by id. Returns true when one was removed. */
  remove(id: string): boolean {
    const before = this.webhooks.length;
    this.webhooks = this.webhooks.filter((w) => w.id !== id);
    if (this.webhooks.length === before) return false;
    this.saveStore();
    return true;
  }

  /**
   * Deliver `event` to every webhook registered for its kind.
   * Best-effort: never throws; each result records ok / status / error.
   * Deliveries run in parallel (one slow endpoint does not delay the rest).
   */
  async dispatch(event: WebhookEvent): Promise<WebhookDispatchResult[]> {
    if (!isEventKind(event.kind)) {
      throw new Error(`Unknown webhook event kind: ${String(event.kind)}`);
    }
    const targets = this.webhooks.filter((w) => w.events.includes(event.kind));
    const body = JSON.stringify(event);
    return Promise.all(targets.map((w) => this.deliverOne(w, body)));
  }

  private async deliverOne(
    webhook: WebhookRegistration,
    body: string,
  ): Promise<WebhookDispatchResult> {
    const base: WebhookDispatchResult = {
      webhookId: webhook.id,
      url: webhook.url,
      ok: false,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      // v0.15 (M5-a): kiểm tra SSRF lại trước MỖI lần gửi — tên miền có
      // thể đổi IP sau khi đăng ký (DNS rebinding), nên chỉ kiểm tra lúc
      // add() là chưa đủ. URL nội bộ → từ chối gửi, log rõ, trả kết quả
      // lỗi; không throw (delivery vẫn best-effort, webhook khác không
      // bị ảnh hưởng). Bật `allowInternalUrls` thì bỏ qua bước này.
      if (!this.allowInternalUrls) {
        try {
          await assertWebhookUrlPublic(webhook.url, { lookupFn: this.lookupFn });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[webhooks] ${message} — không gửi tới ${webhook.url}.`);
          return { ...base, error: message };
        }
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
      };
      if (this.hmacSecret.length > 0) {
        // v0.8: sign the exact bytes being sent. The timestamp is part
        // of the signed string so a captured POST cannot be replayed
        // later (the receiver rejects timestamps > 5 min old).
        const timestamp = Math.floor(Date.now() / 1000);
        headers['X-Open-Bot-Signature'] = signWebhookPayload(this.hmacSecret, timestamp, body);
        headers['X-Open-Bot-Timestamp'] = String(timestamp);
      } else {
        // v0.15 (M5-b): cảnh báo MỖI lần gửi không ký (không còn "một
        // lần rồi thôi") — ghi rõ URL để người dùng thấy webhook nào
        // đang gửi trần. Không bắt buộc ký (không phá webhook đang
        // chạy), và KHÔNG đổi shape payload (không thêm field `signed`).
        console.warn(
          `[webhooks] Webhook ${webhook.url} đang gửi KHÔNG ký HMAC — ` +
            'bất kỳ ai cũng có thể giả mạo POST này. ' +
            'Đặt secret ở Vault namespace "webhook", key "hmac-secret" để receiver xác thực được nguồn.',
        );
      }
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      // Drain the body so the connection can be reused / closed cleanly.
      await res.text().catch(() => undefined);
      return { ...base, ok: res.ok, status: res.status };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? `Webhook delivery timed out after ${WEBHOOK_TIMEOUT_MS} ms.`
            : err.message
          : 'Webhook delivery failed.';
      return { ...base, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Persistence ----------------------------------------------------------

  private loadStore(): WebhookRegistration[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.storePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt store must not kill all webhooks: warn and start empty
      // (same fail-open pattern as the model registry's models.json).
      console.warn(`[webhooks] Store is not valid JSON, starting empty: ${this.storePath}`);
      return [];
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as WebhookStoreFile).version !== 1 ||
      !Array.isArray((parsed as WebhookStoreFile).webhooks)
    ) {
      console.warn(`[webhooks] Store has an unsupported shape, starting empty: ${this.storePath}`);
      return [];
    }
    // Validate on load so a hand-edited file cannot inject bad entries.
    const out: WebhookRegistration[] = [];
    for (const entry of (parsed as WebhookStoreFile).webhooks) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as WebhookRegistration).id !== 'string' ||
        typeof (entry as WebhookRegistration).url !== 'string' ||
        !Array.isArray((entry as WebhookRegistration).events)
      ) {
        continue;
      }
      try {
        const url = validateUrl((entry as WebhookRegistration).url, this.allowInternalUrls);
        const events = validateEvents((entry as WebhookRegistration).events);
        out.push({ id: (entry as WebhookRegistration).id, url: url.toString(), events });
      } catch {
        // Skip one bad entry; the rest of the file still loads.
      }
    }
    return out;
  }

  private saveStore(): void {
    const file: WebhookStoreFile = { version: 1, webhooks: this.webhooks };
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.storePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.storePath);
  }
}

function validateUrl(url: string, allowInternalUrls = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use http: or https:.');
  }
  // v0.15 (M5-a): chặn đồng bộ URL nội bộ ngay lúc đăng ký/nạp store —
  // IP literal nội bộ + localhost. Tên miền (cần DNS) được kiểm tra lại
  // trước mỗi lần gửi ở deliverOne (assertWebhookUrlPublic). Bật
  // allowInternalUrls thì bỏ qua bước này.
  if (!allowInternalUrls) {
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new Error(
        `Chặn SSRF: webhook "${parsed.hostname}" là host nội bộ (localhost) — webhook không được POST tới service nội bộ.`,
      );
    }
    if (isIP(host) !== 0 && isPrivateIp(host)) {
      throw new Error(
        `Chặn SSRF: webhook "${parsed.hostname}" là IP nội bộ/riêng — webhook không được POST tới service nội bộ.`,
      );
    }
  }
  return parsed;
}

function validateEvents(events: unknown): WebhookEventKind[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Webhook needs at least one event kind.');
  }
  const kinds: WebhookEventKind[] = [];
  for (const e of events) {
    if (!isEventKind(e)) {
      throw new Error(`Unknown webhook event kind: ${String(e)}`);
    }
    if (!kinds.includes(e)) kinds.push(e);
  }
  return kinds;
}

export type {
  WebhookDispatchResult,
  WebhookDispatcherOptions,
  WebhookEvent,
  WebhookEventKind,
  WebhookRegistration,
} from './types';
