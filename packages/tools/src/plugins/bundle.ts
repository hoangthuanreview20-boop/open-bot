/**
 * Plugin bundle — v0.14 mục 2.
 *
 * Một plugin bundle là MỘT plugin duy nhất đóng gói nhiều thành phần trong
 * MỘT manifest + MỘT thư mục (mô hình Claude Code plugin): skill, subagent,
 * hook, máy chủ MCP, lệnh slash và tool thường. Manifest đọc từ
 * `plugin.json` (ưu tiên, tương thích plugin thường) hoặc `bundle.json`.
 *
 * Module này CHỈ validate + resolve (đường dẫn tuyệt đối đã kiểm tra).
 * Nó KHÔNG tự đăng ký skill/subagent/hook/MCP/slash vào bất kỳ
 * registry/loader/hook system nào — điều phối viên (coordinator) nối sau,
 * dùng kết quả của `resolveBundleParts()` / `loadBundle()`.
 *
 * An toàn đường dẫn: mọi đường dẫn tương đối trong manifest phải nằm
 * TRONG thư mục bundle — chặn `..` thoát ra ngoài và symlink trỏ ra ngoài
 * (kiểm tra bằng `realpath`, giống `resolveWithin` của sandbox).
 *
 * Giới hạn trung thực: bundle KHÔNG phải sandbox — code trong `main` /
 * hook script vẫn chạy in-process như plugin thường (xem types.ts).
 * Chỉ cài bundle từ nguồn bạn tin tưởng.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { HookEventKind, McpServerConfig, SpecializedSubagentSpec } from '@open-bot/core';
import { validateSpecializedSpec } from '@open-bot/core';
import { validateManifest } from './loader';
import type { PluginManifest } from './types';
import { PluginLoadError } from './types';

/** Tên file manifest của bundle — `plugin.json` được ưu tiên để tương thích plugin thường. */
export const BUNDLE_MANIFEST_FILES = ['plugin.json', 'bundle.json'] as const;

/** Các sự kiện hook hợp lệ (giữ đồng bộ với `HookEventKind` trong core). */
export const BUNDLE_HOOK_EVENTS: readonly HookEventKind[] = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'Stop',
];

/** Tên skill: chữ thường/số, bắt đầu bằng chữ/số, tối đa 64 ký tự (agentskills.io). */
export const BUNDLE_SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Tên lệnh slash / tên hook: chữ thường, số, "-" (giữ đồng bộ với slash.ts). */
export const BUNDLE_SLASH_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const BUNDLE_HOOK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Checksum hợp lệ: sha256 hex, đúng 64 ký tự (v0.15, M9 audit). */
export const BUNDLE_CHECKSUM_RE = /^[0-9a-f]{64}$/;
/** Semver đơn giản — giữ đồng bộ với loader.ts. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Skill trong bundle: chuỗi = đường dẫn tương đối tới thư mục skill
 * (chứa `SKILL.md`, tên skill = tên thư mục), hoặc object inline.
 */
export interface BundleSkillInline {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
}
export type BundleSkillRef = string | BundleSkillInline;

/** Subagent trong bundle — cùng shape với `SpecializedSubagentSpec` của core. */
export interface BundleSubagentRef {
  name: string;
  instructions: string;
  tools?: string[];
  model?: string;
}

/** Bộ lọc inline của hook (khi hook không có script): khớp theo tên tool / mẫu. */
export interface BundleHookMatcher {
  tool?: string;
  pattern?: string;
}

/**
 * Hook trong bundle: `script` là đường dẫn tương đối tới file script
 * trong bundle, `matcher` là bộ lọc inline. Cần ít nhất một trong hai.
 * `name` không bắt buộc — khi thiếu sẽ tự sinh `hook-<event>-<số thứ tự>`.
 */
export interface BundleHookRef {
  name?: string;
  event: HookEventKind;
  script?: string;
  matcher?: BundleHookMatcher;
}

/** Máy chủ MCP trong bundle: chuỗi = file config tương đối, hoặc object inline. */
export type BundleMcpServerRef = string | McpServerConfig;

/** Lệnh slash trong bundle: `file` là file Markdown chứa prompt template. */
export interface BundleSlashCommandRef {
  name: string;
  description: string;
  file: string;
}

/**
 * Manifest của bundle: mở rộng `PluginManifest` — `main` trở thành
 * optional (bundle có thể chỉ gồm skill/slash/hook mà không có tool),
 * cộng thêm các field optional cho từng thành phần.
 */
export interface PluginBundleManifest extends Omit<PluginManifest, 'main'> {
  main?: string;
  /**
   * v0.15 (M9 audit): checksum sha256 hex (64 ký tự) của file `main`,
   * optional để tương thích bundle cũ. Khi có mặt, `loadBundle` /
   * `loadPluginFromManifest` phải hash file `main` và từ chối nạp khi
   * không khớp. Khi vắng mặt, bundle vẫn nạp nhưng có cảnh báo stderr.
   */
  checksum?: string;
  skill?: BundleSkillRef;
  subagent?: BundleSubagentRef;
  hook?: BundleHookRef[];
  mcpServer?: BundleMcpServerRef;
  slashCommand?: BundleSlashCommandRef[];
}

