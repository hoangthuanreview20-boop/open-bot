/**
 * SkillRegistry (v0.11a: Agent Skills standard + progressive disclosure).
 *
 * Owns the loaded skills: built-ins + user directory + plugin directories.
 * Responsibilities:
 * - `load()` — (re)read every skill directory, TIER 1 ONLY: frontmatter
 *   (`name` + `description` + flags) is parsed, the body is NOT retained
 *   (`bodyLoaded === false`). A later source OVERRIDES an earlier one
 *   with the same name (built-in < user < plugin), so a user skill can
 *   replace a built-in.
 * - `enable(name)` / `disable(name)` — persisted in `<stateDir>/skills-enabled.json`
 *   (a plain JSON map name -> boolean; missing entry means enabled).
 *   A disabled skill is never matched and never injected.
 * - `skillIndex()` / `formatSkillIndex()` — TIER 1 for the startup
 *   prompt: one `name — description` line per enabled skill (~100
 *   tokens/skill), instead of full bodies. This is what the agent
 *   sees before any task arrives.
 * - `matchSkills(task, limit)` — score enabled skills against a task
 *   description by keyword overlap on name + description + when-to-use.
 *   Keyword scoring only; the model still decides what to do with the
 *   injected guidance. Skills with `disable-model-invocation: true`
 *   are NEVER matched (only the user may invoke them, via
 *   `invokeSkillByName`). Matching reads metadata only — bodies stay
 *   unloaded.
 * - `applySkills(systemPrompt, skills)` — TIER 2: loads the body of each
 *   given skill (only now) and returns the system prompt with a
 *   `<skills>` section appended. A skill whose body cannot be loaded
 *   is skipped instead of breaking the run.
 * - `applySkillsForTask(systemPrompt, task, limit)` — match + apply
 *   (kept signature: the coordinator calls this per turn).
 * - Tier 3 — `listSkillResources(name)` / `readSkillResource(name, rel)`
 *   / `skillScriptPath(name, script)`: a skill's `scripts/` /
 *   `references/` / `assets/` are only listed at load time; contents
 *   are read (or a script path handed out for execution) on demand.
 * - `context: fork` — recorded on the skill (`skill.context === 'fork'`,
 *   see `skillRunsInSubagent`). The registry does NOT spawn the
 *   subagent itself: running a fork skill in its own subagent is the
 *   loop/coordinator's job (out of this module's scope).
 *
 * Built-in skills are written by hand for open-bot (original text, not
 * copied from any other product). They are Markdown strings parsed by the
 * same loader as files on disk, so they go through the same validation —
 * but only their frontmatter is parsed at `load()`; the body is
 * extracted lazily from the stored raw text on first use.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  extractSkillBody,
  loadSkillsFromDir,
  looksLikeSecret,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_TEXT_CHARS,
  parseSkillMarkdown,
  parseSkillMetadata,
  pluginSkillDirs,
  readSkillResource,
  resolveSkillResourcePath,
  SKILL_FILE_NAME,
  SKILL_NAME_RE,
} from './loader';
import type { Skill, SkillIndexEntry, SkillResources } from './types';
import { SkillLoadError } from './types';

export const SKILLS_ENABLED_FILE = 'skills-enabled.json';

/** Rough token estimate used across open-bot: 1 token ≈ 4 chars (cf. v0.10 toolFilter). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate one skill body when injected into a system prompt. */
export function truncateSkillBody(body: string, maxChars: number = MAX_SKILL_BODY_CHARS): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + `\n[... skill body truncated to ${maxChars} chars ...]`;
}

/** True when the skill must run in a separate subagent (`context: fork`). */
export function skillRunsInSubagent(skill: Skill): boolean {
  return skill.context === 'fork';
}

export interface ApplySkillsOptions {
  /**
   * v0.33 (P0-1 fork-execution): when true, skills with
   * `context: fork` are SKIPPED — their bodies are never inlined into
   * the parent prompt; the coordinator hands them to the loop as
   * `forkSkills` so they run in their own subagents instead.
   */
  excludeFork?: boolean;
  /**
   * v0.64 (skills per-bot): skill names to skip for THIS bot/run
   * (the bot's `denySkills` — see agent/permissions.ts). The shared
   * registry is never mutated: the exclusion applies only to this
   * call, so other bots still see these skills. A denied skill is
   * never matched, indexed or injected for the bot.
   */
  exclude?: Iterable<string>;
}

/** Names in `exclude` as a Set (empty when unset) — v0.64 per-bot deny. */
function excludeSet(exclude?: Iterable<string>): Set<string> {
  return new Set(exclude ?? []);
}

/**
 * Append the given skills to a system prompt. Returns a new string,
 * never mutates. Disabled skills should be filtered out by the caller
 * (matchSkills already does); passing an empty list returns the prompt
 * unchanged.
 *
 * Tier 2: a skill whose body is not loaded yet is loaded here (from
 * its file, or from the built-in raw text held by the registry via
 * `ensureSkillBody`). A skill whose body cannot be loaded is skipped
 * — a missing skill file must not break the run.
 */
