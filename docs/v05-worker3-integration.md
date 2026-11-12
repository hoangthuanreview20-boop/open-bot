# v0.5 worker 3 — Bản đặc tả tích hợp: Team workspace + Service account + Cứng hoá xác thực

> **Trạng thái:** phần core đã xong và đã test (worker 3). Tài liệu này là
> hướng dẫn để **điều phối viên** (người duy nhất được sửa `main.ts`,
> `preload.ts`, `index.ts`, `TeamView`, `SettingsView`) nối core vào app.
> **Không sửa core để khớp UI — UI đã viết trước theo đúng channel dưới
> đây; main phải khớp đúng chữ ký renderer đang gọi.**
>
> Core đã làm xong (không commit, không push):
> - `packages/core/src/team/types.ts` — `teamId?`, `workspaceDir?`,
>   `serviceAccounts?`, `ServiceAccount`, `ServiceAccountScope`,
>   `SERVICE_ACCOUNT_SCOPES`.
> - `packages/core/src/team/team.ts` — `ensureTeamId`, `getTeamId`,
>   `setWorkspaceDir`, `listServiceAccounts`, `createServiceAccount`,
>   `revokeServiceAccount`, `serviceAccountVaultKey`,
>   `SERVICE_ACCOUNT_VAULT_NAMESPACE`; `validateTeamConfig` tự sinh
>   `teamId` cho file cũ, `loadTeamConfig` ghi lại id đó ngay lần đầu.
> - `packages/core/src/vault/vault.ts` — `VaultOptions.noStorage`,
>   `isNoStorage()`, `setNoStorage(enabled)` (tắt → flush xuống file).
> - `packages/core/src/util/{machine,redact,index}.ts` — mới:
>   `getOrCreateMachineId(dir)`, `redactSecrets`, `redactBearer`, `REDACTED`.
> - Test: `tests/team-v05.test.mjs` — **9/9 pass** (xem §7).

---

## 0. Những gì renderer ĐÃ gọi (đừng đổi chữ ký — main phải khớp)

Một worker khác đã viết sẵn `TeamView.tsx`, `SettingsView.tsx`,
`global.d.ts`, `renderer/types.ts` và locale vi/en theo đúng các channel
dưới đây. Bảng này là **sự thật đã đo từ code renderer hiện tại**
(đọc ngày 2026-11-08), không phải đề xuất mới:

| IPC channel | Renderer gọi với | Main phải trả về |
|---|---|---|
| `team:get-workspace` | `()` | `{ dir: string; teamId: string }` (`dir` = `''` khi chưa đặt) |
| `team:set-workspace-dir` | `(dir: string)` — **chuỗi trần, KHÔNG phải `{ dir }`** | `{ dir: string; teamId: string }` |
| `team:service-accounts-list` | `()` | `ServiceAccountView[]` (không có `token`) |
| `team:service-account-create` | `({ name: string, scope: string })` | `ServiceAccountView` **kèm `token` (chỉ 1 lần)** |
| `team:service-account-delete` | `(id: string)` — **chuỗi trần, KHÔNG phải `{ id }`** | `boolean` |
| `vault:get-nostorage` | `()` | `{ enabled: boolean }` |
| `vault:set-nostorage` | `(enabled: boolean)` — **boolean trần, KHÔNG phải `{ enabled }`** | `{ enabled: boolean }` |

> ⚠️ **Lệch so với brief gốc:** brief ghi `team:set-workspace-dir`
> `({ dir })`, `team:service-account-delete` `({ id })`,
> `vault:set-nostorage` `({ enabled })`, nhưng renderer + `global.d.ts`
> đã chốt dạng tham số trần. Handler trong main **phải chấp nhận cả
> hai dạng** (chuẩn hoá ở đầu handler, xem §2) để không vỡ khi một bên
> đổi sau này. Dạng chuẩn đi tiếp là dạng trần (theo renderer).

`ServiceAccountView` (đã có trong `renderer/types.ts:262`):

```ts
export interface ServiceAccountView {
  id: string;
  name: string;
  scope: string;
  createdAt: string; // ISO string — KHÁC core: core lưu epoch ms (number)
  token?: string;    // chỉ có trong kết quả create, không bao giờ trong list
}
```

Main phải map `createdAt` epoch ms → ISO string khi trả về renderer
(`new Date(account.createdAt).toISOString()`). `TeamView` dùng
`formatDate(account.createdAt)` (hàm `new Date(raw)`), nên ISO string
là đủ; đừng trả epoch ms về vì sai kiểu đã khai báo.

---

## 1. Export cần thêm vào `packages/core/src/index.ts`

Thêm vào block team hiện có (sau `validateTeamConfig,`):

