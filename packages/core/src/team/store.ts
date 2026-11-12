/**
 * TeamStore (B-platform M4, LOCAL).
 *
 * Một chỗ duy nhất để đổi team có ghi audit: mỗi mutation áp dụng
 * hàm pure trong team.ts / workspaces.ts, LƯU state xuống đĩa, rồi
 * GHI audit event. Thứ tự này có chủ ý:
 *  - Lưu trước, audit sau: nếu ghi audit lỗi thì method throw, nhưng
 *    state đã đổi — caller thấy lỗi và biết event bị thiếu (log vẫn
 *    verify được, chỉ thiếu một event, không đứt chuỗi).
 *  - Ngược lại (audit trước, lưu sau) còn tệ hơn: log sẽ ghi một thay
 *    đổi chưa từng xảy ra.
 *
 * Service account KHÔNG nằm trong store: tạo/xoá tài khoản cần sinh
 * token + ghi Vault, việc của main process (team.ts +
 * SERVICE_ACCOUNT_VAULT_NAMESPACE). Main gọi `store.audit(...)` trực
 * tiếp sau khi tạo/xoá để event vẫn vào log:
 *   store.audit('service-account.create', `service-account:${id}`, actor, { name, scope })
 *
 * Store giữ state trong bộ nhớ sau lần load đầu; `reload()` đọc lại
 * từ đĩa khi cần (vd sau khi file bị sửa ngoài).
 */

import {
  addMember,
  loadTeamConfig,
  removeMember,
  saveTeamConfig,
  setRole,
  setTeamEgress,
  setWorkspaceDir,
  shareBot,
  unshareBot,
} from './team';
import type { TeamConfig, TeamEgressConfig, TeamMember, TeamRole } from './types';
import { appendAuditEvent, listAuditEvents, verifyAuditLog } from './audit';
import type { AuditEvent, AuditListFilter, AuditVerifyResult } from './audit';
import {
  createWorkspace,
  loadWorkspaces,
  removeWorkspace,
  renameWorkspace,
  saveWorkspaces,
} from './workspaces';
import type { CreateWorkspaceInput, TeamWorkspace } from './workspaces';

export interface TeamMutationResult {
  /** Audit event vừa ghi cho mutation này. */
  event: AuditEvent;
}

function assertActor(actor: string): void {
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new Error('TeamStore: actor (người thực hiện) không được rỗng.');
  }
}

export class TeamStore {
  private readonly dir: string;
  private teamState: TeamConfig;
  private workspaceState: TeamWorkspace[];