export function applySkills(systemPrompt: string, skills: Skill[], opts: ApplySkillsOptions = {}): string {
  // v0.64: per-bot deny — excluded skills never inject, even when the
  // caller passed them in already-matched (defence in depth: the
  // coordinator filters matches first, this is the second gate).
  const excluded = excludeSet(opts.exclude);
  const enabled = skills.filter((s) => s.enabled && !excluded.has(s.name));
  if (enabled.length === 0) return systemPrompt;
  const sections: string[] = [];
  for (const skill of enabled) {
    // v0.33: fork skills run in a subagent — never inline their body.
    if (opts.excludeFork && skillRunsInSubagent(skill)) continue;
    let body: string;
    try {
      body = ensureSkillBody(skill).body;
    } catch {
      continue; // Body unloadable (file gone, secret in body): skip it.
    }
    if (body.length === 0) continue;
    const header = `### Skill: ${skill.name} (v${skill.version}) — ${skill.description}`;
    const tools =
      skill.allowedTools.length > 0
        ? `\nTools this skill may use: ${skill.allowedTools.join(', ')}.`
        : '';
    const fork = skillRunsInSubagent(skill)
      ? `\nNote: this skill runs in a separate subagent (context: fork) — work with its summary, not its raw context.`
      : '';
    sections.push(`${header}${tools}${fork}\n${truncateSkillBody(body)}`);
  }
  if (sections.length === 0) return systemPrompt;
  return (
    `${systemPrompt}\n\n## Skills đang bật\n` +
    `Các kỹ năng dưới đây là hướng dẫn bổ sung cho nhiệm vụ này. ` +
    `Làm theo chúng khi phù hợp; nếu một skill mâu thuẫn với yêu cầu trực tiếp của người dùng, yêu cầu của người dùng thắng.\n\n` +
    sections.join('\n\n')
  );
}

/**
 * Tier 2 — load a skill's body in place (mutates the registry-owned
 * skill object and returns it). No-op when the body is already loaded.
 * Built-ins are extracted from the raw text the registry keeps;
 * disk skills are re-read from their file (frontmatter is re-validated
 * and the body is secret-scanned — a body edited after startup to
 * contain a credential is rejected here, not injected).
 * Throws SkillLoadError when there is no source to load the body from.
 */
