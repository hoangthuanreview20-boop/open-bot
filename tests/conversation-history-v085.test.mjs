/**
 * Tests cho v0.85 (P2-3) — tool mới `conversation_history`.
 *
 * Kiểu tool duy nhất trong 76 kiểu tool của Grok Bot chưa có tool
 * tương đương: lịch sử trước đây chỉ được chèn tự động vào context
 * mỗi turn; sau compaction agent không đọc lại được tin nhắn gốc của
 * các turn đã bị tóm tắt. `search_conversations` tìm qua hội thoại
 * khác và `read_agent_transcript` đọc transcript bot khác, không thay
 * thế được việc đọc lại chính hội thoại đang chạy.
 *
 * Tool đọc BotMemory của chính bot đang gọi (ctx.botId), read-only,
 * phân trang bằng limit/offset, cap như các tool đọc khác (tối đa 200
 * tin/lần, kết quả truncate ở 20.000 ký tự như read_file).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/conversation-history-v085.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { createAgentTools } from '../packages/tools/dist/agentTools.js';

const BOT_A = 'bot-a';
const BOT_B = 'bot-b';

const tmpDirs = [];
function tmpDir(prefix = 'open-bot-convhist-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
}

function ctx(botId = BOT_A) {
  return { workspaceDir: '', botId };
}

async function runHistory(tools, args, botId = BOT_A) {
  const out = await toolByName(tools, 'conversation_history').execute(args, ctx(botId));
  assert.doesNotMatch(out, /^Error:/, `tool lỗi không mong đợi: ${out}`);
  return JSON.parse(out);
}

test('conversation_history: đọc đúng lịch sử hội thoại hiện tại, phân trang', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    mem.saveMessage(BOT_A, 'user', 'tin 1: hỏi về báo cáo');
    mem.saveMessage(BOT_A, 'assistant', 'tin 2: đã viết xong phần 1');
    mem.saveMessage(BOT_A, 'user', 'tin 3: sửa lỗi phần 2');
    mem.saveMessage(BOT_A, 'assistant', 'tin 4: đã sửa xong');
    mem.saveMessage(BOT_A, 'user', 'tin 5: gửi báo cáo đi');
    // Tin của bot khác không được lẫn vào.
    mem.saveMessage(BOT_B, 'user', 'tin của bot khác');
    const tools = createAgentTools({ memory: mem });

    const all = await runHistory(tools, {});
    assert.equal(all.botId, BOT_A);
    assert.equal(all.returned, 5);
    assert.equal(all.hasMore, false);
    assert.deepEqual(
      all.messages.map((m) => m.content),
      [
        'tin 1: hỏi về báo cáo',
        'tin 2: đã viết xong phần 1',
        'tin 3: sửa lỗi phần 2',
        'tin 4: đã sửa xong',
        'tin 5: gửi báo cáo đi',
      ],
    );
    assert.deepEqual(
      all.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant', 'user'],
    );

    // Trang 1 (mặc định lấy mới nhất): 2 tin mới nhất.
    const page1 = await runHistory(tools, { limit: 2 });
    assert.deepEqual(
      page1.messages.map((m) => m.content),
      ['tin 4: đã sửa xong', 'tin 5: gửi báo cáo đi'],
    );
    assert.equal(page1.hasMore, true);
    // Trang 2: bỏ qua 2 tin mới nhất.
    const page2 = await runHistory(tools, { limit: 2, offset: 2 });
    assert.deepEqual(
      page2.messages.map((m) => m.content),
      ['tin 2: đã viết xong phần 1', 'tin 3: sửa lỗi phần 2'],
    );
    assert.equal(page2.hasMore, true);
    // Trang cuối: chỉ còn tin cũ nhất.
    const page3 = await runHistory(tools, { limit: 2, offset: 4 });
    assert.deepEqual(
      page3.messages.map((m) => m.content),
      ['tin 1: hỏi về báo cáo'],
    );
    assert.equal(page3.hasMore, false);
  } finally {
    mem.close();
  }
});

test('conversation_history: sau compaction vẫn đọc được tin gốc (mock memory đã tóm tắt)', async () => {
  // Mô phỏng trạng thái sau compaction: run context chỉ còn bản tóm
  // tắt, nhưng BotMemory vẫn giữ tin gốc — tool phải trả tin gốc,
  // không trả bản tóm tắt.
  const seenBotIds = [];
  const stubMemory = {
    summary: 'TÓM TẮT: user hỏi về báo cáo, assistant đã viết xong.',
    getHistory(botId, limit) {
      seenBotIds.push([botId, limit]);
      return [
        { role: 'user', content: 'tin gốc 1: hỏi về báo cáo Q3, cần số liệu doanh thu' },
        { role: 'assistant', content: 'tin gốc 2: doanh thu Q3 là 1.2 tỷ, đã viết xong phần 1' },
      ];
    },
  };
  const tools = createAgentTools({ memory: stubMemory });
  const out = await runHistory(tools, {});
  assert.deepEqual(seenBotIds, [[BOT_A, 51]], 'chỉ đọc history của chính bot đang gọi');
  assert.equal(out.messages.length, 2);
  assert.match(out.messages[0].content, /tin gốc 1/);
  assert.match(out.messages[1].content, /1\.2 tỷ/);
  assert.doesNotMatch(JSON.stringify(out), /TÓM TẮT/);
});

test('conversation_history: read-only — không ghi gì vào memory', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    mem.saveMessage(BOT_A, 'user', 'tin gốc');
    mem.saveMessage(BOT_A, 'assistant', 'trả lời gốc');
    const before = mem.getHistory(BOT_A).length;
    const tools = createAgentTools({ memory: mem });
    const tool = toolByName(tools, 'conversation_history');
    assert.equal(tool.needsApproval, false, 'tool chỉ-đọc không cần approval');
    await runHistory(tools, {});
    await runHistory(tools, { limit: 1, offset: 1 });
    assert.equal(mem.getHistory(BOT_A).length, before, 'history không đổi sau khi đọc');
    assert.deepEqual(
      mem.getHistory(BOT_A).map((m) => m.content),
      ['tin gốc', 'trả lời gốc'],
    );
  } finally {
    mem.close();
  }
  // Stub chặn mọi thao tác ghi: tool vẫn chạy được (không gọi ghi).
  const writeBlocked = {
    getHistory: () => [{ role: 'user', content: 'x' }],
    saveMessage: () => {
      throw new Error('không được ghi');
    },
    saveMemory: () => {
      throw new Error('không được ghi');
    },
  };
  const tools2 = createAgentTools({ memory: writeBlocked });
  const out = await runHistory(tools2, {});
  assert.equal(out.returned, 1);
});

test('conversation_history: cap 200 tin + truncate 20.000 ký tự như tool đọc khác', async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `tin ${i + 1}`,
  }));
  const stubMany = { getHistory: () => many };
  const toolsMany = createAgentTools({ memory: stubMany });
  // limit 500 bị kẹp về 200.
  const capped = await runHistory(toolsMany, { limit: 500 });
  assert.equal(capped.returned, 200);
  assert.equal(capped.messages.length, 200);

  const huge = {
    getHistory: () => [{ role: 'user', content: 'x'.repeat(30_000) }],
  };
  const toolsHuge = createAgentTools({ memory: huge });
  const raw = await toolByName(toolsHuge, 'conversation_history').execute({}, ctx());
  assert.ok(raw.length < 21_000, `kết quả phải truncate, dài ${raw.length}`);
  assert.match(raw, /\[\.\.\. truncated to 20000 chars \.\.\.\]/);
});

test('conversation_history: không có BotMemory thì lỗi rõ', async () => {
  const tools = createAgentTools({});
  const out = await toolByName(tools, 'conversation_history').execute({}, ctx());
  assert.match(out, /^Error:/);
  assert.match(out, /chưa có BotMemory/);
});

test('conversation_history: có trong registry đầy đủ (187 tool)', () => {
  const ws = tmpDir('open-bot-convhist-ws-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, BOT_A);
    const names = tools.map((t) => t.definition.name);
    assert.equal(names.length, 187, `expected 187 tools, got ${names.length}`); // v0.86 (P2-10): + 1 shell_elevate; v0.89b (Team F): + 14 data/http/text/office-write; v0.95d4 (Đội D4): + 4 memory_save/search/list/delete; v0.95d1 (Đội D1): + 10 internet data; v0.96 (Đội T1): + 10 memory_block_* + 1 memory_consolidate; v0.96 (Đội T2): + 2 repo_map/repo_map_query
    assert.ok(names.includes('conversation_history'));
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  } finally {
    mem.close();
  }
});
