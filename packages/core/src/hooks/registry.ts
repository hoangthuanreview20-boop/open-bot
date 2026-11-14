/**
 * HookRegistry (v0.10, P0-2).
 *
 * Owns the registered hooks: built-ins + code-registered + plugin hooks.
 * Responsibilities:
 * - `register(def)` / `registerHook(name, events, handler, opts)` —
 *   register a function hook. Re-registering a name REPLACES the handler
 *   (last wins, same override rule as SkillRegistry: a user/plugin hook
 *   can replace a built-in with the same name) and preserves the
 *   enabled/disabled state.
 * - `enable(name)` / `disable(name)` — persisted in
 *   `<stateDir>/hooks-enabled.json` (a plain JSON map name -> boolean;
 *   missing entry means enabled), mirroring SkillRegistry. A disabled
 *   hook never runs.
 * - `listForEvent(kind)` — enabled hooks for one event, in registration
 *   order. The runner executes them in this order; the first `block`
 *   wins, `modify` decisions chain (each hook sees the previous hook's
 *   rewritten args/output).
 * - `applySettings(settings)` — apply the `hooks` section of settings:
 *   enable/disable by name and optionally restrict a hook to a subset of
 *   its events. Unknown names are reported in the return value, never
 *   thrown — a typo in settings must not break the agent.
 *
 * The registry holds FUNCTIONS, not script files: v0.10 hooks are
 * functions in code. Since v0.18 a hook may ALSO be backed by an
 * external script file (`registerScriptHook`): the registry wraps the
 * file in a function that runs it out-of-process via `scriptRunner.ts`,
 * so to the runner a script hook is indistinguishable from a function
 * hook. Since v1.01 a hook may ALSO be backed by a SHELL COMMAND from
 * settings (`registerCommandHook` / `applyCommandSettings`): the
 * registry wraps the command in a function that spawns it via
 * `shellCommandRunner.ts` (exit 0 = allow, 2 = block) — again
 * indistinguishable to the runner. The wiring into `AgentRunner.executeCall`
 * is also a later step (coordinator-owned); this module only has to hand
 * over a clean API + a registry the coordinator can fill.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HookCommandSettingsEntry,
  HookDefinition,
  HookEvent,
  HookEventKind,
  HookFn,
  HookSettings,
  HookSource,
} from './types';
import { ALL_HOOK_EVENTS, DEFAULT_HOOK_COMMAND_TIMEOUT_MS, HOOK_NAME_RE, HookRegistrationError } from './types';
import {
  DEFAULT_HOOK_SCRIPT_TIMEOUT_MS,
  resolveHookScriptPath,
  runHookScript,
  type HookScriptOptions,
} from './scriptRunner';
import {
  assertValidHookCommandEntry,
  runHookCommand,
  validateHookCommandEntry,
  type HookCommandOptions,
} from './shellCommandRunner';

/**
 * Definition for a script-backed hook (v0.18): like `HookDefinition`
 * but with a `scriptPath` instead of a `handler`. `registerScriptHook`
 * validates the script file and wraps it in a `HookFn` that runs the
 * script out-of-process via `runHookScript` on every invocation.
 */
export interface RegisterScriptHookDef {
  /** Unique name (same naming rule as function hooks). */
  name: string;
  /** Human-readable description (shown in logs / future settings UI). */
  description?: string;
  /** Events this hook runs for. Must be non-empty. */
  events: HookEventKind[];
  /** Where the hook came from. Defaults to `'plugin'` (bundle hooks). */
  source?: HookSource;
  /**
   * Working directory of the script (its `process.cwd()`), and the
   * default allowed root for the script path. Defaults to the parent's
   * cwd. The coordinator passes the bot workspace dir.
   */
  workspaceDir?: string;
  /**
   * Extra directories the script file may live in (in addition to
   * `workspaceDir`). The coordinator passes the bundle dir here.
   */
  allowedDirs?: string[];
  /** Per-invocation timeout in ms. Default `DEFAULT_HOOK_SCRIPT_TIMEOUT_MS` (10s). */
  timeoutMs?: number;
  /** Where the script's non-decision stdout lines are logged. */
  logger?: HookScriptOptions['logger'];
}

export const HOOKS_ENABLED_FILE = 'hooks-enabled.json';

/** File holding the shell-command hooks (JSON list, under the same state dir). */
export const HOOK_COMMANDS_FILE = 'hooks-commands.json';

/** All lifecycle events, for validation / defaults (v1.01: 10 events). Defined in `types.ts`; re-exported here. */
export { ALL_HOOK_EVENTS } from './types';

export interface HookRegistryOptions {
  /** Directory where `hooks-enabled.json` is stored. Defaults to CWD. */
  stateDir?: string;
}

