/**
 * Plugin templates (v0.8).
 *
 * A plugin template is a shareable, self-contained recipe for a plugin:
 * a manifest plus the plugin's default `config` — so someone else can
 * recreate the same plugin on their machine without hand-writing a
 * manifest. Templates live as one JSON file per template in
 * `<userData>/plugin-templates/<id>.json` (the directory is passed in
 * by the caller, never hard-coded here), mirroring the local marketplace
 * layout (`marketplace/agents.json`).
 *
 * Shape:
 * - `manifest` — the plugin manifest the template installs (same fields
 *   as `PluginManifest` in @open-bot/tools; the rules are mirrored here
 *   because core must NOT import @open-bot/tools — tools depends on
 *   core, so importing it back would be a cycle).
 * - `config` — free-form default settings for the plugin. Reserved key
 *   `entrySource` (string, optional) holds the plugin entry file's
 *   source; `apply` writes it to `manifest.main` so the installed
 *   plugin is actually loadable. Every other key is written verbatim
 *   to `<plugin-dir>/config.json` for the plugin to read at runtime.
 *   A template with no `entrySource` still applies (manifest +
 *   config.json), but the plugin is incomplete until its author adds
 *   the entry file — `apply` reports that as `hasEntry: false`.
 *
 * SECURITY — a template must NEVER carry a secret. `validatePluginTemplate`
 * rejects any `config` key that looks like a credential (apiKey, token,
 * secret, password, …) at any depth, and any string value that looks
 * like a pasted provider token (`sk-…`). Export/import go through the
 * same validation, so a hand-edited file cannot smuggle a key into the
 * template store — the same posture as `sanitizeConfig` in the agent
 * marketplace.
 *
 * TRUST — applying a template writes code (`entrySource`) into the
 * plugins directory, and plugin code runs in-process with the user's
 * trust (see the HONEST LIMIT in tools/src/plugins/types.ts). Only
 * apply templates from sources you trust. The plugin loader's static
 * checks (require allowlist, declared permissions) still run at load
 * time and can reject a bad entry after apply.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const PLUGIN_TEMPLATES_DIR = 'plugin-templates';

/** Capabilities a plugin manifest may declare (mirrors PLUGIN_PERMISSIONS). */
export type PluginTemplatePermission = 'fs' | 'shell' | 'network' | 'mcp';

export const PLUGIN_TEMPLATE_PERMISSIONS: readonly PluginTemplatePermission[] = [
  'fs',
  'shell',
  'network',
  'mcp',
];

/**
 * The plugin manifest a template installs. Same fields as the loader's
 * `PluginManifest` (tools/src/plugins/types.ts); kept as a separate
 * structural type so core stays dependency-free.
 */
export interface PluginTemplateManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: PluginTemplatePermission[];
  main: string;
  tools?: string[];
}

/**
 * A shareable plugin template: manifest + default config.
 *
 * - `id` is the template id AND the plugin id (they must match — see
 *   `validatePluginTemplate`); it is also the file name
 *   (`<id>.json`) and the install directory name.
 * - `config.entrySource` (optional string) is the plugin entry file
 *   source, written to `manifest.main` by `applyPluginTemplate`.
 */
export interface PluginTemplate {
  id: string;
  name: string;
  description: string;
  manifest: PluginTemplateManifest;
  /** Default plugin settings (never secrets — validated on save/import). */
  config: Record<string, unknown>;
  /** ISO timestamp of when the template was created. */
  createdAt: string;
}

export interface CreatePluginTemplateInput {
  id: string;
  name: string;
  description: string;
  manifest: PluginTemplateManifest;
  config?: Record<string, unknown>;
}

export interface AppliedPluginTemplate {
  /** Absolute path of the installed plugin directory. */
  dir: string;
  manifest: PluginTemplateManifest;
  /** False when the template had no `entrySource` (entry file missing). */
  hasEntry: boolean;
  /** Absolute path of the written `<plugin-dir>/config.json`. */
  configPath: string;
}

const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Simple semver: `MAJOR.MINOR.PATCH`, optional pre-release / build suffix. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Config keys that must never appear in a template (any depth). */
const SECRET_KEY_RE =
  /api[-_ ]?key|secret|token|passw|pwd|bearer|credential|private[-_ ]?key|access[-_ ]?key|auth[-_ ]?(key|token)?/i;
/** String values that look like a pasted provider token. */
const SECRET_VALUE_RE = /^(sk-[A-Za-z0-9-]{8,}|xai-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{20,})$/;

