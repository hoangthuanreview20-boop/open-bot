/**
 * Renderer persisted stores có version (P1-10, §9).
 *
 * Tự chứa trong renderer (không import `@open-bot/core` — renderer giữ
 * độc lập với workspace package resolution, như `types.ts` đã nêu; và
 * core dist là CommonJS nên Vite không bundle được named export từ đó).
 * Đây là bản mirror phía renderer của `packages/core/src/client/
 * persistedStore.ts` (logic thuần túy đã có test ở đó): CÙNG envelope
 * `{schemaVersion, scope, accountSensitive, value}`, CÙNG hành vi fail
 * soft + telemetry `client_persistence`. Đổi contract ở một bên thì đổi
 * cả bên kia.
 *
 * Mọi store ở đây đều có `schemaVersion` + `scope` + `accountSensitive`
 * (để biết store nào phải xoá khi đổi tài khoản / bật NO_STORAGE), draft
 * key bằng UUID, và lỗi persistence được báo telemetry
 * `client_persistence` về main qua IPC `telemetry:client-persistence`
 * (main chỉ log, không gửi đi đâu).
 *
 * Store đã đăng ký:
 *  - `composer-drafts` (v1, client-persisted, accountSensitive): bản
 *    nháp ô chat của từng bot, key bằng UUID (DraftStore).
 *  - `ui-layout` (v1, client-persisted, KHÔNG accountSensitive): bố cục
 *    UI chung (vd sidebar thu gọn) — đổi tài khoản vẫn giữ.
 */

export type PersistedStoreScope = 'client-persisted' | 'session-only';

export interface ClientPersistenceReport {
  kind: 'client_persistence';
  storeKey: string;
  operation: 'load' | 'save' | 'clear' | 'migrate';
  error: string;
  at: string;
}

export interface PersistedStoreDef<T> {
  key: string;
  schemaVersion: number;
  scope: PersistedStoreScope;
  accountSensitive: boolean;
  defaultValue: T;
  migrate?: (storedValue: unknown, fromVersion: number) => T;
}

interface StoreEnvelope {
  schemaVersion: number;
  scope: PersistedStoreScope;
  accountSensitive: boolean;
  value: unknown;
}

function isEnvelope(value: unknown): value is StoreEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['schemaVersion'] === 'number' &&
    (v['scope'] === 'client-persisted' || v['scope'] === 'session-only') &&
    typeof v['accountSensitive'] === 'boolean' &&
    'value' in v
  );
}

/** Gửi report `client_persistence` về main (guard: preload cũ thì chỉ log). */
function reportTelemetry(report: ClientPersistenceReport): void {
  try {
    const api = window.openBot as unknown as {
      reportClientPersistence?: (r: ClientPersistenceReport) => void;
    };
    if (typeof api.reportClientPersistence === 'function') {
      api.reportClientPersistence(report);
      return;
    }
  } catch {
    // Bỏ qua — telemetry không được làm hỏng UI.
  }
  console.warn(`[open-bot] client_persistence ${report.storeKey} ${report.operation}: ${report.error}`);
}

/** Draft id mới — LUÔN bằng UUID (Grok §9: "draft id keys the persisted draft"). */
export function createDraftId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class PersistedStore<T> {
  readonly key: string;
  readonly schemaVersion: number;
  readonly scope: PersistedStoreScope;
  readonly accountSensitive: boolean;
  private readonly def: PersistedStoreDef<T>;

  constructor(def: PersistedStoreDef<T>) {
    if (!def.key) throw new Error('PersistedStore cần key không rỗng.');
    if (!Number.isInteger(def.schemaVersion) || def.schemaVersion < 1) {
      throw new Error(`PersistedStore "${def.key}": schemaVersion phải là số nguyên >= 1.`);
    }
    this.def = def;
    this.key = def.key;
    this.schemaVersion = def.schemaVersion;
    this.scope = def.scope;
    this.accountSensitive = def.accountSensitive;
  }

  /** Đọc giá trị đã lưu; lỗi/hỏng/sai version → defaultValue + report. */
  load(): T {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(this.key);
    } catch (err) {
      this.reportError('load', err);
      return this.cloneDefault();
    }
    if (raw === null) return this.cloneDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.reportError('load', err);
      return this.cloneDefault();
    }
    if (!isEnvelope(parsed)) {
      if (this.def.migrate) {
        try {
          return this.def.migrate(parsed, 0);
        } catch (err) {
          this.reportError('migrate', err);
          return this.cloneDefault();
        }
      }
      this.reportError('load', new Error(`Store "${this.key}": dữ liệu lưu không có envelope version.`));
      return this.cloneDefault();
    }
    if (parsed.schemaVersion !== this.schemaVersion) {
      if (this.def.migrate) {
        try {
          return this.def.migrate(parsed.value, parsed.schemaVersion);
        } catch (err) {
          this.reportError('migrate', err);
          return this.cloneDefault();
        }
      }
      this.reportError(
        'load',
        new Error(
          `Store "${this.key}": schemaVersion lưu (${parsed.schemaVersion}) khác hiện tại (${this.schemaVersion}), không có migrate — dùng giá trị mặc định.`,
        ),
      );
      return this.cloneDefault();
    }
    return parsed.value as T;
  }

  /** Ghi giá trị (kèm envelope version). Lỗi → false + report. */
  save(value: T): boolean {
    const envelope: StoreEnvelope = {
      schemaVersion: this.schemaVersion,
      scope: this.scope,
      accountSensitive: this.accountSensitive,
      value,
    };
    try {
      window.localStorage.setItem(this.key, JSON.stringify(envelope));
      return true;
    } catch (err) {
      this.reportError('save', err);
      return false;
    }
  }

  /** Xoá store khỏi storage. Lỗi → report (không throw). */
  clear(): void {
    try {
      window.localStorage.removeItem(this.key);
    } catch (err) {
      this.reportError('clear', err);
    }
  }

  private cloneDefault(): T {
    return JSON.parse(JSON.stringify(this.def.defaultValue)) as T;
  }

  private reportError(operation: ClientPersistenceReport['operation'], err: unknown): void {
    reportTelemetry({
      kind: 'client_persistence',
      storeKey: this.key,
      operation,
      error: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    });
  }
}

