/**
 * Shadow workspace / git worktree — v0.14 mục 5.
 *
 * Cho agent song song: mỗi subagent làm việc trên một git worktree
 * riêng (thư mục riêng, branch riêng) thay vì cùng đụng vào workspace
 * chính, để tránh xung đột file khi nhiều agent chạy cùng lúc.
 *
 * Module thuần Node stdlib (child_process + fs + path), không gọi
 * mạng, không chạm coordinator/loop. Mọi lệnh git chạy qua
 * `child_process.execFile('git', [...args])` với timeout 30s — KHÔNG
 * dùng shell string, và tên branch/id được validate trước khi đưa
 * vào args (chống injection qua tên branch).
 *
 * Quy ước đặt tên:
 * - Thư mục worktree: `<worktreesDir>/wt-<id>` (id 8 ký tự hex ngẫu nhiên).
 * - Branch do open-bot tạo: `wt/<prefix>-<id>` (mặc định prefix `agent`),
 *   tạo từ `baseBranch` (mặc định HEAD). Branch này được xoá khi
 *   `remove()` dọn worktree; branch người dùng tạo sẵn (truyền vào
 *   qua `branch`) thì KHÔNG bị xoá.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Timeout mặc định cho mỗi lệnh git (30s). */
export const GIT_TIMEOUT_MS = 30_000;

/** Thư mục con mặc định chứa worktree, nằm trong repo. */
export const DEFAULT_WORKTREES_DIRNAME = '.open-bot/worktrees';

/** Chỉ cho phép ký tự an toàn trong tên branch / id / prefix. */
const SAFE_NAME_RE = /^[A-Za-z0-9._\/-]+$/;
/** Branch do open-bot tạo: wt/<prefix>-<8 ký tự hex>. */
const MANAGED_BRANCH_RE = /^wt\/[A-Za-z0-9._-]{1,64}-[0-9a-f]{8}$/;
/** Id worktree: 8 ký tự hex. */
const WORKTREE_ID_RE = /^[0-9a-f]{8}$/;

/** Thông tin một worktree do open-bot quản lý. */
export interface WorktreeInfo {
  /** Id 8 ký tự hex (cũng là hậu tố của thư mục wt-<id>). */
  id: string;
  /** Đường dẫn tuyệt đối tới thư mục worktree. */
  path: string;
  /** Branch worktree đang checkout ('' khi detached). */
  branch: string;
  /** True khi worktree đang ở trạng thái detached (không có branch). */
  detached: boolean;
  /** Thời điểm tạo (ISO string). */
  createdAt: string;
}

export interface CreateWorktreeOptions {
  /** Branch có sẵn để checkout; không có thì tạo branch mới wt/<prefix>-<id>. */
  branch?: string;
  /** Branch gốc để tạo branch mới (mặc định HEAD). */
  baseBranch?: string;
  /** Tiền tố của branch mới (mặc định 'agent'). */
  prefix?: string;
}

export interface RemoveWorktreeOptions {
  /** Ép buộc xoá kể cả khi worktree có thay đổi chưa commit. */
  force?: boolean;
}

export interface CleanupStaleOptions {
  /** Chỉ dọn worktree cũ hơn ngưỡng này (mặc định 24h). */
  maxAgeMs?: number;
  /** Ép buộc xoá kể cả khi worktree có thay đổi chưa commit. */
  force?: boolean;
}

/** Tuổi mặc định để một worktree bị coi là cũ (24h). */
export const DEFAULT_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isSafeName(value: string): boolean {
  return (
    SAFE_NAME_RE.test(value) &&
    !value.includes('..') &&
    !value.startsWith('/') &&
    !value.startsWith('-') &&
    !value.endsWith('/') &&
    !value.includes('//')
  );
}

/** Validate tên branch/id/prefix; ném lỗi tiếng Việt rõ ràng khi không hợp lệ. */
export function validateGitName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new Error(`${label} không được rỗng.`);
  if (!isSafeName(name)) {
    throw new Error(
      `${label} không hợp lệ: "${value}" — chỉ dùng chữ cái, số, '.', '_', '-', '/' ` +
        `(không '..', không bắt đầu bằng '/' hay '-', không ký tự shell như ';', '&', '$').`,
    );
  }
  return name;
}

