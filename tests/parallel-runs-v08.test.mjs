/**
 * parallel-runs-v08.test.mjs — v0.8 run queue (ROADMAP §2f).
 *
 * - Tối đa 4 run đồng thời (MAX_CONCURRENT_RUNS): 6 run mock cùng lúc
 *   chạy thành 2 đợt (4 + 2), tất cả đều xong, không chạy nối tiếp.
 * - Run vượt giới hạn xếp hàng FIFO; stopBot huỷ cả run đang xếp hàng.
 * - Hai run cùng một bot không chạy chồng nhau: run sau chờ run trước.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/parallel-runs-v08.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import { MAX_CONCURRENT_RUNS } from '../packages/core/dist/coordinator/coordinator.js';

assert.equal(MAX_CONCURRENT_RUNS, 4, 'MAX_CONCURRENT_RUNS phải là 4');

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-par08-'));
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

async function createMockBot(id, responses) {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig(id, ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: responses },
  });
}

test('6 run đồng thời: tối đa 4 chạy cùng lúc, tất cả xong, không nối tiếp', async () => {
  const DELAY_MS = 300;
  const ids = ['par-a', 'par-b', 'par-c', 'par-d', 'par-e', 'par-f'];
  for (const id of ids) {
    await createMockBot(id, [{ text: `xong ${id}`, delayMs: DELAY_MS }]);
  }

  // Delta của mỗi run tới ngay khi provider mock trả lời (cuối run) —
  // thời điểm delta cho biết run đó chạy ở đợt nào: 4 delta đầu tới
  // sau ~1 đợt delay, 2 delta sau tới sau ~2 đợt delay.
  const deltaAt = [];
  const startedAt = Date.now();
  const results = await Promise.all(
    ids.map((id) =>
      client.run(id, 'chào', (e) => {
        if (e.kind === 'delta') deltaAt.push(Date.now());
      }),
    ),
  );
  const elapsed = Date.now() - startedAt;

  for (let i = 0; i < ids.length; i++) {
    assert.equal(results[i].botId, ids[i]);
    assert.equal(results[i].text, `xong ${ids[i]}`);
    assert.equal(results[i].stopped, false);
  }
  assert.equal(deltaAt.length, 6, 'mỗi run phải có đúng 1 delta');
  deltaAt.sort((a, b) => a - b);
  const gapFirstToFifth = deltaAt[4] - deltaAt[0];
  assert.ok(
    gapFirstToFifth >= 150,
    `delta thứ 5 phải tới muộn hơn delta đầu ít nhất 150ms (2 đợt chạy), thực tế ${gapFirstToFifth}ms`,
  );
  // Nối tiếp 6 run sẽ mất 6 x 300 = 1800ms; 2 đợt chỉ ~600ms.
  assert.ok(elapsed < 1500, `6 run phải xong dưới 1500ms (2 đợt), thực tế ${elapsed}ms`);
  assert.ok(elapsed >= DELAY_MS, `run không thể xong nhanh hơn 1 đợt delay, thực tế ${elapsed}ms`);

  for (const id of ids) await client.destroyBot(id);
});

test('stopBot huỷ run đang xếp hàng; các run đang chạy vẫn xong', async () => {
  const ids = ['q-a', 'q-b', 'q-c', 'q-d'];
  for (const id of ids) {
    await createMockBot(id, [{ text: `xong ${id}`, delayMs: 1200 }]);
  }
  await createMockBot('q-wait', [{ text: 'không bao giờ chạy', delayMs: 100 }]);

  // 4 run chiếm hết 4 slot; run thứ 5 phải xếp hàng.
  const running = ids.map((id) => client.run(id, 'chạy đi'));
  const queued = client.run('q-wait', 'tôi đang chờ');
  // Gắn catch sớm để rejection của run bị huỷ không thành unhandled.
  const queuedGuarded = queued.catch((err) => err);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const stopped = await client.stopBot('q-wait');
  assert.equal(stopped.botId, 'q-wait');
  assert.equal(stopped.stopped, true, 'stopBot phải báo stopped=true khi huỷ run đang xếp hàng');

  const queuedError = await queuedGuarded;
  assert.ok(queuedError instanceof Error, 'run đang xếp hàng bị huỷ phải reject');
  assert.match(queuedError.message, /huỷ khi đang xếp hàng/);

  // 4 run đang chạy không bị ảnh hưởng.
  const results = await Promise.all(running);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(results[i].text, `xong ${ids[i]}`);
    assert.equal(results[i].stopped, false);
  }

  // Coordinator vẫn sống: bot bị huỷ queue chạy lại bình thường.
  const again = await client.run('q-wait', 'chạy lại đi');
  assert.equal(again.text, 'không bao giờ chạy');

  for (const id of [...ids, 'q-wait']) await client.destroyBot(id);
});

test('hai run cùng một bot xếp hàng nối tiếp, không throw, đúng thứ tự', async () => {
  await createMockBot('q-same', [
    { text: 'first', delayMs: 300 },
    { text: 'second', delayMs: 300 },
  ]);
  const [first, second] = await Promise.all([
    client.run('q-same', 'một'),
    client.run('q-same', 'hai'),
  ]);
  assert.equal(first.text, 'first');
  assert.equal(second.text, 'second');
  await client.destroyBot('q-same');
});
