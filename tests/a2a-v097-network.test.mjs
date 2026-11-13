/**
 * Test v0.97 (Đội T2): A2A network policy — loopback mặc định.
 *
 * Chỉ test thuần + server A2A thật trên loopback (không mạng ngoài):
 * host/URL loopback, normalize policy, bind host, chặn URL ngoài.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-v097-network.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_DEFAULT_BIND_HOST,
  A2A_DEFAULT_NETWORK_POLICY,
  A2A_EXTERNAL_BIND_HOST,
  assertA2aUrlAllowed,
  checkA2aUrlAllowed,
  isA2aExternalAllowed,
  isLoopbackHost,
  isLoopbackUrl,
  normalizeA2aNetworkPolicy,
  resolveA2aBindHost,
} from '../packages/core/dist/a2a/network.js';
import { startA2aHttpServer } from '../packages/core/dist/a2a/server.js';
import { fetchAgentCard } from '../packages/core/dist/a2a/client.js';

const serversToClose = [];
after(async () => {
  for (const s of serversToClose.splice(0)) {
    await s.close().catch(() => undefined);
  }
});

test('isLoopbackHost: 127.x, ::1, localhost → true; còn lại → false', () => {
  for (const h of ['127.0.0.1', '127.0.0.2', '127.255.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST', 'localhost.']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ['0.0.0.0', '192.168.1.1', '8.8.8.8', 'example.com', '', '256.0.0.1', '127.0.0.256']) {
    assert.equal(isLoopbackHost(h), false, h);
  }
  assert.equal(isLoopbackHost(undefined), false);
  assert.equal(isLoopbackHost(null), false);
});

test('isLoopbackUrl: chỉ http(s) loopback mới true', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080/'), true);
  assert.equal(isLoopbackUrl('https://localhost:9/a2a'), true);
  assert.equal(isLoopbackUrl('http://192.168.0.5/'), false);
  assert.equal(isLoopbackUrl('ftp://127.0.0.1/'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
  assert.equal(isLoopbackUrl(''), false);
});

test('normalize: mặc định cả hai false; dữ liệu hỏng → false (fail closed)', () => {
  assert.deepEqual(normalizeA2aNetworkPolicy(undefined), A2A_DEFAULT_NETWORK_POLICY);
  assert.deepEqual(normalizeA2aNetworkPolicy(null), A2A_DEFAULT_NETWORK_POLICY);
  assert.deepEqual(normalizeA2aNetworkPolicy('x'), A2A_DEFAULT_NETWORK_POLICY);
  assert.deepEqual(normalizeA2aNetworkPolicy({ allowExternal: true }), {
    allowExternal: true,
    warningAcknowledged: false,
  });
  // Một cờ true không đủ — cần cả hai.
  assert.deepEqual(normalizeA2aNetworkPolicy({ allowExternal: 'yes', warningAcknowledged: 1 }), {
    allowExternal: false,
    warningAcknowledged: false,
  });
});

test('isA2aExternalAllowed: chỉ true khi CẢ hai cờ true', () => {
  assert.equal(isA2aExternalAllowed(undefined), false);
  assert.equal(isA2aExternalAllowed({ allowExternal: false, warningAcknowledged: false }), false);
  assert.equal(isA2aExternalAllowed({ allowExternal: true, warningAcknowledged: false }), false);
  assert.equal(isA2aExternalAllowed({ allowExternal: false, warningAcknowledged: true }), false);
  assert.equal(isA2aExternalAllowed({ allowExternal: true, warningAcknowledged: true }), true);
});

test('resolveA2aBindHost: mặc định 127.0.0.1, đủ hai cờ → 0.0.0.0', () => {
  assert.equal(resolveA2aBindHost(undefined), A2A_DEFAULT_BIND_HOST);
  assert.equal(resolveA2aBindHost({ allowExternal: true, warningAcknowledged: false }), '127.0.0.1');
  assert.equal(
    resolveA2aBindHost({ allowExternal: true, warningAcknowledged: true }),
    A2A_EXTERNAL_BIND_HOST,
  );
});

test('checkA2aUrlAllowed: loopback luôn được; ngoài bị chặn khi chưa bật', () => {
  const closed = { allowExternal: false, warningAcknowledged: false };
  assert.equal(checkA2aUrlAllowed('http://127.0.0.1:9/', closed).allowed, true);
  const blocked = checkA2aUrlAllowed('http://192.168.1.10:8080/', closed);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? '', /loopback|Settings/);
  const open = { allowExternal: true, warningAcknowledged: true };
  assert.equal(checkA2aUrlAllowed('http://192.168.1.10:8080/', open).allowed, true);
  assert.equal(checkA2aUrlAllowed('ftp://127.0.0.1/', open).allowed, false);
  assert.equal(checkA2aUrlAllowed('', closed).allowed, false);
  assert.throws(() => assertA2aUrlAllowed('http://10.0.0.1/', closed), /loopback/);
});

test('startA2aHttpServer: host 0.0.0.0 khi policy chưa cho → throw, không bind lén', () => {
  assert.throws(
    () =>
      startA2aHttpServer(
        { token: 'test-token', allowUnauthenticated: false },
        { port: 0, host: '0.0.0.0' },
      ),
    /không bind 0\.0\.0\.0|policy mạng/,
  );
});

test('startA2aHttpServer: host lạ → throw', () => {
  assert.throws(
    () =>
      startA2aHttpServer(
        { token: 'test-token' },
        { port: 0, host: 'example.com' },
      ),
    /chỉ bind loopback/,
  );
});

test('startA2aHttpServer: policy đủ hai cờ → bind 0.0.0.0 được', async () => {
  const srv = await startA2aHttpServer(
    {
      token: 'test-token',
      networkPolicy: { allowExternal: true, warningAcknowledged: true },
      runner: async ({ text }) => ({ text: `ok: ${text}` }),
    },
    { port: 0, host: '0.0.0.0' },
  );
  serversToClose.push(srv);
  assert.ok(srv.url.startsWith('http://0.0.0.0:'));
  assert.ok(srv.isRunning);
});

test('fetchAgentCard với policy: URL ngoài loopback bị chặn trước khi fetch', async () => {
  await assert.rejects(
    () =>
      fetchAgentCard('http://192.168.1.10:8080/', {
        networkPolicy: { allowExternal: false, warningAcknowledged: false },
        timeoutMs: 1000,
      }),
    /loopback|Settings/,
  );
});
