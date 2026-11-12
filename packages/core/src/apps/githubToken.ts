/**
 * v0.69a — xác thực PAT GitHub lúc kết nối (trước khi lưu vào Vault).
 *
 * Vấn đề (v0.68b): IPC `apps:set-token` chỉ kiểm tra PAT ≤500 ký tự
 * rồi lưu thẳng vào Vault; trạng thái app cũng chỉ kiểm tra token có
 * tồn tại trong Vault hay không. PAT sai/hết hạn/bị thu hồi chỉ lộ ra
 * khi bot gọi tool GitHub rồi nhận lỗi API — user tưởng đã kết nối
 * xong nhưng thật ra chưa.
 *
 * Hàm thuần trong file này gọi GET https://api.github.com/user với
 * PAT (endpoint nhẹ nhất chứng minh token còn sống + trả về login
 * của tài khoản). `fetchFn` inject được nên test dùng mock, không
 * bao giờ gọi api.github.com thật trong test.
 *
 * v0.71: riêng tiến trình Electron (main/coordinator) không inject
 * được `fetchFn` từ bên ngoài nên base URL đọc từ env
 * `OPENBOT_GITHUB_API_BASE` (xem `githubPatApiBase`) — test E2E trỏ
 * app tới mock server local; production không set env này thì vẫn
 * gọi https://api.github.com như cũ.
 *
 * An toàn secret: token chỉ xuất hiện trong header Authorization của
 * đúng một request tới api.github.com; KHÔNG BAO GIỜ log token, và
 * KHÔNG BAO GIỜ đưa token vào error message hay kết quả trả về (kết
 * quả chỉ có ok/reason/login — login là tên tài khoản public, không
 * phải secret).
 */

import { withTimeout } from '../providers/abort';

/** Endpoint xác thực PAT: nhẹ, chỉ cần token còn sống là trả 200 + login. */
export const GITHUB_PAT_VALIDATE_URL = 'https://api.github.com/user';

/**
 * v0.71: base URL của GitHub API cho bước xác thực PAT.
 *
 * Mặc định `https://api.github.com`. Env `OPENBOT_GITHUB_API_BASE`
 * chỉ để test E2E trỏ app tới mock server local (vd
 * `http://127.0.0.1:PORT`) — production không set env này thì không
 * đổi gì. Đọc lúc gọi (không cache lúc load module) để tiến trình
 * main/coordinator nhận env khi khởi động; chỉ trim + bỏ `/` cuối,
 * không sửa gì khác. Giá trị env không bao giờ được log.
 */
export function githubPatApiBase(): string {
  const raw =
    typeof process !== 'undefined' && process.env
      ? process.env.OPENBOT_GITHUB_API_BASE
      : undefined;
  const base = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  return base || 'https://api.github.com';
}

/** Timeout mặc định cho một lần xác thực PAT (10s — đủ cho mạng chậm, không treo UI). */
export const DEFAULT_GITHUB_PAT_TIMEOUT_MS = 10_000;

/**
 * Fetch tối thiểu mà `validateGithubPat` cần — khớp `FetchFn` của
 * connectors/framework.ts và `Response` của global fetch (chỉ cần
 * ok/status/headers/json/text). Header đọc được cả dạng `Headers`
 * (`.get`) lẫn plain object.
 */
export type GithubPatFetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | Record<string, string | string[] | undefined>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Kết quả xác thực PAT:
 *  - `{ ok: true, login? }`: token còn sống; login là tên tài khoản
 *    GitHub (undefined khi body 200 không parse được — status 200 đã
 *    đủ chứng minh token sống).
 *  - `invalid`: 401 hoặc token rỗng — PAT sai/hết hạn/bị thu hồi.
 *  - `forbidden`: 403 — GitHub từ chối token; `rateLimited: true`
 *    khi header X-RateLimit-Remaining là '0' (hết giới hạn gọi API,
 *    khác với token bị thu hồi).
 *  - `network`: lỗi mạng/timeout/status lạ — chưa kiểm tra được, nên
 *    thử lại sau thay vì kết luận token sai.
 */
export type GithubPatValidation =
  | { ok: true; login?: string }
  | { ok: false; reason: 'invalid' | 'network' }
  | { ok: false; reason: 'forbidden'; rateLimited?: boolean };

