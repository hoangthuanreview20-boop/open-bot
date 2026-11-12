/**
 * Telegram read client (worker F2, v0.89b) — Telegram Bot API, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Telegram Bot API
 * (core.telegram.org/bots/api):
 *  - `GET /bot<token>/getMe` → `{ ok: true, result: { id, is_bot,
 *    first_name, username } }`.
 *  - `GET /bot<token>/getUpdates?offset=&limit=` → `{ ok: true, result:
 *    [{ update_id, message: { message_id, chat: { id, type, title },
 *    text, date } }] }`.
 *  - `GET /bot<token>/getChat?chat_id=` → `{ ok: true, result: { id,
 *    type, title, username, first_name } }`.
 *  - Khi lỗi: `{ ok: false, error_code, description }` — client map thành
 *    lỗi có mã, không kèm token.
 *  - Auth: bot token nằm trong path `/bot<token>/...` — đây là thiết kế
 *    của Bot API. Token KHÔNG BAO GIỜ được log hay đưa vào error message
 *    (error chỉ chứa tên operation + error_code/description của Telegram).
 *
 * Không có live test với bot token thật trong repo — test dùng mock fetch
 * (mock-verified, chưa đối chiếu live).
 */
import {
  callJson,
  capLimit,
  isRecord,
  requireNonEmpty,
  strField,
  type ReadClientOptions,
} from './common';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

export type TelegramApiOptions = ReadClientOptions;

export interface TelegramBotInfo {
  id: number;
  isBot: boolean;
  firstName?: string;
  username?: string;
}

export interface TelegramChatInfo {
  id: number;
  type: string;
  title?: string;
  username?: string;
  firstName?: string;
}

export interface TelegramUpdate {
  updateId: number;
  chatId?: number;
  chatType?: string;
  text?: string;
  date?: number;
}

/** Kiểm tra envelope `{ ok, result }` của Bot API; ném lỗi rõ khi ok=false. */
function unwrapTelegramResult(parsed: unknown, context: string): unknown {
  if (!isRecord(parsed)) {
    throw new Error(`Telegram API returned an unexpected response (${context}).`);
  }
  if (parsed['ok'] !== true) {
    const code = typeof parsed['error_code'] === 'number' ? parsed['error_code'] : '?';
    const desc =
      typeof parsed['description'] === 'string' ? (parsed['description'] as string) : 'unknown error';
    throw new Error(`Telegram API error ${code} for ${context}: ${desc}`);
  }
  return parsed['result'];
}

async function telegramCall(
  opts: TelegramApiOptions,
  method: string,
  query: string,
  context: string,
): Promise<unknown> {
  requireNonEmpty(opts.token, 'Telegram token');
  const url = `${TELEGRAM_API_BASE}/bot${opts.token}/${method}${query}`;
  const parsed = await callJson('Telegram', opts, url, context, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return unwrapTelegramResult(parsed, context);
}

/** Lấy thông tin bot hiện tại (kiểm tra token có hợp lệ không). */
export async function telegramGetMe(opts: TelegramApiOptions): Promise<TelegramBotInfo> {
  const result = await telegramCall(opts, 'getMe', '', 'telegramGetMe');
  if (!isRecord(result) || typeof result['id'] !== 'number') {
    throw new Error('Telegram API returned an unexpected getMe response (telegramGetMe).');
  }
  return {
    id: result['id'] as number,
    isBot: result['is_bot'] === true,
    firstName: strField(result, 'first_name'),
    username: strField(result, 'username'),
  };
}

/** Lấy các update mới (tin nhắn gửi tới bot). */
export async function telegramGetUpdates(
  opts: TelegramApiOptions,
  extra: { offset?: number; limit?: number } = {},
): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams();
  if (extra.offset !== undefined) params.set('offset', String(extra.offset));
  if (extra.limit !== undefined) params.set('limit', String(capLimit(extra.limit, 100)));
  const query = params.toString();
  const result = await telegramCall(opts, 'getUpdates', query ? `?${query}` : '', 'telegramGetUpdates');
  if (!Array.isArray(result)) return [];
  return result
    .filter((u): u is Record<string, unknown> => isRecord(u))
    .filter((u) => typeof u['update_id'] === 'number')
    .map((u) => {
      const message = isRecord(u['message']) ? u['message'] : undefined;
      const chat = message && isRecord(message['chat']) ? message['chat'] : undefined;
      return {
        updateId: u['update_id'] as number,
        chatId: chat && typeof chat['id'] === 'number' ? (chat['id'] as number) : undefined,
        chatType: chat ? strField(chat, 'type') : undefined,
        text: message ? strField(message, 'text') : undefined,
        date: message && typeof message['date'] === 'number' ? (message['date'] as number) : undefined,
      };
    });
}

/** Lấy thông tin một chat theo id (số) hoặc username (@...). */
export async function telegramGetChat(
  opts: TelegramApiOptions,
  chatId: string,
): Promise<TelegramChatInfo> {
  requireNonEmpty(chatId, 'Telegram chatId');
  const params = new URLSearchParams({ chat_id: chatId });
  const result = await telegramCall(opts, 'getChat', `?${params.toString()}`, 'telegramGetChat');
  if (!isRecord(result) || typeof result['id'] !== 'number') {
    throw new Error('Telegram API returned an unexpected getChat response (telegramGetChat).');
  }
  return {
    id: result['id'] as number,
    type: typeof result['type'] === 'string' ? (result['type'] as string) : 'unknown',
    title: strField(result, 'title'),
    username: strField(result, 'username'),
    firstName: strField(result, 'first_name'),
  };
}