  constructor(baseDir: string) {
    if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
      throw new Error('TeamStore cần baseDir không rỗng.');
    }
    this.dir = baseDir;
    this.teamState = loadTeamConfig(baseDir);
    this.workspaceState = loadWorkspaces(baseDir);
  }

  /** Thư mục chứa team.json / workspaces.json / audit.jsonl. */
  get baseDir(): string {
    return this.dir;
  }

  /** Team config hiện tại (đừng sửa trực tiếp — dùng các method). */
  get team(): TeamConfig {
    return this.teamState;
  }

  /** Danh sách workspace hiện tại (đừng sửa trực tiếp — dùng các method). */
  get workspaces(): TeamWorkspace[] {
    return this.workspaceState;
  }

  /** Đọc lại team.json + workspaces.json từ đĩa. */
  reload(): void {
    this.teamState = loadTeamConfig(this.dir);
    this.workspaceState = loadWorkspaces(this.dir);
  }

  /**
   * Ghi một audit event trực tiếp (cho những việc store không wrap,
   * vd tạo/xoá service account ở main). Không đổi state.
   */
  audit(
    action: string,
    target: string,
    actor: string,
    detail?: Record<string, unknown>,
  ): AuditEvent {
    assertActor(actor);
    return appendAuditEvent(this.dir, { actor, action, target, detail });
  }

  /** Kiểm tra chuỗi audit log. */
  verifyAudit(): AuditVerifyResult {
    return verifyAuditLog(this.dir);
  }

  /** Liệt kê audit event theo bộ lọc (cũ → mới). */
  listAudit(filter: AuditListFilter = {}): AuditEvent[] {
    return listAuditEvents(this.dir, filter);
  }

  // ------------------------------------------------------------------
  // Members
  // ------------------------------------------------------------------

  addMember(member: TeamMember, actor: string): TeamMutationResult {
    assertActor(actor);
    this.teamState = addMember(this.teamState, member);
    saveTeamConfig(this.dir, this.teamState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'member.add',
      target: `member:${member.userId}`,
      detail: { name: member.name, role: member.role },
    });
    return { event };
  }

  removeMember(userId: string, actor: string): TeamMutationResult {
    assertActor(actor);
    this.teamState = removeMember(this.teamState, userId);
    saveTeamConfig(this.dir, this.teamState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'member.remove',
      target: `member:${userId}`,
    });
    return { event };
  }

  setRole(userId: string, role: TeamRole, actor: string): TeamMutationResult {
    assertActor(actor);
    this.teamState = setRole(this.teamState, userId, role);
    saveTeamConfig(this.dir, this.teamState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'member.set-role',
      target: `member:${userId}`,
      detail: { role },
    });
    return { event };
  }

  // ------------------------------------------------------------------
  // Shared bots
  // ------------------------------------------------------------------

  shareBot(botId: string, sharedBy: string, actor: string): TeamMutationResult {
    assertActor(actor);
    this.teamState = shareBot(this.teamState, botId, sharedBy);
    saveTeamConfig(this.dir, this.teamState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'bot.share',
      target: `bot:${botId}`,
      detail: { sharedBy },
    });
    return { event };
  }

  unshareBot(botId: string, actor: string): TeamMutationResult {
    assertActor(actor);
    this.teamState = unshareBot(this.teamState, botId);
    saveTeamConfig(this.dir, this.teamState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'bot.unshare',
      target: `bot:${botId}`,
    });
    return { event };
  }

  // ------------------------------------------------------------------
  // Team settings
  // ------------------------------------------------------------------

  setTeamEgress(egress: TeamEgressConfig | null | undefined, actor: string): TeamMutationResult {
    assertActor(actor);
    this.teamState = setTeamEgress(this.teamState, egress);
    saveTeamConfig(this.dir, this.teamState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'team.set-egress',
      target: 'team',
      detail: egress ? { mode: egress.mode ?? 'allowlist' } : { cleared: true },
    });
    return { event };
  }

  setWorkspaceDir(dir: string, actor: string): TeamMutationResult {
    assertActor(actor);
    this.teamState = setWorkspaceDir(this.teamState, dir);
    saveTeamConfig(this.dir, this.teamState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'team.set-workspace-dir',
      target: 'team',
      detail: { dir },
    });
    return { event };
  }

  // ------------------------------------------------------------------
  // Named workspaces
  // ------------------------------------------------------------------

  createWorkspace(
    input: CreateWorkspaceInput,
    actor: string,
  ): TeamMutationResult & { workspace: TeamWorkspace } {
    assertActor(actor);
    const { workspaces, workspace } = createWorkspace(this.workspaceState, input);
    this.workspaceState = workspaces;
    saveWorkspaces(this.dir, this.workspaceState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'workspace.create',
      target: `workspace:${workspace.id}`,
      detail: { name: workspace.name, rootDir: workspace.rootDir },
    });
    return { event, workspace };
  }

  removeWorkspace(id: string, actor: string): TeamMutationResult {
    assertActor(actor);
    this.workspaceState = removeWorkspace(this.workspaceState, id);
    saveWorkspaces(this.dir, this.workspaceState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'workspace.remove',
      target: `workspace:${id}`,
    });
    return { event };
  }

  renameWorkspace(id: string, name: string, actor: string): TeamMutationResult {
    assertActor(actor);
    this.workspaceState = renameWorkspace(this.workspaceState, id, name);
    saveWorkspaces(this.dir, this.workspaceState);
    const event = appendAuditEvent(this.dir, {
      actor,
      action: 'workspace.rename',
      target: `workspace:${id}`,
      detail: { name: name.trim() },
    });
    return { event };
  }
}
