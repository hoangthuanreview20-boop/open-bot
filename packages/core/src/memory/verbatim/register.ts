/**
 * Wiring helper cho verbatim memory (v1.01, Đội T4).
 *
 * Hai việc host (desktop main / CLI / coordinator) thường phải làm tay:
 *  1. Mở store cho một workspace: `openVerbatimStoreForWorkspace(dir)`
 *     — backend SQLite trong `<dir>/.open-bot/verbatim`, fallback JSONL.
 *  2. Đăng ký autosave hook vào `HookRegistry`:
 *     `registerVerbatimAutosave(registry, store, opts)`.
 *
 * Tách ra file riêng để host chỉ cần 2 dòng, không phải nhớ đường dẫn
 * file DB hay tên hook. Không tự chạy gì khi import — host gọi tường
 * minh.
 */
import * as path from 'node:path';
import type { HookRegistry } from '../../hooks/registry';
import type { VerbatimEmbedder } from './types';
import { openVerbatimBackend, type VerbatimBackendKind } from './backends/index';
import { createVerbatimAutosaveHook, type VerbatimAutosaveOptions } from './autosave';
import { VerbatimMemoryStore } from './store';

/** Thư mục con chứa verbatim DB trong workspace (song song `.open-bot/memories.json`). */
export const VERBATIM_WORKSPACE_REL_DIR = path.join('.open-bot', 'verbatim');

export interface OpenVerbatimStoreForWorkspaceOptions {
  /** Embedder mặc định (vd OllamaEmbeddings) — vắng = BM25 thuần. */
  embedder?: VerbatimEmbedder;
  /** Tên model embedding (mặc định 'nomic-embed-text'). */
  embeddingModel?: string;
  /** Ép backend ('sqlite' mặc định, 'jsonl' khi cần file thuần). */
  backend?: VerbatimBackendKind;
  /** Giới hạn số record (mặc định 50.000). */
  maxRecords?: number;
  /** Embed ngay khi save (mặc định false). */
  embedOnSave?: boolean;
}

export interface OpenVerbatimStoreForWorkspaceResult {
  store: VerbatimMemoryStore;
  /** Backend thực tế đang chạy (có thể là jsonl khi SQLite fallback). */
  backendKind: VerbatimBackendKind;
  /** Lý do fallback (vắng khi dùng đúng backend yêu cầu). */
  fallbackReason?: string;
  /** Thư mục dữ liệu verbatim. */
  dir: string;
}

/**
 * Mở verbatim store cho một workspace. Thư mục dữ liệu:
 * `<workspaceDir>/.open-bot/verbatim` (file `verbatim.db` hoặc
 * `verbatim.jsonl` bên trong). Tạo thư mục nếu chưa có.
 */
export function openVerbatimStoreForWorkspace(
  workspaceDir: string,
  opts: OpenVerbatimStoreForWorkspaceOptions = {},
): OpenVerbatimStoreForWorkspaceResult {
  const dir = path.join(path.resolve(workspaceDir), VERBATIM_WORKSPACE_REL_DIR);
  const opened = openVerbatimBackend({ dir, backend: opts.backend });
  const store = new VerbatimMemoryStore({
    backend: opened.backend,
    embedder: opts.embedder,
    embeddingModel: opts.embeddingModel ?? 'nomic-embed-text',
    maxRecords: opts.maxRecords,
    embedOnSave: opts.embedOnSave,
  });
  return {
    store,
    backendKind: opened.kind,
    fallbackReason: opened.fallbackReason,
    dir,
  };
}

export interface RegisterVerbatimAutosaveOptions extends VerbatimAutosaveOptions {
  /**
   * Ghi đè hook cùng tên nếu đã đăng ký (mặc định false — đăng ký lần
   * 2 với cùng store sẽ throw để host biết mình đăng ký trùng).
   */
  replaceExisting?: boolean;
}

/**
 * Đăng ký autosave hook vào registry. Hook mặc định TẮT (opt-in):
 * chỉ chạy khi `opts.enabled === true` HOẶC khi user bật trong
 * settings (registry `applySettings` với tên `verbatim-autosave`).
 * Trả về tên hook đã đăng ký.
 */
export function registerVerbatimAutosave(
  registry: HookRegistry,
  store: VerbatimMemoryStore,
  opts: RegisterVerbatimAutosaveOptions = {},
): string {
  const hook = createVerbatimAutosaveHook(store, opts);
  const existing = registry.get(hook.name);
  if (existing !== undefined && opts.replaceExisting !== true) {
    throw new Error(
      `Hook "${hook.name}" đã đăng ký — truyền replaceExisting: true để ghi đè.`,
    );
  }
  registry.register(hook);
  return hook.name;
}
