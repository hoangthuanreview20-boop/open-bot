/**
 * Skills — types (v0.11a: Agent Skills standard, agentskills.io).
 *
 * A Skill is a directory (standard) or a single Markdown file (legacy,
 * still supported) whose `SKILL.md` has a YAML frontmatter header followed
 * by a free-form instruction body. The body is plain guidance text the
 * agent reads; it is NOT code and it is never executed. Skills are how a
 * bot gains per-domain know-how (code review, research briefs, Vietnamese
 * writing, …) without changing the bot's system prompt by hand.
 *
 * Standard layout (agentskills.io):
 *
 *   <skills-dir>/<skill-name>/
 *     SKILL.md            (required — frontmatter + body)
 *     scripts/            (optional — helper scripts the skill may run)
 *     references/         (optional — extra docs, read only when needed)
 *     assets/             (optional — templates, images, data files)
 *
 * Frontmatter (agentskills.io; `name` + `description` required):
 *
 *   ---
 *   name: code-review
 *   description: Review code changes for bugs and style.
 *   license: MIT
 *   compatibility: Requires git + a code search tool.
 *   metadata:
 *     author: open-bot
 *     audience: developers
 *   allowed-tools: [read_file, grep_search, git_diff]
 *   context: fork
 *   disable-model-invocation: true
 *   ---
 *   # Code review
 *   ...instructions...
 *
 * Rules (agentskills.io):
 * - `name` is 1–64 chars, lowercase + hyphen, and MUST match the skill
 *   directory name. (Legacy skills may also use `_`; the loader tolerates
 *   it, but new skills should use `-` only.)
 * - `description` is required, 1–1024 chars, and must say WHEN to use the
 *   skill — it is what matching scores on. Keep it under ~100 tokens:
 *   the startup index (tier 1 of progressive disclosure) contains only
 *   `name` + `description` per skill.
 * - `allowed-tools` is the tool allowlist for the skill. It is enforced
 *   by the v0.10 tool filter (`toolFilter.ts` reads `allowedTools`);
 *   it is NOT just a hint. Legacy `tools:` maps to the same field.
 * - `context: fork` means the skill must run in a separate subagent with
 *   its own context (Claude Code field). The skills module only records
 *   it — the loop/coordinator decides how to honour it.
 * - `disable-model-invocation: true` means only the user may invoke the
 *   skill (e.g. via a slash command); the model must never trigger it
 *   on its own. `matchSkills()` therefore skips such skills.
 * - `version` / `when-to-use` / `tools` are open-bot legacy fields and
 *   still load: `version` defaults to `1.0.0` when absent (the standard
 *   has no version field), `when-to-use` still boosts matching, and
 *   `tools:` is treated as `allowed-tools:`.
 * - The body should stay under ~500 lines / ~5.000 tokens (agentskills.io
 *   guidance). Injection still truncates at `MAX_SKILL_BODY_CHARS`.
 * - A skill MUST NOT contain secrets (API keys, tokens, passwords). The
 *   loader rejects any frontmatter/body that looks like one (see
 *   loader.ts `looksLikeSecret`).
 *
 * Progressive disclosure (3 tiers, see registry.ts):
 *  1. Metadata — at startup only `name` + `description` (+ flags) are
 *     loaded; `body` stays empty until tier 2 (`bodyLoaded === false`).
 *  2. Instructions — when a skill matches a task, its body is loaded.
 *  3. Resources — files under `scripts/` / `references/` / `assets/`
 *     are only listed at load time; their contents are read (or a script
 *     path handed out for execution) only when the skill asks for them.
 */

/** Where a skill came from. */
export type SkillSource = 'builtin' | 'user' | 'plugin';

/** Subdirectories of a standard skill directory (agentskills.io). */
export const SKILL_RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;
export type SkillResourceDir = (typeof SKILL_RESOURCE_DIRS)[number];

