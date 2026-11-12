/**
 * Composio — key API của user trong Vault (v0.57).
 *
 * Key Composio là key MIỄN PHÍ của chính người dùng (lấy ở dashboard
 * Composio → Project Settings → API Keys), lưu như provider key khác:
 * Vault namespace 'provider', key 'composio' — tái dùng API Vault hiện
 * có, KHÔNG refactor vault, KHÔNG thêm namespace mới. Chỉ có key
 * PROJECT của user mới nằm đây; token OAuth của từng app (Gmail, Slack…)
 * nằm phía Composio (managed OAuth) và KHÔNG BAO GIỜ về máy này — xem
 * docs/composio-integration.md § rủi ro custody.
 *
 * Quy tắc an toàn của file này:
 *  - Không log key, không đưa key vào error message (router lọc lại
 *    một lần nữa trước khi ném).
 *  - `listSecrets('provider')` chỉ trả TÊN key, không trả giá trị —
 *    UI chỉ được hỏi "đã cấu hình chưa" (boolean), không được đọc key
 *    ra để hiển thị.
 *  - Key rỗng/khoảng trắng coi như chưa cấu hình.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Vault } from '../vault/vault';
import type { Vault as VaultType } from '../vault/vault';

/** Vault namespace chứa key Composio (chung với provider key khác). */
export const COMPOSIO_VAULT_NAMESPACE = 'provider';
/** Vault key chứa Composio API key của user. */
export const COMPOSIO_VAULT_KEY = 'composio';
/**
 * v0.88b: Vault key chứa Composio user id của user (cùng namespace
 * 'provider' với API key — đi chung một chỗ, cùng vòng đời backup/
 * xoá, main đọc được bằng safeStorage như key). User id KHÔNG phải
 * secret như API key (nó là định danh tài khoản Composio, hiển thị
 * trên dashboard), nhưng vẫn KHÔNG log, KHÔNG hiện nguyên văn ra UI
 * (UI chỉ báo đã cấu hình/chưa), và KHÔNG trả về qua RPC/IPC.
 */
export const COMPOSIO_VAULT_USER_ID_KEY = 'composio-user-id';

/**
 * v0.88b: validate + chuẩn hoá một Composio user id do user nhập.
 * Chấp nhận mọi định dạng Composio cấp (vd `pg-test-...`,
 * `default`, UUID) — chỉ chặn ký tự không thể là id: khoảng trắng
 * và ký tự điều khiển. Rỗng/chỉ khoảng trắng → lỗi rõ ràng (caller
 * muốn xoá thì dùng `clearComposioUserId`, không lưu chuỗi rỗng).
 * Dài quá 200 ký tự → lỗi (id thật ngắn hơn nhiều; chặn paste nhầm).
 */
export function validateComposioUserId(userId: unknown): string {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('Composio user id không được rỗng — dán user id trong dashboard Composio (xem docs/composio-integration.md §17).');
  }
  const id = userId.trim();
  if (id.length > 200) {
    throw new Error('Composio user id quá dài (tối đa 200 ký tự) — kiểm tra lại chuỗi đã dán.');
  }
  if (/[\s\x00-\x1f\x7f]/.test(id)) {
    throw new Error('Composio user id không được chứa khoảng trắng hay ký tự điều khiển.');
  }
  return id;
}

/** Chuẩn hoá user id: hợp lệ → chuỗi đã trim, rỗng/sai kiểu → null. Không ném. */
export function normalizeComposioUserId(userId: unknown): string | null {
  try {
    return validateComposioUserId(userId);
  } catch {
    return null;
  }
}

/** Đọc Composio user id từ Vault; null khi chưa cấu hình. Không log giá trị. */
export function getComposioUserId(vault: ComposioKeyVault): string | null {
  const raw = vault.getSecret(COMPOSIO_VAULT_NAMESPACE, COMPOSIO_VAULT_USER_ID_KEY);
  if (typeof raw !== 'string') return null;
  return normalizeComposioUserId(raw);
}

/** Đã cấu hình Composio user id chưa (chỉ boolean — không lộ giá trị). */
export function hasComposioUserId(vault: ComposioKeyVault): boolean {
  return getComposioUserId(vault) !== null;
}

/**
 * Lưu Composio user id vào Vault. Validate trước khi ghi (rỗng/
 * khoảng trắng/ký tự lạ → ném lỗi rõ, không ghi). KHÔNG log giá trị.
 */
export function setComposioUserId(vault: ComposioKeyVault, userId: string): void {
  const id = validateComposioUserId(userId);
  vault.setSecret(COMPOSIO_VAULT_NAMESPACE, COMPOSIO_VAULT_USER_ID_KEY, id);
}

