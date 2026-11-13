/**
 * tests/router-mock-v096.test.mjs — hồi quy cho lỗi router ở sóng v0.96.
 *
 * Lỗi gốc: router (Đội T3, mặc định BẬT) thêm đích Ollama local qua
 * discoverLocalTarget() cho MỌI bot, rồi tầng structural route prompt
 * đơn giản ("xong", "hello", "chào bạn") sang Ollama — kể cả bot dùng
 * provider `mock`. Kết quả: ~100 test mock-provider nhận câu trả lời
 * thật của qwen2.5:0.5b thay vì text mock, và suite chậm đi hàng chục
 * phút vì Ollama trên máy 1,5 CPU bị dồn hàng trăm call.
 *
 * Fix: coordinator.applyRouting() trả default ngay khi
 * providerConfig.id === 'mock' (xem packages/core/src/coordinator/
 * coordinator.ts) — mock là provider xác định, không phải model thật,
 * router không bao giờ được đổi provider của nó.
 *
 * Test này chỉ có ý nghĩa khi Ollama đang chạy (có đích local để
 * router "thèm" route sang): nếu Ollama chết thì skip — việc đó đã
 * được coordinator.test.mjs bao phủ ở trạng thái không có local.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/router-mock-v096.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-router-mock-'));
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

async function ollamaUp() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
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

test('router v0.96: bot mock KHÔNG bị route sang Ollama dù Ollama đang chạy', async (t) => {
  if (!(await ollamaUp())) {
    t.skip('Ollama không chạy — không có đích local để router route sang');
    return;
  }
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('router-mock-1', ws),
    provider: mockProvider('mock ok'),
  });
  // Prompt đơn giản kiểu "xong"/"hello" là đúng thứ tầng structural
  // từng route sang local — giờ phải ở lại mock.
  const started = Date.now();
  const result = await client.run('router-mock-1', 'xong', () => {});
  assert.equal(result.text, 'mock ok');
  assert.equal(result.stopped, false);
  // Mock trả lời tức thì; nếu bị route sang Ollama thì run này tốn
  // hàng giây trên máy 1,5 CPU — ngưỡng 20s đủ rộng để không flake.
  assert.ok(Date.now() - started < 20_000, `run mock phải nhanh, tốn ${Date.now() - started}ms`);
});

test('router v0.96: nhiều turn liên tiếp trên bot mock đều ở lại mock (không bị pin sang local)', async (t) => {
  if (!(await ollamaUp())) {
    t.skip('Ollama không chạy — không có đích local để router route sang');
    return;
  }
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('router-mock-2', ws),
    provider: mockProvider('lượt hai'),
  });
  for (const prompt of ['hello', 'xong 1', 'ok']) {
    const result = await client.run('router-mock-2', prompt, () => {});
    assert.equal(result.text, 'lượt hai', `prompt ${JSON.stringify(prompt)} phải ở lại mock`);
  }
});
