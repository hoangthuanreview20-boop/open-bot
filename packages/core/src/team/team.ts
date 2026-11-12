/**
 * Team sharing (LOCAL, v0.3 wave 1).
 *
 * Storage: `<baseDir>/team.json` in the app-data directory the host
 * passes in. Missing file → a fresh default team (not an error).
 * Invalid JSON / bad shape → a clear Error (file content is never
 * echoed back).
 *
 * LOCAL LIMITS: no central server, no sync between machines, no
 * invites, no real authentication. A team edited on one machine does
 * not appear on another. userIds are trusted strings from the host.
 *
 * Permission rules (also stated in types.ts):
 *  - canUseBot: the bot must be shared AND the user must be an admin
 *    or member. Viewers can only see shared bots, not use them;
 *    non-members cannot use them either.
 *  - canEditBot: the bot must be shared AND (user is admin, OR user
 *    is a member who shared this bot themselves, i.e. sharedBy ===
 *    userId). Viewers never edit; non-members never edit.
 *  - Sharing a bot (shareBot): only an admin or member can share.
 *    A viewer cannot share.
 *
 * All mutating helpers are pure: they validate, return a NEW
 * TeamConfig, and never mutate the input. Persist with saveTeamConfig.
 *
 * v0.5 additions: stable `teamId` (generated on load when missing and
 * written back so it stays stable), shared `workspaceDir`, and service
 * accounts. A service account record holds NO secret — its token lives
 * in the Vault (namespace 'service-account', see
 * `serviceAccountVaultKey`) and is created/returned by the host only
 * once, at creation time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createDefaultEgressPolicy,
  mergeEgressPolicies,
  validateEgressPolicy,
  type EgressPolicy,
} from '../egress/policy';
import type { TeamEgressConfig } from './types';
import {
  LOCAL_USER_ID,
  SERVICE_ACCOUNT_SCOPES,
  TEAM_ROLES,
  type ServiceAccount,
  type ServiceAccountScope,
  type SharedBot,
  type TeamConfig,
  type TeamMember,
  type TeamRole,
} from './types';

export const TEAM_CONFIG_FILE = 'team.json';

/** Vault namespace holding service-account tokens. */
export const SERVICE_ACCOUNT_VAULT_NAMESPACE = 'service-account';

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** UUID as produced by `randomUUID()` (lowercase, hyphenated). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Service account id: `sa-<uuid>`. Must also pass the Vault key rules. */
const SERVICE_ACCOUNT_ID_RE = /^sa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error(`Invalid team ${what} "${String(value)}": must match /^[A-Za-z0-9_-]+$/`);
  }
}

function assertNonEmptyString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid team ${what}: must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

function validateMember(raw: unknown, index: number): TeamMember {
  if (!isRecord(raw)) {
    throw new Error(`Invalid team config: member #${index} must be an object`);
  }
  assertId(raw['userId'], 'member userId');
  assertNonEmptyString(raw['name'], 'member name');
  if (!isTeamRole(raw['role'])) {
    throw new Error(
      `Invalid team config: member "${String(raw['userId'])}": "role" must be one of ${TEAM_ROLES.join(', ')}`,
    );
  }
  return { userId: raw['userId'], name: raw['name'], role: raw['role'] };
}

function validateSharedBot(raw: unknown, index: number): SharedBot {
  if (!isRecord(raw)) {
    throw new Error(`Invalid team config: shared bot #${index} must be an object`);
  }
  assertId(raw['botId'], 'shared botId');
  if (typeof raw['sharedBy'] !== 'string') {
    throw new Error(`Invalid team config: shared bot "${String(raw['botId'])}": "sharedBy" must be a string`);
  }
  return { botId: raw['botId'], sharedBy: raw['sharedBy'] };
}

function isServiceAccountScope(value: unknown): value is ServiceAccountScope {
  return typeof value === 'string' && (SERVICE_ACCOUNT_SCOPES as readonly string[]).includes(value);
}

