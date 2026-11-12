/**
 * coordinator-v04.test.mjs — v0.4 coordinator RPCs qua NDJSON-RPC thật.
 *
 * - createBot với usageStorePath + mock provider có usage scripted:
 *   chạy xong ghi usage vào usage.json; vượt spend limit thì run bị chặn
 *   bằng SpendLimitError.
 * - run silent (automation/dream): không đẩy event delta về parent.
 * - runTool / createTask / reloadSkills / cache.stats / cache.clear.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/coordinator-v04.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import { UsageTracker } from '../packages/core/dist/usage/index.js';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v04-'));
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

let client;
test.before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

test.after(async () => {
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage: mock provider có usage scripted -> run ghi usage.json', async () => {
  const ws = tmpDir();
  const usagePath = path.join(ws, 'usage.json');
  await client.createBot({
    bot: botConfig('v04-usage', ws),
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [{ text: 'ok', usage: { inputTokens: 100, outputTokens: 50 } }],
    },
    usageStorePath: usagePath,
  });
  const res = await client.run('v04-usage', 'hello');
  assert.equal(res.text, 'ok');
  const stored = JSON.parse(fs.readFileSync(usagePath, 'utf-8'));
  const records = stored.records ?? stored;
  assert.ok(Array.isArray(records), 'usage.json phải chứa danh sách record');
  const mine = records.find((r) => r.botId === 'v04-usage');
  assert.ok(mine, 'phải có record cho bot vừa chạy');
  assert.equal(mine.inputTokens, 100);
  assert.equal(mine.outputTokens, 50);
  await client.destroyBot('v04-usage');
});

test('spend limit: vượt daily limit thì run bị chặn bằng SpendLimitError', async () => {
  const ws = tmpDir();
  const usagePath = path.join(ws, 'usage.json');
  // Gieo chi phí lớn trước (model có giá), rồi đặt limit ngày rất nhỏ.
  const seeder = new UsageTracker({ storePath: usagePath });
  seeder.record('v04-limit', 'xai', 'grok-4.7', { inputTokens: 100_000, outputTokens: 100_000 });
  seeder.setLimits({ dailyUsd: 0.01 });
  await client.createBot({
    bot: botConfig('v04-limit', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'không được chạy' }] },
    usageStorePath: usagePath,
  });
  await assert.rejects(() => client.run('v04-limit', 'hello'), /Spend limit exceeded/);
  await client.destroyBot('v04-limit');
});

test('silent run: không đẩy event delta về parent; run thường thì có', async () => {
  const ws = tmpDir();
  await client.createBot({
    bot: botConfig('v04-silent', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'silent ok' }] },
  });
  const seen = [];
  const off = client.onEvent((event) => {
    if (event.botId === 'v04-silent') seen.push(event.kind);
  });
  try {
    await client.run('v04-silent', 'hi', undefined, { silent: true });
    assert.deepEqual(seen, [], 'silent run không được đẩy event nào');
    const res = await client.run('v04-silent', 'hi again');
    assert.equal(res.text, 'silent ok');
    assert.ok(seen.includes('delta'), 'run thường phải đẩy delta');
  } finally {
    off();
    await client.destroyBot('v04-silent');
  }
});

test('runTool + createTask + cache: read_file 2 lần thì lần 2 trúng cache', async () => {
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, 'note.txt'), 'hello cache', 'utf-8');
  await client.createBot({
    bot: botConfig('v04-tools', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
  });
  const first = await client.runTool('v04-tools', 'read_file', { path: 'note.txt' });
  assert.match(first.output, /hello cache/);
  const stats1 = await client.cacheStats();
  assert.equal(stats1.misses >= 1, true, 'lần đầu phải miss cache');
  const second = await client.runTool('v04-tools', 'read_file', { path: 'note.txt' });
  assert.match(second.output, /hello cache/);
  const stats2 = await client.cacheStats();
  assert.ok(stats2.hits > stats1.hits, 'lần 2 phải hit cache');
  const cleared = await client.clearCache();
  assert.equal(cleared.cleared, true);
  const stats3 = await client.cacheStats();
  assert.equal(stats3.entries, 0, 'xoá cache xong entries về 0');
  const created = await client.createTask('v04-tools', 'Nhiệm vụ v0.4');
  assert.ok(created.id, 'createTask phải trả id');
  const { tasks } = await client.listTasks('v04-tools');
  assert.ok(tasks.some((t) => t.id === created.id), 'task mới phải có trong listTasks');
  await client.destroyBot('v04-tools');
});

test('reloadSkills: registry nạp được skill built-in', async () => {
  const ws = tmpDir();
  await client.createBot({
    bot: botConfig('v04-skills', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
    skillsDirs: {
      userSkillsDir: path.join(ws, 'skills'),
      pluginsDir: path.join(ws, 'plugins'),
      stateDir: ws,
    },
  });
  const res = await client.reloadSkills();
  assert.ok(res.skills.includes('code-review'), 'phải có skill built-in code-review');
  assert.ok(res.skills.includes('research-brief'));
  assert.ok(res.skills.includes('writing-vi'));
  assert.deepEqual(res.errors, []);
  await client.destroyBot('v04-skills');
});