export interface ValidateGithubPatOptions {
  /** Fetch injectable (test dùng mock). Mặc định global fetch. */
  fetchFn?: GithubPatFetchFn;
  /** Timeout (ms) cho một lần xác thực. Mặc định 10s; ≤0 thì dùng mặc định. */
  timeoutMs?: number;
}

/** Đọc một header, chấp nhận cả `Headers` (.get) lẫn plain object (không phân biệt hoa/thường). */
function readHeader(
  headers: { get(name: string): string | null } | Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    try {
      return (headers as { get(name: string): string | null }).get(name);
    } catch {
      return null;
    }
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * Xác thực một PAT GitHub bằng GET /user.
 *
 *  - 200 → `{ ok: true, login? }` (login lấy từ body, thiếu thì thôi).
 *  - 401 → `{ ok: false, reason: 'invalid' }`.
 *  - 403 → `{ ok: false, reason: 'forbidden', rateLimited? }`.
 *  - Lỗi mạng / timeout / status khác → `{ ok: false, reason: 'network' }`.
 *  - Token rỗng → `{ ok: false, reason: 'invalid' }` mà không gọi mạng.
 *
 * Timeout hủy request thật: signal từ `withTimeout` (pattern của
 * providers/abort.ts) được truyền xuống fetch, đồng thời `Promise.race`
 * với cùng signal để fetch nào bỏ qua signal cũng không treo quá
 * timeout. Không bao giờ ném lỗi — mọi thất bại đều mã hoá trong kết
 * quả, caller tự quyết định thông điệp hiển thị.
 */
export async function validateGithubPat(
  token: string,
  opts: ValidateGithubPatOptions = {},
): Promise<GithubPatValidation> {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) return { ok: false, reason: 'invalid' };
  const timeoutMs =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_GITHUB_PAT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as GithubPatFetchFn);

  const { signal, dispose } = withTimeout(undefined, timeoutMs);
  // Race với chính signal timeout: fetch thật (global fetch) đã hủy
  // qua signal; fetch nào bỏ qua signal thì race này vẫn kết thúc
  // đúng hạn thay vì treo. Reject sau khi fetch thắng thì vô hại.
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Hết thời gian chờ xác thực PAT GitHub.');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    onAbort = () => {
      const err = new Error('Hết thời gian chờ xác thực PAT GitHub.');
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    const res = await Promise.race([
      fetchFn(`${githubPatApiBase()}/user`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmed}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'open-bot',
        },
        ...(signal ? { signal } : {}),
      }),
      timeoutPromise,
    ]);
    if (res.status === 200) {
      let login: string | undefined;
      try {
        const body = await res.json();
        if (body !== null && typeof body === 'object') {
          const maybeLogin = (body as { login?: unknown }).login;
          if (typeof maybeLogin === 'string' && maybeLogin) login = maybeLogin;
        }
      } catch {
        // Body 200 parse hỏng vẫn tính là token sống — status 200 đã đủ.
      }
      return login !== undefined ? { ok: true, login } : { ok: true };
    }
    if (res.status === 401) return { ok: false, reason: 'invalid' };
    if (res.status === 403) {
      const remaining = readHeader(res.headers, 'x-ratelimit-remaining');
      return remaining === '0'
        ? { ok: false, reason: 'forbidden', rateLimited: true }
        : { ok: false, reason: 'forbidden' };
    }
    // Status lạ (5xx, 404...) không chứng minh được token sai — coi
    // như chưa kiểm tra được, để user thử lại sau.
    return { ok: false, reason: 'network' };
  } catch {
    // Lỗi mạng, timeout (AbortError) hay fetchFn ném gì cũng về
    // 'network'. Không đưa chi tiết lỗi vào kết quả: lỗi có thể chứa
    // URL/header mà caller không kiểm soát được.
    return { ok: false, reason: 'network' };
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    dispose();
  }
}

/**
 * Thông điệp tiếng Việt cho user khi xác thực PAT thất bại (hiện qua
 * kênh `appTokenError` đã có của renderer — không cần key i18n mới).
 * Không bao giờ chứa token.
 */
