/**
 * Sandbox profiles — named bundles of limits + allowlist (v1.02
 * rescue port of the v0.99 work).
 *
 * A profile is what the UI offers ("Strict", "Standard",
 * "Permissive"): a resource limit set plus an allowlist, under one
 * name. The host picks a profile per bot; the enforcer (see
 * `enforce.ts`) applies it. Profiles are data, not code — a custom
 * profile is just another record.
 */

import type { BoxResourceLimits } from './types';
import type { SandboxAllowlist } from './allowlist';

export interface SandboxProfile {
  name: string;
  description: string;
  limits: BoxResourceLimits;
  allowlist: SandboxAllowlist;
  /** Network access at all (false = no egress, even to allowed hosts). */
  networkEnabled: boolean;
  /** Shell access at all (false = file tools only). */
  shellEnabled: boolean;
}

/** Strict: tight limits, no shell, no network. */
export const SANDBOX_PROFILE_STRICT: SandboxProfile = {
  name: 'strict',
  description: 'File tools only, no shell, no network, small limits.',
  limits: { timeoutMs: 30_000, maxWriteBytes: 10 * 1024 * 1024, maxOutputChars: 50_000, maxFiles: 100 },
  allowlist: { paths: ['.'] },
  networkEnabled: false,
  shellEnabled: false,
};

/** Standard: shell + network to a small allowlist, moderate limits. */
export const SANDBOX_PROFILE_STANDARD: SandboxProfile = {
  name: 'standard',
  description: 'Shell + network to allowlisted hosts, moderate limits.',
  limits: { timeoutMs: 120_000, maxWriteBytes: 100 * 1024 * 1024, maxOutputChars: 200_000, maxFiles: 1000 },
  allowlist: {
    hosts: ['api.github.com', 'registry.npmjs.org'],
    hostSuffixes: ['.githubusercontent.com'],
    paths: ['.'],
    commands: ['node', 'npm', 'git', 'python3', 'ls', 'cat'],
  },
  networkEnabled: true,
  shellEnabled: true,
};

/** Permissive: generous limits, wide allowlist (still no credential paths). */
export const SANDBOX_PROFILE_PERMISSIVE: SandboxProfile = {
  name: 'permissive',
  description: 'Generous limits, wide allowlist. Still blocks credential files.',
  limits: { timeoutMs: 300_000, maxWriteBytes: 500 * 1024 * 1024, maxOutputChars: 500_000, maxFiles: 5000 },
  allowlist: { paths: ['.'], commands: ['node', 'npm', 'npx', 'git', 'python3', 'pip', 'ls', 'cat', 'curl'] },
  networkEnabled: true,
  shellEnabled: true,
};

/** All built-in profiles, keyed by name. */
export const BUILTIN_SANDBOX_PROFILES: Record<string, SandboxProfile> = {
  strict: SANDBOX_PROFILE_STRICT,
  standard: SANDBOX_PROFILE_STANDARD,
  permissive: SANDBOX_PROFILE_PERMISSIVE,
};

/** Look up a built-in profile by name (undefined when unknown). */
export function getBuiltinSandboxProfile(name: string): SandboxProfile | undefined {
  return BUILTIN_SANDBOX_PROFILES[name.toLowerCase()];
}

/** Validate a profile shape (fail-closed on bad values). */
export function validateSandboxProfile(profile: SandboxProfile): string[] {
  const problems: string[] = [];
  if (!profile.name.trim()) problems.push('profile name must not be empty');
  if ((profile.limits.timeoutMs ?? 0) <= 0) problems.push('timeoutMs must be positive');
  if ((profile.limits.maxWriteBytes ?? 0) < 0) problems.push('maxWriteBytes must not be negative');
  if ((profile.limits.maxOutputChars ?? 0) < 0) problems.push('maxOutputChars must not be negative');
  if (!profile.shellEnabled && (profile.allowlist.commands ?? []).length > 0) {
    problems.push('shell is disabled but commands are allowlisted');
  }
  if (!profile.networkEnabled && ((profile.allowlist.hosts ?? []).length > 0 || (profile.allowlist.hostSuffixes ?? []).length > 0)) {
    problems.push('network is disabled but hosts are allowlisted');
  }
  return problems;
}