/** Xoá Composio user id khỏi Vault. Trả true khi trước đó có user id. */
export function clearComposioUserId(vault: ComposioKeyVault): boolean {
  return vault.deleteSecret(COMPOSIO_VAULT_NAMESPACE, COMPOSIO_VAULT_USER_ID_KEY);
}

/** Tối thiểu API Vault mà key store này cần (Vault thật khớp shape này). */
export interface ComposioKeyVault {
  getSecret(namespace: string, key: string): string | null;
  setSecret(namespace: string, key: string, value: string): void;
  deleteSecret(namespace: string, key: string): boolean;
}

/** Ép kiểu Vault thật về interface tối thiểu (chỉ để test dễ tiêm fake). */
export function asComposioKeyVault(vault: VaultType): ComposioKeyVault {
  return vault;
}

/** Đọc Composio API key từ Vault; null khi chưa cấu hình. */
export function getComposioApiKey(vault: ComposioKeyVault): string | null {
  const raw = vault.getSecret(COMPOSIO_VAULT_NAMESPACE, COMPOSIO_VAULT_KEY);
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key ? key : null;
}

/** Đã cấu hình Composio API key chưa (chỉ boolean — không lộ key). */
export function hasComposioApiKey(vault: ComposioKeyVault): boolean {
  return getComposioApiKey(vault) !== null;
}

/**
 * Lưu Composio API key vào Vault. Key rỗng/khoảng trắng thì ném lỗi
 * (không ghi giá trị rỗng vào Vault). KHÔNG log key.
 */
export function setComposioApiKey(vault: ComposioKeyVault, apiKey: string): void {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Composio API key không được rỗng.');
  }
  vault.setSecret(COMPOSIO_VAULT_NAMESPACE, COMPOSIO_VAULT_KEY, apiKey.trim());
}

/** Xoá Composio API key khỏi Vault. Trả true khi trước đó có key. */
export function clearComposioApiKey(vault: ComposioKeyVault): boolean {
  return vault.deleteSecret(COMPOSIO_VAULT_NAMESPACE, COMPOSIO_VAULT_KEY);
}

/**
 * Lọc key khỏi một message trước khi log/ném lỗi: thay mọi lần xuất
 * hiện của key bằng '[composio-key-redacted]'. Không có key thì trả
 * message nguyên vẹn. Dùng cho mọi error đi ra khỏi lớp Composio.
 */
export function redactComposioKey(message: string, apiKey?: string | null): string {
  if (!message || !apiKey) return message;
  return message.split(apiKey).join('[composio-key-redacted]');
}

/**
 * Reader key Composio ĐÃ SEED trong bộ nhớ (v0.59 — phương án thay thế
 * §11 docs/composio-integration.md, theo đúng mẫu token đã có trong
 * coordinator: `connectorTokenSets`, `mcpOAuthTokens`, `xBearer`,
 * `githubToken` — main đọc được Vault bằng safeStorage trong main
 * process rồi seed bản sao qua RPC, con giữ trong bộ nhớ và KHÔNG BAO
 * GIỜ chạm file Vault).
 *
 * Ưu tiên: key đã seed (trong bộ nhớ) thắng fallback (đọc file Vault
 * của main). Chưa seed / đã clear seed thì dùng fallback như cũ —
 * `createComposioVaultFileKeyReader` giữ nguyên làm fallback khi không
 * có key được seed. Key KHÔNG vào log, không vào error message.
 *
 * `seed(key)`:
 *  - key là chuỗi không rỗng → ghi đè key đã seed (xoay key: lần seed
 *    sau thắng lần trước, không cần destroyBot).
 *  - key null / undefined / rỗng / chỉ khoảng trắng → xoá key đã seed
 *    (về lại fallback; main gọi khi user xoá key trong Vault).
 * Trả true khi sau lần gọi có key đã seed (false = đã clear / chưa seed).
 */
export interface ComposioSeededKeyReader {
  (): string | null;
  seed(apiKey: string | null | undefined): boolean;
  hasSeededKey(): boolean;
  clearSeed(): void;
}

export function createComposioSeededKeyReader(
  fallback: () => string | null,
): ComposioSeededKeyReader {
  let seeded: string | null = null;
  const reader = (() => {
    if (seeded !== null) return seeded;
    try {
      return fallback();
    } catch {
      return null;
    }
  }) as ComposioSeededKeyReader;
  reader.seed = (apiKey: string | null | undefined): boolean => {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    seeded = key ? key : null;
    return seeded !== null;
  };
  reader.hasSeededKey = (): boolean => seeded !== null;
  reader.clearSeed = (): void => {
    seeded = null;
  };
  return reader;
}

