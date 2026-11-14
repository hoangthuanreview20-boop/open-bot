/**
 * Sandbox allowlist — which hosts / paths / commands a box may
 * touch (v1.02 rescue port of the v0.99 work).
 *
 * The allowlist is a small, explicit rule set: exact hosts, host
 * suffixes (`.example.com`), path prefixes inside the workspace,
 * and command names. Nothing is allowed by default — an empty
 * allowlist allows nothing (fail-closed). Matching is case-insensitive
 * for hosts and exact for paths (after normalization).
 */

export interface SandboxAllowlist {
  /** Exact hosts allowed (e.g. `api.github.com`). */
  hosts?: string[];
  /** Host suffixes allowed (e.g. `.github.com` matches `api.github.com`). */
  hostSuffixes?: string[];
  /** Path prefixes allowed inside the workspace (e.g. `src/`). */
  paths?: string[];
  /** Command names allowed (e.g. `node`, `git`). */
  commands?: string[];
}

/** True when the host is allowed by exact match or suffix. */
export function isHostAllowed(host: string, allowlist: SandboxAllowlist): boolean {
  const lower = host.toLowerCase().trim();
  if ((allowlist.hosts ?? []).some((h) => h.toLowerCase() === lower)) return true;
  return (allowlist.hostSuffixes ?? []).some((suffix) => {
    const s = suffix.toLowerCase();
    return lower === s.replace(/^\./, '') || lower.endsWith(s.startsWith('.') ? s : `.${s}`);
  });
}

/** True when the (normalized) path is under an allowed prefix. */
export function isPathAllowed(targetPath: string, allowlist: SandboxAllowlist): boolean {
  const normalized = targetPath.replace(/\\/g, '/');
  return (allowlist.paths ?? []).some((prefix) => {
    const p = prefix.replace(/\\/g, '/');
    // A '.' prefix is the workspace root itself: any relative path
    // inside it is allowed (absolute paths and '..' escapes are not).
    if (p === '.' || p === './') {
      return !normalized.startsWith('/') && !normalized.startsWith('..');
    }
    return normalized === p || normalized.startsWith(p.endsWith('/') ? p : `${p}/`);
  });
}

/** True when the command name is allowed (arguments are ignored). */
export function isCommandAllowed(command: string, allowlist: SandboxAllowlist): boolean {
  // The command name is the first whitespace-separated token, without
  // any path prefix ('/usr/bin/git status' -> 'git').
  const first = command.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? first;
  return (allowlist.commands ?? []).some((c) => c.toLowerCase() === base.toLowerCase());
}

/** Check all three dimensions at once (returns the first violation, if any). */
export function checkAllowlist(
  input: { host?: string; path?: string; command?: string },
  allowlist: SandboxAllowlist,
): { allowed: boolean; reason?: string } {
  if (input.host !== undefined && !isHostAllowed(input.host, allowlist)) {
    return { allowed: false, reason: `host not in allowlist: ${input.host}` };
  }
  if (input.path !== undefined && !isPathAllowed(input.path, allowlist)) {
    return { allowed: false, reason: `path not in allowlist: ${input.path}` };
  }
  if (input.command !== undefined && !isCommandAllowed(input.command, allowlist)) {
    return { allowed: false, reason: `command not in allowlist: ${input.command}` };
  }
  return { allowed: true };
}
