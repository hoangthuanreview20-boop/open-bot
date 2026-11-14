/**
 * Memory block version history (v1.02, memory v3 — blocks v2).
 *
 * v0.96 blocks only carry a `version` COUNTER: you can see a block is
 * at version 7, but never what version 6 said. This module adds the
 * missing history: every create/update/replace/append/set-read-only
 * writes one snapshot to an append-only log
 * (`.open-bot/memory-blocks-history.jsonl`), so any version can be
 * inspected and restored.
 *
 * Restore never rewrites history: restoring version N writes the old
 * content back as a NEW version (counter + 1) with an audit entry,
 * and the restore itself is snapshotted too. History is capped at
 * 50 snapshots per block (oldest pruned on write) so the log cannot
 * grow without bound.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryBlock } from './blocks';

export const MEMORY_BLOCKS_HISTORY_REL_PATH = path.join('.open-bot', 'memory-blocks-history.jsonl');
/** Snapshots kept per block (oldest pruned on write). */
export const MAX_BLOCK_HISTORY_PER_BLOCK = 50;

/** One version snapshot of a block. */
export interface BlockVersionSnapshot {
  blockId: string;
  label: string;
  version: number;
  content: string;
  description: string;
  charLimit: number;
  readOnly: boolean;
  /** What produced this version: create/update/replace/append/set-read-only/restore. */
  action: string;
  actor: string;
  at: string;
}

/**
 * Append one snapshot for the block's CURRENT state. Best-effort:
 * a history write failure never fails the block operation itself
 * (history is for inspection, not a gate). Returns false when the
 * snapshot could not be written.
 */
export function recordBlockVersion(
  workspaceDir: string,
  block: MemoryBlock,
  action: string,
  actor: string,
): boolean {
  try {
    const filePath = path.join(workspaceDir, MEMORY_BLOCKS_HISTORY_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const snapshot: BlockVersionSnapshot = {
      blockId: block.id,
      label: block.label,
      version: block.version,
      content: block.content,
      description: block.description,
      charLimit: block.charLimit,
      readOnly: block.readOnly,
      action,
      actor,
      at: new Date().toISOString(),
    };
    fs.appendFileSync(filePath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    pruneBlockHistory(workspaceDir, block.id);
    return true;
  } catch {
    return false;
  }
}

/** All snapshots for a block, oldest first (empty when none). */
export function readBlockHistory(workspaceDir: string, blockId: string, limit = 50): BlockVersionSnapshot[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceDir, MEMORY_BLOCKS_HISTORY_REL_PATH), 'utf8');
  } catch {
    return [];
  }
  const out: BlockVersionSnapshot[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as BlockVersionSnapshot;
      if (parsed.blockId === blockId && typeof parsed.version === 'number') out.push(parsed);
    } catch {
      // Corrupt line — skip it.
    }
  }
  out.sort((a, b) => a.version - b.version);
  return out.slice(-Math.max(1, Math.min(200, limit)));
}

/** One snapshot by version number, or null. */
export function readBlockVersion(
  workspaceDir: string,
  blockId: string,
  version: number,
): BlockVersionSnapshot | null {
  const history = readBlockHistory(workspaceDir, blockId, 200);
  return history.find((s) => s.version === version) ?? null;
}

/**
 * Prune snapshots of one block down to MAX_BLOCK_HISTORY_PER_BLOCK,
 * keeping the newest. Rewrites the whole history file atomically
 * (temp + rename, mode 0600). Best-effort, never throws.
 */
export function pruneBlockHistory(workspaceDir: string, blockId: string): void {
  try {
    const filePath = path.join(workspaceDir, MEMORY_BLOCKS_HISTORY_REL_PATH);
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const kept: string[] = [];
    const blockLines: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as BlockVersionSnapshot;
        if (parsed.blockId === blockId) blockLines.push(line);
        else kept.push(line);
      } catch {
        // Keep unparseable lines of other blocks untouched.
        kept.push(line);
      }
    }
    if (blockLines.length <= MAX_BLOCK_HISTORY_PER_BLOCK) return;
    const pruned = blockLines.slice(-MAX_BLOCK_HISTORY_PER_BLOCK);
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, [...kept, ...pruned].join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    // History pruning is best-effort.
  }
}
