/**
 * Snapshot engine ghi atomic (M5).
 *
 * Snapshot trạng thái engine/instance ghi xuống đĩa bằng ghi file tạm
 * + rename (atomic trên cùng filesystem — crash giữa chừng không bao
 * giờ để lại file snapshot nửa vời). Đọc lại khi khởi động để khôi
 * phục trạng thái HIỂN THỊ (Settings → Engines hiện trạng thái lần
 * cuối trước khi tắt); KHÔNG tự spawn lại process — process CLI chỉ
 * sống khi bot được tạo / turn chạy, xem README.
 *
 * File hỏng (JSON sai / version lạ) thì `readHarnessSnapshot` trả
 * `{snapshot: null, warning}` — caller fallback snapshot rỗng + hiện
 * cảnh báo, không crash app.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HarnessSnapshotFile } from './types';

/** Tên file snapshot trong dataDir. */
export const HARNESS_SNAPSHOT_FILE_NAME = 'harness-snapshot.json';

/** Ghi snapshot atomic: file tạm cùng thư mục rồi rename đè file đích. */
export function writeHarnessSnapshotAtomic(dir: string, snapshot: HarnessSnapshotFile): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, HARNESS_SNAPSHOT_FILE_NAME);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

export interface ReadHarnessSnapshotResult {
  snapshot: HarnessSnapshotFile | null;
  /** Lý do fallback (file chưa có / hỏng) — undefined khi đọc tốt. */
  warning?: string;
}

/** Đọc snapshot; file chưa có/hỏng → snapshot null + warning (không throw). */
export function readHarnessSnapshot(dir: string): ReadHarnessSnapshotResult {
  const target = path.join(dir, HARNESS_SNAPSHOT_FILE_NAME);
  let text: string;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { snapshot: null, warning: 'chưa có snapshot harness (lần chạy đầu).' };
    }
    return { snapshot: null, warning: `không đọc được snapshot harness: ${(err as Error).message}` };
  }
  try {
    const parsed = JSON.parse(text) as HarnessSnapshotFile;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.instances)) {
      return { snapshot: null, warning: 'snapshot harness sai định dạng (version/instances) — bỏ qua.' };
    }
    return { snapshot: parsed };
  } catch (err) {
    return { snapshot: null, warning: `snapshot harness hỏng (JSON sai): ${(err as Error).message}` };
  }
}
