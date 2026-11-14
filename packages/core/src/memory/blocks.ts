/**
 * Memory blocks (v0.96, Đội T1) — bộ nhớ có cấu trúc theo block, ý
 * tưởng kiểu Letta/MemGPT nhưng tự thiết kế lại hoàn toàn cho open-bot.
 *
 * Một block là một mẩu bộ nhớ có tên (label), mô tả, nội dung và giới
 * hạn ký tự riêng. Block sống MỘT lần trong file
 * `<workspace>/.open-bot/memory-blocks.json` và được ATTACH vào một
 * hay nhiều bot: cùng một block id attach ở nhiều bot thì sửa một nơi,
 * mọi bot attach nó đều thấy nội dung mới (share). Block nào chưa
 * attach vào bot nào thì không bao giờ lọt vào system prompt của bot đó.
 *
 * Label đặc biệt (được ưu tiên khi render vào prompt):
 *  - `human`   — sự thật về người dùng (do consolidation đẩy lên)
 *  - `persona` — tính cách / cách hành xử của bot
 * Các label khác là block tự do do user hoặc agent tạo.
 *
 * Read-only: block read-only không sửa được nội dung (append/replace/
 * đổi mô tả/giới hạn/xoá đều bị chặn) — chỉ có thể tắt cờ read-only
 * rồi mới sửa. Mọi thay đổi đều ghi audit append-only vào
 * `.open-bot/memory-blocks-audit.jsonl` (actor `user:...` hoặc
 * `agent:<botId>`), để EventLog/UI có thể xem lại ai đã sửa gì.
 *
 * Lưu trữ: JSON local, ghi atomic (temp + rename, mode 0600) như
 * LongTermMemory — đủ bền cho local-first, không cần SQLite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LongTermMemoryEntry } from './longterm';
import { readBlockHistory, recordBlockVersion } from './blockHistory';
import type { BlockVersionSnapshot } from './blockHistory';

export const MEMORY_BLOCKS_REL_PATH = path.join('.open-bot', 'memory-blocks.json');
export const MEMORY_BLOCKS_AUDIT_REL_PATH = path.join('.open-bot', 'memory-blocks-audit.jsonl');
/** Giới hạn ký tự mặc định của một block. */
export const DEFAULT_BLOCK_CHAR_LIMIT = 2000;
/** Giới hạn ký tự nhỏ nhất / lớn nhất cho phép cấu hình cho một block. */
export const MIN_BLOCK_CHAR_LIMIT = 100;
export const MAX_BLOCK_CHAR_LIMIT = 20000;
/** Label hệ thống — luôn được render trước các block khác. */
export const BLOCK_SYSTEM_LABELS = ['human', 'persona'] as const;
/** Độ dài tối đa của label (sau khi chuẩn hoá thành slug). */
export const MAX_BLOCK_LABEL_LENGTH = 64;

export interface MemoryBlock {
  id: string;
  /** Slug duy nhất trong store (vd `human`, `so-thich-an-uong`). */
  label: string;
  /** Mô tả ngắn: block này nhớ cái gì (hiện trong UI + prompt). */
  description: string;
  /** Nội dung block (giới hạn bởi `charLimit`). */
  content: string;
  /** Giới hạn ký tự của `content` (mặc định 2000). */
  charLimit: number;
  /** true = không sửa/xoá được nội dung (xem `setReadOnly`). */
  readOnly: boolean;
  /** Bot đã tạo block ('' = user tạo / import, không gắn bot nào). */
  createdByBotId: string;
  /** User sở hữu block (vắng = legacy, thuộc user hiện tại). */
  userId?: string;
  /** Tăng 1 mỗi lần nội dung/mô tả/giới hạn đổi. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryBlockAuditEntry {
  at: string;
  /** Ai sửa: `user`, `agent:<botId>`, `system:consolidate`, ... */
  actor: string;
  /** Hành động: create/append/replace/update/delete/attach/detach/share/set-read-only/consolidate. */
  action: string;
  blockId: string;
  label?: string;
  detail?: string;
}

