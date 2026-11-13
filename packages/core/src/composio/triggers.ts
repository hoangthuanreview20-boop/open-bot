/**
 * Composio triggers → automations (v0.83b).
 *
 * When something happens in a connected app (a new Gmail message, a
 * GitHub issue, a Slack message...), Composio POSTs the event to the
 * webhook URL registered for the project. This module is the
 * receiving side of that flow — it does NOT create trigger instances
 * in Composio (the user does that in the Composio dashboard / SDK,
 * pointing the trigger at open-bot's Local API route
 * `POST /v1/automations/:id/composio-trigger`; see
 * `docs/composio-integration.md`).
 *
 * Wire format (Composio docs, "Receiving events" + "Triggers",
 * verified 2026-11-11): every event arrives in the SAME V3 envelope,
 * whether the trigger type is realtime (webhook) or polling:
 *
 *   {
 *     "id": "msg_abc123",
 *     "type": "composio.trigger.message",
 *     "metadata": {
 *       "log_id": "log_abc123",
 *       "trigger_slug": "GITHUB_COMMIT_EVENT",
 *       "trigger_id": "ti_xyz789",
 *       "connected_account_id": "ca_def456",
 *       "auth_config_id": "ac_xyz789",
 *       "user_id": "user-id-123435"
 *     },
 *     "data": { "commit_sha": "a1b2c3d", "message": "...", "author": "jane" },
 *     "timestamp": "2026-01-15T10:30:00Z"
 *   }
 *
 * Authentication — Composio signs EVERY webhook request
 * (docs: "Composio signs every webhook request"):
 *   signature = HMAC-SHA256(`${webhook-id}.${webhook-timestamp}.${rawBody}`, secret)
 *   headers: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`
 *   tolerance: 300 s (replay protection — same as the SDK's default).
 * The secret is the project's `COMPOSIO_WEBHOOK_SECRET` (stored per
 * automation in the Vault, see `triggerKeys.ts` — never logged, never
 * returned to the renderer except once at creation).
 *
 * Fallback auth — URL token: when a delivery carries NO signature
 * headers (e.g. a forwarder that strips them, or a local test
 * through `composio dev triggers listen --forward` without a secret
 * configured), the route also accepts `?token=<secret>` compared
 * timing-safe against a per-automation token in the Vault. A
 * delivery with neither a signature nor a token is rejected, and a
 * delivery whose signature headers are present but INVALID is
 * rejected even if a valid token is also supplied (a present-but-bad
 * signature is evidence of tampering, not of a missing secret).
 *
 * Routing — one webhook URL receives EVERY trigger event of the
 * project, so the scheduler checks the envelope's `trigger_slug`
 * against the automation's configured slug and drops mismatches
 * (no run recorded). Unknown slugs are accepted at the route level
 * (any slug matching `^[A-Z][A-Z0-9_]+$` may be configured — the
 * full catalog is 447 trigger types across open-bot's 40 toolkits,
 * see the live snapshot
 * `scripts/composio-triggers-live-v083/trigger-types-22.json`);
 * the curated list below is only the picker in the UI.
 *
 * Limits (honest, checked live 2026-11-11 via
 * `GET /api/v3.1/triggers_types`, 714 trigger types paged):
 * - Telegram and Dropbox have ZERO trigger types in Composio's
 *   catalog — no trigger can be wired for them (yet).
 * - The `toolkit_slug` query param on `/triggers_types` is IGNORED
 *   by the API (same as `/tools` with `toolkit`): the catalog had
 *   to be paged whole (15 pages) and filtered client-side by
 *   `toolkit.slug`.
 * - Trigger instances are NOT created by open-bot: the user creates
 *   the trigger in Composio (dashboard/SDK/CLI) for their connected
 *   account. Open-bot only receives and routes.
 * - The Local API listens on loopback, so Composio (public internet)
 *   cannot reach it directly: production delivery needs a tunnel
 *   (`cloudflared tunnel --url http://127.0.0.1:<port>` / ngrok) or
 *   `composio dev triggers listen --forward <local-url>` (see docs).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the Composio webhook id (`webhook-id`). */
