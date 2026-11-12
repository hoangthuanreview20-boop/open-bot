/**
 * UpdateService — desktop main (P1-9, §6). Track + kiểm tra định kỳ.
 *
 * API theo mẫu Grok `LiveUpdateService` (§6): `getStatus`,
 * `checkForUpdates`, `setUpdateTrack`, `quitAndInstallUpdate`, event
 * "restart-to-update" (ở đây là trạng thái `available`, main hiện menu/
 * banner; KHÔNG tự restart máy user). Lịch: `checkForUpdates({trigger:
 * "startup"})` khi khởi động + `scheduleNextPeriodicCheck()` — lỗi thì
 * ghi lại và retry ở lần check định kỳ sau (không throw, không spam).
 * Mã lỗi tắt bằng biến môi trường: `updateDisabledByEnv` (domain
 * `update`, tương ứng `SAND-E0505 updateDisabledByEnv`).
 *
 * ⚠️ GIỚI HẠN — ĐỌC TRƯỚC KHI "HOÀN THIỆN" FILE NÀY (cập nhật v0.59):
 * Push GitHub còn defer theo lệnh của Huy nên DỰ ÁN CHƯA CÓ RELEASE
 * NÀO ĐƯỢC PHÁT HÀNH THẬT (kể cả kênh stable). Vì vậy:
 *  - Track `stable` kiểm tra qua GitHub releases API đã có từ v0.7
 *    (`checkForUpdate` — latest `v*` không phải prerelease).
 *  - Track `dogfood` / `nightly` / `lab` từ v0.59 kiểm tra THẬT bằng
 *    code: `checkForTrackUpdate` (core) lấy danh sách releases
 *    (`/releases?per_page=20`) và chọn release prerelease có tag mang
 *    hậu tố kênh (`-dogfood` / `-nightly` / `-lab`, vd
 *    `v0.59.0-nightly.20261109`), rồi so semver với bản đang chạy —
 *    code đã test bằng feed giả local (không gọi mạng thật trong test).
 *    NHƯNG chưa có release nào cho các kênh đó tồn tại thật, nên tới
 *    khi Huy cho push + phát hành release theo quy ước tag trên, lần
 *    kiểm tra sẽ trả `available: false` một cách trung thực (không có
 *    release cho kênh = không phải lỗi). Feed URL cấu hình được qua
 *    `trackFeedUrl`; đặt `trackFeedUrl: ''` nghĩa là "chưa cấu hình
 *    feed" → các track ngoài stable quay lại `stub-no-feed`, không
 *    gọi mạng (hành vi cũ, có chủ ý).
 *  - `update_required` / `min_client_version` mặc định không set (không
 *    có server nào trả cờ này); chỉ có ý nghĩa khi có feed thật sau này
 *    (xem `setServerPolicy`).
 *  - `quitAndInstallUpdate()` LUÔN trả `{installed: false}` cho tới khi
 *    có cơ chế tải + cài đặt thật (cần code-signing + feed — xem v0.7);
 *    app không bao giờ tự ghi đè file của chính nó khi đang chạy.
 *  - Track được persist vào `<userData>/update-track.json` (main truyền
 *    storage vào); service này KHÔNG import electron nên test được bằng
 *    node thuần (storage + checkFn + checkTrackFn đều inject được).
 */

import {
  DEFAULT_UPDATE_TRACK,
  UPDATE_DISABLED_BY_ENV_CODE,
  checkForTrackUpdate,
  checkForUpdate,
  evaluateUpdatePolicy,
  isUpdateDisabledByEnv,
  parseUpdateTrack,
} from '@open-bot/core';
import type { UpdateCheckResult, UpdateFetchLike, UpdateTrack } from '@open-bot/core';

