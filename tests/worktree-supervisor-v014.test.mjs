/**
 * worktree-supervisor-v014.test.mjs — Shadow workspace / git worktree
 * (v0.14 mục 5) + Supervisor / swarm routing (v0.14 mục 7).
 *
 * Chỉ dùng git local + localhost, không mạng, không API key.
 * Run: build core rồi `node --test tests/worktree-supervisor-v014.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WorktreeManager,
  createShadow,
  validateGitName,
} from '../packages/core/dist/agent/worktree.js';
import {
  Supervisor,
  SupervisorRouter,
  scoreAgent,
} from '../packages/core/dist/agent/supervisor.js';

// ---------------------------------------------------------------------------
// Helper: repo git tạm thật
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} thất bại: ${String(stderr || error.message).trim()}`));
      else resolve(String(stdout ?? ''));
    });
  });
}

async function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-wt-'));
  await runGit(['init', '-b', 'main'], dir);
  await runGit(['config', 'user.email', 'test@open-bot.local'], dir);
  await runGit(['config', 'user.name', 'Open Bot Test'], dir);
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'xin chào\n', 'utf8');
  await runGit(['add', 'hello.txt'], dir);
  await runGit(['commit', '-m', 'commit đầu'], dir);
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Bỏ qua lỗi dọn thư mục tạm.
  }
}

async function branchList(repoDir) {
  const out = await runGit(['branch', '--list'], repoDir);
  return out.split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

test('worktree: create → thư mục tồn tại + file có mặt, list thấy 1, remove dọn sạch', async () => {
  const repo = await makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    const wt = await manager.create();
    assert.match(wt.id, /^[0-9a-f]{8}$/);
    assert.match(wt.branch, /^wt\/agent-[0-9a-f]{8}$/);
    assert.equal(wt.detached, false);
    assert.ok(fs.existsSync(wt.path), 'thư mục worktree phải tồn tại');
    assert.equal(fs.readFileSync(path.join(wt.path, 'hello.txt'), 'utf8'), 'xin chào\n');
    assert.ok(fs.existsSync(path.join(wt.path, '.git')), 'worktree phải có .git');

    const listed = await manager.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, wt.id);
    assert.equal(listed[0].branch, wt.branch);

    await manager.remove(wt.id);
    assert.ok(!fs.existsSync(wt.path), 'thư mục worktree phải biến mất sau remove');
    assert.equal((await manager.list()).length, 0);
    assert.ok(!(await branchList(repo)).includes(wt.branch), 'branch do open-bot tạo phải bị xoá');
  } finally {
    cleanup(repo);
  }
});

test('worktree: create với branch có sẵn → checkout branch đó, remove giữ lại branch', async () => {
  const repo = await makeRepo();
  try {
    await runGit(['branch', 'feature-x'], repo);
    const manager = new WorktreeManager(repo);
    const wt = await manager.create({ branch: 'feature-x' });
    assert.equal(wt.branch, 'feature-x');
    assert.ok(fs.existsSync(path.join(wt.path, 'hello.txt')));
    await manager.remove(wt.id);
    assert.ok((await branchList(repo)).includes('feature-x'), 'branch người dùng tạo sẵn phải còn nguyên');
  } finally {
    cleanup(repo);
  }
});

test('worktree: create với branch chưa tồn tại → tạo branch mới từ baseBranch', async () => {
  const repo = await makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    const wt = await manager.create({ branch: 'my-work', baseBranch: 'main' });
    assert.equal(wt.branch, 'my-work');
    assert.ok((await branchList(repo)).includes('my-work'));
    await manager.remove(wt.id);
    // Branch 'my-work' do người dùng đặt tên (không theo mẫu wt/...) nên được giữ lại.
    assert.ok((await branchList(repo)).includes('my-work'));
  } finally {
    cleanup(repo);
  }
});

test('worktree: repo không phải git → lỗi rõ ràng tiếng Việt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-notgit-'));
  try {
    const manager = new WorktreeManager(dir);
    await assert.rejects(
      () => manager.create(),
      /không phải git repo/,
      'phải báo rõ thư mục không phải git repo',
    );
    await assert.rejects(() => manager.list(), /không phải git repo/);
  } finally {
    cleanup(dir);
  }
});

test('worktree: tên branch độc hại bị chặn trước khi chạy git', async () => {
  const repo = await makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    for (const bad of ['../x', 'a;rm -rf /', 'a && echo x', '--force', 'a b', 'a..b', '/etc/passwd']) {
      await assert.rejects(() => manager.create({ branch: bad }), /không hợp lệ/, `branch ${JSON.stringify(bad)} phải bị chặn`);
    }
    await assert.rejects(() => manager.create({ baseBranch: '../x' }), /không hợp lệ/);
    await assert.rejects(() => manager.create({ prefix: 'a;b' }), /không hợp lệ/);
    await assert.rejects(() => manager.remove('../x'), /không hợp lệ/);
    await assert.rejects(() => manager.remove('xyz'), /không hợp lệ/);
    assert.equal(validateGitName('feature-x_1.2', 'Branch'), 'feature-x_1.2');
    assert.equal((await manager.list()).length, 0, 'không worktree nào được tạo từ tên độc hại');
  } finally {
    cleanup(repo);
  }
});

test('worktree: createShadow + dispose dọn sạch; cleanupStale dọn worktree cũ', async () => {
  const repo = await makeRepo();
  try {
    const shadow = await createShadow(repo);
    assert.ok(fs.existsSync(shadow.worktree.path));
    assert.ok(fs.existsSync(path.join(shadow.worktree.path, 'hello.txt')));
    await shadow.dispose();
    assert.ok(!fs.existsSync(shadow.worktree.path));
    await shadow.dispose(); // dispose lần 2 không lỗi

    const manager = new WorktreeManager(repo);
    const wt = await manager.create();
    // Giả tuổi worktree thành 2 ngày trước.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(wt.path, old, old);
    const removed = await manager.cleanupStale({ maxAgeMs: 60 * 60 * 1000 });
    assert.deepEqual(removed, [wt.id]);
    assert.equal((await manager.list()).length, 0);
  } finally {
    cleanup(repo);
  }
});

test('worktree: cleanupStale không dọn worktree còn trẻ', async () => {
  const repo = await makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    const wt = await manager.create();
    const removed = await manager.cleanupStale({ maxAgeMs: 24 * 60 * 60 * 1000 });
    assert.deepEqual(removed, []);
    assert.equal((await manager.list()).length, 1);
    await manager.remove(wt.id);
  } finally {
    cleanup(repo);
  }
});

// ---------------------------------------------------------------------------
// Supervisor scoring + routing
// ---------------------------------------------------------------------------

const TRANSLATOR = {
  id: 'translator',
  kind: 'local-bot',
  description: 'Dịch tài liệu và văn bản sang tiếng Việt, dịch thuật chuyên nghiệp',
  skills: ['translate'],
};
const GIT_AGENT = {
  id: 'git-agent',
  kind: 'local-bot',
  description: 'Quản lý git, commit, branch, pull request',
  skills: ['git'],
};
const CODER = {
  id: 'coder',
  kind: 'local-bot',
  description: 'Review code, kiểm tra lỗi và chất lượng mã nguồn',
  skills: ['code-review'],
};
const REMOTE_RESEARCHER = {
  id: 'remote-researcher',
  kind: 'a2a',
  description: 'Nghiên cứu chủ đề và viết báo cáo ngắn có nguồn',
  skills: ['research-brief'],
  agentCardUrl: 'http://127.0.0.1:9/',
};

test('supervisor: scoring xếp đúng agent theo skill/description', () => {
  const task = 'dịch tài liệu hướng dẫn sang tiếng Việt';
  const tScore = scoreAgent(task, TRANSLATOR);
  const gScore = scoreAgent(task, GIT_AGENT);
  assert.ok(tScore.score > gScore.score, `translator (${tScore.score}) phải cao hơn git-agent (${gScore.score})`);
  assert.ok(tScore.reasons.length > 0);
  assert.ok(tScore.score > 0 && tScore.score <= 1);
  // Skill name xuất hiện nguyên vẹn trong task → ghi vào matchedSkills.
  const literal = scoreAgent('dùng skill translate để dịch tài liệu', TRANSLATOR);
  assert.ok(literal.matchedSkills.includes('translate'));

  const codeScore = scoreAgent('review code trong pull request này', CODER);
  assert.ok(codeScore.score > scoreAgent('review code trong pull request này', TRANSLATOR).score);
  assert.ok(codeScore.matchedSkills.includes('code-review'));

  const researchScore = scoreAgent('nghiên cứu chủ đề và viết báo cáo', REMOTE_RESEARCHER);
  assert.ok(researchScore.score > scoreAgent('nghiên cứu chủ đề và viết báo cáo', GIT_AGENT).score);
  assert.equal(scoreAgent('', TRANSLATOR).score, 0);
});

test('supervisor: route chọn agent đúng, không chọn agent sai chuyên môn', () => {
  const router = new SupervisorRouter();
  router.register(TRANSLATOR);
  router.register(GIT_AGENT);
  router.register(CODER);
  assert.equal(router.route('dịch tài liệu sang tiếng Việt').agentId, 'translator');
  assert.equal(router.route('tạo branch mới và commit lên git').agentId, 'git-agent');
  assert.equal(router.route('review code trong pull request').agentId, 'coder');
});

test('supervisor: tie-break theo inFlight — agent ít việc đang chạy thắng khi hoà điểm', () => {
  const router = new SupervisorRouter();
  const a = { id: 'bot-a', kind: 'local-bot', description: 'dịch tài liệu', skills: ['translate'] };
  const b = { id: 'bot-b', kind: 'local-bot', description: 'dịch tài liệu', skills: ['translate'] };
  router.register(a);
  router.register(b);
  // Chưa ai bận: hoà điểm → id nhỏ nhất thắng.
  assert.equal(router.route('dịch tài liệu').agentId, 'bot-a');
  router.beginTask('bot-a');
  assert.equal(router.route('dịch tài liệu').agentId, 'bot-b');
  assert.equal(router.inFlightCount('bot-a'), 1);
  router.endTask('bot-a');
  assert.equal(router.inFlightCount('bot-a'), 0);
  assert.equal(router.route('dịch tài liệu').agentId, 'bot-a');
});

test('supervisor: routeAll xếp hạng đúng thứ tự; task rỗng / không có agent → lỗi rõ', () => {
  const router = new SupervisorRouter();
  router.register(TRANSLATOR);
  router.register(GIT_AGENT);
  router.register(CODER);
  const ranked = router.routeAll('dịch tài liệu');
  assert.equal(ranked[0].agentId, 'translator');
  assert.ok(ranked[0].score >= ranked[1].score);
  assert.ok(ranked[1].score >= ranked[2].score);
  assert.equal(ranked.length, 3);

  assert.throws(() => router.route('   '), /task không rỗng/);
  assert.throws(() => new SupervisorRouter().route('dịch tài liệu'), /Chưa có agent/);
  assert.throws(() => router.route('dịch tài liệu', { excludeIds: ['translator', 'git-agent', 'coder'] }), /Không còn agent/);
  assert.throws(() => router.register({ id: '   ', kind: 'local-bot', description: '', skills: [] }), /id.*không rỗng/);
});

test('supervisor: dispatch parallel gom đủ kết quả top-N', async () => {
  const supervisor = new Supervisor();
  supervisor.register(TRANSLATOR);
  supervisor.register(GIT_AGENT);
  supervisor.register(CODER);
  const seen = [];
  const results = await supervisor.dispatch('dịch tài liệu và review code', {
    mode: 'parallel',
    topN: 2,
    handoff: async (agentId, task) => {
      seen.push(agentId);
      return `xong bởi ${agentId}: ${task}`;
    },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(seen.sort(), results.map((r) => r.agentId).sort());
  for (const r of results) {
    assert.ok(r.result.includes(`xong bởi ${r.agentId}`));
    assert.equal(r.error, undefined);
    assert.ok(r.score >= 0);
  }
});

test('supervisor: dispatch sequential fallback sang agent thứ hai khi agent đầu lỗi', async () => {
  const failer = { id: 'failer', kind: 'local-bot', description: 'dịch tài liệu translate', skills: ['translate'] };
  const fallback = { id: 'fallback', kind: 'local-bot', description: 'dịch translate', skills: ['translate'] };
  const supervisor = new Supervisor();
  supervisor.register(failer);
  supervisor.register(fallback);
  const calls = [];
  const results = await supervisor.dispatch('dịch tài liệu', {
    mode: 'sequential',
    maxAttempts: 3,
    handoff: async (agentId, task) => {
      calls.push(agentId);
      if (agentId === 'failer') throw new Error('agent đầu sập');
      return `fallback xong: ${task}`;
    },
  });
  assert.deepEqual(calls, ['failer', 'fallback']);
  assert.equal(results.length, 1);
  assert.equal(results[0].agentId, 'fallback');
  assert.equal(results[0].result, 'fallback xong: dịch tài liệu');
});

test('supervisor: dispatch sequential tất cả lỗi → trả về lỗi từng agent, không throw', async () => {
  const supervisor = new Supervisor();
  supervisor.register(TRANSLATOR);
  supervisor.register(GIT_AGENT);
  const results = await supervisor.dispatch('dịch tài liệu', {
    mode: 'sequential',
    handoff: async (agentId) => {
      throw new Error(`lỗi ở ${agentId}`);
    },
  });
  assert.equal(results.length, 2);
  for (const r of results) assert.match(r.error, /lỗi khi nhận task/);
});

test('supervisor: dispatch không có agent / task rỗng / thiếu callback → lỗi rõ', async () => {
  const supervisor = new Supervisor();
  await assert.rejects(
    () => supervisor.dispatch('dịch tài liệu', { handoff: async () => 'ok' }),
    /Chưa có agent/,
  );
  supervisor.register(TRANSLATOR);
  await assert.rejects(
    () => supervisor.dispatch('   ', { handoff: async () => 'ok' }),
    /task không rỗng/,
  );
  await assert.rejects(
    () => supervisor.dispatch('dịch tài liệu', {}),
    /cần callback `handoff/,
  );
  // dispatch với agents truyền riêng (không cần đăng ký trước).
  const fresh = new Supervisor();
  const results = await fresh.dispatch('dịch tài liệu', {
    agents: [TRANSLATOR],
    handoff: async (agentId) => `ok ${agentId}`,
  });
  assert.equal(results[0].agentId, 'translator');
  assert.equal(fresh.router.list().length, 0, 'agents truyền riêng không ghi đè router');
});
