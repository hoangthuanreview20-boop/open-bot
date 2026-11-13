/**
 * Tests for harness v2 — signed webhook receiver (v0.97, Team T5).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/harness-v097-webhook.test.mjs
 *
 * No real provider, no real credential, no outside network: the
 * receiver binds loopback on an OS-picked port, secrets are test-only
 * strings, and deliveries go to a temp dir. The HMAC scheme is the
 * same as the v1 automation webhook (`sha256=<hex>` over the raw
 * body), plus the optional timestamp replay guard.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HARNESS_V2_WEBHOOK_DEFAULT_PORT,
  SignedWebhookReceiver,
  WEBHOOK_MAX_BODY_BYTES,
  authenticateWebhookDelivery,
  computeWebhookSignature,
  verifyWebhookSignature,
  verifyWebhookTimestamp,
} from '../packages/core/dist/index.js';

const SECRET = 'test-only-webhook-secret';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const receivers = [];
async function startReceiver(opts) {
  const receiver = new SignedWebhookReceiver({
    port: 0,
    secretProvider: () => SECRET,
    ...opts,
  });
  receivers.push(receiver);
  await receiver.start();
  return receiver;
}
afterEach(async () => {
  for (const receiver of receivers.splice(0)) {
    await receiver.stop();
  }
});

async function post(port, targetId, body, signature, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/webhooks/${targetId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-open-bot-signature': signature } : {}), ...extraHeaders },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON answer — the status is what the test checks.
  }
  return { status: res.status, json, text };
}

// --- signature ------------------------------------------------------------

test('v0.97 signature: compute + verify round-trips, wrong secret / body / prefix fail', () => {
  const body = JSON.stringify({ hello: 'world' });
  const sig = computeWebhookSignature(SECRET, body);
  assert.ok(sig.startsWith('sha256='));
  assert.equal(verifyWebhookSignature(SECRET, body, sig), true);
  assert.equal(verifyWebhookSignature('other-secret', body, sig), false);
  assert.equal(verifyWebhookSignature(SECRET, '{"hello":"mars"}', sig), false);
  assert.equal(verifyWebhookSignature(SECRET, body, sig.slice('sha256='.length)), false);
  assert.equal(verifyWebhookSignature(SECRET, body, null), false);
  assert.equal(verifyWebhookSignature(SECRET, body, undefined), false);
  assert.equal(verifyWebhookSignature('', body, sig), false);
  assert.equal(verifyWebhookSignature(SECRET, Buffer.from(body, 'utf8'), sig), true);
});

test('v0.97 signature: timestamp replay guard accepts fresh, rejects stale / bad', () => {
  const now = new Date('2026-11-13T12:00:00.000Z');
  const fresh = String(Math.floor(now.getTime() / 1000));
  assert.equal(verifyWebhookTimestamp(fresh, now), true);
  assert.equal(verifyWebhookTimestamp(String(Math.floor(now.getTime() / 1000) - 301), now), false);
  assert.equal(verifyWebhookTimestamp(String(Math.floor(now.getTime() / 1000) + 301), now), false);
  assert.equal(verifyWebhookTimestamp('not-a-number', now), false);
  assert.equal(verifyWebhookTimestamp(null, now), false);
  assert.equal(verifyWebhookTimestamp('', now), false);
});

test('v0.97 signature: authenticate — missing secret / signature / stale timestamp', () => {
  const body = '{"a":1}';
  const sig = computeWebhookSignature(SECRET, body);
  assert.deepEqual(authenticateWebhookDelivery({ secret: SECRET, rawBody: body, signature: sig }), { ok: true });
  assert.equal(authenticateWebhookDelivery({ secret: null, rawBody: body, signature: sig }).ok, false);
  assert.equal(authenticateWebhookDelivery({ secret: SECRET, rawBody: body, signature: 'sha256=deadbeef' }).reason, 'bad-signature');
  assert.equal(authenticateWebhookDelivery({ secret: SECRET, rawBody: body, signature: null }).reason, 'missing-signature');
  const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal(
    authenticateWebhookDelivery({ secret: SECRET, rawBody: body, signature: sig, timestamp: staleTs, requireTimestamp: true }).reason,
    'stale-timestamp',
  );
  // Without requireTimestamp, a missing timestamp is fine.
  assert.equal(authenticateWebhookDelivery({ secret: SECRET, rawBody: body, signature: sig }).ok, true);
});

// --- receiver -------------------------------------------------------------

test('v0.97 receiver: default port is 8800 and non-loopback bind is refused', () => {
  assert.equal(HARNESS_V2_WEBHOOK_DEFAULT_PORT, 8800);
  assert.throws(
    () => new SignedWebhookReceiver({ host: '0.0.0.0', secretProvider: () => SECRET }),
    /loopback-only/,
  );
  assert.throws(
    () => new SignedWebhookReceiver({ host: '192.168.1.10', secretProvider: () => SECRET }),
    /allowNonLoopback/,
  );
  // Explicit opt-in is the only way to bind elsewhere.
  const ok = new SignedWebhookReceiver({ host: '0.0.0.0', allowNonLoopback: true, secretProvider: () => SECRET });
  assert.equal(ok.host, '0.0.0.0');
});

test('v0.97 receiver: signed delivery is accepted (202), queued, logged; stats count it', async () => {
  const dir = tmpDir('open-bot-h2-webhook-');
  const seen = [];
  const receiver = await startReceiver({ logDir: dir, onDelivery: (q) => seen.push(q) });
  const port = receiver.listeningPort;
  assert.ok(port !== null && port > 0);
  const body = JSON.stringify({ text: 'hello from CI' });
  const { status, json } = await post(port, 'routine-1', body, computeWebhookSignature(SECRET, body));
  assert.equal(status, 202);
  assert.equal(json.ok, true);
  assert.equal(typeof json.deliveryId, 'string');
  assert.equal(receiver.queuedCount, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].delivery.targetId, 'routine-1');
  assert.deepEqual(seen[0].payload, { text: 'hello from CI' });
  const stats = receiver.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.rejected, 0);
  // Audit log on disk, with a sanitized preview and no secret.
  const log = fs.readFileSync(path.join(dir, 'webhook-deliveries-v2.ndjson'), 'utf8');
  assert.match(log, /"verified":true/);
  assert.doesNotMatch(log, new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const drained = receiver.drain();
  assert.equal(drained.length, 1);
  assert.equal(receiver.queuedCount, 0);
});

test('v0.97 receiver: unsigned / wrongly signed / missing-secret deliveries are rejected (401) and never queued', async () => {
  const dir = tmpDir('open-bot-h2-webhook-');
  const seen = [];
  const receiver = await startReceiver({ logDir: dir, onDelivery: (q) => seen.push(q) });
  const port = receiver.listeningPort;
  const body = JSON.stringify({ text: 'x' });
  const bad = await post(port, 'routine-1', body, 'sha256=0000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(bad.status, 401);
  const unsigned = await post(port, 'routine-1', body, null);
  assert.equal(unsigned.status, 401);
  assert.equal(seen.length, 0);
  assert.equal(receiver.queuedCount, 0);
  const stats = receiver.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.rejected, 2);
  assert.equal(stats.rejectedByReason['bad-signature'], 1);
  assert.equal(stats.rejectedByReason['missing-signature'], 1);
  assert.equal(receiver.listDeliveries().every((d) => d.verified === false), true);

  // No secret configured for this target at all.
  const noSecret = new SignedWebhookReceiver({ port: 0, secretProvider: () => null });
  receivers.push(noSecret);
  await noSecret.start();
  const denied = await post(noSecret.listeningPort, 'routine-9', body, computeWebhookSignature(SECRET, body));
  assert.equal(denied.status, 401);
  assert.equal(noSecret.stats().rejectedByReason['missing-secret'], 1);
});

test('v0.97 receiver: invalid JSON is 400, oversized body is 413, unknown route is 404, health is 200', async () => {
  const receiver = await startReceiver({});
  const port = receiver.listeningPort;
  const badJson = await post(port, 'routine-1', '{not json', computeWebhookSignature(SECRET, '{not json'));
  assert.equal(badJson.status, 400);
  const big = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1);
  const bigBody = JSON.stringify({ blob: big });
  const tooBig = await post(port, 'routine-1', bigBody, computeWebhookSignature(SECRET, bigBody));
  assert.equal(tooBig.status, 413);
  const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(notFound.status, 404);
  const getOnWebhook = await fetch(`http://127.0.0.1:${port}/webhooks/routine-1`);
  assert.equal(getOnWebhook.status, 404);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const healthJson = await health.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.port, 0);
  assert.equal(receiver.stats().total, 2);
});

test('v0.97 receiver: queue overflow drops the oldest item and counts the drop', async () => {
  const receiver = await startReceiver({ maxQueue: 2 });
  const port = receiver.listeningPort;
  for (let i = 0; i < 4; i++) {
    const body = JSON.stringify({ n: i });
    const { status } = await post(port, 'routine-1', body, computeWebhookSignature(SECRET, body));
    assert.equal(status, 202);
  }
  assert.equal(receiver.queuedCount, 2);
  assert.equal(receiver.dropped.length, 2);
  const drained = receiver.drain();
  assert.deepEqual(drained.map((q) => q.payload.n), [2, 3]);
});

test('v0.97 receiver: onDelivery errors are counted, never crash the server', async () => {
  const receiver = await startReceiver({
    onDelivery: () => {
      throw new Error('host blew up');
    },
  });
  const port = receiver.listeningPort;
  const body = JSON.stringify({ n: 1 });
  const { status } = await post(port, 'routine-1', body, computeWebhookSignature(SECRET, body));
  assert.equal(status, 202);
  // Let the async handler run.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(receiver.deliveryHandlerErrors, 1);
  // The server still answers afterwards.
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
});

test('v0.97 receiver: requireTimestamp rejects a good signature with a stale timestamp', async () => {
  const receiver = await startReceiver({ requireTimestamp: true });
  const port = receiver.listeningPort;
  const body = JSON.stringify({ n: 1 });
  const sig = computeWebhookSignature(SECRET, body);
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  const denied = await post(port, 'routine-1', body, sig, { 'x-open-bot-timestamp': stale });
  assert.equal(denied.status, 401);
  const fresh = String(Math.floor(Date.now() / 1000));
  const ok = await post(port, 'routine-1', body, sig, { 'x-open-bot-timestamp': fresh });
  assert.equal(ok.status, 202);
});
