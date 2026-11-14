/**
 * Memory block conflicts (v1.02, memory v3 — blocks v2).
 *
 * When a new fact contradicts what a block already says (e.g. the
 * `human` block says "user: lives_in Ha Noi" and a new fact says the
 * user lives in Ho Chi Minh City), blindly appending would leave the
 * block self-contradictory. This module detects that case BEFORE the
 * write and records a conflict with both sides' evidence:
 *
 *  - old side: the exact block line, the block version it came from,
 *    and when that version was written;
 *  - new side: the incoming fact line, its source (fact id /
 *    episode id / timestamp) and its confidence.
 *
 * Conflicts live in `.open-bot/memory-blocks-conflicts.json` until a
 * user resolves them: keep the current block text, accept the new
 * fact (caller applies it, then marks resolved), or merge by hand
 * (caller applies the merged text, then marks resolved). Resolutions
 * are recorded with who resolved them and when — nothing is ever
 * silently overwritten.
 *
 * Detection is line-based and only understands the promoted-fact
 * line format `- <subject>: <predicate> <object>` (the format
 * `promoteToHumanBlock` writes). Free-form block lines never match,
 * so user-written prose is never flagged as a conflict.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeGraphText } from './graph/types';

export const MEMORY_BLOCKS_CONFLICTS_REL_PATH = path.join('.open-bot', 'memory-blocks-conflicts.json');

/** How a block conflict was resolved. */
export type BlockConflictResolution = 'keep-current' | 'accept-new' | 'merged';

/** Lifecycle of a conflict. */
export type BlockConflictStatus = 'pending' | 'resolved';

export interface BlockConflictSide {
  /** The exact line / text of this side. */
  text: string;
  /** Fact id behind the new side (when the new side came from a fact). */
  factId?: string;
  /** Episode the new side came from. */
  episodeId?: string;
  /** Block version the old side came from. */
  blockVersion?: number;
  /** Confidence of the new fact (0..1). */
  confidence?: number;
  /** When this side was recorded (ISO). */
  at: string;
  /** Who recorded it (`system:consolidate`, `agent:<botId>`, `user`). */
  actor: string;
}

