/**
 * Vault — encrypted secret store for open-bot (v0.4).
 *
 * Secrets are kept in ONE JSON file (path supplied by the caller, e.g.
 * `<userData>/vault.json`). The file holds only ciphertext (base64) —
 * NEVER plaintext. Namespaces separate the kinds of secret:
 *
 *   'provider' — provider API keys, keyed by provider id
 *                (e.g. ns='provider', key='xai')
 *   'mcp'      — MCP server credentials, keyed by server id
 *   'plugin'   — plugin secrets, keyed by plugin id
 *   'oauth'    — OAuth refresh tokens, keyed by service id
 *   'session'  — session tokens, keyed by account id
 *
 * The three credential kinds (session token / OAuth refresh token /
 * API key) are kept in different namespaces on purpose — they must
 * never be mixed up (see GROK-BOT-ANALYSIS.md §4).
 *
 * Encryption backends are swappable through the `Encryptor` interface:
 *
 *   - `LocalEncryptor` (this file) is the FALLBACK: AES-256-GCM with a
 *     key derived by scrypt from a machine key file stored separately
 *     (mode 0600). It protects secrets from casual disk reads, but it
 *     is NOT as strong as the OS keychain: anyone who can read the key
 *     file can decrypt the vault. Use it only until the Electron
 *     `safeStorage` adapter is wired in (see `SafeStorageEncryptor`).
 *   - `SafeStorageEncryptor` (this file) adapts Electron's
 *     `safeStorage` (DPAPI on Windows, keychain on macOS, libsecret on
 *     Linux). The core package must NOT import `electron` itself, so
 *     the main process passes its `safeStorage` object in — see
 *     docs/v04-worker1-integration.md.
 *
 * Secret values are NEVER logged. Errors never echo a secret value.
 * Writes are atomic (temp file + rename) and the store file is created
 * with mode 0600.
 *
 * v0.53 (P1-6, REA deep-dive lần 2 §7): hardened after Grok's vault —
 *   - durable writes with BOUNDED backup copies (see durableFile.ts):
 *     `vault.json` + `vault.json.1`…`.3`, crash-safe rotation;
 *   - THREE separate stores: session-only secrets (in-memory Map,
 *     never written to disk — see sessionStore.ts), the disk-encrypted
 *     store (this class), and webhook keys (a separate file owned by
 *     WebhookKeyStore, `automation-webhook-keys.json`);
 *   - per-entry `maxAgeMs` + `savedAtMs` (Grok `gateway-descriptor`
 *     pattern): expired encrypted entries are refused on read;
 *   - refusal taxonomy (`vault_full` / `refused`, see refusals.ts)
 *     + 15s wire timeout for out-of-process calls (1Password broker);
 *   - `saveToVault` opt-in on every credential-creating write:
 *     `setSecret(..., { saveToVault: false })` keeps the secret
 *     session-only instead of persisting it;
 *   - 1Password lives behind an out-of-process broker
 *     (onePasswordBroker.ts) — the Vault never holds 1Password
 *     credentials itself.
 *
 * v0.5 NO_STORAGE mode (see `VaultOptions.noStorage` and
 * `Vault.setNoStorage`): while on, secrets are kept in memory only
 * and the store file is never written; turning it off flushes the
 * in-memory state to disk — unless the caller passes
 * `{ discardTemporarySecrets: true }` (v0.15, L5 audit), which drops
 * the secrets added/changed while NO_STORAGE was on instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { writeDurableFileSync, DEFAULT_DURABLE_COPIES } from './durableFile';
import { SessionSecretStore } from './sessionStore';
import {
  DEFAULT_VAULT_MAX_ENTRIES,
  VaultRefusalError,
  type VaultRefusal,
} from './refusals';

// ---------------------------------------------------------------------------
// Encryptor interface
// ---------------------------------------------------------------------------

/**
 * A symmetric encryption backend. `encrypt`/`decrypt` are inverses:
 * `decrypt(encrypt(plain))` must equal `plain`. `decrypt` MUST throw
 * on tampered or wrong-key ciphertext (authenticated encryption).
 */
export interface Encryptor {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(ciphertext: Buffer): Buffer;
}

/** Shape of Electron's `safeStorage` that this module needs. */
export interface SafeStorageLike {
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isEncryptionAvailable(): boolean;
}

/**
 * Adapter around Electron `safeStorage` (DPAPI / keychain / libsecret).
 * The caller (main process) passes `safeStorage` in; core never imports
 * electron. The ciphertext is stored base64-encoded so it can live in
 * the JSON store alongside LocalEncryptor payloads.
 */
export function createSafeStorageEncryptor(safeStorage: SafeStorageLike): Encryptor {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage encryption is not available on this machine (no OS keychain / DPAPI). ' +
        'Fall back to LocalEncryptor or refuse to store secrets.',
    );
  }
  return {
    encrypt(plaintext: Buffer): Buffer {
      // safeStorage works on strings; base64 keeps arbitrary bytes intact.
      const encoded = safeStorage.encryptString(plaintext.toString('base64'));
      return Buffer.from(encoded.toString('base64'), 'utf8');
    },
    decrypt(ciphertext: Buffer): Buffer {
      const encoded = Buffer.from(ciphertext.toString('utf8'), 'base64');
      return Buffer.from(safeStorage.decryptString(encoded), 'base64');
    },
  };
}

// ---------------------------------------------------------------------------
// LocalEncryptor — FALLBACK backend (AES-256-GCM + scrypt machine key)
// ---------------------------------------------------------------------------

/** Version byte of the LocalEncryptor envelope (first byte of payload). */
const LOCAL_ENVELOPE_VERSION = 1;

/**
 * Envelope layout (all concatenated):
 *   [1B version][16B salt][12B iv][ciphertext][16B GCM auth tag]
 * The key is derived per envelope with scrypt from the machine key, so
 * rotating the machine key re-encrypts every entry (see Vault.rotateKey).
 */
export class LocalEncryptor implements Encryptor {
  private readonly machineKey: Buffer;
  /**
   * v0.15 (L4 audit): cache key đã derive theo salt — `scryptSync`
   * tốn ~50-100ms đồng bộ mỗi lần, và `getSecret` gọi lặp lại cùng
   * entry (vd khởi động load nhiều provider) sẽ derive lại cùng một
   * key vô ích. Cache chỉ giữ key đã derive TRONG BỘ NHỚ (không ghi
   * đĩa), tối đa 32 entry, FIFO — khi đầy thì xoá entry cũ nhất
   * (Map giữ thứ tự chèn; KHÔNG refresh vị trí khi hit, đúng FIFO).
   * Lưu ý: mỗi entry có một salt riêng nên cache CHỈ giúp khi đọc lặp
   * cùng entry; encrypt luôn sinh salt mới nên gần như không bao giờ
   * hit cache. `rotateKey` đổi machine key thì cache bị xoá
   * (xem `clearDerivedKeyCache` + `Vault.rotateKey`).
   */
  private readonly derivedKeyCache = new Map<string, Buffer>();
  private static readonly MAX_DERIVED_KEY_CACHE = 32;

  /**
   * @param machineKey 32 random bytes kept OUTSIDE the vault store file.
   *   Use `loadOrCreateMachineKey(keyFilePath)` to obtain one.
   */
  constructor(machineKey: Buffer) {
    if (!Buffer.isBuffer(machineKey) || machineKey.length < 32) {
      throw new Error('LocalEncryptor needs a machine key of at least 32 bytes.');
    }
    this.machineKey = Buffer.from(machineKey);
  }

  /**
   * Derive (hoặc lấy từ cache) key AES-256 cho một salt. Trả về một
   * BẢN SAO của key trong cache để caller không thể sửa key đã cache
   * (createCipheriv/createDecipheriv không được phép giữ tham chiếu
   * có thể bị thay đổi bên ngoài).
   */
  private deriveKey(salt: Buffer): Buffer {
    const id = salt.toString('hex');
    const hit = this.derivedKeyCache.get(id);
    if (hit) return Buffer.from(hit);
    const key = scryptSync(this.machineKey, salt, 32);
    if (this.derivedKeyCache.size >= LocalEncryptor.MAX_DERIVED_KEY_CACHE) {
      // FIFO: xoá entry được chèn sớm nhất.
      const oldest = this.derivedKeyCache.keys().next().value;
      if (oldest !== undefined) this.derivedKeyCache.delete(oldest);
    }
    this.derivedKeyCache.set(id, key);
    return Buffer.from(key);
  }