export interface MemoryBlocksFile {
  version: 1;
  blocks: MemoryBlock[];
  /** botId -> danh sách block id đã attach (giữ đúng thứ tự attach). */
  attachments: Record<string, string[]>;
  /** Cấu hình consolidation lúc idle (v0.96 — xem consolidate.ts). */
  consolidation?: {
    enabled: boolean;
    idleMinutes: number;
    lastActivityAt?: string;
    lastRunAt?: string;
  };
}

export interface CreateBlockInput {
  label: string;
  description?: string;
  content?: string;
  charLimit?: number;
  readOnly?: boolean;
  createdByBotId?: string;
  userId?: string;
}

export interface UpdateBlockPatch {
  description?: string;
  content?: string;
  charLimit?: number;
}

/**
 * Chuẩn hoá label thành slug: chữ thường, khoảng trắng -> `-`, bỏ ký
 * tự lạ, gộp `-` liên tiếp. Dùng cho cả create lẫn tra cứu theo label.
 */
export function normalizeBlockLabel(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_BLOCK_LABEL_LENGTH);
}

/** Label hợp lệ sau chuẩn hoá: bắt đầu bằng chữ/số, chỉ gồm a-z 0-9 - _. */
export function isValidBlockLabel(label: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(label);
}

/** Thứ tự ưu tiên khi render vào prompt: human (0) < persona (1) < khác (2). */
export function blockPromptPriority(block: Pick<MemoryBlock, 'label'>): number {
  if (block.label === 'human') return 0;
  if (block.label === 'persona') return 1;
  return 2;
}

/** So sánh 2 block để xếp thứ tự render: ưu tiên hệ thống trước, rồi theo label. */
export function compareBlocksForPrompt(a: MemoryBlock, b: MemoryBlock): number {
  const pa = blockPromptPriority(a);
  const pb = blockPromptPriority(b);
  if (pa !== pb) return pa - pb;
  return a.label.localeCompare(b.label);
}

function clampCharLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_BLOCK_CHAR_LIMIT, Math.max(MIN_BLOCK_CHAR_LIMIT, Math.floor(value)));
}

