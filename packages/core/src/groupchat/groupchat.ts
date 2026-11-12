/**
 * Group chat bot-bot (M8).
 *
 * Một thread nhóm có nhiều bot: mỗi message ghi rõ bot nào nói, lịch
 * sử nhóm bền vững (file JSON trong thư mục dữ liệu, cùng kiểu lưu như
 * auto-approve rules — ghi atomic, hỏng thì về rỗng fail-closed).
 *
 * Hành vi (học từ OpenMausBot, chỉ lấy kiến trúc):
 *  - @mentions gọi bot cụ thể: `@TênBot` trong message được parse
 *    thành danh sách bot được nhắc (khớp id hoặc tên bot, không phân
 *    biệt hoa/thường, tên có khoảng trắng thì khớp cả `@TênBot` viết
 *    liền). Tái dùng @-mentions v0.16 về mặt ý tưởng, nhưng đây là
 *    mention BOT (không phải mention FILE `@files`/`@docs`).
 *  - Delegation: bot được @mention thì nhận việc — coordinator chạy
 *    bot đó (silent run, dùng `run()` đã có) với nội dung message,
 *    rồi câu trả lời của nó được thêm vào nhóm như message của bot đó.
 *    Không viết delegation mới: chỉ một hop (câu trả lời của bot được
 *    mention không parse mention tiếp — chống vòng lặp bot-bot).
 *  - Lịch sử bền vững: mọi message (cả user gửi vào nhóm, cả bot trả
 *    lời) đều ghi file ngay khi post; đọc lại sau restart vẫn đủ.
 *  - v0.94c: message nhận ảnh đính kèm (vision channel — cùng giới hạn
 *    5 ảnh/10 MB mỗi ảnh/20 MB tổng như chat thường). Ảnh lưu thành
 *    file trong `group-attachments` cạnh file JSON, message chỉ giữ
 *    tham chiếu; delegation run nhận đúng bytes ảnh để bot "nhìn" được.
 *
 * Module này là PURE + file store (giống AutoApproveRuleStore): logic
 * parse/store không gọi provider; việc chạy bot do coordinator làm
 * (xem `coordinator.ts` — `postGroupMessage`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VisionAttachment } from '../types';

/** Trạng thái chạy của một bot trong một nhóm chat (v0.79a, UI parity §7). */
export type GroupBotStatus = 'idle' | 'running';

/** Một bot đang chạy trong nhóm: chỉ trạng thái `running` mới được liệt kê. */
export interface GroupBotStatusEntry {
  botId: string;
  status: GroupBotStatus;
  /** ISO timestamp lúc bot bắt đầu chạy (để UI tính "đang chạy bao lâu"). */
  since: string;
}

/** Một bot đang chạy dở thì app dừng (restart/crash) — xem `GroupBotStatusTracker`. */
export interface GroupBotInterruptedEntry {
  botId: string;
  /** ISO timestamp lúc bot bắt đầu chạy (trước khi app dừng). */
  since: string;
}

/** Tên file snapshot trạng thái bot trong nhóm (cùng thư mục với group-chats.json). */
export const GROUP_BOT_STATUS_FILE_NAME = 'group-bot-status.json';
/** Phiên bản format file snapshot trạng thái bot trong nhóm. */
export const GROUP_BOT_STATUS_FILE_VERSION = 1;
/** Giới hạn entry trong file snapshot (chống file phình vô hạn). */
export const GROUP_BOT_STATUS_MAX_ENTRIES = 200;

