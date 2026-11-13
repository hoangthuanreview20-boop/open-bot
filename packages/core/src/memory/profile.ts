/**
 * User profile — cá nhân hoá sâu, local-first (v0.95, Đội D4).
 *
 * Storage: `<userData>/profile.json`, cùng file với LocalProfile của
 * v0.7 (`auth/identity.ts` — userId ổn định + displayName). Module này
 * KHÔNG sở hữu file: nó chỉ bọc `loadLocalProfile` /
 * `updateLocalProfile` / `getOrCreateLocalProfile` và thêm lớp render
 * context cho agent turn.
 *
 * Profile gồm: tên hiển thị, cách xưng hô (addressForm), sở thích
 * (interests), thói quen (habits), facts khác về user. Tất cả đều do
 * user tự nhập ở Settings (hoặc agent ghi qua `memory_save` CHỈ khi
 * user nói rõ "hãy nhớ ..." — xem memoryTools.ts); không có gì được
 * suy ra lén từ hội thoại rồi ghi âm thầm.
 *
 * Privacy: 100% local — file nằm trong userData trên máy user, không
 * đồng bộ cloud, không gửi cho provider nào ngoài phần context của
 * chính turn đó (như mọi system prompt khác). Xem docs/memory-v095.md.
 */
import {
  getOrCreateLocalProfile,
  loadLocalProfile,
  updateLocalProfile,
  type LocalProfile,
  type LocalProfilePatch,
} from '../auth/identity';

/** Alias: profile của user chính là LocalProfile (đã mở rộng v0.95d4). */
export type UserProfile = LocalProfile;
export type { LocalProfilePatch };

/** Số ký tự tối đa của section profile trong system prompt. */
export const PROFILE_CONTEXT_MAX_CHARS = 2000;

/**
 * Đọc profile, null khi chưa có file (caller tự quyết: bỏ qua section
 * hay tạo profile trống — turn injection bỏ qua, UI thì tạo khi lưu).
 */
export function loadUserProfile(userDataDir: string): UserProfile | null {
  return loadLocalProfile(userDataDir);
}

/** Lấy profile, tạo mới (userId uuid) khi chưa có — dùng cho UI lưu lần đầu. */
export function getOrCreateUserProfile(userDataDir: string): UserProfile {
  return getOrCreateLocalProfile(userDataDir);
}

/** Cập nhật các field cá nhân hoá (merge, validate strict, xem identity.ts). */
export function saveUserProfile(
  userDataDir: string,
  patch: LocalProfilePatch,
): UserProfile {
  return updateLocalProfile(userDataDir, patch);
}

/**
 * Render profile thành một section chèn vào system prompt của turn.
 * Trả '' khi profile trống (không có gì để cá nhân hoá) — caller bỏ
 * qua, không chèn section rỗng. Nội dung bị cắt ở
 * PROFILE_CONTEXT_MAX_CHARS để không bao giờ chiếm hết ngân sách turn.
 *
 * Định dạng (tiếng Việt, vì user chính là Huy — nhưng nội dung field
 * giữ nguyên ngôn ngữ user đã nhập):
 *   [Thông tin về người dùng (đã lưu trên máy này — dùng để xưng hô
 *   và cá nhân hoá câu trả lời):
 *   - Tên hiển thị: ...
 *   - Xưng hô: gọi người dùng là "..."
 *   - Sở thích: ...
 *   - Thói quen: ...
 *   - Biết thêm: ...]
 */
export function buildProfileContext(
  profile: UserProfile | null | undefined,
  opts: { maxChars?: number } = {},
): string {
  if (!profile) return '';
  const lines: string[] = [];
  const displayName = (profile.displayName ?? '').trim();
  if (displayName !== '') lines.push(`- Tên hiển thị: ${displayName}`);
  const addressForm = (profile.addressForm ?? '').trim();
  if (addressForm !== '') {
    lines.push(`- Xưng hô: gọi người dùng là "${addressForm}" (dùng đúng cách xưng hô này khi nói chuyện).`);
  }
  const joinList = (items: string[] | undefined): string =>
    (items ?? []).map((s) => s.trim()).filter(Boolean).join('; ');
  const interests = joinList(profile.interests);
  if (interests !== '') lines.push(`- Sở thích: ${interests}`);
  const habits = joinList(profile.habits);
  if (habits !== '') lines.push(`- Thói quen: ${habits}`);
  const facts = joinList(profile.facts);
  if (facts !== '') lines.push(`- Biết thêm về người dùng: ${facts}`);
  if (lines.length === 0) return '';
  const maxChars = opts.maxChars ?? PROFILE_CONTEXT_MAX_CHARS;
  let section =
    '[Thông tin về người dùng (đã lưu trên máy này — dùng để xưng hô và cá nhân hoá câu trả lời):]\n' +
    lines.join('\n');
  if (section.length > maxChars) {
    section = section.slice(0, maxChars) + '\n…(đã rút gọn)';
  }
  return section;
}

/** Profile có gì để inject vào turn không (ít nhất một field có nội dung). */
export function hasProfileContext(profile: UserProfile | null | undefined): boolean {
  return buildProfileContext(profile) !== '';
}
