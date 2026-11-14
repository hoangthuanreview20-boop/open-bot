/**
 * Scoped vault — one namespace, one purpose (v1.02 rescue port of
 * the v1.00 work).
 *
 * A `ScopedVault` wraps the `Vault` and only exposes a single
 * namespace (e.g. `gateway` for channel tokens, `acp` for ACP agent
 * credentials). Code that only needs gateway tokens cannot read —
 * or even list — provider keys, because it never sees the rest of
 * the vault. The scope is enforced in this module, not by
 * convention: the underlying vault is never exposed.
 */

import type { Vault } from './vault';

export interface ScopedVaultOptions {
  /** Namespace this vault is scoped to (e.g. 'gateway'). */
  namespace: string;
  /** When true, listing keys is allowed (default true; set false to hide even key names). */
  allowList?: boolean;
}

/** One-namespace view over a Vault (the rest is unreachable). */
export class ScopedVault {
  readonly namespace: string;
  private readonly vault: Vault;
  private readonly allowList: boolean;

  constructor(vault: Vault, options: ScopedVaultOptions) {
    this.vault = vault;
    this.namespace = options.namespace;
    this.allowList = options.allowList ?? true;
  }

  set(key: string, value: string): void {
    this.vault.setSecret(this.namespace, key, value);
  }

  get(key: string): string | null {
    return this.vault.getSecret(this.namespace, key);
  }

  has(key: string): boolean {
    return this.vault.hasSecret(this.namespace, key);
  }

  delete(key: string): boolean {
    return this.vault.deleteSecret(this.namespace, key);
  }

  /** List key names in this namespace (empty when listing is disabled). */
  list(): string[] {
    if (!this.allowList) return [];
    return this.vault.listSecrets(this.namespace);
  }
}

/** Create a scoped vault for gateway channel tokens. */
export function gatewayScopedVault(vault: Vault): ScopedVault {
  return new ScopedVault(vault, { namespace: 'gateway' });
}

/** Create a scoped vault for ACP agent credentials. */
export function acpScopedVault(vault: Vault): ScopedVault {
  return new ScopedVault(vault, { namespace: 'acp' });
}
