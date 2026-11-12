/**
 * Team types (LOCAL, v0.3 wave 1).
 *
 * A team is a group of users sharing bots. This is the LOCAL version:
 * the team config is a plain JSON file in the app-data directory
 * (`team.json`, see team.ts). There is NO central server, NO sync
 * between machines, NO invites and NO real authentication — userIds
 * are plain strings the host supplies and trusts. Do not treat this
 * as access control against a hostile user; it is a sharing /
 * permission model for a single trusted local install.
 *
 * Permission rules (kept simple on purpose, see team.ts):
 *  - admin: use + edit every shared bot; manage members.
 *  - member: use every shared bot; edit only bots they shared themselves.
 *  - viewer: see shared bots, but cannot use (run) or edit them.
 *  - non-member: nothing.
 *
 * `sharedBots` records WHO shared each bot (`sharedBy`, a userId) —
 * that is what the member-edit rule needs. A legacy file that still
 * has `sharedBotIds: string[]` loads with `sharedBy: ''` (unknown
 * owner: only admins can edit those bots).
 */

export type TeamRole = 'admin' | 'member' | 'viewer';

export const TEAM_ROLES: readonly TeamRole[] = ['admin', 'member', 'viewer'];

/**
 * Local user id for team checks (v0.85, P1-7): single-machine app,
 * the machine owner. The desktop main used to define this constant
 * locally ('local'); it now lives here so the coordinator child
 * process — spawned by main, no shared memory — checks the role of
 * the SAME user id when it wires `isTeamAdmin` for `manage_access`.
 */
export const LOCAL_USER_ID = 'local';

export interface TeamMember {
  userId: string;
  name: string;
  role: TeamRole;
}

/** One shared bot: which bot, and which user shared it. */
export interface SharedBot {
  botId: string;
  /** userId of the member who shared this bot ('' = unknown, legacy file). */
  sharedBy: string;
}

/**
 * Scope of a service account (v0.5).
 *  - 'run': the account may run agents / use shared bots, but may not
 *    change team membership, roles or other service accounts.
 *  - 'admin': the account may also manage the team (members, roles,
 *    other service accounts). It is still a LOCAL credential: it only
 *    means something to this install until a real server exists.
 */
export type ServiceAccountScope = 'run' | 'admin';

export const SERVICE_ACCOUNT_SCOPES: readonly ServiceAccountScope[] = ['run', 'admin'];

/**
 * A service account (v0.5): a non-human identity that runs agents on
 * behalf of the team, e.g. an automation or an external script calling
 * the local API.
 *
 * The record holds NO secret. The account's token is created by the
 * host (main process) at creation time, stored in the Vault under
 * namespace 'service-account' (see `serviceAccountVaultKey` in
 * team.ts), and returned to the caller exactly ONCE. Afterwards the
 * token can only be verified against the Vault, never read back.
 * Revoking the account removes the record here; the host must also
 * delete the Vault entry.
 */
export interface ServiceAccount {
  /** Stable id, e.g. `sa-<uuid>`. Also the Vault key inside namespace 'service-account'. */
  id: string;
  /** Human-readable name, e.g. 'CI nightly'. */
  name: string;
  scope: ServiceAccountScope;
  /** Epoch milliseconds when the account was created. */
  createdAt: number;
}

/**
 * Egress riêng của team (P0-2, REA deep-dive lần 2 §10/§13).
 *
 * Team có allowlist riêng; field nào team đặt thì thắng policy chung
 * (xem `resolveTeamEgressPolicy` trong team.ts), field nào team không
 * đặt thì lấy theo policy chung. Team không đặt gì (`egress` absent)
 * thì dùng nguyên policy chung — và khi cả hai đều không có thì egress
 * fail-closed (`unconfigured`).
 *
 * Chỉ là phần override của `EgressPolicy` (`packages/core/src/egress/`)
 * — không chứa secret, JSON-serializable, lưu trong team.json.
 */
export interface TeamEgressConfig {
  /** Host được phép (exact hoặc `*.domain`). */
  allowHosts?: string[];
  /** IP/dải IP được phép (IP đơn hoặc CIDR). */
  allowIpRanges?: string[];
  /** Cho phép đích private (LAN, localhost). Mặc định false. */
  allowPrivateDestinations?: boolean;
  /** IP/dải IP của egress tunnel được phép checkout từ GitHub. */
  githubEgressIps?: string[];
  /** 'allowlist' (mặc định) hoặc 'allow-public'. */
  mode?: 'allowlist' | 'allow-public';
}

export interface TeamConfig {
  id: string;
  name: string;
  members: TeamMember[];
  sharedBots: SharedBot[];
  /**
   * Stable team identifier (uuid, v0.5). Used to bind tokens to a team
   * (see ROADMAP §2d: token + machineId + teamId). Old team.json files
   * without it load fine — `validateTeamConfig` generates one.
   */
  teamId?: string;
  /**
   * Shared team workspace directory (v0.5), e.g. a synced folder every
   * team member points at. Empty / absent = each bot keeps its own
   * workspace dir. Only a path — the host decides whether it exists.
   */
  workspaceDir?: string;
  /** Service accounts of this team (v0.5). Absent in old files → []. */
  serviceAccounts?: ServiceAccount[];
  /**
   * Egress riêng của team (P0-2). Absent = team dùng policy chung
   * (xem `resolveTeamEgressPolicy`); có thì field team đặt thắng
   * policy chung, field không đặt lấy theo policy chung.
   */
  egress?: TeamEgressConfig;
}
