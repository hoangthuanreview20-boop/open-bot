/**
 * Tests for direct OAuth connectors (v0.72a Team A): Google Workspace,
 * Jira, Linear, HubSpot, Asana, Discord — ConnectorDefinition theo
 * mẫu sẵn có (slack/gmail/teams), endpoint + scope đối chiếu tài liệu
 * chính thức của từng provider, Google API đọc thật qua mock fetch.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connectors-a.test.mjs
 *
 * No live network, no real tokens: token endpoint + API đều mock
 * fetch, token là chuỗi fake ('ya29-test'). Trello (OAuth 1.0a) và
 * Telegram (không có OAuth2) cố tình KHÔNG có connector — xem
 * docs/composio-integration.md §5.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuthorizationUrl,
  getConnector,
  listConnectors,
} from '../packages/core/dist/connectors/framework.js';
import '../packages/core/dist/connectors/google.js';
import '../packages/core/dist/connectors/jira.js';
import '../packages/core/dist/connectors/linear.js';
import '../packages/core/dist/connectors/hubspot.js';
import '../packages/core/dist/connectors/asana.js';
import '../packages/core/dist/connectors/discord.js';
import {
  GOOGLE_CONNECTOR,
  googleCalendarListEvents,
  googleDriveListFiles,
  googleSheetsGetValues,
} from '../packages/core/dist/connectors/google.js';
import { JIRA_CONNECTOR } from '../packages/core/dist/connectors/jira.js';
import { LINEAR_CONNECTOR } from '../packages/core/dist/connectors/linear.js';
import { HUBSPOT_CONNECTOR } from '../packages/core/dist/connectors/hubspot.js';
import { ASANA_CONNECTOR } from '../packages/core/dist/connectors/asana.js';
import { DISCORD_CONNECTOR } from '../packages/core/dist/connectors/discord.js';

/** Mock fetch: handler(url, init) -> { status, body }. Captures calls. */
function mockFetch(handler) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init ?? {});
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.body,
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
      headers: { get: () => null },
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const tempMocks = [];
afterEach(() => {
  while (tempMocks.length > 0) tempMocks.pop().restore();
});

function authParams() {
  return {
    clientId: 'test-client',
    redirectUri: 'http://127.0.0.1:8765/callback',
    state: 'test-state',
  };
}

test('connectors: 6 connector mới đăng ký, đủ authUrl + tokenUrl + scope', () => {
  const defs = {
    google: GOOGLE_CONNECTOR,
    jira: JIRA_CONNECTOR,
    linear: LINEAR_CONNECTOR,
    hubspot: HUBSPOT_CONNECTOR,
    asana: ASANA_CONNECTOR,
    discord: DISCORD_CONNECTOR,
  };
  for (const [id, def] of Object.entries(defs)) {
    assert.equal(def.id, id);
    assert.equal(def.authType, 'oauth2');
    assert.ok(def.label.length > 0, `${id} needs a label`);
    assert.ok(def.authUrl, `${id} needs an authUrl`);
    assert.ok(def.tokenUrl, `${id} needs a tokenUrl`);
    assert.ok(def.scopes.length > 0, `${id} needs scopes`);
    assert.ok(def.description && def.description.length > 0, `${id} needs a description`);
    const fromRegistry = getConnector(id);
    assert.ok(fromRegistry, `${id} must be registered`);
    assert.deepEqual(fromRegistry.scopes, def.scopes);
  }
  assert.deepEqual(
    listConnectors().map((d) => d.id),
    ['google', 'jira', 'linear', 'hubspot', 'asana', 'discord'],
  );
  // Trello (OAuth 1.0a) và Telegram (không có OAuth2) không có connector.
  assert.equal(getConnector('trello'), undefined);
  assert.equal(getConnector('telegram'), undefined);
});

