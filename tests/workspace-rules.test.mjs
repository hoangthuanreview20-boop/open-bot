/**
 * workspace-rules.test.mjs — AGENTS.md workspace (v0.11, P1-6).
 *
 * - loadWorkspaceRules: ưu tiên `.open-bot/AGENTS.md` rồi `AGENTS.md` ở
 *   root; file thiếu/không đọc được thì null (bỏ qua, không throw).
 * - cache theo mtime+size: lần 2 không đổi file trả đúng object đã cache;
 *   đổi file -> đọc lại; clearRulesCache -> đọc lại.
 * - nội dung quá dài bị cắt ở MAX_WORKSPACE_RULES_CHARS (có cờ truncated).
 * - smoke test: coordinator chạy thật (mock provider, không mạng) với
 *   workspace có AGENTS.md — executeRun nối rules vào system prompt mà
 *   không lỗi.
 *
 * Run: npm run build --workspace=@open-bot/core rồi
 *      node --test tests/workspace-rules.test.mjs (dưới xvfb-run khi chạy full)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_WORKSPACE_RULES_CHARS,
  clearRulesCache,
  findRulesFile,
  loadWorkspaceRules,
} from '../packages/core/dist/rules/index.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-rules-'));
}

test('loadWorkspaceRules: file thiếu / thư mục rỗng / workspaceDir rỗng -> null', () => {
  const dir = tmpDir();
  try {
    assert.equal(loadWorkspaceRules(dir), null);
    assert.equal(loadWorkspaceRules(path.join(dir, 'khong-co')), null);
    assert.equal(loadWorkspaceRules(''), null);
    assert.equal(findRulesFile(dir), null);
    assert.equal(findRulesFile(''), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWorkspaceRules: AGENTS.md ở root được nạp', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Quy tắc\n\n- Dùng tiếng Việt.\n', 'utf8');
    const rules = loadWorkspaceRules(dir);
    assert.ok(rules);
    assert.equal(rules.source, 'AGENTS.md');
    assert.equal(rules.path, path.resolve(dir, 'AGENTS.md'));
    assert.match(rules.content, /Dùng tiếng Việt/);
    assert.equal(rules.truncated, false);
    const found = findRulesFile(dir);
    assert.equal(found.source, 'AGENTS.md');
  } finally {
    clearRulesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWorkspaceRules: .open-bot/AGENTS.md ưu tiên hơn AGENTS.md ở root', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'quy tắc root', 'utf8');
    fs.mkdirSync(path.join(dir, '.open-bot'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.open-bot', 'AGENTS.md'), 'quy tắc .open-bot', 'utf8');
    const rules = loadWorkspaceRules(dir);
    assert.ok(rules);
    assert.equal(rules.source, '.open-bot/AGENTS.md');
    assert.match(rules.content, /quy tắc \.open-bot/);
    assert.doesNotMatch(rules.content, /quy tắc root/);
  } finally {
    clearRulesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWorkspaceRules: AGENTS.md là thư mục thì bỏ qua, fallback sang file còn lại', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'AGENTS.md'), { recursive: true });
    assert.equal(loadWorkspaceRules(dir), null);
    fs.mkdirSync(path.join(dir, '.open-bot'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.open-bot', 'AGENTS.md'), 'quy tắc thật', 'utf8');
    assert.match(loadWorkspaceRules(dir).content, /quy tắc thật/);
  } finally {
    clearRulesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWorkspaceRules: cache mtime+size + clearRulesCache', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, 'quy tac A', 'utf8');
    const first = loadWorkspaceRules(dir);
    assert.equal(first.content, 'quy tac A');
    // Không đổi file -> trả đúng object đã cache.
    const second = loadWorkspaceRules(dir);
    assert.equal(second, first);
    // Đổi nội dung (mtime đổi theo) -> đọc lại, object mới.
    fs.writeFileSync(file, 'quy tac B', 'utf8');
    const third = loadWorkspaceRules(dir);
    assert.notEqual(third, first);
    assert.equal(third.content, 'quy tac B');
    // forceRefresh cũng đọc lại.
    const fourth = loadWorkspaceRules(dir, { forceRefresh: true });
    assert.notEqual(fourth, third);
    assert.equal(fourth.content, 'quy tac B');
    // clearRulesCache -> lần sau đọc lại từ đĩa.
    clearRulesCache();
    const fifth = loadWorkspaceRules(dir);
    assert.notEqual(fifth, fourth);
    assert.equal(fifth.content, 'quy tac B');
  } finally {
    clearRulesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWorkspaceRules: nội dung quá dài bị cắt + cờ truncated', () => {
  const dir = tmpDir();
  try {
    const long = 'x'.repeat(MAX_WORKSPACE_RULES_CHARS + 100);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), long, 'utf8');
    const rules = loadWorkspaceRules(dir);
    assert.ok(rules);
    assert.equal(rules.truncated, true);
    assert.ok(rules.content.length <= MAX_WORKSPACE_RULES_CHARS + 100);
    assert.match(rules.content, /đã rút gọn/);
  } finally {
    clearRulesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator smoke: run với workspace có AGENTS.md không lỗi (mock provider)', async () => {
  const dir = tmpDir();
  const client = new CoordinatorClient();
  try {
    const pong = await client.ping();
    assert.equal(pong.pong, true);
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Quy tắc test\n\n- Trả lời ngắn gọn.\n',
      'utf8',
    );
    const created = await client.createBot({
      bot: {
        id: 'bot-rules',
        name: 'Bot rules',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'You are a test bot.',
        workspaceDir: dir,
        autoApprove: true,
      },
      provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    });
    assert.equal(created.botId, 'bot-rules');
    const result = await client.run('bot-rules', 'chào bạn');
    assert.equal(result.text, 'mock ok');
    assert.equal(result.stopped, false);
  } finally {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
