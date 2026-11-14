/**
 * Deep Dream — nightly distillation of short-term memory into
 * long-term memory (v1.02 rescue port of the v1.00 work).
 *
 * Idea learned from systems with a sleep/distill loop (distill
 * short-term memory into long-term memory while idle, then write a
 * journal) — redesigned from scratch for open-bot, 100% local, and
 * NOT calling the default model: every extraction decision is a
 * deterministic rule on text (like consolidate.ts), so results are
 * verifiable and never invent new facts. The host may plug in an
 * optional `summarizer` (a cheap local model) for nicer summaries —
 * but that is optional, never required.
 *
 * One dream run does 4 things, in order:
 *  1. Collect daily notes — short notes from the day (written by the
 *     agent or the user via `DailyNoteStore.addNote`, or pushed in by
 *     the host through `runOnce`'s `notes`). Each note has a date +
 *     source.
 *  2. Extract durable facts — lines showing a preference / stable
 *     truth (e.g. "likes ...", "never ...", "always ...") become
 *     candidate facts; a fact already in long-term memory (same
 *     normalized key) is skipped, a new one is saved with
 *     `LongTermMemory.remember` tagged `dream` and a confidence from
 *     the extraction rule.
 *  3. Promote to the `human` block — a high-confidence fact (default
 *     >= 0.8) is appended to the `human` block as a bullet (like
 *     consolidation), skipping lines already present.
 *  4. Write the journal + clean up — one journal entry (date, event
 *     summary, facts extracted/promoted, notes cleaned) is appended
 *     to `.open-bot/dream-journal.jsonl`; daily notes older than
 *     `retentionDays` are deleted from the store (pruned, counted
 *     in the report).
 *
 * Runs in 3 ways:
 *  - By hand: tool `dream_run` (calls `DeepDreamEngine.runOnce`).
 *  - On a schedule: `DeepDreamScheduler.tick(now)` — runs at the
 *    configured hour of the day (default 02:00 local) when it has
 *    not run that day yet; skips when chat is active (the host
 *    passes `isChatActive`), never runs twice at once.
 *  - The host calls `runOnce` from its own automation/cron.
 *
 * Storage (local-first, JSON, atomic writes like LongTermMemory):
 *  - `.open-bot/deep-dream-config.json` — config + lastRunAt.
 *  - `.open-bot/daily-notes.json`       — daily notes (short-term).
 *  - `.open-bot/dream-journal.jsonl`    — append-only journal.
 *  - `.open-bot/dream-runs.json`        — log of recent runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { LongTermMemory } from './longterm';
import { MemoryBlockStore } from './blocks';
import { normalizeFactText } from './consolidate';

export const DEEP_DREAM_CONFIG_REL_PATH = path.join('.open-bot', 'deep-dream-config.json');
export const DAILY_NOTES_REL_PATH = path.join('.open-bot', 'daily-notes.json');
export const DREAM_JOURNAL_REL_PATH = path.join('.open-bot', 'dream-journal.jsonl');
export const DREAM_RUNS_REL_PATH = path.join('.open-bot', 'dream-runs.json');
/** Default hour of the day to run a dream (local time). */
export const DEFAULT_DREAM_HOUR = 2;
/** Days to keep daily notes before pruning (default 30). */
export const DEFAULT_DREAM_RETENTION_DAYS = 30;
/** Max facts extracted in one run (default 20). */
export const DEFAULT_DREAM_MAX_FACTS_PER_RUN = 20;
/** Minimum confidence to promote a fact to the human block. */
export const DEFAULT_DREAM_PROMOTE_MIN_CONFIDENCE = 0.8;
/** Confidence for a fact from a strong rule (e.g. "always", "never"). */
export const DREAM_STRONG_FACT_CONFIDENCE = 0.9;
/** Confidence for a fact from a weak rule (e.g. "likes", "usually"). */
export const DREAM_WEAK_FACT_CONFIDENCE = 0.7;
/** How many recent runs to keep in the log. */
export const DREAM_MAX_RUN_LOG = 30;

export interface DailyNote {
  id: string;
  date: string;
  text: string;
  source: string;
  createdAt: string;
}

export interface DreamFact {
  key: string;
  value: string;
  confidence: number;
  sourceNoteId: string;
}

export interface DreamRunReport {
  id: string;
  at: string;
  notesSeen: number;
  factsExtracted: number;
  factsPromoted: number;
  notesPruned: number;
  summary: string;
  facts: DreamFact[];
}

export interface DeepDreamConfig {
  enabled: boolean;
  hour?: number;
  retentionDays?: number;
  maxFactsPerRun?: number;
  promoteMinConfidence?: number;
  lastRunAt?: string;
}

