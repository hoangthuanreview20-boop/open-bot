/**
 * @open-bot/core skills — public surface for the skills module.
 * (v0.4; imported directly as `@open-bot/core/dist/skills/index.js` until
 * the core barrel `src/index.ts` gains these exports — see
 * docs/v04-worker2-integration.md.)
 */

export type {
  Skill,
  SkillContext,
  SkillFrontmatter,
  SkillIndexEntry,
  SkillResourceDir,
  SkillResources,
  SkillSource,
} from './types';
export { SkillLoadError, SKILL_RESOURCE_DIRS } from './types';

export {
  extractSkillBody,
  listSkillResources,
  loadSkillDir,
  loadSkillFile,
  loadSkillFileMetadata,
  loadSkillsFromDir,
  looksLikeSecret,
  parseFrontmatter,
  parseSkillMarkdown,
  parseSkillMetadata,
  parseYaml,
  pluginSkillDirs,
  readSkillResource,
  resolveSkillResourcePath,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_TEXT_CHARS,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_NAME,
  SKILL_NAME_RE,
  SKILL_VERSION_RE,
} from './loader';
export type { LoadSkillsOptions, LoadSkillsResult, YamlValue } from './loader';

export {
  applySkills,
  BUILTIN_SKILLS,
  BUILTIN_SKILL_CODE_REVIEW,
  BUILTIN_SKILL_COMMIT_MESSAGE,
  BUILTIN_SKILL_RESEARCH_BRIEF,
  BUILTIN_SKILL_RELEASE_NOTES,
  BUILTIN_SKILL_SUMMARIZE_FILE,
  BUILTIN_SKILL_WRITING_VI,
  builtinSkillNames,
  ensureSkillBody,
  estimateTokens,
  scoreSkill,
  SkillRegistry,
  skillRunsInSubagent,
  SKILLS_ENABLED_FILE,
  truncateSkillBody,
} from './registry';
export type { ApplySkillsOptions, SkillMatch, SkillRegistryOptions } from './registry';

// --- v1.02 (rescue port of v0.99/v1.00): discovery, matching, token budget, scripts, evolved skills ---
export { defaultDiscoveryRoots, scanDiscoveryRoots } from './discovery';
export type { DiscoveredSkill, DiscoveryScanResult, SkillDiscoveryRoot } from './discovery';
export { DEFAULT_SKILL_MATCH_CONFIG, matchSkillsWithConfig } from './matching';
export type { ConfiguredSkillMatch, SkillMatchConfig } from './matching';
export { SkillTokenBudget } from './tokenBudget';
export type { SkillCost, SkillTokenBudgetOptions } from './tokenBudget';
export {
  DEFAULT_SKILL_SCRIPT_MAX_OUTPUT_BYTES,
  DEFAULT_SKILL_SCRIPT_TIMEOUT_MS,
  runSkillScript,
} from './scriptRun';
export type { SkillScriptResult, SkillScriptRunOptions } from './scriptRun';
export {
  draftSkillFromTasks,
  EvolvedSkillStore,
  EVOLVED_SKILLS_REL_PATH,
  MAX_EVOLVED_BODY_CHARS,
  MAX_EVOLVED_DESCRIPTION_LENGTH,
  MAX_FEEDBACK_NOTE_LENGTH,
  MIN_FAILURES_TO_EVOLVE,
  MIN_FEEDBACKS_TO_EVOLVE,
  MIN_TASKS_TO_PROPOSE,
} from './evolved';
export type { EvolvedSkill, EvolvedSkillStatus, SkillFeedback, TaskLogEntry } from './evolved';

// --- v0.14: skill marketplace (install from URL/git) ---
export {
  installSkillFromUrl,
  previewSkillFromUrl,
  scanSkillDirForSecrets,
  scanSkillDirForInjection,
  scanTextForSecrets,
  scanTextForInjection,
  MarketplaceError,
  MAX_SKILL_DOWNLOAD_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_UNCOMPRESSED_BYTES,
} from './marketplace';
export type {
  InjectionFinding,
  InstallSkillOptions,
  InstallSkillResult,
  MarketplaceFetchFn,
  PreviewSkillOptions,
  SecretFinding,
  SkillPreview,
  SkillPreviewFile,
} from './marketplace';
