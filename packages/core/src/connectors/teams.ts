/**
 * Microsoft Teams connector (v0.7) — Microsoft Graph, token của user.
 *
 * ROADMAP §2c: "Tích hợp Microsoft Teams".
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `teams`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Gửi tin: POST /teams/{teamId}/channels/{channelId}/messages với
 * body text. Cần scope Teams/Graph: Team.ReadBasic.All,
 * ChannelMessage.Send (delegated, token user).
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

export const TEAMS_CONNECTOR: ConnectorDefinition = {
  id: 'teams',
  label: 'Microsoft Teams',
  authType: 'oauth2',
  scopes: ['Team.ReadBasic.All', 'ChannelMessage.Send', 'ChannelMessage.Read.All'],
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  description:
    'Gửi/đọc tin Teams bằng OAuth token của user (Microsoft Graph). Cần app Azure AD — xem hướng dẫn kết nối trong lỗi khi chưa có token.',
};

try {
  registerConnector(TEAMS_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface TeamsApiOptions {
  /** OAuth access token Graph của user (callback do host cấp). */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Provider token có auto-refresh (tạo bằng
   * createConnectorTokenProvider). Khi có, mỗi call lấy token qua
   * provider (tự refresh trước 5 phút, dedup; 401 thì force refresh
   * + retry 1 lần cho GET); khi không có, dùng getToken() như cũ.
   */
  tokenProvider?: ConnectorTokenProvider;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: FetchFn;
}

export interface TeamsTeam {
  id: string;
  displayName: string;
  description?: string;
}

export interface TeamsChannel {
  id: string;
  displayName: string;
  description?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Teams: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Teams để kết nối (Azure AD OAuth, scope Team.ReadBasic.All + ChannelMessage.Send), ' +
      'hoặc cấp token qua host getTeamsToken.',
  );
}

async function graphCall(
  opts: TeamsApiOptions,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const method = init.method ?? 'GET';
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh, POST không retry.
  const res = await callWithAutoRefresh({
    connectorId: 'teams',
    method,
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${GRAPH_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (err) {
        throw new Error(`Microsoft Graph request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) {
    // Không echo body: có thể chứa token.
    throw new Error(`Microsoft Graph returned HTTP ${res.status} for ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`Microsoft Graph returned a non-JSON response for ${path}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Microsoft Graph returned an unexpected response for ${path}.`);
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec['error'] === 'object' && rec['error'] !== null) {
    const msg = (rec['error'] as Record<string, unknown>)['message'];
    throw new Error(
      `Microsoft Graph error for ${path}: ${typeof msg === 'string' ? msg : 'unknown error'}.`,
    );
  }
  return rec;
}

/** Liệt kê các team user đã tham gia. */
export async function teamsListTeams(opts: TeamsApiOptions): Promise<TeamsTeam[]> {
  const rec = await graphCall(opts, '/me/joinedTeams?$select=id,displayName,description');
  const value = rec['value'];
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .filter((t) => typeof t['id'] === 'string' && typeof t['displayName'] === 'string')
    .map((t) => ({
      id: t['id'] as string,
      displayName: t['displayName'] as string,
      description: typeof t['description'] === 'string' ? t['description'] : undefined,
    }));
}

/** Liệt kê channel của một team. */
export async function teamsListChannels(
  opts: TeamsApiOptions,
  teamId: string,
): Promise<TeamsChannel[]> {
  if (!teamId) throw new Error('Teams team id is required.');
  const rec = await graphCall(
    opts,
    `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName,description`,
  );
  const value = rec['value'];
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter((c) => typeof c['id'] === 'string' && typeof c['displayName'] === 'string')
    .map((c) => ({
      id: c['id'] as string,
      displayName: c['displayName'] as string,
      description: typeof c['description'] === 'string' ? c['description'] : undefined,
    }));
}

/** Gửi một tin text vào channel của team. Trả về id message đã gửi. */
export async function teamsSendChannelMessage(
  opts: TeamsApiOptions,
  teamId: string,
  channelId: string,
  text: string,
): Promise<{ id: string }> {
  if (!teamId) throw new Error('Teams team id is required.');
  if (!channelId) throw new Error('Teams channel id is required.');
  if (!text) throw new Error('Teams message text must not be empty.');
  const rec = await graphCall(
    opts,
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST', body: { body: { contentType: 'text', content: text } } },
  );
  if (typeof rec['id'] !== 'string') throw new Error('Teams send did not return a message id.');
  return { id: rec['id'] };
}
