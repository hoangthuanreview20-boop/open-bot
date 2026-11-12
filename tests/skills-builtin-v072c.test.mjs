/**
 * Tests for the v0.72c built-in skills (Team C): the 5 new built-ins
 * (git-workflow, test-writing, data-cleaning, meeting-notes,
 * translation) plus the on-disk mirror of ALL 8 built-in skills at
 * packages/core/src/skills/builtin/<name>/SKILL.md.
 *
 * The disk files must be byte-identical (after trim) to the matching
 * string constant in registry.ts — they are extracted from the
 * registry by script, never retyped by hand.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-builtin-v072c.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_SKILLS,
  builtinSkillNames,
} from '../packages/core/dist/skills/registry.js';
import {
  looksLikeSecret,
  parseSkillMarkdown,
  parseSkillMetadata,
} from '../packages/core/dist/skills/loader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN_DIR = path.join(ROOT, 'packages/core/src/skills/builtin');

const NEW_SKILL_NAMES = [
  'git-workflow',
  'test-writing',
  'data-cleaning',
  'meeting-notes',
  'translation',
];

/** Skill dir names found on disk, sorted. */
function diskSkillNames() {
  return fs
    .readdirSync(BUILTIN_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Raw disk text of one built-in skill. */
function diskText(name) {
  return fs.readFileSync(path.join(BUILTIN_DIR, name, 'SKILL.md'), 'utf8');
}

// ---------------------------------------------------------------------------
// (a) Every disk SKILL.md parses and its name matches its directory
// ---------------------------------------------------------------------------

test('disk builtin skills parse and their names match their directories', () => {
  const names = diskSkillNames();
  assert.equal(names.length, 8, `expected 8 builtin skill dirs, got ${names.join(', ')}`);
  for (const name of names) {
    const text = diskText(name);
    const skill = parseSkillMarkdown(text, 'builtin');
    assert.equal(skill.name, name, `skill name in ${name}/SKILL.md must match its directory`);
    assert.ok(
      skill.description.length >= 1 && skill.description.length <= 1024,
      `${name}: description must be 1-1024 chars (got ${skill.description.length})`,
    );
    assert.ok(skill.body.length > 0, `${name}: body must not be empty`);
    assert.ok(
      skill.body.split('\n').length <= 500,
      `${name}: body should stay under ~500 lines`,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) Disk content is identical to the matching registry constant
// ---------------------------------------------------------------------------

test('disk SKILL.md files are identical to the BUILTIN_SKILLS constants', () => {
  assert.equal(BUILTIN_SKILLS.length, 8, 'expected 8 built-in skill constants');
  const byName = new Map();
  for (const text of BUILTIN_SKILLS) {
    const { name } = parseSkillMetadata(text, 'builtin');
    assert.ok(!byName.has(name), `duplicate built-in skill name ${name}`);
    byName.set(name, text);
  }
  const names = diskSkillNames();
  assert.deepEqual([...byName.keys()].sort(), names, 'registry names must match disk dirs');
  for (const name of names) {
    assert.equal(
      diskText(name).trim(),
      byName.get(name).trim(),
      `${name}: disk SKILL.md must be identical to its registry constant`,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) The 5 new skills are registered built-ins
// ---------------------------------------------------------------------------

test('the 5 new skills are present in builtinSkillNames()', () => {
  const names = builtinSkillNames();
  assert.equal(names.size, 8, `expected 8 builtin skill names, got ${names.size}`);
  for (const name of NEW_SKILL_NAMES) {
    assert.ok(names.has(name), `builtinSkillNames() must contain ${name}`);
  }
});

// ---------------------------------------------------------------------------
// (d) No skill contains secret-like content
// ---------------------------------------------------------------------------

test('no builtin skill contains secret-like content', () => {
  const secretSnippets = ['sk-', 'AKIA', 'ghp_'];
  for (const text of BUILTIN_SKILLS) {
    const { name } = parseSkillMetadata(text, 'builtin');
    assert.equal(
      looksLikeSecret(text),
      false,
      `${name}: registry text looks like it contains a secret`,
    );
    for (const snippet of secretSnippets) {
      assert.ok(
        !text.includes(snippet),
        `${name}: must not contain ${JSON.stringify(snippet)}`,
      );
    }
  }
  for (const name of diskSkillNames()) {
    const text = diskText(name);
    assert.equal(
      looksLikeSecret(text),
      false,
      `${name}: disk SKILL.md looks like it contains a secret`,
    );
  }
});