```ts
export {
  addMember,
  canEditBot,
  canUseBot,
  createServiceAccount,
  defaultTeamConfig,
  ensureTeamId,
  getMember,
  getTeamConfigPath,
  getTeamId,
  listServiceAccounts,
  listSharedBots,
  loadTeamConfig,
  removeMember,
  revokeServiceAccount,
  saveTeamConfig,
  serviceAccountVaultKey,
  setRole,
  setWorkspaceDir,
  shareBot,
  unshareBot,
  validateTeamConfig,
  SERVICE_ACCOUNT_VAULT_NAMESPACE,
} from './team/team';
export type {
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  RevokeServiceAccountResult,
} from './team/team';
export type {
  ServiceAccount,
  ServiceAccountScope,
  SharedBot,
  TeamConfig,
  TeamMember,
  TeamRole,
} from './team/types';
export { SERVICE_ACCOUNT_SCOPES } from './team/types';
```

Block Vault không cần đổi (`Vault`, `VaultOptions` đã export;
`noStorage` là field mới trong `VaultOptions`, `isNoStorage` /
`setNoStorage` là method mới của `Vault`).

Thêm block mới (cuối file, sau block Vault hoặc gần đó):

```ts
// --- v0.5: util (machine id + secret redaction) ---
export { getOrCreateMachineId, MACHINE_ID_FILE } from './util/index';
export { redactBearer, redactSecrets, REDACTED } from './util/index';
```

---

## 2. Code `main.ts` — import, machineId, IPC handlers

### 2.1 Import

Mở rộng import từ `@open-bot/core` (đã có `Vault`, `loadTeamConfig`, …):

```ts
import {
  // … các import hiện có …
  createServiceAccount,
  getOrCreateMachineId,
  getTeamId,
  listServiceAccounts,
  redactBearer,
  redactSecrets,
  revokeServiceAccount,
  serviceAccountVaultKey,
  setWorkspaceDir,
} from '@open-bot/core';
import type {
  // … các type hiện có …
  ServiceAccountScope,
} from '@open-bot/core';
```

Và mở rộng import crypto (hiện chỉ có `randomUUID`):

```ts
import { randomBytes, randomUUID } from 'node:crypto';
```

### 2.2 Khởi tạo machineId lúc app mở

Trong `app.whenReady().then(...)` (hiện tại, sau `initVaultAndUsage`):

```ts
void app.whenReady().then(() => {
  initVaultAndUsage(app.getPath('userData'));
  // v0.5: định danh máy ổn định, dùng để gắn token với (machineId, teamId).
  // Lưu file `machine-id` (mode 0600) trong userData. Không log giá trị.
  machineId = getOrCreateMachineId(app.getPath('userData'));
  // v0.5: áp lại lựa chọn NO_STORAGE đã lưu (Vault mặc định bật durable).
  if (settings.vaultNoStorage === true) vault.setNoStorage(true);
  settings = loadSettings();
  migrateApiKeysToVault();
  // …
});
```

Khai báo ở đầu file, gần `let vault: Vault;`:

```ts
/** v0.5: định danh máy ổn định (uuid), khởi tạo ở app.whenReady. */
let machineId = '';
```

Chưa có IPC nào trả `machineId` về renderer trong mốc này — cố tình:
định danh máy chỉ dùng ở main (gắn token, header team sau này). Worker
API (v0.5) cần thì thêm channel riêng sau, không tự ý expose ở đây.

### 2.3 Helper dùng chung trong main

```ts
/** Chuẩn hoá tham số IPC chấp nhận cả dạng trần lẫn dạng object. */
function asStringParam(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && typeof (payload as { dir?: unknown }).dir === 'string') {
    return (payload as { dir: string }).dir;
  }
  if (payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string') {
    return (payload as { id: string }).id;
  }
  throw new Error('Tham số không hợp lệ.');
}

function asBooleanParam(payload: unknown): boolean {
  if (typeof payload === 'boolean') return payload;
  if (payload && typeof payload === 'object' && typeof (payload as { enabled?: unknown }).enabled === 'boolean') {
    return (payload as { enabled: boolean }).enabled;
  }
  throw new Error('Tham số không hợp lệ.');
}

/** ServiceAccount (core, createdAt = epoch ms) -> dạng renderer đã khai báo. */
function serviceAccountView(account: {
  id: string; name: string; scope: string; createdAt: number;
}): { id: string; name: string; scope: string; createdAt: string } {
  return {
    id: account.id,
    name: account.name,
    scope: account.scope,
    createdAt: new Date(account.createdAt).toISOString(),
  };
}

/**
 * Tất cả API key provider đang lưu — dùng để redact lỗi trả về renderer.
 * Chỉ gọi khi cần redact (mỗi lần gọi đọc Vault); không cache key ở ngoài.
 */
function knownProviderKeys(): string[] {
  const keys: string[] = [];
  for (const id of vault.listSecrets('provider')) {
    const value = vault.getSecret('provider', id);
    if (value) keys.push(value);
  }
  return keys;
}

/** Redact lỗi trước khi trả về renderer / log: Bearer… + key provider đã biết. */
function redactErrorText(text: string): string {
  return redactBearer(redactSecrets(text, knownProviderKeys()));
}
```

### 2.4 IPC handlers — đặt cạnh các handler `team:*` hiện có

