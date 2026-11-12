/**
 * Usage ledger của fleet (đội D) — mức dùng CPU/RAM/đĩa theo workspace.
 *
 * File `usage.jsonl` trong thư mục gốc của fleet: mỗi dòng là một mẫu
 * đo (FleetUsageSample). Không nối chuỗi hash (mẫu đo nhiều, tần suất
 * cao — tính toàn vẹn của ledger không phải yêu cầu an ninh; audit +
 * decision log mới là log chuỗi hash). Số liệu chỉ ghi khi đo được
 * thật, còn không thì null — không bịa số.
 *
 * Đo thật:
 * - CPU time + RSS của service: đọc /proc/<pid>/stat (utime+stime,
 *   CLK_TCK = 100 trên Linux) và /proc/<pid>/status (VmRSS). Chỉ
 *   Linux — nền tảng khác trả null.
 * - Đĩa: cộng dồn kích thước file trong rootDir của workspace (không
 *   theo symlink, giới hạn 20.000 file — vượt thì trả null thay vì
 *   báo thiếu).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetUsageSample, FleetUsageSummary } from './types';

export const USAGE_FILE = 'usage.jsonl';
/** Giữ tối đa mỗi workspace trong ledger (ghi đè cũ khi vượt). */
export const USAGE_MAX_SAMPLES_PER_WORKSPACE = 1000;
/** Giới hạn file khi đo đĩa (vượt thì không đo được). */
export const USAGE_DISK_MAX_FILES = 20000;
/** Số dòng tối đa trước khi prune (kiểm tra khi ghi mẫu mới). */
const USAGE_PRUNE_THRESHOLD_LINES = 5000;

export function getUsagePath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('usage ledger cần rootDir không rỗng.');
  }
  return path.join(rootDir, USAGE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateUsageSample(raw: unknown): FleetUsageSample {
  if (!isRecord(raw)) throw new Error('usage sample phải là object.');
  const { workspaceId, at, cpuSeconds, rssBytes, diskBytes, servicePid } = raw;
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    throw new Error('usage sample cần workspaceId không rỗng.');
  }
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    throw new Error('usage sample cần at là epoch ms > 0.');
  }
  for (const [field, value] of [
    ['cpuSeconds', cpuSeconds],
    ['rssBytes', rssBytes],
    ['diskBytes', diskBytes],
  ] as const) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`usage sample ${field} phải là null hoặc số >= 0.`);
    }
  }
  if (servicePid !== null && (typeof servicePid !== 'number' || !Number.isInteger(servicePid) || servicePid <= 0)) {
    throw new Error('usage sample servicePid phải là null hoặc số nguyên > 0.');
  }
  return {
    workspaceId,
    at,
    cpuSeconds: cpuSeconds as number | null,
    rssBytes: rssBytes as number | null,
    diskBytes: diskBytes as number | null,
    servicePid: servicePid as number | null,
  };
}

/** Đọc toàn bộ mẫu (theo thứ tự ghi). File chưa có → []. Dòng hỏng → throw kèm số dòng. */
export function readUsageSamples(rootDir: string): FleetUsageSample[] {
  const filePath = getUsagePath(rootDir);
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const samples: FleetUsageSample[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${USAGE_FILE} hỏng ở dòng ${i + 1}: không phải JSON hợp lệ.`);
    }
    try {
      samples.push(validateUsageSample(parsed));
    } catch (err) {
      throw new Error(`${USAGE_FILE} hỏng ở dòng ${i + 1}: ${(err as Error).message}`);
    }
  }
  return samples;
}

/** Đọc mẫu của một workspace (mới → cũ khi limit, mặc định lấy hết). */
export function readUsageSamplesFor(
  rootDir: string,
  workspaceId: string,
  opts: { since?: number; limit?: number } = {},
): FleetUsageSample[] {
  let samples = readUsageSamples(rootDir).filter((s) => s.workspaceId === workspaceId);
  if (opts.since !== undefined) samples = samples.filter((s) => s.at >= opts.since!);
  if (opts.limit !== undefined) samples = samples.slice(-opts.limit);
  return samples;
}

/** Ghi một mẫu đo (append). Tự prune khi file quá dài. */
export function recordUsageSample(rootDir: string, sample: FleetUsageSample): void {
  const valid = validateUsageSample(sample);
  const filePath = getUsagePath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(valid)}\n`, 'utf8');
  // Prune lười: chỉ khi file dài bất thường mới đọc lại + ghi lại.
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > USAGE_PRUNE_THRESHOLD_LINES) pruneUsageLedger(rootDir);
  } catch {
    // Prune thất bại không được làm hỏng lần ghi mẫu.
  }
}

