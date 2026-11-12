/**
 * Access-management tool for @open-bot/tools (v0.40, P0-3;
 * REA deep-dive lần 2 §3.4 `ManageAccessToolCall`).
 *
 * QUYẾT ĐỊNH (ghi rõ, không để lửng): làm `manage_access` thành TOOL
 * THẬT với guard chặt — KHÔNG chọn phương án "chỉ làm UI quản trị".
 * Lý do:
 *  - Grok expose quản lý quyền truy cập dưới dạng tool; parity muốn
 *    agent làm được việc này khi user yêu cầu (thêm/xoá thành viên,
 *    đổi role, share bot, quản lý service account).
 *  - Logic nghiệp vụ đã có sẵn, thuần và đã test, trong
 *    `packages/core/src/team/team.ts` (addMember/removeMember/
 *    setRole/shareBot/unshareBot/createServiceAccount/
 *    revokeServiceAccount) — tool chỉ là lớp bọc có guard, không
 *    viết lại logic.
 *  - UI quản trị desktop vẫn là đường chính cho người dùng (xem team
 *    UI), tool là đường thứ hai cho agent — cả hai cùng đọc/ghi một
 *    `team.json`, không có 2 nguồn sự thật.
 *
 * GUARD (fail-closed, 3 lớp):
 *  1. `needsApproval: true` — mọi lần gọi đều phải qua phê duyệt của
 *     user (kể cả list, vì team.json là dữ liệu nhạy cảm).
 *  2. Mọi action THAY ĐỔI (add/remove/set_role/share/unshare/
 *     create/revoke service account) yêu cầu host cấu hình callback
 *     `isAdmin(ctx)` và callback trả true. KHÔNG có callback → từ
 *     chối mọi thay đổi (không âm thầm cho qua). Callback do host
 *     (main process) quyết định "ai là admin" — tool không tự đoán
 *     từ botId. Action chỉ-đọc (list_members, list_service_accounts)
 *     không cần admin (team.json vốn đọc được bằng read_file).
 *  3. Không được xoá / giáng cấp admin cuối cùng của team (team luôn
 *     còn ít nhất 1 admin). Mọi lần thử thay đổi — được phép hay bị
 *     từ chối — đều ghi audit log JSONL vào
 *     `.open-bot/access-audit.jsonl` (thời gian, bot gọi, action,
 *     target, allowed, lý do).
 *
 * Service account: tool chỉ tạo RECORD (id/name/scope/createdAt).
 * Token KHÔNG BAO GIỜ đi qua tool: host (main process) tự sinh token,
 * lưu Vault namespace 'service-account' và trả cho người tạo ĐÚNG MỘT
 * LẦN qua UI quản trị (xem team.ts `createServiceAccount`). Revoke
 * chỉ xoá record — host phải xoá cả Vault entry (ghi rõ trong kết quả
 * trả về).
 *
 * Team config: file `team.json` dưới base dir của host
 * (`opts.teamBaseDir`, mặc định `<workspaceDir>/.open-bot/team`).
 * Đây là team LOCAL (không server, không auth thật — xem team/types.ts):
 * guard này chống agent làm bậy / nhầm lẫn, không chống được user
 * local cố tình sửa file.
 *
 * Factory:
 *   createAccessTools(opts?) -> Tool[]   (bound, usable)
 *   ACCESS_TOOLS                         (unbound placeholder: không
 *                                         có isAdmin nên mọi thay đổi
 *                                         đều bị từ chối fail-closed)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  addMember,
  createServiceAccount,
  getMember,
  listServiceAccounts,
  loadTeamConfig,
  removeMember,
  revokeServiceAccount,
  saveTeamConfig,
  setRole,
  shareBot,
  unshareBot,
} from '@open-bot/core/dist/team/team';
import {
  SERVICE_ACCOUNT_SCOPES,
  TEAM_ROLES,
} from '@open-bot/core/dist/team/types';
import type { ServiceAccountScope, TeamRole } from '@open-bot/core/dist/team/types';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };

export interface AccessToolOptions {
  /** Thư mục chứa team.json (mặc định `<workspaceDir>/.open-bot/team`). */
  teamBaseDir?: string;
  /**
   * Kiểm tra caller có phải admin team không. BẮT BUỘC cho mọi thay
   * đổi: không có callback → mọi mutation bị từ chối (fail-closed).
   * Host (main process) là bên duy nhất biết "ai là admin" — ví dụ
   * kiểm tra userId của phiên desktop hiện tại.
   */
  isAdmin?: (ctx: ToolContext) => boolean | Promise<boolean>;
}

const READ_ACTIONS = new Set(['list_members', 'list_service_accounts']);
const MUTATE_ACTIONS = new Set([
  'add_member',
  'remove_member',
  'set_role',
  'share_bot',
  'unshare_bot',
  'create_service_account',
  'revoke_service_account',
]);


function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