```ts
// --- v0.5: team workspace + service accounts ---

// Workspace dùng chung của team + teamId ổn định.
ipcMain.handle('team:get-workspace', () => {
  const team = loadTeamConfig(app.getPath('userData'));
  return { dir: team.workspaceDir ?? '', teamId: getTeamId(team) };
});

ipcMain.handle('team:set-workspace-dir', (_event: unknown, payload: unknown) => {
  const dir = asStringParam(payload);
  const team = loadTeamConfig(app.getPath('userData'));
  const next = setWorkspaceDir(team, dir);
  saveTeamConfig(app.getPath('userData'), next);
  return { dir: next.workspaceDir ?? '', teamId: getTeamId(next) };
});

ipcMain.handle('team:service-accounts-list', () => {
  const team = loadTeamConfig(app.getPath('userData'));
  return listServiceAccounts(team).map(serviceAccountView);
});

ipcMain.handle(
  'team:service-account-create',
  (_event: unknown, payload: { name: string; scope: ServiceAccountScope }) => {
    if (!payload || typeof payload.name !== 'string') {
      throw new Error('Thiếu tên service account.');
    }
    const team = loadTeamConfig(app.getPath('userData'));
    // createServiceAccount trả về { team, account } (xem §5.1): helper
    // pure nên team mới nằm trong kết quả, KHÔNG phải chỉ account.
    const { team: next, account } = createServiceAccount(team, {
      name: payload.name,
      scope: payload.scope,
    });
    // Token sinh Ở MAIN, chưa từng tồn tại ở core/renderer.
    const token = randomBytes(32).toString('base64url');
    // Lưu Vault trước khi lưu team.json: nếu lưu Vault lỗi thì chưa
    // có record nào trỏ tới token mồ côi.
    vault.setSecret('service-account', account.id, token);
    saveTeamConfig(app.getPath('userData'), next);
    // Token trả về DUY NHẤT 1 LẦN, trong đúng response này. Không log,
    // không lưu settings, không trả lại ở bất kỳ channel nào khác.
    // Lưu ý: nếu vault đang NO_STORAGE thì token chỉ sống trong bộ nhớ
    // và mất khi tắt app — TeamView phải hiện cảnh báo (key
    // team.serviceAccountNoStorageWarning, xem §6).
    return { ...serviceAccountView(account), token };
  },
);

ipcMain.handle('team:service-account-delete', (_event: unknown, payload: unknown) => {
  const id = asStringParam(payload);
  const team = loadTeamConfig(app.getPath('userData'));
  // revokeServiceAccount trả về { team, removed } (xem §5.1).
  const { team: next, removed } = revokeServiceAccount(team, id);
  // Xoá Vault LUÔN, kể cả khi record không còn (tránh token mồ côi).
  vault.deleteSecret('service-account', id);
  if (removed) saveTeamConfig(app.getPath('userData'), next);
  return removed;
});

// --- v0.5: Vault NO_STORAGE ---
ipcMain.handle('vault:get-nostorage', () => ({ enabled: vault.isNoStorage() }));

ipcMain.handle('vault:set-nostorage', (_event: unknown, payload: unknown) => {
  const enabled = asBooleanParam(payload);
  vault.setNoStorage(enabled);
  // Lưu lựa chọn để lần mở sau áp lại (Vault không tự nhớ chế độ này).
  settings.vaultNoStorage = enabled;
  saveSettings();
  return { enabled: vault.isNoStorage() };
});
```

> Thứ tự trong `team:service-account-create` là cố ý: **Vault trước,
> team.json sau**. Nếu `saveTeamConfig` lỗi sau khi Vault đã ghi, lần
> tạo lại sẽ sinh id mới — token cũ thành mồ côi trong Vault nhưng
> không trỏ tới account nào (an toàn, chỉ tốn 1 entry; có thể dọn bằng
> `vault:list` + đối chiếu id).

### 2.5 `settings.vaultNoStorage` — field mới trong `AppSettings`

```ts
export interface AppSettings {
  providers: Record<string, ProviderSettings>;
  bots: BotConfig[];
  locale: AppLocale;
  dream?: DreamConfig;
  /** v0.5: lựa chọn NO_STORAGE của người dùng; áp lại lúc khởi động. */
  vaultNoStorage?: boolean;
}
```

Lưu ý thứ tự khởi động ở §2.2: `settings = loadSettings()` phải chạy
**trước** khi áp `vault.setNoStorage(...)` nếu viết theo code mẫu trên
— trong code mẫu, `settings` lúc đó vẫn là giá trị mặc định khởi tạo
`{ providers: {}, bots: [], locale: 'vi' }` nên `settings.vaultNoStorage`
chưa có. Thứ tự đúng phải là:

```ts
initVaultAndUsage(app.getPath('userData'));
settings = loadSettings();            // load trước
machineId = getOrCreateMachineId(app.getPath('userData'));
if (settings.vaultNoStorage === true) vault.setNoStorage(true);
migrateApiKeysToVault();
```

(Trong `main.ts` hiện tại, `settings = loadSettings()` đã đứng ngay sau
`initVaultAndUsage` — chỉ cần chèn 2 dòng machineId + NO_STORAGE vào
giữa, sau `loadSettings()`.)

