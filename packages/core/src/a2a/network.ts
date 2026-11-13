/**
 * A2A network policy (v0.97, Đội T2) — loopback mặc định, expose ngoài
 * chỉ khi user bật tường minh.
 *
 * Nguyên tắc đứng của open-bot: local-first, miễn phí, không expose
 * agent ra mạng ngoài nếu user không yêu cầu. Mọi A2A server/client
 * trong app đều đi qua policy này:
 *  - Mặc định: chỉ bind 127.0.0.1, chỉ gọi URL loopback.
 *  - Muốn bind 0.0.0.0 / gọi agent ở host khác: user phải bật
 *    `allowExternal` TRONG Settings VÀ xác nhận đã đọc cảnh báo
 *    (`warningAcknowledged: true`). Một cờ duy nhất không đủ — cần
 *    cả hai, để không ai bật nhầm bằng một cú click.
 *  - Client/delegation gọi URL ngoài khi policy chưa cho phép thì
 *    bị chặn ngay ở đây (fail fast, lỗi rõ ràng), không đợi tới
 *    lúc fetch mới timeout.
 *
 * Chỉ dùng Node stdlib, không gọi mạng ở đây.
 */

/** Host loopback hợp lệ (IPv4 + IPv6 + tên localhost). */
export const A2A_LOOPBACK_HOSTS: readonly string[] = [
  '127.0.0.1',
  '::1',
  '[::1]',
  'localhost',
];

/** Host được phép bind khi expose ngoài (mọi interface). */
export const A2A_EXTERNAL_BIND_HOST = '0.0.0.0';

/** Host bind mặc định — luôn loopback. */
export const A2A_DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Policy mạng A2A của app — lưu trong userData
 * (`a2a-network-policy.json`), mặc định cả hai cờ đều false.
 */
export interface A2aNetworkPolicy {
  /**
   * true → cho phép A2A server bind 0.0.0.0 và client gọi agent ở
   * host ngoài loopback. Mặc định false.
   */
  allowExternal: boolean;
  /**
   * true → user đã đọc cảnh báo expose ngoài trong Settings và vẫn
   * đồng ý. Chỉ có ý nghĩa khi `allowExternal` cũng true.
   */
  warningAcknowledged: boolean;
}

/** Policy mặc định: loopback-only, không expose ngoài. */
export const A2A_DEFAULT_NETWORK_POLICY: A2aNetworkPolicy = {
  allowExternal: false,
  warningAcknowledged: false,
};

/**
 * Chuẩn hoá policy đọc từ file/Settings: thiếu field → false,
 * kiểu sai → false (không bao giờ mặc định cho phép expose ngoài
 * vì dữ liệu hỏng).
 */
export function normalizeA2aNetworkPolicy(value: unknown): A2aNetworkPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...A2A_DEFAULT_NETWORK_POLICY };
  }
  const rec = value as Record<string, unknown>;
  return {
    allowExternal: rec['allowExternal'] === true,
    warningAcknowledged: rec['warningAcknowledged'] === true,
  };
}

/** true khi policy cho phép expose ngoài (cần CẢ hai cờ). */
export function isA2aExternalAllowed(policy: A2aNetworkPolicy | undefined | null): boolean {
  if (!policy) return false;
  return policy.allowExternal === true && policy.warningAcknowledged === true;
}

/**
 * Host có phải loopback không. Chấp nhận 127.0.0.0/8 (127.x.y.z),
 * ::1 và localhost (kể cả localhost. và chữ hoa). Host rỗng hoặc
 * lạ → false (fail closed).
 */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  if (h.length === 0) return false;
  if (h === 'localhost' || h === 'localhost.') return true;
  if (h === '::1' || h === '[::1]') return true;
  // 127.0.0.0/8: mọi địa chỉ 127.* đều là loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    return parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  }
  return false;
}

/**
 * URL có trỏ về loopback không. URL hỏng / thiếu host / scheme
 * không phải http(s) → false (fail closed — client không gọi).
 */
export function isLoopbackUrl(url: string | undefined | null): boolean {
  if (typeof url !== 'string' || url.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHost(parsed.hostname);
}

/**
 * Host mà A2A HTTP server được phép bind theo policy.
 * Mặc định '127.0.0.1'; chỉ trả '0.0.0.0' khi user đã bật expose
 * ngoài VÀ xác nhận cảnh báo. Caller KHÔNG tự truyền host khác.
 */
export function resolveA2aBindHost(policy: A2aNetworkPolicy | undefined | null): string {
  return isA2aExternalAllowed(policy) ? A2A_EXTERNAL_BIND_HOST : A2A_DEFAULT_BIND_HOST;
}

/**
 * Kiểm tra một URL đích có được phép gọi theo policy không.
 * Trả `{ allowed: true }` khi URL loopback, hoặc khi policy cho
 * phép ngoài và URL hợp lệ http(s). Ngược lại trả `{ allowed:
 * false, reason }` — caller biến reason thành lỗi rõ ràng cho
 * user (không fetch thử, không rò rỉ URL ra log mạng).
 */
export function checkA2aUrlAllowed(
  url: string,
  policy: A2aNetworkPolicy | undefined | null,
): { allowed: boolean; reason?: string } {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { allowed: false, reason: 'URL agent trống.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `URL agent không hợp lệ: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `A2A chỉ gọi http(s), không gọi scheme "${parsed.protocol}".`,
    };
  }
  if (isLoopbackHost(parsed.hostname)) return { allowed: true };
  if (isA2aExternalAllowed(policy)) return { allowed: true };
  return {
    allowed: false,
    reason:
      `Agent ở host ngoài loopback (${parsed.hostname}) bị chặn: open-bot mặc định chỉ gọi agent trên máy này. ` +
      'Muốn gọi agent ngoài, bật "Cho phép agent ngoài mạng" trong Settings → A2A và xác nhận cảnh báo.',
  };
}

/**
 * Chặn URL ngoài loopback trừ khi policy cho phép — dùng trong
 * client/delegation trước mỗi fetch. Throw `Error` với lý do rõ
 * ràng khi bị chặn.
 */
export function assertA2aUrlAllowed(
  url: string,
  policy: A2aNetworkPolicy | undefined | null,
): void {
  const check = checkA2aUrlAllowed(url, policy);
  if (!check.allowed) {
    throw new Error(check.reason ?? 'URL agent không được phép theo policy mạng A2A.');
  }
}

/**
 * Cảnh báo expose ngoài hiển thị trong Settings (renderer lấy qua
 * i18n key `a2a.networkExternalWarning`; hàm này chỉ để test và
 * log server-side dùng cùng một câu chữ).
 */
export function a2aExternalWarningText(): string {
  return (
    'Exposing the A2A server outside this machine (0.0.0.0) lets any device ' +
    'on the network reach this agent. Only enable it on a network you trust, ' +
    'and keep the A2A token secret.'
  );
}
