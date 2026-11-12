/**
 * Tests for v0.66b — SkillsView: read a skill's full SKILL.md +
 * install a new user skill from pasted text (SkillRegistry.readSkillText
 * / installSkill in packages/core/src/skills/registry.ts).
 *
 * No URL / network install exists by design (supply-chain: a skill from
 * the web must not silently land in the skills directory) — these tests
 * cover the pasted-text path only.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-view-v066b.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_SKILL_TEXT_CHARS,
  SkillLoadError,
  SkillRegistry,
} from '../packages/core/dist/skills/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skill-v066b-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeRegistry(dir) {
  const registry = new SkillRegistry({
    userSkillsDir: path.join(dir, 'skills'),
    stateDir: dir,
  });
  registry.load();
  return registry;
}

const VALID_SKILL = `---
name: ghi-chep-nhanh
description: Ghi nhanh y tuong khi dang lam viec.
---
# Ghi chep nhanh

Ghi lai y tuong ngay khi no xuat hien.
`;

// ---------------------------------------------------------------------------
// readSkillText
// ---------------------------------------------------------------------------

test('readSkillText returns the full SKILL.md of a builtin skill (frontmatter + body)', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  const text = registry.readSkillText('code-review');
  assert.ok(text.startsWith('---\nname: code-review\n'), 'full text starts with frontmatter');
  assert.ok(text.includes('description: Review code changes'), 'frontmatter included');
  assert.ok(text.includes('# Code review'), 'body included');
});

test('readSkillText returns the exact text of an installed user skill', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  registry.installSkill('ghi-chep-nhanh', VALID_SKILL);
  assert.equal(registry.readSkillText('ghi-chep-nhanh'), VALID_SKILL);
});

test('readSkillText throws SkillLoadError for an unknown skill', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  assert.throws(() => registry.readSkillText('khong-co-skill-nay'), SkillLoadError);
});

test('readSkillText rejects a skill file larger than the cap', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  const skillsDir = path.join(dir, 'skills', 'qua-lon');
  fs.mkdirSync(skillsDir, { recursive: true });
  // Valid frontmatter + a body that pushes the file over the cap.
  const big = `---\nname: qua-lon\ndescription: Skill qua lon de doc.\n---\n# Qua lon\n\n${'x'.repeat(MAX_SKILL_TEXT_CHARS)}\n`;
  fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), big, 'utf8');
  registry.load();
  assert.equal(registry.get('qua-lon')?.name, 'qua-lon', 'oversize skill still lists (tier 1)');
  assert.throws(() => registry.readSkillText('qua-lon'), SkillLoadError);
});

// ---------------------------------------------------------------------------
// installSkill: bad names (fail-closed, nothing written)
// ---------------------------------------------------------------------------

for (const badName of ['', '../evil', '..\\evil', '/abs', 'a/b', 'a\\b', 'UPPER', 'has space', '-lead', 'a'.repeat(65)]) {
  test(`installSkill rejects bad name ${JSON.stringify(badName)} and writes nothing`, () => {
    const dir = makeTempDir();
    const registry = makeRegistry(dir);
    assert.throws(() => registry.installSkill(badName, VALID_SKILL), SkillLoadError);
    assert.equal(fs.existsSync(path.join(dir, 'skills')), false, 'no skills dir created');
  });
}

test('installSkill rejects a builtin name (no overwriting builtins)', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  for (const builtin of ['code-review', 'research-brief', 'writing-vi']) {
    assert.throws(() => registry.installSkill(builtin, VALID_SKILL), SkillLoadError);
  }
  assert.equal(fs.existsSync(path.join(dir, 'skills')), false, 'no skills dir created');
});

test('installSkill rejects content whose frontmatter name differs from the install name', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  assert.throws(
    () => registry.installSkill('ten-khac', VALID_SKILL),
    /khớp nhau/,
    'name mismatch must be rejected with a clear message',
  );
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'ten-khac')), false);
});

// ---------------------------------------------------------------------------
// installSkill: bad content (fail-closed, nothing written)
// ---------------------------------------------------------------------------

test('installSkill rejects content with no frontmatter / no description / empty body', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  const badContents = [
    '# Khong co frontmatter\n\nChi co body.',
    `---\nname: ghi-chep-nhanh\n---\n# Body\n\nCo body nhung thieu mo ta.\n`,
    `---\nname: ghi-chep-nhanh\ndescription: Co mo ta.\n---\n`,
    '',
    '   ',
  ];
  for (const content of badContents) {
    assert.throws(() => registry.installSkill('ghi-chep-nhanh', content), SkillLoadError);
  }
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'ghi-chep-nhanh')), false);
});

test('installSkill rejects content that looks like a secret', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  const withSecret = `---
name: ghi-chep-nhanh
description: Ghi nhanh y tuong.
---
# Ghi chep nhanh

api_key: "abcdefghij1234567890"
`;
  assert.throws(() => registry.installSkill('ghi-chep-nhanh', withSecret), SkillLoadError);
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'ghi-chep-nhanh')), false);
});

test('installSkill rejects content larger than the cap', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  const big = `---\nname: ghi-chep-nhanh\ndescription: Ghi nhanh.\n---\n# Lon\n\n${'x'.repeat(MAX_SKILL_TEXT_CHARS)}\n`;
  assert.throws(() => registry.installSkill('ghi-chep-nhanh', big), SkillLoadError);
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'ghi-chep-nhanh')), false);
});

// ---------------------------------------------------------------------------
// installSkill: happy path + no-overwrite + atomic write
// ---------------------------------------------------------------------------

test('installSkill writes <skillsDir>/<name>/SKILL.md and the skill loads back as a user skill', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  const installed = registry.installSkill('ghi-chep-nhanh', VALID_SKILL);
  assert.equal(installed.name, 'ghi-chep-nhanh');
  assert.equal(installed.source, 'user');
  assert.equal(installed.description, 'Ghi nhanh y tuong khi dang lam viec.');
  const file = path.join(dir, 'skills', 'ghi-chep-nhanh', 'SKILL.md');
  assert.equal(fs.readFileSync(file, 'utf8'), VALID_SKILL, 'file content is exactly the pasted text');
  // No temp file left behind.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills', 'ghi-chep-nhanh')), ['SKILL.md']);
  // A fresh registry over the same dir loads it too.
  const fresh = makeRegistry(dir);
  assert.equal(fresh.get('ghi-chep-nhanh')?.source, 'user');
  assert.equal(fresh.readSkillText('ghi-chep-nhanh'), VALID_SKILL);
});

test('installSkill rejects a duplicate name and leaves the original file untouched', () => {
  const dir = makeTempDir();
  const registry = makeRegistry(dir);
  registry.installSkill('ghi-chep-nhanh', VALID_SKILL);
  const other = VALID_SKILL.replace('Ghi nhanh y tuong', 'Noi dung khac');
  assert.throws(() => registry.installSkill('ghi-chep-nhanh', other), SkillLoadError);
  assert.equal(
    fs.readFileSync(path.join(dir, 'skills', 'ghi-chep-nhanh', 'SKILL.md'), 'utf8'),
    VALID_SKILL,
    'original file untouched by the rejected install',
  );
});

test('installSkill throws when there is no user skills directory configured', () => {
  const registry = new SkillRegistry({});
  registry.load();
  assert.throws(() => registry.installSkill('ghi-chep-nhanh', VALID_SKILL), SkillLoadError);
});
