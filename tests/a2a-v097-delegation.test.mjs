/**
 * Test v0.97 (Đội T2): bot-to-bot delegation qua A2A + 2 tool mới
 * (`a2a_delegate`, `a2a_verify_card`).
 *
 * Chỉ test local: bot đích chạy qua A2A server tạm trên loopback
 * (port 0), không mạng ngoài, không key thật.
 *
 * Build core + tools trước khi chạy:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * rồi: node --test tests/a2a-v097-delegation.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startA2aHttpServer } from '../packages/core/dist/a2a/server.js';
import { A2aClient } from '../packages/core/dist/a2a/client.js';
import { generateA2aSigningKey } from '../packages/core/dist/a2a/signing.js';
import {
  A2aDelegator,
  A2aLocalBotRegistry,
  checkDelegationSourceAllowed,
  createA2aDelegator,
  readDelegationChain,
  withDelegationChain,
  A2A_DELEGATION_CHAIN_KEY,
} from '../packages/core/dist/a2a/delegation.js';
import { createA2aTools } from '../packages/tools/dist/a2aTools.js';

const TEST_TOKEN = 'test-a2a-token-v097';
const serversToClose = [];
after(async () => {
  for (const s of serversToClose.splice(0)) {
    await s.close().catch(() => undefined);
  }
});

const echoRunner = (prefix) => async ({ text }) => ({ text: `${prefix}: ${text}` });
const CTX = { botId: 'bot-a', workspaceDir: '/tmp' };

function delegatorWithBots() {
  return createA2aDelegator([
    { botId: 'bot-b', name: 'Bot B', provider: 'openai', runner: echoRunner('B đã làm') },
    { botId: 'bot-c', name: 'Bot C', provider: 'ollama', runner: echoRunner('C đã làm') },
  ]);
}

test('registry: đăng ký/lấy/liệt kê; thiếu runner+baseUrl → throw', () => {
  const reg = new A2aLocalBotRegistry();
  assert.equal(reg.size, 0);
  reg.register({ botId: 'x', runner: echoRunner('x') });
  assert.equal(reg.size, 1);
  assert.equal(reg.get('x')?.botId, 'x');
  assert.deepEqual(reg.list().map((b) => b.botId), ['x']);
  assert.equal(reg.unregister('x'), true);
  assert.equal(reg.unregister('x'), false);
  assert.throws(() => reg.register({ botId: 'y' }), /cần runner/);
  assert.throws(() => reg.register({ botId: '' }), /cần botId/);
});

test('checkDelegationSourceAllowed: mock/cli bị từ chối, provider thật được', () => {
  assert.equal(checkDelegationSourceAllowed('a', 'openai').allowed, true);
  assert.equal(checkDelegationSourceAllowed('a', 'mock').allowed, false);
  assert.match(checkDelegationSourceAllowed('a', 'mock').reason ?? '', /mock/);
  assert.equal(checkDelegationSourceAllowed('a', 'anthropic', 'cli').allowed, false);
  assert.match(checkDelegationSourceAllowed('a', 'anthropic', 'cli').reason ?? '', /CLI/);
  assert.equal(checkDelegationSourceAllowed('', 'openai').allowed, false);
});

test('delegate: bot nội bộ qua server tạm loopback, task completed + chain', async () => {
  const d = delegatorWithBots();
  const res = await d.delegate({
    fromBotId: 'bot-a',
    fromProvider: 'openai',
    toBotId: 'bot-b',
    message: 'tóm tắt đoạn này',
  });
  assert.equal(res.targetBotId, 'bot-b');
  assert.equal(res.depth, 1);
  assert.equal(res.via, 'local-loopback-server');
  assert.ok(res.endpoint.startsWith('http://127.0.0.1:'));
  assert.equal(res.task.status.state, 'completed');
  assert.match(res.task.artifacts?.[0]?.parts?.[0]?.text ?? '', /B đã làm: tóm tắt đoạn này/);
  // Chain ghi trong metadata của task trả về.
  assert.deepEqual(readDelegationChain(res.task), ['bot-a']);
  assert.equal(res.task.metadata?.[A2A_DELEGATION_CHAIN_KEY]?.[0], 'bot-a');
});

test('delegate: bot nguồn mock → từ chối ngay (không chạy thử)', async () => {
  const d = delegatorWithBots();
  await assert.rejects(
    () =>
      d.delegate({ fromBotId: 'bot-mock', fromProvider: 'mock', toBotId: 'bot-b', message: 'x' }),
    /mock/,
  );
});

test('delegate: bot nguồn CLI → từ chối ngay', async () => {
  const d = delegatorWithBots();
  await assert.rejects(
    () =>
      d.delegate({ fromBotId: 'bot-cli', fromProvider: 'anthropic', fromKind: 'cli', toBotId: 'bot-b', message: 'x' }),
    /CLI/,
  );
});

test('delegate: tự ủy thác, bot đích lạ, vòng lặp, vượt độ sâu → lỗi rõ', async () => {
  const d = delegatorWithBots();
  await assert.rejects(
    () => d.delegate({ fromBotId: 'bot-a', fromProvider: 'openai', toBotId: 'bot-a', message: 'x' }),
    /không tự ủy thác/,
  );
  await assert.rejects(
    () => d.delegate({ fromBotId: 'bot-a', fromProvider: 'openai', toBotId: 'bot-z', message: 'x' }),
    /chưa đăng ký/,
  );
  await assert.rejects(
    () =>
      d.delegate({
        fromBotId: 'bot-a',
        fromProvider: 'openai',
        toBotId: 'bot-b',
        message: 'x',
        chain: ['bot-a'],
      }),
    /Vòng lặp/,
  );
  await assert.rejects(
    () =>
      d.delegate({
        fromBotId: 'bot-a',
        fromProvider: 'openai',
        toBotId: 'bot-b',
        message: 'x',
        chain: ['bot-x', 'bot-y', 'bot-z'],
      }),
    /Vượt độ sâu/,
  );
  await assert.rejects(
    () => d.delegate({ fromBotId: 'bot-a', fromProvider: 'openai', toBotId: 'bot-b', message: '  ' }),
    /cần message/,
  );
});

test('delegate: chain 2 tầng (A→B, B→C) ghi đủ, depth=2', async () => {
  const d = delegatorWithBots();
  const res = await d.delegate({
    fromBotId: 'bot-b',
    fromProvider: 'openai',
    toBotId: 'bot-c',
    message: 'việc tầng 2',
    chain: ['bot-a'],
  });
  assert.equal(res.depth, 2);
  assert.deepEqual(readDelegationChain(res.task), ['bot-a', 'bot-b']);
});

test('delegate: bot đích HTTP ngoài (server A2A thật trên loopback)', async () => {
  const target = await startA2aHttpServer(
    { token: TEST_TOKEN, runner: echoRunner('HTTP-B') },
    { port: 0 },
  );
  serversToClose.push(target);
  const d = new A2aDelegator();
  d.bots.register({ botId: 'bot-http', baseUrl: target.url, token: TEST_TOKEN });
  const res = await d.delegate({
    fromBotId: 'bot-a',
    fromProvider: 'openai',
    toBotId: 'bot-http',
    message: 'ping http',
  });
  assert.equal(res.via, 'http');
  assert.equal(res.task.status.state, 'completed');
  assert.match(res.task.artifacts?.[0]?.parts?.[0]?.text ?? '', /HTTP-B: ping http/);
});

test('delegate: bot đích HTTP ngoài loopback bị policy chặn', async () => {
  const d = new A2aDelegator({ networkPolicy: { allowExternal: false, warningAcknowledged: false } });
  d.bots.register({ botId: 'bot-remote', baseUrl: 'http://192.168.1.10:8080/' });
  await assert.rejects(
    () =>
      d.delegate({ fromBotId: 'bot-a', fromProvider: 'openai', toBotId: 'bot-remote', message: 'x' }),
    /loopback|Settings/,
  );
});

test('withDelegationChain/readDelegationChain: round-trip, task lạ → []', () => {
  const task = { id: 't', contextId: 'c', status: { state: 'completed' } };
  assert.deepEqual(readDelegationChain(task), []);
  assert.deepEqual(readDelegationChain(null), []);
  const withChain = withDelegationChain(task, ['a', 'b']);
  assert.deepEqual(readDelegationChain(withChain), ['a', 'b']);
  assert.deepEqual(readDelegationChain(task), []);
});

test('tool a2a_delegate: bot chạy tool ủy thác cho bot đích, trả JSON có kết quả', async () => {
  const tools = createA2aTools({
    localBots: [{ botId: 'bot-b', runner: echoRunner('B-tool') }],
    sourceProvider: 'openai',
  });
  const delegate = tools.find((t) => t.definition.name === 'a2a_delegate');
  assert.ok(delegate);
  const out = await delegate.execute({ toBot: 'bot-b', message: 'việc qua tool' }, CTX);
  const parsed = JSON.parse(out);
  assert.equal(parsed.targetBot, 'bot-b');
  assert.equal(parsed.state, 'completed');
  assert.match(parsed.text, /B-tool: việc qua tool/);
  assert.equal(parsed.fromBot, 'bot-a');
});

test('tool a2a_delegate: bot nguồn mock (qua options) → lỗi trong kết quả, không throw', async () => {
  const tools = createA2aTools({
    localBots: [{ botId: 'bot-b', runner: echoRunner('B') }],
    sourceProvider: 'mock',
  });
  const delegate = tools.find((t) => t.definition.name === 'a2a_delegate');
  const out = await delegate.execute({ toBot: 'bot-b', message: 'x' }, CTX);
  assert.match(out, /^Error: /);
  assert.match(out, /mock/);
});

test('tool a2a_verify_card: server ký số → valid + negotiated 1.0.1; server không ký → unsigned', async () => {
  const key = generateA2aSigningKey();
  const signed = await startA2aHttpServer(
    { token: TEST_TOKEN, signer: key, runner: echoRunner('s') },
    { port: 0 },
  );
  serversToClose.push(signed);
  const unsigned = await startA2aHttpServer(
    { token: TEST_TOKEN, runner: echoRunner('u') },
    { port: 0 },
  );
  serversToClose.push(unsigned);
  const tools = createA2aTools({});
  const verify = tools.find((t) => t.definition.name === 'a2a_verify_card');
  assert.ok(verify);
  const outSigned = JSON.parse(await verify.execute({ url: signed.url, token: TEST_TOKEN }, CTX));
  assert.equal(outSigned.signature.valid, true);
  assert.equal(outSigned.signature.present, true);
  assert.equal(outSigned.signature.keyId, key.keyId);
  assert.equal(outSigned.signature.firstSeen, true);
  assert.equal(outSigned.version.compatible, true);
  assert.equal(outSigned.version.negotiated, '1.0.1');
  assert.equal(outSigned.stateTransitionHistory, true);
  const outUnsigned = JSON.parse(await verify.execute({ url: unsigned.url, token: TEST_TOKEN }, CTX));
  assert.equal(outUnsigned.signature.present, false);
  assert.equal(outUnsigned.signature.valid, false);
  assert.equal(outUnsigned.version.compatible, true);
  // URL không phải A2A → Error, không throw.
  const outBad = await verify.execute({ url: 'http://127.0.0.1:9/' }, CTX);
  assert.match(outBad, /^Error: /);
});

test('tool a2a_delegate: ủy thác sang agent ngoài ĐÃ tin tưởng (fallback trusted store)', async () => {
  const target = await startA2aHttpServer(
    { runner: echoRunner('EXT'), allowUnauthenticated: true },
    { port: 0 },
  );
  serversToClose.push(target);
  // Agent ngoài không auth (allowUnauthenticated) nên tool không cần token.
  const tools = createA2aTools({ sourceProvider: 'openai' });
  const delegate = tools.find((t) => t.definition.name === 'a2a_delegate');
  // Chưa trust → lỗi rõ (không tự trust).
  const notTrusted = await delegate.execute({ toBot: target.url, message: 'x' }, CTX);
  assert.match(notTrusted, /^Error: /);
  assert.match(notTrusted, /chưa đăng ký/);
  // Trust bằng store: dùng tool discover rồi thêm tay vào store.
  const { createMemoryTrustedAgentStore, trustedAgentFromCard } = await import(
    '../packages/tools/dist/a2aTools.js'
  );
  const memStore = createMemoryTrustedAgentStore();
  const card = await new A2aClient({ baseUrl: target.url }).discover();
  await memStore.add(trustedAgentFromCard(card, target.url.replace(/\/+$/, '')));
  const tools2 = createA2aTools({ store: memStore, sourceProvider: 'openai' });
  const delegate2 = tools2.find((t) => t.definition.name === 'a2a_delegate');
  const out = await delegate2.execute({ toBot: 'open-bot', message: 'việc ngoài' }, CTX);
  const parsed = JSON.parse(out);
  assert.equal(parsed.state, 'completed');
  assert.match(parsed.text, /EXT: việc ngoài/);
  assert.equal(parsed.via, 'http');
});

test('tool registry: 8 tool A2A, đủ tên mới', async () => {
  const { A2A_TOOLS, A2A_TOOL_NAMES } = await import('../packages/tools/dist/a2aTools.js');
  assert.equal(A2A_TOOLS.length, 8);
  assert.deepEqual([...A2A_TOOL_NAMES], [
    'a2a_discover',
    'a2a_list_agents',
    'a2a_send',
    'a2a_status',
    'a2a_cancel',
    'a2a_list_tasks',
    'a2a_delegate',
    'a2a_verify_card',
  ]);
  // Client vẫn gọi được server thật qua A2aClient (sanity loopback).
  const srv = await startA2aHttpServer({ token: TEST_TOKEN, runner: echoRunner('z') }, { port: 0 });
  serversToClose.push(srv);
  const client = new A2aClient({ baseUrl: srv.url, token: TEST_TOKEN });
  const task = await client.sendMessage('sanity');
  assert.equal(task.status.state, 'completed');
});
