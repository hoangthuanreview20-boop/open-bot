/**
 * Channels (v0.96 Team T4).
 *
 * Ý tưởng học từ OpenMausBot (chỉ lấy kiến trúc, tự thiết kế lại):
 * một "channel" là một không gian làm việc chung cho nhiều bot — có
 * transcript riêng, hướng dẫn chung, thư mục làm việc, và quy tắc
 * bot nào trả lời tin nhắn trong channel. Khác group chat (M8) ở chỗ:
 *  - Group chat: thread bot-bot, @mention gọi bot chạy việc.
 *  - Channel: không gian LÀM VIỆC — bot trong roster chia nhau việc
 *    theo responder rules, có shared instructions + working folder
 *    đưa vào system prompt của mọi bot khi trả lời trong channel.
 *
 * Module này là PURE + file store (kiểu GroupChatStore/AutoApprove:
 * JSON bền vững, ghi atomic, hỏng thì về rỗng fail-closed). Logic
 * chạy bot KHÔNG ở đây — xem `coordinatorAdapter.ts` (host tiêm hàm
 * chạy, giống cách groupchat để coordinator chạy delegation).
 *
 * Responder rules (`ChannelResponderRules`):
 *  - mode 'mentioned': chỉ bot được @mention mới trả lời (giống
 *    group chat; mặc định).
 *  - mode 'all': mọi bot trong roster đều trả lời (mỗi bot một góc
 *    nhìn — dùng cho brainstorm/review).
 *  - mode 'round-robin': mỗi tin nhắn chỉ 1 bot trả lời, xoay vòng
 *    theo roster (bot nào rảnh thì làm — tránh 2 bot cùng làm 1 việc).
 *  - mode 'first': chỉ bot đầu roster trả lời (bot "chủ trì").
 *  - mode 'none': không bot nào tự trả lời (channel chỉ để đọc/ghi
 *    chú — user gọi tay từng bot).
 *  - `onlyBotIds` (mọi mode trừ 'none'): giới hạn bot được trả lời
 *    trong số bot của roster — vd channel dev chỉ 2 bot code trả
 *    lời, bot research chỉ đọc.
 *  - `requireMentionFor` — liệt kê bot chỉ trả lời khi bị @mention
 *    (kể cả khi mode là 'all'/'round-robin'/'first'): bot "im lặng"
 *    trừ khi được gọi tên.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Loại channel: việc chung, cá nhân, hay theo dự án. */
export type ChannelKind = 'work' | 'personal' | 'project';

/** Mode quyết định bot nào trả lời một tin nhắn trong channel. */
export type ChannelResponderMode = 'mentioned' | 'all' | 'round-robin' | 'first' | 'none';

/** Quy tắc bot nào trả lời tin nhắn trong channel. */
export interface ChannelResponderRules {
  /** Mode chính (mặc định 'mentioned'). */
  mode: ChannelResponderMode;
  /** Giới hạn bot được trả lời (rỗng/undefined = mọi bot trong roster). */
  onlyBotIds?: string[];
  /** Bot chỉ trả lời khi bị @mention (kể cả mode all/round-robin/first). */
  requireMentionFor?: string[];
}

/** Một tin nhắn trong transcript của channel. */
export interface ChannelMessage {
  /** Id tin nhắn. */
  id: string;
  /** Id channel. */
  channelId: string;
  /** Id bot nói; '' = người dùng gửi vào channel. */
  botId: string;
  /** Tên hiển thị của người nói. */
  botName: string;
  /** Nội dung tin nhắn. */
  text: string;
  /** Id các bot được @mention trong tin nhắn này. */
  mentions: string[];
  /** true khi tin nhắn này là câu trả lời của bot theo responder rules. */
  delegated: boolean;
  /** ISO timestamp tạo. */
  createdAt: string;
}

/** Một channel: không gian làm việc chung của nhiều bot. */
export interface Channel {
  /** Id channel (uuid). */
  id: string;
  /** Tên hiển thị. */
  name: string;
  /** Loại channel. */
  kind: ChannelKind;
  /** Hướng dẫn chung — đưa vào system prompt mọi bot khi trả lời trong channel. */
  sharedInstructions: string;
  /** Thư mục làm việc của channel (bot dùng làm cwd mặc định). */
  workingFolder: string;
  /** Id các bot trong roster (theo thứ tự thêm). */
  botIds: string[];
  /** Quy tắc bot nào trả lời. */
  responderRules: ChannelResponderRules;
  /** ISO timestamp tạo. */
  createdAt: string;
  /** ISO timestamp sửa gần nhất. */
  updatedAt: string;
}

