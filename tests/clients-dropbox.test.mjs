/**
 * Tests for Dropbox direct read client (worker F2, v0.89b).
 *
 * Wire shape theo Dropbox API v2
 * (developers.dropbox.com/documentation/http/documentation):
 * POST /2/files/list_folder (+ /list_folder/continue),
 * POST /2/files/get_metadata, POST /2/files/search_v2.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-dropbox.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dropboxGetMetadata,
  dropboxListFolder,
  dropboxSearch,
} from '../packages/core/dist/clients/dropbox.js';

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

const TOKEN = 'sl-test-token';

test('dropboxListFolder: trả entries file/folder + cursor/hasMore', async () => {
  const mock = makeFetch(() => ({
    body: {
      entries: [
        { '.tag': 'folder', name: 'Docs', path_lower: '/docs', id: 'id:1' },
        { '.tag': 'file', name: 'a.txt', path_lower: '/a.txt', id: 'id:2', size: 42, client_modified: '2026-01-01T00:00:00Z' },
      ],
      cursor: 'cur-1',
      has_more: true,
    },
  }));
  const res = await dropboxListFolder({ token: TOKEN, fetch: mock.fetch }, '');
  assert.equal(res.entries.length, 2);
  assert.equal(res.entries[0].tag, 'folder');
  assert.equal(res.entries[1].size, 42);
  assert.equal(res.cursor, 'cur-1');
  assert.equal(res.hasMore, true);
  assert.match(mock.calls[0].url, /\/2\/files\/list_folder$/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.parse(mock.calls[0].init.body).path, '');
});

test('dropboxListFolder: có cursor → gọi list_folder/continue', async () => {
  const mock = makeFetch(() => ({ body: { entries: [], cursor: 'cur-2', has_more: false } }));
  const res = await dropboxListFolder({ token: TOKEN, fetch: mock.fetch }, '', { cursor: 'cur-1' });
  assert.equal(res.hasMore, false);
  assert.match(mock.calls[0].url, /\/2\/files\/list_folder\/continue$/);
  assert.equal(JSON.parse(mock.calls[0].init.body).cursor, 'cur-1');
});

test('dropboxGetMetadata: đọc metadata một path', async () => {
  const mock = makeFetch(() => ({
    body: { '.tag': 'file', name: 'a.txt', path_lower: '/a.txt', id: 'id:2', size: 42 },
  }));
  const entry = await dropboxGetMetadata({ token: TOKEN, fetch: mock.fetch }, '/a.txt');
  assert.equal(entry.name, 'a.txt');
  assert.equal(entry.tag, 'file');
  assert.match(mock.calls[0].url, /\/2\/files\/get_metadata$/);
});

test('dropboxSearch: trả matches theo shape search_v2', async () => {
  const mock = makeFetch(() => ({
    body: {
      matches: [
        { metadata: { metadata: { '.tag': 'file', name: 'report.pdf', path_lower: '/report.pdf', id: 'id:3' } } },
      ],
    },
  }));
  const entries = await dropboxSearch({ token: TOKEN, fetch: mock.fetch }, 'report');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'report.pdf');
  assert.match(mock.calls[0].url, /\/2\/files\/search_v2$/);
});

test('dropboxListFolder: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => dropboxListFolder({ token: TOKEN, fetch: mock.fetch }, ''),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /sl-test-token/);
      return true;
    },
  );
});

test('dropboxGetMetadata: path rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(() => dropboxGetMetadata({ token: TOKEN, fetch: mock.fetch }, ''), /required/);
  assert.equal(mock.calls.length, 0);
});

test('dropboxSearch: query rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(() => dropboxSearch({ token: TOKEN, fetch: mock.fetch }, '  '), /required/);
  assert.equal(mock.calls.length, 0);
});
