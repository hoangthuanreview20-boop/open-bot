/**
 * Egress control — types (P0-2, REA deep-dive lần 2 §10/§13).
 *
 * Kiến trúc lấy từ Grok Bot (chỉ học ý tưởng, viết lại bằng code gốc):
 * mọi traffic ra ngoài của session box / agent đi qua một "egress
 * tunnel" có kiểm soát — allowlist host/IP theo team, chặn đích
 * private (LAN) trừ khi cho phép tường minh, fail-closed khi chưa
 * cấu hình, telemetry đã ẩn danh, lỗi egress phân loại rõ ràng.
 *
 * Nguyên tắc fail-closed:
 *  - Không có policy (undefined/null) hoặc policy bị tắt → chặn với
 *    kind `unconfigured`. Không có chuyện "chưa cấu hình thì cho qua".
 *  - Mode mặc định là `allowlist`: host/IP không có trong allowlist
 *    → chặn (`blocked`), không cần resolve DNS (không rò rỉ đích).
 *  - Lỗi không xác minh được đích (DNS lỗi, không resolve ra địa chỉ)
 *    → chặn (`unreachable` / `invalid_response`) khi `failClosed`
 *    (mặc định true). `failClosed: false` chỉ nới lỏng đúng trường hợp
 *    "không xác minh được" — thiếu policy vẫn luôn chặn.
 *
 * Loopback / localhost — trường hợp cần cho phép rõ ràng:
 *  - Provider local (Ollama 127.0.0.1:11434, mock provider) và Local
 *    API chạy trên chính máy này. Chúng đi qua context
 *    `local-service` và được phép khi `allowLocalServices: true`
 *    (mặc định true trong policy mặc định) — KHÔNG cần có trong
 *    allowlist. Agent (context `agent`) gọi 127.0.0.1/localhost vẫn bị
 *    chặn trừ khi `allowPrivateDestinations: true`.
 *  - Đây là quyết định có chủ ý, ghi rõ ở đây: loopback không phải là
 *    "public", nó chỉ được phép cho mục đích local-service đã khai báo.
 *
 * KHÔNG ghi URL/path/secret vào telemetry hay message lỗi chi tiết:
 * message lỗi chỉ nêu host (đã là phần cần thiết để user sửa
 * allowlist) — không bao giờ nêu path, query hay body.
 */

export type EgressMode = 'allowlist' | 'allow-public';

/**
 * Ngữ cảnh của một lần kiểm tra egress — cùng một đích có thể được
 * phép hay bị chặn tùy ngữ cảnh:
 *  - `agent`: agent/shell trong box gọi ra ngoài (chặt nhất).
 *  - `local-service`: provider local / mock / Local API trên máy này
 *    (loopback được phép khi `allowLocalServices`).
 *  - `github-checkout`: git checkout/clone từ GitHub — kiểm tra thêm
 *    `githubEgressIps` khi có.
 */
export type EgressContext = 'agent' | 'local-service' | 'github-checkout';

/**
 * Phân loại lỗi egress (lấy tên từ Grok Bot, viết lại bằng code gốc):
 *  - `unconfigured`: chưa có policy rõ ràng (thiếu policy / policy tắt).
 *  - `unreachable`: không kết nối/xác minh được đích (DNS lỗi, fetch lỗi mạng).
 *  - `invalid_response`: đích trả về thứ không dùng được (DNS không
 *    resolve ra địa chỉ nào, redirect Location không parse được).
 *  - `blocked`: đích bị policy chặn (đích private, loopback, ngoài allowlist).
 */
export type EgressErrorKind =
  | 'unconfigured'
  | 'unreachable'
  | 'invalid_response'
  | 'blocked';

/** Mã lỗi dạng chuỗi, ổn định để caller/test đối chiếu (giống `egress_*` của Grok). */
export type EgressErrorCode =
  | 'egress_unconfigured'
  | 'egress_unreachable'
  | 'egress_invalid_response'
  | 'egress_blocked'
  | 'egress_private_destination'
  | 'egress_not_allowlisted'
  | 'egress_loopback_blocked'
  | 'egress_invalid_target';