/**
 * Theo dõi trạng thái chạy của bot trong group chat.
 *
 * `running` là in-memory theo nghĩa hẹp: một lần chạy chỉ tồn tại
 * trong lúc tiến trình đang chạy nó. NHƯNG snapshot `running` được
 * lưu xuống đĩa (v0.82, follow-up 3b) để sau restart app biết lần
 * chạy nào đã chết giữa chừng: khi tracker mới (tiến trình mới) đọc
 * file, mọi entry `running` cũ trở thành `interrupted` — KHÔNG BAO
 * GIỜ khôi phục thành `running` (đó sẽ là nói dối: tiến trình cũ đã
 * chết, không còn ai chạy). UI hiện dòng "đang trả lời dở thì app
 * dừng" để user gửi lại tin, và user bấm Bỏ qua để xoá.
 *
 * Ghi đĩa chỉ xảy ra khi trạng thái ĐỔI (markRunning/markIdle/
 * clearGroup/clearInterrupted) — đường poll 2s của renderer
 * (`getGroupBotStatus`) chỉ đọc bộ nhớ, không chạm đĩa. Ghi hỏng
 * (quyền/đĩa đầy) không bao giờ làm đổ lần chạy: persist nuốt lỗi,
 * tracker vẫn chạy đúng trong bộ nhớ.
 *
 * Chỉ entry `running` được giữ: bot idle = không có entry (không cần
 * lưu trạng thái của mọi bot mọi lúc). `getStatus` trả bản copy sắp
 * theo `since` (bot chạy lâu nhất trước).
 */
export class GroupBotStatusTracker {
  private readonly byGroup = new Map<string, Map<string, { since: string }>>();
  private readonly interruptedByGroup = new Map<string, Map<string, { since: string }>>();
  private readonly filePath?: string;

  constructor(opts?: { filePath?: string }) {
    this.filePath = opts?.filePath;
    if (this.filePath) this.loadInterruptedFromSnapshot();
  }