/** Dữ liệu tạo channel mới (name bắt buộc, còn lại có mặc định). */
export interface CreateChannelInput {
  name: string;
  kind?: ChannelKind;
  sharedInstructions?: string;
  workingFolder?: string;
  botIds?: string[];
  responderRules?: Partial<ChannelResponderRules>;
}

/** Dữ liệu sửa channel (chỉ field nào có thì đổi). */
export interface UpdateChannelInput {
  name?: string;
  kind?: ChannelKind;
  sharedInstructions?: string;
  workingFolder?: string;
  responderRules?: Partial<ChannelResponderRules>;
}

/** Tên file lưu channel (cùng thư mục dữ liệu với group-chats.json). */
export const CHANNELS_FILE_NAME = 'channels.json';
/** Phiên bản format file channel. */
export const CHANNELS_FILE_VERSION = 1;
/** Số tin nhắn tối đa giữ trong transcript mỗi channel (chống file phình). */
export const CHANNEL_MAX_MESSAGES = 500;
/** Tên channel tối đa 80 ký tự; working folder tối đa 500 ký tự. */
export const CHANNEL_MAX_NAME_LENGTH = 80;
export const CHANNEL_MAX_WORKING_FOLDER_LENGTH = 500;
/** Shared instructions tối đa 20.000 ký tự (đưa vào system prompt). */
export const CHANNEL_MAX_INSTRUCTIONS_LENGTH = 20_000;

