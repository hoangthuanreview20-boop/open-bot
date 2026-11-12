/**
 * Tests cho v0.59 (UI-3) — màn Tools riêng theo bot.
 *
 * Core (coordinator RPC `listBotTools` / `setBotToolEnabled`):
 *   1. listBotTools: đủ tool (~146/bot), đủ nhóm (file/shell/web/plan/
 *      agent/mcp...), group + readOnly đúng, tokenEstimate > 0 cho mọi
 *      tool, tổng token khớp cộng dồn, cappedByApp có mặt.
 *   2. setBotToolEnabled: tắt/bật một tool — enabledTokens đổi đúng
 *      bằng tokenEstimate của tool đó; bật lại khôi phục.
 *   3. Persist qua BotConfig: tạo bot với denyTools sẵn thì list hiện
 *      tắt ngay (đường main persist `BotConfig.denyTools` rồi
 *      `createBot` đăng ký vào policy — xem coordinator.ts).
 *   4. Filter trong turn thật: tool đã tắt không tới được model —
 *      mock ghi lại request (`mockRecordPath`); dispatcher `file`
 *      sau khi tắt `write_file` không còn liệt kê nó, tool khác
 *      trong nhóm vẫn còn.
 *   5. Lỗi rõ ràng: bot lạ / tool lạ → reject, không đổi gì.
 *   6. filterToolList (toolFilter.ts — luật tìm kiếm/lọc nhóm mà màn
 *      Tools dùng): query nhiều từ (AND, không phân biệt hoa-thường),
 *      lọc nhóm, chỉ tool đang bật.
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/tools-ui3-v059.test.mjs
 *
 * Không mạng thật, không key thật, không tài khoản thật.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCoordinator } from '../packages/core/dist/index.js';
import { filterToolList } from '../packages/core/dist/agent/toolFilter.js';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function botConfig(id, workspaceDir, extra = {}) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
    ...extra,
  };
}

function mockProviderConfig(recordPath) {
  return {
    id: 'mock',
    label: 'Mock',
    defaultModel: 'mock',
    mockResponses: [{ text: 'xong' }],
    ...(recordPath ? { mockRecordPath: recordPath } : {}),
  };
}

async function makeBot(extraBot = {}, recordPath) {
  const ws = tmpDir('open-bot-tools-ui3-ws-');
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-tools-ui3-data-') });
  await coord.createBot({
    bot: botConfig('bot-1', ws, extraBot),
    provider: mockProviderConfig(recordPath),
  });
  return { coord, ws };
}

function byName(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} phải có trong danh sách`);
  return tool;
}

test('listBotTools: đủ tool, đủ nhóm, group/readOnly/token đúng', async () => {
  const { coord } = await makeBot();
  try {
    // Qua RPC handle (đường main → CoordinatorClient đi) chứ không
    // chỉ gọi method trực tiếp.
    const result = await coord.handle('listBotTools', { botId: 'bot-1' });
    assert.equal(result.botId, 'bot-1');
    assert.ok(result.totalTools >= 100, `cần >= 100 tool, có ${result.totalTools}`);
    assert.equal(result.tools.length, result.totalTools);
    assert.equal(result.enabledTools, result.totalTools, 'mặc định bật hết');
    assert.equal(result.enabledTokens, result.totalTokens);

    const groups = new Set(result.tools.map((t) => t.group));
    for (const g of ['file', 'shell', 'web', 'plan', 'agent', 'mcp']) {
      assert.ok(groups.has(g), `thiếu nhóm ${g} (có: ${[...groups].sort().join(', ')})`);
    }

    assert.equal(byName(result.tools, 'read_file').group, 'file');
    assert.equal(byName(result.tools, 'read_file').readOnly, true);
    assert.equal(byName(result.tools, 'write_file').group, 'file');
    assert.equal(byName(result.tools, 'write_file').readOnly, false);
    assert.equal(byName(result.tools, 'web_search').group, 'web');
    assert.equal(byName(result.tools, 'plan_create').group, 'plan');
    assert.equal(byName(result.tools, 'mcp_list_tools').group, 'mcp');

    let sum = 0;
    for (const tool of result.tools) {
      assert.ok(Number.isInteger(tool.tokenEstimate) && tool.tokenEstimate >= 1,
        `${tool.name}: tokenEstimate phải là số nguyên >= 1`);
      assert.ok(['core', 'composio', 'plugin'].includes(tool.source), `${tool.name}: source lạ`);
      assert.equal(typeof tool.enabled, 'boolean');
      assert.equal(typeof tool.cappedByApp, 'boolean');
      assert.equal(typeof tool.needsApproval, 'boolean');
      assert.ok(tool.description.length > 0, `${tool.name}: phải có mô tả`);
      assert.ok(tool.parameters && typeof tool.parameters.properties === 'object');
      assert.ok(Array.isArray(tool.parameters.required));
      sum += tool.tokenEstimate;
    }
    assert.equal(result.totalTokens, sum, 'totalTokens phải bằng tổng tokenEstimate');
    // Không app nào nối nên chưa tool nào bị cap (M7 cap đã có test
    // riêng — ở đây chỉ kiểm chứng field được nối đúng).
    assert.ok(result.tools.every((t) => t.cappedByApp === false));
    // Schema gọn: read_file có tham số path.
    assert.ok('path' in byName(result.tools, 'read_file').parameters.properties);
  } finally {
    coord.shutdown();
  }
});

test('setBotToolEnabled: tắt/bật đổi enabledTokens đúng token của tool', async () => {
  const { coord } = await makeBot();
  try {
    const before = await coord.listBotTools({ botId: 'bot-1' });
    const writeFile = byName(before.tools, 'write_file');

    const off = await coord.handle('setBotToolEnabled', {
      botId: 'bot-1',
      toolName: 'write_file',
      enabled: false,
    });
    assert.equal(off.enabled, false);
    assert.ok(off.denyTools.includes('write_file'));

    const afterOff = await coord.listBotTools({ botId: 'bot-1' });
    assert.equal(byName(afterOff.tools, 'write_file').enabled, false);
    assert.equal(afterOff.enabledTools, before.enabledTools - 1);
    assert.equal(
      afterOff.enabledTokens,
      before.enabledTokens - writeFile.tokenEstimate,
      'tắt tool phải trừ đúng tokenEstimate của nó khỏi enabledTokens',
    );
    assert.equal(afterOff.totalTokens, before.totalTokens, 'tổng token không đổi khi tắt');
    // Tool khác không bị ảnh hưởng.
    assert.equal(byName(afterOff.tools, 'read_file').enabled, true);

    const on = await coord.setBotToolEnabled({ botId: 'bot-1', toolName: 'write_file', enabled: true });
    assert.equal(on.enabled, true);
    assert.ok(!on.denyTools.includes('write_file'));
    const afterOn = await coord.listBotTools({ botId: 'bot-1' });
    assert.equal(afterOn.enabledTools, before.enabledTools);
    assert.equal(afterOn.enabledTokens, before.enabledTokens);
  } finally {
    coord.shutdown();
  }
});

test('denyTools từ BotConfig: tạo bot đã tắt sẵn thì list hiện tắt (persist path)', async () => {
  const { coord } = await makeBot({ denyTools: ['read_file', 'web_search'] });
  try {
    const result = await coord.listBotTools({ botId: 'bot-1' });
    assert.equal(byName(result.tools, 'read_file').enabled, false);
    assert.equal(byName(result.tools, 'web_search').enabled, false);
    assert.equal(byName(result.tools, 'write_file').enabled, true);
    assert.equal(result.enabledTools, result.totalTools - 2);
    // Bật lại qua RPC thì policy live đổi theo.
    await coord.setBotToolEnabled({ botId: 'bot-1', toolName: 'read_file', enabled: true });
    const after = await coord.listBotTools({ botId: 'bot-1' });
    assert.equal(byName(after.tools, 'read_file').enabled, true);
    assert.equal(byName(after.tools, 'web_search').enabled, false);
  } finally {
    coord.shutdown();
  }
});

test('filter trong turn thật: tool đã tắt không tới được model', async () => {
  const recordPath = path.join(tmpDir('open-bot-tools-ui3-rec-'), 'requests.jsonl');
  const { coord } = await makeBot({}, recordPath);
  try {
    await coord.run({ botId: 'bot-1', text: 'hello' });
    let lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'một provider call cho turn đầu');
    let defs = JSON.parse(lines[0]).tools;
    let fileGroup = defs.find((d) => d.name === 'file');
    assert.ok(fileGroup, 'nhóm file phải được gửi cho model ở turn đầu');
    assert.match(fileGroup.description, /write_file/, 'turn đầu còn write_file');

    await coord.handle('setBotToolEnabled', {
      botId: 'bot-1',
      toolName: 'write_file',
      enabled: false,
    });
    await coord.run({ botId: 'bot-1', text: 'hello lần nữa' });
    lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'turn thứ hai ghi thêm một request');
    defs = JSON.parse(lines[1]).tools;
    const names = defs.map((d) => d.name);
    assert.ok(!names.includes('write_file'), 'tool đã tắt không được gửi riêng');
    assert.ok(
      !defs.some((d) => (d.description ?? '').includes('write_file')),
      'tool đã tắt không được rò vào mô tả dispatcher nhóm',
    );
    fileGroup = defs.find((d) => d.name === 'file');
    assert.ok(fileGroup, 'nhóm file vẫn còn sau khi tắt một thành viên');
    assert.match(fileGroup.description, /read_file/, 'thành viên còn bật vẫn được gửi');
  } finally {
    coord.shutdown();
  }
});

test('listBotTools / setBotToolEnabled: bot lạ / tool lạ thì lỗi rõ ràng', async () => {
  const { coord } = await makeBot();
  try {
    await assert.rejects(
      coord.listBotTools({ botId: 'bot-khong-co' }),
      /Chưa tạo bot/,
    );
    await assert.rejects(
      async () => coord.setBotToolEnabled({ botId: 'bot-1', toolName: 'tool_khong_co', enabled: false }),
      /không có tool/,
    );
    await assert.rejects(
      coord.handle('setBotToolEnabled', { botId: 'bot-1', toolName: 'write_file', enabled: 'yes' }),
      /cần params/,
    );
    // Lỗi không làm đổi trạng thái tool thật.
    const after = await coord.listBotTools({ botId: 'bot-1' });
    assert.equal(byName(after.tools, 'write_file').enabled, true);
  } finally {
    coord.shutdown();
  }
});

test('filterToolList: tìm kiếm nhiều từ + lọc nhóm + chỉ tool bật', async () => {
  const { coord } = await makeBot();
  try {
    const { tools } = await coord.listBotTools({ botId: 'bot-1' });
    assert.ok(tools.length >= 100);

    const byQuery = filterToolList(tools, { query: 'read file' });
    assert.ok(byQuery.some((t) => t.name === 'read_file'));
    assert.ok(byQuery.every((t) => `${t.name} ${t.description} ${t.group}`.toLowerCase().includes('read')));
    assert.ok(byQuery.every((t) => `${t.name} ${t.description} ${t.group}`.toLowerCase().includes('file')));

    const upper = filterToolList(tools, { query: 'READ_FILE' });
    assert.ok(upper.some((t) => t.name === 'read_file'), 'tìm kiếm không phân biệt hoa-thường');

    const noMatch = filterToolList(tools, { query: 'file web_search_khong_co' });
    assert.equal(noMatch.length, 0, 'nhiều từ là AND — thiếu một từ thì không khớp');

    const fileOnly = filterToolList(tools, { group: 'file' });
    assert.ok(fileOnly.length > 1);
    assert.ok(fileOnly.every((t) => t.group === 'file'));
    assert.ok(fileOnly.length < tools.length);

    await coord.setBotToolEnabled({ botId: 'bot-1', toolName: 'write_file', enabled: false });
    const { tools: toolsAfter } = await coord.listBotTools({ botId: 'bot-1' });
    const enabledOnly = filterToolList(toolsAfter, { enabledOnly: true });
    assert.ok(!enabledOnly.some((t) => t.name === 'write_file'));
    assert.equal(enabledOnly.length, toolsAfter.length - 1);
    // Query rỗng + không lọc = giữ nguyên thứ tự và số lượng.
    assert.deepEqual(
      filterToolList(toolsAfter, {}).map((t) => t.name),
      toolsAfter.map((t) => t.name),
    );
  } finally {
    coord.shutdown();
  }
});
