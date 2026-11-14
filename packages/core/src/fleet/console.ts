/**
 * Fleet console v2 — fleet-wide user directory, console roles, and the
 * per-bot overview the console UI renders.
 *
 * This sits on top of the v1 fleet layer (registry / manager / service /
 * usage) and does NOT change it:
 *
 * - Console roles are fleet-wide, not per-workspace: 'admin' (full
 *   control), 'operator' (run bots, install plugins, change quotas,
 *   start/stop services) and 'viewer' (read-only + rate marketplace
 *   entries). They are deliberately separate from the per-workspace
 *   FleetRole ('admin' | 'member' | 'chat-only') in types.ts, which
 *   governs what a member may do inside one workspace.
 * - Users live in `<fleetRoot>/fleet-users.json` (atomic write, mode
 *   0600 — same posture as the workspace registry). Role changes and
 *   user add/remove append to the hash-chained fleet audit log, so the
 *   console's own admin actions are themselves auditable.
 * - The bot overview is a pure projection of FleetStatusView[] (one row
 *   per workspace/service, i.e. one bot per workspace in the fleet
 *   model): allocated vs actually used RAM/disk, service state, uptime.
 *   CPU usage is a cumulative counter in the usage ledger, so it is
 *   reported as total CPU seconds, never faked into a percentage —
 *   the per-second rate lives in quotas.ts (cpuRateFromSamples).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendFleetAuditEvent } from './audit';
import type { FleetStatusView } from './types';

/** Fleet-wide console role (distinct from per-workspace FleetRole). */
export type FleetConsoleRole = 'admin' | 'operator' | 'viewer';

export const FLEET_CONSOLE_ROLES: readonly FleetConsoleRole[] = ['admin', 'operator', 'viewer'];

/** Actions the console gates behind a role. */
export type FleetConsoleAction =
  | 'manageUsers'
  | 'manageWorkspaces'
  | 'manageBots'
  | 'installPlugins'
  | 'changeQuotas'
  | 'startStopServices'
  | 'viewUsage'
  | 'viewAudit'
  | 'rateMarketplace';

export const FLEET_CONSOLE_ACTIONS: readonly FleetConsoleAction[] = [
  'manageUsers',
  'manageWorkspaces',
  'manageBots',
  'installPlugins',
  'changeQuotas',
  'startStopServices',
  'viewUsage',
  'viewAudit',
  'rateMarketplace',
];

/**
 * Permission matrix: what each console role may do. Admin can do
 * everything; operator can run the fleet but not manage users or
 * workspaces; viewer can only look (and rate marketplace entries,
 * which only writes local metadata).
 */
export const FLEET_CONSOLE_PERMISSIONS: Record<FleetConsoleRole, readonly FleetConsoleAction[]> = {
  admin: FLEET_CONSOLE_ACTIONS,
  operator: [
    'manageBots',
    'installPlugins',
    'changeQuotas',
    'startStopServices',
    'viewUsage',
    'viewAudit',
    'rateMarketplace',
  ],
  viewer: ['viewUsage', 'viewAudit', 'rateMarketplace'],
};

/** True when the role is allowed to perform the action. */
export function canPerform(role: FleetConsoleRole, action: FleetConsoleAction): boolean {
  return FLEET_CONSOLE_PERMISSIONS[role].includes(action);
}

/** Throws when the role may not perform the action (fail-closed). */
export function assertCanPerform(role: FleetConsoleRole, action: FleetConsoleAction): void {
  if (!FLEET_CONSOLE_PERMISSIONS[role].includes(action)) {
    throw new Error(`role '${role}' may not perform '${action}'.`);
  }
}

/** One person in the fleet-wide user directory. */
export interface FleetConsoleUser {
  /** Stable id (local username or email, as typed by the admin). */
  userId: string;
  displayName: string;
  role: FleetConsoleRole;
  /** Workspace ids this user is assigned to (empty = fleet-wide, no workspace). */
  workspaceIds: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export const FLEET_CONSOLE_USERS_FILE = 'fleet-users.json';

export function getFleetConsoleUsersPath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet console needs a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_CONSOLE_USERS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConsoleRole(value: unknown): value is FleetConsoleRole {
  return value === 'admin' || value === 'operator' || value === 'viewer';
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Validate one stored console user (throws on any bad field). */
export function validateFleetConsoleUser(raw: unknown): FleetConsoleUser {
  if (!isRecord(raw)) throw new Error('fleet console user must be an object.');
  const { userId, displayName, role, workspaceIds, createdAt, createdBy, updatedAt } = raw;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('fleet console user needs a non-empty userId.');
  }
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new Error('fleet console user needs a non-empty displayName.');
  }
  if (!isConsoleRole(role)) throw new Error(`fleet console role must be one of ${FLEET_CONSOLE_ROLES.join(', ')}.`);
  if (!Array.isArray(workspaceIds)) throw new Error('fleet console user needs workspaceIds as an array.');
  for (const stamp of ['createdAt', 'createdBy', 'updatedAt'] as const) {
    const value = raw[stamp];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`fleet console user needs a non-empty ${stamp}.`);
    }
  }
  return {
    userId: userId.trim(),
    displayName: displayName.trim(),
    role,
    workspaceIds: cleanStringList(workspaceIds),
    createdAt: createdAt as string,
    createdBy: createdBy as string,
    updatedAt: updatedAt as string,
  };
}