  /**
   * Xoá toàn bộ key đã derive trong cache. Gọi khi machine key bị
   * thay (rotateKey) để không giữ key cũ trong bộ nhớ — dù cache này
   * gắn với một instance (đổi key là đổi instance) thì việc xoá tường
   * minh vẫn đúng và an toàn khi cùng instance được dùng lại.
   */
  clearDerivedKeyCache(): void {
    this.derivedKeyCache.clear();
  }

  encrypt(plaintext: Buffer): Buffer {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = this.deriveKey(salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([
      Buffer.from([LOCAL_ENVELOPE_VERSION]),
      salt,
      iv,
      ciphertext,
      tag,
    ]);
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (ciphertext.length < 1 + 16 + 12 + 16) {
      throw new Error('Ciphertext is too short to be a valid vault entry.');
    }
    if (ciphertext[0] !== LOCAL_ENVELOPE_VERSION) {
      throw new Error(`Unsupported vault envelope version: ${ciphertext[0]}.`);
    }
    const salt = ciphertext.subarray(1, 17);
    const iv = ciphertext.subarray(17, 29);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(29, ciphertext.length - 16);
    const key = this.deriveKey(salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      // GCM auth failure: wrong key OR tampered ciphertext. Never say
      // which, and never echo any bytes of the payload.
      throw new Error('Failed to decrypt vault entry: wrong key or tampered data.');
    }
  }
}

/**
 * Load the machine key file, creating it (32 random bytes, mode 0600)
 * when it does not exist yet. The key file MUST live next to — but
 * separate from — the vault store file, so a copy of the store alone
 * is not enough to read the secrets.
 */
export function loadOrCreateMachineKey(keyFilePath: string): Buffer {
  try {
    const existing = fs.readFileSync(keyFilePath);
    if (existing.length >= 32) return existing;
    throw new Error('Machine key file exists but is too short.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
  fs.writeFileSync(keyFilePath, key, { mode: 0o600 });
  return key;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface VaultOptions {
  /** Path of the JSON store file, e.g. `<userData>/vault.json`. */
  storePath: string;
  /**
   * Encryption backend. When omitted, a `LocalEncryptor` is built from
   * the machine key file (`keyFilePath`, or `<storePath>.key`).
   * Pass `createSafeStorageEncryptor(safeStorage)` from main for the
   * OS-keychain backend.
   */
  encryptor?: Encryptor;
  /** Machine key file for the default LocalEncryptor. Default: `<storePath>.key`. */
  keyFilePath?: string;
  /**
   * v0.5 NO_STORAGE mode (ROADMAP §2d): start with durable writes
   * disabled. While on, `setSecret`/`deleteSecret` only change the
   * in-memory copy — the store file is never created or modified.
   * Turning it off with `setNoStorage(false)` flushes everything
   * currently in memory to disk. An existing store file is still
   * READ on construction (previously persisted secrets stay
   * readable); NO_STORAGE only stops NEW durable writes.
   */
  noStorage?: boolean;
  /**
   * v0.53 (P1-6): max number of disk entries. A NEW entry past the
   * cap is refused with `{kind: 'vault_full'}` (see `trySetSecret` /
   * `VaultRefusalError`) — overwriting an existing entry never
   * counts. Default DEFAULT_VAULT_MAX_ENTRIES (1000).
   */
  maxEntries?: number;
}

interface VaultStoreFile {
  version: 1;
  /** Composite key `${namespace}:${key}` -> base64 ciphertext. */
  secrets: Record<string, string>;
  /**
   * v0.53 (P1-6): per-entry metadata, same composite keys as
   * `secrets` (`savedAtMs` + optional `maxAgeMs` — same idea as
   * Grok's `gateway-descriptor` entries). Optional so old files (no
   * `meta` key at all) still load; entries without metadata get
   * `savedAtMs` = store file mtime and no expiry. The on-disk
   * `version` stays 1 and the `secrets` map keeps its exact old
   * shape, so pre-v0.53 stores keep loading.
   */
  meta?: Record<string, VaultEntryMeta>;
}

/**
 * v0.53 (P1-6): per-entry metadata (see `VaultStoreFile.meta`).
 * An entry past `savedAtMs + maxAgeMs` is refused on read.
 */
export interface VaultEntryMeta {
  /** Epoch ms when the entry was (last) written. */
  savedAtMs: number;
  /** Optional lifetime in ms; expired entries are refused on read. */
  maxAgeMs?: number;
}

/** Options for a single credential-creating write (v0.53, P1-6). */
export interface SetSecretOptions {
  /**
   * Lifetime in ms for this entry. Past `savedAtMs + maxAgeMs` the
   * entry is refused on read (and purged). Omitted = never expires.
   */
  maxAgeMs?: number;
  /**
   * Opt-in to durable storage (mirrors Grok's `saveToVault` flag on
   * vault-item creation): `false` keeps the secret SESSION-ONLY —
   * in memory, never written to the store file, gone when the
   * process exits. Default true (persist, the pre-v0.53 behaviour).
   * A session-only value shadows a disk value of the same key while
   * the process runs (the fresher, explicitly temporary intent).
   */
  saveToVault?: boolean;
}

const NS_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertName(value: string, what: string): void {
  if (typeof value !== 'string' || !NS_KEY_RE.test(value)) {
    throw new Error(
      `Invalid vault ${what}: must be non-empty and match /^[A-Za-z0-9][A-Za-z0-9._-]*$/`,
    );
  }
}

export class Vault {
  private readonly storePath: string;
  private encryptor: Encryptor;
  private readonly keyFilePath: string | null;
  private secrets: Record<string, string>;
  /** v0.53 (P1-6): per-entry metadata, same composite keys as `secrets`. */
  private entryMeta: Record<string, VaultEntryMeta>;
  /**
   * v0.53 (P1-6): session-only secrets (in-memory Map, never written
   * to disk — Grok's `sessionSecrets`). `setSecret(..., { saveToVault:
   * false })` lands here; `getSecret` checks here FIRST so a
   * session-only value shadows the disk value of the same key.
   */
  private readonly sessionSecrets = new SessionSecretStore();
  /** v0.53 (P1-6): entry cap; new entries past it are refused `vault_full`. */
  private readonly maxEntries: number;
  /** v0.5 NO_STORAGE: while true, writes stay in memory only. */
  private noStorage: boolean;
  /**
   * v0.15 (L5 audit): ảnh chụp trạng thái TRÊN ĐĨA tại thời điểm
   * NO_STORAGE được bật (bản sao ciphertext, không phải plaintext).
   * Dùng để phân biệt "secret tạm" (thêm/sửa/xoá trong lúc NO_STORAGE
   * bật) với secret cũ đã có trên đĩa — xem `countNoStoragePendingSecrets`
   * và `setNoStorage(false, { discardTemporarySecrets: true })`.
   * - Bật NO_STORAGE: baseline = bản sao state hiện tại (chính là
   *   state trên đĩa, vì chưa có ghi nào trong lúc bật).
   * - Tắt NO_STORAGE (flush hay discard): baseline bị xoá.
   * - `null` khi NO_STORAGE đang tắt.
   * - v0.17 (W12d): `rotateKey` chạy trong lúc NO_STORAGE bật KHÔNG
   *   được để baseline thành null nữa — baseline được mã hoá lại bằng
   *   key mới cùng lúc với secret (xem `rotateKey`), nên discard sau
   *   đó vẫn khôi phục đúng secret cũ. Baseline null trong lúc
   *   NO_STORAGE bật chỉ còn là trường hợp phòng thủ (vd vault cũ);
   *   khi đó discard dùng phương án dự phòng: load lại từ đĩa rồi mã
   *   hoá lại bằng key hiện tại (xem `reencryptDiskStoreForDiscard`).
   */
  private noStorageBaseline: Record<string, string> | null;
  /**
   * v0.53 (P1-6): metadata snapshot matching `noStorageBaseline`
   * (same composite keys). Discard restores both together, so an
   * entry's `savedAtMs`/`maxAgeMs` survive a NO_STORAGE round-trip
   * exactly like its ciphertext does.
   */
  private noStorageBaselineMeta: Record<string, VaultEntryMeta> | null;
  /**
   * v0.17 (W12d): key mới của một lần `rotateKey()` (không đối số)
   * chạy trong lúc NO_STORAGE bật — chỉ sống TRONG BỘ NHỚ, chưa ghi
   * lên đĩa. Key file trên đĩa vẫn là key cũ và store trên đĩa vẫn là
   * ciphertext key cũ, hai thứ vẫn khớp nhau; ghi `.new` rồi rename
   * ngay lúc này sẽ làm key file mới không đọc được store cũ (và
   * `repairKeyAfterCrash` cũng không cứu được vì `.bak` đã bị xoá).
   * Key này được commit khi `setNoStorage(false)` flush: chuẩn bị
   * `.bak`/`.new` trước khi ghi store, rename `.new` → key file sau
   * khi store đã durable (xem `preparePendingKeyRotation` /
   * `commitPendingKeyRotation`). Thoát process trước khi flush thì
   * pending mất theo, đĩa giữ nguyên state cũ — đúng semantics
   * NO_STORAGE. `null` khi không có rotation nào đang chờ.
   */
  private pendingRotatedKey: Buffer | null = null;
  /**
   * v0.24 (W17a): cache SHA-256 của plaintext theo ciphertext (base64)
   * — để `countNoStoragePendingSecrets()` so sánh bằng hash thay vì
   * giải mã lại từng entry mỗi lần đếm (mỗi lần giải mã tốn 1 scrypt
   * theo salt riêng, xem ghi chú v0.20). Cache chỉ giữ HASH, không giữ
   * plaintext; hash không đảo ngược được thành secret. Key là chuỗi
   * ciphertext nên cùng một ciphertext luôn ứng với cùng một plaintext
   * (trừ va chạm mã hoá, không đáng kể) — entry cũ trong cache không
   * bao giờ cho kết quả sai, chỉ có thể thừa (ciphertext đã chết sau
   * ghi đè/xoá/rotate). Giới hạn 1024 entry, FIFO như derived-key
   * cache; `rotateKey` đổi toàn bộ ciphertext nên xoá và nạp lại cache
   * từ đầu thay vì giữ entry cũ (xem `rotateKey`).
   *
   * Cách nạp cache (không bao giờ giải mã chỉ để nạp):
   * - `setSecret`: plaintext đang có sẵn trong tay → hash thẳng.
   * - `rotateKey` / `reencryptDiskStoreForDiscard`: plaintext đã giải
   *   mã sẵn để mã hoá lại → hash kèm luôn, không tốn thêm lần nào.
   * - `countNoStoragePendingSecrets`: chỉ entry nào ciphertext khác
   *   baseline VÀ chưa có trong cache mới phải giải mã MỘT lần (lazy),
   *   lần đếm sau dùng lại hash đã cache — đếm lại khi không đổi thì
   *   không giải mã gì cả. Entry giải mã lỗi được cache là `null` để
   *   lần đếm sau không tốn scrypt thử lại vô ích (vẫn đếm thận trọng
   *   là khác, như hành vi cũ); ciphertext đổi (ghi đè) thì key cache
   *   khác nên không dính `null` cũ.
   */
  private readonly plainHashByCiphertext = new Map<string, string | null>();
  private static readonly MAX_PLAIN_HASH_CACHE = 1024;
  /**
   * v0.15 (M6 audit): true khi Vault đang chạy bằng LocalEncryptor
   * fallback thay vì safeStorage của OS. Đặt lúc khởi tạo theo backend
   * thực tế (`instanceof LocalEncryptor`) và cập nhật lại khi
   * `rotateKey` đổi backend — để UI/người dùng hỏi được trạng thái này
   * qua `isLocalFallback()` thay vì phải đoán từ log.
   */
  private localFallback: boolean;

  constructor(options: VaultOptions) {
    if (!options.storePath) throw new Error('Vault needs a storePath.');
    this.storePath = options.storePath;
    this.noStorage = options.noStorage === true;
    if (options.encryptor) {
      this.encryptor = options.encryptor;
      this.keyFilePath = null;
    } else {
      this.keyFilePath = options.keyFilePath ?? `${options.storePath}.key`;
      this.encryptor = new LocalEncryptor(loadOrCreateMachineKey(this.keyFilePath));
    }
    this.localFallback = this.encryptor instanceof LocalEncryptor;
    this.maxEntries = options.maxEntries ?? DEFAULT_VAULT_MAX_ENTRIES;
    if (!(this.maxEntries >= 1)) {
      throw new Error('Vault maxEntries must be at least 1.');
    }
    if (this.localFallback) {
      // Cảnh báo MỘT lần mỗi lần Vault khởi tạo ở chế độ fallback —
      // người dùng phải BIẾT secret không nằm trong OS keychain.
      // Không đổi hành vi mã hoá/giải mã: chỉ thêm cảnh báo.
      process.stderr.write(
        '[open-bot] Cảnh báo: Vault đang dùng LocalEncryptor — key file nằm cùng thư mục store, ' +
          'kém an toàn hơn safeStorage của OS. Hãy cài đặt keychain/libsecret để dùng OS keychain.\n',
      );
    }
    const loaded = this.loadStore();
    this.secrets = loaded.secrets;
    this.entryMeta = loaded.meta;
    // v0.15 (L5 audit): Vault khởi động đã ở NO_STORAGE thì baseline
    // là state vừa đọc từ đĩa — secret thêm sau đó mới là "tạm".
    this.noStorageBaseline = this.noStorage ? { ...this.secrets } : null;
    this.noStorageBaselineMeta = this.noStorage ? { ...this.entryMeta } : null;
    // v0.15 (M7 audit): phục hồi sau rotateKey bị crash giữa chừng — xem
    // repairKeyAfterCrash(): thử giải mã một entry, key hiện tại không
    // được thì thử key `.new` / `.bak` còn sót lại rồi tự sửa key file.
    this.repairKeyAfterCrash();
  }

  /**
   * v0.15 (M7 audit): rotateKey ghi 2 file (key + store) nên crash giữa
   * chừng có thể để lại store mới + key cũ (hoặc ngược lại) — trước đây
   * là mất toàn bộ secret. Hàm này chạy lúc mở Vault: thử giải mã một
   * entry bằng key hiện tại; không được thì thử key `.new` (rotate xong
   * store nhưng chưa kịp rename key) rồi key `.bak` (rotate chưa xong);
   * key nào mở được thì nhận làm key chính và ghi lại key file cho đúng.
   * Store rỗng thì không có gì để kiểm tra. Không bao giờ tạo key mới
   * ở đây — key sai thì ném lỗi rõ ràng thay vì lặng lẽ hỏng sau này.
   */
  private repairKeyAfterCrash(): void {
    if (!this.keyFilePath) return;
    const entries = Object.entries(this.secrets);
    if (entries.length === 0) return;
    const [, firstStored] = entries[0]!;
    const tryDecrypt = (encryptor: Encryptor): boolean => {
      try {
        encryptor.decrypt(Buffer.from(firstStored!, 'base64'));
        return true;
      } catch {
        return false;
      }
    };
    if (tryDecrypt(this.encryptor)) {
      // Key hiện tại đọc được store — `.new`/`.bak` còn sót (vd crash
      // trước khi ghi store, hoặc rotate trong lúc NO_STORAGE bật rồi
      // crash trước khi flush) là key không dùng tới: dọn để lần sau
      // không nhầm với key của một lần rotate khác. An toàn vì store
      // chỉ có một key đúng tại một thời điểm — key hiện tại đã đọc
      // được thì `.new` không còn cần cho store này nữa.
      for (const suffix of ['.new', '.bak']) {
        try {
          fs.rmSync(`${this.keyFilePath}${suffix}`);
        } catch {
          // Không xoá được file tạm cũng không sao.
        }
      }
      return;
    }
    for (const suffix of ['.new', '.bak']) {
      const candidatePath = `${this.keyFilePath}${suffix}`;
      let key: Buffer;
      try {
        key = fs.readFileSync(candidatePath);
        if (key.length < 32) continue;
      } catch {
        continue;
      }
      const candidate = new LocalEncryptor(key);
      if (!tryDecrypt(candidate)) continue;
      // Key này mở được store — nhận làm key chính và sửa key file.
      this.encryptor = candidate;
      fs.writeFileSync(this.keyFilePath, key, { mode: 0o600 });
      try {
        fs.rmSync(candidatePath);
      } catch {
        // Không xoá được file tạm cũng không sao.
      }
      return;
    }
    // Không key nào mở được (vd key file sai hoàn toàn, không phải do
    // crash): giữ nguyên hành vi cũ — constructor vẫn mở, getSecret sẽ
    // throw "Failed to decrypt" khi đọc. Không ném ở đây để không phá
    // contract hiện có.
    return;
  }

  /** Path of the JSON store file. */
  get path(): string {
    return this.storePath;
  }

  /**
   * v0.5: whether NO_STORAGE mode is currently on. While on, secrets
   * live in memory only and the store file is never written.
   */
  isNoStorage(): boolean {
    return this.noStorage;
  }

  /**
   * v0.15 (M6 audit): true khi Vault đang dùng LocalEncryptor fallback
   * (key file nằm cùng thư mục store) thay vì safeStorage của OS.
   * False khi backend là safeStorage (hoặc bất kỳ encryptor nào khác
   * không phải LocalEncryptor). UI dùng hàm này để hiện banner cảnh báo.
   */
  isLocalFallback(): boolean {
    return this.localFallback;
  }

  /**
   * v0.15 (L5 audit): số secret "tạm" — tức secret sẽ bị flush xuống
   * đĩa nếu tắt NO_STORAGE ngay lúc này. Đếm các entry khác với
   * baseline lúc bật NO_STORAGE: thêm mới, bị xoá, hoặc bị ghi đè
   * (mỗi entry tính 1 lần). Trả 0 khi NO_STORAGE đang tắt. Khi
   * baseline không có thì trả về số secret hiện có trong bộ nhớ — con
   * số thận trọng (upper bound) để UI vẫn hỏi xác nhận thay vì lặng
   * lẽ flush.
   *
   * v0.17 (W12d): so sánh theo PLAINTEXT đã giải mã, không so sánh
   * ciphertext nữa — mỗi lần mã hoá sinh salt/IV ngẫu nhiên nên sau
   * `rotateKey` (baseline và secret đều mã hoá lại bằng key mới)
   * ciphertext luôn khác nhau dù giá trị không đổi; so sánh ciphertext
   * sẽ đếm nhầm toàn bộ secret cũ thành "tạm". Entry nào giải mã lỗi
   * thì tính là khác (thận trọng). Ghi đè cùng giá trị cũ giờ không
   * còn tính là tạm — đúng nghĩa "secret sẽ thay đổi trên đĩa".
   *
   * v0.24 (W17a): so sánh theo SHA-256 của plaintext qua cache
   * `plainHashByCiphertext` (xem ghi chú ở field) thay vì giải mã lại
   * mỗi lần đếm. Hành vi đếm GIỮ NGUYÊN so với v0.17: thêm mới / bị
   * xoá / ghi đè khác giá trị → 1; ghi đè đúng giá trị cũ, xoá rồi
   * thêm lại đúng giá trị cũ → 0; giải mã lỗi → 1 (thận trọng);
   * `rotateKey` trong NO_STORAGE không làm đổi số đếm (hash của
   * plaintext không đổi khi mã hoá lại — cache được nạp lại trong
   * `rotateKey` nên đếm sau rotate cũng không giải mã). Chi phí: lần
   * đếm đầu sau một loạt thay đổi chỉ giải mã các entry khác baseline
   * mà chưa có trong cache (mỗi entry tối đa 1 lần); đếm lại khi
   * không đổi thì 0 lần giải mã, chỉ còn so sánh chuỗi hash O(n).
   * Giới hạn: cache tối đa 1024 ciphertext (FIFO) — vault trên 1024
   * entry thay đổi liên tục có thể phải giải mã lại entry đã bị đuổi
   * khỏi cache ở lần đếm sau (vẫn đúng, chỉ chậm hơn); hash SHA-256
   * va chạm thực tế không xảy ra.
   */
  countNoStoragePendingSecrets(): number {
    if (!this.noStorage) return 0;
    if (this.noStorageBaseline === null) return Object.keys(this.secrets).length;
    const baseline = this.noStorageBaseline;
    let count = 0;
    const composites = new Set([...Object.keys(this.secrets), ...Object.keys(baseline)]);
    for (const composite of composites) {
      const current = this.secrets[composite];
      const base = baseline[composite];
      if (current === undefined || base === undefined) {
        count += 1; // thêm mới hoặc bị xoá trong lúc NO_STORAGE bật
        continue;
      }
      if (current === base) continue; // ciphertext giống hệt => plaintext giống
      const currentHash = this.plainHashOf(current);
      const baseHash = this.plainHashOf(base);
      if (currentHash === null || baseHash === null) {
        count += 1; // không giải được thì tính là khác (thận trọng)
      } else if (currentHash !== baseHash) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * v0.24 (W17a): SHA-256 (hex) của một plaintext. Chỉ là hàm băm —
   * không đảo ngược được, không dùng làm khoá mã hoá.
   */
  private static hashPlaintext(plain: Buffer): string {
    return createHash('sha256').update(plain).digest('hex');
  }

  /**
   * v0.24 (W17a): ghi hash của một plaintext vừa có sẵn trong tay vào
   * cache theo ciphertext của nó (dùng trong `setSecret`, `rotateKey`,
   * `reencryptDiskStoreForDiscard` — những chỗ plaintext đã nằm trong
   * tay nên không tốn thêm lần giải mã nào). FIFO: cache đầy thì xoá
   * entry cũ nhất.
   */
  private rememberPlainHash(ciphertextB64: string, plain: Buffer): void {
    if (this.plainHashByCiphertext.size >= Vault.MAX_PLAIN_HASH_CACHE) {
      const oldest = this.plainHashByCiphertext.keys().next().value;
      if (oldest !== undefined) this.plainHashByCiphertext.delete(oldest);
    }
    this.plainHashByCiphertext.set(ciphertextB64, Vault.hashPlaintext(plain));
  }

  /**
   * v0.24 (W17a): hash SHA-256 của plaintext ứng với một ciphertext,
   * lấy từ cache nếu có; chưa có thì giải mã MỘT lần rồi cache lại.
   * Trả `null` khi giải mã lỗi (và cache `null` đó để lần sau khỏi
   * tốn scrypt thử lại — xem ghi chú ở field `plainHashByCiphertext`).
   */
  private plainHashOf(storedB64: string): string | null {
    const cached = this.plainHashByCiphertext.get(storedB64);
    if (cached !== undefined) return cached;
    let hash: string | null;
    try {
      hash = Vault.hashPlaintext(this.encryptor.decrypt(Buffer.from(storedB64, 'base64')));
    } catch {
      hash = null;
    }
    if (this.plainHashByCiphertext.size >= Vault.MAX_PLAIN_HASH_CACHE) {
      const oldest = this.plainHashByCiphertext.keys().next().value;
      if (oldest !== undefined) this.plainHashByCiphertext.delete(oldest);
    }
    this.plainHashByCiphertext.set(storedB64, hash);
    return hash;
  }

  /**
   * v0.5: turn NO_STORAGE mode on or off.
   *
   * - `setNoStorage(true)`: later `setSecret`/`deleteSecret` calls
   *   only touch the in-memory copy; the store file is left exactly
   *   as it was. Secrets set while on are still readable with
   *   `getSecret` until the process exits.
   * - `setNoStorage(false)`: the in-memory state (including secrets
   *   set while NO_STORAGE was on) is flushed durably to the store
   *   file immediately, so nothing is lost by turning the mode off.
   *
   * v0.15 (L5 audit): `setNoStorage(false, { discardTemporarySecrets: true })`
   * XOÁ các secret tạm thay vì flush chúng xuống đĩa — chỉ áp cho
   * secret thêm/sửa/xoá trong lúc NO_STORAGE bật:
   *   - Secret thêm mới trong lúc bật: biến mất khỏi bộ nhớ và không
   *     có trên đĩa.
   *   - Secret bị xoá/ghi đè trong lúc bật: được KHÔI PHỤC về giá trị
   *     đã có trên đĩa trước khi bật (lấy từ baseline).
   *   - Secret cũ không đụng tới trong lúc bật: giữ nguyên.
   * Phương án dự phòng khi không phân biệt được (baseline null):
   * load lại từ đĩa rồi mã hoá lại bằng key hiện tại (xem
   * `reencryptDiskStoreForDiscard`) — KHÔNG ghi thẳng ciphertext
   * trên đĩa về lại đĩa khi key đã đổi, vì ciphertext đó có thể là
   * của key cũ và sẽ không giải được nữa. Nếu không key nào giải mã
   * được secret trên đĩa thì fail rõ ràng thay vì ghi dữ liệu hỏng.
   * Mặc định KHÔNG đổi: `setNoStorage(false)` không opts vẫn flush
   * như cũ (tương thích ngược).
   *
   * v0.17 (W12d): nếu một lần `rotateKey()` chạy trong lúc NO_STORAGE
   * bật để lại key mới đang chờ (`pendingRotatedKey`), lúc tắt phải
   * commit key file theo đúng thứ tự crash-safe: chuẩn bị `.bak`/`.new`
   * trước khi ghi store, rename `.new` → key file sau khi store đã
   * durable (xem `preparePendingKeyRotation` /
   * `commitPendingKeyRotation`). Lỗi ở bước chuẩn bị hoặc ghi store
   * thì NO_STORAGE giữ nguyên bật để thử lại; lỗi ở bước rename thì
   * store đã là key mới và `.new` còn đó nên lần mở sau tự phục hồi.
   *
   *
   * This is a process-lifetime setting, NOT persisted in the store
   * file: a fresh Vault starts in durable mode unless constructed
   * with `noStorage: true`. The UI toggle must therefore re-apply
   * the user's choice at startup (see docs/v05-worker3-integration.md).
   */
  setNoStorage(enabled: boolean, opts?: { discardTemporarySecrets?: boolean }): void {
    const next = enabled === true;
    if (next === this.noStorage) return;
    const discard = opts?.discardTemporarySecrets === true;
    if (next) {
      // Bật: chụp baseline = state trên đĩa ngay lúc này.
      this.noStorageBaseline = { ...this.secrets };
      this.noStorageBaselineMeta = { ...this.entryMeta };
      this.noStorage = true;
      return;
    }
    // Tắt: tính state cuối trong bộ nhớ TRƯỚC KHI đụng tới đĩa, để
    // lỗi ở bước sau còn quay lại được trạng thái cũ.
    let finalSecrets: Record<string, string>;
    let finalMeta: Record<string, VaultEntryMeta>;
    if (discard) {
      if (this.noStorageBaseline !== null) {
        // Khôi phục đúng state trên đĩa lúc bật NO_STORAGE; đĩa vốn
        // chưa bị động tới trong lúc bật nên saveStore chỉ ghi lại
        // cùng nội dung để giữ bất biến "đĩa == bộ nhớ".
        finalSecrets = { ...this.noStorageBaseline };
        finalMeta = { ...(this.noStorageBaselineMeta ?? {}) };
      } else {
        // Phương án dự phòng: baseline mất — load lại từ đĩa rồi mã
        // hoá lại bằng key hiện tại (không ghi thẳng ciphertext cũ).
        const restored = this.reencryptDiskStoreForDiscard();
        finalSecrets = restored.secrets;
        finalMeta = restored.meta;
      }
    } else {
      // Flush (mặc định): giữ nguyên state hiện tại trong bộ nhớ.
      finalSecrets = this.secrets;
      finalMeta = this.entryMeta;
    }
    // Chuẩn bị key file cho rotation đang chờ (nếu có) TRƯỚC KHI ghi
    // store — thứ tự crash-safe như rotateKey thường: `.bak`/`.new`
    // trước, store sau, rename key file cuối cùng. Lỗi ở đây thì chưa
    // đụng tới store/key file nên ném rõ ràng, NO_STORAGE vẫn bật.
    this.preparePendingKeyRotation();
    const prevSecrets = this.secrets;
    const prevBaseline = this.noStorageBaseline;
    const prevMeta = this.entryMeta;
    const prevBaselineMeta = this.noStorageBaselineMeta;
    this.secrets = finalSecrets;
    this.entryMeta = finalMeta;
    this.noStorage = false;
    this.noStorageBaseline = null;
    this.noStorageBaselineMeta = null;
    try {
      this.saveStore();
    } catch (err) {
      // Ghi store lỗi: quay lại trạng thái NO_STORAGE bật để thử lại
      // — store trên đĩa vẫn là state cũ (ghi atomic tmp+rename),
      // key file vẫn cũ, `.bak`/`.new` còn đó để repairKeyAfterCrash
      // phục hồi khi mở lại.
      this.noStorage = true;
      this.secrets = prevSecrets;
      this.entryMeta = prevMeta;
      this.noStorageBaseline = prevBaseline;
      this.noStorageBaselineMeta = prevBaselineMeta;
      throw new Error(
        `Vault: tắt NO_STORAGE thất bại khi ghi store xuống đĩa: ${(err as Error).message}. ` +
          'NO_STORAGE vẫn bật, secret trong bộ nhớ còn nguyên — hãy thử tắt lại sau.',
      );
    }
    // Store đã durable: commit key file của rotation đang chờ (nếu
    // có). Lỗi ở đây vẫn ném rõ ràng; store đã là key mới và `.new`
    // còn đó nên lần mở Vault sau tự phục hồi, lần ghi store sau sẽ
    // thử commit lại.
    this.commitPendingKeyRotation();
  }

  /**
   * v0.17 (W12d): phương án dự phòng cho discard khi baseline đã mất —
   * load secret trên đĩa rồi mã hoá lại bằng encryptor hiện tại. Đĩa
   * có thể còn ciphertext của key cũ (một lần rotate đang chờ commit:
   * key file trên đĩa vẫn là key cũ cho tới khi commit) nên thử giải
   * bằng key file trên đĩa trước, rồi mới thử encryptor hiện tại.
   * Ném lỗi rõ ràng khi không key nào giải mã được — không bao giờ
   * ghi lại ciphertext không đọc được lên đĩa.
   */
  private reencryptDiskStoreForDiscard(): {
    secrets: Record<string, string>;
    meta: Record<string, VaultEntryMeta>;
  } {
    const onDisk = this.loadStore();
    if (Object.keys(onDisk.secrets).length === 0) return { secrets: {}, meta: {} };
    const candidates: Encryptor[] = [];
    if (this.keyFilePath) {
      try {
        const diskKey = fs.readFileSync(this.keyFilePath);
        if (diskKey.length >= 32) candidates.push(new LocalEncryptor(diskKey));
      } catch {
        // Không đọc được key file trên đĩa — bỏ qua ứng viên này.
      }
    }
    candidates.push(this.encryptor);
    const out: Record<string, string> = {};
    for (const [composite, stored] of Object.entries(onDisk.secrets)) {
      const raw = Buffer.from(stored, 'base64');
      let plain: Buffer | null = null;
      for (const candidate of candidates) {
        try {
          plain = candidate.decrypt(raw);
          break;
        } catch {
          // Thử key khác.
        }
      }
      if (plain === null) {
        throw new Error(
          `Vault: không thể khôi phục secret trên đĩa '${composite}' khi discard ` +
            '— không key nào giải mã được (baseline đã mất). Từ chối ghi đĩa để khỏi làm hỏng vault.',
        );
      }
      const reencrypted = this.encryptor.encrypt(plain).toString('base64');
      // v0.24 (W17a): plaintext đang có sẵn — hash thẳng vào cache.
      this.rememberPlainHash(reencrypted, plain);
      out[composite] = reencrypted;
    }
    // v0.53: metadata trên đĩa (savedAtMs/maxAgeMs) đi kèm secret khi
    // khôi phục — không đặt lại tuổi của entry chỉ vì discard.
    return { secrets: out, meta: onDisk.meta };
  }

  /**
   * v0.17 (W12d): chuẩn bị commit key rotation đang chờ — backup key
   * cũ sang `.bak`, ghi key mới sang `.new`. Gọi TRƯỚC KHI ghi store
   * mới trong `setNoStorage(false)`. Ném lỗi rõ ràng khi không ghi
   * được — khi đó key file và store trên đĩa chưa bị đụng tới,
   * NO_STORAGE vẫn bật, có thể thử lại.
   */
  private preparePendingKeyRotation(): void {
    if (this.pendingRotatedKey === null || !this.keyFilePath) return;
    const keyPath = this.keyFilePath;
    let oldKey: Buffer | null = null;
    try {
      oldKey = fs.readFileSync(keyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `Vault: không thể đọc key cũ để backup trước khi commit key rotation đang chờ: ${(err as Error).message}. ` +
            'Key file và store trên đĩa chưa bị đụng tới; NO_STORAGE vẫn bật, hãy thử tắt lại sau.',
        );
      }
      // Key file chưa có (vault mới) — không có gì để backup.
    }
    if (oldKey !== null) {
      try {
        fs.writeFileSync(`${keyPath}.bak`, oldKey, { mode: 0o600 });
      } catch (err) {
        throw new Error(
          `Vault: không thể backup key cũ (${keyPath}.bak) trước khi commit key rotation đang chờ: ${(err as Error).message}. ` +
            'Key file và store trên đĩa chưa bị đụng tới; NO_STORAGE vẫn bật, hãy thử tắt lại sau.',
        );
      }
    }
    try {
      fs.writeFileSync(`${keyPath}.new`, this.pendingRotatedKey, { mode: 0o600 });
    } catch (err) {
      throw new Error(
        `Vault: không thể ghi key mới tạm (${keyPath}.new) để commit key rotation đang chờ: ${(err as Error).message}. ` +
          'Key file và store trên đĩa chưa bị đụng tới; NO_STORAGE vẫn bật, hãy thử tắt lại sau.',
      );
    }
  }

  /**
   * v0.17 (W12d): commit key rotation đang chờ SAU KHI store mới đã
   * ghi durable — rename `.new` → key file rồi xoá `.bak`. Chỉ rename
   * khi nội dung `.new` đúng là key đang chờ (tránh rename nhầm file
   * của một lần rotate khác). Ném lỗi rõ ràng khi rename thất bại —
   * store trên đĩa lúc này đã là ciphertext key mới, `.new` vẫn còn
   * nên lần mở Vault sau sẽ tự phục hồi qua `repairKeyAfterCrash`;
   * vault trong bộ nhớ vẫn đúng và lần ghi store sau sẽ thử commit
   * lại (xem `saveStore`).
   */
  private commitPendingKeyRotation(): void {
    if (this.pendingRotatedKey === null || !this.keyFilePath) return;
    const keyPath = this.keyFilePath;
    const stagedPath = `${keyPath}.new`;
    let staged: Buffer;
    try {
      staged = fs.readFileSync(stagedPath);
    } catch {
      throw new Error(
        `Vault: không tìm thấy key mới tạm (${stagedPath}) để commit key rotation đang chờ. ` +
          'Store trên đĩa đã ghi bằng key mới, key file vẫn là key cũ — lần mở Vault sau sẽ thử phục hồi, ' +
          'nếu không được thì cần khôi phục key mới thủ công. Vault trong bộ nhớ vẫn đọc được secret.',
      );
    }
    if (!staged.equals(this.pendingRotatedKey)) {
      // `.new` không phải key đang chờ (vd bị ghi đè từ bên ngoài):
      // không rename bừa — fail rõ ràng thay vì làm hỏng key file.
      throw new Error(
        `Vault: key mới tạm (${stagedPath}) không khớp với key rotation đang chờ — từ chối commit để khỏi làm hỏng key file. ` +
          'Store trên đĩa đã ghi bằng key mới; vault trong bộ nhớ vẫn đọc được secret.',
      );
    }
    try {
      fs.renameSync(stagedPath, keyPath);
    } catch (err) {
      throw new Error(
        `Vault: không thể rename key mới (${stagedPath} → ${keyPath}) để commit key rotation đang chờ: ${(err as Error).message}. ` +
          'Store trên đĩa đã ghi bằng key mới, `.new` vẫn còn nên lần mở Vault sau sẽ tự phục hồi.',
      );
    }
    this.pendingRotatedKey = null;
    try {
      fs.rmSync(`${keyPath}.bak`);
    } catch {
      // Không xoá được backup cũng không sao.
    }
  }

  // --- CRUD ---------------------------------------------------------------

  /**
   * v0.53 (P1-6): true when a disk entry is past its `maxAgeMs`.
   * Entries without metadata (pre-v0.53 stores) never expire here —
   * they get `savedAtMs` = file mtime at load and no `maxAgeMs`.
   */
  private isExpired(composite: string, nowMs: number = Date.now()): boolean {
    const meta = this.entryMeta[composite];
    if (!meta || meta.maxAgeMs === undefined || !(meta.maxAgeMs > 0)) return false;
    return nowMs - meta.savedAtMs >= meta.maxAgeMs;
  }

  /**
   * Drop one expired disk entry from memory and persist the removal
   * (best-effort: a save failure here must not turn a read into a
   * throw — the entry is already gone from memory). Returns true
   * when something was purged.
   */
  private purgeExpiredEntry(composite: string): boolean {
    if (!(composite in this.secrets)) return false;
    delete this.secrets[composite];
    delete this.entryMeta[composite];
    try {
      this.saveStore();
    } catch {
      // Đọc đã trả null; ghi dọn dẹp thất bại thì lần đọc sau sẽ
      // dọn lại — không ném từ đường đọc.
    }
    return true;
  }

  /**
   * Remove every expired disk entry. Returns how many were purged.
   * Callers that rotate / export the vault can call this first so
   * dead entries do not linger on disk.
   */
  purgeExpired(nowMs: number = Date.now()): number {
    let purged = 0;
    for (const composite of Object.keys(this.secrets)) {
      if (this.isExpired(composite, nowMs)) {
        delete this.secrets[composite];
        delete this.entryMeta[composite];
        purged += 1;
      }
    }
    if (purged > 0) this.saveStore();
    return purged;
  }

  /** Drop every session-only secret (e.g. on logout / account switch). */
  clearSessionSecrets(): void {
    this.sessionSecrets.clear();
  }

  /** Number of live session-only secrets. */
  countSessionSecrets(): number {
    return this.sessionSecrets.size;
  }

  /**
   * Store (or overwrite) a secret. The value is never logged.
   *
   * v0.53 (P1-6): `opts.saveToVault === false` keeps the secret
   * SESSION-ONLY (in-memory Map, never written to disk — Grok's
   * `saveToVault` opt-in); `opts.maxAgeMs` sets the entry lifetime
   * (expired entries are refused on read). A new disk entry past
   * `maxEntries` throws `VaultRefusalError` (`vault_full`); use
   * `trySetSecret` when a structured refusal is preferred over a
   * throw. Overwriting an existing entry never counts towards the cap.
   */
  setSecret(namespace: string, key: string, value: string, opts?: SetSecretOptions): void {
    const result = this.trySetSecret(namespace, key, value, opts);
    if (!result.ok) throw new VaultRefusalError(result.refusal);
  }

  /**
   * Same as `setSecret`, but returns a structured refusal instead of
   * throwing (Grok `GrokBotVaultCreateRefusal` shape):
   * `{ok: true}` or `{ok: false, refusal: {kind, message}}` with
   * kind `'vault_full'` (entry cap hit) or `'refused'` (invalid
   * name/value). A validation refusal never writes anything.
   */
  trySetSecret(
    namespace: string,
    key: string,
    value: string,
    opts?: SetSecretOptions,
  ): { ok: true } | { ok: false; refusal: VaultRefusal } {
    try {
      assertName(namespace, 'namespace');
      assertName(key, 'key');
    } catch (err) {
      return { ok: false, refusal: { kind: 'refused', message: (err as Error).message } };
    }
    if (typeof value !== 'string') {
      return { ok: false, refusal: { kind: 'refused', message: 'Vault secret value must be a string.' } };
    }
    if (opts?.maxAgeMs !== undefined && !(opts.maxAgeMs > 0)) {
      return { ok: false, refusal: { kind: 'refused', message: 'Vault maxAgeMs must be a positive number of milliseconds.' } };
    }
    const composite = `${namespace}:${key}`;
    if (opts?.saveToVault === false) {
      // Session-only: never touches the disk store (or its cap).
      this.sessionSecrets.set(composite, value, {
        ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      });
      return { ok: true };
    }
    const isNew = !(composite in this.secrets);
    if (isNew && Object.keys(this.secrets).length >= this.maxEntries) {
      return {
        ok: false,
        refusal: {
          kind: 'vault_full',
          message: `Vault is full (${this.maxEntries} entries) — delete an old secret before adding a new one.`,
        },
      };
    }
    const plain = Buffer.from(value, 'utf8');
    const ciphertext = this.encryptor.encrypt(plain);
    const stored = ciphertext.toString('base64');
    this.secrets[composite] = stored;
    this.entryMeta[composite] = {
      savedAtMs: Date.now(),
      ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
    };
    // v0.24 (W17a): plaintext đang có sẵn — hash thẳng vào cache để
    // countNoStoragePendingSecrets() sau này khỏi phải giải mã lại.
    this.rememberPlainHash(stored, plain);
    this.saveStore();
    return { ok: true };
  }

  /**
   * Returns null when the secret was never set OR has expired.
   * Throws on wrong key / tampered data. Session-only values shadow
   * disk values of the same key; expired disk entries are purged.
   */
  getSecret(namespace: string, key: string): string | null {
    assertName(namespace, 'namespace');
    assertName(key, 'key');
    const composite = `${namespace}:${key}`;
    const sessionValue = this.sessionSecrets.get(composite);
    if (sessionValue !== null) return sessionValue;
    const stored = this.secrets[composite];
    if (stored === undefined) return null;
    if (this.isExpired(composite)) {
      this.purgeExpiredEntry(composite);
      return null;
    }
    const plaintext = this.encryptor.decrypt(Buffer.from(stored, 'base64'));
    return plaintext.toString('utf8');
  }

  /** Returns true when a secret was removed, false when it did not exist. */
  deleteSecret(namespace: string, key: string): boolean {
    assertName(namespace, 'namespace');
    assertName(key, 'key');
    const composite = `${namespace}:${key}`;
    const hadSession = this.sessionSecrets.delete(composite);
    if (!(composite in this.secrets)) return hadSession;
    delete this.secrets[composite];
    delete this.entryMeta[composite];
    this.saveStore();
    return true;
  }

  /**
   * Key names in a namespace (values are NEVER returned by listing).
   * Includes live session-only keys; expired disk entries are left out.
   */
  listSecrets(namespace: string): string[] {
    assertName(namespace, 'namespace');
    const prefix = `${namespace}:`;
    const out = new Set<string>();
    for (const composite of Object.keys(this.secrets)) {
      if (composite.startsWith(prefix) && !this.isExpired(composite)) {
        out.add(composite.slice(prefix.length));
      }
    }
    for (const composite of this.sessionSecrets.list()) {
      if (composite.startsWith(prefix)) out.add(composite.slice(prefix.length));
    }
    return [...out].sort();
  }

  /** All namespaces that currently hold at least one secret. */
  listNamespaces(): string[] {
    const namespaces = new Set<string>();
    for (const composite of Object.keys(this.secrets)) {
      namespaces.add(composite.split(':')[0]);
    }
    return [...namespaces].sort();
  }

  /** True when a live (non-expired) secret exists — disk or session-only. */
  hasSecret(namespace: string, key: string): boolean {
    assertName(namespace, 'namespace');
    assertName(key, 'key');
    const composite = `${namespace}:${key}`;
    if (this.sessionSecrets.has(composite)) return true;
    if (!(composite in this.secrets)) return false;
    return !this.isExpired(composite);
  }

  // --- Key rotation ---------------------------------------------------------

  /**
   * Re-encrypt every stored secret under a new encryptor.
   *
   * - No argument: only valid when this vault uses the default
   *   `LocalEncryptor` — a fresh machine key is generated, the key
   *   file is replaced, and all entries are re-encrypted under it.
   *   The OLD key file can no longer read the store afterwards.
   * - With an argument: re-encrypt under the given encryptor
   *   (e.g. migrating from LocalEncryptor to safeStorage). The caller
   *   keeps ownership of the old key file / backend.
   *
   * Nothing is written until every entry has decrypted successfully,
   * so a failed rotation leaves the store untouched.
   *
   * v0.17 (W12d): rotate trong lúc NO_STORAGE bật:
   * - Secret tạm trong bộ nhớ được mã hoá lại bằng key mới (không
   *   mất) — `plaintexts` vốn đã lấy từ `this.secrets` trong bộ nhớ.
   * - `noStorageBaseline` cũng được mã hoá lại bằng key mới (không
   *   để null, không giữ ciphertext key cũ): giải mã baseline bằng
   *   key cũ TRƯỚC KHI đổi key, mã hoá lại cùng lúc với secret. Nhờ
   *   đó `setNoStorage(false, { discardTemporarySecrets: true })`
   *   sau rotate vẫn khôi phục đúng secret cũ.
   * - Key file trên đĩa KHÔNG đi qua `.bak` → `.new` → rename ngay
   *   lúc này: `saveStore()` là no-op khi NO_STORAGE bật nên store
   *   trên đĩa vẫn là ciphertext key cũ — rename key file ngay sẽ
   *   làm key mới không đọc được store cũ và `repairKeyAfterCrash`
   *   cũng không cứu được (`.bak` đã bị xoá). Thay vào đó key mới
   *   chỉ sống trong bộ nhớ (`pendingRotatedKey`) và được commit
   *   theo đúng thứ tự crash-safe khi `setNoStorage(false)` flush:
   *   `.bak`/`.new` trước, store mới sau, rename key file cuối cùng.
   *   Thoát process trước khi flush thì đĩa giữ nguyên state cũ.
   * - Rotate bằng encryptor ngoài trong lúc NO_STORAGE bật: không có
   *   key file để defer — chỉ mã hoá lại secret + baseline trong bộ
   *   nhớ; key file trên đĩa (nếu có) giữ nguyên như mọi lần rotate
   *   bằng encryptor ngoài khác.
   */
  rotateKey(newEncryptor?: Encryptor): void {
    const oldEncryptor = this.encryptor;
    const entries = Object.entries(this.secrets);
    const plaintexts = entries.map(([composite, stored]) => {
      const plain = oldEncryptor.decrypt(Buffer.from(stored, 'base64'));
      return [composite, plain] as const;
    });
    // Baseline cũng phải giải mã bằng key cũ TRƯỚC KHI đổi key — nếu
    // baseline giải mã lỗi thì fail ngay khi vault chưa bị đụng tới
    // (không mất secret tạm, không mất baseline).
    const baselinePlaintexts =
      this.noStorageBaseline !== null
        ? Object.entries(this.noStorageBaseline).map(([composite, stored]) => {
            const plain = oldEncryptor.decrypt(Buffer.from(stored, 'base64'));
            return [composite, plain] as const;
          })
        : null;

    // Mọi lần rotate mới đều thay thế rotation đang chờ cũ (nếu có):
    // key pending cũ chưa từng lên đĩa nên không còn giá trị — lần
    // rotate này sẽ đặt pending mới (NO_STORAGE) hoặc commit thẳng
    // theo quy trình thường (không NO_STORAGE).
    this.pendingRotatedKey = null;

    let next: Encryptor;
    let freshKey: Buffer | null = null;
    if (newEncryptor) {
      next = newEncryptor;
    } else {
      if (!this.keyFilePath) {
        throw new Error(
          'rotateKey() without an argument needs a LocalEncryptor vault; ' +
            'pass the new encryptor explicitly.',
        );
      }
      freshKey = randomBytes(32);
      next = new LocalEncryptor(freshKey);
      if (!this.noStorage) {
        // v0.15 (M7 audit): KHÔNG ghi key mới đè lên key file trước khi
        // store được ghi lại — crash ở giữa là mất toàn bộ secret. Thứ tự
        // an toàn: (1) backup key cũ sang `.bak`, (2) ghi key mới sang
        // `.new`, (3) ghi store đã mã hoá lại (atomic temp+rename trong
        // saveStore), (4) rename `.new` → key file, (5) xoá `.bak`. Crash
        // ở bất kỳ bước nào cũng để lại đủ key material để constructor tự
        // phục hồi qua repairKeyAfterCrash().
        const keyPath = this.keyFilePath;
        try {
          const oldKey = fs.readFileSync(keyPath);
          fs.writeFileSync(`${keyPath}.bak`, oldKey, { mode: 0o600 });
        } catch {
          // Key file chưa có (vault mới) — không có gì để backup.
        }
        fs.writeFileSync(`${keyPath}.new`, freshKey, { mode: 0o600 });
        // Ghi lại key file chỉ SAU KHI store đã ghi xong (xem cuối hàm).
      }
      // NO_STORAGE: KHÔNG ghi `.bak`/`.new` lúc này — key mới chỉ sống
      // trong bộ nhớ cho tới khi setNoStorage(false) flush (xem dưới).
    }

    const nextSecrets: Record<string, string> = {};
    for (const [composite, plain] of plaintexts) {
      nextSecrets[composite] = next.encrypt(plain).toString('base64');
    }
    let nextBaseline: Record<string, string> | null = null;
    if (baselinePlaintexts !== null) {
      nextBaseline = {};
      for (const [composite, plain] of baselinePlaintexts) {
        nextBaseline[composite] = next.encrypt(plain).toString('base64');
      }
    }
    // v0.24 (W17a): mọi ciphertext đều đổi sau rotate — cache hash cũ
    // (key theo ciphertext cũ) không còn dùng được nữa nên xoá và nạp
    // lại từ plaintext đang có sẵn trong tay (không tốn thêm lần giải
    // mã nào). Nhờ đó đếm sau rotate vẫn đúng (hash plaintext không
    // đổi) mà không phải giải mã lại toàn bộ vault.
    this.plainHashByCiphertext.clear();
    for (const [composite, plain] of plaintexts) {
      this.rememberPlainHash(nextSecrets[composite]!, plain);
    }
    if (baselinePlaintexts !== null && nextBaseline !== null) {
      for (const [composite, plain] of baselinePlaintexts) {
        this.rememberPlainHash(nextBaseline[composite]!, plain);
      }
    }
    // v0.15 (L4 audit): machine key đổi thì key đã derive theo salt
    // của key cũ không còn giá trị — xoá cache của encryptor cũ.
    // (Encryptor mới — vd LocalEncryptor mới — vốn đã có cache rỗng.)
    if (oldEncryptor instanceof LocalEncryptor) {
      oldEncryptor.clearDerivedKeyCache();
    }
    this.encryptor = next;
    // v0.15 (M6 audit): backend có thể đã đổi (vd migrate từ
    // LocalEncryptor sang safeStorage) — cập nhật trạng thái fallback.
    this.localFallback = next instanceof LocalEncryptor;
    this.secrets = nextSecrets;
    if (baselinePlaintexts !== null) {
      // Baseline được mã hoá lại bằng key mới — KHÔNG để null: discard
      // sau đó vẫn phân biệt được secret tạm / secret cũ.
      this.noStorageBaseline = nextBaseline;
    }
    if (freshKey !== null && this.noStorage) {
      // DEFER key file: đĩa vẫn là key cũ + store cũ (khớp nhau),
      // key mới chỉ sống trong bộ nhớ cho tới khi flush commit.
      this.pendingRotatedKey = freshKey;
    }
    this.saveStore();
    // Store đã durable mới đổi key file: rename `.new` → key file rồi
    // xoá `.bak`. (Khi rotate bằng encryptor ngoài thì không có key file
    // mới — không làm gì thêm. Khi NO_STORAGE bật thì saveStore là
    // no-op và key file được commit sau, lúc flush — xem trên.)
    //
    // v0.27: rename ở bước này KHÔNG được để lỗi thô (EPERM/EXDEV/…)
    // lọt ra ngoài và cũng KHÔNG được rollback state trong bộ nhớ:
    // store trên đĩa lúc này ĐÃ là ciphertext key mới — quay lại key
    // cũ trong bộ nhớ sẽ làm vault không đọc được chính store nó vừa
    // ghi (đó mới là trạng thái nửa vời thật sự). Ném lỗi rõ ràng
    // thay vào đó: vault trong bộ nhớ vẫn đúng (key mới + secret còn
    // nguyên), `.new`/`.bak` còn đó nên lần mở Vault sau tự phục hồi
    // qua repairKeyAfterCrash, và gọi lại rotateKey() cũng an toàn.
    if (!newEncryptor && this.keyFilePath && !this.noStorage) {
      const keyPath = this.keyFilePath;
      try {
        fs.renameSync(`${keyPath}.new`, keyPath);
      } catch (err) {
        throw new Error(
          `Vault: không thể rename key mới (${keyPath}.new → ${keyPath}) để hoàn tất rotateKey: ${(err as Error).message}. ` +
            'Store trên đĩa đã ghi bằng key mới, key mới vẫn còn ở `.new`, key file vẫn là key cũ — ' +
            'vault trong bộ nhớ vẫn đọc được secret, lần mở Vault sau sẽ tự phục hồi qua repairKeyAfterCrash; ' +
            'không xoá `.new`/`.bak` trước khi mở lại.',
        );
      }
      try {
        fs.rmSync(`${keyPath}.bak`);
      } catch {
        // Không xoá được backup cũng không sao.
      }
    }
  }

  // --- Persistence ----------------------------------------------------------

  private loadStore(): { secrets: Record<string, string>; meta: Record<string, VaultEntryMeta> } {
    // v0.53 (P1-6): the durable writer rotates `file` -> `file.1`
    // BEFORE the new content lands, so a crash in that window leaves
    // the live file missing but `file.1` intact — fall back to the
    // newest backup that parses (bounded copies, newest first).
    // A live file that EXISTS but is not valid JSON still throws
    // (pre-v0.53 behaviour — tmp+rename makes partial writes
    // impossible, so unreadable-live means real corruption). A
    // backup that fails to parse is skipped for the next older copy.
    for (let i = 0; i <= DEFAULT_DURABLE_COPIES; i += 1) {
      const candidate = i === 0 ? this.storePath : `${this.storePath}.${i}`;
      const isLive = i === 0;
      let raw: string;
      let mtimeMs: number;
      try {
        raw = fs.readFileSync(candidate, 'utf-8');
        mtimeMs = fs.statSync(candidate).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        continue; // Missing copy — try the next (older) backup.
      }
      const parsed = this.parseStoreText(raw, isLive);
      if (parsed === null) continue; // Bad backup — try the next one.
      return this.splitStoreFile(parsed, mtimeMs);
    }
    return { secrets: {}, meta: {} };
  }

  /**
   * v0.53: parse one store file's text. Returns null when the text
   * came from a BACKUP copy and does not parse / has a bad shape
   * (caller then tries the next older backup); throws when the text
   * came from the LIVE file (pre-v0.53 behaviour).
   */
  private parseStoreText(raw: string, isLive: boolean): VaultStoreFile | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (!isLive) return null;
      throw new Error(`Vault store is not valid JSON: ${this.storePath}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as VaultStoreFile).version !== 1 ||
      typeof (parsed as VaultStoreFile).secrets !== 'object' ||
      (parsed as VaultStoreFile).secrets === null
    ) {
      if (!isLive) return null;
      throw new Error(`Vault store has an unsupported shape: ${this.storePath}`);
    }
    return parsed as VaultStoreFile;
  }

  /**
   * v0.53: split a parsed store file into ciphertext + metadata.
   * Metadata is advisory: a malformed entry is ignored (the entry
   * then behaves like a pre-v0.53 entry — savedAtMs = file mtime,
   * no expiry) rather than failing the whole open.
   */
  private splitStoreFile(
    file: VaultStoreFile,
    mtimeMs: number,
  ): { secrets: Record<string, string>; meta: Record<string, VaultEntryMeta> } {
    const secrets = { ...file.secrets };
    const meta: Record<string, VaultEntryMeta> = {};
    for (const composite of Object.keys(secrets)) {
      const rawMeta = file.meta?.[composite];
      if (
        rawMeta &&
        typeof rawMeta === 'object' &&
        typeof rawMeta.savedAtMs === 'number' &&
        Number.isFinite(rawMeta.savedAtMs)
      ) {
        meta[composite] = {
          savedAtMs: rawMeta.savedAtMs,
          ...(typeof rawMeta.maxAgeMs === 'number' && rawMeta.maxAgeMs > 0
            ? { maxAgeMs: rawMeta.maxAgeMs }
            : {}),
        };
      } else {
        meta[composite] = { savedAtMs: mtimeMs };
      }
    }
    return { secrets, meta };
  }

  private saveStore(): void {
    // v0.5 NO_STORAGE: never touch the file while the mode is on.
    // In-memory state is flushed by setNoStorage(false).
    if (this.noStorage) return;
    const file: VaultStoreFile = {
      version: 1,
      secrets: this.secrets,
      // v0.53 (P1-6): metadata rides along in the same file so an
      // entry's age survives restarts; `secrets` keeps its old shape.
      meta: this.entryMeta,
    };
    // v0.53 (P1-6): durable write with bounded backup copies
    // (crash-safe rotation, tmp + fsync + rename — see durableFile.ts).
    // The old inline tmp+rename (v0.15, random suffix) is replaced by
    // this helper, which keeps the same guarantees plus backups.
    writeDurableFileSync(this.storePath, JSON.stringify(file, null, 2), { mode: 0o600 });
    // v0.17 (W12d): store vừa ghi durable bằng key mới của một rotation
    // đang chờ thì thử commit key file ngay (best-effort). Lỗi ở đây
    // KHÔNG ném — store đã ghi xong, secret trong bộ nhớ vẫn đúng;
    // chỉ cảnh báo và giữ pending để lần ghi sau / setNoStorage thử
    // lại (setNoStorage gọi commitPendingKeyRotation tường minh và
    // ném lỗi rõ ràng khi vẫn thất bại).
    if (this.pendingRotatedKey !== null && this.keyFilePath) {
      try {
        this.commitPendingKeyRotation();
      } catch (err) {
        process.stderr.write(
          `[open-bot] Vault: chưa commit được key rotation đang chờ: ${(err as Error).message}\n`,
        );
      }
    }
  }
}
