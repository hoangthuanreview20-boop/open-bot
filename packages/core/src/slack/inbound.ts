/**
 * Slack inbound — Events API + interactive payloads (v0.87a, P2-2).
 *
 * Slack can reach open-bot two ways, and both land on the SAME
 * automation routing (see `AutomationScheduler.handleSlackInbound`
 * and `handleComposioTrigger`):
 *
 * 1. Direct Slack webhook — the Slack app posts Events API payloads
 *    (`event_callback` with `message` / `app_mention`) and
 *    interactivity payloads (`block_actions` / `view_submission` /
 *    `view_closed`, i.e. dialogs/modals) to
 *    `POST /v1/automations/:id/slack-inbound`. Auth is Slack's own
 *    signing secret (HMAC-SHA256 `v0:{timestamp}:{rawBody}`, 300 s
 *    replay tolerance — the same tolerance v0.83b uses for Composio).
 *    The secret is the Slack app's *Signing Secret* (Slack app
 *    settings → Basic Information), pasted per automation into the
 *    Vault namespace `slack-inbound-keys/` (see `keys.ts`).
 * 2. Via Composio — a Slack trigger (`SLACK_CHANNEL_MESSAGE_RECEIVED`,
 *    `SLACK_DIRECT_MESSAGE_RECEIVED`, `SLACK_RECEIVE_MESSAGE`, all
 *    verified live in the Composio trigger catalog 2026-11-11, see
 *    `scripts/composio-triggers-live-v083/trigger-types-22.json`)
 *    delivers a V3 envelope to the existing
 *    `POST /v1/automations/:id/composio-trigger` route (v0.83b).
 *    The scheduler verifies the Composio webhook signature there;
 *    this module only NORMALIZES the Slack message inside the
 *    envelope `data` (`normalizeSlackMessageFromComposioData`) so the
 *    automation sees the same shape as on the direct path.
 *
 * Replies go back to Slack through the slug that already exists:
 * `SLACK_SEND_MESSAGE` (live-verified v0.72 — required arg
 * `channel`, `markdown_text` for content, optional `thread_ts`).
 * `slackReplyArgs(message, text)` builds exactly that arguments
 * object; a typical automation action is a run-tool
 * `COMPOSIO_MULTI_EXECUTE_TOOL` with
 * `tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: <that> }]`.
 *
 * Honest limits (do NOT paper over these):
 * - The Local API listens on loopback only, so neither Slack nor
 *   Composio (public internet) can reach it directly: production
 *   delivery needs a tunnel (`cloudflared tunnel --url
 *   http://127.0.0.1:<port>` / ngrok) or `composio dev triggers
 *   listen --forward <local-url>` for the Composio path. Local
 *   testing uses signed HTTP calls against the loopback server.
 * - The exact `data` shape of a Composio Slack trigger was NEVER
 *   observed live (the v0.83b live test only listed trigger types,
 *   no event ever fired). The normalizer therefore accepts several
 *   plausible shapes (`data.event`, `data.message`, a bare Slack
 *   event, or flattened `text` + `channel`/`channel_id` fields) and
 *   returns null when nothing matches — the raw `data` still reaches
 *   the automation untouched, so an unrecognised shape degrades to
 *   "raw JSON in the prompt", never to a dropped event.
 * - Interactive payloads are routed to the automation as trigger
 *   input; open-bot does NOT answer Slack's `response_url` and does
 *   NOT return a modal update (`response_action`). A slow agent
 *   action can therefore exceed Slack's 3 s acknowledgement window
 *   and Slack shows the user a timeout warning — use a fast run-tool
 *   reply (SLACK_SEND_MESSAGE) for dialogs, or a run-agent action
 *   only when the delay is acceptable. The route itself always
 *   answers 200 once the run finishes.
 * - `url_verification` is answered (challenge echo) without running
 *   anything; bot messages and `message_changed` / `message_deleted`
 *   subtypes are ignored (200, no run) so the bot never talks to
 *   itself and edits do not re-fire an automation.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the Slack request signature (`x-slack-signature`). */
