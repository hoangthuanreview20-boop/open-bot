/**
 * Tests cho v0.15 item 8 — chặn SSRF ở webhook + cảnh báo gửi không ký
 * mỗi lần gửi (M5 audit).
 * (packages/core/src/api/webhooks.ts)
 *
 * Không gọi mạng thật: DNS được inject fake, fetch được mock, server
 * local chỉ dùng cho trường hợp opt-in `allowInternalUrls: true`.
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/webhook-ssrf-v015.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  WebhookDispatcher,
  assertWebhookUrlPublic,
  isPrivateIp,
} from '../packages/core/dist/api/webhooks.js';

const realFetch = globalThis.fetch;
const realWarn = console.warn;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-webhook-v015-'));
}

/** Bắt console.warn vào mảng, trả hàm khôi phục. */
function captureWarnings() {
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  return warnings;
}

const fakeLookup = (mapping) => async (hostname) => {
  if (!(hostname in mapping)) throw new Error(`ENOTFOUND ${hostname}`);
  return mapping[hostname].map((address) => ({ address }));
};

const EVENT = {
  kind: 'run.done',
  at: '2026-11-09T00:00:00.000Z',
  data: { botId: 'bot-1', runId: 'r1', text: 'xong' },
};

// ---------------------------------------------------------------------------
// isPrivateIp (cùng danh sách dải IP với packages/tools/src/ssrf.ts)
// ---------------------------------------------------------------------------

