/**
 * OS notifications module re-exports (v0.87c).
 *
 * The service lives in @open-bot/core because the desktop app (main
 * process) and the tests both need it; it is exported from the
 * package index since v0.87c.
 */
export {
  NotificationService,
  isNotificationKind,
  notificationSettingsKey,
  resolveNotificationSettings,
  validateNotificationRequest,
  DEFAULT_NOTIFICATION_SETTINGS,
  MAX_NOTIFICATION_BODY_CHARS,
  MAX_NOTIFICATION_TITLE_CHARS,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  NOTIFICATION_KINDS,
  NOTIFICATION_RATE_LIMIT_MAX,
  NOTIFICATION_RATE_LIMIT_WINDOW_MS,
} from './service';
export type {
  NotificationKind,
  NotificationOutcome,
  NotificationOutcomeReason,
  NotificationRequest,
  NotificationServiceOptions,
  NotificationSettings,
  ShownNotification,
} from './service';
export { formatNotificationText } from './text';
export type { NotificationLocale, NotificationText, NotificationTextVars } from './text';
