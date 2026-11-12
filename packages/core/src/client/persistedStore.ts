/**
 * Renderer persisted store có version (P1-10, §9) — logic thuần túy.
 *
 * Pattern lấy từ Grok §9: mọi store persist đều có `schemaVersion` +
 * `scope` + cờ `accountSensitive` (để biết store nào phải xoá khi đổi
 * tài khoản / bật NO_STORAGE), draft key bằng UUID, và telemetry
 * `client_persistence` khi persistence lỗi.
 *
 * Module này KHÔNG chạm DOM: storage được inject qua interface
 * `StorageLike` (test truyền bộ nhớ; host Node truyền wrapper của mình).
 * Renderer desktop KHÔNG import module này (core dist là CommonJS, Vite
 * không bundle được named export từ đó) mà dùng bản mirror tự chứa ở
 * `apps/desktop/src/renderer/store/persistedStore.ts` — cùng envelope,
 * cùng hành vi, cùng telemetry kind; đổi contract thì đổi cả hai bên.
 * Envelope lưu trữ: `{schemaVersion, scope, accountSensitive, value}`.
 *
 * Hành vi khi lỗi (fail soft, không crash app):
 *  - đọc lỗi / JSON hỏng / sai version không migrate được → trả
 *    `defaultValue` + gửi một report `client_persistence`;
 *  - ghi lỗi (vd hết quota) → trả `false` + report;
 *  - xoá lỗi → report.
 * Đổi tài khoản / bật NO_STORAGE: `PersistedStoreRegistry` xoá các
 * store `accountSensitive` (đổi tài khoản) hoặc toàn bộ store
 * `client-persisted` (NO_STORAGE) — caller quyết định thời điểm gọi.
 */


/** Nơi store sống: persist qua restart, hay chỉ trong phiên. */
export type PersistedStoreScope = 'client-persisted' | 'session-only';

/** Interface tối thiểu của storage (khớp localStorage). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Định nghĩa một persisted store (mọi field đều bắt buộc trừ `migrate`). */
export interface PersistedStoreDef<T> {
  /** Key trong storage, vd `open-bot:composer-drafts`. */
  key: string;
  /** Version schema hiện tại — tăng khi đổi hình dạng `value`. */
  schemaVersion: number;
  scope: PersistedStoreScope;
  /** True → xoá khi đổi tài khoản / bật NO_STORAGE. */
  accountSensitive: boolean;
  /** Giá trị khi chưa có gì lưu, hoặc dữ liệu lưu bị hỏng. */
  defaultValue: T;
  /**
   * Migrate dữ liệu cũ lên schema hiện tại. Không có migrate mà version
   * lưu khác version hiện tại → dùng `defaultValue` (dữ liệu cũ bỏ).
   */
  migrate?: (storedValue: unknown, fromVersion: number) => T;
}

/** Một report telemetry `client_persistence` (Grok §9: `shipReport`). */
export interface ClientPersistenceReport {
  kind: 'client_persistence';
  storeKey: string;
  operation: 'load' | 'save' | 'clear' | 'migrate';
  error: string;
  at: string;
}

export type ClientPersistenceReporter = (report: ClientPersistenceReport) => void;

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

/** Storage trong bộ nhớ (cho test + host không có DOM). */
export function createMemoryStorage(): StorageLike & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

/**
 * Draft id mới — LUÔN bằng UUID (Grok §9: "draft id keys the persisted draft").
 * Dùng `globalThis.crypto.randomUUID` (có cả ở Node 24 và trình duyệt)
 * để module này bundle được cho renderer; fallback chỉ khi không có
 * crypto (đủ duy nhất cho draft key — không phải secret).
 */
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
  private readonly storage: StorageLike;
  private readonly report?: ClientPersistenceReporter;

  constructor(def: PersistedStoreDef<T>, storage: StorageLike, report?: ClientPersistenceReporter) {
    if (!def.key) throw new Error('PersistedStore cần key không rỗng.');
    if (!Number.isInteger(def.schemaVersion) || def.schemaVersion < 1) {
      throw new Error(`PersistedStore "${def.key}": schemaVersion phải là số nguyên >= 1.`);
    }
    this.def = def;
    this.key = def.key;
    this.schemaVersion = def.schemaVersion;
    this.scope = def.scope;
    this.accountSensitive = def.accountSensitive;
    this.storage = storage;
    this.report = report;
  }

  /** Đọc giá trị đã lưu; lỗi/hỏng/sai version → defaultValue + report. */
  load(): T {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
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
      // Dữ liệu legacy (lưu trước khi có envelope): migrate nếu có, không thì bỏ.
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
      this.storage.setItem(this.key, JSON.stringify(envelope));
      return true;
    } catch (err) {
      this.reportError('save', err);
      return false;
    }
  }

  /** Xoá store khỏi storage. Lỗi → report (không throw). */
  clear(): void {
    try {
      this.storage.removeItem(this.key);
    } catch (err) {
      this.reportError('clear', err);
    }
  }

  private cloneDefault(): T {
    return JSON.parse(JSON.stringify(this.def.defaultValue)) as T;
  }

  private reportError(operation: ClientPersistenceReport['operation'], err: unknown): void {
    this.report?.({
      kind: 'client_persistence',
      storeKey: this.key,
      operation,
      error: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    });
  }
}

/**
 * Registry các store đã đăng ký — để host xoá đúng nhóm store khi đổi
 * tài khoản hoặc bật NO_STORAGE, thay vì xoá mù cả localStorage.
 */
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

/**
 * Draft store: các bản nháp key bằng UUID (Grok §9). Một draft là một
 * entry `{id, value, updatedAt}` trong MỘT persisted store (không phải
 * một key storage riêng cho mỗi draft).
 */
export interface DraftEntry<T> {
  id: string;
  value: T;
  updatedAt: string;
}

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
