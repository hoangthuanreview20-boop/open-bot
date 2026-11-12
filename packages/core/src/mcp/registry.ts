/**
 * MCP Registry — định dạng `server.json` (v0.13).
 *
 * Đọc/validate file registry chuẩn của MCP Registry
 * (registry.modelcontextprotocol.io): một file có thể là một server đơn
 * lẻ hoặc một registry `{ servers: [...] }`. Hỗ trợ tải registry từ URL
 * remote kèm cache local có TTL và kiểm tra checksum SHA-256 trước khi
 * tin nội dung tải về: cache hỏng / sai checksum thì từ chối, không dùng.
 *
 * Module này KHÔNG sửa `mcp.json` hay marketplace local — nó chỉ parse
 * và validate; coordinator/marketplace nối sau để cài đặt từ entry.
 * Không log nội dung registry (có thể chứa header secret mẫu).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerConfig } from './types';

export type RegistryFetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Cache remote registry mặc định: 1 giờ. */
export const DEFAULT_REGISTRY_CACHE_TTL_MS = 60 * 60_000;
/** Tên file cache cho một registry URL (hash để không lộ URL trong tên). */
export const REGISTRY_CACHE_FILE_PREFIX = 'registry-';

export interface RegistryPackageTransport {
  type: 'stdio' | 'streamable-http' | 'sse';
  /** Lệnh chạy cho stdio (vd `npx`). */
  command?: string;
  args?: string[];
  /** URL cho transport http/sse. */
  url?: string;
  headers?: Array<{ name: string; value?: string; isSecret?: boolean }>;
  [key: string]: unknown;
}

export interface RegistryPackage {
  registryType: 'npm' | 'pypi' | 'oci' | 'nuget';
  identifier: string;
  version: string;
  transport: RegistryPackageTransport;
  runtimeHint?: string;
  environmentVariables?: Array<{
    name: string;
    description?: string;
    isSecret?: boolean;
    isRequired?: boolean;
    default?: string;
  }>;
  [key: string]: unknown;
}

export interface RegistryRemote {
  transportType: 'streamable-http' | 'sse';
  url: string;
  headers?: Array<{ name: string; value?: string; isSecret?: boolean }>;
  [key: string]: unknown;
}

export interface RegistryRepository {
  url: string;
  id?: string;
  subfolder?: string;
  [key: string]: unknown;
}

export interface RegistryServerEntry {
  /** Tên registry, vd `io.github.example/filesystem`. */
  name: string;
  description: string;
  version: string;
  title?: string;
  repository?: RegistryRepository;
  websiteUrl?: string;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: string }>;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
  /** Checksum SHA-256 (hex) của package/server, khi registry công bố. */
  checksum?: string;
  [key: string]: unknown;
}

export interface RegistryFile {
  $schema?: string;
  version?: string;
  servers: RegistryServerEntry[];
}

const REGISTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertHttpUrl(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Registry server.json không hợp lệ: "${what}" phải là URL không rỗng.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Registry server.json không hợp lệ: "${what}" không phải URL hợp lệ.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Registry server.json không hợp lệ: "${what}" phải là http:// hoặc https://.`);
  }
  return value;
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Registry server.json không hợp lệ: "${what}" phải là mảng chuỗi.`);
  }
  return [...(value as string[])];
}

/** SHA-256 hex của một chuỗi / Buffer. */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Kiểm tra checksum SHA-256: so sánh bằng `timingSafeEqual` để không
 * rò rỉ vị trí sai khác qua thời gian. Checksum sai định dạng → false.
 */
export function verifyChecksum(content: string | Buffer, expectedSha256: string): boolean {
  if (!SHA256_HEX_RE.test(expectedSha256.trim())) return false;
  const actual = sha256Hex(content);
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expectedSha256.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function validatePackage(raw: unknown, serverName: string, index: number): RegistryPackage {
  if (!isRecord(raw)) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": package #${index} phải là object.`,
    );
  }
  const registryType = raw['registryType'];
  if (
    registryType !== 'npm' &&
    registryType !== 'pypi' &&
    registryType !== 'oci' &&
    registryType !== 'nuget'
  ) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": package #${index} có "registryType" không hợp lệ.`,
    );
  }
  if (typeof raw['identifier'] !== 'string' || !(raw['identifier'] as string).trim()) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": package #${index} thiếu "identifier".`,
    );
  }
  if (typeof raw['version'] !== 'string' || !SEMVER_RE.test(raw['version'] as string)) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": package #${index} có "version" không phải semver (vd "1.2.3").`,
    );
  }
  if (!isRecord(raw['transport'])) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": package #${index} thiếu "transport".`,
    );
  }
  const transportRaw = raw['transport'] as Record<string, unknown>;
  if (
    transportRaw['type'] !== 'stdio' &&
    transportRaw['type'] !== 'streamable-http' &&
    transportRaw['type'] !== 'sse'
  ) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": package #${index} có transport "type" không hợp lệ.`,
    );
  }
  const transport: RegistryPackageTransport = {
    type: transportRaw['type'] as RegistryPackageTransport['type'],
  };
  if (transport.type === 'stdio') {
    if (typeof transportRaw['command'] === 'string') transport.command = transportRaw['command'] as string;
    if (transportRaw['args'] !== undefined) transport.args = stringList(transportRaw['args'], 'args');
  } else if (typeof transportRaw['url'] === 'string') {
    transport.url = assertHttpUrl(transportRaw['url'], 'package transport url');
  }
  const pkg: RegistryPackage = {
    registryType: registryType as RegistryPackage['registryType'],
    identifier: raw['identifier'] as string,
    version: raw['version'] as string,
    transport,
  };
  if (typeof raw['runtimeHint'] === 'string') pkg.runtimeHint = raw['runtimeHint'] as string;
  return pkg;
}

function validateRemote(raw: unknown, serverName: string, index: number): RegistryRemote {
  if (!isRecord(raw)) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": remote #${index} phải là object.`,
    );
  }
  if (raw['transportType'] !== 'streamable-http' && raw['transportType'] !== 'sse') {
    throw new Error(
      `Registry server.json không hợp lệ: server "${serverName}": remote #${index} có "transportType" không hợp lệ.`,
    );
  }
  const remote: RegistryRemote = {
    transportType: raw['transportType'] as RegistryRemote['transportType'],
    url: assertHttpUrl(raw['url'], 'remote url'),
  };
  return remote;
}

/**
 * Validate một entry server trong registry. Yêu cầu: `name` hợp lệ,
 * `description` không rỗng, `version` semver, và ít nhất một
 * `packages` hoặc `remotes`. `repository.url` / `websiteUrl` / `icons[].src`
 * (khi có) phải là URL http(s) hợp lệ. `checksum` (khi có) phải là
 * SHA-256 hex.
 */
