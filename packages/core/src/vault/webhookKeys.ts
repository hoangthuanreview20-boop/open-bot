/**
 * Webhook key store (v0.53, P1-6 — REA deep-dive lần 2 §7.3: Grok
 * keeps automation webhook keys in their own directory
 * `automation-webhook-keys/` inside userData, encrypted with
 * safeStorage, separate from the main secret store).
 *
 * Original code, same idea: a SEPARATE durable file — never the main
 * `vault.json` — holding one HMAC/signing key per automation (or per
 * webhook receiver). It reuses the hardened `Vault` (bounded-copies
 * durable writes, per-entry `maxAgeMs`/`savedAtMs`, refusal
 * taxonomy) with a fixed namespace, so webhook keys get the same
 * crash-safety and expiry as any other secret while staying
 * physically separated: deleting / rotating / exporting the main
 * vault never touches webhook keys, and vice versa.
 *
 * Layout: `<dir>/automation-webhook-keys.json` (+ `.key` when the
 * default LocalEncryptor is used, + bounded backup copies `.1`…).
 * The caller (desktop main) passes the same encryptor the main Vault
 * uses when it wants one backend for both stores; otherwise a
 * LocalEncryptor is built from the sibling key file.
 */
import * as path from 'node:path';
import type { Encryptor } from './vault';
import { Vault } from './vault';

/** File name of the webhook key store inside its directory. */
export const WEBHOOK_KEYS_FILE = 'automation-webhook-keys.json';

export interface WebhookKeyStoreOptions {
  /**
   * Directory holding the store file (e.g. the app's userData dir).
   * The store file is `<dir>/automation-webhook-keys.json`.
   */
  dir: string;
  /**
   * Encryption backend. When omitted, a `LocalEncryptor` is built
   * from the machine key file (`keyFilePath`, or
   * `<dir>/automation-webhook-keys.json.key`).
   */
  encryptor?: Encryptor;
  /** Machine key file for the default LocalEncryptor. */
  keyFilePath?: string;
  /** Max entries (passed through to the Vault; default 1000). */
  maxEntries?: number;
  /** Start in NO_STORAGE mode (memory only, passed to the Vault). */
  noStorage?: boolean;
}

export interface WebhookKeyOptions {
  /** Lifetime in ms; expired keys are refused on read (like Vault). */
  maxAgeMs?: number;
  /**
   * Opt-in to durable storage (mirrors Grok's `saveToVault` flag and
   * `Vault.setSecret` opts): `false` keeps the key session-only
   * (in memory, never written to the webhook store file).
   * Default true.
   */
  saveToVault?: boolean;
}

/**
 * One HMAC/signing key per automation webhook, in its own file.
 * Key ids are validated like Vault keys (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`).
 * Values are never logged and never returned by listing.
 */
export class WebhookKeyStore {
  private readonly vault: Vault;

  constructor(options: WebhookKeyStoreOptions) {
    if (!options.dir) throw new Error('WebhookKeyStore needs a dir.');
    this.vault = new Vault({
      storePath: path.join(options.dir, WEBHOOK_KEYS_FILE),
      ...(options.encryptor ? { encryptor: options.encryptor } : {}),
      ...(options.keyFilePath ? { keyFilePath: options.keyFilePath } : {}),
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      ...(options.noStorage !== undefined ? { noStorage: options.noStorage } : {}),
    });
  }

  /** Path of the webhook key store file. */
  get path(): string {
    return this.vault.path;
  }

  /** Store (or overwrite) a webhook key. */
  setKey(id: string, secret: string, opts?: WebhookKeyOptions): void {
    this.vault.setSecret('webhook', id, secret, {
      ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      ...(opts?.saveToVault !== undefined ? { saveToVault: opts.saveToVault } : {}),
    });
  }

  /**
   * Same as `setKey`, but returns a structured refusal instead of
   * throwing (see `Vault.trySetSecret`).
   */
  trySetKey(
    id: string,
    secret: string,
    opts?: WebhookKeyOptions,
  ): { ok: true } | { ok: false; refusal: { kind: 'vault_full' | 'refused'; message: string } } {
    return this.vault.trySetSecret('webhook', id, secret, {
      ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      ...(opts?.saveToVault !== undefined ? { saveToVault: opts.saveToVault } : {}),
    });
  }

  /** Returns null when the key was never set or has expired. */
  getKey(id: string): string | null {
    return this.vault.getSecret('webhook', id);
  }

  /** Returns true when a key was removed. */
  deleteKey(id: string): boolean {
    return this.vault.deleteSecret('webhook', id);
  }

  /** Key ids in the store (values are NEVER returned by listing). */
  listKeys(): string[] {
    return this.vault.listSecrets('webhook');
  }

  hasKey(id: string): boolean {
    return this.vault.hasSecret('webhook', id);
  }

  /** Whether the underlying Vault runs in NO_STORAGE mode. */
  isNoStorage(): boolean {
    return this.vault.isNoStorage();
  }

  /** Underlying Vault (escape hatch for rotation / diagnostics). */
  get innerVault(): Vault {
    return this.vault;
  }
}

/** Convenience factory (same options as the constructor). */
export function createWebhookKeyStore(options: WebhookKeyStoreOptions): WebhookKeyStore {
  return new WebhookKeyStore(options);
}
