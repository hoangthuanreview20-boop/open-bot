/**
 * Discord connector (v0.73) — Discord API, OAuth 2.0 + client đọc thật.
 *
 * Endpoints theo tài liệu Discord (docs.discord.com, OAuth2):
 * authorize `https://discord.com/oauth2/authorize`, token
 * `https://discord.com/api/oauth2/token`. Scope `identify` +
 * `guilds` + `guilds.members.read` (chỉ đọc thông tin user/server).
 *
 * API đọc (chỉ đọc, không ghi) — `https://discord.com/api/v10`:
 *  - `GET /users/@me` — user hiện tại (cần scope `identify`).
 *  - `GET /users/@me/guilds` — server (guild) user tham gia (cần
 *    scope `guilds`).
 *  - `GET /guilds/{guild_id}/channels` — channel trong một guild mà
 *    user tham gia (cần scope `guilds` + user là thành viên guild;
 *    channel riêng tư mà user không có quyền xem sẽ không trả về).
 *
 * Gửi tin nhắn channel KHÔNG làm được bằng OAuth user này — cần bot
 * token (đường khác: tạo bot trong Discord Developer Portal, mời bot
 * vào server, gọi `POST /channels/{id}/messages` với header
 * `Authorization: Bot <token>`). Phần đọc dưới đây cố tình không có
 * hàm gửi.
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `discord`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Timeout cho một lần gọi Discord API (30 giây, như các connector khác). */
export const DISCORD_API_TIMEOUT_MS = 30_000;

export const DISCORD_CONNECTOR: ConnectorDefinition = {
  id: 'discord',
  label: 'Discord',
  authType: 'oauth2',
  scopes: ['identify', 'guilds', 'guilds.members.read'],
  authUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  description:
    'Đọc thông tin user/server Discord bằng OAuth token của user (chỉ đọc). Gửi tin nhắn channel cần bot token, không dùng OAuth user này. Cần tạo application trong Discord Developer Portal trước.',
};

try {
  registerConnector(DISCORD_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface DiscordApiOptions {
  /** OAuth access token Discord của user (callback do host cấp). */
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

export interface DiscordUser {
  id: string;
  username?: string;
  /** Tên hiển thị toàn cục (có thể khác username). */
  globalName?: string;
  avatar?: string | null;
}

export interface DiscordGuild {
  id: string;
  name?: string;
  icon?: string | null;
  owner?: boolean;
}

export interface DiscordChannel {
  id: string;
  name?: string;
  /** Loại channel Discord: 0 = text, 2 = voice, 4 = category, 5 = announcement, 15 = forum. */
  type?: number;
  position?: number;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Discord: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Discord để kết nối (OAuth app Discord, scope identify + guilds), ' +
      'hoặc cấp token qua host getDiscordToken.',
  );
}

function throwDiscordHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `Discord API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope identify / guilds của token và user có phải thành viên guild không.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Discord API: không tìm thấy (HTTP 404) ${context} — kiểm tra guild/channel id, hoặc user đã rời guild.`,
    );
  }
  if (status === 429) {
    throw new Error(
      'Discord API: bị rate limit (HTTP 429) — đợi một lúc rồi thử lại.',
    );
  }
  throw new Error(`Discord API returned HTTP ${status} for ${context}.`);
}

async function discordCall(
  opts: DiscordApiOptions,
  path: string,
): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh.
  const res = await callWithAutoRefresh({
    connectorId: 'discord',
    method: 'GET',
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${DISCORD_API_BASE}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Discord API request timed out after ${DISCORD_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Discord API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwDiscordHttpError(res.status, path);
  try {
    return await res.json();
  } catch {
    throw new Error('Discord API returned a non-JSON response.');
  }
}

/** User hiện tại (cần scope `identify`). */
export async function discordGetCurrentUser(opts: DiscordApiOptions): Promise<DiscordUser> {
  const parsed = await discordCall(opts, '/users/@me');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Discord API returned an unexpected response.');
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec['id'] !== 'string') {
    throw new Error('Discord API returned an unexpected user response.');
  }
  return {
    id: rec['id'] as string,
    username: typeof rec['username'] === 'string' ? (rec['username'] as string) : undefined,
    globalName:
      typeof rec['global_name'] === 'string' ? (rec['global_name'] as string) : undefined,
    avatar: typeof rec['avatar'] === 'string' ? (rec['avatar'] as string) : rec['avatar'] === null ? null : undefined,
  };
}

/** Server (guild) user tham gia (cần scope `guilds`). */
export async function discordListGuilds(
  opts: DiscordApiOptions,
  limit = 10,
): Promise<DiscordGuild[]> {
  const capped = Math.min(Math.max(Math.floor(limit), 1), 200);
  const params = new URLSearchParams({ limit: String(capped) });
  const parsed = await discordCall(opts, `/users/@me/guilds?${params.toString()}`);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
    .filter((g) => typeof g['id'] === 'string')
    .map((g) => ({
      id: g['id'] as string,
      name: typeof g['name'] === 'string' ? (g['name'] as string) : undefined,
      icon: typeof g['icon'] === 'string' ? (g['icon'] as string) : g['icon'] === null ? null : undefined,
      owner: typeof g['owner'] === 'boolean' ? (g['owner'] as boolean) : undefined,
    }));
}

/** Channel trong một guild mà user tham gia. */
export async function discordListGuildChannels(
  opts: DiscordApiOptions,
  guildId: string,
): Promise<DiscordChannel[]> {
  if (!guildId) throw new Error('Discord guildId is required (lấy qua discordListGuilds).');
  const parsed = await discordCall(opts, `/guilds/${encodeURIComponent(guildId)}/channels`);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter((c) => typeof c['id'] === 'string')
    .map((c) => ({
      id: c['id'] as string,
      name: typeof c['name'] === 'string' ? (c['name'] as string) : undefined,
      type: typeof c['type'] === 'number' ? (c['type'] as number) : undefined,
      position: typeof c['position'] === 'number' ? (c['position'] as number) : undefined,
    }));
}
