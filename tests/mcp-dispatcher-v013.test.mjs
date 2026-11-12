/**
 * MCP v0.13 W5a tests (node:test). Imports the BUILT core package —
 * build core first (build riêng, không build toàn cục):
 *   npx tsc -p packages/core/tsconfig.json
 * then: node --test tests/mcp-dispatcher-v013.test.mjs
 *
 * Cover:
 *  - dispatcher: route request/notification, method-not-found -32601,
 *    thay thế/gỡ handler, không crash vì message lạ hay handler lỗi.
 *  - progress + cancellation (stdio + Streamable HTTP): progressToken
 *    trong _meta, notifications/progress về đúng callback theo token,
 *    AbortSignal / cancelRequest -> notifications/cancelled.
 *  - structured output + annotations + icons + resource links:
 *    parse outputSchema (validate, fallback text khi sai), annotations,
 *    icons, resource_link.
 *
 * Chỉ dùng server giả local (stdio script ghi ra tmpdir, HTTP server
 * in-process trên 127.0.0.1) — không gọi mạng live, không nối x.ai.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  McpDispatcher,
  createMcpDispatcher,
  isJsonRpcNotification,
  isJsonRpcRequest,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
} from '../packages/core/dist/mcp/dispatcher.js';
import {
  StdioMcpClient,
  StreamableHttpMcpClient,
  extractResourceLinks,
  parseAnnotations,
  parseIcons,
  parseToolCallResult,
  toolResultToText,
  validateAgainstSchema,
} from '../packages/core/dist/mcp/client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake stdio server -----------------------------------------------------
// Ghi mọi message client gửi vào file log (argv[2]) để test assert được
// những gì client đã gửi (_meta.progressToken, notifications/cancelled).
// tools/call:
//  - echo: trả text.
//  - slow: gửi 2 notifications/progress theo token trong _meta rồi trả
//    text + resource_link + structuredContent hợp lệ.
//  - ask: gửi elicitation/create (id 900) rồi roots/list (id 901) về
//    client, chờ trả lời, rồi trả kết quả tóm tắt hai câu trả lời.
//  - never: không bao giờ trả lời (để test cancellation/timeout).
const FAKE_STDIO_SERVER = `#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
const logFile = process.argv[2];
function log(msg) { fs.appendFileSync(logFile, JSON.stringify(msg) + '\\n'); }
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function result(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
const waiters = new Map();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  log(msg);
  if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      result(id, { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fake-v013', version: '0.1.0' } });
      break;
    case 'ping':
      result(id, {});
      break;
    case 'tools/list':
      result(id, { tools: [
        { name: 'slow', title: 'Chay cham', description: 'Tool chay lau co progress',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', properties: { count: { type: 'integer' }, ok: { type: 'boolean' } }, required: ['count', 'ok'] },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          icons: [{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48'] }] },
        { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
        { name: 'ask', description: 'Hoi client qua elicitation', inputSchema: { type: 'object', properties: {} } },
        { name: 'never', description: 'Khong bao gio tra loi', inputSchema: { type: 'object', properties: {} } },
      ] });
      break;
    case 'tools/call': {
      const name = params?.name;
      if (name === 'echo') {
        result(id, { content: [{ type: 'text', text: 'Echo: ' + (params?.arguments?.message ?? '') }], isError: false });
        break;
      }
      if (name === 'slow') {
        const token = params?._meta?.progressToken;
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'dang lam 1/2' } });
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 2, total: 2, message: 'dang lam 2/2' } });
        result(id, { content: [{ type: 'text', text: 'xong' }, { type: 'resource_link', uri: 'fake://ket-qua', name: 'ket-qua', title: 'Ket qua', description: 'File ket qua', mimeType: 'text/plain' }], structuredContent: { count: 3, ok: true }, isError: false });
        break;
      }
      if (name === 'ask') {
        const elicId = 900;
        const rootsId = 901;
        const p1 = new Promise((resolve) => waiters.set(elicId, resolve));
        send({ jsonrpc: '2.0', id: elicId, method: 'elicitation/create', params: { message: 'Ten ban la gi?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } });
        p1.then((resp) => {
          const p2 = new Promise((resolve) => waiters.set(rootsId, resolve));
          send({ jsonrpc: '2.0', id: rootsId, method: 'roots/list', params: {} });
          return p2.then((resp2) => {
            const action = resp?.result?.action ?? '?';
            const nm = resp?.result?.content?.name ?? '?';
            const code = resp2?.error?.code ?? '?';
            result(id, { content: [{ type: 'text', text: 'elicit:' + action + ':' + nm + ';roots:' + code }], isError: false });
          });
        });
        break;
      }
      if (name === 'never') break; // khong bao gio tra loi
      error(id, -32602, 'Unknown tool: ' + name);
      break;
    }
    default:
      error(id, -32601, 'Method not found: ' + method);
  }
});
`;

function makeStdioServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v013-'));
  const serverPath = path.join(dir, 'fake-v013-server.mjs');
  const logPath = path.join(dir, 'messages.log');
  fs.writeFileSync(serverPath, FAKE_STDIO_SERVER, 'utf8');
  fs.writeFileSync(logPath, '', 'utf8');
  const readLog = () =>
    fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { dir, serverPath, logPath, readLog };
}

async function stdioClient(serverPath, logPath) {
  const client = new StdioMcpClient({
    name: 'fake-v013',
    command: 'node',
    args: [serverPath, logPath],
  });
  await client.initialize();
  return client;
}

// --- dispatcher unit tests -------------------------------------------------

test('dispatcher: request lạ -> lỗi -32601 method-not-found, không crash', async () => {
  const d = new McpDispatcher();
  const res = await d.dispatch({ jsonrpc: '2.0', id: 7, method: 'roots/list', params: {} });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 7);
  assert.equal(res.error.code, JSON_RPC_METHOD_NOT_FOUND);
  assert.match(res.error.message, /Method not found: roots\/list/);
  assert.equal(res.result, undefined);
});

test('dispatcher: handler đã đăng ký được gọi với params + context, trả result', async () => {
  const d = new McpDispatcher();
  const seen = [];
  d.register('elicitation/create', (params, ctx) => {
    seen.push({ params, ctx });
    return { action: 'accept', content: { name: 'Huy' } };
  });
  const res = await d.dispatch({
    jsonrpc: '2.0',
    id: 'abc',
    method: 'elicitation/create',
    params: { message: 'Tên bạn là gì?' },
  });
  assert.equal(res.id, 'abc');
  assert.deepEqual(res.result, { action: 'accept', content: { name: 'Huy' } });
  assert.equal(res.error, undefined);
  assert.deepEqual(seen[0].params, { message: 'Tên bạn là gì?' });
  assert.equal(seen[0].ctx.method, 'elicitation/create');
  assert.equal(seen[0].ctx.requestId, 'abc');
});

test('dispatcher: đăng ký lại thay thế handler; gỡ xong -> -32601', async () => {
  const d = new McpDispatcher();
  d.register('sampling/createMessage', () => ({ first: true }));
  d.register('sampling/createMessage', () => ({ second: true }));
  assert.equal(d.has('sampling/createMessage'), true);
  let res = await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' });
  assert.deepEqual(res.result, { second: true });
  assert.equal(d.unregister('sampling/createMessage'), true);
  assert.equal(d.unregister('sampling/createMessage'), false);
  assert.equal(d.has('sampling/createMessage'), false);
  res = await d.dispatch({ jsonrpc: '2.0', id: 2, method: 'sampling/createMessage' });
  assert.equal(res.error.code, JSON_RPC_METHOD_NOT_FOUND);
});

test('dispatcher: notification -> null, handler vẫn chạy; handler lỗi cũng không reject', async () => {
  const d = new McpDispatcher();
  const seen = [];
  d.register('notifications/progress', (params) => {
    seen.push(params);
  });
  d.register('notifications/message', () => {
    throw new Error('log handler lỗi');
  });
  const res = await d.dispatch({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 't1', progress: 1, total: 2 },
  });
  assert.equal(res, null);
  assert.deepEqual(seen, [{ progressToken: 't1', progress: 1, total: 2 }]);
  const res2 = await d.dispatch({ jsonrpc: '2.0', method: 'notifications/message', params: {} });
  assert.equal(res2, null);
});

test('dispatcher: handler request ném lỗi -> -32603 internal error', async () => {
  const d = new McpDispatcher();
  d.register('elicitation/create', () => {
    throw new Error('form lỗi');
  });
  const res = await d.dispatch({ jsonrpc: '2.0', id: 3, method: 'elicitation/create' });
  assert.equal(res.error.code, JSON_RPC_INTERNAL_ERROR);
  assert.match(res.error.message, /elicitation\/create/);
});

test('dispatcher: message lạ -> null, không throw', async () => {
  const d = new McpDispatcher();
  for (const bad of [null, undefined, 42, 'chuỗi', [], {}, { id: 1 }, { method: 5 }, { jsonrpc: '2.0', id: 1, result: {} }]) {
    assert.equal(await d.dispatch(bad), null);
  }
});

test('dispatcher: ping mặc định -> {}; clear() xong ping -> -32601', async () => {
  const d = createMcpDispatcher();
  assert.deepEqual(d.methods().sort(), ['ping']);
  const res = await d.dispatch({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(res.result, {});
  d.register('ping', () => ({ custom: true }));
  assert.deepEqual((await d.dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' })).result, { custom: true });
  d.clear();
  assert.deepEqual(d.methods(), []);
  assert.equal(
    (await d.dispatch({ jsonrpc: '2.0', id: 3, method: 'ping' })).error.code,
    JSON_RPC_METHOD_NOT_FOUND,
  );
});

test('dispatcher: register validate method/handler; guards phân biệt request/notification', () => {
  const d = new McpDispatcher();
  assert.throws(() => d.register('', () => ({})), /method phải là chuỗi/);
  assert.throws(() => d.register('x', 'không phải function'), /phải là function/);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 's', method: 'ping' }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', method: 'notifications/progress' }), false);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: {} }), false);
  assert.equal(isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/progress' }), true);
  assert.equal(isJsonRpcNotification({ jsonrpc: '2.0', id: null, method: 'notifications/x' }), true);
  assert.equal(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'ping' }), false);
});

// --- validate structured output / annotations / icons / resource links -----

test('validateAgainstSchema: đúng/sai type, required, enum, additionalProperties, items', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      mode: { enum: ['a', 'b'] },
    },
    required: ['count'],
    additionalProperties: false,
  };
  assert.equal(validateAgainstSchema({ count: 3, tags: ['x'], mode: 'a' }, schema).valid, true);
  assert.equal(validateAgainstSchema({ count: 3.5 }, schema).valid, false); // integer
  const missing = validateAgainstSchema({ tags: [] }, schema);
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join(';'), /thiếu trường bắt buộc "count"/);
  const extra = validateAgainstSchema({ count: 1, lạ: true }, schema);
  assert.equal(extra.valid, false);
  assert.match(extra.errors.join(';'), /không được phép/);
  const badEnum = validateAgainstSchema({ count: 1, mode: 'c' }, schema);
  assert.equal(badEnum.valid, false);
  const badItems = validateAgainstSchema({ count: 1, tags: ['ok', 2] }, schema);
  assert.equal(badItems.valid, false);
  assert.equal(validateAgainstSchema({ count: 1 }, { type: 'object', properties: { count: { type: 'number' } } }).valid, true);
  assert.equal(validateAgainstSchema('bất cứ gì', 'không phải schema').valid, true); // không có constraint
});

test('parseToolCallResult: structuredContent hợp lệ, sai schema -> fallback text', () => {
  const schema = {
    type: 'object',
    properties: { count: { type: 'integer' }, ok: { type: 'boolean' } },
    required: ['count', 'ok'],
  };
  const good = parseToolCallResult(
    { content: [{ type: 'text', text: 'xong' }], structuredContent: { count: 3, ok: true }, isError: false },
    schema,
  );
  assert.deepEqual(good.structuredContent, { count: 3, ok: true });
  assert.equal(good.structuredContentValid, true);
  assert.equal(good.structuredContentError, undefined);
  assert.equal(good.text, 'xong');
  assert.equal(good.isError, false);

  const bad = parseToolCallResult(
    { content: [{ type: 'text', text: 'vẫn đọc được' }], structuredContent: { count: 'ba' }, isError: false },
    schema,
  );
  assert.equal(bad.structuredContent, undefined);
  assert.equal(bad.structuredContentValid, false);
  assert.match(bad.structuredContentError, /không khớp outputSchema/);
  assert.equal(bad.text, 'vẫn đọc được'); // fallback text còn nguyên

  // Không có schema: structuredContent đi qua nguyên vẹn.
  const noSchema = parseToolCallResult({
    content: [{ type: 'text', text: 't' }],
    structuredContent: { gì: 'cũng được' },
  });
  assert.deepEqual(noSchema.structuredContent, { gì: 'cũng được' });
  assert.equal(noSchema.structuredContentValid, true);
});

test('resource_link: render thành link đọc được + extract ra khỏi content', () => {
  const result = {
    content: [
      { type: 'text', text: 'đây là kết quả' },
      { type: 'resource_link', uri: 'fake://ket-qua', name: 'ket-qua', title: 'Kết quả', mimeType: 'text/plain' },
      { type: 'resource_link', uri: 'fake://khong-ten', name: 'khong-ten' },
    ],
    isError: false,
  };
  assert.equal(
    toolResultToText(result),
    'đây là kết quả\n[resource_link: Kết quả (fake://ket-qua)]\n[resource_link: khong-ten (fake://khong-ten)]',
  );
  const links = extractResourceLinks(result.content);
  assert.equal(links.length, 2);
  assert.equal(links[0].uri, 'fake://ket-qua');
  assert.equal(links[0].title, 'Kết quả');
  assert.equal(links[1].name, 'khong-ten');
  assert.equal(extractResourceLinks([{ type: 'text', text: 'x' }]).length, 0);
  // Block resource dạng lồng nhau vẫn đọc được text/uri.
  assert.equal(
    toolResultToText({ content: [{ type: 'resource', resource: { uri: 'fake://a', text: 'nội dung resource' } }] }),
    'nội dung resource',
  );
  assert.equal(
    toolResultToText({ content: [{ type: 'resource', resource: { uri: 'fake://b' } }] }),
    '[resource: fake://b]',
  );
});

test('parseAnnotations / parseIcons: chỉ lấy field hợp lệ, bỏ rác', () => {
  assert.deepEqual(parseAnnotations({ readOnlyHint: true, destructiveHint: false, lạ: 1 }), {
    readOnlyHint: true,
    destructiveHint: false,
  });
  assert.equal(parseAnnotations({ lạ: 1 }), undefined);
  assert.equal(parseAnnotations(null), undefined);
  assert.deepEqual(parseIcons([{ src: 'https://x/icon.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' }]), [
    { src: 'https://x/icon.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' },
  ]);
  assert.deepEqual(parseIcons([{ src: 'https://x/i.png', sizes: '32x32' }]), [
    { src: 'https://x/i.png', sizes: ['32x32'] },
  ]);
  assert.equal(parseIcons([{ mimeType: 'image/png' }]), undefined); // thiếu src
  assert.equal(parseIcons('không phải mảng'), undefined);
});

test('toolResultToText: isError vẫn prefix; non-object vẫn throw', () => {
  assert.match(
    toolResultToText({ content: [{ type: 'text', text: 'sai đầu vào' }], isError: true }),
    /^MCP tool error: sai đầu vào$/,
  );
  assert.throws(() => toolResultToText(42), /non-object/);
});

// --- stdio integration -----------------------------------------------------

test('stdio: listTools parse title/annotations/outputSchema/icons', async () => {
  const { serverPath, logPath } = makeStdioServer();
  const client = await stdioClient(serverPath, logPath);
  try {
    const tools = await client.listTools();
    const slow = tools.find((t) => t.name === 'slow');
    assert.equal(slow.title, 'Chay cham');
    assert.deepEqual(slow.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(slow.outputSchema.type, 'object');
    assert.deepEqual(slow.outputSchema.required, ['count', 'ok']);
    assert.deepEqual(slow.icons, [{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48'] }]);
    const echo = tools.find((t) => t.name === 'echo');
    assert.equal(echo.annotations, undefined);
    assert.equal(echo.icons, undefined);
  } finally {
    await client.close();
  }
});

test('stdio progress: _meta.progressToken được gửi; onProgress nhận đúng token; structured + link', async () => {
  const { serverPath, logPath, readLog } = makeStdioServer();
  const client = await stdioClient(serverPath, logPath);
  try {
    const events = [];
    const out = await client.callToolStructured(
      'slow',
      {},
      { progressToken: 'token-cua-toi', onProgress: (p) => events.push(p) },
    );
    assert.deepEqual(events, [
      { progressToken: 'token-cua-toi', progress: 1, total: 2, message: 'dang lam 1/2' },
      { progressToken: 'token-cua-toi', progress: 2, total: 2, message: 'dang lam 2/2' },
    ]);
    assert.deepEqual(out.structuredContent, { count: 3, ok: true });
    assert.equal(out.structuredContentValid, true);
    assert.equal(out.text, 'xong\n[resource_link: Ket qua (fake://ket-qua)]');
    assert.equal(out.resourceLinks.length, 1);
    assert.equal(out.resourceLinks[0].uri, 'fake://ket-qua');
    assert.equal(out.resourceLinks[0].title, 'Ket qua');
    // Server thật sự nhận được token trong _meta của tools/call.
    const call = readLog().find((m) => m.method === 'tools/call' && m.params?.name === 'slow');
    assert.equal(call.params._meta.progressToken, 'token-cua-toi');

    // P0-4: không có onProgress thì client VẪN gửi progressToken tự sinh
    // (string không rỗng) — để server báo tiến độ cho idle timeout
    // (120s) phát hiện tool treo; hành vi cũ "không gửi _meta" đã bỏ.
    const before = readLog().length;
    await client.callTool('echo', { message: 'hi' });
    const echoCall = readLog().slice(before).find((m) => m.method === 'tools/call');
    assert.equal(typeof echoCall.params._meta?.progressToken, 'string');
    assert.ok(echoCall.params._meta.progressToken.length > 0);
    const events2 = [];
    await client.callTool('slow', {}, { onProgress: (p) => events2.push(p) });
    assert.equal(events2.length, 2);
    assert.equal(typeof events2[0].progressToken, 'string');
    assert.ok(events2[0].progressToken.length > 0);
    assert.equal(events2[0].progressToken, events2[1].progressToken);
  } finally {
    await client.close();
  }
});

test('stdio progress: onProgress ném lỗi không phá tool call', async () => {
  const { serverPath, logPath } = makeStdioServer();
  const client = await stdioClient(serverPath, logPath);
  try {
    const out = await client.callTool('slow', {}, {
      onProgress: () => {
        throw new Error('callback lỗi');
      },
    });
    assert.match(out, /^xong/);
  } finally {
    await client.close();
  }
});

test('stdio dispatcher end-to-end: elicitation được trả lời, method lạ -> -32601', async () => {
  const { serverPath, logPath } = makeStdioServer();
  const client = await stdioClient(serverPath, logPath);
  try {
    client.dispatcher.register('elicitation/create', () => ({
      action: 'accept',
      content: { name: 'Huy' },
    }));
    const out = await client.callTool('ask', {});
    assert.equal(out, 'elicit:accept:Huy;roots:-32601');
  } finally {
    await client.close();
  }
});

test('stdio cancellation: AbortSignal -> reject + server nhận notifications/cancelled', async () => {
  const { serverPath, logPath, readLog } = makeStdioServer();
  const client = await stdioClient(serverPath, logPath);
  try {
    const controller = new AbortController();
    const promise = client.callTool('never', {}, { signal: controller.signal });
    await sleep(50);
    controller.abort();
    await assert.rejects(promise, /đã bị huỷ/);
    await sleep(100); // chờ server ghi notifications/cancelled vào log
    // initialize = id 1, tools/call never = id 2.
    const cancelled = readLog().find((m) => m.method === 'notifications/cancelled');
    assert.ok(cancelled, 'server phải nhận notifications/cancelled');
    assert.equal(cancelled.params.requestId, 2);
    // Client vẫn sống sau khi huỷ: gọi tool khác bình thường.
    assert.equal(await client.callTool('echo', { message: 'sau-huy' }), 'Echo: sau-huy');
  } finally {
    await client.close();
  }
});

test('stdio cancellation: signal đã abort trước -> reject ngay, không gửi tools/call; cancelRequest trực tiếp', async () => {
  const { serverPath, logPath, readLog } = makeStdioServer();
  const client = await stdioClient(serverPath, logPath);
  try {
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      client.callTool('echo', { message: 'x' }, { signal: preAborted.signal }),
      /đã bị huỷ/,
    );
    assert.equal(readLog().filter((m) => m.method === 'tools/call').length, 0);

    // cancelRequest trực tiếp với id đang chờ.
    const pending = client.callTool('never', {});
    pending.catch(() => undefined); // tránh unhandled rejection
    await sleep(50);
    assert.equal(client.cancelRequest(999), false); // không có request 999
    assert.equal(client.cancelRequest(2), true); // initialize=1, tools/call=2
    await assert.rejects(pending, /đã bị huỷ/);
    await sleep(100); // chờ server ghi notifications/cancelled vào log
    const cancelled = readLog().find((m) => m.method === 'notifications/cancelled');
    assert.equal(cancelled.params.requestId, 2);
  } finally {
    await client.close();
  }
});

// --- Streamable HTTP integration -------------------------------------------
// Mock server in-process: tools/call slow trả SSE gồm 2 frame progress +
// 1 frame result; bad trả structuredContent sai schema; never treo máy.

function startMockHttpMcpServer() {
  const state = { received: [], hanging: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      state.received.push(msg);
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: obj }));
      };
      const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
      switch (msg.method) {
        case 'initialize':
          result({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'mock-http-v013', version: '0.1.0' } });
          break;
        case 'ping':
          result({});
          break;
        case 'tools/list':
          result({
            tools: [
              { name: 'slow', title: 'Chay cham HTTP', description: 'Tool HTTP chay lau',
                inputSchema: { type: 'object', properties: {} },
                outputSchema: { type: 'object', properties: { count: { type: 'integer' }, ok: { type: 'boolean' } }, required: ['count', 'ok'] },
                annotations: { readOnlyHint: true, destructiveHint: false },
                icons: [{ src: 'https://example.com/h.png', mimeType: 'image/png' }] },
              { name: 'bad', description: 'Tra structuredContent sai schema',
                inputSchema: { type: 'object', properties: {} } },
              { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
              { name: 'never', description: 'Khong bao gio tra loi', inputSchema: { type: 'object', properties: {} } },
            ],
          });
          break;
        case 'tools/call': {
          const name = msg.params?.name;
          if (name === 'echo') {
            result({ content: [{ type: 'text', text: `Echo: ${msg.params?.arguments?.message ?? ''}` }], isError: false });
            break;
          }
          if (name === 'slow') {
            const token = msg.params?._meta?.progressToken;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(frame({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'dang lam 1/2' } }));
            res.write(frame({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 2, total: 2, message: 'dang lam 2/2' } }));
            res.write(frame({ jsonrpc: '2.0', id: msg.id, result: {
              content: [{ type: 'text', text: 'xong http' }, { type: 'resource_link', uri: 'fake://ket-qua-http', name: 'ket-qua-http', title: 'Ket qua HTTP' }],
              structuredContent: { count: 5, ok: true }, isError: false,
            } }));
            res.end();
            break;
          }
          if (name === 'bad') {
            result({ content: [{ type: 'text', text: 'xau' }], structuredContent: { count: 'khong phai so' }, isError: false });
            break;
          }
          if (name === 'never') {
            state.hanging.push(res); // treo: không trả gì
            break;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } }));
          break;
        }
        default:
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        close: async () => {
          for (const res of state.hanging) {
            try {
              res.destroy();
            } catch { /* đã đóng */ }
          }
          server.closeAllConnections?.();
          await new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

