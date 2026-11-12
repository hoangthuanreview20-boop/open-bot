/**
 * Tests for v0.7 connectors + session box (local): Slack / Gmail /
 * Teams via mock fetch, iMessage draft on Linux (file), meeting
 * import + rule-based summary, connector OAuth framework, session box
 * snapshot/restore round-trip.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/connectors-v07.test.mjs
 *
 * No live network, no real tokens: fetch is mocked per test, tokens
 * are fake strings ('xoxb-test', 'ya29-test', 'graph-test').
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  INTEGRATION_TOOLS,
  createIntegrationTools,
} from '../packages/tools/dist/integrationTools.js';
import {
  createSession,
  snapshotSession,
  restoreSession,
  listSessions,
  listSnapshots,
  destroySession,
} from '../packages/core/dist/session/box.js';
import {
  ConnectorRegistry,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  vaultTokenStore,
} from '../packages/core/dist/connectors/framework.js';
import { draftImessage } from '../packages/core/dist/connectors/imessage.js';
import {
  parseTranscript,
  summarizeTranscript,
} from '../packages/core/dist/connectors/meeting.js';

const tempDirs = [];
function makeTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-conn-v07-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);

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

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// --- Tool inventory -------------------------------------------------------

test('INTEGRATION_TOOLS exports 29 tools; sends need approval, reads do not', () => {
  const names = INTEGRATION_TOOLS.map((t) => t.definition.name).sort();
  assert.deepEqual(names, [
    'email_read',
    'email_send',
    'git_host_connect',
    'imessage_draft',
    'meeting_summarize',
    'meeting_transcript',
    'memory_forget',
    'memory_recall',
    'memory_remember',
    'pr_code_tour_update',
    'pr_code_tour_view',
    'pr_create',
    'pr_label_set',
    'pr_list',
    'pr_update',
    'session_box_create',
    'session_box_destroy',
    'session_box_list',
    'session_box_replace_env',
    'session_box_restore',
    'session_box_snapshot',
    'set_active_branch',
    'slack_list_channels',
    'slack_read',
    'slack_send',
    'team_context_summary',
    'teams_list_teams',
    'teams_send',
    'transcript_archive',
  ]);
  const byName = Object.fromEntries(INTEGRATION_TOOLS.map((t) => [t.definition.name, t]));
  for (const name of ['slack_send', 'email_send', 'teams_send']) {
    assert.equal(byName[name].needsApproval, true, name);
  }
  for (const name of ['slack_list_channels', 'slack_read', 'email_read', 'teams_list_teams']) {
    assert.equal(byName[name].needsApproval, false, name);
  }
  // v0.68b: the 8 git tools (7 GitHub API + set_active_branch) are
  // folded into createIntegrationTools; the writes need approval,
  // the reads do not — same rule as the other connectors.
  for (const name of ['pr_create', 'pr_update', 'pr_label_set', 'pr_code_tour_update', 'set_active_branch']) {
    assert.equal(byName[name].needsApproval, true, name);
  }
  for (const name of ['git_host_connect', 'pr_list', 'pr_code_tour_view']) {
    assert.equal(byName[name].needsApproval, false, name);
  }
  // No tool description may claim a send that does not happen.
  assert.match(byName['imessage_draft'].definition.description, /never sends/i);
  assert.match(byName['session_box_create'].definition.description, /LOCAL/i);
  // Every tool has a JSON Schema parameters object.
  for (const t of INTEGRATION_TOOLS) {
    assert.equal(t.definition.parameters.type, 'object');
    assert.equal(typeof t.definition.parameters.properties, 'object');
  }
});

test('unbound INTEGRATION_TOOLS: external tools fail with a clear not-connected error, no token', async () => {
  const dir = makeTempWorkspace();
  const out = await tool(INTEGRATION_TOOLS, 'slack_send').execute(
    { channel: 'C1', text: 'hi' },
    CTX(dir),
  );
  assert.match(out, /Error: Chưa kết nối/);
  assert.doesNotMatch(out, /xoxb|ya29|Bearer/);
});

// --- Slack (mock fetch) ----------------------------------------------------

function slackMock() {
  return mockFetch((url, init) => {
    if (url.includes('/conversations.list')) {
      return { body: { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false, num_members: 3 }] } };
    }
    if (url.includes('/conversations.history')) {
      return { body: { ok: true, messages: [{ type: 'message', user: 'U1', text: 'hello channel', ts: '111.222' }] } };
    }
    if (url.includes('/chat.postMessage')) {
      return { body: { ok: true, channel: 'C1', ts: '123.456' } };
    }
    return { status: 404, body: { ok: false, error: 'not_found' } };
  });
}

test('slack tools via mock fetch: list channels, read, send; token only in header, never in output', async () => {
  const dir = makeTempWorkspace();
  const mocked = slackMock();
  try {
    const tools = createIntegrationTools({ getSlackToken: () => 'xoxb-test', fetchFn: globalThis.fetch });
    const listed = await tool(tools, 'slack_list_channels').execute({}, CTX(dir));
    assert.match(listed, /C1 — #general/);
    const read = await tool(tools, 'slack_read').execute({ channel: 'C1', limit: 5 }, CTX(dir));
    assert.match(read, /hello channel/);
    const sent = await tool(tools, 'slack_send').execute({ channel: 'C1', text: 'hi team' }, CTX(dir));
    assert.match(sent, /Sent to Slack channel C1 \(ts 123\.456\)/);
    // Token only ever travelled in the Authorization header.
    assert.equal(mocked.calls.length, 3);
    for (const call of mocked.calls) {
      assert.equal(call.init.headers.Authorization, 'Bearer xoxb-test');
    }
    assert.doesNotMatch(listed + read + sent, /xoxb-test/);
    // POST body carried the message text.
    const postCall = mocked.calls.find((c) => c.url.includes('chat.postMessage'));
    assert.equal(JSON.parse(postCall.init.body).text, 'hi team');
  } finally {
    mocked.restore();
  }
});

test('slack API error surfaces as a clear Error string (no token leak)', async () => {
  const dir = makeTempWorkspace();
  const mocked = mockFetch(() => ({ body: { ok: false, error: 'channel_not_found' } }));
  try {
    const tools = createIntegrationTools({ getSlackToken: () => 'xoxb-test', fetchFn: globalThis.fetch });
    const out = await tool(tools, 'slack_read').execute({ channel: 'C-nope' }, CTX(dir));
    assert.match(out, /Error: Slack API error.*channel_not_found/);
    assert.doesNotMatch(out, /xoxb-test/);
  } finally {
    mocked.restore();
  }
});

// --- Gmail (mock fetch) ----------------------------------------------------

function gmailMock(captured) {
  return mockFetch((url, init) => {
    if (url.includes('/messages/send')) {
      captured.raw = JSON.parse(init.body).raw;
      return { body: { id: 'sent1' } };
    }
    if (url.includes('/messages/m1?')) {
      return {
        body: {
          id: 'm1',
          threadId: 't1',
          snippet: 'Hello body',
          payload: {
            headers: [
              { name: 'Subject', value: 'Hello subject' },
              { name: 'From', value: 'boss@example.com' },
              { name: 'Date', value: 'Mon, 9 Nov 2026' },
            ],
            body: { data: Buffer.from('Hello body').toString('base64') },
          },
        },
      };
    }
    if (url.includes('/messages?')) {
      return { body: { messages: [{ id: 'm1', threadId: 't1' }] } };
    }
    return { status: 404, body: {} };
  });
}

test('email tools via mock fetch: list, read full message, send (raw RFC822 decodes)', async () => {
  const dir = makeTempWorkspace();
  const captured = {};
  const mocked = gmailMock(captured);
  try {
    const tools = createIntegrationTools({ getGmailToken: () => 'ya29-test', fetchFn: globalThis.fetch });
    const listed = await tool(tools, 'email_read').execute({}, CTX(dir));
    assert.match(listed, /m1/);
    const read = await tool(tools, 'email_read').execute({ message_id: 'm1' }, CTX(dir));
    assert.match(read, /Subject: Hello subject/);
    assert.match(read, /From: boss@example\.com/);
    assert.match(read, /Hello body/);
    const sent = await tool(tools, 'email_send').execute(
      { to: 'a@example.com', subject: 'Hi', body: 'Body text' },
      CTX(dir),
    );
    assert.match(sent, /Sent email via Gmail \(message id sent1\)/);
    const rawDecoded = decodeBase64Url(captured.raw);
    assert.match(rawDecoded, /To: a@example\.com/);
    assert.match(rawDecoded, /Subject: Hi/);
    assert.match(rawDecoded, /Body text/);
    for (const call of mocked.calls) {
      assert.equal(call.init.headers.Authorization, 'Bearer ya29-test');
    }
    assert.doesNotMatch(listed + read + sent, /ya29-test/);
  } finally {
    mocked.restore();
  }
});

test('email_read without a token: clear connect guidance, no fetch attempted', async () => {
  const dir = makeTempWorkspace();
  const mocked = mockFetch(() => ({ body: {} }));
  try {
    const tools = createIntegrationTools({ fetchFn: globalThis.fetch });
    const out = await tool(tools, 'email_read').execute({}, CTX(dir));
    assert.match(out, /Error: Chưa kết nối/);
    assert.equal(mocked.calls.length, 0);
  } finally {
    mocked.restore();
  }
});

// --- Teams (mock fetch) ----------------------------------------------------

test('teams tools via mock fetch: list teams+channels, send', async () => {
  const dir = makeTempWorkspace();
  const mocked = mockFetch((url, init) => {
    if (url.includes('/messages')) {
      return { body: { id: 'msg1' } };
    }
    if (url.includes('/me/joinedTeams')) {
      return { body: { value: [{ id: 'team1', displayName: 'Eng', description: 'Engineering' }] } };
    }
    if (url.includes('/teams/team1/channels')) {
      return { body: { value: [{ id: 'ch1', displayName: 'General' }] } };
    }
    return { status: 404, body: {} };
  });
  try {
    const tools = createIntegrationTools({ getTeamsToken: () => 'graph-test', fetchFn: globalThis.fetch });
    const listed = await tool(tools, 'teams_list_teams').execute({}, CTX(dir));
    assert.match(listed, /team1 — Eng/);
    assert.match(listed, /General \(ch1\)/);
    const sent = await tool(tools, 'teams_send').execute(
      { team_id: 'team1', channel_id: 'ch1', text: 'hello teams' },
      CTX(dir),
    );
    assert.match(sent, /Sent to Teams channel ch1 \(message id msg1\)/);
    const postCall = mocked.calls.find((c) => c.url.includes('/messages'));
    assert.equal(JSON.parse(postCall.init.body).body.content, 'hello teams');
    for (const call of mocked.calls) {
      assert.equal(call.init.headers.Authorization, 'Bearer graph-test');
    }
    assert.doesNotMatch(listed + sent, /graph-test/);
  } finally {
    mocked.restore();
  }
});

// --- iMessage draft (Linux: file) ------------------------------------------

test('imessage_draft on Linux writes a draft file and never claims it sent', async () => {
  const dir = makeTempWorkspace();
  const tools = createIntegrationTools({ platform: 'linux' });
  const out = await tool(tools, 'imessage_draft').execute(
    { to: '+84901234567', body: 'Chao ban, hen gap luc 3h' },
    CTX(dir),
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.sent, false);
  assert.equal(parsed.method, 'file');
  assert.match(parsed.note, /KHÔNG tự gửi/);
  const draftPath = path.join(dir, parsed.draftFile);
  assert.ok(fs.existsSync(draftPath));
  const content = fs.readFileSync(draftPath, 'utf8');
  assert.match(content, /To: \+84901234567/);
  assert.match(content, /Chao ban, hen gap luc 3h/);
  assert.match(content, /CHƯA GỬI/);
});

test('draftImessage core: darwin open fallback writes a file when open fails (Linux host)', () => {
  const dir = makeTempWorkspace();
  const draft = draftImessage({ to: 'a@example.com', body: 'hi', workspaceDir: dir, platform: 'darwin' });
  assert.equal(draft.sent, false);
  assert.equal(draft.method, 'file'); // no `open` binary / Messages app here
  assert.ok(draft.path && fs.existsSync(draft.path));
});

// --- Meeting: parse + summarize + import -----------------------------------

test('parseTranscript: txt, vtt and json formats', () => {
  const txt = parseTranscript('An: Xin chao moi nguoi\nBinh: Chao An, hom nay chung ta quyet dinh chon phuong an A');
  assert.equal(txt.format, 'txt');
  assert.equal(txt.segments.length, 2);
  assert.equal(txt.segments[0].speaker, 'An');

  const vtt = parseTranscript(
    'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nAn: Xin chao\n\n00:00:05.000 --> 00:00:08.000\nBinh: Chung ta can hoan thanh bao cao truoc thu Sau',
  );
  assert.equal(vtt.format, 'vtt');
  assert.equal(vtt.segments.length, 2);
  assert.equal(vtt.segments[0].start, '00:00:01.000');

  const json = parseTranscript(
    JSON.stringify([{ speaker: 'An', text: 'Quyet dinh chon A' }]),
    'notes.json',
  );
  assert.equal(json.format, 'json');
  assert.equal(json.segments[0].text, 'Quyet dinh chon A');
});

test('summarizeTranscript is rule-based: decisions and action items split out, no model call', () => {
  const summary = summarizeTranscript(
    'An: Xin chao moi nguoi, hom nay hop ve ke hoach quy 4.\n' +
      'Binh: Chung ta quyet dinh chon phuong an A cho chien dich.\n' +
      'An: Binh can hoan thanh bao cao truoc thu Sau, day la han quan trong.\n' +
      'Binh: Dong y, toi se lam bao cao va gui truoc deadline.',
  );
  assert.ok(summary.keyPoints.length >= 2);
  assert.ok(summary.decisions.some((d) => d.includes('quyet dinh')));
  assert.ok(summary.actionItems.some((a) => a.includes('can hoan thanh') || a.includes('deadline')));
  assert.equal(summary.segmentCount, 4);
});

test('meeting tools: import txt transcript + summarize stored transcript (real files)', async () => {
  const dir = makeTempWorkspace({
    'meeting.txt':
      'An: Xin chao moi nguoi, hop ve ke hoach quy 4.\n' +
      'Binh: Chung ta quyet dinh chon phuong an A.\n' +
      'An: Binh can hoan thanh bao cao truoc thu Sau.',
  });
  const tools = createIntegrationTools();
  const imported = await tool(tools, 'meeting_transcript').execute({ source: 'meeting.txt' }, CTX(dir));
  assert.match(imported, /Imported meeting transcript/);
  assert.match(imported, /quyet dinh chon phuong an A/);
  assert.match(imported, /rule-based/);
  const idMatch = /\(id ([0-9a-f-]+),/.exec(imported);
  assert.ok(idMatch, 'import output carries the transcript id');
  const summarized = await tool(tools, 'meeting_summarize').execute(
    { transcript_id: idMatch[1] },
    CTX(dir),
  );
  assert.match(summarized, /Summary of/);
  assert.match(summarized, /quyet dinh/);
  const listed = await tool(tools, 'meeting_summarize').execute({}, CTX(dir));
  assert.match(listed, new RegExp(idMatch[1]));
});

test('meeting_transcript: missing file -> clear Error, not a throw', async () => {
  const dir = makeTempWorkspace();
  const tools = createIntegrationTools();
  const out = await tool(tools, 'meeting_transcript').execute({ source: 'nope.txt' }, CTX(dir));
  assert.match(out, /^Error: Transcript file not found/);
});

// --- Session box (core + tools) --------------------------------------------

test('session box core: create/snapshot/restore round-trip, list, destroy', () => {
  const dir = makeTempWorkspace();
  const session = createSession(dir, { name: 'work', envVars: ['PATH', 'HOME'], limits: { maxFiles: 100 } });
  assert.match(session.id, /^work-/);
  assert.deepEqual(session.envAllowlist, ['HOME', 'PATH']);
  assert.equal(session.status, 'active');
  assert.ok(fs.existsSync(session.workspaceDir));

  // Secret-looking env names are rejected.
  assert.throws(() => createSession(dir, { name: 'bad', envVars: ['API_KEY'] }), /looks like a secret/);

  fs.writeFileSync(path.join(session.workspaceDir, 'notes.txt'), 'version 1', 'utf8');
  const snap = snapshotSession(dir, session.id, 'before edit');
  assert.equal(snap.files.length, 1);
  assert.equal(snap.files[0].rel, 'notes.txt');
  assert.equal(snap.files[0].size, 9);
  assert.match(snap.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(listSnapshots(dir, session.id).length, 1);

  fs.writeFileSync(path.join(session.workspaceDir, 'notes.txt'), 'version 2 — changed', 'utf8');
  const restored = restoreSession(dir, session.id);
  assert.equal(restored.status, 'restored');
  assert.equal(fs.readFileSync(path.join(session.workspaceDir, 'notes.txt'), 'utf8'), 'version 1');

  assert.equal(listSessions(dir).length, 1);
  assert.equal(listSessions(dir)[0].id, session.id);
  assert.equal(destroySession(dir, session.id), true);
  assert.equal(destroySession(dir, session.id), false);
  assert.equal(listSessions(dir).length, 0);
});

test('session box tools: create, snapshot, list, restore, destroy end to end', async () => {
  const dir = makeTempWorkspace();
  const tools = createIntegrationTools();
  const created = JSON.parse(
    await tool(tools, 'session_box_create').execute({ name: 'demo' }, CTX(dir)),
  );
  assert.match(created.id, /^demo-/);
  assert.match(created.note, /LOCAL/);
  fs.writeFileSync(path.join(created.workspaceDir, 'a.txt'), 'hello', 'utf8');
  const snapOut = JSON.parse(
    await tool(tools, 'session_box_snapshot').execute({ session_id: created.id }, CTX(dir)),
  );
  assert.equal(snapOut.files, 1);
  fs.writeFileSync(path.join(created.workspaceDir, 'a.txt'), 'changed', 'utf8');
  const restored = JSON.parse(
    await tool(tools, 'session_box_restore').execute({ session_id: created.id }, CTX(dir)),
  );
  assert.equal(restored.status, 'restored');
  assert.equal(fs.readFileSync(path.join(created.workspaceDir, 'a.txt'), 'utf8'), 'hello');
  const listed = await tool(tools, 'session_box_list').execute({}, CTX(dir));
  assert.match(listed, new RegExp(created.id));
  const destroyed = await tool(tools, 'session_box_destroy').execute({ session_id: created.id }, CTX(dir));
  assert.match(destroyed, /Deleted local session box/);
});

// --- OAuth framework -------------------------------------------------------

test('connector OAuth framework: auth URL, code exchange, refresh, registry, vault store', async () => {
  const registry = new ConnectorRegistry();
  registry.register({
    id: 'slack-test',
    label: 'Slack Test',
    authType: 'oauth2',
    scopes: ['channels:read'],
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
  });
  assert.equal(registry.size(), 1);
  assert.throws(
    () =>
      registry.register({
        id: 'slack-test',
        label: 'dup',
        authType: 'bearer',
        scopes: [],
      }),
    /already registered/,
  );
  assert.throws(
    () =>
      registry.register({
        id: 'bad-oauth',
        label: 'Bad',
        authType: 'oauth2',
        scopes: [],
        authUrl: 'https://example.com/auth',
      }),
    /needs both authUrl and tokenUrl/,
  );

  const def = registry.get('slack-test');
  const url = buildAuthorizationUrl(def, {
    clientId: 'cid123',
    redirectUri: 'http://127.0.0.1:8787/callback',
    state: 'state-abc',
    codeChallenge: 'challenge-xyz',
  });
  assert.match(url, /response_type=code/);
  assert.match(url, /client_id=cid123/);
  assert.match(url, /code_challenge=challenge-xyz/);

  const fetchFn = async (fetchUrl, init) => {
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') === 'authorization_code') {
      assert.equal(body.get('code'), 'auth-code-1');
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'xoxb-new', refresh_token: 'r1', expires_in: 3600 }),
        text: async () => '',
      };
    }
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'r1');
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'xoxb-refreshed', expires_in: 3600 }),
      text: async () => '',
    };
  };
  const exchanged = await exchangeAuthorizationCode({
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    clientId: 'cid123',
    code: 'auth-code-1',
    redirectUri: 'http://127.0.0.1:8787/callback',
    fetchFn,
  });
  assert.equal(exchanged.accessToken, 'xoxb-new');
  assert.equal(exchanged.refreshToken, 'r1');
  assert.ok(exchanged.expiresAt);

  const refreshed = await refreshAccessToken({
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    clientId: 'cid123',
    refreshToken: 'r1',
    fetchFn,
  });
  assert.equal(refreshed.accessToken, 'xoxb-refreshed');

  // Vault-backed token store (fake vault object — same shape as Vault).
  const backing = new Map();
  const fakeVault = {
    getSecret: (ns, key) => backing.get(`${ns}:${key}`) ?? null,
    setSecret: (ns, key, value) => backing.set(`${ns}:${key}`, value),
    deleteSecret: (ns, key) => backing.delete(`${ns}:${key}`),
  };
  const store = vaultTokenStore(fakeVault);
  await store.setToken('slack-test', { accessToken: 'xoxb-stored', refreshToken: 'r9' });
  assert.equal(backing.get('connector:slack-test').includes('xoxb-stored'), true);
  const loaded = await store.getToken('slack-test');
  assert.equal(loaded.accessToken, 'xoxb-stored');
  await store.clearToken('slack-test');
  assert.equal(await store.getToken('slack-test'), null);
});
