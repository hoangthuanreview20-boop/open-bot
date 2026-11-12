/**
 * Tests cho v0.15 item 8 — chặn SSRF ở http_get/web_fetch (H3 audit).
 * (packages/tools/src/ssrf.ts + nối vào tools.ts/webMedia.ts)
 *
 * Không gọi mạng thật: DNS được inject fake, global fetch được mock.
 * Chạy sau khi build tools:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/ssrf-v015.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPublicUrl,
  fetchPublic,
  isPrivateIp,
} from '../packages/tools/dist/ssrf.js';
import { createDefaultTools } from '../packages/tools/dist/tools.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function toolByName(name) {
  const tool = createDefaultTools().find((t) => t.definition.name === name);
  assert.ok(tool, `thiếu tool ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// isPrivateIp
// ---------------------------------------------------------------------------

test('ssrf: isPrivateIp chặn loopback/private/link-local/metadata, cho public qua', () => {
  for (const ip of [
    '127.0.0.1', '127.0.0.2', '10.0.0.5', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '0.0.0.0', '100.64.0.1',
    '192.0.2.1', '198.51.100.2', '203.0.113.3', '224.0.0.1', '240.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} phải bị chặn`);
  }
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '142.250.72.14',
    '172.15.255.255', '172.32.0.1', '100.63.0.1', '100.128.0.1',
    '2001:4860:4860::8888', '2606:4700:4700::1111',
  ]) {
    assert.equal(isPrivateIp(ip), false, `${ip} là public, phải cho qua`);
  }
});

// ---------------------------------------------------------------------------
// assertPublicUrl (lookup inject fake)
// ---------------------------------------------------------------------------

const fakeLookup = (mapping) => async (hostname) => {
  if (!(hostname in mapping)) throw new Error(`ENOTFOUND ${hostname}`);
  return mapping[hostname].map((address) => ({ address }));
};

test('ssrf: assertPublicUrl chặn IP literal nội bộ + localhost', async () => {
  for (const url of [
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1/v1/health',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/admin',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://localhost:3000/',
    'http://foo.localhost/',
  ]) {
    await assert.rejects(() => assertPublicUrl(url), /Chặn SSRF/, `${url} phải bị chặn`);
  }
  const ok = await assertPublicUrl('https://93.184.216.34/page', {
    lookupFn: fakeLookup({}),
  });
  assert.equal(ok.hostname, '93.184.216.34');
});

test('ssrf: assertPublicUrl chặn tên miền resolve ra IP nội bộ (kể cả khi có cả public)', async () => {
  const lookup = fakeLookup({
    'evil.example.com': ['93.184.216.34', '127.0.0.1'],
    'good.example.com': ['93.184.216.34'],
    'dead.example.com': [],
  });
  await assert.rejects(
    () => assertPublicUrl('https://evil.example.com/', { lookupFn: lookup }),
    /IP nội bộ/,
  );
  const ok = await assertPublicUrl('https://good.example.com/', { lookupFn: lookup });
  assert.equal(ok.hostname, 'good.example.com');
  await assert.rejects(
    () => assertPublicUrl('https://dead.example.com/', { lookupFn: lookup }),
    /không resolve ra địa chỉ nào/,
  );
  await assert.rejects(
    () => assertPublicUrl('https://nx.example.com/', { lookupFn: lookup }),
    /không resolve được/,
  );
});

// ---------------------------------------------------------------------------
// fetchPublic (fetch mock)
// ---------------------------------------------------------------------------

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}

function okResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

test('ssrf: fetchPublic chặn IP nội bộ TRƯỚC khi fetch được gọi', async () => {
  const calls = mockFetch([okResponse('secret')]);
  await assert.rejects(() => fetchPublic('http://127.0.0.1:11434/api/tags'), /Chặn SSRF/);
  assert.equal(calls.length, 0, 'fetch không được gọi khi URL bị chặn');
});

test('ssrf: fetchPublic chặn redirect tới IP nội bộ, cho redirect public qua', async () => {
  // Redirect public → public: follow 1 hop rồi trả body.
  let calls = mockFetch([
    okResponse('', 302, { location: 'https://93.184.216.34/final' }),
    okResponse('final body'),
  ]);
  const res = await fetchPublic('https://93.184.216.34/start', {}, 5000, {
    lookupFn: fakeLookup({}),
  });
  assert.equal(await res.text(), 'final body');
  assert.equal(calls.length, 2);

  // Redirect public → private: hop đầu fetch, hop 2 bị chặn trước khi fetch.
  calls = mockFetch([
    okResponse('', 302, { location: 'http://169.254.169.254/latest/meta-data/' }),
    okResponse('KHÔNG ĐƯỢC ĐỌC'),
  ]);
  await assert.rejects(
    () => fetchPublic('https://93.184.216.34/start', {}, 5000, { lookupFn: fakeLookup({}) }),
    /Chặn SSRF/,
  );
  assert.equal(calls.length, 1, 'chỉ hop đầu được fetch, hop tới metadata bị chặn');
});

test('ssrf: fetchPublic quá 5 redirect → lỗi, không lặp vô hạn', async () => {
  const loop = () => okResponse('', 302, { location: 'https://93.184.216.34/a' });
  mockFetch([loop(), loop(), loop(), loop(), loop(), loop(), loop()]);
  await assert.rejects(
    () => fetchPublic('https://93.184.216.34/a', {}, 5000, { lookupFn: fakeLookup({}) }),
    /Quá nhiều redirect/,
  );
});

// ---------------------------------------------------------------------------
// Tool http_get end-to-end (fetch mock, URL IP literal → không cần DNS thật)
// ---------------------------------------------------------------------------

test('ssrf: http_get chặn 127.0.0.1, cho IP public qua (fetch mock)', async () => {
  const httpGet = toolByName('http_get');
  const calls = mockFetch([okResponse('{"ok":true}')]);
  const blocked = await httpGet.execute({ url: 'http://127.0.0.1:11434/api/tags' }, {});
  assert.match(blocked, /Chặn SSRF/);
  assert.equal(calls.length, 0, 'http_get tới Ollama local không được fetch');

  const okOut = await httpGet.execute({ url: 'https://93.184.216.34/api' }, {});
  assert.match(okOut, /"ok":true/);
  assert.equal(calls.length, 1);
});