/** Strong rules: stable truths (high confidence). */
const STRONG_FACT_PATTERNS: RegExp[] = [
  /\b(always|never|must|must not|không bao giờ|luôn)\b/i,
];
/** Weak rules: preferences / habits (lower confidence). */
const WEAK_FACT_PATTERNS: RegExp[] = [
  /\b(likes?|loves?|prefers?|usually|often|thích|thường|hay)\b/i,
];

/** Extract candidate facts from one note (deterministic rules only). */
export function extractFactsFromNote(note: DailyNote): DreamFact[] {
  const facts: DreamFact[] = [];
  for (const line of note.text.split('\n')) {
    const trimmed = line.trim().replace(/^[-*•]\s*/, '');
    if (trimmed.length < 8 || trimmed.length > 500) continue;
    const strong = STRONG_FACT_PATTERNS.some((pattern) => pattern.test(trimmed));
    const weak = !strong && WEAK_FACT_PATTERNS.some((pattern) => pattern.test(trimmed));
    if (!strong && !weak) continue;
    facts.push({
      key: normalizeFactText(trimmed).slice(0, 120) || 'fact',
      value: trimmed,
      confidence: strong ? DREAM_STRONG_FACT_CONFIDENCE : DREAM_WEAK_FACT_CONFIDENCE,
      sourceNoteId: note.id,
    });
  }
  return facts;
}

/** Short-term store of daily notes (JSON file, atomic writes). */
export class DailyNoteStore {
  private readonly filePath: string;
  private notes: DailyNote[] = [];

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, DAILY_NOTES_REL_PATH);
    this.load();
  }

  addNote(text: string, source: string, date = new Date().toISOString().slice(0, 10)): DailyNote {
    const note: DailyNote = { id: randomUUID(), date, text, source, createdAt: new Date().toISOString() };
    this.notes.push(note);
    this.persist();
    return note;
  }

  list(): DailyNote[] {
    return [...this.notes];
  }

  /** Delete notes older than `retentionDays` (returns the count removed). */
  prune(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const before = this.notes.length;
    this.notes = this.notes.filter((note) => note.date >= cutoff);
    if (this.notes.length !== before) this.persist();
    return before - this.notes.length;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.notes = parsed.filter(
          (entry): entry is DailyNote =>
            typeof entry === 'object' && entry !== null && typeof (entry as DailyNote).text === 'string',
        );
      }
    } catch {
      this.notes = [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.notes, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Notes are best-effort; a failed write must not break the run.
    }
  }
}

export interface DeepDreamEngineOptions {
  workspaceDir: string;
  memory: LongTermMemory;
  blocks?: MemoryBlockStore;
  config?: DeepDreamConfig;
  /** Optional summarizer (a cheap local model) for nicer summaries. */
  summarizer?: (notes: DailyNote[], facts: DreamFact[]) => Promise<string> | string;
}

/** Nightly distillation: notes -> durable facts -> human block -> journal. */
export class DeepDreamEngine {
  private readonly workspaceDir: string;
  private readonly memory: LongTermMemory;
  private readonly blocks: MemoryBlockStore;
  private readonly config: DeepDreamConfig;
  private readonly summarizer?: DeepDreamEngineOptions['summarizer'];
  private readonly noteStore: DailyNoteStore;
  private running = false;

  constructor(options: DeepDreamEngineOptions) {
    this.workspaceDir = options.workspaceDir;
    this.memory = options.memory;
    this.blocks = options.blocks ?? new MemoryBlockStore(options.workspaceDir);
    this.config = {
      enabled: true,
      hour: DEFAULT_DREAM_HOUR,
      retentionDays: DEFAULT_DREAM_RETENTION_DAYS,
      maxFactsPerRun: DEFAULT_DREAM_MAX_FACTS_PER_RUN,
      promoteMinConfidence: DEFAULT_DREAM_PROMOTE_MIN_CONFIDENCE,
      ...(options.config ?? {}),
    };
    this.summarizer = options.summarizer;
    this.noteStore = new DailyNoteStore(options.workspaceDir);
    this.loadConfig();
  }

