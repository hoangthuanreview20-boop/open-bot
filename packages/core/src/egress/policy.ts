/**
 * Egress policy — kiểm tra đích mạng (P0-2, REA deep-dive lần 2 §10/§13).
 *
 * Lấy kiến trúc từ Grok Bot (egress tunnel + fail-closed + allowlist
 * theo team + IP allowlist cho GitHub checkout + phân loại lỗi), viết
 * lại hoàn toàn bằng code gốc. Không sao chép code/text/tài sản xAI.
 *
 * Thứ tự kiểm tra trong `checkEgress()` (fail-closed, rẻ trước đắt sau):
 *  1. Policy thiếu/tắt → `unconfigured` (không DNS, không fetch).
 *  2. Target parse lỗi / scheme không hỗ trợ → `blocked` (invalid target).
 *  3. Loopback/localhost → chỉ context `local-service` (+
 *     `allowLocalServices`) hoặc `allowPrivateDestinations` mới qua.
 *  4. IP literal → private thì chặn (trừ `allowPrivateDestinations`);
 *     public thì mode allowlist đòi nằm trong `allowIpRanges`.
 *  5. Hostname, mode allowlist → phải khớp `allowHosts`, nếu không thì
 *     chặn luôn (không resolve DNS — không rò rỉ đích ra ngoài).
 *  6. DNS resolve (chỉ khi đã qua bước 5 hoặc mode allow-public):
 *     mọi địa chỉ trả về đều phải public (trừ `allowPrivateDestinations`);
 *     context `github-checkout` + `githubEgressIps` có giá trị thì mọi
 *     địa chỉ phải nằm trong dải đó. DNS lỗi → `unreachable`;
 *     không ra địa chỉ nào → `invalid_response`.
 *
 * `checkEgressSync()` là bản đồng bộ (không DNS) cho đường không await
 * được (daemon flush fragment lúc đóng session): hostname ở mode
 * allow-public không xác minh được → `unreachable` khi failClosed.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  defaultEgressTelemetry,
  type EgressTelemetry,
} from './telemetry';
import type {
  EgressContext,
  EgressDecision,
  EgressErrorCode,
  EgressErrorKind,
  EgressPolicy,
  EgressTarget,
} from './types';
import { EgressError } from './types';

export type { EgressTarget };
export type { EgressContext, EgressDecision, EgressPolicy } from './types';
export { EgressError } from './types';

/** IP bị chặn: loopback, link-local, private, unspecified, CGNAT, TEST-NET, multicast, reserved. */
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

/** true khi IP là loopback (127/8, ::1) hoặc hostname là localhost. */
export function isLoopbackTarget(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (isIP(lower) === 4) {
    return lower.split('.')[0] === '127';
  }
  return lower === '::1';
}

// --- IP / CIDR ---------------------------------------------------------------

/** Parse một IP (v4/v6) thành BigInt + số bit (32/128). null khi không phải IP. */
function parseIpToBigInt(ip: string): { value: bigint; bits: number } | null {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    let value = 0n;
    for (const p of parts) value = (value << 8n) | BigInt(p);
    return { value, bits: 32 };
  }
  if (isIP(ip) === 6) {
    // Mở rộng '::' rồi parse từng nhóm 16-bit.
    const lower = ip.toLowerCase();
    const [head, tail] = lower.split('::');
    const headParts = head === '' ? [] : head.split(':');
    const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');
    if (lower.includes('::') && headParts.length + tailParts.length >= 8) return null;
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    const groups = [
      ...headParts,
      ...Array<string>(missing).fill('0'),
      ...tailParts,
    ];
    if (groups.length !== 8) return null;
    let value = 0n;
    for (const g of groups) {
      const n = Number.parseInt(g, 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
      value = (value << 16n) | BigInt(n);
    }
    return { value, bits: 128 };
  }
  return null;
}

