/**
 * Sandbox config store — per-bot profile assignment (v1.02 rescue
 * port of the v0.99 work).
 *
 * JSON file store (atomic temp + rename, mode 0600): which profile
 * each bot uses, plus custom profiles the user defined. A corrupt
 * file loads as empty (all bots fall back to the standard profile —
 * fail-closed, never an unknown profile).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { BUILTIN_SANDBOX_PROFILES, validateSandboxProfile, type SandboxProfile } from './profiles';

/** Sandbox config file name (under the userData directory). */
export const SANDBOX_CONFIG_FILE = 'sandbox-config.json';

export interface SandboxConfigFile {
  version: 1;
  /** Bot id -> profile name. */
  bots: Record<string, string>;
  /** Custom profiles by name (built-ins are not stored here). */
  customProfiles: Record<string, SandboxProfile>;
}

/** File-backed sandbox configuration. */
export class SandboxConfigStore {
  private readonly filePath: string;
  private config: SandboxConfigFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.config = this.load();
  }

  /** Profile name assigned to a bot ('standard' when unassigned). */
  profileForBot(botId: string): string {
    return this.config.bots[botId] ?? 'standard';
  }

  /** Assign a profile to a bot (built-in or custom; unknown names throw). */
  setProfileForBot(botId: string, profileName: string): void {
    if (!this.getProfile(profileName)) throw new Error(`unknown sandbox profile: ${profileName}`);
    this.config.bots[botId] = profileName;
    this.persist();
  }

  /** Look up a profile by name (built-in first, then custom). */
  getProfile(name: string): SandboxProfile | undefined {
    return BUILTIN_SANDBOX_PROFILES[name] ?? this.config.customProfiles[name];
  }

  /** Save a custom profile (validated; built-in names cannot be shadowed). */
  setCustomProfile(profile: SandboxProfile): void {
    if (BUILTIN_SANDBOX_PROFILES[profile.name]) {
      throw new Error(`cannot shadow built-in profile: ${profile.name}`);
    }
    const problems = validateSandboxProfile(profile);
    if (problems.length > 0) throw new Error(`invalid sandbox profile: ${problems.join('; ')}`);
    this.config.customProfiles[profile.name] = profile;
    this.persist();
  }

  deleteCustomProfile(name: string): boolean {
    if (!this.config.customProfiles[name]) return false;
    delete this.config.customProfiles[name];
    // Bots using the deleted profile fall back to standard.
    for (const botId of Object.keys(this.config.bots)) {
      if (this.config.bots[botId] === name) this.config.bots[botId] = 'standard';
    }
    this.persist();
    return true;
  }

  listCustomProfiles(): SandboxProfile[] {
    return Object.values(this.config.customProfiles);
  }

  private load(): SandboxConfigFile {
    const empty: SandboxConfigFile = { version: 1, bots: {}, customProfiles: {} };
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return empty;
      const file = parsed as Partial<SandboxConfigFile>;
      return {
        version: 1,
        bots: typeof file.bots === 'object' && file.bots !== null ? (file.bots as Record<string, string>) : {},
        customProfiles:
          typeof file.customProfiles === 'object' && file.customProfiles !== null
            ? (file.customProfiles as Record<string, SandboxProfile>)
            : {},
      };
    } catch {
      return empty;
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Config is best-effort; a failed write must not break the run.
    }
  }
}
