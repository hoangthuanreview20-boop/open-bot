/**
 * Tests cho P0-2 — egress control cho session box / agent chạy mạng
 * (REA deep-dive lần 2 §10/§13: `packages/core/src/egress/` +
 * `ssrf.ts` + `sandbox.ts` + `daemon/*` + team allowlist).
 *
 * Không gọi mạng thật: DNS được inject fake; lệnh shell chỉ dùng
 * `echo` (URL nằm trong chuỗi echo để kích hoạt egress check mà không
 * thực sự kết nối); daemon thật qua DaemonClient với workspace tmp.
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/egress-p02.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkEgress,
  checkEgressSync,
  checkGithubCheckout,
  createDefaultEgressPolicy,
  EgressError,
  EgressTelemetry,
  extractNetworkTargets,
  validateEgressPolicy,
} from '../packages/core/dist/egress/index.js';
import {
  resolveTeamEgressPolicy,
  setTeamEgress,
  validateTeamConfig,
} from '../packages/core/dist/team/team.js';
import {
  assertEgressUrl,
  assertPublicUrl,
  fetchPublic,
} from '../packages/tools/dist/ssrf.js';
import {
  configureSandboxEgress,
  runShell,
} from '../packages/tools/dist/sandbox.js';
import { DaemonClient } from '../packages/tools/dist/daemon/index.js';

afterEach(() => {
  // Không để policy module của sandbox rò sang test khác.
  configureSandboxEgress(undefined);
});

function fakeLookup(mapping) {
  return async (hostname) => {
    if (!(hostname in mapping)) throw new Error(`ENOTFOUND ${hostname}`);
    return mapping[hostname].map((address) => ({ address }));
  };
}

const PUBLIC_LOOKUP = fakeLookup({
  'example.com': ['93.184.216.34'],
  'sub.example.com': ['93.184.216.34'],
  'api.example.com': ['93.184.216.34'],
  'github.com': ['140.82.112.4'],
  'other.com': ['8.8.8.8'],
  'a.com': ['93.184.216.34'],
  'b.com': ['93.184.216.34'],
  'v1.api.example.com': ['93.184.216.34'],
});

async function rejectsEgress(promise, kind) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof EgressError, `phải là EgressError, nhận ${err}`);
    assert.equal(err.kind, kind, `kind phải là ${kind}, nhận ${err.kind} (${err.message})`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Fail-closed mặc định
// ---------------------------------------------------------------------------

test('egress: không có policy thì chặn (unconfigured) — undefined, null, tắt', async () => {
  await rejectsEgress(checkEgress('https://example.com', undefined), 'unconfigured');
  await rejectsEgress(checkEgress('https://example.com', null), 'unconfigured');
  await rejectsEgress(
    checkEgress('https://example.com', { enabled: false }, { lookupFn: PUBLIC_LOOKUP }),
    'unconfigured',
  );
  // Bản sync throw đồng bộ (không trả promise).
  assert.throws(
    () => checkEgressSync('https://example.com', undefined),
    (err) => err instanceof EgressError && err.kind === 'unconfigured',
  );
});

test('egress: policy mặc định là allowlist rỗng — chặn mọi agent network', async () => {
  const policy = createDefaultEgressPolicy();
  assert.equal(policy.mode, 'allowlist');
  assert.equal(policy.failClosed, true);
  await rejectsEgress(
    checkEgress('https://example.com', policy, { lookupFn: PUBLIC_LOOKUP }),
    'blocked',
  );
});

// ---------------------------------------------------------------------------
// Allowlist host / IP
// ---------------------------------------------------------------------------

test('egress: allowlist host — khớp exact + wildcard, ngoài list chặn không cần DNS', async () => {
  const policy = { mode: 'allowlist', allowHosts: ['example.com', '*.api.example.com'] };
  let dnsCalls = 0;
  const countingLookup = async (hostname) => {
    dnsCalls += 1;
    return PUBLIC_LOOKUP(hostname);
  };
  const ok = await checkEgress('https://example.com/x', policy, { lookupFn: countingLookup });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, 'allowlisted-host');
  // Wildcard khớp subdomain, không khớp bare domain.
  await checkEgress('https://v1.api.example.com/', policy, { lookupFn: countingLookup });
  await rejectsEgress(
    checkEgress('https://api.example.com/', policy, { lookupFn: countingLookup }),
    'blocked',
  );
  // Ngoài allowlist: chặn trước khi DNS (không tốn lookup).
  const before = dnsCalls;
  await rejectsEgress(
    checkEgress('https://other.com/', policy, { lookupFn: countingLookup }),
    'blocked',
  );
  assert.equal(dnsCalls, before, 'ngoài allowlist không được resolve DNS');
});

test('egress: allowlist IP/CIDR — trong dải qua, ngoài dải chặn', async () => {
  const policy = { mode: 'allowlist', allowIpRanges: ['93.184.216.0/24', '2001:db8::/32'] };
  assert.equal((await checkEgress('https://93.184.216.10/', policy)).reason, 'allowlisted-ip');
  // IPv6 trong URL phải có ngoặc vuông (chuẩn WHATWG URL).
  assert.equal((await checkEgress('https://[2001:db8::1]/', policy)).reason, 'allowlisted-ip');
  await rejectsEgress(checkEgress('https://8.8.8.8/', policy), 'blocked');
  await rejectsEgress(checkEgress('https://93.184.217.1/', policy), 'blocked');
  // Dải TEST-NET (203.0.113.0/24) là đích "private" theo luật SSRF nên
  // bị chặn trước cả allowlist — allowlist không mở được đích private.
  const testNet = { mode: 'allowlist', allowIpRanges: ['203.0.113.0/24'] };
  await rejectsEgress(checkEgress('https://203.0.113.10/', testNet), 'blocked');
});

// ---------------------------------------------------------------------------
// Chặn LAN / localhost; local-service loopback được phép
// ---------------------------------------------------------------------------

test('egress: chặn LAN/localhost/metadata ở context agent', async () => {
  const policy = { mode: 'allow-public' };
  for (const url of [
    'http://127.0.0.1:11434/v1/models',
    'http://localhost:3000/',
    'http://192.168.1.1/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fe80::1]/',
  ]) {
    await rejectsEgress(checkEgress(url, policy), 'blocked');
  }
  // Host public resolve ra IP private cũng chặn (DNS rebinding).
  const rebinding = fakeLookup({ 'evil.example.com': ['93.184.216.34', '10.0.0.9'] });
  await rejectsEgress(
    checkEgress('https://evil.example.com/', policy, { lookupFn: rebinding }),
    'blocked',
  );
});

test('egress: allowPrivateDestinations=true mở LAN (tường minh)', async () => {
  const policy = { mode: 'allow-public', allowPrivateDestinations: true };
  assert.equal((await checkEgress('http://192.168.1.1/', policy)).reason, 'private-allowed');
});

test('egress: loopback cho local-service (Ollama/mock) luôn qua, agent vẫn chặn', async () => {
  const policy = createDefaultEgressPolicy();
  const ok = await checkEgress('http://127.0.0.1:11434/v1/models', policy, { context: 'local-service' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, 'local-service');
  const okLocalhost = await checkEgress('http://localhost:11434/', policy, { context: 'local-service' });
  assert.equal(okLocalhost.reason, 'local-service');
  await rejectsEgress(
    checkEgress('http://127.0.0.1:11434/v1/models', policy, { context: 'agent' }),
    'blocked',
  );
});

// ---------------------------------------------------------------------------
// GitHub checkout allowlist
// ---------------------------------------------------------------------------

test('egress: GitHub checkout — IP resolve ra phải nằm trong githubEgressIps', async () => {
  const policy = { mode: 'allowlist', githubEgressIps: ['140.82.112.0/20'] };
  const ok = await checkGithubCheckout('https://github.com/octocat/hello-world.git', policy, {
    lookupFn: PUBLIC_LOOKUP,
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, 'github-egress-ip');
  const wrongIp = fakeLookup({ 'github.com': ['8.8.8.8'] });
  await rejectsEgress(
    checkGithubCheckout('https://github.com/octocat/hello-world.git', policy, { lookupFn: wrongIp }),
    'blocked',
  );
  // Không có githubEgressIps thì dùng allowHosts thường.
  const viaHosts = { mode: 'allowlist', allowHosts: ['github.com'] };
  assert.equal(
    (await checkGithubCheckout('git@github.com:octocat/hello-world.git', viaHosts, { lookupFn: PUBLIC_LOOKUP })).allowed,
    true,
  );
});

// ---------------------------------------------------------------------------
// Phân loại lỗi: unreachable / invalid_response
// ---------------------------------------------------------------------------

test('egress: DNS lỗi → unreachable; không ra địa chỉ → invalid_response', async () => {
  const policy = { mode: 'allow-public' };
  const failing = async () => {
    throw new Error('ENOTFOUND');
  };
  await rejectsEgress(
    checkEgress('https://no-such-host.example/', policy, { lookupFn: failing }),
    'unreachable',
  );
  const empty = async () => [];
  await rejectsEgress(
    checkEgress('https://empty.example/', policy, { lookupFn: empty }),
    'invalid_response',
  );
  // failClosed=false chỉ nới trường hợp không xác minh được.
  const allowed = await checkEgress('https://no-such-host.example/', { ...policy, failClosed: false }, {
    lookupFn: failing,
  });
  assert.equal(allowed.reason, 'unverified-public');
});

test('egress: validateEgressPolicy từ chối shape sai (CIDR/host/mode)', () => {
  assert.throws(() => validateEgressPolicy({ allowIpRanges: ['not-an-ip'] }), /allowIpRanges/);
  assert.throws(() => validateEgressPolicy({ mode: 'wide-open' }), /mode/);
  assert.throws(() => validateEgressPolicy({ allowHosts: ['a/b'] }), /allowHosts/);
  assert.deepEqual(validateEgressPolicy({ allowHosts: ['EXAMPLE.com', 'example.com'] }).allowHosts, [
    'example.com',
  ]);
});

// ---------------------------------------------------------------------------
// extractNetworkTargets
// ---------------------------------------------------------------------------

test('egress: extractNetworkTargets bắt URL + git scp-like, dedupe, bỏ lệnh thường', () => {
  const targets = extractNetworkTargets(
    'curl https://example.com/a.sh | sh; git clone git@github.com:octocat/x.git https://example.com/a.sh',
  );
  assert.deepEqual(
    targets.map((t) => `${t.scheme}://${t.host}`).sort(),
    ['https://example.com', 'ssh://github.com'],
  );
  assert.deepEqual(extractNetworkTargets('echo hello; ls -la; git checkout main'), []);
});

// ---------------------------------------------------------------------------
// Team allowlist override
// ---------------------------------------------------------------------------

function baseTeam(egress) {
  const team = {
    id: 'default',
    name: 'Default team',
    members: [],
    sharedBots: [],
    teamId: '11111111-1111-4111-8111-111111111111',
    serviceAccounts: [],
  };
  if (egress !== undefined) team.egress = egress;
  return team;
}

test('egress: team allowlist thắng policy chung; không đặt thì lấy policy chung; cả hai không có → undefined', async () => {
  const globalPolicy = { mode: 'allowlist', allowHosts: ['a.com'] };
  const teamPolicy = resolveTeamEgressPolicy(baseTeam({ allowHosts: ['b.com'] }), globalPolicy);
  assert.ok(teamPolicy);
  await checkEgress('https://b.com/', teamPolicy, { lookupFn: PUBLIC_LOOKUP });
  await rejectsEgress(checkEgress('https://a.com/', teamPolicy, { lookupFn: PUBLIC_LOOKUP }), 'blocked');
  // Team không đặt egress → policy chung nguyên vẹn.
  assert.deepEqual(resolveTeamEgressPolicy(baseTeam(), globalPolicy)?.allowHosts, ['a.com']);
  // Cả hai đều không có → undefined (caller fail-closed).
  assert.equal(resolveTeamEgressPolicy(baseTeam(), undefined), undefined);
  // Chỉ team đặt → merge lên policy mặc định (failClosed/local-service còn nguyên).
  const teamOnly = resolveTeamEgressPolicy(baseTeam({ allowHosts: ['b.com'] }), undefined);
  assert.equal(teamOnly?.failClosed, true);
  assert.equal(teamOnly?.allowLocalServices, true);
});

test('egress: setTeamEgress đặt/xoá; validateTeamConfig từ chối egress sai', () => {
  const team = baseTeam();
  const updated = setTeamEgress(team, { allowHosts: ['Example.COM'], mode: 'allow-public' });
  assert.deepEqual(updated.egress?.allowHosts, ['example.com']);
  assert.equal(updated.egress?.mode, 'allow-public');
  assert.equal(setTeamEgress(updated, null).egress, undefined);
  assert.throws(
    () => validateTeamConfig(baseTeam({ allowIpRanges: ['999.999.999.999'] })),
    /githubEgressIps|allowIpRanges/,
  );
  assert.throws(() => validateTeamConfig(baseTeam({ mode: 'wide-open' })), /mode/);
});

// ---------------------------------------------------------------------------
// Telemetry ẩn danh
// ---------------------------------------------------------------------------

test('egress: telemetry chỉ đếm, không rò URL/host', async () => {
  const telemetry = new EgressTelemetry();
  const policy = { mode: 'allowlist', allowHosts: ['example.com'] };
  await checkEgress('https://example.com/secret-path?token=abc', policy, {
    lookupFn: PUBLIC_LOOKUP,
    telemetry,
  });
  await assert.rejects(
    checkEgress('https://evil.example.com/secret-path', policy, { lookupFn: PUBLIC_LOOKUP, telemetry }),
  );
  await assert.rejects(checkEgress('https://example.com/', undefined, { telemetry }));
  const snap = telemetry.snapshot();
  assert.equal(snap.allowed, 1);
  assert.equal(snap.blocked, 1);
  assert.equal(snap.unconfigured, 1);
  assert.equal(snap.total, 3);
  assert.equal(snap.byContext.agent, 3);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('example.com'), 'snapshot không được chứa host');
  assert.ok(!text.includes('secret-path'), 'snapshot không được chứa path');
  assert.ok(!text.includes('token'), 'snapshot không được chứa secret');
});

// ---------------------------------------------------------------------------
// SSRF nối vào policy mới (API cũ không đổi)
// ---------------------------------------------------------------------------

test('egress: assertPublicUrl cũ vẫn xanh khi không truyền policy', async () => {
  await assertPublicUrl('https://example.com/x', { lookupFn: PUBLIC_LOOKUP });
  await assert.rejects(assertPublicUrl('http://127.0.0.1:11434/', { lookupFn: PUBLIC_LOOKUP }));
  await assert.rejects(assertPublicUrl('http://192.168.1.1/', { lookupFn: PUBLIC_LOOKUP }));
});

test('egress: assertEgressUrl + fetchPublic với policy — ngoài allowlist chặn, fetch không được gọi', async () => {
  const policy = { mode: 'allowlist', allowHosts: ['example.com'] };
  await assertEgressUrl('https://example.com/x', policy, { lookupFn: PUBLIC_LOOKUP });
  await rejectsEgress(
    assertEgressUrl('https://other.com/x', policy, { lookupFn: PUBLIC_LOOKUP }),
    'blocked',
  );
  // fetchPublic với policy null → fail-closed, fetch không chạy.
  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('x', { status: 200 });
  };
  try {
    await rejectsEgress(
      fetchPublic('https://example.com/x', {}, 30_000, { egressPolicy: null }),
      'unconfigured',
    );
    assert.equal(fetchCalled, false, 'fail-closed thì không được fetch');
    await rejectsEgress(
      fetchPublic('https://other.com/x', {}, 30_000, { egressPolicy: policy, lookupFn: PUBLIC_LOOKUP }),
      'blocked',
    );
    assert.equal(fetchCalled, false, 'ngoài allowlist thì không được fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Sandbox runShell
// ---------------------------------------------------------------------------

test('egress: runShell chặn lệnh có đích mạng khi chưa có policy (fail-closed), lệnh thường vẫn chạy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-egress-'));
  try {
    configureSandboxEgress(undefined);
    await assert.rejects(
      runShell('echo https://example.com/x', dir, { workspaceDir: dir }),
      (err) => err instanceof EgressError && err.kind === 'unconfigured',
    );
    const ok = await runShell('echo hello-no-network', dir, { workspaceDir: dir });
    assert.equal(ok.stdout.trim(), 'hello-no-network');
    assert.equal(ok.code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('egress: runShell với policy — allowlist qua, LAN chặn, policy module dùng được', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-egress-'));
  try {
    const policy = { mode: 'allowlist', allowHosts: ['example.com'] };
    const ok = await runShell('echo https://example.com/x', dir, {
      workspaceDir: dir,
      egressPolicy: policy,
      egressLookupFn: PUBLIC_LOOKUP,
    });
    assert.equal(ok.stdout.trim(), 'https://example.com/x');
    await assert.rejects(
      runShell('echo http://192.168.1.1/x', dir, {
        workspaceDir: dir,
        egressPolicy: policy,
        egressLookupFn: PUBLIC_LOOKUP,
      }),
      (err) => err instanceof EgressError && err.kind === 'blocked',
    );
    await assert.rejects(
      runShell('echo https://other.com/x', dir, {
        workspaceDir: dir,
        egressPolicy: policy,
        egressLookupFn: PUBLIC_LOOKUP,
      }),
      (err) => err instanceof EgressError && err.kind === 'blocked',
    );
    // Policy module-level (configureSandboxEgress) cũng được dùng.
    configureSandboxEgress(policy);
    const ok2 = await runShell('echo https://example.com/y', dir, {
      workspaceDir: dir,
      egressLookupFn: PUBLIC_LOOKUP,
    });
    assert.equal(ok2.stdout.trim(), 'https://example.com/y');
  } finally {
    configureSandboxEgress(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Daemon: chặn curl tới host cấm, lỗi rõ ràng thay vì treo
// ---------------------------------------------------------------------------

async function withDaemonClient(fn) {
  const client = new DaemonClient();
  try {
    return await fn(client);
  } finally {
    await client.dispose();
  }
}

test('egress: daemon bị giam không policy → curl bị chặn EGRESS_UNCONFIGURED, echo vẫn chạy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-egress-'));
  try {
    await withDaemonClient(async (client) => {
      const init = await client.init({ workspaceDir: dir });
      assert.equal(init.egressConfigured, false);
      const ok = await client.exec({ command: 'echo', args: ['hi'], workspaceDir: dir });
      assert.equal(ok.exitCode, 0);
      await assert.rejects(
        client.exec({
          command: '/bin/sh',
          args: ['-c', 'curl http://192.168.1.1/'],
          workspaceDir: dir,
        }),
        (err) => err.code === 'EGRESS_UNCONFIGURED',
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('egress: daemon có policy — curl tới host cấm bị EGRESS_BLOCKED, host allowlist chạy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-egress-'));
  try {
    await withDaemonClient(async (client) => {
      const policy = { mode: 'allowlist', allowHosts: ['example.com'] };
      const init = await client.init({ workspaceDir: dir, egressPolicy: policy });
      assert.equal(init.egressConfigured, true);
      // Host cấm: chặn trước khi spawn (curl không bao giờ chạy).
      await assert.rejects(
        client.exec({
          command: '/bin/sh',
          args: ['-c', 'curl http://evil.example/x'],
          workspaceDir: dir,
        }),
        (err) => err.code === 'EGRESS_BLOCKED',
      );
      // LAN: chặn đích private.
      await assert.rejects(
        client.exec({
          command: '/bin/sh',
          args: ['-c', 'curl http://192.168.1.1/'],
          workspaceDir: dir,
        }),
        (err) => err.code === 'EGRESS_BLOCKED',
      );
      // Host allowlist: lệnh chạy (echo chứa URL, không kết nối thật).
      const ok = await client.exec({
        command: '/bin/sh',
        args: ['-c', 'echo https://example.com/x'],
        workspaceDir: dir,
      });
      assert.equal(ok.exitCode, 0);
      // Policy request thắng policy daemon: request cho other.com thì qua.
      const ok2 = await client.exec({
        command: '/bin/sh',
        args: ['-c', 'echo https://other.com/x'],
        workspaceDir: dir,
        egressPolicy: { mode: 'allowlist', allowHosts: ['other.com'] },
      });
      assert.equal(ok2.exitCode, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('egress: daemon session_write chặn dòng curl tới host cấm, dòng lành vẫn chạy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-egress-'));
  try {
    await withDaemonClient(async (client) => {
      const policy = { mode: 'allowlist', allowHosts: ['example.com'] };
      await client.init({ workspaceDir: dir, egressPolicy: policy });
      const chunks = [];
      client.onEvent((event, data) => {
        if (event === 'session.stdout' && data && typeof data.chunk === 'string') {
          chunks.push(data.chunk);
        }
      });
      const { sessionId } = await client.startSession({
        command: '/bin/sh',
        cwd: dir,
        workspaceDir: dir,
      });
      // Dòng lành chạy được.
      await client.writeSession(sessionId, 'echo marker-session-ok\n');
      // Dòng curl tới host cấm: bị chặn, không ghi vào stdin.
      await assert.rejects(
        client.writeSession(sessionId, 'curl http://evil.example/x\n'),
        (err) => err.code === 'EGRESS_BLOCKED',
      );
      // Dòng lành sau đó vẫn chạy — session còn sống.
      await client.writeSession(sessionId, 'echo marker-session-alive\n');
      // Chờ shell kịp thực thi + đẩy output về trước khi đóng (đóng
      // session kill shell ngay khi không còn fragment để flush).
      const deadline = Date.now() + 3000;
      while (!chunks.join('').includes('marker-session-alive') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await client.closeSession(sessionId);
      const out = chunks.join('');
      assert.ok(out.includes('marker-session-ok'), 'dòng lành đầu phải chạy');
      assert.ok(out.includes('marker-session-alive'), 'session phải sống sau dòng bị chặn');
      assert.ok(!out.includes('evil.example'), 'curl cấm không được chạy');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