/** Parse CIDR ('203.0.113.0/24', '2001:db8::/32') hoặc IP đơn thành { network, bits, prefix }. */
function parseCidr(entry: string): { network: bigint; bits: number; prefix: number } | null {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    const parsed = parseIpToBigInt(trimmed);
    if (parsed === null) return null;
    return { network: parsed.value, bits: parsed.bits, prefix: parsed.bits };
  }
  const addr = trimmed.slice(0, slash);
  const prefix = Number.parseInt(trimmed.slice(slash + 1), 10);
  const parsed = parseIpToBigInt(addr);
  if (parsed === null) return null;
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > parsed.bits) return null;
  const hostBits = BigInt(parsed.bits - prefix);
  const network = (parsed.value >> hostBits) << hostBits;
  return { network, bits: parsed.bits, prefix };
}

/** true khi `ip` nằm trong `entry` (IP đơn hoặc CIDR, v4/v6). Entry lỗi → false. */
export function ipInRange(ip: string, entry: string): boolean {
  const parsedIp = parseIpToBigInt(ip);
  const cidr = parseCidr(entry);
  if (parsedIp === null || cidr === null) return false;
  if (parsedIp.bits !== cidr.bits) return false;
  const hostBits = BigInt(cidr.bits - cidr.prefix);
  const network = (parsedIp.value >> hostBits) << hostBits;
  return network === cidr.network;
}

/** true khi `ip` nằm trong ít nhất một entry của `ranges`. */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  return ranges.some((entry) => ipInRange(ip, entry));
}

// --- Host matching -----------------------------------------------------------

/** Khớp host với một pattern allowlist: exact, hoặc `*.example.com` (subdomain, không khớp bare domain). */
export function matchAllowHost(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // '.example.com'
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

/** true khi `host` khớp ít nhất một pattern trong `allowHosts`. */
export function hostAllowlisted(host: string, allowHosts: readonly string[]): boolean {
  return allowHosts.some((pattern) => matchAllowHost(host, pattern));
}

// --- Policy ------------------------------------------------------------------

export const GITHUB_HOSTS = ['github.com', 'ssh.github.com'] as const;

/** Policy mặc định: fail-closed, mode allowlist rỗng (chặn mọi agent network), local-service loopback được phép. */
export function createDefaultEgressPolicy(): EgressPolicy {
  return {
    enabled: true,
    mode: 'allowlist',
    allowHosts: [],
    allowIpRanges: [],
    allowPrivateDestinations: false,
    allowLocalServices: true,
    githubEgressIps: [],
    failClosed: true,
  };
}

/**
 * Policy "allow-public": mọi host public được ra ngoài, chỉ chặn đích
 * private — cùng ngữ nghĩa với SSRF guard cũ (`packages/tools/src/ssrf.ts`).
 * Dùng khi host muốn nới lỏng từ fail-closed mặc định mà vẫn giữ chặn LAN.
 */
export function createAllowPublicEgressPolicy(): EgressPolicy {
  return { ...createDefaultEgressPolicy(), mode: 'allow-public' };
}

function normalizeStringList(raw: unknown, what: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new Error(`Invalid egress policy: "${what}" must be an array of non-empty strings`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw as string[]) {
    const normalized = v.trim().toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function normalizeBoolean(raw: unknown, what: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(`Invalid egress policy: "${what}" must be a boolean`);
  }
  return raw;
}

/**
 * Validate + chuẩn hoá một policy (từ file/JSON/RPC) và trả về bản đầy
 * đủ mặc định. Ném Error rõ ràng khi shape sai. Không mutate input.
 */
export function validateEgressPolicy(raw: unknown): EgressPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid egress policy: must be an object');
  }
  const rec = raw as Record<string, unknown>;
  if (rec['mode'] !== undefined && rec['mode'] !== 'allowlist' && rec['mode'] !== 'allow-public') {
    throw new Error('Invalid egress policy: "mode" must be "allowlist" or "allow-public"');
  }
  const allowHosts = normalizeStringList(rec['allowHosts'], 'allowHosts');
  for (const h of allowHosts) {
    if (h.includes('/') || h.includes(':') || h.includes(' ')) {
      throw new Error(`Invalid egress policy: allowHosts entry "${h}" must be a hostname or "*.domain"`);
    }
  }
  const allowIpRanges = normalizeStringList(rec['allowIpRanges'], 'allowIpRanges');
  for (const r of allowIpRanges) {
    if (parseCidr(r) === null) {
      throw new Error(`Invalid egress policy: allowIpRanges entry "${r}" must be an IP or CIDR`);
    }
  }
  const githubEgressIps = normalizeStringList(rec['githubEgressIps'], 'githubEgressIps');
  for (const r of githubEgressIps) {
    if (parseCidr(r) === null) {
      throw new Error(`Invalid egress policy: githubEgressIps entry "${r}" must be an IP or CIDR`);
    }
  }
  return {
    enabled: normalizeBoolean(rec['enabled'], 'enabled', true),
    mode: (rec['mode'] as EgressPolicy['mode']) ?? 'allowlist',
    allowHosts,
    allowIpRanges,
    allowPrivateDestinations: normalizeBoolean(rec['allowPrivateDestinations'], 'allowPrivateDestinations', false),
    allowLocalServices: normalizeBoolean(rec['allowLocalServices'], 'allowLocalServices', true),
    githubEgressIps,
    failClosed: normalizeBoolean(rec['failClosed'], 'failClosed', true),
  };
}

