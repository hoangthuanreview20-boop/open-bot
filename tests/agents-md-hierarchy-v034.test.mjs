/**
 * agents-md-hierarchy-v034.test.mjs — AGENTS.md theo thứ bậc thư mục (v0.34, P1-6).
 *
 * Loader mới `packages/core/src/project/agentsMd.ts`:
 * - thứ bậc: gốc workspace -> ... -> cwd; file cha áp dụng cho con,
 *   file gần thư mục làm việc hơn đứng sau (ưu tiên khi xung đột);
 *   mỗi thư mục tối đa một file (`.open-bot/AGENTS.md` trước `AGENTS.md`).
 * - cache theo mtime+size: không đổi file trả đúng object đã cache;
 *   đổi file / thêm file -> đọc lại; clearAgentsMdCache / forceRefresh.
 * - giới hạn kích thước: mỗi file cắt ở 8000 ký tự (cờ truncated),
 *   tổng gộp cắt ở 16000 ký tự (bỏ section cũ nhất trước, giữ file gần nhất).
 * - bỏ qua: không có file -> null; AGENTS.md là thư mục / file rỗng /
 *   symlink trỏ ra ngoài workspace -> skipped kèm lý do.
 * - nối coordinator thật qua mock provider (mockRecordPath ghi lại
 *   system prompt): AGENTS.md có mặt trong system prompt của run, theo
 *   đúng cwd của run; file đổi thì run mới thấy nội dung mới.
 * - RPC debug `getWorkspaceRules`: xem AGENTS.md đang có hiệu lực
 *   (nội dung gộp + nguồn từng file + file bị bỏ qua/cắt ngắn).
 *
 * Run: npm run build --workspace=@open-bot/core rồi
 *      node --test tests/agents-md-hierarchy-v034.test.mjs (dưới xvfb-run khi chạy full)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENTS_MD_FILENAME,
  MAX_AGENTS_MD_CHARS_PER_FILE,
  MAX_AGENTS_MD_TOTAL_CHARS,
  clearAgentsMdCache,
  findAgentsMdChain,
  loadAgentsMd,
} from '../packages/core/dist/project/agentsMd.js';
import { loadWorkspaceRules, clearRulesCache } from '../packages/core/dist/rules/index.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `open-bot-agentsmd-${tag}-`));
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function cleanup(dir) {
  clearAgentsMdCache();
  clearRulesCache();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- loader

test('loadAgentsMd: không có file / thư mục không tồn tại -> null; workspaceDir rỗng -> throw', () => {
  const dir = tmpDir('none');
  try {
    assert.equal(loadAgentsMd(dir), null);
    assert.equal(loadAgentsMd(path.join(dir, 'khong-co')), null);
    assert.throws(() => loadAgentsMd(''), /workspaceDir/);
  } finally {
    cleanup(dir);
  }
});

test('loadAgentsMd: file ở root được nạp, kèm nguồn + đường dẫn', () => {
  const dir = tmpDir('root');
  try {
    write(dir, 'AGENTS.md', '# Quy tắc\n\n- Dùng tiếng Việt.\n');
    const rules = loadAgentsMd(dir);
    assert.ok(rules);
    assert.equal(rules.sources.length, 1);
    assert.equal(rules.sources[0].relative, 'AGENTS.md');
    assert.equal(rules.sources[0].path, path.resolve(dir, 'AGENTS.md'));
    assert.match(rules.content, /Dùng tiếng Việt/);
    assert.equal(rules.truncated, false);
    assert.deepEqual(rules.truncatedFiles, []);
    assert.deepEqual(rules.skipped, []);
    assert.equal(rules.workspaceDir, path.resolve(dir));
    assert.equal(rules.cwd, path.resolve(dir));
  } finally {
    cleanup(dir);
  }
});

test('findAgentsMdChain + loadAgentsMd: thứ bậc root -> sub -> nested, tổ tiên trước, gần nhất sau', () => {
  const dir = tmpDir('chain');
  try {
    write(dir, 'AGENTS.md', 'quy tac ROOT');
    write(dir, 'sub/AGENTS.md', 'quy tac SUB');
    write(dir, 'sub/nested/AGENTS.md', 'quy tac NESTED');
    const leaf = path.join(dir, 'sub', 'nested');
    assert.deepEqual(findAgentsMdChain(dir, leaf), [
      path.resolve(dir),
      path.resolve(dir, 'sub'),
      leaf,
    ]);
    const rules = loadAgentsMd(dir, { cwd: leaf });
    assert.ok(rules);
    assert.deepEqual(
      rules.sources.map((s) => s.relative),
      ['AGENTS.md', 'sub/AGENTS.md', 'sub/nested/AGENTS.md'],
    );
    // Thứ tự trong nội dung gộp: tổ tiên trước, gần nhất sau (ưu tiên khi xung đột).
    const idxRoot = rules.content.indexOf('quy tac ROOT');
    const idxSub = rules.content.indexOf('quy tac SUB');
    const idxNested = rules.content.indexOf('quy tac NESTED');
    assert.ok(idxRoot !== -1 && idxSub !== -1 && idxNested !== -1);
    assert.ok(idxRoot < idxSub && idxSub < idxNested);
    // Mỗi section ghi rõ nguồn để model biết file nào gần hơn.
    assert.match(rules.content, /\[AGENTS\.md: sub\/nested\/AGENTS\.md\]/);
    // Không truyền cwd thì chuỗi chỉ có root.
    const rootOnly = loadAgentsMd(dir);
    assert.deepEqual(
      rootOnly.sources.map((s) => s.relative),
      ['AGENTS.md'],
    );
  } finally {
    cleanup(dir);
  }
});

test('loadAgentsMd: trong cùng thư mục, .open-bot/AGENTS.md ưu tiên hơn AGENTS.md', () => {
  const dir = tmpDir('precedence');
  try {
    write(dir, 'AGENTS.md', 'quy tac ROOT');
    write(dir, 'sub/AGENTS.md', 'quy tac sub root');
    write(dir, 'sub/.open-bot/AGENTS.md', 'quy tac sub open-bot');
    const rules = loadAgentsMd(dir, { cwd: path.join(dir, 'sub') });
    assert.ok(rules);
    assert.deepEqual(
      rules.sources.map((s) => s.relative),
      ['AGENTS.md', 'sub/.open-bot/AGENTS.md'],
    );
    assert.doesNotMatch(rules.content, /quy tac sub root/);
  } finally {
    cleanup(dir);
  }
});

test('loadAgentsMd: cwd ngoài workspace -> chỉ dùng workspaceDir', () => {
  const dir = tmpDir('outside');
  const other = tmpDir('outside-other');
  try {
    write(dir, 'AGENTS.md', 'quy tac ROOT');
    write(other, 'AGENTS.md', 'quy tac NGOAI');
    assert.deepEqual(findAgentsMdChain(dir, other), [path.resolve(dir)]);
    const rules = loadAgentsMd(dir, { cwd: other });
    assert.ok(rules);
    assert.equal(rules.sources.length, 1);
    assert.match(rules.content, /quy tac ROOT/);
    assert.doesNotMatch(rules.content, /quy tac NGOAI/);
  } finally {
    cleanup(dir);
    cleanup(other);
  }
});

test('loadAgentsMd: AGENTS.md là thư mục / file rỗng -> bỏ qua, không có file thật thì null', () => {
  const dir = tmpDir('dirfile');
  try {
    fs.mkdirSync(path.join(dir, 'AGENTS.md'), { recursive: true });
    assert.equal(loadAgentsMd(dir), null);
    fs.rmSync(path.join(dir, 'AGENTS.md'), { recursive: true, force: true });
    write(dir, 'AGENTS.md', '   \n');
    assert.equal(loadAgentsMd(dir), null);
    // File rỗng ở root + file thật ở sub: root bị ghi vào skipped, sub vẫn nạp.
    write(dir, 'sub/AGENTS.md', 'quy tac sub');
    const rules = loadAgentsMd(dir, { cwd: path.join(dir, 'sub') });
    assert.ok(rules);
    assert.equal(rules.sources.length, 1);
    assert.equal(rules.sources[0].relative, 'sub/AGENTS.md');
    assert.equal(rules.skipped.length, 1);
    assert.match(rules.skipped[0].reason, /rỗng/);
  } finally {
    cleanup(dir);
  }
});

test('loadAgentsMd: symlink trỏ ra ngoài workspace bị bỏ qua kèm lý do', () => {
  const dir = tmpDir('symlink');
  const outside = tmpDir('symlink-out');
  try {
    const target = write(outside, 'secret-rules.md', 'quy tac BI MAT NGOAI WORKSPACE');
    fs.symlinkSync(target, path.join(dir, 'AGENTS.md'));
    write(dir, 'sub/AGENTS.md', 'quy tac sub');
    const rules = loadAgentsMd(dir, { cwd: path.join(dir, 'sub') });
    assert.ok(rules);
    assert.deepEqual(
      rules.sources.map((s) => s.relative),
      ['sub/AGENTS.md'],
    );
    assert.doesNotMatch(rules.content, /BI MAT/);
    assert.equal(rules.skipped.length, 1);
    assert.equal(rules.skipped[0].path, path.resolve(dir, 'AGENTS.md'));
    assert.match(rules.skipped[0].reason, /ngoài workspace/);
    // Chỉ còn symlink thì không có quy tắc nào.
    fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
    assert.equal(loadAgentsMd(dir), null);
  } finally {
    cleanup(dir);
    cleanup(outside);
  }
});

test('loadAgentsMd: cache mtime+size + clearAgentsMdCache + forceRefresh', () => {
  const dir = tmpDir('cache');
  try {
    const file = write(dir, 'AGENTS.md', 'quy tac A');
    const first = loadAgentsMd(dir);
    assert.equal(first.content.includes('quy tac A'), true);
    // Không đổi file -> trả đúng object đã cache.
    assert.equal(loadAgentsMd(dir), first);
    // Đổi nội dung (đổi size) -> đọc lại, object mới.
    fs.writeFileSync(file, 'quy tac B dai hon', 'utf8');
    const third = loadAgentsMd(dir);
    assert.notEqual(third, first);
    assert.match(third.content, /quy tac B dai hon/);
    // forceRefresh cũng đọc lại.
    const fourth = loadAgentsMd(dir, { forceRefresh: true });
    assert.notEqual(fourth, third);
    assert.match(fourth.content, /quy tac B dai hon/);
    // Thêm file ở subdir làm chuỗi đổi -> đọc lại (không cần clear cache).
    write(dir, 'sub/AGENTS.md', 'quy tac SUB MOI');
    const fifth = loadAgentsMd(dir, { cwd: path.join(dir, 'sub') });
    assert.notEqual(fifth, fourth);
    assert.equal(fifth.sources.length, 2);
    // clearAgentsMdCache -> lần sau đọc lại từ đĩa.
    clearAgentsMdCache();
    const sixth = loadAgentsMd(dir);
    assert.notEqual(sixth, fourth);
  } finally {
    cleanup(dir);
  }
});

test('loadAgentsMd: file quá dài bị cắt ở giới hạn mỗi file + cờ truncated', () => {
  const dir = tmpDir('toolong');
  try {
    const long = 'x'.repeat(MAX_AGENTS_MD_CHARS_PER_FILE + 100);
    write(dir, 'AGENTS.md', long);
    const rules = loadAgentsMd(dir);
    assert.ok(rules);
    assert.equal(rules.truncated, true);
    assert.deepEqual(rules.truncatedFiles, ['AGENTS.md']);
    assert.equal(rules.sources[0].truncated, true);
    assert.ok(rules.sources[0].content.startsWith('x'.repeat(MAX_AGENTS_MD_CHARS_PER_FILE)));
    assert.match(rules.sources[0].content, /đã rút gọn/);
  } finally {
    cleanup(dir);
  }
});

test('loadAgentsMd: tổng gộp vượt giới hạn -> bỏ section cũ nhất, giữ file gần nhất', () => {
  const dir = tmpDir('totalcap');
  try {
    const big = 7000; // 3 file x 7000 + tiêu đề > 16000.
    write(dir, 'AGENTS.md', 'R'.repeat(big));
    write(dir, 'sub/AGENTS.md', 'S'.repeat(big));
    write(dir, 'sub/nested/AGENTS.md', 'N'.repeat(big));
    const rules = loadAgentsMd(dir, { cwd: path.join(dir, 'sub', 'nested') });
    assert.ok(rules);
    assert.equal(rules.truncated, true);
    assert.deepEqual(
      rules.sources.map((s) => s.relative),
      ['sub/AGENTS.md', 'sub/nested/AGENTS.md'],
    );
    assert.doesNotMatch(rules.content, /R{100}/);
    assert.match(rules.content, /S{100}/);
    assert.match(rules.content, /N{100}/);
    assert.ok(rules.content.length <= MAX_AGENTS_MD_TOTAL_CHARS + 200);
    const dropped = rules.skipped.find((s) => s.path === path.resolve(dir, 'AGENTS.md'));
    assert.ok(dropped);
    assert.match(dropped.reason, /tổng giới hạn/);
  } finally {
    cleanup(dir);
  }
});

test('loadWorkspaceRules (tương thích v0.11): vẫn chỉ nạp file ở root, giữ shape cũ', () => {
  const dir = tmpDir('compat');
  try {
    write(dir, 'AGENTS.md', 'quy tac ROOT');
    write(dir, 'sub/AGENTS.md', 'quy tac SUB');
    const rules = loadWorkspaceRules(dir);
    assert.ok(rules);
    assert.equal(rules.source, 'AGENTS.md');
    assert.equal(rules.path, path.resolve(dir, 'AGENTS.md'));
    assert.match(rules.content, /quy tac ROOT/);
    assert.doesNotMatch(rules.content, /quy tac SUB/);
    assert.equal(rules.truncated, false);
    assert.equal(loadWorkspaceRules(dir), rules);
  } finally {
    cleanup(dir);
  }
});

// ------------------------------------------------------- coordinator (mock)

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

function systemPromptOf(req) {
  const sys = req.messages.find((m) => m.role === 'system');
  assert.ok(sys, 'request phải có message system');
  return sys.content;
}

function recordsOf(recordPath) {
  const raw = fs.readFileSync(recordPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('coordinator getWorkspaceRules: xem AGENTS.md đang có hiệu lực (nội dung + nguồn + bỏ qua)', async () => {
  const dir = tmpDir('rpc');
  const client = new CoordinatorClient();
  try {
    await client.ping();
    write(dir, 'AGENTS.md', 'quy tac ROOT');
    write(dir, 'sub/AGENTS.md', 'quy tac SUB');
    await client.createBot({
      bot: botConfig('bot-agentsmd-rpc', dir),
      provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
    });
    const sub = path.join(dir, 'sub');
    const res = await client.getWorkspaceRules('bot-agentsmd-rpc', sub);
    assert.equal(res.botId, 'bot-agentsmd-rpc');
    assert.equal(res.workspaceDir, dir);
    assert.equal(res.cwd, sub);
    assert.ok(res.rules);
    assert.deepEqual(
      res.rules.sources.map((s) => s.relative),
      ['AGENTS.md', 'sub/AGENTS.md'],
    );
    assert.match(res.rules.content, /quy tac ROOT/);
    assert.match(res.rules.content, /quy tac SUB/);
    // Không truyền cwd -> chỉ root.
    const rootOnly = await client.getWorkspaceRules('bot-agentsmd-rpc');
    assert.deepEqual(
      rootOnly.rules.sources.map((s) => s.relative),
      ['AGENTS.md'],
    );
    // Bot không tồn tại -> lỗi rõ.
    await assert.rejects(() => client.getWorkspaceRules('bot-khong-co'), /Chưa tạo bot/);
  } finally {
    await client.dispose();
    cleanup(dir);
  }
});

test('coordinator getWorkspaceRules: bot không có AGENTS.md -> rules null', async () => {
  const dir = tmpDir('rpc-none');
  const client = new CoordinatorClient();
  try {
    await client.ping();
    await client.createBot({
      bot: botConfig('bot-agentsmd-none', dir),
      provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
    });
    const res = await client.getWorkspaceRules('bot-agentsmd-none');
    assert.equal(res.rules, null);
  } finally {
    await client.dispose();
    cleanup(dir);
  }
});

test('coordinator run: AGENTS.md theo cwd có mặt trong system prompt thật (mock provider)', async () => {
  const dir = tmpDir('run');
  const client = new CoordinatorClient();
  try {
    await client.ping();
    write(dir, 'AGENTS.md', 'quy tac ROOT: tra loi bang tieng Viet');
    write(dir, 'sub/AGENTS.md', 'quy tac SUB: tra loi ngan gon');
    const recordPath = path.join(dir, 'mock-record.jsonl');
    await client.createBot({
      bot: botConfig('bot-agentsmd-run', dir),
      provider: {
        id: 'mock',
        label: 'Mock',
        mockResponses: [{ text: 'mock ok' }],
        mockRecordPath: recordPath,
      },
    });
    // Run ở root: chỉ quy tắc root.
    const r1 = await client.run('bot-agentsmd-run', 'chao ban');
    assert.equal(r1.text, 'mock ok');
    let prompt = systemPromptOf(recordsOf(recordPath).at(-1));
    assert.match(prompt, /quy tac ROOT/);
    assert.doesNotMatch(prompt, /quy tac SUB/);
    // Run với cwd = sub: cả hai, tổ tiên trước, gần nhất sau.
    const r2 = await client.run('bot-agentsmd-run', 'chao ban', undefined, {
      cwd: path.join(dir, 'sub'),
    });
    assert.equal(r2.text, 'mock ok');
    prompt = systemPromptOf(recordsOf(recordPath).at(-1));
    assert.match(prompt, /quy tac ROOT/);
    assert.match(prompt, /quy tac SUB/);
    assert.ok(prompt.indexOf('quy tac ROOT') < prompt.indexOf('quy tac SUB'));
    assert.match(prompt, /file ở thư mục gần thư mục làm việc hơn được ưu tiên/);
    // File đổi -> run mới thấy nội dung mới (cache mtime, không cần restart).
    write(dir, 'sub/AGENTS.md', 'quy tac SUB MOI: tra loi rat ngan');
    const r3 = await client.run('bot-agentsmd-run', 'chao ban', undefined, {
      cwd: path.join(dir, 'sub'),
    });
    assert.equal(r3.text, 'mock ok');
    prompt = systemPromptOf(recordsOf(recordPath).at(-1));
    assert.match(prompt, /quy tac SUB MOI/);
    assert.doesNotMatch(prompt, /tra loi ngan gon/);
  } finally {
    await client.dispose();
    cleanup(dir);
  }
});
