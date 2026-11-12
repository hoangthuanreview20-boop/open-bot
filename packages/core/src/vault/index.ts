/**
 * Vault — encrypted secret store (v0.4).
 * Public surface of packages/core/src/vault/.
 */
export {
  Vault,
  LocalEncryptor,
  createSafeStorageEncryptor,
  loadOrCreateMachineKey,
} from './vault';
export type { Encryptor, SafeStorageLike, VaultOptions, VaultEntryMeta, SetSecretOptions } from './vault';
// v0.53 (P1-6): durable writes with bounded backup copies.
export { writeDurableFileSync, readDurableFileSync, DEFAULT_DURABLE_COPIES } from './durableFile';
export type { DurableWriteOptions } from './durableFile';
// v0.53 (P1-6): session-only secrets (in-memory, never on disk).
export { SessionSecretStore, isSessionEntryExpired } from './sessionStore';
export type { SessionSecretEntry } from './sessionStore';
// v0.53 (P1-6): refusal taxonomy + wire timeout.
export {
  VaultRefusalError,
  VaultWireError,
  VAULT_WIRE_TIMEOUT_MS,
  DEFAULT_VAULT_MAX_ENTRIES,
} from './refusals';
export type { VaultRefusal, VaultRefusalKind } from './refusals';
// v0.53 (P1-6): webhook keys in their own file.
export { WebhookKeyStore, createWebhookKeyStore, WEBHOOK_KEYS_FILE } from './webhookKeys';
export type { WebhookKeyStoreOptions, WebhookKeyOptions } from './webhookKeys';
// v0.53 (P1-6): 1Password broker (out-of-process; main owns it,
// the renderer never holds 1Password credentials).
export { OnePasswordBroker } from './onePasswordBroker';
export type {
  OnePasswordBrokerOptions,
  OnePasswordBrokerState,
  OnePasswordBrokerStatus,
  OnePasswordItemSummary,
} from './onePasswordBroker';
