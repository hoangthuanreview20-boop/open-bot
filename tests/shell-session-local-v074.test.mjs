/**
 * Tests for v0.74b — local (daemon-less) `shell_session_write` parity
 * with the daemon path (BEYOND-ROADMAP: v0.55 note — local path had
 * NO denylist/egress check at all; a probe wrote
 * `echo BEFORE-PROBE / sudo -n id / echo AFTER-PROBE` to a local
 * session and `sudo` ran as root, `uid=0(root)` in the output).
 *
 * The line-check logic itself moved verbatim into
 * `packages/tools/src/daemon/sessionLine.ts` (shared by daemon +
 * local); these tests prove the LOCAL path now enforces it:
 * denylist per line (incl. var expansion + heredoc + split writes),
 * egress per line (fail-closed without a policy, allowed with one),
 * and flush of the pending fragment on close.
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/shell-session-local-v074.test.mjs
 *
 * All commands are real and local: echo / touch / cat / curl (read-only
 * against example.com, --max-time 3). No x.ai, no secrets. `sudo`
 * appears only as a line that must be BLOCKED, never executed.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SHELL_TOOLS,
  createShellTools,
} from '../packages/tools/dist/shellTools.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const shellTool = (tools, name) => tools.find((t) => t.definition.name === name);

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-shell-local-v074-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

function parseJsonToolOutput(out) {
  assert.doesNotMatch(out, /^Error:/, `expected JSON, got error: ${out}`);
  return JSON.parse(out);
}

async function startSession(tools, dir) {
  const started = parseJsonToolOutput(
    await shellTool(tools, 'shell_session_start').execute({}, CTX(dir)),
  );
  assert.ok(started.sessionId);
  return started.sessionId;
}

async function write(tools, sessionId, dir, input) {
  return shellTool(tools, 'shell_session_write').execute(
    { sessionId, input },
    CTX(dir),
  );
}

async function readOutput(tools, sessionId, dir) {
  return parseJsonToolOutput(
    await shellTool(tools, 'shell_session_read').execute({ sessionId }, CTX(dir)),
  );
}

async function readUntil(tools, sessionId, dir, predicate, timeoutMs = 8000) {
  return waitFor(async () => {
    const out = await readOutput(tools, sessionId, dir);
    return predicate(out.output) ? out : null;
  }, timeoutMs);
}

// ---------------------------------------------------------------------------
// denylist on the local path
// ---------------------------------------------------------------------------

test('local session_write: blocked sudo line dropped, safe lines still run', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS;
  const sessionId = await startSession(tools, dir);
  try {
    const result = await write(
      tools,
      sessionId,
      dir,
      'echo BEFORE-PROBE\nsudo -n id\necho AFTER-PROBE\n',
    );
    // The write reports the blocked line (first one) as an error —
    // exactly like the daemon path — but the safe lines were written.
    assert.match(result, /^Error:/);
    assert.match(result, /denylist/i);
    const read = await readUntil(
      tools,
      sessionId,
      dir,
      (output) => output.includes('BEFORE-PROBE') && output.includes('AFTER-PROBE'),
    );
    assert.match(read.output, /BEFORE-PROBE/);
    assert.match(read.output, /AFTER-PROBE/);
    // The blocked line never reached the shell: no root uid anywhere.
    assert.doesNotMatch(read.output, /uid=0\(root\)/);
    assert.doesNotMatch(read.output, /uid=/);
  } finally {
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
  }
});

test('local session_write: split write across two calls still blocked (fragment buffering)', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS;
  const sessionId = await startSession(tools, dir);
  try {
    const marker = path.join(dir, 'blocked-marker');
    // First half of `sudo` — no newline yet, so nothing is decided.
    const first = await write(tools, sessionId, dir, 'su');
    assert.doesNotMatch(first, /^Error:/);
    // Second half completes the line `sudo -n touch <marker>` → blocked.
    const second = await write(
      tools,
      sessionId,
      dir,
      `do -n touch ${marker}\n`,
    );
    assert.match(second, /^Error:/);
    assert.match(second, /denylist/i);
    // The session is still alive: a safe line after the blocked one runs.
    await write(tools, sessionId, dir, 'echo MARKER-B\n');
    const read = await readUntil(
      tools,
      sessionId,
      dir,
      (output) => output.includes('MARKER-B'),
    );
    assert.match(read.output, /MARKER-B/);
    assert.equal(fs.existsSync(marker), false, 'blocked sudo touch must not run');
  } finally {
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
  }
});

test('local session_write: var expansion blocked, harmless assignment passes', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS;
  const sessionId = await startSession(tools, dir);
  try {
    // Trackable assignment: value stays inert until expanded — passes.
    const assigned = await write(tools, sessionId, dir, 'CMD="rm -rf /"\n');
    assert.doesNotMatch(assigned, /^Error:/);
    // Expanding it yields the denylisted command → blocked.
    const expanded = await write(tools, sessionId, dir, '$CMD\n');
    assert.match(expanded, /^Error:/);
    assert.match(expanded, /denylist/i);
    // Harmless assignment whose value merely CONTAINS a banned word passes.
    const msgAssigned = await write(
      tools,
      sessionId,
      dir,
      'MSG="hello sudo world"\n',
    );
    assert.doesNotMatch(msgAssigned, /^Error:/);
    // But USING that variable expands to a line containing the banned
    // word, so the use-site is blocked — same rule as the daemon path
    // (the check runs on the expanded line, not the raw one).
    const msgUsed = await write(tools, sessionId, dir, 'echo $MSG\n');
    assert.match(msgUsed, /^Error:/);
    assert.match(msgUsed, /denylist/i);
    // A safe variable proves the session is alive and assignments land.
    const greetAssigned = await write(tools, sessionId, dir, 'GREET="hello world"\n');
    assert.doesNotMatch(greetAssigned, /^Error:/);
    await write(tools, sessionId, dir, 'echo $GREET\n');
    const read = await readUntil(
      tools,
      sessionId,
      dir,
      (output) => output.includes('hello world'),
    );
    assert.match(read.output, /hello world/);
  } finally {
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
  }
});

test('local session_write: heredoc content checked, safe lines pass', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS;
  const sessionId = await startSession(tools, dir);
  try {
    const result = await write(
      tools,
      sessionId,
      dir,
      'cat <<EOF\necho SAFE-HEREDOC\nsudo -n true\nEOF\n',
    );
    assert.match(result, /^Error:/);
    assert.match(result, /denylist/i);
    const read = await readUntil(
      tools,
      sessionId,
      dir,
      (output) => output.includes('SAFE-HEREDOC'),
    );
    assert.match(read.output, /SAFE-HEREDOC/);
    // The blocked heredoc line never reached `cat`.
    assert.doesNotMatch(read.output, /sudo -n true/);
  } finally {
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
  }
});

// ---------------------------------------------------------------------------
// egress on the local path
// ---------------------------------------------------------------------------

test('local session_write: network line blocked without a policy (fail-closed)', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS; // no getEgressPolicy resolver
  const sessionId = await startSession(tools, dir);
  try {
    const result = await write(tools, sessionId, dir, 'curl https://example.com\n');
    assert.match(result, /^Error:/);
    assert.match(result, /egress_unconfigured/i);
    // Session still alive after the blocked line.
    await write(tools, sessionId, dir, 'echo ALIVE-AFTER-EGRESS\n');
    const read = await readUntil(
      tools,
      sessionId,
      dir,
      (output) => output.includes('ALIVE-AFTER-EGRESS'),
    );
    assert.match(read.output, /ALIVE-AFTER-EGRESS/);
  } finally {
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
  }
});

test('local session_write: network line allowed with an allowlist policy', async () => {
  const dir = makeTempWorkspace();
  const tools = createShellTools({
    getEgressPolicy: () => ({ mode: 'allowlist', allowHosts: ['example.com'] }),
  });
  const sessionId = await startSession(tools, dir);
  try {
    // The write itself must be accepted (not an Error) — the curl runs
    // in the session afterwards; this test only proves the line passed
    // the egress gate, not that the fetch succeeded.
    const result = await write(
      tools,
      sessionId,
      dir,
      'curl -s -o /dev/null --max-time 3 https://example.com\n',
    );
    assert.doesNotMatch(result, /^Error:/);
  } finally {
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
  }
});

// ---------------------------------------------------------------------------
// v0.74b follow-up: egress-allow must REALLY open the connection, not
// just "not block the write". The test above only asserts the write was
// accepted — a gate that silently dropped the line after accepting it
// (or a session whose network was dead) would still pass. These tests
// run a real `curl` from inside the session against a local HTTP
// server and assert the exact response body comes back through the
// session output.
// ---------------------------------------------------------------------------

/** Local HTTP server answering one fixed body; listens on 127.0.0.1:0. */
function startLocalHttpServer(body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

async function stopLocalHttpServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

test('local session_write: egress-allow fetch thật tới server local trả đúng body', async () => {
  const dir = makeTempWorkspace();
  const body = 'EGRESS-ALLOW-BODY-7f3a9';
  const { server, port } = await startLocalHttpServer(body);
  try {
    // Loopback is a private destination for context 'agent': it needs
    // an explicit allowPrivateDestinations (allowHosts alone does not
    // open it — see the negative test below).
    const tools = createShellTools({
      getEgressPolicy: () => ({
        mode: 'allowlist',
        allowHosts: ['127.0.0.1'],
        allowIpRanges: ['127.0.0.1'],
        allowPrivateDestinations: true,
      }),
    });
    const sessionId = await startSession(tools, dir);
    try {
      const result = await write(
        tools,
        sessionId,
        dir,
        `curl -s --noproxy '*' --max-time 5 http://127.0.0.1:${port}/hello\n`,
      );
      assert.doesNotMatch(result, /^Error:/, 'curl qua egress-allow phải được ghi, không bị chặn');
      // The body must come back THROUGH the session: proves the egress
      // gate really opened the connection and the fetch succeeded.
      const read = await readUntil(
        tools,
        sessionId,
        dir,
        (output) => output.includes(body),
        10000,
      );
      assert.match(read.output, new RegExp(body));
    } finally {
      await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
    }
  } finally {
    await stopLocalHttpServer(server);
  }
});

test('local session_write: loopback bị chặn khi policy không bật allowPrivateDestinations', async () => {
  const dir = makeTempWorkspace();
  const body = 'EGRESS-DENY-BODY-must-not-appear';
  const { server, port } = await startLocalHttpServer(body);
  try {
    // Same allowlist as the positive test, MINUS allowPrivateDestinations:
    // 127.0.0.1 is private, so context 'agent' must block it. This
    // guards the positive test — it proves the fetch there succeeded
    // because the policy allowed it, not because loopback is always open.
    const tools = createShellTools({
      getEgressPolicy: () => ({
        mode: 'allowlist',
        allowHosts: ['127.0.0.1'],
        allowIpRanges: ['127.0.0.1'],
      }),
    });
    const sessionId = await startSession(tools, dir);
    try {
      const result = await write(
        tools,
        sessionId,
        dir,
        `curl -s --noproxy '*' --max-time 5 http://127.0.0.1:${port}/hello\n`,
      );
      assert.match(result, /^Error:/);
      assert.match(result, /egress/i);
      await write(tools, sessionId, dir, 'echo ALIVE-AFTER-LOOPBACK-DENY\n');
      const read = await readUntil(
        tools,
        sessionId,
        dir,
        (output) => output.includes('ALIVE-AFTER-LOOPBACK-DENY'),
      );
      assert.match(read.output, /ALIVE-AFTER-LOOPBACK-DENY/);
      assert.doesNotMatch(read.output, /EGRESS-DENY-BODY/);
    } finally {
      await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir));
    }
  } finally {
    await stopLocalHttpServer(server);
  }
});

