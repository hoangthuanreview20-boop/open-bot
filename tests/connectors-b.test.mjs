/**
 * Tests for direct OAuth connector read clients (v0.73): Jira, Linear,
 * HubSpot, Asana, Discord — hàm đọc thật qua API chính thức của từng
 * provider, theo mẫu google.ts (callWithAutoRefresh, mock fetch).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/connectors-b.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake ('test-token'). Mỗi hàm có ít nhất 1 test success + 1 test lỗi.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import '../packages/core/dist/connectors/jira.js';
import '../packages/core/dist/connectors/linear.js';
import '../packages/core/dist/connectors/hubspot.js';
import '../packages/core/dist/connectors/asana.js';
import '../packages/core/dist/connectors/discord.js';
import {
  jiraGetIssue,
  jiraListAccessibleResources,
  jiraSearchIssues,
} from '../packages/core/dist/connectors/jira.js';
import { linearGetIssue, linearListIssues } from '../packages/core/dist/connectors/linear.js';
import {
  hubspotListCompanies,
  hubspotListContacts,
  hubspotSearchContacts,
} from '../packages/core/dist/connectors/hubspot.js';
import {
  asanaGetCurrentUser,
  asanaGetTask,
  asanaListProjects,
  asanaListTasks,
} from '../packages/core/dist/connectors/asana.js';
import {
  discordGetCurrentUser,
  discordListGuildChannels,
  discordListGuilds,
} from '../packages/core/dist/connectors/discord.js';

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

const TOKEN = 'test-token';
const opts = () => ({ getToken: () => TOKEN, fetchFn: globalThis.fetch });

function bearer(call) {
  return call.init.headers.Authorization;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

test('jira: listAccessibleResources — trả về cloudId cho từng site', async () => {
  const mocked = mockFetch((url) => {
    assert.equal(url, 'https://api.atlassian.com/oauth/token/accessible-resources');
    return {
      body: [
        { id: 'cloud-1', name: 'Site A', url: 'https://site-a.atlassian.net', scopes: ['read:jira-work'] },
        { id: 'cloud-2', name: 'Site B', url: 'https://site-b.atlassian.net' },
        { name: 'khong-co-id' },
      ],
    };
  });
  tempMocks.push(mocked);
  const sites = await jiraListAccessibleResources(opts());
  assert.equal(sites.length, 2);
  assert.equal(sites[0].id, 'cloud-1');
  assert.equal(sites[0].name, 'Site A');
  assert.deepEqual(sites[0].scopes, ['read:jira-work']);
  assert.equal(sites[1].url, 'https://site-b.atlassian.net');
  assert.equal(bearer(mocked.calls[0]), `Bearer ${TOKEN}`);
});

test('jira: searchIssues — JQL + parse fields, bỏ item thiếu id/key', async () => {
  const mocked = mockFetch((url) => {
    assert.ok(url.startsWith('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/search?'));
    const params = new URL(url).searchParams;
    assert.equal(params.get('jql'), 'project = ENG ORDER BY updated DESC');
    assert.equal(params.get('maxResults'), '10');
    assert.equal(params.get('fields'), 'summary,status,assignee,updated');
    return {
      body: {
        total: 3,
        issues: [
          { id: '1001', key: 'ENG-1', fields: { summary: 'Làm A', status: { name: 'In Progress' }, assignee: { displayName: 'Huy' }, updated: '2026-11-11T00:00:00Z' } },
          { id: '1002', key: 'ENG-2', fields: { summary: 'Làm B', status: { name: 'Done' } } },
          { key: 'ENG-3', fields: {} },
        ],
      },
    };
  });
  tempMocks.push(mocked);
  const issues = await jiraSearchIssues(opts(), 'cloud-1', 'project = ENG ORDER BY updated DESC');
  assert.equal(issues.length, 2);
  assert.equal(issues[0].key, 'ENG-1');
  assert.equal(issues[0].status, 'In Progress');
  assert.equal(issues[0].assignee, 'Huy');
  assert.equal(issues[1].status, 'Done');
  assert.equal(issues[1].assignee, undefined);
});

test('jira: getIssue — success + lỗi 404 + validation + chưa có token', async () => {
  const mocked = mockFetch((url) => {
    if (url.includes('/issue/ENG-1?')) {
      return {
        body: { id: '1001', key: 'ENG-1', fields: { summary: 'Làm A', status: { name: 'To Do' }, updated: '2026-11-10T00:00:00Z' } },
      };
    }
    return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
  });
  tempMocks.push(mocked);
  const issue = await jiraGetIssue(opts(), 'cloud-1', 'ENG-1');
  assert.equal(issue.key, 'ENG-1');
  assert.equal(issue.summary, 'Làm A');
  assert.equal(issue.status, 'To Do');

  await assert.rejects(jiraGetIssue(opts(), 'cloud-1', 'ENG-404'), /không tìm thấy \(HTTP 404\)/);
  await assert.rejects(jiraGetIssue(opts(), '', 'ENG-1'), /cloudId is required/);
  await assert.rejects(jiraGetIssue(opts(), 'cloud-1', ''), /issueKey is required/);
  await assert.rejects(
    jiraSearchIssues(opts(), 'cloud-1', ''),
    /JQL is required/,
  );
  await assert.rejects(
    jiraListAccessibleResources({ getToken: () => null, fetchFn: globalThis.fetch }),
    /Chưa kết nối Jira/,
  );
});

test('jira: lỗi 403 (không đủ quyền) và 429 (rate limit) có message rõ', async () => {
  const mocked = mockFetch(() => ({ status: 403, body: {} }));
  tempMocks.push(mocked);
  await assert.rejects(
    jiraSearchIssues(opts(), 'cloud-1', 'project = ENG'),
    /không đủ quyền \(HTTP 403\)/,
  );
  mocked.restore();
  tempMocks.pop();

  const mocked429 = mockFetch(() => ({ status: 429, body: {} }));
  tempMocks.push(mocked429);
  await assert.rejects(
    jiraSearchIssues(opts(), 'cloud-1', 'project = ENG'),
    /rate limit \(HTTP 429\)/,
  );
});

test('jira: 401 với cùng token → TokenExpiredError, không retry vô ích', async () => {
  const mocked = mockFetch(() => ({ status: 401, body: {} }));
  tempMocks.push(mocked);
  await assert.rejects(
    jiraSearchIssues(opts(), 'cloud-1', 'project = ENG'),
    (err) => err.code === 'TOKEN_EXPIRED',
  );
  // Token mới giống token cũ → framework không retry (tránh gọi lại vô ích).
  assert.equal(mocked.calls.length, 1);
});

test('jira: 401 rồi token mới khác → retry 1 lần và thành công', async () => {
  let n = 0;
  const mocked = mockFetch(() => {
    n += 1;
    if (n === 1) return { status: 401, body: {} };
    return {
      body: { total: 1, issues: [{ id: '1001', key: 'ENG-1', fields: { summary: 'Làm A' } }] },
    };
  });
  tempMocks.push(mocked);
  const provider = {
    getAccessToken: async ({ forceRefresh } = {}) =>
      forceRefresh ? 'token-moi' : 'test-token',
  };
  const issues = await jiraSearchIssues(
    { getToken: () => TOKEN, tokenProvider: provider, fetchFn: globalThis.fetch },
    'cloud-1',
    'project = ENG',
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'ENG-1');
  assert.equal(mocked.calls.length, 2);
  assert.equal(bearer(mocked.calls[1]), 'Bearer token-moi');
});

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

test('linear: listIssues — POST GraphQL, parse nodes', async () => {
  const mocked = mockFetch((url, init) => {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.ok(body.query.includes('issues(first: $first)'));
    assert.equal(body.variables.first, 10);
    return {
      body: {
        data: {
          issues: {
            nodes: [
              { id: 'u1', identifier: 'ENG-1', title: 'Làm A', state: { name: 'In Progress' }, assignee: { name: 'Huy' }, createdAt: '2026-11-10T00:00:00Z' },
              { id: 'u2', identifier: 'ENG-2', title: 'Làm B', state: { name: 'Done' } },
              { title: 'thieu-id' },
            ],
          },
        },
      },
    };
  });
  tempMocks.push(mocked);
  const issues = await linearListIssues(opts());
  assert.equal(issues.length, 2);
  assert.equal(issues[0].identifier, 'ENG-1');
  assert.equal(issues[0].state, 'In Progress');
  assert.equal(issues[0].assignee, 'Huy');
  assert.equal(issues[1].state, 'Done');
  assert.equal(bearer(mocked.calls[0]), `Bearer ${TOKEN}`);
});

test('linear: getIssue — tìm theo identifier qua filter, không tìm thấy → lỗi rõ', async () => {
  const mocked = mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.query.includes('filter: { identifier: { eq: $identifier } }'));
    assert.equal(body.variables.identifier, 'ENG-1');
    return {
      body: {
        data: {
          issues: {
            nodes: [{ id: 'u1', identifier: 'ENG-1', title: 'Làm A', state: { name: 'To Do' } }],
          },
        },
      },
    };
  });
  tempMocks.push(mocked);
  const issue = await linearGetIssue(opts(), 'ENG-1');
  assert.equal(issue.id, 'u1');
  assert.equal(issue.title, 'Làm A');
  mocked.restore();
  tempMocks.pop();

  const mockedEmpty = mockFetch(() => ({
    body: { data: { issues: { nodes: [] } } },
  }));
  tempMocks.push(mockedEmpty);
  await assert.rejects(linearGetIssue(opts(), 'ENG-404'), /not found/);
  await assert.rejects(linearGetIssue(opts(), ''), /identifier is required/);
});

test('linear: lỗi GraphQL trong mảng errors + HTTP 429 + chưa có token + 401 POST không retry', async () => {
  const mockedErr = mockFetch(() => ({
    body: { data: null, errors: [{ message: 'Invalid scope' }] },
  }));
  tempMocks.push(mockedErr);
  await assert.rejects(linearListIssues(opts()), /Linear GraphQL error: Invalid scope/);
  mockedErr.restore();
  tempMocks.pop();

  const mocked429 = mockFetch(() => ({ status: 429, body: {} }));
  tempMocks.push(mocked429);
  await assert.rejects(linearListIssues(opts()), /rate limit \(HTTP 429\)/);
  mocked429.restore();
  tempMocks.pop();

  await assert.rejects(
    linearListIssues({ getToken: () => null, fetchFn: globalThis.fetch }),
    /Chưa kết nối Linear/,
  );

  // POST 401: framework không retry POST → TokenExpiredError, chỉ 1 call.
  const mocked401 = mockFetch(() => ({ status: 401, body: {} }));
  tempMocks.push(mocked401);
  await assert.rejects(
    linearListIssues(opts()),
    (err) => err.code === 'TOKEN_EXPIRED',
  );
  assert.equal(mocked401.calls.length, 1);
});

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

test('hubspot: listContacts + listCompanies — parse properties', async () => {
  const mocked = mockFetch((url) => {
    if (url.includes('/objects/contacts?')) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('limit'), '10');
      assert.equal(params.get('properties'), 'email,firstname,lastname');
      return {
        body: {
          results: [
            { id: '1', properties: { email: 'a@x.com', firstname: 'An', lastname: 'Nguyen' } },
            { id: '2', properties: { email: 'b@x.com' } },
            { properties: { email: 'khong-co-id@x.com' } },
          ],
        },
      };
    }
    if (url.includes('/objects/companies?')) {
      return {
        body: {
          results: [{ id: '10', properties: { name: 'Acme', domain: 'acme.com' } }],
        },
      };
    }
    return { status: 404, body: {} };
  });
  tempMocks.push(mocked);
  const contacts = await hubspotListContacts(opts());
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].email, 'a@x.com');
  assert.equal(contacts[0].firstName, 'An');
  assert.equal(contacts[0].lastName, 'Nguyen');
  assert.equal(contacts[1].firstName, undefined);

  const companies = await hubspotListCompanies(opts());
  assert.equal(companies.length, 1);
  assert.equal(companies[0].name, 'Acme');
  assert.equal(companies[0].domain, 'acme.com');
  assert.equal(bearer(mocked.calls[0]), `Bearer ${TOKEN}`);
});

test('hubspot: searchContacts — POST search, body có query', async () => {
  const mocked = mockFetch((url, init) => {
    assert.ok(url.endsWith('/objects/contacts/search'));
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.query, 'nguyen');
    assert.equal(body.limit, 5);
    assert.deepEqual(body.properties, ['email', 'firstname', 'lastname']);
    return {
      body: {
        results: [{ id: '1', properties: { email: 'a@x.com', firstname: 'An', lastname: 'Nguyen' } }],
      },
    };
  });
  tempMocks.push(mocked);
  const contacts = await hubspotSearchContacts(opts(), 'nguyen', 5);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].email, 'a@x.com');
  await assert.rejects(hubspotSearchContacts(opts(), ''), /query is required/);
});

test('hubspot: lỗi 403 + chưa có token', async () => {
  const mocked = mockFetch(() => ({ status: 403, body: {} }));
  tempMocks.push(mocked);
  await assert.rejects(hubspotListContacts(opts()), /không đủ quyền \(HTTP 403\)/);
  await assert.rejects(
    hubspotListCompanies({ getToken: () => null, fetchFn: globalThis.fetch }),
    /Chưa kết nối HubSpot/,
  );
});

// ---------------------------------------------------------------------------
// Asana
// ---------------------------------------------------------------------------

test('asana: getCurrentUser — parse data + workspaces', async () => {
  const mocked = mockFetch((url) => {
    assert.ok(url.startsWith('https://app.asana.com/api/1.0/users/me?'));
    return {
      body: {
        data: {
          gid: 'u1',
          name: 'Huy',
          email: 'huy@x.com',
          workspaces: [{ gid: 'w1', name: 'WS 1' }, { gid: 'w2' }],
        },
      },
    };
  });
  tempMocks.push(mocked);
  const user = await asanaGetCurrentUser(opts());
  assert.equal(user.gid, 'u1');
  assert.equal(user.name, 'Huy');
  assert.deepEqual(user.workspaceGids, ['w1', 'w2']);
  assert.equal(bearer(mocked.calls[0]), `Bearer ${TOKEN}`);
});

test('asana: listProjects + listTasks — query param + parse data', async () => {
  const mocked = mockFetch((url) => {
    if (url.includes('/projects?')) {
      assert.equal(new URL(url).searchParams.get('workspace'), 'w1');
      return {
        body: {
          data: [
            { gid: 'p1', name: 'Project A', archived: false },
            { gid: 'p2', name: 'Project B', archived: true },
            { name: 'khong-co-gid' },
          ],
        },
      };
    }
    if (url.includes('/tasks?')) {
      assert.equal(new URL(url).searchParams.get('project'), 'p1');
      return {
        body: {
          data: [
            { gid: 't1', name: 'Task 1', completed: false, due_on: '2026-11-15', assignee: { name: 'Huy' } },
            { gid: 't2', name: 'Task 2', completed: true, due_on: null },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
  tempMocks.push(mocked);
  const projects = await asanaListProjects(opts(), 'w1');
  assert.equal(projects.length, 2);
  assert.equal(projects[0].name, 'Project A');
  assert.equal(projects[1].archived, true);

  const tasks = await asanaListTasks(opts(), 'p1');
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].dueOn, '2026-11-15');
  assert.equal(tasks[0].assignee, 'Huy');
  assert.equal(tasks[1].completed, true);
  assert.equal(tasks[1].dueOn, null);
});

test('asana: getTask — success + 404 + validation + chưa có token', async () => {
  const mocked = mockFetch((url) => {
    if (url.includes('/tasks/t1?')) {
      return {
        body: { data: { gid: 't1', name: 'Task 1', completed: false, due_on: '2026-11-15' } },
      };
    }
    return { status: 404, body: { errors: [{ message: 'task: Not Found' }] } };
  });
  tempMocks.push(mocked);
  const task = await asanaGetTask(opts(), 't1');
  assert.equal(task.name, 'Task 1');
  await assert.rejects(asanaGetTask(opts(), 't404'), /không tìm thấy \(HTTP 404\)/);
  await assert.rejects(asanaGetTask(opts(), ''), /taskGid is required/);
  await assert.rejects(asanaListProjects(opts(), ''), /workspaceGid is required/);
  await assert.rejects(asanaListTasks(opts(), ''), /projectGid is required/);
  await assert.rejects(
    asanaGetCurrentUser({ getToken: () => null, fetchFn: globalThis.fetch }),
    /Chưa kết nối Asana/,
  );
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

test('discord: getCurrentUser — parse @me', async () => {
  const mocked = mockFetch((url) => {
    assert.equal(url, 'https://discord.com/api/v10/users/@me');
    return {
      body: { id: 'u1', username: 'huy', global_name: 'Huy Nguyen', avatar: 'abc123' },
    };
  });
  tempMocks.push(mocked);
  const user = await discordGetCurrentUser(opts());
  assert.equal(user.id, 'u1');
  assert.equal(user.username, 'huy');
  assert.equal(user.globalName, 'Huy Nguyen');
  assert.equal(bearer(mocked.calls[0]), `Bearer ${TOKEN}`);
});

test('discord: listGuilds + listGuildChannels — parse mảng', async () => {
  const mocked = mockFetch((url) => {
    if (url.includes('/users/@me/guilds?')) {
      assert.equal(new URL(url).searchParams.get('limit'), '10');
      return {
        body: [
          { id: 'g1', name: 'Server A', icon: 'ico1', owner: true },
          { id: 'g2', name: 'Server B', icon: null, owner: false },
          { name: 'khong-co-id' },
        ],
      };
    }
    if (url.includes('/guilds/g1/channels')) {
      return {
        body: [
          { id: 'c1', name: 'general', type: 0, position: 0 },
          { id: 'c2', name: 'Voice', type: 2, position: 1 },
        ],
      };
    }
    return { status: 404, body: {} };
  });
  tempMocks.push(mocked);
  const guilds = await discordListGuilds(opts());
  assert.equal(guilds.length, 2);
  assert.equal(guilds[0].name, 'Server A');
  assert.equal(guilds[0].owner, true);
  assert.equal(guilds[1].icon, null);

  const channels = await discordListGuildChannels(opts(), 'g1');
  assert.equal(channels.length, 2);
  assert.equal(channels[0].name, 'general');
  assert.equal(channels[0].type, 0);
  assert.equal(channels[1].type, 2);
  await assert.rejects(discordListGuildChannels(opts(), ''), /guildId is required/);
});

test('discord: lỗi 403 + 429 + chưa có token', async () => {
  const mocked = mockFetch(() => ({ status: 403, body: { message: 'Missing Access' } }));
  tempMocks.push(mocked);
  await assert.rejects(discordListGuilds(opts()), /không đủ quyền \(HTTP 403\)/);
  mocked.restore();
  tempMocks.pop();

  const mocked429 = mockFetch(() => ({ status: 429, body: {} }));
  tempMocks.push(mocked429);
  await assert.rejects(discordGetCurrentUser(opts()), /rate limit \(HTTP 429\)/);
  mocked429.restore();
  tempMocks.pop();

  await assert.rejects(
    discordGetCurrentUser({ getToken: () => null, fetchFn: globalThis.fetch }),
    /Chưa kết nối Discord/,
  );
});
