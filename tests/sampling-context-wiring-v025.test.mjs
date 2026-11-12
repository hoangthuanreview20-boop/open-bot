/**
 * sampling-context-wiring-v025.test.mjs — v0.25 (W18a): test tích hợp
 * cho đường nối sampling-context của W17d.
 *
 * W17d nối `SamplingContextStore` per-bot vào cả hai đường handler
 * sampling (pool qua `buildToolHost().getSamplingHandler`, system qua
 * `callSystemToolFor`) nhưng chỉ xác minh bằng build/typecheck + đọc
 * code, vì mock provider cũ bỏ qua input của `chat()` nên không quan
 * sát được lịch sử có tới provider hay không. Test này chứng minh
 * bằng chứng cứ trực tiếp: mock provider (W18a) ghi lại mọi
 * `ChatCompletionRequest` vào một file JSONL riêng của từng bot
 * (`mockRecordPath`), test đọc file đó và khẳng định messages provider
 * nhận được ở lần sampling sau đã có lịch sử của lần trước prepend
 * trước messages mới.
 *
 * Vì sao record bằng FILE chứ không phải mảng `recordCalls` truyền
 * vào: `CoordinatorClient` chạy coordinator trong tiến trình CON
 * (NDJSON-RPC) — mảng in-process không qua được ranh giới tiến trình,
 * còn file thì cả cha lẫn con đều đọc được. Mỗi bot dùng một file
 * riêng nên hai bot chạy song song không lẫn calls (xem
 * `MockProviderRecordOptions` trong coordinator.ts).
 *
 * Fake server stdio: tool `ask` gửi `sampling/createMessage` với
 * `includeContext: 'allServers'` và một câu hỏi đánh dấu riêng
 * (`ASK_TEXT` qua env), trả text sampling làm kết quả tool.
 *
 * Run: npm run build --workspace=@open-bot/core rồi
 *      node --test tests/sampling-context-wiring-v025.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const FAKE_ASK_SERVER_CODE = [
  `import * as fs from 'node:fs';`,
  `import * as readline from 'node:readline';`,
  `const obsFile = process.env.OBS_FILE;`,
  `const askText = process.env.ASK_TEXT || 'CAU_HOI';`,
  `const rl = readline.createInterface({ input: process.stdin });`,
  `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
  `const obs = (o) => fs.appendFileSync(obsFile, 'OBS ' + JSON.stringify(o) + '\\n');`,
  `let pendingAsk = null;`,
  `for await (const line of rl) {`,
  `  let msg; try { msg = JSON.parse(line); } catch { continue; }`,
  `  if (msg.method === 'initialize') {`,
  `    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-ask', version: '0' } } });`,
  `  } else if (msg.method === 'tools/list') {`,
  `    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [`,
  `      { name: 'ask', description: 'Hoi LLM qua sampling.', inputSchema: { type: 'object', properties: {} } },`,
  `    ] } });`,
  `  } else if (msg.method === 'tools/call') {`,
  `    if (msg.params?.name === 'ask') {`,
  `      pendingAsk = msg.id;`,
  `      out({ jsonrpc: '2.0', id: 100, method: 'sampling/createMessage', params: {`,
  `        messages: [{ role: 'user', content: { type: 'text', text: askText } }],`,
  `        maxTokens: 100,`,
  `        includeContext: 'allServers',`,
  `      } });`,
  `    } else {`,
  `      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } });`,
  `    }`,
  `  } else if (msg.id === 100 && pendingAsk !== null) {`,
  `    const askId = pendingAsk; pendingAsk = null;`,
  `    obs({ samplingResponse: msg });`,
  `    const text = msg.result?.content?.text ?? msg.error?.message ?? '(no text)';`,
  `    out({ jsonrpc: '2.0', id: askId, result: { content: [{ type: 'text', text }] } });`,
  `  }`,
  `}`,
].join('\n');

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-sampling-ctx-'));
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

/**
 * Ghi `.open-bot/mcp.json` với các server cho trước: mỗi server là
 * một fake `ask` với câu hỏi đánh dấu riêng + file obs riêng.
 * `servers` là object `{ tênServer: { askText, obsFile } }`.
 */