/** Load the console user directory (missing file = empty directory). */
export function loadFleetConsoleUsers(rootDir: string): FleetConsoleUser[] {
  const filePath = getFleetConsoleUsersPath(rootDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${FLEET_CONSOLE_USERS_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_CONSOLE_USERS_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateFleetConsoleUser(entry);
    } catch (err) {
      throw new Error(`${FLEET_CONSOLE_USERS_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Save the console user directory (atomic tmp + rename, mode 0600). */
export function saveFleetConsoleUsers(rootDir: string, users: FleetConsoleUser[]): void {
  const valid = users.map((u) => validateFleetConsoleUser(u));
  const filePath = getFleetConsoleUsersPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

export interface AddFleetConsoleUserInput {
  userId: string;
  displayName?: string;
  role: FleetConsoleRole;
  workspaceIds?: string[];
}

/**
 * FleetConsole — the fleet-wide user directory.
 *
 * Every mutation writes state first, then appends an audit event
 * (same order as FleetManager); a failed audit write throws so the
 * caller knows the event is missing. The last admin cannot be removed
 * or demoted — a fleet with no admin cannot be administered.
 */
export class FleetConsole {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
      throw new Error('FleetConsole needs a non-empty rootDir.');
    }
    this.rootDir = rootDir;
  }

  listUsers(): FleetConsoleUser[] {
    return loadFleetConsoleUsers(this.rootDir).sort((a, b) =>
      a.userId.localeCompare(b.userId),
    );
  }

  getUser(userId: string): FleetConsoleUser | undefined {
    return loadFleetConsoleUsers(this.rootDir).find((u) => u.userId === userId);
  }

  addUser(input: AddFleetConsoleUserInput, actor: string): FleetConsoleUser {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Error('fleet console addUser needs a non-empty actor.');
    }
    if (typeof input.userId !== 'string' || input.userId.trim().length === 0) {
      throw new Error('fleet console user needs a non-empty userId.');
    }
    if (!isConsoleRole(input.role)) {
      throw new Error(`fleet console role must be one of ${FLEET_CONSOLE_ROLES.join(', ')}.`);
    }
    const users = loadFleetConsoleUsers(this.rootDir);
    const userId = input.userId.trim();
    if (users.some((u) => u.userId === userId)) {
      throw new Error(`fleet console user already exists: ${userId}`);
    }
    const now = new Date().toISOString();
    const user: FleetConsoleUser = {
      userId,
      displayName: input.displayName?.trim() || userId,
      role: input.role,
      workspaceIds: cleanStringList(input.workspaceIds ?? []),
      createdAt: now,
      createdBy: actor.trim(),
      updatedAt: now,
    };
    saveFleetConsoleUsers(this.rootDir, [...users, user]);
    appendFleetAuditEvent(this.rootDir, {
      actor: actor.trim(),
      action: 'console.user-add',
      target: `user:${userId}`,
      detail: { role: user.role },
    });
    return user;
  }

  setRole(userId: string, role: FleetConsoleRole, actor: string): FleetConsoleUser {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Error('fleet console setRole needs a non-empty actor.');
    }
    if (!isConsoleRole(role)) {
      throw new Error(`fleet console role must be one of ${FLEET_CONSOLE_ROLES.join(', ')}.`);
    }
    const users = loadFleetConsoleUsers(this.rootDir);
    const found = users.find((u) => u.userId === userId);
    if (!found) throw new Error(`fleet console user not found: ${userId}`);
    if (found.role === 'admin' && role !== 'admin') {
      const admins = users.filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        throw new Error('cannot demote the last admin of the fleet.');
      }
    }
    const updated: FleetConsoleUser = {
      ...found,
      role,
      updatedAt: new Date().toISOString(),
    };
    saveFleetConsoleUsers(
      this.rootDir,
      users.map((u) => (u.userId === userId ? updated : u)),
    );
    appendFleetAuditEvent(this.rootDir, {
      actor: actor.trim(),
      action: 'console.role-change',
      target: `user:${userId}`,
      detail: { from: found.role, to: role },
    });
    return updated;
  }

  removeUser(userId: string, actor: string): boolean {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Error('fleet console removeUser needs a non-empty actor.');
    }
    const users = loadFleetConsoleUsers(this.rootDir);
    const found = users.find((u) => u.userId === userId);
    if (!found) return false;
    if (found.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
      throw new Error('cannot remove the last admin of the fleet.');
    }
    saveFleetConsoleUsers(
      this.rootDir,
      users.filter((u) => u.userId !== userId),
    );
    appendFleetAuditEvent(this.rootDir, {
      actor: actor.trim(),
      action: 'console.user-remove',
      target: `user:${userId}`,
      detail: { role: found.role },
    });
    return true;
  }

  assignWorkspace(userId: string, workspaceId: string, actor: string): FleetConsoleUser {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Error('fleet console assignWorkspace needs a non-empty actor.');
    }
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      throw new Error('fleet console assignWorkspace needs a non-empty workspaceId.');
    }
    const users = loadFleetConsoleUsers(this.rootDir);
    const found = users.find((u) => u.userId === userId);
    if (!found) throw new Error(`fleet console user not found: ${userId}`);
    const wid = workspaceId.trim();
    if (found.workspaceIds.includes(wid)) return found;
    const updated: FleetConsoleUser = {
      ...found,
      workspaceIds: [...found.workspaceIds, wid],
      updatedAt: new Date().toISOString(),
    };
    saveFleetConsoleUsers(
      this.rootDir,
      users.map((u) => (u.userId === userId ? updated : u)),
    );
    appendFleetAuditEvent(this.rootDir, {
      actor: actor.trim(),
      action: 'console.workspace-assign',
      target: `user:${userId}`,
      detail: { workspaceId: wid },
    });
    return updated;
  }

  unassignWorkspace(userId: string, workspaceId: string, actor: string): FleetConsoleUser {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Error('fleet console unassignWorkspace needs a non-empty actor.');
    }
    const users = loadFleetConsoleUsers(this.rootDir);
    const found = users.find((u) => u.userId === userId);
    if (!found) throw new Error(`fleet console user not found: ${userId}`);
    const wid = workspaceId.trim();
    if (!found.workspaceIds.includes(wid)) return found;
    const updated: FleetConsoleUser = {
      ...found,
      workspaceIds: found.workspaceIds.filter((w) => w !== wid),
      updatedAt: new Date().toISOString(),
    };
    saveFleetConsoleUsers(
      this.rootDir,
      users.map((u) => (u.userId === userId ? updated : u)),
    );
    appendFleetAuditEvent(this.rootDir, {
      actor: actor.trim(),
      action: 'console.workspace-unassign',
      target: `user:${userId}`,
      detail: { workspaceId: wid },
    });
    return updated;
  }
}

/** One row of the fleet console's bot overview (one bot per workspace). */
export interface FleetBotOverview {
  workspaceId: string;
  name: string;
  osUser: string;
  state: FleetStatusView['service']['state'];
  pid?: number;
  /** Service uptime in ms — null when not running / not measurable. */
  uptimeMs: number | null;
  /** Allocated resources (from the workspace registry). */
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  /** Actually used resources (latest usage sample) — null when never measured. */
  ramUsedBytes: number | null;
  diskUsedBytes: number | null;
  /** Total CPU seconds consumed (cumulative, never a faked percentage). */
  cpuSecondsTotal: number | null;
  /** Used / allocated as a 0..1 fraction — null when unmeasured. */
  ramUsedPercent: number | null;
  diskUsedPercent: number | null;
  members: Array<{ userId: string; role: string }>;
}

function percent(used: number | null, limit: number): number | null {
  if (used === null || limit <= 0) return null;
  return Math.min(1, Math.max(0, used / limit));
}

/**
 * Project fleet statuses into console overview rows. Pure function so
 * the UI can render the same rows the tests assert on.
 */
export function buildFleetBotOverview(statuses: FleetStatusView[]): FleetBotOverview[] {
  return statuses.map((status) => {
    const ws = status.workspace;
    const usage = status.usage;
    return {
      workspaceId: ws.id,
      name: ws.name,
      osUser: ws.osUser,
      state: status.service.state,
      ...(status.service.pid !== undefined ? { pid: status.service.pid } : {}),
      uptimeMs: status.service.uptimeMs,
      cpuCores: ws.cpuCores,
      ramBytes: ws.ramBytes,
      diskBytes: ws.diskBytes,
      ramUsedBytes: usage?.rssBytesLatest ?? null,
      diskUsedBytes: usage?.diskBytesLatest ?? null,
      cpuSecondsTotal: usage?.cpuSecondsMax ?? null,
      ramUsedPercent: percent(usage?.rssBytesLatest ?? null, ws.ramBytes),
      diskUsedPercent: percent(usage?.diskBytesLatest ?? null, ws.diskBytes),
      members: ws.members.map((m) => ({ userId: m.userId, role: m.role })),
    };
  });
}
