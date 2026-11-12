/**
 * Tests for Notion direct read client (worker F2, v0.89b).
 *
 * Wire shape theo Notion API version 2022-06-28
 * (developers.notion.com/reference): POST /v1/search, GET /v1/pages/{id},
 * POST /v1/databases/{id}/query.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-notion.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake ('secret-test'). Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTION_API_VERSION,
  notionGetPage,
  notionQueryDatabase,
  notionSearch,
} from '../packages/core/dist/clients/notion.js';

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

const TOKEN = 'secret-test-token';

test('notionSearch: trả pages + title trích từ properties, header đúng version', async () => {
  const mock = makeFetch(() => ({
    body: {
      results: [
        {
          object: 'page',
          id: 'pg-1',
          properties: { Name: { type: 'title', title: [{ plain_text: 'Hello' }] } },
          url: 'https://notion.so/pg-1',
        },
        { object: 'database', id: 'db-1', properties: {}, url: 'https://notion.so/db-1' },
      ],
      has_more: false,
    },
  }));
  const results = await notionSearch({ token: TOKEN, fetch: mock.fetch }, 'Hello');
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'pg-1');
  assert.equal(results[0].object, 'page');
  assert.equal(results[0].title, 'Hello');
  assert.equal(results[1].object, 'database');
  assert.equal(mock.calls.length, 1);
  assert.match(mock.calls[0].url, /\/v1\/search$/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(mock.calls[0].init.headers['Notion-Version'], NOTION_API_VERSION);
  assert.equal(JSON.parse(mock.calls[0].init.body).query, 'Hello');
});

test('notionGetPage: đọc page theo id', async () => {
  const mock = makeFetch(() => ({
    body: {
      id: 'pg-9',
      object: 'page',
      properties: { Title: { type: 'title', title: [{ plain_text: 'Doc' }] } },
      url: 'https://notion.so/pg-9',
    },
  }));
  const page = await notionGetPage({ token: TOKEN, fetch: mock.fetch }, 'pg-9');
  assert.equal(page.id, 'pg-9');
  assert.equal(page.title, 'Doc');
  assert.match(mock.calls[0].url, /\/v1\/pages\/pg-9$/);
});

test('notionQueryDatabase: liệt kê rows của database', async () => {
  const mock = makeFetch(() => ({
    body: {
      results: [
        { id: 'row-1', properties: { Name: { type: 'title', title: [{ plain_text: 'Row 1' }] } } },
      ],
      has_more: false,
    },
  }));
  const rows = await notionQueryDatabase({ token: TOKEN, fetch: mock.fetch }, 'db-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Row 1');
  assert.match(mock.calls[0].url, /\/v1\/databases\/db-1\/query$/);
});

test('notionSearch: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: { message: 'unauthorized' } }));
  await assert.rejects(
    () => notionSearch({ token: TOKEN, fetch: mock.fetch }, 'x'),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /secret-test-token/);
      return true;
    },
  );
});

test('notionGetPage: 404 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 404, body: {} }));
  await assert.rejects(() => notionGetPage({ token: TOKEN, fetch: mock.fetch }, 'missing'), /404/);
});

test('notionGetPage: pageId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(() => notionGetPage({ token: TOKEN, fetch: mock.fetch }, ''), /required/);
  assert.equal(mock.calls.length, 0);
});

test('notionQueryDatabase: databaseId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(
    () => notionQueryDatabase({ token: TOKEN, fetch: mock.fetch }, '  '),
    /required/,
  );
  assert.equal(mock.calls.length, 0);
});