test('webhook ssrf: isPrivateIp chặn loopback/private/link-local/metadata, cho public qua', () => {
  for (const ip of [
    '127.0.0.1', '127.0.0.2', '10.0.0.5', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '192.0.2.1', '198.51.100.2', '203.0.113.3', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} phải bị chặn`);
  }
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1',
    '2001:4860:4860::8888', '2606:4700:4700::1111',
  ]) {
    assert.equal(isPrivateIp(ip), false, `${ip} là public, phải cho qua`);
  }
});

// ---------------------------------------------------------------------------
// assertWebhookUrlPublic (lookup inject fake)
// ---------------------------------------------------------------------------

test('webhook ssrf: assertWebhookUrlPublic chặn IP literal nội bộ + localhost, cho public qua', async () => {
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
    await assert.rejects(() => assertWebhookUrlPublic(url), /Chặn SSRF/, `${url} phải bị chặn`);
  }
  const ok = await assertWebhookUrlPublic('https://93.184.216.34/page', {
    lookupFn: fakeLookup({}),
  });
  assert.equal(ok.hostname, '93.184.216.34');
});

test('webhook ssrf: assertWebhookUrlPublic chặn tên miền resolve ra IP nội bộ (kể cả chỉ 1 trong nhiều IP)', async () => {
  const lookup = fakeLookup({
    'internal.example': ['10.0.0.5'],
    'mixed.example': ['93.184.216.34', '192.168.1.1'],
    'public.example': ['93.184.216.34'],
  });
  await assert.rejects(
    () => assertWebhookUrlPublic('https://internal.example/hook', { lookupFn: lookup }),
    /Chặn SSRF.*10\.0\.0\.5/,
  );
  await assert.rejects(
    () => assertWebhookUrlPublic('https://mixed.example/hook', { lookupFn: lookup }),
    /Chặn SSRF.*192\.168\.1\.1/,
  );
  const ok = await assertWebhookUrlPublic('https://public.example/hook', { lookupFn: lookup });
  assert.equal(ok.hostname, 'public.example');
  // DNS resolve lỗi → chặn luôn (fail closed).
  await assert.rejects(
    () => assertWebhookUrlPublic('https://khong-co-that.example/hook', { lookupFn: lookup }),
    /Chặn SSRF.*không resolve được/,
  );
});

// ---------------------------------------------------------------------------
// add() — chặn lúc đăng ký
// ---------------------------------------------------------------------------

test('webhook ssrf: add() từ chối URL nội bộ mặc định, cho qua khi allowInternalUrls: true', () => {
  const dir = makeTempDir();
  const d = new WebhookDispatcher({ storePath: path.join(dir, 'webhooks.json') });
  assert.throws(() => d.add('http://127.0.0.1:9/hook', ['run.done']), /Chặn SSRF/);
  assert.throws(() => d.add('http://169.254.169.254/latest/', ['run.done']), /Chặn SSRF/);
  assert.throws(() => d.add('http://localhost:3000/hook', ['run.done']), /Chặn SSRF/);
  assert.throws(() => d.add('http://10.0.0.5/hook', ['run.done']), /Chặn SSRF/);
  assert.deepEqual(d.list(), [], 'không có webhook nội bộ nào được đăng ký');

  // URL public vẫn đăng ký được.
  const reg = d.add('https://93.184.216.34/hook', ['run.done']);
  assert.equal(reg.url, 'https://93.184.216.34/hook');

  // Opt-in: host biết receiver chạy local thì cho phép.
  const d2 = new WebhookDispatcher({
    storePath: path.join(dir, 'webhooks2.json'),
    allowInternalUrls: true,
  });
  const local = d2.add('http://127.0.0.1:9/hook', ['run.done']);
  assert.equal(local.url, 'http://127.0.0.1:9/hook');
});

test('webhook ssrf: loadStore bỏ entry nội bộ khi không opt-in, giữ lại khi opt-in', () => {
  const dir = makeTempDir();
  const storePath = path.join(dir, 'webhooks.json');
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    webhooks: [
      { id: 'w-local', url: 'http://127.0.0.1:9/hook', events: ['run.done'] },
      { id: 'w-public', url: 'https://93.184.216.34/hook', events: ['run.done'] },
    ],
  }), 'utf-8');
  assert.deepEqual(
    new WebhookDispatcher({ storePath }).list().map((w) => w.id),
    ['w-public'],
    'entry nội bộ trong store cũ bị bỏ khi nạp mà không opt-in',
  );
  assert.deepEqual(
    new WebhookDispatcher({ storePath, allowInternalUrls: true }).list().map((w) => w.id),
    ['w-local', 'w-public'],
    'opt-in thì giữ cả entry nội bộ',
  );
});

// ---------------------------------------------------------------------------
// dispatch() — chặn lúc gửi (DNS rebinding: tên miền đổi IP sau khi đăng ký)
// ---------------------------------------------------------------------------

test('webhook ssrf: dispatch chặn tên miền resolve ra IP nội bộ, KHÔNG gọi fetch', async () => {
  const warnings = captureWarnings();
  const dir = makeTempDir();
  const d = new WebhookDispatcher({
    storePath: path.join(dir, 'webhooks.json'),
    hmacSecret: 'secret-test',
    lookupFn: fakeLookup({ 'doi-ten.example': ['10.0.0.5'] }),
  });
  // Tên miền qua được add() (add không resolve DNS), nhưng lúc gửi thì bị chặn.
  d.add('https://doi-ten.example/hook', ['run.done']);

  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };

  const results = await d.dispatch(EVENT);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /Chặn SSRF.*10\.0\.0\.5/);
  assert.equal(fetchCalls, 0, 'bị chặn thì không được gọi fetch');
  assert.ok(
    warnings.some((w) => w.includes('Chặn SSRF') && w.includes('doi-ten.example')),
    'phải log rõ lý do chặn',
  );
});

test('webhook ssrf: dispatch tới tên miền public vẫn gửi được (lookup fake)', async () => {
  const dir = makeTempDir();
  const d = new WebhookDispatcher({
    storePath: path.join(dir, 'webhooks.json'),
    hmacSecret: 'secret-test',
    lookupFn: fakeLookup({ 'public.example': ['93.184.216.34'] }),
  });
  d.add('https://public.example/hook', ['run.done']);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  };
  const results = await d.dispatch(EVENT);
  assert.equal(results[0].ok, true);
  assert.equal(fetchCalls, 1);
});

// ---------------------------------------------------------------------------
// Opt-in allowInternalUrls: webhook local vẫn chạy như cũ
// ---------------------------------------------------------------------------

test('webhook ssrf: allowInternalUrls: true — dispatch tới mock server local vẫn chạy như cũ', async () => {
  const received = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  try {
    const dir = makeTempDir();
    const d = new WebhookDispatcher({
      storePath: path.join(dir, 'webhooks.json'),
      hmacSecret: 'secret-test',
      allowInternalUrls: true,
    });
    d.add(`http://127.0.0.1:${port}/hook`, ['run.done']);
    const results = await d.dispatch(EVENT);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].status, 200);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], EVENT, 'payload không đổi shape');
  } finally {
    await new Promise((r) => mock.close(r));
  }
});

