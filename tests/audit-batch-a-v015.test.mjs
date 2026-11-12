/**
 * Tests v0.15 — audit batch A: M6 (Vault fallback), M8 (MCP env), M9 (bundle checksum).
 *
 * Chỉ dùng file tạm local, không mạng, không API key thật.
 * Run: build core + tools rồi `node --test tests/audit-batch-a-v015.test.mjs`
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  StdioMcpClient,
  safeEnvForMcp,
  findSecretLikeEnvNames,
} from '../packages/core/dist/mcp/client.js';
import {
  Vault,
  LocalEncryptor,
  createSafeStorageEncryptor,
  loadOrCreateMachineKey,
} from '../packages/core/dist/vault/index.js';
import {
  loadBundle,
  validateBundleManifest,
} from '../packages/tools/dist/plugins/bundle.js';
import { loadPluginFromManifest } from '../packages/tools/dist/plugins/loader.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

/** Chặn process.stderr.write trong lúc `fn` chạy, trả về { result, output }. */
function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { result: fn(), output: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

/** Như captureStderr nhưng cho hàm async. */
async function captureStderrAsync(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const result = await fn();
    return { result, output: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

/** Fake safeStorage giống Electron safeStorage (như tests/vault.test.mjs). */
function makeFakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad payload');
      return s.slice(4);
    },
  };
}

// ---------------------------------------------------------------------------
// M8 — MCP server con không kế thừa toàn bộ process.env
// ---------------------------------------------------------------------------

test('M8: safeEnvForMcp chỉ giữ allowlist tối thiểu, chặn mọi tên giống secret', () => {
  const env = safeEnvForMcp({
    PATH: '/usr/bin:/bin',
    HOME: '/home/test',
    LANG: 'en_US.UTF-8',
    NODE_ENV: 'production',
    USER: 'tester',
    OPENAI_API_KEY: 'sk-test-secret',
    GH_TOKEN: 'ghp_test-secret',
    MY_SECRET: 'should-be-dropped',
    DB_PASSWORD: 'should-be-dropped',
    RANDOM_VAR: 'should-be-dropped',
    SESSION_COOKIE: 'should-be-dropped',
  });
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.USER, 'tester');
  for (const name of [
    'OPENAI_API_KEY',
    'GH_TOKEN',
    'MY_SECRET',
    'DB_PASSWORD',
    'RANDOM_VAR',
    'SESSION_COOKIE',
  ]) {
    assert.equal(env[name], undefined, `${name} phải bị chặn`);
  }
  // findSecretLikeEnvNames chỉ trả TÊN, không trả giá trị.
  assert.deepEqual(findSecretLikeEnvNames({ FOO_API_KEY: 'x', SAFE_FLAG: 'y' }), [
    'FOO_API_KEY',
  ]);
  assert.deepEqual(findSecretLikeEnvNames(undefined), []);
});

/**
 * Fake MCP server: lúc khởi động ghi toàn bộ process.env nó thấy ra file,
 * rồi trả lời `initialize`/`ping` bằng JSON-RPC tối thiểu.
 */
const ENV_PROBE_SERVER = `
import * as fs from 'node:fs';
import * as readline from 'node:readline';
const outPath = process.argv[2];
fs.writeFileSync(outPath, JSON.stringify(process.env), 'utf8');
const newline = String.fromCharCode(10);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'env-probe', version: '0.1.0' } } }) + newline);
  } else if (msg.method === 'ping') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + newline);
  }
});
`;

function writeProbeServer(dir) {
  return writeFile(dir, 'env-probe-server.mjs', ENV_PROBE_SERVER);
}

test('M8: spawn MCP server — server con không đọc được secret, vẫn đọc được PATH', async () => {
  const dir = makeTempDir('open-bot-audit-m8-');
  const serverPath = writeProbeServer(dir);
  const outPath = path.join(dir, 'seen-env.json');
  process.env.OPEN_BOT_M8_TEST_KEY = 'sk-m8-secret-khong-duoc-lo';
  process.env.OPEN_BOT_M8_RANDOM = 'khong-trong-allowlist';
  const client = new StdioMcpClient({
    name: 'probe',
    command: 'node',
    args: [serverPath, outPath],
  });
  try {
    const info = await client.initialize();
    assert.equal(info.name, 'env-probe');
    await client.ping();
  } finally {
    await client.close();
    delete process.env.OPEN_BOT_M8_TEST_KEY;
    delete process.env.OPEN_BOT_M8_RANDOM;
  }
  const seen = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(seen.OPEN_BOT_M8_TEST_KEY, undefined, 'secret trong process.env không được truyền cho server con');
  assert.equal(seen.OPEN_BOT_M8_RANDOM, undefined, 'biến ngoài allowlist không được truyền');
  assert.equal(seen.PATH, process.env.PATH, 'PATH trong allowlist vẫn được truyền');
});

