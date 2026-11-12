/**
 * Project updates (v0.94c) — kênh gửi thật cho `project_set_updates`.
 *
 * Trước sóng này, `project_set_updates` (tương đương Grok
 * `Start/StopProjectUpdatesToolCall`) chỉ lưu cờ `updatesEnabled` vào
 * DB — không có gì đọc cờ đó, nên không một cập nhật nào được gửi đi.
 * Module này là nửa "tính toán" của kênh gửi (pure + BotMemory):
 *
 *  - `buildProjectDigest`: tóm tắt tiến độ một project — số task theo
 *    trạng thái, task vừa xong kể từ digest trước, task còn mở.
 *  - `listDueProjectUpdates`: project nào bật updates + tới hạn (chu
 *    kỳ 6 giờ kể từ digest trước; chưa gửi lần nào thì tới hạn ngay).
 *  - `markProjectUpdateSent`: ghi dấu `lastUpdateAt` sau khi gửi.
 *
 * Nửa "gửi" sống ở desktop main (`runProjectUpdatesTick`, timer 15
 * phút): lấy danh sách due qua coordinator RPC `projectUpdatesDue`,
 * gửi thông báo hệ thống + lưu digest làm tin nhắn assistant vào chat
 * của bot, rồi gọi `projectUpdatesMarkSent`. Digest là text thuần đã
 * tính sẵn (không gọi model — không tốn token, không cần provider).
 *
 * Tóm tắt bằng tiếng Việt (ngôn ngữ mặc định của app); nội dung chỉ
 * gồm tên project + trạng thái task — không có secret.
 */
import type { BotMemory, ProjectItem } from '../agent/memory';

/** Chu kỳ gửi digest cho một project: 6 giờ kể từ digest trước. */
export const PROJECT_UPDATES_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Nhịp kiểm tra due ở desktop main (mirror của `dreamTimer` 60s —
 * project updates kiểm tra thưa hơn vì digest chỉ tới hạn mỗi 6 giờ).
 */
export const PROJECT_UPDATES_CHECK_MS = 15 * 60 * 1000;

/** Tối đa task liệt kê trong mỗi mục của digest (giữ digest ngắn). */
export const PROJECT_DIGEST_MAX_ITEMS = 5;

export interface ProjectDigestCounts {
  total: number;
  done: number;
  pending: number;
  inProgress: number;
  cancelled: number;
}

/** Một digest đã tính xong, sẵn sàng để gửi. */
export interface ProjectDigest {
  botId: string;
  projectId: string;
  title: string;
  status: string;
  /** Toàn văn digest (lưu làm tin nhắn trong chat của bot). */
  digest: string;
  /** Một dòng tóm tắt (làm body thông báo hệ thống). */
  summary: string;
  counts: ProjectDigestCounts;
  /**
   * Thời điểm digest kế tiếp tới hạn (ISO). Project chưa gửi lần nào
   * thì bằng `now` (tới hạn ngay); project đã gửi thì bằng
   * lastUpdateAt + chu kỳ.
   */
  nextDueAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  active: 'đang làm',
  paused: 'tạm dừng',
  done: 'đã xong',
  cancelled: 'đã huỷ',
};

function projectTag(projectId: string): string {
  return `project:${projectId}`;
}

function countTasks(memory: BotMemory, botId: string, projectId: string): ProjectDigestCounts {
  const tasks = memory.listTasks(botId, { tag: projectTag(projectId) });
  const counts: ProjectDigestCounts = { total: tasks.length, done: 0, pending: 0, inProgress: 0, cancelled: 0 };
  for (const t of tasks) {
    if (t.status === 'done') counts.done += 1;
    else if (t.status === 'pending') counts.pending += 1;
    else if (t.status === 'in_progress') counts.inProgress += 1;
    else if (t.status === 'cancelled') counts.cancelled += 1;
  }
  return counts;
}

/**
 * Thời điểm digest kế tiếp của một project (ISO), hoặc null khi
 * project tắt updates. Chưa gửi lần nào → `now` (tới hạn ngay).
 */
export function nextProjectDigestAt(project: ProjectItem, now: Date = new Date()): string | null {
  if (!project.updatesEnabled) return null;
  if (!project.lastUpdateAt) return now.toISOString();
  return new Date(Date.parse(project.lastUpdateAt) + PROJECT_UPDATES_INTERVAL_MS).toISOString();
}