export const COMPOSIO_WEBHOOK_ID_HEADER = 'webhook-id';
/** Header carrying the Composio webhook timestamp (`webhook-timestamp`). */
export const COMPOSIO_WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';
/** Header carrying the Composio webhook signature (`webhook-signature`). */
export const COMPOSIO_WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';
/** Prefix of the signature value: `v1,<base64 HMAC>`. */
export const COMPOSIO_WEBHOOK_SIGNATURE_PREFIX = 'v1,';
/** Replay tolerance for `webhook-timestamp` (seconds — SDK default). */
export const COMPOSIO_WEBHOOK_TOLERANCE_SECONDS = 300;

/** A trigger slug is uppercase letters/digits/underscores. */
export const COMPOSIO_TRIGGER_SLUG_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/** One trigger type the UI offers (curated from the live catalog). */
export interface ComposioTriggerDef {
  /** Toolkit slug, e.g. 'gmail' (matches COMPOSIO_TOOLKIT_SLUGS). */
  toolkit: string;
  /** Trigger slug, e.g. 'GMAIL_NEW_GMAIL_MESSAGE'. */
  slug: string;
  /** Human-readable name from Composio's catalog. */
  name: string;
  /** How Composio learns about the event: realtime push or polling. */
  delivery: 'webhook' | 'poll';
}

/**
 * Curated trigger types per toolkit (50 entries v0.83 + 29 entries
 * v0.96 = 79 entries) — the headline trigger(s) of each toolkit,
 * taken VERBATIM from Composio's live `GET /api/v3.1/triggers_types`
 * catalog (2026-11-11, 714 types paged; 2026-11-13 re-fetch: catalog
 * still 714 types; full 22-toolkit subset in
 * `scripts/composio-triggers-live-v083/trigger-types-22.json`, 18
 * new toolkits in
 * `scripts/composio-triggers-live-v096/trigger-types-v096.json`).
 * Realtime (`webhook`) triggers are preferred where the toolkit has
 * them; otherwise the most useful polling trigger is listed. Any
 * other catalog slug may still be typed in by hand in the UI — the
 * scheduler validates the slug FORMAT, not membership in this list.
 */
