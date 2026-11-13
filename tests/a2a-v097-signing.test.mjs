/**
 * Test v0.97 (Đội T2): Signed Agent Card — Ed25519 key local,
 * ký/verify card, trust-on-first-use, load/create key file.
 *
 * Chỉ test local, không mạng live, không key thật của user: key
 * tạo mới trong test (bộ nhớ / tmpdir).
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-v097-signing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalJson,
  fingerprintPublicKeyDer,
  generateA2aSigningKey,
  loadA2aSigningKeyFromPem,
  loadOrCreateA2aSigningKey,
  signAgentCard,
  verifyAgentCardSignature,
  verifyAgentCardTrust,
  A2A_SIGNING_KEY_FILE_NAME,
} from '../packages/core/dist/a2a/signing.js';

const CARD = {
  name: 'open-bot',
  description: 'Test agent',
  version: '0.2.0',
  url: 'http://127.0.0.1:9/',
  protocolVersion: '1.0.1',
};

test('canonicalJson: cùng nội dung, khác thứ tự key → cùng chuỗi', () => {
  const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":4},"b":1}');
  assert.equal(canonicalJson([3, 1]), '[3,1]');
});

test('generate + sign + verify: card ký hợp lệ, keyId khớp fingerprint', () => {
  const key = generateA2aSigningKey();
  assert.equal(key.keyId.length, 64);
  assert.match(key.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(key.privateKeyPem, /BEGIN PRIVATE KEY/);
  const signed = signAgentCard(CARD, key);
  assert.equal(signed.signature.algorithm, 'Ed25519');
  assert.equal(signed.signature.keyId, key.keyId);
  assert.ok(signed.signature.value.length > 0);
  assert.ok(signed.signature.publicKey.length > 0);
  // Card gốc không bị sửa (sign trả bản copy).
  assert.equal('signature' in CARD, false);
  const v = verifyAgentCardSignature(signed);
  assert.equal(v.ok, true);
  assert.equal(v.keyId, key.keyId);
});

test('verify: sửa nội dung card sau khi ký → chữ ký sai', () => {
  const key = generateA2aSigningKey();
  const signed = signAgentCard(CARD, key);
  const tampered = { ...signed, description: 'Agent giả mạo' };
  const v = verifyAgentCardSignature(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /không khớp|bị sửa/);
});

test('verify: card không có chữ ký → unsigned, không phải "sai"', () => {
  const v = verifyAgentCardSignature(CARD);
  assert.equal(v.ok, false);
  assert.equal(v.unsigned, true);
  assert.equal(v.keyId, null);
});

test('verify: keyId không khớp publicKey → sai', () => {
  const key = generateA2aSigningKey();
  const other = generateA2aSigningKey();
  const signed = signAgentCard(CARD, key);
  const forged = {
    ...signed,
    signature: { ...signed.signature, keyId: other.keyId },
  };
  assert.equal(verifyAgentCardSignature(forged).ok, false);
});

test('verify: ký bằng key khác rồi gắn publicKey của key đó → vẫn sai vì value không khớp', () => {
  const key = generateA2aSigningKey();
  const other = generateA2aSigningKey();
  const signedByOther = signAgentCard(CARD, other);
  // Đổi publicKey/keyId sang key đầu nhưng giữ value của key kia.
  const mixed = {
    ...signedByOther,
    signature: { ...signedByOther.signature, keyId: key.keyId, publicKey: key.publicKeyBase64 },
  };
  assert.equal(verifyAgentCardSignature(mixed).ok, false);
});

test('trust-on-first-use: key mới → firstSeen, key đã biết → trustedBefore', () => {
  const key = generateA2aSigningKey();
  const signed = signAgentCard(CARD, key);
  const first = verifyAgentCardTrust(signed, []);
  assert.equal(first.ok, true);
  assert.equal(first.firstSeen, true);
  assert.equal(first.trustedBefore, false);
  const again = verifyAgentCardTrust(signed, [key.keyId]);
  assert.equal(again.ok, true);
  assert.equal(again.firstSeen, false);
  assert.equal(again.trustedBefore, true);
  const otherKey = verifyAgentCardTrust(signed, ['deadbeef']);
  assert.equal(otherKey.trustedBefore, false);
  assert.equal(otherKey.firstSeen, true);
});

test('loadOrCreate: tạo mới + lưu file 0600, nạp lại cùng keyId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-sign-'));
  const file = path.join(dir, A2A_SIGNING_KEY_FILE_NAME);
  const first = loadOrCreateA2aSigningKey(file);
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const second = loadOrCreateA2aSigningKey(file);
  assert.equal(second.keyId, first.keyId);
  assert.equal(second.privateKeyPem, first.privateKeyPem);
  const again = loadA2aSigningKeyFromPem(fs.readFileSync(file, 'utf-8'));
  assert.equal(again.keyId, first.keyId);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadOrCreate: file hỏng → throw rõ ràng, không tự ghi đè', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-sign-'));
  const file = path.join(dir, A2A_SIGNING_KEY_FILE_NAME);
  fs.writeFileSync(file, 'không phải PEM\n', 'utf-8');
  assert.throws(() => loadOrCreateA2aSigningKey(file), /hỏng/);
  // File vẫn nguyên (không bị ghi đè bằng key mới).
  assert.equal(fs.readFileSync(file, 'utf-8'), 'không phải PEM\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fingerprint: cùng key → cùng fingerprint, key khác → khác', () => {
  const a = generateA2aSigningKey();
  const b = generateA2aSigningKey();
  assert.notEqual(a.keyId, b.keyId);
  assert.equal(a.keyId.length, 64);
  assert.match(a.keyId, /^[0-9a-f]{64}$/);
  const der = Buffer.from(a.publicKeyBase64, 'base64');
  assert.equal(fingerprintPublicKeyDer(der), a.keyId);
});