/** Chạy một lệnh git bằng execFile (không shell); lỗi trả về message tiếng Việt. */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim() || String(stdout ?? '').trim();
          const reason =
            (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
              ? `lệnh git hết thời gian sau ${GIT_TIMEOUT_MS}ms`
              : detail || error.message;
          reject(new Error(`Lệnh git thất bại (git ${args.join(' ')}): ${reason}`));
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

/** Kiểm tra repoDir có phải git repo không; không phải thì ném lỗi tiếng Việt. */
async function assertGitRepo(repoDir: string): Promise<void> {
  try {
    await runGit(['rev-parse', '--git-dir'], repoDir);
  } catch {
    throw new Error(
      `Thư mục "${repoDir}" không phải git repo — khởi tạo bằng 'git init' trước khi tạo worktree.`,
    );
  }
}

/** Branch đã tồn tại trong repo chưa (kiểm tra qua show-ref). */
async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoDir);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

/**
 * Quản lý git worktree cho agent song song trong một repo.
 * - `repoDir`: thư mục gốc của repo (phải là git repo).
 * - `worktreesDir`: nơi chứa các worktree, mặc định
 *   `<repoDir>/.open-bot/worktrees`.
 */
export class WorktreeManager {
  readonly repoDir: string;
  readonly worktreesDir: string;

  constructor(repoDir: string, worktreesDir?: string) {
    if (!repoDir || !repoDir.trim()) {
      throw new Error('WorktreeManager cần `repoDir` không rỗng.');
    }
    this.repoDir = path.resolve(repoDir);
    this.worktreesDir = path.resolve(
      worktreesDir?.trim() ? worktreesDir : path.join(this.repoDir, DEFAULT_WORKTREES_DIRNAME),
    );
  }

  /**
   * Tạo worktree mới.
   * - Có `branch`: checkout branch đó nếu đã tồn tại, nếu chưa thì tạo
   *   branch mới với đúng tên đó từ `baseBranch` (mặc định HEAD).
   * - Không có `branch`: tạo branch mới `wt/<prefix>-<id>` từ
   *   `baseBranch` (mặc định HEAD), id 8 ký tự hex ngẫu nhiên.
   * Trả về `{ id, path, branch, detached, createdAt }`.
   * Repo không phải git → lỗi rõ ràng; tên branch/baseBranch/prefix
   * độc hại → bị chặn trước khi chạy git.
   */
  async create(opts: CreateWorktreeOptions = {}): Promise<WorktreeInfo> {
    await assertGitRepo(this.repoDir);
    const prefix = opts.prefix !== undefined ? validateGitName(opts.prefix, 'Tiền tố branch (prefix)') : 'agent';
    const baseBranch = opts.baseBranch !== undefined ? validateGitName(opts.baseBranch, 'Branch gốc (baseBranch)') : undefined;
    const id = randomBytes(4).toString('hex');
    const targetPath = path.join(this.worktreesDir, `wt-${id}`);
    fs.mkdirSync(this.worktreesDir, { recursive: true });

    let branch: string;
    let detached = false;
    try {
      if (opts.branch !== undefined) {
        branch = validateGitName(opts.branch, 'Branch');
        const args: string[] = ['worktree', 'add', targetPath];
        if (await branchExists(this.repoDir, branch)) {
          args.push(branch);
        } else {
          args.push('-b', branch);
          if (baseBranch) args.push(baseBranch);
        }
        await runGit(args, this.repoDir);
      } else {
        branch = `wt/${prefix}-${id}`;
        const args: string[] = ['worktree', 'add', targetPath, '-b', branch];
        if (baseBranch) args.push(baseBranch);
        await runGit(args, this.repoDir);
      }
    } catch (err) {
      // Dọn thư mục dở dang nếu git thất bại giữa chừng.
      try {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } catch {
        // Bỏ qua: thư mục có thể chưa được tạo.
      }
      throw err;
    }
    return { id, path: targetPath, branch, detached, createdAt: new Date().toISOString() };
  }

  /**
   * Liệt kê worktree do open-bot quản lý: đọc
   * `git worktree list --porcelain`, chỉ giữ các worktree nằm trong
   * `worktreesDir` (thư mục chính của repo và worktree ngoài đều bị loại).
   */
  async list(): Promise<WorktreeInfo[]> {
    await assertGitRepo(this.repoDir);
    const out = await runGit(['worktree', 'list', '--porcelain'], this.repoDir);
    const managedRoot = path.resolve(this.worktreesDir) + path.sep;
    const result: WorktreeInfo[] = [];
    let current: { path?: string; branch?: string; detached?: boolean } | null = null;
    const flush = (): void => {
      if (!current?.path) return;
      const resolved = path.resolve(current.path);
      if (!resolved.startsWith(managedRoot)) return;
      const base = path.basename(resolved);
      const match = /^wt-([0-9a-f]{8})$/.exec(base);
      if (!match) return;
      result.push({
        id: match[1],
        path: resolved,
        branch: current.branch ?? '',
        detached: current.detached ?? false,
        createdAt: this.readCreatedAt(resolved),
      });
    };
    for (const line of out.split('\n')) {
      if (line === '') {
        flush();
        current = null;
        continue;
      }
      if (!current) current = {};
      if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      else if (line === 'detached') current.detached = true;
    }
    flush();
    return result;
  }

