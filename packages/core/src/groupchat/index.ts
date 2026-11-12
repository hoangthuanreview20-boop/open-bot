/**
 * Group chat bot-bot (M8): nhiều bot trong một thread, @mention gọi bot
 * cụ thể, delegation qua run() đã có, lịch sử bền vững trong file JSON.
 * Xem `./groupchat.ts`.
 */
export {
  GROUP_ATTACHMENTS_DIRNAME,
  GROUP_ATTACHMENT_EXT_BY_MIME,
  GROUP_BOT_STATUS_FILE_NAME,
  GROUP_BOT_STATUS_FILE_VERSION,
  GROUP_CHATS_FILE_NAME,
  GROUP_CHATS_FILE_VERSION,
  GroupBotStatusTracker,
  GroupChatStore,
  MAX_GROUP_MESSAGES,
  normalizeBotName,
  parseGroupMentions,
} from './groupchat';
export type { GroupBotInterruptedEntry, GroupBotStatus, GroupBotStatusEntry, GroupChat, GroupMessage, GroupMessageAttachment, MentionableBot } from './groupchat';