### 2.6 Áp redact vào các chỗ log / trả lỗi đã audit (xem §5.2)

Áp dụng tối thiểu, đúng các điểm đã phát hiện — không refactor rộng:

1. `chat:send` — catch hiện trả `err.message` thô về renderer. Đổi thành:
   ```ts
   } catch (err) {
     const message = err instanceof Error ? err.message : 'Lỗi không xác định.';
     return { ok: false, error: redactErrorText(message) };
   }
   ```
2. `settings:test` — catch tương tự:
   ```ts
   } catch (err) {
     return { ok: false, error: redactErrorText(err instanceof Error ? err.message : 'Kết nối thất bại.') };
   }
   ```
3. Mọi `console.error` mới sau này trong main: chỉ log `.message` đã qua
   `redactErrorText`, không bao giờ log object (`settings`,
   `providerConfigFor(...)`, `payload` của `settings:set`).
4. `providerConfigFor()` — không đổi code, nhưng ghi nhớ: object này
   chứa key thật; cấm `console.log(providerConfigFor(...))` vĩnh viễn.

---

## 3. API preload (`preload.ts`)

Thêm vào object `openBot`, cạnh các method `team:*` / `vault:*` hiện có.
Dùng **tên channel làm tên method** (đúng `global.d.ts` đã khai báo) để
`TeamView.callOpenBot('team:get-workspace', 'getTeamWorkspace')` tìm
thấy ngay ở `api[channel]`:

```ts
// v0.5: team workspace + service accounts + Vault NO_STORAGE.
// Method names are the IPC channel names (quoted because of the colon).
'team:get-workspace': () => ipcRenderer.invoke('team:get-workspace'),
'team:set-workspace-dir': (dir: string) => ipcRenderer.invoke('team:set-workspace-dir', dir),
'team:service-accounts-list': () => ipcRenderer.invoke('team:service-accounts-list'),
'team:service-account-create': (payload: { name: string; scope: string }) =>
  ipcRenderer.invoke('team:service-account-create', payload),
'team:service-account-delete': (id: string) => ipcRenderer.invoke('team:service-account-delete', id),
'vault:get-nostorage': () => ipcRenderer.invoke('vault:get-nostorage'),
'vault:set-nostorage': (enabled: boolean) => ipcRenderer.invoke('vault:set-nostorage', enabled),
```

Khuyến nghị thêm (không bắt buộc): alias camelCase để fallback trong
`callOpenBot` cũng có tác dụng nếu ai đó đổi tên channel sau này:

```ts
getTeamWorkspace: () => ipcRenderer.invoke('team:get-workspace'),
setTeamWorkspaceDir: (dir: string) => ipcRenderer.invoke('team:set-workspace-dir', dir),
listServiceAccounts: () => ipcRenderer.invoke('team:service-accounts-list'),
createServiceAccount: (payload: { name: string; scope: string }) =>
  ipcRenderer.invoke('team:service-account-create', payload),
deleteServiceAccount: (id: string) => ipcRenderer.invoke('team:service-account-delete', id),
getVaultNoStorage: () => ipcRenderer.invoke('vault:get-nostorage'),
setVaultNoStorage: (enabled: boolean) => ipcRenderer.invoke('vault:set-nostorage', enabled),
```

Nếu thêm alias, khai báo thêm vào interface `OpenBotApi` trong
`preload.ts` (và `global.d.ts` đã có sẵn các method channel-name; alias
thêm vào đó nếu dùng).

**Không expose thêm gì khác:** không expose `machineId`, không expose
token service account ngoài response của create, không expose
`vault.getSecret` hay `listSecrets('service-account')` kèm value
(`vault:list` hiện chỉ trả tên key — giữ nguyên).

---

## 4. Thay đổi TeamView (renderer đã viết phần lớn — kiểm tra/khớp)

`TeamView.tsx` hiện tại **đã có** mục workspace + service account
(state `workspace`, `serviceAccounts`, `newSaToken`, form tạo/xoá,
hiện token 1 lần, nút copy). Điều phối viên chỉ cần đối chiếu với
checklist sau, không viết lại:

- [ ] `load()` gọi `team:get-workspace` → hiện `teamId` (read-only, có
      nút copy) + `dir` vào ô nhập; gọi `team:service-accounts-list` →
      danh sách (không token). Cả hai best-effort, lỗi không chặn phần
      còn lại — đã có `try/catch` từng khối.
- [ ] Lưu workspace: `team:set-workspace-dir` với **chuỗi trần**
      (đã đúng trong code hiện tại). Sau khi lưu, `setWorkspace(next)`.
- [ ] Tạo service account: form tên + scope (`run` mặc định), gọi
      `team:service-account-create` với `{ name, scope }`; kết quả
      (kèm `token`) lưu vào state `newSaToken` **chỉ trong bộ nhớ**,
      hiện trong box `team.serviceAccountTokenTitle` +
      `team.serviceAccountTokenWarning`, có nút copy; **không** ghi
      token vào `localStorage`, không log, không fetch lại.
      Sau khi user đóng box token thì `setNewSaToken(null)` — token
      biến mất vĩnh viễn khỏi UI.