function writeMcpJson(workspaceDir, servers) {
  fs.mkdirSync(path.join(workspaceDir, '.open-bot'), { recursive: true });
  const config = { servers: {} };
  for (const [name, { askText, obsFile }] of Object.entries(servers)) {
    fs.writeFileSync(obsFile, '', 'utf8');
    config.servers[name] = {
      command: 'node',
      args: ['--input-type=module', '-e', FAKE_ASK_SERVER_CODE],
      env: { OBS_FILE: obsFile, ASK_TEXT: askText },
    };
  }
  fs.writeFileSync(
    path.join(workspaceDir, '.open-bot', 'mcp.json'),
    JSON.stringify(config),
    'utf8',
  );
}

function readObservations(obsFile) {
  return fs
    .readFileSync(obsFile, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('OBS '))
    .map((l) => JSON.parse(l.slice(4)));
}

/** Đọc file record JSONL của mock: một object request mỗi dòng, theo thứ tự gọi. */
function readRecord(recordPath) {
  return fs
    .readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** Rút gọn messages của một request đã record về [[role, text], ...] để assert. */
function messagePairs(call) {
  return call.messages.map((m) => [
    m.role,
    typeof m.content === 'string' ? m.content : (m.content?.text ?? JSON.stringify(m.content)),
  ]);
}

/**
 * Lần sampling xin câu hỏi `marker`: lần chat() mà message CUỐI là
 * user message mang đúng marker đó. Không lọc bằng includes: các lần
 * sampling sau cũng chứa marker cũ trong phần lịch sử prepend nên
 * includes sẽ bắt nhầm nhiều lần.
 */
function samplingCallFor(calls, marker) {
  const found = calls.filter((c) => {
    const last = c.messages[c.messages.length - 1];
    const text = typeof last?.content === 'string' ? last.content : (last?.content?.text ?? '');
    return last?.role === 'user' && text === marker;
  });
  assert.equal(
    found.length,
    1,
    `phải có đúng 1 lần sampling xin "${marker}", got ${found.length}: ${JSON.stringify(calls.map((c) => messagePairs(c)))}`,
  );
  return found[0];
}

/** Text sampling server nhận được (ghi ở obs) — chứng minh vòng tròn khép kín. */
function samplingTextReceived(obsFile) {
  const sampling = readObservations(obsFile).find((o) => o.samplingResponse)?.samplingResponse;
  assert.ok(sampling, `server phải nhận sampling response, obs: ${JSON.stringify(readObservations(obsFile))}`);
  assert.equal(sampling.error, undefined, `sampling không được lỗi: ${JSON.stringify(sampling?.error)}`);
  return sampling.result?.content?.text;
}

/** Chạy run với timeout rõ ràng: deadlock (nếu có) thành lỗi test thay vì treo suite. */
async function runWithTimeout(client, botId, text, ms = 20_000) {
  return Promise.race([
    client.run(botId, text),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`run timeout sau ${ms}ms — nghi deadlock sampling/tool-call`)), ms),
    ),
  ]);
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

