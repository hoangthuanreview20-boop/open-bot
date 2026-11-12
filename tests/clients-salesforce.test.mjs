/**
 * Tests for Salesforce direct read client (worker F2, v0.89b, stretch).
 *
 * Wire shape theo Salesforce REST API
 * (developer.salesforce.com/docs/apis/rest-api):
 * GET {instanceUrl}/services/data/v59.0/query?q=SELECT ...
 * → { totalSize, done, records: [{ attributes, Id, Name, ... }] }.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-salesforce.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { salesforceQuery } from '../packages/core/dist/clients/salesforce.js';

/** Mock fetch: handler(url, init) -> { status, body }. Captures calls. */
function makeFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init ?? {});
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.body,
    };
  };
  return { calls, fetch: fetchFn };
}

const OPTS = { instanceUrl: 'https://mycompany.my.salesforce.com', token: 'sf-test-token' };

function optsWithFetch(mock) {
  return { ...OPTS, fetch: mock.fetch };
}

test('salesforceQuery: trả records theo SOQL SELECT', async () => {
  const mock = makeFetch(() => ({
    body: {
      totalSize: 2,
      done: true,
      records: [
        { attributes: { type: 'Account', url: '/services/data/v59.0/sobjects/Account/001' }, Id: '001', Name: 'Acme' },
        { attributes: { type: 'Account', url: '/services/data/v59.0/sobjects/Account/002' }, Id: '002', Name: 'Globex' },
      ],
    },
  }));
  const res = await salesforceQuery(
    optsWithFetch(mock),
    'SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 10',
  );
  assert.equal(res.totalSize, 2);
  assert.equal(res.done, true);
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].Name, 'Acme');
  assert.match(mock.calls[0].url, /mycompany\.my\.salesforce\.com\/services\/data\/v59\.0\/query\?/);
  assert.match(decodeURIComponent(mock.calls[0].url).replace(/\+/g, ' '), /SELECT Id, Name FROM Account/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${OPTS.token}`);
});

test('salesforceQuery: SOQL không phải SELECT → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(
    () => salesforceQuery(optsWithFetch(mock), 'DELETE FROM Account'),
    /must start with SELECT/,
  );
  assert.equal(mock.calls.length, 0);
});

test('salesforceQuery: SOQL rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(() => salesforceQuery(optsWithFetch(mock), ''), /required/);
  assert.equal(mock.calls.length, 0);
});

test('salesforceQuery: instanceUrl http → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(
    () => salesforceQuery({ instanceUrl: 'http://evil.example.com', token: 't', fetch: mock.fetch }, 'SELECT Id FROM Account'),
    /https/,
  );
  assert.equal(mock.calls.length, 0);
});

test('salesforceQuery: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => salesforceQuery(optsWithFetch(mock), 'SELECT Id FROM Account'),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /sf-test-token/);
      return true;
    },
  );
});

test('salesforceQuery: 404 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 404, body: {} }));
  await assert.rejects(
    () => salesforceQuery(optsWithFetch(mock), 'SELECT Id FROM NoSuchObject'),
    /404/,
  );
});