/** Registry các store đã đăng ký — xoá đúng nhóm khi đổi tài khoản / bật NO_STORAGE. */
export class PersistedStoreRegistry {
  private readonly stores = new Map<string, PersistedStore<unknown>>();

  register<T>(store: PersistedStore<T>): PersistedStore<T> {
    this.stores.set(store.key, store as PersistedStore<unknown>);
    return store;
  }

  /** Xoá mọi store `accountSensitive` (đổi tài khoản). Trả về key đã xoá. */
  clearAccountSensitive(): string[] {
    const cleared: string[] = [];
    for (const store of this.stores.values()) {
      if (store.accountSensitive) {
        store.clear();
        cleared.push(store.key);
      }
    }
    return cleared;
  }

  /** Xoá mọi store `client-persisted` (bật NO_STORAGE). Trả về key đã xoá. */
  clearForNoStorage(): string[] {
    const cleared: string[] = [];
    for (const store of this.stores.values()) {
      if (store.scope === 'client-persisted') {
        store.clear();
        cleared.push(store.key);
      }
    }
    return cleared;
  }

  keys(): string[] {
    return [...this.stores.keys()];
  }
}

export interface DraftEntry<T> {
  id: string;
  value: T;
  updatedAt: string;
}

/**
 * Draft store: các bản nháp key bằng UUID (Grok §9). Một draft là một
 * entry `{id, value, updatedAt}` trong MỘT persisted store (không phải
 * một key storage riêng cho mỗi draft).
 */
export class DraftStore<T> {
  private readonly store: PersistedStore<Record<string, DraftEntry<T>>>;

  constructor(store: PersistedStore<Record<string, DraftEntry<T>>>) {
    this.store = store;
  }

  /** Tạo draft mới, key bằng UUID. Trả về id. */
  create(value: T): string {
    const id = createDraftId();
    const all = this.store.load();
    all[id] = { id, value, updatedAt: new Date().toISOString() };
    this.store.save(all);
    return id;
  }

  get(id: string): DraftEntry<T> | null {
    return this.store.load()[id] ?? null;
  }

  update(id: string, value: T): boolean {
    const all = this.store.load();
    if (!all[id]) return false;
    all[id] = { id, value, updatedAt: new Date().toISOString() };
    return this.store.save(all);
  }

  remove(id: string): boolean {
    const all = this.store.load();
    if (!all[id]) return false;
    delete all[id];
    return this.store.save(all);
  }

  list(): DraftEntry<T>[] {
    return Object.values(this.store.load()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}

/** Registry chung của renderer — host gọi clear khi đổi tài khoản / bật NO_STORAGE. */
export const rendererStoreRegistry = new PersistedStoreRegistry();

/** Bản nháp ô chat: `{botId, text}` — một draft cho mỗi bot, key UUID. */
export interface ComposerDraftValue {
  botId: string;
  text: string;
}

const composerDraftsRaw = new PersistedStore<Record<string, DraftEntry<ComposerDraftValue>>>({
  key: 'open-bot:composer-drafts',
  schemaVersion: 1,
  scope: 'client-persisted',
  accountSensitive: true,
  defaultValue: {},
});
rendererStoreRegistry.register(composerDraftsRaw);
export const composerDraftsStore = new DraftStore<ComposerDraftValue>(composerDraftsRaw);

/** Bố cục UI chung (không gắn tài khoản). */
export interface UiLayoutValue {
  sidebarCollapsed: boolean;
}

export const uiLayoutStore = rendererStoreRegistry.register(
  new PersistedStore<UiLayoutValue>({
    key: 'open-bot:ui-layout',
    schemaVersion: 1,
    scope: 'client-persisted',
    accountSensitive: false,
    defaultValue: { sidebarCollapsed: false },
  }),
);

/** Xoá các store gắn tài khoản — gọi khi đổi tài khoản. Trả về key đã xoá. */
export function clearAccountSensitiveStores(): string[] {
  return rendererStoreRegistry.clearAccountSensitive();
}

/** Xoá mọi store client-persisted — gọi khi bật NO_STORAGE. Trả về key đã xoá. */
export function clearStoresForNoStorage(): string[] {
  return rendererStoreRegistry.clearForNoStorage();
}