interface AuditEntry {
  ts: string;
  actorBotId: string;
  action: string;
  target?: string;
  allowed: boolean;
  reason?: string;
}

/** Ghi một dòng audit JSONL (best-effort — lỗi ghi không chặn tool). */
function audit(workspaceDir: string, entry: AuditEntry): void {
  try {
    const dir = path.join(workspaceDir, '.open-bot');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'access-audit.jsonl'),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    );
  } catch {
    // Audit là best-effort; không bao giờ làm hỏng thao tác chính.
  }
}

function asTeamRole(value: string): TeamRole {
  if ((TEAM_ROLES as readonly string[]).includes(value)) return value as TeamRole;
  throw new Error(`Invalid role "${value}" (expected one of: ${TEAM_ROLES.join(', ')}).`);
}

function asServiceAccountScope(value: string): ServiceAccountScope {
  if ((SERVICE_ACCOUNT_SCOPES as readonly string[]).includes(value)) {
    return value as ServiceAccountScope;
  }
  throw new Error(
    `Invalid scope "${value}" (expected one of: ${SERVICE_ACCOUNT_SCOPES.join(', ')}).`,
  );
}

export function createAccessTools(opts: AccessToolOptions = {}): Tool[] {
  const resolveBaseDir = (ctx: ToolContext): string =>
    opts.teamBaseDir ?? path.join(ctx.workspaceDir, '.open-bot', 'team');

  const manageAccess: Tool = {
    definition: toolDef(
      'manage_access',
      'Manage agent/team access (local equivalent of Grok ManageAccessToolCall): list members/service accounts, ' +
        'add/remove members, change roles, share/unshare bots, create/revoke service accounts. GUARDED: every change ' +
        'needs approval AND a host-configured admin check (without it, changes are refused fail-closed); read-only ' +
        'list actions need approval only. The last admin cannot be removed or demoted. Every change attempt is written ' +
        'to .open-bot/access-audit.jsonl. Creating a service account creates only the RECORD — its token is minted by ' +
        'the host and shown once in the admin UI, never through this tool.',
      {
        action: {
          type: 'string',
          description:
            'Action: list_members | add_member | remove_member | set_role | share_bot | unshare_bot | ' +
            'list_service_accounts | create_service_account | revoke_service_account.',
        },
        user_id: { type: 'string', description: 'User id (add_member/remove_member/set_role).' },
        name: { type: 'string', description: 'Display name (add_member) or service account name (create_service_account).' },
        role: { type: 'string', description: 'Team role for add_member/set_role: admin | member | viewer.' },
        bot_id: { type: 'string', description: 'Bot id (share_bot/unshare_bot).' },
        shared_by: { type: 'string', description: 'User id sharing the bot (share_bot).' },
        account_id: { type: 'string', description: 'Service account id, e.g. "sa-<uuid>" (revoke_service_account).' },
        scope: { type: 'string', description: 'Service account scope for create_service_account: run | admin.' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const action = getStringArg(args, 'action');
        if (!READ_ACTIONS.has(action) && !MUTATE_ACTIONS.has(action)) {
          return errorResult(
            `Unknown action "${action}" (expected one of: ${[...READ_ACTIONS, ...MUTATE_ACTIONS].join(', ')}).`,
          );
        }
        const baseDir = resolveBaseDir(ctx);
        const target =
          getOptionalStringArg(args, 'user_id') ??
          getOptionalStringArg(args, 'bot_id') ??
          getOptionalStringArg(args, 'account_id');

        // Lớp guard 2: mutation cần isAdmin — không có callback thì
        // từ chối fail-closed, và ghi audit cho lần thử bị từ chối.
        if (MUTATE_ACTIONS.has(action)) {
          let allowed = false;
          let reason: string | undefined;
          if (!opts.isAdmin) {
            reason =
              'manage_access chưa được cấu hình kiểm tra quản trị (host phải truyền isAdmin vào createAccessTools) — ' +
              'từ chối thay đổi để fail-closed. Quản trị viên hãy dùng UI quản trị team.';
          } else {
            try {
              allowed = await opts.isAdmin(ctx);
            } catch (err) {
              reason = `Kiểm tra quản trị lỗi: ${(err as Error).message} — từ chối thay đổi để fail-closed.`;
              allowed = false;
            }
            if (!allowed && reason === undefined) {
              reason = 'Caller không phải admin của team — chỉ admin mới được thay đổi quyền truy cập.';
            }
          }
          if (!allowed) {
            audit(ctx.workspaceDir, {
              ts: new Date().toISOString(),
              actorBotId: ctx.botId,
              action,
              ...(target ? { target } : {}),
              allowed: false,
              reason,
            });
            return errorResult(reason ?? 'Không có quyền thay đổi quyền truy cập.');
          }
        }

        const team = loadTeamConfig(baseDir);
        const done = (message: string): string => {
          if (MUTATE_ACTIONS.has(action)) {
            audit(ctx.workspaceDir, {
              ts: new Date().toISOString(),
              actorBotId: ctx.botId,
              action,
              ...(target ? { target } : {}),
              allowed: true,
            });
          }
          return message;
        };

        switch (action) {
          case 'list_members': {
            if (team.members.length === 0) return '(no team members yet)';
            return truncate(
              `Team "${team.name}" — ${team.members.length} member(s):\n` +
                team.members.map((m) => `- ${m.userId} — ${m.name} (${m.role})`).join('\n'),
            );
          }
          case 'add_member': {
            const userId = getStringArg(args, 'user_id').trim();
            const name = getStringArg(args, 'name').trim();
            const role = asTeamRole(getStringArg(args, 'role'));
            if (!userId) throw new Error('user_id không được rỗng.');
            if (getMember(team, userId)) {
              return errorResult(`Member "${userId}" already exists (use set_role to change their role).`);
            }
            saveTeamConfig(baseDir, addMember(team, { userId, name, role }));
            return done(`Added member "${userId}" (${name}) with role "${role}".`);
          }
          case 'remove_member': {
            const userId = getStringArg(args, 'user_id').trim();
            const member = getMember(team, userId);
            if (!member) return errorResult(`Unknown member "${userId}" (nothing removed).`);
            // Lớp guard 3: không xoá admin cuối cùng.
            if (member.role === 'admin' && team.members.filter((m) => m.role === 'admin').length <= 1) {
              return errorResult(
                `Cannot remove "${userId}": they are the last admin of the team (a team must keep at least one admin).`,
              );
            }
            saveTeamConfig(baseDir, removeMember(team, userId));
            return done(`Removed member "${userId}".`);
          }
          case 'set_role': {
            const userId = getStringArg(args, 'user_id').trim();
            const role = asTeamRole(getStringArg(args, 'role'));
            const member = getMember(team, userId);
            if (!member) return errorResult(`Unknown member "${userId}".`);
            // Lớp guard 3: không giáng cấp admin cuối cùng.
            if (
              member.role === 'admin' &&
              role !== 'admin' &&
              team.members.filter((m) => m.role === 'admin').length <= 1
            ) {
              return errorResult(
                `Cannot demote "${userId}": they are the last admin of the team (a team must keep at least one admin).`,
              );
            }
            saveTeamConfig(baseDir, setRole(team, userId, role));
            return done(`Member "${userId}" is now "${role}".`);
          }
          case 'share_bot': {
            const botId = getStringArg(args, 'bot_id').trim();
            const sharedBy = getStringArg(args, 'shared_by').trim();
            if (!botId) throw new Error('bot_id không được rỗng.');
            saveTeamConfig(baseDir, shareBot(team, botId, sharedBy));
            return done(`Bot "${botId}" is now shared with the team (shared by "${sharedBy}").`);
          }
          case 'unshare_bot': {
            const botId = getStringArg(args, 'bot_id').trim();
            saveTeamConfig(baseDir, unshareBot(team, botId));
            return done(`Bot "${botId}" is no longer shared with the team.`);
          }
          case 'list_service_accounts': {
            const accounts = listServiceAccounts(team);
            if (accounts.length === 0) return '(no service accounts yet)';
            return truncate(
              `Service accounts (${accounts.length}):\n` +
                accounts
                  .map((a) => `- ${a.id} — ${a.name} (scope ${a.scope}, created ${new Date(a.createdAt).toISOString()})`)
                  .join('\n'),
            );
          }
          case 'create_service_account': {
            const name = getStringArg(args, 'name').trim();
            const scope = asServiceAccountScope(getStringArg(args, 'scope'));
            const { team: next, account } = createServiceAccount(team, { name, scope });
            saveTeamConfig(baseDir, next);
            return done(
              `Created service account "${account.id}" (${account.name}, scope ${account.scope}).\n` +
                'NOTE: only the RECORD was created — its token is NOT here and never goes through this tool. ' +
                'The host (main process) must mint the token, store it in the Vault under namespace ' +
                `'service-account' and show it to the creator EXACTLY ONCE in the admin UI. ` +
                'Revoke the account if its token ever leaks.',
            );
          }
          case 'revoke_service_account': {
            const accountId = getStringArg(args, 'account_id').trim();
            const { team: next, removed } = revokeServiceAccount(team, accountId);
            if (!removed) return errorResult(`Unknown service account "${accountId}" (nothing revoked).`);
            saveTeamConfig(baseDir, next);
            return done(
              `Revoked service account "${accountId}".\n` +
                'NOTE: the record is deleted, but the host must ALSO delete its Vault entry ' +
                `('service-account:${accountId}') or the token stays usable.`,
            );
          }
          default:
            return errorResult(`Unknown action "${action}".`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [manageAccess];
}

/** Unbound placeholder (same pattern as other tool groups): no isAdmin, so every mutation is refused fail-closed. */
export const ACCESS_TOOLS: Tool[] = createAccessTools();

export type { AccessToolOptions as AccessToolsOptions };
