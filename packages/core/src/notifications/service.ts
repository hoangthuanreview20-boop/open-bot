/**
 * OS notifications — pure service (v0.87c).
 *
 * The service knows NOTHING about Electron: the main process injects a
 * `show` adapter that builds a real `Electron.Notification` (see
 * `apps/desktop/src/main/main.ts`). That keeps the anti-spam rules —
 * per-kind toggles, dedupe, rate limit — testable in plain node with a
 * fake `show`, on a headless VM that has no notification daemon at
 * all. A real popup on screen was never observed here; see
 * `docs/notifications.md` for the honest verification limits.
 *
 * Anti-spam contract (numbers are part of the public API, documented
 * in docs/notifications.md):
 *   - DEDUPE_WINDOW_MS (10s): a notification with the same kind +
 *     bot + title (or the same explicit dedupeKey) inside the window
 *     is dropped as a duplicate.
 *   - RATE_LIMIT_MAX (5) per kind per RATE_LIMIT_WINDOW_MS (60s,
 *     rolling): further notifications of that kind are dropped and
 *     counted as suppressed.
 *   - Per-kind on/off comes from `isEnabled` (main reads the user's
 *     Settings; defaults are all ON — see resolveNotificationSettings).
 *
 * Clicking a notification never opens an external URL: the service
 * hands the main process an internal `DeepLinkRoute` (`open-bot://bot/<id>`
 * or the chat screen), and main focuses the window + delivers the
 * route through the same path as the OS deep-link handler.
 */
import type { DeepLinkRoute } from '../deeplink';

/** The events that may raise an OS notification (v0.94c adds project-update; v0.95 adds watch-change). */
export type NotificationKind = 'run-complete' | 'approval' | 'run-error' | 'project-update' | 'watch-change';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'run-complete',
  'approval',
  'run-error',
  'project-update',
  'watch-change',
] as const;

/** Per-kind user toggles (Settings → General → Notifications). */
export interface NotificationSettings {
  runComplete: boolean;
  approval: boolean;
  runError: boolean;
  /** v0.94c: digest cập nhật định kỳ của project. */
  projectUpdate: boolean;
  /** v0.95 (Team D1): a watched page changed content. */
  watchChange: boolean;
}

/**
 * All kinds default to ON. Rationale: these are the events the
 * user asked to be told about (a run finishing, an approval waiting,
 * a run failing, a project digest); each kind can be switched off
 * individually, and the dedupe + rate limit below stop bursts.
 * Turning a kind off is a deliberate user choice, not a silent default.
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  runComplete: true,
  approval: true,
  runError: true,
  projectUpdate: true,
  watchChange: true,
} as const;

/** Map a kind to its settings field. */
export function notificationSettingsKey(kind: NotificationKind): keyof NotificationSettings {
  switch (kind) {
    case 'run-complete':
      return 'runComplete';
    case 'approval':
      return 'approval';
    case 'run-error':
      return 'runError';
    case 'project-update':
      return 'projectUpdate';
    case 'watch-change':
      return 'watchChange';
  }
}

/**
 * Resolve a stored (possibly partial / untrusted) settings value into
 * a full settings object. Unknown fields are ignored; a non-boolean
 * value falls back to the default (ON) instead of throwing, so a
 * hand-edited settings.json can never disable notifications silently
 * by accident — the main process validates strictly on `settings:set`
 * and rejects non-booleans there.
 */
export function resolveNotificationSettings(input: unknown): NotificationSettings {
  const out: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
  const raw = input as Partial<Record<keyof NotificationSettings, unknown>>;
  for (const key of ['runComplete', 'approval', 'runError', 'projectUpdate'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return (
    typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)
  );
}

/** Max title/body length (OS notification centres truncate anyway). */
export const MAX_NOTIFICATION_TITLE_CHARS = 128;
export const MAX_NOTIFICATION_BODY_CHARS = 512;

/** Same bot-id rule as the deep-link parser (packages/core/src/deeplink.ts). */
const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/** One notification request (from the coordinator event, chat run, or IPC). */
export interface NotificationRequest {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Bot the notification is about; click opens this bot's chat. */
  botId?: string;
  /**
   * Optional explicit dedupe group (e.g. an approval callId): two
   * requests with the same dedupeKey inside the dedupe window count
   * as one even if their titles differ.
   */
  dedupeKey?: string;
}

/** Why a notification was not shown (returned to the caller, never thrown). */
export type NotificationOutcomeReason =
  | 'disabled'
  | 'duplicate'
  | 'rate-limited'
  | 'unsupported'
  | 'invalid';

export interface NotificationOutcome {
  shown: boolean;
  reason?: NotificationOutcomeReason;
  /**
   * How many notifications of this kind have been suppressed by the
   * rate limit so far (0 when this call was shown or dropped for
   * another reason). Lets the caller log / surface the loss.
   */
  suppressed?: number;
  /** Human-readable detail for logs (never contains secrets). */
  detail?: string;
}

/** What the platform adapter receives when a notification is shown. */
export interface ShownNotification {
  title: string;
  body: string;
  /** Internal route the click should open (never an external URL). */
  route: DeepLinkRoute;
  /** Called by the adapter when the user clicks the notification. */
  onClick: () => void;
}

export interface NotificationServiceOptions {
  /** Platform adapter: display the notification (Electron Notification in main). */
  show: (notification: ShownNotification) => void;
  /** False on a machine with no notification support (headless Linux). */
  isSupported: () => boolean;
  /** Per-kind user toggle (main reads Settings). */
  isEnabled: (kind: NotificationKind) => boolean;
  /** Called on click with the internal route to open. */
  onActivate: (route: DeepLinkRoute) => void;
  /** Clock override for tests (defaults to Date.now). */
  now?: () => number;
}

/** Dedupe window: identical notifications inside this window are dropped. */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 10_000;
/** Rate limit: at most this many shown notifications per kind per window. */
export const NOTIFICATION_RATE_LIMIT_MAX = 5;
/** Rate-limit window (rolling). */
export const NOTIFICATION_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Validate an untrusted notification request (IPC / coordinator input).
 * Returns the trimmed, capped request, or a reason — never throws.
 * Title/body are required; a missing botId means "open the chat
 * screen" on click.
 */
export function validateNotificationRequest(
  input: unknown,
): { ok: true; request: NotificationRequest } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'notification request must be an object' };
  }
  const raw = input as Record<string, unknown>;
  if (!isNotificationKind(raw['kind'])) {
    return { ok: false, error: 'unknown notification kind' };
  }
  if (typeof raw['title'] !== 'string' || raw['title'].trim().length === 0) {
    return { ok: false, error: 'notification title must be a non-empty string' };
  }
  if (typeof raw['body'] !== 'string' || raw['body'].trim().length === 0) {
    return { ok: false, error: 'notification body must be a non-empty string' };
  }
  const title = raw['title'].trim().slice(0, MAX_NOTIFICATION_TITLE_CHARS);
  const body = raw['body'].trim().slice(0, MAX_NOTIFICATION_BODY_CHARS);
  const request: NotificationRequest = { kind: raw['kind'], title, body };
  if (raw['botId'] !== undefined) {
    if (typeof raw['botId'] !== 'string' || !BOT_ID_RE.test(raw['botId'])) {
      return { ok: false, error: 'invalid botId' };
    }
    request.botId = raw['botId'];
  }
  if (raw['dedupeKey'] !== undefined) {
    if (typeof raw['dedupeKey'] !== 'string' || raw['dedupeKey'].trim().length === 0) {
      return { ok: false, error: 'dedupeKey must be a non-empty string' };
    }
    request.dedupeKey = raw['dedupeKey'].trim().slice(0, 128);
  }
  return { ok: true, request };
}