  get notes(): DailyNoteStore {
    return this.noteStore;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** ISO timestamp of the last completed run (undefined when never run). */
  get lastRunAt(): string | undefined {
    return this.config.lastRunAt;
  }

  /** Run one dream pass (never runs twice at once). */
  async runOnce(extraNotes: DailyNote[] = []): Promise<DreamRunReport> {
    if (this.running) throw new Error('a dream run is already in progress');
    this.running = true;
    try {
      const notes = [...this.noteStore.list(), ...extraNotes];
      const maxFacts = this.config.maxFactsPerRun ?? DEFAULT_DREAM_MAX_FACTS_PER_RUN;
      const promoteMin = this.config.promoteMinConfidence ?? DEFAULT_DREAM_PROMOTE_MIN_CONFIDENCE;
      const existingKeys = new Set(
        this.memory.list().map((entry) => normalizeFactText(entry.key)),
      );
      const facts: DreamFact[] = [];
      for (const note of notes) {
        for (const fact of extractFactsFromNote(note)) {
          if (facts.length >= maxFacts) break;
          if (existingKeys.has(normalizeFactText(fact.key))) continue;
          if (facts.some((f) => normalizeFactText(f.key) === normalizeFactText(fact.key))) continue;
          facts.push(fact);
          existingKeys.add(normalizeFactText(fact.key));
        }
        if (facts.length >= maxFacts) break;
      }
      let promoted = 0;
      for (const fact of facts) {
        this.memory.remember({
          key: fact.key,
          value: fact.value,
          tags: ['dream'],
          confidence: fact.confidence,
        });
        if (fact.confidence >= promoteMin) {
          try {
            const block = this.blocks.ensureBlock('human', { description: 'Stable facts about the user.' }, 'dream');
            if (!block.content.includes(fact.value)) {
              this.blocks.append('human', `- ${fact.value}`, 'dream');
              promoted++;
            }
          } catch {
            // A full or read-only block must not fail the dream run.
          }
        }
      }
      const summary = this.summarizer
        ? String(await this.summarizer(notes, facts))
        : `${notes.length} note(s), ${facts.length} fact(s) extracted, ${promoted} promoted to the human block.`;
      const pruned = this.noteStore.prune(this.config.retentionDays ?? DEFAULT_DREAM_RETENTION_DAYS);
      const report: DreamRunReport = {
        id: randomUUID(),
        at: new Date().toISOString(),
        notesSeen: notes.length,
        factsExtracted: facts.length,
        factsPromoted: promoted,
        notesPruned: pruned,
        summary,
        facts,
      };
      this.appendJournal(report);
      this.appendRunLog(report);
      this.config.lastRunAt = report.at;
      this.persistConfig();
      return report;
    } finally {
      this.running = false;
    }
  }

  private appendJournal(report: DreamRunReport): void {
    try {
      const filePath = path.join(this.workspaceDir, DREAM_JOURNAL_REL_PATH);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(
        filePath,
        `${JSON.stringify({ date: report.at.slice(0, 10), summary: report.summary, facts: report.facts.map((f) => f.value), notesPruned: report.notesPruned })}\n`,
        'utf8',
      );
    } catch {
      // Journal is best-effort.
    }
  }

  private appendRunLog(report: DreamRunReport): void {
    try {
      const filePath = path.join(this.workspaceDir, DREAM_RUNS_REL_PATH);
      let runs: DreamRunReport[] = [];
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed)) runs = parsed as DreamRunReport[];
      } catch {
        runs = [];
      }
      runs.push(report);
      runs = runs.slice(-DREAM_MAX_RUN_LOG);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(runs, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch {
      // Run log is best-effort.
    }
  }

  private loadConfig(): void {
    try {
      const raw = fs.readFileSync(path.join(this.workspaceDir, DEEP_DREAM_CONFIG_REL_PATH), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        Object.assign(this.config, parsed as DeepDreamConfig);
      }
    } catch {
      // Missing or corrupt: keep the defaults.
    }
  }

  private persistConfig(): void {
    try {
      const filePath = path.join(this.workspaceDir, DEEP_DREAM_CONFIG_REL_PATH);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch {
      // Config is best-effort.
    }
  }
}

/** Runs the dream engine once a day at the configured hour (local time). */
export class DeepDreamScheduler {
  private readonly engine: DeepDreamEngine;
  private readonly hour: number;
  private readonly isChatActive: () => boolean;

  constructor(engine: DeepDreamEngine, options: { hour?: number; isChatActive?: () => boolean } = {}) {
    this.engine = engine;
    this.hour = options.hour ?? DEFAULT_DREAM_HOUR;
    this.isChatActive = options.isChatActive ?? (() => false);
  }

  /** Check whether a dream run is due; run it when it is. Returns the report or null. */
  async tick(now = new Date()): Promise<DreamRunReport | null> {
    if (now.getHours() !== this.hour) return null;
    if (this.isChatActive()) return null;
    if (this.engine.isRunning) return null;
    // Local date (same clock as the hour check above).
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const lastRun = this.engine.lastRunAt ? new Date(this.engine.lastRunAt) : undefined;
    if (lastRun) {
      const lastDay = `${lastRun.getFullYear()}-${String(lastRun.getMonth() + 1).padStart(2, '0')}-${String(lastRun.getDate()).padStart(2, '0')}`;
      if (lastDay === today) return null;
    }
    return this.engine.runOnce();
  }
}
