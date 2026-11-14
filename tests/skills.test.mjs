/**
 * Tests for the v0.4 skills system (packages/core/src/skills/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applySkills,
  BUILTIN_SKILLS,
  loadSkillsFromDir,
  parseSkillMarkdown,
  SkillLoadError,
  SkillRegistry,
} from '../packages/core/dist/skills/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skill-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const VALID_SKILL = `---
name: code-review
description: Review code changes for bugs and style.
version: 1.0.0
when-to-use: when the user asks to review code or a diff
tools: [read_file, grep]
---
# Code review

Read the diff first. Report bugs by severity.
`;

function writeSkill(dir, file, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text, 'utf8');
  return path.join(dir, file);
}

// ---------------------------------------------------------------------------
// parseSkillMarkdown: valid + invalid frontmatter
// ---------------------------------------------------------------------------

test('parseSkillMarkdown parses a valid skill: name, description, version, when-to-use, tools, body', () => {
  const skill = parseSkillMarkdown(VALID_SKILL, 'user');
  assert.equal(skill.name, 'code-review');
  assert.equal(skill.description, 'Review code changes for bugs and style.');
  assert.equal(skill.version, '1.0.0');
  assert.equal(skill.whenToUse, 'when the user asks to review code or a diff');
  assert.deepEqual(skill.tools, ['read_file', 'grep']);
  assert.match(skill.body, /Read the diff first/);
  assert.equal(skill.source, 'user');
  assert.equal(skill.enabled, true);
});

test('parseSkillMarkdown rejects: no frontmatter, bad name, missing description, bad version, empty body', () => {
  assert.throws(
    () => parseSkillMarkdown('# No frontmatter at all\nbody', 'user'),
    (e) => e instanceof SkillLoadError && /frontmatter/.test(e.message),
  );

  assert.throws(
    () => parseSkillMarkdown(VALID_SKILL.replace('name: code-review', 'name: Bad Name!'), 'user'),
    (e) => e instanceof SkillLoadError && /name/.test(e.message),
  );

  assert.throws(
    () => parseSkillMarkdown(VALID_SKILL.replace('description: Review code changes for bugs and style.\n', ''), 'user'),
    (e) => e instanceof SkillLoadError && /description/.test(e.message),
  );

  assert.throws(
    () => parseSkillMarkdown(VALID_SKILL.replace('version: 1.0.0', 'version: one'), 'user'),
    (e) => e instanceof SkillLoadError && /version/.test(e.message),
  );

  assert.throws(
    () => parseSkillMarkdown(VALID_SKILL.replace(/# Code review\n\nRead the diff first\. Report bugs by severity\./, ''), 'user'),
    (e) => e instanceof SkillLoadError && /empty/.test(e.message),
  );
});

test('parseSkillMarkdown rejects a skill containing a secret-looking value', () => {
  const withKey = VALID_SKILL.replace(
    'Read the diff first.',
    'Use api_key: sk-abcdefghij1234567890 to call the API.',
  );
  assert.throws(
    () => parseSkillMarkdown(withKey, 'user'),
    (e) => e instanceof SkillLoadError && /secret/.test(e.message),
  );
});

test('parseSkillMarkdown accepts a skill without optional fields (when-to-use, tools)', () => {
  const minimal = `---
name: minimal
description: A minimal skill.
version: 0.1.0
---
Do the thing.
`;
  const skill = parseSkillMarkdown(minimal, 'user');
  assert.equal(skill.whenToUse, '');
  assert.deepEqual(skill.tools, []);
});

// ---------------------------------------------------------------------------
// loadSkillsFromDir: skips broken files, missing dir is empty
// ---------------------------------------------------------------------------

test('loadSkillsFromDir loads valid files, reports broken ones, missing dir is empty', () => {
  const dir = makeTempDir();
  writeSkill(dir, 'good.md', VALID_SKILL);
  writeSkill(dir, 'broken.md', 'no frontmatter here');
  writeSkill(dir, 'notes.txt', VALID_SKILL); // not .md: ignored

  const { skills, errors } = loadSkillsFromDir(dir, 'user');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'code-review');
  assert.equal(errors.length, 1);
  assert.match(errors[0].file, /broken\.md/);

  const missing = loadSkillsFromDir(path.join(dir, 'does-not-exist'), 'user');
  assert.deepEqual(missing.skills, []);
  assert.deepEqual(missing.errors, []);
});

// ---------------------------------------------------------------------------
// SkillRegistry: built-ins, match, applySkills, enable/disable persisted
// ---------------------------------------------------------------------------

test('registry loads the 11 built-in skills and matches by keyword', () => {
  assert.equal(BUILTIN_SKILLS.length, 11);
  const registry = new SkillRegistry({ stateDir: makeTempDir() });
  const skills = registry.load();
  // load() returns skills sorted by name (not BUILTIN_SKILLS order).
  assert.deepEqual(
    skills.map((s) => s.name),
    [
      'code-review',
      'commit-message',
      'data-cleaning',
      'git-workflow',
      'meeting-notes',
      'release-notes',
      'research-brief',
      'summarize-file',
      'test-writing',
      'translation',
      'writing-vi',
    ],
  );
  assert.ok(skills.every((s) => s.source === 'builtin'));

  const matches = registry.matchSkills('hãy review code trong pull request này giúp tôi');
  assert.ok(matches.length >= 1, 'code-review should match a review request');
  assert.equal(matches[0].skill.name, 'code-review');
  assert.ok(matches[0].score > 0);

  const viMatches = registry.matchSkills('viết lại đoạn văn tiếng Việt này cho tự nhiên');
  assert.ok(viMatches.some((m) => m.skill.name === 'writing-vi'));

  // No keyword overlap -> no match, agent just runs without extra skills.
  assert.deepEqual(registry.matchSkills('zzzz qqqq'), []);
});

test('applySkills injects matched skills into the system prompt, unchanged when none', () => {
  const registry = new SkillRegistry({ stateDir: makeTempDir() });
  registry.load();
  const base = 'Bạn là Trợ lý.';
  assert.equal(applySkills(base, []), base);

  const matched = registry.matchSkills('review code giúp tôi').map((m) => m.skill);
  const injected = applySkills(base, matched);
  assert.ok(injected.startsWith(base), 'base prompt is kept verbatim at the front');
  assert.match(injected, /Skill: code-review/);
  assert.match(injected, /Read the changed files|reviewing code/i);
});

test('registry disable/enable persists across a fresh registry on the same state dir', () => {
  const stateDir = makeTempDir();
  const r1 = new SkillRegistry({ stateDir });
  r1.load();
  assert.equal(r1.disable('code-review'), true);
  assert.equal(r1.get('code-review').enabled, false);
  // Query chosen so ONLY code-review matches it (verified by direct
  // measurement: matchSkills returns [code-review] only): 'bugs' appears
  // in no other built-in skill's matchable text, and the Vietnamese words
  // ('tìm', 'giúp', 'tôi') overlap nothing — English stopwords ('the',
  // 'of', 'and') and even Vietnamese ones ('lại') leak points to other
  // skills. (A generic 'review code' query now also matches
  // git-workflow on 'review' and test-writing on 'code'.)
  assert.deepEqual(
    r1.matchSkills('tìm bugs giúp tôi').map((m) => m.skill.name),
    [],
    'a disabled skill must never match',
  );
  assert.equal(fs.existsSync(path.join(stateDir, 'skills-enabled.json')), true);

  const r2 = new SkillRegistry({ stateDir });
  r2.load();
  assert.equal(r2.get('code-review').enabled, false, 'disabled state survives reload');

  assert.equal(r2.enable('code-review'), true);
  assert.equal(r2.get('code-review').enabled, true);
  assert.equal(r2.enable('no-such-skill'), false);
  assert.equal(r2.disable('no-such-skill'), false);
});

test('user skill with the same name overrides the built-in', () => {
  const userDir = makeTempDir();
  const stateDir = makeTempDir();
  writeSkill(
    userDir,
    'code-review.md',
    VALID_SKILL.replace('Review code changes for bugs and style.', 'My own review rules.'),
  );
  const registry = new SkillRegistry({ userSkillsDir: userDir, stateDir });
  registry.load();
  assert.equal(registry.get('code-review').source, 'user');
  assert.equal(registry.get('code-review').description, 'My own review rules.');
});