export function validateRegistryEntry(raw: unknown, index = 0): RegistryServerEntry {
  if (!isRecord(raw)) {
    throw new Error(`Registry server.json không hợp lệ: entry #${index} phải là object.`);
  }
  const name = raw['name'];
  if (typeof name !== 'string' || !REGISTRY_NAME_RE.test(name)) {
    throw new Error(
      `Registry server.json không hợp lệ: entry #${index} có "name" không hợp lệ (chỉ chữ, số, ".", "_", "-", "/").`,
    );
  }
  if (typeof raw['description'] !== 'string' || !(raw['description'] as string).trim()) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${name}": thiếu "description" không rỗng.`,
    );
  }
  if (typeof raw['version'] !== 'string' || !SEMVER_RE.test(raw['version'] as string)) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${name}": "version" phải là semver (vd "1.2.3").`,
    );
  }
  const packagesRaw = raw['packages'];
  const remotesRaw = raw['remotes'];
  if (packagesRaw !== undefined && !Array.isArray(packagesRaw)) {
    throw new Error(`Registry server.json không hợp lệ: server "${name}": "packages" phải là mảng.`);
  }
  if (remotesRaw !== undefined && !Array.isArray(remotesRaw)) {
    throw new Error(`Registry server.json không hợp lệ: server "${name}": "remotes" phải là mảng.`);
  }
  if (
    (!Array.isArray(packagesRaw) || packagesRaw.length === 0) &&
    (!Array.isArray(remotesRaw) || remotesRaw.length === 0)
  ) {
    throw new Error(
      `Registry server.json không hợp lệ: server "${name}": cần ít nhất một "packages" hoặc "remotes".`,
    );
  }
  const entry: RegistryServerEntry = {
    name: name as string,
    description: raw['description'] as string,
    version: raw['version'] as string,
  };
  if (typeof raw['title'] === 'string') entry.title = raw['title'] as string;
  if (isRecord(raw['repository'])) {
    const repo = raw['repository'] as Record<string, unknown>;
    const repository: RegistryRepository = { url: assertHttpUrl(repo['url'], 'repository.url') };
    if (typeof repo['id'] === 'string') repository.id = repo['id'] as string;
    if (typeof repo['subfolder'] === 'string') repository.subfolder = repo['subfolder'] as string;
    entry.repository = repository;
  }
  if (typeof raw['websiteUrl'] === 'string') {
    entry.websiteUrl = assertHttpUrl(raw['websiteUrl'], 'websiteUrl');
  }
  if (Array.isArray(raw['icons'])) {
    entry.icons = (raw['icons'] as unknown[]).map((icon, i) => {
      if (!isRecord(icon) || typeof icon['src'] !== 'string') {
        throw new Error(
          `Registry server.json không hợp lệ: server "${name}": icon #${i} thiếu "src".`,
        );
      }
      const src = icon['src'] as string;
      if (!src.startsWith('data:')) assertHttpUrl(src, 'icon src');
      const out: { src: string; mimeType?: string; sizes?: string[]; theme?: string } = { src };
      if (typeof icon['mimeType'] === 'string') out.mimeType = icon['mimeType'] as string;
      if (Array.isArray(icon['sizes'])) out.sizes = stringList(icon['sizes'], 'icon sizes');
      if (typeof icon['theme'] === 'string') out.theme = icon['theme'] as string;
      return out;
    });
  }
  if (Array.isArray(packagesRaw)) {
    entry.packages = packagesRaw.map((p, i) => validatePackage(p, name as string, i));
  }
  if (Array.isArray(remotesRaw)) {
    entry.remotes = remotesRaw.map((r, i) => validateRemote(r, name as string, i));
  }
  if (typeof raw['checksum'] === 'string') {
    if (!SHA256_HEX_RE.test((raw['checksum'] as string).trim())) {
      throw new Error(
        `Registry server.json không hợp lệ: server "${name}": "checksum" phải là SHA-256 hex (64 ký tự).`,
      );
    }
    entry.checksum = (raw['checksum'] as string).trim().toLowerCase();
  }
  return entry;
}

/**
 * Parse nội dung text của một file `server.json`: chấp nhận cả hai dạng
 * — một server đơn lẻ (`{ name, ... }`) và một registry
 * (`{ servers: [...] }`). Validate từng entry; tên server trùng nhau
 * thì throw. Nội dung file không bao giờ được echo vào lỗi.
 */
export function parseRegistryFile(text: string): RegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Registry server.json không hợp lệ: không phải JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('Registry server.json không hợp lệ: top level phải là object.');
  }
  let rawServers: unknown[];
  let version: string | undefined;
  let schema: string | undefined;
  if (Array.isArray(parsed['servers'])) {
    rawServers = parsed['servers'] as unknown[];
    if (typeof parsed['version'] === 'string') version = parsed['version'] as string;
    if (typeof parsed['$schema'] === 'string') schema = parsed['$schema'] as string;
  } else if (typeof parsed['name'] === 'string') {
    // Một server đơn lẻ — coi như registry một entry.
    rawServers = [parsed];
  } else {
    throw new Error(
      'Registry server.json không hợp lệ: top level phải có "servers" (mảng) hoặc là một server đơn lẻ có "name".',
    );
  }
  if (rawServers.length === 0) {
    throw new Error('Registry server.json không hợp lệ: "servers" rỗng.');
  }
  const seen = new Set<string>();
  const servers = rawServers.map((raw, i) => {
    const entry = validateRegistryEntry(raw, i);
    if (seen.has(entry.name)) {
      throw new Error(`Registry server.json không hợp lệ: trùng tên server "${entry.name}".`);
    }
    seen.add(entry.name);
    return entry;
  });
  const registry: RegistryFile = { servers };
  if (version) registry.version = version;
  if (schema) registry.$schema = schema;
  return registry;
}

