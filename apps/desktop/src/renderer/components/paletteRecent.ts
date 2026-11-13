/**
 * Palette recents (v0.96, Team T6) — the command palette's "recent
 * commands" list, kept in localStorage.
 *
 * Kept in its own `.ts` module (no JSX) so node --test can import
 * it directly via type stripping, like theme.ts / cronBuilder.ts.
 * A recent entry is the item's stable key (`bot:<id>`,
 * `action:create-bot`, `view:settings`, …); the palette resolves
 * keys back to live items, so a stale key (bot deleted since) is
 * silently dropped instead of shown.
 */

export const PALETTE_RECENT_KEY = 'open-bot:palette-recent';
export const PALETTE_RECENT_MAX = 8;

export function readPaletteRecent(storage: Pick<Storage, 'getItem'> | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PALETTE_RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, PALETTE_RECENT_MAX);
  } catch {
    return [];
  }
}

/** Prepend `key` (deduped, capped) and persist. Returns the new list. */
export function recordPaletteRecent(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  key: string,
): string[] {
  const current = readPaletteRecent(storage);
  const next = [key, ...current.filter((k) => k !== key)].slice(0, PALETTE_RECENT_MAX);
  try {
    storage?.setItem(PALETTE_RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — recents just do not persist.
  }
  return next;
}

/** Drop keys that no longer resolve to a live palette item. */
export function prunePaletteRecent(knownKeys: ReadonlySet<string>, recent: readonly string[]): string[] {
  return recent.filter((k) => knownKeys.has(k));
}