  /** Thời điểm tạo worktree (đọc từ mtime của thư mục; fallback epoch khi không đọc được). */
  private readCreatedAt(worktreePath: string): string {
    try {
      return fs.statSync(worktreePath).mtime.toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  }

  /**
   * Xoá một worktree: `git worktree remove` (+ `--force` khi `force`).
   * Branch do open-bot tạo (`wt/<prefix>-<id>`) cũng bị xoá; branch
   * người dùng tạo sẵn thì giữ nguyên. Worktree không tồn tại → lỗi rõ ràng.
   */
  async remove(id: string, opts: RemoveWorktreeOptions = {}): Promise<void> {
    await assertGitRepo(this.repoDir);
    const cleanId = validateGitName(id, 'Id worktree');
    if (!WORKTREE_ID_RE.test(cleanId)) {
      throw new Error(`Id worktree không hợp lệ: "${id}" — id là 8 ký tự hex (vd "a1b2c3d4").`);
    }
    const found = (await this.list()).find((w) => w.id === cleanId);
    if (!found) {
      throw new Error(`Không tìm thấy worktree "${cleanId}" trong "${this.worktreesDir}" — kiểm tra lại id (dùng list() để xem).`);
    }
    const args = ['worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(found.path);
    await runGit(args, this.repoDir);
    if (found.branch && MANAGED_BRANCH_RE.test(found.branch)) {
      try {
        await runGit(['branch', '-D', found.branch], this.repoDir);
      } catch {
        // Branch có thể đã bị xoá tay trước đó: worktree đã dọn xong, không lỗi thêm.
      }
    }
  }

  /**
   * Dọn các worktree cũ hơn `maxAgeMs` (mặc định 24h), dựa trên mtime
   * của thư mục worktree. Trả về danh sách id đã dọn. Worktree còn
   * trẻ hoặc dọn lỗi đều được bỏ qua (lỗi dọn một worktree không chặn
   * các worktree khác).
   */
  async cleanupStale(opts: CleanupStaleOptions = {}): Promise<string[]> {
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error('cleanupStale cần `maxAgeMs` là số ≥ 0 (mili giây).');
    }
    const now = Date.now();
    const removed: string[] = [];
    for (const wt of await this.list()) {
      const ageMs = now - Date.parse(wt.createdAt);
      if (ageMs <= maxAgeMs) continue;
      try {
        await this.remove(wt.id, { force: opts.force });
        removed.push(wt.id);
      } catch {
        // Bỏ qua worktree dọn lỗi (vd đang bận) — lần cleanup sau thử lại.
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// ShadowWorkspace — wrapper tiện lợi cho một agent song song
// ---------------------------------------------------------------------------

/** Kết quả `createShadow`: worktree + hàm dọn sạch. */
export interface ShadowWorkspace {
  /** Thông tin worktree vừa tạo. */
  worktree: WorktreeInfo;
  /** Dọn sạch worktree (gọi `manager.remove`, ép buộc để dọn được cả khi có thay đổi chưa commit). */
  dispose: () => Promise<void>;
}

/**
 * Tạo một shadow workspace cho một subagent: worktree riêng trong
 * repo, dùng xong gọi `dispose()` để dọn sạch (worktree + branch
 * do open-bot tạo). `repoDir` không phải git repo → lỗi rõ ràng.
 *
 * Ví dụ:
 * ```ts
 * const shadow = await createShadow(repoDir);
 * // ... cho subagent làm việc trong shadow.worktree.path ...
 * await shadow.dispose();
 * ```
 */
export async function createShadow(
  repoDir: string,
  opts: CreateWorktreeOptions & { worktreesDir?: string } = {},
): Promise<ShadowWorkspace> {
  const manager = new WorktreeManager(repoDir, opts.worktreesDir);
  const worktree = await manager.create(opts);
  let disposed = false;
  return {
    worktree,
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await manager.remove(worktree.id, { force: true });
    },
  };
}
