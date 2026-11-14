/**
 * JWS compact serialization (Ed25519) for A2A (v1.02 rescue port of
 * the v1.00 work).
 *
 * A2A v1.0 signs Agent Cards; the card-signature helpers in
 * `signing.ts` cover that shape. This module is the general JWS
 * compact form (`header.payload.signature`, base64url) used when an
 * A2A message or task needs a signed envelope: `signJws` /
 * `verifyJws` with Node's built-in Ed25519 keys (no dependency).
 * A token is only trusted when the signature verifies AND the
 * `exp` claim (when present) is still in the future.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/** JWS header for Ed25519 (only `EdDSA` is supported here). */
export interface JwsHeader {
  alg: 'EdDSA';
  typ?: string;
  kid?: string;
}

/** Decoded JWS (header + payload + raw signature). */
export interface DecodedJws {
  header: JwsHeader;
  payload: Record<string, unknown>;
  signature: Buffer;
  signingInput: string;
}

function base64urlEncode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function base64urlDecode(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

/** Sign a payload into a JWS compact token (Ed25519 private key). */
export function signJws(payload: Record<string, unknown>, privateKey: KeyObject, header: Partial<JwsHeader> = {}): string {
  const fullHeader: JwsHeader = { alg: 'EdDSA', typ: 'JWT', ...header };
  const encodedHeader = base64urlEncode(JSON.stringify(fullHeader));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/** Verify a JWS compact token (returns the decoded token, or throws). */
export function verifyJws(token: string, publicKey: KeyObject): DecodedJws {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWS must have 3 parts');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: JwsHeader;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8')) as JwsHeader;
    payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('JWS header or payload is not valid JSON');
  }
  if (header.alg !== 'EdDSA') throw new Error(`unsupported JWS alg: ${String(header.alg)}`);
  const signature = base64urlDecode(encodedSignature);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const valid = verify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature);
  if (!valid) throw new Error('JWS signature verification failed');
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
    throw new Error('JWS token is expired');
  }
  return { header, payload, signature, signingInput };
}

/** Decode a JWS without verifying (for inspection only — never trust it). */
export function decodeJwsUnverified(token: string): { header: JwsHeader; payload: Record<string, unknown> } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWS must have 3 parts');
  return {
    header: JSON.parse(base64urlDecode(parts[0]).toString('utf8')) as JwsHeader,
    payload: JSON.parse(base64urlDecode(parts[1]).toString('utf8')) as Record<string, unknown>,
  };
}

/** Load an Ed25519 private key from a PEM string (for signing). */
export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** Load an Ed25519 public key from a PEM string (for verifying). */
export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}
