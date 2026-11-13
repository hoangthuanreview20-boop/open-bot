/**
 * Sleep-time consolidation agent (v0.97, Team T4 — Memory v2).
 *
 * Idea learned from Letta's sleep-time agents and Mem0 v3's two-step
 * pipeline (extraction, then consolidation): a BACKGROUND agent reviews
 * recent conversation AFTER the turn has finished, extracts what
 * matters, and updates memory — never inside the turn itself, so it
 * can never slow down or corrupt a live reply.
 *
 * Triggers (any of them):
 *  - after N completed steps/turns since the last run (`stepsThreshold`);
 *  - when the context was compacted (`onCompact` — the caller passes
 *    the compacted transcript so nothing is lost);
 *  - manually, via the `memory_sleep_run` tool or the UI.
 *
 * What one run does (all deterministic, no model call, no network):
 *  1. Extract candidate facts from recent episodes with pattern
 *     rules (preferences, identity, location, health notes, ...).
 *  2. Run the v0.96 `consolidate()` pass (dedupe + conflict resolve +
 *     promote important facts to the `human` block).
 *  3. Save NEW facts into long-term memory (with provenance
 *     `source: 'system'`, origin `sleep-agent`), then promote the
 *     important ones into memory blocks via `consolidate()`.
 *  4. Build the temporal graph incrementally: entities + relations
 *     from the same episodes (e.g. "Huy likes pho" -> entity `pho`,
 *     relation `huy -likes-> pho`).
 *  5. Flag contradictions and suspicious content via provenance.ts
 *     instead of trusting the new facts blindly; flagged facts are
 *     recorded with low trust and listed in the run report.
 *
 * Safety rails (lessons from v0.95/v0.96 regressions):
 *  - DEFAULT OFF. Nothing runs unless the user/agent enables it.
 *  - NEVER runs for provider `mock` or provider kind `cli` bots
 *    (test/fake bots must not get real memory writes; CLI bots own
 *    their own session state). `shouldRunForBot()` enforces this.
 *  - NEVER probes the network or Ollama on the turn path: the run
 *    is async/background, embeddings are only backfilled when an
 *    embedder is explicitly supplied, with a short timeout.
 *  - Quota-checked: a run that would exceed the per-bot quota stops
 *    early and reports `quotaBlocked` instead of writing past the cap.
 *  - The run report is persisted (`memory-sleep.json`) so the UI can
 *    show exactly what the last sleep run did, and when.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { consolidate } from './consolidate';
import type { ConsolidationReport } from './consolidate';
import { MemoryBlockStore } from './blocks';
import { LongTermMemory } from './longterm';
import type { LongTermMemoryEntry } from './longterm';
import { TemporalKnowledgeGraph } from './graph';
import type { GraphEntityType } from './graph';
import {
  detectSuspiciousContent,
  detectContradictions,
  hasHighSeverityFlag,
  checkQuota,
  DEFAULT_MEMORY_QUOTA,
} from './provenance';
import type { MemoryQuota } from './provenance';
import { normalizeFactText } from './consolidate';

export const MEMORY_SLEEP_REL_PATH = path.join('.open-bot', 'memory-sleep.json');
/** Per-bot sleep state file name (config + step counter are per bot). */
export function sleepStateFileName(botId: string): string {
  const slug = (botId ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
  return `memory-sleep-${slug}.json`;
}
/** Default: run after this many completed turns since the last run. */
export const DEFAULT_SLEEP_STEPS_THRESHOLD = 20;
/** Max episodes examined in one run (keeps a run bounded). */
export const MAX_SLEEP_EPISODES_PER_RUN = 50;
/** Max facts extracted from one episode (a turn rarely holds more). */
export const MAX_FACTS_PER_EPISODE = 10;
/** Confidence assigned to a pattern-extracted fact (deterministic rules, not a model). */
export const EXTRACTED_FACT_CONFIDENCE = 0.75;
/** Confidence for an explicit identity statement ("my name is X"). */
export const IDENTITY_FACT_CONFIDENCE = 0.95;

/** One conversation episode fed to the sleep agent (one turn pair). */
export interface SleepEpisode {
  /** Stable id of the episode (turn id, message id, ...). */
  id: string;
  /** 'user' or 'bot' — only user turns are mined for facts about the user. */
  role: 'user' | 'bot';
  text: string;
  at: string;
}

/** One fact extracted from an episode (before it is stored). */
export interface ExtractedFact {
  key: string;
  value: string;
  confidence: number;
  tags: string[];
  /** Episode the fact came from (provenance origin). */
  episodeId: string;
  /** Relation hint for the graph, e.g. `likes` (empty = no graph edge). */
  relationLabel?: string;
  /** Entity the relation points at (e.g. `pho` for "likes pho"). */
  relationTarget?: string;
  /** Entity type of the relation target. */
  relationTargetType?: GraphEntityType;
}

export interface SleepAgentConfig {
  /** Master switch (default false — nothing runs unless enabled). */
  enabled: boolean;
  /** Run after this many turns since the last run (default 20). */
  stepsThreshold: number;
  /** Also run when the context is compacted (default true when enabled). */
  runOnCompact: boolean;
  /** Promote important facts to the `human` block (default true). */
  promoteToBlocks: boolean;
  /** Also build the temporal graph from episodes (default true). */
  buildGraph: boolean;
  /** Min confidence for a fact to be stored (default 0.5). */
  minConfidence: number;
}

export const DEFAULT_SLEEP_CONFIG: SleepAgentConfig = {
  enabled: false,
  stepsThreshold: DEFAULT_SLEEP_STEPS_THRESHOLD,
  runOnCompact: true,
  promoteToBlocks: true,
  buildGraph: true,
  minConfidence: 0.5,
};

export interface SleepRunReport {
  ranAt: string;
  botId: string;
  trigger: 'steps' | 'compact' | 'manual' | 'scheduled';
  episodesExamined: number;
  factsExtracted: number;
  factsStored: number;
  factsFlagged: number;
  factsSkippedQuota: number;
  contradictionsFound: number;
  graphEntitiesAdded: number;
  graphRelationsAdded: number;
  consolidation?: ConsolidationReport;
  /** Quota blocked the run (partial or full). */
  quotaBlocked: boolean;
  /** Per-fact notes for the UI (flagged facts list their flag codes). */
  details: string[];
  /** Ids of episodes already processed (so the next run skips them). */
  processedEpisodeIds: string[];
}

interface SleepStateFile {
  version: 1;
  config: SleepAgentConfig;
  stepsSinceLastRun: number;
  lastRunAt?: string;
  lastReport?: SleepRunReport;
  processedEpisodeIds: string[];
}

/** One deterministic extraction rule: regex + key/value builders. */
interface ExtractionRule {
  name: string;
  re: RegExp;
  key: (m: RegExpMatchArray) => string;
  value: (m: RegExpMatchArray) => string;
  confidence: number;
  tags: string[];
  relationLabel?: string;
  relationTarget?: (m: RegExpMatchArray) => string;
  relationTargetType?: GraphEntityType;
}

const EXTRACTION_RULES: ExtractionRule[] = [
  {
    name: 'name-en',
    re: /\bmy name is ([A-Z][\w'’-]{1,40}(?:\s+[A-Z][\w'’-]{1,40})?)/i,
    key: () => 'name',
    value: (m) => (m[1] as string).trim(),
    confidence: IDENTITY_FACT_CONFIDENCE,
    tags: ['identity'],
  },
  {
    name: 'name-vi',
    re: /tên (?:tôi|mình|tớ) là ([^\s,.;!]{1,40}(?:\s+[^\s,.;!]{1,40})?)/i,
    key: () => 'name',
    value: (m) => (m[1] as string).trim(),
    confidence: IDENTITY_FACT_CONFIDENCE,
    tags: ['identity'],
  },
  {
    name: 'likes-en',
    re: /\bI (?:really )?(?:like|love|enjoy) ([a-z][^,.;!]{1,60})/i,
    key: () => 'likes',
    value: (m) => (m[1] as string).trim(),
    confidence: EXTRACTED_FACT_CONFIDENCE,
    tags: ['preference'],
    relationLabel: 'likes',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'concept',
  },
  {
    name: 'likes-vi',
    re: /tôi (?:rất )?thích ([^,.;!]{1,60})/i,
    key: () => 'likes',
    value: (m) => (m[1] as string).trim(),
    confidence: EXTRACTED_FACT_CONFIDENCE,
    tags: ['preference'],
    relationLabel: 'likes',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'concept',
  },
  {
    name: 'dislikes-en',
    re: /\bI (?:do not|don't|dislike|hate) (?:like )?([a-z][^,.;!]{1,60})/i,
    key: () => 'dislikes',
    value: (m) => (m[1] as string).trim(),
    confidence: EXTRACTED_FACT_CONFIDENCE,
    tags: ['preference'],
    relationLabel: 'dislikes',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'concept',
  },
  {
    name: 'lives-en',
    re: /\bI live in ([A-Z][^,.;!]{1,60})/,
    key: () => 'location',
    value: (m) => (m[1] as string).trim(),
    confidence: EXTRACTED_FACT_CONFIDENCE,
    tags: ['location'],
    relationLabel: 'lives-in',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'place',
  },
  {
    name: 'lives-vi',
    re: /tôi sống (?:ở|tại) ([^,.;!]{1,60})/i,
    key: () => 'location',
    value: (m) => (m[1] as string).trim(),
    confidence: EXTRACTED_FACT_CONFIDENCE,
    tags: ['location'],
    relationLabel: 'lives-in',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'place',
  },
  {
    name: 'works-en',
    re: /\bI work (?:as|at|for) ([^,.;!]{1,60})/i,
    key: () => 'work',
    value: (m) => (m[1] as string).trim(),
    confidence: EXTRACTED_FACT_CONFIDENCE,
    tags: ['work'],
    relationLabel: 'works-at',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'concept',
  },
  {
    name: 'allergy-en',
    re: /\bI am allergic to ([^,.;!]{1,60})/i,
    key: () => 'allergy',
    value: (m) => (m[1] as string).trim(),
    confidence: 0.9,
    tags: ['health', 'quan trọng'],
    relationLabel: 'allergic-to',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'concept',
  },
  {
    name: 'allergy-vi',
    re: /tôi (?:bị )?dị ứng (?:với )?([^,.;!]{1,60})/i,
    key: () => 'allergy',
    value: (m) => (m[1] as string).trim(),
    confidence: 0.9,
    tags: ['health', 'quan trọng'],
    relationLabel: 'allergic-to',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'concept',
  },
  {
    name: 'birthday-en',
    re: /\bmy birthday is ([^,.;!]{1,40})/i,
    key: () => 'birthday',
    value: (m) => (m[1] as string).trim(),
    confidence: 0.9,
    tags: ['identity'],
  },
  {
    name: 'birthday-vi',
    re: /sinh nhật (?:của )?(?:tôi|mình) (?:là )?([^,.;!]{1,40})/i,
    key: () => 'birthday',
    value: (m) => (m[1] as string).trim(),
    confidence: 0.9,
    tags: ['identity'],
  },
  {
    name: 'prefers-en',
    re: /\bI prefer ([a-z][^,.;!]{1,60})/i,
    key: () => 'prefers',
    value: (m) => (m[1] as string).trim(),
    confidence: EXTRACTED_FACT_CONFIDENCE,
    tags: ['preference'],
    relationLabel: 'prefers',
    relationTarget: (m) => (m[1] as string).trim(),
    relationTargetType: 'concept',
  },
];

/**
 * Extract candidate facts from ONE episode. Deterministic pattern
 * rules only — no model, no hallucination: if no rule matches, no
 * fact is extracted. Bot turns are skipped (the agent must not learn
 * "facts" from its own replies).
 */
/**
 * Trim a captured fact value: regex captures run to the next sentence
 * boundary, which can swallow a second clause ("pho and I live in
 * Hanoi"). Cut at " and I/my ..." and at a trailing " and <verb>".
 */
export function cleanFactValue(raw: string): string {
  return (raw ?? '')
    .replace(/\s+and\s+(I|my|i)\s+.*$/i, '')
    .replace(/\s+and\s+(live|work|am|like|love|prefer|hate)\b.*$/i, '')
    .replace(/[,;]+$/, '')
    .trim();
}

export function extractFactsFromEpisode(episode: SleepEpisode): ExtractedFact[] {
  if (episode.role !== 'user') return [];
  const text = episode.text ?? '';
  if (text.trim() === '') return [];
  const out: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const rule of EXTRACTION_RULES) {
    const match = text.match(rule.re);
    if (!match) continue;
    const key = rule.key(match);
    const value = cleanFactValue(rule.value(match));
    if (!value || value.length < 2) continue;
    const signature = `${normalizeFactText(key)}::${normalizeFactText(value)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const fact: ExtractedFact = {
      key,
      value,
      confidence: rule.confidence,
      tags: [...rule.tags],
      episodeId: episode.id,
    };
    if (rule.relationLabel && rule.relationTarget) {
      const target = cleanFactValue(rule.relationTarget(match));
      if (target !== '') {
        fact.relationLabel = rule.relationLabel;
        fact.relationTarget = target;
        fact.relationTargetType = rule.relationTargetType ?? 'concept';
      }
    }
    out.push(fact);
    if (out.length >= MAX_FACTS_PER_EPISODE) break;
  }
  return out;
}

/**
 * Extract facts from many episodes, skipping already-processed ones.
 * Returns facts + the ids that were actually examined.
 */
export function extractFactsFromEpisodes(
  episodes: SleepEpisode[],
  alreadyProcessed: Set<string>,
): { facts: ExtractedFact[]; examinedIds: string[] } {
  const facts: ExtractedFact[] = [];
  const examinedIds: string[] = [];
  for (const episode of episodes.slice(0, MAX_SLEEP_EPISODES_PER_RUN)) {
    if (alreadyProcessed.has(episode.id)) continue;
    examinedIds.push(episode.id);
    facts.push(...extractFactsFromEpisode(episode));
  }
  return { facts, examinedIds };
}

/** FNV-1a hash (deterministic, no dependency) for stable episode ids. */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Convert chat history rows into sleep episodes (chronological).
 * BotMemory.getHistory already returns rows oldest-first, so the
 * order is kept as-is (only the last `limit` rows are used).
 * Only `user`/`assistant` roles become episodes (`assistant` maps to
 * `bot`); system/tool rows are skipped (the agent must not learn
 * "facts" from tool output or system prompts). Episode ids are stable
 * across runs: the message id when present, otherwise a content hash
 * (so the next run skips already-processed turns instead of
 * re-extracting the same facts).
 */
export function episodesFromHistory(
  rows: Array<{ id?: string; role: string; content: string; createdAt?: string }>,
  limit = 20,
): SleepEpisode[] {
  const out: SleepEpisode[] = [];
  for (const row of rows.slice(-limit)) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    if (typeof row.content !== 'string' || row.content.trim() === '') continue;
    out.push({
      id: row.id ?? `history-${row.role}-${fnv1aHash(row.content)}`,
      role: row.role === 'user' ? 'user' : 'bot',
      text: row.content,
      at: row.createdAt ?? new Date().toISOString(),
    });
  }
  return out;
}

/**
 * Post-turn hook for the coordinator (called AFTER a run settles, in
 * `executeRun`'s success path — never on the turn path itself).
 *
 *  1. Bumps the step counter (cheap, synchronous).
 *  2. When the step trigger fires, starts a sleep run in the
 *     BACKGROUND (fire-and-forget: the promise is caught, the turn's
 *     result is already decided, and a slow/failed sleep run can never
 *     delay or fail the reply).
 *  3. Does nothing when the agent is disabled, the bot is mock/CLI,
 *     or a run is already in progress (the agent refuses those itself).
 *
 * This function never throws: every step is guarded so a memory
 * failure can never break a chat turn.
 */
export function scheduleSleepAfterTurn(opts: {
  agent: SleepTimeAgent;
  episodes: SleepEpisode[];
  providerId?: string;
  providerKind?: string;
  longTerm?: LongTermMemory;
  blocks?: MemoryBlockStore;
  graph?: TemporalKnowledgeGraph;
  userId?: string;
}): void {
  try {
    const { agent } = opts;
    agent.noteStepCompleted();
    if (!agent.isDueBySteps()) return;
    if (!shouldRunForBot(opts.providerId, opts.providerKind)) return;
    void agent
      .run({
        episodes: opts.episodes,
        trigger: 'steps',
        providerId: opts.providerId,
        providerKind: opts.providerKind,
        longTerm: opts.longTerm,
        blocks: opts.blocks,
        graph: opts.graph,
        userId: opts.userId,
      })
      .catch(() => {
        // Background sleep failures are silent by design (the run
        // report is persisted when the run itself succeeds; a crash
        // here must never surface as a chat error).
      });
  } catch {
    // Never let the sleep hook break a turn.
  }
}
/** Provider gate: never auto-run for `mock` or CLI-kind bots (their session state belongs to the CLI tool). */
export function shouldRunForBot(providerId: string | undefined, providerKind: string | undefined): boolean {
  if (providerId === 'mock') return false;
  if (providerKind === 'cli') return false;
  return true;
}

function emptyState(): SleepStateFile {
  return { version: 1, config: { ...DEFAULT_SLEEP_CONFIG }, stepsSinceLastRun: 0, processedEpisodeIds: [] };
}

/**
 * The sleep-time agent: owns config + step counter + last report for
 * one bot (one workspace). `run()` is async and never throws for a
 * missing store — it reports the failure in the run report instead.
 * The caller runs it in the BACKGROUND (setTimeout / idle callback),
 * never on the turn path.
 */
export class SleepTimeAgent {
  private readonly filePath: string;
  private readonly workspaceDir: string;
  private readonly botId: string;
  private state: SleepStateFile;
  private running = false;

  constructor(workspaceDir: string, botId: string) {
    this.workspaceDir = workspaceDir;
    this.botId = botId;
    this.filePath = path.join(workspaceDir, '.open-bot', sleepStateFileName(botId));
    this.state = this.load();
  }

  get path(): string {
    return this.filePath;
  }

  isRunning(): boolean {
    return this.running;
  }

  private load(): SleepStateFile {
    try {
      if (!fs.existsSync(this.filePath)) return emptyState();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as SleepStateFile;
      if (!parsed || parsed.version !== 1 || !parsed.config) return emptyState();
      return {
        ...emptyState(),
        ...parsed,
        config: { ...DEFAULT_SLEEP_CONFIG, ...parsed.config },
        processedEpisodeIds: Array.isArray(parsed.processedEpisodeIds) ? parsed.processedEpisodeIds : [],
      };
    } catch {
      return emptyState();
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Fail-open: a lost sleep report must never break the bot.
    }
  }

  getConfig(): SleepAgentConfig {
    return { ...this.state.config };
  }

  setConfig(patch: Partial<SleepAgentConfig>): SleepAgentConfig {
    this.state.config = { ...this.state.config, ...patch };
    if (this.state.config.stepsThreshold < 1) this.state.config.stepsThreshold = 1;
    if (this.state.config.stepsThreshold > 1000) this.state.config.stepsThreshold = 1000;
    this.save();
    return this.getConfig();
  }

  getLastReport(): SleepRunReport | undefined {
    return this.state.lastReport;
  }

  getStepsSinceLastRun(): number {
    return this.state.stepsSinceLastRun;
  }

  /** Called by the turn loop AFTER a turn completes (cheap counter bump, no I/O beyond save). */
  noteStepCompleted(): void {
    this.state.stepsSinceLastRun += 1;
    this.save();
  }

  /** True when the step trigger has fired (config enabled + threshold reached). */
  isDueBySteps(): boolean {
    return this.state.config.enabled && this.state.stepsSinceLastRun >= this.state.config.stepsThreshold;
  }

  /**
   * Run one sleep consolidation pass in the background.
   * Returns the report; never throws for bad input (reports it).
   * Concurrent runs are refused (returns the in-progress report note).
   */
  async run(opts: {
    episodes: SleepEpisode[];
    trigger: SleepRunReport['trigger'];
    providerId?: string;
    providerKind?: string;
    longTerm?: LongTermMemory;
    blocks?: MemoryBlockStore;
    graph?: TemporalKnowledgeGraph;
    quota?: MemoryQuota;
    userId?: string;
  }): Promise<SleepRunReport> {
    const ranAt = new Date().toISOString();
    const config = this.state.config;
    const report: SleepRunReport = {
      ranAt,
      botId: this.botId,
      trigger: opts.trigger,
      episodesExamined: 0,
      factsExtracted: 0,
      factsStored: 0,
      factsFlagged: 0,
      factsSkippedQuota: 0,
      contradictionsFound: 0,
      graphEntitiesAdded: 0,
      graphRelationsAdded: 0,
      quotaBlocked: false,
      details: [],
      processedEpisodeIds: [...this.state.processedEpisodeIds],
    };
    if (this.running) {
      report.details.push('A sleep run is already in progress; this run was skipped.');
      return report;
    }
    if (!shouldRunForBot(opts.providerId, opts.providerKind)) {
      report.details.push(
        `Sleep consolidation refused for provider '${opts.providerId ?? ''}' (mock/CLI bots do not get memory writes).`,
      );
      return report;
    }
    if (!config.enabled && opts.trigger !== 'manual') {
      report.details.push('Sleep agent is disabled; enable it to run automatically.');
      return report;
    }
    this.running = true;
    try {
      const longTerm = opts.longTerm ?? new LongTermMemory(this.workspaceDir);
      const blocks = opts.blocks ?? new MemoryBlockStore(this.workspaceDir);
      const graph = opts.graph ?? new TemporalKnowledgeGraph(this.workspaceDir);
      const quota = opts.quota ?? DEFAULT_MEMORY_QUOTA;

      const processed = new Set(this.state.processedEpisodeIds);
      const { facts, examinedIds } = extractFactsFromEpisodes(opts.episodes, processed);
      report.episodesExamined = examinedIds.length;
      report.factsExtracted = facts.length;

      // Contradictions against existing memories + within the new batch.
      const existing = longTerm.recall({ limit: 500 });
      const contradictionItems = [
        ...existing.map((e) => ({ id: e.id, key: e.key, value: e.value, recordedAt: e.updatedAt })),
        ...facts.map((f, i) => ({ id: `new-${i}`, key: f.key, value: f.value, recordedAt: ranAt })),
      ];
      const contradictions = detectContradictions(contradictionItems);
      report.contradictionsFound = contradictions.length;
      for (const c of contradictions) {
        report.details.push(`Contradiction on '${c.key}': '${c.firstValue}' vs '${c.secondValue}' (newer kept, older flagged).`);
      }

      // Store new facts (quota-checked, suspicion-flagged, never blind).
      // Suspicion is checked on the fact AND on the whole episode text:
      // an injection hidden in the same turn as a real fact must still
      // lower that fact's trust.
      const episodeTextById = new Map(opts.episodes.map((e) => [e.id, e.text ?? '']));
      const usage = {
        items: existing.length,
        chars: existing.reduce((n, e) => n + e.key.length + e.value.length, 0),
        graphEntities: graph.usage().graphEntities,
        graphRelations: graph.usage().graphRelations,
      };
      const stored: LongTermMemoryEntry[] = [];
      for (const fact of facts) {
        if (fact.confidence < config.minConfidence) continue;
        const flags = detectSuspiciousContent(`${fact.key}: ${fact.value}`);
        for (const episodeFlag of detectSuspiciousContent(episodeTextById.get(fact.episodeId) ?? '')) {
          if (!flags.some((f) => f.code === episodeFlag.code && f.detail === episodeFlag.detail)) {
            flags.push(episodeFlag);
          }
        }
        const flagged = flags.length > 0;
        if (flagged) report.factsFlagged += 1;
        const quotaCheck = checkQuota(usage, { items: 1, chars: fact.key.length + fact.value.length }, quota);
        if (!quotaCheck.allowed) {
          report.factsSkippedQuota += 1;
          report.quotaBlocked = true;
          report.details.push(`Quota blocked fact '${fact.key}' (${quotaCheck.detail}).`);
          continue;
        }
        const entry = longTerm.remember({
          key: fact.key,
          value: fact.value,
          tags: [...fact.tags, ...(flagged ? ['flagged'] : []), 'sleep-agent'],
          confidence: flagged && hasHighSeverityFlag(flags) ? Math.min(fact.confidence, 0.2) : fact.confidence,
          botId: this.botId,
          ...(opts.userId ? { userId: opts.userId } : {}),
        });
        usage.items += 1;
        usage.chars += fact.key.length + fact.value.length;
        stored.push(entry);
        report.factsStored += 1;
        if (flagged) {
          report.details.push(
            `Fact '${fact.key}' stored with low trust (flags: ${flags.map((f) => f.code).join(', ')}).`,
          );
        }
      }

      // Temporal graph: entities + relations from the same facts.
      if (config.buildGraph) {
        for (const fact of facts) {
          if (!fact.relationLabel || !fact.relationTarget) continue;
          try {
            const target = graph.addEntity({
              name: fact.relationTarget,
              type: fact.relationTargetType ?? 'concept',
              botId: this.botId,
              source: 'system',
              origin: `sleep-agent:${fact.episodeId}`,
            });
            if (target.created) report.graphEntitiesAdded += 1;
            const subject = graph.addEntity({
              name: 'user',
              type: 'person',
              botId: this.botId,
              source: 'system',
              origin: `sleep-agent:${fact.episodeId}`,
            });
            if (subject.created) report.graphEntitiesAdded += 1;
            const relation = graph.addRelation({
              fromEntityId: subject.entity.id,
              toEntityId: target.entity.id,
              label: fact.relationLabel,
              botId: this.botId,
              source: 'system',
              origin: `sleep-agent:${fact.episodeId}`,
            });
            if (relation.created) report.graphRelationsAdded += 1;
          } catch (err) {
            report.details.push(`Graph update skipped for '${fact.key}': ${(err as Error).message}`);
          }
        }
      }

      // v0.96 consolidate pass: dedupe + resolve conflicts + promote
      // important facts into the `human` memory block.
      if (config.promoteToBlocks) {
        try {
          report.consolidation = consolidate(longTerm, blocks, { actor: 'system:sleep-agent' });
        } catch (err) {
          report.details.push(`Consolidation failed: ${(err as Error).message}`);
        }
      }

      // Mark episodes processed only after a successful run.
      for (const id of examinedIds) {
        if (!this.state.processedEpisodeIds.includes(id)) this.state.processedEpisodeIds.push(id);
      }
      this.state.processedEpisodeIds = this.state.processedEpisodeIds.slice(-500);
      this.state.stepsSinceLastRun = 0;
      this.state.lastRunAt = ranAt;
      this.state.lastReport = report;
      report.processedEpisodeIds = [...this.state.processedEpisodeIds];
      this.save();
      return report;
    } finally {
      this.running = false;
    }
  }
}