export const EGRESS_ERROR_CODE_BY_KIND: Record<EgressErrorKind, EgressErrorCode> = {
  unconfigured: 'egress_unconfigured',
  unreachable: 'egress_unreachable',
  invalid_response: 'egress_invalid_response',
  blocked: 'egress_blocked',
};

/** Lỗi egress: Error thường kèm `kind` + `code` để caller phân loại mà không parse message. */
export class EgressError extends Error {
  readonly kind: EgressErrorKind;
  readonly code: EgressErrorCode;
  constructor(kind: EgressErrorKind, message: string, code?: EgressErrorCode) {
    super(message);
    this.name = 'EgressError';
    this.kind = kind;
    this.code = code ?? EGRESS_ERROR_CODE_BY_KIND[kind];
  }
}

/**
 * Policy egress cho một bot / team / daemon. Mọi field đều optional —
 * `validateEgressPolicy()` điền mặc định và chuẩn hoá.
 *
 * JSON-serializable hoàn toàn (đi qua NDJSON-RPC tới daemon, lưu trong
 * team.json) — không chứa function, RegExp hay secret.
 */
export interface EgressPolicy {
  /** false = policy tắt → mọi kiểm tra fail-closed với `unconfigured`. Mặc định true. */
  enabled?: boolean;
  /**
   * `allowlist` (mặc định): chỉ host/IP trong allowlist được ra ngoài.
   * `allow-public`: mọi host public được ra ngoài, chỉ chặn đích
   * private — cùng ngữ nghĩa với SSRF guard cũ (`ssrf.ts`).
   */
  mode?: EgressMode;
  /**
   * Host được phép (mode `allowlist`). Mỗi entry là host exact
   * (`api.example.com`) hoặc wildcard một cấp (`*.example.com` — khớp
   * subdomain, KHÔNG khớp chính `example.com`). So khớp không phân
   * biệt hoa/thường.
   */
  allowHosts?: string[];
  /**
   * IP/dải IP được phép (mode `allowlist`). Mỗi entry là IP đơn
   * (`203.0.113.10`) hoặc CIDR (`203.0.113.0/24`, hỗ trợ cả IPv6).
   */
  allowIpRanges?: string[];
  /** Cho phép đích private (LAN, localhost, link-local, metadata). Mặc định false. */
  allowPrivateDestinations?: boolean;
  /**
   * Cho phép loopback/localhost KHI context là `local-service`
   * (Ollama/mock provider/Local API). Mặc định true. Không ảnh hưởng
   * context `agent` — agent gọi 127.0.0.1 vẫn bị chặn trừ khi
   * `allowPrivateDestinations: true`.
   */
  allowLocalServices?: boolean;
  /**
   * IP/dải IP của egress tunnel được phép checkout từ GitHub (Grok:
   * org GitHub phải allowlist IP của egress tunnel). Khi có, context
   * `github-checkout` yêu cầu mọi IP mà github.com resolve ra đều nằm
   * trong danh sách này. Khi rỗng, checkout dùng luật allowHosts
   * thường (github.com phải có trong allowHosts ở mode allowlist).
   */
  githubEgressIps?: string[];
  /**
   * Fail-closed (mặc định true): đích không xác minh được (DNS lỗi,
   * không resolve ra địa chỉ) thì chặn. `false` chỉ nới đúng trường
   * hợp này; thiếu policy vẫn luôn chặn.
   */
  failClosed?: boolean;
}

/** Một đích mạng cần kiểm tra (URL, host, hoặc đích git/ssh). */
export interface EgressTarget {
  /** Hostname hoặc IP literal (đã lowercase, không kèm port). */
  host: string;
  /** Scheme gốc: 'http' | 'https' | 'ssh' | 'git' | ... */
  scheme?: string;
  /** Chuỗi gốc đã trích ra (chỉ để debug; KHÔNG ghi vào telemetry). */
  raw?: string;
}

/** Kết quả kiểm tra egress thành công (được phép). */
export interface EgressDecision {
  allowed: true;
  /** Lý do ngắn, ổn định: 'allowlisted-host' | 'allowlisted-ip' |
   *  'allow-public' | 'local-service' | 'github-egress-ip' |
   *  'private-allowed' | 'unverified-public'. */
  reason: string;
}
