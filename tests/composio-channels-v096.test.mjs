/**
 * Tests for v0.96 Team T4 (Composio + Channels):
 *  - 40 toolkit Composio (22 cũ + 18 mới v0.96, slug đối chiếu live
 *    2026-11-13 trong scripts/composio-toolkits-live-v096/),
 *    400 tool catalog, approval theo động từ ghi.
 *  - Trigger queue: enqueue/dedupe/cap/TTL, long-poll (trả ngay khi
 *    có event, timeout rỗng, wake đúng lúc), drain/peek/filter.
 *  - Polling: Gmail preset 15 phút, dedupe 24h, lỗi fetch không mất
 *    trạng thái, item không id vẫn báo mới.
 *  - Channels: CRUD + roster + move bot, responder rules 5 mode,
 *    @mention parse, transcript bền vững, system prompt, route qua
 *    adapter (mock runner, 1 hop, lỗi bot không đổ channel).
 *  - Composio wire shape mock: session policy object {enable: []},
 *    GET_TOOL_SCHEMAS {tool_slugs}, MULTI_EXECUTE {tool_slug} —
 *    khớp docs/composio-integration.md (xác nhận live v0.72).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-channels-v096.test.mjs
 *
 * No live network, no real Composio key: mọi slug mới được đối chiếu
 * với bằng chứng live đã lưu, test chỉ dùng mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPOSIO_TOOLKITS,
  COMPOSIO_TOOLKIT_SLUGS,
  COMPOSIO_ROUTER_APP_ID,
  composioAppId,
  composioToolNeedsApproval,
  createComposioAppDefinitions,
  toolkitForComposioAppId,
  ComposioToolRouter,
  ComposioTriggerQueue,
  getSharedComposioTriggerQueue,
  ComposioPoller,
  createGmailPollerConfig,
  composioPollItemId,
  createComposioPollToQueueBridge,
  enqueueComposioPollResult,
  hashComposioPollItem,
} from '../packages/core/dist/composio/index.js';
import {
  ChannelStore,
  createChannelObject,
  parseChannelMentions,
  resolveChannelResponders,
  buildChannelSystemPrompt,
  routeChannelMessage,
} from '../packages/core/dist/channels/index.js';

// ---------------------------------------------------------------- toolkit
const NEW_TOOLKIT_SLUGS = [
  'stripe', 'shopify', 'box', 'confluence', 'gitlab', 'calendly',
  'mailchimp', 'twilio', 'googledocs', 'youtube', 'linkedin', 'reddit',
  'whatsapp', 'pagerduty', 'typeform', 'sendgrid', 'bitbucket', 'freshdesk',
];

test('composio v096: 40 toolkit, 400 tool catalog, slug moi deu co trong live evidence', () => {
  assert.equal(COMPOSIO_TOOLKITS.length, 40);
  assert.equal(COMPOSIO_TOOLKIT_SLUGS.length, 40);
  assert.equal(new Set(COMPOSIO_TOOLKIT_SLUGS).size, 40, 'slug toolkit khong trung');
  for (const slug of NEW_TOOLKIT_SLUGS) {
    assert.ok(COMPOSIO_TOOLKIT_SLUGS.includes(slug), `thieu toolkit moi ${slug}`);
  }
  const evidence = JSON.parse(
    readFileSync(new URL('../scripts/composio-toolkits-live-v096/toolkits-live-2026-11-13.json', import.meta.url), 'utf8'),
  );
  let total = 0;
  for (const toolkit of COMPOSIO_TOOLKITS) {
    assert.equal(toolkit.verifiedToolSlugs.length, 10, `${toolkit.slug} phai co dung 10 slug`);
    assert.equal(new Set(toolkit.verifiedToolSlugs).size, 10, `${toolkit.slug} slug trung`);
    for (const slug of toolkit.verifiedToolSlugs) {
      assert.match(slug, /^[A-Z][A-Z0-9_]+$/, `slug sai shape: ${slug}`);
      assert.ok(!slug.includes(' '), slug);
    }
    total += toolkit.verifiedToolSlugs.length;
    if (NEW_TOOLKIT_SLUGS.includes(toolkit.slug)) {
      const live = evidence.toolkits[toolkit.slug];
      assert.ok(live, `thieu evidence live cho ${toolkit.slug}`);
      for (const slug of toolkit.verifiedToolSlugs) {
        assert.ok(
          live.first_200_alphabetical_sample.includes(slug),
          `${slug} khong co trong ket qua live cua toolkit ${toolkit.slug}`,
        );
      }
    }
  }
  assert.equal(total, 400);
  // Teams: khong co toolkit (microsoftteams/teams tra 0 tool live).
  assert.ok(!COMPOSIO_TOOLKIT_SLUGS.includes('microsoftteams'));
  assert.ok(!COMPOSIO_TOOLKIT_SLUGS.includes('teams'));
});

test('composio v096: app id/router va approval van dung voi 40 toolkit', () => {
  assert.equal(composioAppId('stripe'), 'composio-stripe');
  assert.equal(toolkitForComposioAppId('composio-freshdesk'), 'freshdesk');
  assert.equal(toolkitForComposioAppId('composio-nope'), undefined);
  const defs = createComposioAppDefinitions();
  assert.equal(defs.length, 41, 'router + 40 toolkit');
  assert.equal(defs[0].id, COMPOSIO_ROUTER_APP_ID);
  assert.equal(defs[0].tools.length, 3);
  // Ghi can approval, doc khong.
  assert.equal(composioToolNeedsApproval('STRIPE_CREATE_CUSTOMER'), true);
  assert.equal(composioToolNeedsApproval('STRIPE_GET_ACCOUNT'), false);
  assert.equal(composioToolNeedsApproval('WHATSAPP_SEND_MESSAGE'), true);
  assert.equal(composioToolNeedsApproval('GOOGLEDOCS_GET_DOCUMENT_BY_ID'), false);
  assert.equal(composioToolNeedsApproval('YOUTUBE_SEARCH_YOU_TUBE'), false);
});

// ------------------------------------------------------- wire shape mock
test('composio v096: wire shape mock khop docs (session policy, schemas, multi-execute)', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/tool_router/session')) {
      return {
        status: 200,
        text: async () => JSON.stringify({
          session_id: 'sess_v096',
          mcp: { url: 'https://backend.composio.dev/tool_router/sess_v096/mcp', headers: { 'x-api-key': 'mock-key' } },
        }),
      };
    }
    return { status: 404, text: async () => 'not found' };
  };
  const router = new ComposioToolRouter({ apiKey: 'mock-key', fetchFn });
  const session = await router.createSession({ userId: 'user-1', toolkits: ['gmail', 'stripe', 'freshdesk'] });
  assert.equal(session.sessionId, 'sess_v096');
  // Wire shape: toolkits la policy OBJECT {enable: [...]}, khong phai mang.
  assert.deepEqual(seen[0].body, { user_id: 'user-1', toolkits: { enable: ['gmail', 'stripe', 'freshdesk'] } });
  assert.equal(session.mcpUrl, 'https://backend.composio.dev/tool_router/sess_v096/mcp');

  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    return { text: 'ok', isError: false };
  };
  await router.getToolSchemas(['STRIPE_CREATE_CUSTOMER'], callTool);
  assert.deepEqual(calls[0], { name: 'COMPOSIO_GET_TOOL_SCHEMAS', args: { tool_slugs: ['STRIPE_CREATE_CUSTOMER'] } });
  await router.executeTools(
    [{ tool: 'FRESHDESK_CREATE_TICKET', arguments: { subject: 'hi' }, account: 'acct-1' }],
    callTool,
  );
  assert.deepEqual(calls[1], {
    name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    args: { tools: [{ tool_slug: 'FRESHDESK_CREATE_TICKET', arguments: { subject: 'hi' }, account: 'acct-1' }] },
  });
  // Qua 50 tool/call thi tu choi (khong gui wire).
  await assert.rejects(
    router.executeTools(Array.from({ length: 51 }, (_, i) => ({ tool: `X_${i}`, arguments: {} })), callTool),
    /tối đa 50/,
  );
});

// ------------------------------------------------------------ trigger queue
function makeEvent(overrides = {}) {
  return {
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    data: { id: 'm1' },
    ...overrides,
  };
}

test('trigger queue v096: enqueue, dedupe theo eventId, drain/peek/filter', () => {
  const q = new ComposioTriggerQueue({ maxSize: 3, ttlMs: 60_000, now: () => 1_000 });
  assert.equal(q.enqueue(makeEvent({ eventId: 'msg_1' })), 'enqueued');
  assert.equal(q.enqueue(makeEvent({ eventId: 'msg_1' })), 'duplicate', 'Composio retry cung msg thi dedupe');
  assert.equal(q.enqueue(makeEvent({ eventId: 'msg_2', triggerSlug: 'GITHUB_COMMIT_EVENT' })), 'enqueued');
  assert.equal(q.size, 2);
  assert.equal(q.peek({ triggerSlug: 'GITHUB_COMMIT_EVENT' }).length, 1);
  assert.equal(q.peek({ triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE' }).length, 1);
  assert.equal(q.peek().length, 2, 'peek khong xoa');
  const drained = q.drain({ triggerSlug: 'GITHUB_COMMIT_EVENT' });
  assert.equal(drained.length, 1);
  assert.equal(q.size, 1);
  const stats = q.stats();
  assert.equal(stats.enqueued, 2);
  assert.equal(stats.deduped, 1);
  assert.equal(stats.pending, 1);
});

test('trigger queue v096: day thi drop cu nhat (FIFO), het TTL thi roi', () => {
  let now = 1_000;
  const q = new ComposioTriggerQueue({ maxSize: 2, ttlMs: 1_000, now: () => now });
  q.enqueue(makeEvent({ eventId: 'a' }));
  q.enqueue(makeEvent({ eventId: 'b' }));
  q.enqueue(makeEvent({ eventId: 'c' }));
  assert.equal(q.size, 2);
  assert.equal(q.stats().droppedFull, 1);
  assert.equal(q.peek()[0].event.eventId, 'b', 'event cu nhat (a) bi drop');
  now = 5_000;
  assert.equal(q.purgeExpired(), 2);
  assert.equal(q.size, 0);
  assert.equal(q.stats().expired, 2);
});

test('trigger queue v096: long-poll tra ngay khi co event, timeout tra rong, wake dung luc', async () => {
  const q = new ComposioTriggerQueue({ ttlMs: 60_000 });
  q.enqueue(makeEvent({ eventId: 'ready-1' }));
  const immediate = await q.waitForEvents({ triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE' }, 100);
  assert.equal(immediate.length, 1);
  assert.equal(immediate[0].event.eventId, 'ready-1');
  assert.equal(q.size, 0, 'event da tra thi roi khoi queue');

  const started = Date.now();
  const pending = q.waitForEvents({ triggerSlug: 'GITHUB_COMMIT_EVENT' }, 5_000);
  setTimeout(() => q.enqueue(makeEvent({ eventId: 'late-1', triggerSlug: 'GITHUB_COMMIT_EVENT' })), 50);
  const got = await pending;
  assert.equal(got.length, 1);
  assert.equal(got[0].event.eventId, 'late-1');
  assert.ok(Date.now() - started < 2_000, 'wake ngay khi enqueue, khong cho het timeout');

  const empty = await q.waitForEvents({ triggerSlug: 'SLACK_CHANNEL_MESSAGE_RECEIVED' }, 50);
  assert.deepEqual(empty, []);
});

// ------------------------------------------------------------------- polling
test('polling v096: Gmail preset 15 phut, dedupe 24h, chi tra item moi', async () => {
  let calls = 0;
  const fetchItems = async (args) => {
    calls++;
    assert.equal(args.query, 'newer_than:15m');
    assert.equal(args.max_results, 25);
    return calls === 1
      ? [{ id: 'm1', subject: 'a' }, { id: 'm2', subject: 'b' }]
      : [{ id: 'm1', subject: 'a' }, { id: 'm2', subject: 'b' }, { id: 'm3', subject: 'c' }];
  };
  const poller = new ComposioPoller(createGmailPollerConfig(fetchItems));
  assert.equal(poller.intervalMs, 15 * 60 * 1000);
  assert.equal(poller.toolkit, 'gmail');
  assert.equal(poller.toolSlug, 'GMAIL_FETCH_EMAILS');
  const first = await poller.pollOnce();
  assert.equal(first.newItems.length, 2);
  assert.equal(first.totalFetched, 2);
  assert.equal(first.error, undefined);
  const second = await poller.pollOnce();
  assert.deepEqual(second.newItems.map((m) => m.id), ['m3'], 'chi mail moi duoc tra');
  assert.equal(poller.seenCount, 3);
  assert.equal(poller.polls, 2);
});

test('polling v096: loi fetch khong mat trang thai dedupe; item khong id van bao moi', async () => {
  let fail = false;
  const fetchItems = async () => {
    if (fail) throw new Error('session het han');
    return [{ id: 'x1' }, { snippet: 'khong co id' }];
  };
  const poller = new ComposioPoller({
    name: 't', toolkit: 'gmail', toolSlug: 'GMAIL_FETCH_EMAILS', fetchItems, maxNewItems: 10,
  });
  const ok1 = await poller.pollOnce();
  assert.equal(ok1.newItems.length, 2, 'item khong id van bao la moi');
  fail = true;
  const bad = await poller.pollOnce();
  assert.equal(bad.newItems.length, 0);
  assert.match(bad.error ?? '', /session het han/);
  assert.equal(poller.seenCount, 1, 'loi khong xoa dedupe');
  fail = false;
  const ok2 = await poller.pollOnce();
  assert.equal(ok2.newItems.length, 1, 'chi item khong id (khong dedupe duoc) bao lai');
  assert.equal(composioPollItemId({ messageId: 'mm-9' }), 'mm-9');
  assert.equal(composioPollItemId({}), undefined);
});

// ------------------------------------------------------------------ channels
const BOTS = [
  { id: 'bot-code', name: 'Coder' },
  { id: 'bot-review', name: 'Reviewer' },
  { id: 'bot-research', name: 'Research' },
];

function tempStore() {
  return new ChannelStore(mkdtempSync(join(tmpdir(), 'openbot-channels-v096-')));
}

test('channels v096: CRUD + validation + ben vung qua file', () => {
  const store = tempStore();
  assert.deepEqual(store.listChannels(), []);
  const ch = store.createChannel({
    name: '  Dev Squad  ',
    kind: 'project',
    sharedInstructions: 'Viet code TypeScript, test truoc khi bao xong.',
    workingFolder: '/tmp/work',
    botIds: ['bot-code', 'bot-review'],
    responderRules: { mode: 'round-robin' },
  });
  assert.equal(ch.name, 'Dev Squad', 'ten duoc trim');
  assert.equal(ch.kind, 'project');
  assert.equal(ch.responderRules.mode, 'round-robin');
  assert.equal(store.listChannels().length, 1);
  assert.throws(() => store.createChannel({ name: '   ' }), /không được rỗng/);
  assert.throws(() => store.createChannel({ name: 'x'.repeat(81) }), /tối đa 80/);

  const updated = store.updateChannel(ch.id, { name: 'Dev Squad 2', sharedInstructions: 'Moi.' });
  assert.equal(updated?.name, 'Dev Squad 2');
  assert.equal(updated?.sharedInstructions, 'Moi.');
  assert.equal(store.updateChannel('khong-co', { name: 'x' }), undefined);
  assert.equal(store.deleteChannel('khong-co'), false);
  assert.equal(store.deleteChannel(ch.id), true);
  assert.deepEqual(store.listChannels(), []);
});

test('channels v096: roster add/remove (khong trung) + move bot giua channel', () => {
  const store = tempStore();
  const a = store.createChannel({ name: 'A', botIds: ['bot-code'] });
  const b = store.createChannel({ name: 'B' });
  store.addBotToChannel(a.id, 'bot-code');
  assert.deepEqual(store.getChannel(a.id)?.botIds, ['bot-code'], 'them trung khong nhan doi');
  store.addBotToChannel(a.id, 'bot-review');
  assert.equal(store.moveBotBetweenChannels(a.id, b.id, 'bot-code'), true);
  assert.deepEqual(store.getChannel(a.id)?.botIds, ['bot-review']);
  assert.deepEqual(store.getChannel(b.id)?.botIds, ['bot-code']);
  assert.equal(store.moveBotBetweenChannels(a.id, 'khong-co', 'bot-review'), false);
  assert.equal(store.moveBotBetweenChannels(a.id, a.id, 'bot-review'), false, 'cung channel thi khong move');
  store.removeBotFromChannel(a.id, 'bot-review');
  assert.deepEqual(store.getChannel(a.id)?.botIds, []);
});

test('channels v096: parse @mention (id, ten, ten viet lien) + responder rules 5 mode', () => {
  assert.deepEqual(parseChannelMentions('nho @Coder xem lai', BOTS), ['bot-code']);
  assert.deepEqual(parseChannelMentions('@bot-review oi', BOTS), ['bot-review']);
  assert.deepEqual(parseChannelMentions('ca @Coder va @Research nhe', BOTS), ['bot-code', 'bot-research']);

  const base = createChannelObject({ name: 'T', botIds: ['bot-code', 'bot-review', 'bot-research'] });
  const msg = { text: '@Coder lam di', mentions: ['bot-code'] };
  const msgNone = { text: 'chao moi nguoi', mentions: [] };

  assert.deepEqual(resolveChannelResponders({ ...base, responderRules: { mode: 'mentioned' } }, msg), ['bot-code']);
  assert.deepEqual(resolveChannelResponders({ ...base, responderRules: { mode: 'mentioned' } }, msgNone), []);
  assert.deepEqual(
    resolveChannelResponders({ ...base, responderRules: { mode: 'all' } }, msgNone),
    ['bot-code', 'bot-review', 'bot-research'],
  );
  assert.deepEqual(resolveChannelResponders({ ...base, responderRules: { mode: 'first' } }, msgNone), ['bot-code']);
  assert.deepEqual(resolveChannelResponders({ ...base, responderRules: { mode: 'none' } }, msg), []);
  // round-robin xoay vong theo lastResponderId.
  const rr = { ...base, responderRules: { mode: 'round-robin' } };
  assert.deepEqual(resolveChannelResponders(rr, msgNone, {}), ['bot-code']);
  assert.deepEqual(resolveChannelResponders(rr, msgNone, { lastResponderId: 'bot-code' }), ['bot-review']);
  assert.deepEqual(resolveChannelResponders(rr, msgNone, { lastResponderId: 'bot-research' }), ['bot-code']);
  assert.deepEqual(resolveChannelResponders(rr, msgNone, { lastResponderId: 'bot-da-xoa' }), ['bot-code']);
  // onlyBotIds + requireMentionFor loc truoc moi mode.
  const limited = {
    ...base,
    responderRules: { mode: 'all', onlyBotIds: ['bot-code', 'bot-review'], requireMentionFor: ['bot-review'] },
  };
  assert.deepEqual(resolveChannelResponders(limited, msgNone), ['bot-code'], 'bot-review can mention moi tra loi');
  assert.deepEqual(
    resolveChannelResponders(limited, { text: '@Reviewer', mentions: ['bot-review'] }),
    ['bot-code', 'bot-review'],
  );
});

test('channels v096: transcript ben vung + system prompt + round-robin qua store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openbot-channels-v096-'));
  const store = new ChannelStore(dir);
  const ch = store.createChannel({
    name: 'Docs', kind: 'work', sharedInstructions: 'Viet ngan gon.', workingFolder: '/srv/docs',
    botIds: ['bot-code', 'bot-review'], responderRules: { mode: 'round-robin' },
  });
  const prompt = buildChannelSystemPrompt(ch);
  assert.match(prompt, /Docs/);
  assert.match(prompt, /Viet ngan gon/);
  assert.match(prompt, /\/srv\/docs/);
  assert.match(prompt, /nhiều bot/);

  const posted = store.postChannelMessage(ch.id, { botId: '', botName: 'Bạn', text: 'hello' });
  assert.ok(posted?.id);
  assert.equal(store.postChannelMessage('khong-co', { botId: '', botName: 'Bạn', text: 'x' }), undefined);
  assert.deepEqual(store.resolveResponders(ch.id, 'hi', []), ['bot-code']);
  store.setLastResponder(ch.id, 'bot-code');
  assert.deepEqual(store.resolveResponders(ch.id, 'hi', []), ['bot-review']);
  // Mo lai store moi tu cung thu muc: channel + transcript + round-robin con nguyen.
  const store2 = new ChannelStore(dir);
  assert.equal(store2.listChannels().length, 1);
  assert.equal(store2.listChannelMessages(ch.id).length, 1);
  assert.equal(store2.listChannelMessages(ch.id)[0].text, 'hello');
  assert.equal(store2.getLastResponder(ch.id), 'bot-code');
  assert.ok(existsSync(join(dir, 'channels.json')));
});

test('channels v096: routeChannelMessage chay bot tuan tu, 1 hop, loi bot khong do channel', async () => {
  const store = tempStore();
  const ch = store.createChannel({
    name: 'All', kind: 'work', sharedInstructions: 'Lam viec nhom.',
    botIds: ['bot-code', 'bot-review'], responderRules: { mode: 'all' },
  });
  const prompts = [];
  const runBot = async ({ botId, prompt, channelSystemPrompt }) => {
    prompts.push({ botId, channelSystemPrompt });
    if (botId === 'bot-review') throw new Error('reviewer sap nguon');
    return `tra loi tu ${botId} cho: ${prompt.slice(-20)}`;
  };
  const result = await routeChannelMessage(store, ch.id, { text: 'lam task X', bots: BOTS }, runBot);
  assert.deepEqual(result.responders, ['bot-code', 'bot-review']);
  assert.equal(result.repliesPosted, 1, 'chi bot chay thanh cong dem repliesPosted');
  assert.match(result.errors['bot-review'], /sap nguon/);
  assert.ok(result.userMessageId);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].channelSystemPrompt, /Lam viec nhom/);
  const msgs = store.listChannelMessages(ch.id);
  assert.equal(msgs.length, 3, 'user + 1 tra loi + 1 tin loi');
  assert.equal(msgs[0].delegated, false);
  assert.equal(msgs[1].delegated, true);
  assert.match(msgs[2].text, /^\[lỗi\]/);
  // Channel khong ton tai: khong nem, khong ghi gi.
  const missing = await routeChannelMessage(store, 'khong-co', { text: 'hi', bots: BOTS }, runBot);
  assert.deepEqual(missing.responders, []);
  assert.equal(missing.repliesPosted, 0);
});

// ------------------------------------------- trigger defs v096 (live 2026-11-13)
import {
  COMPOSIO_TRIGGER_COUNTS,
  COMPOSIO_TRIGGER_DEFS,
  COMPOSIO_TRIGGER_TOTAL_COUNT,
  findComposioTriggerDef,
} from '../packages/core/dist/composio/index.js';
import { AgentCoordinator } from '../packages/core/dist/index.js';
import { mkdirSync, mkdtempSync as _mkdtemp } from 'node:fs';

test('triggers v096: 81 defs, tong 447 type, slug moi trong evidence, 7 toolkit 0 trigger', () => {
  assert.equal(COMPOSIO_TRIGGER_DEFS.length, 79, '50 cu + 29 moi');
  assert.equal(COMPOSIO_TRIGGER_TOTAL_COUNT, 447, '244 cu + 203 moi');
  const sum = Object.values(COMPOSIO_TRIGGER_COUNTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, COMPOSIO_TRIGGER_TOTAL_COUNT, 'tong counts phai bang total');
  assert.equal(Object.keys(COMPOSIO_TRIGGER_COUNTS).length, 40, 'counts du 40 toolkit');
  const evidence = JSON.parse(
    readFileSync(new URL('../scripts/composio-triggers-live-v096/trigger-types-v096.json', import.meta.url), 'utf8'),
  );
  const liveBySlug = new Map(evidence.items.map((it) => [it.slug, it]));
  assert.equal(evidence.total, 203);
  for (const def of COMPOSIO_TRIGGER_DEFS) {
    assert.ok(COMPOSIO_TOOLKIT_SLUGS.includes(def.toolkit), `toolkit la: ${def.toolkit}`);
  }
  const newDefs = COMPOSIO_TRIGGER_DEFS.filter((d) => NEW_TOOLKIT_SLUGS.includes(d.toolkit));
  assert.equal(newDefs.length, 29);
  for (const def of newDefs) {
    const live = liveBySlug.get(def.slug);
    assert.ok(live, `${def.slug} khong co trong catalog live`);
    assert.equal(live.name, def.name, `ten trigger ${def.slug} khac catalog live`);
    assert.equal(live.type, def.delivery, `delivery ${def.slug} khac catalog live (type=${live.type})`);
  }
  // 7 toolkit moi co 0 trigger trong catalog (nhu telegram/dropbox).
  for (const tk of ['gitlab', 'linkedin', 'reddit', 'pagerduty', 'sendgrid', 'bitbucket', 'freshdesk']) {
    assert.equal(COMPOSIO_TRIGGER_COUNTS[tk], 0, `${tk} phai 0 trigger`);
    assert.equal(COMPOSIO_TRIGGER_DEFS.filter((d) => d.toolkit === tk).length, 0);
  }
  assert.ok(findComposioTriggerDef('STRIPE_CHARGE_SUCCEEDED'));
  assert.ok(findComposioTriggerDef('TYPEFORM_NEW_RESPONSE'));
  assert.equal(findComposioTriggerDef('GITLAB_NOT_A_TRIGGER'), undefined);
});

// ------------------------------------------------- coordinator channels
async function makeChannelCoordinator(dataDir, recordPath) {
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  const mkBot = async (id, name, reply) => {
    const ws = join(dataDir, 'ws', id);
    mkdirSync(ws, { recursive: true });
    await coordinator.createBot({
      bot: { id, name, providerId: 'mock', model: 'mock', systemPrompt: 'test', workspaceDir: ws, autoApprove: true },
      provider: {
        id: 'mock', label: 'Mock', defaultModel: 'mock',
        mockResponses: [{ text: reply }],
        ...(recordPath ? { mockRecordPath: recordPath } : {}),
      },
    });
  };
  await mkBot('bot-code', 'Coder', 'code xong');
  await mkBot('bot-review', 'Reviewer', 'review xong');
  return coordinator;
}

test('coordinator channels v096: CRUD + roster + move + post (mock provider, instructions toi model)', async () => {
  const dataDir = _mkdtemp(join(tmpdir(), 'openbot-channels-v096-coord-'));
  const recordPath = join(dataDir, 'mock-requests.jsonl');
  const coordinator = await makeChannelCoordinator(dataDir, recordPath);

  const { channel } = coordinator.createChannel({
    name: 'Dev',
    kind: 'project',
    sharedInstructions: 'VIET_CODE_THEO_CHUAN_XYZ',
    workingFolder: '',
    botIds: ['bot-code', 'bot-review'],
    responderRules: { mode: 'all' },
  });
  assert.equal(channel.name, 'Dev');
  assert.equal(channel.responderRules.mode, 'all');
  assert.equal(coordinator.listChannels().channels.length, 1);
  assert.throws(() => coordinator.createChannel({ name: '' }), /không rỗng/);
  assert.throws(() => coordinator.createChannel({ name: 'X', botIds: ['bot-la'] }), /Không rõ bot/);

  const updated = coordinator.updateChannel({ channelId: channel.id, name: 'Dev 2' });
  assert.equal(updated.channel.name, 'Dev 2');
  assert.throws(() => coordinator.updateChannel({ channelId: 'khong-co', name: 'x' }), /Không thấy channel/);

  // Post: mode all -> ca 2 bot mock tra loi; instructions toi duoc model.
  const posted = await coordinator.postChannelMessage({ channelId: channel.id, text: 'lam task T' });
  assert.equal(posted.message.text, 'lam task T');
  assert.deepEqual(posted.responders, ['bot-code', 'bot-review']);
  assert.equal(posted.replies.length, 2);
  assert.deepEqual(posted.replies.map((r) => r.text), ['code xong', 'review xong']);
  assert.deepEqual(posted.errors, {});
  const recorded = readFileSync(recordPath, 'utf8');
  assert.ok(recorded.includes('VIET_CODE_THEO_CHUAN_XYZ'), 'shared instructions phai toi prompt cua model');
  assert.ok(recorded.includes('lam task T'), 'tin nhan phai toi prompt cua model');

  // Transcript ben vung: coordinator moi mo cung dataDir doc lai du.
  const again = coordinator.listChannelMessages({ channelId: channel.id, limit: 100 });
  assert.equal(again.messages.length, 3, 'user + 2 tra loi');
  const coordinator2 = new AgentCoordinator({ dataDir, emit: () => {} });
  assert.equal(coordinator2.listChannels().channels.length, 1);
  assert.equal(coordinator2.listChannelMessages({ channelId: channel.id }).messages.length, 3);

  // Move bot sang channel khac + remove + delete.
  const { channel: other } = coordinator.createChannel({ name: 'Ops', botIds: [] });
  assert.equal(coordinator.moveBotBetweenChannels({ fromChannelId: channel.id, toChannelId: other.id, botId: 'bot-review' }).moved, true);
  assert.deepEqual(coordinator.listChannels().channels.find((c) => c.id === channel.id).botIds, ['bot-code']);
  assert.equal(coordinator.removeBotFromChannel({ channelId: channel.id, botId: 'bot-code' }).removed, true);
  assert.equal(coordinator.addBotToChannel({ channelId: channel.id, botId: 'bot-code' }).added, true);
  assert.equal(coordinator.deleteChannel({ channelId: other.id }).deleted, true);
  assert.equal(coordinator.listChannels().channels.length, 1);
  assert.equal(coordinator.deleteChannel({ channelId: other.id }).deleted, false);
});

test('coordinator channels v096: mentioned chi goi bot duoc mention; round-robin xoay vong', async () => {
  const dataDir = _mkdtemp(join(tmpdir(), 'openbot-channels-v096-coord2-'));
  const coordinator = await makeChannelCoordinator(dataDir);
  const { channel } = coordinator.createChannel({
    name: 'Help', botIds: ['bot-code', 'bot-review'],
    responderRules: { mode: 'mentioned' },
  });
  const r1 = await coordinator.postChannelMessage({ channelId: channel.id, text: '@Coder giup voi' });
  assert.deepEqual(r1.responders, ['bot-code']);
  assert.equal(r1.replies.length, 1);
  const r2 = await coordinator.postChannelMessage({ channelId: channel.id, text: 'chao moi nguoi' });
  assert.deepEqual(r2.responders, [], 'khong mention thi khong ai tra loi');

  coordinator.updateChannel({ channelId: channel.id, responderRules: { mode: 'round-robin' } });
  // r1 (mentioned) da chay bot-code nen lastResponder = bot-code:
  // round-robin tiep tuc xoay sang bot-review, roi quay lai bot-code.
  const r3 = await coordinator.postChannelMessage({ channelId: channel.id, text: 'viec 1' });
  assert.deepEqual(r3.responders, ['bot-review']);
  const r4 = await coordinator.postChannelMessage({ channelId: channel.id, text: 'viec 2' });
  assert.deepEqual(r4.responders, ['bot-code'], 'round-robin xoay vong quay lai dau roster');
  await assert.rejects(
    coordinator.postChannelMessage({ channelId: 'khong-co', text: 'hi' }),
    /Không thấy channel/,
  );
  await assert.rejects(
    coordinator.postChannelMessage({ channelId: channel.id, text: '   ' }),
    /không rỗng/,
  );
});

test('composio v096: poll -> queue — synthetic event, dedupe theo id, item khong id theo hash', () => {
  const q = new ComposioTriggerQueue({ maxSize: 100, ttlMs: 60_000, now: () => 1_000 });
  const n = enqueueComposioPollResult(q, {
    newItems: [
      { id: 'm1', subject: 'hello' },
      { subject: 'no-id' },
    ],
    seenCount: 0,
  });
  assert.equal(n, 2);
  // Enqueue lai cung result KHI event van trong queue -> dedupe theo
  // eventId, khong tang. (Sau drain() thi enqueue lai la event moi.)
  assert.equal(enqueueComposioPollResult(q, {
    newItems: [{ id: 'm1', subject: 'hello' }],
    seenCount: 0,
  }), 0);
  const events = q.drain();
  assert.equal(events.length, 2);
  assert.equal(events[0].event.triggerSlug, 'GMAIL_NEW_GMAIL_MESSAGE');
  assert.equal(events[0].event.type, 'composio.trigger.poll');
  assert.equal(events[0].event.eventId, 'poll:GMAIL_NEW_GMAIL_MESSAGE:m1');
  assert.deepEqual(events[0].event.data, { item: { id: 'm1', subject: 'hello' } });
  assert.equal(events[1].event.eventId, `poll:GMAIL_NEW_GMAIL_MESSAGE:no-id-${hashComposioPollItem({ subject: 'no-id' })}`);
  // Result loi -> 0, khong enqueue.
  assert.equal(enqueueComposioPollResult(q, {
    newItems: [{ id: 'm2' }],
    seenCount: 0,
    error: 'boom',
  }), 0);
  assert.equal(q.stats().pending, 0);
});

test('composio v096: poll bridge — start/stop, item moi vao queue qua long-poll', async () => {
  const q = new ComposioTriggerQueue({ maxSize: 100, ttlMs: 60_000, now: () => Date.now() });
  let calls = 0;
  const poller = new ComposioPoller(
    createGmailPollerConfig(async () => {
      calls++;
      return calls === 1 ? [{ id: 'g1', subject: 'bridge' }] : [];
    }),
    { intervalMs: 60_000 },
  );
  const bridge = createComposioPollToQueueBridge(poller, q);
  assert.equal(bridge.running, false);
  bridge.start();
  assert.equal(bridge.running, true);
  bridge.start(); // goi lan 2 khong tao timer doi
  const found = await q.waitForEvents({ triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE' }, 2_000);
  assert.equal(found.length, 1);
  assert.equal(found[0].event.data.item.subject, 'bridge');
  bridge.stop();
  assert.equal(bridge.running, false);
});

test('composio v096: shared queue singleton — cung instance, khong rac state test', () => {
  const a = getSharedComposioTriggerQueue();
  const b = getSharedComposioTriggerQueue();
  assert.equal(a, b);
  assert.ok(a instanceof ComposioTriggerQueue);
});