export interface ApplyHookSettingsResult {
  /** Names from settings that were applied to a registered hook. */
  applied: string[];
  /** Names from settings that match no registered hook. */
  unknown: string[];
}

/** Result of syncing shell-command hooks from settings (v1.01). */
export interface ApplyCommandHookSettingsResult {
  /** Names registered or updated from settings. */
  applied: string[];
  /** Names removed because settings no longer lists them. */
  removed: string[];
  /** Entries that failed validation (never throw — see `applyCommandSettings`). */
  invalid: Array<{ name: string; issues: string[] }>;
}

/** Options for `registerCommandHook` / `applyCommandSettings` (v1.01). */
export interface RegisterCommandHookOptions {
  /**
   * Working directory of the command (its `process.cwd()`), and the
   * default when the run context carries no workspace dir. Defaults to
   * the parent's cwd. The coordinator passes the bot workspace dir via
   * `HookContext.workspaceDir` at run time instead — this is only the
   * fallback for runs without a context.
   */
  workspaceDir?: string;
  /** Per-invocation timeout override (ms). Defaults to the entry's `timeoutMs`. */
  timeoutMs?: number;
  /** Where the command's non-decision stdout lines are logged. */
  logger?: HookCommandOptions['logger'];
}

export class HookRegistry {
  private readonly opts: HookRegistryOptions;
  private readonly byName = new Map<string, HookDefinition>();
  /** Registration order (insertion order of first registration per name). */
  private readonly order: string[] = [];
  private readonly disabled = new Set<string>();
  /**
   * Per-hook event restriction from settings (`applySettings`): when set,
   * the hook only runs for these events even if it registered for more.
   */
  private readonly eventOverrides = new Map<string, Set<HookEventKind>>();
  /**
   * v1.01: validated config of every shell-command hook, by name. Only
   * command hooks appear here — function/script hooks have no settings
   * config to remember. Used by `listCommandHooks()` (Settings UI) and
   * by `applyCommandSettings()` to diff settings against the registry.
   */
  private readonly commandDefs = new Map<string, HookCommandSettingsEntry>();

  constructor(opts: HookRegistryOptions = {}) {
    this.opts = opts;
    this.loadEnabledState();
  }

  /**
   * Register (or replace) a hook. Validates the name, the event list and
   * the handler; throws HookRegistrationError on invalid input. The
   * enabled state survives a re-registration (so replacing a built-in
   * hook does not silently re-enable a hook the user disabled).
   */
  register(def: HookDefinition): HookDefinition {
    validateDefinition(def);
    const wasDisabled = this.disabled.has(def.name);
    const stored: HookDefinition = { ...def, enabled: !wasDisabled };
    if (!this.byName.has(def.name)) this.order.push(def.name);
    this.byName.set(def.name, stored);
    return stored;
  }

  /** Convenience for `register()` with the fields spelled out. */
  registerHook(
    name: string,
    events: HookEventKind[],
    handler: HookFn,
    opts: { description?: string; source?: HookSource } = {},
  ): HookDefinition {
    return this.register({
      name,
      description: opts.description,
      events: [...events],
      handler,
      source: opts.source ?? 'settings',
      enabled: true,
    });
  }

  /**
   * Register a hook backed by an external script file (v0.18).
   *
   * Validates eagerly and throws `HookRegistrationError` when the
   * script file does not exist or lies outside the allowed directories
   * (`workspaceDir` + `allowedDirs`) — a bad bundle hook is caught at
   * wiring time, never at first run. The registered handler spawns
   * `node <script>` out-of-process on every invocation (see
   * `scriptRunner.ts`): the script gets `{ event, ...fields }` on
   * stdin and returns its `HookDecision` as the last stdout line.
   * A script failure (timeout, non-zero exit, bad output) rejects the
   * handler promise, which `HookRunner` treats exactly like a throwing
   * function hook (recorded as a `HookError`, never a run crash).
   *
   * Re-registering a name REPLACES the handler and preserves the
   * enabled/disabled state, like `register()`.
   */
  registerScriptHook(def: RegisterScriptHookDef, scriptPath: string): HookDefinition {
    const workspaceDir = def.workspaceDir ?? process.cwd();
    const allowedDirs = [
      workspaceDir,
      ...(def.allowedDirs ?? []).filter((d) => typeof d === 'string' && d !== ''),
    ];
    const timeoutMs = def.timeoutMs ?? DEFAULT_HOOK_SCRIPT_TIMEOUT_MS;
    // Validate eagerly: resolveHookScriptPath throws HookRegistrationError.
    const resolved = resolveHookScriptPath(scriptPath, allowedDirs);
    const handler: HookFn = (event, ctx) => {
      const { event: kind, ...input } = event as HookEvent & { event: HookEventKind };
      return runHookScript(resolved, kind, input as Record<string, unknown>, {
        timeoutMs,
        workspaceDir: ctx.workspaceDir ?? workspaceDir,
        allowedDirs,
        logger: def.logger,
      });
    };
    return this.register({
      name: def.name,
      description: def.description,
      events: [...def.events],
      handler,
      source: def.source ?? 'plugin',
      enabled: true,
    });
  }