export function ensureSkillBody(skill: Skill): Skill {
  if (skill.bodyLoaded) return skill;
  const raw = BUILTIN_SKILL_TEXT.get(skill.name);
  if (skill.source === 'builtin' && raw !== undefined) {
    if (looksLikeSecret(raw)) {
      throw new SkillLoadError(
        'Skill contains text that looks like a secret (API key / token / password). ' +
          'Skills must never contain credentials — remove it and try again.',
        skill.filePath,
      );
    }
    const body = extractSkillBody(raw, skill.filePath);
    if (body.length === 0) {
      throw new SkillLoadError(`Skill "${skill.name}" has an empty instruction body.`, skill.filePath);
    }
    skill.body = body;
    skill.bodyLoaded = true;
    return skill;
  }
  if (!skill.filePath) {
    throw new SkillLoadError(
      `Skill "${skill.name}" has no body loaded and no file to load it from.`,
      skill.filePath,
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(skill.filePath, 'utf8');
  } catch {
    throw new SkillLoadError(`Cannot read skill file "${skill.filePath}".`, skill.filePath);
  }
  const full = parseSkillMarkdown(text, skill.source, skill.filePath, skill.pluginId, skill.skillDir);
  skill.body = full.body;
  skill.bodyLoaded = true;
  return skill;
}

// ---------------------------------------------------------------------------
// Built-in skills (original text, written for open-bot)
// ---------------------------------------------------------------------------

export const BUILTIN_SKILL_CODE_REVIEW = `---
name: code-review
description: Review code changes for bugs, security issues and style.
version: 1.0.0
license: MIT
when-to-use: when the user asks to review code, a diff, a pull request, or check code quality
allowed-tools: [read_file, grep_search, git_diff]
---
# Code review

You are reviewing code, not rewriting it from scratch.

1. Read the changed files (or the diff) first. Do not guess what the code does — check the actual code and its callers.
2. Report findings in order of severity: correctness bugs first, then security issues, then maintainability, then style.
3. For each finding, give: the file and location, what is wrong, why it matters, and a concrete suggested fix. Skip findings you cannot back up with a quote from the code.
4. Security checklist: user input reaching shell/SQL/file paths without validation, secrets or tokens in code or logs, unsafe deserialization, missing permission checks.
5. End with a short verdict: approve, approve with minor fixes, or needs changes — plus the 1–3 most important fixes if any.
6. Keep the review in the user's language. Do not invent issues in code you did not read.
`;

export const BUILTIN_SKILL_RESEARCH_BRIEF = `---
name: research-brief
description: Research a topic and write a short sourced brief.
version: 1.0.0
license: MIT
when-to-use: when the user asks to research, compare, investigate or summarise a topic
allowed-tools: [web_search, web_fetch]
---
# Research brief

You are researching a topic and writing a brief the user can trust.

1. Start from the user's exact question. Write it down, then list the 3–5 sub-questions that decide the answer.
2. Search the web for each sub-question. Prefer primary sources (official docs, announcements, data pages) over second-hand summaries. Note the date of each source.
3. Distinguish facts from opinions and from your own prior knowledge. Anything you did not verify in a source must be labelled "chưa kiểm chứng" (unverified).
4. Structure the brief: TL;DR (3 lines max), Findings (one section per sub-question, each with its sources), What is still uncertain, Sources (full URLs).
5. If sources disagree, say so and show both sides instead of picking one silently.
6. Answer in the user's language. Keep it tight: a brief, not an essay.
`;

export const BUILTIN_SKILL_WRITING_VI = `---
name: writing-vi
description: Write and edit Vietnamese text that reads naturally.
version: 1.0.0
license: MIT
when-to-use: when the user asks to write, draft, rewrite or polish Vietnamese text — viết, viết lại, soạn thảo tiếng Việt, chỉnh sửa văn bản
allowed-tools: [read_file, write_file]
---
# Writing in Vietnamese

You are writing Vietnamese for a Vietnamese reader. Sound like a person, not a translation engine.

1. Write in Vietnamese unless the user asked for another language. Use natural Vietnamese word order and connectors (vậy nên, tuy nhiên, nói cách khác); avoid word-for-word English calques.
2. Tone: clear and direct by default. Match the register the user used — formal for work documents, friendly for social posts — and say which one you picked.
3. Structure: one idea per paragraph, short sentences, headings for anything longer than a screen. Lead with the point, then the detail.
4. Numbers, dates and names: keep the user's original numbers and proper names exactly; write dates in Vietnamese format (ngày/tháng/năm) unless told otherwise.
5. When editing the user's draft, keep their voice and their facts. Mark every change you made beyond spelling/grammar, and never invent quotes, figures or claims.
6. End with a one-line note on what you changed and why, so the user can review fast.
`;

export const BUILTIN_SKILL_GIT_WORKFLOW = `---
name: git-workflow
description: Work with git safely — commit, branch, review history and prepare pull requests.
version: 1.0.0
license: MIT
when-to-use: when the user works with git — committing, branching, reviewing history, or preparing a pull request
allowed-tools: [read_file, git_status, git_diff, git_commit, grep_search]
---
# Git workflow

You are helping the user work with git safely and clearly. Git history is hard to undo, so check before you act.

1. Before any commit, check git status and git diff first so you know exactly what is changing. Never commit blind, and never commit files you have not looked at.
2. Write clear commit messages: one short summary line (under 72 characters when possible), then a blank line and a short explanation only when the change needs one. Say what changed and why, not how.
3. Keep branches short and named after the feature or fix, for example feature/add-login or fix/crash-on-start. One branch, one purpose; do not mix unrelated changes on one branch.
4. Never commit files that contain secrets, credentials, tokens, or private local configuration. If a diff contains anything like that, stop and tell the user before doing anything else.
5. Never push, merge, or force-push unless the user explicitly asked for it. Pushing publishes work to others, so it is always the user's decision.
6. When reviewing history, summarise what changed and why in the user's language, and point at the commits that matter instead of pasting the whole log.
`;

export const BUILTIN_SKILL_TEST_WRITING = `---
name: test-writing
description: Write tests for new or changed code — happy path, edge cases and errors.
version: 1.0.0
license: MIT
when-to-use: when the user needs tests written for new or changed code
allowed-tools: [read_file, write_file, grep_search, shell_exec]
---
# Test writing

You are writing tests that catch real bugs and keep catching them later.

1. Read the code under test first. A test written without reading the code usually tests the wrong thing — check the actual behaviour, its inputs and its edge cases.
2. Write the test before the code, or immediately after it. A feature without a test is unfinished; do not call the work done until its tests exist.
3. Cover three cases for every behaviour that matters: the happy path, at least one edge case (empty input, boundary value, missing field), and at least one error case (invalid input, failure of a dependency).
4. Keep tests independent: each test sets up its own data and does not depend on another test running first. A test that only passes in a certain order is a broken test.
5. Name tests clearly so a failure tells the reader what broke, for example "rejects an empty email" instead of "test 3".
6. Run the related tests after writing them. Report how many passed and failed, and fix the failures instead of deleting the tests that fail.
`;

export const BUILTIN_SKILL_DATA_CLEANING = `---
name: data-cleaning
description: Clean CSV or JSON data files before analysis — fix formats, remove duplicates, report problems.
version: 1.0.0
license: MIT
when-to-use: when the user needs a CSV or JSON data file cleaned before analysis
allowed-tools: [read_file, write_file, list_files, glob_files, shell_exec]
---
# Data cleaning

You are cleaning a data file so it can be analysed safely. The original data is the truth — your job is to make it consistent, not to improve it silently.

1. Inspect the file first: format, header row, column names, row count, and any broken lines. Never clean blind, and never guess the format from the file name alone.
2. Normalise dates, numbers and column names to one consistent format per column (for example one date format, one decimal separator, lowercase column names with underscores). Record which format you chose.
3. Remove exact duplicate rows, and log how many rows were removed and why. When two rows conflict instead of matching exactly, keep both and flag them — do not pick a winner silently.
4. Never invent replacement values for missing or broken data. Leave the value empty and flag the row, or ask the user what to do. A made-up number is worse than a missing one.
5. Write the cleaned result to a NEW file and keep the original untouched, unless the user explicitly asked to overwrite it.
6. Report the result every time: rows read, rows kept, rows removed, rows with errors (with their line numbers), and every normalisation you applied.
`;

export const BUILTIN_SKILL_MEETING_NOTES = `---
name: meeting-notes
description: Take meeting notes and summarise discussions — decisions, action items and open questions.
version: 1.0.0
license: MIT
when-to-use: when the user needs notes taken for a meeting or a summary of a discussion
allowed-tools: [read_file, write_file, list_files]
---
# Meeting notes

You are turning a meeting or discussion into notes the user can act on later, without having been there.

1. Structure every note the same way: Decisions, Action items, Open questions. Nothing else goes in the main body — background and context go in a short "Context" section at the top.
2. Every action item needs three things: what must be done, who is responsible, and by when. An action item missing any of the three is not finished — mark what is missing.
3. Keep the user's numbers, names and dates exactly as stated. Never round a figure, shorten a name, or move a deadline.
4. Separate what was DECIDED from what was merely PROPOSED. A suggestion is not a decision until the group agrees it — if it is unclear whether something was decided, say so and put it under Open questions.
5. If something is unclear or you could not hear it, mark it as unclear instead of guessing. A gap labelled "unclear" is useful; a confident guess is misleading.
6. Keep it short. Notes are for scanning later, not for re-reading the whole meeting — one line per decision, one line per action item.
`;

export const BUILTIN_SKILL_TRANSLATION = `---
name: translation
description: Translate text into another language, keeping meaning, tone, terms and formatting.
version: 1.0.0
license: MIT
when-to-use: when the user needs text translated into another language
allowed-tools: [read_file, write_file]
---
# Translation

You are translating text so it reads naturally in the target language while saying exactly what the original said.

1. Keep the meaning, tone and terminology of the original. A formal document stays formal, a friendly message stays friendly, and a technical term stays the same term throughout.
2. Keep proper names, numbers, dates, units, links and formatting exactly as they are. Do not convert a number, reformat a date, or localise a name unless the user asked for it.
3. When the source sentence is ambiguous, ask the user instead of guessing. A wrong guess in a translation looks like a fact the original never stated.
4. Do not add ideas, examples or explanations that were not in the original. If something needs explaining for the target reader, add it as a clearly marked translator's note, not as part of the text.
5. If a term has no good equivalent in the target language, keep the original term and add a short note explaining it, rather than forcing an awkward translation.
6. Read the result back once before delivering it: it must sound like it was written in the target language, not like a word-for-word copy of the original.
`;

export const BUILTIN_SKILL_COMMIT_MESSAGE = `---
name: commit-message
description: Write clear git commit messages from a diff — what changed, why, and what to watch out for.
version: 1.0.0
license: MIT
when-to-use: when the user asks for a commit message, or before committing changes
allowed-tools: [git_diff, git_log, read_file]
---
# Commit message

You are writing a commit message for changes the user is about to commit. The message is the only record of why the change exists — write it for the person reading the history later.

1. Read the diff first (and the recent log for context). Do not guess what changed — describe what the diff actually does.
2. Use the imperative mood in the subject line ("Fix login retry", not "Fixed login retry" or "Fixes login retry"). Keep the subject under 72 characters.
3. The subject says WHAT changed. The body says WHY it changed and what the trade-off was, when that is not obvious from the subject alone. Leave the body out when the subject already says everything.
4. One logical change per commit. When the diff mixes unrelated changes, say so and propose splitting them instead of writing one message that covers everything.
5. Never include secrets, tokens, credentials, or internal URLs in a message. If the diff touches sensitive code, describe the change without quoting the sensitive values.
6. Keep the message in the user's language, and match the repository's existing message style when one is visible in the log.
`;

export const BUILTIN_SKILL_RELEASE_NOTES = `---
name: release-notes
description: Draft release notes from commits and changes — what is new, what changed, what was fixed.
version: 1.0.0
license: MIT
when-to-use: when the user asks for release notes, a changelog entry, or a summary of a new version
allowed-tools: [git_log, git_diff, read_file]
---
# Release notes

You are drafting release notes for a new version. The reader wants to know what changed for them — not how the code was rearranged inside.

1. Read the commits since the last release (or the diff the user points at). Group the changes into: Added, Changed, Fixed. Leave out internal refactors that change nothing the user can see, unless they affect performance.
2. Write for the user of the software, not for the author of the code: lead with what is new or fixed, in plain words, with the user-visible effect first.
3. Keep every entry to one line when possible. A version with fifty one-line entries is easier to scan than five long paragraphs.
4. Breaking changes go first, under their own heading, with what the user must do differently. Never bury a breaking change in the middle of a list.
5. Keep version numbers, dates and names exactly as they are. Do not invent a version number the user did not give you.
6. End with a short "Upgrade notes" section only when upgrading needs a manual step. When there is none, leave it out — do not write "no action needed".
`;

export const BUILTIN_SKILL_SUMMARIZE_FILE = `---
name: summarize-file
description: Summarise a file or document faithfully — what it says, what matters, and what is missing.
version: 1.0.0
license: MIT
when-to-use: when the user asks for a summary of a file, document, or long text
allowed-tools: [read_file, list_files]
---
# Summarise file

You are summarising a file the user gives you. The summary must let them decide whether to read the whole file — without ever misleading them about what it says.

1. Read the whole file before writing anything. Never summarise from the first page alone.
2. Lead with the one-sentence answer to "what is this file about", then the points that matter, in the order they appear in the file.
3. Keep numbers, names, dates and quoted claims exactly as written. A summary that rounds a number or paraphrases a quote into a different claim is wrong.
4. Mark what you could not verify. When the file references something it does not explain, say so instead of filling the gap from your own knowledge.
5. End with "Not covered" when the file leaves an obvious question unanswered — that gap is part of the summary, not a failure to summarise.
6. Keep it short: a summary longer than a third of the original is not a summary. When the user wants detail, they will ask for the full text.
`;

export const BUILTIN_SKILLS: string[] = [
  BUILTIN_SKILL_CODE_REVIEW,
  BUILTIN_SKILL_RESEARCH_BRIEF,
  BUILTIN_SKILL_WRITING_VI,
  BUILTIN_SKILL_GIT_WORKFLOW,
  BUILTIN_SKILL_TEST_WRITING,
  BUILTIN_SKILL_DATA_CLEANING,
  BUILTIN_SKILL_MEETING_NOTES,
  BUILTIN_SKILL_TRANSLATION,
  BUILTIN_SKILL_SUMMARIZE_FILE,
  BUILTIN_SKILL_RELEASE_NOTES,
  BUILTIN_SKILL_COMMIT_MESSAGE,
];

/** Raw built-in texts by skill name — the tier-2 body source for built-ins. */
const BUILTIN_SKILL_TEXT = new Map<string, string>();

/** Names of the built-in skills (v0.66b: install must never overwrite one). */
let BUILTIN_NAME_CACHE: Set<string> | null = null;
export function builtinSkillNames(): Set<string> {
  if (!BUILTIN_NAME_CACHE) {
    BUILTIN_NAME_CACHE = new Set<string>();
    for (const text of BUILTIN_SKILLS) {
      try {
        BUILTIN_NAME_CACHE.add(parseSkillMetadata(text, 'builtin').name);
      } catch {
        // Built-ins are hand-written and valid; a bad one is caught by load().
      }
    }
  }
  return BUILTIN_NAME_CACHE;
}

export interface SkillRegistryOptions {
  /** Directory with user skills (loose `*.md` and/or skill dirs). Optional. */
  userSkillsDir?: string;
  /** Directory holding one subdir per installed plugin. Optional. */
  pluginsDir?: string;
  /** Directory where `skills-enabled.json` is stored. Defaults to userSkillsDir's parent, else CWD. */
  stateDir?: string;
}

export interface SkillMatch {
  skill: Skill;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]+/u)
    .filter((t) => t.length > 1);
}

