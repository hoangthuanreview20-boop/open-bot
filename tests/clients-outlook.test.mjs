/**
 * Tests for Outlook direct read client (worker F2, v0.89b).
 *
 * Wire shape theo Microsoft Graph v1.0
 * (learn.microsoft.com/en-us/graph/api/resources/message, mailfolder):
 * GET /v1.0/me/messages, GET /v1.0/me/mailFolders, GET /v1.0/me/messages?$search.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-outlook.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  outlookListFolders,
  outlookListMessages,
  outlookSearchMessages,
} from '../packages/core/dist/clients/outlook.js';

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

const TOKEN = 'graph-test-token';

test('outlookListMessages: trả messages, parse from.emailAddress', async () => {
  const mock = makeFetch(() => ({
    body: {
      value: [
        {
          id: 'm1',
          subject: 'Hi',
          from: { emailAddress: { address: 'boss@example.com', name: 'Boss' } },
          receivedDateTime: '2026-11-11T08:00:00Z',
          isRead: false,
        },
      ],
    },
  }));
  const msgs = await outlookListMessages({ token: TOKEN, fetch: mock.fetch }, 5);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].subject, 'Hi');
  assert.equal(msgs[0].fromAddress, 'boss@example.com');
  assert.equal(msgs[0].fromName, 'Boss');
  assert.equal(msgs[0].isRead, false);
  assert.match(mock.calls[0].url, /graph\.microsoft\.com\/v1\.0\/me\/messages/);
  assert.match(mock.calls[0].url, /%24top=5/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('outlookListFolders: trả folders với counts', async () => {
  const mock = makeFetch(() => ({
    body: {
      value: [
        { id: 'f1', displayName: 'Inbox', totalItemCount: 10, unreadItemCount: 3 },
        { id: 'f2', displayName: 'Sent Items', totalItemCount: 4, unreadItemCount: 0 },
      ],
    },
  }));
  const folders = await outlookListFolders({ token: TOKEN, fetch: mock.fetch });
  assert.equal(folders.length, 2);
  assert.equal(folders[0].displayName, 'Inbox');
  assert.equal(folders[0].unreadItemCount, 3);
  assert.match(mock.calls[0].url, /\/v1\.0\/me\/mailFolders/);
});

test('outlookSearchMessages: $search có trong URL', async () => {
  const mock = makeFetch(() => ({ body: { value: [] } }));
  const msgs = await outlookSearchMessages({ token: TOKEN, fetch: mock.fetch }, 'report');
  assert.deepEqual(msgs, []);
  assert.match(mock.calls[0].url, /%24search=/);
  assert.match(decodeURIComponent(mock.calls[0].url), /\$search="report"/);
});

test('outlookListMessages: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => outlookListMessages({ token: TOKEN, fetch: mock.fetch }),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /graph-test-token/);
      return true;
    },
  );
});

test('outlookListFolders: 403 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 403, body: {} }));
  await assert.rejects(() => outlookListFolders({ token: TOKEN, fetch: mock.fetch }), /403/);
});

test('outlookSearchMessages: query rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { value: [] } }));
  await assert.rejects(
    () => outlookSearchMessages({ token: TOKEN, fetch: mock.fetch }, ''),
    /required/,
  );
  assert.equal(mock.calls.length, 0);
});

test('outlookListMessages: thiếu token → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { value: [] } }));
  await assert.rejects(() => outlookListMessages({ token: '', fetch: mock.fetch }), /token is required/);
  assert.equal(mock.calls.length, 0);
});
