/**
 * Team workspace registry (B-platform M4, LOCAL).
 *
 * Một team có thể có nhiều workspace đặt tên (thư mục dùng chung, vd
 * thư mục đồng bộ mà mọi member cùng trỏ tới), thay vì chỉ một
 * `workspaceDir` duy nhất trong team.json (v0.5). Registry là file
 * `<baseDir>/workspaces.json`: danh sách workspace, mỗi cái có id ổn
 * định, tên, đường dẫn TUYỆT ĐỐI, người tạo, thời gian tạo.
 *
 * Chỉ là registry (tên → đường dẫn): code này KHÔNG tạo thư mục,
 * KHÔNG kiểm tra thư mục tồn tại, KHÔNG đồng bộ file — host (main
 * process) quyết định thư mục có thật hay không khi dùng. Đường dẫn
 * phải tuyệt đối để không bị hiểu nhầm theo thư mục làm việc hiện tại.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const WORKSPACES_FILE = 'workspaces.json';

export interface TeamWorkspace {
  /** Id ổn định, `ws-<uuid>`. */
  id: string;
  /** Tên hiển thị, vd 'Dự án chung'. */
  name: string;
  /** Đường dẫn TUYỆT ĐỐI tới thư mục workspace. */
  rootDir: string;
  /** userId của người tạo. */
  createdBy: string;
  /** Epoch milliseconds khi tạo. */
  createdAt: number;
}

export interface CreateWorkspaceInput {
  name: string;
  rootDir: string;
  createdBy: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chuẩn hoá đường dẫn để so trùng: resolve + bỏ dấu `/` cuối. */
export function normalizeWorkspaceDir(dir: string): string {
  const resolved = path.resolve(dir);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

/** Validate một workspace đã parse; sai shape → throw (không echo nội dung). */
export function validateWorkspace(raw: unknown): TeamWorkspace {
  if (!isRecord(raw)) throw new Error('workspace phải là object.');
  const { id, name, rootDir, createdBy, createdAt } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('workspace cần id không rỗng.');
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('workspace cần name không rỗng.');
  }
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('workspace cần rootDir không rỗng.');
  }
  if (!path.isAbsolute(rootDir as string)) {
    throw new Error('workspace rootDir phải là đường dẫn tuyệt đối.');
  }
  if (typeof createdBy !== 'string' || createdBy.trim().length === 0) {
    throw new Error('workspace cần createdBy không rỗng.');
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    throw new Error('workspace cần createdAt là epoch ms > 0.');
  }
  return {
    id: (id as string).trim(),
    name: (name as string).trim(),
    rootDir: rootDir as string,
    createdBy: (createdBy as string).trim(),
    createdAt: createdAt as number,
  };
}

/** Validate toàn bộ danh sách; trùng id hoặc trùng rootDir → throw. */
export function validateWorkspaces(raw: unknown): TeamWorkspace[] {
  if (!Array.isArray(raw)) throw new Error('workspaces phải là mảng JSON.');
  const list = raw.map(validateWorkspace);
  const ids = new Set<string>();
  const dirs = new Set<string>();
  for (const ws of list) {
    if (ids.has(ws.id)) throw new Error(`workspaces trùng id "${ws.id}".`);
    ids.add(ws.id);
    const dir = normalizeWorkspaceDir(ws.rootDir);
    if (dirs.has(dir)) throw new Error(`workspaces trùng rootDir "${ws.rootDir}".`);
    dirs.add(dir);
  }
  return list;
}

export function getWorkspacesPath(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('getWorkspacesPath cần baseDir không rỗng.');
  }
  return path.join(baseDir, WORKSPACES_FILE);
}

/**
 * Đọc registry. File chưa có → []. JSON hỏng / shape sai → throw
 * (không echo nội dung file).
 */
export function loadWorkspaces(baseDir: string): TeamWorkspace[] {
  const filePath = getWorkspacesPath(baseDir);
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được ${WORKSPACES_FILE}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${WORKSPACES_FILE} hỏng (không phải JSON hợp lệ): ${(err as Error).message}`);
  }
  return validateWorkspaces(parsed);
}

/** Ghi registry (ghi atomic: file tạm + đổi tên). */
export function saveWorkspaces(baseDir: string, list: TeamWorkspace[]): void {
  const valid = validateWorkspaces(list);
  const filePath = getWorkspacesPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Tìm workspace theo id, hoặc undefined khi không có. */
export function findWorkspace(list: TeamWorkspace[], id: string): TeamWorkspace | undefined {
  return list.find((ws) => ws.id === id);
}

/**
 * Tạo workspace mới (pure — không ghi file). Trả về danh sách mới +
 * workspace vừa tạo. rootDir tương đối → throw; rootDir đã có trong
 * registry (sau chuẩn hoá) → throw; tên rỗng → throw.
 */
export function createWorkspace(
  list: TeamWorkspace[],
  input: CreateWorkspaceInput,
): { workspaces: TeamWorkspace[]; workspace: TeamWorkspace } {
  const valid = validateWorkspaces(list);
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('createWorkspace cần name không rỗng.');
  }
  if (typeof input.rootDir !== 'string' || !path.isAbsolute(input.rootDir)) {
    throw new Error('createWorkspace cần rootDir là đường dẫn tuyệt đối.');
  }
  if (typeof input.createdBy !== 'string' || input.createdBy.trim().length === 0) {
    throw new Error('createWorkspace cần createdBy không rỗng.');
  }
  const dir = normalizeWorkspaceDir(input.rootDir);
  if (valid.some((ws) => normalizeWorkspaceDir(ws.rootDir) === dir)) {
    throw new Error(`workspace đã tồn tại cho thư mục "${input.rootDir}".`);
  }
  const workspace: TeamWorkspace = {
    id: `ws-${randomUUID()}`,
    name: input.name.trim(),
    rootDir: input.rootDir,
    createdBy: input.createdBy.trim(),
    createdAt: Date.now(),
  };
  return { workspaces: [...valid, workspace], workspace };
}

/**
 * Xoá workspace theo id (pure — không ghi file). Id không có → throw.
 */
export function removeWorkspace(list: TeamWorkspace[], id: string): TeamWorkspace[] {
  const valid = validateWorkspaces(list);
  if (!valid.some((ws) => ws.id === id)) {
    throw new Error(`Không có workspace "${id}".`);
  }
  return valid.filter((ws) => ws.id !== id);
}

/**
 * Đổi tên workspace theo id (pure — không ghi file). Id không có
 * hoặc tên rỗng → throw.
 */
export function renameWorkspace(list: TeamWorkspace[], id: string, name: string): TeamWorkspace[] {
  const valid = validateWorkspaces(list);
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('renameWorkspace cần name không rỗng.');
  }
  let found = false;
  const next = valid.map((ws) => {
    if (ws.id !== id) return ws;
    found = true;
    return { ...ws, name: name.trim() };
  });
  if (!found) throw new Error(`Không có workspace "${id}".`);
  return next;
}
