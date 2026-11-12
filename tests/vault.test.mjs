/**
 * Tests for the v0.4 Vault (packages/core/src/vault/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/vault.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  Vault,
  LocalEncryptor,
  createSafeStorageEncryptor,
  loadOrCreateMachineKey,
} from '../packages/core/dist/vault/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-vault-test-'));
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

// ---------------------------------------------------------------------------
// LocalEncryptor: round-trip + wrong key / tampering
// ---------------------------------------------------------------------------

test('LocalEncryptor encrypt/decrypt round-trips, including empty and unicode plaintext', () => {
  const enc = new LocalEncryptor(loadOrCreateMachineKey(path.join(makeTempDir(), 'k')));
  for (const plain of ['', 'hello', 'sk-secret-123', '🔑 khóa bí mật — tiếng Việt']) {
    const buf = Buffer.from(plain, 'utf8');
    assert.equal(enc.decrypt(enc.encrypt(buf)).toString('utf8'), plain);
  }
});

test('LocalEncryptor: wrong key cannot decrypt (GCM auth fails)', () => {
  const dir = makeTempDir();
  const encA = new LocalEncryptor(loadOrCreateMachineKey(path.join(dir, 'a.key')));
  const encB = new LocalEncryptor(loadOrCreateMachineKey(path.join(dir, 'b.key')));
  const ciphertext = encA.encrypt(Buffer.from('top-secret', 'utf8'));
  assert.throws(() => encB.decrypt(ciphertext), /Failed to decrypt/);
});

test('LocalEncryptor: tampered ciphertext cannot decrypt', () => {
  const enc = new LocalEncryptor(loadOrCreateMachineKey(path.join(makeTempDir(), 'k')));
  const ciphertext = enc.encrypt(Buffer.from('top-secret', 'utf8'));
  const tampered = Buffer.from(ciphertext);
  tampered[tampered.length - 1] ^= 0xff; // flip a bit in the auth tag
  assert.throws(() => enc.decrypt(tampered), /Failed to decrypt/);
  const truncated = ciphertext.subarray(0, 10);
  assert.throws(() => enc.decrypt(truncated), /too short|Failed to decrypt/);
});

test('loadOrCreateMachineKey reuses the existing key file and creates it mode 0600', () => {
  const dir = makeTempDir();
  const keyPath = path.join(dir, 'vault.key');
  const first = loadOrCreateMachineKey(keyPath);
  assert.equal(first.length, 32);
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  const second = loadOrCreateMachineKey(keyPath);
  assert.ok(first.equals(second), 'same file must yield the same key');
});

// ---------------------------------------------------------------------------
// Vault CRUD
// ---------------------------------------------------------------------------

test('Vault CRUD: set/get/delete/has/list, values never appear in listings', () => {
  const dir = makeTempDir();
  const vault = new Vault({ storePath: storeIn(dir), keyFilePath: keyIn(dir) });

  assert.equal(vault.getSecret('provider', 'xai'), null);
  assert.equal(vault.hasSecret('provider', 'xai'), false);

  vault.setSecret('provider', 'xai', 'xai-key-abc');
  vault.setSecret('provider', 'openai', 'sk-openai-xyz');
  vault.setSecret('mcp', 'github', 'ghp-token-123');
  assert.equal(vault.getSecret('provider', 'xai'), 'xai-key-abc');
  assert.equal(vault.getSecret('provider', 'openai'), 'sk-openai-xyz');
  assert.equal(vault.getSecret('mcp', 'github'), 'ghp-token-123');
  assert.equal(vault.hasSecret('provider', 'xai'), true);

  // Overwrite replaces the value.
  vault.setSecret('provider', 'xai', 'xai-key-NEW');
  assert.equal(vault.getSecret('provider', 'xai'), 'xai-key-NEW');

  // Listing returns key NAMES only — never values.
  assert.deepEqual(vault.listSecrets('provider'), ['openai', 'xai']);
  assert.deepEqual(vault.listSecrets('mcp'), ['github']);
  assert.deepEqual(vault.listSecrets('plugin'), []);
  assert.deepEqual(vault.listNamespaces(), ['mcp', 'provider']);

  assert.equal(vault.deleteSecret('provider', 'openai'), true);
  assert.equal(vault.getSecret('provider', 'openai'), null);
  assert.equal(vault.deleteSecret('provider', 'openai'), false);
  assert.deepEqual(vault.listSecrets('provider'), ['xai']);
});

test('Vault persists across instances and the store file holds no plaintext', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const secret = 'xai-key-super-secret-987';
  new Vault({ storePath, keyFilePath: keyPath }).setSecret('provider', 'xai', secret);

  const raw = fs.readFileSync(storePath, 'utf8');
  assert.ok(!raw.includes(secret), 'store file must not contain the plaintext secret');
  assert.ok(!raw.includes('xai-key'), 'store file must not contain any part of the secret');
  assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);

  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'xai'), secret);
});

test('Vault with a different key file cannot read the store', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  new Vault({ storePath, keyFilePath: keyIn(dir) }).setSecret('provider', 'xai', 'secret-1');
  const otherKey = path.join(makeTempDir(), 'other.key');
  const vault = new Vault({ storePath, keyFilePath: otherKey });
  assert.throws(() => vault.getSecret('provider', 'xai'), /Failed to decrypt/);
});

test('Vault rejects invalid namespace/key names', () => {
  const vault = new Vault({ storePath: storeIn(makeTempDir()) });
  assert.throws(() => vault.setSecret('', 'xai', 'v'), /namespace/);
  assert.throws(() => vault.setSecret('provider', 'bad:key', 'v'), /key/);
  assert.throws(() => vault.setSecret('provider', 'bad key', 'v'), /key/);
  assert.throws(() => vault.getSecret('pro vider', 'xai'), /namespace/);
});

// ---------------------------------------------------------------------------
// Vault.rotateKey
// ---------------------------------------------------------------------------

test('Vault.rotateKey: new key file reads old secrets; old key file cannot', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'rotate-me-1');
  vault.setSecret('mcp', 'github', 'rotate-me-2');
  const oldKey = fs.readFileSync(keyPath);

  vault.rotateKey();
  assert.equal(vault.getSecret('provider', 'xai'), 'rotate-me-1');
  assert.equal(vault.getSecret('mcp', 'github'), 'rotate-me-2');

  // The key file on disk changed.
  assert.ok(!fs.readFileSync(keyPath).equals(oldKey));

  // A vault opened with the OLD key bytes can no longer decrypt.
  const stale = new Vault({ storePath, encryptor: new LocalEncryptor(oldKey) });
  assert.throws(() => stale.getSecret('provider', 'xai'), /Failed to decrypt/);

  // A fresh vault with the new key file still reads everything.
  const fresh = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(fresh.getSecret('provider', 'xai'), 'rotate-me-1');
});

test('Vault.rotateKey(newEncryptor) migrates entries to the new backend', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyIn(dir) });
  vault.setSecret('provider', 'xai', 'migrate-me');

  const otherKey = loadOrCreateMachineKey(path.join(makeTempDir(), 'other.key'));
  vault.rotateKey(new LocalEncryptor(otherKey));
  assert.equal(vault.getSecret('provider', 'xai'), 'migrate-me');

  const migrated = new Vault({ storePath, encryptor: new LocalEncryptor(otherKey) });
  assert.equal(migrated.getSecret('provider', 'xai'), 'migrate-me');
});

// ---------------------------------------------------------------------------
// SafeStorage adapter (fake safeStorage — core never imports electron)
// ---------------------------------------------------------------------------

test('createSafeStorageEncryptor round-trips through a fake safeStorage', () => {
  // Fake mimics Electron safeStorage: encryptString returns an opaque
  // Buffer, decryptString reverses it. The adapter must survive it.
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad payload');
      return s.slice(4);
    },
  };
  const enc = createSafeStorageEncryptor(fake);
  const plain = Buffer.from('safe-storage-secret', 'utf8');
  assert.equal(enc.decrypt(enc.encrypt(plain)).toString('utf8'), 'safe-storage-secret');

  const vault = new Vault({ storePath: storeIn(makeTempDir()), encryptor: enc });
  vault.setSecret('provider', 'xai', 'via-safestorage');
  assert.equal(vault.getSecret('provider', 'xai'), 'via-safestorage');
});

test('createSafeStorageEncryptor throws when the OS backend is unavailable', () => {
  const fake = {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => b.toString('utf8'),
  };
  assert.throws(() => createSafeStorageEncryptor(fake), /not available/);
});

// ---------------------------------------------------------------------------
// Vault.rotateKey crash-safety (v0.15, M7 audit)
// ---------------------------------------------------------------------------

test('Vault.rotateKey: không để lại file .new/.bak sau khi xong', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'clean-rotate');
  vault.rotateKey();
  assert.equal(fs.existsSync(`${keyPath}.new`), false);
  assert.equal(fs.existsSync(`${keyPath}.bak`), false);
  assert.equal(vault.getSecret('provider', 'xai'), 'clean-rotate');
});

test('Vault.rotateKey crash giữa chừng (store mới + key cũ + .new): mở lại tự phục hồi', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'crash-recover-me');
  const oldKey = fs.readFileSync(keyPath);

  // Giả lập crash sau bước (3) của rotateKey: store đã mã hoá lại bằng
  // key mới, key file vẫn là key cũ, key mới còn nằm ở `.new`.
  const freshKey = loadOrCreateMachineKey(path.join(makeTempDir(), 'fresh.key'));
  const oldEnc = new LocalEncryptor(oldKey);
  const newEnc = new LocalEncryptor(freshKey);
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const nextSecrets = {};
  for (const [composite, b64] of Object.entries(stored.secrets)) {
    nextSecrets[composite] = newEnc.encrypt(oldEnc.decrypt(Buffer.from(b64, 'base64'))).toString('base64');
  }
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, secrets: nextSecrets }, null, 2));
  fs.writeFileSync(`${keyPath}.new`, freshKey, { mode: 0o600 });
  fs.writeFileSync(`${keyPath}.bak`, oldKey, { mode: 0o600 });

  // Mở lại: constructor phải tự nhận key `.new` và sửa key file.
  const recovered = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(recovered.getSecret('provider', 'xai'), 'crash-recover-me');
  assert.ok(fs.readFileSync(keyPath).equals(freshKey), 'key file phải được sửa thành key mới');
  assert.equal(fs.existsSync(`${keyPath}.new`), false, '.new phải được dọn sau khi phục hồi');
});

test('Vault.rotateKey crash trước khi ghi store (.new/.bak còn, store cũ): mở lại bình thường', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'still-old-store');
  const randomKey = loadOrCreateMachineKey(path.join(makeTempDir(), 'random.key'));
  fs.writeFileSync(`${keyPath}.new`, randomKey, { mode: 0o600 });
  fs.writeFileSync(`${keyPath}.bak`, fs.readFileSync(keyPath), { mode: 0o600 });

  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'xai'), 'still-old-store');
});

// ---------------------------------------------------------------------------
// Vault.rotateKey rename-failure (v0.27): rename `.new` → key file là
// bước cuối của rotate — store đã ghi bằng key mới, chỉ còn key file
// chưa đổi. Lỗi ở đây phải báo rõ (không phải lỗi fs thô), vault trong
// bộ nhớ phải còn nguyên (không rollback về key cũ — store đã là key
// mới), key cũ + `.new`/`.bak` phải còn đủ để mở lại tự phục hồi.
// Mock qua CJS require: dist biên dịch sang CJS nên require('node:fs')
// là cùng object mà vault dùng — patch ở đây vault sẽ thấy. (import
// * as fs của ESM là namespace đóng băng, gán trực tiếp sẽ throw.)
// ---------------------------------------------------------------------------

const fsCjs = createRequire(import.meta.url)('node:fs');
function failKeyRename(keyPath, onIntercept) {
  const orig = fsCjs.renameSync;
  fsCjs.renameSync = (src, dest) => {
    if (src === `${keyPath}.new` && dest === keyPath) {
      onIntercept?.();
      throw new Error('mock EPERM: operation not permitted, rename');
    }
    return orig(src, dest);
  };
  return () => {
    fsCjs.renameSync = orig;
  };
}

test('Vault.rotateKey: rename key file thất bại — lỗi rõ ràng, không mất key cũ, mở lại tự phục hồi', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'rename-fail-me');
  vault.setSecret('provider', 'openai', 'rename-fail-me-2');
  const oldKey = fs.readFileSync(keyPath);
  let intercepts = 0;
  const restore = failKeyRename(keyPath, () => intercepts++);

  let thrown;
  try {
    vault.rotateKey();
  } catch (err) {
    thrown = err;
  } finally {
    restore();
  }
  // (1) Lỗi được báo rõ: đúng nhánh rotateKey, kèm nguyên nhân gốc
  // và hướng phục hồi — không phải lỗi fs thô.
  assert.ok(thrown instanceof Error, 'rotateKey phải ném lỗi khi rename thất bại');
  assert.match(thrown.message, /Vault: không thể rename key mới .* hoàn tất rotateKey/);
  assert.match(thrown.message, /mock EPERM/);
  assert.match(thrown.message, /repairKeyAfterCrash/);
  assert.equal(intercepts, 1, 'chỉ đúng 1 lần rename key file bị chặn');

  // (2) Không rơi vào trạng thái nửa vời trong bộ nhớ: vault vẫn đọc
  // được secret bằng key mới (store đã ghi bằng key mới nên rollback
  // về key cũ mới là hỏng), ghi tiếp vẫn được.
  assert.equal(vault.getSecret('provider', 'xai'), 'rename-fail-me');
  assert.equal(vault.getSecret('provider', 'openai'), 'rename-fail-me-2');
  vault.setSecret('provider', 'anthropic', 'after-failed-rotate');
  assert.equal(vault.getSecret('provider', 'anthropic'), 'after-failed-rotate');

  // (3) Không mất key cũ: key file trên đĩa vẫn là key cũ, `.bak`
  // vẫn giữ key cũ, `.new` vẫn giữ key mới — đủ material để phục hồi.
  assert.ok(fs.readFileSync(keyPath).equals(oldKey), 'key file phải còn là key cũ');
  assert.ok(fs.existsSync(`${keyPath}.new`), '.new phải còn để phục hồi');
  assert.ok(fs.existsSync(`${keyPath}.bak`), '.bak phải còn để phục hồi');
  assert.ok(fs.readFileSync(`${keyPath}.bak`).equals(oldKey), '.bak phải là key cũ');
  const newKey = fs.readFileSync(`${keyPath}.new`);
  assert.equal(newKey.equals(oldKey), false, '.new phải là key mới, khác key cũ');
  // Store trên đĩa đã là ciphertext key mới: key cũ không giải được,
  // key `.new` giải được — đúng trạng thái "store mới + key cũ".
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const firstCipher = Buffer.from(Object.values(stored.secrets)[0], 'base64');
  assert.throws(() => new LocalEncryptor(oldKey).decrypt(firstCipher), /Failed to decrypt/);
  assert.doesNotThrow(() => new LocalEncryptor(newKey).decrypt(firstCipher));

  // (4) Mở lại tự phục hồi: nhận key `.new`, sửa key file, đọc đủ
  // secret (kể cả secret ghi thêm sau lần rotate lỗi).
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'xai'), 'rename-fail-me');
  assert.equal(reopened.getSecret('provider', 'openai'), 'rename-fail-me-2');
  assert.equal(reopened.getSecret('provider', 'anthropic'), 'after-failed-rotate');
  assert.ok(fs.readFileSync(keyPath).equals(newKey), 'key file phải được sửa thành key mới');
  assert.equal(fs.existsSync(`${keyPath}.new`), false, '.new phải được dọn sau khi phục hồi');
});

test('Vault.rotateKey: rename thất bại rồi gọi lại — lần 2 thành công, không còn .new/.bak', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'retry-after-rename-fail');
  const oldKey = fs.readFileSync(keyPath);
  const restore = failKeyRename(keyPath);
  try {
    assert.throws(() => vault.rotateKey(), /không thể rename key mới/);
  } finally {
    restore();
  }
  assert.ok(fs.readFileSync(keyPath).equals(oldKey), 'key file vẫn là key cũ sau lần lỗi');
  assert.equal(vault.getSecret('provider', 'xai'), 'retry-after-rename-fail');

  // Gọi lại khi rename đã hết lỗi: rotate hoàn tất bình thường.
  vault.rotateKey();
  assert.equal(vault.getSecret('provider', 'xai'), 'retry-after-rename-fail');
  assert.equal(fs.existsSync(`${keyPath}.new`), false);
  assert.equal(fs.existsSync(`${keyPath}.bak`), false);
  assert.equal(fs.readFileSync(keyPath).equals(oldKey), false, 'key file phải là key mới sau lần 2');
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'xai'), 'retry-after-rename-fail');
});

// ---------------------------------------------------------------------------
// v0.74c: writeDurableFileSync rename cuối thất bại — lỗi bọc rõ (lấp gap v0.28)
// ---------------------------------------------------------------------------

function failStoreRename(storePath, onIntercept) {
  const orig = fsCjs.renameSync;
  fsCjs.renameSync = (src, dest) => {
    // Chỉ chặn rename CUỐI tmp → live; các rename xoay bản sao lưu
    // (live → .1, .1 → .2) vẫn chạy bình thường.
    if (dest === storePath && src.startsWith(`${storePath}.tmp-`)) {
      onIntercept?.();
      throw new Error('mock EPERM: operation not permitted, rename');
    }
    return orig(src, dest);
  };
  return () => {
    fsCjs.renameSync = orig;
  };
}

test('Vault.setSecret: rename tmp → live thất bại — lỗi rõ ràng, backup nguyên + mở lại fallback, thử lại được', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-secret');
  vault.setSecret('provider', 'openai', 'old-secret-2');
  const liveBefore = fs.readFileSync(storePath);
  assert.ok(fs.existsSync(`${storePath}.1`), 'phải có backup .1 sau 2 lần lưu');
  let intercepts = 0;
  const restore = failStoreRename(storePath, () => intercepts++);

  let thrown;
  try {
    vault.setSecret('provider', 'anthropic', 'new-secret');
  } catch (err) {
    thrown = err;
  } finally {
    restore();
  }
  // (1) Lỗi được báo rõ: đúng nhánh ghi store, kèm nguyên nhân gốc
  // và hướng phục hồi — không phải lỗi fs thô.
  assert.ok(thrown instanceof Error, 'setSecret phải ném lỗi khi rename thất bại');
  assert.match(thrown.message, /Vault: không thể rename file tạm .* hoàn tất ghi store/);
  assert.match(thrown.message, /mock EPERM/);
  assert.match(thrown.message, /thử lại thao tác lưu là an toàn/);
  assert.equal(intercepts, 1, 'chỉ đúng 1 lần rename tmp → live bị chặn');

  // (2) Trong bộ nhớ: secret mới đã staged trước khi saveStore ném
  // (cùng ngữ nghĩa với test rotateKey — không rollback), đọc được.
  assert.equal(vault.getSecret('provider', 'anthropic'), 'new-secret');

  // (3) Trên đĩa: rename cuối lỗi SAU KHI xoay bản sao lưu nên file
  // live tạm VẮNG (cửa sổ đã ghi trong durableFile.ts/loadStore —
  // live → .1 rồi tmp → live mới lỗi), backup .1 giữ đúng nội dung
  // cũ, không còn file tạm nào sót lại; mở lại đọc được secret cũ
  // nhờ fallback sang .1.
  assert.equal(fs.existsSync(storePath), false, 'file live vắng trong cửa sổ xoay-rename');
  assert.ok(fs.existsSync(`${storePath}.1`), 'backup .1 phải còn sau lần lỗi');
  assert.ok(
    JSON.parse(fs.readFileSync(`${storePath}.1`, 'utf8')).secrets['provider:xai'] !== undefined,
    'backup .1 phải giữ secret cũ',
  );
  assert.ok(
    fs.readFileSync(`${storePath}.1`).equals(liveBefore),
    'backup .1 phải bằng đúng nội dung live trước lần lỗi',
  );
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length,
    0,
    'file tạm phải được dọn sau lần lỗi',
  );
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'xai'), 'old-secret');
  assert.equal(reopened.getSecret('provider', 'openai'), 'old-secret-2');
  assert.equal(reopened.getSecret('provider', 'anthropic'), null, 'đĩa chưa có secret mới');

  // (4) Thử lại khi rename đã hết lỗi: lưu thành công, mở lại đọc đủ.
  vault.setSecret('provider', 'anthropic', 'new-secret');
  const reopened2 = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened2.getSecret('provider', 'anthropic'), 'new-secret');
  assert.equal(reopened2.getSecret('provider', 'xai'), 'old-secret');
});

// ---------------------------------------------------------------------------
// v0.15 (L4 audit): scrypt derived-key cache + tên file tạm ngẫu nhiên
// ---------------------------------------------------------------------------

test('L4: đọc lặp cùng entry vẫn đúng khi có cache key đã derive', () => {
  const dir = makeTempDir();
  const vault = new Vault({ storePath: storeIn(dir), keyFilePath: keyIn(dir) });
  vault.setSecret('provider', 'xai', 'cached-secret-1');
  vault.setSecret('provider', 'openai', 'cached-secret-2');
  // Đọc lặp nhiều lần cùng entry: lần đầu derive key bằng scrypt,
  // các lần sau lấy từ cache theo salt — kết quả phải giống nhau.
  for (let i = 0; i < 10; i++) {
    assert.equal(vault.getSecret('provider', 'xai'), 'cached-secret-1');
    assert.equal(vault.getSecret('provider', 'openai'), 'cached-secret-2');
  }
});

test('L4: cache tối đa 32 entry (FIFO) — hơn 32 entry đọc vẫn đúng', () => {
  const dir = makeTempDir();
  const vault = new Vault({ storePath: storeIn(dir), keyFilePath: keyIn(dir) });
  for (let i = 0; i < 40; i++) {
    vault.setSecret('provider', `key-${i}`, `value-${i}`);
  }
  // 40 entry > giới hạn cache 32: entry cũ nhất đã bị đuổi khỏi cache,
  // đọc lại phải derive lại và vẫn đúng (không hỏng, không lẫn).
  for (let i = 0; i < 40; i++) {
    assert.equal(vault.getSecret('provider', `key-${i}`), `value-${i}`);
  }
  // Đọc lặp lại entry đầu tiên (đã từng bị đuổi) vẫn đúng.
  assert.equal(vault.getSecret('provider', 'key-0'), 'value-0');
});

test('L4: rotateKey xong đọc vẫn đúng (cache key cũ đã xoá)', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'rotate-cache-me');
  // Đọc trước để key cũ vào cache.
  assert.equal(vault.getSecret('provider', 'xai'), 'rotate-cache-me');
  vault.rotateKey();
  // Sau rotate, entry đã mã hoá lại bằng key mới; đọc phải đúng —
  // cache key cũ không được dùng lại cho salt/key mới.
  assert.equal(vault.getSecret('provider', 'xai'), 'rotate-cache-me');
  assert.equal(vault.getSecret('provider', 'xai'), 'rotate-cache-me');
  const fresh = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(fresh.getSecret('provider', 'xai'), 'rotate-cache-me');
});

test('L4: saveStore không để lại file tạm, không còn file .tmp-<pid> dạng cũ', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyIn(dir) });
  vault.setSecret('provider', 'xai', 'tmp-name-check');
  vault.setSecret('provider', 'openai', 'tmp-name-check-2');
  vault.deleteSecret('provider', 'openai');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'không được còn file tạm nào sau khi ghi xong');
  // Dạng cũ `.tmp-<pid>` (chỉ số PID, không hậu tố ngẫu nhiên) tuyệt
  // đối không được xuất hiện — tên mới luôn có hậu tố random hex.
  assert.ok(!fs.existsSync(`${storePath}.tmp-${process.pid}`));
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(Object.keys(parsed.secrets).length, 1);
  assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
});

// ---------------------------------------------------------------------------
// v0.15 (L5 audit): countNoStoragePendingSecrets + discardTemporarySecrets
// ---------------------------------------------------------------------------

test('L5: countNoStoragePendingSecrets đếm đúng thêm/sửa/xoá trong lúc bật', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyIn(dir) });
  vault.setSecret('provider', 'xai', 'old-xai');
  vault.setSecret('provider', 'openai', 'old-openai');

  assert.equal(vault.countNoStoragePendingSecrets(), 0, 'tắt NO_STORAGE thì đếm 0');

  vault.setNoStorage(true);
  assert.equal(vault.countNoStoragePendingSecrets(), 0, 'mới bật, chưa đổi gì thì 0');
  vault.setSecret('provider', 'temp1', 'temporary-1');
  assert.equal(vault.countNoStoragePendingSecrets(), 1, 'thêm 1 secret tạm');
  vault.setSecret('provider', 'temp2', 'temporary-2');
  assert.equal(vault.countNoStoragePendingSecrets(), 2, 'thêm secret tạm thứ 2');
  vault.setSecret('provider', 'xai', 'new-xai');
  assert.equal(vault.countNoStoragePendingSecrets(), 3, 'ghi đè secret cũ tính thêm 1');
  vault.deleteSecret('provider', 'openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 4, 'xoá secret cũ tính thêm 1');
  // Ghi đè lại cùng giá trị tạm rồi đổi tiếp vẫn tính 1 entry.
  vault.setSecret('provider', 'temp1', 'temporary-1b');
  assert.equal(vault.countNoStoragePendingSecrets(), 4, 'sửa lại secret tạm cũ không tăng thêm');

  // Tắt không discard (flush mặc định): đếm về 0, secret tạm đã lên đĩa.
  vault.setNoStorage(false);
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
  const reopened = new Vault({ storePath, keyFilePath: keyIn(dir) });
  assert.equal(reopened.getSecret('provider', 'temp1'), 'temporary-1b');
  assert.equal(reopened.getSecret('provider', 'xai'), 'new-xai');
  assert.equal(reopened.getSecret('provider', 'openai'), null);
});

test('L5: tắt với discardTemporarySecrets xoá secret tạm, khôi phục secret cũ, không ghi đĩa', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-xai');
  vault.setSecret('provider', 'openai', 'old-openai');

  vault.setNoStorage(true);
  vault.setSecret('provider', 'xai', 'new-xai'); // ghi đè secret cũ
  vault.setSecret('provider', 'temp', 'temporary-only'); // secret mới
  vault.deleteSecret('provider', 'openai'); // xoá secret cũ
  assert.equal(vault.countNoStoragePendingSecrets(), 3);

  vault.setNoStorage(false, { discardTemporarySecrets: true });

  // Trong bộ nhớ: secret tạm biến mất, secret cũ khôi phục đúng.
  assert.equal(vault.getSecret('provider', 'temp'), null);
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(vault.getSecret('provider', 'openai'), 'old-openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 0);

  // Trên đĩa: secret tạm chưa từng được ghi, secret cũ còn nguyên.
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'temp'), null);
  assert.equal(reopened.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(reopened.getSecret('provider', 'openai'), 'old-openai');
  const raw = fs.readFileSync(storePath, 'utf8');
  assert.ok(!raw.includes('temporary-only'), 'đĩa không được chứa secret tạm đã xoá');
});

test('L5: tắt không discard (mặc định) vẫn flush như cũ', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setNoStorage(true);
  vault.setSecret('provider', 'temp', 'flush-me');
  vault.setNoStorage(false); // không opts -> flush như cũ
  assert.equal(vault.getSecret('provider', 'temp'), 'flush-me');
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'temp'), 'flush-me');
});

test('L5: Vault khởi động đã ở noStorage thì secret thêm sau đó mới là tạm', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  new Vault({ storePath, keyFilePath: keyPath }).setSecret('provider', 'xai', 'on-disk');

  const vault = new Vault({ storePath, keyFilePath: keyPath, noStorage: true });
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
  vault.setSecret('provider', 'temp', 'temporary-only');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  vault.setNoStorage(false, { discardTemporarySecrets: true });
  assert.equal(vault.getSecret('provider', 'temp'), null);
  assert.equal(vault.getSecret('provider', 'xai'), 'on-disk');
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'temp'), null);
  assert.equal(reopened.getSecret('provider', 'xai'), 'on-disk');
});

// ---------------------------------------------------------------------------
// v0.17 (W12d): rotateKey trong lúc NO_STORAGE bật
// ---------------------------------------------------------------------------

test('W12d: rotateKey trong lúc NO_STORAGE bật — secret tạm còn, đĩa + key file chưa đổi', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-xai');
  const storeBefore = fs.readFileSync(storePath, 'utf8');
  const keyBefore = fs.readFileSync(keyPath);

  vault.setNoStorage(true);
  vault.setSecret('provider', 'temp', 'temporary-only');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);

  vault.rotateKey();
  // Secret tạm + cũ vẫn đọc được bằng key mới (trong bộ nhớ).
  assert.equal(vault.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');
  // Baseline không bị mất: secret cũ không tính là tạm sau rotate.
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  // Đĩa chưa bị đụng tới: key file vẫn key cũ, store vẫn ciphertext cũ,
  // chưa có file .new/.bak (key mới chỉ sống trong bộ nhớ).
  assert.ok(fs.readFileSync(keyPath).equals(keyBefore), 'key file chưa đổi khi NO_STORAGE bật');
  assert.equal(fs.readFileSync(storePath, 'utf8'), storeBefore, 'store trên đĩa chưa đổi');
  assert.equal(fs.existsSync(`${keyPath}.new`), false);
  assert.equal(fs.existsSync(`${keyPath}.bak`), false);
});

test('W12d: rotateKey trong lúc NO_STORAGE bật rồi tắt (flush) — secret tạm lên đĩa, mở lại bằng key mới', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-xai');
  const oldKey = fs.readFileSync(keyPath);

  vault.setNoStorage(true);
  vault.setSecret('provider', 'temp', 'temporary-only');
  vault.rotateKey();
  assert.equal(vault.getSecret('provider', 'temp'), 'temporary-only');

  vault.setNoStorage(false); // flush
  assert.equal(vault.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');
  // Key file đã đổi sang key mới, không còn .new/.bak.
  assert.ok(!fs.readFileSync(keyPath).equals(oldKey), 'key file phải đổi sau khi flush');
  assert.equal(fs.existsSync(`${keyPath}.new`), false);
  assert.equal(fs.existsSync(`${keyPath}.bak`), false);

  // Mở lại bằng key file mới: đọc được cả secret cũ lẫn tạm.
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(reopened.getSecret('provider', 'xai'), 'old-xai');
  // Key cũ không còn đọc được store mới.
  const stale = new Vault({ storePath, encryptor: new LocalEncryptor(oldKey) });
  assert.throws(() => stale.getSecret('provider', 'xai'), /Failed to decrypt/);
});

test('W12d: rotateKey trong lúc NO_STORAGE bật rồi tắt với discard — secret tạm mất, secret cũ còn (đọc bằng key mới)', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-xai');
  vault.setSecret('provider', 'openai', 'old-openai');

  vault.setNoStorage(true);
  vault.setSecret('provider', 'xai', 'new-xai'); // ghi đè secret cũ
  vault.setSecret('provider', 'temp', 'temporary-only'); // secret mới
  vault.deleteSecret('provider', 'openai'); // xoá secret cũ
  assert.equal(vault.countNoStoragePendingSecrets(), 3);

  vault.rotateKey();
  // Trong lúc NO_STORAGE bật, secret tạm vẫn đọc được bằng key mới.
  assert.equal(vault.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(vault.getSecret('provider', 'xai'), 'new-xai');
  assert.equal(vault.getSecret('provider', 'openai'), null);
  assert.equal(vault.countNoStoragePendingSecrets(), 3);

  vault.setNoStorage(false, { discardTemporarySecrets: true });
  // Trong bộ nhớ: secret tạm biến mất, secret cũ khôi phục đúng.
  assert.equal(vault.getSecret('provider', 'temp'), null);
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(vault.getSecret('provider', 'openai'), 'old-openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 0);

  // Trên đĩa (mở lại bằng key mới): secret cũ còn, secret tạm không có.
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'temp'), null);
  assert.equal(reopened.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(reopened.getSecret('provider', 'openai'), 'old-openai');
  const raw = fs.readFileSync(storePath, 'utf8');
  assert.ok(!raw.includes('temporary-only'), 'đĩa không được chứa secret tạm đã xoá');
  assert.equal(fs.existsSync(`${keyPath}.new`), false);
  assert.equal(fs.existsSync(`${keyPath}.bak`), false);
});

test('W12d: rotateKey 2 lần trong lúc NO_STORAGE bật rồi flush — chỉ key cuối lên đĩa', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-xai');
  const oldKey = fs.readFileSync(keyPath);

  vault.setNoStorage(true);
  vault.setSecret('provider', 'temp', 'temporary-only');
  vault.rotateKey();
  vault.rotateKey(); // lần 2 thay thế pending của lần 1 (key lần 1 chưa lên đĩa)
  assert.equal(vault.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  // Key file trên đĩa vẫn là key cũ cho tới khi flush.
  assert.ok(fs.readFileSync(keyPath).equals(oldKey));
  assert.equal(fs.existsSync(`${keyPath}.new`), false);

  vault.setNoStorage(false);
  assert.ok(!fs.readFileSync(keyPath).equals(oldKey), 'key file phải đổi sau khi flush');
  assert.equal(fs.existsSync(`${keyPath}.new`), false);
  assert.equal(fs.existsSync(`${keyPath}.bak`), false);
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(reopened.getSecret('provider', 'xai'), 'old-xai');
});

test('W12d: rotateKey(newEncryptor) trong lúc NO_STORAGE bật — baseline mã hoá lại, discard vẫn khôi phục secret cũ', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyIn(dir) });
  vault.setSecret('provider', 'xai', 'old-xai');

  vault.setNoStorage(true);
  vault.setSecret('provider', 'temp', 'temporary-only');
  const otherKey = loadOrCreateMachineKey(path.join(makeTempDir(), 'other.key'));
  vault.rotateKey(new LocalEncryptor(otherKey));
  assert.equal(vault.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);

  vault.setNoStorage(false, { discardTemporarySecrets: true });
  assert.equal(vault.getSecret('provider', 'temp'), null);
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');

  // Store trên đĩa đã ghi bằng encryptor mới — mở lại bằng encryptor đó.
  const reopened = new Vault({ storePath, encryptor: new LocalEncryptor(otherKey) });
  assert.equal(reopened.getSecret('provider', 'temp'), null);
  assert.equal(reopened.getSecret('provider', 'xai'), 'old-xai');
});

// ---------------------------------------------------------------------------
// v0.24 (W17a): countNoStoragePendingSecrets nhanh hơn nhờ hash SHA-256
// ---------------------------------------------------------------------------

// Encryptor đếm số lần gọi encrypt/decrypt — thước đo tin cậy cho hiệu
// năng của countNoStoragePendingSecrets: mỗi lần LocalEncryptor.decrypt
// tốn 1 lần scrypt theo salt riêng (~130ms trên VM này), nên "đếm không
// giải mã lại" tương đương "đếm không tốn scrypt". Không đo bằng thời
// gian (nhiễu, flake) mà đếm trực tiếp số lần decrypt.
function countingEncryptor(inner) {
  const stats = { encryptCalls: 0, decryptCalls: 0 };
  const enc = {
    encrypt: (buf) => {
      stats.encryptCalls += 1;
      return inner.encrypt(buf);
    },
    decrypt: (buf) => {
      stats.decryptCalls += 1;
      return inner.decrypt(buf);
    },
  };
  return { enc, stats };
}

// Encryptor giả NHANH (không scrypt) chỉ để kiểm tra đường rotateKey:
// tính đúng của cache sau rotate không phụ thuộc backend, mà phụ thuộc
// việc rotateKey có nạp lại cache từ plaintext đang có trong tay hay
// không — đếm số lần decrypt trên backend mới sau rotate là đủ.
function fakeCountingEncryptor() {
  const stats = { encryptCalls: 0, decryptCalls: 0 };
  const prefix = Buffer.from('FAKE1:');
  const enc = {
    encrypt: (buf) => {
      stats.encryptCalls += 1;
      return Buffer.concat([prefix, buf]);
    },
    decrypt: (buf) => {
      stats.decryptCalls += 1;
      if (!buf.subarray(0, prefix.length).equals(prefix)) {
        throw new Error('Failed to decrypt vault entry: wrong key or tampered data.');
      }
      return Buffer.from(buf.subarray(prefix.length));
    },
  };
  return { enc, stats };
}

test('W17a: ghi đè đúng giá trị cũ / xoá rồi thêm lại đúng giá trị không tính là tạm', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-xai');
  vault.setSecret('provider', 'openai', 'old-openai');

  vault.setNoStorage(true);
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
  // Ghi đè đúng giá trị cũ: ciphertext đổi (salt/IV ngẫu nhiên) nhưng
  // plaintext giống baseline → không tạm.
  vault.setSecret('provider', 'xai', 'old-xai');
  assert.equal(vault.countNoStoragePendingSecrets(), 0, 'ghi đè đúng giá trị cũ không tính là tạm');
  // Xoá rồi thêm lại đúng giá trị cũ → vẫn 0.
  vault.deleteSecret('provider', 'openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 1, 'xoá thì tính là tạm');
  vault.setSecret('provider', 'openai', 'old-openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 0, 'thêm lại đúng giá trị cũ thì hết tạm');
  // Đổi rồi đổi lại về giá trị cũ → vẫn 0.
  vault.setSecret('provider', 'xai', 'new-xai');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  vault.setSecret('provider', 'xai', 'old-xai');
  assert.equal(vault.countNoStoragePendingSecrets(), 0, 'đổi rồi trả lại giá trị cũ thì hết tạm');
  // Thêm mới rồi xoá ngay → 0 (không còn khác baseline).
  vault.setSecret('provider', 'temp', 'temporary-only');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  vault.deleteSecret('provider', 'temp');
  assert.equal(vault.countNoStoragePendingSecrets(), 0);

  // Discard sau đó: mọi thứ về đúng giá trị cũ.
  vault.setNoStorage(false, { discardTemporarySecrets: true });
  assert.equal(vault.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(vault.getSecret('provider', 'openai'), 'old-openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
});

test('W17a: rotateKey (không đối số) trong lúc NO_STORAGE bật rồi đếm vẫn đúng', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  vault.setSecret('provider', 'xai', 'old-xai');
  vault.setSecret('provider', 'openai', 'old-openai');

  vault.setNoStorage(true);
  vault.setSecret('provider', 'temp', 'temporary-only');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);

  vault.rotateKey();
  // Sau rotate, baseline và secret đều mã hoá lại bằng key mới nhưng
  // plaintext không đổi → chỉ secret tạm tính là tạm.
  assert.equal(vault.countNoStoragePendingSecrets(), 1, 'rotate không được làm secret cũ thành tạm');
  // Ghi đè đúng giá trị cũ sau rotate vẫn không tính là tạm.
  vault.setSecret('provider', 'xai', 'old-xai');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  // Xoá rồi thêm lại đúng giá trị cũ sau rotate → không tăng.
  vault.deleteSecret('provider', 'openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 2);
  vault.setSecret('provider', 'openai', 'old-openai');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  // Ghi đè secret tạm bằng đúng giá trị tạm → không tăng.
  vault.setSecret('provider', 'temp', 'temporary-only');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);

  vault.setNoStorage(false); // flush
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
  const reopened = new Vault({ storePath, keyFilePath: keyPath });
  assert.equal(reopened.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(reopened.getSecret('provider', 'xai'), 'old-xai');
  assert.equal(reopened.getSecret('provider', 'openai'), 'old-openai');
});

test('W17a: vault ~200 secret — đếm lặp không giải mã lại (đếm số lần decrypt)', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const key = loadOrCreateMachineKey(path.join(dir, 'count.key'));
  const { enc, stats } = countingEncryptor(new LocalEncryptor(key));
  const vault = new Vault({ storePath, encryptor: enc });
  for (let i = 0; i < 200; i++) {
    vault.setSecret('provider', `key-${i}`, `value-${i}`);
  }
  // setSecret chỉ mã hoá (không giải mã): constructor + 200 lần set
  // không tốn lần decrypt nào.
  assert.equal(stats.decryptCalls, 0, 'setup không được giải mã lần nào');

  vault.setNoStorage(true);
  // Đếm lặp 5 lần khi không đổi gì: ciphertext giống baseline nên
  // fast-path bỏ qua, không giải mã lần nào.
  for (let n = 0; n < 5; n++) {
    assert.equal(vault.countNoStoragePendingSecrets(), 0, `lần đếm ${n + 1} phải là 0`);
  }
  assert.equal(stats.decryptCalls, 0, 'đếm lặp khi không đổi không được giải mã');

  // Ghi đè 1 secret bằng giá trị khác: hash phía secret mới đã có sẵn
  // từ setSecret, và hash phía baseline cũng đã có sẵn từ lúc setSecret
  // giá trị gốc trước khi bật NO_STORAGE (baseline giữ nguyên chính
  // ciphertext đó) — nên đếm vẫn không cần giải mã lần nào.
  vault.setSecret('provider', 'key-0', 'value-0-CHANGED');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  assert.equal(stats.decryptCalls, 0, 'đếm sau thay đổi vẫn không giải mã (2 phía đều đã cache từ setSecret)');
  // Đếm lại: vẫn 0 lần giải mã.
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  assert.equal(stats.decryptCalls, 0, 'đếm lại không được giải mã thêm');

  // Ghi đè lại đúng giá trị cũ: 2 phía đều đã cache → 0 lần giải mã
  // mới, và hết tạm.
  vault.setSecret('provider', 'key-0', 'value-0');
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
  assert.equal(stats.decryptCalls, 0, 'ghi đè về giá trị cũ không được giải mã thêm');

  // Thêm secret mới: không có phía baseline để so → không giải mã.
  vault.setSecret('provider', 'temp', 'temporary-only');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  assert.equal(stats.decryptCalls, 0, 'thêm secret mới không được giải mã thêm');
});

test('W17a: vault mở lại từ đĩa — lần đếm đầu chỉ giải mã entry khác baseline, lần sau không giải mã', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const first = new Vault({ storePath, keyFilePath: keyPath });
  for (let i = 0; i < 30; i++) {
    first.setSecret('provider', `key-${i}`, `value-${i}`);
  }
  const keyBytes = fs.readFileSync(keyPath);

  // Mở lại bằng encryptor đếm: vault dùng encryptor ngoài nên
  // keyFilePath là null, repairKeyAfterCrash bỏ qua ngay — constructor
  // không giải mã lần nào.
  const { enc, stats } = countingEncryptor(new LocalEncryptor(keyBytes));
  const vault = new Vault({ storePath, encryptor: enc });
  assert.equal(stats.decryptCalls, 0, 'constructor (encryptor ngoài) không giải mã');

  vault.setNoStorage(true);
  assert.equal(stats.decryptCalls, 0, 'bật NO_STORAGE không được giải mã (lazy)');
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
  assert.equal(stats.decryptCalls, 0, 'đếm khi không đổi không được giải mã');

  // Ghi đè 10 secret: phía secret mới đã cache từ setSecret, phía
  // baseline của đúng 10 entry đó phải giải mã 1 lần mỗi entry.
  for (let i = 0; i < 10; i++) {
    vault.setSecret('provider', `key-${i}`, `value-${i}-CHANGED`);
  }
  assert.equal(vault.countNoStoragePendingSecrets(), 10);
  assert.equal(
    stats.decryptCalls,
    10,
    'lần đếm đầu sau thay đổi chỉ giải mã 10 phía baseline (không giải mã 20 entry còn nguyên)',
  );
  // Đếm lại: mọi hash đã cache → không giải mã thêm.
  assert.equal(vault.countNoStoragePendingSecrets(), 10);
  assert.equal(stats.decryptCalls, 10, 'đếm lại không được giải mã thêm');
});

test('W17a: rotateKey(newEncryptor) trong lúc NO_STORAGE bật — đếm sau rotate không giải mã', () => {
  const dir = makeTempDir();
  const storePath = storeIn(dir);
  const keyPath = keyIn(dir);
  const vault = new Vault({ storePath, keyFilePath: keyPath });
  for (let i = 0; i < 30; i++) {
    vault.setSecret('provider', `key-${i}`, `value-${i}`);
  }

  vault.setNoStorage(true);
  vault.setSecret('provider', 'temp', 'temporary-only');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);

  // Rotate sang backend mới (đếm số lần decrypt trên backend mới):
  // rotateKey đã có plaintext trong tay nên nạp lại cache luôn — đếm
  // sau rotate không cần giải mã entry nào, dù toàn bộ ciphertext đã đổi.
  const { enc, stats } = fakeCountingEncryptor();
  vault.rotateKey(enc);
  assert.equal(vault.countNoStoragePendingSecrets(), 1, 'rotate không được làm secret cũ thành tạm');
  assert.equal(stats.decryptCalls, 0, 'đếm sau rotate không được giải mã lần nào');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  assert.equal(stats.decryptCalls, 0, 'đếm lặp sau rotate vẫn không giải mã');
  // Ghi đè đúng giá trị cũ sau rotate vẫn không tính là tạm.
  vault.setSecret('provider', 'key-0', 'value-0');
  assert.equal(vault.countNoStoragePendingSecrets(), 1);
  assert.equal(stats.decryptCalls, 0, 'ghi đè đúng giá trị cũ sau rotate không được giải mã');

  // Secret vẫn đọc được bằng backend mới; discard khôi phục đúng.
  assert.equal(vault.getSecret('provider', 'temp'), 'temporary-only');
  assert.equal(vault.getSecret('provider', 'key-0'), 'value-0');
  vault.setNoStorage(false, { discardTemporarySecrets: true });
  assert.equal(vault.getSecret('provider', 'temp'), null);
  assert.equal(vault.getSecret('provider', 'key-0'), 'value-0');
  assert.equal(vault.countNoStoragePendingSecrets(), 0);
});
