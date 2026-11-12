# Các gap KHÔNG làm được trên máy này — v0.86 (đợt 2)

Tài liệu này ghi rõ những gap parity đã xác định là **không thể làm
xong một cách trung thực trên máy này** (VM Linux + X11, không có
quyết định sản phẩm, không có hạ tầng phát hành). Mục đích: ngăn việc
"làm nửa vời rồi ghi là xong" — mỗi gap ghi rõ **hiện trạng thật,
lý do không làm được, và cần gì để làm được**. Không sửa
`docs/BEYOND-ROADMAP.md`; khi một gap được làm thật, cập nhật cả hai
file cùng lúc (xóa mục này, ghi mục BEYOND-ROADMAP).

Ngày ghi: 2026-11-11. Môi trường tham chiếu: VM này — Linux, X11
(xvfb), không có Wayland session, không macOS, không Windows, không
code-signing, chưa push GitHub (push đang defer theo lệnh của Huy).

---

## P1-2 — Computer-use trên Wayland / macOS / Windows

**Hiện trạng thật (đã kiểm chứng trong code):** computer-use chỉ
chạy trên Linux + X11 — `packages/tools/src/computerUse.ts` dùng
`xdotool` + ImageMagick/`ffmpeg (x11grab)`, mọi tool yêu cầu `DISPLAY`
đang chạy; trên Windows/macOS hàm kiểm tra trả lỗi fail-closed
("Computer-use is only available on Linux with an X11 display").
`docs/ROADMAP.md` cũng ghi rõ "Linux + X11 only, chưa
Wayland/macOS/Windows". OpenMausBot (tham chiếu kiến trúc) làm theo
hướng tương tự: Ubuntu Xorg có local control opt-in, Wayland mặc
định fail-closed.

**Vì sao không làm được trên máy này:** không có môi trường thật để
kiểm chứng bất kỳ nền tảng nào trong ba nền tảng còn thiếu.

- **Wayland:** VM này chạy X11 (xvfb); không có Wayland compositor
  (không GNOME/KDE Wayland session, không `wtype`/`ydotool`/
  portal). Viết code gọi `org.freedesktop.portal.RemoteDesktop`
  hay `ydotool` mà không chạy được một lần nào thì chỉ là code
  đoán — đúng kiểu "làm nửa vời" tài liệu này muốn ngăn.
- **macOS:** không có máy Mac, không có `cliclick`/AppleScript/
  Accessibility API để chạy thật; không thể ký/notarize hay kiểm
  chứng quyền Accessibility (người dùng phải cấp tay trong
  System Settings).
- **Windows:** không có máy Windows, không có `SendInput`/UI
  Automation để chạy thật; không thể kiểm chứng UAC/elevate hay
  hành vi trên nhiều độ phân giải/scale.

**Cần gì để làm được (theo thứ tự):**

1. Môi trường thật cho từng nền tảng: một Wayland session (GNOME
   hoặc KDE) trên Linux; một máy Mac (Intel hoặc Apple Silicon);
   một máy Windows 10/11. Mỗi nền tảng cần chạy được test thật
   (click + đọc hiệu ứng, như L5 làm trên X11), không chỉ
   `node --check`.
2. Quyết định kiến trúc cho từng nền tảng: Wayland — RemoteDesktop
   portal (cần người dùng phê duyệt session, không tự ý) hay
   `ydotool` (cần daemon + quyền input); macOS — AppleScript/
   `cliclick` hay Accessibility API native; Windows — `SendInput`
   hay UI Automation. Mỗi lựa chọn có mô hình quyền và độ tin cậy
   khác nhau; không chọn hộ trong tài liệu này.
3. Fail-closed giữ nguyên: nền tảng chưa hỗ trợ phải tiếp tục từ
   chối rõ ràng như hiện tại, không im lặng giả vờ chạy.

**Không làm:** không viết driver Wayland/macOS/Windows "cho có" mà
không chạy được; không đổi fail-closed thành fail-open.

---

## P1-1 — Tự cập nhật cài đặt thật (`quitAndInstallUpdate`)

**Hiện trạng thật (đã kiểm chứng trong code):** phần *kiểm tra* đã
là code thật — `stable` qua GitHub releases API, `dogfood`/
`nightly`/`lab` qua `checkForTrackUpdate`
(`packages/core/src/update/checker.ts`, xem chi tiết ở
`docs/update-tracks.md`). Phần *cài đặt* thì chưa có:
`quitAndInstallUpdate()` trong
`apps/desktop/src/main/updateService.ts` **luôn trả
`{installed: false}`**; khi có bản mới, app chỉ mở trang release để
người dùng tải tay (`update:open-download`, chỉ cho phép URL
`github.com/hoangthuanreview20-boop/open-bot/releases/`).

