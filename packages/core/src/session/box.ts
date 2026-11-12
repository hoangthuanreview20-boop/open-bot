/**
 * Session box — BẢN TƯƠNG ĐƯƠNG LOCAL (v0.7).
 *
 * ROADMAP §2c: "Phiên chạy trong hộp cát phía server (session box) — khi
 * có chế độ cloud/từ xa". Không có server/cloud nên open-bot triển khai
 * bản tương đương local: một "session box" là một phiên chạy tách biệt
 * trên chính máy người dùng.
 *
 * Mỗi session có:
 *   - workspace riêng: `<workspaceDir>/.open-bot/sessions/<id>/workspace/`
 *   - env allowlist riêng: chỉ TÊN biến môi trường, không bao giờ ghi
 *     giá trị/secret (`env.allowlist.json`).
 *   - giới hạn tài nguyên ghi trong metadata (`session.json`): giới hạn
 *     chỉ là METADATA CHƯA ENFORCE bằng cgroup/VM — giống
 *     `sandbox_prepare` ở v0.6, ghi rõ để không ai tưởng là giới hạn thật.
 *   - snapshot: khi kết thúc (hoặc bất cứ lúc nào), toàn bộ file trong
 *     workspace được sao chép sang
 *     `<sessionDir>/snapshots/<snapshotId>/` kèm manifest (đường dẫn,
 *     kích thước, sha256); `restoreSession` chép ngược lại để mở lại
 *     phiên từ đúng trạng thái đã snapshot.
 *
 * Đây KHÔNG phải hộp cát phía server, KHÔNG phải VM/container, và
 * KHÔNG cách ly tiến trình/mạng — chỉ là thư mục tách biệt + snapshot.
 * Mọi hàm đều đồng bộ (fs sync) như BotMemory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const SESSIONS_REL_DIR = path.join('.open-bot', 'sessions');

export interface SessionResourceLimits {
  /** Số file tối đa trong workspace (metadata — chưa enforce). */
  maxFiles?: number;
  /** Tổng dung lượng tối đa (bytes, metadata — chưa enforce). */
  maxTotalBytes?: number;
  /** Timeout mặc định cho lệnh chạy trong session, ms (metadata). */
  timeoutMs?: number;
  /** Số ký tự output tối đa (metadata — chưa enforce). */
  maxOutputChars?: number;
}

export type SessionStatus = 'active' | 'snapshotted' | 'restored' | 'destroyed';

export interface SessionBox {
  id: string;
  name: string;
  /** Thư mục gốc của session: `<workspaceDir>/.open-bot/sessions/<id>`. */
  dir: string;
  /** Thư mục làm việc của session: `<dir>/workspace`. */
  workspaceDir: string;
  /** Chỉ tên biến môi trường được phép — không bao giờ chứa giá trị. */
  envAllowlist: string[];
  limits: SessionResourceLimits;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** Id snapshot mới nhất (nếu đã snapshot). */
  lastSnapshotId?: string;
}

