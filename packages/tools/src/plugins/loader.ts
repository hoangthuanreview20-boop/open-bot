/**
 * Plugin loader for @open-bot/tools (v0.3, wave 1).
 *
 * `loadPlugin(dir)` reads `<dir>/manifest.json`, validates it, `require`s
 * the CommonJS entry file and returns the plugin's tools — each one
 * validated with the SAME `validateToolDefinition` as core tools, and each
 * one's output wrapped so it is truncated to 20_000 chars like every core
 * tool (`MAX_TOOL_RESULT_CHARS` in tools.ts / codeTools.ts / mcpTools.ts).
 *
 * Load-time safety checks (all static — see the HONEST LIMIT below):
 *
 * 1. Manifest validation: id `^[A-Za-z0-9_-]+$`, simple semver version,
 *    non-empty name/description, `permissions` subset of
 *    fs/shell/network/mcp, `main` present and resolving INSIDE the plugin
 *    directory (no `../` escape).
 * 2. Require allowlist: every `require()` / `import` in the plugin's own
 *    `.js`/`.cjs` files must be a Node built-in (`node:fs`, `fs`, …), a
 *    relative path (`./helper`), or an absolute path. Any other specifier
 *    (an npm package such as `lodash`, `axios`, …) is rejected — plugins
 *    ship no dependencies and install none.
 * 3. Permission check: the plugin's source (entry + helper files) and each
 *    tool's `execute` source are scanned for capability signals
 *    (e.g. `child_process` / `execSync` / `runShell` need `shell`,
 *    `fetch(` / `node:https` need `network`, `fs.*` / `readFile` /
 *    `resolveWithin` need `fs`). A tool that uses a capability its manifest
 *    did not declare is rejected at load time — the whole plugin fails to
 *    load, so the tool never reaches the registry.
 *
 * HONEST LIMIT: checks 2–3 are static source scans, and plugins run
 * in-process (see types.ts). They catch the honest mistakes and the
 * declared-permission violations a normal plugin author would write, but
 * they are NOT a sandbox: deliberately obfuscated code
 * (`require('node:child_' + 'process')`, dynamic `import()`) can evade a
 * text scan, and trusted in-process code can always call Node APIs
 * directly. Do not load plugins you do not trust. Real isolation — a
 * separate plugin process — is wave-2 work (process model).
 *
 * Runtime confinement that DOES hold: a plugin tool receives the normal
 * `ToolContext` (`workspaceDir`, …). Tools that touch the filesystem are
 * expected to go through `resolveWithin(workspaceDir, …)` from sandbox.ts,
 * exactly like core tools; `resolveWithin` throws on any path (including
 * symlink escapes) outside the workspace. The test suite verifies this
 * with a plugin that reads via `resolveWithin`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import type { Tool } from '@open-bot/core';
import { validateToolDefinition } from '../registry';
import type {
  PluginManifest,
  PluginModule,
  PluginPermission,
} from './types';
import { PLUGIN_PERMISSIONS, PluginLoadError } from './types';
import { MAX_PLUGIN_TOOL_OUTPUT_CHARS, truncateText as truncate } from '../truncate';

// Shared helper: MAX_PLUGIN_TOOL_OUTPUT_CHARS nay song o ../truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_PLUGIN_TOOL_OUTPUT_CHARS };

const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Simple semver: `MAJOR.MINOR.PATCH`, optional pre-release / build suffix. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => m.replace(/^node:/, '')),
]);

/**
 * Capability signals: regexes matched against plugin source. A match means
 * the code uses that capability, so the manifest must declare it.
 * Deliberately conservative (may flag a comment); a false positive fails
 * loudly at load time, which is the safe direction for v0.3.
 */
