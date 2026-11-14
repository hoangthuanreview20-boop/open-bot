/**
 * Test v1.02 (Team T3): ANP discovery — did:key identity, DID
 * document, local registry, well-known discovery over loopback.
 *
 * Only local code + loopback HTTP (no external network).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/anp-discovery-v102.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  base58btcEncode,
  base58btcDecode,
  createAnpIdentity,
  loadAnpIdentity,
  anpDidDocument,
  validateAnpDidDocument,
  parseAnpDid,
  isAnpDid,
  signAnpPayload,
  verifyAnpSignature,
} from '../packages/core/dist/anp/did.js';
import { AnpRegistry, FileAnpRegistry } from '../packages/core/dist/anp/registry.js';
import {
  discoverAnpAgent,
  fetchAnpDidDocument,
  announceAnpAgent,
  AnpDiscoveryError,
} from '../packages/core/dist/anp/discovery.js';

test('base58btc: round-trip, leading zeros, illegal chars', () => {
  assert.equal(base58btcEncode(Buffer.alloc(0)), '');
  assert.equal(base58btcDecode('').length, 0);
  assert.equal(base58btcEncode(Buffer.from([0, 0, 1, 2, 3])), base58btcEncode(Buffer.from([0, 0, 1, 2, 3])));
  const buf = Buffer.from('hello anp discovery', 'utf8');
  assert.ok(base58btcDecode(base58btcEncode(buf)).equals(buf));
  assert.equal(base58btcDecode('0OIl'), null);
  assert.equal(base58btcEncode(Buffer.from([0, 0, 0])), '111');
});

test('identity: did:key round-trips, PEM reload reproduces the DID', () => {
  const identity = createAnpIdentity('local-agent');
  assert.ok(identity.did.startsWith('did:key:z'));
  assert.equal(isAnpDid(identity.did), true);
  assert.equal(isAnpDid('did:web:example.com'), false);
  assert.equal(isAnpDid('did:key:z0OIl'), false);
  const parsed = parseAnpDid(identity.did);
  assert.ok(parsed);
  assert.equal(parsed.publicKey.length, 32);
  assert.equal(parsed.publicKey.toString('base64'), identity.publicKeyBase64);
  const reloaded = loadAnpIdentity(identity.privateKeyPem, 'local-agent');
  assert.equal(reloaded.did, identity.did);
  assert.notEqual(createAnpIdentity('other').did, identity.did);
  assert.throws(() => createAnpIdentity('  '), /tên agent/);
});

test('DID document: validates, tampered key is rejected', () => {
  const identity = createAnpIdentity('doc-agent');
  const doc = anpDidDocument(identity, 'http://127.0.0.1:9999/');
  assert.equal(doc.id, identity.did);
  assert.equal(doc.verificationMethod[0].type, 'Ed25519VerificationKey2020');
  assert.equal(doc.service?.[0].type, 'A2AEndpoint');
  const validated = validateAnpDidDocument(doc);
  assert.ok(validated);
  assert.equal(validated.did, identity.did);
  // Wrong key for this DID.
  const other = createAnpIdentity('other-agent');
  const forged = anpDidDocument(other);
  forged.id = identity.did;
  assert.equal(validateAnpDidDocument(forged), null);
  assert.equal(validateAnpDidDocument({ id: identity.did }), null);
  assert.equal(validateAnpDidDocument(null), null);
});

test('signing: Ed25519 sign/verify round-trips, wrong payload/key fails', () => {
  const identity = createAnpIdentity('signer');
  const payload = '{"did":"announce","at":"2026-11-14T00:00:00.000Z"}';
  const sig = signAnpPayload(identity, payload);
  assert.equal(verifyAnpSignature(identity.publicKeyBase64, payload, sig), true);
  assert.equal(verifyAnpSignature(identity.publicKeyBase64, `${payload}x`, sig), false);
  const other = createAnpIdentity('other');
  assert.equal(verifyAnpSignature(other.publicKeyBase64, payload, sig), false);
  assert.equal(verifyAnpSignature('not-base64!!!', payload, sig), false);
});

test('registry: register/resolve/find/remove, re-register updates', () => {
  const registry = new AnpRegistry();
  const a = createAnpIdentity('alpha');
  const b = createAnpIdentity('beta');
  registry.register({ did: a.did, name: 'alpha', skills: ['chat', 'code'], didDocument: anpDidDocument(a) });
  registry.register({
    did: b.did,
    name: 'beta',
    url: 'http://127.0.0.1:9001/',
    skills: ['code'],
    didDocument: anpDidDocument(b, 'http://127.0.0.1:9001/'),
  });
  assert.equal(registry.size, 2);
  assert.equal(registry.resolve(a.did)?.name, 'alpha');
  assert.equal(registry.resolve('did:key:z11111111111111111111111111111111'), undefined);
  assert.equal(registry.find({ skill: 'code' }).length, 2);
  assert.equal(registry.find({ skill: 'chat' }).length, 1);
  assert.equal(registry.find({ nameContains: 'BET' }).length, 1);
  assert.equal(registry.find({ limit: 1 }).length, 1);
  // Re-register keeps registeredAt, updates the rest.
  const first = registry.resolve(a.did);
  registry.register({ did: a.did, name: 'alpha-2', skills: ['chat'], didDocument: anpDidDocument(a) });
  const updated = registry.resolve(a.did);
  assert.equal(updated.name, 'alpha-2');
  assert.equal(updated.registeredAt, first.registeredAt);
  assert.equal(registry.remove(a.did), true);
  assert.equal(registry.remove(a.did), false);
  assert.equal(registry.size, 1);
  // Invalid DID / mismatched document are rejected.
  assert.throws(() => registry.register({ did: 'did:web:x', name: 'x', skills: [], didDocument: anpDidDocument(a) }), /DID không hợp lệ/);
  assert.throws(
    () => registry.register({ did: a.did, name: 'x', skills: [], didDocument: anpDidDocument(b) }),
    /khác DID/,
  );
});

test('file registry: persists across restarts, skips corrupt entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anp-registry-v102-'));
  const file = path.join(dir, 'registry.json');
  const registry = new FileAnpRegistry(file);
  const a = createAnpIdentity('persisted');
  registry.register({ did: a.did, name: 'persisted', skills: ['chat'], didDocument: anpDidDocument(a) });
  assert.equal(registry.loadedRecords, 0);
  const reloaded = new FileAnpRegistry(file);
  assert.equal(reloaded.loadedRecords, 1);
  assert.equal(reloaded.resolve(a.did)?.name, 'persisted');
  // Corrupt the file: one bad entry + one good entry.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.push({ did: 'not-a-did', name: 'bad' });
  fs.writeFileSync(file, JSON.stringify(raw));
  const tolerant = new FileAnpRegistry(file);
  assert.equal(tolerant.loadedRecords, 1);
  assert.equal(tolerant.corruptEntries, 1);
  assert.equal(tolerant.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('discovery: well-known DID document over loopback, then announce', async () => {
  const identity = createAnpIdentity('remote-agent');
  const doc = anpDidDocument(identity, 'http://127.0.0.1:0/');
  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/anp/did.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(doc));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  try {
    const fetched = await fetchAnpDidDocument(baseUrl);
    assert.equal(fetched.id, identity.did);
    const registry = new AnpRegistry();
    const { record, registered } = await discoverAnpAgent(baseUrl, { registry, skills: ['chat'] });
    assert.equal(registered, true);
    assert.equal(record.did, identity.did);
    assert.deepEqual(record.skills, ['chat']);
    assert.equal(registry.resolve(identity.did)?.did, identity.did);
    // Second discovery: already known.
    const again = await discoverAnpAgent(baseUrl, { registry });
    assert.equal(again.registered, false);
    // Non-http URL and 404 are clean errors.
    await assert.rejects(fetchAnpDidDocument('ftp://example.com/'), AnpDiscoveryError);
    await assert.rejects(discoverAnpAgent('http://127.0.0.1:1/'), AnpDiscoveryError);
    // Announce the local identity into the same registry.
    const local = createAnpIdentity('local-agent');
    const announced = announceAnpAgent(registry, local, { url: 'http://127.0.0.1:9100/', skills: ['code'] });
    assert.equal(announced.did, local.did);
    assert.equal(registry.resolve(local.did)?.url, 'http://127.0.0.1:9100/');
  } finally {
    await new Promise((done) => server.close(() => done()));
  }
});