  /** Remove a hook. Returns false when no hook with that name exists. */
  unregister(name: string): boolean {
    if (!this.byName.has(name)) return false;
    this.byName.delete(name);
    this.commandDefs.delete(name);
    this.eventOverrides.delete(name);
    const idx = this.order.indexOf(name);
    if (idx >= 0) this.order.splice(idx, 1);
    return true;
  }

  /**
   * Register a hook backed by a SHELL COMMAND from settings (v1.01).
   *
   * Validates eagerly and throws `HookRegistrationError` on a bad
   * config (empty command, bad events, secret-looking env names) — a
   * bad command hook is caught at wiring time, never at first run.
   * The registered handler spawns the command through the platform
   * shell on every invocation (see `shellCommandRunner.ts`): the
   * command gets `{ event, ...fields }` on stdin and answers with an
   * exit code (0 = allow / optional JSON decision, 2 = block, other
   * non-zero = error). The working directory comes from the run
   * context (`ctx.workspaceDir`, the bot workspace) when present, else
   * `opts.workspaceDir`, else the parent's cwd.
   *
   * Re-registering a name REPLACES the handler and preserves the
   * enabled/disabled state, like `register()`. The validated config is
   * remembered in `commandDefs` for `listCommandHooks()`.
   */
  registerCommandHook(
    entry: HookCommandSettingsEntry,
    opts: RegisterCommandHookOptions = {},
  ): HookDefinition {
    const valid = assertValidHookCommandEntry(entry);
    const timeoutMs = opts.timeoutMs ?? valid.timeoutMs ?? DEFAULT_HOOK_COMMAND_TIMEOUT_MS;
    const handler: HookFn = (event, ctx) => {
      const { event: kind, ...input } = event as HookEvent & { event: HookEventKind };
      return runHookCommand(valid.command, kind, input as Record<string, unknown>, {
        timeoutMs,
        workspaceDir: ctx.workspaceDir ?? opts.workspaceDir,
        env: valid.env,
        logger: opts.logger,
      });
    };
    const def = this.register({
      name: valid.name,
      description: valid.description,
      events: [...valid.events],
      handler,
      source: 'command',
      enabled: true,
    });
    this.commandDefs.set(valid.name, valid);
    if (valid.enabled === false) this.disable(valid.name);
    return def;
  }

  /** Validated config of every registered shell-command hook, in registration order. */
  listCommandHooks(): HookCommandSettingsEntry[] {
    return this.order
      .map((name) => this.commandDefs.get(name))
      .filter((e): e is HookCommandSettingsEntry => e !== undefined)
      .map((e) => ({ ...e, enabled: this.isEnabled(e.name) }));
  }

  /** Validated config of one shell-command hook, when it is one. */
  getCommandHook(name: string): HookCommandSettingsEntry | undefined {
    const entry = this.commandDefs.get(name);
    if (!entry) return undefined;
    return { ...entry, enabled: this.isEnabled(name) };
  }

  /**
   * Sync shell-command hooks from settings (v1.01): register new ones,
   * re-register changed ones, unregister ones settings no longer lists.
   * Invalid entries are reported in `invalid` and skipped — never
   * thrown, so one bad command line cannot break the agent or hide the
   * other hooks. A duplicate name in settings: the last valid entry wins.
   * `opts` (workspace dir / logger / timeout override) applies to every
   * hook registered by this call.
   */
  applyCommandSettings(
    settings: HookSettings,
    opts: RegisterCommandHookOptions = {},
  ): ApplyCommandHookSettingsResult {
    const applied: string[] = [];
    const removed: string[] = [];
    const invalid: Array<{ name: string; issues: string[] }> = [];
    const entries = settings?.commands ?? [];
    if (!Array.isArray(entries)) return { applied, removed, invalid };
    const wanted = new Set<string>();
    for (const raw of entries) {
      const result = validateHookCommandEntry(raw);
      if (!result.valid || !result.entry) {
        const name =
          raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
            ? (raw as { name: string }).name
            : '(không rõ tên)';
        invalid.push({
          name,
          issues: result.issues.map((i) => `${i.field}: ${i.message}`),
        });
        continue;
      }
      wanted.add(result.entry.name);
      try {
        this.registerCommandHook(result.entry, opts);
        applied.push(result.entry.name);
      } catch (err) {
        invalid.push({
          name: result.entry.name,
          issues: [err instanceof Error ? err.message : String(err)],
        });
      }
    }
    // Remove command hooks settings no longer lists (function/script
    // hooks are untouched — only names in `commandDefs` are managed here).
    for (const name of [...this.commandDefs.keys()]) {
      if (!wanted.has(name)) {
        this.unregister(name);
        removed.push(name);
      }
    }
    return { applied, removed, invalid };
  }

