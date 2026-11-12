/**
 * Tests for v0.7 long-term memory: remember/recall/forget,
 * team_context_summary, transcript_archive round-trip (archive -> load
 * -> search) on temp directories.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v07.test.mjs
 *
 * No network, no real tokens. Memories live in a JSON file
 * (.open-bot/memories.json) — see packages/core/src/memory/longterm.ts
 * for why not SQLite (BotMemory.db is private; memory.ts must not be
 * edited by this task).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BotMemory } from '../packages/core/dist/agent/memory.js';
import {
  LongTermMemory,
  archiveTranscript,
  loadTranscriptArchive,
  searchTranscriptArchive,
  teamContextSummary,
} from '../packages/core/dist/memory/longterm.js';
import {
  INTEGRATION_TOOLS,
  createIntegrationTools,
} from '../packages/tools/dist/integrationTools.js';

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memory-v07-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = (workspaceDir, botId = 'bot-a') => ({ workspaceDir, botId });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);

// --- LongTermMemory core ----------------------------------------------------

test('LongTermMemory core: remember/recall by keyword+tag/forget, overwrite keeps id', () => {
  const dir = makeTempWorkspace();
  const store = new LongTermMemory(dir);

  const first = store.remember({
    key: 'user.prefers_language',
    value: 'Tiếng Việt',
    tags: ['preference', 'language'],
    confidence: 0.9,
    botId: 'bot-a',
  });
  store.remember({ key: 'project.stack', value: 'Node + TypeScript', tags: ['project'], botId: 'bot-a' });
  store.remember({ key: 'shared.note', value: 'Team standup lúc 9h sáng', tags: ['team'], botId: '' });

  // File is JSON, mode 0600, no SQLite involved.
  const filePath = path.join(dir, '.open-bot', 'memories.json');
  assert.ok(fs.existsSync(filePath));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).version, 1);

  // Keyword recall ranks the matching entry first.
  const hits = store.recall({ query: 'tiếng việt', botId: 'bot-a' });
  assert.equal(hits[0].key, 'user.prefers_language');
  // Tag filter.
  assert.deepEqual(
    store.recall({ tag: 'project' }).map((e) => e.key),
    ['project.stack'],
  );
  // Bot-scoped recall does not leak another bot's memories.
  assert.equal(store.recall({ botId: 'bot-b' }).length, 0);
  // Shared (botId '') memories are visible via list() unfiltered.
  assert.equal(store.list().length, 3);

  // Overwrite same (botId, key): value updates, id + createdAt kept.
  const updated = store.remember({ key: 'user.prefers_language', value: 'English', botId: 'bot-a' });
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.value, 'English');
  assert.equal(store.list().length, 3);

  // Forget: true when deleted, false when absent; list shrinks.
  assert.equal(store.forget('project.stack', 'bot-a'), true);
  assert.equal(store.forget('project.stack', 'bot-a'), false);
  assert.equal(store.list().length, 2);

  // Validation errors.
  assert.throws(() => store.remember({ key: '', value: 'x' }), /key must not be empty/);
  assert.throws(() => store.remember({ key: 'k', value: '   ' }), /value must not be empty/);
  // Confidence clamps to 0..1.
  assert.equal(store.remember({ key: 'c', value: 'v', confidence: 5 }).confidence, 1);
  assert.equal(store.remember({ key: 'c2', value: 'v', confidence: -1 }).confidence, 0);
});

// --- Memory tools ------------------------------------------------------------

test('memory tools: remember/recall/forget end to end (bot-scoped + shared)', async () => {
  const dir = makeTempWorkspace();
  const tools = createIntegrationTools();
  const ctx = CTX(dir, 'bot-a');

  const remembered = await tool(tools, 'memory_remember').execute(
    { key: 'user.timezone', value: 'Asia/Ho_Chi_Minh', tags: ['preference'], confidence: 0.95 },
    ctx,
  );
  assert.match(remembered, /Remembered "user.timezone" \(confidence 0\.95/);

  const recalled = await tool(tools, 'memory_recall').execute({ query: 'Ho_Chi_Minh' }, ctx);
  assert.match(recalled, /user\.timezone: Asia\/Ho_Chi_Minh/);

  const forgotten = await tool(tools, 'memory_forget').execute({ key: 'user.timezone' }, ctx);
  assert.match(forgotten, /Forgot memory "user\.timezone"/);
  const afterForget = await tool(tools, 'memory_recall').execute({ query: 'Ho_Chi_Minh' }, ctx);
  assert.match(afterForget, /no matching long-term memories/);

  const missing = await tool(tools, 'memory_forget').execute({ key: 'nope' }, ctx);
  assert.match(missing, /nothing forgotten/);
});

// --- Team context summary ----------------------------------------------------

test('team_context_summary: memories + tasks + recent history saved to a markdown file', async () => {
  const dir = makeTempWorkspace();
  const memory = new BotMemory(dir);
  try {
    memory.saveMessage('bot-a', 'user', 'Hãy nhớ: team họp standup 9h sáng thứ Hai');
    memory.saveMessage('bot-a', 'assistant', 'Đã ghi nhớ lịch standup.');
    memory.createTask('bot-a', 'Viết báo cáo tuần', 'report');
    memory.createTask('bot-b', 'Review pull request #12', 'review');

    const tools = createIntegrationTools({ memory });
    await tool(tools, 'memory_remember').execute(
      { key: 'team.standup', value: 'Standup 9h sáng thứ Hai', tags: ['team'] },
      CTX(dir, 'bot-a'),
    );
    const out = await tool(tools, 'team_context_summary').execute(
      { team_id: 'team-x', bot_ids: ['bot-a', 'bot-b'] },
      CTX(dir, 'bot-a'),
    );
    assert.match(out, /team-x-/);
    assert.match(out, /1 memor/);

    // The summary file itself exists and contains memories + tasks.
    const summaryDir = path.join(dir, '.open-bot', 'team-context');
    const files = fs.readdirSync(summaryDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^team-x-\d{4}-\d{2}-\d{2}\.md$/);
    const content = fs.readFileSync(path.join(summaryDir, files[0]), 'utf8');
    assert.match(content, /# Team context — team-x/);
    assert.match(content, /Viết báo cáo tuần/);
    assert.match(content, /Review pull request #12/);
    assert.match(content, /standup 9h/);
  } finally {
    memory.close();
  }
});

test('teamContextSummary core without BotMemory: memories only, tasks skipped note', () => {
  const dir = makeTempWorkspace();
  const store = new LongTermMemory(dir);
  store.remember({ key: 'shared.note', value: 'Standup 9h', tags: ['team'], botId: '' });
  const result = teamContextSummary({ workspaceDir: dir, botIds: ['bot-a'], teamId: 'solo' });
  assert.match(result.content, /Standup 9h/);
  assert.match(result.content, /no BotMemory provided/);
  assert.ok(fs.existsSync(result.path));
  assert.equal(result.memoryCount, 1);
  assert.equal(result.botCount, 1);
});

// --- Transcript archive round-trip -------------------------------------------

test('transcript_archive round-trip: archive -> load -> search (real BotMemory history)', async () => {
  const dir = makeTempWorkspace();
  const memory = new BotMemory(dir);
  try {
    memory.saveMessage('bot-a', 'user', 'Hello, please explain the quarterly plan');
    memory.saveMessage('bot-a', 'assistant', 'The quarterly plan focuses on growth and retention.');
    memory.saveMessage('bot-a', 'user', 'Thanks, also remind me about the deploy deadline');

    const tools = createIntegrationTools({ memory });
    const archived = await tool(tools, 'transcript_archive').execute({}, CTX(dir, 'bot-a'));
    assert.match(archived, /Archived 3 message\(s\) of bot "bot-a"/);
    const relMatch = /to (\S+\.jsonl)/.exec(archived);
    assert.ok(relMatch, 'archive output carries the file path');
    const archivePath = path.join(dir, relMatch[1]);

    // Core load: JSONL parses back to the same 3 messages in order.
    const loaded = loadTranscriptArchive(archivePath);
    assert.equal(loaded.length, 3);
    assert.equal(loaded[0].role, 'user');
    assert.match(loaded[0].content, /quarterly plan/);
    assert.equal(loaded[1].role, 'assistant');
    assert.equal(loaded[2].index, 2);

    // Core search: keyword filter.
    assert.equal(searchTranscriptArchive(archivePath, 'deploy deadline').length, 1);
    assert.equal(searchTranscriptArchive(archivePath, 'nonexistent phrase').length, 0);

    // Tool search path: archive_file + query.
    const searched = await tool(tools, 'transcript_archive').execute(
      { archive_file: relMatch[1], query: 'quarterly' },
      CTX(dir, 'bot-a'),
    );
    assert.match(searched, /2 message\(s\) matching "quarterly"/);
    const listed = await tool(tools, 'transcript_archive').execute(
      { archive_file: relMatch[1] },
      CTX(dir, 'bot-a'),
    );
    assert.match(listed, /3 message\(s\)/);
  } finally {
    memory.close();
  }
});

test('archiveTranscript core: empty history still writes a valid (empty) JSONL file', () => {
  const dir = makeTempWorkspace();
  const memory = new BotMemory(dir);
  try {
    const result = archiveTranscript({ workspaceDir: dir, botId: 'bot-empty', memory });
    assert.equal(result.count, 0);
    assert.ok(fs.existsSync(result.path));
    assert.equal(loadTranscriptArchive(result.path).length, 0);
  } finally {
    memory.close();
  }
});

test('transcript_archive without BotMemory: clear error, not a crash', async () => {
  const dir = makeTempWorkspace();
  const tools = createIntegrationTools();
  const out = await tool(tools, 'transcript_archive').execute({}, CTX(dir, 'bot-a'));
  assert.match(out, /Error: transcript_archive needs a BotMemory/);
});
