/**
 * Channels → coordinator adapter (v0.96 Team T4).
 *
 * Nối channel vào coordinator + group chat hiện có mà KHÔNG tạo vòng
 * import: module này không import coordinator; host (coordinator)
 * tiêm một `runBot` — hàm chạy một bot với prompt + system prompt bổ
 * sung rồi trả text trả lời (chính là `run()` silent mà group chat
 * dùng cho delegation). Adapter chỉ lo:
 *  1. ghi tin nhắn user vào transcript channel,
 *  2. resolve bot nào trả lời (theo responder rules),
 *  3. chạy từng bot responder (tuần tự — bot sau thấy transcript đã
 *     có câu trả lời bot trước, tránh 2 bot làm trùng việc),
 *  4. ghi câu trả lời mỗi bot vào transcript + cập nhật round-robin.
 *
 * Một hop duy nhất: câu trả lời của bot KHÔNG parse @mention tiếp
 * (cùng quy tắc chống vòng lặp bot-bot của group chat M8). Bot chạy
 * lỗi → ghi tin nhắn lỗi vào transcript (botName là tên bot, text
 * bắt đầu bằng `[lỗi]`), không làm đổ cả channel.
 */

import type { Channel, ChannelStore } from './channels';
import { buildChannelSystemPrompt, parseChannelMentions } from './channels';

/** Hàm host tiêm: chạy một bot, trả text trả lời (ném lỗi khi bot lỗi). */
export type ChannelBotRunner = (opts: {
  botId: string;
  /** Prompt gửi bot: tin nhắn user + transcript gần nhất. */
  prompt: string;
  /** System prompt bổ sung của channel (shared instructions + folder). */
  channelSystemPrompt: string;
  channel: Channel;
}) => Promise<string>;

/** Kết quả route một tin nhắn trong channel. */
export interface ChannelRouteResult {
  /** Tin nhắn user đã ghi (undefined khi channel không tồn tại). */
  userMessageId?: string;
  /** Bot đã được chạy (theo thứ tự chạy). */
  responders: string[];
  /** Bot chạy lỗi (botId → message lỗi). */
  errors: Record<string, string>;
  /** Số tin nhắn bot đã ghi vào transcript. */
  repliesPosted: number;
}

/** Số tin nhắn transcript gần nhất đưa vào prompt cho bot. */
export const CHANNEL_ROUTE_CONTEXT_MESSAGES = 20;

/**
 * Route một tin nhắn user trong channel: ghi transcript, resolve
 * responder, chạy từng bot, ghi trả lời. Trả summary để caller/UI
 * hiển thị. Không bao giờ ném (channel không tồn tại → responders rỗng).
 */
export async function routeChannelMessage(
  store: ChannelStore,
  channelId: string,
  input: { text: string; userName?: string; bots: readonly { id: string; name: string }[] },
  runBot: ChannelBotRunner,
): Promise<ChannelRouteResult> {
  const channel = store.getChannel(channelId);
  if (!channel) return { responders: [], errors: {}, repliesPosted: 0 };
  const mentions = parseChannelMentions(input.text, input.bots);
  const userMessage = store.postChannelMessage(channelId, {
    botId: '',
    botName: input.userName ?? 'Bạn',
    text: input.text,
    mentions,
    delegated: false,
  });
  const responders = store.resolveResponders(channelId, input.text, mentions);
  const errors: Record<string, string> = {};
  let repliesPosted = 0;
  const channelSystemPrompt = buildChannelSystemPrompt(channel);
  for (const botId of responders) {
    const bot = input.bots.find((b) => b.id === botId);
    const botName = bot?.name ?? botId;
    try {
      const history = store
        .listChannelMessages(channelId, CHANNEL_ROUTE_CONTEXT_MESSAGES)
        .map((m) => `${m.botId === '' ? (input.userName ?? 'Bạn') : m.botName}: ${m.text}`)
        .join('\n');
      const prompt = history ? `Transcript channel gần đây:\n${history}\n\nTin nhắn mới nhất cần trả lời:\n${input.text}` : input.text;
      const reply = await runBot({ botId, prompt, channelSystemPrompt, channel });
      store.postChannelMessage(channelId, {
        botId,
        botName,
        text: reply,
        mentions: [],
        delegated: true,
      });
      store.setLastResponder(channelId, botId);
      repliesPosted++;
    } catch (err) {
      const message = (err as Error).message;
      errors[botId] = message;
      store.postChannelMessage(channelId, {
        botId,
        botName,
        text: `[lỗi] Bot ${botName} không trả lời được: ${message}`,
        mentions: [],
        delegated: true,
      });
    }
  }
  return {
    ...(userMessage ? { userMessageId: userMessage.id } : {}),
    responders,
    errors,
    repliesPosted,
  };
}
