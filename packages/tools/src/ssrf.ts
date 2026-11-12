/**
 * SSRF guard cho các tool fetch URL do agent/user đưa vào (v0.15, sửa H3
 * của audit bảo mật).
 *
 * Vấn đề: `http_get`/`web_fetch` trước đây chỉ kiểm tra protocol, nên
 * agent (hoặc model bị lái bởi prompt injection từ một trang vừa fetch)
 * có thể GET service nội bộ không auth: Ollama ở 127.0.0.1:11434, Local
 * API, metadata cloud 169.254.169.254, service nội bộ khác.
 *
 * Guard này chặn trước khi fetch:
 *  - hostname là IP literal → kiểm tra trực tiếp;
 *  - hostname là tên miền → resolve bằng DNS, TẤT CẢ địa chỉ trả về đều
 *    phải là IP public (một tên miền trỏ cả public + private vẫn bị chặn);
 *  - redirect được follow thủ công (tối đa 5), mỗi hop kiểm tra lại URL
 *    đích — fetch mặc định follow redirect nên không dùng được ở đây.
 *
 * IP bị chặn: loopback (127/8, ::1), link-local (169.254/16, fe80::/10),
 * private (10/8, 172.16/12, 192.168/16, fc00::/7), unspecified (0.0.0.0,
 * ::), CGNAT (100.64/10), TEST-NET (192.0.2/24, 198.51.100/24,
 * 203.0.113/24), multicast (224/4, ff00::/8), reserved (240/4), và
 * IPv4-mapped IPv6 (::ffff:a.b.c.d → kiểm tra phần IPv4).
 *
 * DNS resolve lỗi → chặn luôn (fail closed): không fetch khi không xác
 * minh được đích đến. `lookupFn` inject được để test không cần mạng thật.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
// P0-2: SSRF check nối vào egress policy chung của core
// (`packages/core/src/egress/`). Đường cũ (không policy) giữ nguyên
// hành vi/messages để test cũ xanh; khi caller truyền `egressPolicy`
// thì kiểm tra đi qua policy (allowlist theo team, fail-closed,
// phân loại lỗi egress) thay vì chỉ chặn private.
import {
  checkEgress,
  classifyEgressFetchError,
  EgressError,
  type EgressContext,
  type EgressPolicy,
} from '@open-bot/core/dist/egress/policy';

export const MAX_SSRF_REDIRECTS = 5;

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

export interface SsrfCheckOptions {
  /** Hàm resolve DNS (test inject fake; mặc định dns.lookup). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /**
   * P0-2: khi có, URL được kiểm tra bằng egress policy chung
   * (allowlist/fail-closed/phân loại lỗi) thay vì chỉ chặn đích
   * private. `null` = chặn fail-closed (không có policy rõ ràng).
   * Không truyền = giữ hành vi SSRF cũ (chỉ chặn private).
   */
  egressPolicy?: EgressPolicy | null;
  /** Ngữ cảnh egress khi dùng `egressPolicy` (mặc định 'agent'). */
  egressContext?: EgressContext;
}

/**
 * Kiểm tra URL theo egress policy chung (P0-2): cùng một đích, cùng
 * một luật với shell trong box và daemon — allowlist theo team,
 * fail-closed, chặn LAN/localhost, phân loại lỗi egress. Ném
 * EgressError (kèm `kind`/`code`) khi chặn.
 */
export async function assertEgressUrl(
  raw: string | URL,
  policy: EgressPolicy | undefined | null,
  opts: SsrfCheckOptions = {},
): Promise<URL> {
  const url = raw instanceof URL ? raw : new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressError(
      'blocked',
      `Chỉ cho phép http:// và https://, nhận được "${url.protocol}"`,
      'egress_invalid_target',
    );
  }
  await checkEgress(url, policy, {
    context: opts.egressContext ?? 'agent',
    lookupFn: opts.lookupFn,
  });
  return url;
}

/**
 * Kiểm tra URL trỏ tới đích public. Trả về URL đã parse khi OK, ném lỗi
 * tiếng Việt rõ ràng khi bị chặn (kèm host/IP để log, không lộ body).
 *
 * P0-2: khi `opts.egressPolicy` được truyền (kể cả `null` = fail-closed
 * vì không có policy), kiểm tra đi qua egress policy chung
 * (`assertEgressUrl`) thay vì luật SSRF cũ.
 */
export async function assertPublicUrl(
  raw: string | URL,
  opts: SsrfCheckOptions = {},
): Promise<URL> {
  if (opts.egressPolicy !== undefined) {
    return assertEgressUrl(raw, opts.egressPolicy, opts);
  }
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new Error(`URL không hợp lệ: "${String(raw)}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Chỉ cho phép http:// và https://, nhận được "${url.protocol}"`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(
      `Chặn SSRF: "${url.hostname}" là host nội bộ (localhost) — http_get/web_fetch không được gọi service nội bộ.`,
    );
  }
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(
        `Chặn SSRF: "${url.hostname}" là IP nội bộ/riêng — http_get/web_fetch không được gọi service nội bộ.`,
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
      `Chặn SSRF: không resolve được "${url.hostname}" nên không xác minh được đích đến — không fetch.`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(`Chặn SSRF: "${url.hostname}" không resolve ra địa chỉ nào.`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `Chặn SSRF: "${url.hostname}" resolve ra IP nội bộ/riêng (${address}) — http_get/web_fetch không được gọi service nội bộ.`,
      );
    }
  }
  return url;
}

/**
 * fetch() có chặn SSRF + timeout + follow redirect thủ công (tối đa 5 hop,
 * mỗi hop kiểm tra lại). Dùng cho các tool fetch URL do agent/user đưa vào.
 * Trả về Response của hop cuối (chưa đọc body).
 */
export async function fetchPublic(
  raw: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
  opts: SsrfCheckOptions = {},
): Promise<Response> {
  let url = await assertPublicUrl(raw, opts);
  let redirects = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), { ...init, signal: controller.signal, redirect: 'manual' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      }
      // P0-2: đường egress-aware (có policy) phân loại lỗi fetch thành
      // kind egress `unreachable`, message đã khử URL. Đường cũ giữ
      // nguyên lỗi gốc để test cũ xanh.
      if (opts.egressPolicy !== undefined) throw classifyEgressFetchError(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    // Headers có thể không phải Headers thật (fetch bị mock trong test
    // trả object trơn): thiếu headers thì coi như không có redirect.
    const location = res.headers?.get?.('location') ?? null;
    if (res.status >= 300 && res.status < 400 && location && redirects < MAX_SSRF_REDIRECTS) {
      redirects += 1;
      // URL đích có thể là tương đối — resolve theo URL hiện tại rồi kiểm tra lại.
      url = await assertPublicUrl(new URL(location, url), opts);
      continue;
    }
    if (res.status >= 300 && res.status < 400 && location) {
      throw new Error(`Quá nhiều redirect (>${MAX_SSRF_REDIRECTS}) khi GET ${url}`);
    }
    return res;
  }
}
