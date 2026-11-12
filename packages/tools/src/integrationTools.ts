/**
 * Integration tools for @open-bot/tools (v0.7) — session box (local),
 * Slack / Gmail / Teams / iMessage / meeting, bộ nhớ dài hạn.
 *
 * ROADMAP §2c: session box, tích hợp Slack/email/Teams/iMessage/
 * meeting, connectors OAuth, bộ nhớ dài hạn.
 *
 * Cách tool chạm tới thế giới ngoài (tất cả qua callback do host cấp —
 * file này KHÔNG hard-code token/key, KHÔNG đọc settings.json):
 *  - Slack: opts.getSlackToken() — host đọc Vault namespace
 *    `connector`, key `slack` (xem core connectors/framework.ts).
 *  - Gmail: opts.getGmailToken() — Vault `connector` / key `gmail`.
 *  - Teams: opts.getTeamsToken() — Vault `connector` / key `teams`.
 *  - getConnectorToken(connectorId) — fallback chung cho cả ba khi
 *    callback riêng không có (trả về access token, hoặc null).
 *  - getConnectorTokenProvider(connectorId) — v0.9d: provider token có
 *    auto-refresh (refresh trước 5 phút, retry 401 cho GET). Khi có,
 *    connector dùng provider thay cho token tĩnh; khi không có, dùng
 *    token tĩnh như cũ.
 *  - GitHub: opts.getGitHubToken() — host đọc Vault namespace `github`,
 *    key `token` (PAT do user dán vào, xem M7 app 'github'). 7 tool API
 *    GitHub + `set_active_branch` (git checkout local) đều đi qua
 *    createGitTools — factory này chỉ gom lại để M7 `createAppTools`
 *    lọc được theo catalog; logic tool vẫn nằm ở gitTools.ts.
 *  - fetchFn: fetch injectable (test dùng mock; mặc định global fetch).
 *  - memory: BotMemory của host — transcript_archive và
 *    team_context_summary cần nó để đọc history/task.
 *  - platform: ghi đè process.platform cho imessage_draft (test).
 *
 * Approval: tool GỬI ra ngoài (slack_send, email_send, teams_send) và
 * tool thay đổi trạng thái (session create/snapshot/restore/destroy,
 * memory_forget) -> true; tool ĐỌC (list/read/recall/summarize) -> false.
 * Token chỉ đi trong header Authorization, không bao giờ log.
 *
 * Factory:
 *   createIntegrationTools(opts?) -> Tool[]   (bound, usable)
 *   INTEGRATION_TOOLS                         (unbound placeholder:
 *                                            chưa có token callback nên
 *                                            tool ngoài trả lỗi "chưa kết
 *                                            nối" rõ ràng)
 *
 * Giới hạn thật (ghi trong description từng tool):
 *  - session box là BẢN LOCAL (thư mục tách biệt + snapshot), không
 *    phải hộp cát phía server; giới hạn tài nguyên chỉ là metadata.
 *  - iMessage chỉ soạn NHÁP, không bao giờ tự gửi; trên Linux/Windows
 *    chỉ ghi file nháp.
 *  - meeting chưa tự tham gia meeting thật; tóm tắt rule-based, không
 *    gọi model.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotMemory, ConnectorTokenProvider, Tool, ToolContext } from '@open-bot/core';
import {
  createSession,
  destroySession,
  listSessions,
  listSnapshots,
  replaceSessionEnv,
  restoreSession,
  snapshotSession,
} from '@open-bot/core/dist/session/box';
import {
  draftImessage,
  IMESSAGE_DRAFTS_REL_DIR,
} from '@open-bot/core/dist/connectors/imessage';
import { appIdForTool, getAppToolNames } from '@open-bot/core/dist/apps/catalog';
import {
  importTranscript,
  listStoredTranscripts,
  summarizeStoredTranscript,
} from '@open-bot/core/dist/connectors/meeting';
import {
  archiveTranscript,
  loadTranscriptArchive,
  LongTermMemory,
  searchTranscriptArchive,
  teamContextSummary,
} from '@open-bot/core/dist/memory/longterm';
import { OllamaEmbeddings } from '@open-bot/core/dist/memory/embeddings.js';
import {
  gmailGetMessage,
  gmailListMessages,
  gmailSendMessage,
} from '@open-bot/core/dist/connectors/email';
import { createGitTools } from './gitTools';
import {
  slackListChannels,
  slackReadChannel,
  slackSendMessage,
} from '@open-bot/core/dist/connectors/slack';
import {
  teamsListChannels,
  teamsListTeams,
  teamsSendChannelMessage,
} from '@open-bot/core/dist/connectors/teams';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };

export type TokenCallback = () => string | null | Promise<string | null>;

export interface IntegrationToolOptions {
  /** Slack user/bot token (host đọc Vault `connector` / key `slack`). */
  getSlackToken?: TokenCallback;
  /** Gmail OAuth access token (host đọc Vault `connector` / key `gmail`). */
  getGmailToken?: TokenCallback;
  /** Teams/Graph OAuth access token (Vault `connector` / key `teams`). */
  getTeamsToken?: TokenCallback;
  /**
   * v0.68b: GitHub personal access token (host đọc Vault `github` /
   * key `token` — PAT do user dán vào qua Connected apps). Khi có,
   * 7 tool API GitHub của M7 app 'github' chạy được; khi không có,
   * chúng báo lỗi "chưa kết nối" rõ ràng như tool Slack/Gmail/Teams
   * (gitTools tự ném lỗi khi thiếu callback, execute bắt lại thành
   * Error: ...). `set_active_branch` không cần token (git local).
   */
  getGitHubToken?: TokenCallback;
  /** Fallback chung: access token theo connector id ('slack'|'gmail'|'teams'). */
  getConnectorToken?: (connectorId: string) => string | null | Promise<string | null>;
  /**
   * v0.9d: provider token có auto-refresh theo connector id (host cấp
   * qua coordinator — xem core coordinator/coordinator.ts). Khi có,
   * mỗi call lấy token qua provider (tự refresh trước 5 phút, dedup;
   * GET gặp 401 thì force refresh + retry 1 lần); khi không có, dùng
   * token tĩnh từ getConnectorToken như cũ. Provider không bao giờ
   * mang refresh token hay client secret ra ngoài host.
   */
  getConnectorTokenProvider?: (connectorId: string) => ConnectorTokenProvider | null;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: typeof fetch;
  /** BotMemory của host (transcript_archive, team_context_summary). */
  memory?: BotMemory;
  /** Ghi đè platform cho imessage_draft (mặc định process.platform). */
  platform?: NodeJS.Platform;
}


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