// ---------------------------------------------------------------------------
// flush on close (local path)
// ---------------------------------------------------------------------------

test('local session_close: pending fragment flushed, blocked fragment dropped', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS;
  // Safe fragment (no trailing newline): flushed + `\n` on close.
  const flushedMarker = path.join(dir, 'flushed-marker');
  const s1 = await startSession(tools, dir);
  const w1 = await write(tools, s1, dir, `touch ${flushedMarker}`);
  assert.doesNotMatch(w1, /^Error:/);
  await shellTool(tools, 'shell_session_close').execute({ sessionId: s1 }, CTX(dir));
  await waitFor(() => (fs.existsSync(flushedMarker) ? true : null), 5000);
  assert.equal(fs.existsSync(flushedMarker), true, 'flushed fragment must run on close');

  // Blocked fragment: checked on flush, dropped, never runs.
  const blockedMarker = path.join(dir, 'blocked-marker');
  const s2 = await startSession(tools, dir);
  const w2 = await write(tools, s2, dir, `sudo -n touch ${blockedMarker}`);
  assert.doesNotMatch(w2, /^Error:/, 'fragment is not decided until close');
  await shellTool(tools, 'shell_session_close').execute({ sessionId: s2 }, CTX(dir));
  await sleep(1200);
  assert.equal(fs.existsSync(blockedMarker), false, 'blocked fragment must not run on close');
});