test('pool -> pool: server B xin allServers thấy lịch sử sampling của server A prepend trước câu mới', async () => {
  const ws = tmpWorkspace();
  const recordPath = path.join(ws, 'mock-record.jsonl');
  const obsA = path.join(ws, 'obs-a.jsonl');
  const obsB = path.join(ws, 'obs-b.jsonl');
  writeMcpJson(ws, {
    'fake-a': { askText: 'CAU_HOI_A', obsFile: obsA },
    'fake-b': { askText: 'CAU_HOI_B', obsFile: obsB },
  });
  await client.createBot({
    bot: botConfig('bot-pool-ctx-v025', ws),
    provider: {
      id: 'mock',
      mockResponses: [
        // Run 1: agent gọi mcp_call_tool fake-a -> sampling A -> text cuối.
        { text: '', toolCalls: [{ id: 'c1', name: 'mcp_call_tool', args: { server: 'fake-a', tool: 'ask', arguments: {} } }] },
        { text: 'TRA_LOI_A' },
        { text: 'xong A' },
        // Run 2: agent gọi mcp_call_tool fake-b -> sampling B -> text cuối.
        { text: '', toolCalls: [{ id: 'c2', name: 'mcp_call_tool', args: { server: 'fake-b', tool: 'ask', arguments: {} } }] },
        { text: 'TRA_LOI_B' },
        { text: 'xong B' },
      ],
      mockRecordPath: recordPath,
    },
  });

  const r1 = await runWithTimeout(client, 'bot-pool-ctx-v025', 'gọi server A giúp tôi');
  assert.equal(r1.stopped, false);
  assert.match(r1.text, /xong A/, `run 1 phải xong, got: ${r1.text}`);
  const r2 = await runWithTimeout(client, 'bot-pool-ctx-v025', 'gọi server B giúp tôi');
  assert.equal(r2.stopped, false);
  assert.match(r2.text, /xong B/, `run 2 phải xong, got: ${r2.text}`);

  // Cả hai server đều nhận đúng text sampling mock trả.
  assert.equal(samplingTextReceived(obsA), 'TRA_LOI_A');
  assert.equal(samplingTextReceived(obsB), 'TRA_LOI_B');

  // Bằng chứng chính: file record của mock — 2 run × 3 lần chat
  // (agent tool-call, sampling, agent text cuối).
  const calls = readRecord(recordPath);
  assert.equal(calls.length, 6, `mock phải nhận đúng 6 lần chat, got ${calls.length}: ${JSON.stringify(calls.map((c) => messagePairs(c)))}`);

  const samplingA = samplingCallFor(calls, 'CAU_HOI_A');
  // Lần sampling đầu: store còn trống nên provider chỉ thấy câu mới.
  assert.deepEqual(
    messagePairs(samplingA),
    [['user', 'CAU_HOI_A']],
    'sampling A (lần đầu) không được có lịch sử prepend',
  );

  const samplingB = samplingCallFor(calls, 'CAU_HOI_B');
  // Lần sampling thứ 2: lịch sử lượt A (câu hỏi + câu trả lời) prepend
  // TRƯỚC câu mới của B — đây là `includeContext: 'allServers'` thật
  // qua store dùng chung, không phải fallback thisServer.
  assert.deepEqual(
    messagePairs(samplingB),
    [
      ['user', 'CAU_HOI_A'],
      ['assistant', 'TRA_LOI_A'],
      ['user', 'CAU_HOI_B'],
    ],
    'sampling B phải thấy lịch sử của server A prepend trước câu mới',
  );
});

