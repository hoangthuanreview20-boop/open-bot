/**
 * Bot marketplace v2 — searchable catalog + ratings + one-click install.
 *
 * The v1 marketplace (marketplace.ts) only lists locally published
 * agents, newest first, with no search, no categories and no ratings.
 * V2 builds one catalog from BOTH sources that already exist on this
 * machine:
 *
 * - the 20 built-in bot templates (templates.ts) — kind 'template',
 *   catalog id `tpl:<templateId>`;
 * - the locally published agents (marketplace.ts) — kind 'published',
 *   catalog id `pub:<agentId>`.
 *
 * On top of the merged catalog it adds:
 * - search by free text (name / description / tags), filter by
 *   category or tag, sort by rating / installs / name / newest;
 * - per-entry ratings (1–5 stars, one rating per user per entry,
 *   stored in `<baseDir>/marketplace/ratings.json`);
 * - one-click install: a template builds a fresh BotConfig via
 *   createBotConfigFromTemplate, a published entry installs via
 *   installPublished. Either way the caller gets a BotConfig with a
 *   NEW id and an EMPTY workspaceDir (the main process assigns a
 *   per-bot workspace), and the entry's install count goes up.
 *
 * LOCAL ONLY, like v1: no central server, no network, no account.
 * Sharing a published agent with another machine still means copying
 * the marketplace file. Ratings and install counts are this machine's
 * own metadata, not a global store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotConfig } from '../types';
import { installPublished, listPublished, MARKETPLACE_DIR } from './marketplace';
import { createBotConfigFromTemplate, getTemplate, listBuiltInTemplates } from './templates';

export type MarketplaceV2EntryKind = 'template' | 'published';

export type MarketplaceV2Sort = 'rating' | 'installs' | 'name' | 'newest';

/** One catalog entry: a template or a locally published agent. */
export interface MarketplaceV2Entry {
  /** Stable catalog id: `tpl:<templateId>` or `pub:<agentId>`. */
  id: string;
  kind: MarketplaceV2EntryKind;
  /** Template id (kind 'template') or published agent id (kind 'published'). */
  sourceId: string;
  name: string;
  description: string;
  author: string;
  /** Template category ('code', 'research', …) or 'custom' for published agents. */
  category: string;
  /** Searchable tags: category + suggested tools (templates) or ['custom']. */
  tags: string[];
  version: string;
  /** How many times this entry was installed on this machine. */
  installs: number;
  /** Mean rating (0 when unrated). */
  ratingAverage: number;
  /** Number of ratings. */
  ratingCount: number;
  /** ISO timestamp, or null for built-in templates (they have no date). */
  createdAt: string | null;
}

/** One user's rating of one catalog entry. */
export interface MarketplaceV2Rating {
  entryId: string;
  userId: string;
  stars: number;
  at: string;
}

export const MARKETPLACE_V2_RATINGS_FILE = 'ratings.json';
export const MARKETPLACE_V2_STATS_FILE = 'catalog-stats.json';
export const MARKETPLACE_V2_TEMPLATE_VERSION = '1.0.0';
export const MARKETPLACE_V2_PUBLISHED_VERSION = '1.0.0';

function marketplaceDir(baseDir: string): string {
  return path.join(baseDir, MARKETPLACE_DIR);
}

function ratingsPath(baseDir: string): string {
  return path.join(marketplaceDir(baseDir), MARKETPLACE_V2_RATINGS_FILE);
}

function statsPath(baseDir: string): string {
  return path.join(marketplaceDir(baseDir), MARKETPLACE_V2_STATS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonArray(filePath: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function validateRating(raw: unknown): MarketplaceV2Rating | null {
  if (!isRecord(raw)) return null;
  const { entryId, userId, stars, at } = raw;
  if (typeof entryId !== 'string' || entryId.trim().length === 0) return null;
  if (typeof userId !== 'string' || userId.trim().length === 0) return null;
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) return null;
  if (typeof at !== 'string' || at.trim().length === 0) return null;
  return { entryId: entryId.trim(), userId: userId.trim(), stars, at };
}

/** All stored ratings (corrupt rows are dropped, never fatal). */
export function listMarketplaceV2Ratings(baseDir: string): MarketplaceV2Rating[] {
  return readJsonArray(ratingsPath(baseDir))
    .map((row) => validateRating(row))
    .filter((r): r is MarketplaceV2Rating => r !== null);
}

function loadInstallCounts(baseDir: string): Record<string, number> {
  const raw = readJsonRecord(statsPath(baseDir)).installs;
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value);
  }
  return out;
}