/** Skill đã resolve: thư mục (đọc qua skills loader sau) hoặc inline. */
export interface ResolvedBundleSkill {
  kind: 'directory' | 'inline';
  name: string;
  /** Mô tả (inline) — với skill thư mục, đọc từ SKILL.md khi nạp sau. */
  description?: string;
  /** Đường dẫn tuyệt đối tới thư mục skill (chỉ khi kind = 'directory'). */
  dir?: string;
  /** Đường dẫn tuyệt đối tới SKILL.md (chỉ khi kind = 'directory'). */
  filePath?: string;
  /** Hướng dẫn (chỉ khi kind = 'inline'). */
  instructions?: string;
  /** Tool được phép (chỉ khi kind = 'inline'). */
  allowedTools?: string[];
}

/** Hook đã resolve: script thành đường dẫn tuyệt đối. */
export interface ResolvedBundleHook {
  name: string;
  event: HookEventKind;
  script?: string;
  matcher?: BundleHookMatcher;
}

/** Máy chủ MCP đã resolve. */
export interface ResolvedBundleMcpServer {
  name: string;
  config: McpServerConfig;
  /** File config gốc, khi mcpServer khai bằng tên file. */
  file?: string;
}

/** Lệnh slash đã resolve: file thành đường dẫn tuyệt đối. */
export interface ResolvedBundleSlashCommand {
  name: string;
  description: string;
  file: string;
}

/** Kết quả của `resolveBundleParts()` — mọi đường dẫn đã là tuyệt đối và đã kiểm tra. */
export interface ResolvedPluginBundleParts {
  manifest: PluginBundleManifest;
  dir: string;
  skill?: ResolvedBundleSkill;
  subagent?: SpecializedSubagentSpec;
  hooks: ResolvedBundleHook[];
  mcpServer?: ResolvedBundleMcpServer;
  slashCommands: ResolvedBundleSlashCommand[];
  /** Allowlist tool từ manifest (`[]` = không giới hạn theo manifest). */
  tools: string[];
  /** Entry file tuyệt đối, khi bundle có `main`. */
  main?: string;
}

/**
 * Lỗi của bundle: liệt kê TỪNG lỗi bằng tiếng Việt (một lỗi mỗi dòng
 * bắt đầu bằng "- "), thay vì chỉ lỗi đầu tiên như `validateManifest`.
 */
export class PluginBundleError extends PluginLoadError {
  readonly errors: string[];

  constructor(errors: string[], opts: { pluginId?: string; dir?: string } = {}) {
    const idPart = opts.pluginId ? ` "${opts.pluginId}"` : '';
    super(
      `Plugin bundle${idPart} không hợp lệ:\n${errors.map((e) => `- ${e}`).join('\n')}`,
      opts,
    );
    this.name = 'PluginBundleError';
    this.errors = [...errors];
  }
}