export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';
/** Header carrying the Slack request timestamp (`x-slack-request-timestamp`). */
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';
/** Prefix of the signature value: `v0,<hex HMAC>`. */
export const SLACK_SIGNATURE_VERSION = 'v0';
/** Replay tolerance for `x-slack-request-timestamp` (seconds — same as v0.83b). */
export const SLACK_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Composio trigger slugs that carry an inbound Slack message (live
 * catalog 2026-11-11, `scripts/composio-triggers-live-v083/`).
 * `SLACK_RECEIVE_BOT_MESSAGE` is deliberately NOT here: bot messages
 * are ignored on the direct path too, so a bot-message trigger would
 * never fire through this module.
 */
export const SLACK_MESSAGE_TRIGGER_SLUGS: readonly string[] = [
  'SLACK_CHANNEL_MESSAGE_RECEIVED',
  'SLACK_DIRECT_MESSAGE_RECEIVED',
  'SLACK_RECEIVE_MESSAGE',
];

/** True when the slug is one of the inbound-Slack message triggers. */
export function isSlackMessageTriggerSlug(slug: string): boolean {
  return (SLACK_MESSAGE_TRIGGER_SLUGS as readonly string[]).includes(slug);
}

/** One normalized inbound Slack message, from either delivery path. */
export interface SlackInboundMessage {
  /** Which path delivered it. */
  source: 'slack-direct' | 'composio';
  /** Events API event type. */
  eventType: 'message' | 'app_mention';
  /** Message text ('' when the message carries only blocks/attachments). */
  text: string;
  /** Channel id (`C…`, `D…` for a DM, `G…` for a private channel). */
  channel: string;
  /** Channel kind, when Slack reported it (`channel_type`). */
  channelType?: 'channel' | 'im' | 'group';
  /** User id (`U…`) that sent the message, when known. */
  user?: string;
  /** Workspace (team) id, when known. */
  teamId?: string;
  /** Message timestamp (`ts`), used as `thread_ts` for threaded replies. */
  ts: string;
  /** Parent `ts` when the message is itself a thread reply. */
  threadTs?: string;
}

/** One action inside a `block_actions` payload. */
export interface SlackInboundAction {
  /** `action_id` of the clicked element. */
  actionId: string;
  /** `block_id` holding the element. */
  blockId: string;
  /** Element type (`button`, `static_select`, …). */
  type: string;
  /** Button / input value, when the element carries one. */
  value?: string;
  /** Selected option value, when the element is a select. */
  selectedOption?: string;
}

/** One normalized Slack interactive payload (dialog / modal). */
export interface SlackInboundInteraction {
  /** Interactivity payload type. */
  kind: 'block_actions' | 'view_submission' | 'view_closed';
  /** User that interacted, when known. */
  user?: string;
  /** Workspace (team) id, when known. */
  teamId?: string;
  /** Channel the interaction happened in, when known. */
  channel?: string;
  /** Message `ts` the interaction belongs to, when known. */
  messageTs?: string;
  /** `trigger_id` (only useful for opening a modal — not used here). */
  triggerId?: string;
  /** `response_url` (NOT called by open-bot — see the header note). */
  responseUrl?: string;
  /** Modal view id, for `view_submission` / `view_closed`. */
  viewId?: string;
  /** Modal `callback_id`, for `view_submission` / `view_closed`. */
  callbackId?: string;
  /** Clicked elements, for `block_actions` (empty otherwise). */
  actions: SlackInboundAction[];
  /**
   * Submitted modal values, for `view_submission`: `"<block_id>.<action_id>"`
   * → the submitted value (string, string[] for multi-select, or null
   * when the input was left empty). Empty for other payload types.
   */
  values: Record<string, string | string[] | null>;
}

