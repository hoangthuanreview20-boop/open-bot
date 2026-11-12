/**
 * PluginManager for @open-bot/tools (v0.3, wave 1).
 *
 * Owns a plugins directory (`<pluginsDir>/<plugin-id>/manifest.json` +
 * entry file, one folder per plugin — the install layout borrowed from
 * Claude Code marketplaces, where a plugin is a folder that gets copied
 * into place). Responsibilities:
 *
 * - `scanDir()`: discover every folder with a `manifest.json`, load it,
 *   remember per-plugin failures instead of crashing on one bad plugin.
 * - `load()` / `unload()`: load or drop one plugin (and its tools).
 * - `enable()` / `disable()`: flip a plugin on/off, persisted in
 *   `<pluginsDir>/enabled.json` (`{ "enabled": { "<id>": true|false } }`; a plugin
 *   absent from that file defaults to ENABLED, like a freshly installed
 *   VS Code extension). Disabled plugins stay loaded in memory but
 *   contribute no tools until re-enabled.
 * - `installFromDir()` / `uninstall()`: copy a validated plugin folder in
 *   / delete a plugin folder out.
 * - `toolsForRegistry()`: the tools of loaded + enabled plugins only —
 *   the single choke point the coordinator uses to feed a ToolRegistry.
 *
 * Plugins run IN-PROCESS (see types.ts): `unload()` only drops the
 * plugin's tools from the manager; it cannot unload the required module
 * from Node's module system in a way that guarantees the code is gone.
 * That is acceptable for v0.3 — unload means "no longer callable", not
 * "code evicted from memory".
 *
 * v0.14: plugins CAN run out-of-process via `loadSandboxed()` /
 * `scanDirSandboxed()` — each plugin gets its own `SandboxedPluginHost`
 * (fork + IPC JSON); a hanging/crashing plugin cannot take down the
 * coordinator. Sandboxed tools are stored in the same `loaded` map, so
 * `toolsForRegistry()` / enable / disable work identically; use
 * `disposeSandboxed()` to kill the child processes.
 *
 * v0.14: `scanDir()` also discovers plugin BUNDLES — folders with
 * `plugin.json` / `bundle.json` and no `manifest.json` (see
 * plugins/bundle.ts). A bundle's `main` tools load like a normal plugin;
 * its other parts (skill / subagent / MCP server / slash commands) are
 * collected in `listBundleParts()` for the coordinator to wire — the
 * manager does NOT register skills, hooks or MCP servers itself. Bundle
 * hook scripts are NOT executed (no safe script runner yet): they are
 * skipped with a stderr warning.
 *
 *
 * This file deliberately does NOT import `ToolRegistry` as a value (only
 * as a type, for `registerPluginTools`): the registry stays untouched
 * (the coordinator wires the two together), and `toolsFromPlugins()` is
 * the dependency-free helper for that wiring.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import type { ToolRegistry } from '../registry';
import { validateToolDefinition } from '../registry';
import { loadPlugin, loadPluginFromManifest, readManifest, truncatePluginOutput } from './loader';
import type { LoadedPlugin } from './loader';
import { loadBundle, type ResolvedPluginBundleParts } from './bundle';
import {
  createSandboxedPluginHost,
  type SandboxedPluginHost,
  type SandboxedPluginHostOptions,
} from './sandbox';
import type { PluginInfo, PluginManifest } from './types';
import { PluginLoadError } from './types';

const ENABLED_FILE = 'enabled.json';

/** True khi thư mục có manifest của bundle (`plugin.json`/`bundle.json`). */
function hasBundleManifest(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'plugin.json')) ||
    fs.existsSync(path.join(dir, 'bundle.json'))
  );
}

export interface PluginLoadFailure {
  dir: string;
  error: PluginLoadError | Error;
}

export class PluginManager {
  readonly pluginsDir: string;
  private readonly loaded = new Map<string, LoadedPlugin>();
  private enabledIds = new Set<string>();
  private enabledKnown = new Set<string>();
  private failures: PluginLoadFailure[] = [];
  /** Sandbox hosts theo plugin id (v0.14) — dispose khi unload. */
  private readonly sandboxHosts = new Map<string, SandboxedPluginHost>();
  /** Bundle parts đã resolve (v0.14) — coordinator nối skill/slash/MCP. */
  private bundleParts: ResolvedPluginBundleParts[] = [];

