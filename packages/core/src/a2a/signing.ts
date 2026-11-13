/**
 * Signed Agent Card (v0.97, Đội T2) — ký số Agent Card bằng key local.
 *
 * Mục đích: client ngoài biết card này thật sự do open-bot publish
 * (không phải ai đó giả mạo endpoint rồi chèn skill độc hại), và
 * biết card có bị sửa sau khi ký không. Key là Ed25519 tạo local,
 * lưu file PEM mode 0600 dưới userData — KHÔNG dùng dịch vụ ngoài,
 * không gửi key đi đâu.
 *
 * Định dạng chữ ký trong card (`card.signature`):
 *   {
 *     algorithm: 'Ed25519',
 *     keyId: '<fingerprint SHA-256 của public key, hex>',
 *     publicKey: '<SPKI DER base64 — để client verify không cần hỏi key riêng>',
 *     value: '<chữ ký base64 trên canonical JSON của card (không gồm field signature)>',
 *     signedAt: '<ISO-8601 lúc ký>'
 *   }
 * Trust model: trust-on-first-use (như SSH host key) — client lưu
 * fingerprint lần đầu gặp, lần sau đổi key thì cảnh báo. Verify ở
 * đây chỉ chứng minh card khớp key đã ký, không chứng minh key
 * thuộc về ai.
 *
 * Chỉ dùng Node stdlib (`node:crypto`, `node:fs`, `node:path`).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { A2aCardSignature } from './types';

export type { A2aCardSignature };

/** Thuật toán ký duy nhất open-bot dùng cho Agent Card. */
export const A2A_SIGNATURE_ALGORITHM = 'Ed25519';

/** Tên file key ký card dưới userData (main process truyền đường dẫn). */
export const A2A_SIGNING_KEY_FILE_NAME = 'a2a-signing-key.pem';

/** Một keypair Ed25519 dùng để ký card (giữ private key trong bộ nhớ). */
export interface A2aSigningKeyPair {
  /** Private key PEM (PKCS#8) — KHÔNG log, KHÔNG gửi đi. */
  privateKeyPem: string;
  /** Public key PEM (SPKI). */
  publicKeyPem: string;
  /** Public key dạng SPKI DER base64 (đưa vào card). */
  publicKeyBase64: string;
  /** Fingerprint SHA-256 hex của public key DER. */
  keyId: string;
}

/**
 * Canonical JSON: sắp xếp key theo thứ tự bảng chữ cái ở mọi cấp,
 * `JSON.stringify` không khoảng trắng. Hai object bằng nhau về nội
 * dung thì cho cùng một chuỗi → chữ ký ổn định, không phụ thuộc
 * thứ tự key lúc build card.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = rec[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Fingerprint SHA-256 (hex) của một public key DER. */
export function fingerprintPublicKeyDer(der: Buffer): string {
  return crypto.createHash('sha256').update(der).digest('hex');
}

/** Tạo keypair Ed25519 mới (trong bộ nhớ, chưa lưu file). */
export function generateA2aSigningKey(): A2aSigningKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    privateKeyPem: privatePem,
    publicKeyPem: publicPem,
    publicKeyBase64: publicDer.toString('base64'),
    keyId: fingerprintPublicKeyDer(publicDer),
  };
}

/**
 * Nạp keypair từ PEM private key (PKCS#8). Throw khi PEM hỏng —
 * caller bắt lỗi và tạo key mới (không âm thầm dùng key hỏng).
 */
export function loadA2aSigningKeyFromPem(privateKeyPem: string): A2aSigningKeyPair {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKeyPem,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeyBase64: publicDer.toString('base64'),
    keyId: fingerprintPublicKeyDer(publicDer),
  };
}

/**
 * Lưu private key xuống file PEM mode 0600 (ghi atomic: file tạm
 * cùng thư mục + rename). Thư mục cha được tạo nếu chưa có.
 * Throw khi không ghi được — caller log rõ ràng, server vẫn chạy
 * với card không ký thay vì crash.
 */
export function saveA2aSigningKeyToFile(keyPair: A2aSigningKeyPair, filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, keyPair.privateKeyPem, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort — file đã ghi xong.
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // File tạm có thể chưa được tạo.
    }
    throw err;
  }
}

/**
 * Load key ký card từ file, hoặc tạo mới + lưu khi file chưa có.
 * File hỏng (không phải PEM Ed25519) → throw lỗi rõ ràng, KHÔNG
 * tự ghi đè (ghi đè sẽ đổi fingerprint, client đã trust key cũ
 * sẽ thấy card "đổi key" — user phải xoá file tay khi thật sự
 * muốn rotate key).
 */