- [ ] Xoá: confirm `team.serviceAccountDeleteConfirm`, gọi
      `team:service-account-delete` với **id trần**; xoá khỏi list,
      clear `newSaToken` nếu trùng id.
- [ ] Hiển thị scope bằng `team.serviceAccountScopeRun/Admin`,
      ngày tạo bằng `team.serviceAccountCreatedAt` (`formatDate`).
- [ ] **Còn thiếu (thêm mới):** khi `vault` đang NO_STORAGE, tạo service
      account sẽ cho token chỉ sống tới khi tắt app. Cần hiện cảnh báo
      trong mục service account khi toggle NO_STORAGE đang bật — cần
      thêm key `team.serviceAccountNoStorageWarning` (§6) + đọc trạng
      thái qua `vault:get-nostorage` lúc mở TeamView. Nếu không làm kịp
      thì ít nhất ghi chú trong `team.serviceAccountIntro` (không chặn).
- [ ] **Còn thiếu (thêm mới, nhỏ):** UI hiện không xoá được workspace
      dir đã đặt (nút Save bị disable khi ô trống). Muốn xoá thì cho
      phép gửi chuỗi rỗng → main đã hỗ trợ (`setWorkspaceDir(team, '')`
      xoá setting). Thêm nút "Xoá" riêng hoặc bỏ disable khi đã có dir
      cũ. Không chặn mốc.

---

## 5. Thay đổi SettingsView (renderer đã viết phần lớn — kiểm tra/khớp)

`SettingsView.tsx` hiện tại **đã có** toggle NO_STORAGE trong mục Vault
(state `noStorage`, `loadNoStorage()` gọi `vault:get-nostorage`,
`changeNoStorage()` gọi `vault:set-nostorage` với **boolean trần**,
optimistic update + rollback khi lỗi, key
`settings.vaultNoStorageLabel/Hint/Error`). Đối chiếu:

- [ ] Toggle nằm trong section Vault (`settings.vaultTitle`), dưới danh
      sách secret, trên hoặc dưới `settings.vaultHint`.
- [ ] `loadNoStorage()` chạy trong lần load đầu của Settings (đã có ở
      dòng ~473); khi IPC chưa có thì toggle ở trạng thái off, không crash.
- [ ] Khi bật: nhắc user rằng secret nhập sau đó chỉ giữ trong phiên
      (`settings.vaultNoStorageHint` đã có). Khi tắt: secret trong bộ
      nhớ được ghi bền ngay (core `setNoStorage(false)` flush) — không
      cần code thêm ở renderer.
- [ ] **Lưu ý hành vi:** toggle chỉ đổi chế độ của Vault process hiện
      tại + lưu `settings.vaultNoStorage`; lần mở app sau main áp lại
      (§2.5). Nếu user bật NO_STORAGE rồi tạo service account thì token
      sẽ mất khi tắt app — xem cảnh báo ở §4.

---

## 6. Chuỗi i18n vi/en cần thêm

Các key dưới đây **đã có sẵn** trong cả `vi.json` và `en.json` (worker
khác đã thêm) — chỉ đối chiếu, không thêm lại:

| Key | vi | en |
|---|---|---|
| `team.workspaceTitle` | Workspace team | Team workspace |
| `team.workspaceIntro` | Thư mục dùng chung cho cả team trên máy này. | The shared folder for the whole team on this machine. |
| `team.workspaceTeamIdLabel` | Team ID | Team ID |
| `team.workspaceDirLabel` | Thư mục workspace dùng chung | Shared workspace folder |
| `team.workspaceDirPlaceholder` | vd: /home/huy/team-workspace | e.g. /home/huy/team-workspace |
| `team.workspaceSave` / `team.workspaceSaved` / `team.workspaceSaveError` | Lưu workspace / Đã lưu workspace team. / Không lưu được workspace team. | Save workspace / Team workspace saved. / Could not save the team workspace. |
| `team.workspaceCopy` / `team.copied` | Sao chép / Đã sao chép. | Copy / Copied. |
| `team.serviceAccountTitle` / `team.serviceAccountIntro` / `team.serviceAccountEmpty` | Service account / Tài khoản dịch vụ để app hoặc script ngoài chạy agent mà không cần tài khoản người dùng. / Chưa có service account nào. | Service accounts / Service accounts let outside apps or scripts run the agent without a user account. / No service accounts yet. |
| `team.serviceAccountNameLabel` / `team.serviceAccountNamePlaceholder` / `team.serviceAccountNameRequired` | Tên / vd: ci-bot / Vui lòng nhập tên service account. | Name / e.g. ci-bot / Please enter a service account name. |
| `team.serviceAccountScopeLabel` / `team.serviceAccountScopeRun` / `team.serviceAccountScopeAdmin` | Quyền (scope) / Chạy agent (run) / Quản trị (admin) | Scope / Run agents (run) / Admin (admin) |
| `team.serviceAccountCreate` / `team.serviceAccountCreatedOk` / `team.serviceAccountCreateError` | Tạo service account / Đã tạo service account “{name}”. / Không tạo được service account. | Create service account / Created service account “{name}”. / Could not create the service account. |
| `team.serviceAccountDelete` / `team.serviceAccountDeleteConfirm` / `team.serviceAccountDeletedOk` | Xoá / Xoá service account “{name}”? Token của nó sẽ không dùng được nữa. / Đã xoá service account “{name}”. | Delete / Delete service account “{name}”? Its token will stop working. / Deleted service account “{name}”. |
| `team.serviceAccountCreatedAt` | Tạo ngày {date} | Created {date} |
| `team.serviceAccountTokenTitle` / `team.serviceAccountTokenWarning` / `team.serviceAccountCopyToken` | Token — chỉ hiện một lần / Sao chép và lưu token ngay. Bạn sẽ không xem lại được token này nữa. / Sao chép token | Token — shown only once / Copy and save this token now. You will not be able to see it again. / Copy token |
| `team.serviceAccountLoadError` | Không tải được service account. | Could not load service accounts. |
| `settings.vaultNoStorageLabel` / `settings.vaultNoStorageHint` / `settings.vaultNoStorageError` | Chế độ không lưu trữ (NO_STORAGE) / Khi bật, secret chỉ giữ trong phiên làm việc — tắt app là mất và bạn phải nhập lại. / Không đổi được chế độ không lưu trữ. | No-storage mode (NO_STORAGE) / When on, secrets are only kept for the current session — closing the app discards them and you will need to enter them again. / Could not change the no-storage mode. |