const PERMISSION_SIGNALS: Record<PluginPermission, RegExp[]> = {
  shell: [
    /\brunShell\b/,
    /child_process/,
    /\bexecSync\b/,
    /\bspawnSync\b/,
    /\bexecFile(?:Sync)?\b/,
    /\bspawn\s*\(/,
    /\bexec\s*\(/,
  ],
  network: [
    /\bfetch\s*\(/,
    /node:https?/,
    /node:net\b/,
    /\bhttps?\.request\s*\(/,
    /\baxios\b/,
    /\bWebSocket\b/,
    /\bhttp\.request\s*\(/,
  ],
  fs: [
    /\bresolveWithin\b/,
    /\bfs\./,
    /\breadFile(?:Sync)?\b/,
    /\bwriteFile(?:Sync)?\b/,
    /\breaddir(?:Sync)?\b/,
    /\bcreateReadStream\b/,
    /\bcreateWriteStream\b/,
    /\bmkdir(?:Sync)?\b/,
    /\bunlink(?:Sync)?\b/,
  ],
  mcp: [/\bMcpClient\b/, /\bcreateMcpTools\b/, /\bcallMcpTool\b/, /\bmcpTools\b/],
};

/** One loaded plugin: manifest + validated, wrapped tools. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Tool[];
}

/**
 * Manifest plugin kèm checksum optional (v0.15, M9 audit): sha256 hex của
 * file `main`, do bundle khai trong `plugin.json`/`bundle.json`
 * (`validateBundleManifest` đã kiểm tra định dạng). Plugin thường
 * (`manifest.json`) không có field này — `validateManifest` không giữ
 * lại field lạ, nên `loadPlugin` không bao giờ thấy checksum.
 */
export type PluginManifestWithChecksum = PluginManifest & { checksum?: string };

/** Checksum hợp lệ: sha256 hex, đúng 64 ký tự — giống `BUNDLE_CHECKSUM_RE` của bundle.ts. */
const PLUGIN_CHECKSUM_RE = /^[0-9a-f]{64}$/;

/**
 * Kiểm tra checksum của plugin trước khi `require` entry file (v0.15,
 * M9 audit) — cùng luật với `verifyBundleChecksum` trong bundle.ts
 * (logic lặp lại ở đây thay vì import, để tránh phụ thuộc vòng tròn
 * loader ↔ bundle).
 *
 * - Có `checksum`: hash file entry phải khớp, không khớp thì từ chối
 *   nạp (lỗi tiếng Việt rõ ràng); định dạng sai cũng từ chối.
 * - Không có `checksum`: chỉ cảnh báo khi đây là bundle
 *   (`manifestFile` là `plugin.json`/`bundle.json`) — plugin thường
 *   (`manifest.json`) chưa có cơ chế checksum nên không cảnh báo.
 *   Cảnh báo không chặn load, để tương thích bundle cũ.
 */
function verifyPluginMainChecksum(
  manifest: PluginManifestWithChecksum,
  entryPath: string,
  dir: string,
  manifestFile: string,
): void {
  const checksum = manifest.checksum;
  if (checksum === undefined) {
    if (manifestFile !== 'manifest.json') {
      process.stderr.write(
        `[open-bot] Cảnh báo: bundle "${manifest.id}" không có checksum — chỉ cài bundle từ nguồn đáng tin.\n`,
      );
    }
    return;
  }
  if (!PLUGIN_CHECKSUM_RE.test(checksum)) {
    fail(
      `Plugin "${manifest.id}": "checksum" phải là chuỗi sha256 hex 64 ký tự ` +
        `(nhận ${JSON.stringify(checksum)}).`,
      dir,
      manifest.id,
    );
  }
  let actual: string;
  try {
    actual = createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
  } catch (err) {
    fail(
      `Plugin "${manifest.id}": không đọc được entry file để kiểm tra checksum: ` +
        `${(err as Error).message}`,
      dir,
      manifest.id,
    );
  }
  if (actual !== checksum) {
    fail(
      `Plugin "${manifest.id}": checksum không khớp — file "main" đã bị sửa đổi hoặc không đúng ` +
        `bản phát hành (khai ${checksum}, thực tế ${actual}). Từ chối nạp plugin.`,
      dir,
      manifest.id,
    );
  }
}

function fail(message: string, dir: string, pluginId?: string): never {
  throw new PluginLoadError(message, { dir, pluginId });
}

/** Validate a parsed manifest object; returns it typed, or throws. */
export function validateManifest(raw: unknown, dir: string): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('manifest.json must contain a JSON object.', dir);
  }
  const m = raw as Record<string, unknown>;
  const id = m['id'];
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    fail(
      `Invalid plugin id ${JSON.stringify(id)}: use only letters, digits, "-" and "_".`,
      dir,
      typeof id === 'string' ? id : undefined,
    );
  }
  if (typeof m['name'] !== 'string' || (m['name'] as string).trim() === '') {
    fail(`Plugin "${id}" must have a non-empty string "name".`, dir, id);
  }
  if (typeof m['version'] !== 'string' || !SEMVER_RE.test(m['version'])) {
    fail(
      `Plugin "${id}" has invalid version ${JSON.stringify(m['version'])}: expected semver like "1.0.0".`,
      dir,
      id,
    );
  }
  if (typeof m['description'] !== 'string' || (m['description'] as string).trim() === '') {
    fail(`Plugin "${id}" must have a non-empty string "description".`, dir, id);
  }
  if (m['author'] !== undefined && typeof m['author'] !== 'string') {
    fail(`Plugin "${id}": "author" must be a string when present.`, dir, id);
  }
  const permissions = m['permissions'];
  if (
    !Array.isArray(permissions) ||
    permissions.some(
      (p) => typeof p !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(p),
    )
  ) {
    fail(
      `Plugin "${id}": "permissions" must be an array using only: ${PLUGIN_PERMISSIONS.join(', ')}.`,
      dir,
      id,
    );
  }
  if (typeof m['main'] !== 'string' || (m['main'] as string).trim() === '') {
    fail(`Plugin "${id}" must have a non-empty string "main" entry file.`, dir, id);
  }
  if (
    m['tools'] !== undefined &&
    (!Array.isArray(m['tools']) || m['tools'].some((t) => typeof t !== 'string'))
  ) {
    fail(`Plugin "${id}": "tools" must be an array of tool-name strings when present.`, dir, id);
  }
  return {
    id,
    name: m['name'] as string,
    version: m['version'] as string,
    description: m['description'] as string,
    author: m['author'] as string | undefined,
    permissions: [...(permissions as PluginPermission[])],
    main: m['main'] as string,
    tools: m['tools'] as string[] | undefined,
  };
}

/** Read + validate `<dir>/manifest.json`. */
export function readManifest(dir: string): PluginManifest {
  const manifestPath = path.join(dir, 'manifest.json');
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    fail(`No manifest.json found in "${dir}".`, dir);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text!);
  } catch (err) {
    fail(`manifest.json in "${dir}" is not valid JSON: ${(err as Error).message}`, dir);
  }
  return validateManifest(raw, dir);
}