function validateServiceAccount(raw: unknown, index: number): ServiceAccount {
  if (!isRecord(raw)) {
    throw new Error(`Invalid team config: service account #${index} must be an object`);
  }
  if (typeof raw['id'] !== 'string' || !SERVICE_ACCOUNT_ID_RE.test(raw['id'])) {
    throw new Error(
      `Invalid team config: service account #${index}: "id" must look like "sa-<uuid>"`,
    );
  }
  assertNonEmptyString(raw['name'], 'service account name');
  if (!isServiceAccountScope(raw['scope'])) {
    throw new Error(
      `Invalid team config: service account "${String(raw['id'])}": "scope" must be one of ${SERVICE_ACCOUNT_SCOPES.join(', ')}`,
    );
  }
  if (typeof raw['createdAt'] !== 'number' || !Number.isFinite(raw['createdAt']) || raw['createdAt'] < 0) {
    throw new Error(
      `Invalid team config: service account "${String(raw['id'])}": "createdAt" must be a non-negative number (epoch ms)`,
    );
  }
  return { id: raw['id'], name: raw['name'], scope: raw['scope'], createdAt: raw['createdAt'] };
}

/** Normalize an optional workspace dir: trimmed, '' → undefined. */
function normalizeWorkspaceDir(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error('Invalid team config: "workspaceDir" must be a string');
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate phần egress riêng của team (P0-2). Absent/null → undefined
 * (team dùng policy chung). Dùng chung `validateEgressPolicy` của
 * module egress để một nơi định nghĩa luật — chỉ khác là ở đây mọi
 * field đều optional và KHÔNG điền mặc định (field thiếu = lấy theo
 * policy chung lúc resolve, không rơi về mặc định).
 */
function validateTeamEgress(raw: unknown): TeamEgressConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid team config: "egress" must be an object');
  }
  // validateEgressPolicy ném Error rõ ràng khi entry sai (host chứa
  // '/', IP/CIDR lỗi, mode lạ...); bản chuẩn hoá của nó giữ đúng các
  // field team đã đặt, field thiếu được điền mặc định — resolve lúc
  // sau sẽ chỉ lấy field team đặt (xem resolveTeamEgressPolicy).
  const valid = validateEgressPolicy(raw);
  const rec = raw as Record<string, unknown>;
  const out: TeamEgressConfig = {};
  if (rec['allowHosts'] !== undefined) out.allowHosts = valid.allowHosts;
  if (rec['allowIpRanges'] !== undefined) out.allowIpRanges = valid.allowIpRanges;
  if (rec['allowPrivateDestinations'] !== undefined) {
    out.allowPrivateDestinations = valid.allowPrivateDestinations;
  }
  if (rec['githubEgressIps'] !== undefined) out.githubEgressIps = valid.githubEgressIps;
  if (rec['mode'] !== undefined) out.mode = valid.mode;
  return out;
}

/**
 * Validate a TeamConfig value (from a file or built by hand) and
 * return a normalized copy. Throws a clear Error on any bad shape.
 * Accepts the legacy `sharedBotIds: string[]` shape and migrates it
 * to `sharedBots` with `sharedBy: ''` (unknown owner).
 *
 * v0.5 defaults: a config without `teamId` gets a fresh uuid (the
 * caller must persist it — `loadTeamConfig` does that automatically);
 * without `workspaceDir` it is left unset; without `serviceAccounts`
 * it defaults to `[]`.
 */