/**
 * Feed nào đã dùng cho lần kiểm tra gần nhất (v0.59):
 *  - `github-stable`: track `stable`, qua GitHub releases API (latest).
 *  - `github-releases-list`: track `dogfood` / `nightly` / `lab`, qua
 *    danh sách releases GitHub lọc theo tag kênh (code thật từ v0.59;
 *    chưa có release kênh nào tồn tại thật nên thường trả "không có
 *    bản mới" cho tới khi release được phát hành).
 *  - `stub-no-feed`: không có feed cấu hình cho track ngoài stable
 *    (`trackFeedUrl: ''`) — không gọi mạng, fail soft như cũ.
 */
export type UpdateFeedStatus = 'github-stable' | 'github-releases-list' | 'stub-no-feed';

export type UpdateCheckTrigger = 'startup' | 'periodic' | 'manual';

export interface UpdateStatus {
  track: UpdateTrack;
  currentVersion: string;
  /** True khi có bản mới hơn trên feed của track đang chọn. */
  available: boolean;
  latestVersion: string | null;
  latestTag: string | null;
  htmlUrl: string | null;
  /** True khi lần kiểm tra gần nhất lỗi (mạng/API) — `available` là false khi đó. */
  checkFailed: boolean;
  error?: string;
  /** Mã lỗi máy-đọc được khi checkFailed (vd `updateDisabledByEnv`). */
  errorCode?: string;
  /** Feed nào đã dùng cho lần kiểm tra gần nhất. */
  feedStatus: UpdateFeedStatus;
  /** Cờ server `update_required` (mặc định false — chưa có feed thật). */
  updateRequired: boolean;
  /** `min_client_version` từ server (mặc định null — chưa có feed thật). */
  minClientVersion: string | null;
  /** True khi policy bắt buộc update (required hoặc dưới min version). */
  updateRequiredByPolicy: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface UpdateTrackStorage {
  loadTrack(): string | null;
  saveTrack(track: string): void;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  /** Nơi persist track (mặc định: chỉ nhớ trong bộ nhớ tiến trình). */
  storage?: UpdateTrackStorage;
  /** Hàm kiểm tra bản mới cho track `stable` (mặc định: `checkForUpdate` của core). */
  checkFn?: (opts: { currentVersion: string }) => Promise<UpdateCheckResult>;
  /**
   * Hàm kiểm tra bản mới cho track ngoài `stable` (mặc định:
   * `checkForTrackUpdate` của core — danh sách releases GitHub lọc
   * theo tag kênh; `fetchImpl` + `trackFeedUrl` bên dưới được truyền
   * vào). Test inject mock ở đây.
   */
  checkTrackFn?: (opts: { currentVersion: string; track: UpdateTrack }) => Promise<UpdateCheckResult>;
  /**
   * URL feed danh sách releases cho track ngoài `stable` (mặc định:
   * GitHub releases list API của repo). Đặt `''` = chưa cấu hình feed
   * → các track đó quay lại `stub-no-feed`, không gọi mạng.
   */
  trackFeedUrl?: string;
  /** Fetch dùng cho lần kiểm tra track mặc định (mặc định: global fetch). */
  fetchImpl?: UpdateFetchLike;
  /** Chu kỳ kiểm tra định kỳ, ms. Mặc định 6 giờ. */
  periodicIntervalMs?: number;
  /** Đồng hồ (test inject). */
  now?: () => Date;
  /** Env (test inject; mặc định process.env). */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Feed status theo track (v0.59): `stable` → GitHub releases API;
 * các track khác → danh sách releases lọc theo tag kênh, trừ khi feed
 * chưa được cấu hình (`feedConfigured === false`) thì vẫn là stub.
 */
export function feedStatusForTrack(track: UpdateTrack, feedConfigured = true): UpdateFeedStatus {
  if (track === 'stable') return 'github-stable';
  return feedConfigured ? 'github-releases-list' : 'stub-no-feed';
}

export class UpdateService {
  private readonly currentVersion: string;
  private readonly storage?: UpdateTrackStorage;
  private readonly checkFn: (opts: { currentVersion: string }) => Promise<UpdateCheckResult>;
  private readonly checkTrackFn: (opts: { currentVersion: string; track: UpdateTrack }) => Promise<UpdateCheckResult>;
  /** False chỉ khi `trackFeedUrl` được đặt `''` (chưa cấu hình feed). */
  private readonly trackFeedConfigured: boolean;
  private readonly periodicIntervalMs: number;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private track: UpdateTrack;
  private latest: { version: string | null; tag: string | null; htmlUrl: string | null } = {
    version: null,
    tag: null,
    htmlUrl: null,
  };
  private available = false;
  private checkFailed = false;
  private error?: string;
  private errorCode?: string;
  private feedStatus: UpdateFeedStatus;
  private updateRequired = false;
  private minClientVersion: string | null = null;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(opts: UpdateServiceOptions) {
    this.currentVersion = opts.currentVersion?.trim() || '0.0.0';
    this.storage = opts.storage;
    this.checkFn = opts.checkFn ?? ((o) => checkForUpdate({ currentVersion: o.currentVersion }));
    this.trackFeedConfigured = opts.trackFeedUrl !== '';
    const trackFeedUrl = opts.trackFeedUrl === '' ? undefined : opts.trackFeedUrl;
    const fetchImpl = opts.fetchImpl;
    this.checkTrackFn =
      opts.checkTrackFn ??
      ((o) =>
        checkForTrackUpdate({
          currentVersion: o.currentVersion,
          track: o.track,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(trackFeedUrl ? { releasesListApiUrl: trackFeedUrl } : {}),
        }));
    this.periodicIntervalMs = opts.periodicIntervalMs ?? DEFAULT_PERIODIC_CHECK_MS;
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
    let stored: string | null = null;
    try {
      stored = this.storage?.loadTrack() ?? null;
    } catch {
      stored = null;
    }
    this.track = parseUpdateTrack(stored);
    this.feedStatus = feedStatusForTrack(this.track, this.trackFeedConfigured);
  }

  getTrack(): UpdateTrack {
    return this.track;
  }

  /**
   * Đổi track update (`setUpdateTrack`): validate, persist, cập nhật
   * feedStatus. Track lạ thì về `stable` (không throw — UI gửi gì cũng
   * an toàn). Trả về status hiện tại.
   */
  setUpdateTrack(track: unknown): UpdateStatus {
    this.track = parseUpdateTrack(track);
    this.feedStatus = feedStatusForTrack(this.track, this.trackFeedConfigured);
    try {
      this.storage?.saveTrack(this.track);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.getStatus();
  }

  getStatus(): UpdateStatus {
    const policy = evaluateUpdatePolicy({
      currentVersion: this.currentVersion,
      updateRequired: this.updateRequired,
      minClientVersion: this.minClientVersion,
    });
    return {
      track: this.track,
      currentVersion: this.currentVersion,
      available: this.available,
      latestVersion: this.latest.version,
      latestTag: this.latest.tag,
      htmlUrl: this.latest.htmlUrl,
      checkFailed: this.checkFailed,
      ...(this.error ? { error: this.error } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      feedStatus: this.feedStatus,
      updateRequired: this.updateRequired,
      minClientVersion: this.minClientVersion,
      updateRequiredByPolicy: policy.required,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Đặt cờ policy từ server (dành cho feed thật sau này). Hiện không có
   * server nào gọi hàm này nên cờ luôn ở mặc định (không bắt buộc).
   */
  setServerPolicy(policy: { updateRequired?: boolean; minClientVersion?: string | null }): void {
    if (typeof policy.updateRequired === 'boolean') this.updateRequired = policy.updateRequired;
    if (policy.minClientVersion !== undefined) this.minClientVersion = policy.minClientVersion;
  }

  /**
   * Kiểm tra bản mới (startup / định kỳ / tay). Fail soft: lỗi thì ghi
   * lại (`checkFailed`, `lastError`) và trả status — KHÔNG throw, lần
   * check định kỳ sau sẽ retry. Tắt bằng env thì báo mã
   * `updateDisabledByEnv`. Track chưa cấu hình feed (`stub-no-feed`)
   * thì trả ngay, không gọi mạng. Track `stable` dùng `checkFn`
   * (releases latest); track khác dùng `checkTrackFn` (danh sách
   * releases lọc theo tag kênh).
   */
  async checkForUpdates(trigger: UpdateCheckTrigger): Promise<UpdateStatus> {
    void trigger;
    this.lastCheckedAt = this.now().toISOString();
    if (isUpdateDisabledByEnv(this.env)) {
      this.checkFailed = true;
      this.available = false;
      this.error = 'Kiểm tra bản cập nhật đã bị tắt bằng biến môi trường OPEN_BOT_DISABLE_UPDATE.';
      this.errorCode = UPDATE_DISABLED_BY_ENV_CODE;
      this.lastError = this.error;
      return this.getStatus();
    }
    this.error = undefined;
    this.errorCode = undefined;
    if (this.feedStatus === 'stub-no-feed') {
      // Feed chưa được cấu hình cho track này: không gọi mạng, không báo bản mới.
      this.checkFailed = false;
      this.available = false;
      this.latest = { version: null, tag: null, htmlUrl: null };
      return this.getStatus();
    }
    try {
      const res =
        this.track === 'stable'
          ? await this.checkFn({ currentVersion: this.currentVersion })
          : await this.checkTrackFn({ currentVersion: this.currentVersion, track: this.track });
      this.checkFailed = res.checkFailed;
      this.available = res.available;
      this.latest = { version: res.latestVersion, tag: res.latestTag, htmlUrl: res.htmlUrl };
      if (res.checkFailed) {
        this.error = res.error ?? 'Không kiểm tra được bản mới.';
        this.lastError = this.error;
      } else {
        this.lastError = null;
      }
    } catch (err) {
      this.checkFailed = true;
      this.available = false;
      this.error = err instanceof Error ? err.message : 'Không kiểm tra được bản mới.';
      this.lastError = this.error;
    }
    return this.getStatus();
  }

  /**
   * Thoát app để cài bản cập nhật đã tải (`quitAndInstallUpdate`).
   * CHƯA CÓ CƠ CHẾ TẢI/CÀI THẬT nên luôn trả `{installed: false}` kèm
   * lý do — main KHÔNG được tự thoát app theo kết quả này. Khi có feed
   * + code-signing + autoUpdater, hàm này mới thật sự thoát + cài.
   */
  quitAndInstallUpdate(): { installed: boolean; reason: string } {
    if (!this.available) {
      return { installed: false, reason: 'Chưa có bản cập nhật để cài đặt.' };
    }
    return {
      installed: false,
      reason:
        'Đã thấy bản mới nhưng chưa có cơ chế tải + cài đặt (cần feed phát hành + code-signing) — mở trang release để tải tay.',
    };
  }

  /**
   * Lên lịch kiểm tra định kỳ tiếp theo (`scheduleNextPeriodicCheck`):
   * sau `periodicIntervalMs` thì check rồi tự lên lịch lần sau — lỗi ở
   * lần nào cũng không dừng lịch (lần sau retry). Gọi `start()` một lần
   * lúc app khởi động: check startup ngay + bắt đầu lịch định kỳ.
   */
  scheduleNextPeriodicCheck(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.checkForUpdates('periodic')
        .catch(() => undefined)
        .finally(() => {
          if (this.started) this.scheduleNextPeriodicCheck();
        });
    }, this.periodicIntervalMs);
    this.timer.unref?.();
  }

  /** Check lúc startup + bắt đầu lịch kiểm tra định kỳ. */
  async start(): Promise<UpdateStatus> {
    this.started = true;
    const status = await this.checkForUpdates('startup');
    this.scheduleNextPeriodicCheck();
    return status;
  }

  /** Dừng lịch kiểm tra định kỳ (vd khi app sắp thoát). */
  stop(): void {
    this.started = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
