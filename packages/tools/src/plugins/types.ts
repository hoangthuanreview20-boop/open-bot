/**
 * Plugin types for @open-bot/tools (v0.3, wave 1).
 *
 * Design notes — what was borrowed, and what was deliberately left out:
 *
 * - From VS Code: a plugin is a directory with a *manifest* (`manifest.json`,
 *   VS Code's `package.json` + `contributes`) that declares its id, version,
 *   entry point and the tools it contributes, and a *lazy* lifecycle — the
 *   manifest is read at scan time, code is only `require`d when the plugin
 *   is loaded. VS Code's activation events (`onCommand:…`, `onLanguage:…`)
 *   are NOT copied: v0.3 loads every enabled plugin at startup instead.
 * - From Claude Code: a plugin is one installable bundle that can carry
 *   several capabilities (here: tools; later: skills / MCP servers / hooks),
 *   installed by copying a directory into a plugins folder, with an
 *   explicit enable/disable switch per plugin.
 * - Local-first and deliberately small: no marketplace, no semver-range
 *   resolution, no dependency installation. A plugin is a folder with a
 *   manifest + a CommonJS entry file, nothing more.
 *
 * HONEST LIMIT (read before trusting this): plugins run IN-PROCESS, in the
 * same Node process as the agent, and plugin code is trusted exactly like
 * code the user installed themselves (the same trust model as installing a
 * VS Code extension). The `permissions` below are *declaration + load-time
 * checks* (see loader.ts), NOT an OS sandbox: a malicious plugin that
 * passes the static checks could still call Node APIs directly at runtime.
 * A separate plugin process with real isolation is wave-2 work (process
 * model), not this file. Only install plugins from sources you trust.
 */
import type { Tool } from '@open-bot/core';

/** Capability a plugin may declare. Keep in sync with loader.ts signals. */
export type PluginPermission = 'fs' | 'shell' | 'network' | 'mcp';

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'fs',
  'shell',
  'network',
  'mcp',
];

/**
 * The plugin manifest, read from `<plugin-dir>/manifest.json`.
 *
 * - `id`: unique, `[A-Za-z0-9_-]+` (also used as the install directory name).
 * - `main`: entry file inside the plugin directory, e.g. `index.js`.
 * - `permissions`: capabilities the plugin declares it needs. A tool that
 *   uses a capability NOT listed here is rejected at load time.
 * - `tools`: optional allowlist of tool names the plugin contributes. When
 *   present, exported tools whose names are not listed are ignored; when
 *   absent, every exported tool is loaded.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: PluginPermission[];
  main: string;
  tools?: string[];
}

/** Runtime view of one plugin: its manifest plus load/enable state. */
export interface PluginInfo {
  manifest: PluginManifest;
  /** Absolute path of the plugin directory. */
  dir: string;
  /** False when the user disabled the plugin (persisted in enabled.json). */
  enabled: boolean;
  /** Names of the tools this plugin contributed (after manifest filtering). */
  loadedTools: string[];
}

/** What a plugin entry file must export (CommonJS `module.exports`). */
export interface PluginModule {
  /** The tools this plugin contributes. */
  tools?: Tool[];
  /** Alternative shape: `module.exports.default = [...]` or `{ tools }`. */
  default?: Tool[] | { tools?: Tool[] };
}

/** Thrown whenever a plugin cannot be loaded (bad manifest, missing entry,
 *  invalid tool, undeclared permission, forbidden require, …). */
export class PluginLoadError extends Error {
  /** Plugin id when known (from the manifest or directory name). */
  readonly pluginId?: string;
  /** Directory that failed to load, when known. */
  readonly dir?: string;

  constructor(message: string, opts: { pluginId?: string; dir?: string } = {}) {
    super(message);
    this.name = 'PluginLoadError';
    this.pluginId = opts.pluginId;
    this.dir = opts.dir;
  }
}
