/**
 * Cô lập workspace fleet (đội D).
 *
 * Ba biên cô lập:
 * 1. Đường dẫn: mọi đọc/ghi file của một workspace phải nằm trong
 *    rootDir của workspace đó. Kiểm tra bằng realpath (chống symlink
 *    trỏ ra ngoài) + kiểm tra tiền tố; vi phạm → throw, fail-closed.
 *    Không có ngoại lệ "đọc nhờ" workspace khác.
 * 2. Vault: secret tách theo workspace bằng namespace `fleet:<id>`.
 *    Module này chỉ định nghĩa tên — Vault thật vẫn do caller quản.
 * 3. OS user: mức 'os-user' chỉ thật khi process chạy đặc quyền
 *    (root) VÀ OS user đã tồn tại VÀ child được spawn với uid đó.
 *    Còn không thì mức là 'directory' + lý do rõ ràng.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FleetIsolationLevel, FleetWorkspace } from './types';

/** Namespace Vault của workspace (secret không bao giờ lẫn nhau). */
export function fleetVaultNamespace(workspaceId: string): string {
  return `fleet:${workspaceId}`;
}

/** Key Vault đầy đủ của một workspace (namespace + key gốc). */
export function fleetVaultKey(workspaceId: string, key: string): string {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new Error('fleetVaultKey cần workspaceId không rỗng.');
  }
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('fleetVaultKey cần key không rỗng.');
  }
  return `${fleetVaultNamespace(workspaceId)}:${key}`;
}

/**
 * Kiểm tra OS user có tồn tại trên máy không (best-effort).
 * Linux/macOS: `id -u <user>` (đồng bộ, không throw khi không có).
 * Windows: chưa hỗ trợ kiểm tra thật → { exists: false, detail }.
 */
export function probeOsUser(osUser: string): { exists: boolean; detail: string } {
  if (process.platform === 'win32') {
    return { exists: false, detail: 'chưa kiểm tra được OS user trên Windows.' };
  }
  try {
    execFileSync('id', ['-u', osUser], { stdio: 'ignore', timeout: 5000 });
    return { exists: true, detail: `OS user "${osUser}" đã tồn tại.` };
  } catch {
    return { exists: false, detail: `OS user "${osUser}" chưa tồn tại trên máy.` };
  }
}

/** Process hiện tại có đang chạy đặc quyền (root) không (POSIX). */
export function isRunningPrivileged(): boolean {
  if (process.platform === 'win32') return false;
  try {
    return typeof process.geteuid === 'function' && process.geteuid() === 0;
  } catch {
    return false;
  }
}

/**
 * Quyết định mức cô lập thật của workspace (thuần, test trực tiếp).
 * 'os-user' chỉ khi cả 3 điều kiện đúng; còn không thì 'directory'
 * kèm lý do — không bao giờ báo cao hơn thực tế.
 */
export function resolveIsolationLevel(input: {
  runningAsRoot: boolean;
  osUserExists: boolean;
  platform: NodeJS.Platform;
}): { level: FleetIsolationLevel; reason?: string } {
  if (input.platform === 'win32') {
    return {
      level: 'directory',
      reason: 'Windows chưa hỗ trợ spawn service với OS user khác — cô lập ở mức thư mục + port + vault namespace riêng.',
    };
  }
  if (!input.runningAsRoot) {
    return {
      level: 'directory',
      reason: 'chưa chạy đặc quyền (cần root để spawn service với OS user khác) — cô lập ở mức thư mục + port + vault namespace riêng.',
    };
  }
  if (!input.osUserExists) {
    return {
      level: 'directory',
      reason: 'OS user chưa tồn tại trên máy (cần tạo trước bằng quyền admin) — cô lập ở mức thư mục + port + vault namespace riêng.',
    };
  }
  return { level: 'os-user' };
}

/** Lấy uid số của OS user (POSIX, khi tồn tại) — null khi không đo được. */
export function getOsUserUid(osUser: string): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('id', ['-u', osUser], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const uid = Number.parseInt(String(out).trim(), 10);
    return Number.isInteger(uid) && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

/**
 * Giải quyết đường dẫn đích trong workspace và kiểm tra nó nằm trong
 * rootDir (chống `..` và symlink trỏ ra ngoài). Đường dẫn chưa tồn
 * tại thì realpath thư mục cha gần nhất còn tồn tại rồi kiểm tra tiếp.
 * Vi phạm → throw (fail-closed). Trả về đường dẫn tuyệt đối đã chuẩn hoá.
 */
export function resolveFleetWorkspacePath(workspace: FleetWorkspace, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    throw new Error('Đường dẫn trong workspace không được rỗng.');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error('Đường dẫn trong workspace phải là đường dẫn tương đối.');
  }
  const rootReal = realpathExisting(workspace.rootDir);
  const targetAbs = path.resolve(workspace.rootDir, relPath);
  // Tìm thư mục cha gần nhất còn tồn tại để realpath (chống symlink).
  let probe = targetAbs;
  const missing: string[] = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missing.unshift(path.basename(probe));
    probe = parent;
  }
  const probeReal = realpathExisting(probe);
  const targetReal = path.join(probeReal, ...missing);
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`Đường dẫn "${relPath}" nằm ngoài workspace "${workspace.name}" (đã chặn).`);
  }
  return targetReal;
}

function realpathExisting(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Đọc file trong workspace (fail-closed khi nằm ngoài workspace).
 * Trả về nội dung UTF-8. File không tồn tại → throw.
 */
export function readWorkspaceFile(workspace: FleetWorkspace, relPath: string): string {
  const target = resolveFleetWorkspacePath(workspace, relPath);
  return fs.readFileSync(target, 'utf8');
}

/**
 * Ghi file trong workspace (fail-closed khi nằm ngoài workspace).
 * Tạo thư mục cha khi cần. Ghi atomic (file tạm + đổi tên).
 */
export function writeWorkspaceFile(workspace: FleetWorkspace, relPath: string, content: string): void {
  const target = resolveFleetWorkspacePath(workspace, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/** Thư mục gốc của fleet (để kiểm tra rootDir workspace nằm trong đó). */
export function assertWorkspaceRootInsideFleet(fleetRoot: string, rootDir: string): void {
  const fleetReal = realpathExisting(path.resolve(fleetRoot));
  const dirReal = realpathExisting(path.resolve(rootDir));
  if (dirReal !== fleetReal && !dirReal.startsWith(`${fleetReal}${path.sep}`)) {
    throw new Error('Thư mục workspace phải nằm trong thư mục gốc của fleet.');
  }
}

/** Tên host + user hiện tại (để ghi audit actor mặc định). */
export function currentOsUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}
