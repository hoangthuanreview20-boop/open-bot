# Plugin marketplace — bundle signing + downgrade (v0.93a)

Chính sách chữ ký bundle và downgrade cho plugin marketplace
(`packages/tools/src/plugins/marketplace.ts` + `signing.ts`,
`packages/core/src/coordinator/coordinator.ts`).

## 1. Vì sao cần chữ ký

SHA-256 của file `.zip` tải về (v0.89a) chỉ chứng minh bytes còn
nguyên vẹn trên đường truyền — không chứng minh AI phát hành bundle
đó. Chữ ký Ed25519 chứng minh cả hai: bundle là đúng bytes mà người
giữ private key đã ký, và bất kỳ thay đổi nào sau đó (1 byte, 1 file
thêm) đều fail verification.

## 2. Định dạng chữ ký

File `signature.json` nằm ở gốc plugin, cạnh `manifest.json`, được
copy theo plugin khi cài đặt:

```json
{
  "algorithm": "ed25519",
  "keyId": "<sha256 hex của SPKI DER — suy từ key, không do caller đặt>",
  "pluginId": "my-plugin",
  "version": "1.2.0",
  "files": { "<đường dẫn tương đối POSIX>": "<sha256 hex>", "...": "..." },
  "signature": "<base64: Ed25519 sign của canonical JSON bên dưới>"
}
```

- `files` bao phủ MỌI file trong bundle, trừ chính `signature.json`,
  `node_modules` và `.git`. Chữ ký bao phủ canonical JSON của
  `{ algorithm, keyId, pluginId, version, files }` (key sắp xếp đệ
  quy) — nên chữ ký không thể tráo sang plugin khác hay version khác.
- Ký bằng Ed25519 có sẵn trong `node:crypto` — không thêm dependency.

## 3. Kho khóa tin cậy

`<userDataDir>/marketplace/trusted-keys.json`:

```json
{ "<keyId>": { "publicKey": "<SPKI PEM>", "label": "Acme", "addedAt": "..." } }
```

- Chỉ chứa PUBLIC key — private key không bao giờ nằm trong app.
- Thêm key là quyết định rõ ràng của user (IPC
  `plugin-marketplace:add-trusted-key`, hoặc sửa file). Gỡ key làm
  plugin ký bằng key đó fail verification ở lần load sau
  (fail-closed, có rollback khi còn bản trước — xem §6).
- `keyId` suy từ chính key (sha256 của SPKI DER) nên hai key khác
  nhau không bao giờ trùng id; key không phải Ed25519 bị từ chối
  ngay khi thêm.

### Publisher ký bundle như thế nào

```js
const { generateMarketplaceSigningKeyPair, signPluginBundle } =
  require('@open-bot/tools');
// Một lần duy nhất (giữ privateKey cẩn thận, đừng commit):
const pair = generateMarketplaceSigningKeyPair('Acme');
// Mỗi lần phát hành:
signPluginBundle('./my-plugin', pair.privateKey);
// → ghi ./my-plugin/signature.json; user thêm pair.publicKey vào kho khóa tin cậy.
```

## 4. Chính sách plugin CHƯA KÝ (quyết định v0.93a)

| Trường hợp | Kết quả |
|---|---|
| Có chữ ký, hợp lệ, key đã tin tưởng | Cài + load bình thường |
| Có chữ ký nhưng SAI (sửa file, thêm file code, thiếu file, sai plugin/version, key lạ, JSON hỏng) | **Từ chối ở mọi đường** — cả nguồn `local` lẫn `url`/`git`, cả lúc cài lẫn lúc load (fail-closed, lỗi nêu rõ lý do) |
| Không có chữ ký, nguồn `url`/`git` | **Từ chối**, trừ khi caller truyền `allowUnsigned: true` (xem dưới) |
| Không có chữ ký, nguồn `local` | **Cho phép** — user copy từ đĩa của mình, cùng mức tin tưởng như plugin cài tay |
| Không có bản ghi marketplace (cài tay, không qua marketplace) | **Không kiểm tra** — giữ nguyên trust model cũ |

`allowUnsigned: true` là opt-in rõ ràng, mặc định `false`, KHÔNG BAO
GIỜ tự bật: UI/CLI chỉ truyền nó sau khi user xác nhận "cài plugin
chưa ký". Quyết định được ghi vào `marketplace-installed.json`
(`allowUnsigned: true`) nên lần load sau tôn trọng đúng quyết định
đó thay vì từ chối lại. IPC desktop nhận cờ này ở
`plugin-marketplace:prepare` / `:install` / `:update`
(`window.openBot.preparePluginInstall(source, { allowUnsigned })`).

### File thêm sau khi ký