/** One recorded conflict between a block and an incoming fact. */
export interface BlockConflict {
  id: string;
  blockId: string;
  label: string;
  predicate: string;
  oldSide: BlockConflictSide;
  newSide: BlockConflictSide;
  status: BlockConflictStatus;
  resolution?: BlockConflictResolution;
  /** Text the user finally kept (for 'merged' resolutions). */
  resolvedText?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface BlockConflictsFile {
  version: 1;
  conflicts: BlockConflict[];
}

/** Parse a promoted-fact line `- subject: predicate object`. */
export function parsePromotedLine(line: string): { subject: string; predicate: string; object: string } | null {
  const match = /^-\s*([^:]+):\s*([a-z0-9_]+)\s+(.+)$/.exec(line.trim());
  if (!match) return null;
  const subject = (match[1] ?? '').trim();
  const predicate = (match[2] ?? '').trim();
  const object = (match[3] ?? '').trim();
  if (subject === '' || predicate === '' || object === '') return null;
  return { subject, predicate, object };
}

/**
 * Find the block line that contradicts an incoming fact: same
 * subject + predicate, different object (after normalization).
 * Returns the conflicting line, or null when there is none.
 */
export function findConflictingLine(
  blockContent: string,
  subjectName: string,
  predicate: string,
  objectText: string,
): string | null {
  const subjectNorm = normalizeGraphText(subjectName);
  const predicateNorm = normalizeGraphText(predicate).replace(/\s+/g, '_');
  const objectNorm = normalizeGraphText(objectText);
  if (subjectNorm === '' || predicateNorm === '' || objectNorm === '') return null;
  for (const line of (blockContent ?? '').split('\n')) {
    const parsed = parsePromotedLine(line);
    if (!parsed) continue;
    if (normalizeGraphText(parsed.subject) !== subjectNorm) continue;
    if (normalizeGraphText(parsed.predicate).replace(/\s+/g, '_') !== predicateNorm) continue;
    if (normalizeGraphText(parsed.object) === objectNorm) continue;
    return line.trim();
  }
  return null;
}

/**
 * Build the promoted-fact line for a new fact (same format the
 * sleep agent writes into the `human` block).
 */
export function promotedFactLine(subjectName: string, predicate: string, objectText: string): string {
  return `- ${subjectName}: ${predicate} ${objectText}`;
}

function emptyFile(): BlockConflictsFile {
  return { version: 1, conflicts: [] };
}

export class BlockConflictStore {
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, MEMORY_BLOCKS_CONFLICTS_REL_PATH);
  }

  private readFile(): BlockConflictsFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Block conflicts file is not valid JSON: ${MEMORY_BLOCKS_CONFLICTS_REL_PATH}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as BlockConflictsFile).version !== 1 ||
      !Array.isArray((parsed as BlockConflictsFile).conflicts)
    ) {
      throw new Error(`Block conflicts file has an unsupported shape: ${MEMORY_BLOCKS_CONFLICTS_REL_PATH}`);
    }
    return parsed as BlockConflictsFile;
  }

  private writeFile(file: BlockConflictsFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * Check an incoming fact line against a block's content. When it
   * contradicts an existing line, record a pending conflict (unless
   * an identical pending conflict already exists — then return the
   * existing one) and return it. Returns null when there is no
   * contradiction — the caller may append the line.
   */
  checkAndRecord(
    blockId: string,
    label: string,
    blockContent: string,
    blockVersion: number,
    subjectName: string,
    predicate: string,
    objectText: string,
    source: { factId?: string; episodeId?: string; confidence?: number; at?: string; actor?: string },
  ): BlockConflict | null {
    const conflictingLine = findConflictingLine(blockContent, subjectName, predicate, objectText);
    if (conflictingLine === null) return null;
    const now = new Date().toISOString();
    const file = this.readFile();
    const newLine = promotedFactLine(subjectName, predicate, objectText);
    const existing = file.conflicts.find(
      (c) =>
        c.status === 'pending' &&
        c.blockId === blockId &&
        c.predicate === normalizeGraphText(predicate).replace(/\s+/g, '_') &&
        c.newSide.text === newLine &&
        c.oldSide.text === conflictingLine,
    );
    if (existing) return { ...existing };
    const conflict: BlockConflict = {
      id: randomUUID(),
      blockId,
      label,
      predicate: normalizeGraphText(predicate).replace(/\s+/g, '_'),
      oldSide: {
        text: conflictingLine,
        blockVersion,
        at: now,
        actor: source.actor ?? 'system:consolidate',
      },
      newSide: {
        text: newLine,
        ...(source.factId ? { factId: source.factId } : {}),
        ...(source.episodeId ? { episodeId: source.episodeId } : {}),
        ...(source.confidence !== undefined ? { confidence: source.confidence } : {}),
        at: source.at ?? now,
        actor: source.actor ?? 'system:consolidate',
      },
      status: 'pending',
      createdAt: now,
    };
    file.conflicts.push(conflict);
    this.writeFile(file);
    return { ...conflict };
  }

  /** List conflicts (pending first, newest first within each group). */
  list(opts: { status?: BlockConflictStatus; blockId?: string; limit?: number } = {}): BlockConflict[] {
    const file = this.readFile();
    let out = file.conflicts;
    if (opts.status) out = out.filter((c) => c.status === opts.status);
    if (opts.blockId) out = out.filter((c) => c.blockId === opts.blockId);
    out = [...out].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return out.slice(0, opts.limit ?? 100).map((c) => ({ ...c }));
  }

  get(id: string): BlockConflict | null {
    const file = this.readFile();
    const found = file.conflicts.find((c) => c.id === id);
    return found ? { ...found } : null;
  }

  /**
   * Resolve a pending conflict. `keep-current` keeps the block as
   * is; `accept-new` means the caller replaces the old line with
   * the new side's text; `merged` means the caller applied
   * `resolvedText` to the block. The store only records the
   * decision — applying the text is the caller's job, so the block
   * and the conflict record can never disagree about who changed
   * what. Resolving an already-resolved conflict throws.
   */
  resolve(
    id: string,
    resolution: BlockConflictResolution,
    resolvedBy: string,
    resolvedText?: string,
  ): BlockConflict {
    const file = this.readFile();
    const conflict = file.conflicts.find((c) => c.id === id);
    if (!conflict) throw new Error(`Block conflict "${id}" not found.`);
    if (conflict.status !== 'pending') throw new Error(`Block conflict "${id}" was already resolved.`);
    if (resolution === 'merged' && (resolvedText ?? '').trim() === '') {
      throw new Error('A merged resolution needs the merged text (resolvedText).');
    }
    conflict.status = 'resolved';
    conflict.resolution = resolution;
    if (resolvedText !== undefined) conflict.resolvedText = resolvedText;
    conflict.resolvedBy = resolvedBy;
    conflict.resolvedAt = new Date().toISOString();
    this.writeFile(file);
    return { ...conflict };
  }
}
