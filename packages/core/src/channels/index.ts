/**
 * Channels — public surface of packages/core/src/channels/ (v0.96 Team T4).
 *
 * Channel = không gian làm việc chung của nhiều bot: transcript
 * riêng, hướng dẫn chung, thư mục làm việc, responder rules quyết
 * định bot nào trả lời. Xem docs/composio-channels-v096.md.
 */
export {
  CHANNELS_FILE_NAME,
  CHANNELS_FILE_VERSION,
  CHANNEL_MAX_INSTRUCTIONS_LENGTH,
  CHANNEL_MAX_MESSAGES,
  CHANNEL_MAX_NAME_LENGTH,
  CHANNEL_MAX_WORKING_FOLDER_LENGTH,
  DEFAULT_CHANNEL_RESPONDER_RULES,
  ChannelStore,
  buildChannelSystemPrompt,
  createChannelObject,
  parseChannelMentions,
  resolveChannelResponders,
} from './channels';
export type {
  Channel,
  ChannelKind,
  ChannelMessage,
  ChannelResponderMode,
  ChannelResponderRules,
  CreateChannelInput,
  UpdateChannelInput,
} from './channels';
export { CHANNEL_ROUTE_CONTEXT_MESSAGES, routeChannelMessage } from './coordinatorAdapter';
export type { ChannelBotRunner, ChannelRouteResult } from './coordinatorAdapter';