export function validateTeamConfig(raw: unknown): TeamConfig {
  if (!isRecord(raw)) {
    throw new Error('Invalid team config: top level must be an object');
  }
  assertId(raw['id'], 'id');
  assertNonEmptyString(raw['name'], 'name');
  if (!Array.isArray(raw['members'])) {
    throw new Error('Invalid team config: "members" must be an array');
  }
  const members = raw['members'].map((m, i) => validateMember(m, i));
  const userIds = new Set<string>();
  for (const m of members) {
    if (userIds.has(m.userId)) {
      throw new Error(`Invalid team config: duplicate member userId "${m.userId}"`);
    }
    userIds.add(m.userId);
  }
  let sharedBots: SharedBot[];
  if (Array.isArray(raw['sharedBots'])) {
    sharedBots = raw['sharedBots'].map((b, i) => validateSharedBot(b, i));
  } else if (Array.isArray(raw['sharedBotIds'])) {
    // Legacy shape: bare bot ids, owner unknown.
    sharedBots = raw['sharedBotIds'].map((botId, i) => {
      assertId(botId, `sharedBotIds[${i}]`);
      return { botId: botId as string, sharedBy: '' };
    });
  } else {
    throw new Error('Invalid team config: "sharedBots" must be an array');
  }
  const botIds = new Set<string>();
  for (const b of sharedBots) {
    if (botIds.has(b.botId)) {
      throw new Error(`Invalid team config: duplicate shared botId "${b.botId}"`);
    }
    botIds.add(b.botId);
  }
  // v0.5: teamId — generate a fresh uuid when missing so old files load.
  let teamId: string;
  if (raw['teamId'] === undefined || raw['teamId'] === null) {
    teamId = randomUUID();
  } else if (typeof raw['teamId'] === 'string' && UUID_RE.test(raw['teamId'])) {
    teamId = raw['teamId'];
  } else {
    throw new Error('Invalid team config: "teamId" must be a uuid');
  }
  const workspaceDir = normalizeWorkspaceDir(raw['workspaceDir']);
  let serviceAccounts: ServiceAccount[];
  if (raw['serviceAccounts'] === undefined || raw['serviceAccounts'] === null) {
    serviceAccounts = [];
  } else if (Array.isArray(raw['serviceAccounts'])) {
    serviceAccounts = raw['serviceAccounts'].map((a, i) => validateServiceAccount(a, i));
  } else {
    throw new Error('Invalid team config: "serviceAccounts" must be an array');
  }
  const accountIds = new Set<string>();
  for (const a of serviceAccounts) {
    if (accountIds.has(a.id)) {
      throw new Error(`Invalid team config: duplicate service account id "${a.id}"`);
    }
    accountIds.add(a.id);
  }
  const out: TeamConfig = { id: raw['id'], name: raw['name'], members, sharedBots, teamId, serviceAccounts };
  if (workspaceDir !== undefined) out.workspaceDir = workspaceDir;
  // P0-2: egress riêng của team (absent ở file cũ → undefined, team dùng policy chung).
  const teamEgress = validateTeamEgress(raw['egress']);
  if (teamEgress !== undefined) out.egress = teamEgress;
  return out;
}

export function getTeamConfigPath(baseDir: string): string {
  assertNonEmptyString(baseDir, 'baseDir');
  return path.join(baseDir, TEAM_CONFIG_FILE);
}

/** Fresh empty team used when no team.json exists yet. */
export function defaultTeamConfig(): TeamConfig {
  return { id: 'default', name: 'Default team', members: [], sharedBots: [], teamId: randomUUID(), serviceAccounts: [] };
}

/**
 * Load the team config from `<baseDir>/team.json`.
 * Missing file → a fresh default team. Invalid JSON / bad shape →
 * a clear Error (file content is never echoed back).
 *
 * v0.5: when an existing file has no `teamId`, one is generated and
 * the normalized config is written back immediately, so the id stays
 * stable across later loads.
 */