/** Merge policy team (override) lên trên policy chung: team có field nào thì thắng field đó. */
export function mergeEgressPolicies(base: EgressPolicy, override: EgressPolicy): EgressPolicy {
  const merged = validateEgressPolicy({ ...validateEgressPolicy(base), ...validateEgressPolicy(override) });
  // validateEgressPolicy đã điền mặc định cho field thiếu — merge thủ
  // công để field team không đặt thì giữ giá trị base, không rơi về mặc định.
  const b = validateEgressPolicy(base);
  const o = override;
  return {
    enabled: o.enabled ?? b.enabled,
    mode: o.mode ?? b.mode,
    allowHosts: o.allowHosts !== undefined ? [...o.allowHosts] : [...(b.allowHosts ?? [])],
    allowIpRanges: o.allowIpRanges !== undefined ? [...o.allowIpRanges] : [...(b.allowIpRanges ?? [])],
    allowPrivateDestinations: o.allowPrivateDestinations ?? b.allowPrivateDestinations,
    allowLocalServices: o.allowLocalServices ?? b.allowLocalServices,
    githubEgressIps: o.githubEgressIps !== undefined ? [...o.githubEgressIps] : [...(b.githubEgressIps ?? [])],
    failClosed: o.failClosed ?? b.failClosed,
  };
}

// --- Target parsing ----------------------------------------------------------

const URL_TARGET_RE = /\b(?:https?|ssh|git|ftp):\/\/[^\s'"<>`]+/g;
const GIT_SCP_RE = /\bgit@([A-Za-z0-9.-]+):[^\s'"<>`]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

/** Parse một target (URL string, host trần, hoặc EgressTarget) thành { host, scheme }. Ném EgressError khi không parse được. */
export function parseEgressTarget(target: string | URL | EgressTarget): EgressTarget {
  if (typeof target === 'object' && target !== null && !(target instanceof URL) && 'host' in target) {
    const host = String((target as EgressTarget).host ?? '').trim().toLowerCase();
    if (host === '') {
      throw new EgressError('blocked', 'Egress: đích trống, không kiểm tra được.', 'egress_invalid_target');
    }
    return { host, scheme: (target as EgressTarget).scheme, raw: (target as EgressTarget).raw };
  }
  const raw = target instanceof URL ? target.toString() : String(target);
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new EgressError('blocked', 'Egress: đích trống, không kiểm tra được.', 'egress_invalid_target');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new EgressError('blocked', 'Egress: URL đích không parse được, chặn.', 'egress_invalid_target');
    }
    if (url.hostname === '') {
      throw new EgressError('blocked', 'Egress: URL đích không có host, chặn.', 'egress_invalid_target');
    }
    // WHATWG URL giữ ngoặc vuông cho IPv6 ('[::1]') — bỏ ngoặc để
    // isIP/isPrivateIp/isLoopbackTarget nhận diện đúng.
    const rawHost = url.hostname.toLowerCase();
    const host =
      rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    return { host, scheme: url.protocol.replace(':', ''), raw: trimmed };
  }
  const scp = trimmed.match(/^git@([A-Za-z0-9.-]+):/);
  if (scp !== null) {
    return { host: (scp[1] as string).toLowerCase(), scheme: 'ssh', raw: trimmed };
  }
  // Host trần (không scheme): coi như hostname https. Dấu '/' hay khoảng
  // trắng thì không phải host hợp lệ → chặn.
  if (/[\s/:]/.test(trimmed)) {
    throw new EgressError('blocked', 'Egress: đích không phải host/URL hợp lệ, chặn.', 'egress_invalid_target');
  }
  return { host: trimmed.toLowerCase(), scheme: 'https', raw: trimmed };
}