  /** Đọc snapshot cũ: mọi entry `running` lúc app dừng = `interrupted`. */
  private loadInterruptedFromSnapshot(): void {
    if (!this.filePath) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      // File chưa có / hỏng → không có lần chạy nào bị gián đoạn.
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== GROUP_BOT_STATUS_FILE_VERSION ||
      !Array.isArray((parsed as { running?: unknown }).running)
    ) {
      return;
    }
    const entries = (parsed as { running: unknown[] }).running;
    for (const entry of entries.slice(0, GROUP_BOT_STATUS_MAX_ENTRIES)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { groupId, botId, since } = entry as Record<string, unknown>;
      if (typeof groupId !== 'string' || !groupId) continue;
      if (typeof botId !== 'string' || !botId) continue;
      if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) continue;
      let group = this.interruptedByGroup.get(groupId);
      if (!group) {
        group = new Map();
        this.interruptedByGroup.set(groupId, group);
      }
      if (!group.has(botId)) group.set(botId, { since });
    }
  }

  /** Ghi snapshot `running` hiện tại xuống đĩa (atomic, 0600, nuốt lỗi). */
  private persist(): void {
    if (!this.filePath) return;
    try {
      const running: Array<{ groupId: string; botId: string; since: string }> = [];
      for (const [groupId, group] of this.byGroup) {
        for (const [botId, { since }] of group) {
          running.push({ groupId, botId, since });
          if (running.length >= GROUP_BOT_STATUS_MAX_ENTRIES) break;
        }
        if (running.length >= GROUP_BOT_STATUS_MAX_ENTRIES) break;
      }
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ version: GROUP_BOT_STATUS_FILE_VERSION, running }, null, 2),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // chmod lỗi trên FS lạ thì vẫn giữ file đã rename.
      }
    } catch {
      // Persist hỏng không được làm đổ lần chạy — tracker vẫn đúng
      // trong bộ nhớ; lần chạy bị gián đoạn sau đó chỉ không được báo.
    }
  }

  /** Đánh dấu bot bắt đầu chạy trong nhóm (ghi đè lần chạy trước nếu có). */
  markRunning(groupId: string, botId: string): void {
    if (!groupId || !botId) return;
    let group = this.byGroup.get(groupId);
    if (!group) {
      group = new Map();
      this.byGroup.set(groupId, group);
    }
    group.set(botId, { since: new Date().toISOString() });
    // Bot chạy lại thì lần chạy dở trước đó (nếu có) không còn treo.
    this.interruptedByGroup.get(groupId)?.delete(botId);
    if (this.interruptedByGroup.get(groupId)?.size === 0) {
      this.interruptedByGroup.delete(groupId);
    }
    this.persist();
  }

  /** Đánh dấu bot xong việc trong nhóm (xoá entry; nhóm rỗng thì dọn luôn). */
  markIdle(groupId: string, botId: string): void {
    const group = this.byGroup.get(groupId);
    if (group) {
      group.delete(botId);
      if (group.size === 0) this.byGroup.delete(groupId);
    }
    this.interruptedByGroup.get(groupId)?.delete(botId);
    if (this.interruptedByGroup.get(groupId)?.size === 0) {
      this.interruptedByGroup.delete(groupId);
    }
    this.persist();
  }

  /** Bot có đang chạy trong nhóm không. */
  isRunning(groupId: string, botId: string): boolean {
    return this.byGroup.get(groupId)?.has(botId) === true;
  }

  /** Các bot đang chạy trong nhóm (bản copy, sắp theo `since`). */
  getStatus(groupId: string): GroupBotStatusEntry[] {
    const group = this.byGroup.get(groupId);
    if (!group) return [];
    return [...group.entries()]
      .map(([botId, { since }]) => ({ botId, status: 'running' as const, since }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }

  /** Các bot đang chạy dở thì app dừng (bản copy, sắp theo `since`). */
  getInterrupted(groupId: string): GroupBotInterruptedEntry[] {
    const group = this.interruptedByGroup.get(groupId);
    if (!group) return [];
    return [...group.entries()]
      .map(([botId, { since }]) => ({ botId, since }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }

  /** User bấm Bỏ qua: xoá ghi nhận "chạy dở" của một bot trong nhóm. */
  clearInterrupted(groupId: string, botId: string): void {
    this.interruptedByGroup.get(groupId)?.delete(botId);
    if (this.interruptedByGroup.get(groupId)?.size === 0) {
      this.interruptedByGroup.delete(groupId);
    }
    // Rewrite the snapshot too: otherwise the next restart would
    // resurrect this dismissed entry from the stale file.
    this.persist();
  }

  /** Xoá mọi trạng thái của một nhóm (nhóm bị xoá). */
  clearGroup(groupId: string): void {
    this.byGroup.delete(groupId);
    this.interruptedByGroup.delete(groupId);
    this.persist();
  }
}

/** Tên file group chat trong thư mục dữ liệu local (userData). */
export const GROUP_CHATS_FILE_NAME = 'group-chats.json';

/** Phiên bản format file group chat. */
export const GROUP_CHATS_FILE_VERSION = 1;

/** Giới hạn message mỗi nhóm giữ trong file (chống file phình vô hạn). */
export const MAX_GROUP_MESSAGES = 1000;

export interface GroupChat {
  id: string;
  name: string;
  /** Id các bot trong nhóm (theo thứ tự thêm). */
  botIds: string[];
  createdAt: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  /** Id bot nói; '' = người dùng gửi vào nhóm. */
  botId: string;
  /** Tên hiển thị của người nói (tên bot, hoặc 'Bạn'). */
  botName: string;
  text: string;
  /** Id các bot được @mention trong message này. */
  mentions: string[];
  /** true khi message này là câu trả lời delegation cho một mention. */
  delegated: boolean;
  /**
   * v0.94c: ảnh đính kèm (chỉ tham chiếu file — xem
   * `GroupMessageAttachment`). Message có ảnh thì `text` được rỗng.
   */
  attachments?: GroupMessageAttachment[];
  createdAt: string;
}

/**
 * v0.94c: một ảnh đính kèm của message nhóm.
 *
 * Chỉ lưu THAM CHIẾU file, không nhúng base64 vào `group-chats.json`
 * (ảnh tới 10 MB/ảnh — nhúng vào JSON sẽ phình file và làm chậm mọi
 * lần đọc lịch sử). File nằm trong thư mục `group-attachments` cạnh
 * file group-chats.json; `file` chỉ là tên file (không chứa '/').
 * Store không có filePath (chỉ giữ trong bộ nhớ — test) thì bytes giữ
 * trong map nội bộ, không chạm đĩa.
 */
export interface GroupMessageAttachment {
  id: string;
  mimeType: string;
  name?: string;
  sizeBytes: number;
  /** Tên file trong thư mục group-attachments (không chứa '/'). */
  file: string;
}

/** Tên thư mục chứa file ảnh đính kèm (cạnh file group-chats.json). */
export const GROUP_ATTACHMENTS_DIRNAME = 'group-attachments';

/**
 * Hậu tố file theo MIME ảnh — cùng allowlist với vision channel
 * (`core/agent/vision.ts` VISION_ALLOWED_MIME_TYPES).
 */
export const GROUP_ATTACHMENT_EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Bot tối thiểu mà parser mention cần biết (id + tên hiển thị). */
export interface MentionableBot {
  id: string;
  name: string;
}

/** Chuẩn hoá tên để khớp @mention: bỏ khoảng trắng, thường hoá. */
export function normalizeBotName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Parse @mention bot trong text: `@TênBot` / `@bot-id`. Trả về id các
 * bot được nhắc (theo thứ tự xuất hiện, không trùng). Token sau `@`
 * lấy tới khoảng trắng hoặc dấu câu; khớp id chính xác hoặc tên đã
 * chuẩn hoá (bỏ khoảng trắng). `@files`/`@docs` (mention file v0.16)
 * không phải mention bot nên không khớp.
 */
export function parseGroupMentions(text: string, bots: readonly MentionableBot[]): string[] {
  if (!text || bots.length === 0) return [];
  const byId = new Map(bots.map((b) => [b.id.toLowerCase(), b.id]));
  const byName = new Map(bots.map((b) => [normalizeBotName(b.name), b.id]));
  const out: string[] = [];
  // Quét từng '@': thử khớp tên bot DÀI NHẤT trước (tối đa 3 từ sau
  // @), rồi mới tới token đơn — để `@Bot A` khớp bot tên "Bot A"
  // chứ không chỉ khớp "Bot". `@files`/`@docs` (mention file v0.16)
  // không phải mention bot nên không khớp.
  const re = /@/g;
  let at: RegExpExecArray | null;
  while ((at = re.exec(text)) !== null) {
    const rest = text.slice(at.index + 1);
    const words = rest
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .slice(0, 3);
    let matchedId: string | undefined;
    let consumed = 0;
    for (let n = words.length; n >= 1; n--) {
      const joined = words
        .slice(0, n)
        .join(' ')
        .replace(/[.,;:!?)]+$/, '');
      const id =
        byName.get(normalizeBotName(joined)) ?? byId.get(joined.toLowerCase());
      if (id) {
        matchedId = id;
        consumed = words.slice(0, n).join(' ').length;
        break;
      }
    }
    if (matchedId) {
      if (!out.includes(matchedId)) out.push(matchedId);
      re.lastIndex = at.index + 1 + consumed;
    }
  }
  return out;
}

interface StoredGroupChatsFile {
  version: number;
  groups: GroupChat[];
  messages: GroupMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * v0.94c: parse mảng attachments đã lưu — chỉ giữ entry đủ shape
 * (`id`/`mimeType`/`file` string, `sizeBytes` number, `file` không
 * chứa '/'); entry hỏng bị bỏ, không làm hỏng cả message.
 */
function parseStoredAttachments(value: unknown): GroupMessageAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: GroupMessageAttachment[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry['id'] !== 'string' ||
      entry['id'] === '' ||
      typeof entry['mimeType'] !== 'string' ||
      entry['mimeType'] === '' ||
      typeof entry['file'] !== 'string' ||
      entry['file'] === '' ||
      entry['file'].includes('/') ||
      entry['file'].includes('\\') ||
      typeof entry['sizeBytes'] !== 'number'
    ) {
      continue;
    }
    out.push({
      id: entry['id'],
      mimeType: entry['mimeType'],
      ...(typeof entry['name'] === 'string' && entry['name'] !== ''
        ? { name: entry['name'] }
        : {}),
      sizeBytes: entry['sizeBytes'],
      file: entry['file'],
    });
  }
  return out;
}

function parseStoredFile(text: string, filePath: string): StoredGroupChatsFile {
  const empty: StoredGroupChatsFile = { version: GROUP_CHATS_FILE_VERSION, groups: [], messages: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.warn(
      `[group-chat] File group chat hỏng (${filePath}): ${err instanceof Error ? err.message : String(err)} — dùng danh sách rỗng.`,
    );
    return empty;
  }
  if (!isRecord(data) || !Array.isArray(data['groups']) || !Array.isArray(data['messages'])) {
    console.warn(`[group-chat] File group chat sai định dạng (${filePath}) — dùng danh sách rỗng.`);
    return empty;
  }
  const groups: GroupChat[] = [];
  for (const entry of data['groups'] as unknown[]) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry['id'] !== 'string' ||
      typeof entry['name'] !== 'string' ||
      !Array.isArray(entry['botIds']) ||
      typeof entry['createdAt'] !== 'string'
    ) {
      continue;
    }
    groups.push({
      id: entry['id'],
      name: entry['name'],
      botIds: (entry['botIds'] as unknown[]).filter((v): v is string => typeof v === 'string'),
      createdAt: entry['createdAt'],
    });
  }
  const messages: GroupMessage[] = [];
  for (const entry of data['messages'] as unknown[]) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry['id'] !== 'string' ||
      typeof entry['groupId'] !== 'string' ||
      typeof entry['botId'] !== 'string' ||
      typeof entry['botName'] !== 'string' ||
      typeof entry['text'] !== 'string' ||
      typeof entry['createdAt'] !== 'string'
    ) {
      continue;
    }
    // v0.94c: attachments là trường mới (optional) — file cũ không có
    // thì vắng; entry hỏng thì bỏ entry đó, không bỏ cả message.
    const storedAttachments = parseStoredAttachments(entry['attachments']);
    messages.push({
      id: entry['id'],
      groupId: entry['groupId'],
      botId: entry['botId'],
      botName: entry['botName'],
      text: entry['text'],
      mentions: Array.isArray(entry['mentions'])
        ? (entry['mentions'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
      delegated: entry['delegated'] === true,
      ...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
      createdAt: entry['createdAt'],
    });
  }
  return { version: GROUP_CHATS_FILE_VERSION, groups, messages };
}