export const COMPOSIO_TRIGGER_DEFS: readonly ComposioTriggerDef[] = [
  { toolkit: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE', name: 'New Gmail Message Received Trigger', delivery: 'poll' },
  { toolkit: 'gmail', slug: 'GMAIL_EMAIL_SENT_TRIGGER', name: 'Email Sent', delivery: 'poll' },
  { toolkit: 'github', slug: 'GITHUB_COMMIT_EVENT', name: 'Commit Event', delivery: 'webhook' },
  { toolkit: 'github', slug: 'GITHUB_ISSUE_ADDED_EVENT', name: 'Issue Added Event', delivery: 'webhook' },
  { toolkit: 'github', slug: 'GITHUB_PULL_REQUEST_EVENT', name: 'Pull Request Event', delivery: 'webhook' },
  { toolkit: 'github', slug: 'GITHUB_ISSUE_CREATED_TRIGGER', name: 'New Issue Created', delivery: 'poll' },
  { toolkit: 'slack', slug: 'SLACK_CHANNEL_MESSAGE_RECEIVED', name: 'Channel Message Received', delivery: 'webhook' },
  { toolkit: 'slack', slug: 'SLACK_DIRECT_MESSAGE_RECEIVED', name: 'Direct Message Received', delivery: 'webhook' },
  { toolkit: 'slack', slug: 'SLACK_RECEIVE_MESSAGE', name: 'New Message Received Trigger', delivery: 'webhook' },
  { toolkit: 'notion', slug: 'NOTION_PAGE_CREATED', name: 'Page Created', delivery: 'webhook' },
  { toolkit: 'notion', slug: 'NOTION_PAGE_CONTENT_UPDATED', name: 'Page Content Updated', delivery: 'webhook' },
  { toolkit: 'notion', slug: 'NOTION_COMMENT_CREATED', name: 'Comment Created', delivery: 'webhook' },
  { toolkit: 'googlesheets', slug: 'GOOGLESHEETS_NEW_ROWS_TRIGGER', name: 'New Rows in Google Sheet', delivery: 'poll' },
  { toolkit: 'googlesheets', slug: 'GOOGLESHEETS_SPREADSHEET_ROW_CHANGED_TRIGGER', name: 'Spreadsheet Row Changed', delivery: 'poll' },
  { toolkit: 'googledrive', slug: 'GOOGLEDRIVE_FILE_CREATED_TRIGGER', name: 'File Created', delivery: 'poll' },
  { toolkit: 'googledrive', slug: 'GOOGLEDRIVE_FILE_UPDATED_TRIGGER', name: 'File Updated', delivery: 'poll' },
  { toolkit: 'googlecalendar', slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER', name: 'Event Created', delivery: 'poll' },
  { toolkit: 'googlecalendar', slug: 'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER', name: 'Event Starting Soon', delivery: 'poll' },
  { toolkit: 'jira', slug: 'JIRA_ISSUE_CREATED', name: 'Issue Created', delivery: 'webhook' },
  { toolkit: 'jira', slug: 'JIRA_ISSUE_UPDATED', name: 'Issue Updated', delivery: 'webhook' },
  { toolkit: 'jira', slug: 'JIRA_COMMENT_CREATED', name: 'Comment Created', delivery: 'webhook' },
  { toolkit: 'linear', slug: 'LINEAR_ISSUE_CREATED_TRIGGER', name: 'Issue Created Trigger', delivery: 'webhook' },
  { toolkit: 'linear', slug: 'LINEAR_ISSUE_UPDATED_TRIGGER', name: 'Issue Updated Trigger', delivery: 'webhook' },
  { toolkit: 'linear', slug: 'LINEAR_COMMENT_EVENT_TRIGGER', name: 'Comment Received Trigger', delivery: 'webhook' },
  { toolkit: 'discord', slug: 'DISCORD_NEW_MESSAGE_TRIGGER', name: 'New Discord Message Trigger', delivery: 'poll' },
  { toolkit: 'trello', slug: 'TRELLO_CARD_CREATED', name: 'Card Created', delivery: 'webhook' },
  { toolkit: 'trello', slug: 'TRELLO_CARD_MOVED_BETWEEN_LISTS', name: 'Card Moved Between Lists', delivery: 'webhook' },
  { toolkit: 'trello', slug: 'TRELLO_COMMENT_ADDED_TO_CARD', name: 'Comment Added To Card', delivery: 'webhook' },
  { toolkit: 'asana', slug: 'ASANA_TASK_CREATED', name: 'New Task Created', delivery: 'webhook' },
  { toolkit: 'asana', slug: 'ASANA_TASK_UPDATED', name: 'Task Updated', delivery: 'webhook' },
  { toolkit: 'asana', slug: 'ASANA_TASK_COMMENT_ADDED', name: 'New Comment on Task', delivery: 'webhook' },
  { toolkit: 'hubspot', slug: 'HUBSPOT_CONTACT_CREATED_TRIGGER', name: 'Contact Created Trigger', delivery: 'webhook' },
  { toolkit: 'hubspot', slug: 'HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER', name: 'Deal Stage UpdatedTrigger', delivery: 'webhook' },
  { toolkit: 'zoom', slug: 'ZOOM_NEW_CLOUD_RECORDING_TRIGGER', name: 'New Cloud Recording', delivery: 'poll' },
  { toolkit: 'zoom', slug: 'ZOOM_MEETING_SUMMARY_UPDATED_TRIGGER', name: 'Meeting Summary Created or Updated', delivery: 'poll' },
  { toolkit: 'salesforce', slug: 'SALESFORCE_NEW_LEAD_TRIGGER', name: 'New Lead Trigger', delivery: 'poll' },
  { toolkit: 'salesforce', slug: 'SALESFORCE_NEW_OR_UPDATED_OPPORTUNITY_TRIGGER', name: 'New or Updated Opportunity', delivery: 'poll' },
  { toolkit: 'zendesk', slug: 'ZENDESK_NEW_ZENDESK_TICKET_TRIGGER', name: 'New Zendesk Ticket', delivery: 'poll' },
  { toolkit: 'zendesk', slug: 'ZENDESK_NEW_USER_TRIGGER', name: 'New User Created', delivery: 'webhook' },
  { toolkit: 'airtable', slug: 'AIRTABLE_VIEW_CREATED_TRIGGER', name: 'View Created', delivery: 'poll' },
  { toolkit: 'airtable', slug: 'AIRTABLE_BASE_SCHEMA_CHANGED_TRIGGER', name: 'Base Schema Changed', delivery: 'poll' },
  { toolkit: 'monday', slug: 'MONDAY_ITEM_CREATED', name: 'Item Created', delivery: 'webhook' },
  { toolkit: 'monday', slug: 'MONDAY_ITEM_COLUMN_VALUE_UPDATED', name: 'Item Column Value Updated', delivery: 'webhook' },
  { toolkit: 'monday', slug: 'MONDAY_ITEM_UPDATE_POSTED', name: 'Item Update Posted', delivery: 'webhook' },
  { toolkit: 'clickup', slug: 'CLICKUP_TASK_CREATED', name: 'Task Created', delivery: 'webhook' },
  { toolkit: 'clickup', slug: 'CLICKUP_TASK_STATUS_UPDATED', name: 'Task Status Updated', delivery: 'webhook' },
  { toolkit: 'clickup', slug: 'CLICKUP_TASK_COMMENT_POSTED', name: 'Task Comment Posted', delivery: 'webhook' },
  { toolkit: 'outlook', slug: 'OUTLOOK_MESSAGE_TRIGGER', name: 'New Outlook Message', delivery: 'webhook' },
  { toolkit: 'outlook', slug: 'OUTLOOK_EVENT_TRIGGER', name: 'New Calendar Event', delivery: 'webhook' },
  { toolkit: 'outlook', slug: 'OUTLOOK_SENT_MESSAGE_TRIGGER', name: 'New Sent Message', delivery: 'webhook' },
  // v0.96 Team T4: 29 trigger đại diện cho 11/18 toolkit mới (đối chiếu
  // live GET /api/v3.1/triggers_types 2026-11-13, 714 type; xem
  // scripts/composio-triggers-live-v096/trigger-types-v096.json).
  // 7 toolkit mới có ZERO trigger trong catalog: gitlab, linkedin,
  // reddit, pagerduty, sendgrid, bitbucket, freshdesk (như telegram/
  // dropbox ở v0.83 — chỉ gọi tool chủ động được, không nhận event).
  { toolkit: 'stripe', slug: 'STRIPE_CHARGE_SUCCEEDED', name: 'Charge Succeeded', delivery: 'webhook' },
  { toolkit: 'stripe', slug: 'STRIPE_CHARGE_FAILED', name: 'Charge Failed', delivery: 'webhook' },
  { toolkit: 'stripe', slug: 'STRIPE_CHECKOUT_SESSION_COMPLETED', name: 'Checkout Session Completed', delivery: 'webhook' },
  { toolkit: 'shopify', slug: 'SHOPIFY_PRODUCT_CREATED', name: 'Product Created', delivery: 'webhook' },
  { toolkit: 'shopify', slug: 'SHOPIFY_COLLECTION_CREATED', name: 'Collection Created', delivery: 'webhook' },
  { toolkit: 'shopify', slug: 'SHOPIFY_CUSTOMER_SEGMENT_CREATED', name: 'Customer Segment Created', delivery: 'webhook' },
  { toolkit: 'box', slug: 'BOX_NEW_FILE_ADDED_TRIGGER', name: 'New File Added to Folder', delivery: 'poll' },
  { toolkit: 'box', slug: 'BOX_FILE_VERSION_UPLOADED_TRIGGER', name: 'New File Version Uploaded', delivery: 'poll' },
  { toolkit: 'box', slug: 'BOX_FOLDER_ITEM_ADDED_TRIGGER', name: 'New Item Added to Folder', delivery: 'poll' },
  { toolkit: 'confluence', slug: 'CONFLUENCE_NEW_BLOG_POST_CREATED_TRIGGER', name: 'New Blog Post Created', delivery: 'poll' },
  { toolkit: 'confluence', slug: 'CONFLUENCE_NEW_CHILD_PAGE_TRIGGER', name: 'New Child Page Created', delivery: 'poll' },
  { toolkit: 'confluence', slug: 'CONFLUENCE_NEW_CQL_CONTENT_MATCH_TRIGGER', name: 'New CQL Content Match', delivery: 'poll' },
  { toolkit: 'calendly', slug: 'CALENDLY_MEETING_SCHEDULED', name: 'Meeting Scheduled', delivery: 'webhook' },
  { toolkit: 'calendly', slug: 'CALENDLY_MEETING_CANCELED', name: 'Meeting Canceled', delivery: 'webhook' },
  { toolkit: 'calendly', slug: 'CALENDLY_INVITEE_MARKED_NO_SHOW', name: 'Invitee Marked No-Show', delivery: 'webhook' },
  { toolkit: 'mailchimp', slug: 'MAILCHIMP_SUBSCRIBE_TRIGGER', name: 'Subscribe Trigger', delivery: 'webhook' },
  { toolkit: 'mailchimp', slug: 'MAILCHIMP_UNSUBSCRIBE_TRIGGER', name: 'Unsubscribe Trigger', delivery: 'webhook' },
  { toolkit: 'mailchimp', slug: 'MAILCHIMP_CAMPAIGN_TRIGGER', name: 'Campaign Trigger', delivery: 'webhook' },
  { toolkit: 'twilio', slug: 'TWILIO_CALL_COMPLETED', name: 'Call Completed', delivery: 'webhook' },
  { toolkit: 'twilio', slug: 'TWILIO_CALL_RECORDING_READY', name: 'Call Recording Ready', delivery: 'webhook' },
  { toolkit: 'twilio', slug: 'TWILIO_CONVERSATION_MESSAGE_ADDED', name: 'Conversation Message Added', delivery: 'webhook' },
  { toolkit: 'googledocs', slug: 'GOOGLEDOCS_DOCUMENT_CREATED_TRIGGER', name: 'New Document Created', delivery: 'poll' },
  { toolkit: 'googledocs', slug: 'GOOGLEDOCS_DOCUMENT_UPDATED_TRIGGER', name: 'Document Updated', delivery: 'poll' },
  { toolkit: 'googledocs', slug: 'GOOGLEDOCS_KEYWORD_DETECTED_TRIGGER', name: 'Keyword Detected in Document', delivery: 'poll' },
  { toolkit: 'youtube', slug: 'YOUTUBE_NEW_ACTIVITY_TRIGGER', name: 'New YouTube Activity', delivery: 'poll' },
  { toolkit: 'youtube', slug: 'YOUTUBE_NEW_PLAYLIST_ITEM_TRIGGER', name: 'New Item in YouTube Playlist', delivery: 'poll' },
  { toolkit: 'youtube', slug: 'YOUTUBE_NEW_SUBSCRIPTION_TRIGGER', name: 'New YouTube Channel Subscription', delivery: 'poll' },
  { toolkit: 'whatsapp', slug: 'WHATSAPP_MESSAGE_STATUS_UPDATED_TRIGGER', name: 'Message Status Updated', delivery: 'poll' },
  { toolkit: 'typeform', slug: 'TYPEFORM_NEW_RESPONSE', name: 'New Form Response', delivery: 'webhook' },
];

/** Curated slugs only (for the UI picker). */
export const COMPOSIO_TRIGGER_SLUGS: readonly string[] = COMPOSIO_TRIGGER_DEFS.map((d) => d.slug);

/**
 * Trigger-type counts per toolkit from the live catalog (2026-11-11
 * 244 total across the 22 toolkits + 2026-11-13 203 total across the
 * 18 new toolkits = 447 total; Telegram, Dropbox, GitLab, LinkedIn,
 * Reddit, PagerDuty, SendGrid, Bitbucket, Freshdesk have none).
 * The scheduler does NOT enforce these — they document coverage.
 */
export const COMPOSIO_TRIGGER_COUNTS: Readonly<Record<string, number>> = {
  gmail: 2,
  github: 46,
  slack: 9,
  notion: 8,
  googlesheets: 16,
  googledrive: 7,
  googlecalendar: 6,
  jira: 17,
  linear: 12,
  discord: 1,
  telegram: 0,
  trello: 43,
  asana: 6,
  hubspot: 2,
  zoom: 11,
  salesforce: 7,
  zendesk: 2,
  airtable: 6,
  monday: 17,
  clickup: 21,
  dropbox: 0,
  outlook: 5,
  stripe: 40,
  shopify: 45,
  box: 20,
  confluence: 23,
  gitlab: 0,
  calendly: 10,
  mailchimp: 4,
  twilio: 45,
  googledocs: 10,
  youtube: 4,
  linkedin: 0,
  reddit: 0,
  whatsapp: 1,
  pagerduty: 0,
  typeform: 1,
  sendgrid: 0,
  bitbucket: 0,
  freshdesk: 0,
};

/** Total trigger types across open-bot's 40 toolkits (live catalog). */
export const COMPOSIO_TRIGGER_TOTAL_COUNT = 447;

/** Find a curated def by slug (undefined when not curated). */
export function findComposioTriggerDef(slug: string): ComposioTriggerDef | undefined {
  return COMPOSIO_TRIGGER_DEFS.find((d) => d.slug === slug);
}

/** True when the slug is in the curated picker list. */
export function isKnownComposioTriggerSlug(slug: string): boolean {
  return findComposioTriggerDef(slug) !== undefined;
}

/** True when the slug has the right SHAPE (any catalog slug qualifies). */
export function isValidComposioTriggerSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && COMPOSIO_TRIGGER_SLUG_RE.test(slug);
}

/** One parsed Composio trigger event (V3 envelope). */
export interface ComposioTriggerEvent {
  /** Envelope id (`msg_...`), when present. */
  eventId?: string;
  /** Envelope type, e.g. `composio.trigger.message`. */
  type?: string;
  /** Trigger type, e.g. `GITHUB_COMMIT_EVENT`. */
  triggerSlug: string;
  /** Trigger instance id (`ti_...`), when present. */
  triggerId?: string;
  /** Connected account id (`ca_...`), when present. */
  connectedAccountId?: string;
  /** Auth config id (`ac_...`), when present. */
  authConfigId?: string;
  /** Composio user id, when present. */
  userId?: string;
  /** Envelope timestamp, when present. */
  timestamp?: string;
  /** The event itself, in the shape the trigger type declares. */
  data: unknown;
}

/**
 * Parse a raw Composio webhook body into a trigger event. Accepts
 * the V3 envelope (`metadata.trigger_slug` + `data`); `payload` is
 * accepted as an alias for `data` (some forwarders re-wrap it).
 * Throws a clear error on invalid JSON, on a missing trigger slug,
 * or on a non-V3 shape — the caller must not run anything for an
 * unparseable delivery.
 */
export function parseComposioTriggerPayload(rawBody: string | Buffer): ComposioTriggerEvent {
  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Composio trigger body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Composio trigger body must be a JSON object (V3 envelope).');
  }
  const obj = parsed as Record<string, unknown>;
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Composio trigger body has no metadata — only the V3 envelope is supported.');
  }
  const meta = metadata as Record<string, unknown>;
  const triggerSlug = meta.trigger_slug;
  if (typeof triggerSlug !== 'string' || triggerSlug.trim() === '') {
    throw new Error('Composio trigger body has no metadata.trigger_slug.');
  }
  if (!isValidComposioTriggerSlug(triggerSlug)) {
    throw new Error(`Composio trigger slug has an unexpected shape: ${JSON.stringify(triggerSlug)}.`);
  }
  const data = obj.data !== undefined ? obj.data : obj.payload;
  if (data === undefined) {
    throw new Error('Composio trigger body has neither data nor payload.');
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    ...(str(obj.id) ? { eventId: str(obj.id) } : {}),
    ...(str(obj.type) ? { type: str(obj.type) } : {}),
    triggerSlug,
    ...(str(meta.trigger_id) ? { triggerId: str(meta.trigger_id) } : {}),
    ...(str(meta.connected_account_id) ? { connectedAccountId: str(meta.connected_account_id) } : {}),
    ...(str(meta.auth_config_id) ? { authConfigId: str(meta.auth_config_id) } : {}),
    ...(str(meta.user_id) ? { userId: str(meta.user_id) } : {}),
    ...(str(obj.timestamp) ? { timestamp: str(obj.timestamp) } : {}),
    data,
  };
}