  /** All registered hooks, in registration order. */
  list(): HookDefinition[] {
    return this.order
      .map((name) => this.byName.get(name)!)
      .filter((h): h is HookDefinition => h !== undefined);
  }

  /** Only enabled hooks, in registration order. */
  listEnabled(): HookDefinition[] {
    return this.list().filter((h) => h.enabled);
  }

  get(name: string): HookDefinition | undefined {
    return this.byName.get(name);
  }

  /** Events a hook effectively runs for (settings restriction applied). */
  effectiveEvents(name: string): HookEventKind[] {
    const hook = this.byName.get(name);
    if (!hook) return [];
    const override = this.eventOverrides.get(name);
    if (!override) return [...hook.events];
    return hook.events.filter((e) => override.has(e));
  }

  /**
   * Enabled hooks for one event, in registration order. This is the
   * order the runner executes them in.
   */
  listForEvent(kind: HookEventKind): HookDefinition[] {
    return this.listEnabled().filter((h) => this.effectiveEvents(h.name).includes(kind));
  }

  enable(name: string): boolean {
    const hook = this.byName.get(name);
    if (!hook) return false;
    this.disabled.delete(name);
    hook.enabled = true;
    this.saveEnabledState();
    return true;
  }

  disable(name: string): boolean {
    const hook = this.byName.get(name);
    if (!hook) return false;
    this.disabled.add(name);
    hook.enabled = false;
    this.saveEnabledState();
    return true;
  }

  isEnabled(name: string): boolean {
    return this.byName.has(name) && !this.disabled.has(name);
  }

  /**
   * Apply the `hooks` section of settings. For each entry: if the hook
   * exists, set its enabled state (default true) and, when `events` is
   * given, restrict it to those events; otherwise record the name as
   * unknown. Never throws for unknown names or bad entries — a bad
   * settings line must not break the agent; the caller can log `unknown`.
   */
  applySettings(settings: HookSettings): ApplyHookSettingsResult {
    const applied: string[] = [];
    const unknown: string[] = [];
    const entries = settings?.hooks ?? [];
    if (!Array.isArray(entries)) return { applied, unknown };
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
        continue;
      }
      const hook = this.byName.get(entry.name);
      if (!hook) {
        unknown.push(entry.name);
        continue;
      }
      if (entry.enabled === false) this.disable(entry.name);
      else this.enable(entry.name);
      if (Array.isArray(entry.events) && entry.events.length > 0) {
        const valid = entry.events.filter((e): e is HookEventKind =>
          ALL_HOOK_EVENTS.includes(e),
        );
        if (valid.length > 0) this.eventOverrides.set(entry.name, new Set(valid));
      } else {
        this.eventOverrides.delete(entry.name);
      }
      applied.push(entry.name);
    }
    return { applied, unknown };
  }

  private stateFile(): string {
    return path.join(this.opts.stateDir ?? process.cwd(), HOOKS_ENABLED_FILE);
  }

  private loadEnabledState(): void {
    try {
      const raw = fs.readFileSync(this.stateFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, enabled] of Object.entries(parsed as Record<string, unknown>)) {
          if (enabled === false) this.disabled.add(name);
        }
      }
    } catch {
      // No state file yet (or corrupt): everything defaults to enabled.
    }
  }

  private saveEnabledState(): void {
    try {
      const dir = path.dirname(this.stateFile());
      fs.mkdirSync(dir, { recursive: true });
      const state: Record<string, boolean> = {};
      for (const name of this.disabled) state[name] = false;
      fs.writeFileSync(this.stateFile(), JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Best-effort persistence: in-memory state still applies for this run.
    }
  }
}

function validateDefinition(def: HookDefinition): void {
  if (!def || typeof def !== 'object') {
    throw new HookRegistrationError('Hook definition must be an object.');
  }
  if (typeof def.name !== 'string' || !HOOK_NAME_RE.test(def.name)) {
    throw new HookRegistrationError(
      `Invalid hook name "${String(def.name)}": must match ${HOOK_NAME_RE}.`,
    );
  }
  if (!Array.isArray(def.events) || def.events.length === 0) {
    throw new HookRegistrationError(
      `Hook "${def.name}" must list at least one event.`,
    );
  }
  for (const event of def.events) {
    if (!ALL_HOOK_EVENTS.includes(event)) {
      throw new HookRegistrationError(
        `Hook "${def.name}" lists unknown event "${String(event)}".`,
      );
    }
  }
  if (typeof def.handler !== 'function') {
    throw new HookRegistrationError(`Hook "${def.name}" must have a function handler.`);
  }
}
