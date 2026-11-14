/**
 * Vault export / import — move secrets between machines (v1.02 rescue
 * port of the v1.00 work).
 *
 * Export writes a JSON bundle of ONE namespace (never the whole
 * vault — exporting everything at once is how secrets leak). The
 * bundle is encrypted with a passphrase the user types (AES-256-GCM,
 * scrypt-derived key, random salt + IV per bundle), so the file is
 * useless without the passphrase. Import decrypts, validates the
 * shape, and writes the entries into the target namespace — refusing
 * to overwrite existing keys unless the caller explicitly allows it.
 *
 * The passphrase is never stored, never logged, and never written
 * into the bundle.
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

import type { Vault } from './vault';

export const VAULT_EXPORT_VERSION = 1;

/** An encrypted vault bundle (one namespace, passphrase-protected). */
export interface VaultExportBundle {
  version: number;
  namespace: string;
  exportedAt: string;
  /** Base64 salt (scrypt). */
  salt: string;
  /** Base64 IV (AES-GCM). */
  iv: string;
  /** Base64 ciphertext (JSON of { key: value }). */
  data: string;
  /** Base64 GCM auth tag. */
  tag: string;
}

/** Export one namespace as an encrypted bundle. */
export function exportVaultNamespace(vault: Vault, namespace: string, passphrase: string): VaultExportBundle {
  if (!passphrase) throw new Error('export needs a non-empty passphrase');
  const entries: Record<string, string> = {};
  for (const key of vault.listSecrets(namespace)) {
    const value = vault.getSecret(namespace, key);
    if (value !== null) entries[key] = value;
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(entries), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: VAULT_EXPORT_VERSION,
    namespace,
    exportedAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** Import an encrypted bundle into a namespace (returns the keys imported). */
export function importVaultNamespace(
  vault: Vault,
  bundle: VaultExportBundle,
  passphrase: string,
  options: { targetNamespace?: string; overwrite?: boolean } = {},
): string[] {
  if (bundle.version !== VAULT_EXPORT_VERSION) {
    throw new Error(`unsupported vault export version: ${bundle.version}`);
  }
  if (!passphrase) throw new Error('import needs a non-empty passphrase');
  const namespace = options.targetNamespace ?? bundle.namespace;
  const key = scryptSync(passphrase, Buffer.from(bundle.salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(bundle.tag, 'base64'));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(bundle.data, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new Error('cannot decrypt vault bundle — wrong passphrase or corrupted file');
  }
  let entries: unknown;
  try {
    entries = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('vault bundle payload is not valid JSON');
  }
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new Error('vault bundle payload must be an object of key/value pairs');
  }
  const imported: string[] = [];
  for (const [keyName, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!options.overwrite && vault.hasSecret(namespace, keyName)) continue;
    vault.setSecret(namespace, keyName, value);
    imported.push(keyName);
  }
  return imported;
}