**Vì sao không làm được trên máy này:** thiếu cả hai thứ mà cơ chế
tải + cài thật bắt buộc phải có, và cả hai đều nằm ngoài code:

1. **Hạ tầng phát hành (release infrastructure):** push GitHub đang
   defer theo lệnh của Huy nên repo chưa có release nào được phát
   hành thật — không có artifact (AppImage/deb/zip) để tải về, không
   có feed để autoUpdater theo dõi. Không thể "cài thử" một bản cập
   nhật không tồn tại.
2. **Code-signing:** `electron-updater`/autoUpdater cần bản build
   đã ký thì hệ điều hành mới tin để cài đè; hiện không có chứng
   chỉ ký nào cho Linux (GPG/sign cho AppImage/deb), macOS
   (Developer ID + notarization) hay Windows (EV/code-signing
   cert). Không có chứng chỉ thì mọi test cài đặt đều là giả lập.

**Chuẩn bị đã có (không phải "xong"):** code kiểm tra theo track,
cờ server `update_required`/`min_client_version` (mặc định không
set, chưa có server nào trả), banner "Bắt buộc cập nhật", tắt hoàn
toàn bằng `OPEN_BOT_DISABLE_UPDATE=1`. Những thứ này là nền, không
phải cơ chế cài đặt.

**Cần gì để làm được (theo thứ tự):**

1. Huy cho push GitHub + phát hành release đầu tiên (kèm quy ước
   tag `-dogfood`/`-nightly`/`-lab` cho các track ngoài stable —
   xem `docs/update-tracks.md` §"Khi nào thì 'xong' thật?").
2. Chứng chỉ code-signing cho từng nền tảng phát hành + pipeline
   build ký artifact trong CI (không ký tay trên máy dev).
3. Nối `electron-updater` (hoặc cơ chế tương đương) vào
   `quitAndInstallUpdate()`: tải artifact đã ký, verify chữ ký +
   checksum trước khi cài, cài rồi khởi động lại; test end-to-end
   bằng release prerelease thật (cài bản cũ → cập nhật lên bản mới
   → verify version), không test bằng mock.
4. Cập nhật `docs/update-tracks.md`, bỏ các cảnh báo "chưa có
   release thật" khi cả ba bước trên xong.

**Không làm:** không giả vờ `quitAndInstallUpdate()` trả
`{installed: true}` khi chưa cài gì; không tự ghi đè file của app
đang chạy; không bỏ qua verify chữ ký.

---

## P1-6 — Project updates sender (gửi cập nhật project)

> **ĐÃ ĐÓNG ở v0.94c (worker C, branch `v094c-parity-expand`)** — chọn
> phương án A theo lệnh sóng (làm gap loại (a) lớn nhất còn lại) và
> theo hướng local-first đứng của Huy (không server, không tài khoản
> ngoài, không gửi ra ngoài): digest tính từ task của project trong
> BotMemory (số task theo trạng thái + task vừa xong kể từ digest
> trước + task còn mở), gửi mỗi 6 giờ qua **thông báo hệ thống + tin
> nhắn assistant trong chat của bot** (`packages/core/src/project/updates.ts`,
> timer 15 phút ở desktop main, RPC `projectUpdatesDue` /
> `projectUpdatesMarkSent`, `lastUpdateAt` trong DB, toggle
> `settings.notificationsProjectUpdateLabel`). Mô tả tool
> `project_set_updates` đã sửa đúng kênh gửi thật + trả `nextDigestAt`.
> Phương án B (email digest) và C (webhook ra ngoài) vẫn mở — cần
> quyết định của Huy + connected account + phê duyệt gửi (gửi ra
> ngoài là hành động ghi, không tự ý). Phương án D vẫn loại trừ
> (không phù hợp local-first). Nội dung gốc dưới đây giữ lại làm
> lịch sử quyết định.

