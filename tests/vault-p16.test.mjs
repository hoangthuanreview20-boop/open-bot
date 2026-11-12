/**
 * Tests for P1-6 (v0.53, REA deep-dive lần 2 §7): Vault hardening.
 *   - durable writes with bounded backup copies (+ fallback to .1)
 *   - 3 separate stores: session-only Map / disk encrypted / webhook keys
 *   - maxAgeMs + savedAtMs expiry for encrypted entries
 *   - refusal taxonomy (vault_full / refused) + wire timeout
 *   - saveToVault opt-in per credential-creating write
 *   - 1Password broker (out-of-process; fake `op` script on PATH —
 *     no real 1Password account, no network, fake secrets only)
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/vault-p16.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  Vault,
  WebhookKeyStore,
  OnePasswordBroker,
  VaultRefusalError,
  VAULT_WIRE_TIMEOUT_MS,
} from '../packages/core/dist/vault/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-vault-p16-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const storeIn = (dir) => path.join(dir, 'vault.json');
const keyIn = (dir) => path.join(dir, 'vault.key');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newVault(dir, extra = {}) {
  return new Vault({ storePath: storeIn(dir), keyFilePath: keyIn(dir), ...extra });
}

// ---------------------------------------------------------------------------
// Durable writes with bounded copies
// ---------------------------------------------------------------------------

test('P1-6 durable: setSecret twice keeps a .1 backup; no .tmp leftovers; mode 0600', () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  vault.setSecret('provider', 'xai', 'first-value');
  vault.setSecret('provider', 'xai', 'second-value');
  assert.ok(fs.existsSync(`${storeIn(dir)}.1`), 'vault.json.1 backup must exist');
  assert.equal(fs.statSync(storeIn(dir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${storeIn(dir)}.1`).mode & 0o777, 0o600);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
  const parsed = JSON.parse(fs.readFileSync(storeIn(dir), 'utf8'));
  assert.equal(parsed.version, 1, 'on-disk version stays 1 (meta rides in `meta` key)');
  assert.ok(typeof parsed.secrets['provider:xai'] === 'string');
  assert.equal(typeof parsed.meta['provider:xai'].savedAtMs, 'number');
});

test('P1-6 durable: backup copies stay bounded (max .3, no .4)', () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  for (let i = 0; i < 6; i += 1) vault.setSecret('provider', `k${i}`, `v${i}`);
  assert.ok(fs.existsSync(`${storeIn(dir)}.1`));
  assert.ok(fs.existsSync(`${storeIn(dir)}.2`));
  assert.ok(fs.existsSync(`${storeIn(dir)}.3`));
  assert.ok(!fs.existsSync(`${storeIn(dir)}.4`), 'copies must stay bounded at 3');
});

test('P1-6 durable: live file deleted (crash window) -> reopen reads the .1 backup', () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  vault.setSecret('provider', 'xai', 'crash-window-value');
  vault.setSecret('provider', 'openai', 'second-write');
  fs.rmSync(storeIn(dir));
  const reopened = newVault(dir);
  assert.equal(reopened.getSecret('provider', 'xai'), 'crash-window-value');
});

test('P1-6 durable: legacy v1 file without `meta` still loads', () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  vault.setSecret('provider', 'xai', 'legacy-value');
  // Rewrite the store by hand in the exact pre-v0.53 shape.
  const parsed = JSON.parse(fs.readFileSync(storeIn(dir), 'utf8'));
  fs.writeFileSync(storeIn(dir), JSON.stringify({ version: 1, secrets: parsed.secrets }, null, 2));
  const reopened = newVault(dir);
  assert.equal(reopened.getSecret('provider', 'xai'), 'legacy-value');
});

// ---------------------------------------------------------------------------
// Expiry: maxAgeMs + savedAtMs
// ---------------------------------------------------------------------------

test('P1-6 expiry: entry with maxAgeMs is readable, then refused after it lapses', async () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  vault.setSecret('provider', 'short-lived', 'temp-key-value', { maxAgeMs: 60 });
  assert.equal(vault.getSecret('provider', 'short-lived'), 'temp-key-value');
  await sleep(90);
  assert.equal(vault.getSecret('provider', 'short-lived'), null, 'expired entry must be refused');
  // Purged from disk too: a fresh Vault sees nothing.
  assert.equal(newVault(dir).getSecret('provider', 'short-lived'), null);
  assert.equal(newVault(dir).hasSecret('provider', 'short-lived'), false);
});

test('P1-6 expiry: entry without maxAgeMs never expires; purgeExpired drops only the dead', async () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  vault.setSecret('provider', 'forever', 'keep-me');
  vault.setSecret('provider', 'brief', 'drop-me', { maxAgeMs: 30 });
  await sleep(50);
  assert.equal(vault.purgeExpired(), 1);
  assert.equal(vault.getSecret('provider', 'forever'), 'keep-me');
  assert.equal(vault.getSecret('provider', 'brief'), null);
});

// ---------------------------------------------------------------------------
// Session-only store + saveToVault opt-in
// ---------------------------------------------------------------------------

test('P1-6 session: saveToVault:false stays in memory only, never on disk', () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  vault.setSecret('provider', 'disk-key', 'disk-value');
  vault.setSecret('provider', 'temp-key', 'session-only-value', { saveToVault: false });
  assert.equal(vault.getSecret('provider', 'temp-key'), 'session-only-value');
  const parsed = JSON.parse(fs.readFileSync(storeIn(dir), 'utf8'));
  assert.ok(!('provider:temp-key' in parsed.secrets), 'session-only key must not be in the file');
  assert.equal(newVault(dir).getSecret('provider', 'temp-key'), null, 'gone after reopen');
  assert.equal(vault.countSessionSecrets(), 1);
  vault.clearSessionSecrets();
  assert.equal(vault.getSecret('provider', 'temp-key'), null);
});

test('P1-6 session: session value shadows the disk value; delete removes both', () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  vault.setSecret('provider', 'xai', 'disk-value');
  vault.setSecret('provider', 'xai', 'session-value', { saveToVault: false });
  assert.equal(vault.getSecret('provider', 'xai'), 'session-value');
  assert.deepEqual(vault.listSecrets('provider'), ['xai'], 'shadowed key listed once');
  // Delete means gone: both the session shadow AND the disk value go,
  // so no stale disk key silently reappears afterwards.
  assert.equal(vault.deleteSecret('provider', 'xai'), true);
  assert.equal(vault.getSecret('provider', 'xai'), null);
  assert.equal(vault.hasSecret('provider', 'xai'), false);
});

// ---------------------------------------------------------------------------
// Refusal taxonomy
// ---------------------------------------------------------------------------

test('P1-6 refusal: new entry past maxEntries -> vault_full (throw + trySetSecret)', () => {
  const dir = makeTempDir();
  const vault = newVault(dir, { maxEntries: 2 });
  vault.setSecret('provider', 'a', '1');
  vault.setSecret('provider', 'b', '2');
  assert.throws(
    () => vault.setSecret('provider', 'c', '3'),
    (err) => err instanceof VaultRefusalError && err.kind === 'vault_full',
  );
  const refused = vault.trySetSecret('provider', 'c', '3');
  assert.equal(refused.ok, false);
  assert.equal(refused.refusal.kind, 'vault_full');
  // Overwriting an existing entry never counts towards the cap.
  vault.setSecret('provider', 'a', '1-new');
  assert.equal(vault.getSecret('provider', 'a'), '1-new');
  // Session-only writes never hit the disk cap.
  vault.setSecret('provider', 'c', 'session', { saveToVault: false });
  assert.equal(vault.getSecret('provider', 'c'), 'session');
});

test('P1-6 refusal: invalid name -> refused (not vault_full), nothing written', () => {
  const dir = makeTempDir();
  const vault = newVault(dir);
  const result = vault.trySetSecret('bad ns!', 'k', 'v');
  assert.equal(result.ok, false);
  assert.equal(result.refusal.kind, 'refused');
  assert.equal(vault.listSecrets('provider').length, 0);
});

test('P1-6 refusal: wire timeout constant is 15s', () => {
  assert.equal(VAULT_WIRE_TIMEOUT_MS, 15_000);
});

// ---------------------------------------------------------------------------
// Webhook keys: separate store file
// ---------------------------------------------------------------------------

test('P1-6 webhook keys: own file, own keys, expiry works, invisible to the main vault', async () => {
  const dir = makeTempDir();
  const store = new WebhookKeyStore({ dir });
  store.setKey('automation-1', 'hook-secret-1');
  // v0.85: listKeys is asserted ONLY for the long-lived key. The
  // short-lived key used to be asserted here too, but setKey ->
  // getKey -> listKeys (JSON file round-trips) must then finish in
  // <40ms or the key expires before the assert runs — a pure
  // wall-clock flake under load (red at ~995ms vs ~155ms solo).
  assert.deepEqual(store.listKeys(), ['automation-1']);
  assert.equal(store.getKey('automation-1'), 'hook-secret-1');
  store.setKey('short', 'hook-secret-2', { maxAgeMs: 40 });
  assert.equal(store.path, path.join(dir, 'automation-webhook-keys.json'));
  assert.ok(fs.existsSync(store.path));
  assert.ok(!fs.existsSync(storeIn(dir)), 'main vault file must not exist');
  const mainVault = newVault(dir);
  assert.deepEqual(mainVault.listSecrets('webhook'), [], 'webhook keys are not in the main vault');
  await sleep(60);
  // Expiry is asserted via getKey() only: sleep only ever pushes time
  // further past the deadline, so this can never be "not expired yet".
  assert.equal(store.getKey('short'), null, 'expired webhook key refused');
  assert.equal(store.getKey('automation-1'), 'hook-secret-1');
  assert.equal(store.deleteKey('automation-1'), true);
  assert.equal(store.getKey('automation-1'), null);
});

// ---------------------------------------------------------------------------
// 1Password broker (fake `op` on PATH — no real account)
// ---------------------------------------------------------------------------

const FAKE_OP_SCRIPT = `#!/bin/sh
mode="\${FAKE_OP_MODE:-signed-in}"
if [ "$1" = "--version" ]; then echo "2.32.0"; exit 0; fi
if [ "$mode" = "slow" ]; then sleep 5; fi
if [ "$1" = "account" ]; then
  if [ "$mode" = "signed-out" ]; then echo "not signed in" >&2; exit 1; fi
  echo '[{"id":"a1","shorthand":"test.1password.com","url":"https://test.1password.com","email":"t@example.com"}]'
  exit 0
fi
if [ "$1" = "item" ] && [ "$2" = "list" ]; then
  echo '[{"id":"abc123","title":"Test Key","category":"API_CREDENTIAL"}]'
  exit 0
fi
if [ "$1" = "item" ] && [ "$2" = "get" ]; then
  if [ "$3" != "abc123" ]; then echo "not found" >&2; exit 1; fi
  echo '{"id":"abc123","title":"Test Key","category":"API_CREDENTIAL","fields":[{"id":"password","label":"password","type":"PASSWORD","value":"fake-secret-123"},{"id":"username","label":"username","type":"STRING","value":"bob"}]}'
  exit 0
fi
echo "unknown command" >&2; exit 1
`;

function installFakeOp() {
  const dir = makeTempDir('open-bot-fake-op-');
  const opPath = path.join(dir, 'op');
  fs.writeFileSync(opPath, FAKE_OP_SCRIPT, { mode: 0o755 });
  return dir;
}

test('P1-6 1Password: no op CLI on PATH -> status unavailable, never throws', async () => {
  const emptyDir = makeTempDir('open-bot-empty-path-');
  const savedPath = process.env.PATH;
  const broker = new OnePasswordBroker();
  try {
    process.env.PATH = emptyDir;
    const status = await broker.getStatus();
    assert.equal(status.available, false);
    assert.equal(status.signedIn, false);
    assert.equal(status.state, 'unavailable');
    assert.deepEqual(status.accounts, []);
    assert.match(status.reason ?? '', /not installed/);
  } finally {
    process.env.PATH = savedPath;
    broker.dispose();
  }
});

test('P1-6 1Password: fake op signed-in -> status, list (metadata only), getField', async () => {
  const fakeDir = installFakeOp();
  const savedPath = process.env.PATH;
  const savedMode = process.env.FAKE_OP_MODE;
  const broker = new OnePasswordBroker();
  try {
    process.env.PATH = `${fakeDir}${path.delimiter}${savedPath ?? ''}`;
    process.env.FAKE_OP_MODE = 'signed-in';
    const status = await broker.getStatus();
    assert.equal(status.state, 'signed-in');
    assert.equal(status.available, true);
    assert.equal(status.signedIn, true);
    assert.equal(status.cliVersion, '2.32.0');
    assert.deepEqual(status.accounts, ['test.1password.com']);
    const items = await broker.listItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'abc123');
    assert.equal(items[0].title, 'Test Key');
    assert.ok(!('value' in items[0]), 'list must never carry a secret value');
    assert.equal(await broker.getField('abc123', 'password'), 'fake-secret-123');
    assert.equal(await broker.getField('abc123', 'username'), 'bob');
    await assert.rejects(() => broker.getField('abc123', 'no-such-field'), /no such field/);
    await assert.rejects(() => broker.getField('nope', 'password'), /1Password CLI failed/);
  } finally {
    process.env.PATH = savedPath;
    if (savedMode === undefined) delete process.env.FAKE_OP_MODE;
    else process.env.FAKE_OP_MODE = savedMode;
    broker.dispose();
  }
});

test('P1-6 1Password: fake op signed-out -> status signed-out', async () => {
  const fakeDir = installFakeOp();
  const savedPath = process.env.PATH;
  const savedMode = process.env.FAKE_OP_MODE;
  const broker = new OnePasswordBroker();
  try {
    process.env.PATH = `${fakeDir}${path.delimiter}${savedPath ?? ''}`;
    process.env.FAKE_OP_MODE = 'signed-out';
    const status = await broker.getStatus();
    assert.equal(status.state, 'signed-out');
    assert.equal(status.available, true);
    assert.equal(status.signedIn, false);
  } finally {
    process.env.PATH = savedPath;
    if (savedMode === undefined) delete process.env.FAKE_OP_MODE;
    else process.env.FAKE_OP_MODE = savedMode;
    broker.dispose();
  }
});

test('P1-6 1Password: slow op -> broker call fails with VaultWireError (fail-closed)', async () => {
  const fakeDir = installFakeOp();
  const savedPath = process.env.PATH;
  const savedMode = process.env.FAKE_OP_MODE;
  const broker = new OnePasswordBroker({ timeoutMs: 200 });
  try {
    process.env.PATH = `${fakeDir}${path.delimiter}${savedPath ?? ''}`;
    process.env.FAKE_OP_MODE = 'slow';
    await assert.rejects(
      () => broker.getStatus(),
      (err) => err.name === 'VaultWireError' && err.timeoutMs === 200,
    );
  } finally {
    process.env.PATH = savedPath;
    if (savedMode === undefined) delete process.env.FAKE_OP_MODE;
    else process.env.FAKE_OP_MODE = savedMode;
    broker.dispose();
  }
});
