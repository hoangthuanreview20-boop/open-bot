/**
 * wiring-v07.test.mjs — wave 2 nối vào registry + coordinator con.
 *
 * 1. Registry đầy đủ (defaultToolFactory) chứa cả 37 tool mới của v0.7
 *    (8 git + 4 CI + 2 agent-data + 20 integration + 3 MCP system),
 *    cộng mcp_revoke của v0.13 (4 MCP system),
 *    không trùng tên, tổng 123 (v0.13: + mcp_revoke; v0.14: + skill_marketplace_preview/install, supervisor_dispatch).
 * 2. Coordinator con qua RPC: createBot với githubToken /
 *    connectorTokens / mcpOAuthTokens rồi chạy tool thật qua runTool:
 *    mcp_auth_status đọc được token đã seed, mcp_system_exec bị chặn
 *    bởi allowlist rỗng, slack_send báo thiếu token rõ ràng, ci_investigate
 *    báo file thiếu, session box + agent export/import chạy thật local.
 * 3. Vòng OAuth MCP đầy đủ qua tiến trình con: mock OAuth server
 *    (auth redirect + token), mcp_auth mở URL qua event 'mcp.open-url',
 *    callback localhost trong con nhận code, đổi code lấy token, lưu
 *    token và phát event 'mcp.oauth-token' về cho main (Vault).
 *
 * Run: npm run build rồi node --test tests/wiring-v07.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import {
  BotMemory,
  defaultToolFactory,
  serializeOAuthToken,
} from '../packages/core/dist/index.js';

const EXPECTED_V07_TOOLS = [
  // git (8)
  'git_host_connect',
  'pr_list',
  'pr_create',
  'pr_update',
  'pr_label_set',
  'pr_code_tour_view',
  'pr_code_tour_update',
  'set_active_branch',
  // CI (4)
  'ci_investigate',
  'bug_report',
  'bug_fix_report',
  'ai_attribution',
  // agent data (2)
  'agent_export',
  'agent_import',
  // MCP system (3)
  'mcp_auth',
  'mcp_auth_status',
  'mcp_system_exec',
];

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-wiring-'));
  tmpDirs.push(dir);
  return dir;
}

test('registry: 175 tool, đủ 37 tool v0.7, không trùng tên', () => {
  const ws = tmpWorkspace();
  const memory = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(memory, ws, 'bot-1');
    const names = tools.map((t) => t.definition.name);
    // v0.53: + 2 (tool_call_replay, computer_local_tool); v0.54: + 1 grind_pause → 134 + 3 = 137; v0.85 (P2-3): + 1 conversation_history = 138; v0.86 (P1-5): + 2 video_status, video_cancel = 140; v0.86 (P2-4): + 1 code_symbols = 141; v0.86a (P1-3): + 5 browser_* = 146; v0.86 (P2-10): + 1 shell_elevate = 147; v0.89b (Team F): + 14 (6 data + 1 http + 4 text + 3 office-write) = 161; v0.95d4 (Đội D4): + 4 memory_save/search/list/delete = 165; v0.95d1 (Đội D1): + 10 internet data (internet_search, web_fetch_clean, 4 feed_*, 4 watch_*) = 175.
    assert.equal(names.length, 175, `expected 175 tools, got ${names.length}`);
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
    for (const name of [
      'a2a_discover', 'a2a_list_agents', 'a2a_send',
      'a2a_status', 'a2a_cancel', 'a2a_list_tasks',
    ]) {
      assert.ok(names.includes(name), `missing A2A client tool: ${name}`);
    }
    for (const name of EXPECTED_V07_TOOLS) {
      assert.ok(names.includes(name), `missing v0.7 tool: ${name}`);
    }
    // v0.41 (P0-3): the 4 new tools.
    for (const name of [
      'session_box_replace_env',
      'cloud_agent_fetch_data',
      'manage_access',
      'tool_blob_fetch',
    ]) {
      assert.ok(names.includes(name), `missing v0.41 P0-3 tool: ${name}`);
    }
    // Integration tools (21) — spot-check the main ones; the count
    // above (123) already proves the whole group is present.
    for (const name of [
      'slack_send',
      'slack_list_channels',
      'slack_read',
      'email_read',
      'email_send',
      'teams_send',
      'teams_list_teams',
      'memory_remember',
      'memory_recall',
      'memory_forget',
      'imessage_draft',
      'meeting_transcript',
      'meeting_summarize',
      'session_box_create',
      'session_box_snapshot',
      'session_box_list',
      'transcript_archive',
      'team_context_summary',
    ]) {
      assert.ok(names.includes(name), `missing integration tool: ${name}`);
    }
  } finally {
    memory.close();
  }
});

let client;
test.before(async () => {
  client = new CoordinatorClient();
  await client.ping();
});
test.after(async () => {
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function botConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

test('coordinator con: tool v0.7 chạy thật qua runTool (seed token + lỗi rõ)', async () => {
  const ws = tmpWorkspace();
  const seeded = serializeOAuthToken({
    accessToken: 'seeded-access-token',
    tokenType: 'Bearer',
    obtainedAt: Date.now(),
  });
  const created = await client.createBot({
    bot: botConfig('wiring-1', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [] },
    githubToken: 'ghp_fake',
    connectorTokens: { slack: 'xoxb-fake' },
    mcpOAuthTokens: { 'seeded-server': seeded },
  });
  assert.equal(created.toolCount, 175); // v0.31: 123 + 6 A2A client tools; v0.37 (P1-4): + 1 list_subagent_roles; v0.41 (P0-3): + 4 (replace_env, cloud fetch, manage_access, blob fetch); v0.53: + 2 (tool_call_replay, computer_local_tool); v0.54: + 1 grind_pause; v0.85 (P2-3): + 1 conversation_history; v0.86 (P1-5): + 2 video_status, video_cancel; v0.86 (P2-4): + 1 code_symbols; v0.86a (P1-3): + 5 browser_*; v0.86 (P2-10): + 1 shell_elevate; v0.89b (Team F): + 14 data/http/text/office-write; v0.95d4 (Đội D4): + 4 memory_save/search/list/delete; v0.95d1 (Đội D1): + 10 internet data

  // Token đã seed tới được store trong con: mcp_auth_status báo authorized.
  let out = await client.runTool('wiring-1', 'mcp_auth_status', { server: 'seeded-server' });
  assert.match(out.output, /authorized/);
  assert.match(out.output, /Access token: stored/);
  // Server chưa từng authorize -> báo rõ, không throw.
  out = await client.runTool('wiring-1', 'mcp_auth_status', { server: 'never-authorized' });
  assert.match(out.output, /not authorized/i);

  // Allowlist hệ thống rỗng mặc định -> mcp_system_exec từ chối mọi tool.
  out = await client.runTool('wiring-1', 'mcp_system_exec', { tool: 'anything', arguments: {} });
  assert.match(out.output, /not on the allowlist/);

  // Slack có token fake nhưng không gọi mạng thật ở đây: tool cần token
  // để gọi API — với token fake, API trả lỗi HTTP (không throw, không crash).
  // Để tránh phụ thuộc mạng, chỉ kiểm tra tool báo thiếu token khi không có:
  // (bot này CÓ token slack fake nên không test được nhánh đó ở đây;
  // nhánh thiếu token đã có trong test của W6.)

  // ci_investigate với file không tồn tại -> lỗi rõ, không throw.
  out = await client.runTool('wiring-1', 'ci_investigate', {
    source: 'no-such-log.txt',
  });
  assert.match(out.output, /Error:/);

  // Session box chạy thật local: create -> list thấy 1 box.
  out = await client.runTool('wiring-1', 'session_box_create', { name: 'box-a' });
  assert.match(out.output, /box-a|created/i);
  out = await client.runTool('wiring-1', 'session_box_list', {});
  assert.match(out.output, /box-a/);

  // agent_export/import chạy thật local (bundle file + checksum).
  const bundlePath = path.join(ws, 'bot-bundle.json');
  out = await client.runTool('wiring-1', 'agent_export', {
    botId: 'wiring-1',
    outputPath: 'bot-bundle.json',
  });
  assert.ok(fs.existsSync(bundlePath), 'bundle file must exist after export');
  assert.match(out.output, /exported|bundle/i);
  out = await client.runTool('wiring-1', 'agent_import', {
    bundlePath: 'bot-bundle.json',
    newBotId: 'wiring-1-copy',
  });
  assert.match(out.output, /imported|bundle/i);
});

test('coordinator con: vòng OAuth MCP đầy đủ với mock server (open-url + oauth-token events)', async () => {
  // Mock OAuth provider: /auth redirect về callback của con với code giả,
  // /token đổi code lấy token giả.
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/auth') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      assert.ok(redirectUri, 'auth request must carry redirect_uri');
      res.writeHead(302, {
        Location: `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=fake-code-123&state=${encodeURIComponent(state)}`,
      });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.equal(params.get('code'), 'fake-code-123');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'mock-access-token',
            refresh_token: 'mock-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = mock.address().port;
  const base = `http://127.0.0.1:${port}`;

  const ws = tmpWorkspace();
  const oauthTokenEvents = [];
  const unsubscribe = client.onEvent((event) => {
    if (event.kind === 'mcp.oauth-token') oauthTokenEvents.push(event.payload);
    if (event.kind === 'mcp.open-url') {
      // Giả làm trình duyệt: GET URL xin phép, đi theo redirect về
      // callback localhost của tiến trình con.
      const payload = event.payload;
      const url = typeof payload === 'string' ? payload : payload?.url;
      if (typeof url === 'string') void fetch(url).catch(() => undefined);
    }
  });
  try {
    await client.createBot({
      bot: botConfig('wiring-oauth', ws),
      provider: { id: 'mock', label: 'Mock', mockResponses: [] },
      mcpOAuthConfigs: {
        'mock-oauth-server': {
          authorizationEndpoint: `${base}/auth`,
          tokenEndpoint: `${base}/token`,
          clientId: 'test-client',
        },
      },
    });
    const out = await client.runTool('wiring-oauth', 'mcp_auth', {
      server: 'mock-oauth-server',
      timeoutSeconds: 30,
    });
    assert.match(out.output, /authorized|success/i);
    // Token mới được phát về main qua event (để main lưu Vault).
    assert.equal(oauthTokenEvents.length, 1, 'expected one mcp.oauth-token event');
    assert.equal(oauthTokenEvents[0].server, 'mock-oauth-server');
    assert.match(oauthTokenEvents[0].value, /mock-access-token/);
    // Và đọc lại được qua mcp_auth_status trong cùng tiến trình con.
    const status = await client.runTool('wiring-oauth', 'mcp_auth_status', {
      server: 'mock-oauth-server',
    });
    assert.match(status.output, /authorized/);
    assert.match(status.output, /Refresh token stored: yes/);
  } finally {
    unsubscribe();
    await new Promise((resolve) => mock.close(resolve));
  }
});
