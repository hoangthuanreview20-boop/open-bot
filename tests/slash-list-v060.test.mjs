/**
 * Tests cho v0.60 (UI-6 follow-up) — IPC `slash:list` + coordinator
 * RPC `listSlashCommands`.
 *
 * Core (coordinator `listSlashCommands`, qua RPC `handle` như đường
 * main → CoordinatorClient đi):
 *   1. Lệnh markdown: `<workspace>/.open-bot/commands/*.md` được liệt
 *      kê theo tên file, mô tả từ dòng `# ...` đầu tiên (hoặc dòng đầu
 *      không rỗng), chỉ trả `{ name, description }` — không lộ
 *      promptTemplate/file/run qua IPC.
 *   2. Không có thư mục commands → `[]` (không throw).
 *   3. Lệnh bundle: plugin có `slashCommand` trong `plugin.json`
 *      được liệt kê; trùng tên với markdown thì markdown thắng
 *      (cùng ngữ nghĩa `resolveSlashCommand` dùng khi chạy lệnh).
 *   4. Bot lạ / botId rỗng → lỗi rõ ràng, không đổi gì.
 * Static contract (không có harness Electron thật trong node:test —
 * ipcMain/preload chỉ kiểm chứng được bằng source, như các test IPC
 * khác trong repo):
 *   5. main.ts đăng ký `ipcMain.handle('slash:list', …)` và gọi
 *      `getCoordinator().listSlashCommands(botId)`.
 *   6. preload.ts expose `listSlashCommands` (interface + object)
 *      gọi `ipcRenderer.invoke('slash:list', { botId })`.
 *   7. global.d.ts khai báo `listSlashCommands` BẮT BUỘC (không còn
 *      `?` — preload đã expose thật, xem UI-6 test cũ từng assert
 *      optional trước follow-up này).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/slash-list-v060.test.mjs
 *
 * Không mạng thật, không key thật, không tài khoản thật.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCoordinator } from '../packages/core/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf-8');

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

function mockProvider() {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text: 'xong' }] };
}

function writeCommands(ws, files) {
  const dir = path.join(ws, '.open-bot', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

/** Plugin bundle tối thiểu có một lệnh slash (hình dạng như test v014). */
function writeSlashBundle(pluginsDir, pluginId, cmdName, description) {
  const dir = path.join(pluginsDir, pluginId);
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { tools: [] };\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'commands', `${cmdName}.md`),
    `# ${description}\nTemplate bundle cho {{args}}.\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: pluginId,
        name: 'Slash Bundle',
        version: '1.0.0',
        description: 'Bundle demo có lệnh slash.',
        permissions: [],
        main: 'index.js',
        tools: [],
        slashCommand: [{ name: cmdName, description, file: `commands/${cmdName}.md` }],
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

async function makeBot(botId, ws, extra = {}) {
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-slash-list-data-') });
  await coord.createBot({ bot: botConfig(botId, ws), provider: mockProvider(), ...extra });
  return coord;
}

test('listSlashCommands: lệnh markdown được liệt kê, mô tả từ dòng "#", chỉ name+description', async () => {
  const ws = tmpDir('open-bot-slash-list-ws-');
  writeCommands(ws, {
    'review-code.md': '# Review code, tìm bug.\nReview {{args}} thật kỹ.\n',
    'commit.md': 'Viết commit message.\nDựa trên diff {{args}}.\n',
  });
  const coord = await makeBot('bot-1', ws);
  try {
    // Qua RPC handle (đường main → CoordinatorClient đi), không chỉ
    // gọi method trực tiếp.
    const list = await coord.handle('listSlashCommands', { botId: 'bot-1' });
    assert.deepEqual(list, [
      { name: 'commit', description: 'Viết commit message.' },
      { name: 'review-code', description: 'Review code, tìm bug.' },
    ]);
    // Chỉ hai trường đi qua IPC — promptTemplate/file/run không lộ.
    for (const item of list) {
      assert.deepEqual(Object.keys(item).sort(), ['description', 'name']);
    }
    // Method trực tiếp trả cùng kết quả.
    assert.deepEqual(await coord.listSlashCommands({ botId: 'bot-1' }), list);
  } finally {
    await coord.shutdown();
  }
});

test('listSlashCommands: không có thư mục commands → []', async () => {
  const ws = tmpDir('open-bot-slash-list-ws-');
  const coord = await makeBot('bot-1', ws);
  try {
    assert.deepEqual(await coord.handle('listSlashCommands', { botId: 'bot-1' }), []);
  } finally {
    await coord.shutdown();
  }
});

test('listSlashCommands: lệnh bundle được liệt kê; trùng tên thì markdown thắng', async () => {
  const ws = tmpDir('open-bot-slash-list-ws-');
  // Markdown 'review' + bundle 'review' (trùng tên) + bundle 'deploy' (riêng).
  writeCommands(ws, {
    'review.md': '# Review theo chuẩn nhà.\nReview {{args}} theo chuẩn nhà.\n',
  });
  const pluginsDir = tmpDir('open-bot-slash-list-plugins-');
  writeSlashBundle(pluginsDir, 'slash-bundle', 'review', 'Review code (bundle).');
  // Bundle thứ hai chỉ có lệnh deploy — viết tay vì helper chỉ làm 1 lệnh/bundle.
  const deployDir = path.join(pluginsDir, 'deploy-bundle');
  fs.mkdirSync(path.join(deployDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(deployDir, 'index.js'), 'module.exports = { tools: [] };\n', 'utf8');
  fs.writeFileSync(
    path.join(deployDir, 'commands', 'deploy.md'),
    '# Deploy lên staging.\nDeploy {{args}} lên staging.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(deployDir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'deploy-bundle',
        name: 'Deploy Bundle',
        version: '1.0.0',
        description: 'Bundle deploy.',
        permissions: [],
        main: 'index.js',
        tools: [],
        slashCommand: [{ name: 'deploy', description: 'Deploy lên staging.', file: 'commands/deploy.md' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  const coord = await makeBot('bot-1', ws, { pluginsDir });
  try {
    const list = await coord.handle('listSlashCommands', { botId: 'bot-1' });
    const byName = new Map(list.map((c) => [c.name, c.description]));
    assert.equal(byName.get('deploy'), 'Deploy lên staging.', 'lệnh bundle riêng phải có');
    // Trùng tên: mô tả của markdown thắng, không phải của bundle.
    assert.equal(byName.get('review'), 'Review theo chuẩn nhà.');
    assert.equal(list.length, 2, `chỉ còn 2 lệnh (review + deploy), có ${JSON.stringify(list)}`);
  } finally {
    await coord.shutdown();
  }
});

test('listSlashCommands: bot lạ / botId rỗng → lỗi rõ ràng', async () => {
  const ws = tmpDir('open-bot-slash-list-ws-');
  const coord = await makeBot('bot-1', ws);
  try {
    // listSlashCommands là sync (như listThreads) → throw đồng bộ.
    assert.throws(() => coord.listSlashCommands({ botId: 'bot-khong-co' }), /Chưa tạo bot/);
    assert.throws(() => coord.listSlashCommands({ botId: '' }), /listSlashCommands cần params/);
    assert.throws(() => coord.listSlashCommands({}), /listSlashCommands cần params/);
    // Qua RPC handle (async) thì lỗi thành rejection.
    await assert.rejects(
      coord.handle('listSlashCommands', { botId: 'bot-khong-co' }),
      /Chưa tạo bot/,
    );
  } finally {
    await coord.shutdown();
  }
});

// --- Static contract: IPC wiring -----------------------------------------

test('main.ts đăng ký ipcMain.handle("slash:list") gọi coordinator listSlashCommands', () => {
  const main = read(path.join(repo, 'apps/desktop/src/main/main.ts'));
  assert.match(main, /ipcMain\.handle\('slash:list'/);
  assert.match(main, /getCoordinator\(\)\.listSlashCommands\(botId\)/);
  assert.match(main, /Không tìm thấy bot\./);
});

test('preload.ts expose listSlashCommands qua IPC slash:list', () => {
  const preload = read(path.join(repo, 'apps/desktop/src/main/preload.ts'));
  assert.match(
    preload,
    /listSlashCommands: \(botId: string\) => Promise<Array<\{ name: string; description: string \}>>/,
    'interface phải khai báo listSlashCommands',
  );
  assert.match(
    preload,
    /listSlashCommands: \(botId\) => ipcRenderer\.invoke\('slash:list', \{ botId \}\)/,
    'object expose phải invoke channel slash:list',
  );
});

test('global.d.ts khai báo listSlashCommands BẮT BUỘC (không còn "?")', () => {
  const dts = read(path.join(repo, 'apps/desktop/src/renderer/global.d.ts'));
  assert.match(dts, /listSlashCommands\(botId: string\): Promise<Array<\{ name: string; description: string \}>>/);
  assert.doesNotMatch(dts, /listSlashCommands\?\(botId: string\)/);
});