/** sha256 hex của một file (file `main` của plugin thường nhỏ). */
export function sha256FileHex(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Kiểm tra checksum của bundle (v0.15, M9 audit).
 *
 * - Manifest có `checksum`: hash file `main` phải khớp, không khớp thì
 *   ném `PluginBundleError` (từ chối nạp — file có thể đã bị sửa sau
 *   khi tác giả phát hành). `mainAbs` là đường dẫn tuyệt đối tới file
 *   main đã resolve (undefined khi bundle không có `main`).
 * - Không có `checksum`: nạp bình thường nhưng cảnh báo ra stderr
 *   (tương thích bundle cũ, chưa bắt buộc checksum).
 */
export function verifyBundleChecksum(
  manifest: PluginBundleManifest,
  mainAbs: string | undefined,
): void {
  if (!manifest.checksum) {
    if (mainAbs !== undefined) {
      process.stderr.write(
        `[open-bot] Cảnh báo: bundle "${manifest.id}" không có checksum — chỉ cài bundle từ nguồn đáng tin.\n`,
      );
    }
    return;
  }
  if (mainAbs === undefined) {
    throw new PluginBundleError(
      [`Bundle "${manifest.id}" khai "checksum" nhưng không có file "main" để kiểm tra.`],
      { pluginId: manifest.id },
    );
  }
  let actual: string;
  try {
    actual = sha256FileHex(mainAbs);
  } catch (err) {
    throw new PluginBundleError(
      [
        `Không đọc được file "main" của bundle "${manifest.id}" để kiểm tra checksum: ` +
          `${(err as Error).message}`,
      ],
      { pluginId: manifest.id },
    );
  }
  if (actual !== manifest.checksum) {
    throw new PluginBundleError(
      [
        `Checksum của bundle "${manifest.id}" không khớp: file "main" đã bị sửa đổi hoặc không đúng ` +
          `bản phát hành (khai ${manifest.checksum}, thực tế ${actual}). Từ chối nạp bundle.`,
      ],
      { pluginId: manifest.id },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve `rel` (tương đối) vào trong `dir`, chặn thoát ra ngoài bằng
 * `..`, đường dẫn tuyệt đối lạ, và symlink trỏ ra ngoài. Trả về đường
 * dẫn tuyệt đối, hoặc `undefined` (và ghi lỗi vào `errors`).
 * `label` là tên field trong manifest, vd `"skill"` hay `"main"`.
 */
function resolveInside(
  dir: string,
  rel: string,
  label: string,
  errors: string[],
): string | undefined {
  const absDir = path.resolve(dir);
  const abs = path.resolve(absDir, rel);
  if (abs !== absDir && !abs.startsWith(absDir + path.sep)) {
    errors.push(
      `Đường dẫn ${label} (${JSON.stringify(rel)}) thoát ra ngoài thư mục bundle — ` +
        `mọi file của bundle phải nằm trong thư mục của nó.`,
    );
    return undefined;
  }
  if (!fs.existsSync(abs)) {
    errors.push(`Đường dẫn ${label} (${JSON.stringify(rel)}) không tồn tại trong thư mục bundle.`);
    return undefined;
  }
  try {
    const realDir = fs.realpathSync(absDir);
    const real = fs.realpathSync(abs);
    if (real !== realDir && !real.startsWith(realDir + path.sep)) {
      errors.push(
        `Đường dẫn ${label} (${JSON.stringify(rel)}) trỏ ra ngoài thư mục bundle qua symlink — ` +
          `không cho phép symlink thoát ra ngoài.`,
      );
      return undefined;
    }
  } catch {
    errors.push(`Không đọc được đường dẫn ${label} (${JSON.stringify(rel)}) — có thể là symlink hỏng.`);
    return undefined;
  }
  return abs;
}

/** Kiểm tra các field cơ bản của manifest (trừ `main`), ghi lỗi tiếng Việt vào `errors`. */
function collectBaseFieldErrors(raw: Record<string, unknown>, errors: string[]): void {
  const id = raw['id'];
  const idLabel = typeof id === 'string' ? `"${id}"` : '(chưa có id)';
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    errors.push(`"id" ${JSON.stringify(id)} không hợp lệ: chỉ dùng chữ cái, số, "-" và "_".`);
  }
  if (typeof raw['name'] !== 'string' || (raw['name'] as string).trim() === '') {
    errors.push(`Plugin ${idLabel} cần có "name" là chuỗi không rỗng.`);
  }
  if (typeof raw['version'] !== 'string' || !SEMVER_RE.test(raw['version'])) {
    errors.push(
      `Plugin ${idLabel} có "version" ${JSON.stringify(raw['version'])} không hợp lệ: cần semver dạng "1.0.0".`,
    );
  }
  if (typeof raw['description'] !== 'string' || (raw['description'] as string).trim() === '') {
    errors.push(`Plugin ${idLabel} cần có "description" là chuỗi không rỗng.`);
  }
  if (raw['author'] !== undefined && typeof raw['author'] !== 'string') {
    errors.push(`Plugin ${idLabel}: "author" phải là chuỗi khi có mặt.`);
  }
  const permissions = raw['permissions'];
  const allowed = ['fs', 'shell', 'network', 'mcp'];
  if (
    !Array.isArray(permissions) ||
    permissions.some((p) => typeof p !== 'string' || !allowed.includes(p))
  ) {
    errors.push(
      `Plugin ${idLabel}: "permissions" phải là mảng chỉ gồm: ${allowed.join(', ')}.`,
    );
  }
  if (
    raw['tools'] !== undefined &&
    (!Array.isArray(raw['tools']) || raw['tools'].some((t) => typeof t !== 'string'))
  ) {
    errors.push(`Plugin ${idLabel}: "tools" phải là mảng các tên tool (chuỗi) khi có mặt.`);
  }
}

function hasAnyBundlePart(raw: Record<string, unknown>): boolean {
  return (
    raw['skill'] !== undefined ||
    raw['subagent'] !== undefined ||
    raw['hook'] !== undefined ||
    raw['mcpServer'] !== undefined ||
    raw['slashCommand'] !== undefined
  );
}

/** Validate một object McpServerConfig inline (theo đúng luật của core/mcp/config.ts). */
function validateMcpServerInline(
  raw: unknown,
  label: string,
  defaultName: string | undefined,
  errors: string[],
): McpServerConfig | undefined {
  const before = errors.length;
  if (!isRecord(raw)) {
    errors.push(`${label} phải là một object cấu hình máy chủ MCP.`);
    return undefined;
  }
  const name =
    typeof raw['name'] === 'string' && (raw['name'] as string).trim()
      ? (raw['name'] as string).trim()
      : defaultName;
  if (!name) {
    errors.push(`${label} cần có "name" (tên máy chủ MCP) — không suy ra được tên mặc định.`);
    return undefined;
  }
  const command = raw['command'];
  const url = raw['url'];
  if (command !== undefined && typeof command !== 'string') {
    errors.push(`${label} (máy chủ "${name}"): "command" phải là chuỗi.`);
  }
  if (url !== undefined && typeof url !== 'string') {
    errors.push(`${label} (máy chủ "${name}"): "url" phải là chuỗi.`);
  }
  const hasCommand = typeof command === 'string' && command.trim() !== '';
  const hasUrl = typeof url === 'string' && url.trim() !== '';
  if (!hasCommand && !hasUrl) {
    errors.push(
      `${label} (máy chủ "${name}"): cần có "command" (stdio) hoặc "url" (streamable HTTP) — thiếu cả hai.`,
    );
    return undefined;
  }
  if (hasUrl) {
    try {
      const parsed = new URL(url as string);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(`${label} (máy chủ "${name}"): "url" phải bắt đầu bằng http:// hoặc https://.`);
      }
    } catch {
      errors.push(`${label} (máy chủ "${name}"): "url" không phải URL hợp lệ.`);
    }
  }
  const args = raw['args'];
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    errors.push(`${label} (máy chủ "${name}"): "args" phải là mảng các chuỗi.`);
  }
  for (const field of ['env', 'headers'] as const) {
    const v = raw[field];
    if (v !== undefined) {
      if (!isRecord(v) || Object.values(v).some((x) => typeof x !== 'string')) {
        errors.push(`${label} (máy chủ "${name}"): "${field}" phải là object với giá trị chuỗi.`);
      }
    }
  }
  if (errors.length > before) {
    // Có lỗi thuộc về server này — trả về undefined để caller không dùng config dở.
    return undefined;
  }
  const config: McpServerConfig = { name };
  if (hasCommand) config.command = command as string;
  if (Array.isArray(args)) config.args = [...(args as string[])];
  if (isRecord(raw['env'])) config.env = { ...(raw['env'] as Record<string, string>) };
  if (hasUrl) config.url = url as string;
  if (isRecord(raw['headers'])) config.headers = { ...(raw['headers'] as Record<string, string>) };
  return config;
}

/**
 * Đọc file config MCP: hoặc một object server duy nhất, hoặc
 * `{ "servers": { "<tên>": {...} } }` với ĐÚNG MỘT server (bundle chỉ
 * đóng gói một máy chủ MCP). Trả về config, hoặc undefined (ghi lỗi).
 */
function readMcpServerFile(
  absPath: string,
  label: string,
  defaultName: string | undefined,
  errors: string[],
): McpServerConfig | undefined {
  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    errors.push(`Không đọc được file cấu hình MCP ${label}: ${(err as Error).message}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    errors.push(`File cấu hình MCP ${label} không phải JSON hợp lệ: ${(err as Error).message}`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    errors.push(`File cấu hình MCP ${label} phải chứa một JSON object.`);
    return undefined;
  }
  const servers = parsed['servers'];
  if (servers !== undefined) {
    if (!isRecord(servers)) {
      errors.push(`File cấu hình MCP ${label}: "servers" phải là một object.`);
      return undefined;
    }
    const entries = Object.entries(servers);
    if (entries.length !== 1) {
      errors.push(
        `File cấu hình MCP ${label} phải khai đúng MỘT máy chủ trong "servers" ` +
          `(đang có ${entries.length}) — một bundle chỉ đóng gói một máy chủ MCP.`,
      );
      return undefined;
    }
    const [key, serverRaw] = entries[0]!;
    return validateMcpServerInline(serverRaw, label, key, errors);
  }
  return validateMcpServerInline(parsed, label, defaultName, errors);
}

/**
 * Validate manifest bundle (raw JSON đã parse) trong thư mục `dir`.
 * Thu thập TẤT CẢ lỗi rồi ném một `PluginBundleError` liệt kê từng lỗi
 * bằng tiếng Việt. Trả về manifest đã chuẩn hoá khi hợp lệ.
 */
export function validateBundleManifest(raw: unknown, dir: string): PluginBundleManifest {
  const absDir = path.resolve(dir);
  const errors: string[] = [];
  if (!isRecord(raw)) {
    throw new PluginBundleError(
      ['Manifest của bundle phải là một JSON object (nhận được kiểu dữ liệu khác).'],
      { dir: absDir },
    );
  }
  const pluginId = typeof raw['id'] === 'string' ? raw['id'] : undefined;
  const hasParts = hasAnyBundlePart(raw);
  const mainRaw = raw['main'];

  // --- Nền tảng: tái sử dụng validateManifest của plugin thường. ---
  // Bundle không có `main` vẫn hợp lệ khi nó đóng gói ít nhất một thành
  // phần khác (skill/slash/hook/...) — trường hợp này validate thủ công
  // các field còn lại. Lỗi của validateManifest được diễn giải lại bằng
  // tiếng Việt (collectBaseFieldErrors) để message liệt kê đầy đủ.
  let base: PluginManifest | null = null;
  try {
    base = validateManifest(raw, absDir);
  } catch {
    const mainMissing =
      mainRaw === undefined || (typeof mainRaw === 'string' && mainRaw.trim() === '');
    const baseErrors: string[] = [];
    collectBaseFieldErrors(raw, baseErrors);
    if (mainMissing && hasParts) {
      if (baseErrors.length === 0) {
        base = {
          id: raw['id'] as string,
          name: raw['name'] as string,
          version: raw['version'] as string,
          description: raw['description'] as string,
          author: raw['author'] as string | undefined,
          permissions: [...(raw['permissions'] as PluginManifest['permissions'])],
          main: '',
          tools: raw['tools'] as string[] | undefined,
        };
      } else {
        errors.push(...baseErrors);
      }
    } else {
      if (baseErrors.length > 0) errors.push(...baseErrors);
      if (mainMissing) {
        errors.push(
          'Bundle cần có "main" (file entry của plugin) hoặc ít nhất một thành phần ' +
            'bundle (skill, subagent, hook, mcpServer, slashCommand) — hiện không có gì cả.',
        );
      }
    }
  }
  // `main` khi có mặt: phải nằm trong thư mục bundle và tồn tại.
  if (typeof mainRaw === 'string' && mainRaw.trim() !== '') {
    const mainAbs = resolveInside(absDir, mainRaw, '"main"', errors);
    if (mainAbs !== undefined && !isFile(mainAbs)) {
      errors.push(`Entry file "main" (${JSON.stringify(mainRaw)}) không tồn tại hoặc không phải file.`);
    }
  }

  // --- checksum (v0.15, M9 audit): sha256 hex của file `main`, optional. ---
  let checksum: string | undefined;
  if (raw['checksum'] !== undefined) {
    if (typeof raw['checksum'] !== 'string' || !BUNDLE_CHECKSUM_RE.test(raw['checksum'])) {
      errors.push(
        `"checksum" phải là chuỗi sha256 hex 64 ký tự (nhận ${JSON.stringify(raw['checksum'])}).`,
      );
    } else {
      checksum = raw['checksum'];
      if (mainRaw === undefined || (typeof mainRaw === 'string' && mainRaw.trim() === '')) {
        errors.push('"checksum" chỉ có ý nghĩa khi bundle có "main" — bundle này không có file "main".');
      }
    }
  }

  // --- Thu thập tên các thành phần để kiểm tra trùng tên. ---
  const seenNames: Array<{ name: string; kind: string }> = [];
  const noteName = (name: string | undefined, kind: string): void => {
    if (name !== undefined && name !== '') seenNames.push({ name, kind });
  };

  // --- skill ---
  let skill: BundleSkillRef | undefined;
  if (raw['skill'] !== undefined) {
    const s = raw['skill'];
    if (typeof s === 'string') {
      if (s.trim() === '') {
        errors.push('"skill" dạng đường dẫn phải là chuỗi không rỗng.');
      } else {
        const skillDir = resolveInside(absDir, s, '"skill"', errors);
        if (skillDir !== undefined) {
          if (!isDir(skillDir)) {
            errors.push(`"skill" (${JSON.stringify(s)}) phải trỏ tới một thư mục chứa SKILL.md.`);
          } else {
            const skillFile = resolveInside(absDir, path.join(s, 'SKILL.md'), '"skill"/SKILL.md', errors);
            if (skillFile !== undefined && !isFile(skillFile)) {
              errors.push(`Thư mục skill (${JSON.stringify(s)}) thiếu file SKILL.md.`);
            }
            noteName(path.basename(skillDir), 'skill');
          }
        }
        skill = s;
      }
    } else if (isRecord(s)) {
      const name = s['name'];
      if (typeof name !== 'string' || !BUNDLE_SKILL_NAME_RE.test(name)) {
        errors.push(
          `"skill" inline cần "name" hợp lệ: chữ thường/số, bắt đầu bằng chữ/số, tối đa 64 ký tự ` +
            `(nhận ${JSON.stringify(name)}).`,
        );
      }
      if (typeof s['description'] !== 'string' || (s['description'] as string).trim() === '') {
        errors.push(`"skill" inline (${JSON.stringify(name)}) cần "description" không rỗng.`);
      }
      if (typeof s['instructions'] !== 'string' || (s['instructions'] as string).trim() === '') {
        errors.push(`"skill" inline (${JSON.stringify(name)}) cần "instructions" không rỗng.`);
      }
      if (
        s['allowedTools'] !== undefined &&
        (!Array.isArray(s['allowedTools']) ||
          s['allowedTools'].some((t) => typeof t !== 'string' || t.trim() === ''))
      ) {
        errors.push(`"skill" inline (${JSON.stringify(name)}): "allowedTools" phải là mảng tên tool không rỗng.`);
      }
      if (typeof name === 'string' && BUNDLE_SKILL_NAME_RE.test(name)) {
        noteName(name, 'skill');
        skill = {
          name,
          description: (s['description'] as string)?.trim() ?? '',
          instructions: (s['instructions'] as string)?.trim() ?? '',
          ...(Array.isArray(s['allowedTools'])
            ? { allowedTools: [...(s['allowedTools'] as string[])] }
            : {}),
        };
      }
    } else {
      errors.push('"skill" phải là đường dẫn thư mục (chuỗi) hoặc object inline { name, description, instructions }.');
    }
  }

  // --- subagent ---
  let subagent: SpecializedSubagentSpec | undefined;
  if (raw['subagent'] !== undefined) {
    const s = raw['subagent'];
    if (!isRecord(s)) {
      errors.push('"subagent" phải là object { name, instructions, tools?, model? }.');
    } else {
      try {
        subagent = validateSpecializedSpec(s as unknown as SpecializedSubagentSpec);
        noteName(subagent.name, 'subagent');
      } catch (err) {
        errors.push(`"subagent" không hợp lệ: ${(err as Error).message}`);
      }
    }
  }

  // --- hook ---
  let hooks: BundleHookRef[] | undefined;
  if (raw['hook'] !== undefined) {
    const list = raw['hook'];
    if (!Array.isArray(list)) {
      errors.push('"hook" phải là một mảng các hook.');
    } else {
      hooks = [];
      list.forEach((entry, i) => {
        const label = `"hook"[${i}]`;
        if (!isRecord(entry)) {
          errors.push(`${label} phải là object { event, script? | matcher? }.`);
          return;
        }
        const event = entry['event'];
        if (typeof event !== 'string' || !(BUNDLE_HOOK_EVENTS as readonly string[]).includes(event)) {
          errors.push(
            `${label} có "event" ${JSON.stringify(event)} không hợp lệ — chỉ dùng: ${BUNDLE_HOOK_EVENTS.join(', ')}.`,
          );
          return;
        }
        const name =
          typeof entry['name'] === 'string' && (entry['name'] as string).trim() !== ''
            ? (entry['name'] as string).trim()
            : `hook-${event}-${i + 1}`;
        if (
          typeof entry['name'] === 'string' &&
          entry['name'] !== '' &&
          !BUNDLE_HOOK_NAME_RE.test(entry['name'])
        ) {
          errors.push(
            `${label} có "name" ${JSON.stringify(entry['name'])} không hợp lệ: chỉ dùng chữ thường, số, "-" và "_".`,
          );
        }
        noteName(name, 'hook');
        const script = entry['script'];
        const matcher = entry['matcher'];
        if (script === undefined && matcher === undefined) {
          errors.push(`${label} (hook "${name}") cần có "script" hoặc "matcher" — thiếu cả hai.`);
          return;
        }
        let scriptRel: string | undefined;
        if (script !== undefined) {
          if (typeof script !== 'string' || script.trim() === '') {
            errors.push(`${label} (hook "${name}"): "script" phải là đường dẫn file không rỗng.`);
          } else {
            const scriptAbs = resolveInside(absDir, script, `${label} "script"`, errors);
            if (scriptAbs !== undefined && !isFile(scriptAbs)) {
              errors.push(`${label} (hook "${name}"): file script (${JSON.stringify(script)}) không tồn tại hoặc không phải file.`);
            }
            scriptRel = script;
          }
        }
        let matcherNorm: BundleHookMatcher | undefined;
        if (matcher !== undefined) {
          if (!isRecord(matcher)) {
            errors.push(`${label} (hook "${name}"): "matcher" phải là object { tool?, pattern? }.`);
          } else {
            const tool = matcher['tool'];
            const pattern = matcher['pattern'];
            if (
              (tool !== undefined && typeof tool !== 'string') ||
              (pattern !== undefined && typeof pattern !== 'string')
            ) {
              errors.push(`${label} (hook "${name}"): "matcher.tool" và "matcher.pattern" phải là chuỗi.`);
            } else if (tool === undefined && pattern === undefined) {
              errors.push(`${label} (hook "${name}"): "matcher" cần ít nhất "tool" hoặc "pattern".`);
            } else {
              matcherNorm = {
                ...(typeof tool === 'string' ? { tool } : {}),
                ...(typeof pattern === 'string' ? { pattern } : {}),
              };
            }
          }
        }
        hooks!.push({
          name,
          event: event as HookEventKind,
          ...(scriptRel !== undefined ? { script: scriptRel } : {}),
          ...(matcherNorm !== undefined ? { matcher: matcherNorm } : {}),
        });
      });
    }
  }

  // --- mcpServer ---
  let mcpServer: BundleMcpServerRef | undefined;
  let mcpName: string | undefined;
  if (raw['mcpServer'] !== undefined) {
    const m = raw['mcpServer'];
    if (typeof m === 'string') {
      if (m.trim() === '') {
        errors.push('"mcpServer" dạng file phải là đường dẫn không rỗng.');
      } else {
        const abs = resolveInside(absDir, m, '"mcpServer"', errors);
        if (abs !== undefined) {
          if (!isFile(abs)) {
            errors.push(`File cấu hình MCP (${JSON.stringify(m)}) không tồn tại hoặc không phải file.`);
          } else {
            const before = errors.length;
            const config = readMcpServerFile(abs, `"mcpServer" (${JSON.stringify(m)})`, pluginId, errors);
            if (config !== undefined && errors.length === before) {
              mcpName = config.name;
              mcpServer = m;
            }
          }
        }
      }
    } else if (isRecord(m)) {
      const before = errors.length;
      const config = validateMcpServerInline(m, '"mcpServer" inline', pluginId, errors);
      if (config !== undefined && errors.length === before) {
        mcpName = config.name;
        mcpServer = config;
      }
    } else {
      errors.push('"mcpServer" phải là tên file config (chuỗi) hoặc object cấu hình máy chủ MCP. ');
    }
    noteName(mcpName, 'máy chủ MCP');
  }

  // --- slashCommand ---
  let slashCommands: BundleSlashCommandRef[] | undefined;
  if (raw['slashCommand'] !== undefined) {
    const list = raw['slashCommand'];
    if (!Array.isArray(list)) {
      errors.push('"slashCommand" phải là một mảng các lệnh slash.');
    } else {
      slashCommands = [];
      list.forEach((entry, i) => {
        const label = `"slashCommand"[${i}]`;
        if (!isRecord(entry)) {
          errors.push(`${label} phải là object { name, description, file }.`);
          return;
        }
        const name = entry['name'];
        if (typeof name !== 'string' || !BUNDLE_SLASH_NAME_RE.test(name)) {
          errors.push(
            `${label} có "name" ${JSON.stringify(name)} không hợp lệ: tên lệnh slash chỉ dùng chữ thường, số và "-".`,
          );
          return;
        }
        noteName(name, 'lệnh slash');
        if (typeof entry['description'] !== 'string' || (entry['description'] as string).trim() === '') {
          errors.push(`Lệnh slash "/${name}" cần "description" không rỗng.`);
        }
        const file = entry['file'];
        if (typeof file !== 'string' || file.trim() === '') {
          errors.push(`Lệnh slash "/${name}" cần "file" là đường dẫn tới file Markdown không rỗng.`);
          return;
        }
        const abs = resolveInside(absDir, file, `lệnh slash "/${name}" ("file")`, errors);
        if (abs !== undefined) {
          if (!isFile(abs)) {
            errors.push(`File của lệnh slash "/${name}" (${JSON.stringify(file)}) không tồn tại hoặc không phải file.`);
          } else if (!abs.endsWith('.md')) {
            errors.push(`File của lệnh slash "/${name}" (${JSON.stringify(file)}) phải có đuôi .md.`);
          } else {
            let content = '';
            try {
              content = fs.readFileSync(abs, 'utf8');
            } catch (err) {
              errors.push(`Không đọc được file của lệnh slash "/${name}": ${(err as Error).message}`);
            }
            if (content.trim() === '') {
              errors.push(`File của lệnh slash "/${name}" (${JSON.stringify(file)}) rỗng — cần nội dung prompt template.`);
            }
          }
        }
        slashCommands!.push({
          name,
          description: typeof entry['description'] === 'string' ? entry['description'].trim() : '',
          file,
        });
      });
    }
  }

  // --- Trùng tên giữa các thành phần trong cùng bundle. ---
  const byName = new Map<string, string[]>();
  for (const { name, kind } of seenNames) {
    const kinds = byName.get(name) ?? [];
    kinds.push(kind);
    byName.set(name, kinds);
  }
  for (const [name, kinds] of [...byName.entries()].sort()) {
    if (kinds.length > 1) {
      errors.push(
        `Tên "${name}" bị trùng trong cùng bundle (${kinds.join(' và ')}) — ` +
          `skill, subagent, hook, máy chủ MCP và lệnh slash phải có tên khác nhau.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new PluginBundleError(errors, { pluginId, dir: absDir });
  }

  // base chắc chắn đã có ở đây (validateManifest thành công, hoặc đường
  // manual khi thiếu main mà có thành phần khác — và khi đó baseErrors rỗng).
  const b = base!;
  const manifest: PluginBundleManifest = {
    id: b.id,
    name: b.name,
    version: b.version,
    description: b.description,
    ...(b.author !== undefined ? { author: b.author } : {}),
    permissions: [...b.permissions],
    ...(b.main !== undefined && b.main !== '' ? { main: b.main } : {}),
    ...(checksum !== undefined ? { checksum } : {}),
    ...(b.tools !== undefined ? { tools: [...b.tools] } : {}),
    ...(skill !== undefined ? { skill } : {}),
    ...(subagent !== undefined ? { subagent } : {}),
    ...(hooks !== undefined ? { hook: hooks } : {}),
    ...(mcpServer !== undefined ? { mcpServer } : {}),
    ...(slashCommands !== undefined ? { slashCommand: slashCommands } : {}),
  };
  return manifest;
}

/**
 * Resolve các thành phần của một manifest bundle đã validate thành đường
 * dẫn tuyệt đối đã kiểm tra. Ném `PluginBundleError` khi file biến mất
 * hoặc đổi chỗ sau lúc validate. KHÔNG đăng ký gì vào registry/loader/
 * hook system — điều phối viên dùng kết quả này để nối sau.
 */
export function resolveBundleParts(
  manifest: PluginBundleManifest,
  dir: string,
): ResolvedPluginBundleParts {
  const absDir = path.resolve(dir);
  const errors: string[] = [];
  const pluginId = manifest.id;

  let main: string | undefined;
  if (manifest.main !== undefined && manifest.main !== '') {
    const abs = resolveInside(absDir, manifest.main, '"main"', errors);
    if (abs !== undefined && !isFile(abs)) {
      errors.push(`Entry file "main" (${JSON.stringify(manifest.main)}) không tồn tại hoặc không phải file.`);
    } else {
      main = abs;
    }
  }

  let skill: ResolvedBundleSkill | undefined;
  if (manifest.skill !== undefined) {
    if (typeof manifest.skill === 'string') {
      const skillDir = resolveInside(absDir, manifest.skill, '"skill"', errors);
      if (skillDir !== undefined) {
        const skillFile = resolveInside(absDir, path.join(manifest.skill, 'SKILL.md'), '"skill"/SKILL.md', errors);
        skill = {
          kind: 'directory',
          name: path.basename(skillDir),
          dir: skillDir,
          ...(skillFile !== undefined ? { filePath: skillFile } : {}),
        };
      }
    } else {
      skill = {
        kind: 'inline',
        name: manifest.skill.name,
        description: manifest.skill.description,
        instructions: manifest.skill.instructions,
        ...(manifest.skill.allowedTools !== undefined
          ? { allowedTools: [...manifest.skill.allowedTools] }
          : {}),
      };
    }
  }

  let subagent: SpecializedSubagentSpec | undefined;
  if (manifest.subagent !== undefined) {
    try {
      subagent = validateSpecializedSpec(manifest.subagent);
    } catch (err) {
      errors.push(`"subagent" không hợp lệ: ${(err as Error).message}`);
    }
  }

  const hooks: ResolvedBundleHook[] = [];
  for (const [i, h] of (manifest.hook ?? []).entries()) {
    // Tên đã được chuẩn hoá ở validate (thiếu thì sinh hook-<event>-<số>);
    // sinh lại ở đây để type an toàn khi manifest được dựng bằng tay.
    const hookName = h.name ?? `hook-${h.event}-${i + 1}`;
    let script: string | undefined;
    if (h.script !== undefined) {
      const abs = resolveInside(absDir, h.script, `hook "${hookName}" ("script")`, errors);
      if (abs !== undefined && !isFile(abs)) {
        errors.push(`File script của hook "${hookName}" (${JSON.stringify(h.script)}) không tồn tại hoặc không phải file.`);
      } else {
        script = abs;
      }
    }
    hooks.push({
      name: hookName,
      event: h.event,
      ...(script !== undefined ? { script } : {}),
      ...(h.matcher !== undefined ? { matcher: { ...h.matcher } } : {}),
    });
  }

  let mcpServer: ResolvedBundleMcpServer | undefined;
  if (manifest.mcpServer !== undefined) {
    if (typeof manifest.mcpServer === 'string') {
      const abs = resolveInside(absDir, manifest.mcpServer, '"mcpServer"', errors);
      if (abs !== undefined) {
        const config = readMcpServerFile(abs, `"mcpServer" (${JSON.stringify(manifest.mcpServer)})`, pluginId, errors);
        if (config !== undefined) {
          mcpServer = { name: config.name, config, file: abs };
        }
      }
    } else {
      mcpServer = { name: manifest.mcpServer.name, config: { ...manifest.mcpServer } };
    }
  }

  const slashCommands: ResolvedBundleSlashCommand[] = [];
  for (const c of manifest.slashCommand ?? []) {
    const abs = resolveInside(absDir, c.file, `lệnh slash "/${c.name}" ("file")`, errors);
    if (abs !== undefined) {
      if (!isFile(abs)) {
        errors.push(`File của lệnh slash "/${c.name}" (${JSON.stringify(c.file)}) không tồn tại hoặc không phải file.`);
      } else {
        slashCommands.push({ name: c.name, description: c.description, file: abs });
      }
    }
  }

  if (errors.length > 0) {
    throw new PluginBundleError(errors, { pluginId, dir: absDir });
  }

  return {
    manifest,
    dir: absDir,
    ...(skill !== undefined ? { skill } : {}),
    ...(subagent !== undefined ? { subagent } : {}),
    hooks,
    ...(mcpServer !== undefined ? { mcpServer } : {}),
    slashCommands,
    tools: manifest.tools !== undefined ? [...manifest.tools] : [],
    ...(main !== undefined ? { main } : {}),
  };
}

/**
 * Nạp một bundle từ thư mục: đọc `plugin.json` (ưu tiên) hoặc
 * `bundle.json`, validate rồi resolve. Ném `PluginBundleError` khi
 * thiếu file manifest, JSON sai, hoặc manifest không hợp lệ.
 */
export function loadBundle(dir: string): ResolvedPluginBundleParts {
  const absDir = path.resolve(dir);
  let manifestPath: string | undefined;
  for (const file of BUNDLE_MANIFEST_FILES) {
    const candidate = path.join(absDir, file);
    if (fs.existsSync(candidate)) {
      manifestPath = candidate;
      break;
    }
  }
  if (manifestPath === undefined) {
    throw new PluginBundleError(
      [`Không tìm thấy plugin.json hoặc bundle.json trong thư mục "${absDir}".`],
      { dir: absDir },
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new PluginBundleError(
      [`Không đọc được ${path.basename(manifestPath)}: ${(err as Error).message}`],
      { dir: absDir },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PluginBundleError(
      [`${path.basename(manifestPath)} không phải JSON hợp lệ: ${(err as Error).message}`],
      { dir: absDir },
    );
  }
  const manifest = validateBundleManifest(raw, absDir);
  const parts = resolveBundleParts(manifest, absDir);
  // v0.15 (M9 audit): verify checksum của file `main` khi manifest khai
  // báo; không có checksum thì chỉ cảnh báo, vẫn nạp bình thường.
  verifyBundleChecksum(manifest, parts.main);
  return parts;
}
