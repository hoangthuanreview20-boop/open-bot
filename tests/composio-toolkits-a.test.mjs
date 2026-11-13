/**
 * Tests for Composio toolkit expansion (v0.72a Team A + v0.82 + v0.96
 * Team T4): 40 toolkit (4 gốc + 10 mới v0.72a: Google Sheets/Drive/
 * Calendar, Jira, Linear, Discord, Telegram, Trello, Asana, HubSpot +
 * 8 mới v0.82: Zoom, Salesforce, Zendesk, Airtable, Monday, ClickUp,
 * Dropbox, Outlook + 18 mới v0.96: Stripe, Shopify, Box, Confluence,
 * GitLab, Calendly, Mailchimp, Twilio, Google Docs, YouTube, LinkedIn,
 * Reddit, WhatsApp, PagerDuty, Typeform, SendGrid, Bitbucket,
 * Freshdesk), 400 tool thật trong catalog, approval theo động từ ghi,
 * source/state chạy theo danh sách động.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-toolkits-a.test.mjs
 *
 * No live network, no real Composio account/key: mọi slug trong test
 * được đối chiếu với bằng chứng live đã lưu
 * (scripts/composio-toolkits-live/toolkits-live-2026-11-10.json —
 * chạy live ngày 2026-11-10, 2.564 tool thật trên 14 toolkit — và
 * toolkits-live-2026-11-11.json — chạy live ngày 2026-11-11, 1.721
 * tool thật trên 8 toolkit v0.82; tổng 4.285 tool trên 22 toolkit —
 * và scripts/composio-toolkits-live-v096/toolkits-live-2026-11-13.json
 * — chạy live ngày 2026-11-13, 2.386 slug mẫu đầu trên 18 toolkit
 * v0.96; tổng 6.671 tool mẫu trên 40 toolkit),
 * không gọi API Composio trong test này.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSIO_ROUTER_APP_ID,
  COMPOSIO_TOOLKITS,
  COMPOSIO_TOOLKIT_SLUGS,
  ComposioAppSource,
  ComposioError,
  applyComposioPersistedState,
  buildComposioStateView,
  composioAppId,
  composioToolNeedsApproval,
  createComposioAppDefinitions,
  createComposioToolkitAppDefinitions,
  defaultComposioPersistedState,
  resolveComposioPersistedState,
  toolkitForComposioAppId,
} from '../packages/core/dist/composio/index.js';
import {
  AppRegistry,
  BUILTIN_APPS,
  DEFAULT_APP_TOOL_CAP,
  applyAppToolCaps,
} from '../packages/core/dist/apps/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
// Bằng chứng live gộp 2 lần chạy (2026-11-10: 14 toolkit đầu;
// 2026-11-11: 8 toolkit v0.82) — slug nào cũng phải có trong file
// live tương ứng của nó.
const live = { toolkits: {} };
for (const file of [
  'toolkits-live-2026-11-10.json',
  'toolkits-live-2026-11-11.json',
]) {
  const part = JSON.parse(
    readFileSync(join(repo, 'scripts/composio-toolkits-live', file), 'utf-8'),
  );
  Object.assign(live.toolkits, part.toolkits);
}
// v0.96: evidence 18 toolkit mới có format khác (mẫu 200 slug đầu,
// thứ tự ABC) — chuẩn hoá về cùng dạng {count, tools: [{slug}]}.
// (API trả theo thứ tự ABC nên chỉ 200 slug đầu được lấy mẫu; 10
// slug catalog mỗi toolkit đều nằm trong mẫu này.)
{
  const part = JSON.parse(
    readFileSync(join(repo, 'scripts/composio-toolkits-live-v096/toolkits-live-2026-11-13.json'), 'utf-8'),
  );
  for (const [slug, entry] of Object.entries(part.toolkits)) {
    live.toolkits[slug] = {
      count: entry.fetched_count,
      tools: entry.first_200_alphabetical_sample.map((toolSlug) => ({ slug: toolSlug })),
    };
  }
}

const EXPECTED_SLUGS = [
  'gmail',
  'github',
  'slack',
  'notion',
  'googlesheets',
  'googledrive',
  'googlecalendar',
  'jira',
  'linear',
  'discord',
  'telegram',
  'trello',
  'asana',
  'hubspot',
  'zoom',
  'salesforce',
  'zendesk',
  'airtable',
  'monday',
  'clickup',
  'dropbox',
  'outlook',
  'stripe',
  'shopify',
  'box',
  'confluence',
  'gitlab',
  'calendly',
  'mailchimp',
  'twilio',
  'googledocs',
  'youtube',
  'linkedin',
  'reddit',
  'whatsapp',
  'pagerduty',
  'typeform',
  'sendgrid',
  'bitbucket',
  'freshdesk',
];

test('toolkits: 40 toolkit, đúng thứ tự (4 gốc + 10 v0.72a + 8 v0.82 + 18 v0.96)', () => {
  assert.deepEqual([...COMPOSIO_TOOLKIT_SLUGS], EXPECTED_SLUGS);
  assert.equal(COMPOSIO_TOOLKITS.length, 40);
  assert.deepEqual(
    COMPOSIO_TOOLKITS.map((t) => t.slug),
    EXPECTED_SLUGS,
  );
  for (const def of COMPOSIO_TOOLKITS) {
    assert.ok(def.label.length > 0, `${def.slug} needs a label`);
    assert.ok(def.icon.length > 0, `${def.slug} needs an icon`);
    assert.ok(def.description.length > 0, `${def.slug} needs a description`);
    // 10 slug/toolkits = đúng cap M7 (DEFAULT_APP_TOOL_CAP).
    assert.equal(def.verifiedToolSlugs.length, 10, `${def.slug} must list 10 verified slugs`);
    assert.equal(new Set(def.verifiedToolSlugs).size, 10, `${def.slug} slugs must be unique`);
  }
});

test('toolkits: mọi slug đều có tiền tố toolkit + tồn tại trong bằng chứng live', () => {
  // Bằng chứng live phải đủ 40 toolkit (4.285 + 2.386 mẫu = 6.671 tool).
  assert.deepEqual(Object.keys(live.toolkits).sort(), [...EXPECTED_SLUGS].sort());
  const totalLive = Object.values(live.toolkits).reduce((n, t) => n + t.count, 0);
  assert.ok(totalLive >= 6600, `live inventory should hold 6600+ tools, got ${totalLive}`);
  const allSlugs = [];
  for (const def of COMPOSIO_TOOLKITS) {
    const prefix = `${def.slug.toUpperCase()}_`;
    const liveSlugs = new Set(live.toolkits[def.slug].tools.map((t) => t.slug));
    for (const slug of def.verifiedToolSlugs) {
      assert.ok(slug.startsWith(prefix), `${slug} must start with ${prefix}`);
      assert.ok(
        liveSlugs.has(slug),
        `${slug} must exist in the live Composio inventory for ${def.slug}`,
      );
      allSlugs.push(slug);
    }
  }
  assert.equal(allSlugs.length, 400, 'catalog must hold 400 real Composio tools');
  assert.equal(new Set(allSlugs).size, 400, 'no tool slug may repeat across toolkits');
  // Sửa sai v0.57: slug suy đoán GITHUB_CREATE_ISSUE không tồn tại
  // live — slug thật là GITHUB_CREATE_AN_ISSUE.
  assert.ok(!allSlugs.includes('GITHUB_CREATE_ISSUE'), 'GITHUB_CREATE_ISSUE must not be listed');
  assert.ok(allSlugs.includes('GITHUB_CREATE_AN_ISSUE'));
  // v0.85: slug Slack deprecated SLACK_CHAT_POST_MESSAGE không còn là
  // lựa chọn chính — thay bằng SLACK_SEND_MESSAGE (schema live đã
  // fetch, xem docs §8.1 + tool-schemas-write-2026-11-11.json).
  assert.ok(!allSlugs.includes('SLACK_CHAT_POST_MESSAGE'), 'SLACK_CHAT_POST_MESSAGE is deprecated and must not be listed');
  assert.ok(allSlugs.includes('SLACK_SEND_MESSAGE'));
  assert.ok(composioToolNeedsApproval('SLACK_SEND_MESSAGE'), 'SLACK_SEND_MESSAGE is a write and needs approval');
});

test('approval: tool ghi cần approval, tool đọc thì không (so khớp theo segment)', () => {
  const writes = [
    'GMAIL_SEND_EMAIL',
    'GITHUB_CREATE_AN_ISSUE',
    'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
    'GOOGLESHEETS_UPSERT_ROWS',
    'GOOGLEDRIVE_COPY_FILE',
    'GOOGLECALENDAR_QUICK_ADD',
    'JIRA_EDIT_ISSUE',
    'JIRA_TRANSITION_ISSUE',
    'JIRA_ASSIGN_ISSUE',
    'DISCORD_MODIFY_CURRENT_USER',
    'TELEGRAM_EDIT_MESSAGE',
    'TELEGRAM_FORWARD_MESSAGE',
    'TRELLO_ADD_BOARDS',
    'ASANA_ADD_TAG_TO_TASK',
    'SLACK_SEND_MESSAGE',
    'NOTION_APPEND_BLOCK_CHILDREN',
    'HUBSPOT_UPDATE_CONTACT',
    'ZOOM_CREATE_A_MEETING',
    'SALESFORCE_CREATE_LEAD',
    'ZENDESK_CREATE_ZENDESK_TICKET',
    'AIRTABLE_DELETE_RECORD',
    'MONDAY_CREATE_ITEM',
    'CLICKUP_UPDATE_TASK',
    'DROPBOX_CREATE_SHARED_LINK',
    'OUTLOOK_CREATE_USER_MESSAGE',
  ];
  const reads = [
    'GMAIL_FETCH_EMAILS',
    'TELEGRAM_GET_UPDATES',
    'JIRA_SEARCH_ISSUES',
    'LINEAR_GET_CURRENT_USER',
    'DISCORD_GET_MY_USER',
    'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA',
    'GOOGLEDRIVE_LIST_FILES',
    'GOOGLECALENDAR_FREE_BUSY_QUERY',
    'NOTION_SEARCH_NOTION_PAGE',
    'SLACK_WHO_AM_I',
    'ASANA_GET_USER',
    'TRELLO_GET_SEARCH',
    'ZOOM_LIST_MEETINGS',
    'SALESFORCE_QUERY',
    'ZENDESK_SEARCH_ZENDESK',
    'AIRTABLE_LIST_RECORDS',
    'MONDAY_LIST_BOARDS',
    'CLICKUP_GET_TASKS',
    'DROPBOX_FILES_SEARCH',
    'OUTLOOK_SEARCH_MESSAGES',
  ];
  for (const slug of writes) assert.equal(composioToolNeedsApproval(slug), true, slug);
  for (const slug of reads) assert.equal(composioToolNeedsApproval(slug), false, slug);
  // Rỗng/không phải chuỗi → fail-closed (cần approval).
  assert.equal(composioToolNeedsApproval(''), true);
  assert.equal(composioToolNeedsApproval(null), true);
  // GET_UPDATES không được nhầm với UPDATE (so khớp theo segment).
  assert.equal(composioToolNeedsApproval('TELEGRAM_GET_UPDATES'), false);
});

test('catalog: router + 40 toolkit, app id + approval khớp định nghĩa', () => {
  const defs = createComposioAppDefinitions();
  assert.equal(defs.length, 41);
  assert.equal(defs[0].id, COMPOSIO_ROUTER_APP_ID);
  assert.deepEqual(
    defs[0].tools.map((t) => t.name),
    ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MULTI_EXECUTE_TOOL'],
  );
  assert.deepEqual(
    defs.slice(1).map((d) => d.id),
    EXPECTED_SLUGS.map((s) => `composio-${s}`),
  );
  for (const def of defs.slice(1)) {
    assert.equal(def.authType, 'composio');
    assert.equal(def.source, 'composio');
    assert.ok(def.toolkit);
    assert.equal(def.tools.length, 10);
    for (const tool of def.tools) {
      assert.equal(
        tool.needsApproval,
        composioToolNeedsApproval(tool.name),
        `${tool.name} needsApproval must match the rule`,
      );
    }
  }
  assert.equal(createComposioToolkitAppDefinitions().length, 40);
  assert.equal(composioAppId('jira'), 'composio-jira');
  assert.equal(toolkitForComposioAppId('composio-hubspot'), 'hubspot');
  assert.equal(toolkitForComposioAppId('slack'), undefined);
  assert.equal(toolkitForComposioAppId('composio-nope'), undefined);
});

test('source: bật/tắt từng toolkit mới, session chỉ gồm toolkit đang bật', () => {
  const registry = new AppRegistry();
  const source = new ComposioAppSource({ registry, hasApiKey: () => true });
  assert.equal(source.isEnabled(), false);
  source.setEnabled(true);
  assert.deepEqual(source.enabledToolkits(), EXPECTED_SLUGS);
  // new AppRegistry() mặc định đã seed 6 app local (BUILTIN_APPS).
  assert.equal(registry.size(), 6 + 41);
  assert.ok(registry.has('composio-jira'));
  assert.ok(registry.has('composio-hubspot'));
  assert.ok(registry.has('composio-telegram'));
  assert.ok(registry.has('composio-zoom'));
  assert.ok(registry.has('composio-salesforce'));
  assert.ok(registry.has('composio-outlook'));
  // Tắt Jira → gỡ đúng app đó, các toolkit khác không ảnh hưởng.
  source.setToolkitEnabled('jira', false);
  assert.equal(source.isToolkitEnabled('jira'), false);
  assert.equal(registry.has('composio-jira'), false);
  assert.equal(registry.has('composio-linear'), true);
  assert.deepEqual(source.enabledToolkits(), EXPECTED_SLUGS.filter((s) => s !== 'jira'));
  source.setToolkitEnabled('jira', true);
  assert.equal(registry.has('composio-jira'), true);
  // Toolkit lạ → lỗi rõ ràng.
  assert.throws(
    () => source.setToolkitEnabled('nope', true),
    (err) => err instanceof ComposioError && /composio_unknown_toolkit/.test(err.code),
  );
  // Tắt source → gỡ hết app Composio, M7 local còn nguyên (6 app).
  source.setEnabled(false);
  assert.equal(registry.size(), 6);
  // Registry chung: 6 app local + router + 40 toolkit, không đụng tên tool.
  const shared = new AppRegistry([...BUILTIN_APPS]);
  const source2 = new ComposioAppSource({ registry: shared, hasApiKey: () => false });
  source2.setEnabled(true);
  assert.equal(shared.size(), 6 + 41);
  // listStatusViews chỉ trả view của 41 app Composio mà source đã đăng
  // ký (không gồm 6 app local trong registry chung).
  const views = source2.listStatusViews();
  assert.equal(views.length, 41);
  assert.deepEqual(
    views.map((v) => v.app.id).sort(),
    [
      'composio',
      'composio-airtable',
      'composio-asana',
      'composio-bitbucket',
      'composio-box',
      'composio-calendly',
      'composio-clickup',
      'composio-confluence',
      'composio-discord',
      'composio-dropbox',
      'composio-freshdesk',
      'composio-github',
      'composio-gitlab',
      'composio-gmail',
      'composio-googlecalendar',
      'composio-googledocs',
      'composio-googledrive',
      'composio-googlesheets',
      'composio-hubspot',
      'composio-jira',
      'composio-linear',
      'composio-linkedin',
      'composio-mailchimp',
      'composio-monday',
      'composio-notion',
      'composio-outlook',
      'composio-pagerduty',
      'composio-reddit',
      'composio-salesforce',
      'composio-sendgrid',
      'composio-shopify',
      'composio-slack',
      'composio-stripe',
      'composio-telegram',
      'composio-trello',
      'composio-twilio',
      'composio-typeform',
      'composio-whatsapp',
      'composio-youtube',
      'composio-zendesk',
      'composio-zoom',
    ],
  );
});

test('state: mặc định 40 toolkit, resolve chỉ giữ slug hợp lệ', () => {
  const def = defaultComposioPersistedState();
  assert.equal(def.enabled, false);
  assert.deepEqual(def.toolkits, EXPECTED_SLUGS);
  const resolved = resolveComposioPersistedState({
    enabled: true,
    toolkits: ['jira', 'jira', 'nope', 'hubspot', 42, null],
  });
  assert.deepEqual(resolved, { enabled: true, toolkits: ['jira', 'hubspot'] });
  assert.deepEqual(resolveComposioPersistedState(undefined).toolkits, EXPECTED_SLUGS);
  assert.deepEqual(resolveComposioPersistedState({ enabled: 'yes' }), {
    enabled: false,
    toolkits: EXPECTED_SLUGS,
  });
  const registry = new AppRegistry();
  const source = new ComposioAppSource({ registry, hasApiKey: () => true });
  applyComposioPersistedState(source, { enabled: true, toolkits: ['trello', 'asana'] });
  assert.equal(source.isEnabled(), true);
  assert.deepEqual(source.enabledToolkits(), ['trello', 'asana']);
  const view = buildComposioStateView(source, true);
  assert.equal(view.enabled, true);
  assert.equal(view.keyConfigured, true);
  assert.equal(view.apps.length, 40);
  assert.deepEqual(
    view.apps.filter((a) => a.enabled).map((a) => a.toolkit),
    ['trello', 'asana'],
  );
  assert.equal(view.apps.find((a) => a.toolkit === 'trello').label, 'Trello (via Composio)');
});

test('cap: 10 tool/toolkit vừa đúng cap M7 — không tool nào bị cắt', () => {
  const defs = createComposioAppDefinitions();
  const registry = new AppRegistry();
  for (const def of defs) registry.register(def);
  const tools = defs.flatMap((d) =>
    d.tools.map((t) => ({ definition: { name: t.name } })),
  );
  assert.equal(tools.length, 403); // 3 meta-tool + 400 toolkit tool.
  const { tools: kept, capped } = applyAppToolCaps(tools, {}, registry);
  assert.equal(kept.length, 403);
  assert.deepEqual(capped, []);
  assert.equal(DEFAULT_APP_TOOL_CAP, 10);
});
