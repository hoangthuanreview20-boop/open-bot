/**
 * Tests for the v0.89 http tool (worker F4): http_request
 * (packages/tools/src/httpTools.ts, wired into tools.ts ALL_TOOLS).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/http-tools-f4.test.mjs
 *
 * No live network: fetch is injected (opts.fetchFn) and DNS is either
 * avoided (IP-literal hosts) or faked (opts.lookupFn). No real
 * credentials anywhere — the Authorization tests use the literal
 * string 'Bearer test-token' (a fake literal) supplied by the test itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultTools, ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  HTTP_TOOLS,
  createHttpTools,
  doHttpRequest,
} from '../packages/tools/dist/httpTools.js';

const ALLOW_PUBLIC = () => ({ mode: 'allow-public' });
const ALLOWLIST = () => ({ mode: 'allowlist', allowHosts: ['api.example.com'] });

function headersFor(pairs) {
  const map = new Map(pairs);
  return {
    get: (name) => map.get(name.toLowerCase()) ?? null,
    forEach: (cb) => {
      for (const [name, value] of map) cb(value, name);
    },
  };
}

function jsonResponse(obj, status = 200, statusText = 'OK', extraHeaders = []) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: headersFor([['content-type', 'application/json'], ...extraHeaders]),
    text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  };
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test('http-tools: http_request in ALL_TOOLS, needsApproval true (non-GET must be gated)', () => {
  assert.equal(HTTP_TOOLS.length, 1);
  assert.equal(HTTP_TOOLS[0].definition.name, 'http_request');
  assert.equal(HTTP_TOOLS[0].needsApproval, true);
  const inRegistry = ALL_TOOLS.find((t) => t.definition.name === 'http_request');
  assert.ok(inRegistry, 'http_request missing from ALL_TOOLS');
  assert.equal(inRegistry.needsApproval, true);
  // Policy-bound variant from createDefaultTools keeps the same shape.
  const bound = createDefaultTools({ getEgressPolicy: ALLOW_PUBLIC });
  const boundTool = bound.find((t) => t.definition.name === 'http_request');
  assert.ok(boundTool);
  assert.equal(boundTool.needsApproval, true);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names in ALL_TOOLS');
});

// ---------------------------------------------------------------------------
// Success path (mocked fetch, IP-literal host = no DNS needed)
// ---------------------------------------------------------------------------

test('http-tools: GET success returns status + filtered headers + body', async () => {
  let seenInit;
  const fetchFn = async (url, init) => {
    seenInit = init;
    return jsonResponse({ ok: true }, 200, 'OK', [['set-cookie', 'session=abc'], ['x-test', '1']]);
  };
  const out = await doHttpRequest(
    { url: 'http://93.184.216.34/api', method: 'GET' },
    { fetchFn, getEgressPolicy: ALLOW_PUBLIC },
  );
  assert.match(out, /HTTP 200 OK GET http:\/\/93\.184\.216\.34\/api/);
  assert.match(out, /"ok":true/);
  assert.match(out, /x-test: 1/);
  assert.ok(!out.includes('set-cookie'), 'set-cookie must be stripped from the result');
  assert.ok(!out.includes('session=abc'));
  assert.equal(seenInit.method, 'GET');
  assert.equal(seenInit.headers.Authorization, undefined);
});

test('http-tools: POST sends the body and returns the status; PUT/DELETE also work', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push(init);
    return jsonResponse('created', 201, 'Created');
  };
  const out = await doHttpRequest(
    { url: 'http://93.184.216.34/api', method: 'POST', body: '{"a":1}' },
    { fetchFn, getEgressPolicy: ALLOW_PUBLIC },
  );
  assert.match(out, /HTTP 201 Created POST/);
  assert.match(out, /created/);
  assert.equal(seen[0].body, '{"a":1}');
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
  await doHttpRequest({ url: 'http://93.184.216.34/api', method: 'PUT', body: '{}' }, { fetchFn, getEgressPolicy: ALLOW_PUBLIC });
  await doHttpRequest({ url: 'http://93.184.216.34/api', method: 'DELETE' }, { fetchFn, getEgressPolicy: ALLOW_PUBLIC });
  assert.deepEqual(seen.map((s) => s.method), ['POST', 'PUT', 'DELETE']);
});

// ---------------------------------------------------------------------------
// Egress / SSRF
// ---------------------------------------------------------------------------

test('http-tools: egress blocks localhost even with an allow-public policy', async () => {
  const fetchFn = async () => { throw new Error('fetch must not be called'); };
  for (const url of ['http://127.0.0.1:11434/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data/']) {
    const out = await doHttpRequest({ url }, { fetchFn, getEgressPolicy: ALLOW_PUBLIC });
    assert.match(out, /^Error:/, url);
  }
});

test('http-tools: allowlist policy blocks hosts not on the list (no DNS leak)', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return jsonResponse({}); };
  const out = await doHttpRequest(
    { url: 'http://93.184.216.34/api' },
    { fetchFn, getEgressPolicy: ALLOWLIST },
  );
  assert.match(out, /^Error:/);
  assert.equal(called, false, 'blocked request must not reach fetch');
});

test('http-tools: no policy resolver falls back to the SSRF guard (public IP ok, localhost blocked)', async () => {
  const fetchFn = async () => jsonResponse({ ok: true });
  const ok = await doHttpRequest({ url: 'http://93.184.216.34/api' }, { fetchFn });
  assert.match(ok, /HTTP 200/);
  const blocked = await doHttpRequest({ url: 'http://10.0.0.5/api' }, { fetchFn });
  assert.match(blocked, /^Error:/);
});

test('http-tools: redirect to an internal host is blocked on re-check', async () => {
  const fetchFn = async (url) => {
    if (url === 'http://93.184.216.34/start') {
      return {
        ok: false, status: 302, statusText: 'Found',
        headers: headersFor([['location', 'http://127.0.0.1/secret']]),
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const out = await doHttpRequest(
    { url: 'http://93.184.216.34/start' },
    { fetchFn, getEgressPolicy: ALLOW_PUBLIC },
  );
  assert.match(out, /^Error:/);
});

// ---------------------------------------------------------------------------
// Credentials / limits / bad input
// ---------------------------------------------------------------------------

test('http-tools: Authorization is never sent from args; only an explicit resolver sends it', async () => {
  let seenHeaders;
  const fetchFn = async (url, init) => {
    seenHeaders = init.headers;
    return jsonResponse({});
  };
  await doHttpRequest(
    { url: 'http://93.184.216.34/api', headers: { Authorization: 'Bearer test-nope', Cookie: 'x=1' } },
    { fetchFn, getEgressPolicy: ALLOW_PUBLIC },
  );
  assert.equal(seenHeaders.Authorization, undefined);
  assert.equal(seenHeaders.Cookie, undefined);
  await doHttpRequest(
    { url: 'http://93.184.216.34/api' },
    { fetchFn, getEgressPolicy: ALLOW_PUBLIC, getAuthorization: () => 'Bearer test-token' },
  );
  assert.equal(seenHeaders.Authorization, 'Bearer test-token');
});

test('http-tools: bad method, bad URL, GET with body, oversized body are errors', async () => {
  const fetchFn = async () => jsonResponse({});
  const opts = { fetchFn, getEgressPolicy: ALLOW_PUBLIC };
  assert.match(await doHttpRequest({ url: 'http://93.184.216.34/api', method: 'PATCH' }, opts), /not allowed/);
  assert.match(await doHttpRequest({ url: 'not a url' }, opts), /Invalid URL/);
  assert.match(await doHttpRequest({ url: 'ftp://93.184.216.34/x' }, opts), /Only http/);
  assert.match(
    await doHttpRequest({ url: 'http://93.184.216.34/api', method: 'GET', body: 'x' }, opts),
    /do not take a body/,
  );
  assert.match(
    await doHttpRequest({ url: 'http://93.184.216.34/api', method: 'POST', body: 'x'.repeat(1_000_001) }, opts),
    /over the 1000000 byte limit/,
  );
  assert.match(
    await doHttpRequest({ url: 'http://93.184.216.34/api', headers: { 'X-A': 5 } }, opts),
    /must be a string/,
  );
});

test('http-tools: tool wrapper through createHttpTools executes with the same rules', async () => {
  const fetchFn = async () => jsonResponse({ hi: 1 });
  const [tool] = createHttpTools({ fetchFn, getEgressPolicy: ALLOW_PUBLIC });
  const out = await tool.execute({ url: 'http://93.184.216.34/api' }, { workspaceDir: '/tmp', botId: 't' });
  assert.match(out, /HTTP 200/);
  const blocked = await tool.execute({ url: 'http://127.0.0.1/x' }, { workspaceDir: '/tmp', botId: 't' });
  assert.match(blocked, /^Error:/);
});