/**
 * Đọc Composio API key TRỰC TIẾP từ file Vault của main process
 * (v0.58 — đường key cho tiến trình coordinator con).
 *
 * Từ v0.59 hàm này chỉ còn là FALLBACK khi không có key được seed
 * (xem `createComposioSeededKeyReader` ở trên — main seed key qua RPC
 * `composio.setApiKey` / param `composioApiKey` của `createBot`, làm
 * việc với mọi backend Vault kể cả safeStorage + NO_STORAGE).
 *
 * Cách dùng: coordinator con (không có Electron, không cầm Vault của
 * main) mở lại cùng file `<dataDir>/vault.json` mà main dùng — dataDir
 * là userData mà coordinator đã biết qua `CoordinatorOptions.dataDir` /
 * env `OPENBOT_DATA_DIR`. Chỉ ĐỌC, không bao giờ ghi/xoá (không
 * `setSecret`/`deleteSecret` từ tiến trình con — key chỉ main quản lý).
 *
 * Giới hạn — đọc kỹ trước khi trông cậy vào hàm này (xem thêm
 * docs/composio-integration.md §11):
 *  - CHỈ mở được khi Vault của main dùng LocalEncryptor fallback (key
 *    file `vault.json.key` nằm cùng thư mục). Khi main dùng Electron
 *    `safeStorage` (OS keychain/DPAPI — mặc định khi có keychain),
 *    tiến trình Node thường không có `safeStorage.decryptString` nên
 *    `getSecret` ném lỗi giải mã → hàm này trả null (fail-closed).
 *  - Key thêm vào Vault khi main bật NO_STORAGE chỉ sống trong bộ nhớ
 *    của main, không xuống đĩa → hàm này không thấy (trả null).
 *  - Vault chỉ đọc file lúc mở (constructor load một lần): hàm này
 *    theo dõi `mtimeMs` của `vault.json` và mở lại Vault mới khi file
 *    đổi, nên key mới/xoay trong main được thấy ở lần đọc sau — nhưng
 *    hai tiến trình vẫn có thể lệch nhau trong khoảnh khắc giữa lần
 *    ghi của main và lần đọc tiếp theo của coordinator.
 *  - Mọi lỗi (không có dataDir, không có file, JSON hỏng, giải mã
 *    thất bại) đều trả null — không ném, không crash turn, không lộ
 *    key. Lỗi giải mã không phân biệt được "chưa có key" và "không mở
 *    được Vault": caller báo chung là "chưa cấu hình / không đọc được".
 *  - `new Vault()` ở chế độ LocalEncryptor ghi MỘT dòng cảnh báo ra
 *    stderr mỗi lần mở lại (khi file đổi) — ồn nhưng vô hại.
 *
 * Phương án thay thế khi đường này không đủ (cần worker main làm,
 * KHÔNG tự làm ở đây): main seed key cho coordinator lúc createBot /
 * qua RPC riêng, theo đúng mẫu token đã có (`connectorTokenSets`,
 * `mcpOAuthTokens`, `xBearer` — main truyền bản sao trong bộ nhớ,
 * con không bao giờ chạm file Vault). Xem docs §11.
 *
 * v0.59 — ĐÃ LÀM: `createComposioSeededKeyReader` ở trên + RPC
 * `composio.setApiKey` / `composio.getKeyStatus` + param `composioApiKey`
 * của `createBot` (coordinator) + main seed ở `getOrCreateRuntime` /
 * `syncComposioToCoordinator` / IPC `composio:set-key` /
 * `composio:clear-key` (apps/desktop/src/main/main.ts). Hàm này giờ
 * chỉ là fallback khi không có key được seed.
 */
export function createComposioVaultFileKeyReader(
  dataDir?: string | null,
): () => string | null {
  if (!dataDir || typeof dataDir !== 'string' || !dataDir.trim()) {
    return () => null;
  }
  const storePath = path.join(dataDir, 'vault.json');
  let cached: { mtimeMs: number; vault: Vault | null } | null = null;
  return () => {
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(storePath).mtimeMs;
    } catch {
      // Không có file Vault (chưa lưu secret nào) → chưa có key.
      cached = null;
      return null;
    }
    if (!cached || cached.mtimeMs !== mtimeMs) {
      let vault: Vault | null = null;
      try {
        vault = new Vault({ storePath });
      } catch {
        // File hỏng / không mở được → coi như chưa có key (fail-closed).
        vault = null;
      }
      cached = { mtimeMs, vault };
    }
    if (!cached.vault) return null;
    try {
      return getComposioApiKey(cached.vault);
    } catch {
      // Giải mã thất bại (vd Vault của main dùng safeStorage của OS
      // mà tiến trình này không mở được) → chưa đọc được key.
      return null;
    }
  };
}
