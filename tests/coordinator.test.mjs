/**
 * coordinator.test.mjs — node-agent-coordinator thật qua NDJSON-RPC.
 *
 * Spawn coordinator con thật, createBot với provider "mock" (không gọi
 * mạng, không API key thật), run chat qua RPC, kiểm tra event
 * notification, 2 bot song song với 2 BotMemory riêng, stopBot /
 * destroyBot, và coordinator vẫn sống sau khi run lỗi.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/coordinator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-coord-'));
  tmpDirs.push(dir);
  return dir;
}

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

function mockProvider(text, extra = {}) {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text, ...extra }] };
}

let client;
test.before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

test.after(async () => {
  await client.dispose();
  // dispose() lần 2 phải an toàn (idempotent).
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createBot + run: mock provider trả đúng text qua RPC, có event delta', async () => {
  const ws = tmpWorkspace();
  const created = await client.createBot({
    bot: botConfig('bot-1', ws),
    provider: mockProvider('Xin chào từ mock!'),
  });
  assert.equal(created.botId, 'bot-1');
  // Registry đầy đủ như main: 82 (tới v0.6) + 37 v0.7 (8 git + 4 CI +
  // 2 agent-data + 20 integration + 4 MCP system + 2 marketplace + 1 supervisor) = 123 (v0.13: + mcp_revoke; v0.14: + 3; v0.31: + 6 A2A client) = 129; v0.37 (P1-4): + 1 list_subagent_roles = 130; v0.41 (P0-3): + 1 session_box_replace_env + 1 cloud_agent_fetch_data + 1 manage_access + 1 tool_blob_fetch = 134; v0.53 (P1-7): + 1 tool_call_replay + 1 computer_local_tool = 136; v0.54 (P1-8): + 1 grind_pause = 137; v0.85 (P2-3): + 1 conversation_history = 138; v0.86 (P2-4): + 1 code_symbols = 139; v0.86b (P1-5): + 2 video_status + video_cancel = 141; v0.86a (P1-3): + 5 browser_* = 146; v0.86 (P2-10): + 1 shell_elevate = 147; v0.89b (Team F): + 14 data/http/text/office-write = 161; v0.95d4 (Đội D4): + 4 memory_save/search/list/delete = 165; v0.95d1 (Đội D1): + 10 internet data = 175; v0.96 (Đội T1): + 10 memory_block_* + 1 memory_consolidate = 186; v0.96 (Đội T2): + 2 repo_map/repo_map_query = 187.
  assert.equal(created.toolCount, 187, `expected 187 tools, got ${created.toolCount}`);
  assert.ok(created.toolNames.includes('read_file'));
  assert.ok(created.toolNames.includes('plan_create'));
  assert.ok(created.toolNames.includes('delegate_task'));
  assert.ok(created.toolNames.includes('mcp_list_tools'));
  assert.ok(created.toolNames.includes('a2a_send'));
  // v0.53 (P1-7): replay + local bridge phải có trong registry đầy đủ.
  assert.ok(created.toolNames.includes('tool_call_replay'));
  assert.ok(created.toolNames.includes('computer_local_tool'));
  assert.ok(created.toolNames.includes('a2a_discover'));
  // Mỗi bot sở hữu BotMemory (SQLite) riêng tại workspace của nó.
  assert.ok(fs.existsSync(path.join(ws, '.open-bot', 'memory.db')));

  const events = [];
  const result = await client.run('bot-1', 'chào bạn', (e) => events.push(e));
  assert.equal(result.botId, 'bot-1');
  assert.equal(result.text, 'Xin chào từ mock!');
  assert.equal(result.stopped, false);
  const deltas = events.filter((e) => e.kind === 'delta');
  assert.equal(deltas.length, 1, 'phải nhận đúng 1 event delta');
  assert.equal(deltas[0].payload, 'Xin chào từ mock!');
  assert.equal(deltas[0].botId, 'bot-1');

  const listed = await client.listBots();
  assert.deepEqual(listed.botIds, ['bot-1']);
});

test('2 bot song song: 2 BotMemory riêng, không tranh chấp, kết quả đúng từng bot', async () => {
  const wsA = tmpWorkspace();
  const wsB = tmpWorkspace();
  await client.createBot({ bot: botConfig('bot-a', wsA), provider: mockProvider('trả lời A') });
  await client.createBot({ bot: botConfig('bot-b', wsB), provider: mockProvider('trả lời B') });

  const [ra, rb] = await Promise.all([
    client.run('bot-a', 'hỏi A'),
    client.run('bot-b', 'hỏi B'),
  ]);
  assert.equal(ra.text, 'trả lời A');
  assert.equal(rb.text, 'trả lời B');

  const listed = await client.listBots();
  assert.deepEqual(new Set(listed.botIds), new Set(['bot-1', 'bot-a', 'bot-b']));
  assert.ok(fs.existsSync(path.join(wsA, '.open-bot', 'memory.db')));
  assert.ok(fs.existsSync(path.join(wsB, '.open-bot', 'memory.db')));

  const destroyed = await client.destroyBot('bot-a');
  assert.equal(destroyed.destroyed, true);
  const after = await client.listBots();
  assert.ok(!after.botIds.includes('bot-a'));
  await assert.rejects(client.run('bot-a', 'hỏi lại'), /Chưa tạo bot "bot-a"/);
});

test('stopBot: báo stopped=true khi run đang chạy; coordinator vẫn sống', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-slow', ws),
    provider: mockProvider('trả lời chậm', { delayMs: 1500 }),
  });
  const runPromise = client.run('bot-slow', 'câu hỏi chậm');
  // Đợi run bắt đầu rồi mới stop.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stopped = await client.stopBot('bot-slow');
  assert.equal(stopped.botId, 'bot-slow');
  assert.equal(stopped.stopped, true);
  // Run vẫn resolve (provider mock xong sau delay); stopped được đánh dấu.
  const result = await runPromise;
  assert.equal(result.text, 'trả lời chậm');
  assert.equal(result.stopped, true);
  // Hết run rồi thì stopBot báo không có run đang chạy.
  const again = await client.stopBot('bot-slow');
  assert.equal(again.stopped, false);
  assert.match(again.reason ?? '', /không có run đang chạy/);
  await client.destroyBot('bot-slow');
});

test('v0.60 P0 Stop race: stopBot TRƯỚC run() — run sau đó phải dừng ngay, không chạy', async () => {
  // Hồi quy cho lỗi smoke UI-2: renderer hiện nút Stop ngay khi đặt
  // status=thinking, còn chat:send vẫn chờ vòng saveMessage rồi mới
  // dispatch run — click Stop nhanh có thể tới coordinator TRƯỚC run.
  // Trước bản sửa, stop này bị mất (stopped:false, không ghi nhớ) và
  // run chạy trọn (bài văn 800 từ vượt quá 60s chờ của smoke test).
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-race', ws),
    provider: mockProvider('CÂU TRẢ LỜI ĐẦY ĐỦ (stop đã mất)', { delayMs: 5000 }),
  });
  // Stop tới trước — chưa có run nào: vẫn báo stopped:false như cũ
  // (hợp đồng trả về không đổi), nhưng stop phải được ghi nhớ.
  const stopped = await client.stopBot('bot-race');
  assert.equal(stopped.stopped, false);
  assert.match(stopped.reason ?? '', /không có run đang chạy/);
  // Run tới sau phải dừng ngay (nhanh hơn nhiều so với delay 5s của
  // provider) và báo stopped:true, không trả text của provider.
  const t0 = Date.now();
  const result = await client.run('bot-race', 'câu hỏi tới sau stop');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `run phải dừng ngay sau stop (<2s), thực tế ${elapsed}ms`);
  assert.equal(result.stopped, true, 'run tới sau stop phải báo stopped:true');
  assert.match(result.text ?? '', /Đã dừng/, 'run dừng phải trả text dừng, không phải text provider');
  await client.destroyBot('bot-race');
});

test('v0.60 P0 Stop race: cờ stop chỉ dùng một lần — run kế tiếp chạy bình thường', async () => {
  // Cờ pending-stop bị tiêu thụ ngay ở run đầu tiên bắt đầu sau stop:
  // run kế tiếp không còn bị ảnh hưởng. (Cửa sổ 30s chống stop cũ thì
  // không test ở đây vì chờ 30s quá lâu cho unit test — logic cửa sổ
  // nằm cùng 3 dòng với tiêu thụ cờ, đọc code để kiểm chứng.)
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-stale', ws),
    provider: mockProvider('trả lời bình thường'),
  });
  const r1 = await client.run('bot-stale', 'chào lần 1');
  assert.equal(r1.stopped, false);
  assert.equal(r1.text, 'trả lời bình thường');
  // Stop lúc idle, rồi chạy run khác ngay: run này NẰM trong cửa sổ
  // nên bị dừng (đúng hành vi race) — nhưng run KẾ TIẾP phải chạy
  // bình thường vì cờ đã bị tiêu thụ.
  const stopped = await client.stopBot('bot-stale');
  assert.equal(stopped.stopped, false);
  const r2 = await client.run('bot-stale', 'chào lần 2');
  assert.equal(r2.stopped, true, 'run ngay sau stop phải dừng');
  const r3 = await client.run('bot-stale', 'chào lần 3');
  assert.equal(r3.stopped, false, 'cờ stop đã tiêu thụ — run tiếp theo chạy bình thường');
  assert.equal(r3.text, 'trả lời bình thường');
  await client.destroyBot('bot-stale');
});

test('coordinator sống sau run lỗi: bot chưa tạo, rồi tạo bot mới vẫn chạy được', async () => {
  await assert.rejects(client.run('bot-chua-co', 'hello'), /Chưa tạo bot "bot-chua-co"/);
  await assert.rejects(client.destroyBot('bot-chua-co'), /Chưa tạo bot "bot-chua-co"/);
  await assert.rejects(client.stopBot('bot-chua-co'), /Chưa tạo bot "bot-chua-co"/);
  // Coordinator vẫn trả ping sau loạt lỗi.
  assert.equal((await client.ping()).pong, true);

  // Provider id lạ cũng chỉ lỗi ở createBot, không giết coordinator.
  const ws = tmpWorkspace();
  await assert.rejects(
    client.createBot({
      bot: botConfig('bot-bad-provider', ws),
      provider: { id: 'khong-co-provider-nay', label: 'Bad', defaultModel: 'x' },
    }),
    /Không rõ provider id/,
  );
  assert.equal((await client.ping()).pong, true);

  // Tạo bot hợp lệ sau lỗi vẫn chạy bình thường.
  await client.createBot({
    bot: botConfig('bot-after-error', ws),
    provider: mockProvider('vẫn sống sau lỗi'),
  });
  const result = await client.run('bot-after-error', 'hello');
  assert.equal(result.text, 'vẫn sống sau lỗi');
  await client.destroyBot('bot-after-error');
});

test('createBot trùng botId: cùng cấu hình thì re-attach, khác cấu hình thì bị từ chối', async () => {
  const ws = tmpWorkspace();
  const first = await client.createBot({ bot: botConfig('bot-dup', ws), provider: mockProvider('một') });
  // v0.55: cùng bot id + cùng provider/model/workspace → re-attach
  // (main gọi createBot 2 lần lúc khởi động không còn ném lỗi); lần
  // tạo đầu thắng — bot vẫn chạy bằng provider mock 'một', không phải
  // 'hai' của lần gọi lại.
  const second = await client.createBot({ bot: botConfig('bot-dup', ws), provider: mockProvider('hai') });
  assert.equal(second.botId, 'bot-dup');
  assert.equal(second.toolCount, first.toolCount);
  assert.deepEqual(second.toolNames, first.toolNames);
  assert.deepEqual((await client.listBots()).botIds.filter((id) => id === 'bot-dup'), ['bot-dup']);
  const res = await client.run('bot-dup', 'hello');
  assert.equal(res.text, 'một');
  // Cùng id nhưng model khác → vẫn bị từ chối rõ ràng (đổi cấu hình
  // phải destroyBot trước).
  await assert.rejects(
    client.createBot({
      bot: { ...botConfig('bot-dup', ws), model: 'khac' },
      provider: mockProvider('hai'),
    }),
    /đã tồn tại với cấu hình khác/,
  );
  await client.destroyBot('bot-dup');
});

test('approval round-trip: tool cần duyệt chờ respondApproval rồi mới chạy', async () => {
  const ws = tmpWorkspace();
  const bot = { ...botConfig('bot-approve', ws), autoApprove: false };
  await client.createBot({
    bot,
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [
        {
          toolCalls: [
            { id: 'c1', name: 'write_file', args: { path: 'approved.txt', content: 'da duyet' } },
          ],
        },
        { text: 'đã ghi file' },
      ],
    },
  });
  let approvalSeen = null;
  const unsubscribe = client.onEvent(async (e) => {
    if (e.botId === 'bot-approve' && e.kind === 'approval-needed') {
      approvalSeen = e.payload;
      // Trả lời qua RPC — child đang chờ ở onApprovalNeeded.
      await client.respondApproval(e.payload.callId, true);
    }
  });
  try {
    const result = await client.run('bot-approve', 'hãy ghi file');
    assert.equal(result.text, 'đã ghi file');
    assert.ok(approvalSeen, 'phải nhận notification approval-needed');
    assert.equal(approvalSeen.callId, 'c1');
    assert.equal(approvalSeen.call.name, 'write_file');
    const written = fs.readFileSync(path.join(ws, 'approved.txt'), 'utf8');
    assert.equal(written, 'da duyet');
  } finally {
    unsubscribe();
    await client.destroyBot('bot-approve');
  }
});

test('approval bị từ chối: respondApproval(false) thì tool không chạy', async () => {
  const ws = tmpWorkspace();
  const bot = { ...botConfig('bot-deny', ws), autoApprove: false };
  await client.createBot({
    bot,
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [
        {
          toolCalls: [
            { id: 'c9', name: 'write_file', args: { path: 'denied.txt', content: 'khong duoc' } },
          ],
        },
        { text: 'đã từ chối' },
      ],
    },
  });
  const unsubscribe = client.onEvent(async (e) => {
    if (e.botId === 'bot-deny' && e.kind === 'approval-needed') {
      await client.respondApproval(e.payload.callId, false);
    }
  });
  try {
    const result = await client.run('bot-deny', 'hãy ghi file');
    // Runner dừng cả lượt ngay khi bị từ chối (loop.ts: "Approval denied
    // stops the whole turn immediately") — trả 'đã hủy', không gọi provider nữa.
    assert.equal(result.text, 'đã hủy');
    assert.ok(!fs.existsSync(path.join(ws, 'denied.txt')), 'tool bị từ chối thì không được chạy');
  } finally {
    unsubscribe();
    await client.destroyBot('bot-deny');
  }
});

test('ask-user round-trip: hỏi qua notification, trả lời qua respondAskUser', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-ask', ws),
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [
        {
          toolCalls: [
            { id: 'c2', name: 'ask_user', args: { question: 'Màu yêu thích của bạn là gì?' } },
          ],
        },
        { text: 'ghi nhận câu trả lời' },
      ],
    },
  });
  let questionSeen = null;
  let answeredWith = null;
  const unsubscribe = client.onEvent(async (e) => {
    if (e.botId === 'bot-ask' && e.kind === 'ask-user') {
      questionSeen = e.payload;
      answeredWith = 'xanh';
      await client.respondAskUser(e.payload.requestId, 'xanh');
    }
  });
  try {
    const result = await client.run('bot-ask', 'hỏi tôi đi');
    assert.equal(result.text, 'ghi nhận câu trả lời');
    assert.ok(questionSeen, 'phải nhận notification ask-user');
    assert.equal(questionSeen.question, 'Màu yêu thích của bạn là gì?');
    assert.equal(typeof questionSeen.requestId, 'string');
    assert.equal(answeredWith, 'xanh');
  } finally {
    unsubscribe();
    await client.destroyBot('bot-ask');
  }
});

test('saveMessage/getHistory/listTasks qua RPC; plugin tools qua pluginsDir', async () => {
  const ws = tmpWorkspace();
  await client.createBot({ bot: botConfig('bot-h', ws), provider: mockProvider('ok') });
  const saved = await client.saveMessage('bot-h', 'user', 'xin chào');
  assert.equal(typeof saved.id, 'string');
  await client.saveMessage('bot-h', 'assistant', 'chào bạn');
  const history = await client.getHistory('bot-h', 50);
  assert.deepEqual(history.messages, [
    { role: 'user', content: 'xin chào' },
    { role: 'assistant', content: 'chào bạn' },
  ]);
  const tasks = await client.listTasks('bot-h');
  assert.deepEqual(tasks.tasks, []);
  await client.destroyBot('bot-h');

  // Plugin tools: copy fixture, khai đủ quyền shell, createBot với pluginsDir.
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'sample-plugin');
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-coord-plugins-'));
  tmpDirs.push(pluginsDir);
  const pluginDir = path.join(pluginsDir, 'sample-plugin');
  fs.cpSync(fixture, pluginDir, { recursive: true });
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.permissions = ['fs', 'shell'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const ws2 = tmpWorkspace();
  const created = await client.createBot({
    bot: botConfig('bot-plugin', ws2),
    provider: mockProvider('ok'),
    pluginsDir,
  });
  assert.equal(created.toolCount, 189, `expected 187 + 2 plugin tools, got ${created.toolCount}`);
  assert.ok(created.toolNames.includes('sample_echo'));
  assert.ok(created.toolNames.includes('sample_shell'));
  await client.destroyBot('bot-plugin');
});

test('daemon lazy: chưa dùng shell thì daemon chưa chạy; dùng shell thì daemon chạy', async () => {
  const ws = tmpWorkspace();
  await client.createBot({ bot: botConfig('bot-lazy', ws), provider: mockProvider('ok') });
  const before = await client.daemonStatus();
  assert.equal(before.running, false, 'daemon phải lazy — chưa chạy trước khi dùng shell');
  await client.destroyBot('bot-lazy');
});

test('shell_exec runs in the exec daemon (coordinator owns the daemon)', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-shell', ws),
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [
        {
          toolCalls: [
            { id: 's1', name: 'shell_exec', args: { command: 'echo hello-from-daemon' } },
          ],
        },
        { text: 'xong shell' },
      ],
    },
  });
  const events = [];
  const result = await client.run('bot-shell', 'chạy lệnh echo', (e) => events.push(e));
  assert.equal(result.text, 'xong shell');
  const toolResults = events.filter((e) => e.kind === 'toolresult');
  assert.ok(
    toolResults.some((e) => String(e.payload.output).includes('hello-from-daemon')),
    'shell output phải về qua toolresult',
  );
  assert.ok(
    toolResults.some((e) => String(e.payload.output).includes('exit code: 0')),
    'shell output phải có exit code 0',
  );
  const status = await client.daemonStatus();
  assert.equal(status.running, true, 'daemon phải đang chạy sau khi dùng shell');
  assert.equal(typeof status.pid, 'number');
  await client.destroyBot('bot-shell');
});
