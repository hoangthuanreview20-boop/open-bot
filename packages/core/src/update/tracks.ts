/**
 * Update track + chính sách update (P1-9, §6) — thuần túy, không gọi mạng.
 *
 * Track (theo mẫu Grok §6, đổi tên cho open-bot):
 *  - `stable` (mặc định): bản phát hành ổn định.
 *  - `dogfood`: bản nội bộ dùng thử trước khi ra stable.
 *  - `nightly`: bản build hàng đêm từ main.
 *  - `lab`: bản thử nghiệm.
 *
 * GIỚI HẠN QUAN TRỌNG (2026-11-09, push GitHub còn defer — chưa có
 * release feed thật): module này CHỈ quản lý track + đánh giá chính sách
 * (`update_required` / `min_client_version`) từ dữ liệu đã có; nó KHÔNG
 * tự bịa ra server release nào. `checkForUpdate` (checker.ts) kiểm tra
 * kênh stable qua GitHub releases API; từ v0.59 `checkForTrackUpdate`
 * (cùng file) kiểm tra các track khác qua danh sách releases lọc theo
 * tag kênh — code thật, nhưng chưa có release kênh nào được phát hành
 * thật nên lần kiểm tra trả "không có bản mới" cho tới khi có release.
 * `UpdateService` ở desktop chỉ đánh dấu `stub-no-feed` khi feed chưa
 * được cấu hình (`trackFeedUrl: ''`). Đừng "hoàn thiện" module này bằng
 * cách trỏ sang một URL release không tồn tại.
 *
 * Mã lỗi: tắt update bằng biến môi trường → `updateDisabledByEnv`
 * (tương ứng `SAND-E0505 updateDisabledByEnv` của Grok §6).
 */

import { compareSemver } from './checker';
export const UPDATE_TRACKS = ['stable', 'dogfood', 'nightly', 'lab'] as const;
export type UpdateTrack = (typeof UPDATE_TRACKS)[number];

export const DEFAULT_UPDATE_TRACK: UpdateTrack = 'stable';

/** Biến môi trường tắt hoàn toàn việc kiểm tra update. */
export const UPDATE_DISABLED_ENV_VAR = 'OPEN_BOT_DISABLE_UPDATE';

/** Mã lỗi khi update bị tắt bằng biến môi trường (domain `update`). */
export const UPDATE_DISABLED_BY_ENV_CODE = 'updateDisabledByEnv';

/** true khi giá trị là một track hợp lệ. */
export function isUpdateTrack(value: unknown): value is UpdateTrack {
  return typeof value === 'string' && (UPDATE_TRACKS as readonly string[]).includes(value);
}

/** Parse track từ chuỗi (vd settings.json); không hợp lệ → `stable`. */
export function parseUpdateTrack(value: unknown): UpdateTrack {
  return isUpdateTrack(value) ? value : DEFAULT_UPDATE_TRACK;
}

/**
 * true khi update bị tắt bằng biến môi trường. Giá trị `1`/`true` (không
 * phân biệt hoa thường) thì tắt; mọi giá trị khác (kể cả `0`) thì không.
 */
export function isUpdateDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[UPDATE_DISABLED_ENV_VAR];
  if (typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === '1' || raw.trim().toLowerCase() === 'true';
}

export interface UpdatePolicyInput {
  /** Phiên bản đang chạy, vd "0.50.0". */
  currentVersion: string;
  /** Cờ `update_required`: server bắt buộc lên bản mới. */
  updateRequired?: boolean;
  /** Phiên bản client tối thiểu còn được hỗ trợ, vd "0.49.0". */
  minClientVersion?: string | null;
}

export interface UpdatePolicyResult {
  /** true khi client BẮT BUỘC phải update (required hoặc dưới min version). */
  required: boolean;
  /** true khi client đang dưới min_client_version. */
  belowMinVersion: boolean;
  /** Lý do (tiếng Việt) khi required, ngược lại null. */
  reason: string | null;
}

/**
 * Đánh giá chính sách update từ cờ server: `update_required` thắng mọi
 * thứ; `min_client_version` so bằng semver (xem checker.ts). Không có cờ
 * nào thì không bắt buộc. Thuần túy — không gọi mạng, không đọc settings.
 */
export function evaluateUpdatePolicy(input: UpdatePolicyInput): UpdatePolicyResult {
  const belowMinVersion =
    typeof input.minClientVersion === 'string' &&
    input.minClientVersion.trim() !== '' &&
    compareSemver(input.currentVersion, input.minClientVersion) < 0;
  if (input.updateRequired === true) {
    return {
      required: true,
      belowMinVersion,
      reason: 'Bản này bắt buộc phải cập nhật lên bản mới (update_required).',
    };
  }
  if (belowMinVersion) {
    return {
      required: true,
      belowMinVersion: true,
      reason: `Phiên bản hiện tại (${input.currentVersion}) thấp hơn phiên bản tối thiểu còn hỗ trợ (${input.minClientVersion}).`,
    };
  }
  return { required: false, belowMinVersion: false, reason: null };
}