/** Collect the plugin's own `.js` / `.cjs` files (recursive, entry first). */
function collectPluginSources(dir: string, entryPath: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      out.push({ file: resolved, text: fs.readFileSync(resolved, 'utf8') });
    } catch {
      // Unreadable file: the require step below will report it properly.
    }
  };
  visit(entryPath);
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && (full.endsWith('.js') || full.endsWith('.cjs'))) visit(full);
    }
  };
  walk(dir);
  return out;
}

const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_FROM_RE = /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Reject any non-built-in, non-relative module specifier in the plugin's
 * own sources. Node built-ins (`node:fs`, `fs`) and relative paths
 * (`./helper`) are allowed; npm packages (`lodash`, `axios`, …) are not.
 */
export function checkRequiresAllowed(
  sources: Array<{ file: string; text: string }>,
  dir: string,
  pluginId: string,
): void {
  for (const { file, text } of sources) {
    const specifiers = new Set<string>();
    for (const re of [REQUIRE_RE, IMPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) specifiers.add(match[1]!);
    }
    for (const spec of specifiers) {
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) continue;
      if (BUILTINS.has(spec) || BUILTINS.has(spec.replace(/^node:/, ''))) continue;
      fail(
        `Plugin "${pluginId}" requires external package "${spec}" in ${path.relative(dir, file)}: ` +
          `plugins may only require Node built-ins or their own relative files (no npm dependencies).`,
        dir,
        pluginId,
      );
    }
  }
}

