/**
 * ci-v07.test.mjs — CI investigation, bug reports, AI attribution,
 * agent export/import round-trip (v0.7).
 * BotMemory + CanvasStore are REAL (temp workspace); the CI log URL
 * uses a mock fetch. No live x.ai, no network.
 * Run: node --test tests/ci-v07.test.mjs (after building core + tools)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { CanvasStore } from '../packages/core/dist/canvas/store.js';
import {
  AGENT_BUNDLE_VERSION,
  computeBundleChecksum,
  exportAgentData,
  importAgentData,
  parseAgentBundleJson,
  validateAgentBundle,
} from '../packages/core/dist/agent/export.js';
import {
  CI_TOOLS,
  createCiTools,
  guessFailureCause,
  pickErrorLines,
} from '../packages/tools/dist/ciTools.js';
import {
  AGENT_DATA_TOOLS,
  createAgentDataTools,
} from '../packages/tools/dist/agentDataTools.js';

const ctx = (dir, botId = 'test-bot') => ({ workspaceDir: dir, botId });
const toolByName = (tools, name) => tools.find((t) => t.definition.name === name);

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-ci-v07-'));
}

function seedBot(memory, botId) {
  memory.saveBot({
    id: botId,
    name: 'Seed Bot',
    providerId: 'ollama',
    model: 'qwen2.5:0.5b',
    systemPrompt: 'You are a test bot.',
  });
  memory.saveMessage(botId, 'user', 'hello');
  memory.saveMessage(botId, 'assistant', 'hi there');
  const taskId = memory.createTask(botId, 'Write docs', 'docs');
  memory.updateTask(taskId, 'done');
  memory.createTask(botId, 'Review PR', '');
  const goalId = memory.createGoal(botId, 'Ship v0.7', 'the v0.7 milestone');
  memory.updateGoal(goalId, { status: 'done' });
  const todoId = memory.createTodo(botId, 'Buy milk');
  memory.updateTodo(todoId, { done: true });
  const projectId = memory.createProject(botId, 'open-bot', 'the agent');
  memory.setProjectUpdates(projectId, true);
  memory.setMemory(botId, 'pref:lang', 'vi');
  memory.setMemory(botId, 'note', 'likes short answers');
}

const MEMORIES = [
  { key: 'pref:lang', value: 'vi' },
  { key: 'note', value: 'likes short answers' },
];

// ---------------------------------------------------------------------------
// CI investigate (pure helpers + tool)
// ---------------------------------------------------------------------------

test('ci: pickErrorLines + guessFailureCause classify OOM / timeout / missing module', () => {
  const oom = pickErrorLines('ok\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nmore\n');
  assert.ok(oom.length >= 1);
  assert.match(guessFailureCause(oom).cause, /out-of-memory/i);

  const timeout = pickErrorLines('running tests...\nError: test timed out after 5000ms\n');
  assert.match(guessFailureCause(timeout).cause, /timeout/i);

  const missing = pickErrorLines("Error: Cannot find module './nope'\n    at loader\n");
  assert.match(guessFailureCause(missing).cause, /missing file or dependency/i);

  const empty = guessFailureCause([]);
  assert.match(empty.cause, /No clear error line/);
});

test('ci_investigate: reads a workspace log file, guesses the cause, writes the record', async () => {
  const dir = makeWorkspace();
  const logPath = path.join(dir, 'ci.log');
  fs.writeFileSync(
    logPath,
    [
      'npm test',
      '  12 passing',
      '  1 failing',
      '  1) renders the widget:',
      '     AssertionError: expected 2 to equal 3',
      'npm ERR! Test failed. See above for more details.',
      'Error: Process completed with exit code 1.',
      '',
    ].join('\n'),
    'utf8',
  );
  const tools = createCiTools();
  assert.equal(toolByName(tools, 'ci_investigate').needsApproval, false);
  const out = await toolByName(tools, 'ci_investigate').execute(
    { source: 'ci.log', id: 'inv-1' },
    ctx(dir),
  );
  assert.match(out, /CI investigation inv-1 recorded/);
  assert.match(out, /AssertionError/);
  assert.match(out, /exit code 1/);
  const record = JSON.parse(
    fs.readFileSync(path.join(dir, '.open-bot', 'ci-investigations', 'inv-1.json'), 'utf8'),
  );
  assert.equal(record.id, 'inv-1');
  assert.equal(record.sourceKind, 'file');
  assert.ok(record.findings.length >= 2);
  assert.ok(typeof record.suspectedCause === 'string' && record.suspectedCause.length > 0);
  assert.ok(Array.isArray(record.suggestedNextSteps) && record.suggestedNextSteps.length > 0);
});

test('ci_investigate: fetches a log from a URL via mock fetch; missing file -> error string', async () => {
  const dir = makeWorkspace();
  const fetchFn = async (url) => {
    assert.match(url, /example\.com\/ci\.log/);
    return new Response('FATAL ERROR: JavaScript heap out of memory\n', { status: 200 });
  };
  const tools = createCiTools({ fetchFn });
  const out = await toolByName(tools, 'ci_investigate').execute(
    { source: 'https://example.com/ci.log', id: 'inv-url' },
    ctx(dir),
  );
  assert.match(out, /out-of-memory/i);

  const missing = await toolByName(tools, 'ci_investigate').execute(
    { source: 'no-such.log' },
    ctx(dir),
  );
  assert.match(missing, /^Error: Cannot read CI log file/);
});

// ---------------------------------------------------------------------------
// bug_report / bug_fix_report / ai_attribution
// ---------------------------------------------------------------------------

test('bug_report + bug_fix_report: structured files; fix marks the bug fixed', async () => {
  const dir = makeWorkspace();
  const tools = createCiTools();
  assert.equal(toolByName(tools, 'bug_report').needsApproval, true);
  assert.equal(toolByName(tools, 'bug_fix_report').needsApproval, true);

  const created = await toolByName(tools, 'bug_report').execute(
    {
      id: 'bug-1',
      title: 'Chat crashes on empty message',
      description: 'Sending an empty message crashes the renderer.',
      severity: 'high',
      steps: ['Open chat', 'Send empty message'],
      labels: ['crash', 'chat'],
      log: 'TypeError: Cannot read properties of undefined',
    },
    ctx(dir),
  );
  assert.match(created, /Bug report bug-1 saved/);
  const report = JSON.parse(
    fs.readFileSync(path.join(dir, '.open-bot', 'bug-reports', 'bug-1.json'), 'utf8'),
  );
  assert.equal(report.status, 'open');
  assert.equal(report.severity, 'high');
  assert.deepEqual(report.steps, ['Open chat', 'Send empty message']);
  assert.match(report.logExcerpt, /TypeError/);

  const fixed = await toolByName(tools, 'bug_fix_report').execute(
    {
      bugId: 'bug-1',
      summary: 'Guarded the empty-message path in the renderer.',
      changes: ['apps/desktop/src/chat.ts'],
      testsRun: ['npm test'],
      result: 'fixed',
    },
    ctx(dir),
  );
  assert.match(fixed, /Bug fix report .* saved/);
  assert.match(fixed, /marked fixed/);
  const updated = JSON.parse(
    fs.readFileSync(path.join(dir, '.open-bot', 'bug-reports', 'bug-1.json'), 'utf8'),
  );
  assert.equal(updated.status, 'fixed');
  assert.ok(updated.fixReportId);
  const fixFile = JSON.parse(
    fs.readFileSync(path.join(dir, '.open-bot', 'bug-reports', 'bug-1.fix.json'), 'utf8'),
  );
  assert.equal(fixFile.result, 'fixed');
  assert.deepEqual(fixFile.testsRun, ['npm test']);

  const badSeverity = await toolByName(tools, 'bug_report').execute(
    { title: 'x', description: 'y', severity: 'huge' },
    ctx(dir),
  );
  assert.match(badSeverity, /Invalid "severity"/);
});

test('ai_attribution: appends entries; refuses without a model (never invents a source)', async () => {
  const dir = makeWorkspace();
  const tools = createCiTools();
  assert.equal(toolByName(tools, 'ai_attribution').needsApproval, true);

  const first = await toolByName(tools, 'ai_attribution').execute(
    {
      file: 'src/a.ts',
      model: 'grok-4.7',
      promptSummary: 'Add the OAuth callback listener',
      changeSummary: 'New oauth.ts module',
    },
    ctx(dir),
  );
  assert.match(first, /AI attribution recorded/);
  const second = await toolByName(tools, 'ai_attribution').execute(
    { file: 'src/b.ts', model: 'gpt-5', promptSummary: 'Fix the test' },
    ctx(dir),
  );
  assert.match(second, /AI attribution recorded/);
  const entries = JSON.parse(
    fs.readFileSync(path.join(dir, '.open-bot', 'attribution.json'), 'utf8'),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].model, 'grok-4.7');
  assert.equal(entries[1].file, 'src/b.ts');
  assert.ok(entries.every((e) => typeof e.recordedAt === 'string'));

  const noModel = await toolByName(tools, 'ai_attribution').execute(
    { file: 'src/c.ts', model: '  ' },
    ctx(dir),
  );
  assert.match(noModel, /never guessed or invented/);
});

test('ci tools: exports 4 tools', () => {
  const names = CI_TOOLS.map((t) => t.definition.name).sort();
  assert.deepEqual(names, ['ai_attribution', 'bug_fix_report', 'bug_report', 'ci_investigate']);
});

// ---------------------------------------------------------------------------
// Agent export / import round-trip (real BotMemory + CanvasStore)
// ---------------------------------------------------------------------------

test('agent export/import: round-trip through real BotMemory + CanvasStore', async () => {
  const dir = makeWorkspace();
  const mem = new BotMemory(dir);
  try {
    seedBot(mem, 'bot-1');
    const canvas = new CanvasStore(dir, 'bot-1');
    const doc = await canvas.create('My canvas', [{ type: 'text', text: 'hello canvas' }]);

    const bundle = await exportAgentData({ memory: mem, botId: 'bot-1', workspaceDir: dir, memories: MEMORIES });
    assert.equal(bundle.kind, 'open-bot-agent-bundle');
    assert.equal(bundle.version, AGENT_BUNDLE_VERSION);
    assert.equal(bundle.botId, 'bot-1');
    assert.equal(bundle.checksum, computeBundleChecksum(bundle.data));
    assert.equal(bundle.data.history.length, 2);
    assert.equal(bundle.data.history[0].content, 'hello');
    assert.equal(bundle.data.tasks.length, 2);
    assert.equal(bundle.data.memories.length, 2);
    assert.equal(bundle.data.canvases.length, 1);
    assert.equal(bundle.data.canvases[0].id, doc.id);

    // Validate + parse from JSON text.
    const reparsed = parseAgentBundleJson(JSON.stringify(bundle));
    assert.equal(reparsed.botId, 'bot-1');
    assert.deepEqual(validateAgentBundle(bundle), bundle);

    // Import into a FRESH workspace.
    const dir2 = makeWorkspace();
    const mem2 = new BotMemory(dir2);
    try {
      const result = await importAgentData({ memory: mem2, workspaceDir: dir2, bundle });
      assert.equal(result.botId, 'bot-1');
      assert.equal(result.counts.history, 2);
      assert.equal(result.counts.tasks, 2);
      assert.equal(result.counts.canvases, 1);
      const bot = mem2.getBot('bot-1');
      assert.equal(bot.name, 'Seed Bot');
      assert.equal(bot.model, 'qwen2.5:0.5b');
      const history = mem2.getHistory('bot-1', 10);
      assert.deepEqual(
        history.map((m) => m.content),
        ['hello', 'hi there'],
      );
      const tasks = mem2.listTasks('bot-1');
      assert.deepEqual(
        tasks.map((t) => t.title).sort(),
        ['Review PR', 'Write docs'],
      );
      assert.equal(tasks.find((t) => t.title === 'Write docs').status, 'done');
      assert.equal(mem2.getMemory('bot-1', 'pref:lang'), 'vi');
      assert.equal(mem2.listGoals('bot-1')[0].status, 'done');
      assert.equal(mem2.listTodos('bot-1')[0].done, true);
      assert.equal(mem2.listProjects('bot-1')[0].updatesEnabled, true);
      const canvas2 = new CanvasStore(dir2, 'bot-1');
      const importedDoc = await canvas2.read(doc.id);
      assert.equal(importedDoc.title, 'My canvas');
      assert.equal(importedDoc.blocks[0].text, 'hello canvas');

      // Second import, same id, no overwrite -> refused.
      await assert.rejects(
        () => importAgentData({ memory: mem2, workspaceDir: dir2, bundle }),
        /already exists/,
      );
      // With overwrite it succeeds (config replaced; history appends — documented).
      const again = await importAgentData({ memory: mem2, workspaceDir: dir2, bundle, overwrite: true });
      assert.equal(again.overwritten, true);
      assert.equal(mem2.getBot('bot-1').name, 'Seed Bot');

      // Import under a new id.
      const renamed = await importAgentData({
        memory: mem2,
        workspaceDir: dir2,
        bundle,
        newBotId: 'bot-1-copy',
      });
      assert.equal(renamed.botId, 'bot-1-copy');
      assert.equal(mem2.getBot('bot-1-copy').name, 'Seed Bot');
    } finally {
      mem2.close();
    }
  } finally {
    mem.close();
  }
});

test('agent bundle: tampered data fails checksum; unknown version fails; unknown bot fails export', async () => {
  const dir = makeWorkspace();
  const mem = new BotMemory(dir);
  try {
    seedBot(mem, 'bot-1');
    const bundle = await exportAgentData({ memory: mem, botId: 'bot-1', workspaceDir: dir });
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.data.history.push({ role: 'user', content: 'injected' });
    assert.throws(() => validateAgentBundle(tampered), /checksum mismatch/);
    assert.throws(
      () => validateAgentBundle({ ...bundle, version: 99 }),
      /Unsupported agent bundle version/,
    );
    assert.throws(() => parseAgentBundleJson('{not json'), /not valid JSON/);
    await assert.rejects(
      () => exportAgentData({ memory: mem, botId: 'ghost', workspaceDir: dir }),
      /no bot with id "ghost"/,
    );
  } finally {
    mem.close();
  }
});

test('agent_export/agent_import tools: file round-trip between two workspaces', async () => {
  const dir1 = makeWorkspace();
  const dir2 = makeWorkspace();
  const mem1 = new BotMemory(dir1);
  const mem2 = new BotMemory(dir2);
  try {
    seedBot(mem1, 'bot-9');
    const tools1 = createAgentDataTools({ memory: mem1, listMemories: () => MEMORIES });
    assert.equal(toolByName(tools1, 'agent_export').needsApproval, false);
    assert.equal(toolByName(tools1, 'agent_import').needsApproval, true);

    const exported = await toolByName(tools1, 'agent_export').execute({}, ctx(dir1, 'bot-9'));
    assert.match(exported, /exported to \.open-bot\/exports\/agent-bot-9-/);
    assert.match(exported, /2 message\(s\)/);
    assert.match(exported, /LOCAL equivalent of cloud agent data/);
    const bundleRel = exported.match(/exported to (\S+)\./)[1];
    const bundlePath1 = path.join(dir1, bundleRel);
    assert.ok(fs.existsSync(bundlePath1));

    // The bundle file is what moves between machines: copy it into ws2.
    const bundleRel2 = '.open-bot/exports/imported-bot-9.json';
    fs.mkdirSync(path.dirname(path.join(dir2, bundleRel2)), { recursive: true });
    fs.copyFileSync(bundlePath1, path.join(dir2, bundleRel2));

    const tools2 = createAgentDataTools({ memory: mem2 });
    const imported = await toolByName(tools2, 'agent_import').execute(
      { bundlePath: bundleRel2 },
      ctx(dir2, 'other-bot'),
    );
    assert.match(imported, /imported as bot "Seed Bot" \(id bot-9\)/);
    assert.equal(mem2.getBot('bot-9').providerId, 'ollama');
    assert.equal(mem2.getHistory('bot-9', 10).length, 2);

    // Importing again without overwrite is refused by the tool too.
    const refused = await toolByName(tools2, 'agent_import').execute(
      { bundlePath: bundleRel2 },
      ctx(dir2, 'other-bot'),
    );
    assert.match(refused, /already exists/);
  } finally {
    mem1.close();
    mem2.close();
  }
});

test('agent data tools: exports 4 tools', () => {
  const names = AGENT_DATA_TOOLS.map((t) => t.definition.name).sort();
  assert.deepEqual(names, ['agent_export', 'agent_import', 'cloud_agent_fetch_data', 'tool_call_replay']);
});