/**
 * Result of parsing a Slack delivery body. `url_verification` and
 * `ignored` carry no message and must NOT run an automation.
 */
export type SlackInboundPayload =
  | { kind: 'url_verification'; challenge: string }
  | { kind: 'event_callback'; message: SlackInboundMessage }
  | { kind: 'interaction'; interaction: SlackInboundInteraction }
  | { kind: 'ignored'; reason: string };

/**
 * Compute the signature value for a delivery:
 * `v0=<hex HMAC-SHA256("v0:{timestamp}:{rawBody}")>`. The host uses
 * this to sign its own test deliveries; Slack computes the same value
 * with the app's signing secret.
 */
export function computeSlackSignature(
  secret: string,
  timestamp: string | number,
  rawBody: string | Buffer,
): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const hmac = createHmac('sha256', secret);
  hmac.update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:`, 'utf8');
  hmac.update(body);
  return `${SLACK_SIGNATURE_VERSION}=${hmac.digest('hex')}`;
}

/**
 * Verify a Slack request signature. Returns false (never throws) for
 * a missing/empty secret, a missing or non-numeric timestamp, a
 * timestamp more than `toleranceSeconds` away from `now`, a malformed
 * signature, or a mismatched HMAC. Comparison is timing-safe on
 * fixed-length buffers; a length mismatch is rejected without
 * comparing. The signature must be `v0=<hex>` (Slack's documented
 * format — no bare-hex fallback, unlike the Composio verifier).
 */
export function verifySlackSignature(
  secret: string,
  timestamp: string | number | null | undefined,
  rawBody: string | Buffer,
  signature: string | null | undefined,
  opts?: { now?: Date; toleranceSeconds?: number },
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (timestamp === null || timestamp === undefined || timestamp === '') return false;
  const tsText = String(timestamp);
  if (!/^\d+$/.test(tsText)) return false;
  const tsSeconds = Number(tsText);
  if (!Number.isFinite(tsSeconds)) return false;
  const nowSeconds = Math.floor((opts?.now ?? new Date()).getTime() / 1000);
  const tolerance = opts?.toleranceSeconds ?? SLACK_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - tsSeconds) > tolerance) return false;
  if (typeof signature !== 'string' || signature === '') return false;
  if (!signature.startsWith(`${SLACK_SIGNATURE_VERSION}=`)) return false;
  const givenHex = signature.slice(SLACK_SIGNATURE_VERSION.length + 1);
  if (!/^[0-9a-fA-F]+$/.test(givenHex)) return false;
  const expected = computeSlackSignature(secret, tsText, rawBody);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const givenBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function channelTypeOf(value: unknown): SlackInboundMessage['channelType'] {
  if (value === 'channel' || value === 'im' || value === 'group') return value;
  // Multi-person IMs report `mpim`; treat them like a private channel.
  if (value === 'mpim') return 'group';
  return undefined;
}

/**
 * Normalize one raw Slack event object (`event_callback.event`) into
 * a `SlackInboundMessage`. Returns `{ ignored, reason }` for bot
 * messages and for subtypes that are not a new user message
 * (`message_changed`, `message_deleted`, joins, …) — the caller must
 * NOT run an automation for those. Throws a clear error when the
 * event is a `message` / `app_mention` but is missing the fields a
 * reply needs (`channel`, `ts`).
 */
export function normalizeSlackEvent(
  event: unknown,
  source: SlackInboundMessage['source'],
): { message: SlackInboundMessage } | { ignored: string } {
  if (!isRecord(event)) {
    throw new Error('Slack event must be a JSON object.');
  }
  const eventType = event.type;
  if (eventType !== 'message' && eventType !== 'app_mention') {
    throw new Error(
      `Slack event type is not supported: ${JSON.stringify(eventType)} — only "message" and "app_mention" are routed.`,
    );
  }
  if (typeof event.bot_id === 'string' || event.subtype === 'bot_message') {
    return { ignored: 'Message is from a bot — ignored so the bot never answers itself.' };
  }
  if (typeof event.subtype === 'string') {
    return { ignored: `Message subtype "${event.subtype}" is not a new user message — ignored.` };
  }
  const channel = nonEmptyString(event.channel);
  if (!channel) {
    throw new Error('Slack message event has no channel — it cannot be routed or answered.');
  }
  const ts = nonEmptyString(event.ts);
  if (!ts) {
    throw new Error('Slack message event has no ts — it cannot be routed or answered.');
  }
  const text = typeof event.text === 'string' ? event.text : '';
  const message: SlackInboundMessage = {
    source,
    eventType,
    text,
    channel,
    ts,
  };
  const channelType = channelTypeOf(event.channel_type);
  if (channelType) message.channelType = channelType;
  const user = nonEmptyString(event.user);
  if (user) message.user = user;
  const teamId = nonEmptyString(event.team);
  if (teamId) message.teamId = teamId;
  const threadTs = nonEmptyString(event.thread_ts);
  if (threadTs) message.threadTs = threadTs;
  return { message };
}

/**
 * Parse a Slack Events API body (JSON). Handles `url_verification`
 * (challenge echo — no run) and `event_callback` with a `message` /
 * `app_mention` event. Throws a clear error on invalid JSON, on an
 * unsupported top-level `type`, or on a message event that is missing
 * `channel` / `ts`. Bot messages and non-message subtypes come back
 * as `{ kind: 'ignored' }` instead of throwing.
 */
export function parseSlackEventsPayload(rawBody: string | Buffer): SlackInboundPayload {
  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Slack Events API body is not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Slack Events API body must be a JSON object.');
  }
  if (parsed.type === 'url_verification') {
    const challenge = nonEmptyString(parsed.challenge);
    if (!challenge) {
      throw new Error('Slack url_verification payload has no challenge.');
    }
    return { kind: 'url_verification', challenge };
  }
  if (parsed.type !== 'event_callback') {
    throw new Error(
      `Slack Events API payload type is not supported: ${JSON.stringify(parsed.type)} — only "url_verification" and "event_callback" are handled.`,
    );
  }
  const normalized = normalizeSlackEvent(parsed.event, 'slack-direct');
  if ('ignored' in normalized) {
    return { kind: 'ignored', reason: normalized.ignored };
  }
  return { kind: 'event_callback', message: normalized.message };
}

function flattenViewStateValues(state: unknown): Record<string, string | string[] | null> {
  const values: Record<string, string | string[] | null> = {};
  if (!isRecord(state)) return values;
  const blocks = state.values;
  if (!isRecord(blocks)) return values;
  for (const [blockId, actions] of Object.entries(blocks)) {
    if (!isRecord(actions)) continue;
    for (const [actionId, element] of Object.entries(actions)) {
      if (!isRecord(element)) continue;
      const key = `${blockId}.${actionId}`;
      if (typeof element.value === 'string') {
        values[key] = element.value;
      } else if (isRecord(element.selected_option) && typeof element.selected_option.value === 'string') {
        values[key] = element.selected_option.value;
      } else if (Array.isArray(element.selected_options)) {
        const picked = element.selected_options
          .filter((o): o is Record<string, unknown> => isRecord(o) && typeof o.value === 'string')
          .map((o) => o.value as string);
        values[key] = picked;
      } else if (typeof element.selected_date === 'string') {
        values[key] = element.selected_date;
      } else if (typeof element.selected_time === 'string') {
        values[key] = element.selected_time;
      } else {
        values[key] = null;
      }
    }
  }
  return values;
}

/**
 * Normalize one Slack interactivity payload object (the JSON inside
 * the form-encoded `payload` field, or a raw JSON body). Supports
 * `block_actions` and `view_submission` / `view_closed` (dialogs /
 * modals). Throws a clear error on an unknown `type` or on a payload
 * missing the fields the automation needs to answer (`channel` for
 * `block_actions`).
 */
export function normalizeSlackInteraction(payload: unknown): SlackInboundInteraction {
  if (!isRecord(payload)) {
    throw new Error('Slack interactive payload must be a JSON object.');
  }
  const kind = payload.type;
  if (kind !== 'block_actions' && kind !== 'view_submission' && kind !== 'view_closed') {
    throw new Error(
      `Slack interactive payload type is not supported: ${JSON.stringify(kind)} — only "block_actions", "view_submission" and "view_closed" are routed.`,
    );
  }
  const interaction: SlackInboundInteraction = { kind, actions: [], values: {} };
  const user = isRecord(payload.user) ? nonEmptyString(payload.user.id) : undefined;
  if (user) interaction.user = user;
  const teamId = isRecord(payload.team) ? nonEmptyString(payload.team.id) : undefined;
  if (teamId) interaction.teamId = teamId;
  const triggerId = nonEmptyString(payload.trigger_id);
  if (triggerId) interaction.triggerId = triggerId;
  const responseUrl = nonEmptyString(payload.response_url);
  if (responseUrl) interaction.responseUrl = responseUrl;
  if (isRecord(payload.channel)) {
    const channel = nonEmptyString(payload.channel.id);
    if (channel) interaction.channel = channel;
  }
  if (isRecord(payload.message)) {
    const messageTs = nonEmptyString(payload.message.ts);
    if (messageTs) interaction.messageTs = messageTs;
  }
  if (kind === 'block_actions') {
    if (!interaction.channel) {
      throw new Error('Slack block_actions payload has no channel — it cannot be answered.');
    }
    const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
    for (const raw of rawActions) {
      if (!isRecord(raw)) continue;
      const actionId = nonEmptyString(raw.action_id);
      const blockId = nonEmptyString(raw.block_id);
      const type = nonEmptyString(raw.type);
      if (!actionId || !blockId || !type) continue;
      const action: SlackInboundAction = { actionId, blockId, type };
      const value = nonEmptyString(raw.value);
      if (value) action.value = value;
      if (isRecord(raw.selected_option) && typeof raw.selected_option.value === 'string') {
        action.selectedOption = raw.selected_option.value;
      }
      interaction.actions.push(action);
    }
  }
  if ((kind === 'view_submission' || kind === 'view_closed') && isRecord(payload.view)) {
    const view = payload.view;
    const viewId = nonEmptyString(view.id);
    if (viewId) interaction.viewId = viewId;
    const callbackId = nonEmptyString(view.callback_id);
    if (callbackId) interaction.callbackId = callbackId;
    interaction.values = flattenViewStateValues(view.state);
  }
  return interaction;
}

/**
 * Parse a Slack interactivity body. Slack sends these as
 * `application/x-www-form-urlencoded` with a single `payload=<json>`
 * field; a raw JSON body is also accepted (local tests, forwarders
 * that re-encode). Throws a clear error on a missing `payload`
 * field, on invalid JSON, or on an unsupported payload `type`.
 */
export function parseSlackInteractivePayload(
  rawBody: string | Buffer,
  contentType?: string | null,
): SlackInboundPayload {
  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let jsonText = text;
  const looksFormEncoded =
    (typeof contentType === 'string' && contentType.includes('application/x-www-form-urlencoded')) ||
    text.startsWith('payload=');
  if (looksFormEncoded) {
    const params = new URLSearchParams(text);
    const payload = params.get('payload');
    if (payload === null) {
      throw new Error('Slack interactive body is form-encoded but has no payload field.');
    }
    jsonText = payload;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    throw new Error('Slack interactive payload is not valid JSON.');
  }
  return { kind: 'interaction', interaction: normalizeSlackInteraction(parsed) };
}

/**
 * Parse any direct-Slack delivery body: try the Events API shape
 * first, then the interactivity shape. The two are unambiguous in
 * practice (Events API bodies are JSON objects with a top-level
 * `type` of `url_verification` / `event_callback`; interactivity
 * bodies are form-encoded `payload=` or a JSON object with a
 * `type` of `block_actions` / `view_submission` / `view_closed`).
 * Throws the Events API error when the body is neither.
 */
export function parseSlackInboundPayload(
  rawBody: string | Buffer,
  contentType?: string | null,
): SlackInboundPayload {
  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  if (
    text.startsWith('payload=') ||
    (typeof contentType === 'string' && contentType.includes('application/x-www-form-urlencoded'))
  ) {
    return parseSlackInteractivePayload(rawBody, contentType);
  }
  try {
    return parseSlackEventsPayload(rawBody);
  } catch (eventsError) {
    // A raw-JSON interactivity payload is the only other shape worth
    // trying; anything else reports the Events API error (the common
    // case) so the caller gets one clear message, not two.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw eventsError;
    }
    if (
      isRecord(parsed) &&
      (parsed.type === 'block_actions' || parsed.type === 'view_submission' || parsed.type === 'view_closed')
    ) {
      return parseSlackInteractivePayload(rawBody, contentType);
    }
    throw eventsError;
  }
}

/**
 * Normalize a Slack message out of a Composio trigger `data`.
 *
 * The exact `data` shape of a Composio Slack trigger was NEVER
 * observed live (no Slack event ever fired during the v0.83b live
 * test — only the trigger-type catalog was read), so this accepts
 * the shapes a Composio delivery plausibly carries, in order:
 * `data.event` (an Events API envelope), `data.message` (a nested
 * message), a bare Slack event object (`type: 'message' |
 * 'app_mention'`), or a flattened object (`text` plus `channel` /
 * `channel_id`). Returns null when nothing matches (reaction
 * triggers, channel-created triggers, …) — the caller keeps the raw
 * `data` in that case; a null here never drops the event.
 */
export function normalizeSlackMessageFromComposioData(data: unknown): SlackInboundMessage | null {
  if (!isRecord(data)) return null;
  const candidates: unknown[] = [data.event, data.message, data];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    // A flattened payload has no event `type` — treat it as a plain
    // message when it carries the fields a reply needs.
    const eventType = candidate.type === 'app_mention' ? 'app_mention' : 'message';
    const hasType = candidate.type === 'message' || candidate.type === 'app_mention';
    const hasText = typeof candidate.text === 'string';
    const channel =
      nonEmptyString(candidate.channel) ??
      nonEmptyString(candidate.channel_id) ??
      nonEmptyString(candidate.channelId);
    if (!channel) continue;
    if (!hasType && !hasText) continue;
    const ts =
      nonEmptyString(candidate.ts) ??
      nonEmptyString(candidate.message_ts) ??
      nonEmptyString(candidate.messageTs);
    if (!ts) continue;
    if (typeof candidate.bot_id === 'string' || candidate.subtype === 'bot_message') return null;
    if (typeof candidate.subtype === 'string') return null;
    const message: SlackInboundMessage = {
      source: 'composio',
      eventType,
      text: typeof candidate.text === 'string' ? candidate.text : '',
      channel,
      ts,
    };
    const channelType = channelTypeOf(candidate.channel_type ?? candidate.channelType);
    if (channelType) message.channelType = channelType;
    const user = nonEmptyString(candidate.user) ?? nonEmptyString(candidate.user_id) ?? nonEmptyString(candidate.userId);
    if (user) message.user = user;
    const teamId = nonEmptyString(candidate.team) ?? nonEmptyString(candidate.team_id) ?? nonEmptyString(candidate.teamId);
    if (teamId) message.teamId = teamId;
    const threadTs = nonEmptyString(candidate.thread_ts) ?? nonEmptyString(candidate.threadTs);
    if (threadTs) message.threadTs = threadTs;
    return message;
  }
  return null;
}

/**
 * True when a normalized Slack message may fire an automation
 * configured for `slug`:
 * - `SLACK_RECEIVE_MESSAGE` (generic) accepts any message.
 * - `SLACK_DIRECT_MESSAGE_RECEIVED` accepts DMs (`channel_type: 'im'`) only.
 * - `SLACK_CHANNEL_MESSAGE_RECEIVED` accepts channel / group messages only.
 * Any other slug is never a Slack message trigger.
 */
export function slackEventMatchesSlug(message: SlackInboundMessage, slug: string): boolean {
  if (slug === 'SLACK_RECEIVE_MESSAGE') return true;
  if (slug === 'SLACK_DIRECT_MESSAGE_RECEIVED') return message.channelType === 'im';
  if (slug === 'SLACK_CHANNEL_MESSAGE_RECEIVED') {
    return message.channelType === 'channel' || message.channelType === 'group';
  }
  return false;
}

/**
 * Build the trigger input a direct-Slack message delivery fires
 * with. Top-level `channel` / `text` / `ts` are there so a run-tool
 * action can fill `SLACK_SEND_MESSAGE` args from them (the same
 * input-shaping rule `applyTriggerInputToAction` applies to every
 * trigger source: payload keys fill args the action does not set);
 * the full normalized message travels under `slack`, and the raw
 * Slack event under `data` for the run history / retry.
 */
export function slackMessageToTriggerInput(
  message: SlackInboundMessage,
  opts?: { triggerSlug?: string; rawEvent?: unknown },
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    source: 'slack-direct',
    ...(opts?.triggerSlug ? { triggerSlug: opts.triggerSlug } : {}),
    eventType: message.eventType,
    channel: message.channel,
    text: message.text,
    ts: message.ts,
    slack: { ...message },
  };
  if (message.channelType) input.channelType = message.channelType;
  if (message.user) input.user = message.user;
  if (message.teamId) input.teamId = message.teamId;
  if (message.threadTs) input.threadTs = message.threadTs;
  if (opts?.rawEvent !== undefined) input.data = opts.rawEvent;
  return input;
}

/**
 * Build the trigger input a Slack interaction delivery fires with.
 * The run-tool action answers through `SLACK_SEND_MESSAGE` with
 * `channel` from this input; the clicked actions / submitted values
 * travel under `interaction` so the prompt (run-agent) or the args
 * (run-tool) can use them.
 */
export function slackInteractionToTriggerInput(
  interaction: SlackInboundInteraction,
  opts?: { triggerSlug?: string; rawPayload?: unknown },
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    source: 'slack-direct',
    ...(opts?.triggerSlug ? { triggerSlug: opts.triggerSlug } : {}),
    kind: 'interaction',
    interactionType: interaction.kind,
    interaction: { ...interaction },
  };
  if (interaction.channel) input.channel = interaction.channel;
  if (interaction.user) input.user = interaction.user;
  if (interaction.teamId) input.teamId = interaction.teamId;
  if (opts?.rawPayload !== undefined) input.data = opts.rawPayload;
  return input;
}

/**
 * Build the `arguments` object for a `SLACK_SEND_MESSAGE` call that
 * answers `message` (live-verified v0.72 schema: required `channel`,
 * `markdown_text` for content, optional `thread_ts`). A message that
 * is itself a thread reply keeps the thread (`thread_ts` =
 * `message.threadTs`); a top-level message is answered in the
 * channel, not as a new thread.
 */
export function slackReplyArgs(
  message: SlackInboundMessage,
  markdownText: string,
): { channel: string; markdown_text: string; thread_ts?: string } {
  const args: { channel: string; markdown_text: string; thread_ts?: string } = {
    channel: message.channel,
    markdown_text: markdownText,
  };
  if (message.threadTs) args.thread_ts = message.threadTs;
  return args;
}