test('http: progress qua SSE về đúng callback; structured + resource link; listTools có annotations', async () => {
  const mock = await startMockHttpMcpServer();
  const client = new StreamableHttpMcpClient({ name: 'mock-http', url: mock.url });
  try {
    await client.initialize();
    const tools = await client.listTools();
    const slow = tools.find((t) => t.name === 'slow');
    assert.equal(slow.title, 'Chay cham HTTP');
    assert.deepEqual(slow.annotations, { readOnlyHint: true, destructiveHint: false });
    assert.deepEqual(slow.icons, [{ src: 'https://example.com/h.png', mimeType: 'image/png' }]);

    const events = [];
    const out = await client.callToolStructured('slow', {}, { onProgress: (p) => events.push(p) });
    assert.equal(events.length, 2);
    assert.equal(events[0].progress, 1);
    assert.equal(events[1].progress, 2);
    assert.equal(events[0].total, 2);
    // Token ở notification khớp token client gửi trong _meta.
    const call = mock.state.received.find((m) => m.method === 'tools/call' && m.params?.name === 'slow');
    assert.equal(events[0].progressToken, call.params._meta.progressToken);
    assert.deepEqual(out.structuredContent, { count: 5, ok: true });
    assert.equal(out.text, 'xong http\n[resource_link: Ket qua HTTP (fake://ket-qua-http)]');
    assert.equal(out.resourceLinks[0].uri, 'fake://ket-qua-http');
  } finally {
    await client.close();
    await mock.close();
  }
});