**Key CẦN THÊM MỚI** (chưa có trong locale):

| Key | vi (đề xuất) | en (đề xuất) |
|---|---|---|
| `team.serviceAccountNoStorageWarning` | Đang bật chế độ không lưu trữ: token này sẽ mất khi tắt app. Hãy tắt chế độ không lưu trữ trước nếu muốn giữ service account lâu dài. | No-storage mode is on: this token will be lost when the app closes. Turn off no-storage mode first if you want to keep this service account. |

---

## 7. Kiểm thử đã chạy (worker 3)

```text
npx tsc --noEmit -p packages/core/tsconfig.json   → OK (sau khi sửa 3 lỗi
  type "possibly undefined" ở team.ts do serviceAccounts? optional)
npm run build --workspace=@open-bot/core          → OK
node --test tests/team-v05.test.mjs               → 9/9 pass
  ✔ teamId ổn định qua 2 lần load; file cũ được ghi thêm teamId
  ✔ ensureTeamId / getTeamId khớp nhau, không mutate input
  ✔ setWorkspaceDir set/trim/clear + persist qua save/load
  ✔ service account tạo/list/thu hồi; record không chứa token
  ✔ vault NO_STORAGE bật: file không đổi + get vẫn đọc được; tắt: flush bền
  ✔ vault NO_STORAGE từ constructor: chưa tạo file cho tới khi tắt
  ✔ redactSecrets thay mọi lần xuất hiện, bỏ qua secret < 4 ký tự/rỗng
  ✔ redactBearer thay Bearer token, giữ chữ Bearer
  ✔ machineId ổn định + file mode 0600 + file hỏng được thay mới
node --test tests/vault.test.mjs                  → 12/12 pass (test cũ)
```

### Hồi quy: 1 test cũ FAIL do đổi shape (cần điều phối viên sửa test, không phải sửa core)

```text
node --test tests/vault.test.mjs tests/mcp-marketplace-team.test.mjs
  → 25/26 pass, 1 fail:
  ✖ team: add/remove/setRole with validation
    (tests/mcp-marketplace-team.test.mjs:163)
    assert.deepEqual(team, { id: 'default', name: 'Default team',
      members: [], sharedBots: [] })
    actual:   { …, teamId: '7eedbb46-…', serviceAccounts: [] }
```

Nguyên nhân: test cũ assert **exact shape** của team mặc định; theo
đặc tả v0.5, `validateTeamConfig`/`defaultTeamConfig` bắt buộc thêm
`teamId` (uuid mới) + `serviceAccounts: []`. Đây là thay đổi có chủ ý,
không phải bug. File test đó thuộc worker khác nên worker 3 **không
được sửa**. Cách sửa (1 dòng, do điều phối viên làm):

```ts
// tests/mcp-marketplace-team.test.mjs:163 — thay assert exact-shape bằng:
assert.equal(team.id, 'default');
assert.equal(team.name, 'Default team');
assert.deepEqual(team.members, []);
assert.deepEqual(team.sharedBots, []);
assert.match(team.teamId, /^[0-9a-f-]{36}$/i);
assert.deepEqual(team.serviceAccounts, []);
```

---

## 8. Lưu ý thiết kế / quyết định cần điều phối viên biết

### 8.1 `createServiceAccount` / `revokeServiceAccount` KHÔNG trả đúng chữ ký brief

Brief ghi `createServiceAccount(team, {name, scope}) -> ServiceAccount`
và `revokeServiceAccount(team, id) -> boolean`. Core trả về:

