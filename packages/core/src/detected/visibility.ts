/**
 * Visibility của provider CLI theo snapshot detector (M1).
 *
 * Một provider CLI chỉ được dùng/hiện trong picker khi nguồn tương ứng
 * VỪA được user bật (opt-in) VỪA available (CLI đã cài + đã đăng nhập).
 * Mặc định tắt (fail-closed): snapshot null, nguồn chưa bật, hay CLI
 * chưa đăng nhập đều -> không dùng được.
 *
 * Main process dùng hàm này để chặn tạo provider CLI (`providerConfigFor`);
 * renderer dùng cùng điều kiện (qua snapshot IPC) để lọc picker.
 */

import type { DetectedEnginesSnapshot } from './types';

/** True khi nguồn `kind` trong snapshot vừa bật vừa available. */
export function isEngineUsable(
  snapshot: DetectedEnginesSnapshot | null | undefined,
  kind: string,
): boolean {
  if (!snapshot) return false;
  const engine = snapshot.engines[kind];
  return !!engine && engine.enabled === true && engine.status === 'available';
}

/**
 * M3 — True khi nguồn `kind` vừa bật vừa available HOẶC 'unknown'.
 * Chỉ dùng cho CLI ACP tuỳ chỉnh không khai lệnh kiểm tra đăng nhập
 * (status 'unknown' = không rõ, không bịa là đã đăng nhập): user bật
 * nguồn thì được thử chạy, lỗi auth (nếu có) sẽ hiện rõ khi chạy bot.
 * Nguồn built-in vẫn dùng `isEngineUsable` (chỉ 'available').
 */
export function isEngineUsableAllowingUnknown(
  snapshot: DetectedEnginesSnapshot | null | undefined,
  kind: string,
): boolean {
  if (!snapshot) return false;
  const engine = snapshot.engines[kind];
  return (
    !!engine &&
    engine.enabled === true &&
    (engine.status === 'available' || engine.status === 'unknown')
  );
}

/** Binary đã detect của nguồn `kind` (null khi không dùng được). */
export function usableEngineBinary(
  snapshot: DetectedEnginesSnapshot | null | undefined,
  kind: string,
): string | null {
  if (!isEngineUsable(snapshot, kind)) return null;
  const engine = snapshot!.engines[kind];
  return engine.binaryPath;
}

/** Binary đã detect của nguồn CLI tuỳ chỉnh `kind` (null khi không dùng được — chấp nhận cả 'unknown'). */
export function usableCustomEngineBinary(
  snapshot: DetectedEnginesSnapshot | null | undefined,
  kind: string,
): string | null {
  if (!isEngineUsableAllowingUnknown(snapshot, kind)) return null;
  const engine = snapshot!.engines[kind];
  return engine.binaryPath;
}