/** Files found under a skill's `scripts/` / `references/` / `assets/`. */
export interface SkillResources {
  /** Relative paths under `scripts/` (e.g. `scripts/check.sh`). */
  scripts: string[];
  /** Relative paths under `references/` (e.g. `references/api.md`). */
  references: string[];
  /** Relative paths under `assets/` (e.g. `assets/template.md`). */
  assets: string[];
}

export function emptySkillResources(): SkillResources {
  return { scripts: [], references: [], assets: [] };
}

/** How a skill should be executed (Claude Code field). */
export type SkillContext = 'fork';

/** The YAML frontmatter of a skill file (agentskills.io + legacy fields). */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Legacy open-bot field; the standard has no version. Defaults to 1.0.0. */
  version?: string;
  /** Free text: when this skill should be used. Legacy field. */
  whenToUse?: string;
  /** Legacy alias of `allowedTools` (`tools:` in old skill files). */
  tools?: string[];
  /** agentskills.io: tool allowlist, enforced by the tool filter. */
  allowedTools?: string[];
  /** agentskills.io: SPDX identifier or free-form license text. */
  license?: string;
  /** agentskills.io: environment requirements (string or list). */
  compatibility?: string | string[];
  /** agentskills.io: arbitrary extra frontmatter for tooling. */
  metadata?: Record<string, unknown>;
  /** Claude Code: `fork` runs the skill in a separate subagent. */
  context?: SkillContext;
  /** Claude Code: only the user may invoke this skill, never the model. */
  disableModelInvocation?: boolean;
  /** Claude Code: `false` hides the skill from the `/` menu. Default true. */
  userInvocable?: boolean;
}

/** One parsed skill: frontmatter + instruction body (see tiers above). */
export interface Skill {
  name: string;
  description: string;
  version: string;
  whenToUse: string;
  /**
   * Tool names the skill may use. Kept in sync with `allowedTools`
   * (same array) so older readers (`toolFilter`, `scoreSkill`) keep
   * working; new code should read `allowedTools`.
   */
  tools: string[];
  /** agentskills.io `allowed-tools` — enforced by the tool filter. */
  allowedTools: string[];
  license?: string;
  compatibility?: string | string[];
  metadata?: Record<string, unknown>;
  /** `fork` = run in a separate subagent; undefined = inline. */
  context?: SkillContext;
  /** True when only the user may invoke this skill. */
  disableModelInvocation: boolean;
  /** False hides the skill from the `/` (slash-command) menu. */
  userInvocable: boolean;
  /**
   * Instruction body (everything after the frontmatter fence).
   * Empty until tier-2 loading when `bodyLoaded` is false — do NOT
   * inject `body` into a prompt without checking `bodyLoaded` (or
   * going through `SkillRegistry.applySkills`, which loads it).
   */
  body: string;
  /** Tier 2 done: `body` holds the real instructions. */
  bodyLoaded: boolean;
  /** Absolute directory holding SKILL.md (standard layout); undefined for loose files / built-ins. */
  skillDir?: string;
  /** Tier-3 resource listing (paths only — contents are NOT loaded). */
  resources: SkillResources;
  /** Where the skill was loaded from. */
  source: SkillSource;
  /** Absolute path of SKILL.md / the loose `.md` file (undefined for built-ins). */
  filePath?: string;
  /** Plugin id, when source === 'plugin'. */
  pluginId?: string;
  /** Whether the user enabled this skill (registry-managed). */
  enabled: boolean;
}

/** Tier-1 index entry: everything the startup prompt needs per skill. */
export interface SkillIndexEntry {
  name: string;
  description: string;
  /** `fork` skills are marked so the model knows they run in a subagent. */
  context?: SkillContext;
  allowedTools: string[];
}

/** Thrown when a skill file cannot be parsed or fails validation. */
export class SkillLoadError extends Error {
  readonly filePath?: string;
  constructor(message: string, filePath?: string) {
    super(message);
    this.name = 'SkillLoadError';
    this.filePath = filePath;
  }
}
