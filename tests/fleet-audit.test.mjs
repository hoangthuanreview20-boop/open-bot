/**
 * Fleet audit + decision log tests: chuỗi hash SHA-256, verify,
 * phát hiện sửa/xoá dòng.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendFleetAuditEvent,
  appendFleetDecision,
  listFleetAuditEvents,
  listFleetDecisions,
  readFleetAuditEvents,
  readFleetDecisions,
  verifyFleetAuditLog,
  verifyFleetDecisionLog,
} from '../packages/core/dist/fleet/audit.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-'));
}

test('audit: ghi + đọc + verify chuỗi hash', () => {
  const dir = tmpDir();
  assert.deepEqual(verifyFleetAuditLog(dir), { ok: true, checked: 0 });
  const e1 = appendFleetAuditEvent(dir, { actor: 'root', action: 'workspace.create', target: 'workspace:fw-1' });
  const e2 = appendFleetAuditEvent(dir, { actor: 'root', action: 'service.start', target: 'workspace:fw-1', detail: { port: 18001 } });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e2.prevHash, e1.hash);
  assert.notEqual(e1.hash, e2.hash);
  assert.deepEqual(verifyFleetAuditLog(dir), { ok: true, checked: 2 });
  assert.equal(readFleetAuditEvents(dir).length, 2);
  assert.equal(listFleetAuditEvents(dir, { action: 'service.start' }).length, 1);
  assert.equal(listFleetAuditEvents(dir, { actor: 'nobody' }).length, 0);
});

test('audit: sửa nội dung dòng → verify fail đúng dòng', () => {
  const dir = tmpDir();
  appendFleetAuditEvent(dir, { actor: 'root', action: 'workspace.create', target: 'workspace:fw-1' });
  appendFleetAuditEvent(dir, { actor: 'root', action: 'service.start', target: 'workspace:fw-1' });
  const file = path.join(dir, 'fleet.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.action = 'workspace.remove';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  const result = verifyFleetAuditLog(dir);
  assert.equal(result.ok, false);
  assert.equal(result.badLine, 2);
  assert.match(result.reason ?? '', /hash sai/);
});

test('audit: xoá 1 dòng giữa → verify fail vì seq/prevHash đứt', () => {
  const dir = tmpDir();
  appendFleetAuditEvent(dir, { actor: 'root', action: 'a', target: 't1' });
  appendFleetAuditEvent(dir, { actor: 'root', action: 'b', target: 't2' });
  appendFleetAuditEvent(dir, { actor: 'root', action: 'c', target: 't3' });
  const file = path.join(dir, 'fleet.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.splice(1, 1);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  const result = verifyFleetAuditLog(dir);
  assert.equal(result.ok, false);
  assert.equal(result.badLine, 2);
});

test('audit: dòng không phải JSON / sai shape → throw kèm số dòng', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'fleet.jsonl'), '{"actor":"x"}\n', 'utf8');
  assert.throws(() => readFleetAuditEvents(dir), /dòng 1/);
  fs.writeFileSync(path.join(dir, 'fleet.jsonl'), 'không phải json\n', 'utf8');
  assert.throws(() => readFleetAuditEvents(dir), /không phải JSON hợp lệ/);
  assert.throws(() => appendFleetAuditEvent(dir, { actor: '', action: 'a', target: 't' }), /actor không rỗng/);
});

test('decisions: allow/deny đều ghi, verify chuỗi hash, lọc theo decision', () => {
  const dir = tmpDir();
  const d1 = appendFleetDecision(dir, { actor: 'admin', action: 'workspace.create', target: 'workspace:alice', decision: 'allow' });
  const d2 = appendFleetDecision(dir, {
    actor: 'admin',
    action: 'workspace.create',
    target: 'workspace:bob',
    decision: 'deny',
    reason: 'not-enough-ram',
  });
  assert.equal(d1.decision, 'allow');
  assert.equal(d2.decision, 'deny');
  assert.equal(d2.reason, 'not-enough-ram');
  assert.equal(d2.prevHash, d1.hash);
  assert.deepEqual(verifyFleetDecisionLog(dir), { ok: true, checked: 2 });
  assert.equal(listFleetDecisions(dir, { decision: 'deny' }).length, 1);
  assert.equal(listFleetDecisions(dir).length, 2);
  assert.equal(readFleetDecisions(dir)[0].action, 'workspace.create');
});

test('decisions: sửa decision trong detail → verify fail (hash bao phủ decision)', () => {
  const dir = tmpDir();
  appendFleetDecision(dir, { actor: 'admin', action: 'workspace.create', target: 'workspace:alice', decision: 'deny', reason: 'x' });
  const file = path.join(dir, 'decisions.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.detail.decision = 'allow';
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  const result = verifyFleetDecisionLog(dir);
  assert.equal(result.ok, false);
  assert.equal(result.badLine, 1);
});