/**
 * Trích các đích mạng từ một chuỗi lệnh shell (curl/wget/git clone/ssh/
 * URL trần...). Chỉ bắt URL có scheme rõ ràng + dạng git scp-like
 * (`git@host:path`) — `curl example.com` không scheme KHÔNG bị bắt
 * (giới hạn đã ghi trong docs/egress-policy.md; vẫn còn denylist +
 * approval chặn lệnh nguy hiểm). Trả về danh sách đã dedupe theo
 * scheme://host. Không thực thi gì, không resolve DNS.
 */
export function extractNetworkTargets(command: string): EgressTarget[] {
  const seen = new Set<string>();
  const out: EgressTarget[] = [];
  const push = (target: EgressTarget): void => {
    const key = `${target.scheme ?? ''}://${target.host}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(target);
  };
  for (const m of command.matchAll(URL_TARGET_RE)) {
    const cleaned = m[0].replace(TRAILING_PUNCT_RE, '');
    try {
      push(parseEgressTarget(cleaned));
    } catch {
      // URL bắt bằng regex nhưng parse lỗi → bỏ qua ở đây; lệnh vẫn
      // qua denylist, và phía thực thi sẽ lỗi rõ khi chạy.
    }
  }
  for (const m of command.matchAll(GIT_SCP_RE)) {
    push({ host: (m[1] as string).toLowerCase(), scheme: 'ssh', raw: m[0] });
  }
  return out;
}

// --- Checking ----------------------------------------------------------------

export interface CheckEgressOptions {
  /** Ngữ cảnh kiểm tra (mặc định 'agent'). */
  context?: EgressContext;
  /** Hàm resolve DNS (test inject fake; mặc định dns.lookup). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Telemetry ghi đếm (mặc định instance global; null = không ghi). */
  telemetry?: EgressTelemetry | null;
}

function resolvePolicy(policy: EgressPolicy | undefined | null): EgressPolicy {
  if (policy === undefined || policy === null) {
    throw new EgressError(
      'unconfigured',
      'Egress chưa cấu hình (egress_unconfigured): chưa có policy egress rõ ràng nên chặn. ' +
        'Cấu hình allowlist host/IP cho bot/team rồi thử lại.',
    );
  }
  const valid = validateEgressPolicy(policy);
  if (valid.enabled === false) {
    throw new EgressError(
      'unconfigured',
      'Egress chưa cấu hình (egress_unconfigured): policy egress đang tắt nên chặn. ' +
        'Bật policy rồi thử lại.',
    );
  }
  return valid;
}

function blocked(kind: EgressErrorKind, code: EgressErrorCode, message: string): EgressError {
  return new EgressError(kind, message, code);
}

/**
 * Kiểm tra một IP literal đã parse xong (bước chung cho checkEgress và
 * checkEgressSync). Ném EgressError khi bị chặn, trả về EgressDecision
 * khi qua. `isGithub` = context github-checkout (áp githubEgressIps).
 */
function checkLiteralIp(
  ip: string,
  policy: EgressPolicy,
  isGithub: boolean,
): EgressDecision {
  if (isPrivateIp(ip)) {
    if (policy.allowPrivateDestinations === true) {
      return { allowed: true, reason: 'private-allowed' };
    }
    throw blocked(
      'blocked',
      'egress_private_destination',
      `Egress chặn đích private (egress_private_destination): IP đích là địa chỉ nội bộ/riêng. ` +
        `Chỉ cho phép khi policy bật allowPrivateDestinations.`,
    );
  }
  if (isGithub && (policy.githubEgressIps?.length ?? 0) > 0) {
    if (ipInRanges(ip, policy.githubEgressIps ?? [])) {
      return { allowed: true, reason: 'github-egress-ip' };
    }
    throw blocked(
      'blocked',
      'egress_not_allowlisted',
      'Egress chặn GitHub checkout (egress_not_allowlisted): IP đích không nằm trong githubEgressIps của policy.',
    );
  }
  if (policy.mode === 'allowlist') {
    if (ipInRanges(ip, policy.allowIpRanges ?? [])) {
      return { allowed: true, reason: 'allowlisted-ip' };
    }
    throw blocked(
      'blocked',
      'egress_not_allowlisted',
      'Egress chặn đích ngoài allowlist (egress_not_allowlisted): IP đích không có trong allowIpRanges của policy.',
    );
  }
  return { allowed: true, reason: 'allow-public' };
}

/**
 * Kiểm tra một đích mạng theo policy. Trả về EgressDecision khi cho
 * qua, ném EgressError (kèm `kind`/`code`) khi chặn. Không ghi URL/path
 * vào telemetry hay message lỗi ngoài host.
 */
export async function checkEgress(
  target: string | URL | EgressTarget,
  policy: EgressPolicy | undefined | null,
  opts: CheckEgressOptions = {},
): Promise<EgressDecision> {
  const context = opts.context ?? 'agent';
  const telemetry = opts.telemetry === undefined ? defaultEgressTelemetry : opts.telemetry;
  try {
    const decision = await checkEgressInner(target, policy, context, opts.lookupFn);
    telemetry?.record('allowed', context);
    return decision;
  } catch (err) {
    if (err instanceof EgressError) {
      telemetry?.record(err.kind, context);
    }
    throw err;
  }
}

async function checkEgressInner(
  target: string | URL | EgressTarget,
  policyInput: EgressPolicy | undefined | null,
  context: EgressContext,
  lookupFn?: CheckEgressOptions['lookupFn'],
): Promise<EgressDecision> {
  const policy = resolvePolicy(policyInput);
  const parsed = parseEgressTarget(target);
  const host = parsed.host;
  const isGithub = context === 'github-checkout';

  // Loopback / localhost: chỉ local-service (allowLocalServices) hoặc
  // allowPrivateDestinations mới qua. Agent gọi 127.0.0.1 vẫn chặn.
  if (isLoopbackTarget(host)) {
    if (context === 'local-service' && policy.allowLocalServices !== false) {
      return { allowed: true, reason: 'local-service' };
    }
    if (policy.allowPrivateDestinations === true) {
      return { allowed: true, reason: 'private-allowed' };
    }
    throw blocked(
      'blocked',
      'egress_loopback_blocked',
      `Egress chặn localhost/loopback (egress_loopback_blocked): host "${host}" là đích nội bộ. ` +
        `Agent không được gọi service nội bộ; chỉ local-service (vd Ollama 127.0.0.1) mới được phép.`,
    );
  }

  // IP literal: kiểm tra trực tiếp, không cần DNS.
  if (isIP(host) !== 0) {
    return checkLiteralIp(host, policy, isGithub);
  }

  // Hostname, mode allowlist: phải khớp allowHosts trước khi resolve
  // DNS — ngoài allowlist thì chặn luôn, không rò rỉ đích ra ngoài.
  if (policy.mode === 'allowlist') {
    const inAllowHosts = hostAllowlisted(host, policy.allowHosts ?? []);
    const isGithubHost = (GITHUB_HOSTS as readonly string[]).includes(host);
    if (!inAllowHosts) {
      // GitHub checkout: githubEgressIps là allowlist theo IP — host
      // github.com vẫn phải qua bước DNS bên dưới để kiểm tra IP, nên
      // không chặn sớm khi context github-checkout và có githubEgressIps.
      if (!(isGithub && isGithubHost && (policy.githubEgressIps?.length ?? 0) > 0)) {
        throw blocked(
          'blocked',
          'egress_not_allowlisted',
          `Egress chặn đích ngoài allowlist (egress_not_allowlisted): host "${host}" không có trong allowHosts của policy.`,
        );
      }
    }
    if (inAllowHosts && !isGithub) {
      return checkResolvedAddresses(host, policy, false, lookupFn);
    }
    if (isGithub && isGithubHost) {
      return checkResolvedAddresses(host, policy, true, lookupFn);
    }
    // inAllowHosts && isGithub nhưng host không phải github.com (vd
    // allowHosts có 'example.com' mà context là github-checkout):
    // rơi xuống kiểm tra DNS thường.
    return checkResolvedAddresses(host, policy, false, lookupFn);
  }

  // Mode allow-public: resolve DNS, mọi địa chỉ đều phải public.
  return checkResolvedAddresses(host, policy, isGithub, lookupFn);
}

async function checkResolvedAddresses(
  host: string,
  policy: EgressPolicy,
  isGithub: boolean,
  lookupFn?: CheckEgressOptions['lookupFn'],
): Promise<EgressDecision> {
  const resolve =
    lookupFn ??
    (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(host);
  } catch {
    if (policy.failClosed !== false) {
      throw blocked(
        'unreachable',
        'egress_unreachable',
        `Egress không xác minh được đích (egress_unreachable): không resolve được host "${host}" nên không fetch/kết nối.`,
      );
    }
    return { allowed: true, reason: 'unverified-public' };
  }
  if (addresses.length === 0) {
    throw blocked(
      'invalid_response',
      'egress_invalid_response',
      `Egress chặn đích (egress_invalid_response): host "${host}" không resolve ra địa chỉ nào.`,
    );
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      if (policy.allowPrivateDestinations === true) continue;
      throw blocked(
        'blocked',
        'egress_private_destination',
        `Egress chặn đích private (egress_private_destination): host "${host}" resolve ra IP nội bộ/riêng.`,
      );
    }
    if (isGithub && (policy.githubEgressIps?.length ?? 0) > 0) {
      if (!ipInRanges(address, policy.githubEgressIps ?? [])) {
        throw blocked(
          'blocked',
          'egress_not_allowlisted',
          'Egress chặn GitHub checkout (egress_not_allowlisted): IP mà github.com resolve ra không nằm trong githubEgressIps của policy.',
        );
      }
    }
  }
  if (isGithub && (policy.githubEgressIps?.length ?? 0) > 0) {
    return { allowed: true, reason: 'github-egress-ip' };
  }
  return { allowed: true, reason: policy.mode === 'allowlist' ? 'allowlisted-host' : 'allow-public' };
}

/**
 * Bản đồng bộ của `checkEgress` (không DNS) cho đường không await được
 * (daemon flush fragment lúc đóng session). Quy tắc:
 *  - Loopback / IP literal: kiểm tra đầy đủ như bản async.
 *  - Hostname, mode allowlist: phải khớp allowHosts, nếu không chặn
 *    (không cần DNS). Khớp rồi thì cho qua mà KHÔNG xác minh DNS
 *    (giới hạn đã ghi: DNS rebinding không bị bắt ở đường này).
 *  - Hostname, mode allow-public: không xác minh được → `unreachable`
 *    khi failClosed, cho qua khi failClosed=false.
 *  - github-checkout + githubEgressIps có giá trị: không xác minh được
 *    IP → `unreachable` khi failClosed.
 */
export function checkEgressSync(
  target: string | URL | EgressTarget,
  policyInput: EgressPolicy | undefined | null,
  opts: { context?: EgressContext; telemetry?: EgressTelemetry | null } = {},
): EgressDecision {
  const context = opts.context ?? 'agent';
  const telemetry = opts.telemetry === undefined ? defaultEgressTelemetry : opts.telemetry;
  try {
    const decision = checkEgressSyncInner(target, policyInput, context);
    telemetry?.record('allowed', context);
    return decision;
  } catch (err) {
    if (err instanceof EgressError) {
      telemetry?.record(err.kind, context);
    }
    throw err;
  }
}

function checkEgressSyncInner(
  target: string | URL | EgressTarget,
  policyInput: EgressPolicy | undefined | null,
  context: EgressContext,
): EgressDecision {
  const policy = resolvePolicy(policyInput);
  const parsed = parseEgressTarget(target);
  const host = parsed.host;
  const isGithub = context === 'github-checkout';

  if (isLoopbackTarget(host)) {
    if (context === 'local-service' && policy.allowLocalServices !== false) {
      return { allowed: true, reason: 'local-service' };
    }
    if (policy.allowPrivateDestinations === true) {
      return { allowed: true, reason: 'private-allowed' };
    }
    throw blocked(
      'blocked',
      'egress_loopback_blocked',
      `Egress chặn localhost/loopback (egress_loopback_blocked): host "${host}" là đích nội bộ.`,
    );
  }
  if (isIP(host) !== 0) {
    return checkLiteralIp(host, policy, isGithub);
  }
  if (policy.mode === 'allowlist') {
    const isGithubHost = (GITHUB_HOSTS as readonly string[]).includes(host);
    if (isGithub && isGithubHost && (policy.githubEgressIps?.length ?? 0) > 0) {
      // Không DNS ở đường sync → không xác minh được IP egress.
      if (policy.failClosed !== false) {
        throw blocked(
          'unreachable',
          'egress_unreachable',
          `Egress không xác minh được đích (egress_unreachable): không kiểm tra được IP của host "${host}" ở đường đồng bộ.`,
        );
      }
      return { allowed: true, reason: 'unverified-public' };
    }
    if (hostAllowlisted(host, policy.allowHosts ?? [])) {
      return { allowed: true, reason: 'allowlisted-host' };
    }
    throw blocked(
      'blocked',
      'egress_not_allowlisted',
      `Egress chặn đích ngoài allowlist (egress_not_allowlisted): host "${host}" không có trong allowHosts của policy.`,
    );
  }
  // Mode allow-public, không DNS → không xác minh được.
  if (policy.failClosed !== false) {
    throw blocked(
      'unreachable',
      'egress_unreachable',
      `Egress không xác minh được đích (egress_unreachable): không kiểm tra được host "${host}" ở đường đồng bộ.`,
    );
  }
  return { allowed: true, reason: 'unverified-public' };
}

/**
 * Kiểm tra checkout từ GitHub (git clone/fetch/pull) theo policy:
 * host phải là github.com/ssh.github.com, IP resolve ra phải nằm trong
 * `githubEgressIps` khi danh sách này có giá trị. Dùng cho git trong
 * box — xem docs/egress-policy.md.
 */
export async function checkGithubCheckout(
  target: string | URL | EgressTarget,
  policy: EgressPolicy | undefined | null,
  opts: CheckEgressOptions = {},
): Promise<EgressDecision> {
  return checkEgress(target, policy, { ...opts, context: 'github-checkout' });
}

/**
 * Phân loại lỗi fetch thành kind egress (dùng cho fetchPublic khi đi
 * qua policy): AbortError/timeout giữ nguyên message cũ của caller;
 * lỗi mạng khác → `unreachable` với message đã khử URL (không rò rỉ
 * đích vào log).
 */
export function classifyEgressFetchError(err: unknown): EgressError {
  if (err instanceof EgressError) return err;
  const e = err as Error;
  if (e?.name === 'AbortError') {
    return new EgressError('unreachable', 'Egress: request bị hủy/timeout (egress_unreachable).');
  }
  return new EgressError(
    'unreachable',
    'Egress không kết nối được tới đích (egress_unreachable): lỗi mạng khi fetch.',
  );
}