```ts
createServiceAccount(team, input) -> { team: TeamConfig; account: ServiceAccount }
revokeServiceAccount(team, id)   -> { team: TeamConfig; removed: boolean }
```

Lý do: mọi helper trong `team.ts` đều **pure** (không mutate input,
trả về TeamConfig mới — xem header file). Trả về chỉ account/boolean
thì caller mất team mới và không thể persist. Payload brief yêu cầu
nằm trong kết quả (`account`, `removed`). Code main ở §2.4 đã viết theo
dạng này. Nếu điều phối viên muốn chữ ký đúng brief từng chữ thì phải
chấp nhận mutate input — worker 3 không khuyến nghị.

### 8.2 Token service account: chỉ main sinh, chỉ trả 1 lần, không verify ở core

- Sinh: `randomBytes(32).toString('base64url')` (43 ký tự) ở main.
- Lưu: Vault namespace `'service-account'`, key = account id
  (`serviceAccountVaultKey(id)` → `'service-account:<id>'`).
- **Không có hàm verify token trong core mốc này** — worker API (v0.5)
  sẽ cần `vault.getSecret('service-account', id)` + so sánh constant-time
  khi request tới kèm token. Đừng so sánh bằng `===` trên token thô ở
  handler nóng mà không qua `crypto.timingSafeEqual` (ghi chú cho worker API).
- Xoá account mà không xoá Vault entry thì token vẫn còn trong Vault
  (mồ côi nhưng chưa bị vô hiệu hoá ở tầng lưu trữ). Handler delete ở
  §2.4 đã xoá cả hai — giữ đúng thứ tự đó.
- Scope `run`/`admin` hiện chỉ là **ghi chú trong record** — chưa có
  enforcement ở API vì API chưa tồn tại. Worker API phải kiểm tra scope
  trước khi cho chạy task quản trị.

### 8.3 NO_STORAGE không phải là "xoá hết secret"

- Bật NO_STORAGE **không xoá** secret đã lưu bền từ trước; chúng vẫn
  đọc được (`getSecret` đọc từ bộ nhớ đã load lúc khởi tạo). Nó chỉ
  chặn **ghi bền mới**. Muốn "quên hết" thì phải xoá từng secret
  (hoặc xoá file `vault.json` khi app tắt — ngoài phạm vi mốc này).
- Chế độ này không tự persist: main lưu `settings.vaultNoStorage`
  (§2.5). Nếu main không lưu thì sau restart toggle về off.
- `rotateKey()` khi NO_STORAGE đang bật: `saveStore()` bị chặn nên
  store không ghi, nhưng `rotateKey()` **không tham số vẫn ghi file key
  mới** (`vault.json.key`) — hành vi này giữ nguyên từ v0.4, không đổi
  ở mốc này. Khuyến nghị: không gọi rotate khi NO_STORAGE đang bật.

### 8.4 `teamId` sinh khi load — và tính ổn định

- File cũ (không có `teamId`) được `loadTeamConfig` ghi lại ngay lần
  đầu với id mới → ổn định từ lần load thứ hai trở đi. Ghi lại này
  best-effort (lỗi ghi không làm fail load).
- `defaultTeamConfig()` sinh id mới mỗi lần gọi — đúng vì đó là team
  mới, chưa lưu. Đừng gọi nó hai lần rồi so sánh id.
- `getTeamId(team)` trên team chưa có id sẽ sinh id mới **mà không
  lưu** — caller muốn ổn định phải dùng `ensureTeamId` + `saveTeamConfig`.

### 8.5 `machine-id` không phải secret, nhưng vẫn mode 0600

File `machine-id` chứa uuid định danh máy (không phải key mã hoá).
Giữ mode 0600 để một user local khác không copy cặp
(machineId, vault) một cách tầm thường. Không bao giờ log giá trị này,
không gửi về renderer.

---

## 9. Audit log token (chỉ đọc — worker 3 không sửa code người khác)

Phạm vi: `grep console\.` toàn bộ `packages/core/src` +
`apps/desktop/src/main/main.ts` (ngày 2026-11-08). Kết quả:

### 9.1 `console.*` tìm thấy: chỉ 5 dòng, tất cả AN TOÀN

| Vị trí | Dòng | Kết luận |
|---|---|---|
| `apps/desktop/src/main/main.ts:158` | `console.error('…Không lưu được settings:', (err).message)` | Chỉ `.message`. Có comment "KHÔNG log nội dung settings". An toàn. |
| `apps/desktop/src/main/main.ts:211` | `console.error('…safeStorage không khả dụng…:', (err).message)` | Chỉ `.message`. An toàn. |
| `apps/desktop/src/main/main.ts:239` | `console.log('…Đã dời API key…')` | Chuỗi tĩnh, không chứa key. An toàn. |
| `apps/desktop/src/main/main.ts:487` | `console.error('…Coordinator đã thoát…')` | Chuỗi tĩnh. An toàn. |
| `apps/desktop/src/main/main.ts:636` | `console.error('…Không lưu được tin nhắn:', (err).message)` | Chỉ `.message`. An toàn. |
| `packages/core/src` (toàn bộ) | **0 dòng `console.*`** | Core không log gì cả. |

