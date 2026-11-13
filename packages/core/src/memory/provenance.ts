/**
 * Memory provenance + quota (v0.97, Team T4 — Memory v2).
 *
 * Idea learned from OWASP ASI06 (Memory & Context Poisoning) and from
 * Mem0/Letta's provenance practice: memory must never be trusted blindly.
 * Every memory item records WHERE it came from, WHO wrote it, and WHEN;
 * per-bot quotas cap how much memory can accumulate; suspicious content
 * (instruction-like text smuggled into a fact, contradictory claims) is
 * flagged instead of silently believed.
 *
 * This module is 100% deterministic and local: no model call, no network.
 * It is the trust layer that sits UNDER the v0.96 memory blocks and the
 * v0.97 temporal knowledge graph — it does not replace them.
 *
 * Design:
 *  - `MemoryProvenance` — source record attached to any memory item.
 *  - `MemoryQuota` / `MemoryQuotaUsage` — per-bot caps (count + chars)
 *    with a pure `checkQuota()` that returns what would exceed.
 *  - `detectSuspiciousContent()` — heuristic scan for prompt-injection
 *    patterns inside memory text (imperatives aimed at the agent,
 *    "ignore previous instructions", fake system markers, URLs that
 *    claim authority, ...). Returns flags, never mutates.
 *  - `detectContradiction()` — two facts about the same key with
 *    different normalised values are a contradiction candidate; the
 *    newer one does NOT silently win here — both are flagged and the
 *    caller decides (sleep agent archives the loser, UI shows the flag).
 *  - `trustScore()` — 0..1 score from source kind + age + flags, used
 *    by hybrid search ranking (low-trust items rank lower, flagged
 *    items are labelled in the explanation).
 *  - `ProvenanceLog` — append-only JSONL audit of provenance decisions
 *    (flag / quarantine / trust change), stored next to the other
 *    memory files so the UI can show "why is this memory flagged?".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where a memory item came from. */
export type ProvenanceSourceKind =
  | 'user' // typed / said by the user in chat
  | 'bot' // written by a bot (its own inference or tool result)
  | 'tool' // produced by a tool call result
  | 'import' // imported from a file (MemFS / JSON export)
  | 'system'; // created by the system (consolidation, sleep agent, migration)

/** Who/what produced the memory, and through which channel. */
export interface MemoryProvenance {
  /** Source kind (see above). */
  source: ProvenanceSourceKind;
  /** Bot that recorded it ('' = shared / no bot). */
  botId: string;
  /** Stable user id when known ('' = legacy / unknown). */
  userId?: string;
  /** Free-form origin detail: tool name, file name, chat id, ... */
  origin?: string;
  /** ISO timestamp when the memory was recorded. */
  recordedAt: string;
  /** Trust score 0..1 at record time (see `trustScore`). */
  trust: number;
  /** Suspicion flags raised at record time (empty = clean). */
  flags: MemorySuspicionFlag[];
  /** True when the item is quarantined: excluded from prompt recall. */
  quarantined: boolean;
}

/** One suspicion flag attached to a memory item. */
export interface MemorySuspicionFlag {
  /** Stable flag code, e.g. `instruction-like`. */
  code: SuspicionCode;
  /** Human-readable detail (English, shown in UI). */
  detail: string;
  /** Severity: `low` = note, `high` = quarantine candidate. */
  severity: 'low' | 'high';
}

export type SuspicionCode =
  | 'instruction-like'
  | 'fake-system-marker'
  | 'authority-url'
  | 'contradiction'
  | 'oversized'
  | 'untrusted-import';

/** Per-bot quota configuration. */
export interface MemoryQuota {
  /** Max memory items per bot (default 2000). */
  maxItems: number;
  /** Max total characters of all values per bot (default 500_000). */
  maxChars: number;
  /** Max characters of a single value (default 8000). */
  maxCharsPerItem: number;
  /** Max entities in the temporal graph per bot (default 5000). */
  maxGraphEntities: number;
  /** Max relations in the temporal graph per bot (default 20000). */
  maxGraphRelations: number;
}

export const DEFAULT_MEMORY_QUOTA: MemoryQuota = {
  maxItems: 2000,
  maxChars: 500_000,
  maxCharsPerItem: 8000,
  maxGraphEntities: 5000,
  maxGraphRelations: 20000,
};

/** Current usage measured against a quota. */
export interface MemoryQuotaUsage {
  items: number;
  chars: number;
  graphEntities: number;
  graphRelations: number;
}

/** Result of a quota check: what would exceed, if anything. */
export interface QuotaCheckResult {
  allowed: boolean;
  /** Codes of the limits that would be exceeded. */
  exceeded: Array<'items' | 'chars' | 'per-item' | 'graph-entities' | 'graph-relations'>;
  /** Human-readable explanation (English). */
  detail: string;
  usage: MemoryQuotaUsage;
  quota: MemoryQuota;
}

