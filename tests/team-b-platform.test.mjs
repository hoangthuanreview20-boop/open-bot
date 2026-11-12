/**
 * B-platform M4 tests: audit log (JSONL + chuỗi hash SHA-256), named
 * workspace registry, TeamStore (mutation có audit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendAuditEvent,
  AUDIT_GENESIS_PREV_HASH,
  computeAuditHash,
  listAuditEvents,
  readAuditEvents,
  verifyAuditLog,
} from '../packages/core/dist/team/audit.js';
import {
  createWorkspace,
  findWorkspace,
  loadWorkspaces,
  removeWorkspace,
  renameWorkspace,
  saveWorkspaces,
  validateWorkspaces,
} from '../packages/core/dist/team/workspaces.js';
import { TeamStore } from '../packages/core/dist/team/store.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

test('M4 audit: computeAuditHash ổn định, nhạy với nội dung', () => {
  const base = {
    seq: 1,
    at: 1700000000000,
    actor: 'alice',
    action: 'member.add',
    target: 'member:bob',
    detail: { role: 'member' },
    prevHash: AUDIT_GENESIS_PREV_HASH,
  };
  assert.equal(computeAuditHash(base), computeAuditHash(base));
  assert.notEqual(computeAuditHash(base), computeAuditHash({ ...base, seq: 2 }));
  assert.notEqual(computeAuditHash(base), computeAuditHash({ ...base, detail: { role: 'admin' } }));
  // Thứ tự key trong detail không làm đổi hash (chuẩn hoá key đệ quy).
  assert.equal(
    computeAuditHash({ ...base, detail: { a: 1, b: 2 } }),
    computeAuditHash({ ...base, detail: { b: 2, a: 1 } }),
  );
});

test('M4 audit: append nối chuỗi hash, verify ok, list lọc được', () => {
  const dir = makeTempDir('open-bot-audit-m4-');
  try {
    assert.deepEqual(verifyAuditLog(dir), { ok: true, checked: 0 });
    const e1 = appendAuditEvent(dir, { actor: 'alice', action: 'member.add', target: 'member:bob', detail: { role: 'member' } });
    const e2 = appendAuditEvent(dir, { actor: 'alice', action: 'bot.share', target: 'bot:bot-1' });
    assert.equal(e1.seq, 1);
    assert.equal(e1.prevHash, AUDIT_GENESIS_PREV_HASH);
    assert.equal(e2.seq, 2);
    assert.equal(e2.prevHash, e1.hash);
    assert.equal(e2.hash, computeAuditHash(e2));
    assert.ok(e1.id.startsWith('audit-'));
    assert.deepEqual(verifyAuditLog(dir), { ok: true, checked: 2 });
    assert.deepEqual(readAuditEvents(dir).map((e) => e.seq), [1, 2]);

    assert.equal(listAuditEvents(dir, { action: 'bot.share' }).length, 1);
    assert.equal(listAuditEvents(dir, { actor: 'nobody' }).length, 0);
    assert.equal(listAuditEvents(dir, { target: 'member:bob' }).length, 1);
    // e1.at là mốc sớm nhất (hai event có thể cùng mili-giây nên chỉ
    // assert theo hướng an toàn, không giả định e1.at < e2.at).
    assert.equal(listAuditEvents(dir, { since: e1.at }).length, 2);
    assert.equal(listAuditEvents(dir, { since: e2.at + 100_000 }).length, 0);
    assert.equal(listAuditEvents(dir, { until: e1.at - 1 }).length, 0);
    assert.equal(listAuditEvents(dir).length, 2);
  } finally {
    cleanup(dir);
  }
});

test('M4 audit: sửa nội dung → verify báo hash sai; xoá dòng giữa → báo seq sai; dòng hỏng → throw', () => {
  const dir = makeTempDir('open-bot-audit-m4-');
  try {
    appendAuditEvent(dir, { actor: 'alice', action: 'member.add', target: 'member:bob' });
    appendAuditEvent(dir, { actor: 'alice', action: 'member.add', target: 'member:carol' });
    appendAuditEvent(dir, { actor: 'alice', action: 'bot.share', target: 'bot:bot-1' });
    const file = path.join(dir, 'audit.jsonl');

    // Sửa nội dung dòng 2 (đổi target) mà không tính lại hash.
    let lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.target = 'member:eve';
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    let result = verifyAuditLog(dir);
    assert.equal(result.ok, false);
    assert.equal(result.badLine, 2);
    assert.match(result.reason ?? '', /hash sai/);

    // Xoá dòng giữa → seq đứt.
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 1);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    result = verifyAuditLog(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /seq sai/);

    // Dòng không phải JSON → đọc throw kèm số dòng, không echo nội dung.
    fs.appendFileSync(file, 'không phải json {\n', 'utf8');
    assert.throws(() => readAuditEvents(dir), /dòng 3/);
  } finally {
    cleanup(dir);
  }
});

test('M4 audit: append thiếu actor/action/target → throw', () => {
  const dir = makeTempDir('open-bot-audit-m4-');
  try {
    assert.throws(() => appendAuditEvent(dir, { actor: '', action: 'x', target: 'y' }), /actor/);
    assert.throws(() => appendAuditEvent(dir, { actor: 'a', action: '', target: 'y' }), /action/);
    assert.throws(() => appendAuditEvent(dir, { actor: 'a', action: 'x', target: '' }), /target/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

test('M4 workspaces: create/remove/rename pure, rootDir tuyệt đối, chống trùng', () => {
  const { workspaces, workspace } = createWorkspace([], {
    name: 'Dự án chung',
    rootDir: '/tmp/team-ws-1',
    createdBy: 'alice',
  });
  assert.ok(workspace.id.startsWith('ws-'));
  assert.equal(workspace.name, 'Dự án chung');
  assert.ok(workspace.createdAt > 0);
  assert.equal(workspaces.length, 1);
  assert.equal(findWorkspace(workspaces, workspace.id)?.rootDir, '/tmp/team-ws-1');
  assert.equal(findWorkspace(workspaces, 'không-có'), undefined);

  // Đường dẫn tương đối → throw; trùng thư mục (kể cả thêm `/` cuối) → throw.
  assert.throws(
    () => createWorkspace(workspaces, { name: 'x', rootDir: 'relative/path', createdBy: 'alice' }),
    /tuyệt đối/,
  );
  assert.throws(
    () => createWorkspace(workspaces, { name: 'y', rootDir: '/tmp/team-ws-1/', createdBy: 'bob' }),
    /đã tồn tại/,
  );
  assert.throws(
    () => createWorkspace(workspaces, { name: '  ', rootDir: '/tmp/khac', createdBy: 'alice' }),
    /name/,
  );

  const renamed = renameWorkspace(workspaces, workspace.id, 'Tên mới');
  assert.equal(renamed[0].name, 'Tên mới');
  assert.throws(() => renameWorkspace(workspaces, workspace.id, '  '), /name/);
  assert.throws(() => renameWorkspace(workspaces, 'không-có', 'x'), /Không có workspace/);

  assert.deepEqual(removeWorkspace(workspaces, workspace.id), []);
  assert.throws(() => removeWorkspace(workspaces, 'không-có'), /Không có workspace/);

  // validateWorkspaces: trùng id → throw.
  assert.throws(
    () => validateWorkspaces([workspace, { ...workspace, rootDir: '/tmp/khac' }]),
    /trùng id/,
  );
});

test('M4 workspaces: save/load round-trip, file chưa có → [], JSON hỏng → throw', () => {
  const dir = makeTempDir('open-bot-ws-m4-');
  try {
    assert.deepEqual(loadWorkspaces(dir), []);
    const { workspaces } = createWorkspace([], {
      name: 'WS1',
      rootDir: '/tmp/team-ws-1',
      createdBy: 'alice',
    });
    saveWorkspaces(dir, workspaces);
    const loaded = loadWorkspaces(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'WS1');

    fs.writeFileSync(path.join(dir, 'workspaces.json'), '{ hỏng', 'utf8');
    assert.throws(() => loadWorkspaces(dir), /không phải JSON hợp lệ/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// TeamStore
// ---------------------------------------------------------------------------

test('M4 TeamStore: member + bot + setting đều lưu state và ghi audit', () => {
  const dir = makeTempDir('open-bot-store-m4-');
  try {
    const store = new TeamStore(dir);
    assert.equal(store.team.members.length, 0);
    assert.deepEqual(store.workspaces, []);

    const r1 = store.addMember({ userId: 'alice', name: 'Alice', role: 'admin' }, 'system');
    assert.equal(r1.event.action, 'member.add');
    assert.equal(r1.event.target, 'member:alice');
    assert.equal(store.team.members.length, 1);

    store.addMember({ userId: 'bob', name: 'Bob', role: 'member' }, 'alice');
    const rRole = store.setRole('bob', 'viewer', 'alice');
    assert.equal(rRole.event.action, 'member.set-role');
    assert.equal(rRole.event.detail.role, 'viewer');
    assert.equal(store.team.members.find((m) => m.userId === 'bob')?.role, 'viewer');

    const rShare = store.shareBot('bot-1', 'alice', 'alice');
    assert.equal(rShare.event.action, 'bot.share');
    assert.deepEqual(store.team.sharedBots, [{ botId: 'bot-1', sharedBy: 'alice' }]);
    store.unshareBot('bot-1', 'alice');
    assert.deepEqual(store.team.sharedBots, []);

    const rEgress = store.setTeamEgress({ mode: 'allowlist', allowHosts: ['example.com'] }, 'alice');
    assert.equal(rEgress.event.action, 'team.set-egress');
    assert.equal(store.team.egress?.mode, 'allowlist');

    const rDir = store.setWorkspaceDir('/tmp/team-shared', 'alice');
    assert.equal(rDir.event.action, 'team.set-workspace-dir');
    assert.equal(store.team.workspaceDir, '/tmp/team-shared');

    // State đã xuống đĩa: store mới đọc lại được.
    const store2 = new TeamStore(dir);
    assert.equal(store2.team.members.length, 2);
    assert.equal(store2.team.workspaceDir, '/tmp/team-shared');

    // Audit: đủ event, verify ok, lọc được.
    assert.deepEqual(store.verifyAudit(), { ok: true, checked: 7 });
    assert.equal(store.listAudit({ action: 'member.add' }).length, 2);
    assert.equal(store.listAudit({ actor: 'alice' }).length, 6);
    assert.equal(store.listAudit().length, 7);
  } finally {
    cleanup(dir);
  }
});

test('M4 TeamStore: workspace qua store (tạo/đổi tên/xoá) + audit service account', () => {
  const dir = makeTempDir('open-bot-store-m4-');
  try {
    const store = new TeamStore(dir);
    const { workspace, event } = store.createWorkspace(
      { name: 'WS chung', rootDir: '/tmp/team-ws-9', createdBy: 'alice' },
      'alice',
    );
    assert.equal(event.action, 'workspace.create');
    assert.equal(store.workspaces.length, 1);

    store.renameWorkspace(workspace.id, 'WS mới', 'alice');
    assert.equal(store.workspaces[0].name, 'WS mới');
    store.removeWorkspace(workspace.id, 'alice');
    assert.deepEqual(store.workspaces, []);

    // Service account không nằm trong store — main ghi audit trực tiếp.
    const sa = store.audit('service-account.create', 'service-account:sa-1', 'alice', {
      name: 'CI nightly',
      scope: 'run',
    });
    assert.equal(sa.action, 'service-account.create');
    assert.deepEqual(store.verifyAudit(), { ok: true, checked: 4 });

    // reload() đọc lại thay đổi từ store khác.
    const store2 = new TeamStore(dir);
    store2.addMember({ userId: 'carol', name: 'Carol', role: 'member' }, 'system');
    store.reload();
    assert.equal(store.team.members.find((m) => m.userId === 'carol')?.name, 'Carol');
  } finally {
    cleanup(dir);
  }
});

test('M4 TeamStore: actor rỗng → throw; workspace id lạ → throw', () => {
  const dir = makeTempDir('open-bot-store-m4-');
  try {
    const store = new TeamStore(dir);
    assert.throws(
      () => store.addMember({ userId: 'x', name: 'X', role: 'member' }, ''),
      /actor/,
    );
    assert.throws(() => store.removeWorkspace('không-có', 'alice'), /Không có workspace/);
    assert.throws(() => store.audit('x', 'y', ''), /actor/);
    assert.throws(() => new TeamStore(''), /baseDir/);
  } finally {
    cleanup(dir);
  }
});