/** Mode mặc định khi tạo channel: chỉ bot được @mention mới trả lời. */
export const DEFAULT_CHANNEL_RESPONDER_RULES: ChannelResponderRules = { mode: 'mentioned' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

function normalizeResponderRules(input: Partial<ChannelResponderRules> | undefined): ChannelResponderRules {
  const mode = input?.mode;
  const valid: ChannelResponderMode[] = ['mentioned', 'all', 'round-robin', 'first', 'none'];
  const rules: ChannelResponderRules = { mode: valid.includes(mode as ChannelResponderMode) ? (mode as ChannelResponderMode) : 'mentioned' };
  if (input?.onlyBotIds !== undefined) rules.onlyBotIds = asStringArray(input.onlyBotIds);
  if (input?.requireMentionFor !== undefined) rules.requireMentionFor = asStringArray(input.requireMentionFor);
  return rules;
}

function validateChannelName(name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('Tên channel không được rỗng.');
  if (trimmed.length > CHANNEL_MAX_NAME_LENGTH) {
    throw new Error(`Tên channel tối đa ${CHANNEL_MAX_NAME_LENGTH} ký tự.`);
  }
}

function validateWorkingFolder(folder: string): void {
  if (folder.length > CHANNEL_MAX_WORKING_FOLDER_LENGTH) {
    throw new Error(`Thư mục làm việc tối đa ${CHANNEL_MAX_WORKING_FOLDER_LENGTH} ký tự.`);
  }
}

function validateInstructions(text: string): void {
  if (text.length > CHANNEL_MAX_INSTRUCTIONS_LENGTH) {
    throw new Error(`Hướng dẫn chung tối đa ${CHANNEL_MAX_INSTRUCTIONS_LENGTH} ký tự.`);
  }
}

/**
 * Tạo một channel mới (chưa lưu — store lưu khi `createChannel`).
 * Id là uuid; createdAt/updatedAt là thời điểm tạo.
 */
export function createChannelObject(input: CreateChannelInput, now: Date = new Date()): Channel {
  validateChannelName(input.name);
  const instructions = input.sharedInstructions ?? '';
  validateInstructions(instructions);
  const folder = input.workingFolder ?? '';
  validateWorkingFolder(folder);
  const stamp = now.toISOString();
  return {
    id: randomUUID(),
    name: input.name.trim(),
    kind: input.kind ?? 'work',
    sharedInstructions: instructions,
    workingFolder: folder,
    botIds: asStringArray(input.botIds),
    responderRules: normalizeResponderRules(input.responderRules),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * Parse @mention trong text thành id bot (khớp id hoặc tên bot, không
 * phân biệt hoa/thường; tên có khoảng trắng thì khớp cả `@TênBot`
 * viết liền — cùng quy ước với group chat M8).
 */
export function parseChannelMentions(
  text: string,
  bots: readonly { id: string; name: string }[],
): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const bot of bots) {
    const byId = `@${bot.id.toLowerCase()}`;
    const byName = `@${bot.name.toLowerCase()}`;
    const byNameSquashed = `@${bot.name.toLowerCase().replace(/\s+/g, '')}`;
    if (
      lower.includes(byId) ||
      (bot.name !== '' && (lower.includes(byName) || lower.includes(byNameSquashed)))
    ) {
      if (!found.includes(bot.id)) found.push(bot.id);
    }
  }
  return found;
}

/**
 * Quyết định bot nào trả lời một tin nhắn trong channel, theo
 * responder rules + @mention.
 *
 * Thứ tự: mode 'none' → không ai; bot trong `requireMentionFor` mà
 * không bị mention → loại; mode 'mentioned' → chỉ bot bị mention;
 * mode 'all' → mọi bot (sau khi lọc onlyBotIds + requireMention);
 * mode 'first' → bot đầu roster (sau lọc); mode 'round-robin' →
 * bot kế tiếp sau `lastResponderId` trong roster (sau lọc), xoay vòng.
 * `onlyBotIds` lọc TRƯỚC mọi mode (trừ 'none').
 */
export function resolveChannelResponders(
  channel: Channel,
  message: { text: string; mentions: string[] },
  opts: { lastResponderId?: string } = {},
): string[] {
  const rules = channel.responderRules ?? DEFAULT_CHANNEL_RESPONDER_RULES;
  if (rules.mode === 'none') return [];
  let eligible = [...channel.botIds];
  if (rules.onlyBotIds !== undefined && rules.onlyBotIds.length > 0) {
    eligible = eligible.filter((id) => rules.onlyBotIds!.includes(id));
  }
  if (eligible.length === 0) return [];
  const requireMention = new Set(rules.requireMentionFor ?? []);
  const mentioned = new Set(message.mentions);
  // Bot "chỉ khi được gọi tên" mà không bị mention thì không trả lời.
  eligible = eligible.filter((id) => !requireMention.has(id) || mentioned.has(id));
  if (eligible.length === 0) return [];
  switch (rules.mode) {
    case 'mentioned': {
      return eligible.filter((id) => mentioned.has(id));
    }
    case 'all': {
      return eligible;
    }
    case 'first': {
      return [eligible[0]];
    }
    case 'round-robin': {
      if (!opts.lastResponderId) return [eligible[0]];
      const idx = eligible.indexOf(opts.lastResponderId);
      // Bot trả lời lần trước không còn trong roster → bắt đầu lại từ đầu.
      if (idx === -1) return [eligible[0]];
      return [eligible[(idx + 1) % eligible.length]];
    }
    default:
      return [];
  }
}

/**
 * System prompt bổ sung cho bot khi trả lời trong channel: hướng
 * dẫn chung + thư mục làm việc + tên/loại channel. Rỗng khi channel
 * không có shared instructions lẫn working folder.
 */
export function buildChannelSystemPrompt(channel: Channel): string {
  const parts: string[] = [];
  parts.push(`Bạn đang làm việc trong channel "${channel.name}" (loại: ${channel.kind}).`);
  if (channel.sharedInstructions.trim() !== '') {
    parts.push(`Hướng dẫn chung của channel:\n${channel.sharedInstructions.trim()}`);
  }
  if (channel.workingFolder.trim() !== '') {
    parts.push(`Thư mục làm việc của channel: ${channel.workingFolder.trim()} (dùng làm thư mục mặc định khi đọc/ghi file, trừ khi user chỉ định khác).`);
  }
  if (channel.botIds.length > 1) {
    parts.push(
      'Channel này có nhiều bot cùng làm việc — chỉ làm phần việc của bạn, đừng làm lại việc của bot khác, và ghi rõ kết quả để bot khác nối tiếp được.',
    );
  }
  return parts.join('\n\n');
}

/** Dạng file channels.json trên đĩa. */
interface ChannelsFileData {
  version: number;
  channels: Channel[];
  /** Transcript mỗi channel (key = channel id). */
  transcripts: Record<string, ChannelMessage[]>;
  /** Bot trả lời gần nhất mỗi channel (cho round-robin). */
  lastResponders: Record<string, string>;
}

function emptyFileData(): ChannelsFileData {
  return { version: CHANNELS_FILE_VERSION, channels: [], transcripts: {}, lastResponders: {} };
}

function parseChannelsFile(raw: string): ChannelsFileData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyFileData();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.channels)) return emptyFileData();
  const channels: Channel[] = [];
  for (const item of parsed.channels as unknown[]) {
    if (!isRecord(item)) continue;
    const name = asNonEmptyString(item.name);
    const id = asNonEmptyString(item.id);
    if (!name || !id) continue;
    const kind = item.kind === 'personal' || item.kind === 'project' ? item.kind : 'work';
    channels.push({
      id,
      name,
      kind,
      sharedInstructions: typeof item.sharedInstructions === 'string' ? item.sharedInstructions : '',
      workingFolder: typeof item.workingFolder === 'string' ? item.workingFolder : '',
      botIds: asStringArray(item.botIds),
      responderRules: normalizeResponderRules(isRecord(item.responderRules) ? (item.responderRules as Partial<ChannelResponderRules>) : undefined),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
    });
  }
  const transcripts: Record<string, ChannelMessage[]> = {};
  if (isRecord(parsed.transcripts)) {
    for (const [channelId, msgs] of Object.entries(parsed.transcripts)) {
      if (!Array.isArray(msgs)) continue;
      const list: ChannelMessage[] = [];
      for (const m of msgs as unknown[]) {
        if (!isRecord(m)) continue;
        const mid = asNonEmptyString(m.id);
        if (!mid) continue;
        list.push({
          id: mid,
          channelId,
          botId: typeof m.botId === 'string' ? m.botId : '',
          botName: typeof m.botName === 'string' ? m.botName : '',
          text: typeof m.text === 'string' ? m.text : '',
          mentions: asStringArray(m.mentions),
          delegated: m.delegated === true,
          createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
        });
      }
      transcripts[channelId] = list.slice(-CHANNEL_MAX_MESSAGES);
    }
  }
  const lastResponders: Record<string, string> = {};
  if (isRecord(parsed.lastResponders)) {
    for (const [k, v] of Object.entries(parsed.lastResponders)) {
      if (typeof v === 'string' && v !== '') lastResponders[k] = v;
    }
  }
  return { version: CHANNELS_FILE_VERSION, channels, transcripts, lastResponders };
}