File bị thêm vào sau khi ký chỉ bị từ chối khi nó có thể load thành
code (`.js`, `.cjs`, `.mjs`, `.node`, `.json` — các đuôi Node
`require()` mặc định): plugin quét thư mục của mình có thể thực thi
file code thêm vào. File khác (log, cache, dữ liệu runtime plugin tự
ghi vào thư mục của nó) được chấp nhận — kẻ tấn công viết được vào
thư mục plugin thì cũng sửa được file đã ký (và việc đó BỊ bắt), nên
từ chối mọi file log chỉ làm hỏng plugin hay ghi log, không tăng an
toàn. Quy tắc này được test pin (`evil.js` thêm vào → invalid;
`run.log` thêm vào → vẫn signed).

## 5. Downgrade

- Khi cập nhật ghi đè một version đã cài, version cũ được snapshot
  nguyên vẹn vào
  `<userDataDir>/plugin-previous-versions/<id>/<version>/` (giữ đúng
  MỘT bản trước; snapshot gồm cả `signature.json` của nó). Snapshot
  thất bại → từ chối cập nhật (không được mất bản cũ).
- API: `getPluginDowngradeInfo(id, pluginsDir)` →
  `{ currentVersion, previousVersion, canDowngrade, reason? }`;
  `downgradePlugin(id, pluginsDir)` → `{ id, fromVersion, toVersion }`.
- Downgrade fail-closed theo thứ tự: phải có bản trước + snapshot
  còn trên đĩa → snapshot validate bằng loader thật → snapshot có
  chữ ký thì verify lại (snapshot bị sửa → từ chối, bản đang chạy
  giữ nguyên) → snapshot bản ĐANG chạy trước, rồi mới cài bản cũ.
  Nhờ bước snapshot này mà downgrade đảo ngược được: downgrade lần
  nữa trở lại version vừa rời (hai version đổi vai cho nhau).
- Desktop: IPC `plugin-marketplace:downgrade` /
  `:downgrade-info`, preload `downgradePluginMarketplace(id)` /
  `getPluginDowngradeInfo(id)`; `plugin-marketplace:list` trả thêm
  `signatureStatus`, `signatureKeyId`, `previousVersion` để UI hiển
  thị. Uninstall xóa cả snapshot (không hồi sinh bản cũ sau khi gỡ).

## 6. Bot start: verify trước khi load + auto-rollback

`loadPlugins()` LOẠI plugin marketplace khỏi lần quét chung — chúng
chỉ được load bởi `loadMarketplacePluginsAtStartup`, SAU KHI verify
chữ ký (`verifyInstalledPluginSignature`). Verify sau khi quét chung
sẽ là hình thức: code đã chạy trong sandbox worker rồi.

- Verify fail → plugin KHÔNG load (fail-closed), ghi vào `skipped`.
  Nếu còn bản trước, loader rollback về bản đó (`downgradePlugin`),
  verify lại, rồi load bản cũ — ghi vào `rolledBack`
  (`{ id, fromVersion, toVersion, reason }`). Chỉ thử rollback MỘT
  lần cho mỗi plugin.
- Load fail (bản mới ký đúng nhưng code hỏng, `loadSandboxed`
  throw) → rollback tương tự rồi thử load lại.
- Bản ghi hỏng/không đọc được → fail-open như v0.92a (quét chung
  load hết, vẫn sandboxed; chỉ bước verify bị bỏ qua vì không có
  bản ghi để gate). Bot start không bao giờ fail vì marketplace.
- Tools cũ hơn v0.93a (không có hàm verify/downgrade) → hành vi
  v0.92a giữ nguyên.

## 7. Giới hạn còn lại (nói thẳng)

- Nút Downgrade + quản lý khóa tin cậy trong renderer đã có từ
  v0.94a (`McpMarketplaceView.tsx`, tab Plugin): nút Downgrade chỉ
  hiện khi `getPluginDowngradeInfo` nói `canDowngrade` (confirm
  trước khi gọi IPC, notice nêu đúng bản đã về); section khóa tin
  cậy list keyId + label + ngày thêm (không hiện key material, không
  private key), thêm key có validate PEM ở client, gỡ key có
  confirm. Test renderer `tests/plugin-marketplace-ui-v094a.test.mjs`
  13/13 (Electron thật + mock `openBot` theo shape preload).
- Chỉ giữ MỘT bản trước — không có lịch sử nhiều version.
- Không có thu hồi chữ ký tập trung (revocation list): gỡ key khỏi
  kho tin cậy là cách thu hồi duy nhất.
- `loadPluginTools()` (helper sync cũ, không còn caller trong repo)
  không enforce chính sách marketplace — đường bot start thật dùng
  `loadPlugins` async (giới hạn đã có từ v0.92a, không đổi).
- Chữ ký không thay thế sandbox lúc chạy: code vẫn chạy
  out-of-process, chữ ký chỉ chứng minh nguồn gốc bundle.