**Hiện trạng thật (đã kiểm chứng trong code):** tool
`project_set_updates` (`packages/tools/src/planTools.ts`) **chỉ lưu
cờ `updatesEnabled` vào DB** — mô tả tool tự ghi rõ: "CHỈ LƯU CỜ
updatesEnabled vào DB — chưa có kênh gửi thật nên sẽ không có cập
nhật nào được gửi đi". Không có code nào đọc cờ đó để gửi bất cứ
thứ gì, ở bất cứ đâu. Parity với Grok Bot chỉ dừng ở tên tool:
Grok có cặp `StartProjectUpdatesToolCall` /
`StopProjectUpdatesToolCall` (xem `docs/rea-grokbot-deep-dive.md`
dòng 340/342) — nhưng phần gửi cập nhật của Grok chạy phía server
xAI, không có trong installer để phân tích, nên không biết nó gửi
cái gì, gửi cho ai, theo lịch nào.

**Vì sao không làm được (chưa phải vì thiếu môi trường):** đây là
gap **thiếu quyết định sản phẩm**, không phải thiếu máy móc. "Gửi
cập nhật project" chưa có định nghĩa: không rõ **nguồn dữ liệu** là
gì (lấy từ đâu), **đích đến** là ai (gửi cho ai, qua kênh nào), và
**tần suất/nội dung** ra sao. Viết code gửi trước khi trả lời ba câu
đó là bịa một tính năng rồi ép người dùng theo — đúng thứ Huy đã
từng sửa (scope correction) khi có thêm thứ không hỏi.

**Các phương án nguồn + đích (ghi rõ để Huy chọn, không bịa quyết
định):**

| # | Nguồn dữ liệu | Đích / kênh gửi | Ghi chú |
|---|---|---|---|
| A | Event của run (task xong, plan đổi, lỗi) từ history/coordinator, ngay trong app | In-app: feed/bảng "Cập nhật project" trong UI, + OS notification (cần làm P-notification trước) | Local-first nhất; không cần server, không cần tài khoản ngoài. Nhưng chỉ người đang mở app mới thấy. |
| B | Như A, tổng hợp theo lịch (vd mỗi ngày / mỗi tuần) | Email digest gửi tới email của owner (qua provider email đã nối, vd Gmail qua Composio — cần connected account + phê duyệt) | Cần quyết định: lịch nào, tóm tắt bằng model hay liệt kê thô, gửi cho đúng 1 owner hay cả team. |
| C | Như A | Webhook ra ngoài (Slack/Teams/email một chiều — hiện chỉ có chiều gửi qua Composio tool, chưa có chiều nhận) | Cần chọn kênh + đích cụ thể; mỗi kênh cần connected account riêng. |
| D | Server trung tâm theo dõi project rồi đẩy cập nhật (mô hình Grok) | Push tới client | **Không phù hợp local-first**: cần server luôn chạy, tài khoản, và dữ liệu project rời khỏi máy người dùng. Chỉ ghi ra để loại trừ có lý do. |

**Cần gì để làm được (theo thứ tự):**

1. **Quyết định của Huy**: chọn một phương án (A, B, C, hoặc
   phương án khác) + trả lời: cập nhật gồm những event nào, gửi
   cho ai, tần suất nào, nội dung tóm tắt hay liệt kê thô.
2. Sau khi có quyết định: implement sender đọc đúng nguồn đã chọn,
   nối vào đúng kênh đã chọn, test end-to-end (bật cờ → chạy task
   → cập nhật đến đích thật, tắt cờ → không gửi nữa), và sửa mô tả
   tool `project_set_updates` (bỏ câu "chưa có kênh gửi thật").
3. Phương án B/C cần thêm: connected account thật + phê duyệt gửi
   (gửi ra ngoài là hành động ghi, không tự ý).

**Không làm:** không tự chọn phương án rồi code sender; không đổi
mô tả tool thành "đã gửi" khi chưa gửi gì; không làm phương án D
mà không có quyết định chuyển sang mô hình server.

---

## Ghi chú chung

- Ba gap trên đều đã được ghi trong audit v0.85 (parity 75/76,
  "project updates chỉ là cờ", "computer-use chỉ Linux+X11", "tự
  cập nhật chỉ check+mở link") — tài liệu này không phát hiện gap
  mới, chỉ ghi rõ vì sao sóng v0.86 đợt 2 không làm chúng và cần gì
  để sóng sau làm thật.
- Các gap khác trong danh sách P1/P2 của v0.85 đã hoặc đang được
  làm ở sóng v0.86 (Playwright P1-3, video P1-5, CanvasView P2-1,
  tree-sitter P2-4, per-window screenshot P2-5, deep-link P2-6,
  crash reporting P2-7) — không thuộc phạm vi file này.
