/**
 * Fleet registry — đăng ký workspace (đội D).
 *
 * Một workspace = 1 OS user + 1 service + 1 port loopback + 1 thư mục
 * dữ liệu riêng. Registry là file `fleet.json` trong thư mục gốc của
 * fleet, ghi atomic (file tạm + đổi tên) như team/workspaces.ts.
 *
 * Chỉ là registry thuần (không I/O ngoài đọc/ghi file) — tạo thư mục,
 * cấp phát port, chạy service là việc của FleetManager.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CreateFleetWorkspaceInput,
  FleetMember,
  FleetRole,
  FleetWorkspace,
} from './types';
import { FLEET_ROLES } from './types';

export const FLEET_REGISTRY_FILE = 'fleet.json';
/** CPU tối thiểu cấp cho một workspace (core). */
export const FLEET_MIN_CPU_CORES = 0.5;
/** RAM tối thiểu cấp cho một workspace (128 MB). */
export const FLEET_MIN_RAM_BYTES = 128 * 1024 ** 2;
/** Đĩa tối thiểu cấp cho một workspace (1 GB). */
export const FLEET_MIN_DISK_BYTES = 1024 ** 3;
/** Dải port mặc định khi cấp tự động. */
export const FLEET_AUTO_PORT_MIN = 18000;
export const FLEET_AUTO_PORT_MAX = 18999;

const OS_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateFleetMember(raw: unknown): FleetMember {
  if (!isRecord(raw)) throw new Error('fleet member phải là object.');
  const { userId, role, addedBy, addedAt } = raw;
  if (!isNonEmptyString(userId)) throw new Error('fleet member cần userId không rỗng.');
  if (typeof role !== 'string' || !(FLEET_ROLES as readonly string[]).includes(role)) {
    throw new Error(`fleet member role phải là một trong: ${FLEET_ROLES.join(', ')}.`);
  }
  if (!isNonEmptyString(addedBy)) throw new Error('fleet member cần addedBy không rỗng.');
  if (!isNonEmptyString(addedAt)) throw new Error('fleet member cần addedAt không rỗng.');
  return { userId, role: role as FleetRole, addedBy, addedAt };
}

/** Validate một workspace đã parse; sai shape → throw (không echo nội dung). */
export function validateFleetWorkspace(raw: unknown): FleetWorkspace {
  if (!isRecord(raw)) throw new Error('fleet workspace phải là object.');
  const {
    id, name, osUser, serviceName, port, rootDir, cpuCores, ramBytes, diskBytes,
    members, status, serviceState, pid, isolationLevel, isolationReason,
    lastError, createdBy, createdAt, updatedAt,
  } = raw;
  if (!isNonEmptyString(id)) throw new Error('fleet workspace cần id không rỗng.');
  if (!isNonEmptyString(name)) throw new Error('fleet workspace cần name không rỗng.');
  if (typeof osUser !== 'string' || !OS_USER_RE.test(osUser)) {
    throw new Error('fleet workspace cần osUser hợp lệ (chữ thường, số, _ -, bắt đầu bằng chữ hoặc _).');
  }
  if (typeof serviceName !== 'string' || !SERVICE_NAME_RE.test(serviceName)) {
    throw new Error('fleet workspace cần serviceName hợp lệ (chữ thường, số, _ -).');
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('fleet workspace cần port là số nguyên 1024–65535.');
  }
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
    throw new Error('fleet workspace cần rootDir là đường dẫn tuyệt đối.');
  }
  if (typeof cpuCores !== 'number' || !Number.isFinite(cpuCores) || cpuCores < FLEET_MIN_CPU_CORES) {
    throw new Error(`fleet workspace cần cpuCores >= ${FLEET_MIN_CPU_CORES}.`);
  }
  if (typeof ramBytes !== 'number' || !Number.isFinite(ramBytes) || ramBytes < FLEET_MIN_RAM_BYTES) {
    throw new Error(`fleet workspace cần ramBytes >= ${FLEET_MIN_RAM_BYTES}.`);
  }
  if (typeof diskBytes !== 'number' || !Number.isFinite(diskBytes) || diskBytes < FLEET_MIN_DISK_BYTES) {
    throw new Error(`fleet workspace cần diskBytes >= ${FLEET_MIN_DISK_BYTES}.`);
  }
  if (!Array.isArray(members)) throw new Error('fleet workspace cần members là mảng.');
  const parsedMembers = members.map(validateFleetMember);
  if (status !== 'active' && status !== 'suspended') {
    throw new Error("fleet workspace status phải là 'active' hoặc 'suspended'.");
  }
  if (serviceState !== 'stopped' && serviceState !== 'starting' && serviceState !== 'running' && serviceState !== 'error') {
    throw new Error("fleet workspace serviceState phải là 'stopped', 'starting', 'running' hoặc 'error'.");
  }
  if (pid !== undefined && (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)) {
    throw new Error('fleet workspace pid (khi có) phải là số nguyên > 0.');
  }
  if (isolationLevel !== 'directory' && isolationLevel !== 'os-user') {
    throw new Error("fleet workspace isolationLevel phải là 'directory' hoặc 'os-user'.");
  }
  if (isolationReason !== undefined && typeof isolationReason !== 'string') {
    throw new Error('fleet workspace isolationReason (khi có) phải là chuỗi.');
  }
  if (lastError !== undefined && typeof lastError !== 'string') {
    throw new Error('fleet workspace lastError (khi có) phải là chuỗi.');
  }
  if (!isNonEmptyString(createdBy)) throw new Error('fleet workspace cần createdBy không rỗng.');
  if (!isNonEmptyString(createdAt)) throw new Error('fleet workspace cần createdAt không rỗng.');
  if (!isNonEmptyString(updatedAt)) throw new Error('fleet workspace cần updatedAt không rỗng.');
  return {
    id,
    name,
    osUser,
    serviceName,
    port,
    rootDir,
    cpuCores,
    ramBytes,
    diskBytes,
    members: parsedMembers,
    status,
    serviceState,
    ...(pid !== undefined ? { pid } : {}),
    isolationLevel,
    ...(isolationReason !== undefined ? { isolationReason } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    createdBy,
    createdAt,
    updatedAt,
  };
}