/** Score one skill against a task: name hits weigh most, then when-to-use, then description. */
export function scoreSkill(skill: Skill, task: string): number {
  const words = new Set(tokenize(task));
  if (words.size === 0) return 0;
  let score = 0;
  const nameTokens = tokenize(skill.name.replace(/[-_]/g, ' '));
  for (const t of nameTokens) if (words.has(t)) score += 10;
  for (const t of tokenize(skill.whenToUse)) if (words.has(t)) score += 3;
  for (const t of tokenize(skill.description)) if (words.has(t)) score += 2;
  // Tool-name mentions (e.g. task says "review the diff") add a little.
  for (const tool of skill.allowedTools) {
    for (const t of tokenize(tool.replace(/_/g, ' '))) if (words.has(t)) score += 1;
  }
  return score;
}

export class SkillRegistry {
  private readonly opts: SkillRegistryOptions;
  private readonly byName = new Map<string, Skill>();
  private readonly disabled = new Set<string>();
  private loadErrors: Array<{ file: string; error: string }> = [];

  constructor(opts: SkillRegistryOptions = {}) {
    this.opts = opts;
    this.loadEnabledState();
  }

  /**
   * (Re)load all skills from built-ins + user dir + plugin dirs.
   * TIER 1 ONLY: frontmatter is parsed, bodies are NOT loaded
   * (`bodyLoaded === false` for every skill). Bodies load lazily via
   * `ensureSkillBody` / `applySkills` when a skill actually matches.
   */
  load(): Skill[] {
    this.byName.clear();
    this.loadErrors = [];
    // 1. Built-ins (frontmatter only; raw text kept for lazy body load).
    for (const text of BUILTIN_SKILLS) {
      const skill = parseSkillMetadata(text, 'builtin');
      BUILTIN_SKILL_TEXT.set(skill.name, text);
      skill.enabled = !this.disabled.has(skill.name);
      this.byName.set(skill.name, skill);
    }
    // 2. User skills override built-ins with the same name.
    if (this.opts.userSkillsDir) {
      const { skills, errors } = loadSkillsFromDir(this.opts.userSkillsDir, 'user', undefined, {
        metadataOnly: true,
      });
      this.loadErrors.push(...errors);
      for (const skill of skills) {
        skill.enabled = !this.disabled.has(skill.name);
        this.byName.set(skill.name, skill);
      }
    }
    // 3. Plugin skills override user skills with the same name.
    if (this.opts.pluginsDir) {
      for (const { pluginId, dir } of pluginSkillDirs(this.opts.pluginsDir)) {
        const { skills, errors } = loadSkillsFromDir(dir, 'plugin', pluginId, {
          metadataOnly: true,
        });
        this.loadErrors.push(...errors);
        for (const skill of skills) {
          skill.enabled = !this.disabled.has(skill.name);
          this.byName.set(skill.name, skill);
        }
      }
    }
    return this.list();
  }

