/**
 * Tests for the v1.02 rescue A2A additions (Agent Card builder +
 * validator, JWS compact signing, ACP adapter) and vault additions
 * (scoped vault, encrypted export/import, audit log).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/a2a-vault-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AcpUpdateCollector,
  ScopedVault,
  Vault,
  VaultAuditLog,
  acpScopedVault,
  acpStopReasonToA2aState,
  buildAgentCard,
  decodeJwsUnverified,
  exportVaultNamespace,
  gatewayScopedVault,
  importVaultNamespace,
  isValidAgentCard,
  privateKeyFromPem,
  publicKeyFromPem,
  runA2aTaskViaAcp,
  signJws,
  validateAgentCard,
  verifyJws,
  wellKnownCardUrl,
} from '../packages/core/dist/index.js';
import { AcpAgentServer, AcpClient, createAcpPeerPair } from '../packages/core/dist/acp/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-a2a-v102-'));
}

test('agent card: builds a valid card; validator catches bad cards', () => {
  const card = buildAgentCard({
    name: 'open-bot',
    description: 'A local-first agent.',
    url: 'http://127.0.0.1:8765',
    skills: [{ id: 'chat', name: 'Chat', description: 'Chat with the agent.' }],
  });
  assert.equal(validateAgentCard(card).length, 0);
  assert.equal(isValidAgentCard(card), true);
  assert.equal(card.protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(wellKnownCardUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765/.well-known/agent-card.json');

  assert.ok(validateAgentCard({}).length > 0);
  assert.ok(validateAgentCard({ name: 'x', description: 'y', url: 'ftp://bad' }).length > 0);
  assert.equal(isValidAgentCard(null), false);
  assert.throws(() => buildAgentCard({ name: '', description: 'd', url: 'http://x' }), /needs a name/);
  assert.throws(() => buildAgentCard({ name: 'n', description: 'd', url: 'not-a-url' }), /must be http/);
});

test('jws: sign + verify round-trips; tampered payload is rejected', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const token = signJws({ sub: 'open-bot', iss: 'test' }, privateKey);
  assert.equal(token.split('.').length, 3);
  const decoded = verifyJws(token, publicKey);
  assert.equal(decoded.payload.sub, 'open-bot');
  assert.equal(decoded.header.alg, 'EdDSA');
  const { payload } = decodeJwsUnverified(token);
  assert.equal(payload.iss, 'test');
  const tampered = `${token.split('.')[0]}.${Buffer.from(JSON.stringify({ sub: 'mallory' })).toString('base64url')}.${token.split('.')[2]}`;
  assert.throws(() => verifyJws(tampered, publicKey), /signature/);
  assert.throws(() => verifyJws('not.a.token', publicKey));
  // PEM round-trip helpers.
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const restored = privateKeyFromPem(pem);
  const token2 = signJws({ sub: 'again' }, restored);
  assert.equal(verifyJws(token2, publicKey).payload.sub, 'again');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyJws(token, publicKeyFromPem(pubPem)).payload.sub, 'open-bot');
});

test('acp adapter: stop reasons map to A2A states; collector joins agent text', () => {
  assert.equal(acpStopReasonToA2aState('end_turn'), 'completed');
  assert.equal(acpStopReasonToA2aState('cancelled'), 'cancelled');
  assert.equal(acpStopReasonToA2aState('refusal'), 'failed');
  assert.equal(acpStopReasonToA2aState('max_tokens'), 'failed');
  assert.equal(acpStopReasonToA2aState('max_turn_requests'), 'failed');
  assert.equal(acpStopReasonToA2aState('other'), 'failed');

  const collector = new AcpUpdateCollector();
  collector.feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  collector.feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
  collector.feed({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read file' });
  assert.equal(collector.text, 'Hello \nworld\n[tool: read file]');
  assert.equal(collector.count, 3);
  collector.feed({ sessionUpdate: 'plan', entries: [] });
  assert.equal(collector.count, 4);
});

test('acp adapter: runs a task through the echo ACP agent and returns completed + artifact text', async () => {
  const { client, server } = createAcpPeerPair();
  const agent = new AcpAgentServer(server);
  const acp = new AcpClient(client, {});
  await acp.initialize();
  const session = await acp.newSession(tmpDir());
  const result = await runA2aTaskViaAcp(acp, session.sessionId, 'hello there');
  assert.equal(result.state, 'completed');
  assert.equal(result.stopReason, 'end_turn');
  assert.match(result.artifactText, /hello there/);
  assert.ok(result.updatesSeen >= 1);
  acp.close();
  client.close();
  server.close();
});

test('scoped vault: one namespace is visible, the rest is unreachable', () => {
  const dir = tmpDir();
  const vault = new Vault({ storePath: path.join(dir, 'vault.json') });
  vault.setSecret('gateway', 'telegram-token', 'tok-123');
  vault.setSecret('acp', 'agent-key', 'key-456');
  vault.setSecret('other', 'secret', 'nope');
  const gateway = gatewayScopedVault(vault);
  assert.equal(gateway.namespace, 'gateway');
  assert.equal(gateway.get('telegram-token'), 'tok-123');
  assert.equal(gateway.get('agent-key'), null);
  assert.deepEqual(gateway.list(), ['telegram-token']);
  gateway.set('slack-token', 'tok-789');
  assert.equal(vault.getSecret('gateway', 'slack-token'), 'tok-789');
  assert.equal(gateway.delete('slack-token'), true);
  assert.equal(gateway.get('slack-token'), null);
  const acp = acpScopedVault(vault);
  assert.equal(acp.get('agent-key'), 'key-456');
  assert.equal(acp.list().includes('agent-key'), true);
  const noList = new ScopedVault(vault, { namespace: 'gateway', allowList: false });
  assert.deepEqual(noList.list(), []);
});

test('vault export/import: round-trips a namespace encrypted; wrong passphrase fails', () => {
  const dir = tmpDir();
  const source = new Vault({ storePath: path.join(dir, 'source-vault.json') });
  source.setSecret('gateway', 'telegram-token', 'tok-123');
  source.setSecret('gateway', 'slack-token', 'tok-456');
  source.setSecret('other', 'secret', 'must-not-leak');
  const bundle = exportVaultNamespace(source, 'gateway', 'correct horse battery staple');
  assert.equal(bundle.namespace, 'gateway');
  assert.equal(bundle.data.length > 0, true, 'ciphertext is present');
  assert.ok(!('entries' in bundle), 'plaintext entries never leave the vault');

  const target = new Vault({ storePath: path.join(dir, 'target-vault.json') });
  const imported = importVaultNamespace(target, bundle, 'correct horse battery staple');
  assert.deepEqual(imported.sort(), ['slack-token', 'telegram-token']);
  assert.equal(target.getSecret('gateway', 'telegram-token'), 'tok-123');
  assert.equal(target.getSecret('other', 'secret'), null);

  assert.throws(() => importVaultNamespace(target, bundle, 'wrong passphrase'));
  assert.throws(() => exportVaultNamespace(source, 'gateway', ''));
  // Import into a different namespace.
  const renamed = importVaultNamespace(target, bundle, 'correct horse battery staple', { targetNamespace: 'gateway-copy' });
  assert.equal(renamed.length, 2);
  assert.equal(target.getSecret('gateway-copy', 'slack-token'), 'tok-456');
});

test('vault audit: appends records, reads newest first, skips bad lines', () => {
  const dir = tmpDir();
  const log = new VaultAuditLog(path.join(dir, 'vault-audit.jsonl'));
  log.append({ at: '2026-11-14T00:00:00Z', action: 'read', namespace: 'gateway', key: 'telegram-token', outcome: 'ok' });
  log.append({ at: '2026-11-14T00:01:00Z', action: 'read', namespace: 'gateway', key: 'missing', outcome: 'denied', detail: 'not found' });
  fs.appendFileSync(path.join(dir, 'vault-audit.jsonl'), 'not json\n');
  const records = log.read();
  assert.equal(records.length, 2);
  assert.equal(records[0].outcome, 'denied', 'newest first');
  assert.equal(log.read().filter((r) => r.outcome === 'denied').length, 1);
});