// ---------------------------------------------------------------------------
// (b) Gửi không ký: cảnh báo MỖI lần gửi, payload không đổi shape
// ---------------------------------------------------------------------------

test('webhook unsigned: mỗi lần gửi không ký đều cảnh báo rõ URL, payload không thêm field signed', async () => {
  const warnings = captureWarnings();
  const received = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ signature: req.headers['x-open-bot-signature'], body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  try {
    const dir = makeTempDir();
    const d = new WebhookDispatcher({
      storePath: path.join(dir, 'webhooks.json'),
      allowInternalUrls: true,
    });
    assert.equal(d.isSigning, false);
    const url = `http://127.0.0.1:${port}/hook`;
    d.add(url, ['run.done']);

    const results = await Promise.all([d.dispatch(EVENT), d.dispatch(EVENT)]);
    assert.ok(results.flat().every((r) => r.ok), 'thiếu secret vẫn gửi được (không crash, không bắt buộc ký)');
    assert.equal(received.length, 2);
    assert.equal(received[0].signature, undefined);
    assert.equal(received[1].signature, undefined);
    // Payload giữ nguyên shape cũ — không thêm field `signed`.
    assert.deepEqual(received[0].body, EVENT);
    assert.deepEqual(received[1].body, EVENT);
    // Cảnh báo MỖI lần gửi (không còn "một lần rồi thôi"), ghi rõ URL.
    const unsignedWarnings = warnings.filter((w) => w.includes('KHÔNG ký HMAC'));
    assert.equal(unsignedWarnings.length, 2, `phải cảnh báo 2 lần (mỗi lần gửi), thấy ${unsignedWarnings.length}`);
    assert.ok(unsignedWarnings.every((w) => w.includes(url)), 'cảnh báo phải ghi rõ URL webhook');
    assert.ok(unsignedWarnings.every((w) => w.includes('giả mạo')), 'cảnh báo phải nói rõ nguy cơ giả mạo');
  } finally {
    await new Promise((r) => mock.close(r));
  }
});

test('webhook unsigned: có secret thì gửi có ký và KHÔNG cảnh báo unsigned', async () => {
  const warnings = captureWarnings();
  const received = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ signature: req.headers['x-open-bot-signature'], body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  try {
    const dir = makeTempDir();
    const d = new WebhookDispatcher({
      storePath: path.join(dir, 'webhooks.json'),
      hmacSecret: 'secret-test',
      allowInternalUrls: true,
    });
    d.add(`http://127.0.0.1:${port}/hook`, ['run.done']);
    const results = await d.dispatch(EVENT);
    assert.equal(results[0].ok, true);
    assert.match(received[0].signature, /^sha256=[0-9a-f]{64}$/);
    assert.equal(
      warnings.filter((w) => w.includes('KHÔNG ký HMAC')).length,
      0,
      'gửi có ký thì không cảnh báo unsigned',
    );
  } finally {
    await new Promise((r) => mock.close(r));
  }
});
