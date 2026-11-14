/**
 * ANP identity: `did:key` from Ed25519 (v1.02, Team T3).
 *
 * `did:key` (DID Core + the `did:key` method spec) derives the DID
 * directly from the public key — no ledger, no registrar, no network
 * needed to create an identity:
 *   did = "did:key:z" + base58btc(0xed 0x01 || 32-byte Ed25519 pubkey)
 * where `0xed01` is the multicodec varint prefix for Ed25519 public
 * keys and `z` marks base58btc encoding.
 *
 * Implemented with Node stdlib only (`node:crypto` for the keypair and
 * signatures, a small hand-written base58btc codec). The public key is
 * taken from the JWK export (`x` = raw 32 bytes, base64url) so no DER
 * parsing is needed.
 */

import * as crypto from 'node:crypto';
import type { AnpAgentIdentity, AnpDid, AnpDidDocument } from './types';

/** Multicodec varint prefix for an Ed25519 public key. */
const ED25519_MULTICODEC_PREFIX = Buffer.from([0xed, 0x01]);

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode bytes as base58btc (Bitcoin alphabet, leading zeros → '1'). */
export function base58btcEncode(data: Buffer): string {
  if (data.length === 0) return '';
  let zeroes = 0;
  while (zeroes < data.length && data[zeroes] === 0) zeroes += 1;
  // Work in base-256 → base-58 with a plain digit array (no BigInt
  // needed, but BigInt keeps this short and obviously correct).
  let num = 0n;
  for (const byte of data) num = (num << 8n) | BigInt(byte);
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = BASE58_ALPHABET[rem] + out;
  }
  return '1'.repeat(zeroes) + out;
}

/** Decode a base58btc string; null when it contains an illegal char. */
export function base58btcDecode(text: string): Buffer | null {
  if (text.length === 0) return Buffer.alloc(0);
  let zeroes = 0;
  while (zeroes < text.length && text[zeroes] === '1') zeroes += 1;
  let num = 0n;
  for (const ch of text) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num = num >> 8n;
  }
  bytes.reverse();
  return Buffer.concat([Buffer.alloc(zeroes), Buffer.from(bytes)]);
}

/** True when `value` parses as a `did:key` Ed25519 identifier. */
export function isAnpDid(value: unknown): value is AnpDid {
  if (typeof value !== 'string') return false;
  return parseAnpDid(value) !== null;
}

/**
 * Parse a `did:key` DID: returns the raw 32-byte Ed25519 public key,
 * or null when the format / prefix / key length is wrong.
 */
export function parseAnpDid(did: string): { publicKey: Buffer } | null {
  if (!did.startsWith('did:key:z')) return null;
  const decoded = base58btcDecode(did.slice('did:key:z'.length));
  if (decoded === null) return null;
  if (decoded.length !== ED25519_MULTICODEC_PREFIX.length + 32) return null;
  if (!decoded.subarray(0, 2).equals(ED25519_MULTICODEC_PREFIX)) return null;
  return { publicKey: decoded.subarray(2) };
}

/** Build a `did:key` identifier from a raw 32-byte Ed25519 public key. */
export function anpDidFromPublicKey(publicKey: Buffer): AnpDid {
  if (publicKey.length !== 32) throw new Error('Ed25519 public key phải dài đúng 32 byte.');
  return `did:key:z${base58btcEncode(Buffer.concat([ED25519_MULTICODEC_PREFIX, publicKey]))}`;
}

/**
 * Create a fresh ANP identity: a new Ed25519 keypair, its `did:key`
 * and the private key as PKCS#8 PEM. The caller must store the PEM in
 * the Vault / a 0600 file — this function never writes it anywhere.
 */
export function createAnpIdentity(name: string): AnpAgentIdentity {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('ANP identity cần một tên agent không rỗng.');
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('Không export được public key Ed25519 (JWK x).');
  const rawPublicKey = Buffer.from(jwk.x, 'base64url');
  const did = anpDidFromPublicKey(rawPublicKey);
  return {
    did,
    name: name.trim(),
    publicKeyBase64: rawPublicKey.toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Rebuild the public identity from a stored PEM private key (e.g.
 * after restart): the DID is re-derived from the key, so the identity
 * survives restarts as long as the PEM does.
 */
export function loadAnpIdentity(privateKeyPem: string, name: string): AnpAgentIdentity {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('PEM không phải key Ed25519 hợp lệ.');
  const rawPublicKey = Buffer.from(jwk.x, 'base64url');
  return {
    did: anpDidFromPublicKey(rawPublicKey),
    name,
    publicKeyBase64: rawPublicKey.toString('base64'),
    privateKeyPem,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build the minimal DID document for an identity. `serviceEndpoint`
 * is the agent's A2A base URL when it has one — other agents use it
 * to reach this agent after discovery.
 */
export function anpDidDocument(identity: AnpAgentIdentity, serviceEndpoint?: string): AnpDidDocument {
  const methodId = `${identity.did}#key-1`;
  const doc: AnpDidDocument = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: identity.did,
    verificationMethod: [
      {
        id: methodId,
        type: 'Ed25519VerificationKey2020',
        controller: identity.did,
        publicKeyBase64: identity.publicKeyBase64,
      },
    ],
    authentication: [methodId],
  };
  if (serviceEndpoint) {
    doc.service = [
      { id: `${identity.did}#a2a`, type: 'A2AEndpoint', serviceEndpoint },
    ];
  }
  return doc;
}

/**
 * Validate a DID document shape: right id, at least one Ed25519
 * verification method whose key matches the DID itself (a document
 * whose key does not match its id is a forgery / copy error).
 * Returns the key bytes for signature verification, or null.
 */
export function validateAnpDidDocument(doc: unknown): { did: AnpDid; publicKey: Buffer } | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const record = doc as Record<string, unknown>;
  if (typeof record['id'] !== 'string') return null;
  const parsed = parseAnpDid(record['id'] as string);
  if (parsed === null) return null;
  const methods = record['verificationMethod'];
  if (!Array.isArray(methods) || methods.length === 0) return null;
  const first = methods[0] as Record<string, unknown>;
  if (first['type'] !== 'Ed25519VerificationKey2020') return null;
  if (typeof first['publicKeyBase64'] !== 'string') return null;
  const keyBytes = Buffer.from(first['publicKeyBase64'] as string, 'base64');
  if (keyBytes.length !== 32 || !keyBytes.equals(parsed.publicKey)) return null;
  return { did: record['id'] as AnpDid, publicKey: keyBytes };
}

/**
 * Sign bytes with an identity's private key (Ed25519). Returns the
 * raw 64-byte signature as base64. The signed payload is the caller's
 * responsibility (e.g. a canonical JSON announcement).
 */
export function signAnpPayload(identity: AnpAgentIdentity, payload: Buffer | string): string {
  const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return crypto.sign(null, data, privateKey).toString('base64');
}

/** Verify an Ed25519 signature against a raw public key (base64). */
export function verifyAnpSignature(
  publicKeyBase64: string,
  payload: Buffer | string,
  signatureBase64: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    if (raw.length !== 32) return false;
    const publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
    const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    return crypto.verify(null, data, publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