export class MemoryBlockStore {
  private readonly filePath: string;
  private readonly auditPath: string;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, MEMORY_BLOCKS_REL_PATH);
    this.auditPath = path.join(workspaceDir, MEMORY_BLOCKS_AUDIT_REL_PATH);
  }

  /** Thư mục workspace mà store này thuộc về. */
  get dir(): string {
    return this.workspaceDir;
  }

  private readFile(): MemoryBlocksFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, blocks: [], attachments: {} };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Memory blocks file is not valid JSON: ${MEMORY_BLOCKS_REL_PATH}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as MemoryBlocksFile).version !== 1 ||
      !Array.isArray((parsed as MemoryBlocksFile).blocks) ||
      typeof (parsed as MemoryBlocksFile).attachments !== 'object' ||
      (parsed as MemoryBlocksFile).attachments === null
    ) {
      throw new Error(`Memory blocks file has an unsupported shape: ${MEMORY_BLOCKS_REL_PATH}`);
    }
    return parsed as MemoryBlocksFile;
  }

  private writeFile(file: MemoryBlocksFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * Ghi một dòng audit append-only (best-effort: lỗi ghi audit không
   * bao giờ làm fail thao tác chính — audit là để xem lại, không phải
   * rào chắn). Trả false khi không ghi được.
   */
  audit(action: string, blockId: string, actor: string, detail?: string, label?: string): boolean {
    try {
      const dir = path.dirname(this.auditPath);
      fs.mkdirSync(dir, { recursive: true });
      const entry: MemoryBlockAuditEntry = {
        at: new Date().toISOString(),
        actor,
        action,
        blockId,
        ...(label !== undefined ? { label } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
      fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** Đọc N dòng audit mới nhất (bỏ dòng hỏng, không throw khi chưa có file). */
  readAudit(limit = 100): MemoryBlockAuditEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.auditPath, 'utf8');
    } catch {
      return [];
    }
    const out: MemoryBlockAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as MemoryBlockAuditEntry;
        if (typeof parsed.action === 'string' && typeof parsed.blockId === 'string') out.push(parsed);
      } catch {
        // Dòng hỏng — bỏ qua.
      }
    }
    const n = Math.min(Math.max(Math.floor(limit), 1), 1000);
    return out.slice(-n).reverse();
  }

  /** Tạo block mới. Label trùng (sau chuẩn hoá) hoặc nội dung vượt giới hạn -> throw. */
  create(input: CreateBlockInput, actor = 'user'): MemoryBlock {
    const label = normalizeBlockLabel(input.label);
    if (!isValidBlockLabel(label)) {
      throw new Error(
        `Memory block label không hợp lệ: "${input.label}" (chỉ gồm chữ thường, số, "-" và "_", tối đa ${MAX_BLOCK_LABEL_LENGTH} ký tự).`,
      );
    }
    const charLimit = clampCharLimit(input.charLimit, DEFAULT_BLOCK_CHAR_LIMIT);
    const content = input.content ?? '';
    if (content.length > charLimit) {
      throw new Error(
        `Nội dung block "${label}" dài ${content.length} ký tự, vượt giới hạn ${charLimit} ký tự của block.`,
      );
    }
    const file = this.readFile();
    if (file.blocks.some((b) => b.label === label)) {
      throw new Error(`Đã có memory block với label "${label}" — dùng label khác hoặc sửa block đó.`);
    }
    const now = new Date().toISOString();
    const block: MemoryBlock = {
      id: randomUUID(),
      label,
      description: (input.description ?? '').trim(),
      content,
      charLimit,
      readOnly: input.readOnly === true,
      createdByBotId: input.createdByBotId ?? '',
      ...((input.userId ?? '').trim() !== '' ? { userId: (input.userId as string).trim() } : {}),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    file.blocks.push(block);
    this.writeFile(file);
    this.audit('create', block.id, actor, `label="${label}"`, label);
    // v1.02 (memory v3 — blocks v2): snapshot version 1 for history.
    recordBlockVersion(this.workspaceDir, block, 'create', actor);
    return { ...block };
  }

  /** Tìm block theo id hoặc label (label được chuẩn hoá trước khi so). Null khi không có. */
  get(idOrLabel: string): MemoryBlock | null {
    const file = this.readFile();
    const label = normalizeBlockLabel(idOrLabel);
    const found =
      file.blocks.find((b) => b.id === idOrLabel) ??
      (label !== '' ? file.blocks.find((b) => b.label === label) : undefined);
    return found ? { ...found } : null;
  }

  /**
   * Liệt kê block. `botId` -> chỉ block đã attach vào bot đó (đúng
   * thứ tự attach); không truyền botId -> toàn bộ block, xếp theo
   * label. `userId` lọc theo user sở hữu (legacy chưa gắn user vẫn
   * tính là của user hiện tại, như LongTermMemory).
   */
  list(opts: { botId?: string; userId?: string } = {}): MemoryBlock[] {
    const file = this.readFile();
    let blocks = file.blocks;
    if (opts.botId !== undefined) {
      const attached = file.attachments[opts.botId] ?? [];
      const byId = new Map(blocks.map((b) => [b.id, b]));
      blocks = attached
        .map((id) => byId.get(id))
        .filter((b): b is MemoryBlock => b !== undefined);
    } else {
      blocks = [...blocks].sort((a, b) => a.label.localeCompare(b.label));
    }
    if (opts.userId !== undefined) {
      blocks = blocks.filter((b) => (b.userId ?? '') === '' || b.userId === opts.userId);
    }
    return blocks.map((b) => ({ ...b }));
  }

  /** Các block đã attach vào bot (giữ thứ tự attach). */
  listAttached(botId: string): MemoryBlock[] {
    return this.list({ botId });
  }

  /** true khi block đã attach vào bot. */
  isAttached(botId: string, blockId: string): boolean {
    const file = this.readFile();
    return (file.attachments[botId] ?? []).includes(blockId);
  }

  /** Danh sách botId đang attach block này. */
  attachedBotIds(blockId: string): string[] {
    const file = this.readFile();
    return Object.entries(file.attachments)
      .filter(([, ids]) => ids.includes(blockId))
      .map(([botId]) => botId)
      .sort();
  }

  /** Attach block vào bot (idempotent — attach lại không trùng lặp). */
  attach(botId: string, blockIdOrLabel: string, actor = 'user'): MemoryBlock {
    const file = this.readFile();
    const block = this.resolveBlock(file, blockIdOrLabel);
    const list = file.attachments[botId] ?? [];
    if (!list.includes(block.id)) {
      list.push(block.id);
      file.attachments[botId] = list;
      this.writeFile(file);
      this.audit('attach', block.id, actor, `botId="${botId}"`, block.label);
    }
    return { ...block };
  }

  /** Detach block khỏi bot (idempotent — detach block chưa attach vẫn ok). */
  detach(botId: string, blockIdOrLabel: string, actor = 'user'): MemoryBlock {
    const file = this.readFile();
    const block = this.resolveBlock(file, blockIdOrLabel);
    const list = file.attachments[botId] ?? [];
    const idx = list.indexOf(block.id);
    if (idx !== -1) {
      list.splice(idx, 1);
      if (list.length === 0) delete file.attachments[botId];
      else file.attachments[botId] = list;
      this.writeFile(file);
      this.audit('detach', block.id, actor, `botId="${botId}"`, block.label);
    }
    return { ...block };
  }

  /**
   * Share block cho nhiều bot cùng lúc (mỗi bot = một attach). Trả về
   * danh sách botId vừa được attach thêm (bot đã attach từ trước
   * không tính lại). Dùng cho nút "share cho mọi bot" ở UI.
   */
  share(blockIdOrLabel: string, botIds: string[], actor = 'user'): string[] {
    const file = this.readFile();
    const block = this.resolveBlock(file, blockIdOrLabel);
    const newly: string[] = [];
    for (const botId of [...new Set(botIds.map((b) => b.trim()).filter(Boolean))]) {
      const list = file.attachments[botId] ?? [];
      if (!list.includes(block.id)) {
        list.push(block.id);
        file.attachments[botId] = list;
        newly.push(botId);
      }
    }
    if (newly.length > 0) {
      this.writeFile(file);
      this.audit('share', block.id, actor, `bots=${newly.join(',')}`, block.label);
    }
    return newly;
  }

  /** Gỡ block khỏi mọi bot đang attach nó. Trả số bot đã gỡ. */
  unshareAll(blockIdOrLabel: string, actor = 'user'): number {
    const file = this.readFile();
    const block = this.resolveBlock(file, blockIdOrLabel);
    let removed = 0;
    for (const botId of Object.keys(file.attachments)) {
      const list = file.attachments[botId] ?? [];
      const idx = list.indexOf(block.id);
      if (idx !== -1) {
        list.splice(idx, 1);
        removed += 1;
        if (list.length === 0) delete file.attachments[botId];
      }
    }
    if (removed > 0) {
      this.writeFile(file);
      this.audit('unshare-all', block.id, actor, `removedFrom=${removed} bots`, block.label);
    }
    return removed;
  }

  private resolveBlock(file: MemoryBlocksFile, idOrLabel: string): MemoryBlock {
    const label = normalizeBlockLabel(idOrLabel);
    const found =
      file.blocks.find((b) => b.id === idOrLabel) ??
      (label !== '' ? file.blocks.find((b) => b.label === label) : undefined);
    if (!found) throw new Error(`Không tìm thấy memory block "${idOrLabel}".`);
    return found;
  }

  private assertWritable(block: MemoryBlock): void {
    if (block.readOnly) {
      throw new Error(
        `Memory block "${block.label}" đang read-only — tắt read-only trước khi sửa (setReadOnly).`,
      );
    }
  }

  /**
   * Sửa block (mô tả / nội dung / giới hạn ký tự). Block read-only bị
   * chặn. Nội dung mới vượt giới hạn -> throw (không cắt lén). Đổi nội
   * dung/mô tả/giới hạn thì version +1, updatedAt mới.
   */
  update(
    idOrLabel: string,
    patch: UpdateBlockPatch,
    actor = 'user',
  ): MemoryBlock {
    if (typeof patch !== 'object' || patch === null) {
      throw new Error('Memory block patch must be an object.');
    }
    const file = this.readFile();
    const block = this.resolveBlock(file, idOrLabel);
    this.assertWritable(block);
    const newLimit =
      patch.charLimit !== undefined ? clampCharLimit(patch.charLimit, block.charLimit) : block.charLimit;
    const newContent = patch.content !== undefined ? patch.content : block.content;
    if (newContent.length > newLimit) {
      throw new Error(
        `Nội dung block "${block.label}" dài ${newContent.length} ký tự, vượt giới hạn ${newLimit} ký tự của block.`,
      );
    }
    let changed = false;
    if (patch.description !== undefined && patch.description.trim() !== block.description) {
      block.description = patch.description.trim();
      changed = true;
    }
    if (patch.content !== undefined && patch.content !== block.content) {
      block.content = patch.content;
      changed = true;
    }
    if (patch.charLimit !== undefined && newLimit !== block.charLimit) {
      block.charLimit = newLimit;
      changed = true;
    }
    if (changed) {
      block.version += 1;
      block.updatedAt = new Date().toISOString();
      this.writeFile(file);
      this.audit('update', block.id, actor, `version=${block.version}`, block.label);
      // v1.02 (memory v3 — blocks v2): snapshot the new version.
      recordBlockVersion(this.workspaceDir, block, 'update', actor);
    }
    return { ...block };
  }

  /**
   * Ghi đè toàn bộ nội dung block. Block read-only hoặc nội dung mới
   * vượt giới hạn -> throw. Audit ghi action `replace` (phân biệt với
   * `update` mô tả/giới hạn) để EventLog thấy rõ agent đã thay nội dung.
   */
  replace(idOrLabel: string, content: string, actor = 'user'): MemoryBlock {
    const file = this.readFile();
    const block = this.resolveBlock(file, idOrLabel);
    this.assertWritable(block);
    if (content.length > block.charLimit) {
      throw new Error(
        `Nội dung block "${block.label}" dài ${content.length} ký tự, vượt giới hạn ${block.charLimit} ký tự của block.`,
      );
    }
    if (content !== block.content) {
      block.content = content;
      block.version += 1;
      block.updatedAt = new Date().toISOString();
      this.writeFile(file);
      this.audit('replace', block.id, actor, `version=${block.version}`, block.label);
      // v1.02 (memory v3 — blocks v2): snapshot the new version.
      recordBlockVersion(this.workspaceDir, block, 'replace', actor);
    }
    return { ...block };
  }

  /**
   * Nối thêm text vào cuối nội dung block (thêm một dòng mới khi block
   * đã có nội dung). Block read-only hoặc vượt giới hạn -> throw.
   */
  append(idOrLabel: string, text: string, actor = 'user'): MemoryBlock {
    if (!text || !text.trim()) throw new Error('Không có nội dung để nối vào block.');
    const file = this.readFile();
    const block = this.resolveBlock(file, idOrLabel);
    this.assertWritable(block);
    const addition = text.trim();
    const next = block.content === '' ? addition : `${block.content}\n${addition}`;
    if (next.length > block.charLimit) {
      throw new Error(
        `Nối thêm ${addition.length} ký tự sẽ làm block "${block.label}" dài ${next.length} ký tự, vượt giới hạn ${block.charLimit} ký tự.`,
      );
    }
    block.content = next;
    block.version += 1;
    block.updatedAt = new Date().toISOString();
    this.writeFile(file);
    this.audit('append', block.id, actor, `+${addition.length} chars, version=${block.version}`, block.label);
    // v1.02 (memory v3 — blocks v2): snapshot the new version.
    recordBlockVersion(this.workspaceDir, block, 'append', actor);
    return { ...block };
  }

  /** Xoá block (kèm mọi attachment). Block read-only bị chặn xoá. */
  delete(idOrLabel: string, actor = 'user'): boolean {
    const file = this.readFile();
    const block = this.resolveBlock(file, idOrLabel);
    this.assertWritable(block);
    const idx = file.blocks.findIndex((b) => b.id === block.id);
    if (idx === -1) return false;
    file.blocks.splice(idx, 1);
    for (const botId of Object.keys(file.attachments)) {
      const list = (file.attachments[botId] ?? []).filter((id) => id !== block.id);
      if (list.length === 0) delete file.attachments[botId];
      else file.attachments[botId] = list;
    }
    this.writeFile(file);
    this.audit('delete', block.id, actor, `label="${block.label}"`, block.label);
    // v1.02 (memory v3 — blocks v2): keep a tombstone snapshot so the
    // deleted content stays inspectable in history.
    recordBlockVersion(this.workspaceDir, block, 'delete', actor);
    return true;
  }

  /** Bật/tắt cờ read-only (chính thao tác này KHÔNG bị chặn bởi read-only). */
  setReadOnly(idOrLabel: string, readOnly: boolean, actor = 'user'): MemoryBlock {
    const file = this.readFile();
    const block = this.resolveBlock(file, idOrLabel);
    if (block.readOnly !== readOnly) {
      block.readOnly = readOnly;
      block.version += 1;
      block.updatedAt = new Date().toISOString();
      this.writeFile(file);
      this.audit('set-read-only', block.id, actor, `readOnly=${readOnly}`, block.label);
      // v1.02 (memory v3 — blocks v2): snapshot the new version.
      recordBlockVersion(this.workspaceDir, block, 'set-read-only', actor);
    }
    return { ...block };
  }

  // --- Version history (v1.02, memory v3 — blocks v2) ----------------

  /** Version snapshots of a block, oldest first (empty when none). */
  getHistory(idOrLabel: string, limit = 50): BlockVersionSnapshot[] {
    const file = this.readFile();
    const block = this.resolveBlock(file, idOrLabel);
    return readBlockHistory(this.workspaceDir, block.id, limit);
  }

  /** Version snapshots by block id (also works after deletion). */
  getHistoryById(blockId: string, limit = 50): BlockVersionSnapshot[] {
    return readBlockHistory(this.workspaceDir, blockId, limit);
  }

  /**
   * Restore a block to an older version's content. History is never
   * rewritten: the old content comes back as a NEW version (counter
   * + 1) with an audit entry. Restoring the current content is a
   * no-op. Read-only blocks and content over the char limit throw,
   * like any other write.
   */
  restoreVersion(idOrLabel: string, version: number, actor = 'user'): MemoryBlock {
    const file = this.readFile();
    const block = this.resolveBlock(file, idOrLabel);
    this.assertWritable(block);
    const snapshot = readBlockHistory(this.workspaceDir, block.id, 200).find(
      (s) => s.version === version,
    );
    if (!snapshot) {
      throw new Error(`Block "${block.label}" không có version ${version} trong lịch sử.`);
    }
    if (snapshot.content === block.content) return { ...block };
    if (snapshot.content.length > block.charLimit) {
      throw new Error(
        `Nội dung version ${version} của block "${block.label}" dài ${snapshot.content.length} ký tự, vượt giới hạn ${block.charLimit} ký tự hiện tại.`,
      );
    }
    block.content = snapshot.content;
    block.version += 1;
    block.updatedAt = new Date().toISOString();
    this.writeFile(file);
    this.audit('restore-version', block.id, actor, `restored version=${version} as version=${block.version}`, block.label);
    recordBlockVersion(this.workspaceDir, block, 'restore', actor);
    return { ...block };
  }

  /**
   * Lấy block theo label, chưa có thì tạo mới (dùng cho consolidation
   * đẩy fact lên block `human`, và cho import MemFS). Block đã có thì
   * trả nguyên, không ghi đè.
   */
  ensureBlock(
    label: string,
    defaults: { description?: string; content?: string; charLimit?: number; createdByBotId?: string } = {},
    actor = 'user',
  ): MemoryBlock {
    const existing = this.get(label);
    if (existing) return existing;
    return this.create(
      {
        label,
        description: defaults.description ?? '',
        content: defaults.content ?? '',
        charLimit: defaults.charLimit,
        createdByBotId: defaults.createdByBotId,
      },
      actor,
    );
  }

  /**
   * Tạo block từ một long-term memory entry (nối blocks với kho D4 đã
   * có): label lấy từ key (slug hoá), nội dung = value, mô tả ghi rõ
   * nguồn. Label đã tồn tại -> throw (dùng `get(label)` kiểm tra trước
   * hoặc đổi label); entry rỗng -> throw. Block mới KHÔNG tự attach —
   * caller attach vào bot cần thiết.
   */
  importFromLongTerm(entry: LongTermMemoryEntry, actor = 'user'): MemoryBlock {
    const label = normalizeBlockLabel(entry.key);
    if (!isValidBlockLabel(label)) {
      throw new Error(
        `Không tạo được block từ memory "${entry.key}" — key không chuyển được thành label hợp lệ.`,
      );
    }
    if (!entry.value || !entry.value.trim()) {
      throw new Error(`Memory "${entry.key}" không có nội dung để tạo block.`);
    }
    return this.create(
      {
        label,
        description: `Nhập từ long-term memory "${entry.key}"${entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''}.`,
        content: entry.value,
        createdByBotId: entry.botId,
        ...(entry.userId !== undefined ? { userId: entry.userId } : {}),
      },
      actor,
    );
  }

  // --- Cấu hình consolidation lúc idle (xem consolidate.ts) ---

  getConsolidationConfig(): {
    enabled: boolean;
    idleMinutes: number;
    lastActivityAt?: string;
    lastRunAt?: string;
  } {
    const file = this.readFile();
    return {
      enabled: file.consolidation?.enabled === true,
      idleMinutes: file.consolidation?.idleMinutes ?? 30,
      ...(file.consolidation?.lastActivityAt ? { lastActivityAt: file.consolidation.lastActivityAt } : {}),
      ...(file.consolidation?.lastRunAt ? { lastRunAt: file.consolidation.lastRunAt } : {}),
    };
  }

  setConsolidationConfig(
    patch: { enabled?: boolean; idleMinutes?: number; lastActivityAt?: string; lastRunAt?: string },
    actor = 'user',
  ): { enabled: boolean; idleMinutes: number; lastActivityAt?: string; lastRunAt?: string } {
    const file = this.readFile();
    const current = file.consolidation ?? { enabled: false, idleMinutes: 30 };
    const next = {
      enabled: patch.enabled !== undefined ? patch.enabled === true : current.enabled,
      idleMinutes:
        patch.idleMinutes !== undefined
          ? Math.min(24 * 60, Math.max(1, Math.floor(patch.idleMinutes)))
          : current.idleMinutes,
      ...(patch.lastActivityAt !== undefined || current.lastActivityAt
        ? { lastActivityAt: patch.lastActivityAt ?? current.lastActivityAt }
        : {}),
      ...(patch.lastRunAt !== undefined || current.lastRunAt
        ? { lastRunAt: patch.lastRunAt ?? current.lastRunAt }
        : {}),
    };
    file.consolidation = next;
    this.writeFile(file);
    this.audit(
      'consolidate-config',
      'consolidation',
      actor,
      `enabled=${next.enabled} idleMinutes=${next.idleMinutes}`,
    );
    return { ...next };
  }
}
