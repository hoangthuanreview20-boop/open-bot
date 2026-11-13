/**
 * ToolResultCache — cache kết quả tool read-only.
 *
 * Key = tên tool + hash SHA-256 của args đã chuẩn hoá (JSON với key
 * object sắp xếp đệ quy, nên `{a:1,b:2}` và `{b:2,a:1}` trùng key).
 * Mỗi entry có TTL riêng; dung lượng giới hạn bằng số entry tối đa
 * (LRU — entry ít dùng nhất bị đuổi khi đầy).
 *
 * QUAN TRỌNG — chỉ cache tool read-only: cache này không biết tool nào
 * ghi file/shell, nên việc CHỌN tool nào được cache thuộc về người gọi
 * (ToolRegistry nhận danh sách `cacheableTools`, mặc định rỗng). Cache
 * chỉ lưu kết quả THÀNH CÔNG — tool ném lỗi thì không cache.
 */
import { createHash } from 'node:crypto';

export interface ToolResultCacheOptions {
  /** TTL mặc định cho mỗi entry (ms). Default 5 phút. */
  defaultTtlMs?: number;
  /** Số entry tối đa (LRU). Default 200. */
  maxEntries?: number;
}

export interface ToolResultCacheStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  maxEntries: number;
}

export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CACHE_MAX_ENTRIES = 200;

/**
 * Gợi ý danh sách tool read-only có thể cache — người gọi phải CHỌN
 * tường minh (truyền vào ToolRegistry), cache không tự áp dụng.
 * Tool ghi (write_file, shell_exec, git_commit, ...) KHÔNG có ở đây.
 */
export const SUGGESTED_CACHEABLE_TOOLS: readonly string[] = [
  'read_file',
  'list_files',
  'glob',
  'grep',
  'git_status',
  'git_diff',
  'web_search',
  'web_fetch',
  'http_get',
  // v0.95 (Team D1): internet data — read-only search/fetch/feed-read.
  'internet_search',
  'web_fetch_clean',
  'feed_read',
];

/** JSON.stringify với key object sắp xếp đệ quy — cùng args, cùng chuỗi. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Cache key cho một lần gọi tool: `name:sha256(stableStringify(args))`. */
export function cacheKeyFor(toolName: string, args: Record<string, unknown>): string {
  const hash = createHash('sha256').update(stableStringify(args)).digest('hex');
  return `${toolName}:${hash}`;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class ToolResultCache {
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ToolResultCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
  }

  /** Lấy kết quả đã cache; undefined khi chưa có hoặc đã hết hạn. */
  get(toolName: string, args: Record<string, unknown>): string | undefined {
    const key = cacheKeyFor(toolName, args);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // LRU: chạm vào thì đưa về cuối (mới nhất).
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /** Lưu kết quả. ttlMs <= 0 nghĩa là không cache (bỏ qua). */
  set(
    toolName: string,
    args: Record<string, unknown>,
    value: string,
    ttlMs?: number,
  ): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (ttl <= 0) return;
    const key = cacheKeyFor(toolName, args);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttl });
    while (this.entries.size > this.maxEntries) {
      // Map giữ thứ tự chèn: key đầu tiên = ít dùng nhất.
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  /** True khi còn entry hợp lệ (không hết hạn). Không tính vào hit/miss. */
  has(toolName: string, args: Record<string, unknown>): boolean {
    const entry = this.entries.get(cacheKeyFor(toolName, args));
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(cacheKeyFor(toolName, args));
      return false;
    }
    return true;
  }

  /**
   * Xoá cache: `invalidate(name)` xoá mọi entry của tool đó;
   * `invalidate(name, args)` chỉ xoá đúng một lần gọi.
   */
  invalidate(toolName: string, args?: Record<string, unknown>): void {
    if (args === undefined) {
      const prefix = `${toolName}:`;
      for (const key of [...this.entries.keys()]) {
        if (key.startsWith(prefix)) this.entries.delete(key);
      }
      return;
    }
    this.entries.delete(cacheKeyFor(toolName, args));
  }

  /** Xoá toàn bộ cache (kèm reset bộ đếm hit/miss). */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /** Số entry hiện tại. */
  size(): number {
    return this.entries.size;
  }

  stats(): ToolResultCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      maxEntries: this.maxEntries,
    };
  }
}
