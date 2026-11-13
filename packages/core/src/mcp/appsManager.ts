/**
 * AppManager — sổ đăng ký các MCP App đang mở (v0.98, sóng T6).
 *
 * Giữ trong bộ nhớ của main process (không persist: HTML của app là
 * nội dung không tin cậy từ server, không ghi ra disk). Renderer lấy
 * danh sách qua IPC `mcp-apps:list`, mở/đóng qua `mcp-apps:open` /
 * `mcp-apps:close`; main process đẩy event `mcp-apps:changed` mỗi khi
 * danh sách đổi để view refresh.
 *
 * Quy tắc:
 *  - Tối đa MAX_OPEN_APPS app cùng lúc (mặc định 10) — mở thêm thì app
 *    cũ nhất (ít dùng nhất: openedAt nhỏ nhất) tự đóng, không ném lỗi.
 *  - Mở lại đúng app đã mở (cùng server + tool + title + HTML) thì trả
 *    app cũ, không nhân đôi tab.
 *  - `list()` trả snapshot KHÔNG kèm HTML (HTML chỉ lấy qua `get()` khi
 *    render) để IPC list không chở cả trăm KB HTML mỗi lần refresh.
 */

import type { McpAppDefinition } from './apps';
import { MAX_OPEN_APPS } from './apps';

export interface OpenAppInput {
  serverName: string;
  toolName?: string;
  title: string;
  html: string;
  sourceUri?: string;
  origin: McpAppDefinition['origin'];
}

/** Snapshot nhẹ cho UI (không kèm HTML). */
export interface AppSnapshot {
  id: string;
  serverName: string;
  toolName?: string;
  title: string;
  sourceUri?: string;
  origin: McpAppDefinition['origin'];
  openedAt: number;
  /** Kích thước HTML (bytes UTF-8) — UI hiện để user thấy app nặng cỡ nào. */
  htmlBytes: number;
}

export interface AppManagerOptions {
  /** Số app mở tối đa. Mặc định MAX_OPEN_APPS. */
  maxOpenApps?: number;
  /** Sinh id (mặc định: counter + thời gian + random — test có thể chích id ổn định). */
  newId?: () => string;
}

export type AppChangeListener = (apps: AppSnapshot[]) => void;

function defaultNewId(counter: number): string {
  return `app-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class AppManager {
  private readonly maxOpenApps: number;
  private readonly newId: () => string;
  private readonly apps = new Map<string, McpAppDefinition>();
  private readonly listeners = new Set<AppChangeListener>();
  private counter = 0;

  constructor(options: AppManagerOptions = {}) {
    this.maxOpenApps = Math.max(1, options.maxOpenApps ?? MAX_OPEN_APPS);
    const factory = options.newId;
    this.newId = factory ?? (() => defaultNewId((this.counter += 1)));
  }

  /** Số app đang mở. */
  get size(): number {
    return this.apps.size;
  }

  /** Đăng ký listener gọi mỗi khi danh sách app đổi. Trả hàm huỷ đăng ký. */
  onChange(listener: AppChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Một listener lỗi không được làm chết manager.
      }
    }
  }

  /**
   * Mở một app (HTML phải qua `validateAppHtml` trước — manager không
   * validate lại, vì caller đã validate lúc parse). Trả app đã mở
   * (mở lại app trùng thì trả app cũ). Vượt giới hạn thì app cũ nhất
   * tự đóng trước.
   */
  open(input: OpenAppInput): McpAppDefinition {
    for (const existing of this.apps.values()) {
      if (
        existing.serverName === input.serverName &&
        existing.toolName === input.toolName &&
        existing.title === input.title &&
        existing.html === input.html
      ) {
        return existing;
      }
    }
    while (this.apps.size >= this.maxOpenApps) {
      let oldest: McpAppDefinition | undefined;
      for (const candidate of this.apps.values()) {
        if (!oldest || candidate.openedAt < oldest.openedAt) oldest = candidate;
      }
      if (!oldest) break;
      this.apps.delete(oldest.id);
    }
    const app: McpAppDefinition = {
      id: this.newId(),
      serverName: input.serverName,
      toolName: input.toolName,
      title: input.title.slice(0, 120),
      html: input.html,
      sourceUri: input.sourceUri,
      origin: input.origin,
      openedAt: Date.now(),
    };
    this.apps.set(app.id, app);
    this.emit();
    return app;
  }

  /** Đóng một app. Trả true khi app tồn tại. */
  close(id: string): boolean {
    const removed = this.apps.delete(id);
    if (removed) this.emit();
    return removed;
  }

  /** Đóng tất cả app. */
  closeAll(): void {
    if (this.apps.size === 0) return;
    this.apps.clear();
    this.emit();
  }

  /** Lấy app đầy đủ (kèm HTML) để render, hoặc undefined. */
  get(id: string): McpAppDefinition | undefined {
    return this.apps.get(id);
  }

  /** Danh sách snapshot nhẹ, mới mở nhất trước. */
  list(): AppSnapshot[] {
    return [...this.apps.values()]
      .sort((a, b) => b.openedAt - a.openedAt)
      .map((app) => ({
        id: app.id,
        serverName: app.serverName,
        toolName: app.toolName,
        title: app.title,
        sourceUri: app.sourceUri,
        origin: app.origin,
        openedAt: app.openedAt,
        htmlBytes: new TextEncoder().encode(app.html).length,
      }));
  }
}