test('http: structuredContent sai schema -> fallback text + lỗi ghi rõ', async () => {
  const mock = await startMockHttpMcpServer();
  const client = new StreamableHttpMcpClient({ name: 'mock-http', url: mock.url });
  try {
    await client.initialize();
    const out = await client.callToolStructured(
      'bad',
      {},
      { outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } },
    );
    assert.equal(out.structuredContent, undefined);
    assert.equal(out.structuredContentValid, false);
    assert.match(out.structuredContentError, /không khớp outputSchema/);
    assert.equal(out.text, 'xau');
  } finally {
    await client.close();
    await mock.close();
  }
});

test('http cancellation: AbortSignal -> reject + server nhận notifications/cancelled', async () => {
  const mock = await startMockHttpMcpServer();
  const client = new StreamableHttpMcpClient({ name: 'mock-http', url: mock.url });
  try {
    await client.initialize();
    const controller = new AbortController();
    const promise = client.callTool('never', {}, { signal: controller.signal });
    await sleep(50);
    controller.abort();
    await assert.rejects(promise, /đã bị huỷ/);
    await sleep(150); // chờ notification cancelled tới server (best-effort POST)
    const cancelled = mock.state.received.find((m) => m.method === 'notifications/cancelled');
    assert.ok(cancelled, 'server phải nhận notifications/cancelled');
    assert.equal(cancelled.params.requestId, 2); // initialize=1, tools/call=2
    assert.equal(await client.callTool('echo', { message: 'sau-huy' }), 'Echo: sau-huy');
  } finally {
    await client.close();
    await mock.close();
  }
});
