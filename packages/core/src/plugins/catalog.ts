/**
 * Plugin marketplace catalog (core side) — browse, search and review
 * plugins before installing them.
 *
 * This complements the tools-side marketplace (packages/tools, which
 * stages and installs plugin code from a source): the catalog answers
 * "what is available on this machine, what does it ask for, and is it
 * already installed / enabled?" without touching the loader.
 *
 * Two sources, merged by plugin id (installed wins):
 * - installed plugins: `<pluginsDir>/<id>/manifest.json` — the same
 *   layout the plugin loader reads. The enabled flag is read from
 *   `<pluginsDir>/enabled.json` (the loader's own file) but NEVER
 *   written here: enable/disable goes through the loader's toggle
 *   (existing `plugins:toggle` IPC), so there is exactly one writer.
 * - plugin templates: `<templatesDir>/<id>.json` (templates.ts) —
 *   shareable recipes that install a plugin when applied. A template
 *   whose plugin is already installed is shown as installed.
 *
 * Permission review is the safety core of the UI: before installing,
 * the user sees every permission the manifest declares, each with a
 * risk level and a plain-English summary. Unknown permission strings
 * are reported as high risk instead of silently dropped — a manifest
 * asking for something the app does not recognize must look scary,
 * not invisible.
 *
 * LOCAL ONLY: the catalog is built from directories on this machine.
 * There is no remote registry here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listPluginTemplates } from './templates';

/** Permissions the loader understands (mirrors PLUGIN_PERMISSIONS). */
export type PluginCatalogPermission = 'fs' | 'shell' | 'network' | 'mcp';

export const PLUGIN_CATALOG_PERMISSIONS: readonly PluginCatalogPermission[] = [
  'fs',
  'shell',
  'network',
  'mcp',
];

export const PLUGIN_ENABLED_FILE = 'enabled.json';

/** One plugin in the marketplace catalog. */
export interface PluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** Raw permission strings from the manifest (unknown ones kept, flagged by review). */
  permissions: string[];
  source: 'installed' | 'template';
  /** Installed plugins: enabled flag from enabled.json (null when the file has no entry). Templates: null. */
  enabled: boolean | null;
  /** Installed: the manifest's main file exists. Template: config carries entrySource. */
  hasEntry: boolean;
}

export type PermissionRisk = 'low' | 'medium' | 'high';

/** One declared permission, reviewed for the pre-install screen. */
export interface PermissionReview {
  permission: string;
  risk: PermissionRisk;
  /** Plain-English summary (core data; the renderer localizes the chrome around it). */
  summary: string;
}

const PERMISSION_REVIEWS: Record<PluginCatalogPermission, { risk: PermissionRisk; summary: string }> = {
  fs: {
    risk: 'medium',
    summary: 'Reads and writes files inside the bot workspace.',
  },
  shell: {
    risk: 'high',
    summary: 'Runs shell commands on this machine.',
  },
  network: {
    risk: 'high',
    summary: 'Makes network requests; could send local data to a remote server.',
  },
  mcp: {
    risk: 'medium',
    summary: 'Connects to external MCP servers declared by the plugin.',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanPermissions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface ParsedManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  main: string;
}

/** Parse + validate a plugin manifest (returns null when missing/invalid). */
export function parsePluginManifest(raw: unknown): ParsedManifest | null {
  if (!isRecord(raw)) return null;
  const { id, name, version, description, author, permissions, main } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof version !== 'string' || version.trim().length === 0) return null;
  if (typeof description !== 'string') return null;
  if (typeof main !== 'string' || main.trim().length === 0) return null;
  return {
    id: id.trim(),
    name: name.trim(),
    version: version.trim(),
    description: description.trim(),
    author: typeof author === 'string' ? author.trim() : '',
    permissions: cleanPermissions(permissions),
    main: main.trim(),
  };
}

/** Enabled map from `<pluginsDir>/enabled.json` (missing/corrupt = empty). */
export function readPluginEnabledMap(pluginsDir: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(pluginsDir, PLUGIN_ENABLED_FILE), 'utf8'),
    );
    if (!isRecord(parsed) || !isRecord(parsed.enabled)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed.enabled)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Scan installed plugins: every subdir of pluginsDir with a valid
 * manifest.json. Subdirs without a manifest (or with an invalid one)
 * are skipped — a half-copied plugin must not break the catalog.
 */
export function scanInstalledPlugins(pluginsDir: string): PluginCatalogEntry[] {
  let dirNames: string[];
  try {
    dirNames = fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const enabledMap = readPluginEnabledMap(pluginsDir);
  const entries: PluginCatalogEntry[] = [];
  for (const dirName of dirNames.sort()) {
    const dir = path.join(pluginsDir, dirName);
    let manifest: ParsedManifest | null = null;
    try {
      manifest = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
    } catch {
      manifest = null;
    }
    if (!manifest) continue;
    entries.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      permissions: manifest.permissions,
      source: 'installed',
      enabled: manifest.id in enabledMap ? enabledMap[manifest.id] : null,
      hasEntry: fs.existsSync(path.join(dir, manifest.main)),
    });
  }
  return entries;
}

/**
 * Plugin templates as catalog entries (source 'template'). A template
 * with no entrySource still lists (the plugin is incomplete until its
 * author adds the entry file — reported via hasEntry: false).
 */
export function scanPluginTemplatesAsCatalog(templatesDir: string): PluginCatalogEntry[] {
  let templates;
  try {
    templates = listPluginTemplates(templatesDir);
  } catch {
    return [];
  }
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    version: template.manifest.version,
    description: template.description,
    author: template.manifest.author ?? '',
    permissions: [...template.manifest.permissions],
    source: 'template' as const,
    enabled: null,
    hasEntry:
      typeof (template.config as Record<string, unknown>).entrySource === 'string' &&
      ((template.config as Record<string, unknown>).entrySource as string).length > 0,
  }));
}

/**
 * Merge installed plugins and templates into one catalog, deduped by
 * id (installed wins — a template whose plugin is installed is shown
 * as installed, not as a second row). Sorted by name.
 */
export function mergePluginCatalog(
  installed: PluginCatalogEntry[],
  templates: PluginCatalogEntry[],
): PluginCatalogEntry[] {
  const byId = new Map<string, PluginCatalogEntry>();
  for (const entry of templates) byId.set(entry.id, entry);
  for (const entry of installed) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Search a catalog by free text (name / description / id, case-insensitive). */
export function searchPluginCatalog(entries: PluginCatalogEntry[], query: string): PluginCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((entry) => {
    const haystack = `${entry.name} ${entry.description} ${entry.id} ${entry.permissions.join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((word) => haystack.includes(word));
  });
}

/**
 * Review a manifest's permissions for the pre-install screen: one row
 * per declared permission, deduped, in manifest order. Unknown
 * permission strings are high risk — never silently dropped.
 */
export function reviewPluginPermissions(permissions: unknown): PermissionReview[] {
  return cleanPermissions(permissions).map((permission) => {
    const known = (PERMISSION_REVIEWS as Record<string, { risk: PermissionRisk; summary: string }>)[
      permission
    ];
    if (known) return { permission, risk: known.risk, summary: known.summary };
    return {
      permission,
      risk: 'high' as PermissionRisk,
      summary: `Unknown permission "${permission}": not recognized by this app — treat as high risk.`,
    };
  });
}

/** Worst risk across a permission review (no permissions = low). */
export function summarizePluginRisk(reviews: PermissionReview[]): PermissionRisk {
  if (reviews.some((r) => r.risk === 'high')) return 'high';
  if (reviews.some((r) => r.risk === 'medium')) return 'medium';
  return 'low';
}