/**
 * Store channel bền vững (file JSON, ghi atomic qua file tạm +
 * rename — cùng kiểu GroupChatStore). File hỏng → về rỗng
 * fail-closed, không crash app.
 */
export class ChannelStore {
  private readonly filePath: string | undefined;
  private data: ChannelsFileData;

  /**
   * `dataDir` là thư mục chứa `channels.json`; không có dataDir thì
   * store chỉ giữ trong bộ nhớ (như GroupChatStore không có filePath).
   */
  constructor(dataDir?: string) {
    this.filePath = dataDir ? path.join(dataDir, CHANNELS_FILE_NAME) : undefined;
    this.data = this.load();
  }

  private load(): ChannelsFileData {
    try {
      if (!this.filePath || !fs.existsSync(this.filePath)) return emptyFileData();
      return parseChannelsFile(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return emptyFileData();
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Ghi hỏng (quyền/đĩa đầy) không làm đổ lần chạy: bộ nhớ vẫn đúng.
    }
  }

  /** Toàn bộ channel (bản copy, theo thứ tự tạo). */
  listChannels(): Channel[] {
    return this.data.channels.map((c) => ({ ...c, botIds: [...c.botIds], responderRules: { ...c.responderRules } }));
  }

  /** Tìm channel theo id (undefined khi không có). */
  getChannel(id: string): Channel | undefined {
    const found = this.data.channels.find((c) => c.id === id);
    if (!found) return undefined;
    return { ...found, botIds: [...found.botIds], responderRules: { ...found.responderRules } };
  }

  /** Tạo channel mới (tên trùng vẫn cho phép — id mới phân biệt). */
  createChannel(input: CreateChannelInput): Channel {
    const channel = createChannelObject(input);
    this.data.channels.push(channel);
    this.data.transcripts[channel.id] = [];
    this.persist();
    return { ...channel, botIds: [...channel.botIds], responderRules: { ...channel.responderRules } };
  }

  /** Sửa channel (chỉ field nào có thì đổi). Trả undefined khi không tìm thấy. */
  updateChannel(id: string, input: UpdateChannelInput): Channel | undefined {
    const channel = this.data.channels.find((c) => c.id === id);
    if (!channel) return undefined;
    if (input.name !== undefined) {
      validateChannelName(input.name);
      channel.name = input.name.trim();
    }
    if (input.kind !== undefined) channel.kind = input.kind;
    if (input.sharedInstructions !== undefined) {
      validateInstructions(input.sharedInstructions);
      channel.sharedInstructions = input.sharedInstructions;
    }
    if (input.workingFolder !== undefined) {
      validateWorkingFolder(input.workingFolder);
      channel.workingFolder = input.workingFolder;
    }
    if (input.responderRules !== undefined) {
      channel.responderRules = normalizeResponderRules({
        ...channel.responderRules,
        ...input.responderRules,
      });
    }
    channel.updatedAt = new Date().toISOString();
    this.persist();
    return { ...channel, botIds: [...channel.botIds], responderRules: { ...channel.responderRules } };
  }

  /** Xoá channel + transcript + trạng thái round-robin của nó. Trả false khi không tìm thấy. */
  deleteChannel(id: string): boolean {
    const idx = this.data.channels.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this.data.channels.splice(idx, 1);
    delete this.data.transcripts[id];
    delete this.data.lastResponders[id];
    this.persist();
    return true;
  }

  /** Thêm bot vào roster (đã có thì không thêm lần 2). Trả undefined khi không tìm thấy channel. */
  addBotToChannel(channelId: string, botId: string): Channel | undefined {
    const channel = this.data.channels.find((c) => c.id === channelId);
    if (!channel) return undefined;
    if (botId !== '' && !channel.botIds.includes(botId)) {
      channel.botIds.push(botId);
      channel.updatedAt = new Date().toISOString();
      this.persist();
    }
    return { ...channel, botIds: [...channel.botIds], responderRules: { ...channel.responderRules } };
  }

  /** Bớt bot khỏi roster. Trả undefined khi không tìm thấy channel. */
  removeBotFromChannel(channelId: string, botId: string): Channel | undefined {
    const channel = this.data.channels.find((c) => c.id === channelId);
    if (!channel) return undefined;
    const idx = channel.botIds.indexOf(botId);
    if (idx !== -1) {
      channel.botIds.splice(idx, 1);
      channel.updatedAt = new Date().toISOString();
      this.persist();
    }
    return { ...channel, botIds: [...channel.botIds], responderRules: { ...channel.responderRules } };
  }

  /**
   * Chuyển bot từ channel này sang channel khác (rời roster cũ, vào
   * roster mới). Trả false khi một trong hai channel không tồn tại.
   */
  moveBotBetweenChannels(fromChannelId: string, toChannelId: string, botId: string): boolean {
    const from = this.data.channels.find((c) => c.id === fromChannelId);
    const to = this.data.channels.find((c) => c.id === toChannelId);
    if (!from || !to || fromChannelId === toChannelId) return false;
    const idx = from.botIds.indexOf(botId);
    if (idx !== -1) from.botIds.splice(idx, 1);
    if (!to.botIds.includes(botId)) to.botIds.push(botId);
    const stamp = new Date().toISOString();
    from.updatedAt = stamp;
    to.updatedAt = stamp;
    this.persist();
    return true;
  }

  /** Transcript của channel (bản copy, cũ → mới, tối đa CHANNEL_MAX_MESSAGES). */
  listChannelMessages(channelId: string, limit = 100): ChannelMessage[] {
    const msgs = this.data.transcripts[channelId] ?? [];
    return msgs.slice(-Math.max(1, limit)).map((m) => ({ ...m, mentions: [...m.mentions] }));
  }

  /** Ghi một tin nhắn vào transcript (tự cắt khi quá CHANNEL_MAX_MESSAGES). */
  postChannelMessage(
    channelId: string,
    input: { botId: string; botName: string; text: string; mentions?: string[]; delegated?: boolean },
  ): ChannelMessage | undefined {
    if (!this.data.channels.some((c) => c.id === channelId)) return undefined;
    const message: ChannelMessage = {
      id: randomUUID(),
      channelId,
      botId: input.botId,
      botName: input.botName,
      text: input.text,
      mentions: [...(input.mentions ?? [])],
      delegated: input.delegated === true,
      createdAt: new Date().toISOString(),
    };
    const list = this.data.transcripts[channelId] ?? (this.data.transcripts[channelId] = []);
    list.push(message);
    while (list.length > CHANNEL_MAX_MESSAGES) list.shift();
    this.persist();
    return { ...message, mentions: [...message.mentions] };
  }

  /** Bot trả lời gần nhất của channel (cho round-robin). */
  getLastResponder(channelId: string): string | undefined {
    return this.data.lastResponders[channelId];
  }

  /** Ghi bot vừa trả lời trong channel (cho round-robin lần sau). */
  setLastResponder(channelId: string, botId: string): void {
    this.data.lastResponders[channelId] = botId;
    this.persist();
  }

  /**
   * Quyết định bot nào trả lời tin nhắn mới trong channel (dùng
   * trạng thái round-robin đã lưu). Không ghi gì xuống đĩa.
   */
  resolveResponders(channelId: string, text: string, mentions: string[]): string[] {
    const channel = this.data.channels.find((c) => c.id === channelId);
    if (!channel) return [];
    return resolveChannelResponders(channel, { text, mentions }, { lastResponderId: this.data.lastResponders[channelId] });
  }
}
