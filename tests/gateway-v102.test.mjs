/**
 * Tests for the v1.02 rescue gateway module (config, sessions,
 * rate limit, adapters, manager, audit, command parsing).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/gateway-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DiscordAdapter,
  GatewayAuditLog,
  GatewayConfigStore,
  GatewayManager,
  GatewayRateLimiter,
  GatewaySessionStore,
  MockGatewayTransport,
  SlackAdapter,
  TelegramAdapter,
  WhatsappAdapter,
  defaultGatewayConfig,
  gatewayUserId,
  normalizeGatewayConfig,
  parseGatewayCommand,
} from '../packages/core/dist/gateway/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-gateway-v102-'));
}

test('gateway config: all channels disabled by default; enable persists; corrupt file fails closed', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'gateway-config.json');
  const store = new GatewayConfigStore(file);
  const config = store.get();
  assert.equal(config.channels.telegram.enabled, false);
  assert.equal(config.channels.whatsapp.enabled, false);
  store.setChannelEnabled('telegram', true);
  store.setChannel('telegram', { mock: true });
  assert.equal(store.getChannel('telegram').enabled, true);
  assert.equal(store.getChannel('telegram').mock, true);
  const reloaded = new GatewayConfigStore(file);
  assert.equal(reloaded.getChannel('telegram').enabled, true);
  assert.equal(reloaded.getChannel('telegram').mock, true);

  fs.writeFileSync(file, '{corrupt');
  const failClosed = new GatewayConfigStore(file);
  assert.equal(failClosed.getChannel('telegram').enabled, false);

  const normalized = normalizeGatewayConfig({ version: 1, channels: { telegram: { enabled: true } } });
  assert.equal(normalized.channels.telegram.enabled, true);
  assert.equal(normalized.channels.slack.enabled, false);
  assert.equal(defaultGatewayConfig().maxHistoryPerSession, 100);
});

test('gateway session store: one user id = one session; history capped; persists', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'gateway-sessions.json');
  const store = new GatewaySessionStore(file, 2);
  const first = store.getOrCreate('telegram:42', 'bot-1');
  const second = store.getOrCreate('telegram:42');
  assert.equal(first.id, second.id);
  assert.equal(store.size, 1);
  assert.equal(store.getByUser('telegram:42')?.id, first.id);
  assert.equal(gatewayUserId('telegram', '42'), 'telegram:42');

  const message = (text) => ({
    id: `m-${text}`, channel: 'telegram', senderId: '42', senderName: '',
    chatId: '42', text, receivedAt: new Date().toISOString(),
  });
  store.recordMessage('telegram:42', message('one'));
  store.recordMessage('telegram:42', message('two'));
  store.recordMessage('telegram:42', message('three'));
  const session = store.get(first.id);
  assert.equal(session.messages.length, 2, 'history capped at 2');
  assert.equal(session.messages[0].text, 'two');
  assert.deepEqual(session.channels, ['telegram']);
  assert.equal(store.delete(first.id), true);
  assert.equal(store.get(first.id), undefined);
  assert.equal(store.delete(first.id), false);

  const other = store.getOrCreate('slack:42');
  assert.notEqual(other.id, first.id, 'channel is part of the user id');
  const reloaded = new GatewaySessionStore(file, 2);
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.getByUser('slack:42')?.id, other.id);
});

test('rate limiter: allows up to the limit, then blocks; remaining counts down', () => {
  const limiter = new GatewayRateLimiter({ maxPerWindow: 2, windowMs: 60_000 });
  assert.equal(limiter.tryConsume('sender-1'), true);
  assert.equal(limiter.remaining('sender-1'), 1);
  assert.equal(limiter.tryConsume('sender-1'), true);
  assert.equal(limiter.tryConsume('sender-1'), false);
  assert.equal(limiter.remaining('sender-1'), 0);
  assert.equal(limiter.tryConsume('sender-2'), true, 'limits are per sender');
  // A window in the past is expired.
  const now = Date.now();
  assert.equal(limiter.tryConsume('sender-3', now - 120_000), true);
  assert.equal(limiter.remaining('sender-3', now), 2, 'the old hit fell out of the window');
});

test('adapters: normalize inbound payloads into GatewayMessages; malformed payloads -> undefined', () => {
  const telegram = new TelegramAdapter().normalize({
    message: { chat: { id: 42 }, from: { id: 7, first_name: 'Ada' }, text: 'hello', message_id: 7 },
    update_id: 100,
  });
  assert.ok(telegram);
  assert.equal(telegram.channel, 'telegram');
  assert.equal(telegram.senderId, '7');
  assert.equal(telegram.chatId, '42');
  assert.equal(telegram.text, 'hello');
  assert.equal(telegram.senderName, 'Ada');

  const command = new TelegramAdapter().normalize({
    message: { chat: { id: 1 }, from: { id: 1 }, text: '/new write a poem' },
  });
  assert.equal(command.command, 'new');
  assert.equal(command.commandArgs, 'write a poem');

  const slack = new SlackAdapter().normalize({
    event: { type: 'message', channel: 'C1', user: 'U1', text: 'hey' },
  });
  assert.ok(slack);
  assert.equal(slack.channel, 'slack');
  assert.equal(slack.chatId, 'C1');
  assert.equal(slack.senderId, 'U1');
  assert.equal(new SlackAdapter().normalize({ event: { type: 'message', bot_id: 'B1', text: 'bot' } }), undefined, 'other bots are ignored');

  const discord = new DiscordAdapter().normalize({
    d: { channel_id: 'D1', author: { id: 'A1', username: 'bob' }, content: 'yo', id: 'M1' },
  });
  assert.ok(discord);
  assert.equal(discord.chatId, 'D1');
  assert.equal(discord.senderName, 'bob');
  assert.equal(new DiscordAdapter().normalize({ d: { content: 'x', author: { bot: true, id: 'B' } } }), undefined);

  const whatsapp = new WhatsappAdapter().normalize({
    entry: [{ changes: [{ value: { messages: [{ from: '5511999999999', text: { body: 'oi' }, id: 'wamid.1' }] } }] }],
  });
  assert.ok(whatsapp);
  assert.equal(whatsapp.channel, 'whatsapp');
  assert.equal(whatsapp.senderId, '5511999999999');
  assert.equal(whatsapp.text, 'oi');

  assert.equal(new TelegramAdapter().normalize({}), undefined);
  assert.equal(new TelegramAdapter().normalize({ message: { chat: { id: 1 } } }), undefined);
  assert.equal(new SlackAdapter().normalize({}), undefined);
});

test('adapters: format shapes the outbound payload per channel', () => {
  assert.deepEqual(new TelegramAdapter().format({ channel: 'telegram', chatId: '42', text: 'hi' }), { chat_id: '42', text: 'hi' });
  assert.deepEqual(new SlackAdapter().format({ channel: 'slack', chatId: 'C1', text: 'hi' }), { channel: 'C1', text: 'hi' });
  assert.deepEqual(new DiscordAdapter().format({ channel: 'discord', chatId: 'D1', text: 'hi' }), { content: 'hi' });
  assert.deepEqual(
    new WhatsappAdapter().format({ channel: 'whatsapp', chatId: '5511', text: 'hi' }),
    { messaging_product: 'whatsapp', to: '5511', type: 'text', text: { body: 'hi' } },
  );
});

test('manager: receive routes, rate-limits, replies and reuses the shared session', async () => {
  const dir = tmpDir();
  const transport = new MockGatewayTransport();
  const manager = new GatewayManager({
    dataDir: path.join(dir, 'gateway'),
    transport,
    rateLimiter: new GatewayRateLimiter({ maxPerWindow: 2, windowMs: 60_000 }),
    onMessage: async (message) => `got: ${message.text}`,
  });
  const statuses = manager.channelStatus();
  assert.equal(statuses.telegram, 'disabled');
  assert.equal(statuses.slack, 'disabled');

  // Disabled channel: not handled.
  const disabled = await manager.receive('telegram', {
    message: { chat: { id: 1 }, from: { id: 1 }, text: 'hello' },
  });
  assert.equal(disabled.handled, false);
  assert.equal(disabled.reason, 'channel_disabled');

  // Enable telegram (mock) and receive twice: both handled, same session.
  manager.config.setChannel('telegram', { enabled: true, mock: true });
  assert.equal(manager.channelStatus().telegram, 'mock');
  const first = await manager.receive('telegram', {
    message: { chat: { id: 1 }, from: { id: 1 }, text: 'hello' },
  });
  assert.equal(first.handled, true);
  assert.equal(first.replySent, true);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].text, 'got: hello');
  const second = await manager.receive('telegram', {
    message: { chat: { id: 1 }, from: { id: 1 }, text: 'two' },
  });
  assert.equal(second.handled, true);
  assert.equal(second.sessionId, first.sessionId, 'same sender reuses the session');

  // Third message from the same sender hits the rate limit.
  const limited = await manager.receive('telegram', {
    message: { chat: { id: 1 }, from: { id: 1 }, text: 'three' },
  });
  assert.equal(limited.handled, false);
  assert.equal(limited.reason, 'rate_limited');

  // Host-initiated send goes through the transport.
  const id = await manager.send({ channel: 'telegram', chatId: '1', text: 'outbound' });
  assert.match(id, /^mock-/);
  assert.equal(transport.sent.length, 3);

  // The audit log records inbound + outbound (no message text).
  const audit = new GatewayAuditLog(path.join(dir, 'gateway', 'gateway-audit.jsonl'));
  const records = audit.read();
  assert.ok(records.length >= 3);
  assert.ok(records.some((r) => r.direction === 'inbound' && r.outcome === 'ok'));
  assert.ok(records.some((r) => r.direction === 'inbound' && r.outcome === 'rate_limited'));
  assert.ok(records.some((r) => r.direction === 'outbound'));
  assert.ok(records.every((r) => !JSON.stringify(r).includes('got: hello')), 'no message text in the audit log');
});

test('manager: no handler -> handled false with reason no_handler; same raw sender id on two channels = two sessions', async () => {
  const dir = tmpDir();
  const manager = new GatewayManager({ dataDir: path.join(dir, 'gateway') });
  manager.config.setChannelEnabled('telegram', true);
  manager.config.setChannelEnabled('slack', true);
  const noHandler = await manager.receive('telegram', {
    message: { chat: { id: 1 }, from: { id: 1 }, text: 'hello' },
  });
  assert.equal(noHandler.handled, false);
  assert.equal(noHandler.reason, 'no_handler');

  const withHandler = new GatewayManager({
    dataDir: path.join(dir, 'gateway2'),
    onMessage: async () => 'ok',
  });
  withHandler.config.setChannelEnabled('telegram', true);
  withHandler.config.setChannelEnabled('slack', true);
  const telegram = await withHandler.receive('telegram', {
    message: { chat: { id: 1 }, from: { id: 1 }, text: 'hi' },
  });
  const slack = await withHandler.receive('slack', {
    event: { type: 'message', channel: 'C1', user: '1', text: 'hi' },
  });
  assert.notEqual(telegram.sessionId, slack.sessionId, 'user id is channel-scoped unless the host maps users');
});

test('parseGatewayCommand: parses /command args, ignores plain text', () => {
  assert.deepEqual(parseGatewayCommand('/help'), { command: 'help' });
  assert.deepEqual(parseGatewayCommand('/new write a poem'), { command: 'new', commandArgs: 'write a poem' });
  assert.deepEqual(parseGatewayCommand('hello'), {});
  assert.deepEqual(parseGatewayCommand('/'), { command: '' });
});

test('gateway audit: appends records, reads newest first, skips bad lines', () => {
  const dir = tmpDir();
  const log = new GatewayAuditLog(path.join(dir, 'gateway-audit.jsonl'));
  log.append({ at: '2026-11-14T00:00:00Z', direction: 'inbound', channel: 'telegram', chatId: '1', outcome: 'ok' });
  log.append({ at: '2026-11-14T00:01:00Z', direction: 'inbound', channel: 'telegram', chatId: '1', outcome: 'disabled' });
  fs.appendFileSync(path.join(dir, 'gateway-audit.jsonl'), 'not json\n');
  const records = log.read();
  assert.equal(records.length, 2);
  assert.equal(records[0].outcome, 'disabled', 'newest first');
});