/**
 * Compute the signature value for a delivery:
 * `v1,<base64 HMAC-SHA256(${webhookId}.${timestamp}.${rawBody})>`.
 * The host uses this to sign its own test deliveries; Composio
 * computes the same value with the project's webhook secret.
 */
export function computeComposioWebhookSignature(
  secret: string,
  webhookId: string,
  timestamp: string | number,
  rawBody: string | Buffer,
): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const hmac = createHmac('sha256', secret);
  hmac.update(`${webhookId}.${timestamp}.`, 'utf8');
  hmac.update(body);
  return `${COMPOSIO_WEBHOOK_SIGNATURE_PREFIX}${hmac.digest('base64')}`;
}

/**
 * Verify a Composio webhook signature. Returns false (never throws)
 * for a missing/empty secret, missing headers, a malformed signature,
 * a timestamp more than `toleranceSeconds` away from `now`, or a
 * mismatched HMAC. Comparison is timing-safe on fixed-length
 * buffers; a length mismatch is rejected without comparing. The
 * signature must be `v1,<base64>` (bare base64 is also accepted for
 * forwarders that strip the prefix).
 */
export function verifyComposioWebhookSignature(
  secret: string,
  webhookId: string | null | undefined,
  timestamp: string | number | null | undefined,
  rawBody: string | Buffer,
  signature: string | null | undefined,
  opts?: { now?: Date; toleranceSeconds?: number },
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof webhookId !== 'string' || webhookId === '') return false;
  if (timestamp === null || timestamp === undefined || timestamp === '') return false;
  const tsText = String(timestamp);
  if (!/^\d+$/.test(tsText)) return false;
  const tsSeconds = Number(tsText);
  if (!Number.isFinite(tsSeconds)) return false;
  const nowSeconds = Math.floor((opts?.now ?? new Date()).getTime() / 1000);
  const tolerance = opts?.toleranceSeconds ?? COMPOSIO_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - tsSeconds) > tolerance) return false;
  if (typeof signature !== 'string' || signature === '') return false;
  let givenB64 = signature;
  if (givenB64.startsWith(COMPOSIO_WEBHOOK_SIGNATURE_PREFIX)) {
    givenB64 = givenB64.slice(COMPOSIO_WEBHOOK_SIGNATURE_PREFIX.length);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(givenB64)) return false;
  const expected = computeComposioWebhookSignature(secret, webhookId, tsText, rawBody);
  const expectedB64 = expected.slice(COMPOSIO_WEBHOOK_SIGNATURE_PREFIX.length);
  const expectedBuf = Buffer.from(expectedB64, 'utf8');
  const givenBuf = Buffer.from(givenB64, 'utf8');
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}

