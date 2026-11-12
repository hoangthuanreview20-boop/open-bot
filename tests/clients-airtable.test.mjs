/**
 * Tests for Airtable direct read client (worker F2, v0.89b).
 *
 * Wire shape theo Airtable API (airtable.com/developers/web/api):
 * GET /v0/{baseId}/{table} (filterByFormula/sort/maxRecords/offset),
 * GET /v0/{baseId}/{table}/{recordId}.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-airtable.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  airtableGetRecord,
  airtableListRecords,
} from '../packages/core/dist/clients/airtable.js';

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

const TOKEN = 'pat-test-token';

test('airtableListRecords: trả records + offset, filter/sort trong URL', async () => {
  const mock = makeFetch(() => ({
    body: {
      records: [
        { id: 'rec1', createdTime: '2026-01-01T00:00:00.000Z', fields: { Name: 'Alpha', Done: true } },
        { id: 'rec2', createdTime: '2026-01-02T00:00:00.000Z', fields: { Name: 'Beta' } },
      ],
      offset: 'off-1',
    },
  }));
  const res = await airtableListRecords({ token: TOKEN, fetch: mock.fetch }, 'appBase', 'Tasks', {
    filterByFormula: '{Done}=1',
    sortField: 'Name',
    sortDirection: 'desc',
    maxRecords: 5,
  });
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].fields.Name, 'Alpha');
  assert.equal(res.offset, 'off-1');
  assert.match(mock.calls[0].url, /api\.airtable\.com\/v0\/appBase\/Tasks/);
  assert.match(decodeURIComponent(mock.calls[0].url), /filterByFormula=\{Done\}=1/);
  assert.match(decodeURIComponent(mock.calls[0].url), /sort\[0\]\[field\]=Name/);
  assert.match(decodeURIComponent(mock.calls[0].url), /sort\[0\]\[direction\]=desc/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('airtableGetRecord: đọc record theo id', async () => {
  const mock = makeFetch(() => ({
    body: { id: 'rec1', createdTime: '2026-01-01T00:00:00.000Z', fields: { Name: 'Alpha' } },
  }));
  const rec = await airtableGetRecord({ token: TOKEN, fetch: mock.fetch }, 'appBase', 'Tasks', 'rec1');
  assert.equal(rec.id, 'rec1');
  assert.equal(rec.fields.Name, 'Alpha');
  assert.match(mock.calls[0].url, /\/v0\/appBase\/Tasks\/rec1$/);
});

test('airtableListRecords: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => airtableListRecords({ token: TOKEN, fetch: mock.fetch }, 'appBase', 'Tasks'),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /pat-test-token/);
      return true;
    },
  );
});

test('airtableGetRecord: 404 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 404, body: {} }));
  await assert.rejects(
    () => airtableGetRecord({ token: TOKEN, fetch: mock.fetch }, 'appBase', 'Tasks', 'recX'),
    /404/,
  );
});

test('airtableListRecords: baseId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { records: [] } }));
  await assert.rejects(
    () => airtableListRecords({ token: TOKEN, fetch: mock.fetch }, '', 'Tasks'),
    /required/,
  );
  assert.equal(mock.calls.length, 0);
});

test('airtableGetRecord: recordId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(
    () => airtableGetRecord({ token: TOKEN, fetch: mock.fetch }, 'appBase', 'Tasks', ''),
    /required/,
  );
  assert.equal(mock.calls.length, 0);
});
