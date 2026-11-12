/**
 * Durable file writes with bounded backup copies (v0.53, P1-6 — REA
 * deep-dive lần 2 §7.1: Grok ghi `user-secrets` qua
 * `withBoundedDurableFileCopies` + `openDurableFileSync`).
 *
 * Idea only, original code: write the new content to a temp file in
 * the same directory, fsync it, rotate the previous copies
 * (`file` -> `file.1` -> `file.2` ... up to `maxCopies`), then rename
 * the temp file into place and fsync the directory (best effort).
 * A crash at any point leaves either the old content (in `file.1`)
 * or the new content (in `file`) — never a half-written file — and
 * the number of backup copies on disk stays bounded.
 *
 * The previous copies are NOT secret-free: they hold the same
 * ciphertext as the live file (never plaintext), so keeping them is
 * no worse than keeping the live file. They are created with mode
 * 0600 like the live file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Default number of backup copies kept (`file.1` … `file.N`). */
export const DEFAULT_DURABLE_COPIES = 3;

export interface DurableWriteOptions {
  /**
   * How many previous copies to keep. Default 3. 0 means "no backups,
   * just atomic tmp+rename" (the pre-v0.53 Vault behaviour).
   */
  maxCopies?: number;
  /** File mode for the new file (and its backups). Default 0o600. */
  mode?: number;
}

/** Best-effort fsync of an open fd / a directory. Never throws. */
function fsyncBestEffort(target: string, isDir: boolean): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, isDir ? 'r' : 'r');
    fs.fsyncSync(fd);
  } catch {
    // fsync of directories is not supported on every platform
    // (notably macOS/Windows) — durability still holds via rename.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore.
      }
    }
  }
}

/**
 * Write `data` to `filePath` durably, keeping at most `maxCopies`
 * previous copies (`filePath.1` is the newest backup).
 *
 * Order (crash-safe):
 *   1. write temp file `<file>.tmp-<pid>-<random>` + fsync it;
 *   2. shift backups: `file.(N-1)` -> `file.N`, …, `file` -> `file.1`
 *      (the oldest copy, if any, is deleted first);
 *   3. rename temp -> `file`;
 *   4. fsync the directory (best effort).
 *
 * A crash between steps 2 and 3 leaves `file` missing but `file.1`
 * intact — callers that can tolerate it should fall back to the
 * newest backup when the live file is absent (see Vault.loadStore).
 * A crash during step 2 can only lose the OLDEST backup, never the
 * live content.
 */
export function writeDurableFileSync(
  filePath: string,
  data: string | Buffer,
  opts: DurableWriteOptions = {},
): void {
  const maxCopies = opts.maxCopies ?? DEFAULT_DURABLE_COPIES;
  const mode = opts.mode ?? 0o600;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Xoay bản sao lưu: mỗi bước đều tự bọc lỗi (bản sao không tồn tại
  // là bình thường) nên khối này không ném — lỗi duy nhất có thể ném
  // ra là rename cuối tmp → live, được bọc riêng bên dưới (v0.74c).
  if (maxCopies > 0) {
    // Drop the oldest backup first so the shift never exceeds the bound.
    try {
      fs.rmSync(`${filePath}.${maxCopies}`);
    } catch {
      // No such copy — fine.
    }
    for (let i = maxCopies - 1; i >= 1; i -= 1) {
      try {
        fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
      } catch {
        // That copy did not exist — fine.
      }
    }
    try {
      fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      // Live file did not exist yet (first write) — fine.
    }
  }
  // v0.74c (lấp gap v0.28, mirror message rename của rotateKey):
  // rename cuối là bước duy nhất còn ném lỗi fs thô — bọc rõ ràng:
  // file tạm đã dọn, file live vẫn giữ nội dung cũ, các bản sao lưu
  // còn nguyên, secret trong bộ nhớ không ảnh hưởng, thử lại an toàn.
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Do not leave the temp file behind on failure.
    try {
      fs.rmSync(tmpPath);
    } catch {
      // Ignore.
    }
    throw new Error(
      `Vault: không thể rename file tạm (${tmpPath} → ${filePath}) để hoàn tất ghi store: ${(err as Error).message}. ` +
        'File tạm đã được dọn; file live vẫn giữ nội dung cũ, các bản sao lưu ' +
        `(${filePath}.1 …) còn nguyên, secret trong bộ nhớ không ảnh hưởng — ` +
        'thử lại thao tác lưu là an toàn.',
    );
  }
  fsyncBestEffort(dir, true);
}

/**
 * Read the newest available copy of a durably-written file: the live
 * file first, then `file.1`, `file.2`, … Returns null when no copy
 * exists. Callers still validate/parse the content themselves — a
 * corrupt live file is NOT silently replaced by a backup here (the
 * caller decides: Vault treats an unreadable live file as an error,
 * and only falls back when the live file is missing entirely).
 */
export function readDurableFileSync(
  filePath: string,
  maxCopies: number = DEFAULT_DURABLE_COPIES,
): Buffer | null {
  for (let i = 0; i <= maxCopies; i += 1) {
    const candidate = i === 0 ? filePath : `${filePath}.${i}`;
    try {
      return fs.readFileSync(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}