/**
 * Compare a `?token=` value against the stored URL-token secret
 * (timing-safe; false for missing/empty values — never throws).
 */
export function verifyComposioTriggerToken(
  storedToken: string | null | undefined,
  givenToken: string | null | undefined,
): boolean {
  if (typeof storedToken !== 'string' || storedToken.length === 0) return false;
  if (typeof givenToken !== 'string' || givenToken.length === 0) return false;
  const expected = Buffer.from(storedToken, 'utf8');
  const given = Buffer.from(givenToken, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * Map a parsed trigger event to the automation trigger input (the
 * value `applyTriggerInputToAction` shapes the action with — see
 * `automations/webhook.ts`): the run-agent prompt gets the event
 * context appended, run-tool args are filled from the event data.
 * The full envelope metadata travels along so a run's history shows
 * WHICH trigger instance and account fired it.
 */
export function composioTriggerToInput(event: ComposioTriggerEvent): Record<string, unknown> {
  return {
    triggerSlug: event.triggerSlug,
    ...(event.triggerId ? { triggerId: event.triggerId } : {}),
    ...(event.connectedAccountId ? { connectedAccountId: event.connectedAccountId } : {}),
    ...(event.userId ? { userId: event.userId } : {}),
    ...(event.eventId ? { eventId: event.eventId } : {}),
    data: event.data,
  };
}
