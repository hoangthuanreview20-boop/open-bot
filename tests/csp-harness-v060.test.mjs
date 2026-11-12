/**
 * Tests cho v0.60 — CSP worker-src tường minh + harness re-attach.
 *
 * (a) CSP: meta trong `apps/desktop/src/renderer/index.html` giờ có
 * `worker-src 'self'` tường minh (trước đây không có directive này nên
 * worker rơi về fallback `script-src 'self'` — cùng mức cho phép, nhưng
 * để mặc định thì một lần nới `script-src` sau này sẽ vô tình nới cả
 * worker). KHÔNG blob:/data: — AudioWorklet vẫn theo `script-src`
 * (đã sửa v0.55: worklet load từ file asset `?url`, không blob).
 * `worker-src blob:` là cách sửa SAI đã bác ở v0.55 (không cứu được
 * AudioWorklet), `script-src blob:` thì nới lỏng chung — cả hai đều
 * không được xuất hiện.
 *
 * (b) Harness: `attachToProvider` gọi lại với ĐÚNG provider đã đăng ký
 * (cùng object + providerId/engine) thì trả snapshot hiện có, không
 * throw, không gắn sink/handler lần nữa — hết cảnh báo "đã có instance
 * sống" mỗi lần mở app. Provider KHÁC cho cùng bot đang sống thì vẫn
 * throw (chống spawn trùng); thay provider phải qua `reregisterProvider`
 * hoặc unregister trước. Coordinator + harness: `createBot` 2 lần
 * (tuần tự + song song) không in cảnh báo harness nào.
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/csp-harness-v060.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCoordinator, LocalHarness } from '../packages/core/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = path.join(ROOT, 'apps/desktop/src/renderer/index.html');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------
// (a) CSP worker-src
// ---------------------------------------------------------------------------

test('csp-v060: meta CSP có worker-src self tường minh, không blob:/data:', () => {
  const html = read(INDEX_HTML);
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, 'index.html phải có meta CSP');
  const csp = m[1];
  assert.match(csp, /(?:^|;\s*)worker-src 'self'(?:;|$)/, `CSP phải có worker-src 'self' — nhận ${csp}`);
  assert.match(csp, /script-src 'self'/, 'script-src vẫn là self (AudioWorklet theo directive này)');
  assert.ok(!csp.includes('blob:'), `CSP không được chứa blob: — nhận ${csp}`);
  assert.ok(!csp.includes('data:'), `CSP không được chứa data: — nhận ${csp}`);
  assert.ok(!/worker-src[^;]*blob:/.test(csp), 'worker-src không được chứa blob:');
  assert.ok(!/script-src[^;]*blob:/.test(csp), 'script-src không được chứa blob: (không nới lỏng chung)');
});

// ---------------------------------------------------------------------------
// (b) Harness re-attach
// ---------------------------------------------------------------------------

function countingProvider(id, engine) {
  let sinkCalls = 0;
  let permCalls = 0;
  let sink = null;
  const provider = {
    id,
    dispose: () => undefined,
    attachHarnessSink: (s) => {
      sinkCalls += 1;
      sink = s;
    },
    attachPermissionHandler: () => {
      permCalls += 1;
    },
  };
  return { provider, sinkCalls: () => sinkCalls, permCalls: () => permCalls, sink: () => sink };
}

test('harness-v060: re-attach cùng provider trả snapshot cũ, không gắn sink lần nữa', () => {
  const harness = new LocalHarness({});
  const { provider, sinkCalls, permCalls, sink } = countingProvider('claude-code', 'claude');
  const first = harness.attachToProvider('bot-1', provider, { engine: 'claude', threadId: 'bot-1' });
  const second = harness.attachToProvider('bot-1', provider, { engine: 'claude', threadId: 'bot-1' });
  assert.equal(second.instanceId, first.instanceId, 're-attach trả đúng instance đã có');
  assert.equal(harness.registry.size, 1, 'không nhân đôi instance');
  assert.equal(sinkCalls(), 1, 'sink chỉ gắn một lần');
  assert.equal(permCalls(), 1, 'permission handler chỉ gắn một lần');
  // Sink duy nhất vẫn hoạt động: 1 event vào bus, không nhân đôi.
  const events = [];
  harness.bus.subscribe({}, (e) => events.push(e));
  sink()({ type: 'text', delta: 'xin chào' });
  assert.equal(events.length, 1, 'event qua sink không bị nhân đôi sau re-attach');
  assert.equal(events[0].kind, 'text');
});

test('harness-v060: provider khác (object khác) cho bot đang sống vẫn throw', () => {
  const harness = new LocalHarness({});
  const a = countingProvider('mock', 'mock');
  const b = countingProvider('mock', 'mock');
  harness.attachToProvider('bot-1', a.provider, { engine: 'mock' });
  assert.throws(
    () => harness.attachToProvider('bot-1', b.provider, { engine: 'mock' }),
    /đã có instance sống/,
    'object provider khác thì vẫn throw (chống spawn trùng)',
  );
  assert.throws(
    () => harness.attachToProvider('bot-1', { id: 'codex', dispose: () => undefined }, { engine: 'codex' }),
    /đã có instance sống/,
    'engine khác thì vẫn throw',
  );
  assert.equal(harness.registry.size, 1);
});

test('harness-v060: unregister rồi attach lại được (không kẹt re-attach)', () => {
  const harness = new LocalHarness({});
  const a = countingProvider('mock', 'mock');
  const first = harness.attachToProvider('bot-1', a.provider, { engine: 'mock' });
  assert.equal(harness.unregisterBot('bot-1'), true);
  const b = countingProvider('mock', 'mock');
  const second = harness.attachToProvider('bot-1', b.provider, { engine: 'mock' });
  assert.notEqual(second.instanceId, first.instanceId, 'đăng ký lại sau unregister là instance mới');
  assert.equal(harness.registry.size, 1);
});

test('harness-v060: reregisterProvider sau re-attach vẫn đổi sang provider mới', () => {
  const harness = new LocalHarness({});
  const a = countingProvider('mock', 'mock');
  const first = harness.attachToProvider('bot-1', a.provider, { engine: 'mock' });
  harness.attachToProvider('bot-1', a.provider, { engine: 'mock' });
  const b = countingProvider('codex', 'codex');
  const replaced = harness.reregisterProvider('bot-1', b.provider, { engine: 'codex' });
  assert.notEqual(replaced.instanceId, first.instanceId);
  assert.equal(replaced.providerId, 'codex');
  assert.equal(harness.registry.size, 1);
});

// ---------------------------------------------------------------------------
// (b) Coordinator + harness: createBot 2 lần không cảnh báo
// ---------------------------------------------------------------------------

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

function mockProvider() {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] };
}

/** Chặn stderr trong lúc chạy fn, trả các dòng cảnh báo harness thu được. */
async function captureHarnessWarnings(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return orig(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('').split('\n').filter((l) => l.includes('không đăng ký được bot'));
}

test('harness-v060: coordinator có harness, createBot 2 lần (tuần tự + song song) không cảnh báo', async () => {
  const ws = tmpDir('open-bot-v060-ws-');
  const coord = new AgentCoordinator({
    dataDir: tmpDir('open-bot-v060-data-'),
    harness: new LocalHarness({}),
  });
  try {
    const warnings = await captureHarnessWarnings(async () => {
      await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider() });
      await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider() });
      await Promise.all([
        coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider() }),
        coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider() }),
      ]);
    });
    assert.deepEqual(warnings, [], `không còn cảnh báo harness — nhận ${JSON.stringify(warnings)}`);
    assert.deepEqual(coord.listBots().botIds, ['bot-1'], 'chỉ có đúng một bot');
    const res = await coord.run({ botId: 'bot-1', text: 'chào' });
    assert.equal(res.text, 'ok', 'bot sau re-attach vẫn chạy được');
    const status = coord.harnessStatus();
    assert.equal(status.instances.length, 1, 'harness chỉ giữ một instance');
    assert.equal(status.instances[0].botId, 'bot-1');
  } finally {
    coord.shutdown();
  }
});
