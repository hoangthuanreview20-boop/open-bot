# Update theo track (P1-9, v0.54; feed track ngoài stable thật từ v0.59)

Tài liệu ngắn về cơ chế update của open-bot — track, lịch kiểm tra, và
**giới hạn chưa có release thật** (đọc trước khi "hoàn thiện" cơ chế này).

## Track

| Track | Ý nghĩa | Feed kiểm tra |
|---|---|---|
| `stable` (mặc định) | Bản phát hành ổn định | GitHub releases API latest (`checkForUpdate`, có từ v0.7) |
| `dogfood` | Bản dùng thử nội bộ trước khi ra stable | GitHub releases list, lọc prerelease có tag `-dogfood` (code thật từ v0.59 — xem dưới) |
| `nightly` | Build hàng đêm từ main | GitHub releases list, lọc prerelease có tag `-nightly` (code thật từ v0.59 — xem dưới) |
| `lab` | Bản thử nghiệm | GitHub releases list, lọc prerelease có tag `-lab` (code thật từ v0.59 — xem dưới) |

Đổi track: Settings → Cập nhật → "Kênh cập nhật" (`setUpdateTrack`).
Track persist vào `<userData>/update-track.json` (`{track}`); file lỗi/mất
thì về `stable`.

## Lịch kiểm tra

- **Startup**: `UpdateService.start()` gọi `checkForUpdates({trigger: "startup"})`
  lúc app khởi động (không chặn khởi động — lỗi thì log).
- **Định kỳ**: `scheduleNextPeriodicCheck()` — mặc định 6 giờ/lần; lỗi ở lần
  nào thì ghi lại (`checkFailed`, `lastError`) và **retry ở lần sau**, không
  dừng lịch, không throw, không spam user.
- **Tay**: nút "Kiểm tra" ở Settings, hoặc banner "Kiểm tra lại".

Tắt hoàn toàn bằng biến môi trường `OPEN_BOT_DISABLE_UPDATE=1` (hoặc
`true`) → lần check nào cũng trả `checkFailed: true` kèm mã lỗi
`updateDisabledByEnv` (domain `update`, tương ứng `SAND-E0505
updateDisabledByEnv` của Grok §6), không gọi mạng.

## Cờ server: `update_required` / `min_client_version`

`evaluateUpdatePolicy()` (core, thuần túy) đánh giá: `update_required`
thắng mọi thứ; dưới `min_client_version` thì bắt buộc update. Khi bắt buộc,
banner hiện dạng "Bắt buộc cập nhật" và không cho dismiss.

**Hiện tại cả hai cờ đều mặc định không set** — không có server nào trả
chúng. `UpdateService.setServerPolicy()` đã có sẵn cho feed thật sau này.

## ⚠️ Giới hạn: chưa có release nào được phát hành thật (cập nhật v0.59)

Push GitHub còn defer theo lệnh của Huy nên dự án **chưa có release
nào được phát hành thật** (kể cả kênh stable). Hệ quả:

1. **Mọi track đều kiểm tra bằng code thật** (từ v0.59):
   `stable` qua GitHub releases API latest; `dogfood`/`nightly`/`lab`
   qua `checkForTrackUpdate` (`packages/core/src/update/checker.ts`) —
   lấy danh sách releases (`/releases?per_page=20`, mới nhất trước)
   và chọn prerelease đầu tiên có tag mang hậu tố kênh, vd
   `v0.59.0-dogfood.1`, `v0.59.0-nightly.20261109`, `v0.59.0-lab.1`,
   rồi so semver với bản đang chạy. Code đã test bằng feed giả local
   (`tests/update-feed-tracks-v059.test.mjs`, không gọi mạng thật).
   **Nhưng chưa có release nào cho các kênh đó tồn tại thật**, nên tới
   khi release được phát hành theo quy ước tag trên, lần kiểm tra sẽ
   trả `available: false` một cách trung thực (không có release cho
   kênh = không phải lỗi, `checkFailed: false`). Feed URL cấu hình
   được qua option `trackFeedUrl` của `UpdateService` (mặc định là
   GitHub releases list API của repo); đặt `trackFeedUrl: ''` nghĩa là
   "chưa cấu hình feed" → các track ngoài stable quay lại
   `feedStatus: 'stub-no-feed'`: `checkForUpdates` **không gọi mạng**,
   `available: false`, `checkFailed: false` (fail soft — stub có chủ ý
   cho trường hợp chưa cấu hình, không phải bug). Lỗi feed (mạng/API/
   dữ liệu sai dạng) thì fail soft như track stable (`checkFailed:
   true`, retry ở lần check sau).
2. **`quitAndInstallUpdate()` luôn trả `{installed: false}`** — chưa có cơ
   chế tải + cài đặt thật (cần code-signing + feed; xem ghi chú v0.7 trong
   `packages/core/src/update/checker.ts`). App không bao giờ tự ghi đè file
   của chính nó khi đang chạy. Khi có bản mới, banner + Settings chỉ mở
   trang release để tải tay (`update:open-download`, chỉ cho phép URL
   `github.com/hoangthuanreview20-boop/open-bot/releases/`).
3. **`update_required` / `min_client_version` chưa có nguồn** (xem trên).

## Khi nào thì "xong" thật?

Khi Huy cho push GitHub + phát hành release: lúc đó feed cho `stable`
(đã có sẵn qua releases API) và feed cho `dogfood`/`nightly`/`lab`
(đã có sẵn code từ v0.59, chỉ cần phát hành release prerelease với tag
mang hậu tố kênh, vd `v0.59.0-nightly.20261109`) đều chạy thật — không
cần sửa thêm code kiểm tra. Phần còn thiếu lúc đó chỉ là cơ chế tải/cài
(electron autoUpdater cần code-signing) để `quitAndInstallUpdate()`
trong `apps/desktop/src/main/updateService.ts` làm việc thật — và cập
nhật tài liệu này, bỏ các cảnh báo ở trên.
