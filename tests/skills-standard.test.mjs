/**
 * Tests for the v0.11a Agent Skills standard (agentskills.io) +
 * progressive disclosure (packages/core/src/skills/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-standard.test.mjs
 *
 * NOTE: new loader/registry helpers are imported from their modules
 * directly (dist/skills/loader.js, dist/skills/registry.js) — the
 * skills barrel (index.ts) was out of scope for v0.11a, so the new
 * names are not re-exported through it yet.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applySkills,
  BUILTIN_SKILLS,
  ensureSkillBody,
  estimateTokens,
  SkillRegistry,
  skillRunsInSubagent,
} from '../packages/core/dist/skills/registry.js';
import {
  extractSkillBody,
  listSkillResources,
  loadSkillDir,
  loadSkillsFromDir,
  parseFrontmatter,
  parseSkillMarkdown,
  parseSkillMetadata,
  parseYaml,
  readSkillResource,
  resolveSkillResourcePath,
  SKILL_NAME_MAX_LENGTH,
} from '../packages/core/dist/skills/loader.js';
import { SkillLoadError } from '../packages/core/dist/skills/types.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skill-std-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function writeFile(dir, rel, text) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return full;
}

// ---------------------------------------------------------------------------
// 1. Real YAML parser (not the old flat `key: value` splitter)
// ---------------------------------------------------------------------------

test('parseYaml handles nested maps, block + flow lists, quoted strings, block scalars', () => {
  const doc = parseYaml(
    [
      'name: demo',
      'description: "Review: code, with a colon"',
      'metadata:',
      '  author: open-bot',
      '  tags: [a, b]',
      '  nested:',
      '    level: 2',
      'allowed-tools:',
      '  - read_file',
      '  - grep',
      'notes: |',
      '  line one',
      '  line two',
      'folded: >',
      '  word one',
      '  word two',
      '',
      '  next para',
      'enabled: true',
      'count: 3',
      'nothing: null',
    ].join('\n'),
  );
  assert.equal(doc.name, 'demo');
  assert.equal(doc.description, 'Review: code, with a colon');
  assert.deepEqual(doc.metadata, { author: 'open-bot', tags: ['a', 'b'], nested: { level: 2 } });
  assert.deepEqual(doc['allowed-tools'], ['read_file', 'grep']);
  assert.equal(doc.notes, 'line one\nline two\n');
  assert.equal(doc.folded, 'word one word two\nnext para\n');
  assert.equal(doc.enabled, true);
  assert.equal(doc.count, 3);
  assert.equal(doc.nothing, null);
});

test('parseYaml rejects unclosed flow collections and bad indentation', () => {
  assert.throws(() => parseYaml('tools: [a, b\nname: x'), SkillLoadError);
  assert.throws(
    () => parseYaml('a:\n  b: 1\n c: 2'),
    (e) => e instanceof SkillLoadError,
  );
  assert.throws(
    // A lone scalar is valid YAML as a document, but not as frontmatter.
    () => parseFrontmatter('just a scalar line without a colon'),
    (e) => e instanceof SkillLoadError && /must be a mapping/.test(e.message),
  );
});

test('parseFrontmatter reads agentskills.io fields + maps legacy fields', () => {
  const fm = parseFrontmatter(
    [
      'name: demo-skill',
      'description: Do the demo thing when asked.',
      'license: MIT',
      'compatibility:',
      '  - node >= 24',
      '  - git',
      'metadata:',
      '  author: huy',
      '  audience: developers',
      'allowed-tools: [read_file, grep]',
      'context: fork',
      'disable-model-invocation: true',
      'user-invocable: false',
    ].join('\n'),
  );
  assert.equal(fm.name, 'demo-skill');
  assert.equal(fm.license, 'MIT');
  assert.deepEqual(fm.compatibility, ['node >= 24', 'git']);
  assert.deepEqual(fm.metadata, { author: 'huy', audience: 'developers' });
  assert.deepEqual(fm.allowedTools, ['read_file', 'grep']);
  assert.equal(fm.context, 'fork');
  assert.equal(fm.disableModelInvocation, true);
  assert.equal(fm.userInvocable, false);
  assert.equal(fm.version, undefined, 'standard skills carry no version');

  // Legacy: `tools:` maps to allowed-tools, `version:` kept when present.
  const legacy = parseFrontmatter(
    'name: old-skill\ndescription: Old format.\nversion: 2.3.4\nwhen-to-use: when old\ntools: [read_file]\n',
  );
  assert.equal(legacy.version, '2.3.4');
  assert.equal(legacy.whenToUse, 'when old');
  assert.deepEqual(legacy.allowedTools, ['read_file']);
  assert.deepEqual(legacy.tools, ['read_file']);
});

test('parseFrontmatter validates the standard: name length, description length, context', () => {
  assert.throws(
    () => parseFrontmatter(`name: ${'a'.repeat(SKILL_NAME_MAX_LENGTH + 1)}\ndescription: x\n`),
    (e) => e instanceof SkillLoadError && /name/.test(e.message),
  );
  assert.throws(
    () => parseFrontmatter(`name: ok\ndescription: ${'x'.repeat(1025)}\n`),
    (e) => e instanceof SkillLoadError && /description/.test(e.message),
  );
  assert.throws(
    () => parseFrontmatter('name: ok\ndescription: x\ncontext: background\n'),
    (e) => e instanceof SkillLoadError && /context/.test(e.message),
  );
  assert.throws(
    () => parseFrontmatter('name: ok\ndescription: x\nversion: one\n'),
    (e) => e instanceof SkillLoadError && /version/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// 2. Standard skill directory: SKILL.md + scripts/ + references/ + assets/
// ---------------------------------------------------------------------------

const STD_SKILL_MD = `---
name: demo-skill
description: Demo skill for testing the standard layout.
license: MIT
compatibility: Requires node.
metadata:
  author: test
allowed-tools:
  - read_file
  - grep
context: fork
---
# Demo skill

Do the demo thing. Read references/api.md first.
`;

function writeStandardSkill(base, dirName = 'demo-skill') {
  const dir = path.join(base, dirName);
  writeFile(dir, 'SKILL.md', STD_SKILL_MD);
  writeFile(dir, 'scripts/check.sh', '#!/bin/sh\necho ok\n');
  writeFile(dir, 'references/api.md', '# API notes\nUse the demo API.\n');
  writeFile(dir, 'assets/template.md', '# Template\nHello.\n');
  return dir;
}

test('loadSkillDir loads tier-1 metadata, lists resources, enforces name == directory', () => {
  const base = makeTempDir();
  const dir = writeStandardSkill(base);
  const skill = loadSkillDir(dir, 'user');
  assert.equal(skill.name, 'demo-skill');
  assert.equal(skill.description, 'Demo skill for testing the standard layout.');
  assert.equal(skill.body, '', 'tier 1 keeps no body');
  assert.equal(skill.bodyLoaded, false);
  assert.equal(skill.context, 'fork');
  assert.equal(skillRunsInSubagent(skill), true);
  assert.deepEqual(skill.allowedTools, ['read_file', 'grep']);
  assert.deepEqual(skill.tools, ['read_file', 'grep'], 'legacy tools stays in sync');
  assert.deepEqual(skill.resources, {
    scripts: ['scripts/check.sh'],
    references: ['references/api.md'],
    assets: ['assets/template.md'],
  });
  assert.equal(skill.skillDir, dir);

  // Name must match the directory name (agentskills.io rule).
  const wrong = writeStandardSkill(base, 'other-name');
  assert.throws(
    () => loadSkillDir(wrong, 'user'),
    (e) => e instanceof SkillLoadError && /does not match its directory/.test(e.message),
  );
  assert.throws(
    () => loadSkillDir(path.join(base, 'no-such-dir'), 'user'),
    (e) => e instanceof SkillLoadError && /SKILL.md/.test(e.message),
  );
});

test('tier 3: readSkillResource reads on demand, resolveSkillResourcePath blocks traversal', () => {
  const base = makeTempDir();
  const dir = writeStandardSkill(base);
  const skill = loadSkillDir(dir, 'user');
  assert.equal(readSkillResource(skill, 'references/api.md'), '# API notes\nUse the demo API.\n');
  assert.equal(readSkillResource(skill, 'scripts/check.sh'), '#!/bin/sh\necho ok\n');
  assert.equal(resolveSkillResourcePath(skill, 'scripts/check.sh'), path.join(dir, 'scripts/check.sh'));
  assert.equal(resolveSkillResourcePath(skill, '../SKILL.md'), undefined);
  assert.equal(resolveSkillResourcePath(skill, 'scripts/../../etc/passwd'), undefined);
  assert.equal(resolveSkillResourcePath(skill, '/etc/passwd'), undefined);
  assert.equal(resolveSkillResourcePath(skill, 'references/missing.md'), undefined);
  assert.throws(
    () => readSkillResource(skill, '../SKILL.md'),
    (e) => e instanceof SkillLoadError,
  );
  assert.deepEqual(listSkillResources(dir), skill.resources);
});

test('loadSkillsFromDir mixes loose .md files and skill directories; broken entries are reported', () => {
  const dir = makeTempDir();
  writeFile(
    dir,
    'loose.md',
    '---\nname: loose-one\ndescription: A loose legacy file.\nversion: 1.0.0\n---\nLoose body.\n',
  );
  writeStandardSkill(dir);
  writeFile(dir, 'notes.txt', 'ignored, not a skill');
  writeFile(dir, 'broken.md', 'no frontmatter here');
  fs.mkdirSync(path.join(dir, 'empty-dir'));

  const { skills, errors } = loadSkillsFromDir(dir, 'user');
  assert.deepEqual(
    skills.map((s) => s.name),
    ['demo-skill', 'loose-one'],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].file, /broken\.md/);

  const meta = loadSkillsFromDir(dir, 'user', undefined, { metadataOnly: true });
  assert.ok(meta.skills.every((s) => s.bodyLoaded === false), 'metadataOnly keeps bodies unloaded');
  assert.ok(meta.skills.some((s) => s.name === 'demo-skill' && s.resources.scripts.length === 1));
});

// ---------------------------------------------------------------------------
// 3. Backward compatibility: old format still loads
// ---------------------------------------------------------------------------

test('legacy loose skill (v0.4 format) still loads, tools map to allowed-tools', () => {
  const skill = parseSkillMarkdown(
    [
      '---',
      'name: code-review',
      'description: Review code changes for bugs and style.',
      'version: 1.0.0',
      'when-to-use: when the user asks to review code or a diff',
      'tools: [read_file, grep]',
      '---',
      '# Code review',
      '',
      'Read the diff first.',
      '',
    ].join('\n'),
    'user',
  );
  assert.equal(skill.name, 'code-review');
  assert.equal(skill.version, '1.0.0');
  assert.equal(skill.whenToUse, 'when the user asks to review code or a diff');
  assert.deepEqual(skill.allowedTools, ['read_file', 'grep']);
  assert.deepEqual(skill.tools, ['read_file', 'grep']);
  assert.equal(skill.bodyLoaded, true);
  assert.match(skill.body, /Read the diff first/);

  // Standard skill without `version` defaults to 1.0.0.
  const modern = parseSkillMarkdown(
    '---\nname: modern\ndescription: Modern skill.\n---\nBody here.\n',
    'user',
  );
  assert.equal(modern.version, '1.0.0');
  assert.deepEqual(modern.allowedTools, []);

  // parseSkillMetadata keeps the body out; extractSkillBody recovers it.
  const meta = parseSkillMetadata(
    '---\nname: modern\ndescription: Modern skill.\n---\nBody here.\n',
    'user',
  );
  assert.equal(meta.bodyLoaded, false);
  assert.equal(meta.body, '');
  assert.equal(extractSkillBody('---\nname: modern\ndescription: Modern skill.\n---\nBody here.\n'), 'Body here.');
});

// ---------------------------------------------------------------------------
// 4. Progressive disclosure, tiers 1–3, in the registry
// ---------------------------------------------------------------------------

test('tier 1: registry.load() keeps bodies unloaded; index is name+description only', () => {
  const registry = new SkillRegistry({ stateDir: makeTempDir() });
  const skills = registry.load();
  assert.equal(skills.length, 11);
  assert.ok(skills.every((s) => s.bodyLoaded === false), 'no body loaded at startup');
  assert.ok(skills.every((s) => s.body === ''), 'no body retained at startup');

  const index = registry.formatSkillIndex();
  assert.match(index, /code-review: Review code changes/);
  assert.match(index, /research-brief: Research a topic/);
  assert.match(index, /writing-vi: Write and edit Vietnamese/);
  assert.match(index, /git-workflow: Work with git safely/);
  assert.match(index, /test-writing: Write tests for new or changed code/);
  assert.match(index, /data-cleaning: Clean CSV or JSON data files/);
  assert.match(index, /meeting-notes: Take meeting notes/);
  assert.match(index, /translation: Translate text into another language/);
  assert.match(index, /commit-message: Write clear git commit messages/);
  assert.match(index, /release-notes: Draft release notes/);
  assert.match(index, /summarize-file: Summarise a file/);
  assert.doesNotMatch(index, /Read the changed files/, 'index must not contain body text');
  assert.doesNotMatch(index, /TL;DR/, 'index must not contain body text');
  assert.equal(registry.skillIndex().length, 11);

  // Tier 1 is dramatically cheaper than the old inject-everything cost:
  // full bodies of all 11 built-ins vs the one-line-per-skill index.
  const fullBodies = BUILTIN_SKILLS.map((raw) => extractSkillBody(raw)).join('\n');
  const indexTokens = estimateTokens(index);
  const bodyTokens = estimateTokens(fullBodies);
  assert.ok(indexTokens < bodyTokens * 0.2, `index ${indexTokens} tokens should be <20% of bodies ${bodyTokens}`);
});

test('tier 2: matchSkills reads metadata only; applySkillsForTask loads bodies of matches only', () => {
  const registry = new SkillRegistry({ stateDir: makeTempDir() });
  registry.load();
  const matches = registry.matchSkills('hãy review code trong pull request này giúp tôi');
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].skill.name, 'code-review');
  assert.equal(matches[0].skill.bodyLoaded, false, 'matching alone must not load the body');

  const injected = registry.applySkillsForTask('Bạn là Trợ lý.', 'review code giúp tôi');
  assert.match(injected, /Skill: code-review/);
  assert.match(injected, /Read the changed files|reviewing code/i);
  assert.equal(matches[0].skill.bodyLoaded, true, 'matched skill body loads on inject');
  assert.equal(
    registry.get('research-brief').bodyLoaded,
    false,
    'unmatched skills stay unloaded',
  );
  assert.equal(registry.get('writing-vi').bodyLoaded, false, 'unmatched skills stay unloaded');

  // Public signatures kept: matchSkills(task, limit) and
  // applySkillsForTask(systemPrompt, task, limit) — function.length
  // counts params before the first default (limit = 3), so 1 and 2.
  assert.equal(registry.applySkillsForTask.length, 2);
  assert.equal(registry.matchSkills.length, 1);
  assert.equal(applySkills('base', []), 'base');
});

test('tier 2 helper: ensureSkillBody / loadBody load a body on demand, get() does not', () => {
  const registry = new SkillRegistry({ stateDir: makeTempDir() });
  registry.load();
  const meta = registry.get('research-brief');
  assert.equal(meta.bodyLoaded, false);
  const loaded = registry.loadBody('research-brief');
  assert.equal(loaded.bodyLoaded, true);
  assert.match(loaded.body, /TL;DR/);
  assert.equal(registry.loadBody('no-such-skill'), undefined);
  assert.equal(ensureSkillBody(meta).bodyLoaded, true);
});

test('tier 3 via registry: list/read resources and script paths for a skill directory', () => {
  const userDir = makeTempDir();
  writeStandardSkill(userDir);
  const registry = new SkillRegistry({ userSkillsDir: userDir, stateDir: makeTempDir() });
  registry.load();
  assert.deepEqual(registry.listSkillResources('demo-skill'), {
    scripts: ['scripts/check.sh'],
    references: ['references/api.md'],
    assets: ['assets/template.md'],
  });
  assert.equal(registry.readSkillResource('demo-skill', 'references/api.md'), '# API notes\nUse the demo API.\n');
  assert.match(registry.skillScriptPath('demo-skill', 'check.sh'), /scripts[/\\]check\.sh$/);
  assert.equal(registry.skillScriptPath('demo-skill', 'missing.sh'), undefined);
  assert.equal(registry.listSkillResources('no-such-skill'), undefined);
  assert.throws(
    () => registry.readSkillResource('demo-skill', '../SKILL.md'),
    (e) => e instanceof SkillLoadError,
  );
  // A skill directory skill still matches + injects its body on demand.
  const injected = registry.applySkillsForTask('base', 'demo thing');
  assert.match(injected, /Demo skill/);
  assert.match(injected, /runs in a separate subagent/, 'fork note is injected with the body');
});

// ---------------------------------------------------------------------------
// 5. disable-model-invocation + context: fork
// ---------------------------------------------------------------------------

const FORK_ONLY_SKILL = `---
name: fork-only
description: A fork-only skill for sensitive review work.
allowed-tools: [read_file]
context: fork
disable-model-invocation: true
---
# Fork only

Run me in a subagent.
`;

test('disable-model-invocation skills never match and never appear in the index, but the user can invoke them', () => {
  const userDir = makeTempDir();
  writeFile(userDir, 'fork-only.md', FORK_ONLY_SKILL);
  const registry = new SkillRegistry({ userSkillsDir: userDir, stateDir: makeTempDir() });
  registry.load();

  const skill = registry.get('fork-only');
  assert.equal(skill.disableModelInvocation, true);
  assert.equal(skill.context, 'fork');
  assert.equal(skillRunsInSubagent(skill), true);

  // Query matches ONLY the fork-only skill (verified by direct
  // measurement: matchSkills returns [] because fork-only is skipped and
  // nothing else matches): 'fork'/'sensitive'/'subagent' appear in no
  // built-in skill's matchable text. The old query ('... sensitive
  // subagent work') now also matches git-workflow on 'work'.
  assert.deepEqual(
    registry.matchSkills('fork-only sensitive subagent').map((m) => m.skill.name),
    [],
    'model must never self-invoke this skill',
  );
  assert.ok(
    !registry.formatSkillIndex().includes('fork-only'),
    'index must not advertise a model-uninvocable skill',
  );
  assert.ok(!registry.skillIndex().some((e) => e.name === 'fork-only'));

  // Explicit user invocation still works (slash-command path).
  const invoked = registry.invokeSkillByName('fork-only');
  assert.equal(invoked.name, 'fork-only');
  assert.equal(invoked.bodyLoaded, true);
  assert.match(invoked.body, /Run me in a subagent/);
  assert.equal(registry.invokeSkillByName('no-such-skill'), undefined);
});

test('allowed-tools is what scoring and injection use (tools stays in sync)', () => {
  const userDir = makeTempDir();
  writeFile(
    userDir,
    'grep-skill.md',
    '---\nname: grep-skill\ndescription: Search code with grep.\nallowed-tools:\n  - grep\n  - read_file\n---\nSearch first.\n',
  );
  const registry = new SkillRegistry({ userSkillsDir: userDir, stateDir: makeTempDir() });
  registry.load();
  const skill = registry.get('grep-skill');
  assert.deepEqual(skill.allowedTools, ['grep', 'read_file']);
  assert.deepEqual(skill.tools, ['grep', 'read_file']);
  assert.ok(registry.matchSkills('search code with grep').some((m) => m.skill.name === 'grep-skill'));
  const injected = registry.applySkillsForTask('base', 'search code with grep');
  assert.match(injected, /Tools this skill may use: grep, read_file/);
});
