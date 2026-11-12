/**
 * Tests for direct read clients index (worker F2, v0.89b).
 *
 * Kiểm tra map toolkit slug → client đủ 11 toolkit và export đầy đủ.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-index.test.mjs
 *
 * No live network, no real tokens. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  READ_CLIENT_TOOLKITS,
  READ_CLIENT_TOOLKIT_SLUGS,
  getReadClientInfo,
  notionSearch,
  trelloListBoards,
  dropboxListFolder,
  outlookListMessages,
  airtableListRecords,
  zoomListMeetings,
  telegramGetMe,
  mondayListBoards,
  clickupListTasks,
  salesforceQuery,
  zendeskListTickets,
} from '../packages/core/dist/clients/index.js';

test('clients index: map đủ 11 toolkit slug', () => {
  const expected = [
    'notion',
    'trello',
    'dropbox',
    'outlook',
    'airtable',
    'zoom',
    'telegram',
    'monday',
    'clickup',
    'salesforce',
    'zendesk',
  ];
  assert.deepEqual([...READ_CLIENT_TOOLKIT_SLUGS].sort(), [...expected].sort());
  for (const slug of expected) {
    const info = READ_CLIENT_TOOLKITS[slug];
    assert.equal(info.slug, slug);
    assert.ok(info.client.length > 0);
    assert.ok(info.label.length > 0);
    assert.ok(info.auth.length > 0);
  }
});

test('clients index: getReadClientInfo trả đúng / undefined khi chưa có', () => {
  assert.equal(getReadClientInfo('notion')?.client, 'notion');
  assert.equal(getReadClientInfo('telegram')?.auth.includes('Bot token'), true);
  assert.equal(getReadClientInfo('gmail'), undefined);
});

test('clients index: export đủ hàm đọc chính của 11 client', () => {
  for (const fn of [
    notionSearch,
    trelloListBoards,
    dropboxListFolder,
    outlookListMessages,
    airtableListRecords,
    zoomListMeetings,
    telegramGetMe,
    mondayListBoards,
    clickupListTasks,
    salesforceQuery,
    zendeskListTickets,
  ]) {
    assert.equal(typeof fn, 'function');
  }
});
