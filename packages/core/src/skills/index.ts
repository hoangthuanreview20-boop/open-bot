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
  BUILTIN_SKILL_RESEARCH_BRIEF,
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