  constructor(pluginsDir: string) {
    this.pluginsDir = path.resolve(pluginsDir);
  }

  // ---------------------------------------------------------------- enabled
  private enabledFilePath(): string {
    return path.join(this.pluginsDir, ENABLED_FILE);
  }

  /** Read enabled.json (tolerant: missing / corrupt file = all default on).
   *  Format: `{ "enabled": { "<id>": true|false, … } }` — a full map, so a
   *  disabled plugin stays disabled after a restart (a bare enabled-list
   *  could not tell "never seen" from "disabled"). A legacy bare array
   *  (`{ "enabled": ["id", …] }`) is still accepted as "these are on". */
  private readEnabledFile(): void {
    this.enabledKnown = new Set<string>();
    this.enabledIds = new Set<string>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.enabledFilePath(), 'utf8')) as unknown;
      const enabled = (raw as Record<string, unknown> | null)?.['enabled'];
      if (Array.isArray(enabled)) {
        for (const id of enabled) {
          if (typeof id === 'string') {
            this.enabledKnown.add(id);
            this.enabledIds.add(id);
          }
        }
      } else if (enabled && typeof enabled === 'object') {
        for (const [id, on] of Object.entries(enabled as Record<string, unknown>)) {
          this.enabledKnown.add(id);
          if (on === true) this.enabledIds.add(id);
        }
      }
    } catch {
      // Missing or unreadable: every discovered plugin defaults to enabled.
    }
  }

  private writeEnabledFile(): void {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    const payload: { enabled: Record<string, boolean> } = { enabled: {} };
    for (const id of [...this.enabledKnown].sort()) {
      payload.enabled[id] = this.enabledIds.has(id);
    }
    const tmp = this.enabledFilePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.enabledFilePath());
  }

  /** True when the plugin is enabled (unknown ids default to enabled). */
  isEnabled(id: string): boolean {
    return !this.enabledKnown.has(id) || this.enabledIds.has(id);
  }

  // ------------------------------------------------------------------ load
  /** Plugins that failed to load on the last `scanDir()` (or `load()`). */
  loadErrors(): PluginLoadFailure[] {
    return [...this.failures];
  }

  private toInfo(loaded: LoadedPlugin): PluginInfo {
    return {
      manifest: loaded.manifest,
      dir: loaded.dir,
      enabled: this.isEnabled(loaded.manifest.id),
      loadedTools: loaded.tools.map((t) => t.definition.name),
    };
  }

  /**
   * Load one plugin from a directory (or, when given a bare id, from
   * `<pluginsDir>/<id>`). Returns its PluginInfo. Throws PluginLoadError
   * on any problem; a failed load leaves no trace in the manager.
   * v0.14: a folder with `plugin.json`/`bundle.json` and no
   * `manifest.json` loads as a bundle (see `loadBundleDir`).
   */
  load(dirOrId: string): PluginInfo {
    const dir = path.isAbsolute(dirOrId) || dirOrId.includes(path.sep)
      ? path.resolve(dirOrId)
      : path.join(this.pluginsDir, dirOrId);
    if (!fs.existsSync(path.join(dir, 'manifest.json')) && hasBundleManifest(dir)) {
      const { info } = this.loadBundleDir(dir);
      if (info) return info;
      throw new PluginLoadError(
        `Bundle "${dir}" không có entry "main" — không có tool để tải.`,
        { dir },
      );
    }
    return this.rememberLoaded(loadPlugin(dir));
  }

  /** Ghi một plugin đã tải vào map + mặc định enabled khi gặp lần đầu. */
  private rememberLoaded(loaded: LoadedPlugin): PluginInfo {
    this.loaded.set(loaded.manifest.id, loaded);
    if (!this.enabledKnown.has(loaded.manifest.id)) {
      // First sight of this plugin: enabled by default; persist so the
      // choice is explicit from now on.
      this.enabledKnown.add(loaded.manifest.id);
      this.enabledIds.add(loaded.manifest.id);
      this.writeEnabledFile();
    }
    return this.toInfo(loaded);
  }

  /**
   * Load a plugin BUNDLE from a directory (v0.14): validate + resolve
   * mọi thành phần (skill / subagent / hook / MCP server / slash command),
   * tải tool từ `main` như plugin thường (nếu có). Các thành phần ngoài
   * tool được giữ trong `listBundleParts()` để coordinator nối tiếp.
   * Hook script KHÔNG được thực thi ở đây — coordinator nối tiếp qua
   * `registerScriptHook` khi tạo bot (xem `wireBundleParts`); chỉ ghi chú.
   */
  loadBundleDir(dir: string): { info: PluginInfo | null; parts: ResolvedPluginBundleParts } {
    const absDir = path.resolve(dir);
    const parts = loadBundle(absDir);
    this.rememberBundleParts(parts);
    if (parts.hooks.length > 0) {
      process.stderr.write(
        `[plugins] Bundle "${parts.manifest.id}" có ${parts.hooks.length} hook script — ` +
          `coordinator sẽ nối qua registerScriptHook khi tạo bot.\n`,
      );
    }
    if (!parts.manifest.main) return { info: null, parts };
    const manifestFile = fs.existsSync(path.join(absDir, 'plugin.json'))
      ? 'plugin.json'
      : 'bundle.json';
    // Spread để `main` thành `string` (đã guard ở trên) cho PluginManifest.
    const manifest: PluginManifest = { ...parts.manifest, main: parts.manifest.main };
    const loaded = loadPluginFromManifest(manifest, absDir, manifestFile);
    return { info: this.rememberLoaded(loaded), parts };
  }

  /** Bundle parts đã resolve (skill/slash/MCP/...) — coordinator nối tiếp. */
  listBundleParts(): ResolvedPluginBundleParts[] {
    return [...this.bundleParts];
  }

  private rememberBundleParts(parts: ResolvedPluginBundleParts): void {
    this.bundleParts = this.bundleParts.filter((p) => p.manifest.id !== parts.manifest.id);
    this.bundleParts.push(parts);
  }

  /**
   * Load one plugin OUT-OF-PROCESS (v0.14): fork một `SandboxedPluginHost`
   * cho thư mục plugin; tool chạy trong process con, coordinator chỉ gọi
   * qua IPC. Tool definitions lấy từ worker (`listToolDefinitions`) nên
   * registry không cần load plugin in-process. Bundle (không có `main`)
   * thì throw — không có tool để chạy sandboxed.
   */
  async loadSandboxed(
    dirOrId: string,
    opts: Omit<SandboxedPluginHostOptions, 'pluginDir' | 'manifest'> = {},
  ): Promise<PluginInfo> {
    const dir = path.isAbsolute(dirOrId) || dirOrId.includes(path.sep)
      ? path.resolve(dirOrId)
      : path.join(this.pluginsDir, dirOrId);
    let manifest: PluginManifest;
    if (fs.existsSync(path.join(dir, 'manifest.json'))) {
      manifest = readManifest(dir);
    } else if (hasBundleManifest(dir)) {
      const parts = loadBundle(dir);
      this.rememberBundleParts(parts);
      if (!parts.manifest.main) {
        throw new Error(
          `Bundle "${parts.manifest.id}" không có entry "main" — không có tool để chạy sandboxed.`,
        );
      }
      manifest = { ...parts.manifest, main: parts.manifest.main };
    } else {
      throw new PluginLoadError(
        `Không tìm thấy manifest.json hay plugin.json/bundle.json trong "${dir}".`,
        { dir },
      );
    }
    // Host đang chạy thì tái dùng (không fork lại): rescan rẻ, code plugin
    // sandboxed chỉ tải lại khi coordinator khởi động lại.
    const existingHost = this.sandboxHosts.get(manifest.id);
    if (existingHost && existingHost.getStatus().status === 'running') {
      const existingLoaded = this.loaded.get(manifest.id);
      if (existingLoaded) return this.toInfo(existingLoaded);
    }
    await this.disposeSandboxed(manifest.id);
    const host = createSandboxedPluginHost({ ...opts, pluginDir: dir, manifest });
    try {
      const infos = await host.listToolDefinitions();
      const tools: Tool[] = [];
      for (const info of infos) {
        validateToolDefinition(info.definition);
        tools.push({
          definition: info.definition,
          needsApproval: info.needsApproval,
          execute: async (args) => truncatePluginOutput(await host.callTool(info.definition.name, args)),
        });
      }
      this.sandboxHosts.set(manifest.id, host);
      return this.rememberLoaded({ manifest, dir, tools });
    } catch (err) {
      await host.dispose().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Discover + load every plugin folder sandboxed (v0.14) — bản async của
   * `scanDir()`. Một plugin hỏng được ghi vào `loadErrors()` thay vì làm
   * sập cả lần quét; thư mục không có manifest nào thì bỏ qua như scanDir.
   *
   * v0.93a: `opts.excludeIds` bỏ qua các thư mục plugin có tên trong
   * danh sách (khớp theo tên thư mục == id plugin) — coordinator dùng
   * nó để plugin marketplace KHÔNG bị load ở lần quét chung, mà chỉ
   * load sau khi verify chữ ký ở `loadMarketplacePluginsAtStartup`.
   */
  async scanDirSandboxed(
    pluginsDir: string = this.pluginsDir,
    opts: { excludeIds?: string[] } = {},
  ): Promise<PluginInfo[]> {
    this.readEnabledFile();
    this.failures = [];
    this.bundleParts = [];
    const dir = path.resolve(pluginsDir);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const excluded = new Set(opts.excludeIds ?? []);
    const infos: PluginInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (excluded.has(entry.name)) continue;
      const pluginDir = path.join(dir, entry.name);
      if (
        !fs.existsSync(path.join(pluginDir, 'manifest.json')) &&
        !hasBundleManifest(pluginDir)
      ) {
        continue;
      }
      try {
        infos.push(await this.loadSandboxed(pluginDir));
      } catch (err) {
        this.failures.push({
          dir: pluginDir,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
    return infos;
  }

  /** Kill (các) sandbox host: một plugin, hoặc tất cả khi không truyền id. */
  async disposeSandboxed(id?: string): Promise<void> {
    if (id !== undefined) {
      const host = this.sandboxHosts.get(id);
      if (host) {
        this.sandboxHosts.delete(id);
        await host.dispose();
      }
      return;
    }
    const hosts = [...this.sandboxHosts.values()];
    this.sandboxHosts.clear();
    await Promise.all(hosts.map((h) => h.dispose().catch(() => undefined)));
  }

  /** Trạng thái sandbox của một plugin (undefined = không chạy sandboxed). */
  getSandboxedStatus(id: string): ReturnType<SandboxedPluginHost['getStatus']> | undefined {
    return this.sandboxHosts.get(id)?.getStatus();
  }

  /**
   * Discover + load every plugin folder under `pluginsDir`
   * (default: this manager's directory). A folder without `manifest.json`
   * is ignored; a folder whose plugin fails to load is skipped and
   * recorded in `loadErrors()` — one bad plugin never blocks the rest.
   * v0.14: a folder with `plugin.json`/`bundle.json` and no
   * `manifest.json` loads as a bundle (see `loadBundleDir`).
   * Returns the PluginInfo of every successfully loaded plugin.
   */
  scanDir(
    pluginsDir: string = this.pluginsDir,
    opts: { excludeIds?: string[] } = {},
  ): PluginInfo[] {
    this.readEnabledFile();
    this.failures = [];
    this.bundleParts = [];
    const dir = path.resolve(pluginsDir);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const excluded = new Set(opts.excludeIds ?? []);
    const infos: PluginInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // v0.93a: như scanDirSandboxed — bỏ qua plugin marketplace để
      // coordinator verify chữ ký trước khi load (xem comment ở đó).
      if (excluded.has(entry.name)) continue;
      const pluginDir = path.join(dir, entry.name);
      try {
        if (fs.existsSync(path.join(pluginDir, 'manifest.json'))) {
          const loaded = loadPlugin(pluginDir);
          this.loaded.set(loaded.manifest.id, loaded);
          infos.push(this.toInfo(loaded));
        } else if (hasBundleManifest(pluginDir)) {
          const { info } = this.loadBundleDir(pluginDir);
          if (info) infos.push(info);
        }
      } catch (err) {
        this.failures.push({
          dir: pluginDir,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
    // Persist defaults for newly discovered plugins.
    let changed = false;
    for (const info of infos) {
      if (!this.enabledKnown.has(info.manifest.id)) {
        this.enabledKnown.add(info.manifest.id);
        this.enabledIds.add(info.manifest.id);
        changed = true;
      }
    }
    if (changed) this.writeEnabledFile();
    return infos;
  }

  /** Drop a plugin's tools from the manager (code stays in Node's module cache; see header). Returns true when it was loaded. v0.14: also disposes its sandbox host (if any). */
  unload(id: string): boolean {
    const host = this.sandboxHosts.get(id);
    if (host) {
      this.sandboxHosts.delete(id);
      void host.dispose().catch(() => undefined);
    }
    return this.loaded.delete(id);
  }

  /** Look up a loaded plugin, or undefined. */
  getPlugin(id: string): PluginInfo | undefined {
    const loaded = this.loaded.get(id);
    return loaded ? this.toInfo(loaded) : undefined;
  }

  /** PluginInfo for every loaded plugin, in load order. */
  listPlugins(): PluginInfo[] {
    return [...this.loaded.values()].map((l) => this.toInfo(l));
  }

  // -------------------------------------------------------------- enable
  /** Enable a plugin (persists to enabled.json). False when unknown. */
  enable(id: string): boolean {
    if (!this.loaded.has(id) && !this.enabledKnown.has(id)) return false;
    this.enabledKnown.add(id);
    this.enabledIds.add(id);
    this.writeEnabledFile();
    return true;
  }

  /** Disable a plugin (persists to enabled.json). False when unknown. */
  disable(id: string): boolean {
    if (!this.loaded.has(id) && !this.enabledKnown.has(id)) return false;
    this.enabledKnown.add(id);
    this.enabledIds.delete(id);
    this.writeEnabledFile();
    return true;
  }

  // ---------------------------------------------------------------- tools
  /**
   * Tools contributed by loaded AND enabled plugins only. This is what
   * goes into a ToolRegistry — disabled or failed plugins contribute
   * nothing. Returns fresh Tool objects (the wrapped ones from the loader),
   * in plugin load order.
   */
  toolsForRegistry(): Tool[] {
    const out: Tool[] = [];
    for (const loaded of this.loaded.values()) {
      if (!this.isEnabled(loaded.manifest.id)) continue;
      out.push(...loaded.tools);
    }
    return out;
  }

  // -------------------------------------------------------------- install
  /**
   * Install a plugin from a source directory: validate it FIRST (full
   * loadPlugin pass on the source), then copy it to
   * `<pluginsDir>/<id>/` and load it from there. Throws PluginLoadError
   * when the source is invalid, and Error when the id is already
   * installed (pass `{ overwrite: true }` to replace it).
   */
  installFromDir(srcDir: string, opts: { overwrite?: boolean } = {}): PluginInfo {
    const validated = loadPlugin(srcDir);
    const id = validated.manifest.id;
    const dest = path.join(this.pluginsDir, id);
    if (fs.existsSync(dest) && !opts.overwrite) {
      throw new Error(
        `Plugin "${id}" is already installed in "${this.pluginsDir}". Pass { overwrite: true } to replace it.`,
      );
    }
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.resolve(srcDir), dest, { recursive: true });
    const loaded = loadPlugin(dest);
    this.loaded.set(id, loaded);
    if (!this.enabledKnown.has(id)) {
      this.enabledKnown.add(id);
      this.enabledIds.add(id);
    }
    this.writeEnabledFile();
    return this.toInfo(loaded);
  }

  /**
   * Uninstall a plugin: drop it from the manager and delete its folder
   * from the plugins directory. Returns true when something was removed.
   */
  uninstall(id: string): boolean {
    this.loaded.delete(id);
    const dir = path.join(this.pluginsDir, id);
    let removed = false;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed = true;
    }
    if (this.enabledKnown.has(id) || this.enabledIds.has(id)) {
      this.enabledKnown.delete(id);
      this.enabledIds.delete(id);
      this.writeEnabledFile();
      removed = true;
    }
    return removed;
  }
}

/**
 * Helper for wiring plugins into a ToolRegistry WITHOUT touching
 * registry.ts: returns the enabled plugins' tools, ready for
 * `registry.registerMany(toolsFromPlugins(manager))`.
 */
export function toolsFromPlugins(manager: PluginManager): Tool[] {
  return manager.toolsForRegistry();
}

/**
 * Convenience wrapper around `toolsFromPlugins`: registers every enabled
 * plugin tool into `registry` and returns the registered tool names.
 * Duplicate tool names still throw, exactly like `registry.register` —
 * a plugin that collides with a core tool fails loudly instead of
 * silently shadowing it.
 */
export function registerPluginTools(registry: ToolRegistry, manager: PluginManager): string[] {
  const tools = toolsFromPlugins(manager);
  registry.registerMany(tools);
  return tools.map((t) => t.definition.name);
}
