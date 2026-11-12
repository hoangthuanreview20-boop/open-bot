/**
 * Machine identity (v0.5, ROADMAP §2d).
 *
 * A stable per-machine identifier (`machineId`) that travels with
 * tokens: a token is bound to (machineId, teamId). The id is a uuid
 * stored in a plain-text file named `machine-id` inside the directory
 * the caller passes in (normally the app userData dir, next to
 * `vault.json` — but NOT inside the vault, it is not a secret).
 *
 * The file is created with mode 0600 even though the id is not a
 * secret: it is an identifier that must not be trivially copyable
 * alongside the vault by another local user.
 *
 * This module does no logging and reads no environment variables.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** File name holding the machine id inside the given directory. */
export const MACHINE_ID_FILE = 'machine-id';

/** UUID as produced by `randomUUID()` (lowercase, hyphenated). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return the stable machine id for `dir`, creating and persisting it
 * (mode 0600) on first use. A later call with the same `dir` returns
 * the same id.
 *
 * - Missing file → generate a uuid, write it (creating `dir` if
 *   needed), return it.
 * - Existing file → its trimmed content is returned when it is a
 *   valid uuid; a present-but-invalid file (empty, truncated,
 *   hand-edited) is replaced with a fresh uuid rather than throwing,
 *   so a corrupt id file can never brick startup.
 * - Unreadable / unwritable directory → throws (the caller decides
 *   how to report it; startup should fail loudly rather than run
 *   with a different id every launch).
 */
export function getOrCreateMachineId(dir: string): string {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    throw new Error('getOrCreateMachineId needs a non-empty directory path.');
  }
  const filePath = path.join(dir, MACHINE_ID_FILE);
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== null) {
    const trimmed = existing.trim();
    if (UUID_RE.test(trimmed)) return trimmed;
    // Present but invalid: fall through and replace it.
  }
  const id = randomUUID();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${id}\n`, { mode: 0o600, encoding: 'utf8' });
  return id;
}