function fail(message: string): never {
  throw new Error(`Plugin template không hợp lệ: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reject non-JSON values (functions, undefined, symbols, bigint) anywhere. */
function assertJsonSerializable(value: unknown, where: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${where} phải là JSON hợp lệ (số không hữu hạn).`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSerializable(item, `${where}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonSerializable(item, `${where}.${key}`);
    }
    return;
  }
  fail(`${where} phải là JSON hợp lệ (không dùng function/undefined/symbol/bigint).`);
}

/** Reject secret-looking keys and token-like values in `config`, any depth. */
function assertNoSecrets(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${where}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        fail(
          `config.${where}${key} trông như credential (apiKey/token/secret/password, …) — ` +
            `template không được chứa secret. Đưa giá trị này vào Vault hoặc file cấu hình riêng của plugin.`,
        );
      }
      assertNoSecrets(item, `${where}${key}.`);
    }
    return;
  }
  if (typeof value === 'string' && SECRET_VALUE_RE.test(value.trim())) {
    fail(`config.${where} trông như token đã paste (bắt đầu bằng sk-/xai-/ghp_…) — template không được chứa secret.`);
  }
}

function validateManifest(raw: unknown): PluginTemplateManifest {
  if (!isPlainObject(raw)) fail('manifest phải là một object.');
  const id = raw['id'];
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) {
    fail(`manifest.id ${JSON.stringify(id)} không hợp lệ: chỉ dùng chữ, số, "-" và "_".`);
  }
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    fail(`Plugin "${id}" phải có "name" là chuỗi không rỗng.`);
  }
  if (typeof raw['version'] !== 'string' || !SEMVER_RE.test(raw['version'])) {
    fail(
      `Plugin "${id}" có version ${JSON.stringify(raw['version'])} không hợp lệ: cần semver dạng "1.0.0".`,
    );
  }
  if (typeof raw['description'] !== 'string' || raw['description'].trim() === '') {
    fail(`Plugin "${id}" phải có "description" là chuỗi không rỗng.`);
  }
  if (raw['author'] !== undefined && typeof raw['author'] !== 'string') {
    fail(`Plugin "${id}": "author" phải là chuỗi khi có mặt.`);
  }
  const permissions = raw['permissions'];
  if (
    !Array.isArray(permissions) ||
    permissions.some(
      (p) => typeof p !== 'string' || !(PLUGIN_TEMPLATE_PERMISSIONS as readonly string[]).includes(p),
    )
  ) {
    fail(
      `Plugin "${id}": "permissions" phải là mảng chỉ gồm: ${PLUGIN_TEMPLATE_PERMISSIONS.join(', ')}.`,
    );
  }
  if (typeof raw['main'] !== 'string' || raw['main'].trim() === '') {
    fail(`Plugin "${id}" phải có "main" là file entry không rỗng.`);
  }
  const main = raw['main'] as string;
  if (main.split(/[\\/]/).includes('..') || path.isAbsolute(main)) {
    fail(`Plugin "${id}": "main" (${main}) không được thoát khỏi thư mục plugin.`);
  }
  if (
    raw['tools'] !== undefined &&
    (!Array.isArray(raw['tools']) || raw['tools'].some((t) => typeof t !== 'string'))
  ) {
    fail(`Plugin "${id}": "tools" phải là mảng chuỗi tên tool khi có mặt.`);
  }
  return {
    id,
    name: raw['name'] as string,
    version: raw['version'] as string,
    description: raw['description'] as string,
    author: raw['author'] as string | undefined,
    permissions: [...(permissions as PluginTemplatePermission[])],
    main,
    tools: raw['tools'] as string[] | undefined,
  };
}

/**
 * Validate a parsed template object; returns a normalized copy, or throws.
 * Unknown top-level fields are dropped (same posture as `sanitizeConfig`).
 * A missing `createdAt` is filled with the current time (import of an
 * older hand-written template); a present one must be a string.
 */
export function validatePluginTemplate(raw: unknown): PluginTemplate {
  if (!isPlainObject(raw)) fail('template phải là một object JSON.');
  const id = raw['id'];
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) {
    fail(`id ${JSON.stringify(id)} không hợp lệ: chỉ dùng chữ, số, "-" và "_".`);
  }
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    fail(`Template "${id}" phải có "name" là chuỗi không rỗng.`);
  }
  if (typeof raw['description'] !== 'string' || raw['description'].trim() === '') {
    fail(`Template "${id}" phải có "description" là chuỗi không rỗng.`);
  }
  const manifest = validateManifest(raw['manifest']);
  if (manifest.id !== id) {
    fail(`manifest.id ("${manifest.id}") phải trùng với template id ("${id}").`);
  }
  const config = raw['config'] ?? {};
  if (!isPlainObject(config)) fail(`Template "${id}": "config" phải là một object.`);
  if (typeof config['entrySource'] !== 'undefined' && typeof config['entrySource'] !== 'string') {
    fail(`Template "${id}": "config.entrySource" phải là chuỗi (source của file entry) khi có mặt.`);
  }
  assertJsonSerializable(config, 'config');
  assertNoSecrets(config, '');
  const createdAt = raw['createdAt'];
  if (createdAt !== undefined && typeof createdAt !== 'string') {
    fail(`Template "${id}": "createdAt" phải là chuỗi ISO khi có mặt.`);
  }
  return {
    id,
    name: raw['name'] as string,
    description: raw['description'] as string,
    manifest,
    config: { ...(config as Record<string, unknown>) },
    createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
  };
}

/** Build a new template (validates; `createdAt` is set to now). */
export function createPluginTemplate(input: CreatePluginTemplateInput): PluginTemplate {
  return validatePluginTemplate({
    ...input,
    createdAt: new Date().toISOString(),
  });
}

function templatePath(templatesDir: string, id: string): string {
  return path.join(templatesDir, `${id}.json`);
}

/** Read + validate one template file; undefined when missing or invalid. */
function readTemplateFile(file: string): PluginTemplate | undefined {
  try {
    return validatePluginTemplate(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Save (create or replace) a template. Validates first — a template
 * carrying a secret is never written to disk. Returns the saved copy.
 */
export function savePluginTemplate(
  templatesDir: string,
  template: PluginTemplate,
): PluginTemplate {
  const clean = validatePluginTemplate(template);
  fs.mkdirSync(templatesDir, { recursive: true });
  const target = templatePath(templatesDir, clean.id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return clean;
}

/** Every valid template in the directory, sorted by name (then id). */
export function listPluginTemplates(templatesDir: string): PluginTemplate[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(templatesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PluginTemplate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const tpl = readTemplateFile(path.join(templatesDir, entry.name));
    if (tpl) out.push(tpl);
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/** One template by id, or undefined when missing or invalid. */
export function getPluginTemplate(
  templatesDir: string,
  id: string,
): PluginTemplate | undefined {
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return undefined;
  return readTemplateFile(templatePath(templatesDir, id));
}

/** Delete a template file. Returns true when a file was removed. */
export function deletePluginTemplate(templatesDir: string, id: string): boolean {
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return false;
  const file = templatePath(templatesDir, id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** Serialize a template to one JSON string (validated first — never leaks a secret). */
export function exportPluginTemplate(template: PluginTemplate): string {
  return JSON.stringify(validatePluginTemplate(template), null, 2) + '\n';
}

/** Parse + validate an exported template JSON string. Throws on bad input. */
export function importPluginTemplate(json: string): PluginTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new Error(`Plugin template không hợp lệ: không phải JSON — ${(err as Error).message}`);
  }
  return validatePluginTemplate(parsed);
}

/**
 * Install a plugin from a template into `pluginsDir`.
 *
 * Writes `<pluginsDir>/<manifest.id>/manifest.json` plus `config.json`
 * (the template config without `entrySource`); when the template has
 * `config.entrySource`, it is written to `manifest.main` so the plugin
 * loads immediately. Throws when the template is unknown, when the
 * plugin is already installed (pass `{ overwrite: true }` to replace
 * it), or when the template fails validation.
 */
export function applyPluginTemplate(
  templatesDir: string,
  id: string,
  pluginsDir: string,
  opts: { overwrite?: boolean } = {},
): AppliedPluginTemplate {
  const template = getPluginTemplate(templatesDir, id);
  if (!template) {
    throw new Error(`Không tìm thấy plugin template "${id}".`);
  }
  const clean = validatePluginTemplate(template);
  const dir = path.join(pluginsDir, clean.manifest.id);
  if (fs.existsSync(dir) && !opts.overwrite) {
    throw new Error(
      `Plugin "${clean.manifest.id}" đã được cài trong "${pluginsDir}". Truyền { overwrite: true } để thay thế.`,
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  if (opts.overwrite) {
    // Clear the previous install so stale files cannot survive a replace.
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(clean.manifest, null, 2) + '\n',
    'utf8',
  );
  const { entrySource, ...restConfig } = clean.config;
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(restConfig, null, 2) + '\n', 'utf8');
  let hasEntry = false;
  if (typeof entrySource === 'string') {
    const entryPath = path.resolve(dir, clean.manifest.main);
    const dirWithSep = path.resolve(dir) + path.sep;
    if (entryPath !== path.resolve(dir) && !entryPath.startsWith(dirWithSep)) {
      throw new Error(
        `Plugin "${clean.manifest.id}": "main" (${clean.manifest.main}) thoát khỏi thư mục plugin.`,
      );
    }
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, entrySource, 'utf8');
    hasEntry = true;
  }
  return { dir, manifest: clean.manifest, hasEntry, configPath };
}
