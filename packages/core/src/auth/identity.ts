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
  /**
   * v0.95d4 (personalization): how the user wants to be addressed
   * (e.g. "bạn", "anh", "chị", "em", "cậu") — used by the agent when
   * it talks to the user. Empty = no preference recorded.
   */
  addressForm?: string;
  /** Things the user likes / is interested in (free-form, deduped). */
  interests?: string[];
  /** Habits / routines the user mentioned (free-form, deduped). */
  habits?: string[];
  /** Other facts about the user (free-form, deduped). */
  facts?: string[];
  /** Epoch ms of the last profile update (absent = createdAt). */
  updatedAt?: number;
}

/** Max items kept in one profile list field (interests/habits/facts). */
export const PROFILE_LIST_MAX_ITEMS = 50;
/** Max length (chars) of one profile list item / the address form. */
export const PROFILE_LIST_MAX_ITEM_CHARS = 200;

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
  const out: LocalProfile = {
    userId: userId.trim(),
    displayName: typeof displayName === 'string' ? displayName : '',
    createdAt,
  };
  // v0.95d4: optional personalization fields — old files (pre-v0.95)
  // simply lack them. Unknown/mistyped values are dropped, never crash
  // the load (the profile must stay readable); strict checks live in
  // `updateLocalProfile` / memory/profile.ts instead.
  const addressForm = raw['addressForm'];
  if (typeof addressForm === 'string' && addressForm.trim() !== '') {
    out.addressForm = addressForm.trim().slice(0, PROFILE_LIST_MAX_ITEM_CHARS);
  }
  for (const field of ['interests', 'habits', 'facts'] as const) {
    const list = validateProfileStringList(raw[field]);
    if (list !== undefined) out[field] = list;
  }
  const updatedAt = raw['updatedAt'];
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0) {
    out.updatedAt = updatedAt;
  }
  return out;
}

/**
 * Lenient list validation for profile fields read from disk: keeps
 * only non-empty trimmed strings (max 200 chars, max 50 items).
 * Returns undefined when the value is absent or yields no items.
 */
function validateProfileStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed.slice(0, PROFILE_LIST_MAX_ITEM_CHARS));
    if (out.length >= PROFILE_LIST_MAX_ITEMS) break;
  }
  return out.length > 0 ? out : undefined;
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

export interface LocalProfilePatch {
  displayName?: string;
  /** Empty string clears the address form. */
  addressForm?: string;
  /** Full replacement lists (empty array clears the field). */
  interests?: string[];
  habits?: string[];
  facts?: string[];
}

/**
 * v0.95d4: update the personalization fields of the local profile
 * (merge over the existing profile; userId/createdAt never change).
 * Strict validation — throws on a bad patch, writes nothing. Lists
 * are trimmed, deduped, capped at 50 items × 200 chars.
 */
export function updateLocalProfile(dir: string, patch: LocalProfilePatch): LocalProfile {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new Error('Profile patch must be an object.');
  }
  const clean: LocalProfilePatch = {};
  if (patch.displayName !== undefined) {
    if (typeof patch.displayName !== 'string' || patch.displayName.length > 200) {
      throw new Error('Display name must be a string of at most 200 characters.');
    }
    clean.displayName = patch.displayName.trim();
  }
  if (patch.addressForm !== undefined) {
    if (typeof patch.addressForm !== 'string' || patch.addressForm.length > PROFILE_LIST_MAX_ITEM_CHARS) {
      throw new Error('Address form must be a string of at most 200 characters.');
    }
    clean.addressForm = patch.addressForm.trim();
  }
  for (const field of ['interests', 'habits', 'facts'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`Profile field "${field}" must be an array of strings.`);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
      const trimmed = item.trim();
      if (trimmed === '' || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed.slice(0, PROFILE_LIST_MAX_ITEM_CHARS));
      if (out.length >= PROFILE_LIST_MAX_ITEMS) break;
    }
    clean[field] = out;
  }
  const profile = getOrCreateLocalProfile(dir);
  const next: LocalProfile = { ...profile, ...clean, updatedAt: Date.now() };
  if (next.addressForm === '') delete next.addressForm;
  return saveLocalProfile(dir, next);
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