function saveInstallCounts(baseDir: string, installs: Record<string, number>): void {
  writeJsonFile(statsPath(baseDir), { installs });
}

function ratingSummary(ratings: MarketplaceV2Rating[], entryId: string): { average: number; count: number } {
  const mine = ratings.filter((r) => r.entryId === entryId);
  if (mine.length === 0) return { average: 0, count: 0 };
  const sum = mine.reduce((total, r) => total + r.stars, 0);
  return { average: sum / mine.length, count: mine.length };
}

/**
 * Build the full v2 catalog: 20 built-in templates + every locally
 * published agent. Template install counts come from the local stats
 * file; published install counts come from the published entry itself.
 */
export function buildMarketplaceV2Catalog(baseDir: string): MarketplaceV2Entry[] {
  const ratings = listMarketplaceV2Ratings(baseDir);
  const templateInstalls = loadInstallCounts(baseDir);
  const entries: MarketplaceV2Entry[] = [];

  for (const template of listBuiltInTemplates()) {
    const id = `tpl:${template.id}`;
    const summary = ratingSummary(ratings, id);
    const tags = [...new Set([template.category, ...template.suggestedTools])];
    entries.push({
      id,
      kind: 'template',
      sourceId: template.id,
      name: template.name,
      description: template.description,
      author: 'open-bot',
      category: template.category,
      tags,
      version: MARKETPLACE_V2_TEMPLATE_VERSION,
      installs: templateInstalls[id] ?? 0,
      ratingAverage: summary.average,
      ratingCount: summary.count,
      createdAt: null,
    });
  }

  for (const agent of listPublished(baseDir)) {
    const id = `pub:${agent.id}`;
    const summary = ratingSummary(ratings, id);
    entries.push({
      id,
      kind: 'published',
      sourceId: agent.id,
      name: agent.name,
      description: agent.description,
      author: agent.author,
      category: 'custom',
      tags: ['custom', ...(agent.templateId ? [agent.templateId] : [])],
      version: MARKETPLACE_V2_PUBLISHED_VERSION,
      installs: agent.installs,
      ratingAverage: summary.average,
      ratingCount: summary.count,
      createdAt: agent.createdAt,
    });
  }

  return entries;
}

export interface SearchMarketplaceV2Options {
  /** Free text matched against name, description and tags (case-insensitive). */
  query?: string;
  /** Exact category ('code', 'research', …, 'custom'). */
  category?: string;
  /** Exact tag (case-insensitive). */
  tag?: string;
  sort?: MarketplaceV2Sort;
}