export function loadOrCreateA2aSigningKey(filePath: string): A2aSigningKeyPair {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  if (raw !== null && raw.trim().length > 0) {
    try {
      return loadA2aSigningKeyFromPem(raw);
    } catch (err) {
      throw new Error(
        `File key ký Agent Card hỏng (${filePath}) — xoá file để tạo key mới (client đã trust sẽ thấy key đổi): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  const created = generateA2aSigningKey();
  saveA2aSigningKeyToFile(created, filePath);
  return created;
}

/** Xoá field `signature` khỏi card để lấy nội dung đã ký. */
export function unsignedAgentCard<T extends Record<string, unknown>>(card: T): Omit<T, 'signature'> {
  const copy = { ...card };
  delete (copy as Record<string, unknown>)['signature'];
  return copy;
}

/**
 * Ký một Agent Card: trả card mới có thêm `signature`. Card gốc
 * không bị sửa (trả bản copy). `signedAt` mặc định là thời điểm ký.
 */
export function signAgentCard<T extends object>(
  card: T,
  keyPair: A2aSigningKeyPair,
  signedAt?: string,
): T & { signature: A2aCardSignature } {
  const unsigned = unsignedAgentCard(card as Record<string, unknown>);
  const payload = canonicalJson(unsigned);
  const privateKey = crypto.createPrivateKey(keyPair.privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf-8'), privateKey);
  const at = signedAt ?? new Date().toISOString();
  return {
    ...(card as T),
    signature: {
      algorithm: A2A_SIGNATURE_ALGORITHM,
      keyId: keyPair.keyId,
      publicKey: keyPair.publicKeyBase64,
      value: signature.toString('base64'),
      signedAt: at,
    },
  };
}

export interface A2aSignatureVerification {
  /** true khi chữ ký khớp nội dung card với public key trong card. */
  ok: boolean;
  /** Fingerprint của key đã ký (null khi card không có chữ ký). */
  keyId: string | null;
  /** Lý do khi ok=false (hiển thị cho user). */
  reason?: string;
  /** true khi card không có chữ ký nào (khác với chữ ký sai). */
  unsigned?: boolean;
}

/**
 * Verify chữ ký của một Agent Card đã ký. Kiểm tra:
 *  1. Card có `signature` với algorithm Ed25519, đủ field.
 *  2. `keyId` khớp fingerprint của `publicKey` trong card (chống
 *     gắn key này + khai keyId khác).
 *  3. Chữ ký khớp canonical JSON của card (không gồm `signature`).
 * Không kiểm tra key có được trust không — đó là việc của tầng
 * trust store (fingerprint lần đầu gặp, xem `verifyAgentCardTrust`).
 */
export function verifyAgentCardSignature(
  card: Record<string, unknown> | undefined | null,
): A2aSignatureVerification {
  if (!card || typeof card !== 'object') {
    return { ok: false, keyId: null, reason: 'Không có Agent Card để verify.' };
  }
  const sig = (card as Record<string, unknown>)['signature'];
  if (sig === undefined || sig === null) {
    return { ok: false, keyId: null, unsigned: true, reason: 'Agent Card không có chữ ký.' };
  }
  if (typeof sig !== 'object' || Array.isArray(sig)) {
    return { ok: false, keyId: null, reason: 'Field signature trong Agent Card sai định dạng.' };
  }
  const s = sig as Record<string, unknown>;
  if (s['algorithm'] !== A2A_SIGNATURE_ALGORITHM) {
    return {
      ok: false,
      keyId: typeof s['keyId'] === 'string' ? (s['keyId'] as string) : null,
      reason: `Thuật toán chữ ký không hỗ trợ: ${String(s['algorithm'] ?? '(thiếu)')} (chỉ hỗ trợ Ed25519).`,
    };
  }
  if (
    typeof s['keyId'] !== 'string' ||
    typeof s['publicKey'] !== 'string' ||
    typeof s['value'] !== 'string'
  ) {
    return { ok: false, keyId: null, reason: 'Chữ ký thiếu keyId, publicKey hoặc value.' };
  }
  const keyId = s['keyId'] as string;
  const publicKeyB64 = s['publicKey'] as string;
  let publicDer: Buffer;
  try {
    publicDer = Buffer.from(publicKeyB64, 'base64');
    if (publicDer.length === 0) throw new Error('publicKey rỗng');
  } catch {
    return { ok: false, keyId, reason: 'publicKey trong chữ ký không phải base64 hợp lệ.' };
  }
  if (fingerprintPublicKeyDer(publicDer) !== keyId) {
    return { ok: false, keyId, reason: 'keyId không khớp fingerprint của publicKey trong chữ ký.' };
  }
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, keyId, reason: 'publicKey trong chữ ký không phải key Ed25519 hợp lệ.' };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(s['value'] as string, 'base64');
  } catch {
    return { ok: false, keyId, reason: 'Chữ ký (value) không phải base64 hợp lệ.' };
  }
  const payload = canonicalJson(unsignedAgentCard(card));
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(payload, 'utf-8'), publicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, keyId, reason: 'Chữ ký không khớp nội dung Agent Card (card đã bị sửa sau khi ký).' };
  }
  return { ok: true, keyId };
}

export interface A2aCardTrustCheck extends A2aSignatureVerification {
  /** true khi key này đã được trust từ trước (fingerprint khớp). */
  trustedBefore: boolean;
  /** true khi key MỚI (chưa từng gặp) — user nên xác nhận lần đầu. */
  firstSeen: boolean;
}

/**
 * Verify chữ ký + đối chiếu trust store (trust-on-first-use).
 * `knownKeyIds` là tập fingerprint đã trust trước đây (từ store
 * của app). Key mới → ok=true nhưng firstSeen=true (caller hiện
 * cảnh báo "key mới, kiểm tra fingerprint rồi mới trust"); key đổi
 * (card ký bằng key khác với key đã trust cho cùng URL) → caller
 * tự đối chiếu bằng cách truyền knownKeyIds của URL đó.
 */
export function verifyAgentCardTrust(
  card: Record<string, unknown> | undefined | null,
  knownKeyIds: ReadonlySet<string> | readonly string[] = [],
): A2aCardTrustCheck {
  const verified = verifyAgentCardSignature(card);
  const known = new Set(knownKeyIds);
  if (!verified.ok || !verified.keyId) {
    return { ...verified, trustedBefore: false, firstSeen: false };
  }
  const trustedBefore = known.has(verified.keyId);
  return { ...verified, trustedBefore, firstSeen: !trustedBefore };
}