/** Throw when `source` uses a capability the manifest did not declare.
 *  `subject` names what was scanned, e.g. `tool "my_tool"` or `entry source`. */
export function checkPermissions(
  source: string,
  manifest: PluginManifest,
  dir: string,
  subject: string,
): void {
  const declared = new Set<PluginPermission>(manifest.permissions);
  for (const perm of PLUGIN_PERMISSIONS) {
    if (declared.has(perm)) continue;
    for (const pattern of PERMISSION_SIGNALS[perm]) {
      if (pattern.test(source)) {
        fail(
          `Plugin "${manifest.id}" ${subject} uses "${perm}" capability ` +
            `(${pattern}) but the manifest does not declare the "${perm}" permission. ` +
            `Add "${perm}" to manifest.json permissions, or remove that capability from the tool.`,
          dir,
          manifest.id,
        );
      }
    }
  }
}


/** Truncate plugin tool output (v0.14: dùng chung cho tool chạy sandboxed). */
export function truncatePluginOutput(text: string): string {
  return truncate(text);
}

/**
 * Validate one exported tool (same definition rules as core tools) and wrap
 * its `execute` so the returned text is truncated to 20_000 chars.
 * The wrapper does NOT change `needsApproval` or the tool name.
 */
export function wrapPluginTool(tool: Tool, manifest: PluginManifest, dir: string): Tool {
  validateToolDefinition(tool.definition);
  if (typeof tool.execute !== 'function') {
    fail(
      `Plugin "${manifest.id}" tool "${tool.definition.name}" must have an execute(args, ctx) function.`,
      dir,
      manifest.id,
    );
  }
  if (typeof tool.needsApproval !== 'boolean') {
    fail(
      `Plugin "${manifest.id}" tool "${tool.definition.name}" must have a boolean needsApproval flag.`,
      dir,
      manifest.id,
    );
  }
  const originalExecute = tool.execute.bind(tool);
  return {
    definition: tool.definition,
    needsApproval: tool.needsApproval,
    execute: async (args, ctx) => {
      const out = await originalExecute(args, ctx);
      return truncate(typeof out === 'string' ? out : String(out ?? ''));
    },
  };
}

function extractTools(mod: unknown, dir: string, pluginId: string): Tool[] {
  const m = mod as PluginModule | Tool[] | null;
  if (Array.isArray(m)) return m;
  if (m && typeof m === 'object') {
    if (Array.isArray((m as PluginModule).tools)) return (m as PluginModule).tools as Tool[];
    const def = (m as PluginModule).default;
    if (Array.isArray(def)) return def;
    if (def && typeof def === 'object' && Array.isArray(def.tools)) return def.tools as Tool[];
  }
  fail(
    `Plugin "${pluginId}" entry must export "tools" (an array of Tool) ` +
      `or "default" (an array of Tool, or { tools }). Got: ${mod === null ? 'null' : typeof mod}.`,
    dir,
    pluginId,
  );
}

/**
 * Load a plugin from a directory. Reads + validates `manifest.json`,
 * checks requires/permissions, requires the entry file and validates +
 * wraps every exported tool.
 *
 * Throws `PluginLoadError` on any problem — a plugin that fails to load
 * contributes NO tools, so a bad plugin can never half-register.
 */
export function loadPlugin(dir: string): LoadedPlugin {
  const absDir = path.resolve(dir);
  return loadPluginFromManifest(readManifest(absDir), absDir);
}

