/**
 * Local agent marketplace (v0.3).
 *
 * LOCAL ONLY — there is no central server. "Publish" saves a bot's config
 * into `<baseDir>/marketplace/agents.json` on this machine (baseDir is the
 * app's userData directory, passed in by the main process — never
 * hard-coded here), and "install" creates a fresh bot from a published
 * entry. Sharing a published agent with another machine means copying
 * that file; a shared/remote marketplace is future work.
 *
 * SECURITY — a published entry contains ONLY the seven BotConfig fields.
 * BotConfig never holds an API key (keys live in settings.json, main
 * process only), and `sanitizeConfig` additionally drops any unknown
 * field so a hand-edited config object can never smuggle a key into the
 * marketplace file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotConfig } from '../types';

export interface PublishedAgent {
  id: string;
  name: string;
  description: string;
  /** Template the agent was built from, if any. */
  templateId?: string;
  /** The bot config, sanitized (BotConfig fields only — never an API key). */
  config: BotConfig;
  author: string;
  createdAt: string;
  /** How many times this entry has been installed on this machine. */
  installs: number;
}

export interface MarketplacePublishMeta {
  author?: string;
  description?: string;
  templateId?: string;
}

export const MARKETPLACE_DIR = 'marketplace';
export const MARKETPLACE_AGENTS_FILE = 'agents.json';

/** Độ dài tối đa của `BotConfig.description` (v0.77) — main + sanitizeConfig cùng cắt. */
export const BOT_DESCRIPTION_MAX_LENGTH = 500;

/** Keep exactly the BotConfig fields — drop anything else (e.g. an apiKey). */
export function sanitizeConfig(config: BotConfig): BotConfig {
  // v0.65: denyTools/denySkills được giữ (copy mảng mới, không share tham
  // chiếu) — deny chỉ thu hẹp quyền nên an toàn khi publish; clone,
  // publish và install đều đi qua đây nên hành vi nhất quán.
  // v0.90b: disabledProviders giữ như denyTools/denySkills (bot clone
  // giữ nguyên nguồn đã tắt của bot gốc).
  const denyTools = cleanStringList(config.denyTools);
  const denySkills = cleanStringList(config.denySkills);
  const disabledProviders = cleanStringList(config.disabledProviders);
  return {
    id: typeof config.id === 'string' ? config.id : randomUUID(),
    name: typeof config.name === 'string' ? config.name : 'Bot',
    providerId: typeof config.providerId === 'string' ? config.providerId : 'xai',
    model: typeof config.model === 'string' ? config.model : '',
    systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : '',
    workspaceDir: typeof config.workspaceDir === 'string' ? config.workspaceDir : '',
    autoApprove: config.autoApprove === true,
    // v0.61 (UI-13): a clone keeps the bot's display colour.
    ...(typeof config.color === 'string' && config.color.trim()
      ? { color: config.color.trim() }
      : {}),
    // v0.77: a clone keeps the bot's short description (trimmed + capped).
    ...(typeof config.description === 'string' && config.description.trim()
      ? { description: config.description.trim().slice(0, BOT_DESCRIPTION_MAX_LENGTH) }
      : {}),
    ...(denyTools ? { denyTools } : {}),
    ...(denySkills ? { denySkills } : {}),
    ...(disabledProviders ? { disabledProviders } : {}),
  };
}

/**
 * Chỉ giữ các chuỗi không rỗng, trả về mảng MỚI (`.filter` luôn tạo mảng
 * mới nên không share tham chiếu với mảng gốc). Trả undefined khi không
 * phải mảng, rỗng, hoặc toàn entry lạ — field đó sẽ bị lược khỏi config
 * đã sanitize, tương đương "không deny gì".
 */
function cleanStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = value.filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  return clean.length > 0 ? clean : undefined;
}

function agentsPath(baseDir: string): string {
  return path.join(baseDir, MARKETPLACE_DIR, MARKETPLACE_AGENTS_FILE);
}

function readStore(baseDir: string): PublishedAgent[] {
  try {
    const raw = fs.readFileSync(agentsPath(baseDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PublishedAgent =>
        !!e && typeof e === 'object' && typeof (e as PublishedAgent).id === 'string',
    );
  } catch {
    // Missing file (first use) or unreadable/corrupt file: empty marketplace.
    return [];
  }
}

function writeStore(baseDir: string, agents: PublishedAgent[]): void {
  const dir = path.join(baseDir, MARKETPLACE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(agentsPath(baseDir), JSON.stringify(agents, null, 2), 'utf-8');
}

/**
 * Publish a bot to the LOCAL marketplace. Re-publishing the same bot id
 * replaces its entry (keeping the original id, author, createdAt and
 * install count); publishing a new bot creates a new entry.
 */
export function publishAgent(
  baseDir: string,
  config: BotConfig,
  meta: MarketplacePublishMeta = {},
): PublishedAgent {
  const clean = sanitizeConfig(config);
  const agents = readStore(baseDir);
  const now = new Date().toISOString();
  const existing = agents.find((a) => a.id === clean.id);
  const entry: PublishedAgent = {
    // The entry id IS the bot id: re-publishing the same bot updates its
    // entry instead of creating a duplicate.
    id: clean.id,
    name: clean.name,
    description: meta.description ?? existing?.description ?? '',
    templateId: meta.templateId ?? existing?.templateId,
    config: clean,
    author: meta.author ?? existing?.author ?? 'local',
    createdAt: existing?.createdAt ?? now,
    installs: existing?.installs ?? 0,
  };
  const next = existing
    ? agents.map((a) => (a.id === entry.id ? entry : a))
    : [...agents, entry];
  writeStore(baseDir, next);
  return entry;
}

/** All locally published agents, newest first. */
export function listPublished(baseDir: string): PublishedAgent[] {
  return readStore(baseDir).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** One published agent by id, or undefined when unknown. */
export function getPublished(baseDir: string, id: string): PublishedAgent | undefined {
  return readStore(baseDir).find((a) => a.id === id);
}

/**
 * Install a published agent: returns a FRESH BotConfig (new id, empty
 * workspaceDir so the main process assigns a per-bot workspace) and bumps
 * the entry's install count. The caller saves the returned config as a bot.
 * Throws when the id is not published.
 */
export function installPublished(baseDir: string, id: string): BotConfig {
  const agents = readStore(baseDir);
  const entry = agents.find((a) => a.id === id);
  if (!entry) throw new Error(`Không tìm thấy agent đã publish: ${id}`);
  writeStore(
    baseDir,
    agents.map((a) => (a.id === id ? { ...a, installs: a.installs + 1 } : a)),
  );
  const clean = sanitizeConfig(entry.config);
  return { ...clean, id: randomUUID(), workspaceDir: '' };
}

/** Remove a published agent. Returns true when an entry was removed. */
export function uninstallPublished(baseDir: string, id: string): boolean {
  const agents = readStore(baseDir);
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) return false;
  writeStore(baseDir, next);
  return true;
}

/**
 * Clone a bot config: NEW id, NEW name, EMPTY workspaceDir (never shared
 * with the original — the main process assigns a fresh per-bot workspace).
 * Keeps the original's denyTools/denySkills as fresh copies (v0.65).
 * Default name is "<name> (copy)"; the main process passes the localized
 * "<name> (bản sao)" instead.
 */
export function cloneAgent(config: BotConfig, newName?: string): BotConfig {
  const clean = sanitizeConfig(config);
  return {
    ...clean,
    id: randomUUID(),
    name: newName?.trim() || `${clean.name} (copy)`,
    workspaceDir: '',
  };
}