/**
 * Anti-spam OS notification service. Pure logic + injected platform
 * adapter; safe to construct in tests with a fake `show`.
 *
 * `notify()` never throws for a bad request or a failing adapter: a
 * notification is best-effort by nature, and a crash in the
 * notification path must never take down a run. Adapter errors are
 * swallowed and reported as `{ shown: false, reason: 'unsupported' }`
 * with the detail in the outcome (main logs it).
 */
export class NotificationService {
  private readonly show: NotificationServiceOptions['show'];
  private readonly isSupported: NotificationServiceOptions['isSupported'];
  private readonly isEnabled: NotificationServiceOptions['isEnabled'];
  private readonly onActivate: NotificationServiceOptions['onActivate'];
  private readonly now: () => number;
  /** Dedupe key -> last shown timestamp (ms). */
  private readonly lastShownByKey = new Map<string, number>();
  /** Kind -> shown timestamps (ms) inside the current rate window. */
  private readonly shownAtByKind = new Map<NotificationKind, number[]>();
  /** Kind -> total suppressed by the rate limit (for reporting). */
  private readonly suppressedByKind = new Map<NotificationKind, number>();

  constructor(options: NotificationServiceOptions) {
    this.show = options.show;
    this.isSupported = options.isSupported;
    this.isEnabled = options.isEnabled;
    this.onActivate = options.onActivate;
    this.now = options.now ?? Date.now;
  }

  /** Total notifications suppressed by the rate limit for a kind. */
  suppressedCount(kind: NotificationKind): number {
    return this.suppressedByKind.get(kind) ?? 0;
  }

  notify(input: unknown): NotificationOutcome {
    const validated = validateNotificationRequest(input);
    if (!validated.ok) {
      return { shown: false, reason: 'invalid', detail: validated.error };
    }
    const request = validated.request;
    if (!this.isEnabled(request.kind)) {
      return { shown: false, reason: 'disabled' };
    }
    if (!this.isSupported()) {
      return { shown: false, reason: 'unsupported' };
    }
    const now = this.now();
    const key = request.dedupeKey ?? `${request.kind}|${request.botId ?? ''}|${request.title}`;
    const lastShown = this.lastShownByKey.get(key);
    if (lastShown !== undefined && now - lastShown < NOTIFICATION_DEDUPE_WINDOW_MS) {
      return { shown: false, reason: 'duplicate' };
    }
    const shownAt = (this.shownAtByKind.get(request.kind) ?? []).filter(
      (t) => now - t < NOTIFICATION_RATE_LIMIT_WINDOW_MS,
    );
    if (shownAt.length >= NOTIFICATION_RATE_LIMIT_MAX) {
      this.shownAtByKind.set(request.kind, shownAt);
      const suppressed = (this.suppressedByKind.get(request.kind) ?? 0) + 1;
      this.suppressedByKind.set(request.kind, suppressed);
      return { shown: false, reason: 'rate-limited', suppressed };
    }
    const route: DeepLinkRoute = request.botId
      ? { kind: 'bot', botId: request.botId }
      : { kind: 'chat' };
    try {
      this.show({
        title: request.title,
        body: request.body,
        route,
        onClick: () => this.onActivate(route),
      });
    } catch (err) {
      return {
        shown: false,
        reason: 'unsupported',
        detail: err instanceof Error ? err.message : 'show adapter failed',
      };
    }
    this.lastShownByKey.set(key, now);
    shownAt.push(now);
    this.shownAtByKind.set(request.kind, shownAt);
    return { shown: true };
  }
}
