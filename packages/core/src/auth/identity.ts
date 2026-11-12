/**
 * Multi-layer login (v0.7, ROADMAP §2d: "Đăng nhập đa tầng").
 *
 * Two layers, kept separate on purpose:
 *
 *   1. Local account — ONE stable profile for the machine owner,
 *      stored in `<userData>/profile.json` (NOT a secret: just an id
 *      + display name). Created once, never re-created.
 *   2. Provider identity — ONE identity per provider, stored in the
 *      Vault. The Vault composite key is `identity:<provider>`
 *      (namespace 'identity', key = provider id), value = JSON
 *      `{ id, displayName?, email?, updatedAt }`. It holds NO token:
 *      tokens live in their own namespaces (see credentials.ts).
 *
 * Nothing here logs a secret; the identity JSON contains only
 * display data (id / name / email the user chose to show).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Vault } from '../vault/vault';

export const PROFILE_FILE = 'profile.json';
export const IDENTITY_NAMESPACE = 'identity';

export interface LocalProfile {
  /** Stable local user id, generated once (uuid). */
  userId: string;
  /** Display name the user chose (may be empty). */
  displayName: string;
  /** Epoch ms of creation. */
  createdAt: number;
}

export interface ProviderIdentity {
  /** Provider-side id (e.g. Google `sub`, xAI user id). */
  id: string;
  displayName?: string;
  email?: string;
  /** Epoch ms of the last update. */
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a profile object read from disk; throws on a bad shape. */
export function validateLocalProfile(raw: unknown): LocalProfile {
  if (!isRecord(raw)) throw new Error('Invalid local profile: top level must be an object.');
  const userId = raw['userId'];
  if (typeof userId !== 'string' || userId.trim().length === 0 || userId.length > 128) {
    throw new Error('Invalid local profile: "userId" must be a non-empty string.');
  }
  const displayName = raw['displayName'];
  if (displayName !== undefined && typeof displayName !== 'string') {
    throw new Error('Invalid local profile: "displayName" must be a string.');
  }
  const createdAt = raw['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    throw new Error('Invalid local profile: "createdAt" must be a non-negative number.');
  }
  return {
    userId: userId.trim(),
    displayName: typeof displayName === 'string' ? displayName : '',
    createdAt,
  };
}

/**
 * Load the local profile, or null when no profile.json exists yet.
 * A corrupt file throws (never silently replaced — the id must stay
 * stable, so the user/host decides how to recover).
 */
export function loadLocalProfile(dir: string): LocalProfile | null {
  const filePath = path.join(dir, PROFILE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid local profile: not valid JSON.');
  }
  return validateLocalProfile(parsed);
}

/** Persist a profile (atomic write, mode 0600 — it identifies the owner). */
export function saveLocalProfile(dir: string, profile: LocalProfile): LocalProfile {
  const valid = validateLocalProfile(profile);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, PROFILE_FILE);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(valid, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  return valid;
}

/**
 * Return the local profile, creating it (fresh uuid) on first use.
 * Idempotent: later calls return the same userId.
 */
export function getOrCreateLocalProfile(dir: string): LocalProfile {
  const existing = loadLocalProfile(dir);
  if (existing) return existing;
  return saveLocalProfile(dir, {
    userId: randomUUID(),
    displayName: '',
    createdAt: Date.now(),
  });
}

/** Alias of `getOrCreateLocalProfile` (ROADMAP §2d naming). */
export const getLocalProfile = getOrCreateLocalProfile;

/** Change only the display name; the userId never changes. */
export function setLocalDisplayName(dir: string, displayName: string): LocalProfile {
  if (typeof displayName !== 'string' || displayName.length > 200) {
    throw new Error('Display name must be a string of at most 200 characters.');
  }
  const profile = getOrCreateLocalProfile(dir);
  return saveLocalProfile(dir, { ...profile, displayName: displayName.trim() });
}

/** Validate a provider-identity object (from Vault JSON); throws on bad shape. */
export function validateProviderIdentity(raw: unknown): ProviderIdentity {
  if (!isRecord(raw)) throw new Error('Invalid provider identity: must be an object.');
  const id = raw['id'];
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 256) {
    throw new Error('Invalid provider identity: "id" must be a non-empty string.');
  }
  const displayName = raw['displayName'];
  const email = raw['email'];
  if (displayName !== undefined && typeof displayName !== 'string') {
    throw new Error('Invalid provider identity: "displayName" must be a string.');
  }
  if (email !== undefined && typeof email !== 'string') {
    throw new Error('Invalid provider identity: "email" must be a string.');
  }
  const updatedAt = raw['updatedAt'];
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) {
    throw new Error('Invalid provider identity: "updatedAt" must be a non-negative number.');
  }
  const out: ProviderIdentity = { id: id.trim(), updatedAt };
  if (typeof displayName === 'string' && displayName) out.displayName = displayName;
  if (typeof email === 'string' && email) out.email = email;
  return out;
}

/**
 * Read one provider's identity from the Vault (`identity:<provider>`),
 * or null when the user never signed in to that provider.
 */
export function getProviderIdentity(vault: Vault, providerId: string): ProviderIdentity | null {
  const raw = vault.getSecret(IDENTITY_NAMESPACE, providerId);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid provider identity for "${providerId}": not valid JSON.`);
  }
  return validateProviderIdentity(parsed);
}

/** Store (or replace) one provider's identity in the Vault. */
export function setProviderIdentity(
  vault: Vault,
  providerId: string,
  identity: Omit<ProviderIdentity, 'updatedAt'> & { updatedAt?: number },
): ProviderIdentity {
  const valid = validateProviderIdentity({
    ...identity,
    updatedAt: identity.updatedAt ?? Date.now(),
  });
  vault.setSecret(IDENTITY_NAMESPACE, providerId, JSON.stringify(valid));
  return valid;
}

/** Remove one provider's identity (sign out of that provider only). */
export function deleteProviderIdentity(vault: Vault, providerId: string): boolean {
  return vault.deleteSecret(IDENTITY_NAMESPACE, providerId);
}

/** All provider ids that currently have an identity stored. */
export function listProviderIdentities(vault: Vault): string[] {
  return vault.listSecrets(IDENTITY_NAMESPACE);
}
