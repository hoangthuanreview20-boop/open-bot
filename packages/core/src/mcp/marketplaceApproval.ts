/**
 * Marketplace install/update approvals (v0.89a, worker F1 — Marketplace v2).
 *
 * Every install or update that comes from a marketplace (MCP server or
 * plugin) must be approved by the user FIRST, and the decision is
 * recorded on disk so it can be audited later. This module is the single
 * store for those decisions; it does NOT show any UI and it does NOT
 * decide by itself — the desktop main process records a decision only
 * after the user confirms in the renderer (ConfirmModal), and the
 * install/update code calls `requireMarketplaceApproval()` before it
 * touches anything.
 *
 * File: `<baseDir>/marketplace/approvals.json` (`baseDir` is the app
 * user-data dir passed in by the host):
 *   { "decisions": [ { "id", "kind", "targetId", "version?", "source?",
 *                      "decidedAt", "note?" } ] }
 *
 * Matching rule (fail-closed): a decision matches a required approval
 * when kind + targetId match AND (the required version is absent, or
 * the decision has no version pinned, or the versions are equal).
 * A decision pinned to 1.2.0 therefore never authorizes an install of
 * 2.0.0. Decisions never expire automatically — the user can remove
 * them by editing/deleting the file.
 *
 * SECURITY — no secrets here, ever: a decision records WHAT was
 * approved (kind, id, version, source label), never a credential, a
 * URL with embedded credentials, or a file's contents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MARKETPLACE_APPROVALS_REL_PATH = path.join(
  'marketplace',
  'approvals.json',
);

export type MarketplaceApprovalKind =
  | 'mcp-install'
  | 'mcp-update'
  | 'plugin-install'
  | 'plugin-update';

export interface MarketplaceApprovalDecision {
  /** Stable id of this decision (uuid). */
  id: string;
  kind: MarketplaceApprovalKind;
  /** Marketplace id that was approved (server id / plugin id). */
  targetId: string;
  /** Version that was approved, when the approval was version-pinned. */
  version?: string;
  /** Human-readable source label, e.g. "local" or "remote:example.com". */
  source?: string;
  /** ISO timestamp of the decision. */
  decidedAt: string;
  /** Optional free-text note from the UI (never a credential). */
  note?: string;
}