export function validateFleetWorkspaces(raw: unknown): FleetWorkspace[] {
  if (!Array.isArray(raw)) throw new Error('fleet registry phải là mảng.');
  const list = raw.map(validateFleetWorkspace);
  const seen = new Map<string, string>();
  for (const ws of list) {
    for (const [key, value] of [
      ['id', ws.id],
      ['name', ws.name],
      ['osUser', ws.osUser],
      ['serviceName', ws.serviceName],
      ['port', String(ws.port)],
      ['rootDir', ws.rootDir],
    ] as const) {
      const seenKey = `${key}:${value}`;
      if (seen.has(seenKey)) throw new Error(`fleet registry trùng ${key}: ${value}.`);
      seen.set(seenKey, ws.id);
    }
  }
  return list;
}

export function getFleetRegistryPath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('getFleetRegistryPath cần rootDir không rỗng.');
  }
  return path.join(rootDir, FLEET_REGISTRY_FILE);
}

/**
 * Đọc registry. File chưa có → []. JSON hỏng / shape sai → throw
 * (không echo nội dung file).
 */
export function loadFleetWorkspaces(rootDir: string): FleetWorkspace[] {
  const filePath = getFleetRegistryPath(rootDir);
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được ${FLEET_REGISTRY_FILE}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${FLEET_REGISTRY_FILE} hỏng (không phải JSON hợp lệ): ${(err as Error).message}`);
  }
  return validateFleetWorkspaces(parsed);
}

/** Ghi registry (ghi atomic: file tạm + đổi tên, 0600). */
export function saveFleetWorkspaces(rootDir: string, list: FleetWorkspace[]): void {
  const valid = validateFleetWorkspaces(list);
  const filePath = getFleetRegistryPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows không có chmod POSIX — bỏ qua.
  }
  fs.renameSync(tmp, filePath);
}

export function findFleetWorkspace(list: FleetWorkspace[], id: string): FleetWorkspace | undefined {
  return list.find((ws) => ws.id === id);
}

/** Port trống đầu tiên trong dải tự động (chưa có workspace nào dùng). */
export function pickFreePort(list: FleetWorkspace[]): number {
  const used = new Set(list.map((ws) => ws.port));
  for (let port = FLEET_AUTO_PORT_MIN; port <= FLEET_AUTO_PORT_MAX; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error('Hết port trống trong dải cấp tự động cho fleet (18000–18999).');
}

/**
 * Tạo workspace mới trong danh sách (thuần — không ghi file, không tạo
 * thư mục). Trùng tên/osUser/serviceName/port/rootDir → throw.
 * rootDir mặc định do caller truyền vào (FleetManager tính từ id).
 */
export function createFleetWorkspace(
  list: FleetWorkspace[],
  input: CreateFleetWorkspaceInput & { rootDir: string },
): { list: FleetWorkspace[]; workspace: FleetWorkspace } {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('Tên workspace không được rỗng.');
  const osUser = input.osUser.trim();
  if (!OS_USER_RE.test(osUser)) {
    throw new Error('osUser không hợp lệ (chữ thường, số, _ -, bắt đầu bằng chữ hoặc _).');
  }
  const serviceName = (input.serviceName ?? `open-bot-${osUser}`).trim();
  if (!SERVICE_NAME_RE.test(serviceName)) {
    throw new Error('serviceName không hợp lệ (chữ thường, số, _ -).');
  }
  const port = input.port ?? pickFreePort(list);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('port phải là số nguyên 1024–65535.');
  }
  if (typeof input.rootDir !== 'string' || !path.isAbsolute(input.rootDir)) {
    throw new Error('fleet workspace cần rootDir là đường dẫn tuyệt đối.');
  }
  const rootDir = path.resolve(input.rootDir);
  const cpuCores = input.cpuCores ?? 1;
  const ramBytes = input.ramBytes ?? 512 * 1024 ** 2;
  const diskBytes = input.diskBytes ?? 10 * 1024 ** 3;
  if (typeof cpuCores !== 'number' || !Number.isFinite(cpuCores) || cpuCores < FLEET_MIN_CPU_CORES) {
    throw new Error(`cpuCores phải >= ${FLEET_MIN_CPU_CORES}.`);
  }
  if (typeof ramBytes !== 'number' || !Number.isFinite(ramBytes) || ramBytes < FLEET_MIN_RAM_BYTES) {
    throw new Error(`ramBytes phải >= ${FLEET_MIN_RAM_BYTES}.`);
  }
  if (typeof diskBytes !== 'number' || !Number.isFinite(diskBytes) || diskBytes < FLEET_MIN_DISK_BYTES) {
    throw new Error(`diskBytes phải >= ${FLEET_MIN_DISK_BYTES}.`);
  }
  for (const ws of list) {
    if (input.id !== undefined && ws.id === input.id) throw new Error(`Đã có workspace id "${input.id}".`);
    if (ws.name === name) throw new Error(`Đã có workspace tên "${name}".`);
    if (ws.osUser === osUser) throw new Error(`OS user "${osUser}" đã dùng cho workspace khác.`);
    if (ws.serviceName === serviceName) throw new Error(`Đã có service tên "${serviceName}".`);
    if (ws.port === port) throw new Error(`Port ${port} đã dùng cho workspace khác.`);
    if (path.resolve(ws.rootDir) === rootDir) throw new Error(`Thư mục "${rootDir}" đã dùng cho workspace khác.`);
  }
  const now = new Date().toISOString();
  const workspace: FleetWorkspace = {
    id: input.id !== undefined && input.id.trim() !== '' ? input.id.trim() : `fw-${randomUUID()}`,
    name,
    osUser,
    serviceName,
    port,
    rootDir,
    cpuCores,
    ramBytes,
    diskBytes,
    members: [],
    status: 'active',
    serviceState: 'stopped',
    isolationLevel: 'directory',
    isolationReason: 'chưa chạy đặc quyền — cô lập ở mức thư mục + port + vault namespace riêng.',
    createdBy: (input.createdBy ?? 'system').trim() || 'system',
    createdAt: now,
    updatedAt: now,
  };
  return { list: [...list, workspace], workspace };
}

/** Xoá workspace khỏi danh sách (thuần). Không có id → throw. */
export function removeFleetWorkspace(list: FleetWorkspace[], id: string): FleetWorkspace[] {
  if (!findFleetWorkspace(list, id)) throw new Error(`Không có workspace fleet "${id}".`);
  return list.filter((ws) => ws.id !== id);
}

/** Đổi tên workspace (thuần). Trùng tên → throw. */
export function renameFleetWorkspace(list: FleetWorkspace[], id: string, name: string): FleetWorkspace[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('Tên workspace không được rỗng.');
  const ws = findFleetWorkspace(list, id);
  if (!ws) throw new Error(`Không có workspace fleet "${id}".`);
  if (list.some((other) => other.id !== id && other.name === trimmed)) {
    throw new Error(`Đã có workspace tên "${trimmed}".`);
  }
  return list.map((other) =>
    other.id === id ? { ...other, name: trimmed, updatedAt: new Date().toISOString() } : other,
  );
}

/** Cập nhật một workspace trong danh sách (thuần — dùng cho serviceState/pid/...). */
export function updateFleetWorkspace(
  list: FleetWorkspace[],
  id: string,
  patch: Partial<FleetWorkspace>,
): FleetWorkspace[] {
  const ws = findFleetWorkspace(list, id);
  if (!ws) throw new Error(`Không có workspace fleet "${id}".`);
  const next: FleetWorkspace = { ...ws, ...patch, id: ws.id, updatedAt: new Date().toISOString() };
  return list.map((other) => (other.id === id ? validateFleetWorkspace(next) : other));
}

/** Đổi trạng thái đăng ký của workspace (active/suspended). */
export function setFleetWorkspaceStatus(
  list: FleetWorkspace[],
  id: string,
  status: 'active' | 'suspended',
): FleetWorkspace[] {
  return updateFleetWorkspace(list, id, { status });
}
