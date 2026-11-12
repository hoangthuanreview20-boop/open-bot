/**
 * mentions-loop-v015.test.mjs — kiểm thử tích hợp @-mentions ở mức loop
 * (coordinator thật qua NDJSON-RPC, giống v014-integration.test.mjs):
 *
 *  1. `@files notes.txt` trong chat: nội dung file tới được model — chứng
 *     minh qua trace (span guardrail "input" chứa nội dung file, không
 *     chứa lệnh thô `@files notes.txt` làm input).
 *  2. File mention không tồn tại: run vẫn chạy, progress event báo lý do
 *     bỏ qua, trace chứa ghi chú "đã bỏ qua" thay vì nội dung tưởng tượng.
 *  3. Mention + slash cùng lúc: `/hello @files notes.txt` — mention resolve
 *     trước, nội dung file chảy vào args của slash rồi mới render template.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/mentions-loop-v015.test.mjs
 * Không mạng, không API key thật, không x.ai.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mentions-'));
  tmpDirs.push(dir);
  return dir;
}

// tracesFile là MỘT TraceStore duy nhất cho cả coordinator (mở lazy ở
// lần dùng đầu, gắn với file đầu tiên) — nên cả 3 test dùng chung một
// file trace; các assertion dùng `includes` nên nội dung tích lũy không
// ảnh hưởng nhau.
const sharedTracesDir = tmpWorkspace();
const sharedTracesFile = path.join(sharedTracesDir, 'traces.jsonl');

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

test('@files trong chat: nội dung file tới được model (trace chứng minh)', async () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'NỘI DUNG BÍ MẬT CỦA FILE 12345', 'utf8');
  await client.createBot({
    bot: botConfig('bot-mentions', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    tracesFile: sharedTracesFile,
  });
  const run = await client.run('bot-mentions', '@files notes.txt hãy tóm tắt file này');
  assert.equal(run.text, 'mock ok');
  const traceText = fs.readFileSync(sharedTracesFile, 'utf8');
  assert.ok(
    traceText.includes('NỘI DUNG BÍ MẬT CỦA FILE 12345'),
    `trace phải chứa nội dung file đã resolve, got ${traceText.slice(0, 500)}`,
  );
  assert.ok(
    !traceText.includes('@files notes.txt hãy tóm tắt'),
    'trace không được chứa lệnh thô "@files notes.txt" làm input (đã resolve xong mới đưa vào model)',
  );
});

test('@files file không tồn tại: run vẫn chạy, progress báo lý do bỏ qua', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-mentions-missing', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    tracesFile: sharedTracesFile,
  });
  const progress = [];
  const unsubscribe = client.onEvent((e) => {
    if (e.kind === 'progress') progress.push(typeof e.payload === 'string' ? e.payload : '');
  });
  try {
    const run = await client.run('bot-mentions-missing', '@files khong-co.txt giúp mình');
    assert.equal(run.text, 'mock ok');
  } finally {
    unsubscribe();
  }
  assert.ok(
    progress.some((p) => p.includes('@files khong-co.txt') && p.includes('không tồn tại')),
    `phải có progress báo file bị bỏ qua, got ${JSON.stringify(progress)}`,
  );
  const traceText = fs.readFileSync(sharedTracesFile, 'utf8');
  assert.ok(
    traceText.includes('đã bỏ qua'),
    `trace phải chứa ghi chú "đã bỏ qua" thay cho mention, got ${traceText.slice(0, 500)}`,
  );
});

test('mention + slash: /hello @files notes.txt — nội dung file chảy vào args slash', async () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'NỘI DUNG FILE CHO SLASH 67890', 'utf8');
  const cmdDir = path.join(ws, '.open-bot', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(
    path.join(cmdDir, 'hello.md'),
    '# Chào hỏi.\nChào {{args}}, tôi là bot test.\n',
    'utf8',
  );
  await client.createBot({
    bot: botConfig('bot-mentions-slash', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    tracesFile: sharedTracesFile,
  });
  const run = await client.run('bot-mentions-slash', '/hello @files notes.txt');
  assert.equal(run.text, 'mock ok');
  const traceText = fs.readFileSync(sharedTracesFile, 'utf8');
  assert.ok(
    traceText.includes('NỘI DUNG FILE CHO SLASH 67890'),
    `trace phải chứa nội dung file đã resolve qua slash, got ${traceText.slice(0, 500)}`,
  );
  assert.ok(
    traceText.includes('Chào [@files notes.txt]'),
    `template slash phải render với mention đã resolve làm args, got ${traceText.slice(0, 500)}`,
  );
});