  /**
   * v0.14: load skills from ONE extra directory (e.g. a plugin bundle's
   * skill dir) WITHOUT reloading everything. Bundle skills override user
   * skills with the same name (same precedence as plugin skills). A bad
   * dir contributes nothing and records errors in `errors()` instead of
   * throwing — loading one bundle must never break the registry.
   */
  addSkillsFromDir(dir: string, source: 'plugin' | 'user' = 'plugin', pluginId?: string): Skill[] {
    const added: Skill[] = [];
    try {
      const { skills, errors } = loadSkillsFromDir(dir, source, pluginId, {
        metadataOnly: true,
      });
      this.loadErrors.push(...errors);
      for (const skill of skills) {
        skill.enabled = !this.disabled.has(skill.name);
        this.byName.set(skill.name, skill);
        added.push(skill);
      }
    } catch (err) {
      this.loadErrors.push({
        file: dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return added;
  }

  /**
   * v0.14: register ONE skill from raw SKILL.md text (same path as the
   * built-ins — parse metadata, keep the text for lazy body load). Dùng
   * cho skill inline của plugin bundle (không có thư mục riêng). Trả
   * skill đã đăng ký, hoặc undefined khi text không parse được (lỗi ghi
   * vào `errors()` thay vì throw).
   */
  addSkillFromText(text: string, source: 'plugin' | 'user' = 'plugin'): Skill | undefined {
    try {
      const skill = parseSkillMetadata(text, source);
      // Inline skill không có file: nạp body NGAY từ text (nếu không,
      // ensureSkillBody sẽ throw vì không có file để đọc lại).
      const body = extractSkillBody(text, skill.filePath);
      if (body.length === 0) return undefined;
      skill.body = body;
      skill.bodyLoaded = true;
      skill.enabled = !this.disabled.has(skill.name);
      this.byName.set(skill.name, skill);
      return skill;
    } catch (err) {
      this.loadErrors.push({
        file: '(inline skill)',
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** All loaded skills, sorted by name. */
  list(): Skill[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Only enabled skills, sorted by name. */
  listEnabled(): Skill[] {
    return this.list().filter((s) => s.enabled);
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  /** Files that failed to load on the last `load()` (empty when all good). */
  errors(): Array<{ file: string; error: string }> {
    return [...this.loadErrors];
  }

  // --- Tier 1: startup index (metadata only, ~100 tokens/skill) ---

  /**
   * Tier-1 index: `name` + `description` (+ fork flag, allowed tools)
   * of every ENABLED skill the model may invoke. Skills with
   * `disable-model-invocation` are excluded — the model must never
   * see them as invocable (the user invokes those by name).
   *
   * v0.64: `exclude` drops per-bot denied skills from the index, so
   * the model never even learns their names for this bot.
   */
  skillIndex(exclude?: Iterable<string>): SkillIndexEntry[] {
    const excluded = excludeSet(exclude);
    return this.listEnabled()
      .filter((s) => !s.disableModelInvocation && !excluded.has(s.name))
      .map((s) => ({
        name: s.name,
        description: s.description,
        context: s.context,
        allowedTools: [...s.allowedTools],
      }));
  }

  /** The tier-1 index as compact prompt text (one line per skill). */
  formatSkillIndex(exclude?: Iterable<string>): string {
    const entries = this.skillIndex(exclude);
    if (entries.length === 0) return '';
    const lines = entries.map((e) => {
      const fork = e.context === 'fork' ? ' [runs in a subagent]' : '';
      const tools = e.allowedTools.length > 0 ? ` (tools: ${e.allowedTools.join(', ')})` : '';
      return `- ${e.name}: ${e.description}${fork}${tools}`;
    });
    return (
      `Available skills (invoke by name when the task matches; ` +
      `the full instructions load only then):\n${lines.join('\n')}`
    );
  }

  /** Estimated tokens of the tier-1 index (chars/4, same rule as v0.10). */
  estimateSkillIndexTokens(): number {
    return estimateTokens(this.formatSkillIndex());
  }

  // --- Tier 2: match + load body ---

  /**
   * Rank enabled skills for a task, best first. Only skills with a
   * positive score are returned (a task with no keyword overlap matches
   * nothing — the agent just runs without extra skills).
   * Metadata-only: returned skills may have `bodyLoaded === false`;
   * their bodies load when injected (see `applySkillsForTask`).
   * Skills with `disable-model-invocation: true` never match here —
   * the model must not trigger them on its own.
   *
   * v0.64: `exclude` drops per-bot denied skills before scoring, so
   * a denied skill can never match, load its body or fork for the bot.
   */
  matchSkills(task: string, limit = 3, exclude?: Iterable<string>): SkillMatch[] {
    const excluded = excludeSet(exclude);
    return this.listEnabled()
      .filter((s) => !s.disableModelInvocation && !excluded.has(s.name))
      .map((skill) => ({ skill, score: scoreSkill(skill, task) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, limit);
  }

  /** Convenience: match a task and inject the winners into a system prompt (tier 2 loads their bodies). */
  applySkillsForTask(
    systemPrompt: string,
    task: string,
    limit = 3,
    opts: ApplySkillsOptions = {},
  ): string {
    return applySkills(
      systemPrompt,
      this.matchSkills(task, limit, opts.exclude).map((m) => m.skill),
      opts,
    );
  }

  /**
   * Tier 2 for one skill by name: load its body (if needed) and return
   * it, or undefined when the skill does not exist or its body cannot
   * be loaded. Use `get()` when only metadata is needed.
   */
  loadBody(name: string): Skill | undefined {
    const skill = this.byName.get(name);
    if (!skill || !skill.enabled) return undefined;
    try {
      return ensureSkillBody(skill);
    } catch {
      return undefined;
    }
  }

  /**
   * Explicit user invocation (e.g. a `/name` slash command): returns
   * the skill with its body loaded, INCLUDING skills with
   * `disable-model-invocation: true` — the user, not the model, asked
   * for it. Returns undefined for unknown/disabled/unloadable skills.
   */
  invokeSkillByName(name: string): Skill | undefined {
    return this.loadBody(name);
  }

  // --- v0.66b: read a whole SKILL.md + install a user skill from pasted text ---

  /**
   * Read the FULL text of one loaded skill's SKILL.md (frontmatter +
   * body), for the SkillsView "view content" panel. Built-ins come
   * from the raw text the registry keeps; disk skills are re-read from
   * their file; inline (plugin) skills without a file are rebuilt from
   * their loaded body. Throws SkillLoadError when the skill is unknown,
   * its file is unreadable, or the text exceeds MAX_SKILL_TEXT_CHARS
   * (fail-closed — a huge file is rejected instead of being read
   * unbounded). Reading never depends on `enabled`: a disabled skill
   * can still be inspected.
   */
  readSkillText(name: string): string {
    if (this.byName.size === 0) this.load();
    const skill = this.byName.get(name);
    if (!skill) {
      throw new SkillLoadError(`Không tìm thấy skill "${name}".`);
    }
    const rawBuiltin = BUILTIN_SKILL_TEXT.get(name);
    if (skill.source === 'builtin' && rawBuiltin !== undefined) {
      if (rawBuiltin.length > MAX_SKILL_TEXT_CHARS) {
        throw new SkillLoadError(
          `Skill "${name}" quá lớn để đọc (${rawBuiltin.length} ký tự, tối đa ${MAX_SKILL_TEXT_CHARS}).`,
        );
      }
      return rawBuiltin;
    }
    if (skill.filePath) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(skill.filePath);
      } catch {
        throw new SkillLoadError(`Không đọc được file của skill "${name}".`, skill.filePath);
      }
      if (!stat.isFile() || stat.size > MAX_SKILL_TEXT_CHARS) {
        throw new SkillLoadError(
          `Skill "${name}" quá lớn để đọc (${stat.size} byte, tối đa ${MAX_SKILL_TEXT_CHARS}).`,
          skill.filePath,
        );
      }
      try {
        return fs.readFileSync(skill.filePath, 'utf8');
      } catch {
        throw new SkillLoadError(`Không đọc được file của skill "${name}".`, skill.filePath);
      }
    }
    // Inline skill (no file on disk): rebuild from its loaded body.
    const withBody = ensureSkillBody(skill);
    const text =
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${withBody.body}`;
    if (text.length > MAX_SKILL_TEXT_CHARS) {
      throw new SkillLoadError(
        `Skill "${name}" quá lớn để đọc (${text.length} ký tự, tối đa ${MAX_SKILL_TEXT_CHARS}).`,
      );
    }
    return text;
  }

  /**
   * Install a NEW user skill from pasted SKILL.md text (v0.66b).
   * Deliberately NOT a download: there is no URL / network fetch here —
   * the content comes only from text the user pasted in the UI, so a
   * skill from the web cannot silently land in the skills directory
   * (supply-chain: a foreign skill's instructions run as agent
   * guidance). Validation reuses the loader itself (`parseSkillMarkdown`):
   * frontmatter must parse, name + description must be valid, the body
   * must be non-empty, and no secret-looking text is allowed.
   *
   * Fail-closed, in order: bad name (SKILL_NAME_RE already blocks
   * `../`, `/`, `\`, empty and uppercase names — no path traversal) →
   * name of a built-in (never overwritten) → empty/oversize content →
   * unparsable content → name in the file differs from the directory
   * name → a skill with that name already exists (any source — no
   * overwrite, so an install can never shadow a plugin skill) → a
   * directory with that name already exists on disk. Nothing is
   * written until every check passes; the file is written atomically
   * (temp file + rename) and the registry reloads afterwards, so a
   * half-written file can never be loaded. Returns the installed skill.
   */
  installSkill(name: string, content: string): Skill {
    const dir = this.opts.userSkillsDir;
    if (!dir) {
      throw new SkillLoadError('Không có thư mục skills của người dùng để cài skill mới.');
    }
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
      throw new SkillLoadError(
        `Tên skill ${JSON.stringify(name)} không hợp lệ: chỉ dùng chữ thường, số, "-" và "_", ` +
          `1–64 ký tự, bắt đầu bằng chữ hoặc số (không dùng "/", "\\", "..").`,
      );
    }
    if (builtinSkillNames().has(name)) {
      throw new SkillLoadError(
        `Không được ghi đè skill có sẵn "${name}". Hãy chọn tên khác.`,
      );
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new SkillLoadError('Nội dung SKILL.md không được để trống.');
    }
    if (content.length > MAX_SKILL_TEXT_CHARS) {
      throw new SkillLoadError(
        `Nội dung skill quá lớn (${content.length} ký tự, tối đa ${MAX_SKILL_TEXT_CHARS}).`,
      );
    }
    // Validate bằng chính loader trước khi ghi bất cứ thứ gì.
    const parsed = parseSkillMarkdown(content, 'user');
    if (parsed.name !== name) {
      throw new SkillLoadError(
        `Tên trong SKILL.md là "${parsed.name}" nhưng tên skill phải là "${name}" — hai tên phải khớp nhau (tên skill phải bằng tên thư mục).`,
      );
    }
    if (this.byName.size === 0) this.load();
    if (this.byName.has(name)) {
      throw new SkillLoadError(
        `Đã có skill "${name}" — không ghi đè. Hãy xoá skill cũ rồi cài lại, hoặc chọn tên khác.`,
      );
    }
    const targetDir = path.join(dir, name);
    if (fs.existsSync(targetDir)) {
      throw new SkillLoadError(
        `Đã có thư mục skill "${name}" trong thư mục skills — không ghi đè.`,
      );
    }
    const targetFile = path.join(targetDir, SKILL_FILE_NAME);
    const tmpFile = path.join(
      targetDir,
      `.${SKILL_FILE_NAME}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
    let createdDir = false;
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      createdDir = true;
      fs.writeFileSync(tmpFile, content, 'utf8');
      fs.renameSync(tmpFile, targetFile);
    } catch (err) {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        // Best effort cleanup.
      }
      if (createdDir) {
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup.
        }
      }
      throw new SkillLoadError(
        `Không ghi được skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Load lại để loader tự kiểm tra file vừa ghi (tên khớp thư mục, parse được).
    this.load();
    const installed = this.byName.get(name);
    if (!installed || installed.source !== 'user') {
      // Không bao giờ tới được khi file đã ghi đúng — nhưng fail-closed:
      // không trả về skill mà loader không nhận.
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup.
      }
      throw new SkillLoadError(
        `Skill "${name}" đã ghi nhưng loader không nhận — đã xoá file vừa ghi.`,
      );
    }
    return installed;
  }

  // --- Tier 3: skill resources (scripts / references / assets) ---

  /** Tier-3 listing (paths only) for a skill, or undefined when unknown. */
  listSkillResources(name: string): SkillResources | undefined {
    const skill = this.byName.get(name);
    return skill ? { ...skill.resources } : undefined;
  }

  /** Tier 3: read one resource file of a skill (utf-8). Throws SkillLoadError on a bad path. */
  readSkillResource(name: string, relPath: string): string {
    const skill = this.byName.get(name);
    if (!skill) {
      throw new SkillLoadError(`Unknown skill ${JSON.stringify(name)}.`);
    }
    return readSkillResource(skill, relPath);
  }

  /**
   * Tier 3: absolute path of a script inside a skill's `scripts/`
   * directory, for the caller to execute. Returns undefined when the
   * script does not exist or the skill has no directory. This module
   * never executes scripts itself.
   */
  skillScriptPath(name: string, scriptName: string): string | undefined {
    const skill = this.byName.get(name);
    if (!skill) return undefined;
    return resolveSkillResourcePath(skill, `scripts/${scriptName}`);
  }

  enable(name: string): boolean {
    if (!this.byName.has(name)) return false;
    this.disabled.delete(name);
    const skill = this.byName.get(name)!;
    skill.enabled = true;
    this.saveEnabledState();
    return true;
  }

  disable(name: string): boolean {
    if (!this.byName.has(name)) return false;
    this.disabled.add(name);
    const skill = this.byName.get(name)!;
    skill.enabled = false;
    this.saveEnabledState();
    return true;
  }

  isEnabled(name: string): boolean {
    return !this.disabled.has(name);
  }

  private stateFile(): string {
    const dir =
      this.opts.stateDir ??
      (this.opts.userSkillsDir ? path.dirname(this.opts.userSkillsDir) : process.cwd());
    return path.join(dir, SKILLS_ENABLED_FILE);
  }

  private loadEnabledState(): void {
    try {
      const raw = fs.readFileSync(this.stateFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, enabled] of Object.entries(parsed as Record<string, unknown>)) {
          if (enabled === false) this.disabled.add(name);
        }
      }
    } catch {
      // No state file yet (or corrupt): everything defaults to enabled.
    }
  }

  private saveEnabledState(): void {
    try {
      const dir = path.dirname(this.stateFile());
      fs.mkdirSync(dir, { recursive: true });
      const state: Record<string, boolean> = {};
      for (const name of this.disabled) state[name] = false;
      fs.writeFileSync(this.stateFile(), JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Best-effort persistence: in-memory state still applies for this run.
    }
  }
}
