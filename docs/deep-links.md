# Deep-link `open-bot://` (v0.86, P2-6)

Mở app từ bên ngoài bằng URL `open-bot://...` — ví dụ click link trong
trình duyệt, ghi chú, hoặc terminal: `xdg-open 'open-bot://bot/<id>'`.

## Scheme và route

Scheme: **`open-bot`**. Parser thuần nằm ở
`packages/core/src/deeplink.ts` (`parseDeepLink`, test ở
`tests/deep-link-v086.test.mjs`).

| URL | Hành động |
| --- | --- |
| `open-bot://` hoặc `open-bot://chat` | Mở màn hình chat chính |
| `open-bot://bot/<botId>` | Mở chat của bot `<botId>` (cũng nhận `open-bot://bot?id=<botId>`, `open-bot:///bot/<botId>`) |
| `open-bot://settings` | Mở Settings |
| `open-bot://canvas` | Mở Canvas |

URL sai / không rõ (scheme khác, route lạ, thiếu `botId`, `botId` chứa
ký tự lạ, thừa segment, `%` encode hỏng, segment `.`/`..`) được **bỏ
qua an toàn, log lý do, không crash, không mở gì cả**.

Lưu ý: `open-bot://info` và `open-bot://workspace` là **URI resource
của MCP server** (`packages/core/src/mcp/server.ts`), KHÔNG phải
deep-link OS — parser từ chối chúng một cách có chủ ý.

## Cách hoạt động

1. Main process đăng ký scheme lúc khởi động (`setupDeepLink` trong
   `apps/desktop/src/main/deeplink.ts`, gọi trước `app.whenReady`):
   `app.setAsDefaultProtocolClient('open-bot')` (chỉ khi app đã đóng
   gói — ở dev, binary electron sẽ chiếm scheme nên bỏ qua), kèm
   single-instance lock (`app.requestSingleInstanceLock()`).
2. URL tới qua event `open-url` (macOS) hoặc `second-instance`
   (Windows/Linux — instance thứ hai giao URL trong argv rồi thoát;
   instance đang chạy xử lý thay), hoặc argv lúc khởi động.
3. Main parse URL thành route; route bot chỉ hợp lệ khi bot đó còn
   tồn tại trong settings. Route được đẩy tới renderer qua IPC
   `deep-link:open` (khi renderer đã sẵn) hoặc renderer kéo về 1 lần
   qua IPC `deep-link:pending` lúc mount (cho URL tới trước khi cửa
   sổ / renderer sẵn). Preload expose `onDeepLink` /
   `getPendingDeepLink` qua `window.openBot`; `App.tsx` áp route
   (`setView` / `setSelectedBotId`, kể cả khi bot chưa load xong).
4. `electron-builder.yml` khai báo `protocols: [{ name: open-bot,
   schemes: [open-bot] }]` để bản đóng gói tự đăng ký với OS
   (Windows NSIS ghi registry, macOS Info.plist, Linux file
   `.desktop` của AppImage có `MimeType=x-scheme-handler/open-bot`).

## Giới hạn — chưa kiểm chứng đăng ký OS thật

- **Linux trên máy này (VM headless, không có desktop environment):
  đăng ký OS thật CHƯA kiểm chứng được.** Đã thử kiểm chứng
  2026-11-11: chạy Electron thật dưới `xvfb` với `XDG_DATA_HOME` /
  `XDG_CONFIG_HOME` trỏ vào thư mục tạm,
  `app.setAsDefaultProtocolClient('open-bot')` trả `false` và
  `isDefaultProtocolClient` trả `false`, cả khi đã đặt sẵn file
  `electron.desktop` có `MimeType=x-scheme-handler/open-bot;`.
  `xdg-settings set default-url-scheme-handler` cũng thoát mã 4 khi
  không có desktop environment (chỉ thành công khi giả
  `XDG_CURRENT_DESKTOP=GNOME`). Nghĩa là cơ chế đăng ký trên Linux
  phụ thuộc desktop environment + file `.desktop` của bản đóng gói
  thật — cần kiểm chứng lại trên máy Linux có desktop / bản AppImage
  đóng gói. Code đã viết đúng đường chuẩn (electron-builder
  `protocols:` + `setAsDefaultProtocolClient` lúc chạy), và mọi lỗi
  đăng ký đều fail-open (app vẫn chạy bình thường, chỉ mất deep-link).
- **macOS / Windows: chưa kiểm chứng** — không có máy macOS/Windows
  trong đợt này; code theo đúng pattern chuẩn của Electron
  (`open-url` + `second-instance` + single-instance lock).
- **Dev mode không đăng ký scheme** (cố ý, để khỏi chiếm scheme của
  bản đóng gói). Muốn thử deep-link ở dev: gọi trực tiếp IPC hoặc
  chạy app đã đóng gói.