function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`Argument "${name}" must be a positive number.`);
  }
  return Math.min(Math.floor(value), max);
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
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

const NOT_CONNECTED =
  'Chưa kết nối: host chưa cấp token callback cho connector này (createIntegrationTools cần getSlackToken/getGmailToken/getTeamsToken hoặc getConnectorToken — token đọc từ Vault, không hard-code).';

export function createIntegrationTools(opts: IntegrationToolOptions = {}): Tool[] {
  const fetchFn = opts.fetchFn;
  const memory = opts.memory;

  async function resolveToken(
    specific: TokenCallback | undefined,
    connectorId: string,
  ): Promise<string | null> {
    if (specific) {
      const token = await specific();
      if (token) return token;
    }
    if (opts.getConnectorToken) return opts.getConnectorToken(connectorId);
    return null;
  }

  const slackOpts = () => ({
    getToken: () => resolveToken(opts.getSlackToken, 'slack'),
    ...withProvider('slack'),
    ...(fetchFn ? { fetchFn } : {}),
  });
  const gmailOpts = () => ({
    getToken: () => resolveToken(opts.getGmailToken, 'gmail'),
    ...withProvider('gmail'),
    ...(fetchFn ? { fetchFn } : {}),
  });
  const teamsOpts = () => ({
    getToken: () => resolveToken(opts.getTeamsToken, 'teams'),
    ...withProvider('teams'),
    ...(fetchFn ? { fetchFn } : {}),
  });

  /**
   * v0.9d: lấy provider auto-refresh cho một connector (mới mỗi lần
   * gọi — coordinator dựng provider mới mỗi lần nên client config mới
   * nhất luôn được dùng). Trả {} khi không có provider để options của
   * connector giữ nguyên kiểu cũ (chỉ có getToken tĩnh).
   */
  function withProvider(
    connectorId: string,
  ): { tokenProvider: ConnectorTokenProvider } | Record<string, never> {
    const provider = opts.getConnectorTokenProvider?.(connectorId);
    return provider ? { tokenProvider: provider } : {};
  }

  // -------------------------------------------------------------------------
  // Session box (local)
  // -------------------------------------------------------------------------

  const sessionBoxCreateTool: Tool = {
    definition: toolDef(
      'session_box_create',
      'Create a LOCAL session box (local equivalent of a server-side session box): an isolated workspace directory ' +
        'under .open-bot/sessions/<id>/workspace with its own env allowlist (names only, never values) and resource limits ' +
        'recorded as metadata. NOT a server sandbox, NOT a VM/container — limits are metadata only, not enforced.',
      {
        name: { type: 'string', description: 'Session name: letters, digits, ".", "-" and "_" only.' },
        env_vars: { type: 'array', items: { type: 'string' }, description: 'Extra env var NAMES to allow (names only; secret-looking names are rejected).' },
        max_files: { type: 'number', description: 'Max files in the session workspace (metadata only, not enforced).' },
        max_total_bytes: { type: 'number', description: 'Max total bytes in the session workspace (metadata only, not enforced).' },
        timeout_ms: { type: 'number', description: 'Default command timeout in ms (metadata only).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const name = getOptionalStringArg(args, 'name');
        const envVars = getStringArrayArg(args, 'env_vars');
        const limits: { maxFiles?: number; maxTotalBytes?: number; timeoutMs?: number } = {};
        if (args['max_files'] !== undefined) limits.maxFiles = getNumberArg(args, 'max_files', 0, Number.MAX_SAFE_INTEGER);
        if (args['max_total_bytes'] !== undefined) limits.maxTotalBytes = getNumberArg(args, 'max_total_bytes', 0, Number.MAX_SAFE_INTEGER);
        if (args['timeout_ms'] !== undefined) limits.timeoutMs = getNumberArg(args, 'timeout_ms', 0, Number.MAX_SAFE_INTEGER);
        const session = createSession(ctx.workspaceDir, {
          ...(name ? { name } : {}),
          envVars,
          limits,
        });
        return truncate(
          JSON.stringify(
            {
              id: session.id,
              name: session.name,
              workspaceDir: session.workspaceDir,
              envAllowlist: session.envAllowlist,
              limits: session.limits,
              status: session.status,
              note: 'LOCAL session box — isolated directory + metadata limits, not a server sandbox/VM.',
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionBoxSnapshotTool: Tool = {
    definition: toolDef(
      'session_box_snapshot',
      'Snapshot a local session box: copy all files in its workspace to .open-bot/sessions/<id>/snapshots/<snapshotId>/ ' +
        'with a manifest (path, size, sha256) so the session can be restored later. Local only — not a server snapshot.',
      {
        session_id: { type: 'string', description: 'Session id returned by session_box_create.' },
        note: { type: 'string', description: 'Optional note stored in the snapshot manifest.' },
      },
      ['session_id'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const sessionId = getStringArg(args, 'session_id');
        const note = getOptionalStringArg(args, 'note');
        const snap = snapshotSession(ctx.workspaceDir, sessionId, note);
        return truncate(
          JSON.stringify(
            { snapshotId: snap.id, sessionId: snap.sessionId, files: snap.files.length, createdAt: snap.createdAt },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionBoxRestoreTool: Tool = {
    definition: toolDef(
      'session_box_restore',
      'Restore a local session box from a snapshot (defaults to the newest snapshot): replaces the session workspace ' +
        'contents with the snapshot files. Local only — not a server restore.',
      {
        session_id: { type: 'string', description: 'Session id returned by session_box_create.' },
        snapshot_id: { type: 'string', description: 'Snapshot id (optional; defaults to the newest snapshot).' },
      },
      ['session_id'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const sessionId = getStringArg(args, 'session_id');
        const snapshotId = getOptionalStringArg(args, 'snapshot_id');
        const session = restoreSession(ctx.workspaceDir, sessionId, snapshotId);
        return JSON.stringify(
          { id: session.id, status: session.status, workspaceDir: session.workspaceDir, lastSnapshotId: session.lastSnapshotId ?? null },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionBoxListTool: Tool = {
    definition: toolDef(
      'session_box_list',
      'List local session boxes in the workspace (id, name, status, workspace dir, last snapshot). Local only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const sessions = listSessions(ctx.workspaceDir);
        if (sessions.length === 0) return '(no local session boxes yet — create one with session_box_create)';
        const lines = sessions.map((s) => {
          const snaps = listSnapshots(ctx.workspaceDir, s.id).length;
          return `- ${s.id} — "${s.name}" (${s.status}, ${snaps} snapshot(s), workspace: ${s.workspaceDir})`;
        });
        return truncate(`Local session boxes (${sessions.length}):\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionBoxDestroyTool: Tool = {
    definition: toolDef(
      'session_box_destroy',
      'Permanently delete a local session box (workspace + snapshots). Cannot be undone. Local only.',
      {
        session_id: { type: 'string', description: 'Session id to delete.' },
      },
      ['session_id'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const sessionId = getStringArg(args, 'session_id');
        const deleted = destroySession(ctx.workspaceDir, sessionId);
        return deleted ? `Deleted local session box "${sessionId}".` : `Unknown session box "${sessionId}" (nothing deleted).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionBoxReplaceEnvTool: Tool = {
    definition: toolDef(
      'session_box_replace_env',
      'Change the environment variables of a RUNNING local session box (local equivalent of Grok ReplaceEnvToolCall, ' +
        'associated_pod_key = session_id) WITHOUT recreating the box. Only env var NAMES are stored (never values — ' +
        'secret-looking names are rejected, same rule as session_box_create). By default the allowlist is REPLACED ' +
        'wholesale; pass merge=true to only ADD names to the current allowlist. The new env applies to commands run ' +
        'in the box AFTER the change — a process already running keeps its old env (local box has no live-process ' +
        'injection). Needs approval.',
      {
        session_id: { type: 'string', description: 'Session id returned by session_box_create.' },
        env_vars: { type: 'array', items: { type: 'string' }, description: 'Env var NAMES for the new allowlist (names only; secret-looking names are rejected).' },
        merge: { type: 'boolean', description: 'true = add env_vars to the current allowlist instead of replacing it (default false = replace).' },
      },
      ['session_id', 'env_vars'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const sessionId = getStringArg(args, 'session_id');
        const envVars = getStringArrayArg(args, 'env_vars');
        const merge = getBoolArg(args, 'merge', false);
        const session = replaceSessionEnv(ctx.workspaceDir, sessionId, envVars, { merge });
        return truncate(
          JSON.stringify(
            {
              id: session.id,
              name: session.name,
              status: session.status,
              envAllowlist: session.envAllowlist,
              updatedAt: session.updatedAt,
              note: 'Env allowlist updated in place — no box recreated. New env applies to commands run in the box from now on.',
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Slack
  // -------------------------------------------------------------------------

  const slackSendTool: Tool = {
    definition: toolDef(
      'slack_send',
      'Send a message to a Slack channel via chat.postMessage (public Slack API, user token from the host Vault callback). ' +
        'Needs approval. Fails with a clear "not connected" error when no Slack token is wired up.',
      {
        channel: { type: 'string', description: 'Slack channel id (e.g. C0123456789).' },
        text: { type: 'string', description: 'Message text to send.' },
      },
      ['channel', 'text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const channel = getStringArg(args, 'channel');
        const text = getStringArg(args, 'text');
        const token = await resolveToken(opts.getSlackToken, 'slack');
        if (!token) return errorResult(NOT_CONNECTED);
        const sent = await slackSendMessage(slackOpts(), channel, text);
        return `Sent to Slack channel ${sent.channel} (ts ${sent.ts}).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const slackListChannelsTool: Tool = {
    definition: toolDef(
      'slack_list_channels',
      'List Slack channels in the connected workspace (public Slack API, user token from the host Vault callback). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const token = await resolveToken(opts.getSlackToken, 'slack');
        if (!token) return errorResult(NOT_CONNECTED);
        const channels = await slackListChannels(slackOpts());
        if (channels.length === 0) return '(no Slack channels found)';
        return truncate(
          `Slack channels (${channels.length}):\n` +
            channels.map((c) => `- ${c.id} — #${c.name}${c.isPrivate ? ' (private)' : ''}`).join('\n'),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const slackReadTool: Tool = {
    definition: toolDef(
      'slack_read',
      'Read the N most recent messages of a Slack channel via conversations.history (public Slack API, user token from the host Vault callback). Read-only.',
      {
        channel: { type: 'string', description: 'Slack channel id (e.g. C0123456789).' },
        limit: { type: 'number', description: 'Max messages to return (default 20, capped at 100).' },
      },
      ['channel'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const channel = getStringArg(args, 'channel');
        const limit = getNumberArg(args, 'limit', 20, 100);
        const token = await resolveToken(opts.getSlackToken, 'slack');
        if (!token) return errorResult(NOT_CONNECTED);
        const messages = await slackReadChannel(slackOpts(), channel, limit);
        if (messages.length === 0) return `(no messages in Slack channel ${channel})`;
        return truncate(
          `Slack #${channel} — ${messages.length} message(s):\n` +
            messages.map((m) => `[${m.ts ?? '?'}] ${m.user ?? '?'}: ${m.text ?? ''}`).join('\n'),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Email (Gmail API)
  // -------------------------------------------------------------------------

  const emailReadTool: Tool = {
    definition: toolDef(
      'email_read',
      'Read the Gmail inbox via the public Gmail API (list + get message, OAuth token of the user from the host Vault callback). ' +
        'NOT IMAP. Give a message_id to read one message in full, or a query to list matching messages. Read-only. ' +
        'Fails with a clear "not connected" error when no Gmail token is wired up.',
      {
        message_id: { type: 'string', description: 'Gmail message id to read in full (optional — when omitted, lists inbox messages).' },
        query: { type: 'string', description: 'Gmail search query for listing (e.g. "from:boss newer_than:7d"). Default: inbox.' },
        limit: { type: 'number', description: 'Max messages to list (default 10, capped at 100).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const token = await resolveToken(opts.getGmailToken, 'gmail');
        if (!token) return errorResult(NOT_CONNECTED);
        const messageId = getOptionalStringArg(args, 'message_id');
        if (messageId) {
          const msg = await gmailGetMessage(gmailOpts(), messageId);
          return truncate(
            `From: ${msg.from ?? '?'}\nSubject: ${msg.subject ?? '(no subject)'}\nDate: ${msg.date ?? '?'}\n\n${msg.body ?? msg.snippet ?? '(no body)'}`,
          );
        }
        const query = getOptionalStringArg(args, 'query') ?? '';
        const limit = getNumberArg(args, 'limit', 10, 100);
        const messages = await gmailListMessages(gmailOpts(), query, limit);
        if (messages.length === 0) return '(no Gmail messages found)';
        return truncate(
          `Gmail messages (${messages.length}):\n` +
            messages.map((m) => `- ${m.id}${m.threadId ? ` (thread ${m.threadId})` : ''}`).join('\n'),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const emailSendTool: Tool = {
    definition: toolDef(
      'email_send',
      'Send an email via the public Gmail API (messages.send, OAuth token of the user from the host Vault callback). ' +
        'Needs approval. Fails with a clear "not connected" error when no Gmail token is wired up.',
      {
        to: { type: 'string', description: 'Recipient email address (comma-separated for several).' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Email body (plain text).' },
        cc: { type: 'string', description: 'Optional Cc address(es).' },
      },
      ['to', 'subject', 'body'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const to = getStringArg(args, 'to');
        const subject = getStringArg(args, 'subject');
        const body = getStringArg(args, 'body');
        const cc = getOptionalStringArg(args, 'cc');
        const token = await resolveToken(opts.getGmailToken, 'gmail');
        if (!token) return errorResult(NOT_CONNECTED);
        const sent = await gmailSendMessage(gmailOpts(), { to, subject, body, ...(cc ? { cc } : {}) });
        return `Sent email via Gmail (message id ${sent.id}).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Microsoft Teams (Graph)
  // -------------------------------------------------------------------------

  const teamsSendTool: Tool = {
    definition: toolDef(
      'teams_send',
      'Send a message to a Microsoft Teams channel via Microsoft Graph (user OAuth token from the host Vault callback). ' +
        'Needs approval. Fails with a clear "not connected" error when no Teams token is wired up.',
      {
        team_id: { type: 'string', description: 'Teams team id.' },
        channel_id: { type: 'string', description: 'Teams channel id within the team.' },
        text: { type: 'string', description: 'Message text to send.' },
      },
      ['team_id', 'channel_id', 'text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const teamId = getStringArg(args, 'team_id');
        const channelId = getStringArg(args, 'channel_id');
        const text = getStringArg(args, 'text');
        const token = await resolveToken(opts.getTeamsToken, 'teams');
        if (!token) return errorResult(NOT_CONNECTED);
        const sent = await teamsSendChannelMessage(teamsOpts(), teamId, channelId, text);
        return `Sent to Teams channel ${channelId} (message id ${sent.id}).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const teamsListTeamsTool: Tool = {
    definition: toolDef(
      'teams_list_teams',
      'List Microsoft Teams the user has joined via Microsoft Graph (user OAuth token from the host Vault callback). ' +
        'Use teams_list_channels via team id afterwards — channel listing is part of teams_send flow inputs. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const token = await resolveToken(opts.getTeamsToken, 'teams');
        if (!token) return errorResult(NOT_CONNECTED);
        const teams = await teamsListTeams(teamsOpts());
        if (teams.length === 0) return '(no Teams teams found)';
        const lines: string[] = [];
        for (const t of teams) {
          let channels = '';
          try {
            const list = await teamsListChannels(teamsOpts(), t.id);
            channels = list.length > 0 ? ` — channels: ${list.map((c) => `${c.displayName} (${c.id})`).join(', ')}` : ' — (no channels)';
          } catch {
            channels = ' — (could not list channels)';
          }
          lines.push(`- ${t.id} — ${t.displayName}${channels}`);
        }
        return truncate(`Teams (${teams.length}):\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // -------------------------------------------------------------------------
  // iMessage (draft only)
  // -------------------------------------------------------------------------

  const imessageDraftTool: Tool = {
    definition: toolDef(
      'imessage_draft',
      'Draft an iMessage — DRAFT ONLY, never sends. iMessage has no public API. On macOS it opens the Messages app compose ' +
        'window with recipient + text prefilled (you press Send yourself); on Linux/Windows it writes a draft file to ' +
        `.open-bot/imessage-drafts/<id>.txt with instructions. The result always says sent: false — this tool never pretends it sent anything.`,
      {
        to: { type: 'string', description: 'Recipient (phone number or Apple ID email).' },
        body: { type: 'string', description: 'Message text for the draft.' },
      },
      ['to', 'body'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const to = getStringArg(args, 'to');
        const body = getStringArg(args, 'body');
        const draft = draftImessage({
          to,
          body,
          workspaceDir: ctx.workspaceDir,
          ...(opts.platform ? { platform: opts.platform } : {}),
        });
        return truncate(
          JSON.stringify(
            {
              id: draft.id,
              to: draft.to,
              sent: draft.sent,
              method: draft.method,
              ...(draft.path ? { draftFile: path.relative(ctx.workspaceDir, draft.path) } : {}),
              note: draft.note,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Meeting (import transcript + rule-based summary)
  // -------------------------------------------------------------------------

  const meetingTranscriptTool: Tool = {
    definition: toolDef(
      'meeting_transcript',
      'Import a meeting transcript from a file in the workspace (txt/vtt/srt/json) or an http(s) URL, store it under ' +
        '.open-bot/meetings/<id>.json, and return a rule-based summary. This does NOT join a real meeting — joining a meeting ' +
        'needs the meeting provider bot infrastructure, which open-bot does not have.',
      {
        source: { type: 'string', description: 'File path inside the workspace, or an http(s) URL, of the transcript.' },
        title: { type: 'string', description: 'Optional title for the stored transcript.' },
      },
      ['source'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const source = getStringArg(args, 'source');
        const title = getOptionalStringArg(args, 'title');
        const { transcript, summary } = await importTranscript(ctx.workspaceDir, source, {
          ...(title ? { title } : {}),
          ...(fetchFn ? { fetchFn } : {}),
        });
        return truncate(
          `Imported meeting transcript "${transcript.title}" (id ${transcript.id}, format ${transcript.format}, ${transcript.segments.length} segment(s)).\n\n` +
            `Summary (rule-based, no model call):\n${summary.summary}\n\n` +
            (summary.decisions.length > 0 ? `Decisions:\n${summary.decisions.map((d) => `- ${d}`).join('\n')}\n\n` : '') +
            (summary.actionItems.length > 0 ? `Action items:\n${summary.actionItems.map((a) => `- ${a}`).join('\n')}` : ''),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const meetingSummarizeTool: Tool = {
    definition: toolDef(
      'meeting_summarize',
      'Summarize an already-imported meeting transcript by id (rule-based summary — extracts key sentences per segment, ' +
        'no model/API call). Lists stored transcripts when no id is given.',
      {
        transcript_id: { type: 'string', description: 'Id of the stored transcript (from meeting_transcript). Omit to list stored transcripts.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const transcriptId = getOptionalStringArg(args, 'transcript_id');
        if (!transcriptId) {
          const stored = listStoredTranscripts(ctx.workspaceDir);
          if (stored.length === 0) return '(no meeting transcripts imported yet — use meeting_transcript first)';
          return truncate(
            `Stored meeting transcripts (${stored.length}):\n` +
              stored.map((t) => `- ${t.id} — "${t.title}" (${t.format}, ${t.segments.length} segment(s), ${t.importedAt})`).join('\n'),
          );
        }
        const { transcript, summary } = summarizeStoredTranscript(ctx.workspaceDir, transcriptId);
        return truncate(
          `Summary of "${transcript.title}" (rule-based, no model call):\n${summary.summary}\n\n` +
            (summary.decisions.length > 0 ? `Decisions:\n${summary.decisions.map((d) => `- ${d}`).join('\n')}\n\n` : '') +
            (summary.actionItems.length > 0 ? `Action items:\n${summary.actionItems.map((a) => `- ${a}`).join('\n')}` : ''),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Long-term memory
  // -------------------------------------------------------------------------

  const memoryRememberTool: Tool = {
    definition: toolDef(
      'memory_remember',
      'Remember a long-term fact/preference (key, value, tags, confidence 0..1) in .open-bot/memories.json. ' +
        'Same (bot, key) overwrites the previous value. With embed=true, also stores a real Ollama embedding vector ' +
        'for the memory (local, model nomic-embed-text) so semantic recall can rank it; if Ollama is down the memory ' +
        'is still saved, just without a vector. Local only.',
      {
        key: { type: 'string', description: 'Memory key, e.g. "user.prefers_language".' },
        value: { type: 'string', description: 'The fact/preference to remember.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for recall.' },
        confidence: { type: 'number', description: 'Confidence 0..1 (default 0.8).' },
        embed: {
          type: 'boolean',
          description: 'Also store an Ollama embedding vector for this memory (default false).',
        },
        ollama_base_url: {
          type: 'string',
          description: 'Base URL của Ollama khi embed=true (mặc định http://127.0.0.1:11434).',
        },
        ollama_model: {
          type: 'string',
          description: 'Model embedding của Ollama khi embed=true (mặc định nomic-embed-text).',
        },
      },
      ['key', 'value'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const key = getStringArg(args, 'key');
        const value = getStringArg(args, 'value');
        const tags = getStringArrayArg(args, 'tags');
        let confidence: number | undefined;
        if (args['confidence'] !== undefined && args['confidence'] !== null) {
          const raw = args['confidence'];
          if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
            return errorResult('Argument "confidence" must be a number between 0 and 1.');
          }
          confidence = raw;
        }
        const store = new LongTermMemory(ctx.workspaceDir);
        const wantEmbed = getBoolArg(args, 'embed', false);
        if (!wantEmbed) {
          const entry = store.remember({ key, value, tags, confidence, botId: ctx.botId });
          return `Remembered "${entry.key}" (confidence ${entry.confidence.toFixed(2)}${entry.tags.length > 0 ? `, tags: ${entry.tags.join(', ')}` : ''}).`;
        }
        const baseUrl = getOptionalStringArg(args, 'ollama_base_url') || undefined;
        const model = getOptionalStringArg(args, 'ollama_model') || undefined;
        const embeddings = new OllamaEmbeddings({
          ...(baseUrl ? { baseUrl } : {}),
          ...(model ? { model } : {}),
        });
        const result = await store.rememberWithEmbedding(
          { key, value, tags, confidence, botId: ctx.botId },
          embeddings,
        );
        const entry = result.entry;
        const suffix = result.embedded
          ? ` Đã lưu vector embedding (model ${embeddings.model}).`
          : ` Chưa lưu được vector embedding: ${result.error ?? 'không rõ lý do'} — memory vẫn đã lưu, recall ngữ nghĩa sẽ fallback về từ khoá.`;
        return `Remembered "${entry.key}" (confidence ${entry.confidence.toFixed(2)}${entry.tags.length > 0 ? `, tags: ${entry.tags.join(', ')}` : ''}).${suffix}`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryRecallTool: Tool = {
    definition: toolDef(
      'memory_recall',
      'Recall long-term memories by keyword and/or tag (searches key, value and tags; ranked by keyword matches x confidence). ' +
        'With mode="semantic", ranks by cosine similarity of real Ollama embeddings instead (local, model nomic-embed-text; ' +
        'memories without a vector are embedded on the fly and cached); when Ollama is unavailable or no memory has a vector, ' +
        'it falls back to keyword search and says so. No query/tag returns the most recent memories. Local only.',
      {
        query: { type: 'string', description: 'Keywords to search for.' },
        tag: { type: 'string', description: 'Tag to filter by.' },
        limit: { type: 'number', description: 'Max memories to return (default 10, capped at 50).' },
        mode: {
          type: 'string',
          enum: ['keyword', 'semantic'],
          description: 'Chế độ recall: "keyword" (mặc định) hoặc "semantic" (embedding thật qua Ollama local).',
        },
        min_similarity: {
          type: 'number',
          description: 'Ngưỡng cosine tối thiểu cho mode "semantic" (mặc định 0.3, 0..1).',
        },
        ollama_base_url: {
          type: 'string',
          description: 'Base URL của Ollama cho mode "semantic" (mặc định http://127.0.0.1:11434).',
        },
        ollama_model: {
          type: 'string',
          description: 'Model embedding của Ollama cho mode "semantic" (mặc định nomic-embed-text).',
        },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const query = getOptionalStringArg(args, 'query');
        const tag = getOptionalStringArg(args, 'tag');
        const limit = getNumberArg(args, 'limit', 10, 50);
        const mode = getOptionalStringArg(args, 'mode') ?? 'keyword';
        if (mode !== 'keyword' && mode !== 'semantic') {
          return errorResult('Argument "mode" must be "keyword" or "semantic".');
        }
        let minSimilarity: number | undefined;
        if (args['min_similarity'] !== undefined && args['min_similarity'] !== null) {
          const raw = args['min_similarity'];
          if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
            return errorResult('Argument "min_similarity" must be a number between 0 and 1.');
          }
          minSimilarity = raw;
        }
        const store = new LongTermMemory(ctx.workspaceDir);
        if (mode === 'semantic' && query) {
          const baseUrl = getOptionalStringArg(args, 'ollama_base_url') || undefined;
          const model = getOptionalStringArg(args, 'ollama_model') || undefined;
          const embeddings = new OllamaEmbeddings({
            ...(baseUrl ? { baseUrl } : {}),
            ...(model ? { model } : {}),
          });
          const semanticOpts = {
            embedder: embeddings,
            backfill: true,
            limit,
            ...(minSimilarity !== undefined ? { minSimilarity } : {}),
            ...(tag ? { tag } : {}),
          };
          // Giữ đúng phạm vi của nhánh từ khoá: memory của bot + nhớ chung.
          const botRes = await store.recallSemantic(query, { ...semanticOpts, botId: ctx.botId });
          const sharedRes = await store.recallSemantic(query, { ...semanticOpts, botId: '' });
          const merged = new Map<string, { entry: (typeof botRes.hits)[number]['entry']; score: number }>();
          for (const h of [...botRes.hits, ...sharedRes.hits]) {
            const prev = merged.get(h.entry.id);
            if (!prev || h.score > prev.score) merged.set(h.entry.id, h);
          }
          const all = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
          if (all.length === 0) return '(no matching long-term memories)';
          // Phạm vi trống không tính là fallback (recallSemantic trả
          // usedFallback=false khi không có entry) nên OR ở đây đúng:
          // fallback chỉ khi một phạm vi CÓ entry mà phải dùng từ khoá.
          const usedFallback = botRes.usedFallback || sharedRes.usedFallback;
          const reason = botRes.fallbackReason ?? sharedRes.fallbackReason;
          const header = usedFallback
            ? `Long-term memories (${all.length}, fallback về tìm kiếm từ khoá${reason ? ` — ${reason}` : ''}):`
            : `Long-term memories (${all.length}, tìm kiếm ngữ nghĩa, model ${embeddings.model}):`;
          return truncate(
            `${header}\n` +
              all
                .map(
                  (h) =>
                    `- ${h.entry.key}: ${h.entry.value} (score ${h.score.toFixed(2)}, confidence ${h.entry.confidence.toFixed(2)}${h.entry.tags.length > 0 ? `, tags: ${h.entry.tags.join(', ')}` : ''})`,
                )
                .join('\n'),
          );
        }
        const entries = store.recall({ ...(query ? { query } : {}), ...(tag ? { tag } : {}), botId: ctx.botId, limit });
        // Also include shared (botId '') memories when recalling for a bot.
        const shared = store.recall({ ...(query ? { query } : {}), ...(tag ? { tag } : {}), botId: '', limit });
        const merged = new Map<string, (typeof entries)[number]>();
        for (const e of [...entries, ...shared]) merged.set(e.id, e);
        const all = [...merged.values()].slice(0, limit);
        if (all.length === 0) return '(no matching long-term memories)';
        return truncate(
          `Long-term memories (${all.length}):\n` +
            all.map((e) => `- ${e.key}: ${e.value} (confidence ${e.confidence.toFixed(2)}${e.tags.length > 0 ? `, tags: ${e.tags.join(', ')}` : ''})`).join('\n'),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryForgetTool: Tool = {
    definition: toolDef(
      'memory_forget',
      'Forget a long-term memory by key (deletes it from .open-bot/memories.json). Cannot be undone. Local only.',
      {
        key: { type: 'string', description: 'Memory key to forget.' },
      },
      ['key'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const key = getStringArg(args, 'key');
        const store = new LongTermMemory(ctx.workspaceDir);
        const deleted = store.forget(key, ctx.botId) || store.forget(key, '');
        return deleted ? `Forgot memory "${key}".` : `No memory with key "${key}" (nothing forgotten).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const teamContextSummaryTool: Tool = {
    definition: toolDef(
      'team_context_summary',
      'Summarize team context: long-term memories + recent tasks/history of the bots in a team, saved as a markdown file ' +
        'under .open-bot/team-context/<teamId>-<date>.md. Extractive summary (no model call). Without a BotMemory wired up ' +
        'by the host, tasks/history are skipped and only memories are summarized.',
      {
        team_id: { type: 'string', description: 'Team id (used for the file name; default "team").' },
        bot_ids: { type: 'array', items: { type: 'string' }, description: 'Bot ids in the team to summarize.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const teamId = getOptionalStringArg(args, 'team_id') ?? 'team';
        const botIds = getStringArrayArg(args, 'bot_ids');
        const result = teamContextSummary({
          workspaceDir: ctx.workspaceDir,
          botIds: botIds.length > 0 ? botIds : [ctx.botId],
          teamId,
          ...(memory ? { memory } : {}),
        });
        return truncate(
          `Team context summary saved to ${path.relative(ctx.workspaceDir, result.path)} ` +
            `(${result.memoryCount} memor(ies), ${result.botCount} bot(s)).\n\n${result.content}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const transcriptArchiveTool: Tool = {
    definition: toolDef(
      'transcript_archive',
      'Archive a bot chat transcript: export its history to a timestamped JSONL file under .open-bot/transcripts/ ' +
        '(one message per line, with timestamps) for later search. Give a query to search an archived file instead ' +
        'of creating a new archive. Needs a BotMemory wired up by the host to create an archive.',
      {
        bot_id: { type: 'string', description: 'Bot whose history to archive (default: the calling bot).' },
        archive_file: { type: 'string', description: 'Existing archive file path (relative to workspace) to search instead of archiving.' },
        query: { type: 'string', description: 'Keyword to search for inside archive_file (requires archive_file).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const archiveFile = getOptionalStringArg(args, 'archive_file');
        if (archiveFile) {
          const full = path.resolve(ctx.workspaceDir, archiveFile);
          const root = path.resolve(ctx.workspaceDir);
          if (full !== root && !full.startsWith(root + path.sep)) {
            return errorResult(`Path "${archiveFile}" escapes the workspace.`);
          }
          const query = getOptionalStringArg(args, 'query') ?? '';
          const hits = query ? searchTranscriptArchive(full, query) : loadTranscriptArchive(full);
          if (hits.length === 0) return `(no messages in archive "${archiveFile}"${query ? ` matching "${query}"` : ''})`;
          return truncate(
            `Archive "${archiveFile}" — ${hits.length} message(s)${query ? ` matching "${query}"` : ''}:\n` +
              hits.map((h) => `[${h.index}] ${h.role}: ${h.content.slice(0, 300)}`).join('\n'),
          );
        }
        if (!memory) {
          return errorResult(
            'transcript_archive needs a BotMemory — host must pass memory to createIntegrationTools.',
          );
        }
        const botId = getOptionalStringArg(args, 'bot_id') ?? ctx.botId;
        const result = archiveTranscript({ workspaceDir: ctx.workspaceDir, botId, memory });
        return `Archived ${result.count} message(s) of bot "${botId}" to ${path.relative(ctx.workspaceDir, result.path)}.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    sessionBoxCreateTool,
    sessionBoxSnapshotTool,
    sessionBoxRestoreTool,
    sessionBoxListTool,
    sessionBoxDestroyTool,
    sessionBoxReplaceEnvTool,
    slackSendTool,
    slackListChannelsTool,
    slackReadTool,
    emailReadTool,
    emailSendTool,
    teamsSendTool,
    teamsListTeamsTool,
    imessageDraftTool,
    meetingTranscriptTool,
    meetingSummarizeTool,
    memoryRememberTool,
    memoryRecallTool,
    memoryForgetTool,
    teamContextSummaryTool,
    transcriptArchiveTool,
    // v0.68b: tool GitHub (7 tool API + set_active_branch local) —
    // logic ở gitTools.ts, gom vào đây để M7 app 'github' sở hữu
    // chúng qua catalog + createAppTools. Đây là NƠI DUY NHẤT đăng
    // ký tool git trong factory mặc định của coordinator (xem
    // defaultToolFactory): đăng ký riêng createGitTools nữa sẽ trùng
    // tên và registry ném lỗi. `set_active_branch` không thuộc app
    // 'github' trong catalog (git local, không phải API GitHub) nên
    // createAppTools('github') chỉ trả 7 tool API; tool này vẫn chạy
    // như tool nội bộ (như session_box_*). Chưa có getGitHubToken thì
    // 7 tool API báo lỗi thiếu token rõ ràng, như GIT_TOOLS gốc.
    // fetchFn chuyển tiếp để test mock được API GitHub như các
    // connector khác (slack/gmail/teams).
    ...createGitTools({
      ...(opts.getGitHubToken ? { getGitHubToken: opts.getGitHubToken } : {}),
      ...(fetchFn ? { fetchFn } : {}),
    }),
  ];
}

/** Unbound placeholders (same pattern as PLAN_TOOLS / WEB_MEDIA_TOOLS). */
export const INTEGRATION_TOOLS: Tool[] = createIntegrationTools();

/**
 * M7 — gom tool hiện có về catalog app (packages/core/src/apps/).
 *
 * Không viết lại logic tool: createAppTools chỉ lọc list tool đã có
 * theo tên tool mà catalog khai cho app đó (vd 'slack' ->
 * slack_send/slack_list_channels/slack_read). Tool vẫn chạy như cũ;
 * chỉ đường đăng ký/quản lý đổi sang qua catalog — host muốn expose
 * tool của một app thì gọi hàm này thay vì lọc tay theo tên.
 * App không tồn tại (không có tool nào trong catalog) thì ném lỗi rõ.
 */
export function createAppTools(appId: string, opts: IntegrationToolOptions = {}): Tool[] {
  const names = getAppToolNames(appId);
  if (names.length === 0) {
    throw new Error(`Không rõ app "${appId}" — không có tool nào trong catalog apps.`);
  }
  const wanted = new Set(names);
  return createIntegrationTools(opts).filter((t) => wanted.has(t.definition.name));
}

/** App sở hữu một tên tool tích hợp (undefined khi tool không thuộc app nào). */
export function integrationToolAppId(toolName: string): string | undefined {
  return appIdForTool(toolName);
}

export { IMESSAGE_DRAFTS_REL_DIR };
export type { IntegrationToolOptions as IntegrationToolsOptions };
