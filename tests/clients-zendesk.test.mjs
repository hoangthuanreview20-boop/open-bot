/**
 * Tests for Zendesk direct read client (worker F2, v0.89b, stretch).
 *
 * Wire shape theo Zendesk API v2
 * (developer.zendesk.com/api-reference/ticketing/tickets/tickets/):
 * GET /api/v2/tickets.json, GET /api/v2/tickets/{id}.json,
 * GET /api/v2/search.json?query=type:ticket ...
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/clients-zendesk.test.mjs
 *
 * No live network, no real tokens: API đều mock fetch, token là chuỗi
 * fake. Mock-verified, chưa đối chiếu live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zendeskGetTicket,
  zendeskListTickets,
  zendeskSearchTickets,
} from '../packages/core/dist/clients/zendesk.js';

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

const OPTS = { subdomain: 'mycompany', token: 'zd-test-token' };

function optsWithFetch(mock) {
  return { ...OPTS, fetch: mock.fetch };
}

test('zendeskListTickets: trả tickets, base URL theo subdomain', async () => {
  const mock = makeFetch(() => ({
    body: {
      tickets: [
        { id: 1, subject: 'Login issue', status: 'open', requester_id: 10, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' },
        { id: 2, subject: 'Refund', status: 'solved', requester_id: 11, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' },
      ],
      next_page: null,
    },
  }));
  const tickets = await zendeskListTickets(optsWithFetch(mock), 25);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].subject, 'Login issue');
  assert.equal(tickets[1].status, 'solved');
  assert.match(mock.calls[0].url, /mycompany\.zendesk\.com\/api\/v2\/tickets\.json/);
  assert.match(mock.calls[0].url, /page%5Bsize%5D=25/);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${OPTS.token}`);
});

test('zendeskGetTicket: đọc ticket theo id', async () => {
  const mock = makeFetch(() => ({
    body: { ticket: { id: 1, subject: 'Login issue', status: 'open', requester_id: 10 } },
  }));
  const ticket = await zendeskGetTicket(optsWithFetch(mock), 1);
  assert.equal(ticket.id, 1);
  assert.equal(ticket.subject, 'Login issue');
  assert.match(mock.calls[0].url, /\/api\/v2\/tickets\/1\.json$/);
});

test('zendeskSearchTickets: query có tiền tố type:ticket', async () => {
  const mock = makeFetch(() => ({
    body: { results: [{ id: 2, subject: 'Refund', status: 'solved' }], count: 1 },
  }));
  const tickets = await zendeskSearchTickets(optsWithFetch(mock), 'status<solved refund');
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].id, 2);
  assert.match(decodeURIComponent(mock.calls[0].url).replace(/\+/g, ' '), /query=type:ticket status<solved refund/);
});

test('zendeskListTickets: 401 → lỗi rõ, không lộ token', async () => {
  const mock = makeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => zendeskListTickets(optsWithFetch(mock)),
    (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /zd-test-token/);
      return true;
    },
  );
});

test('zendeskGetTicket: 404 → lỗi rõ', async () => {
  const mock = makeFetch(() => ({ status: 404, body: {} }));
  await assert.rejects(() => zendeskGetTicket(optsWithFetch(mock), 999), /404/);
});

test('zendeskGetTicket: ticketId không hợp lệ → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: {} }));
  await assert.rejects(() => zendeskGetTicket(optsWithFetch(mock), 0), /ticketId is invalid/);
  assert.equal(mock.calls.length, 0);
});

test('zendeskSearchTickets: query rỗng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { results: [] } }));
  await assert.rejects(() => zendeskSearchTickets(optsWithFetch(mock), ''), /required/);
  assert.equal(mock.calls.length, 0);
});

test('zendeskListTickets: subdomain sai định dạng → lỗi input', async () => {
  const mock = makeFetch(() => ({ body: { tickets: [] } }));
  await assert.rejects(
    () => zendeskListTickets({ subdomain: 'bad subdomain!', token: 't', fetch: mock.fetch }),
    /subdomain is invalid/,
  );
  assert.equal(mock.calls.length, 0);
});
