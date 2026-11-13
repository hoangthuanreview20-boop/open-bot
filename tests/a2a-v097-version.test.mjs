/**
 * Test v0.97 (Đội T2): A2A protocol version negotiation (1.0 / 1.0.1).
 *
 * Chỉ test thuần (không mạng): parse, compare, negotiate, check card.
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-v097-version.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_MIN_PROTOCOL_VERSION,
  A2A_PROTOCOL_VERSION,
  A2A_SUPPORTED_PROTOCOL_VERSIONS,
  checkAgentCardVersion,
  compareA2aProtocolVersions,
  isCompatibleProtocolVersion,
  negotiateProtocolVersion,
  parseA2aProtocolVersion,
} from '../packages/core/dist/a2a/version.js';

test('parse: 1.0, 1.0.1, hậu tố build; lạ → null', () => {
  assert.deepEqual(parseA2aProtocolVersion('1.0'), { major: 1, minor: 0, patch: 0, raw: '1.0' });
  assert.deepEqual(parseA2aProtocolVersion('1.0.1'), { major: 1, minor: 0, patch: 1, raw: '1.0.1' });
  assert.equal(parseA2aProtocolVersion('1.0.1-rc.1')?.patch, 1);
  assert.equal(parseA2aProtocolVersion(''), null);
  assert.equal(parseA2aProtocolVersion('v1'), null);
  assert.equal(parseA2aProtocolVersion('banana'), null);
  assert.equal(parseA2aProtocolVersion('1.0.0.0'), null);
  assert.equal(parseA2aProtocolVersion(undefined), null);
  assert.equal(parseA2aProtocolVersion('  1.0  ')?.minor, 0);
});

test('compare: major → minor → patch', () => {
  const v101 = parseA2aProtocolVersion('1.0.1');
  const v100 = parseA2aProtocolVersion('1.0');
  const v200 = parseA2aProtocolVersion('2.0');
  assert.ok(compareA2aProtocolVersions(v101, v100) > 0);
  assert.ok(compareA2aProtocolVersions(v100, v101) < 0);
  assert.equal(compareA2aProtocolVersions(v100, parseA2aProtocolVersion('1.0.0')), 0);
  assert.ok(compareA2aProtocolVersions(v200, v101) > 0);
});

test('constants: open-bot nói 1.0.1, hỗ trợ [1.0.1, 1.0], tối thiểu 1.0', () => {
  assert.equal(A2A_PROTOCOL_VERSION, '1.0.1');
  assert.deepEqual([...A2A_SUPPORTED_PROTOCOL_VERSIONS], ['1.0.1', '1.0']);
  assert.equal(A2A_MIN_PROTOCOL_VERSION, '1.0');
});

test('negotiate: giao nhau → bản cao nhất chung', () => {
  const r = negotiateProtocolVersion(['1.0', '1.0.1'], ['1.0']);
  assert.equal(r.ok, true);
  assert.equal(r.negotiated, '1.0');
  const r2 = negotiateProtocolVersion(['1.0.1'], ['1.0.1', '1.0']);
  assert.equal(r2.ok, true);
  assert.equal(r2.negotiated, '1.0.1');
});

test('negotiate: khác major → không đàm phán được, lý do rõ ràng', () => {
  const r = negotiateProtocolVersion(['2.0'], ['1.0', '1.0.1']);
  assert.equal(r.ok, false);
  assert.equal(r.negotiated, null);
  assert.match(r.reason ?? '', /không có protocol version chung/i);
});

test('negotiate: version lạ một bên → fail closed; list rỗng → mặc định 1.0.1', () => {
  const r = negotiateProtocolVersion(['banana'], ['1.0']);
  assert.equal(r.ok, false);
  // Client không khai version → mặc định 1.0.1, server chỉ nói 1.0
  // → đàm phán xuống 1.0 (minor tương thích ngược).
  const r2 = negotiateProtocolVersion([], ['1.0']);
  assert.equal(r2.ok, true);
  assert.equal(r2.negotiated, '1.0');
  // Ngược lại: client 1.0, server 1.0.1 → cũng 1.0.
  const r3 = negotiateProtocolVersion(['1.0'], ['1.0.1']);
  assert.equal(r3.ok, true);
  assert.equal(r3.negotiated, '1.0');
});

test('isCompatible: cùng major 1.x → true; 2.0 vs 1.0 → false', () => {
  assert.equal(isCompatibleProtocolVersion('1.0', '1.0.1'), true);
  assert.equal(isCompatibleProtocolVersion('1.0.1', '1.0.1'), true);
  assert.equal(isCompatibleProtocolVersion('2.0', '1.0'), false);
  assert.equal(isCompatibleProtocolVersion('0.9', '1.0'), false);
  assert.equal(isCompatibleProtocolVersion('banana', '1.0'), false);
});

test('checkAgentCardVersion: card 1.0 → ok + cảnh báo bản cũ', () => {
  const c = checkAgentCardVersion({ protocolVersion: '1.0' });
  assert.equal(c.ok, true);
  assert.equal(c.cardVersion, '1.0');
  assert.equal(c.negotiated, '1.0');
  assert.equal(c.warnings.length, 1);
});

test('checkAgentCardVersion: card 1.0.1 → ok, không cảnh báo', () => {
  const c = checkAgentCardVersion({ protocolVersion: '1.0.1' });
  assert.equal(c.ok, true);
  assert.equal(c.negotiated, '1.0.1');
  assert.equal(c.warnings.length, 0);
});

test('checkAgentCardVersion: card không ghi version → coi như 1.0 + cảnh báo', () => {
  const c = checkAgentCardVersion({});
  assert.equal(c.ok, true);
  assert.equal(c.cardVersion, null);
  assert.equal(c.negotiated, '1.0');
  assert.equal(c.warnings.length, 1);
  const c2 = checkAgentCardVersion(null);
  assert.equal(c2.ok, false);
});

test('checkAgentCardVersion: card 2.0 / lạ → không tương thích', () => {
  const c = checkAgentCardVersion({ protocolVersion: '2.0' });
  assert.equal(c.ok, false);
  assert.equal(c.negotiated, null);
  assert.match(c.reason ?? '', /không có protocol version chung/i);
  const bad = checkAgentCardVersion({ protocolVersion: 'banana' });
  assert.equal(bad.ok, false);
});
