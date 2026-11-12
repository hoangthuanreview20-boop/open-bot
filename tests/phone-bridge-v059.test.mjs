/**
 * Tests for v0.59 — phone bridge thật (phoneBridge.ts + localBridge.ts):
 *   - `PhoneBridge` kiểm tra trạng thái pairing THẬT từ transport
 *     (mặc định: không có transport → chưa pair), rồi mới route lệnh.
 *   - Chưa pair → fail-closed `phone-not-connected`, transport KHÔNG
 *     bao giờ được gọi (không giả vờ thành công).
 *   - Đã pair (fake transport trong test) → gửi/đọc/mở app/truy vấn
 *     tool trả kết quả thật, transport nhận đúng toolId + input.
 *   - Tool ngoài allowlist bị chặn TRƯỚC transport (allowlist thắng);
 *     tool local (`read-file`) không được route qua phone bridge.
 *   - `SocketPhoneTransport`: đi qua Unix socket thật với một fake
 *     daemon socket server (protocol JSON-lines của open-bot); socket
 *     mất thì fail-closed (unpaired).
 *   - `read-ai-tool-setup` báo trạng thái pairing thật
 *     (`phoneConnected` / `phoneChannel`), không còn hằng false.
 *   - `handlers` map vẫn thắng bridge (back-compat với v0.53).
 *
 * No real phone, no real daemon: the paired phone here is a fake
 * transport; the socket daemon here is a fake local server. What is
 * REAL: the pairing check, the allowlist gate, the routing, and the
 * fail-closed behaviour — all of it runs through production code.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/phone-bridge-v059.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  NoPhoneTransport,
  PhoneBridge,
  SocketPhoneTransport,
  createLocalBridgeTools,
  createPhoneBridge,
  createPhoneToolHandlers,
  isPhoneOnlyTool,
} from '../packages/tools/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-p59-phone-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(workspaceDir, botId = 'bot-1') {
  return { workspaceDir, botId };
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool "${name}" must exist`);
  return tool;
}

async function runBridge(bridge, ws, args) {
  const out = await bridge.execute(args, ctx(ws));
  return JSON.parse(out);
}

/**
 * Fake transport: a "paired phone" in-process. Records every call so
 * the test can prove routing happened; returns canned-but-real
 * results (echoes the actual input back).
 */
class FakePhoneTransport {
  constructor({ paired = true, channel = 'fake-bluetooth', deviceName = "Huy's iPhone" } = {}) {
    this.id = 'fake';
    this.channel = channel;
    this.paired = paired;
    this.deviceName = deviceName;
    this.calls = [];
  }

  async getPairing() {
    return {
      paired: this.paired,
      channel: this.channel,
      ...(this.paired && this.deviceName ? { deviceName: this.deviceName } : {}),
      detail: this.paired ? 'Fake phone paired for test.' : 'Fake phone unpaired for test.',
    };
  }

  async callTool(toolId, input, c) {
    this.calls.push({ toolId, input, botId: c.botId });
    switch (toolId) {
      case 'send-imessage':
        return { ok: true, result: `iMessage sent to ${input.to}: ${input.body}` };
      case 'read-messages':
        return {
          ok: true,
          result: JSON.stringify([{ from: '+84111', body: 'hello from fake phone' }]),
        };
      case 'send-mail':
        return { ok: true, result: `Mail sent to ${input.to} (subject: ${input.subject})` };
      case 'use-app':
        return { ok: true, result: `Opened app "${input.app}" on the phone` };
      case 'run-phone-tool':
        return { ok: true, result: JSON.stringify({ tool: input.name, ran: true }) };
      default:
        return { ok: false, result: `Unknown fake tool ${toolId}`, reason: 'not-allowlisted' };
    }
  }
}

// ---------------------------------------------------------------------------
// 1. No bridge / no transport: fail-closed, honest "unavailable"
// ---------------------------------------------------------------------------