export interface SessionSnapshot {
  id: string;
  sessionId: string;
  createdAt: string;
  /** Đường dẫn tương đối (so với workspace của session) -> thông tin file. */
  files: Array<{ rel: string; size: number; sha256: string }>;
  note?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;

function sessionDir(workspaceDir: string, id: string): string {
  return path.join(workspaceDir, SESSIONS_REL_DIR, id);
}

function sessionMetaPath(dir: string): string {
  return path.join(dir, 'session.json');
}

function readSessionMeta(dir: string): SessionBox {
  const raw = fs.readFileSync(sessionMetaPath(dir), 'utf8');
  return JSON.parse(raw) as SessionBox;
}

function writeSessionMeta(session: SessionBox): void {
  fs.mkdirSync(session.dir, { recursive: true });
  const tmp = `${sessionMetaPath(session.dir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, sessionMetaPath(session.dir));
}

function sha256File(full: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(full));
  return hash.digest('hex');
}

/** Liệt kê mọi file dưới `root` (đệ quy, không theo symlink). */
function walkFiles(root: string): Array<{ rel: string; full: string }> {
  const out: Array<{ rel: string; full: string }> = [];
  const walk = (dir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push({ rel, full: path.join(dir, entry.name) });
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function copyDirContents(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of walkFiles(srcDir)) {
    const dest = path.join(destDir, ...file.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.full, dest);
  }
}

function clearDirContents(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    fs.rmSync(full, { recursive: true, force: true });
  }
}

/**
 * Tạo một session box mới (local). Trả về metadata của session.
 * `envVars` chỉ nhận TÊN biến; tên trông giống secret bị từ chối.
 */
export function createSession(
  workspaceDir: string,
  opts: { name?: string; envVars?: string[]; limits?: SessionResourceLimits } = {},
): SessionBox {
  const name = opts.name ?? `session-${new Date().toISOString().slice(0, 10)}`;
  if (!ID_RE.test(name) || name.includes('..')) {
    throw new Error(
      `Invalid session name "${name}": use letters, digits, ".", "-" and "_" only, starting with a letter or digit.`,
    );
  }
  const envAllowlist: string[] = validateEnvVarNames(opts.envVars ?? []);
  const id = `${name}-${randomUUID().slice(0, 8)}`;
  const dir = sessionDir(workspaceDir, id);
  if (fs.existsSync(dir)) throw new Error(`Session "${id}" already exists.`);
  const wsDir = path.join(dir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const now = new Date().toISOString();
  const session: SessionBox = {
    id,
    name,
    dir,
    workspaceDir: wsDir,
    envAllowlist: [...envAllowlist].sort(),
    limits: opts.limits ?? {},
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  // env.allowlist.json: chỉ tên biến — không bao giờ ghi giá trị/secret.
  fs.writeFileSync(
    path.join(dir, 'env.allowlist.json'),
    JSON.stringify(
      { allowedEnvVars: session.envAllowlist, note: 'Names only — never put secret values in this file.' },
      null,
      2,
    ),
    'utf8',
  );
  writeSessionMeta(session);
  return session;
}

/** Đọc metadata một session; ném lỗi rõ ràng khi session không tồn tại. */
export function getSession(workspaceDir: string, sessionId: string): SessionBox {
  const dir = sessionDir(workspaceDir, sessionId);
  try {
    return readSessionMeta(dir);
  } catch {
    throw new Error(`Unknown session "${sessionId}" (no session.json under .open-bot/sessions/).`);
  }
}

/**
 * Validate env var names the way createSession does: valid identifier
 * shape, and secret-looking names are rejected. Returns the deduped,
 * sorted allowlist. createSession uses this too, so the two paths can
 * never drift apart.
 */
function validateEnvVarNames(varNames: string[]): string[] {
  const out: string[] = [];
  for (const varName of varNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new Error(`Invalid env var name "${varName}".`);
    }
    if (SECRET_NAME_RE.test(varName)) {
      throw new Error(
        `Env var name "${varName}" looks like a secret and is not allowed in a session allowlist.`,
      );
    }
    if (!out.includes(varName)) out.push(varName);
  }
  return out.sort();
}

/**
 * v0.41 (P0-3, REA deep-dive lần 2 §3.3/§3.4 `ReplaceEnvToolCall`):
 * đổi biến môi trường của một session box ĐANG CHẠY — không cần tạo
 * lại box. Chỉ đổi allowlist TÊN biến (giống createSession: không bao
 * giờ ghi giá trị/secret); `merge: true` thì cộng thêm tên mới vào
 * allowlist hiện có, mặc định thay toàn bộ allowlist bằng `envVars`.
 * Ghi lại cả `session.json` lẫn `env.allowlist.json`, cập nhật
 * `updatedAt`. Giới hạn thật (local box không có process đang chạy
 * riêng để inject env vào): env mới áp dụng cho các lệnh chạy trong
 * box TỪ SAU lúc đổi — tiến trình nào đã chạy trước đó giữ env cũ.
 */
export function replaceSessionEnv(
  workspaceDir: string,
  sessionId: string,
  envVars: string[],
  opts: { merge?: boolean } = {},
): SessionBox {
  const session = getSession(workspaceDir, sessionId);
  const validated = validateEnvVarNames(envVars);
  const next = opts.merge
    ? [...new Set([...session.envAllowlist, ...validated])].sort()
    : validated;
  session.envAllowlist = next;
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(session.dir, 'env.allowlist.json'),
    JSON.stringify(
      { allowedEnvVars: session.envAllowlist, note: 'Names only — never put secret values in this file.' },
      null,
      2,
    ),
    'utf8',
  );
  writeSessionMeta(session);
  return session;
}

/**
 * Chụp snapshot trạng thái hiện tại của session: sao chép toàn bộ file
 * trong workspace sang `snapshots/<snapshotId>/` kèm manifest
 * (đường dẫn, kích thước, sha256). Trả về manifest snapshot.
 */
export function snapshotSession(
  workspaceDir: string,
  sessionId: string,
  note?: string,
): SessionSnapshot {
  const session = getSession(workspaceDir, sessionId);
  const snapshotId = `snap-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const snapDir = path.join(session.dir, 'snapshots', snapshotId);
  fs.mkdirSync(snapDir, { recursive: true });
  const files: SessionSnapshot['files'] = [];
  for (const file of walkFiles(session.workspaceDir)) {
    const dest = path.join(snapDir, ...file.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.full, dest);
    const size = fs.statSync(file.full).size;
    files.push({ rel: file.rel, size, sha256: sha256File(file.full) });
  }
  const snapshot: SessionSnapshot = {
    id: snapshotId,
    sessionId,
    createdAt: new Date().toISOString(),
    files,
    note,
  };
  fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  session.status = 'snapshotted';
  session.lastSnapshotId = snapshotId;
  session.updatedAt = new Date().toISOString();
  writeSessionMeta(session);
  return snapshot;
}

/** Liệt kê các snapshot đã chụp của một session (mới nhất trước). */
export function listSnapshots(workspaceDir: string, sessionId: string): SessionSnapshot[] {
  const session = getSession(workspaceDir, sessionId);
  const snapsDir = path.join(session.dir, 'snapshots');
  if (!fs.existsSync(snapsDir)) return [];
  const out: SessionSnapshot[] = [];
  for (const entry of fs.readdirSync(snapsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(snapsDir, entry.name, 'manifest.json');
    try {
      out.push(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SessionSnapshot);
    } catch {
      // Snapshot dở dang (không có manifest) — bỏ qua, không crash.
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/**
 * Mở lại session từ một snapshot: xoá nội dung workspace hiện tại rồi
 * chép file từ snapshot về. `snapshotId` mặc định là snapshot mới nhất.
 * Trả về metadata session đã cập nhật (status 'restored').
 */
export function restoreSession(
  workspaceDir: string,
  sessionId: string,
  snapshotId?: string,
): SessionBox {
  const session = getSession(workspaceDir, sessionId);
  const snaps = listSnapshots(workspaceDir, sessionId);
  const target =
    snapshotId !== undefined
      ? snaps.find((s) => s.id === snapshotId)
      : snaps[0];
  if (!target) {
    throw new Error(
      snapshotId !== undefined
        ? `Session "${sessionId}" has no snapshot "${snapshotId}".`
        : `Session "${sessionId}" has no snapshots yet — snapshot it first with snapshotSession().`,
    );
  }
  const snapDir = path.join(session.dir, 'snapshots', target.id);
  clearDirContents(session.workspaceDir);
  copyDirContents(snapDir, session.workspaceDir);
  // manifest.json cũng bị chép vào workspace — dọn nó ra, nó chỉ thuộc về snapshot.
  const strayManifest = path.join(session.workspaceDir, 'manifest.json');
  if (fs.existsSync(strayManifest)) fs.unlinkSync(strayManifest);
  session.status = 'restored';
  session.updatedAt = new Date().toISOString();
  writeSessionMeta(session);
  return session;
}

/** Liệt kê mọi session box trong workspace (mới nhất trước). */
export function listSessions(workspaceDir: string): SessionBox[] {
  const root = path.join(workspaceDir, SESSIONS_REL_DIR);
  if (!fs.existsSync(root)) return [];
  const out: SessionBox[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(readSessionMeta(path.join(root, entry.name)));
    } catch {
      // Thư mục không có session.json hợp lệ — bỏ qua, không crash.
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/**
 * Xoá vĩnh viễn một session box (thư mục + workspace + snapshot).
 * Trả về true khi đã xoá, false khi session không tồn tại.
 */
export function destroySession(workspaceDir: string, sessionId: string): boolean {
  const dir = sessionDir(workspaceDir, sessionId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
