/**
 * Test v1.02 (Team T3): MCP audit log — redaction, query/filter,
 * summary, hash chain, file store, auditMcpCall helper.
 *
 * Only local code (no network, no real MCP server).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-audit-log-v102.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  McpAuditLog,
  FileMcpAuditLog,
  auditMcpCall,
  redactMcpSecrets,
  summarizeMcpResult,
  MCP_AUDIT_REDACTED,
} from '../packages/core/dist/mcp/auditLog.js';

function record(log, overrides = {}) {
  return log.record({
    direction: 'client',
    server: 'srv-a',
    method: 'tools/call',
    tool: 'echo',
    outcome: 'ok',
    durationMs: 12,
    ...overrides,
  });
}

test('redaction: secret keys, bearer values and nested secrets never survive', () => {
  const redacted = redactMcpSecrets({
    text: 'hello',
    apiKey: 'sk-secret-123',
    nested: { password: 'hunter2', token: 'abc', ok: 1 },
    headers: { Authorization: 'Bearer xyz-123' },
    list: [{ client_secret: 'shh' }, 'plain'],
    bearerValue: 'Bearer token-value-here',
    skValue: 'sk-abcdefgh12345678',
  });
  assert.equal(redacted.text, 'hello');
  assert.equal(redacted.apiKey, MCP_AUDIT_REDACTED);
  assert.equal(redacted.nested.password, MCP_AUDIT_REDACTED);
  assert.equal(redacted.nested.token, MCP_AUDIT_REDACTED);
  assert.equal(redacted.nested.ok, 1);
  assert.equal(redacted.headers.Authorization, MCP_AUDIT_REDACTED);
  assert.equal(redacted.list[0].client_secret, MCP_AUDIT_REDACTED);
  assert.equal(redacted.list[1], 'plain');
  assert.equal(redacted.bearerValue, MCP_AUDIT_REDACTED);
  assert.equal(redacted.skValue, MCP_AUDIT_REDACTED);
});

test('redaction: long strings are truncated, short values kept whole', () => {
  const redacted = redactMcpSecrets({ short: 'abc', long: 'x'.repeat(2000) });
  assert.equal(redacted.short, 'abc');
  assert.ok(redacted.long.length < 2000);
  assert.ok(redacted.long.includes('[truncated'));
});

test('record + query: filters by method/tool/outcome/caller/time/text, newest first', () => {
  const log = new McpAuditLog();
  record(log, { tool: 'echo', caller: 'bot-1', at: '2026-11-14T00:00:00.000Z' });
  record(log, { tool: 'read', method: 'resources/read', outcome: 'error', errorCode: -32602, caller: 'bot-2', at: '2026-11-14T00:01:00.000Z' });
  record(log, { tool: 'echo', caller: 'bot-1', at: '2026-11-14T00:02:00.000Z' });
  assert.equal(log.size, 3);
  assert.equal(log.query().length, 3);
  // Newest first.
  assert.equal(log.query()[0].at, '2026-11-14T00:02:00.000Z');
  assert.equal(log.query({ tool: 'echo' }).length, 2);
  assert.equal(log.query({ outcome: 'error' }).length, 1);
  assert.equal(log.query({ caller: 'bot-2' })[0].tool, 'read');
  assert.equal(log.query({ method: 'resources/read' }).length, 1);
  assert.equal(log.query({ fromAt: '2026-11-14T00:01:00.000Z', toAt: '2026-11-14T00:01:00.000Z' }).length, 1);
  assert.equal(log.query({ text: 'bot-1' }).length, 2);
  // Paging: limit + offset.
  assert.equal(log.query({ limit: 1 }).length, 1);
  assert.equal(log.query({ limit: 1, offset: 1 })[0].at, '2026-11-14T00:01:00.000Z');
  // Args are stored redacted.
  const withSecret = record(log, { args: { text: 'hi', apiKey: 'sk-top-secret' } });
  assert.equal(withSecret.args.apiKey, MCP_AUDIT_REDACTED);
  assert.equal(withSecret.args.text, 'hi');
  // Sequence numbers are monotonic.
  const seqs = log.query({ limit: 100 }).map((e) => e.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('summarize: counts by outcome/method/server/tool + durations', () => {
  const log = new McpAuditLog();
  record(log, { tool: 'echo', durationMs: 10 });
  record(log, { tool: 'echo', durationMs: 30 });
  record(log, { tool: 'read', method: 'resources/read', outcome: 'error', durationMs: 20, server: 'srv-b' });
  const s = log.summarize();
  assert.equal(s.total, 3);
  assert.equal(s.byOutcome.ok, 2);
  assert.equal(s.byOutcome.error, 1);
  assert.equal(s.byMethod['tools/call'], 2);
  assert.equal(s.byMethod['resources/read'], 1);
  assert.equal(s.byServer['srv-a'], 2);
  assert.equal(s.byServer['srv-b'], 1);
  assert.equal(s.byTool.echo, 2);
  assert.equal(s.avgDurationMs, 20);
  assert.equal(s.maxDurationMs, 30);
  assert.equal(log.summarize({ tool: 'echo' }).total, 2);
});

test('hash chain: verifies clean, detects tampering after reload from file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-audit-v102-'));
  const file = path.join(dir, 'audit.jsonl');
  const log = new FileMcpAuditLog(file);
  record(log, { tool: 'echo' });
  record(log, { tool: 'read', method: 'resources/read' });
  assert.equal(log.verifyChain().ok, true);
  assert.equal(log.loadedEntries, 0);
  // Reload: chain still verifies.
  const reloaded = new FileMcpAuditLog(file);
  assert.equal(reloaded.loadedEntries, 2);
  assert.equal(reloaded.verifyChain().ok, true);
  assert.equal(reloaded.size, 2);
  // Tamper with the second line on disk (change outcome) and reload.
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.outcome = 'error';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const tamperedLog = new FileMcpAuditLog(file);
  const verification = tamperedLog.verifyChain();
  assert.equal(verification.ok, false);
  assert.equal(verification.firstBadSeq, 2);
  assert.match(verification.reason ?? '', /hash mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file store: corrupt lines are skipped, not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-audit-v102-'));
  const file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, 'not json\n{"seq": 1, "version": 1}\n');
  const log = new FileMcpAuditLog(file);
  assert.equal(log.corruptLines, 2);
  assert.equal(log.loadedEntries, 0);
  assert.equal(log.size, 0);
  // Recording still works after a corrupt load.
  record(log);
  assert.equal(log.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auditMcpCall: records ok and error, rethrows the original error', async () => {
  const log = new McpAuditLog();
  const ok = await auditMcpCall(
    log,
    { direction: 'client', server: 'srv-a', method: 'tools/call', tool: 'echo', args: { text: 'hi' } },
    async () => ({ content: [{ type: 'text', text: 'hi' }] }),
  );
  assert.deepEqual(ok, { content: [{ type: 'text', text: 'hi' }] });
  const boom = new Error('kaboom');
  await assert.rejects(
    auditMcpCall(
      log,
      { direction: 'client', server: 'srv-a', method: 'tools/call', tool: 'echo' },
      async () => {
        throw boom;
      },
    ),
    (err) => err === boom,
  );
  const entries = log.query({ limit: 10 });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].outcome, 'error');
  assert.equal(entries[0].errorMessage, 'kaboom');
  assert.equal(entries[1].outcome, 'ok');
  assert.ok(entries[1].resultSummary?.includes('hi'));
  // No logger = passthrough, no crash.
  const passthrough = await auditMcpCall(undefined, { direction: 'client', server: 'x', method: 'ping' }, async () => 42);
  assert.equal(passthrough, 42);
});

test('summarizeMcpResult: tool errors and content counts', () => {
  assert.equal(summarizeMcpResult(undefined), '(no result)');
  assert.equal(summarizeMcpResult('plain text'), 'plain text');
  const summary = summarizeMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false });
  assert.match(summary, /2 content item/);
  const errSummary = summarizeMcpResult({ content: [{ type: 'text', text: 'bad args' }], isError: true });
  assert.match(errSummary, /isError=true/);
  assert.match(errSummary, /bad args/);
});

test('ring buffer: oldest entries drop after the cap, chain still verifies', () => {
  const log = new McpAuditLog({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) record(log, { tool: `t${i}` });
  assert.equal(log.size, 3);
  assert.deepEqual(log.query({ limit: 10 }).map((e) => e.tool), ['t4', 't3', 't2']);
  assert.equal(log.verifyChain().ok, true);
});
