/**
 * stoprun-pending-v074.test.mjs — v0.74a: `stopRun` ghi nhớ stop cho
 * runId chưa bắt đầu (lấp gap ghi ở v0.61: "stopRun theo runId lạ vẫn
 * không ghi pending stop").
 *
 * Race: WS client truyền runId của chính nó khi gọi `run`, nên một
 * `stopRun` (vd qua WS) có thể tới coordinator TRƯỚC cả RPC `run`
 * (vd qua IPC) — lúc đó run chưa chạy, chưa xếp hàng, `stopRun` cũ
 * trả stopped:false rồi quên hẳn, run sau đó chạy trọn. Nay stop
 * được ghi lại theo runId (cửa sổ 30s, tiêu thụ một lần) và run mang
 * id đó bắt đầu trong cửa sổ sẽ dừng ngay trước mọi provider call.
 *
 * Run: npm run build --workspace=@open-bot/core rồi
 *      node --test tests/stoprun-pending-v074.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-stoprun-v074-'));
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
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stopRun TRƯỚC run() với cùng runId — run sau đó dừng ngay, không chạy', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-stoprun-early', ws),
    provider: mockProvider('CÂU TRẢ LỜI ĐẦY ĐỦ (stop đã mất)', { delayMs: 5000 }),
  });
  const runId = randomUUID();
  // Stop tới trước khi có run nào: vẫn báo stopped:false như cũ
  // (hợp đồng trả về không đổi), nhưng reason phải nói rõ stop đã
  // được ghi lại thay vì "không tìm thấy".
  const stopped = await client.stopRun(runId);
  assert.equal(stopped.stopped, false);
  assert.match(stopped.reason ?? '', /ghi lại/, 'reason phải nói stop đã ghi lại');
  // Run mang đúng id đó tới sau phải dừng ngay (nhanh hơn nhiều so
  // với delay 5s của provider) và báo stopped:true.
  const t0 = Date.now();
  const result = await client.run('bot-stoprun-early', 'câu hỏi tới sau stop', undefined, {
    runId,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `run phải dừng ngay sau stop (<2s), thực tế ${elapsed}ms`);
  assert.equal(result.stopped, true, 'run tới sau stop phải báo stopped:true');
  assert.match(result.text ?? '', /Đã dừng/, 'run dừng phải trả text dừng, không phải text provider');
  await client.destroyBot('bot-stoprun-early');
});

test('stopRun với runId lạ không giết run mang runId khác', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-stoprun-other', ws),
    provider: mockProvider('trả lời bình thường'),
  });
  const stopped = await client.stopRun(randomUUID());
  assert.equal(stopped.stopped, false);
  const result = await client.run('bot-stoprun-other', 'chào bạn', undefined, {
    runId: randomUUID(),
  });
  assert.equal(result.stopped, false, 'run mang id khác không được dừng');
  assert.equal(result.text, 'trả lời bình thường');
  await client.destroyBot('bot-stoprun-other');
});

test('stop theo runId chỉ dùng một lần — chạy lại cùng runId thì chạy bình thường', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-stoprun-once', ws),
    provider: mockProvider('trả lời bình thường'),
  });
  const runId = randomUUID();
  await client.stopRun(runId);
  const r1 = await client.run('bot-stoprun-once', 'chào lần 1', undefined, { runId });
  assert.equal(r1.stopped, true, 'run đầu mang id đã stop phải dừng');
  const r2 = await client.run('bot-stoprun-once', 'chào lần 2', undefined, { runId });
  assert.equal(r2.stopped, false, 'pending stop đã tiêu thụ — run lại cùng id chạy bình thường');
  assert.equal(r2.text, 'trả lời bình thường');
  await client.destroyBot('bot-stoprun-once');
});

test('stopRun 2 lần cùng runId lạ — ghi đè vô hại, run sau đó vẫn dừng', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-stoprun-twice', ws),
    provider: mockProvider('CÂU TRẢ LỜI ĐẦY ĐỦ (stop đã mất)', { delayMs: 5000 }),
  });
  const runId = randomUUID();
  const s1 = await client.stopRun(runId);
  const s2 = await client.stopRun(runId);
  assert.equal(s1.stopped, false);
  assert.equal(s2.stopped, false, 'stop lần 2 cùng id cũng chỉ ghi lại, không lỗi');
  const result = await client.run('bot-stoprun-twice', 'câu hỏi tới sau 2 stop', undefined, {
    runId,
  });
  assert.equal(result.stopped, true, 'run mang id đã stop 2 lần vẫn phải dừng');
  await client.destroyBot('bot-stoprun-twice');
});