/**
 * Store group chat. `filePath` undefined = chỉ giữ trong bộ nhớ (test /
 * host chưa cấu hình thư mục dữ liệu — mất khi restart). Có filePath
 * thì mọi thay đổi ghi ngay xuống đĩa (atomic tmp + rename, mode 0600).
 */
export class GroupChatStore {
  private readonly filePath?: string;
  private groups: GroupChat[] = [];
  private messages: GroupMessage[] = [];
  /**
   * v0.94c: bytes ảnh của store không có filePath (chỉ giữ trong bộ
   * nhớ — test) — key là tên file, value là base64. Store có filePath
   * thì bytes nằm trên đĩa, map này luôn rỗng.
   */
  private readonly inlineBlobs = new Map<string, string>();

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) this.reload();
  }

  get path(): string | undefined {
    return this.filePath;
  }

  /**
   * v0.94c: thư mục chứa file ảnh đính kèm (cạnh file group-chats.json).
   * undefined khi store chỉ giữ trong bộ nhớ.
   */
  get attachmentsDir(): string | undefined {
    return this.filePath
      ? path.join(path.dirname(this.filePath), GROUP_ATTACHMENTS_DIRNAME)
      : undefined;
  }

  /**
   * v0.94c: lưu một ảnh (đã validate ở coordinator — cùng giới hạn
   * vision channel: PNG/JPEG/GIF/WebP) thành file, trả về tham chiếu
   * để gắn vào GroupMessage. MIME lạ → throw (fail-closed).
   */
  saveAttachment(att: VisionAttachment): GroupMessageAttachment {
    const ext = GROUP_ATTACHMENT_EXT_BY_MIME[att.mimeType];
    if (!ext) throw new Error(`Không hỗ trợ ảnh đính kèm loại "${att.mimeType}".`);
    const bytes = Buffer.from(att.data ?? '', 'base64');
    const file = `${randomUUID()}${ext}`;
    const ref: GroupMessageAttachment = {
      id: randomUUID(),
      mimeType: att.mimeType,
      ...(att.name ? { name: att.name } : {}),
      sizeBytes: bytes.length,
      file,
    };
    const dir = this.attachmentsDir;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, file);
      fs.writeFileSync(target, bytes, { mode: 0o600 });
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        // chmod lỗi trên FS lạ thì vẫn giữ file đã ghi.
      }
    } else {
      this.inlineBlobs.set(file, att.data ?? '');
    }
    return ref;
  }

  /**
   * v0.94c: đọc lại bytes của một ảnh đã lưu (cho delegation run và
   * IPC `group:get-attachment`). Trả null khi file mất/hỏng — caller
   * báo "ảnh không còn" thay vì crash.
   */
  readAttachment(ref: GroupMessageAttachment): VisionAttachment | null {
    if (!ref || typeof ref.file !== 'string' || ref.file.includes('/') || ref.file.includes('\\')) {
      return null;
    }
    if (!GROUP_ATTACHMENT_EXT_BY_MIME[ref.mimeType]) return null;
    const inline = this.inlineBlobs.get(ref.file);
    if (inline !== undefined) {
      return { mimeType: ref.mimeType, data: inline, ...(ref.name ? { name: ref.name } : {}) };
    }
    const dir = this.attachmentsDir;
    if (!dir) return null;
    try {
      const bytes = fs.readFileSync(path.join(dir, ref.file));
      return {
        mimeType: ref.mimeType,
        data: bytes.toString('base64'),
        ...(ref.name ? { name: ref.name } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * v0.94c: xoá file ảnh của một tham chiếu (khi message bị trim/xoá
   * nhóm, hoặc post lỗi sau khi đã lưu ảnh). Không throw. Public để
   * coordinator dọn file mồ côi khi `postMessage` lỗi sau `saveAttachment`.
   */
  deleteAttachmentFile(file: string): void {
    if (!file || file.includes('/') || file.includes('\\')) return;
    if (this.inlineBlobs.delete(file)) return;
    const dir = this.attachmentsDir;
    if (!dir) return;
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // File đã mất từ trước thì thôi.
    }
  }

  reload(): void {
    if (!this.filePath) return;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      this.groups = [];
      this.messages = [];
      return;
    }
    const parsed = parseStoredFile(text, this.filePath);
    this.groups = parsed.groups;
    this.messages = parsed.messages;
  }

  private save(): void {
    if (!this.filePath) return;
    const payload: StoredGroupChatsFile = {
      version: GROUP_CHATS_FILE_VERSION,
      groups: this.groups,
      messages: this.messages,
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // chmod lỗi trên FS lạ thì vẫn giữ file đã rename.
    }
  }

  /** Tạo nhóm mới (tên không rỗng). */
  createGroup(name: string, botIds: string[] = []): GroupChat {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Tạo nhóm chat cần tên không rỗng.');
    const group: GroupChat = {
      id: randomUUID(),
      name: trimmed,
      botIds: [...new Set(botIds.filter((b) => typeof b === 'string' && b !== ''))],
      createdAt: new Date().toISOString(),
    };
    this.groups.push(group);
    this.save();
    return { ...group, botIds: [...group.botIds] };
  }

  /** Tất cả nhóm (bản copy). */
  listGroups(): GroupChat[] {
    return this.groups.map((g) => ({ ...g, botIds: [...g.botIds] }));
  }

  /** Một nhóm theo id, hoặc undefined. */
  getGroup(groupId: string): GroupChat | undefined {
    const group = this.groups.find((g) => g.id === groupId);
    return group ? { ...group, botIds: [...group.botIds] } : undefined;
  }

  /** Thêm bot vào nhóm. Trả false khi nhóm không có hoặc bot đã trong nhóm. */
  addBot(groupId: string, botId: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group || !botId) return false;
    if (group.botIds.includes(botId)) return false;
    group.botIds.push(botId);
    this.save();
    return true;
  }

  /** Bỏ bot khỏi nhóm. Trả false khi nhóm không có hoặc bot không trong nhóm. */
  removeBot(groupId: string, botId: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return false;
    const idx = group.botIds.indexOf(botId);
    if (idx === -1) return false;
    group.botIds.splice(idx, 1);
    this.save();
    return true;
  }

  /** Xoá nhóm + toàn bộ message của nó (+ file ảnh đính kèm của chúng). Trả false khi nhóm không có. */
  deleteGroup(groupId: string): boolean {
    const idx = this.groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return false;
    this.groups.splice(idx, 1);
    for (const m of this.messages.filter((m) => m.groupId === groupId)) {
      for (const att of m.attachments ?? []) this.deleteAttachmentFile(att.file);
    }
    this.messages = this.messages.filter((m) => m.groupId !== groupId);
    this.save();
    return true;
  }

  /**
   * Thêm một message vào nhóm. Throw khi nhóm không có hoặc text rỗng
   * mà không có ảnh đính kèm. Message vượt `MAX_GROUP_MESSAGES` thì
   * message cũ nhất của nhóm bị xoá (kèm file ảnh của nó — chống file
   * phình vô hạn).
   */
  postMessage(input: {
    groupId: string;
    botId?: string;
    botName: string;
    text: string;
    mentions?: string[];
    delegated?: boolean;
    attachments?: GroupMessageAttachment[];
  }): GroupMessage {
    const group = this.groups.find((g) => g.id === input.groupId);
    if (!group) throw new Error(`Không thấy nhóm chat: "${input.groupId}".`);
    const text = input.text.trim();
    const attachments = (input.attachments ?? []).map((a) => ({ ...a }));
    if (!text && attachments.length === 0) {
      throw new Error('Message nhóm chat cần nội dung không rỗng hoặc ảnh đính kèm.');
    }
    const message: GroupMessage = {
      id: randomUUID(),
      groupId: input.groupId,
      botId: input.botId ?? '',
      botName: input.botName.trim() || 'Bạn',
      text,
      mentions: [...new Set(input.mentions ?? [])],
      delegated: input.delegated === true,
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    const groupMessages = this.messages.filter((m) => m.groupId === input.groupId);
    if (groupMessages.length > MAX_GROUP_MESSAGES) {
      const excess = groupMessages.length - MAX_GROUP_MESSAGES;
      let removed = 0;
      this.messages = this.messages.filter((m) => {
        if (m.groupId === input.groupId && removed < excess) {
          removed += 1;
          // v0.94c: message bị trim thì xoá luôn file ảnh của nó.
          for (const att of m.attachments ?? []) this.deleteAttachmentFile(att.file);
          return false;
        }
        return true;
      });
    }
    this.save();
    return { ...message, mentions: [...message.mentions] };
  }

  /** Lịch sử một nhóm theo thứ tự thời gian (cũ → mới). */
  listMessages(groupId: string, limit = 100): GroupMessage[] {
    const out = this.messages
      .filter((m) => m.groupId === groupId)
      .slice(-Math.max(1, limit))
      .map((m) => ({
        ...m,
        mentions: [...m.mentions],
        ...(m.attachments ? { attachments: m.attachments.map((a) => ({ ...a })) } : {}),
      }));
    return out;
  }
}