test('M8: config env chứa tên giống secret thì chỉ cảnh báo stderr, không chặn', async () => {
  const dir = makeTempDir('open-bot-audit-m8-warn-');
  const serverPath = writeProbeServer(dir);
  const outPath = path.join(dir, 'seen-env.json');
  const client = new StdioMcpClient({
    name: 'probe-warn',
    command: 'node',
    args: [serverPath, outPath],
    env: { PROBE_API_KEY: 'gia-tri-bi-mat-khong-duoc-in-log', PROBE_FLAG: 'yes' },
  });
  let info;
  try {
    const captured = await captureStderrAsync(async () => {
      info = await client.initialize();
    });
    assert.equal(info.name, 'env-probe');
    // Cảnh báo ghi TÊN biến, không bao giờ ghi giá trị.
    assert.match(captured.output, /PROBE_API_KEY/);
    assert.ok(
      !captured.output.includes('gia-tri-bi-mat-khong-duoc-in-log'),
      'cảnh báo không được in giá trị secret',
    );
  } finally {
    await client.close();
  }
  // Không chặn: giá trị config env vẫn tới được server con (người dùng đã khai rõ).
  const seen = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(seen.PROBE_API_KEY, 'gia-tri-bi-mat-khong-duoc-in-log');
  assert.equal(seen.PROBE_FLAG, 'yes');
});

// ---------------------------------------------------------------------------
// M9 — Plugin bundle verify checksum khi cài
// ---------------------------------------------------------------------------

const ECHO_INDEX_JS = `
const echoTool = {
  definition: {
    name: 'echo',
    description: 'Echo the given text back.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
    },
  },
  needsApproval: false,
  execute: async (args) => String(args.text ?? ''),
};
module.exports = { tools: [echoTool] };
`;

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Ghi một bundle tối thiểu (plugin.json + index.js); `checksum` tính từ nội dung đã ghi. */
function writeBundle(dir, { checksumMode = 'correct' } = {}) {
  const indexPath = writeFile(dir, 'index.js', ECHO_INDEX_JS);
  const correct = sha256Hex(fs.readFileSync(indexPath, 'utf8'));
  let checksum;
  if (checksumMode === 'correct') checksum = correct;
  else if (checksumMode === 'wrong') checksum = '0'.repeat(64);
  // 'none': không khai checksum.
  const manifest = {
    id: 'checksum-plugin',
    name: 'Checksum Plugin',
    version: '1.0.0',
    description: 'Plugin demo cho test checksum.',
    permissions: [],
    main: 'index.js',
    tools: ['echo'],
    ...(checksum !== undefined ? { checksum } : {}),
  };
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  return { manifest, correct };
}

test('M9: bundle có checksum đúng thì loadBundle + loadPluginFromManifest đều nạp được', () => {
  const dir = makeTempDir('open-bot-audit-m9-ok-');
  const { manifest } = writeBundle(dir, { checksumMode: 'correct' });
  const parts = loadBundle(dir);
  assert.equal(parts.manifest.id, 'checksum-plugin');
  assert.equal(parts.manifest.checksum, manifest.checksum);
  assert.ok(parts.main.endsWith('index.js'));

  const loaded = loadPluginFromManifest(
    { ...parts.manifest, main: parts.manifest.main },
    dir,
    'plugin.json',
  );
  assert.equal(loaded.tools.length, 1);
  assert.equal(loaded.tools[0].definition.name, 'echo');
});

test('M9: bundle có checksum sai thì loadBundle và loadPluginFromManifest đều từ chối', () => {
  const dir = makeTempDir('open-bot-audit-m9-bad-');
  const { manifest } = writeBundle(dir, { checksumMode: 'wrong' });
  assert.throws(() => loadBundle(dir), /Checksum.*không khớp|checksum không khớp/);

  const loadedManifest = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    permissions: [],
    main: 'index.js',
    tools: ['echo'],
    checksum: manifest.checksum,
  };
  assert.throws(
    () => loadPluginFromManifest(loadedManifest, dir, 'plugin.json'),
    /checksum không khớp/,
  );
});