export function loadTeamConfig(baseDir: string): TeamConfig {
  const filePath = getTeamConfigPath(baseDir);
  if (!fs.existsSync(filePath)) return defaultTeamConfig();
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read team config at ${TEAM_CONFIG_FILE}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid team config at ${TEAM_CONFIG_FILE}: not valid JSON: ${(err as Error).message}`);
  }
  const validated = validateTeamConfig(parsed);
  if (!isRecord(parsed) || typeof parsed['teamId'] !== 'string') {
    // First load of a pre-v0.5 file: persist the generated teamId so
    // it does not change on the next load. A write failure here must
    // not break loading — the in-memory config is still valid.
    try {
      saveTeamConfig(baseDir, validated);
    } catch {
      // Ignore: the team still loads; the id will be regenerated next
      // time. (Do not log here — core has no logger; the host may.)
    }
  }
  return validated;
}

/** Validate and write the team config to `<baseDir>/team.json`. */
export function saveTeamConfig(baseDir: string, team: TeamConfig): void {
  const valid = validateTeamConfig(team);
  const filePath = getTeamConfigPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(valid, null, 2) + '\n', 'utf8');
}

/** Find a member by userId, or `undefined` when not in the team. */
export function getMember(team: TeamConfig, userId: string): TeamMember | undefined {
  assertId(userId, 'userId');
  return validateTeamConfig(team).members.find((m) => m.userId === userId);
}

/**
 * Whether the LOCAL user is a team admin (v0.85, P1-7 — the admin
 * check the desktop main wires into the coordinator child for the
 * `manage_access` tool). Reads `<baseDir>/team.json` LIVE on every
 * call, so a role change (team:set-role) takes effect without a
 * restart — same rule the desktop main already applies to its own
 * team checks (`teamAllowsEdit` / `localAutomationPolicyChecker`):
 *  - no team members configured (single-user install) → the machine
 *    owner is unrestricted (true);
 *  - owner is not a team member → not bound by team roles (true);
 *  - owner is a member → true only when their role is 'admin';
 *  - team.json unreadable / invalid → false (fail-closed: a broken
 *    team file must never silently grant admin).
 * Never throws.
 */
export function isLocalUserTeamAdmin(baseDir: string, userId: string = LOCAL_USER_ID): boolean {
  try {
    const team = loadTeamConfig(baseDir);
    if (team.members.length === 0) return true;
    const member = getMember(team, userId);
    if (!member) return true;
    return member.role === 'admin';
  } catch {
    return false;
  }
}

/** Add a member. Throws on a bad role or a duplicate userId. */
export function addMember(team: TeamConfig, member: TeamMember): TeamConfig {
  const valid = validateTeamConfig(team);
  const newMember = validateMember(member, 0);
  if (valid.members.some((m) => m.userId === newMember.userId)) {
    throw new Error(`Team member "${newMember.userId}" already exists`);
  }
  return { ...valid, members: [...valid.members, newMember] };
}

/**
 * Remove a member. Throws when the user is not in the team.
 * Bots they shared stay shared (only an admin can unshare them
 * afterwards); their `sharedBy` keeps pointing at the removed user,
 * so only admins can edit those bots from then on.
 */
export function removeMember(team: TeamConfig, userId: string): TeamConfig {
  assertId(userId, 'userId');
  const valid = validateTeamConfig(team);
  if (!valid.members.some((m) => m.userId === userId)) {
    throw new Error(`Team member "${userId}" does not exist`);
  }
  return { ...valid, members: valid.members.filter((m) => m.userId !== userId) };
}

/** Change a member's role. Throws on a bad role or an unknown user. */
export function setRole(team: TeamConfig, userId: string, role: TeamRole): TeamConfig {
  assertId(userId, 'userId');
  if (!isTeamRole(role)) {
    throw new Error(`Invalid team role "${String(role)}": must be one of ${TEAM_ROLES.join(', ')}`);
  }
  const valid = validateTeamConfig(team);
  if (!valid.members.some((m) => m.userId === userId)) {
    throw new Error(`Team member "${userId}" does not exist`);
  }
  return {
    ...valid,
    members: valid.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
  };
}

/**
 * Share a bot with the team. Only an admin or member can share;
 * viewers cannot. Throws on a bad botId, an unknown sharer, a
 * viewer sharer, or a bot that is already shared.
 */
export function shareBot(team: TeamConfig, botId: string, sharedBy: string): TeamConfig {
  assertId(botId, 'botId');
  assertId(sharedBy, 'sharedBy userId');
  const valid = validateTeamConfig(team);
  const sharer = valid.members.find((m) => m.userId === sharedBy);
  if (!sharer) {
    throw new Error(`Cannot share bot "${botId}": user "${sharedBy}" is not a team member`);
  }
  if (sharer.role === 'viewer') {
    throw new Error(`Cannot share bot "${botId}": viewers cannot share bots (user "${sharedBy}" is a viewer)`);
  }
  if (valid.sharedBots.some((b) => b.botId === botId)) {
    throw new Error(`Bot "${botId}" is already shared with this team`);
  }
  return { ...valid, sharedBots: [...valid.sharedBots, { botId, sharedBy }] };
}

/** Stop sharing a bot. Throws when the bot is not shared. */
export function unshareBot(team: TeamConfig, botId: string): TeamConfig {
  assertId(botId, 'botId');
  const valid = validateTeamConfig(team);
  if (!valid.sharedBots.some((b) => b.botId === botId)) {
    throw new Error(`Bot "${botId}" is not shared with this team`);
  }
  return { ...valid, sharedBots: valid.sharedBots.filter((b) => b.botId !== botId) };
}

/** Bot ids currently shared with the team. */
export function listSharedBots(team: TeamConfig): string[] {
  return validateTeamConfig(team).sharedBots.map((b) => b.botId);
}

function isShared(team: TeamConfig, botId: string): boolean {
  return team.sharedBots.some((b) => b.botId === botId);
}

/**
 * Can this user USE (run/chat with) this bot? The bot must be shared
 * and the user must be an admin or member. Viewers can only see
 * shared bots, not use them; non-members cannot use them either.
 */
export function canUseBot(team: TeamConfig, userId: string, botId: string): boolean {
  assertId(userId, 'userId');
  assertId(botId, 'botId');
  const valid = validateTeamConfig(team);
  if (!isShared(valid, botId)) return false;
  const member = valid.members.find((m) => m.userId === userId);
  return member !== undefined && member.role !== 'viewer';
}

/**
 * Can this user EDIT this bot? The bot must be shared and the user
 * must be an admin (edits any shared bot) or a member who shared
 * this bot themselves (sharedBy === userId). Viewers never edit.
 */
export function canEditBot(team: TeamConfig, userId: string, botId: string): boolean {
  assertId(userId, 'userId');
  assertId(botId, 'botId');
  const valid = validateTeamConfig(team);
  if (!isShared(valid, botId)) return false;
  const member = valid.members.find((m) => m.userId === userId);
  if (!member) return false;
  if (member.role === 'admin') return true;
  if (member.role === 'viewer') return false;
  const shared = valid.sharedBots.find((b) => b.botId === botId);
  return shared !== undefined && shared.sharedBy === userId;
}

// ---------------------------------------------------------------------------
// v0.5: teamId, shared workspace dir, service accounts
// ---------------------------------------------------------------------------

/**
 * Return a copy of the team guaranteed to carry a `teamId`.
 * A team without one gets a fresh uuid. Pure: the input is not
 * mutated — persist the returned config with `saveTeamConfig` so the
 * id stays stable (see `loadTeamConfig`, which does this on load).
 */
export function ensureTeamId(team: TeamConfig): TeamConfig {
  return validateTeamConfig(team);
}

/**
 * The team's stable id. When the team has none yet, a fresh uuid is
 * generated and returned — but it is NOT persisted by this call. Use
 * `ensureTeamId(team)` + `saveTeamConfig(...)` when the id must
 * survive the next load.
 */
export function getTeamId(team: TeamConfig): string {
  const valid = validateTeamConfig(team);
  return valid.teamId as string;
}

/**
 * Set (or clear) the team's shared workspace directory. Pure: returns
 * a NEW TeamConfig. An empty / whitespace-only `dir` clears the
 * setting. The path is only stored, never created or checked here —
 * the host decides whether it exists and is reachable.
 */
export function setWorkspaceDir(team: TeamConfig, dir: string): TeamConfig {
  if (typeof dir !== 'string') {
    throw new Error('Invalid team workspaceDir: must be a string');
  }
  const valid = validateTeamConfig(team);
  const trimmed = dir.trim();
  if (trimmed.length === 0) {
    const { workspaceDir: _removed, ...rest } = valid;
    return rest;
  }
  return { ...valid, workspaceDir: trimmed };
}

/** Service accounts of the team (copies — mutating them changes nothing). */
export function listServiceAccounts(team: TeamConfig): ServiceAccount[] {
  const accounts = validateTeamConfig(team).serviceAccounts ?? [];
  return accounts.map((a) => ({ ...a }));
}

export interface CreateServiceAccountInput {
  name: string;
  scope: ServiceAccountScope;
}

export interface CreateServiceAccountResult {
  /** The team with the new account added — persist with saveTeamConfig. */
  team: TeamConfig;
  /** The created record. Contains NO token (see below). */
  account: ServiceAccount;
}

/**
 * Create a service account record.
 *
 * Returns `{ team, account }` (NOT just the account): helpers here are
 * pure, so the updated team comes back alongside the created record
 * and the caller persists it with `saveTeamConfig`.
 *
 * The record contains NO token. The host (main process) must generate
 * the token itself (e.g. `crypto.randomBytes(32)`), store it in the
 * Vault under namespace 'service-account' (key = account id, see
 * `serviceAccountVaultKey`), and return it to the caller exactly ONCE
 * at creation time. The token is never readable again afterwards.
 *
 * Throws on an empty name or an unknown scope.
 */
export function createServiceAccount(
  team: TeamConfig,
  input: CreateServiceAccountInput,
): CreateServiceAccountResult {
  const valid = validateTeamConfig(team);
  assertNonEmptyString(input?.name, 'service account name');
  if (!isServiceAccountScope(input?.scope)) {
    throw new Error(
      `Invalid service account scope "${String(input?.scope)}": must be one of ${SERVICE_ACCOUNT_SCOPES.join(', ')}`,
    );
  }
  const account: ServiceAccount = {
    id: `sa-${randomUUID()}`,
    name: (input.name as string).trim(),
    scope: input.scope,
    createdAt: Date.now(),
  };
  return {
    team: { ...valid, serviceAccounts: [...(valid.serviceAccounts ?? []), account] },
    account: { ...account },
  };
}

export interface RevokeServiceAccountResult {
  /** The team with the account removed (unchanged when id was unknown). */
  team: TeamConfig;
  /** True when an account was actually removed. */
  removed: boolean;
}

/**
 * Revoke (delete) a service account record. Returns `{ team, removed }`.
 * `removed` is false when the id does not exist (not an error — revoke
 * is idempotent). The caller must ALSO delete the Vault entry
 * (`serviceAccountVaultKey(id)`) or the token stays usable.
 */
export function revokeServiceAccount(team: TeamConfig, id: string): RevokeServiceAccountResult {
  const valid = validateTeamConfig(team);
  if (typeof id !== 'string' || !SERVICE_ACCOUNT_ID_RE.test(id)) {
    throw new Error(`Invalid service account id "${String(id)}": must look like "sa-<uuid>"`);
  }
  if (!(valid.serviceAccounts ?? []).some((a) => a.id === id)) {
    return { team: valid, removed: false };
  }
  return {
    team: { ...valid, serviceAccounts: (valid.serviceAccounts ?? []).filter((a) => a.id !== id) },
    removed: true,
  };
}

/**
 * Vault composite key for a service account's token:
 * `service-account:<id>`. With the Vault API this is namespace
 * `'service-account'` + key `<id>` (see
 * `SERVICE_ACCOUNT_VAULT_NAMESPACE`). The token value itself is never
 * held here — only its address.
 */
export function serviceAccountVaultKey(id: string): string {
  if (typeof id !== 'string' || !SERVICE_ACCOUNT_ID_RE.test(id)) {
    throw new Error(`Invalid service account id "${String(id)}": must look like "sa-<uuid>"`);
  }
  return `${SERVICE_ACCOUNT_VAULT_NAMESPACE}:${id}`;
}

// ---------------------------------------------------------------------------
// P0-2: egress riêng của team
// ---------------------------------------------------------------------------

/**
 * Policy egress hiệu lực cho một team: allowlist riêng của team (nếu
 * có) merge lên trên policy chung.
 *
 *  - Team có `egress` → field team đặt thắng policy chung, field team
 *    không đặt lấy theo policy chung.
 *  - Team không có `egress` → trả về policy chung nguyên vẹn.
 *  - Cả hai đều không có (`globalPolicy` undefined và team không đặt)
 *    → trả về `undefined` — caller phải fail-closed (`unconfigured`),
 *    không tự sinh policy cho phép.
 *
 * Pure: không mutate input. Policy chung truyền vào cũng không bị đổi.
 */
export function resolveTeamEgressPolicy(
  team: TeamConfig,
  globalPolicy?: EgressPolicy,
): EgressPolicy | undefined {
  const valid = validateTeamConfig(team);
  const teamEgress = valid.egress;
  if (teamEgress === undefined) {
    return globalPolicy === undefined ? undefined : validateEgressPolicy(globalPolicy);
  }
  const override: EgressPolicy = {};
  if (teamEgress.allowHosts !== undefined) override.allowHosts = [...teamEgress.allowHosts];
  if (teamEgress.allowIpRanges !== undefined) override.allowIpRanges = [...teamEgress.allowIpRanges];
  if (teamEgress.allowPrivateDestinations !== undefined) {
    override.allowPrivateDestinations = teamEgress.allowPrivateDestinations;
  }
  if (teamEgress.githubEgressIps !== undefined) override.githubEgressIps = [...teamEgress.githubEgressIps];
  if (teamEgress.mode !== undefined) override.mode = teamEgress.mode;
  if (globalPolicy === undefined) {
    // Chỉ có team đặt: merge lên policy mặc định để các field còn lại
    // (allowLocalServices, failClosed...) có giá trị rõ ràng.
    return mergeEgressPolicies(createDefaultEgressPolicy(), override);
  }
  return mergeEgressPolicies(globalPolicy, override);
}

/**
 * Đặt (hoặc xoá) egress riêng của team. Pure: trả về TeamConfig MỚI.
 * `egress` undefined/null → xoá cấu hình egress của team (team lại
 * dùng policy chung). Validate qua `validateTeamConfig` nên entry sai
 * (host/IP/mode) ném Error rõ ràng, không ghi đè config cũ.
 */
export function setTeamEgress(team: TeamConfig, egress?: TeamEgressConfig | null): TeamConfig {
  const valid = validateTeamConfig(team);
  if (egress === undefined || egress === null) {
    const { egress: _removed, ...rest } = valid;
    return rest;
  }
  const checked = validateTeamEgress(egress);
  if (checked === undefined) {
    const { egress: _removed, ...rest } = valid;
    return rest;
  }
  return { ...valid, egress: checked };
}