export function githubPatValidationErrorMessage(
  result: Extract<GithubPatValidation, { ok: false }>,
): string {
  if (result.reason === 'invalid') {
    return 'PAT không đúng hoặc đã hết hạn — kiểm tra lại token ở github.com → Settings → Developer settings';
  }
  if (result.reason === 'forbidden') {
    return result.rateLimited
      ? 'GitHub từ chối token vì đã hết giới hạn gọi API (rate limit) — thử lại sau ít phút'
      : 'GitHub từ chối token (có thể hết hạn, bị thu hồi hoặc hết giới hạn gọi API)';
  }
  return 'Không kiểm tra được PAT (lỗi mạng/timeout) — thử lại sau';
}

export interface SaveValidatedGithubPatOptions {
  /** PAT user vừa dán (đã trim ở main qua requireString; đây trim lại cho chắc). */
  token: string;
  /** Fetch injectable cho bước validate (test dùng mock). */
  fetchFn?: GithubPatFetchFn;
  /** Timeout (ms) cho bước validate. Mặc định 10s. */
  timeoutMs?: number;
  /** Ghi token đã xác thực (vd Vault). CHỈ gọi khi validate ok. */
  save: (token: string) => void | Promise<void>;
  /**
   * Seed token cho coordinator sau khi lưu — best-effort như main cũ
   * (lỗi seed không làm hỏng lần lưu, được nuốt lặng). Nhận thêm
   * login để main seed luôn nhãn tài khoản cho UI.
   */
  onSaved?: (token: string, login?: string) => void | Promise<void>;
}

/**
 * Xác thực PAT rồi mới lưu: validate fail thì ném Error (thông điệp
 * tiếng Việt từ `githubPatValidationErrorMessage`) và KHÔNG gọi `save`
 * lẫn `onSaved` — token sai không bao giờ chạm tới Vault hay
 * coordinator. Validate ok thì `save` rồi `onSaved`, trả `{ login? }`.
 */
