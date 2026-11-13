/**
 * Bot management (v0.96, Team T6) — the gap the v0.95 repo survey
 * called out: the sidebar could only create / edit / clone / delete
 * a bot. Now a bot also has lightweight UI state kept in
 * localStorage (never on the server, never in the bot config):
 *
 * - pinned — pinned bots sort to the top of the list;
 * - unread — a bot with new activity the user has not opened yet
 *   (the sidebar shows a dot; opening the bot clears it);
 * - hidden — hidden bots leave the list but are not deleted (the
 *   user can unhide them from Settings or the palette).
 *
 * Duplicate and copy-conversation-id are pure helpers over the bot
 * record: duplicate builds a new config (fresh id, " (copy)" name,
 * same provider/model/workspace) for App to create through the
 * normal `bots:create` IPC; copy-conversation-id returns the id
 * string the clipboard action writes.
 *
 * Everything here is pure and framework-free so node --test can
 * drive it without Electron.
 */

export interface BotLike {
  id: string;
  name: string;
  providerId: string;
  model: string;
  systemPrompt?: string;
  workspaceDir?: string;
  description?: string;
  color?: string;
}

/** Per-bot UI state (localStorage `open-bot:bot-meta`). */
export interface BotMeta {
  pinned?: boolean;
  unread?: boolean;
  hidden?: boolean;
  /** When the bot was pinned (pins sort oldest-first among pins). */
  pinnedAt?: number;
}

export type BotMetaMap = Record<string, BotMeta>;

const COPY_SUFFIX = ' (copy)';

/** A bot is visible in the sidebar list (not hidden). */
export function isBotVisible(meta: BotMeta | undefined): boolean {
  return meta?.hidden !== true;
}

/** Bots the sidebar shows, in display order: pinned first (by
 * pin time), then the rest in list order. Hidden bots are dropped. */
export function sortBots<T extends BotLike>(bots: readonly T[], meta: BotMetaMap): T[] {
  const visible = bots.filter((b) => isBotVisible(meta[b.id]));
  const pinned = visible.filter((b) => meta[b.id]?.pinned === true);
  const rest = visible.filter((b) => meta[b.id]?.pinned !== true);
  pinned.sort((a, b) => (meta[a.id]?.pinnedAt ?? 0) - (meta[b.id]?.pinnedAt ?? 0));
  return [...pinned, ...rest];
}

/** Toggle pin; returns the new meta map (input is never mutated). */
export function togglePin(meta: BotMetaMap, botId: string, at = Date.now()): BotMetaMap {
  const current = meta[botId] ?? {};
  const next = { ...meta };
  if (current.pinned) {
    const { pinned, pinnedAt, ...rest } = current;
    next[botId] = rest;
  } else {
    next[botId] = { ...current, pinned: true, pinnedAt: at };
  }
  return next;
}

export function setBotUnread(meta: BotMetaMap, botId: string, unread: boolean): BotMetaMap {
  const current = meta[botId] ?? {};
  const next = { ...meta };
  if (unread) next[botId] = { ...current, unread: true };
  else {
    const { unread: _u, ...rest } = current;
    next[botId] = rest;
  }
  return next;
}

export function setBotHidden(meta: BotMetaMap, botId: string, hidden: boolean): BotMetaMap {
  const current = meta[botId] ?? {};
  const next = { ...meta };
  if (hidden) next[botId] = { ...current, hidden: true };
  else {
    const { hidden: _h, ...rest } = current;
    next[botId] = rest;
  }
  return next;
}

/** How many visible bots have unread activity. */
export function countUnread(bots: readonly BotLike[], meta: BotMetaMap): number {
  return bots.filter((b) => isBotVisible(meta[b.id]) && meta[b.id]?.unread === true).length;
}

/** Hidden bots, for the "show hidden" list in Settings / palette. */
export function hiddenBots<T extends BotLike>(bots: readonly T[], meta: BotMetaMap): T[] {
  return bots.filter((b) => meta[b.id]?.hidden === true);
}

/**
 * Duplicate a bot: a fresh id (the caller passes a unique one —
 * `crypto.randomUUID()` in the browser) and " (copy)" appended to
 * the name. Everything else is copied verbatim so the copy behaves
 * exactly like the original until the user edits it.
 */
export function duplicateBot<T extends BotLike>(bot: T, newId: string): T {
  if (!newId.trim()) throw new Error('duplicateBot needs a new id.');
  return { ...bot, id: newId, name: `${bot.name}${COPY_SUFFIX}` };
}

/**
 * The conversation id to copy: a thread id when the user is in a
 * thread, otherwise the bot id. Both are stable identifiers the
 * user can paste into a deep link (`open-bot://bot/<id>`) or a bug
 * report — never a secret.
 */
export function conversationIdForCopy(botId: string, threadId?: string | null): string {
  return threadId?.trim() ? threadId.trim() : botId;
}

/** Parse the stored meta map defensively — a corrupt entry never breaks the sidebar. */
export function parseBotMeta(raw: string | null | undefined): BotMetaMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: BotMetaMap = {};
    for (const [botId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const meta: BotMeta = {};
      if (v['pinned'] === true) meta.pinned = true;
      if (v['unread'] === true) meta.unread = true;
      if (v['hidden'] === true) meta.hidden = true;
      if (typeof v['pinnedAt'] === 'number') meta.pinnedAt = v['pinnedAt'];
      out[botId] = meta;
    }
    return out;
  } catch {
    return {};
  }
}

export function stringifyBotMeta(meta: BotMetaMap): string {
  return JSON.stringify(meta);
}