test('pool -> system -> pool: lịch sử sampling đi qua cả hai đường handler của cùng bot', async () => {
  const ws = tmpWorkspace();
  const recordPath = path.join(ws, 'mock-record.jsonl');
  const obsA = path.join(ws, 'obs-a.jsonl');
  const obsSys = path.join(ws, 'obs-sys.jsonl');
  const obsB = path.join(ws, 'obs-b.jsonl');
  writeMcpJson(ws, {
    'fake-a': { askText: 'CAU_HOI_A', obsFile: obsA },
    system: { askText: 'CAU_HOI_SYS', obsFile: obsSys },
    'fake-b': { askText: 'CAU_HOI_B', obsFile: obsB },
  });
  await client.createBot({
    bot: botConfig('bot-cross-ctx-v025', ws),
    provider: {
      id: 'mock',
      mockResponses: [
        // Run 1 (pool): mcp_call_tool fake-a -> sampling A -> text cuối.
        { text: '', toolCalls: [{ id: 'c1', name: 'mcp_call_tool', args: { server: 'fake-a', tool: 'ask', arguments: {} } }] },
        { text: 'TRA_LOI_A' },
        { text: 'xong A' },
        // Run 2 (system): mcp_system_exec ask -> sampling SYS -> text cuối.
        { text: '', toolCalls: [{ id: 'c2', name: 'mcp_system_exec', args: { tool: 'ask', arguments: {} } }] },
        { text: 'TRA_LOI_SYS' },
        { text: 'xong SYS' },
        // Run 3 (pool): mcp_call_tool fake-b -> sampling B -> text cuối.
        { text: '', toolCalls: [{ id: 'c3', name: 'mcp_call_tool', args: { server: 'fake-b', tool: 'ask', arguments: {} } }] },
        { text: 'TRA_LOI_B' },
        { text: 'xong B' },
      ],
      mockRecordPath: recordPath,
    },
    allowedSystemTools: ['ask'],
  });

  const r1 = await runWithTimeout(client, 'bot-cross-ctx-v025', 'gọi server A giúp tôi');
  assert.equal(r1.stopped, false);
  assert.match(r1.text, /xong A/, `run 1 (pool A) phải xong, got: ${r1.text}`);
  const r2 = await runWithTimeout(client, 'bot-cross-ctx-v025', 'hỏi system giúp tôi');
  assert.equal(r2.stopped, false);
  assert.match(r2.text, /xong SYS/, `run 2 (system) phải xong, got: ${r2.text}`);
  const r3 = await runWithTimeout(client, 'bot-cross-ctx-v025', 'gọi server B giúp tôi');
  assert.equal(r3.stopped, false);
  assert.match(r3.text, /xong B/, `run 3 (pool B) phải xong, got: ${r3.text}`);

  assert.equal(samplingTextReceived(obsA), 'TRA_LOI_A');
  assert.equal(samplingTextReceived(obsSys), 'TRA_LOI_SYS');
  assert.equal(samplingTextReceived(obsB), 'TRA_LOI_B');

  // 3 run × 3 lần chat (agent tool-call, sampling, agent text cuối).
  const calls = readRecord(recordPath);
  assert.equal(calls.length, 9, `mock phải nhận đúng 9 lần chat, got ${calls.length}: ${JSON.stringify(calls.map((c) => messagePairs(c)))}`);

  const samplingA = samplingCallFor(calls, 'CAU_HOI_A');
  assert.deepEqual(messagePairs(samplingA), [['user', 'CAU_HOI_A']]);

  // Chiều chéo pool -> system: system server xin allServers cũng thấy
  // lịch sử pool của server A (store dùng chung per-bot).
  const samplingSys = samplingCallFor(calls, 'CAU_HOI_SYS');
  assert.deepEqual(
    messagePairs(samplingSys),
    [
      ['user', 'CAU_HOI_A'],
      ['assistant', 'TRA_LOI_A'],
      ['user', 'CAU_HOI_SYS'],
    ],
    'sampling system phải thấy lịch sử pool của server A prepend trước câu mới',
  );

  // Chiều ngược system -> pool: server B (pool) thấy cả lịch sử pool A
  // lẫn lịch sử system SYS prepend trước câu mới.
  const samplingB = samplingCallFor(calls, 'CAU_HOI_B');
  assert.deepEqual(
    messagePairs(samplingB),
    [
      ['user', 'CAU_HOI_A'],
      ['assistant', 'TRA_LOI_A'],
      ['user', 'CAU_HOI_SYS'],
      ['assistant', 'TRA_LOI_SYS'],
      ['user', 'CAU_HOI_B'],
    ],
    'sampling B phải thấy lịch sử của cả server A (pool) và system prepend trước câu mới',
  );
});
