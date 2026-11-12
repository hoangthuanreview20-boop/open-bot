/**
 * Tests for P0-1 (Agent Skills standard) at the coordinator run path:
 * progressive disclosure tiers 1–2 in the REAL system prompt the model
 * sees, and `allowed-tools` respected by the tool filter on a real run.
 *
 * The mock provider records every ChatCompletionRequest to a JSONL file
 * (`mockRecordPath`, v0.25) — the test reads that file back and inspects
 * the system prompt + tool definitions of the first chat call.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-coordinator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skills-coord-'));
  tmpDirs.push(dir);
  return dir;
}

function botConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

/** First ChatCompletionRequest recorded by the mock provider. */
function firstRecord(recordPath) {
  const lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'mock provider phải ghi ít nhất 1 request');
  return JSON.parse(lines[0]);
}

function systemPromptOf(req) {
  const sys = req.messages.find((m) => m.role === 'system');
  assert.ok(sys, 'request phải có message system');
  return sys.content;
}

function toolNamesOf(req) {
  return (req.tools ?? []).map((t) => t.name);
}

let client;
test.before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

test.after(async () => {
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function createBotWithRecord(botId) {
  const ws = tmpDir();
  const recordPath = path.join(ws, 'mock-record.jsonl');
  await client.createBot({
    bot: botConfig(botId, ws),
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [{ text: 'ok' }],
      mockRecordPath: recordPath,
    },
    skillsDirs: {
      userSkillsDir: path.join(ws, 'skills'),
      pluginsDir: path.join(ws, 'plugins'),
      stateDir: ws,
    },
  });
  return { ws, recordPath };
}

// Body markers — text that ONLY appears in one built-in skill's body.
const BODY_MARKERS = {
  'code-review': 'Read the changed files',
  'research-brief': 'TL;DR',
  'writing-vi': 'Sound like a person',
};

test('tier 1 + tier 2 in the run path: index lists every skill, only the matched body is injected', async () => {
  const { recordPath } = await createBotWithRecord('skills-coord-tiered');
  try {
    const res = await client.run('skills-coord-tiered', 'review code trong pull request này giúp tôi');
    assert.equal(res.text, 'ok');

    const prompt = systemPromptOf(firstRecord(recordPath));
    // Tier 1 — the index: name + description of every enabled skill,
    // no body text. The model sees this on EVERY run (~100 token/skill).
    assert.match(prompt, /Available skills \(invoke by name when the task matches/);
    assert.match(prompt, /- code-review: Review code changes for bugs, security issues and style\./);
    assert.match(prompt, /- research-brief: Research a topic and write a short sourced brief\./);
    assert.match(prompt, /- writing-vi: Write and edit Vietnamese text that reads naturally\./);
    // Tier 2 — only the matched skill's body is loaded into the prompt.
    assert.match(prompt, new RegExp(BODY_MARKERS['code-review']), 'matched skill body must be injected');
    assert.doesNotMatch(prompt, new RegExp(BODY_MARKERS['research-brief']), 'unmatched skill body must stay out');
    assert.doesNotMatch(prompt, new RegExp(BODY_MARKERS['writing-vi']), 'unmatched skill body must stay out');
  } finally {
    await client.destroyBot('skills-coord-tiered');
  }
});

test('allowed-tools is respected by the tool filter on a real run (matched skill narrows the tools sent)', async () => {
  const { recordPath } = await createBotWithRecord('skills-coord-tools');
  try {
    // Query matches ONLY code-review (verified by direct measurement:
    // matchSkills returns [code-review] only — 'bugs' appears in no
    // other built-in skill's matchable text). The generic 'review code'
    // query now matches code-review + git-workflow + test-writing, whose
    // union allowlist is covered by the next test instead.
    const res = await client.run('skills-coord-tools', 'tìm bugs giúp tôi');
    assert.equal(res.text, 'ok');

    const names = toolNamesOf(firstRecord(recordPath));
    // code-review allows [read_file, grep_search, git_diff]; the filter
    // keeps those + the essential comms tools (grouped as one `comms`
    // dispatcher by groupTools). Nothing else may reach the model.
    assert.ok(names.includes('read_file'), `tools sent must include read_file, got: ${names.join(', ')}`);
    assert.ok(names.includes('grep_search'), `tools sent must include grep_search, got: ${names.join(', ')}`);
    assert.ok(names.includes('git_diff'), `tools sent must include git_diff, got: ${names.join(', ')}`);
    for (const banned of ['write_file', 'delete_file', 'shell_exec', 'web_search', 'web_fetch', 'grep']) {
      assert.ok(!names.includes(banned), `tools sent must NOT include ${banned}, got: ${names.join(', ')}`);
    }
    assert.ok(names.length <= 8, `matched-skill run should send few tools, got ${names.length}: ${names.join(', ')}`);
  } finally {
    await client.destroyBot('skills-coord-tools');
  }
});

test('multi-skill match: tool filter sends the union of matched skills allowlists (grouped)', async () => {
  const { recordPath } = await createBotWithRecord('skills-coord-union');
  try {
    // 'review code trong pull request này giúp tôi' matches code-review
    // (39) + git-workflow (10) + test-writing (5): the filter sends the
    // UNION of their allowlists — read_file/write_file/grep_search/
    // git_diff/git_status/git_commit/shell_exec — grouped by groupTools
    // (file = read_file+write_file, git = git_*). Nothing outside the
    // union may reach the model.
    const res = await client.run('skills-coord-union', 'review code trong pull request này giúp tôi');
    assert.equal(res.text, 'ok');

    const names = toolNamesOf(firstRecord(recordPath));
    for (const expected of ['file', 'git', 'grep_search', 'shell_exec', 'comms']) {
      assert.ok(names.includes(expected), `union run must include ${expected}, got: ${names.join(', ')}`);
    }
    for (const banned of ['web_search', 'web_fetch', 'delete_file']) {
      assert.ok(!names.includes(banned), `union run must NOT include ${banned}, got: ${names.join(', ')}`);
    }
    // Grouped away: the raw member names must not appear beside their dispatcher.
    for (const grouped of ['read_file', 'write_file', 'git_diff', 'git_status', 'git_commit']) {
      assert.ok(!names.includes(grouped), `union run must NOT include raw ${grouped}, got: ${names.join(', ')}`);
    }
  } finally {
    await client.destroyBot('skills-coord-union');
  }
});

test('no skill match: tier-1 index is still there, no body is injected, full tools stay available', async () => {
  const { recordPath } = await createBotWithRecord('skills-coord-nomatch');
  try {
    const res = await client.run('skills-coord-nomatch', 'xin chào, hôm nay thế nào?');
    assert.equal(res.text, 'ok');

    const req = firstRecord(recordPath);
    const prompt = systemPromptOf(req);
    // Tier 1 is unconditional: the model always knows the skills exist.
    assert.match(prompt, /Available skills \(invoke by name when the task matches/);
    assert.match(prompt, /- code-review: Review code changes/);
    for (const marker of Object.values(BODY_MARKERS)) {
      assert.doesNotMatch(prompt, new RegExp(marker), `no skill body may leak when nothing matches (${marker})`);
    }
    // No skill matched → no skill filter → write tools stay reachable
    // (inside the `file` group dispatcher, whose description lists them).
    const toolText = (req.tools ?? []).map((t) => `${t.name} ${t.description}`).join('\n');
    assert.match(toolText, /write_file/, 'without a matched skill, write_file must stay available');
  } finally {
    await client.destroyBot('skills-coord-nomatch');
  }
});