**Không tìm thấy** `console.log(settings)`, `console.log(providerConfigFor…)`,
hay bất kỳ `console.*` nào in object chứa token trong phạm vi audit.
Các file đã kiểm tra thêm: `providers/*.ts` (key chỉ đi vào header/URL,
không log), `voice/*` (không có `console.*`), `vault/*` (lỗi không echo
value), `skills/loader.ts` (đã có sẵn pattern nhận diện secret, trong
đó có `/\bBearer\s+…/`, nhất quán với `redactBearer` mới).

### 9.2 Rủi ro KHÔNG phải `console.*` nhưng có thể làm rò token — cần sửa

| # | Vị trí | Vấn đề | Cách sửa (điều phối viên / worker sở hữu file) |
|---|---|---|---|
| R1 | `main.ts:563` `providerConfigFor()` | Build `ProviderConfig` chứa `apiKey` thật trong bộ nhớ, truyền cho `createProvider` + RPC `createBot` qua stdio. Đúng thiết kế, nhưng bất kỳ `console.log` tương lai nào lên object này là rò ngay. | Cấm log object này (ghi chú §2.6). Khi cần debug chỉ log `providerId` + `model`, không log config. |
| R2 | `packages/core/src/providers/gemini.ts:134` | Key nằm trong URL query `?key=…`. Lỗi fetch/network có thể kèm URL → key lọt vào `err.message` → `chat:send` trả về renderer. | Ở main: `redactErrorText()` (§2.3, đã redact bằng key thật đã biết) trước khi trả lỗi ở `chat:send` + `settings:test` (§2.6). Về lâu dài: cân nhắc chuyển Gemini sang header thay vì query (worker provider). |
| R3 | `providers/openaiCompatible.ts:156-165`, `anthropic.ts:139-147`, `gemini.ts:142-150` | Lỗi HTTP nhúng `truncateErrorText(bodyText)` (500 ký tự đầu của body provider trả về), không redact. Provider lạ/ác ý có thể echo credential trong body lỗi. | Worker provider: áp `redactBearer()` (core mới, đã export) lên `bodyText` trước khi đưa vào `Error` — hoặc redact ngay trong `truncateErrorText`. Không sửa ở mốc này (file ngoài phạm vi worker 3). |
| R4 | `packages/core/src/coordinator/coordinator.ts:392` | `onDaemonStderr: (chunk) => process.stderr.write(chunk)` — forward **nguyên văn** stderr của exec daemon (thuộc `packages/tools`, ngoài phạm vi audit sâu). Daemon có thể in env/args. | Worker coordinator/tools: `redactBearer(chunk)` trước khi forward; tốt hơn nữa là chỉ forward dòng đã qua `redactSecrets` với key đã biết (main nắm key, coordinator con không nên giữ key). |
| R5 | `packages/core/src/mcp/client.ts:161-204` | `stderrTail` (tới 500 ký tự stderr của MCP server) nhúng vào `McpError` → hiện ở UI/log. MCP server có thể in token từ env của nó. | Worker MCP: `redactBearer(stderrTail)` khi dựng message lỗi; không tăng giới hạn 500 ký tự. |
| R6 | `main.ts:902` `settings:set` | Renderer gửi `apiKey` plaintext qua IPC (local, chấp nhận được), nhưng `patch` là object nhạy cảm. | Không log `patch` bao giờ; nếu sau này thêm log ở handler này thì chỉ log `Object.keys(patch.providers ?? {})`. |
| R7 | `main.ts:875-877` `chat:send` catch | Trả `err.message` thô về renderer; lỗi provider có thể chứa body/URL (R2/R3). | Đã có cách sửa ở §2.6: `redactErrorText(message)`. |
| R8 | `main.ts:211` fallback LocalEncryptor | Khi `safeStorage` không khả dụng, app fallback LocalEncryptor + chỉ log 1 dòng `.message`. An toàn, nhưng user không được báo rõ là key đang ở mức bảo vệ yếu hơn. | (Tuỳ chọn) Hiện cảnh báo 1 lần trong Settings khi fallback xảy ra — cần IPC trạng thái encryptor, ngoài phạm vi mốc này. |

### 9.3 Đã xác minh là an toàn, không cần sửa

- `settingsForRenderer()` (`main.ts:162`): strip `apiKey`, renderer
  không bao giờ nhận key thật.
- `migrateApiKeysToVault()` (`main.ts:226`): dời key rồi xoá khỏi
  settings; log chỉ 1 chuỗi tĩnh.
- Vault: mọi lỗi không echo value; `listSecrets` chỉ trả tên key.
- Coordinator stderr còn lại (`coordinator.ts:238-252, 357-400, 525`):
  chỉ `err.message` + tên plugin/dir — an toàn.
- Code mới của worker 3 (`team.ts`, `vault.ts`, `util/*`): 0 `console.*`.
