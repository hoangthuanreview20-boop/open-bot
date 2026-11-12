/**
 * sampling-tool-wiring-v020.test.mjs — v0.23 (W15b follow-up): nối
 * `callServerTool` ở production.
 *
 * W15b làm handler sampling hỗ trợ tool (SEP-1577) nhưng coordinator
 * (system server) và pool MCP chưa truyền `callServerTool` nên server
 * thật xin sampling kèm tools sẽ nhận SamplingError. Hai test này
 * chứng minh vòng tròn đầy đủ qua coordinator thật (NDJSON-RPC):
 * agent gọi tool MCP -> server xin sampling kèm tools -> provider mock
 * gọi tool -> handler gọi NGƯỢC tool đó trên cùng server -> text cuối.
 *
 * Fake server stdio: tools `ask` + `get_time`. `tools/call ask` gửi
 * `sampling/createMessage` (tools=[get_time]) về client, chờ response,
 * trả text sampling làm kết quả tool; `get_time` trả '12:00'.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/sampling-tool-wiring-v020.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const FAKE_WIRING_SERVER_CODE = [
  `import * as fs from 'node:fs';`,
  `import * as readline from 'node:readline';`,
  `const obsFile = process.env.OBS_FILE;`,
  `const rl = readline.createInterface({ input: process.stdin });`,
  `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
  `const obs = (o) => fs.appendFileSync(obsFile, 'OBS ' + JSON.stringify(o) + '\\n');`,
  `let pendingAsk = null;`,
  `for await (const line of rl) {`,
  `  let msg; try { msg = JSON.parse(line); } catch { continue; }`,
  `  if (msg.method === 'initialize') {`,
  `    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-wiring', version: '0' } } });`,
  `  } else if (msg.method === 'tools/list') {`,
  `    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [`,
  `      { name: 'ask', description: 'Hoi LLM qua sampling.', inputSchema: { type: 'object', properties: {} } },`,
  `      { name: 'get_time', description: 'Lay gio.', inputSchema: { type: 'object', properties: {} } },`,
  `    ] } });`,
  `  } else if (msg.method === 'tools/call') {`,
  `    const name = msg.params?.name;`,
  `    if (name === 'get_time') {`,
  `      obs({ getTimeCall: true });`,
  `      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '12:00' }] } });`,
  `    } else if (name === 'ask') {`,
  `      pendingAsk = msg.id;`,
  `      out({ jsonrpc: '2.0', id: 100, method: 'sampling/createMessage', params: {`,
  `        messages: [{ role: 'user', content: { type: 'text', text: 'may gio roi?' } }],`,
  `        maxTokens: 100,`,
  `        tools: [{ name: 'get_time', description: 'Lay gio.', inputSchema: { type: 'object', properties: {} } }],`,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-sampling-wiring-'));
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

/** Kịch bản mock chung cho cả 2 đường: tool MCP -> tool-call get_time -> text cuối. */
function scriptedResponses(firstToolCall) {
  return [
    { text: '', toolCalls: [firstToolCall] },
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_time', args: {} }] },
    { text: 'Bây giờ là 12:00' },
  ];
}

function writeMcpJson(workspaceDir, serverName, obsFile) {
  fs.mkdirSync(path.join(workspaceDir, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.open-bot', 'mcp.json'),
    JSON.stringify({
      servers: {
        [serverName]: {
          command: 'node',
          args: ['--input-type=module', '-e', FAKE_WIRING_SERVER_CODE],
          env: { OBS_FILE: obsFile },
        },
      },
    }),
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

test('system path: mcp_system_exec -> server xin sampling kèm tools -> provider gọi get_time ngược trên server -> text cuối', async () => {
  const ws = tmpWorkspace();
  const obsFile = path.join(ws, 'obs.jsonl');
  fs.writeFileSync(obsFile, '', 'utf8');
  writeMcpJson(ws, 'system', obsFile);
  await client.createBot({
    bot: botConfig('bot-sys-wiring', ws),
    provider: {
      id: 'mock',
      mockResponses: scriptedResponses({
        id: 'c1',
        name: 'mcp_system_exec',
        args: { tool: 'ask', arguments: {} },
      }),
    },
    allowedSystemTools: ['ask'],
  });
  const result = await runWithTimeout(client, 'bot-sys-wiring', 'hỏi giờ giúp tôi');
  assert.equal(result.stopped, false);
  assert.match(result.text, /12:00/, `run phải trả text cuối từ sampling, got: ${result.text}`);
  const observations = readObservations(obsFile);
  assert.equal(
    observations.filter((o) => o.getTimeCall).length,
    1,
    `get_time trên server phải chạy đúng 1 lần qua callServerTool, obs: ${JSON.stringify(observations)}`,
  );
  const sampling = observations.find((o) => o.samplingResponse)?.samplingResponse;
  assert.ok(sampling, 'server phải nhận sampling response');
  assert.equal(sampling.error, undefined, `sampling không được lỗi: ${JSON.stringify(sampling?.error)}`);
  assert.equal(sampling.result?.content?.text, 'Bây giờ là 12:00');
});

test('pool path: mcp_call_tool -> server xin sampling kèm tools -> provider gọi get_time ngược trên server -> text cuối', async () => {
  const ws = tmpWorkspace();
  const obsFile = path.join(ws, 'obs.jsonl');
  fs.writeFileSync(obsFile, '', 'utf8');
  writeMcpJson(ws, 'fake', obsFile);
  await client.createBot({
    bot: botConfig('bot-pool-wiring', ws),
    provider: {
      id: 'mock',
      mockResponses: scriptedResponses({
        id: 'c1',
        name: 'mcp_call_tool',
        args: { server: 'fake', tool: 'ask', arguments: {} },
      }),
    },
  });
  const result = await runWithTimeout(client, 'bot-pool-wiring', 'hỏi giờ giúp tôi');
  assert.equal(result.stopped, false);
  assert.match(result.text, /12:00/, `run phải trả text cuối từ sampling, got: ${result.text}`);
  const observations = readObservations(obsFile);
  assert.equal(
    observations.filter((o) => o.getTimeCall).length,
    1,
    `get_time trên server phải chạy đúng 1 lần qua callServerTool của pool, obs: ${JSON.stringify(observations)}`,
  );
  const sampling = observations.find((o) => o.samplingResponse)?.samplingResponse;
  assert.ok(sampling, 'server phải nhận sampling response');
  assert.equal(sampling.error, undefined, `sampling không được lỗi: ${JSON.stringify(sampling?.error)}`);
  assert.equal(sampling.result?.content?.text, 'Bây giờ là 12:00');
});