test('connectors: endpoint + scope khớp tài liệu chính thức từng provider', () => {
  assert.equal(GOOGLE_CONNECTOR.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(GOOGLE_CONNECTOR.tokenUrl, 'https://oauth2.googleapis.com/token');
  assert.ok(GOOGLE_CONNECTOR.scopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(
    GOOGLE_CONNECTOR.scopes.includes('https://www.googleapis.com/auth/spreadsheets.readonly'),
  );
  assert.ok(
    GOOGLE_CONNECTOR.scopes.includes('https://www.googleapis.com/auth/calendar.events.readonly'),
  );

  assert.equal(JIRA_CONNECTOR.authUrl, 'https://auth.atlassian.com/authorize');
  assert.equal(JIRA_CONNECTOR.tokenUrl, 'https://auth.atlassian.com/oauth/token');
  assert.deepEqual(JIRA_CONNECTOR.scopes, [
    'read:jira-user',
    'read:jira-work',
    'write:jira-work',
    'offline_access',
  ]);

  assert.equal(LINEAR_CONNECTOR.authUrl, 'https://linear.app/oauth/authorize');
  assert.equal(LINEAR_CONNECTOR.tokenUrl, 'https://api.linear.app/oauth/token');
  assert.deepEqual(LINEAR_CONNECTOR.scopes, ['read', 'write']);

  assert.equal(HUBSPOT_CONNECTOR.authUrl, 'https://app.hubspot.com/oauth/authorize');
  assert.equal(HUBSPOT_CONNECTOR.tokenUrl, 'https://api.hubapi.com/oauth/v1/token');
  assert.ok(HUBSPOT_CONNECTOR.scopes.includes('oauth'));
  assert.ok(HUBSPOT_CONNECTOR.scopes.includes('crm.objects.contacts.read'));

  assert.equal(ASANA_CONNECTOR.authUrl, 'https://app.asana.com/-/oauth_authorize');
  assert.equal(ASANA_CONNECTOR.tokenUrl, 'https://app.asana.com/-/oauth_token');
  assert.deepEqual(ASANA_CONNECTOR.scopes, ['projects:read', 'tasks:read', 'tasks:write']);

  assert.equal(DISCORD_CONNECTOR.authUrl, 'https://discord.com/oauth2/authorize');
  assert.equal(DISCORD_CONNECTOR.tokenUrl, 'https://discord.com/api/oauth2/token');
  assert.deepEqual(DISCORD_CONNECTOR.scopes, ['identify', 'guilds', 'guilds.members.read']);
});

test('connectors: buildAuthorizationUrl — Jira cần audience, Linear scope nối bằng dấu phẩy', () => {
  const googleUrl = new URL(buildAuthorizationUrl(GOOGLE_CONNECTOR, authParams()));
  assert.equal(googleUrl.searchParams.get('response_type'), 'code');
  assert.equal(googleUrl.searchParams.get('client_id'), 'test-client');
  assert.ok(googleUrl.searchParams.get('scope').includes('drive.readonly'));

  const jiraUrl = new URL(buildAuthorizationUrl(JIRA_CONNECTOR, authParams()));
  assert.equal(jiraUrl.searchParams.get('audience'), 'api.atlassian.com');
  assert.equal(jiraUrl.searchParams.get('prompt'), 'consent');
  assert.ok(jiraUrl.searchParams.get('scope').includes('read:jira-work'));

  const linearUrl = new URL(buildAuthorizationUrl(LINEAR_CONNECTOR, authParams()));
  // Linear: scope nối bằng DẤU PHẨY (docs Linear), không phải khoảng trắng.
  assert.equal(linearUrl.searchParams.get('scope'), 'read,write');

  const hubspotUrl = new URL(buildAuthorizationUrl(HUBSPOT_CONNECTOR, authParams()));
  assert.equal(hubspotUrl.hostname, 'app.hubspot.com');

  const asanaUrl = new URL(buildAuthorizationUrl(ASANA_CONNECTOR, authParams()));
  assert.equal(asanaUrl.pathname, '/-/oauth_authorize');

  const discordUrl = new URL(buildAuthorizationUrl(DISCORD_CONNECTOR, authParams()));
  assert.equal(discordUrl.hostname, 'discord.com');

  // PKCE: code_challenge đi kèm method S256 cho Jira/Linear.
  const pkce = { ...authParams(), codeChallenge: 'abc123challenge' };
  const jiraPkce = new URL(buildAuthorizationUrl(JIRA_CONNECTOR, pkce));
  assert.equal(jiraPkce.searchParams.get('code_challenge'), 'abc123challenge');
  assert.equal(jiraPkce.searchParams.get('code_challenge_method'), 'S256');
  const linearPkce = new URL(buildAuthorizationUrl(LINEAR_CONNECTOR, pkce));
  assert.equal(linearPkce.searchParams.get('code_challenge'), 'abc123challenge');
  assert.equal(linearPkce.searchParams.get('code_challenge_method'), 'S256');
});

test('google: drive list files — parse + Bearer token + query', async () => {
  const mocked = mockFetch((url) => {
    assert.ok(url.startsWith('https://www.googleapis.com/drive/v3/files?'));
    // URLSearchParams mã hoá khoảng trắng thành '+', không phải '%20'.
    assert.equal(new URL(url).searchParams.get('q'), "name contains 'bao cao'");
    assert.equal(new URL(url).searchParams.get('pageSize'), '10');
    return {
      body: {
        files: [
          { id: 'f1', name: 'bao cao.xlsx', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-11-10T01:00:00Z' },
          { id: 'f2', name: 'ghi chu.txt', mimeType: 'text/plain' },
          { name: 'khong-co-id' },
        ],
      },
    };
  });
  tempMocks.push(mocked);
  const files = await googleDriveListFiles(
    { getToken: () => 'ya29-test', fetchFn: globalThis.fetch },
    "name contains 'bao cao'",
    10,
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].id, 'f1');
  assert.equal(files[0].name, 'bao cao.xlsx');
  assert.equal(files[0].modifiedTime, '2026-11-10T01:00:00Z');
  assert.equal(files[1].mimeType, 'text/plain');
  const auth = mocked.calls[0].init.headers.Authorization;
  assert.equal(auth, 'Bearer ya29-test');
});

test('google: sheets get values + calendar list events — parse + lỗi khi chưa có token', async () => {
  const mocked = mockFetch((url) => {
    if (url.includes('/values/')) {
      assert.ok(url.includes('Sheet1!A1%3AB2'));
      return { body: { range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']] } };
    }
    if (url.includes('/events?')) {
      assert.equal(
        new URL(url).searchParams.get('timeMin'),
        '2026-11-11T00:00:00+07:00',
      );
      return {
        body: {
          items: [
            { id: 'e1', summary: 'Họp team', start: { dateTime: '2026-11-11T09:00:00+07:00' }, end: { dateTime: '2026-11-11T10:00:00+07:00' } },
            { id: 'e2', summary: 'Nghỉ', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
  tempMocks.push(mocked);
  const sheet = await googleSheetsGetValues(
    { getToken: () => 'ya29-test', fetchFn: globalThis.fetch },
    'abc123',
    'Sheet1!A1:B2',
  );
  assert.equal(sheet.range, 'Sheet1!A1:B2');
  assert.deepEqual(sheet.values, [['a', 'b'], ['c', 'd']]);

  const events = await googleCalendarListEvents(
    { getToken: async () => 'ya29-test', fetchFn: globalThis.fetch },
    'primary',
    '2026-11-11T00:00:00+07:00',
    undefined,
    5,
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].summary, 'Họp team');
  assert.equal(events[0].start, '2026-11-11T09:00:00+07:00');
  assert.equal(events[1].start, '2026-11-12'); // all-day event dùng date.

  // Chưa có token → lỗi rõ ràng, không gọi API.
  await assert.rejects(
    googleDriveListFiles({ getToken: () => null, fetchFn: globalThis.fetch }),
    /Chưa kết nối Google/,
  );
  await assert.rejects(
    googleSheetsGetValues({ getToken: () => null }, 'x', 'A1'),
    /Chưa kết nối Google/,
  );
  await assert.rejects(
    googleSheetsGetValues({ getToken: () => 'ya29-test' }, '', 'A1'),
    /spreadsheetId is required/,
  );
  await assert.rejects(
    googleCalendarListEvents({ getToken: () => 'ya29-test' }, ''),
    /calendarId is required/,
  );
});