test('M9: bundle không có checksum thì vẫn nạp được nhưng có cảnh báo stderr', () => {
  const dir = makeTempDir('open-bot-audit-m9-none-');
  writeBundle(dir, { checksumMode: 'none' });

  const loadCaptured = captureStderr(() => loadBundle(dir));
  assert.equal(loadCaptured.result.manifest.id, 'checksum-plugin');
  assert.match(loadCaptured.output, /không có checksum — chỉ cài bundle từ nguồn đáng tin/);

  const manifest = {
    id: 'checksum-plugin',
    name: 'Checksum Plugin',
    version: '1.0.0',
    description: 'Plugin demo cho test checksum.',
    permissions: [],
    main: 'index.js',
    tools: ['echo'],
  };
  const pluginCaptured = captureStderr(() =>
    loadPluginFromManifest(manifest, dir, 'plugin.json'),
  );
  assert.equal(pluginCaptured.result.tools.length, 1);
  assert.match(pluginCaptured.output, /không có checksum — chỉ cài bundle từ nguồn đáng tin/);
});

test('M9: validateBundleManifest từ chối checksum sai định dạng', () => {
  const dir = makeTempDir('open-bot-audit-m9-fmt-');
  writeFile(dir, 'index.js', ECHO_INDEX_JS);
  const base = {
    id: 'checksum-plugin',
    name: 'Checksum Plugin',
    version: '1.0.0',
    description: 'Plugin demo.',
    permissions: [],
    main: 'index.js',
  };
  assert.throws(
    () => validateBundleManifest({ ...base, checksum: 'xyz' }, dir),
    /checksum.*sha256 hex 64 ký tự/,
  );
  assert.throws(
    () => validateBundleManifest({ ...base, checksum: 'A'.repeat(64) }, dir),
    /checksum.*sha256 hex 64 ký tự/,
  );
  assert.throws(
    () => validateBundleManifest({ ...base, checksum: 'a'.repeat(63) }, dir),
    /checksum.*sha256 hex 64 ký tự/,
  );
  // Checksum đúng định dạng thì validate qua (verify khớp mới là việc của loadBundle).
  const ok = validateBundleManifest(
    { ...base, checksum: sha256Hex(ECHO_INDEX_JS) },
    dir,
  );
  assert.equal(ok.checksum, sha256Hex(ECHO_INDEX_JS));
});

// ---------------------------------------------------------------------------
// M6 — Vault fallback LocalEncryptor phải lộ rõ cho người dùng
// ---------------------------------------------------------------------------

test('M6: Vault fallback → isLocalFallback() true + cảnh báo stderr; mã hoá vẫn chạy', () => {
  const dir = makeTempDir('open-bot-audit-m6-fallback-');
  const storePath = path.join(dir, 'vault.json');
  const { result: vault, output } = captureStderr(
    () => new Vault({ storePath }),
  );
  assert.equal(vault.isLocalFallback(), true);
  assert.match(output, /Vault đang dùng LocalEncryptor — key file nằm cùng thư mục store/);
  vault.setSecret('provider', 'xai', 'sk-m6-test');
  assert.equal(vault.getSecret('provider', 'xai'), 'sk-m6-test');
});

test('M6: Vault safeStorage → isLocalFallback() false, không có cảnh báo fallback', () => {
  const dir = makeTempDir('open-bot-audit-m6-safe-');
  const storePath = path.join(dir, 'vault.json');
  const enc = createSafeStorageEncryptor(makeFakeSafeStorage());
  const { result: vault, output } = captureStderr(
    () => new Vault({ storePath, encryptor: enc }),
  );
  assert.equal(vault.isLocalFallback(), false);
  assert.ok(!output.includes('LocalEncryptor'), 'không được cảnh báo fallback khi dùng safeStorage');
  vault.setSecret('provider', 'xai', 'sk-m6-safe');
  assert.equal(vault.getSecret('provider', 'xai'), 'sk-m6-safe');
});

test('M6: Vault nhận LocalEncryptor tường minh cũng là fallback; rotateKey sang safeStorage hết fallback', () => {
  const dir = makeTempDir('open-bot-audit-m6-rotate-');
  const storePath = path.join(dir, 'vault.json');
  const keyPath = path.join(dir, 'vault.key');
  const localEnc = new LocalEncryptor(loadOrCreateMachineKey(keyPath));
  const vault = new Vault({ storePath, encryptor: localEnc });
  assert.equal(vault.isLocalFallback(), true);
  vault.setSecret('provider', 'xai', 'sk-m6-rotate');
  vault.rotateKey(createSafeStorageEncryptor(makeFakeSafeStorage()));
  assert.equal(vault.isLocalFallback(), false);
  assert.equal(vault.getSecret('provider', 'xai'), 'sk-m6-rotate');
});