export interface RecordMarketplaceApprovalInput {
  kind: MarketplaceApprovalKind;
  targetId: string;
  version?: string;
  source?: string;
  note?: string;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const APPROVAL_KINDS: readonly MarketplaceApprovalKind[] = [
  'mcp-install',
  'mcp-update',
  'plugin-install',
  'plugin-update',
];

function assertNonEmptyString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid marketplace approval: "${what}" must be a non-empty string`);
  }
}

function assertApprovalKind(kind: unknown): asserts kind is MarketplaceApprovalKind {
  if (typeof kind !== 'string' || !(APPROVAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `Invalid marketplace approval kind "${String(kind)}": must be one of ${APPROVAL_KINDS.join(', ')}`,
    );
  }
}

function assertTargetId(targetId: unknown): asserts targetId is string {
  if (typeof targetId !== 'string' || !ID_RE.test(targetId)) {
    throw new Error(
      `Invalid marketplace approval target "${String(targetId)}": must match /^[A-Za-z0-9_-]+$/`,
    );
  }
}

export function getMarketplaceApprovalsPath(baseDir: string): string {
  assertNonEmptyString(baseDir, 'baseDir');
  return path.join(baseDir, MARKETPLACE_APPROVALS_REL_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecision(raw: unknown, index: number): MarketplaceApprovalDecision | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  const targetId = raw['targetId'];
  const id = raw['id'];
  const decidedAt = raw['decidedAt'];
  if (
    typeof kind !== 'string' ||
    !(APPROVAL_KINDS as readonly string[]).includes(kind) ||
    typeof targetId !== 'string' ||
    !ID_RE.test(targetId) ||
    typeof id !== 'string' ||
    !id.trim() ||
    typeof decidedAt !== 'string' ||
    !decidedAt.trim()
  ) {
    // A corrupt entry is skipped (with its index in the error only when
    // the whole file is unreadable — here we just drop the bad row so
    // one bad decision cannot block every later approval check).
    void index;
    return null;
  }
  const decision: MarketplaceApprovalDecision = {
    id,
    kind: kind as MarketplaceApprovalKind,
    targetId,
    decidedAt,
  };
  if (typeof raw['version'] === 'string' && raw['version'].trim()) {
    decision.version = raw['version'];
  }
  if (typeof raw['source'] === 'string' && raw['source'].trim()) {
    decision.source = raw['source'];
  }
  if (typeof raw['note'] === 'string' && raw['note'].trim()) {
    decision.note = raw['note'];
  }
  return decision;
}

/**
 * List every recorded approval decision. Missing file → []. A corrupt
 * file (invalid JSON / bad top-level shape) throws — a silently
 * ignored approvals file would be a fail-OPEN hole, so a broken file
 * must be fixed by hand instead of being treated as "no approvals".
 * Single corrupt rows are skipped, not fatal.
 */
export function listMarketplaceApprovals(baseDir: string): MarketplaceApprovalDecision[] {
  const filePath = getMarketplaceApprovalsPath(baseDir);
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read marketplace approvals: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid marketplace approvals file: not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['decisions'])) {
    throw new Error(
      'Invalid marketplace approvals file: top level must be an object with a "decisions" array',
    );
  }
  const out: MarketplaceApprovalDecision[] = [];
  (parsed['decisions'] as unknown[]).forEach((raw, i) => {
    const decision = parseDecision(raw, i);
    if (decision) out.push(decision);
  });
  return out;
}

function writeApprovals(baseDir: string, decisions: MarketplaceApprovalDecision[]): void {
  const filePath = getMarketplaceApprovalsPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ decisions }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Record a user's approval decision (called by main only after the
 * user confirmed in the UI). Returns the stored decision, with its
 * generated id and timestamp.
 */
export function recordMarketplaceApproval(
  baseDir: string,
  input: RecordMarketplaceApprovalInput,
): MarketplaceApprovalDecision {
  assertApprovalKind(input?.kind);
  assertTargetId(input?.targetId);
  if (input?.version !== undefined) assertNonEmptyString(input.version, 'version');
  if (input?.source !== undefined) assertNonEmptyString(input.source, 'source');
  if (input?.note !== undefined) assertNonEmptyString(input.note, 'note');
  const decision: MarketplaceApprovalDecision = {
    id: randomUUID(),
    kind: input.kind,
    targetId: input.targetId,
    decidedAt: new Date().toISOString(),
  };
  if (input.version !== undefined) decision.version = input.version;
  if (input.source !== undefined) decision.source = input.source;
  if (input.note !== undefined) decision.note = input.note;
  const decisions = listMarketplaceApprovals(baseDir);
  decisions.push(decision);
  writeApprovals(baseDir, decisions);
  return decision;
}

/**
 * True when a recorded decision authorizes this install/update.
 * Fail-closed on bad input: an invalid kind/target throws instead of
 * returning false, so a caller typo cannot silently look like "not
 * approved, ask again" in one place and "approved" in another.
 */
export function hasMarketplaceApproval(
  baseDir: string,
  kind: MarketplaceApprovalKind,
  targetId: string,
  version?: string,
): boolean {
  assertApprovalKind(kind);
  assertTargetId(targetId);
  if (version !== undefined) assertNonEmptyString(version, 'version');
  return listMarketplaceApprovals(baseDir).some(
    (d) =>
      d.kind === kind &&
      d.targetId === targetId &&
      (version === undefined || d.version === undefined || d.version === version),
  );
}

/**
 * Throw unless a recorded approval authorizes this install/update.
 * This is the gate every marketplace install/update path must call
 * before it writes anything.
 */
export function requireMarketplaceApproval(
  baseDir: string,
  kind: MarketplaceApprovalKind,
  targetId: string,
  version?: string,
): void {
  if (!hasMarketplaceApproval(baseDir, kind, targetId, version)) {
    throw new Error(
      `Marketplace ${kind} of "${targetId}"${version ? ` version ${version}` : ''} needs user approval first — no recorded approval decision found (approve it in the marketplace UI, then try again).`,
    );
  }
}