/**
 * Load a plugin from an already-validated manifest (v0.14 integration).
 * Dùng cho bundle (`plugin.json`/`bundle.json` — manifest đã validate qua
 * `validateBundleManifest`): cùng mọi kiểm tra như `loadPlugin`, chỉ khác
 * file manifest gốc (dùng làm base cho `createRequire` khi dọn cache).
 * `manifestFile` là tên file manifest trong `dir` (mặc định manifest.json).
 *
 * v0.15 (M9 audit): khi manifest có `checksum` (bundle) thì hash file
 * `main` phải khớp mới nạp; không có checksum thì cảnh báo stderr (chỉ
 * với bundle — xem `verifyPluginMainChecksum`).
 */
export function loadPluginFromManifest(
  manifest: PluginManifestWithChecksum,
  dir: string,
  manifestFile = 'manifest.json',
): LoadedPlugin {
  const absDir = path.resolve(dir);

  const entryPath = path.resolve(absDir, manifest.main);
  const dirWithSep = absDir + path.sep;
  if (entryPath !== absDir && !entryPath.startsWith(dirWithSep)) {
    fail(
      `Plugin "${manifest.id}": "main" (${manifest.main}) escapes the plugin directory.`,
      absDir,
      manifest.id,
    );
  }
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    fail(
      `Plugin "${manifest.id}": entry file "${manifest.main}" does not exist in "${absDir}".`,
      absDir,
      manifest.id,
    );
  }

  // v0.15 (M9 audit): verify checksum TRƯỚC khi require entry file.
  verifyPluginMainChecksum(manifest, entryPath, absDir, manifestFile);

  const sources = collectPluginSources(absDir, entryPath);
  checkRequiresAllowed(sources, absDir, manifest.id);
  const allSource = sources.map((s) => s.text).join('\n');
  // Plugin-level scan first: a capability used ANYWHERE in the plugin's
  // own code must be declared in the manifest. This catches a tool that
  // delegates the capability to a helper function in the entry file
  // (whose text would not appear in the tool's own execute source).
  // The whole plugin fails to load, so no tool of it reaches the registry.
  checkPermissions(allSource, manifest, absDir, 'entry source');

  // Fresh require each load (so a reinstalled / edited plugin is re-read,
  // and two copies of the same plugin do not share module state).
  const req = createRequire(path.join(absDir, manifestFile));
  try {
    delete req.cache[req.resolve(entryPath)];
  } catch {
    // Not previously loaded; nothing to evict.
  }
  let mod: unknown;
  try {
    mod = req(entryPath);
  } catch (err) {
    fail(
      `Plugin "${manifest.id}": failed to require entry "${manifest.main}": ${(err as Error).message}`,
      absDir,
      manifest.id,
    );
  }

  let tools = extractTools(mod, absDir, manifest.id);
  if (manifest.tools !== undefined) {
    const allowed = new Set(manifest.tools);
    tools = tools.filter((t) => t?.definition && allowed.has(t.definition.name));
  }

  const wrapped: Tool[] = [];
  const seenNames = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !tool.definition) {
      fail(`Plugin "${manifest.id}" exports an invalid tool (not a Tool object).`, absDir, manifest.id);
    }
    // Per-tool check on the tool's own execute source, so the error can
    // name the offending tool when the capability lives there.
    checkPermissions(tool.execute.toString(), manifest, absDir, `tool "${tool.definition.name}"`);
    const wrappedTool = wrapPluginTool(tool, manifest, absDir);
    if (seenNames.has(wrappedTool.definition.name)) {
      fail(
        `Plugin "${manifest.id}" exports duplicate tool name "${wrappedTool.definition.name}".`,
        absDir,
        manifest.id,
      );
    }
    seenNames.add(wrappedTool.definition.name);
    wrapped.push(wrappedTool);
  }
  return { manifest, dir: absDir, tools: wrapped };
}
