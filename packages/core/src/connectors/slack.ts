/**
 * Slack connector (v0.7) — API công khai slack.com, token của user.
 *
 * ROADMAP §2c: "Tích hợp Slack (nhận/gửi tin, gắn workspace)".
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `slack` — xem connectors/framework.ts).
 * Token chỉ đi trong header `Authorization: Bearer …`, KHÔNG BAO GIỜ
 * được log và không xuất hiện trong kết quả trả về hay thông báo lỗi.
 * Khi chưa có token, hàm ném lỗi rõ ràng kèm hướng dẫn kết nối thay vì
 * gọi API ẩn danh.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const SLACK_API_BASE = 'https://slack.com/api';

export const SLACK_CONNECTOR: ConnectorDefinition = {
  id: 'slack',
  label: 'Slack',
  authType: 'oauth2',
  scopes: ['channels:read', 'channels:history', 'chat:write'],
  authUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  description:
    'Gửi/đọc tin Slack bằng token OAuth của user. Cần app Slack (bot hoặc user token) — xem hướng dẫn kết nối trong lỗi khi chưa có token.',
};

try {
  registerConnector(SLACK_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
  memberCount?: number;
}

export interface SlackMessage {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
}

export interface SlackApiOptions {
  /** Token Slack của user (callback do host cấp). */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Provider token có auto-refresh (tạo bằng
   * createConnectorTokenProvider). Khi có, mỗi call lấy token qua
   * provider (tự refresh trước 5 phút, dedup; 401 thì force refresh
   * + retry 1 lần cho GET); khi không có, dùng getToken() như cũ.
   * Token xoxb không hết hạn: provider trả token đó tiếp, không refresh.
   */
  tokenProvider?: ConnectorTokenProvider;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: FetchFn;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Slack: chưa có token. ' +
      'Vào Settings → Connectors → Slack để kết nối (OAuth app Slack của bạn, scope channels:read, channels:history, chat:write), ' +
      'hoặc cấp token qua host getSlackToken.',
  );
}

async function slackCall(
  opts: SlackApiOptions,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const method = init.method ?? 'GET';
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh, POST không retry.
  const res = await callWithAutoRefresh({
    connectorId: 'slack',
    method,
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${SLACK_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (err) {
        throw new Error(`Slack API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) {
    // Không echo body/header: có thể chứa token.
    throw new Error(`Slack API returned HTTP ${res.status} for ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`Slack API returned a non-JSON response for ${path}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Slack API returned an unexpected response for ${path}.`);
  }
  const rec = parsed as Record<string, unknown>;
  if (rec['ok'] !== true) {
    const code = typeof rec['error'] === 'string' ? rec['error'] : 'unknown_error';
    throw new Error(`Slack API error for ${path}: ${code}.`);
  }
  return rec;
}

/** Liệt kê channel trong workspace (tối đa 200, loại channel đã archive). */
export async function slackListChannels(opts: SlackApiOptions): Promise<SlackChannel[]> {
  const rec = await slackCall(opts, '/conversations.list?types=public_channel,private_channel&limit=200');
  const channels = rec['channels'];
  if (!Array.isArray(channels)) return [];
  return channels
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter((c) => typeof c['id'] === 'string' && typeof c['name'] === 'string')
    .map((c) => ({
      id: c['id'] as string,
      name: c['name'] as string,
      isPrivate: c['is_private'] === true,
      memberCount: typeof c['num_members'] === 'number' ? c['num_members'] : undefined,
    }));
}

/** Đọc N tin gần nhất của một channel (mới nhất trước, mặc định 20). */
export async function slackReadChannel(
  opts: SlackApiOptions,
  channelId: string,
  limit = 20,
): Promise<SlackMessage[]> {
  if (!channelId) throw new Error('Slack channel id is required.');
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const rec = await slackCall(
    opts,
    `/conversations.history?channel=${encodeURIComponent(channelId)}&limit=${capped}`,
  );
  const messages = rec['messages'];
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      type: typeof m['type'] === 'string' ? m['type'] : undefined,
      user: typeof m['user'] === 'string' ? m['user'] : undefined,
      text: typeof m['text'] === 'string' ? m['text'] : undefined,
      ts: typeof m['ts'] === 'string' ? m['ts'] : undefined,
    }));
}

/** Gửi một tin vào channel qua chat.postMessage. Trả về ts của tin đã gửi. */
export async function slackSendMessage(
  opts: SlackApiOptions,
  channelId: string,
  text: string,
): Promise<{ channel: string; ts: string }> {
  if (!channelId) throw new Error('Slack channel id is required.');
  if (!text) throw new Error('Slack message text must not be empty.');
  const rec = await slackCall(opts, '/chat.postMessage', {
    method: 'POST',
    body: { channel: channelId, text },
  });
  return {
    channel: typeof rec['channel'] === 'string' ? rec['channel'] : channelId,
    ts: typeof rec['ts'] === 'string' ? rec['ts'] : '',
  };
}