/** One append-only provenance audit record. */
export interface ProvenanceLogEntry {
  at: string;
  /** `flag` | `quarantine` | `unquarantine` | `trust-change` | `quota-block`. */
  action: string;
  /** Memory / entity / relation id the decision concerns. */
  itemId: string;
  actor: string;
  detail?: string;
}

export const MEMORY_PROVENANCE_LOG_REL_PATH = path.join(
  '.open-bot',
  'memory-provenance.jsonl',
);

/** Instruction-like patterns that suggest prompt injection in memory text. */
export const SUSPICIOUS_PATTERNS: Array<{
  code: SuspicionCode;
  severity: 'low' | 'high';
  re: RegExp;
  detail: string;
}> = [
  {
    code: 'instruction-like',
    severity: 'high',
    re: /\b(ignore|disregard|forget|override)\b[^.]{0,60}\b(instructions?|prompt|system|rules?|previous)\b/i,
    detail: 'Text tells the agent to ignore or override instructions.',
  },
  {
    code: 'instruction-like',
    severity: 'high',
    re: /\b(you (must|should|will|are to)|do not (tell|mention|reveal|say)|always (do|say|reveal|send|share))\b/i,
    detail: 'Text contains imperative instructions aimed at the agent.',
  },
  {
    code: 'instruction-like',
    severity: 'low',
    re: /\b(system prompt|developer message|new instructions?|updated (rules?|policy))\b/i,
    detail: 'Text claims to be a new system/developer instruction.',
  },
  {
    code: 'fake-system-marker',
    severity: 'high',
    re: /(<\s*system\s*>|\[\s*SYSTEM\s*\]|###\s*SYSTEM|```system|<\/?(assistant|user|tool)[_a-z]*>)/i,
    detail: 'Text contains fake chat/system role markers.',
  },
  {
    code: 'authority-url',
    severity: 'low',
    re: /https?:\/\/[^\s]{4,}/i,
    detail: 'Text contains a URL claiming external authority.',
  },
  {
    code: 'instruction-like',
    severity: 'low',
    re: /\b(send|share|exfiltrate|upload)\b[^.]{0,40}\b(password|secret|api[-_ ]?key|token|credential)\b/i,
    detail: 'Text asks the agent to share a secret.',
  },
];

/**
 * Scan memory text for suspicious (possibly injected) content.
 * Pure function: returns flags, never throws, never mutates input.
 * Empty text returns no flags.
 */
export function detectSuspiciousContent(text: string): MemorySuspicionFlag[] {
  const input = typeof text === 'string' ? text : '';
  if (input.trim() === '') return [];
  const flags: MemorySuspicionFlag[] = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.re.test(input)) {
      flags.push({ code: pattern.code, detail: pattern.detail, severity: pattern.severity });
    }
  }
  return flags;
}

/** True when any flag is high severity (quarantine candidate). */
export function hasHighSeverityFlag(flags: MemorySuspicionFlag[]): boolean {
  return flags.some((f) => f.severity === 'high');
}

/**
 * Normalise a fact value for contradiction comparison: lowercase,
 * strip Vietnamese diacritics, drop punctuation, collapse whitespace.
 * Shared with consolidate.ts's normaliser (duplicated on purpose so
 * this module stays dependency-free).
 */
export function normalizeProvenanceValue(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ContradictionCandidate {
  key: string;
  firstId: string;
  firstValue: string;
  firstRecordedAt: string;
  secondId: string;
  secondValue: string;
  secondRecordedAt: string;
  /** The newer item (by recordedAt, then by id for determinism). */
  newerId: string;
}

/**
 * Find contradiction candidates: same normalised key, different
 * normalised values. Items are NOT resolved here — the caller decides
 * (sleep agent archives the loser, UI shows the flag). Returns one
 * candidate per conflicting pair, newest-first.
 */
export function detectContradictions(
  items: Array<{ id: string; key: string; value: string; recordedAt: string }>,
): ContradictionCandidate[] {
  const byKey = new Map<string, Array<{ id: string; key: string; value: string; recordedAt: string }>>();
  for (const item of items) {
    const key = normalizeProvenanceValue(item.key);
    if (key === '') continue;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  const out: ContradictionCandidate[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const distinct = new Map<string, typeof group>();
    for (const item of group) {
      const sig = normalizeProvenanceValue(item.value);
      const list = distinct.get(sig) ?? [];
      list.push(item);
      distinct.set(sig, list);
    }
    if (distinct.size < 2) continue;
    const sorted = [...group].sort((a, b) =>
      a.recordedAt === b.recordedAt ? a.id.localeCompare(b.id) : a.recordedAt.localeCompare(b.recordedAt),
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i] as (typeof group)[number];
        const b = sorted[j] as (typeof group)[number];
        if (normalizeProvenanceValue(a.value) === normalizeProvenanceValue(b.value)) continue;
        out.push({
          key,
          firstId: a.id,
          firstValue: a.value,
          firstRecordedAt: a.recordedAt,
          secondId: b.id,
          secondValue: b.value,
          secondRecordedAt: b.recordedAt,
          newerId: b.id,
        });
      }
    }
  }
  return out;
}