/** Search / filter / sort a catalog (pure function, no disk access). */
export function searchMarketplaceV2Catalog(
  entries: MarketplaceV2Entry[],
  opts: SearchMarketplaceV2Options = {},
): MarketplaceV2Entry[] {
  const query = opts.query?.trim().toLowerCase() ?? '';
  const category = opts.category?.trim() ?? '';
  const tag = opts.tag?.trim().toLowerCase() ?? '';
  const sort: MarketplaceV2Sort = opts.sort ?? 'rating';
  const filtered = entries.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (tag && !entry.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (query) {
      const haystack = `${entry.name} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase();
      if (!query.split(/\s+/).every((word) => haystack.includes(word))) return false;
    }
    return true;
  });
  const sorted = [...filtered];
  switch (sort) {
    case 'rating':
      sorted.sort(
        (a, b) => b.ratingAverage - a.ratingAverage || b.ratingCount - a.ratingCount || b.installs - a.installs,
      );
      break;
    case 'installs':
      sorted.sort((a, b) => b.installs - a.installs || b.ratingAverage - a.ratingAverage);
      break;
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'newest':
      sorted.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      break;
  }
  return sorted;
}

/** Distinct categories present in a catalog, sorted. */
export function listMarketplaceV2Categories(entries: MarketplaceV2Entry[]): string[] {
  return [...new Set(entries.map((e) => e.category))].sort();
}

/** Distinct tags present in a catalog, sorted. */
export function listMarketplaceV2Tags(entries: MarketplaceV2Entry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.tags))].sort();
}

/** Mean rating + count for one catalog entry (0 / 0 when unrated). */
export function getMarketplaceV2Rating(baseDir: string, entryId: string): { average: number; count: number } {
  return ratingSummary(listMarketplaceV2Ratings(baseDir), entryId);
}

/**
 * Rate one catalog entry (1–5 stars). One rating per user per entry:
 * rating again replaces the previous rating. Returns the new summary.
 * Throws when the entry id is unknown or stars are out of range.
 */
export function rateMarketplaceV2Entry(
  baseDir: string,
  entryId: string,
  userId: string,
  stars: number,
): { average: number; count: number } {
  if (typeof entryId !== 'string' || entryId.trim().length === 0) {
    throw new Error('marketplace v2 rating needs a non-empty entryId.');
  }
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('marketplace v2 rating needs a non-empty userId.');
  }
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new Error('marketplace v2 rating stars must be an integer from 1 to 5.');
  }
  const catalog = buildMarketplaceV2Catalog(baseDir);
  if (!catalog.some((e) => e.id === entryId.trim())) {
    throw new Error(`marketplace v2 entry not found: ${entryId}`);
  }
  const ratings = listMarketplaceV2Ratings(baseDir).filter(
    (r) => !(r.entryId === entryId.trim() && r.userId === userId.trim()),
  );
  ratings.push({ entryId: entryId.trim(), userId: userId.trim(), stars, at: new Date().toISOString() });
  writeJsonFile(ratingsPath(baseDir), ratings);
  return ratingSummary(ratings, entryId.trim());
}

export interface InstallMarketplaceV2Result {
  /** Fresh BotConfig (new id, empty workspaceDir) — the caller saves it as a bot. */
  config: BotConfig;
  entry: MarketplaceV2Entry;
}

/**
 * One-click install of a catalog entry. Returns a fresh BotConfig and
 * bumps the entry's install count. Throws when the entry id is unknown.
 */
export function installMarketplaceV2Entry(baseDir: string, entryId: string): InstallMarketplaceV2Result {
  if (typeof entryId !== 'string' || entryId.trim().length === 0) {
    throw new Error('marketplace v2 install needs a non-empty entryId.');
  }
  const id = entryId.trim();
  if (id.startsWith('tpl:')) {
    const template = getTemplate(id.slice('tpl:'.length));
    if (!template) throw new Error(`marketplace v2 template not found: ${id}`);
    const counts = loadInstallCounts(baseDir);
    counts[id] = (counts[id] ?? 0) + 1;
    saveInstallCounts(baseDir, counts);
    const entry = buildMarketplaceV2Catalog(baseDir).find((e) => e.id === id);
    // buildMarketplaceV2Catalog re-reads the bumped count, so the
    // returned entry already shows the new install total.
    if (!entry) throw new Error(`marketplace v2 template not found after install: ${id}`);
    return { config: createBotConfigFromTemplate(template), entry };
  }
  if (id.startsWith('pub:')) {
    const config = installPublished(baseDir, id.slice('pub:'.length));
    const entry = buildMarketplaceV2Catalog(baseDir).find((e) => e.id === id);
    if (!entry) throw new Error(`marketplace v2 entry not found after install: ${id}`);
    return { config, entry };
  }
  throw new Error(`marketplace v2 entry id must start with 'tpl:' or 'pub:': ${id}`);
}
