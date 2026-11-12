/**
 * Tests for Telegram direct read client (worker F2, v0.89b).
 *
 * Wire shape theo Telegram Bot API (core.telegram.org/bots/api):
 * GET /bot<token>/getMe, GET /bot<token>/getUpdates,
 * GET /bot<token>/getChat. Envelope { ok, result } / { ok:false,
 * error_code, description }.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-telegram.test.mjs
 *
 * No live network, no real bot tokens: API đều mock fetch, token là
 * chuỗi fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  telegramGetChat,
  telegramGetMe,
  telegramGetUpdates,
} from '../packages/core/dist/clients/telegram.js';

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

const TOKEN = '123456:TEST-bot-token';

test('telegramGetMe: trả bot info, URL đúng dạng /bot<token>/getMe', async () => {
  const mock = makeFetch(() => ({
    body: { ok: true, result: { id: 123456, is_bot: true, first_name: 'OpenBot', username: 'openbot' } },
  }));
  const me = await telegramGetMe({ token: TOKEN, fetch: mock.fetch });
  assert.equal(me.id, 123456);
  assert.equal(me.isBot, true);
  assert.equal(me.username, 'openbot');
  assert.match(mock.calls[0].url, /api\.telegram\.org\/bot123456:TEST-bot-token\/getMe$/);
});

test('telegramGetUpdates: trả updates, parse message/chat/text', async () => {
  const mock = makeFetch(() => ({
    body: {
      ok: true,
      result: [
        { update_id: 1001, message: { message_id: 7, chat: { id: -100, type: 'group', title: 'Team' }, text: 'hello', date: 1762900000 } },
        { update_id: 1002 },
      ],
    },
  }));
  const updates = await telegramGetUpdates({ token: TOKEN, fetch: mock.fetch }, { limit: 10 });
  assert.equal(updates.length, 2);
  assert.equal(updates[0].updateId, 1001);
  assert.equal(updates[0].chatId, -100);
  assert.equal(updates[0].text, 'hello');
  assert.equal(updates[1].text, undefined);
  assert.match(mock.calls[0].url, /\/getUpdates\?limit=10$/);
});

test('telegramGetChat: đọc chat theo id', async () => {
  const mock = makeFetch(() => ({
    body: { ok: true, result: { id: -100, type: 'group', title: 'Team', username: 'teamgroup' } },
  }));
  const chat = await telegramGetChat({ token: TOKEN, fetch: mock.fetch }, '-100');
  assert.equal(chat.id, -100);
  assert.equal(chat.type, 'group');
  assert.equal(chat.title, 'Team');
  assert.match(mock.calls[0].url, /\/getChat\?chat_id=-100$/);
});

test('telegramGetMe: ok:false → lỗi có mã, KHÔNG lộ token', async () => {
  const mock = makeFetch(() => ({
    body: { ok: false, error_code: 401, description: 'Unauthorized: bot token invalid' },
  }));
  await assert.rejects(
    () => telegramGetMe({ token: TOKEN, fetch: mock.fetch }),
    (err) => {
      assert.match(err.message, /401/);
      assert.match(err.message, /bot token invalid/);
      assert.doesNotMatch(err.message, /TEST-bot-token/);
      return true;
    },
  );
});

test('telegramGetMe: HTTP 401 → lỗi rõ, KHÔNG lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => telegramGetMe({ token: TOKEN, fetch: mock.fetch }),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /TEST-bot-token/);
      return true;
    },
  );
});

test('telegramGetChat: chatId rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { ok: true, result: {} } }));
  await assert.rejects(() => telegramGetChat({ token: TOKEN, fetch: mock.fetch }, ''), /required/);
  assert.equal(mock.calls.length, 0);
});

test('telegramGetMe: thiếu token → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { ok: true, result: {} } }));
  await assert.rejects(() => telegramGetMe({ token: '', fetch: mock.fetch }), /token is required/);
  assert.equal(mock.calls.length, 0);
});
