/**
 * Sandbox enforcer — check every action against the profile before
 * it runs (v1.02 rescue port of the v0.99 work).
 *
 * The enforcer is the single choke point: shell commands, file
 * writes/reads, and network requests all pass through `check*`
 * before executing. A denied action throws `SandboxDeniedError`
 * (fail-closed) and is written to the audit log. Credential paths
 * (`.env*`, `*.pem`, `*.key`, `credentials*`) are denied always,
 * even under the permissive profile — no profile may open them.
 */

import { checkAllowlist } from './allowlist';
import type { SandboxProfile } from './profiles';
import type { SandboxAuditLogger } from './audit';

/** Credential / secret paths that are denied under every profile. */
export const SANDBOX_DENIED_PATH_PATTERNS: RegExp[] = [
  /^\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /^credentials/i,
  /\.p12$/i,
  /^id_rsa/i,
  /(^|\/)\.git\//,
];

export class SandboxDeniedError extends Error {
  readonly action: string;
  readonly target: string;
  constructor(action: string, target: string, reason: string) {
    super(`sandbox denied ${action} ${target}: ${reason}`);
    this.name = 'SandboxDeniedError';
    this.action = action;
    this.target = target;
  }
}

export interface SandboxEnforcerOptions {
  profile: SandboxProfile;
  botId?: string;
  audit?: SandboxAuditLogger;
}

/** Checks actions against a profile (+ the always-denied paths). */
export class SandboxEnforcer {
  private readonly profile: SandboxProfile;
  private readonly botId?: string;
  private readonly audit?: SandboxAuditLogger;

  constructor(options: SandboxEnforcerOptions) {
    this.profile = options.profile;
    this.botId = options.botId;
    this.audit = options.audit;
  }

  get profileName(): string {
    return this.profile.name;
  }

  /** True when this path is denied under every profile (credentials, .git). */
  static isAlwaysDeniedPath(targetPath: string): boolean {
    const base = targetPath.replace(/\\/g, '/').split('/').pop() ?? targetPath;
    const normalized = targetPath.replace(/\\/g, '/');
    return SANDBOX_DENIED_PATH_PATTERNS.some(
      (pattern) => pattern.test(base) || pattern.test(normalized),
    );
  }

  /** Check a shell command (throws when denied). */
  checkCommand(command: string): void {
    if (!this.profile.shellEnabled) {
      this.deny('exec', command, 'shell is disabled by the sandbox profile');
    }
    const check = checkAllowlist({ command }, this.profile.allowlist);
    if (!check.allowed) this.deny('exec', command, check.reason ?? 'not in allowlist');
    this.allow('exec', command);
  }

  /** Check a file write (throws when denied). */
  checkWrite(targetPath: string): void {
    if (SandboxEnforcer.isAlwaysDeniedPath(targetPath)) {
      this.deny('write', targetPath, 'sensitive path is denied under every profile');
    }
    const check = checkAllowlist({ path: targetPath }, this.profile.allowlist);
    if (!check.allowed) this.deny('write', targetPath, check.reason ?? 'not in allowlist');
    this.allow('write', targetPath);
  }

  /** Check a file read (throws when denied). */
  checkRead(targetPath: string): void {
    if (SandboxEnforcer.isAlwaysDeniedPath(targetPath)) {
      this.deny('read', targetPath, 'sensitive path is denied under every profile');
    }
    const check = checkAllowlist({ path: targetPath }, this.profile.allowlist);
    if (!check.allowed) this.deny('read', targetPath, check.reason ?? 'not in allowlist');
    this.allow('read', targetPath);
  }

  /** Check a network host (throws when denied). */
  checkNetwork(host: string): void {
    if (!this.profile.networkEnabled) {
      this.deny('network', host, 'network is disabled by the sandbox profile');
    }
    const check = checkAllowlist({ host }, this.profile.allowlist);
    if (!check.allowed) this.deny('network', host, check.reason ?? 'not in allowlist');
    this.allow('network', host);
  }

  private allow(action: 'exec' | 'write' | 'read' | 'network', target: string): void {
    this.audit?.append({
      at: new Date().toISOString(),
      ...(this.botId ? { botId: this.botId } : {}),
      action,
      target,
      allowed: true,
      profile: this.profile.name,
    });
  }

  private deny(action: 'exec' | 'write' | 'read' | 'network', target: string, reason: string): never {
    this.audit?.append({
      at: new Date().toISOString(),
      ...(this.botId ? { botId: this.botId } : {}),
      action,
      target,
      allowed: false,
      reason,
      profile: this.profile.name,
    });
    throw new SandboxDeniedError(action, target, reason);
  }
}