/** Giữ tối đa USAGE_MAX_SAMPLES_PER_WORKSPACE mẫu mới nhất cho mỗi workspace. */
export function pruneUsageLedger(rootDir: string): void {
  const all = readUsageSamples(rootDir);
  const byWorkspace = new Map<string, FleetUsageSample[]>();
  for (const sample of all) {
    const list = byWorkspace.get(sample.workspaceId) ?? [];
    list.push(sample);
    byWorkspace.set(sample.workspaceId, list);
  }
  const kept: FleetUsageSample[] = [];
  for (const list of byWorkspace.values()) {
    kept.push(...list.slice(-USAGE_MAX_SAMPLES_PER_WORKSPACE));
  }
  kept.sort((a, b) => a.at - b.at);
  const filePath = getUsagePath(rootDir);
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, kept.map((s) => `${JSON.stringify(s)}\n`).join(''), 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Tóm tắt mức dùng của một workspace (null khi chưa có mẫu nào). */
export function summarizeUsage(
  rootDir: string,
  workspaceId: string,
  opts: { since?: number } = {},
): FleetUsageSummary | null {
  const samples = readUsageSamplesFor(rootDir, workspaceId, opts);
  if (samples.length === 0) return null;
  let cpuSecondsMax: number | null = null;
  for (const s of samples) {
    if (s.cpuSeconds !== null && (cpuSecondsMax === null || s.cpuSeconds > cpuSecondsMax)) {
      cpuSecondsMax = s.cpuSeconds;
    }
  }
  const latest = samples[samples.length - 1];
  return {
    workspaceId,
    samples: samples.length,
    windowStart: samples[0].at,
    windowEnd: latest.at,
    cpuSecondsMax,
    rssBytesLatest: latest.rssBytes,
    diskBytesLatest: latest.diskBytes,
  };
}

/** Đo CPU time (giây) + RSS (bytes) của một PID trên Linux (/proc). */
export function measureProcessUsage(pid: number): { cpuSeconds: number | null; rssBytes: number | null } {
  if (process.platform !== 'linux') return { cpuSeconds: null, rssBytes: null };
  let cpuSeconds: number | null = null;
  let rssBytes: number | null = null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm có thể chứa khoảng trắng/ngoặc — cắt từ dấu ')' cuối cùng.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    // Sau comm: state(1) ppid(2) ... utime là field 14 tổng thể = index 11 sau comm.
    const utime = Number(afterComm[11]);
    const stime = Number(afterComm[12]);
    if (Number.isFinite(utime) && Number.isFinite(stime)) {
      cpuSeconds = (utime + stime) / 100; // CLK_TCK = 100 trên Linux.
    }
  } catch {
    // Process đã thoát hoặc không đọc được — null.
  }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (match) rssBytes = Number.parseInt(match[1], 10) * 1024;
  } catch {
    // Không đọc được — null.
  }
  return { cpuSeconds, rssBytes };
}

/** Đo dung lượng đĩa của một thư mục (cộng dồn file, không theo symlink). */
export function measureDiskUsage(dir: string): number | null {
  let total = 0;
  let files = 0;
  const stack: string[] = [dir];
  try {
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          files += 1;
          if (files > USAGE_DISK_MAX_FILES) return null;
          try {
            total += fs.statSync(full).size;
          } catch {
            return null;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return total;
}

/** Đo một mẫu đầy đủ cho workspace: CPU/RSS của service + đĩa thư mục. */
export function measureWorkspaceUsage(
  workspaceId: string,
  servicePid: number | null,
  workspaceDir: string,
): FleetUsageSample {
  const proc = servicePid !== null ? measureProcessUsage(servicePid) : { cpuSeconds: null, rssBytes: null };
  return {
    workspaceId,
    at: Date.now(),
    cpuSeconds: proc.cpuSeconds,
    rssBytes: proc.rssBytes,
    diskBytes: measureDiskUsage(workspaceDir),
    servicePid,
  };
}