/**
 * Tóm tắt tiến độ một project. Trả null khi project không có hoặc
 * không thuộc bot này. `now` chỉ dùng để tính `nextDueAt` (mặc định
 * thời điểm hiện tại).
 *
 * "Vừa xong" = task done có updatedAt sau digest trước (khi chưa có
 * digest trước thì là mọi task done). "Còn mở" = task pending /
 * in_progress cũ nhất trước (mỗi mục tối đa 5).
 */
export function buildProjectDigest(
  memory: BotMemory,
  botId: string,
  projectId: string,
  now: Date = new Date(),
): ProjectDigest | null {
  const project = memory.getProject(projectId);
  if (!project || project.botId !== botId) return null;
  const tasks = memory.listTasks(botId, { tag: projectTag(projectId) });
  const counts = countTasks(memory, botId, projectId);
  const lastSentAt = project.lastUpdateAt ? Date.parse(project.lastUpdateAt) : null;

  const recentlyDone = tasks
    .filter((t) => t.status === 'done' && (lastSentAt === null || Date.parse(t.updatedAt) > lastSentAt))
    .slice(0, PROJECT_DIGEST_MAX_ITEMS);
  const stillOpen = tasks
    .filter((t) => t.status === 'pending' || t.status === 'in_progress')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, PROJECT_DIGEST_MAX_ITEMS);

  const lines: string[] = [];
  lines.push(`📋 Cập nhật project: ${project.title} (${STATUS_LABEL[project.status] ?? project.status})`);
  if (project.detail) lines.push(project.detail);
  lines.push(
    `Tiến độ: ${counts.done}/${counts.total} task xong` +
      (counts.inProgress > 0 ? `, ${counts.inProgress} đang làm` : '') +
      (counts.pending > 0 ? `, ${counts.pending} đang chờ` : '') +
      (counts.cancelled > 0 ? `, ${counts.cancelled} đã huỷ` : '') +
      '.',
  );
  if (recentlyDone.length > 0) {
    lines.push(`Mới xong kể từ cập nhật trước (${recentlyDone.length}):`);
    for (const t of recentlyDone) lines.push(`  ✓ ${t.title}`);
  }
  if (stillOpen.length > 0) {
    lines.push(`Còn mở (${stillOpen.length}):`);
    for (const t of stillOpen) lines.push(`  • ${t.title}`);
  }
  if (counts.total === 0) lines.push('Project chưa có task nào.');
  // Digest này đang được gửi ngay (now) nên kỳ kế tiếp tính từ now,
  // không phải từ digest trước (đã quá hạn rồi).
  const nextDueAt = new Date(now.getTime() + PROJECT_UPDATES_INTERVAL_MS).toISOString();
  lines.push(`Cập nhật kế tiếp: ${new Date(nextDueAt).toLocaleString('vi-VN')}.`);

  return {
    botId,
    projectId,
    title: project.title,
    status: project.status,
    digest: lines.join('\n'),
    summary: `Project "${project.title}": ${counts.done}/${counts.total} task xong` +
      (counts.inProgress > 0 ? `, ${counts.inProgress} đang làm` : '') +
      (counts.pending > 0 ? `, ${counts.pending} đang chờ` : '') +
      '.',
    counts,
    nextDueAt,
  };
}

/**
 * Project nào của bot đang tới hạn gửi digest: bật updates + (chưa
 * gửi lần nào, hoặc digest trước đã quá chu kỳ 6 giờ).
 */
export function listDueProjectUpdates(
  memory: BotMemory,
  botId: string,
  now: Date = new Date(),
): ProjectDigest[] {
  const out: ProjectDigest[] = [];
  for (const project of memory.listProjects(botId)) {
    if (!project.updatesEnabled) continue;
    const nextDue = nextProjectDigestAt(project, now);
    if (nextDue === null) continue;
    if (Date.parse(nextDue) > now.getTime()) continue;
    const digest = buildProjectDigest(memory, botId, project.id, now);
    if (digest) out.push(digest);
  }
  return out;
}

/**
 * Ghi dấu đã gửi digest cho một project lúc `at` (mặc định bây giờ).
 * Trả false khi project không có (không ghi gì).
 */
export function markProjectUpdateSent(
  memory: BotMemory,
  projectId: string,
  at: Date = new Date(),
): boolean {
  if (!memory.getProject(projectId)) return false;
  memory.setProjectLastUpdateAt(projectId, at);
  return true;
}