export async function saveValidatedGithubPat(
  opts: SaveValidatedGithubPatOptions,
): Promise<{ login?: string }> {
  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  if (!token) {
    throw new Error(
      githubPatValidationErrorMessage({ ok: false, reason: 'invalid' }),
    );
  }
  const result = await validateGithubPat(token, {
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (!result.ok) {
    throw new Error(githubPatValidationErrorMessage(result));
  }
  await opts.save(token);
  if (opts.onSaved) {
    try {
      await opts.onSaved(token, result.login);
    } catch {
      // Seed coordinator là best-effort (main cũ nuốt lỗi seed):
      // token đã lưu bền trong Vault, bot tạo mới vẫn seed lại được
      // từ Vault lúc createBot.
    }
  }
  return result.login !== undefined ? { login: result.login } : {};
}

/**
 * v0.70 — xác thực LẠI PAT GitHub lúc kiểm tra trạng thái app.
 *
 * Vấn đề (v0.69a chỉ xác thực lúc dán): PAT bị thu hồi/hết hạn SAU
 * khi lưu vẫn chỉ lộ ra khi bot gọi tool GitHub. `GithubPatRevalidator`
 * gọi lại GET /user với chính token của user đó (qua
 * `validateGithubPat` — timeout tối đa 10s, fail-closed, không log
 * token, token không xuất hiện trong error/kết quả) mỗi khi trạng thái
 * app được query, nhưng cache kết quả HỢP LỆ trong 1 giờ để không gọi
 * GitHub mỗi lần mở view Connected apps. Kết quả không hợp lệ (401)
 * KHÔNG cache — lần kiểm tra sau gọi lại ngay; kết quả chưa kiểm tra
 * được (lỗi mạng/timeout/403) cũng không cache, caller giữ trạng thái
 * cũ thay vì đánh dấu token hỏng oan.
 */

 /** Thời gian cache kết quả xác thực lại HỢP LỆ (1 giờ). */
export const DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS = 3_600_000;

/** Token đã hết hạn hoặc bị thu hồi — user cần tạo PAT mới rồi dán lại. Không chứa token. */
export const GITHUB_PAT_REVOKED_DETAIL =
  'Token GitHub không còn hiệu lực (đã hết hạn hoặc bị thu hồi) — tạo PAT mới ở github.com → Settings → Developer settings rồi dán lại vào đây.';
/** Chưa kiểm tra được vì lỗi mạng/timeout — giữ trạng thái cũ, kiểm tra lại sau. Không chứa token. */
export const GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL =
  'Không kiểm tra được token GitHub (lỗi mạng/timeout) — vẫn giữ trạng thái cũ, sẽ kiểm tra lại sau.';
/** Chưa kiểm tra được vì GitHub hết giới hạn gọi API — giữ trạng thái cũ, thử lại sau ít phút. Không chứa token. */
export const GITHUB_PAT_UNCHECKABLE_RATE_LIMIT_DETAIL =
  'GitHub đang giới hạn số lần gọi API (rate limit) — vẫn giữ trạng thái cũ, sẽ kiểm tra lại sau ít phút.';
/** Chưa kiểm tra được vì GitHub tạm thời từ chối token — giữ trạng thái cũ, thử lại sau. Không chứa token. */
export const GITHUB_PAT_UNCHECKABLE_FORBIDDEN_DETAIL =
  'GitHub tạm thời từ chối token — vẫn giữ trạng thái cũ, sẽ kiểm tra lại sau.';

/**
 * Kết quả một lần xác thực lại PAT:
 *  - `'valid'`: token còn sống (kèm login khi biết; `fromCache` khi
 *    lấy từ cache 1 giờ, `checkedAtMs` là lúc xác thực, không phải lúc
 *    đọc cache).
 *  - `'invalid'`: 401 — token sai/hết hạn/bị thu hồi; `detail` hướng
 *    dẫn dán lại token.
 *  - `'unknown'`: chưa kiểm tra được (lỗi mạng/timeout/403) — caller
 *    GIỮ trạng thái cũ; `detail` ghi rõ lý do.
 */
export type GithubPatRevalidateOutcome = 'valid' | 'invalid' | 'unknown';

export interface GithubPatRevalidateResult {
  outcome: GithubPatRevalidateOutcome;
  /** Tên tài khoản GitHub (chỉ khi outcome 'valid' và body trả về login). */
  login?: string;
  /** true khi kết quả lấy từ cache hợp lệ (không gọi GitHub lần này). */
  fromCache: boolean;
  /** Thời điểm (ms) token được xác thực (cache hit: lúc xác thực gốc). */
  checkedAtMs: number;
  /** Thông điệp tiếng Việt cho user (không bao giờ chứa token). */
  detail?: string;
}

export interface GithubPatRevalidatorOptions {
  /** Fetch injectable (test dùng mock). Mặc định global fetch. */
  fetchFn?: GithubPatFetchFn;
  /** Timeout (ms) cho một lần xác thực lại. Mặc định 10s (xem validateGithubPat). */
  timeoutMs?: number;
  /** Thời gian cache kết quả hợp lệ (ms). Mặc định 1 giờ; ≤0 thì dùng mặc định. */
  cacheMs?: number;
  /** Đồng hồ (ms) — test bơm thời gian giả để kiểm tra cache hết hạn. Mặc định Date.now. */
  nowMs?: () => number;
}

/**
 * Xác thực lại PAT GitHub có cache. Một instance dùng cho một tiến
 * trình (main hoặc coordinator) — cache nằm trong bộ nhớ tiến trình
 * đó, token thay đổi thì `clear()`/`seedValid()` đồng bộ lại.
 */
export class GithubPatRevalidator {
  private readonly fetchFn?: GithubPatFetchFn;
  private readonly timeoutMs?: number;
  private readonly cacheMs: number;
  private readonly nowMs: () => number;
  /** Kết quả hợp lệ gần nhất (chỉ cache khi token còn sống). */
  private cachedValid: { atMs: number; login?: string } | null = null;
  /** Lần kiểm tra đang chạy (dedup các lần check song song cùng token). */
  private inFlight: { token: string; promise: Promise<GithubPatRevalidateResult> } | null = null;
  /** Tăng mỗi lần clear()/seedValid(): kết quả của lần kiểm tra cũ không được ghi đè cache mới. */
  private epoch = 0;

  constructor(opts: GithubPatRevalidatorOptions = {}) {
    this.fetchFn = opts.fetchFn;
    this.timeoutMs = opts.timeoutMs;
    this.cacheMs =
      opts.cacheMs !== undefined && opts.cacheMs > 0
        ? opts.cacheMs
        : DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  /**
   * Xác thực lại một PAT. Token rỗng → 'invalid' mà không gọi mạng.
   * Kết quả hợp lệ trong cache → trả ngay, không gọi GitHub.
   * Không bao giờ ném lỗi và không bao giờ đưa token vào kết quả.
   */
  async check(token: string): Promise<GithubPatRevalidateResult> {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    const now = this.nowMs();
    if (!trimmed) {
      return {
        outcome: 'invalid',
        fromCache: false,
        checkedAtMs: now,
        detail: GITHUB_PAT_REVOKED_DETAIL,
      };
    }
    const cached = this.cachedValid;
    if (cached && now - cached.atMs < this.cacheMs) {
      return {
        outcome: 'valid',
        ...(cached.login !== undefined ? { login: cached.login } : {}),
        fromCache: true,
        checkedAtMs: cached.atMs,
      };
    }
    if (this.inFlight && this.inFlight.token === trimmed) return this.inFlight.promise;
    const epochAtStart = this.epoch;
    const run = this.checkUncached(trimmed, epochAtStart);
    this.inFlight = { token: trimmed, promise: run };
    try {
      return await run;
    } finally {
      if (this.inFlight?.promise === run) this.inFlight = null;
    }
  }

  private async checkUncached(
    token: string,
    epochAtStart: number,
  ): Promise<GithubPatRevalidateResult> {
    let result: GithubPatValidation;
    try {
      result = await validateGithubPat(token, {
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      });
    } catch {
      // validateGithubPat không bao giờ ném, nhưng phòng thủ: coi như
      // chưa kiểm tra được thay vì kết luận token hỏng.
      return {
        outcome: 'unknown',
        fromCache: false,
        checkedAtMs: this.nowMs(),
        detail: GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL,
      };
    }
    const doneAt = this.nowMs();
    if (result.ok) {
      if (this.epoch === epochAtStart) {
        this.cachedValid = {
          atMs: doneAt,
          ...(result.login !== undefined ? { login: result.login } : {}),
        };
      }
      return {
        outcome: 'valid',
        ...(result.login !== undefined ? { login: result.login } : {}),
        fromCache: false,
        checkedAtMs: doneAt,
      };
    }
    if (result.reason === 'invalid') {
      // 401: token đã hết hạn/bị thu hồi. Không cache kết quả xấu,
      // nhưng xóa cache hợp lệ cũ để lần sau không trả lại kết quả cũ.
      if (this.epoch === epochAtStart) this.cachedValid = null;
      return {
        outcome: 'invalid',
        fromCache: false,
        checkedAtMs: doneAt,
        detail: GITHUB_PAT_REVOKED_DETAIL,
      };
    }
    // 'network' hay 'forbidden' (kể cả rate-limit): chưa kiểm tra
    // được — không cache, caller giữ trạng thái cũ. Riêng 403: token
    // bị GitHub từ chối có thể do thiếu scope/tạm thời, không đủ bằng
    // chứng kết luận token hỏng như 401.
    const detail =
      result.reason === 'forbidden'
        ? result.rateLimited
          ? GITHUB_PAT_UNCHECKABLE_RATE_LIMIT_DETAIL
          : GITHUB_PAT_UNCHECKABLE_FORBIDDEN_DETAIL
        : GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL;
    return { outcome: 'unknown', fromCache: false, checkedAtMs: doneAt, detail };
  }

  /**
   * Seed kết quả hợp lệ vừa xác thực được ở bước lưu (apps:set-token
   * đã validate ok qua saveValidatedGithubPat): lần kiểm tra trạng
   * thái ngay sau đó không gọi lại GitHub.
   */
  seedValid(login?: string): void {
    this.epoch += 1;
    this.cachedValid = {
      atMs: this.nowMs(),
      ...(login !== undefined ? { login } : {}),
    };
  }

  /** Xóa cache (ngắt kết nối / token đã đổi): lần kiểm tra sau gọi lại GitHub. */
  clear(): void {
    this.epoch += 1;
    this.cachedValid = null;
  }
}