test('v0.59 phone bridge: no bridge → all 5 phone tools fail closed (phone-not-connected)', async () => {
  const ws = makeTempDir();
  const bridge = toolByName(createLocalBridgeTools({ workspaceDir: ws }), 'computer_local_tool');
  for (const [toolId, input, reasonMatch] of [
    ['send-imessage', { to: '+84123456789', body: 'hi' }, /No phone is paired/],
    ['read-messages', {}, /No phone is paired/],
    // send-mail has its own honest reason (no mail connector wired) — same fail-closed code.
    ['send-mail', { to: 'a@b.c', subject: 'hi', body: 'hello' }, /No mail connector is wired/],
    ['use-app', { app: 'Messages' }, /No phone.*bridge is connected/],
    ['run-phone-tool', { name: 'open-settings' }, /No phone is paired/],
  ]) {
    const out = await runBridge(bridge, ws, { tool_id: toolId, input_json: JSON.stringify(input) });
    assert.equal(out.ok, false, toolId);
    assert.equal(out.reason, 'phone-not-connected', toolId);
    assert.match(out.result, reasonMatch, toolId);
  }
});

test('v0.59 phone bridge: default PhoneBridge (NoPhoneTransport) reports unpaired, channel none', async () => {
  const bridge = createPhoneBridge();
  assert.equal(bridge.getTransportId(), 'none');
  const status = await bridge.getPairingStatus();
  assert.equal(status.paired, false);
  assert.equal(status.channel, 'none');
  assert.match(status.detail ?? '', /No phone bridge transport is configured/);
  const noPhone = new NoPhoneTransport();
  assert.deepEqual(await noPhone.getPairing(), await bridge.getPairingStatus());

  const ws = makeTempDir();
  const tool = toolByName(createLocalBridgeTools({ workspaceDir: ws, phoneBridge: bridge }), 'computer_local_tool');
  const out = await runBridge(tool, ws, {
    tool_id: 'send-imessage',
    input_json: JSON.stringify({ to: '+84123456789', body: 'hi' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'phone-not-connected');
});

// ---------------------------------------------------------------------------
// 2. Paired (fake transport): real routing end-to-end through the bridge
// ---------------------------------------------------------------------------

test('v0.59 phone bridge: paired fake transport → send/read/app/mail/tool return real results', async () => {
  const ws = makeTempDir();
  const fake = new FakePhoneTransport({ paired: true });
  const phoneBridge = new PhoneBridge(fake);
  const bridge = toolByName(
    createLocalBridgeTools({ workspaceDir: ws, phoneBridge }),
    'computer_local_tool',
  );

  const sent = await runBridge(bridge, ws, {
    tool_id: 'send-imessage',
    input_json: JSON.stringify({ to: '+84123456789', body: 'xin chao' }),
  });
  assert.equal(sent.ok, true);
  assert.match(sent.result, /iMessage sent to \+84123456789: xin chao/);

  const read = await runBridge(bridge, ws, {
    tool_id: 'read-messages',
    input_json: JSON.stringify({ peer: '+84111', limit: 5 }),
  });
  assert.equal(read.ok, true);
  assert.match(read.result, /hello from fake phone/);

  const app = await runBridge(bridge, ws, {
    tool_id: 'use-app',
    input_json: JSON.stringify({ app: 'Messages' }),
  });
  assert.equal(app.ok, true);
  assert.match(app.result, /Opened app "Messages" on the phone/);

  const mail = await runBridge(bridge, ws, {
    tool_id: 'send-mail',
    input_json: JSON.stringify({ to: 'a@b.c', subject: 'hi', body: 'hello' }),
  });
  assert.equal(mail.ok, true);
  assert.match(mail.result, /Mail sent to a@b\.c \(subject: hi\)/);

  const ran = await runBridge(bridge, ws, {
    tool_id: 'run-phone-tool',
    input_json: JSON.stringify({ name: 'open-settings', args: {} }),
  });
  assert.equal(ran.ok, true);
  assert.match(ran.result, /"tool":"open-settings"/);

  // Routing proof: the transport saw all 5 calls, with the real inputs.
  assert.equal(fake.calls.length, 5);
  assert.deepEqual(
    fake.calls.map((c) => c.toolId),
    ['send-imessage', 'read-messages', 'use-app', 'send-mail', 'run-phone-tool'],
  );
  assert.equal(fake.calls[0].input.to, '+84123456789');
  assert.equal(fake.calls[0].input.body, 'xin chao');
  assert.equal(fake.calls[0].botId, 'bot-1');
  assert.equal(fake.calls[1].input.limit, 5);
});

test('v0.59 phone bridge: read-ai-tool-setup reports the REAL pairing state', async () => {
  const ws = makeTempDir();
  const noBridge = toolByName(createLocalBridgeTools({ workspaceDir: ws }), 'computer_local_tool');
  const setupNone = JSON.parse(
    JSON.parse(await noBridge.execute({ tool_id: 'read-ai-tool-setup', input_json: '{}' }, ctx(ws))).result,
  );
  assert.equal(setupNone.phoneConnected, false);
  assert.equal(setupNone.phoneChannel, 'none');

  const fake = new FakePhoneTransport({ paired: true, channel: 'fake-bluetooth', deviceName: "Huy's iPhone" });
  const withBridge = toolByName(
    createLocalBridgeTools({ workspaceDir: ws, phoneBridge: new PhoneBridge(fake) }),
    'computer_local_tool',
  );
  const setupPaired = JSON.parse(
    JSON.parse(await withBridge.execute({ tool_id: 'read-ai-tool-setup', input_json: '{}' }, ctx(ws))).result,
  );
  assert.equal(setupPaired.phoneConnected, true);
  assert.equal(setupPaired.phoneChannel, 'fake-bluetooth');
  assert.equal(setupPaired.phoneDeviceName, "Huy's iPhone");
});

// ---------------------------------------------------------------------------
// 3. Unpaired transport: fail-closed, transport.callTool never runs
// ---------------------------------------------------------------------------

test('v0.59 phone bridge: unpaired fake transport → fail-closed, transport never called', async () => {
  const ws = makeTempDir();
  const fake = new FakePhoneTransport({ paired: false });
  const phoneBridge = new PhoneBridge(fake);
  const status = await phoneBridge.getPairingStatus();
  assert.equal(status.paired, false);
  assert.equal(status.channel, 'fake-bluetooth');

  const bridge = toolByName(
    createLocalBridgeTools({ workspaceDir: ws, phoneBridge }),
    'computer_local_tool',
  );
  const out = await runBridge(bridge, ws, {
    tool_id: 'send-imessage',
    input_json: JSON.stringify({ to: '+84123456789', body: 'hi' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'phone-not-connected');
  assert.match(out.result, /no phone is paired/i);
  assert.equal(fake.calls.length, 0, 'unpaired: transport.callTool must never run');
});

// ---------------------------------------------------------------------------
// 4. Allowlist: blocked BEFORE the transport; local tools stay local
// ---------------------------------------------------------------------------

test('v0.59 phone bridge: tool ngoài allowlist bị chặn trước transport; tool local không qua bridge', async () => {
  const ws = makeTempDir();
  const fake = new FakePhoneTransport({ paired: true });
  const phoneBridge = new PhoneBridge(fake);
  const bridge = toolByName(
    createLocalBridgeTools({ workspaceDir: ws, phoneBridge }),
    'computer_local_tool',
  );
  const out = await bridge.execute(
    { tool_id: 'format-disk', input_json: '{}' },
    ctx(ws),
  );
  assert.match(out, /Error: Unknown local tool "format-disk"/);
  assert.match(out, /not on the daemon phone-tool allowlist/);
  assert.equal(fake.calls.length, 0, 'allowlist refusal must not reach the transport');

  // Direct bridge call, same gate (bridge re-checks, handlers cannot bypass it).
  const blocked = await phoneBridge.callTool('format-disk', {}, {
    workspaceDir: ws,
    botId: 'bot-1',
    imageUploads: [],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'not-allowlisted');
  assert.equal(fake.calls.length, 0);

  const local = await phoneBridge.callTool('read-file', { path: 'x.txt' }, {
    workspaceDir: ws,
    botId: 'bot-1',
    imageUploads: [],
  });
  assert.equal(local.ok, false);
  assert.equal(local.reason, 'not-a-phone-tool');
  assert.equal(fake.calls.length, 0);

  assert.equal(isPhoneOnlyTool('send-imessage'), true);
  assert.equal(isPhoneOnlyTool('read-file'), false);
});

// ---------------------------------------------------------------------------
// 5. Handlers map: bridge-backed handlers + precedence (back-compat)
// ---------------------------------------------------------------------------

test('v0.59 phone bridge: createPhoneToolHandlers routes through the bridge; handlers map wins', async () => {
  const ws = makeTempDir();
  const fake = new FakePhoneTransport({ paired: true });
  const phoneBridge = new PhoneBridge(fake);
  const handlers = createPhoneToolHandlers(phoneBridge);
  assert.equal(typeof handlers['send-imessage'], 'function');
  assert.equal(typeof handlers['read-messages'], 'function');

  const viaHandlers = toolByName(
    createLocalBridgeTools({ workspaceDir: ws, handlers }),
    'computer_local_tool',
  );
  const sent = await runBridge(viaHandlers, ws, {
    tool_id: 'send-imessage',
    input_json: JSON.stringify({ to: '+84999', body: 'via handlers' }),
  });
  assert.equal(sent.ok, true);
  assert.match(sent.result, /iMessage sent to \+84999/);
  assert.equal(fake.calls.length, 1);

  // Missing required field is refused before the bridge.
  const bad = await viaHandlers.execute(
    { tool_id: 'send-imessage', input_json: JSON.stringify({ to: '+84999' }) },
    ctx(ws),
  );
  assert.match(bad, /Error: input_json needs a non-empty string "body"/);
  assert.equal(fake.calls.length, 1, 'validation failure must not reach the transport');

  // An explicit handler in the map wins over the bridge.
  const withOverride = toolByName(
    createLocalBridgeTools({
      workspaceDir: ws,
      phoneBridge,
      handlers: {
        'send-mail': async (input) => ({ ok: true, result: `custom mailer to ${input.to}` }),
      },
    }),
    'computer_local_tool',
  );
  const mail = await runBridge(withOverride, ws, {
    tool_id: 'send-mail',
    input_json: JSON.stringify({ to: 'a@b.c', subject: 'hi', body: 'hello' }),
  });
  assert.match(mail.result, /custom mailer to a@b\.c/);
  assert.equal(fake.calls.length, 1, 'override handler must not touch the bridge');
});

// ---------------------------------------------------------------------------
// 6. Socket transport: real Unix socket against a fake daemon server
// ---------------------------------------------------------------------------

function startFakeSocketDaemon() {
  const sockPath = path.join(os.tmpdir(), `open-bot-phone-bridge-${process.pid}.sock`);
  try {
    fs.rmSync(sockPath, { force: true });
  } catch {
    /* ignore */
  }
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      if (req.type === 'pairing') {
        socket.write(
          `${JSON.stringify({ paired: true, channel: 'socket', deviceName: 'Socket Test Phone' })}\n`,
        );
      } else if (req.type === 'tool') {
        socket.write(
          `${JSON.stringify({ ok: true, result: `socket-tool:${req.toolId}:${JSON.stringify(req.input)}` })}\n`,
        );
      }
    });
  });
  return { sockPath, server };
}

test('v0.59 phone bridge: SocketPhoneTransport — pair + send qua socket thật với fake daemon', async () => {
  const { sockPath, server } = startFakeSocketDaemon();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  try {
    const bridge = new PhoneBridge(new SocketPhoneTransport({ socketPath: sockPath }));
    const status = await bridge.getPairingStatus();
    assert.equal(status.paired, true);
    assert.equal(status.channel, 'socket');
    assert.equal(status.deviceName, 'Socket Test Phone');

    const ws = makeTempDir();
    const tool = toolByName(
      createLocalBridgeTools({ workspaceDir: ws, phoneBridge: bridge }),
      'computer_local_tool',
    );
    const out = await runBridge(tool, ws, {
      tool_id: 'send-imessage',
      input_json: JSON.stringify({ to: '+84123456789', body: 'via socket' }),
    });
    assert.equal(out.ok, true);
    assert.match(out.result, /socket-tool:send-imessage/);
    assert.match(out.result, /via socket/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(sockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test('v0.59 phone bridge: SocketPhoneTransport — socket mất thì unpaired, fail-closed, không throw', async () => {
  const missingPath = path.join(os.tmpdir(), `open-bot-phone-bridge-missing-${process.pid}.sock`);
  const bridge = new PhoneBridge(new SocketPhoneTransport({ socketPath: missingPath, timeoutMs: 1000 }));
  const status = await bridge.getPairingStatus();
  assert.equal(status.paired, false);
  assert.equal(status.channel, 'socket');
  assert.match(status.detail ?? '', /unreachable/);
  const out = await bridge.callTool('send-imessage', { to: '+84', body: 'hi' }, {
    workspaceDir: makeTempDir(),
    botId: 'bot-1',
    imageUploads: [],
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'phone-not-connected');
});