/** Parse một file `server.json` đơn lẻ thành một entry (dạng 1 server). */
export function parseServerJson(text: string): RegistryServerEntry {
  const registry = parseRegistryFile(text);
  if (registry.servers.length !== 1) {
    throw new Error(
      `Registry server.json: file này chứa ${registry.servers.length} server, ` +
        'không phải đúng một server — dùng parseRegistryFile() thay vì parseServerJson().',
    );
  }
  return registry.servers[0] as RegistryServerEntry;
}

/** Đọc và parse một file `server.json` trên đĩa (đồng bộ). */
export function loadRegistryFile(filePath: string): RegistryFile {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được file registry: ${(err as Error).message}`);
  }
  return parseRegistryFile(text);
}

/** Tìm một server trong registry theo tên, hoặc `undefined`. */
export function findRegistryServer(
  registry: RegistryFile,
  name: string,
): RegistryServerEntry | undefined {
  return registry.servers.find((s) => s.name === name);
}

/**
 * Chuyển một registry entry thành config MCP của open-bot
 * (`McpServerConfig`): ưu tiên remote streamable-http, nếu không thì
 * package stdio đầu tiên (npm → `npx -y <identifier>`, pypi → `uvx`).
 * Tên trong `mcp.json` là phần cuối của tên registry (sau `/` cuối).
 * Không bao giờ ghi secret/env vào config — user tự điền sau khi cài.
 */
export function registryEntryToMcpConfig(entry: RegistryServerEntry): McpServerConfig {
  const shortName = entry.name.split('/').pop() as string;
  const config: McpServerConfig = { name: shortName };
  const remote = entry.remotes?.find((r) => r.transportType === 'streamable-http')
    ?? entry.remotes?.[0];
  if (remote) {
    config.url = remote.url;
    return config;
  }
  const pkg = entry.packages?.find((p) => p.transport.type === 'stdio') ?? entry.packages?.[0];
  if (!pkg) {
    throw new Error(
      `Registry server "${entry.name}": không có remote hay package stdio nào để chạy.`,
    );
  }
  if (pkg.transport.type === 'stdio') {
    const command = pkg.transport.command
      ?? (pkg.registryType === 'pypi' ? 'uvx' : 'npx');
    const args: string[] = [...(pkg.transport.args ?? [])];
    if (args.length === 0) {
      if (pkg.registryType === 'npm') args.push('-y', pkg.identifier);
      else if (pkg.registryType === 'pypi') args.push(pkg.identifier);
      else args.push(pkg.identifier);
    }
    config.command = command;
    config.args = args;
    return config;
  }
  throw new Error(
    `Registry server "${entry.name}": package transport "${pkg.transport.type}" chưa hỗ trợ chuyển sang config local.`,
  );
}

// ---------------------------------------------------------------------------
// Remote registry: tải + cache local có TTL + kiểm tra checksum
// ---------------------------------------------------------------------------

export interface RemoteRegistryOptions {
  url: string;
  fetchFn?: RegistryFetchFn;
  /** Thư mục cache. Khi vắng thì không cache (chỉ tải + validate). */
  cacheDir?: string;
  /** TTL của cache (mặc định 1 giờ). 0 = không dùng cache đọc. */
  ttlMs?: number;
  /**
   * Checksum SHA-256 (hex) kỳ vọng của nội dung registry. Khi có, nội
   * dung tải về / trong cache SAI checksum sẽ bị từ chối, không dùng.
   */
  expectedSha256?: string;
  timeoutMs?: number;
}

export interface RemoteRegistryResult {
  registry: RegistryFile;
  /** True khi kết quả lấy từ cache local (không gọi mạng). */
  fromCache: boolean;
  /** SHA-256 hex của nội dung đã dùng. */
  sha256: string;
  fetchedAt: number;
}

interface RegistryCacheEntry {
  url: string;
  fetchedAt: number;
  sha256: string;
  body: string;
}

export function getRegistryCachePath(cacheDir: string, url: string): string {
  const hash = sha256Hex(url);
  return path.join(cacheDir, `${REGISTRY_CACHE_FILE_PREFIX}${hash}.json`);
}

function readRegistryCache(cachePath: string): RegistryCacheEntry | null {
  let text: string;
  try {
    text = fs.readFileSync(cachePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed['url'] !== 'string' ||
      typeof parsed['fetchedAt'] !== 'number' ||
      typeof parsed['sha256'] !== 'string' ||
      typeof parsed['body'] !== 'string'
    ) {
      return null;
    }
    return parsed as unknown as RegistryCacheEntry;
  } catch {
    return null;
  }
}

function writeRegistryCache(cachePath: string, entry: RegistryCacheEntry): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, cachePath);
}

/**
 * Tải registry từ URL remote, có cache local:
 * 1. Cache còn hạn (tuổi < ttlMs) và checksum khớp (khi có
 *    `expectedSha256`) → trả về từ cache, không gọi mạng.
 * 2. Nếu không, GET từ URL; response phải 2xx, nội dung phải parse +
 *    validate được; checksum (khi có) phải khớp — sai thì throw và
 *    KHÔNG ghi cache, KHÔNG dùng nội dung đó.
 * 3. Ghi cache (khi có `cacheDir`) rồi trả về.
 * Cache hỏng (không parse được / thiếu field / sai checksum) thì bỏ
 * qua và tải lại từ mạng thay vì crash.
 */
export async function fetchRemoteRegistry(
  options: RemoteRegistryOptions,
): Promise<RemoteRegistryResult> {
  const url = assertHttpUrl(options.url, 'registry URL');
  const ttlMs = options.ttlMs ?? DEFAULT_REGISTRY_CACHE_TTL_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const cachePath = options.cacheDir ? getRegistryCachePath(options.cacheDir, url) : null;

  if (cachePath && ttlMs > 0) {
    const cached = readRegistryCache(cachePath);
    if (cached && cached.url === url && Date.now() - cached.fetchedAt < ttlMs) {
      const checksumOk =
        !options.expectedSha256 || verifyChecksum(cached.body, options.expectedSha256);
      const storedChecksumOk = cached.sha256 === sha256Hex(cached.body);
      if (checksumOk && storedChecksumOk) {
        try {
          const registry = parseRegistryFile(cached.body);
          return {
            registry,
            fromCache: true,
            sha256: cached.sha256,
            fetchedAt: cached.fetchedAt,
          };
        } catch {
          // Cache parse không được: bỏ qua, tải lại từ mạng.
        }
      }
      // Cache sai checksum / hỏng: bỏ qua, tải lại từ mạng.
    }
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Không tải được registry từ ${url}: hết thời gian sau ${timeoutMs}ms.`);
    }
    throw new Error(`Không tải được registry từ ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Không tải được registry từ ${url}: HTTP ${res.status}.`);
  }
  const body = await res.text();
  const sha256 = sha256Hex(body);
  if (options.expectedSha256 && !verifyChecksum(body, options.expectedSha256)) {
    throw new Error(
      'Registry tải về sai checksum SHA-256 so với kỳ vọng — từ chối dùng nội dung này ' +
        '(có thể đã bị sửa đổi trên đường truyền).',
    );
  }
  // Parse + validate TRƯỚC khi ghi cache: không cache nội dung hỏng.
  const registry = parseRegistryFile(body);
  const fetchedAt = Date.now();
  if (cachePath) {
    try {
      writeRegistryCache(cachePath, { url, fetchedAt, sha256, body });
    } catch {
      // Ghi cache thất bại không làm hỏng kết quả tải về.
    }
  }
  return { registry, fromCache: false, sha256, fetchedAt };
}

/** Xóa cache của một registry URL (trả về true khi có file để xóa). */
export function clearRegistryCache(cacheDir: string, url: string): boolean {
  const cachePath = getRegistryCachePath(cacheDir, url);
  try {
    fs.unlinkSync(cachePath);
    return true;
  } catch {
    return false;
  }
}
