/**
 * Tests for v0.87a (P2-2) — Slack inbound / dialog.
 *
 *   - verifySlackSignature: compute→verify round-trips; tampered
 *     body, wrong secret, stale timestamp (>300 s), missing headers,
 *     a missing `v0=` prefix and bare hex all fail (Slack's format
 *     is strictly `v0=<hex>` — no bare-hex fallback, unlike the
 *     Composio verifier).
 *   - parseSlackEventsPayload: url_verification (challenge echo),
 *     message / app_mention (channel, user, text, ts, thread_ts,
 *     channel_type); bot messages (`bot_id`, `bot_message` subtype)
 *     and `message_changed` / `message_deleted` come back as
 *     `ignored`, not as runs; invalid JSON / unsupported type /
 *     missing challenge / missing channel / missing ts all throw.
 *   - parseSlackInteractivePayload: form-encoded `payload=` bodies
 *     and raw JSON; `block_actions` (button value, select option),
 *     `view_submission` (modal values flattened to
 *     `block.action` keys — value, selected option, multi-select
 *     array, empty → null) and `view_closed`; a missing `payload`
 *     field, an unknown type and a `block_actions` without a channel
 *     all throw.
 *   - normalizeSlackMessageFromComposioData: `data.event`, a bare
 *     Slack event, and a flattened `text` + `channel`/`channel_id`
 *     object all normalize; a reaction trigger and a bot message
 *     return null (the raw `data` still reaches the automation).
 *   - slackEventMatchesSlug / slackReplyArgs: DM vs channel
 *     matching, generic slug accepts all; reply args are exactly
 *     the live-verified SLACK_SEND_MESSAGE shape (`channel`,
 *     `markdown_text`, `thread_ts` only inside a thread).
 *   - slackKeys: signing-secret set/get/has/delete in a fake Vault.
 *   - AutomationScheduler.handleSlackInbound (real
 *     JsonFileAutomationStore, fake handlers): a signed message runs
 *     with the normalized Slack input (run-agent prompt carries the
 *     text + channel; run-tool args gain `channel` from the input
 *     while explicit action args win); url_verification and ignored
 *     bot messages return without recording a run; a wrong
 *     signature, no auth, a missing secret, a non-Slack slug, a
 *     slug mismatch and a disabled automation all throw with NO run
 *     recorded; a form-encoded `block_actions` delivery runs with
 *     the interaction as input.
 *   - AutomationScheduler.handleComposioTrigger (Slack slug): a
 *     Composio envelope whose `data` is a Slack message enriches
 *     the trigger input with the normalized `slack` block + `channel`
 *     (same reply path as direct Slack); a non-message Slack trigger
 *     (reaction) leaves the input untouched.
 *
 * No Slack app, no Composio key, no network, no real provider ever
 * runs — the "live" side is the Composio trigger-type catalog
 * snapshot in scripts/composio-triggers-live-v083/ and the
 * SLACK_SEND_MESSAGE schema in scripts/composio-live-v072/
 * (mock payloads here only).
 *
 * Run: npm run build --workspace=@open-bot/core && node --test tests/slack-inbound-v087a.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AutomationScheduler,
  JsonFileAutomationStore,
} from '../packages/core/dist/automations/index.js';
import {
  SLACK_INBOUND_KEYS_NAMESPACE,
  SLACK_MESSAGE_TRIGGER_SLUGS,
  computeSlackSignature,
  deleteSlackSigningSecret,
  getSlackSigningSecret,
  hasSlackSigningSecret,
  isSlackMessageTriggerSlug,
  normalizeSlackMessageFromComposioData,
  parseSlackEventsPayload,
  parseSlackInboundPayload,
  parseSlackInteractivePayload,
  setSlackSigningSecret,
  slackEventMatchesSlug,
  slackReplyArgs,
  verifySlackSignature,
} from '../packages/core/dist/slack/index.js';
import {
  computeComposioWebhookSignature,
  parseComposioTriggerPayload,
} from '../packages/core/dist/composio/index.js';

const SECRET = 'test-slack-signing-secret-v087a';
const COMPOSIO_SECRET = 'test-composio-webhook-secret-v087a';

function fakeVault() {
  const store = new Map();
  return {
    getSecret: (ns, key) => store.get(`${ns}/${key}`) ?? null,
    setSecret: (ns, key, value) => {
      store.set(`${ns}/${key}`, value);
    },
    deleteSecret: (ns, key) => store.delete(`${ns}/${key}`),
    hasSecret: (ns, key) => store.has(`${ns}/${key}`),
  };
}

function slackSign(rawBody) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { signature: computeSlackSignature(SECRET, ts, rawBody), timestamp: ts };
}

function messageBody(overrides = {}) {
  return JSON.stringify({
    token: 'test-verification-token',
    team_id: 'T123',
    api_app_id: 'A123',
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'C123',
      user: 'U456',
      text: 'hello bot, deploy please',
      ts: '1762850000.000001',
      team: 'T123',
      channel_type: 'channel',
      event_ts: '1762850000.000001',
      ...overrides,
    },
  });
}

// --- Signature ------------------------------------------------------------

test('verifySlackSignature: round-trip, tamper, replay, malformed', () => {
  const body = messageBody();
  const { signature, timestamp } = slackSign(body);
  assert.equal(signature.startsWith('v0='), true);
  assert.equal(verifySlackSignature(SECRET, timestamp, body, signature), true);
  // Tampered body fails.
  assert.equal(verifySlackSignature(SECRET, timestamp, `${body} `, signature), false);
  // Wrong secret fails.
  assert.equal(verifySlackSignature('wrong-secret', timestamp, body, signature), false);
  // Stale timestamp (>300 s) fails — replay protection.
  const stale = String(Math.floor(Date.now() / 1000) - 301);
  const staleSig = computeSlackSignature(SECRET, stale, body);
  assert.equal(verifySlackSignature(SECRET, stale, body, staleSig), false);
  // Fresh timestamp within tolerance passes.
  const fresh = String(Math.floor(Date.now() / 1000) - 299);
  assert.equal(
    verifySlackSignature(SECRET, fresh, body, computeSlackSignature(SECRET, fresh, body)),
    true,
  );
  // Missing / malformed inputs fail, never throw.
  assert.equal(verifySlackSignature(SECRET, timestamp, body, null), false);
  assert.equal(verifySlackSignature(SECRET, null, body, signature), false);
  assert.equal(verifySlackSignature(SECRET, 'not-a-number', body, signature), false);
  assert.equal(verifySlackSignature('', timestamp, body, signature), false);
  // No `v0=` prefix: Slack's format is strict.
  assert.equal(verifySlackSignature(SECRET, timestamp, body, signature.slice(3)), false);
  // Bare hex (no prefix at all) fails.
  assert.equal(verifySlackSignature(SECRET, timestamp, body, signature.slice(3).toUpperCase()), false);
  // Uppercase hex after the prefix fails (compute uses lowercase).
  assert.equal(
    verifySlackSignature(SECRET, timestamp, body, `v0=${signature.slice(3).toUpperCase()}`),
    false,
  );
});

// --- Events API parsing ---------------------------------------------------

test('parseSlackEventsPayload: url_verification, message, app_mention', () => {
  const verified = parseSlackEventsPayload(
    JSON.stringify({ token: 't', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmH', type: 'url_verification' }),
  );
  assert.deepEqual(verified, {
    kind: 'url_verification',
    challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmH',
  });

  const parsed = parseSlackEventsPayload(messageBody());
  assert.equal(parsed.kind, 'event_callback');
  assert.equal(parsed.message.source, 'slack-direct');
  assert.equal(parsed.message.eventType, 'message');
  assert.equal(parsed.message.channel, 'C123');
  assert.equal(parsed.message.user, 'U456');
  assert.equal(parsed.message.text, 'hello bot, deploy please');
  assert.equal(parsed.message.ts, '1762850000.000001');
  assert.equal(parsed.message.channelType, 'channel');
  assert.equal(parsed.message.teamId, 'T123');

  const mention = parseSlackEventsPayload(
    messageBody({ type: 'app_mention', text: '<@U789> status?', channel_type: 'channel' }),
  );
  assert.equal(mention.message.eventType, 'app_mention');
  assert.equal(mention.message.text, '<@U789> status?');

  const threaded = parseSlackEventsPayload(
    messageBody({ thread_ts: '1762850000.000001', ts: '1762850001.000002' }),
  );
  assert.equal(threaded.message.threadTs, '1762850000.000001');
  assert.equal(threaded.message.ts, '1762850001.000002');

  const dm = parseSlackEventsPayload(
    messageBody({ channel: 'D999', channel_type: 'im' }),
  );
  assert.equal(dm.message.channelType, 'im');
});

test('parseSlackEventsPayload: bot messages and edits are ignored, bad shapes throw', () => {
  const botSubtype = parseSlackEventsPayload(messageBody({ subtype: 'bot_message', bot_id: 'B1' }));
  assert.equal(botSubtype.kind, 'ignored');
  assert.match(botSubtype.reason, /bot/i);

  const botId = parseSlackEventsPayload(messageBody({ bot_id: 'B1' }));
  assert.equal(botId.kind, 'ignored');

  const edited = parseSlackEventsPayload(messageBody({ subtype: 'message_changed' }));
  assert.equal(edited.kind, 'ignored');
  assert.match(edited.reason, /message_changed/);

  const deleted = parseSlackEventsPayload(messageBody({ subtype: 'message_deleted' }));
  assert.equal(deleted.kind, 'ignored');

  assert.throws(() => parseSlackEventsPayload('{oops'), /not valid JSON/);
  assert.throws(() => parseSlackEventsPayload(JSON.stringify({ type: 'event_callback' })), /Slack event/);
  assert.throws(
    () => parseSlackEventsPayload(JSON.stringify({ type: 'url_verification' })),
    /no challenge/,
  );
  assert.throws(
    () => parseSlackEventsPayload(JSON.stringify({ type: 'something_else' })),
    /not supported/,
  );
  assert.throws(
    () => parseSlackEventsPayload(messageBody({ channel: '' })),
    /no channel/,
  );
  assert.throws(() => parseSlackEventsPayload(messageBody({ ts: '' })), /no ts/);
  assert.throws(
    () => parseSlackEventsPayload(messageBody({ type: 'reaction_added' })),
    /not supported/,
  );
});

// --- Interactivity parsing -------------------------------------------------

function blockActionsPayload(overrides = {}) {
  return {
    type: 'block_actions',
    user: { id: 'U456', username: 'huy' },
    api_app_id: 'A123',
    token: 'test-verification-token',
    trigger_id: '123.456.abc',
    team: { id: 'T123', domain: 'test' },
    channel: { id: 'C123', name: 'general' },
    message: { ts: '1762850000.000001', text: 'Deploy?' },
    response_url: 'https://hooks.slack.com/actions/T123/456/xyz',
    actions: [
      { action_id: 'approve_prod', block_id: 'b1', type: 'button', value: 'approve_prod' },
    ],
    ...overrides,
  };
}

function formEncode(payload) {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

test('parseSlackInteractivePayload: form-encoded block_actions + view_submission + view_closed', () => {
  const parsed = parseSlackInteractivePayload(formEncode(blockActionsPayload()), 'application/x-www-form-urlencoded');
  assert.equal(parsed.kind, 'interaction');
  assert.equal(parsed.interaction.kind, 'block_actions');
  assert.equal(parsed.interaction.user, 'U456');
  assert.equal(parsed.interaction.teamId, 'T123');
  assert.equal(parsed.interaction.channel, 'C123');
  assert.equal(parsed.interaction.messageTs, '1762850000.000001');
  assert.equal(parsed.interaction.triggerId, '123.456.abc');
  assert.equal(parsed.interaction.responseUrl, 'https://hooks.slack.com/actions/T123/456/xyz');
  assert.equal(parsed.interaction.actions.length, 1);
  assert.equal(parsed.interaction.actions[0].actionId, 'approve_prod');
  assert.equal(parsed.interaction.actions[0].value, 'approve_prod');

  // A select action carries the selected option.
  const select = parseSlackInteractivePayload(
    formEncode(
      blockActionsPayload({
        actions: [
          {
            action_id: 'env_pick',
            block_id: 'b2',
            type: 'static_select',
            selected_option: { text: { type: 'plain_text', text: 'Prod' }, value: 'prod' },
          },
        ],
      }),
    ),
  );
  assert.equal(select.interaction.actions[0].selectedOption, 'prod');

  // view_submission: modal values flattened to `block.action` keys.
  const submitted = parseSlackInteractivePayload(
    JSON.stringify({
      type: 'view_submission',
      user: { id: 'U456' },
      team: { id: 'T123' },
      view: {
        id: 'V1',
        callback_id: 'deploy_modal',
        state: {
          values: {
            env_block: {
              env_pick: {
                type: 'static_select',
                selected_option: { value: 'staging' },
              },
            },
            note_block: {
              note_input: { type: 'plain_text_input', value: 'ship it' },
            },
            tags_block: {
              tags_pick: {
                type: 'multi_static_select',
                selected_options: [{ value: 'a' }, { value: 'b' }],
              },
            },
            empty_block: {
              empty_input: { type: 'plain_text_input', value: null },
            },
          },
        },
      },
    }),
    'application/json',
  );
  assert.equal(submitted.interaction.kind, 'view_submission');
  assert.equal(submitted.interaction.viewId, 'V1');
  assert.equal(submitted.interaction.callbackId, 'deploy_modal');
  assert.deepEqual(submitted.interaction.values, {
    'env_block.env_pick': 'staging',
    'note_block.note_input': 'ship it',
    'tags_block.tags_pick': ['a', 'b'],
    'empty_block.empty_input': null,
  });

  const closed = parseSlackInteractivePayload(
    JSON.stringify({ type: 'view_closed', user: { id: 'U1' }, view: { id: 'V2', callback_id: 'c' } }),
  );
  assert.equal(closed.interaction.kind, 'view_closed');
  assert.equal(closed.interaction.viewId, 'V2');
});

test('parseSlackInteractivePayload: rejections', () => {
  assert.throws(
    () => parseSlackInteractivePayload('foo=bar', 'application/x-www-form-urlencoded'),
    /no payload field/,
  );
  assert.throws(() => parseSlackInteractivePayload('payload=%7Bbad', 'application/x-www-form-urlencoded'), /not valid JSON/);
  assert.throws(
    () => parseSlackInteractivePayload(JSON.stringify({ type: 'shortcut', callback_id: 'x' })),
    /not supported/,
  );
  assert.throws(
    () => parseSlackInteractivePayload(formEncode(blockActionsPayload({ channel: undefined }))),
    /no channel/,
  );
});

test('parseSlackInboundPayload: dispatches Events API and interactivity bodies', () => {
  assert.equal(parseSlackInboundPayload(messageBody()).kind, 'event_callback');
  assert.equal(parseSlackInboundPayload(formEncode(blockActionsPayload())).kind, 'interaction');
  assert.equal(
    parseSlackInboundPayload(JSON.stringify(blockActionsPayload())).kind,
    'interaction',
  );
  assert.throws(() => parseSlackInboundPayload('{oops'), /not valid JSON/);
});

// --- Composio data normalization -------------------------------------------

test('normalizeSlackMessageFromComposioData: shapes, and null when not a message', () => {
  // Bare Slack event in `data`.
  const bare = normalizeSlackMessageFromComposioData({
    type: 'message',
    channel: 'C123',
    user: 'U456',
    text: 'hi',
    ts: '1.2',
    channel_type: 'channel',
  });
  assert.equal(bare?.source, 'composio');
  assert.equal(bare?.channel, 'C123');
  assert.equal(bare?.text, 'hi');

  // `data.event` envelope.
  const enveloped = normalizeSlackMessageFromComposioData({
    event: { type: 'app_mention', channel: 'C9', user: 'U1', text: '@bot', ts: '3.4' },
  });
  assert.equal(enveloped?.eventType, 'app_mention');
  assert.equal(enveloped?.channel, 'C9');

  // `data.message` nesting.
  const nested = normalizeSlackMessageFromComposioData({
    message: { type: 'message', channel: 'C5', text: 'nested', ts: '5.6' },
  });
  assert.equal(nested?.channel, 'C5');

  // Flattened fields (channel_id / user_id aliases).
  const flat = normalizeSlackMessageFromComposioData({
    text: 'flat',
    channel_id: 'C7',
    user_id: 'U7',
    ts: '7.8',
  });
  assert.equal(flat?.channel, 'C7');
  assert.equal(flat?.user, 'U7');

  // Not a message: reaction trigger, channel-created trigger, bot message.
  assert.equal(normalizeSlackMessageFromComposioData({ type: 'reaction_added', item: {} }), null);
  assert.equal(normalizeSlackMessageFromComposioData({ channel_id: 'C1', name: 'general' }), null);
  assert.equal(
    normalizeSlackMessageFromComposioData({ type: 'message', channel: 'C1', text: 'x', ts: '1.1', bot_id: 'B1' }),
    null,
  );
  assert.equal(normalizeSlackMessageFromComposioData('not an object'), null);
  assert.equal(normalizeSlackMessageFromComposioData(null), null);

  // The three slugs are exactly the live-catalog message triggers.
  assert.deepEqual([...SLACK_MESSAGE_TRIGGER_SLUGS], [
    'SLACK_CHANNEL_MESSAGE_RECEIVED',
    'SLACK_DIRECT_MESSAGE_RECEIVED',
    'SLACK_RECEIVE_MESSAGE',
  ]);
  assert.equal(isSlackMessageTriggerSlug('SLACK_RECEIVE_MESSAGE'), true);
  assert.equal(isSlackMessageTriggerSlug('SLACK_MESSAGE_REACTION_ADDED'), false);
  assert.equal(isSlackMessageTriggerSlug('GMAIL_NEW_GMAIL_MESSAGE'), false);
});

test('slackEventMatchesSlug + slackReplyArgs: channel kinds and the live reply shape', () => {
  const channel = { source: 'slack-direct', eventType: 'message', text: 't', channel: 'C1', ts: '1.1', channelType: 'channel' };
  const dm = { ...channel, channel: 'D1', channelType: 'im' };
  assert.equal(slackEventMatchesSlug(channel, 'SLACK_CHANNEL_MESSAGE_RECEIVED'), true);
  assert.equal(slackEventMatchesSlug(channel, 'SLACK_DIRECT_MESSAGE_RECEIVED'), false);
  assert.equal(slackEventMatchesSlug(dm, 'SLACK_DIRECT_MESSAGE_RECEIVED'), true);
  assert.equal(slackEventMatchesSlug(dm, 'SLACK_CHANNEL_MESSAGE_RECEIVED'), false);
  assert.equal(slackEventMatchesSlug(channel, 'SLACK_RECEIVE_MESSAGE'), true);
  assert.equal(slackEventMatchesSlug(dm, 'SLACK_RECEIVE_MESSAGE'), true);
  assert.equal(slackEventMatchesSlug(channel, 'GMAIL_NEW_GMAIL_MESSAGE'), false);

  // Reply args are exactly the live-verified SLACK_SEND_MESSAGE shape.
  assert.deepEqual(slackReplyArgs(channel, 'done'), { channel: 'C1', markdown_text: 'done' });
  const threaded = { ...channel, threadTs: '1.1' };
  assert.deepEqual(slackReplyArgs(threaded, 'done'), {
    channel: 'C1',
    markdown_text: 'done',
    thread_ts: '1.1',
  });
});

// --- Vault keys -------------------------------------------------------------

test('slackKeys: signing secret lifecycle in a fake Vault', () => {
  assert.equal(SLACK_INBOUND_KEYS_NAMESPACE, 'slack-inbound-keys');
  const vault = fakeVault();
  assert.equal(hasSlackSigningSecret(vault, 'auto-1'), false);
  setSlackSigningSecret(vault, 'auto-1', SECRET);
  assert.equal(getSlackSigningSecret(vault, 'auto-1'), SECRET);
  assert.equal(hasSlackSigningSecret(vault, 'auto-1'), true);
  assert.throws(() => setSlackSigningSecret(vault, 'auto-2', '   '), /must not be empty/);
  assert.equal(deleteSlackSigningSecret(vault, 'auto-1'), true);
  assert.equal(hasSlackSigningSecret(vault, 'auto-1'), false);
  assert.equal(deleteSlackSigningSecret(vault, 'auto-1'), false);
});

// --- Scheduler --------------------------------------------------------------

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-slack-v087a-'));
  tempDirs.push(dir);
  return dir;
}

function makeScheduler({ secret = SECRET, composioSecret = COMPOSIO_SECRET } = {}) {
  const dir = makeTempDir();
  const store = new JsonFileAutomationStore(dir);
  const agentPrompts = [];
  const toolCalls = [];
  const handlers = {
    runAgent: async (botId, prompt) => {
      agentPrompts.push({ botId, prompt });
      return `agent saw: ${prompt.slice(0, 200)}`;
    },
    runTool: async (name, args) => {
      toolCalls.push({ name, args });
      return `tool ${name} ok`;
    },
    createTask: async () => 'task-1',
    notify: () => undefined,
  };
  const scheduler = new AutomationScheduler(store, handlers, {
    slackSigningSecretProvider: (keyId) => (keyId === 'auto-1' ? secret : null),
    composioWebhookSecretProvider: (keyId) => (keyId === 'auto-1' ? composioSecret : null),
  });
  return { scheduler, store, agentPrompts, toolCalls, dir };
}

function slackAutomation(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'auto-1',
    botId: 'bot-1',
    name: 'Slack thì trả lời',
    trigger: { kind: 'composio', triggerSlug: 'SLACK_CHANNEL_MESSAGE_RECEIVED', keyId: 'auto-1' },
    action: { kind: 'run-agent', botId: 'bot-1', prompt: 'Trả lời tin Slack.' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('scheduler.handleSlackInbound: signed message runs with the normalized Slack input', async () => {
  const { scheduler, store, agentPrompts } = makeScheduler();
  scheduler.create(slackAutomation());
  const body = messageBody();
  const run = await scheduler.handleSlackInbound('auto-1', body, slackSign(body));
  assert.equal(run.status, 'ok');
  assert.equal(run.trigger, 'composio');
  assert.equal(agentPrompts.length, 1);
  assert.ok(agentPrompts[0].prompt.includes('Trả lời tin Slack.'), 'original prompt kept');
  assert.ok(agentPrompts[0].prompt.includes('hello bot, deploy please'), 'message text in the prompt');
  assert.ok(agentPrompts[0].prompt.includes('C123'), 'channel in the prompt');
  assert.ok(agentPrompts[0].prompt.includes('SLACK_CHANNEL_MESSAGE_RECEIVED'), 'slug in the prompt context');
  const stored = store.listRuns('auto-1');
  assert.equal(stored.length, 1);
  assert.ok(stored[0].triggerInput?.includes('hello bot, deploy please'), 'run history keeps the trigger input');
});

test('scheduler.handleSlackInbound: run-tool action gains channel from the input, explicit args win', async () => {
  const { scheduler, toolCalls } = makeScheduler();
  scheduler.create(
    slackAutomation({
      action: {
        kind: 'run-tool',
        tool: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        args: {
          tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { markdown_text: 'hi' } }],
        },
      },
    }),
  );
  const body = messageBody();
  const run = await scheduler.handleSlackInbound('auto-1', body, slackSign(body));
  assert.equal(run.status, 'ok');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].args.channel, 'C123', 'input fills the reply channel');
  assert.equal(toolCalls[0].args.text, 'hello bot, deploy please');
  assert.deepEqual(
    toolCalls[0].args.tools,
    [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { markdown_text: 'hi' } }],
    'explicit action args win over payload keys',
  );
});

test('scheduler.handleSlackInbound: bad signature / no auth / no secret / wrong slug / mismatch record no run', async () => {
  const { scheduler, store } = makeScheduler();
  scheduler.create(slackAutomation());
  const body = messageBody();
  const good = slackSign(body);
  // Wrong signature.
  await assert.rejects(
    scheduler.handleSlackInbound('auto-1', body, { ...good, signature: 'v0=0000000000000000000000000000000000000000000000000000000000000000' }),
    /Invalid Slack signature/,
  );
  // No auth at all.
  await assert.rejects(scheduler.handleSlackInbound('auto-1', body, {}), /Invalid Slack signature/);
  // Missing timestamp.
  await assert.rejects(
    scheduler.handleSlackInbound('auto-1', body, { signature: good.signature }),
    /Invalid Slack signature/,
  );
  // Unknown automation.
  await assert.rejects(scheduler.handleSlackInbound('nope', body, good), /No automation with id/);
  // Invalid JSON with a valid signature for that body.
  const badJson = '{oops';
  await assert.rejects(
    scheduler.handleSlackInbound('auto-1', badJson, slackSign(badJson)),
    /not valid JSON/,
  );
  assert.equal(store.listRuns('auto-1').length, 0, 'rejected deliveries record no run');

  // No signing secret stored for the automation.
  const { scheduler: noSecret, store: noSecretStore } = makeScheduler({ secret: null });
  noSecret.create(slackAutomation());
  await assert.rejects(
    noSecret.handleSlackInbound('auto-1', body, slackSign(body)),
    /has no Slack signing secret/,
  );
  assert.equal(noSecretStore.listRuns('auto-1').length, 0);

  // Automation that does not listen for Slack at all.
  const { scheduler: gmailScheduler } = makeScheduler();
  gmailScheduler.create(
    slackAutomation({
      trigger: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', keyId: 'auto-1' },
    }),
  );
  await assert.rejects(
    gmailScheduler.handleSlackInbound('auto-1', body, slackSign(body)),
    /does not listen for Slack/,
  );

  // Slug mismatch: a DM delivered to a channel-message automation.
  const dmBody = messageBody({ channel: 'D999', channel_type: 'im' });
  await assert.rejects(
    scheduler.handleSlackInbound('auto-1', dmBody, slackSign(dmBody)),
    /slug mismatch/,
  );

  // Disabled automation.
  scheduler.setEnabled('auto-1', false);
  await assert.rejects(scheduler.handleSlackInbound('auto-1', body, slackSign(body)), /disabled/);
  assert.equal(store.listRuns('auto-1').length, 0);
});

test('scheduler.handleSlackInbound: url_verification and ignored messages return without a run', async () => {
  const { scheduler, store, agentPrompts } = makeScheduler();
  scheduler.create(slackAutomation());

  const challengeBody = JSON.stringify({ token: 't', challenge: 'abc123', type: 'url_verification' });
  const verified = await scheduler.handleSlackInbound('auto-1', challengeBody, slackSign(challengeBody));
  assert.deepEqual(verified, { kind: 'url_verification', challenge: 'abc123' });
  assert.equal(store.listRuns('auto-1').length, 0, 'url_verification records no run');
  assert.equal(agentPrompts.length, 0);

  const botBody = messageBody({ subtype: 'bot_message', bot_id: 'B1' });
  const ignored = await scheduler.handleSlackInbound('auto-1', botBody, slackSign(botBody));
  assert.equal(ignored.kind, 'ignored');
  assert.equal(ignored.ok, true);
  assert.equal(store.listRuns('auto-1').length, 0, 'bot message records no run');
});

test('scheduler.handleSlackInbound: form-encoded block_actions runs with the interaction as input', async () => {
  const { scheduler, store, agentPrompts } = makeScheduler();
  scheduler.create(slackAutomation());
  const body = formEncode(blockActionsPayload());
  const run = await scheduler.handleSlackInbound(
    'auto-1',
    body,
    slackSign(body),
    'application/x-www-form-urlencoded',
  );
  assert.equal(run.status, 'ok');
  assert.equal(agentPrompts.length, 1);
  assert.ok(agentPrompts[0].prompt.includes('approve_prod'), 'clicked action in the prompt');
  assert.ok(agentPrompts[0].prompt.includes('block_actions'), 'interaction type in the prompt');
  assert.equal(store.listRuns('auto-1').length, 1);
});

test('scheduler.handleComposioTrigger: Slack slug enriches the input, reaction slug does not', async () => {
  const { scheduler, toolCalls } = makeScheduler();
  scheduler.create(
    slackAutomation({
      action: { kind: 'run-tool', tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', args: { fixed: true } },
    }),
  );
  const envelope = JSON.stringify({
    id: 'msg_slack1',
    type: 'composio.trigger.message',
    metadata: {
      trigger_slug: 'SLACK_CHANNEL_MESSAGE_RECEIVED',
      trigger_id: 'ti_slack1',
      connected_account_id: 'ca_slack1',
      user_id: 'user-1',
    },
    data: { type: 'message', channel: 'C123', user: 'U456', text: 'hello via composio', ts: '1.2', channel_type: 'channel' },
    timestamp: new Date().toISOString(),
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = computeComposioWebhookSignature(COMPOSIO_SECRET, 'wh_1', ts, envelope);
  const run = await scheduler.handleComposioTrigger('auto-1', envelope, {
    webhookId: 'wh_1',
    webhookTimestamp: ts,
    webhookSignature: sig,
  });
  assert.equal(run.status, 'ok');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].args.channel, 'C123', 'normalized channel fills the reply args');
  assert.equal(toolCalls[0].args.text, 'hello via composio');
  assert.equal(toolCalls[0].args.fixed, true, 'explicit action args win');

  // A reaction trigger carries no message — the input stays raw.
  const { scheduler: reactionScheduler, toolCalls: reactionCalls } = makeScheduler();
  reactionScheduler.create(
    slackAutomation({
      trigger: { kind: 'composio', triggerSlug: 'SLACK_MESSAGE_REACTION_ADDED', keyId: 'auto-1' },
      action: { kind: 'run-tool', tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', args: { fixed: true } },
    }),
  );
  const reactionEnvelope = JSON.stringify({
    id: 'msg_react1',
    type: 'composio.trigger.message',
    metadata: { trigger_slug: 'SLACK_MESSAGE_REACTION_ADDED', trigger_id: 'ti_r1' },
    data: { type: 'reaction_added', reaction: 'thumbsup', item: { channel: 'C123' } },
    timestamp: new Date().toISOString(),
  });
  const ts2 = String(Math.floor(Date.now() / 1000));
  const sig2 = computeComposioWebhookSignature(COMPOSIO_SECRET, 'wh_2', ts2, reactionEnvelope);
  const run2 = await reactionScheduler.handleComposioTrigger('auto-1', reactionEnvelope, {
    webhookId: 'wh_2',
    webhookTimestamp: ts2,
    webhookSignature: sig2,
  });
  assert.equal(run2.status, 'ok');
  assert.equal(reactionCalls.length, 1);
  assert.equal('channel' in reactionCalls[0].args, false, 'no normalized channel for a reaction');
});

// Sanity: the parser the scheduler uses also parses a real Composio envelope.
test('parseComposioTriggerPayload still parses the V3 envelope (no regression)', () => {
  const event = parseComposioTriggerPayload(
    JSON.stringify({
      id: 'msg_x',
      type: 'composio.trigger.message',
      metadata: { trigger_slug: 'SLACK_RECEIVE_MESSAGE' },
      data: { type: 'message', channel: 'C1', text: 'x', ts: '1.1' },
    }),
  );
  assert.equal(event.triggerSlug, 'SLACK_RECEIVE_MESSAGE');
});
