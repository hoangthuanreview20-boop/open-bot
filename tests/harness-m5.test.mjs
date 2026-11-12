/**
 * Tests cho M5 — Harness local chuẩn hoá (registry + event bus +
 * NDJSON log + snapshot atomic + permission broker).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   xvfb-run -a node --test tests/harness-m5.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: registry kill test dùng process `sleep` spawn từ test;
 * broker/ACP/Codex test dùng fake CLI trong tests/fixtures/ (như
 * M1–M3); coordinator test dùng mock provider + thư mục tạm. Secret
 * giả chỉ xuất hiện trong payload test để chứng minh log redact được
 * chúng — không bao giờ là key thật.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AgentCoordinator,
  HarnessEventBus,
  HarnessRegistry,
  LocalHarness,
  PermissionBroker,
  ThreadLog,
  readHarnessSnapshot,
  sanitizeHarnessPayload,
  writeHarnessSnapshotAtomic,
} from '../packages/core/dist/index.js';
import { AcpClient } from '../packages/core/dist/providers/cli/index.js';
import { CodexCliProvider } from '../packages/core/dist/providers/cli/index.js';
import { createApiServer } from '../packages/core/dist/api/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-m5-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FAKE_ACP_') || key.startsWith('FAKE_CODEX_') || key.startsWith('FAKE_CLAUDE_')) {
      delete process.env[key];
    }
  }
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitUntil(fn, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

function installFakeBin(binDir, fixtureName, binaryName) {
  const dest = path.join(binDir, binaryName);
  fs.copyFileSync(path.join(fixturesDir, fixtureName), dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function makeBinDir(binaries) {
  const dir = makeTempDir();
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [fixture, name] of binaries) installFakeBin(binDir, fixture, name);
  return { dir, binDir };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('M5 registry: đăng ký/liệt kê/tìm theo botId/chống trùng/gỡ', () => {
  const registry = new HarnessRegistry();
  const a = registry.register({
    botId: 'bot-a',
    engine: 'claude',
    providerId: 'claude-code',
    pid: 111,
    kill: () => undefined,
  });
  assert.equal(a.botId, 'bot-a');
  assert.equal(a.status, 'starting');
  assert.equal(a.pid, 111);
  assert.equal(registry.size, 1);
  assert.equal(registry.getByBotId('bot-a')?.instanceId, a.instanceId);
  assert.equal(registry.hasLive('bot-a'), true);
  assert.equal(registry.getByBotId('bot-nope'), undefined);
  // Đăng ký trùng bot đang sống -> throw (chống spawn trùng process).
  assert.throws(
    () =>
      registry.register({ botId: 'bot-a', engine: 'claude', providerId: 'claude-code', kill: () => undefined }),
    /đã có instance sống/,
  );
  registry.touch(a.instanceId);
  assert.equal(registry.get(a.instanceId)?.status, 'running');
  registry.updateStatus(a.instanceId, 'idle');
  assert.equal(registry.get(a.instanceId)?.status, 'idle');
  assert.equal(registry.unregisterByBotId('bot-a'), true);
  assert.equal(registry.hasLive('bot-a'), false);
  assert.equal(registry.unregisterByBotId('bot-a'), false);
  // Đăng ký lại sau khi gỡ thì được.
  registry.register({ botId: 'bot-a', engine: 'codex', providerId: 'codex', kill: () => undefined });
  assert.equal(registry.size, 1);
});

test('M5 registry shutdownAll: kill sạch process còn sống, kill lỗi thì ghi failed không throw', async () => {
  const registry = new HarnessRegistry();
  const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  assert.ok(isAlive(sleeper.pid));
  let killedFlag = false;
  registry.register({
    botId: 'bot-sleep',
    engine: 'mock',
    providerId: 'mock',
    pid: sleeper.pid,
    kill: () => {
      killedFlag = true;
      try {
        process.kill(-sleeper.pid, 'SIGKILL');
      } catch {
        sleeper.kill('SIGKILL');
      }
    },
  });
  registry.register({
    botId: 'bot-broken',
    engine: 'mock',
    providerId: 'mock',
    kill: () => {
      throw new Error('kill hỏng giả lập');
    },
  });
  const res = await registry.shutdownAll();
  assert.equal(res.killed, 1);
  assert.equal(res.failed.length, 1);
  assert.equal(killedFlag, true);
  assert.equal(registry.size, 0);
  assert.equal(await waitUntil(() => !isAlive(sleeper.pid)), true);
});

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

test('M5 bus: fan-in, lọc theo botId/kind/engine, unsubscribe, handler lỗi không hỏng bus', () => {
  const bus = new HarnessEventBus();
  const seenAll = [];
  const seenBotA = [];
  const seenText = [];
  const unsubAll = bus.subscribe({}, (e) => seenAll.push(e));
  bus.subscribe({ botId: 'bot-a' }, (e) => seenBotA.push(e));
  bus.subscribe({ kinds: ['text'] }, (e) => seenText.push(e));
  bus.subscribe({ engine: 'codex' }, () => {
    throw new Error('handler hỏng giả lập');
  });
  const ev1 = bus.publishCliEvent('inst-1', 'bot-a', 'bot-a', 'claude', { type: 'text', delta: 'chào' });
  assert.equal(ev1.kind, 'text');
  assert.equal(ev1.payload.delta, 'chào');
  assert.equal(typeof ev1.at, 'string');
  bus.publishCliEvent('inst-2', 'bot-b', 'bot-b', 'codex', { type: 'result', text: 'xong' });
  bus.publishCliEvent('inst-1', 'bot-a', 'bot-a', 'claude', {
    type: 'approval_denied',
    method: 'execCommandApproval',
    detail: 'tool=rm',
  });
  assert.equal(bus.totalPublished, 3);
  assert.equal(seenAll.length, 3);
  assert.equal(seenBotA.length, 2);
  assert.equal(seenText.length, 1);
  assert.equal(bus.totalHandlerErrors, 1);
  unsubAll();
  bus.publishCliEvent('inst-1', 'bot-a', 'bot-a', 'claude', { type: 'text', delta: 'nữa' });
  assert.equal(seenAll.length, 3);
  assert.equal(seenBotA.length, 3);
});

test('M5 bus: map CliEvent -> kind chuẩn (aborted -> abort, approval_request giữ nguyên)', () => {
  const bus = new HarnessEventBus();
  const kinds = [];
  bus.subscribe({}, (e) => kinds.push(e.kind));
  bus.publishCliEvent('i', 'b', 'b', 'codex', { type: 'aborted' });
  bus.publishCliEvent('i', 'b', 'b', 'codex', { type: 'approval_request', method: 'm', detail: 'd' });
  bus.publishCliEvent('i', 'b', 'b', 'codex', { type: 'tool_call', call: { id: 'c1', name: 'rm', args: { path: '/tmp/x' } } });
  assert.deepEqual(kinds, ['abort', 'approval_request', 'tool_call']);
});

// ---------------------------------------------------------------------------
// NDJSON log
// ---------------------------------------------------------------------------

test('M5 ndjson: ghi/đọc/phân trang/lọc kind, dòng hỏng bỏ qua', () => {
  const dir = makeTempDir();
  const log = new ThreadLog(path.join(dir, 'logs'));
  log.append({ at: '2026-11-09T00:00:00.000Z', botId: 'bot-1', threadId: 'thread-1', kind: 'text', payload: { delta: 'a' } });
  log.append({ at: '2026-11-09T00:00:01.000Z', botId: 'bot-1', threadId: 'thread-1', kind: 'result', payload: { text: 'b' } });
  log.append({ at: '2026-11-09T00:00:02.000Z', botId: 'bot-1', threadId: 'thread-1', kind: 'text', payload: { delta: 'c' } });
  // Dòng hỏng chèn tay vào file.
  fs.appendFileSync(path.join(dir, 'logs', 'thread-1.ndjson'), 'không phải json\n');
  const page = log.read('thread-1', { limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[0].kind, 'result');
  const onlyText = log.read('thread-1', { kinds: ['text'] });
  assert.equal(onlyText.total, 2);
  assert.deepEqual(log.listThreads(), ['thread-1']);
  assert.equal(log.read('thread-chua-co').total, 0);
});

test('M5 ndjson redact: secret key/Bearer/chuỗi dài/tool args value không lọt log', () => {
  const payload = sanitizeHarnessPayload('result', {
    text: 'key thật là sk-fake-1234567890 và header Authorization: Bearer tok-fake-abcdef',
    apiKey: 'sk-fake-1234567890',
    inputTokens: 60,
    outputTokens: 18,
    nested: { password: 'pw-fake-xyz', ok: 'giữ' },
  });
  assert.equal(payload.apiKey, '<redacted>');
  assert.equal(payload.nested.password, '<redacted>');
  assert.equal(payload.inputTokens, 60);
  assert.equal(payload.outputTokens, 18);
  assert.match(payload.text, /Bearer <redacted>/);
  assert.doesNotMatch(payload.text, /sk-fake-1234567890/);
  assert.doesNotMatch(payload.text, /tok-fake-abcdef/);

  const tool = sanitizeHarnessPayload('tool_call', {
    callId: 'c1',
    tool: 'read_file',
    argKeys: ['path', 'apiKey'],
  });
  // tool_call chỉ giữ tên tool + tên key, không value.
  assert.deepEqual(tool, { callId: 'c1', tool: 'read_file', argKeys: ['path', 'apiKey'] });

  const long = sanitizeHarnessPayload('text', { delta: 'x'.repeat(5000) });
  assert.ok(long.delta.length <= 2010);
  assert.match(long.delta, /cắt ngắn/);
});

test('M5 ndjson xoay file: vượt maxFileBytes thì xoay, file cũ vẫn đọc được', () => {
  const dir = makeTempDir();
  const log = new ThreadLog(path.join(dir, 'logs'), { maxFileBytes: 200, maxTotalBytes: 100000 });
  for (let i = 0; i < 10; i += 1) {
    log.append({
      at: new Date().toISOString(),
      botId: 'bot-1',
      threadId: 'thread-rot',
      kind: 'text',
      payload: { delta: `dòng ${i} `.repeat(10) },
    });
  }
  const files = fs.readdirSync(path.join(dir, 'logs'));
  assert.ok(files.length >= 2, `cần ít nhất 2 file sau xoay, có: ${files.join(',')}`);
  const page = log.read('thread-rot');
  assert.equal(page.total, 10);
});

// ---------------------------------------------------------------------------
// Snapshot atomic
// ---------------------------------------------------------------------------

test('M5 snapshot: ghi atomic + đọc lại, file hỏng thì fallback rỗng kèm warning', () => {
  const dir = makeTempDir();
  const snapshot = {
    version: 1,
    savedAt: '2026-11-09T00:00:00.000Z',
    engines: { claude: { status: 'available', label: 'Claude Code' } },
    instances: [
      {
        instanceId: 'i1',
        botId: 'bot-1',
        engine: 'claude',
        providerId: 'claude-code',
        status: 'running',
        startedAt: '2026-11-09T00:00:00.000Z',
        lastEventAt: '2026-11-09T00:00:00.000Z',
      },
    ],
  };
  const target = writeHarnessSnapshotAtomic(dir, snapshot);
  assert.equal(target, path.join(dir, 'harness-snapshot.json'));
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0);
  const read = readHarnessSnapshot(dir);
  assert.equal(read.warning, undefined);
  assert.equal(read.snapshot.instances[0].botId, 'bot-1');
  assert.equal(read.snapshot.engines.claude.status, 'available');

  const missing = readHarnessSnapshot(path.join(dir, 'chua-co'));
  assert.equal(missing.snapshot, null);
  assert.match(missing.warning, /chưa có snapshot/);

  const badDir = makeTempDir();
  fs.writeFileSync(path.join(badDir, 'harness-snapshot.json'), '{ json hỏng');
  const bad = readHarnessSnapshot(badDir);
  assert.equal(bad.snapshot, null);
  assert.match(bad.warning, /hỏng/);
});

// ---------------------------------------------------------------------------
// Permission broker
// ---------------------------------------------------------------------------

test('M5 broker: mặc định từ chối khi không có UI, ghi log quyết định', async () => {
  const broker = new PermissionBroker();
  const allowed = await broker.request({ botId: 'bot-1', engine: 'grok-cli', method: 'session/request_permission' });
  assert.equal(allowed, false);
  const decisions = broker.listDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].allowed, false);
  assert.equal(decisions[0].source, 'default-deny');
  assert.equal(broker.pendingCount, 0);
});

test('M5 broker: UI cho phép qua uiHandler, UI từ chối qua uiHandler', async () => {
  const allow = new PermissionBroker({ uiHandler: async () => true });
  assert.equal(await allow.request({ botId: 'b', engine: 'grok-cli', method: 'm' }), true);
  assert.equal(allow.listDecisions()[0].source, 'ui');
  assert.equal(allow.listDecisions()[0].allowed, true);

  const deny = new PermissionBroker({ uiHandler: () => false });
  assert.equal(await deny.request({ botId: 'b', engine: 'grok-cli', method: 'm' }), false);
  assert.equal(deny.listDecisions()[0].allowed, false);
});

test('M5 broker: timeout -> từ chối, không treo (request resolve trong timeoutMs)', async () => {
  const broker = new PermissionBroker({
    timeoutMs: 60,
    uiHandler: () => new Promise(() => undefined), // UI không bao giờ trả lời.
  });
  const start = Date.now();
  const allowed = await broker.request({ botId: 'b', engine: 'grok-cli', method: 'm' });
  assert.equal(allowed, false);
  assert.ok(Date.now() - start < 5000);
  assert.equal(broker.listDecisions()[0].source, 'timeout');
});

test('M5 broker: decide() thắng uiHandler đang chờ; decide() request lạ trả false', async () => {
  const broker = new PermissionBroker({
    timeoutMs: 5000,
    uiHandler: () => new Promise(() => undefined),
  });
  assert.equal(broker.decide('khong-co', true), false);
  const promise = broker.request({ botId: 'b', engine: 'grok-cli', method: 'm' });
  assert.equal(await waitUntil(() => broker.pendingCount === 1), true);
  const [pending] = broker.listPending();
  assert.equal(broker.decide(pending.requestId, true, 'user bấm Allow trên thẻ.'), true);
  assert.equal(await promise, true);
  assert.equal(broker.listDecisions()[0].reason, 'user bấm Allow trên thẻ.');
});

test('M5 broker: denyAll từ chối request đang chờ; allowable=false từ chối ngay không hỏi UI', async () => {
  let uiAsked = 0;
  const broker = new PermissionBroker({
    timeoutMs: 5000,
    uiHandler: () => {
      uiAsked += 1;
      return new Promise(() => undefined);
    },
  });
  const promise = broker.request({ botId: 'b', engine: 'codex', method: 'execCommandApproval', allowable: false });
  assert.equal(await promise, false);
  assert.equal(uiAsked, 0);
  assert.equal(broker.listDecisions()[0].source, 'allow-not-supported');

  const promise2 = broker.request({ botId: 'b', engine: 'grok-cli', method: 'm' });
  assert.equal(await waitUntil(() => broker.pendingCount === 1), true);
  assert.equal(broker.denyAll('b'), 1);
  assert.equal(await promise2, false);
  assert.equal(broker.listDecisions().at(-1).source, 'shutdown');
});

// ---------------------------------------------------------------------------
// LocalHarness facade
// ---------------------------------------------------------------------------

test('M5 harness: attach provider -> bus + log NDJSON, trùng bot throw, unregister, snapshot, shutdown', async () => {
  const dir = makeTempDir();
  const harness = new LocalHarness({ dataDir: dir });
  const busEvents = [];
  harness.bus.subscribe({}, (e) => busEvents.push(e));
  let disposed = false;
  let sink = null;
  let permHandler = null;
  const fakeProvider = {
    id: 'claude-code',
    dispose: () => {
      disposed = true;
    },
    cliPid: 4242,
    attachHarnessSink: (s) => {
      sink = s;
    },
    attachPermissionHandler: (h) => {
      permHandler = h;
    },
  };
  const snap = harness.attachToProvider('bot-h', fakeProvider, { engine: 'claude', threadId: 'bot-h' });
  assert.equal(snap.pid, 4242);
  assert.equal(snap.botId, 'bot-h');
  // v0.60: gắn lại ĐÚNG provider đã đăng ký (re-attach) thì trả snapshot
  // hiện có, không throw, không gắn sink lần nữa (không nhân đôi event).
  const sinkBefore = sink;
  const reattached = harness.attachToProvider('bot-h', fakeProvider, { engine: 'claude' });
  assert.equal(reattached.instanceId, snap.instanceId, 're-attach trả đúng instance đã có');
  assert.equal(harness.registry.size, 1, 'không nhân đôi instance');
  assert.equal(sink, sinkBefore, 're-attach không gắn sink lần nữa');
  // Provider KHÁC (object khác, cùng providerId/engine) cho bot đang
  // sống thì vẫn throw — chống spawn trùng; thay provider phải
  // reregister/unregister trước.
  assert.throws(
    () => harness.attachToProvider('bot-h', { ...fakeProvider }, { engine: 'claude' }),
    /đã có instance sống/,
  );
  // Engine khác cũng vẫn throw.
  assert.throws(
    () => harness.attachToProvider('bot-h', { id: 'codex', dispose: () => undefined }, { engine: 'codex' }),
    /đã có instance sống/,
  );
  assert.ok(typeof sink === 'function');
  sink({ type: 'text', delta: 'xin chào' });
  sink({ type: 'tool_call', call: { id: 'c1', name: 'read_file', args: { path: '/tmp/secret.txt', token: 'tok-fake' } } });
  assert.equal(busEvents.length, 2);
  assert.equal(busEvents[0].kind, 'text');
  assert.equal(busEvents[1].kind, 'tool_call');
  const page = harness.readThreadLog('bot-h');
  assert.equal(page.total, 2);
  assert.doesNotMatch(JSON.stringify(page.entries), /tok-fake/);
  assert.doesNotMatch(JSON.stringify(page.entries), /secret\.txt/);

  // Permission qua handler đã gắn: không UI -> từ chối ngay.
  assert.ok(typeof permHandler === 'function');
  assert.equal(await permHandler({ method: 'session/request_permission', detail: 'tool=x', allowable: true }), false);

  const saved = harness.saveSnapshot({ claude: { status: 'available' } });
  assert.equal(saved, path.join(dir, 'harness-snapshot.json'));
  const loaded = harness.loadSnapshot();
  assert.equal(loaded.snapshot.instances[0].botId, 'bot-h');

  const status = harness.harnessStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.instances.length, 1);

  assert.equal(harness.unregisterBot('bot-h'), true);
  assert.equal(harness.registry.size, 0);
  const res = await harness.shutdownAll();
  assert.equal(res.killed, 0);
  assert.equal(disposed, false); // unregister không kill; shutdownAll sau đó không còn instance.
});

test('M5 harness shutdownAll: kill provider qua dispose khi còn instance sống', async () => {
  const harness = new LocalHarness();
  let disposed = false;
  harness.attachToProvider('bot-k', { id: 'mock', dispose: () => { disposed = true; } }, { engine: 'mock' });
  const res = await harness.shutdownAll();
  assert.equal(res.killed, 1);
  assert.equal(disposed, true);
  assert.equal(harness.registry.size, 0);
});

// ---------------------------------------------------------------------------
// Broker -> driver thật (fake CLI): ACP cho phép, Codex vẫn từ chối
// ---------------------------------------------------------------------------

test('M5 ACP + broker: user cho phép -> chọn opt-allow, event approval_request xuất hiện', async () => {
  const { binDir } = makeBinDir([['fake-acp-generic.mjs', 'mycli']]);
  const approvalLog = path.join(makeTempDir(), 'approval.log');
  process.env.FAKE_ACP_MODE = 'approval';
  process.env.FAKE_ACP_APPROVAL_LOG = approvalLog;
  const child = spawn(path.join(binDir, 'mycli'), ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  try {
    const events = [];
    const broker = new PermissionBroker({ uiHandler: async () => true });
    const client = new AcpClient(child, {
      onCliEvent: (e) => events.push(e),
      permissionHandler: (req) => broker.request({ botId: 'bot-acp', engine: 'grok-cli', method: req.method, detail: req.detail, allowable: req.allowable }),
    });
    await client.initialize();
    const sessionId = await client.newSession({});
    const result = await client.prompt(sessionId, ['do a risky thing']);
    assert.match(result.text, /Fake reply/);
    assert.equal(result.approvalsDenied, 0);
    assert.ok(events.some((e) => e.type === 'approval_request'));
    assert.equal(events.some((e) => e.type === 'approval_denied'), false);
    const lines = readLines(approvalLog);
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    assert.equal(response.result.outcome.outcome, 'selected');
    assert.equal(response.result.outcome.optionId, 'opt-allow');
    assert.equal(broker.listDecisions()[0].allowed, true);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Đã chết.
    }
  }
});

test('M5 Codex + broker: broker hỏi nhưng shape allow chưa rõ -> vẫn deny decline, log ghi allow-not-supported', async () => {
  const { dir, binDir } = makeBinDir([['fake-codex.mjs', 'codex']]);
  const approvalLog = path.join(dir, 'approval.log');
  process.env.FAKE_CODEX_MODE = 'approval';
  process.env.FAKE_CODEX_APPROVAL_LOG = approvalLog;
  const events = [];
  const broker = new PermissionBroker({ uiHandler: async () => true });
  const provider = new CodexCliProvider(
    { label: 'Codex (CLI)' },
    {
      binaryPath: path.join(binDir, 'codex'),
      // Env fake phải được allowlist (sanitizeEnvForCli chặn mọi biến
      // khác) — như M2 (CODEX_FAKE_ENV).
      extraEnvAllowed: ['CODEX_HOME', 'FAKE_CODEX_MODE', 'FAKE_CODEX_APPROVAL_LOG'],
      onCliEvent: (e) => events.push(e),
      permissionHandler: (req) => broker.request({ botId: 'bot-codex', engine: 'codex', method: req.method, detail: req.detail, allowable: req.allowable }),
    },
  );
  try {
    const res = await provider.chat({ model: 'codex', messages: [{ role: 'user', content: 'xoá file giúp tôi' }] });
    assert.match(res.text, /Fake reply to: xoá file/);
    const logged = readLines(approvalLog);
    assert.equal(logged.length, 1);
    const response = JSON.parse(logged[0]);
    assert.deepEqual(response.result, { decision: 'decline' });
    assert.equal(provider.approvalsDeniedTotal, 1);
    assert.ok(events.some((e) => e.type === 'approval_request'));
    assert.ok(events.some((e) => e.type === 'approval_denied'));
    assert.equal(broker.listDecisions()[0].source, 'allow-not-supported');
    assert.equal(broker.listDecisions()[0].allowed, false);
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Coordinator wiring
// ---------------------------------------------------------------------------

function makeCoordinatorWithHarness(botId, dir, harness) {
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    emit: () => undefined,
    harness,
  });
  const bot = {
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'mock',
    model: 'mock-old',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
  };
  return { coordinator, bot };
}

test('M5 coordinator: createBot đăng ký harness, destroyBot gỡ, switchModel đăng ký lại, RPC harness*', async () => {
  const dir = makeTempDir();
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const { coordinator, bot } = makeCoordinatorWithHarness('bot-coord', dir, harness);
  try {
    await coordinator.createBot({
      bot,
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-old', mockResponses: [{ text: 'hi' }] },
    });
    const status = await coordinator.handle('harnessStatus', {});
    assert.equal(status.enabled, true);
    assert.equal(status.instances.length, 1);
    assert.equal(status.instances[0].botId, 'bot-coord');
    assert.equal(status.instances[0].providerId, 'mock');

    // Log thread trống (mock provider không emit CliEvent).
    const logPage = await coordinator.handle('harnessThreadLog', { threadId: 'bot-coord' });
    assert.equal(logPage.total, 0);

    // Decide request lạ -> found false.
    const decided = await coordinator.handle('harnessDecidePermission', { requestId: 'khong-co', allowed: true });
    assert.deepEqual(decided, { requestId: 'khong-co', found: false });

    // switchModel mock -> mock: registry đăng ký lại provider mới, vẫn 1 instance.
    const switched = coordinator.switchModel({
      botId: 'bot-coord',
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-new' },
    });
    assert.equal(switched.applied, true);
    assert.equal(harness.registry.size, 1);
    assert.equal(harness.registry.getByBotId('bot-coord')?.providerId, 'mock');

    coordinator.destroyBot({ botId: 'bot-coord' });
    assert.equal(harness.registry.size, 0);
    const after = await coordinator.handle('harnessStatus', {});
    assert.equal(after.instances.length, 0);
  } finally {
    coordinator.shutdown();
  }
});

test('M5 coordinator không có harness: harnessStatus trả enabled=false, không throw', async () => {
  const dir = makeTempDir();
  const { coordinator, bot } = makeCoordinatorWithHarness('bot-noharness', dir, undefined);
  try {
    await coordinator.createBot({
      bot,
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-old', mockResponses: [{ text: 'hi' }] },
    });
    const status = await coordinator.handle('harnessStatus', {});
    assert.equal(status.enabled, false);
    assert.deepEqual(status.instances, []);
    const logPage = await coordinator.handle('harnessThreadLog', { threadId: 'bot-noharness' });
    assert.equal(logPage.total, 0);
  } finally {
    coordinator.destroyBot({ botId: 'bot-noharness' });
    coordinator.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Local API wiring
// ---------------------------------------------------------------------------

const API_TOKEN = 'm5-test-token-0123456789abcdef';

function apiHandlers(overrides = {}) {
  return {
    listBots: async () => [{ id: 'bot-1', name: 'Bot 1', providerId: 'mock', model: 'mock' }],
    runBot: async (_botId, text) => ({ text: `echo: ${text}` }),
    getHistory: async () => [],
    listTasks: async () => [],
    ...overrides,
  };
}

async function apiReq(server, p, opts = {}) {
  return fetch(`http://127.0.0.1:${server.port}${p}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${API_TOKEN}` },
  });
}

test('M5 Local API: GET /v1/harness/status + thread log + POST decide permission', async () => {
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir, permissionTimeoutMs: 5000, permissionUiHandler: () => new Promise(() => undefined) });
  harness.attachToProvider('bot-1', { id: 'mock', dispose: () => undefined }, { engine: 'mock' });
  harness.cliEventSink('bot-1', 'mock', 'bot-1')({ type: 'text', delta: 'hello api' });
  // Một permission đang chờ để POST decide.
  const pendingPromise = harness.broker.request({ botId: 'bot-1', engine: 'mock', method: 'm' });
  assert.equal(await waitUntil(() => harness.broker.pendingCount === 1), true);
  const [pending] = harness.broker.listPending();

  const server = createApiServer({
    port: 0,
    token: API_TOKEN,
    handlers: apiHandlers({
      harnessStatus: () => harness.harnessStatus(),
      harnessThreadLog: (threadId, opts) => harness.readThreadLog(threadId, opts),
      respondHarnessPermission: (requestId, allowed) => harness.decidePermission(requestId, allowed),
    }),
  });
  await server.start();
  try {
    const statusRes = await apiReq(server, '/v1/harness/status');
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.enabled, true);
    assert.equal(status.instances.length, 1);
    assert.equal(status.pendingPermissions.length, 1);

    const logRes = await apiReq(server, '/v1/harness/threads/bot-1/log?limit=10');
    assert.equal(logRes.status, 200);
    const logPage = await logRes.json();
    assert.equal(logPage.total, 1);
    assert.equal(logPage.entries[0].kind, 'text');

    const decideRes = await apiReq(server, `/v1/harness/permissions/${pending.requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed: true }),
    });
    assert.equal(decideRes.status, 200);
    assert.deepEqual(await decideRes.json(), { requestId: pending.requestId, found: true, allowed: true });
    assert.equal(await pendingPromise, true);

    const badBody = await apiReq(server, `/v1/harness/permissions/${pending.requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed: 'yes' }),
    });
    assert.equal(badBody.status, 400);
  } finally {
    await server.stop();
    harness.unregisterBot('bot-1');
  }
});

test('M5 Local API không mount harness: route harness trả 404', async () => {
  const server = createApiServer({ port: 0, token: API_TOKEN, handlers: apiHandlers() });
  await server.start();
  try {
    assert.equal((await apiReq(server, '/v1/harness/status')).status, 404);
    assert.equal((await apiReq(server, '/v1/harness/threads/bot-1/log')).status, 404);
    const decide = await apiReq(server, '/v1/harness/permissions/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed: true }),
    });
    assert.equal(decide.status, 404);
  } finally {
    await server.stop();
  }
});
