/**
 * CLI ACP tuỳ chỉnh (M3) — cấu hình + validate + detector definition.
 *
 * User trỏ tới bất kỳ CLI nào nói ACP trong Settings → Engines
 * ("Set CLI…"): tên hiển thị + đường dẫn tuyệt đối tới binary + lệnh
 * spawn ACP (argv) + (tuỳ chọn) lệnh kiểm tra đăng nhập. Cấu hình lưu
 * bền vững trong `detected-engines.json` (cùng file opt-in, ghi
 * atomic qua registry.saveState()).
 *
 * Quy tắc validate (fail-closed):
 * - `id` (slug): chỉ chữ thường/số/gạch nối, bắt đầu bằng chữ/số,
 *   tối đa 32 ký tự. Kind của engine là `custom-acp:<slug>`; model
 *   của bot dùng CLI này cũng là slug.
 * - `binaryPath`: phải là đường dẫn tuyệt đối (tồn tại + chạy được
 *   thì registry kiểm tra thêm lúc thêm/sửa).
 * - `acpArgs` / `statusArgs`: mảng chuỗi không rỗng, không chứa ký tự
 *   NUL; argv nào trông như đang nhét API key/token vào dòng lệnh
 *   (`--api-key`, `--token`, `--auth-token`, `--access-token` và dạng
 *   `--flag=value` của chúng) đều bị TỪ CHỐI — key/token không được
 *   lưu vào file config dưới dạng plaintext; user phải đăng nhập
 *   bằng chính CLI đó (login của CLI nằm ở keychain/file riêng của
 *   nó, open-bot không đọc).
 * - Không có `statusArgs` thì trạng thái detect là 'unknown' (không
 *   rõ đăng nhập) — không bịa là đã đăng nhập.
 */

import * as path from 'node:path';

import type { CustomAcpCliConfig, DetectorDefinition } from './types';

/** Tiền tố kind của engine CLI ACP tuỳ chỉnh. */
export const CUSTOM_ACP_KIND_PREFIX = 'custom-acp:';

/** Kind của engine cho CLI tuỳ chỉnh có slug `id`. */
export function customAcpKind(id: string): string {
  return `${CUSTOM_ACP_KIND_PREFIX}${id}`;
}

/** True khi `kind` là kind của một CLI ACP tuỳ chỉnh (`custom-acp:<slug>`). */
export function isCustomAcpKind(kind: string): boolean {
  return typeof kind === 'string' && kind.startsWith(CUSTOM_ACP_KIND_PREFIX) && kind.length > CUSTOM_ACP_KIND_PREFIX.length;
}

/** Slug của CLI tuỳ chỉnh từ kind (`custom-acp:<slug>` → `<slug>`, khác thì null). */
export function customAcpIdFromKind(kind: string): string | null {
  if (!isCustomAcpKind(kind)) return null;
  return kind.slice(CUSTOM_ACP_KIND_PREFIX.length);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Cờ dòng lệnh bị từ chối vì trông như đang nhét key/token vào argv. */
const SECRET_FLAG_RE = /^(--api-key|--token|--auth-token|--access-token|--apikey)(=.*)?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArgList(value: unknown, field: string, opts: { min: number; max: number }): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`CLI tuỳ chỉnh: "${field}" phải là mảng chuỗi (vd ["acp"]).`);
  }
  if (value.length < opts.min || value.length > opts.max) {
    throw new Error(`CLI tuỳ chỉnh: "${field}" cần ${opts.min}–${opts.max} phần tử.`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 200 || item.includes('\0')) {
      throw new Error(`CLI tuỳ chỉnh: "${field}" chỉ nhận chuỗi không rỗng (tối đa 200 ký tự).`);
    }
    if (SECRET_FLAG_RE.test(item.trim())) {
      throw new Error(
        `CLI tuỳ chỉnh: không dùng cờ "${item.trim()}" — API key/token không được lưu vào cấu hình. Hãy đăng nhập bằng chính CLI đó rồi để open-bot mượn login của nó.`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

/**
 * Validate một cấu hình CLI ACP tuỳ chỉnh (dạng chưa biết) thành
 * `CustomAcpCliConfig` đã chuẩn hoá. Throw khi không hợp lệ (kèm lý
 * do rõ ràng để UI hiện cho user). Không kiểm tra file tồn tại ở đây
 * (registry kiểm tra thêm lúc thêm/sửa).
 */
export function validateCustomAcpCliConfig(input: unknown): CustomAcpCliConfig {
  if (!isRecord(input)) {
    throw new Error('CLI tuỳ chỉnh: cấu hình phải là object.');
  }
  const id = input['id'];
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    throw new Error(
      'CLI tuỳ chỉnh: "id" chỉ nhận chữ thường, số và gạch nối (vd "my-agent"), tối đa 32 ký tự.',
    );
  }
  const label = input['label'];
  if (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > 100) {
    throw new Error('CLI tuỳ chỉnh: "label" (tên hiển thị) không được để trống, tối đa 100 ký tự.');
  }
  const binaryPath = input['binaryPath'];
  if (
    typeof binaryPath !== 'string' ||
    binaryPath.trim().length === 0 ||
    binaryPath.includes('\0') ||
    !path.isAbsolute(binaryPath.trim())
  ) {
    throw new Error('CLI tuỳ chỉnh: "binaryPath" phải là đường dẫn tuyệt đối tới binary (vd "/usr/local/bin/my-agent").');
  }
  const acpArgs = validateArgList(input['acpArgs'], 'acpArgs', { min: 1, max: 20 });
  const out: CustomAcpCliConfig = {
    id,
    label: label.trim(),
    binaryPath: binaryPath.trim(),
    acpArgs,
  };
  if (input['statusArgs'] !== undefined) {
    out.statusArgs = validateArgList(input['statusArgs'], 'statusArgs', { min: 1, max: 10 });
  }
  return out;
}

/**
 * Dựng `DetectorDefinition` cho một CLI ACP tuỳ chỉnh: binary lấy
 * thẳng theo đường dẫn tuyệt đối (không tìm trên PATH), probe version
 * bằng `--version`, kiểm tra đăng nhập bằng `statusArgs` (nếu có)
 * hoặc trạng thái 'unknown' (nếu không có).
 */
export function customAcpDetectorDefinition(cfg: CustomAcpCliConfig): DetectorDefinition {
  return {
    kind: customAcpKind(cfg.id),
    label: cfg.label,
    binaries: [path.basename(cfg.binaryPath)],
    binaryPath: cfg.binaryPath,
    minVersion: '',
    versionArgs: ['--version'],
    auth: cfg.statusArgs
      ? {
          type: 'command',
          args: [...cfg.statusArgs],
          parse: (result) =>
            result.code === 0 && !result.timedOut ? { method: 'unknown' } : null,
        }
      : { type: 'none' },
  };
}