/** Base trust per source kind: user and system are most trusted. */
export const SOURCE_TRUST: Record<ProvenanceSourceKind, number> = {
  user: 0.95,
  system: 0.9,
  bot: 0.7,
  tool: 0.6,
  import: 0.5,
};

/**
 * Trust score 0..1 for a memory item.
 *  - starts from the source-kind base trust;
 *  - high-severity flags cut it to at most 0.2, low flags subtract 0.1 each;
 *  - items older than 180 days lose 0.1 (stale facts are less trusted);
 *  - quarantined items score 0.
 * Deterministic: same input always yields the same score.
 */
export function trustScore(
  provenance: Pick<MemoryProvenance, 'source' | 'flags' | 'quarantined' | 'recordedAt'>,
  now = new Date(),
): number {
  if (provenance.quarantined) return 0;
  let score = SOURCE_TRUST[provenance.source] ?? 0.5;
  let lowFlags = 0;
  for (const flag of provenance.flags ?? []) {
    if (flag.severity === 'high') return Math.min(score, 0.2);
    lowFlags += 1;
  }
  score -= 0.1 * lowFlags;
  const recorded = Date.parse(provenance.recordedAt);
  if (Number.isFinite(recorded)) {
    const ageDays = (now.getTime() - recorded) / 86_400_000;
    if (ageDays > 180) score -= 0.1;
  }
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/**
 * Build a provenance record for a newly recorded memory item.
 * Runs the suspicion scan immediately so the flag is stored with the
 * item, not discovered later. Quarantine is NOT automatic: a high
 * flag only lowers trust; the caller (or the user in the UI) decides
 * to quarantine. `import` sources start with an extra low flag when
 * the origin file is unknown, because imported text was never seen
 * in a live conversation.
 */
export function createProvenance(opts: {
  source: ProvenanceSourceKind;
  botId: string;
  userId?: string;
  origin?: string;
  text: string;
  recordedAt?: string;
}): MemoryProvenance {
  const flags = detectSuspiciousContent(opts.text);
  if (opts.source === 'import' && (!opts.origin || opts.origin.trim() === '')) {
    flags.push({
      code: 'untrusted-import',
      detail: 'Imported memory with no recorded origin file.',
      severity: 'low',
    });
  }
  const recordedAt = opts.recordedAt ?? new Date().toISOString();
  const base: MemoryProvenance = {
    source: opts.source,
    botId: opts.botId,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    recordedAt,
    trust: 0,
    flags,
    quarantined: false,
  };
  base.trust = trustScore(base);
  return base;
}

/**
 * Pure quota check: would adding `incoming` (items/chars, plus graph
 * growth) exceed the quota given current `usage`? Nothing is mutated.
 * A single oversized item is rejected even when the totals still fit.
 */
export function checkQuota(
  usage: MemoryQuotaUsage,
  incoming: { items?: number; chars?: number; graphEntities?: number; graphRelations?: number },
  quota: MemoryQuota = DEFAULT_MEMORY_QUOTA,
): QuotaCheckResult {
  const exceeded: QuotaCheckResult['exceeded'] = [];
  const items = incoming.items ?? 0;
  const chars = incoming.chars ?? 0;
  if (chars > quota.maxCharsPerItem && items > 0) exceeded.push('per-item');
  if (usage.items + items > quota.maxItems) exceeded.push('items');
  if (usage.chars + chars > quota.maxChars) exceeded.push('chars');
  if (usage.graphEntities + (incoming.graphEntities ?? 0) > quota.maxGraphEntities) {
    exceeded.push('graph-entities');
  }
  if (usage.graphRelations + (incoming.graphRelations ?? 0) > quota.maxGraphRelations) {
    exceeded.push('graph-relations');
  }
  const detail =
    exceeded.length === 0
      ? 'Within quota.'
      : `Quota exceeded: ${exceeded.join(', ')} (items ${usage.items + items}/${quota.maxItems}, chars ${usage.chars + chars}/${quota.maxChars}).`;
  return { allowed: exceeded.length === 0, exceeded, detail, usage, quota };
}

/**
 * Append-only provenance audit log (JSONL, mode 0600 via atomic write
 * of the directory; each line is one JSON object). Fail-open: a log
 * write failure never blocks the memory write it describes.
 */
export class ProvenanceLog {
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, MEMORY_PROVENANCE_LOG_REL_PATH);
  }

  get path(): string {
    return this.filePath;
  }

  append(entry: Omit<ProvenanceLogEntry, 'at'> & { at?: string }): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() });
      fs.appendFileSync(this.filePath, `${line}\n`, { mode: 0o600 });
    } catch {
      // Fail-open: provenance logging must never break a memory write.
    }
  }

  /** Read the last `limit` entries (newest last, as stored). */
  read(limit = 200): ProvenanceLogEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
      const out: ProvenanceLogEntry[] = [];
      for (const line of lines.slice(-Math.max(1, limit))) {
        try {
          out.push(JSON.parse(line) as ProvenanceLogEntry);
        } catch {
          // Skip a single corrupt line, keep the rest.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
